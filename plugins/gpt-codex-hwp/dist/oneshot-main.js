import { extname, isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PROJECT_METADATA } from "./generated/project-metadata.js";
import { configureAllowedRootsForMcp, createMcpServer, } from "./mcp-main.js";
import { readFileBounded } from "./shared/files.js";
import { preflightExclusiveOutput, writeFilesExclusively, } from "./shared/output.js";
import { assertUtf8Budget, MAX_MCP_RESPONSE_BYTES, } from "./shared/resource-limits.js";
import { toolDefinitions } from "./tools/index.js";
import { MAX_DOCUMENT_DEADLINE_MS } from "./workers/document-execution-policy.js";
import { subscribeDocumentChildTerminationReceipts } from "./workers/document-child-termination-channel.js";
import { subscribeDocumentWorkerTerminationReceipts } from "./workers/document-worker-termination-channel.js";
import { MAX_REGISTERED_PROCESS_GROUPS, normalizeProcessTreeTerminationReceipt, unverifiedTermination, } from "./workers/registered-process-supervisor.js";
export const MAX_ONESHOT_REQUEST_BYTES = 32 * 1024 * 1024;
export const ONESHOT_CLEANUP_ALLOWANCE_MS = 15_000;
export const ONESHOT_TOOL_TIMEOUT_MS = MAX_DOCUMENT_DEADLINE_MS + ONESHOT_CLEANUP_ALLOWANCE_MS;
export const ONESHOT_CLEANUP_EVIDENCE_ENV = "GPT_CODEX_HWP_ONESHOT_CLEANUP_EVIDENCE";
export function createOneShotCleanupEvidenceCollector(options = {}) {
    const receipts = [];
    const workerReceipts = [];
    let overflow = false;
    let finished = false;
    const reserveReceipt = () => {
        if (receipts.length + workerReceipts.length >= MAX_REGISTERED_PROCESS_GROUPS) {
            overflow = true;
            return false;
        }
        return true;
    };
    const unsubscribeChild = (options.subscribe ?? subscribeDocumentChildTerminationReceipts)((message) => {
        if (!reserveReceipt())
            return;
        try {
            receipts.push(normalizeProcessTreeTerminationReceipt(message));
        }
        catch {
            receipts.push(unverifiedTermination("termination"));
        }
    });
    const unsubscribeWorker = (options.subscribeWorker ?? subscribeDocumentWorkerTerminationReceipts)((message) => {
        if (!reserveReceipt())
            return;
        workerReceipts.push(message);
    });
    return Object.freeze({
        finish() {
            if (finished)
                throw new Error("One-shot cleanup evidence is unavailable.");
            finished = true;
            unsubscribeChild();
            unsubscribeWorker();
            if (overflow || receipts.length + workerReceipts.length === 0) {
                throw new Error("One-shot cleanup evidence is invalid.");
            }
            const platform = options.platform ?? process.platform;
            if (platform !== "win32" && platform !== "linux" && platform !== "darwin") {
                throw new Error("One-shot cleanup evidence is unverified.");
            }
            for (const receipt of workerReceipts) {
                if (!isRecord(receipt)
                    || Object.keys(receipt).sort().join(",") !== "proof,terminated"
                    || receipt.terminated !== true
                    || receipt.proof !== "worker-thread-terminated") {
                    throw new Error("One-shot cleanup evidence is unverified.");
                }
            }
            if (receipts.length === 0) {
                return "ONESHOT_CLEANUP proof=worker-thread-terminated observedProcessTrees=0 remainingProcessTrees=0\n";
            }
            if (platform === "win32") {
                if (receipts.some((receipt) => !receipt.gone || receipt.proof !== "windows-job-empty")) {
                    throw new Error("One-shot cleanup evidence is unverified.");
                }
                const proof = workerReceipts.length === 0
                    ? "windows-job-empty"
                    : "worker-and-windows-job-empty";
                return `ONESHOT_CLEANUP proof=${proof} observedProcessTrees=${receipts.length} remainingProcessTrees=0\n`;
            }
            let observedProcessTrees = 0;
            for (const receipt of receipts) {
                if (!receipt.gone || receipt.proof !== "registered-groups-empty"
                    || !("registeredIdentityCount" in receipt)
                    || receipt.registeredIdentityCount < 1
                    || receipt.remainingIdentityCount !== 0) {
                    throw new Error("One-shot cleanup evidence is unverified.");
                }
                observedProcessTrees += receipt.registeredIdentityCount;
            }
            if (observedProcessTrees > MAX_REGISTERED_PROCESS_GROUPS) {
                throw new Error("One-shot cleanup evidence is invalid.");
            }
            const proof = workerReceipts.length === 0
                ? "registered-groups-empty"
                : "worker-and-registered-groups-empty";
            return `ONESHOT_CLEANUP proof=${proof} observedProcessTrees=${observedProcessTrees} remainingProcessTrees=0\n`;
        },
    });
}
const TOOL_NAMES = new Set(toolDefinitions.map(({ name }) => name));
export function parseOneShotArguments(argv) {
    if (argv.length !== 4 || argv[0] !== "--request" || argv[2] !== "--response") {
        throw new Error("Invalid one-shot invocation.");
    }
    const requestPath = argv[1];
    const responsePath = argv[3];
    if (!isJsonPath(requestPath) || !isJsonPath(responsePath)
        || comparablePath(requestPath) === comparablePath(responsePath)) {
        throw new Error("Invalid one-shot invocation.");
    }
    return Object.freeze({ requestPath, responsePath });
}
export function parseOneShotRequest(bytes) {
    try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!isRecord(value)
            || Object.keys(value).sort().join(",") !== "arguments,schemaVersion,tool"
            || value.schemaVersion !== 1
            || typeof value.tool !== "string"
            || !TOOL_NAMES.has(value.tool)
            || !isRecord(value.arguments)) {
            throw new Error();
        }
        return Object.freeze({
            schemaVersion: 1,
            tool: value.tool,
            arguments: Object.freeze({ ...value.arguments }),
        });
    }
    catch {
        throw new Error("Invalid one-shot request.");
    }
}
export function callOneShotTool(client, request, options = {}) {
    return client.callTool({ name: request.tool, arguments: request.arguments }, undefined, { timeout: ONESHOT_TOOL_TIMEOUT_MS, signal: options.signal });
}
export async function runOneShot(argv = process.argv.slice(2), options = {}) {
    let client;
    let server;
    try {
        const paths = parseOneShotArguments(argv);
        await configureAllowedRootsForMcp();
        const request = parseOneShotRequest(await readFileBounded(paths.requestPath, "one-shot request", MAX_ONESHOT_REQUEST_BYTES, { directPath: true }));
        const response = await preflightExclusiveOutput(paths.responsePath, {
            sourcePaths: [paths.requestPath],
        });
        server = createMcpServer();
        client = new Client({
            name: `${PROJECT_METADATA.productId}-oneshot`,
            version: PROJECT_METADATA.version,
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await callOneShotTool(client, request, options);
        const serialized = JSON.stringify(result);
        assertUtf8Budget(serialized, MAX_MCP_RESPONSE_BYTES, "one-shot response");
        await writeFilesExclusively([{ path: response.path, data: serialized, mode: 0o600 }], {
            sourcePaths: [paths.requestPath],
            expectedDirectoryIdentities: response.expectedDirectoryIdentities,
        });
        return result.isError === true ? 1 : 0;
    }
    catch {
        return 2;
    }
    finally {
        await client?.close().catch(() => undefined);
        await server?.close().catch(() => undefined);
    }
}
function isJsonPath(value) {
    return isAbsolute(value) && extname(value).toLowerCase() === ".json";
}
function comparablePath(value) {
    return process.platform === "win32"
        ? value.toLocaleLowerCase("en-US")
        : value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export async function runOneShotEntry(argv = process.argv.slice(2)) {
    const controller = new AbortController();
    const abort = () => {
        if (!controller.signal.aborted)
            controller.abort();
    };
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    let code = 2;
    let cleanupEvidence;
    let cleanupEvidenceReceipt = "";
    try {
        const evidenceMode = process.env[ONESHOT_CLEANUP_EVIDENCE_ENV];
        delete process.env[ONESHOT_CLEANUP_EVIDENCE_ENV];
        if (evidenceMode !== undefined) {
            if (evidenceMode !== "stdout")
                throw new Error("Invalid one-shot cleanup evidence mode.");
            cleanupEvidence = createOneShotCleanupEvidenceCollector();
        }
        code = await runOneShot(argv, { signal: controller.signal });
        if (code === 0 && cleanupEvidence !== undefined) {
            cleanupEvidenceReceipt = cleanupEvidence.finish();
        }
    }
    catch {
        code = 2;
    }
    finally {
        if (code !== 0 && cleanupEvidence !== undefined) {
            try {
                cleanupEvidence.finish();
            }
            catch { }
        }
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
    }
    process.exitCode = code;
    const receipt = code === 0
        ? `${cleanupEvidenceReceipt}ONESHOT_OK\n`
        : code === 1
            ? "ONESHOT_TOOL_ERROR\n"
            : "ONESHOT_INVOCATION_ERROR\n";
    try {
        (code === 2 ? process.stderr : process.stdout).write(receipt);
    }
    catch {
        process.exitCode = 2;
    }
    return code;
}
