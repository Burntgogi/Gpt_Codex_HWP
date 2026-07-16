import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROJECT_METADATA } from "./generated/project-metadata.js";
import { registerTools } from "./tools/index.js";
import { encodeBoundedJsonFrame } from "./workers/bounded-frame.js";
import { superviseDocumentProcessTree, terminateDocumentProcessTreeByPid, } from "./workers/document-child-client.js";
import { DOCTOR_RUNNER_MAX_FRAME_BYTES, DOCTOR_RUNNER_READY, DOCTOR_RUNNER_SCHEMA_VERSION, } from "./workers/doctor-command-runner.js";
export const DOCTOR_SCHEMA_VERSION = 1;
const EXPECTED_TOOL_NAMES = Object.freeze([
    "hwp_detect_format",
    "hwp_read",
    "hwp_generate_hwpx",
    "hwp_validate",
    "hwp_render_preview",
    "hwp_patch_document",
    "hwp_fill_form",
    "hwp_create_svg_asset",
    "hwp_insert_image",
]);
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const JSON_LIMIT_BYTES = 1024 * 1024;
const KORDOC_FILE_LIMIT_BYTES = 16 * 1024 * 1024;
const KORDOC_FILE_COUNT_LIMIT = 512;
const KORDOC_TOTAL_LIMIT_BYTES = 64 * 1024 * 1024;
const REMEDIATION = Object.freeze({
    node: "Install a supported Node.js release and retry the diagnostic.",
    npm: "Install npm for the active Node.js runtime and retry the diagnostic.",
    python: "Install a supported Python 3 runtime and retry the diagnostic.",
    metadata: "Reinstall the plugin from a verified release.",
    dependencies: "Reinstall production dependencies from the verified lockfile.",
    optional: "Install the optional capability only if that workflow is required.",
    fixture: "No repair is required unless pinned release-test evidence is needed.",
});
export async function runDoctor(providedDependencies) {
    const dependencies = providedDependencies ?? await createDefaultDependencies();
    const checks = [];
    checks.push(nodeCheck(dependencies.nodeVersion));
    checks.push(await npmCheck(dependencies));
    checks.push(await pythonCheck(dependencies));
    checks.push(await projectMetadataCheck(dependencies));
    checks.push(await pluginManifestCheck(dependencies));
    checks.push(await mcpManifestCheck(dependencies));
    checks.push(await kordocProvenanceCheck(dependencies));
    checks.push(await kordocLinkCheck(dependencies));
    checks.push(await productionDependencyCheck(dependencies));
    checks.push(await toolCountCheck(dependencies));
    checks.push(await rhwpCheck(dependencies));
    checks.push(await pinnedFixtureCheck(dependencies));
    const requiredChecks = checks.filter((check) => check.required);
    const optionalChecks = checks.filter((check) => !check.required);
    const requiredFailed = requiredChecks.filter((check) => !check.ok).length;
    const optionalUnavailable = optionalChecks.filter((check) => !check.ok).length;
    const ok = requiredFailed === 0;
    return Object.freeze({
        schemaVersion: DOCTOR_SCHEMA_VERSION,
        code: ok ? "DOCTOR_OK" : "DOCTOR_REQUIRED_CHECK_FAILED",
        ok,
        required: Object.freeze({
            passed: requiredChecks.length - requiredFailed,
            failed: requiredFailed,
        }),
        optional: Object.freeze({
            available: optionalChecks.length - optionalUnavailable,
            unavailable: optionalUnavailable,
        }),
        checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    });
}
export async function doctorMain(args = process.argv.slice(2), io = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
}, dependencies) {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
        io.stderr("DOCTOR_USAGE_INVALID: use --json or no arguments.\n");
        return 2;
    }
    const report = await runDoctor(dependencies);
    if (args[0] === "--json")
        io.stdout(`${JSON.stringify(report)}\n`);
    else
        io.stdout(renderHumanReport(report));
    return report.ok ? 0 : 1;
}
export function redactDiagnosticText(value) {
    return value
        .slice(0, COMMAND_OUTPUT_LIMIT_BYTES)
        .replace(/[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\r\n"']+/gu, "<redacted-path>")
        .replace(/\/(?:Users|home)\/[^\s"']+/gu, "<redacted-path>")
        .replace(/\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*[^\s"']+/gu, "<redacted-value>")
        .replace(/\b(?:HOME|USERPROFILE|USERNAME|USER)\s*=\s*[^\r\n]+/giu, "<redacted-value>");
}
async function createDefaultDependencies() {
    const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const runtimeAccess = await createDoctorRuntimeAccess(runtimeRoot);
    const npmCommand = await resolveNpmCommand();
    let verifiedKordoc = false;
    return {
        nodeVersion: process.version,
        projectMetadata: PROJECT_METADATA,
        npmCommand,
        pythonCommands: process.platform === "win32"
            ? [
                { command: "python", argsPrefix: [] },
                { command: "py", argsPrefix: ["-3"] },
            ]
            : [
                { command: "python3", argsPrefix: [] },
                { command: "python", argsPrefix: [] },
            ],
        verifyKordocRuntime: async () => {
            const verifier = await import(new URL("../scripts/kordoc-runtime-verifier.mjs", import.meta.url).href);
            const result = await verifier.verifyKordocCoreRuntime(join(runtimeRoot, "vendor", "kordoc-core"));
            const fileCount = Array.isArray(result.files) ? result.files.length : 0;
            if (fileCount <= 0 || fileCount > KORDOC_FILE_COUNT_LIMIT) {
                throw new Error("invalid verified Kordoc file count");
            }
            verifiedKordoc = true;
            return Object.freeze({ fileCount });
        },
        probeRegisteredTools: probeRegisteredToolsInProcess,
        readJson: (path) => runtimeAccess.readJson(path),
        readBytes: (path) => runtimeAccess.readBytes(path, KORDOC_FILE_LIMIT_BYTES),
        statRegular: (path) => runtimeAccess.statRegular(path),
        sameCanonicalPath: async (left, right) => left === "node_modules/kordoc"
            && right === "vendor/kordoc-core"
            && verifiedKordoc
            && await runtimeAccess.sameCanonicalKordocLink(),
        runCommand: (specification) => executeBoundedCommand(specification, runtimeRoot),
    };
}
function nodeCheck(value) {
    const version = cleanVersion(value);
    if (version !== undefined && Number(version.split(".")[0]) >= 22) {
        return check("NODE_RUNTIME_OK", true, true, { version });
    }
    return check("NODE_RUNTIME_UNSUPPORTED", false, true, { remediation: REMEDIATION.node });
}
async function npmCheck(dependencies) {
    if (dependencies.npmCommand === null) {
        return check("NPM_UNAVAILABLE", false, true, { remediation: REMEDIATION.npm });
    }
    const result = await safeRun(dependencies, dependencies.npmCommand.command, [
        ...dependencies.npmCommand.argsPrefix,
        "--version",
    ]);
    const version = cleanVersion(`${result.stdout}\n${result.stderr}`);
    if (successful(result) && version !== undefined)
        return check("NPM_OK", true, true, { version });
    return check("NPM_UNAVAILABLE", false, true, { remediation: REMEDIATION.npm });
}
async function pythonCheck(dependencies) {
    for (const candidate of dependencies.pythonCommands) {
        const result = await safeRun(dependencies, candidate.command, [
            ...candidate.argsPrefix,
            "--version",
        ]);
        const version = cleanVersion(`${result.stdout}\n${result.stderr}`);
        if (successful(result) && version !== undefined && isSupportedPython(version)) {
            return check("PYTHON_OK", true, false, { version });
        }
    }
    return check("PYTHON_UNAVAILABLE", false, false, { remediation: REMEDIATION.python });
}
async function projectMetadataCheck(dependencies) {
    try {
        const runtimePackage = object(await dependencies.readJson("package.json"));
        const valid = runtimePackage.name === dependencies.projectMetadata.productId
            && runtimePackage.version === dependencies.projectMetadata.version
            && object(runtimePackage.dependencies).kordoc === "file:vendor/kordoc-core";
        return valid
            ? check("PROJECT_METADATA_OK", true, true)
            : check("PROJECT_METADATA_INVALID", false, true, { remediation: REMEDIATION.metadata });
    }
    catch {
        return check("PROJECT_METADATA_INVALID", false, true, { remediation: REMEDIATION.metadata });
    }
}
async function pluginManifestCheck(dependencies) {
    try {
        const manifest = object(await dependencies.readJson(".codex-plugin/plugin.json"));
        const version = typeof manifest.version === "string" ? manifest.version : "";
        const valid = manifest.name === dependencies.projectMetadata.productId
            && version.startsWith(`${dependencies.projectMetadata.version}+codex.`)
            && manifest.mcpServers === "./.mcp.json";
        return valid
            ? check("PLUGIN_MANIFEST_OK", true, true)
            : check("PLUGIN_MANIFEST_INVALID", false, true, { remediation: REMEDIATION.metadata });
    }
    catch {
        return check("PLUGIN_MANIFEST_INVALID", false, true, { remediation: REMEDIATION.metadata });
    }
}
async function mcpManifestCheck(dependencies) {
    try {
        const manifest = object(await dependencies.readJson(".mcp.json"));
        const servers = object(manifest.mcpServers);
        const keys = Object.keys(servers);
        const server = object(servers[dependencies.projectMetadata.productId]);
        const valid = keys.length === 1
            && keys[0] === dependencies.projectMetadata.productId
            && server.command === "node"
            && isExactStringArray(server.args, ["./dist/mcp.js"])
            && server.cwd === ".";
        return valid
            ? check("MCP_MANIFEST_OK", true, true, { count: keys.length })
            : check("MCP_MANIFEST_INVALID", false, true, { remediation: REMEDIATION.metadata });
    }
    catch {
        return check("MCP_MANIFEST_INVALID", false, true, { remediation: REMEDIATION.metadata });
    }
}
async function kordocProvenanceCheck(dependencies) {
    try {
        const verified = await dependencies.verifyKordocRuntime();
        if (!Number.isSafeInteger(verified.fileCount) || verified.fileCount <= 0
            || verified.fileCount > KORDOC_FILE_COUNT_LIMIT)
            throw new Error("invalid verifier result");
        return check("KORDOC_PROVENANCE_OK", true, true, { count: verified.fileCount });
    }
    catch {
        return check("KORDOC_PROVENANCE_INVALID", false, true, { remediation: REMEDIATION.metadata });
    }
}
async function kordocLinkCheck(dependencies) {
    const valid = await dependencies.sameCanonicalPath("node_modules/kordoc", "vendor/kordoc-core");
    return valid
        ? check("KORDOC_LINK_OK", true, true)
        : check("KORDOC_LINK_INVALID", false, true, { remediation: REMEDIATION.dependencies });
}
async function productionDependencyCheck(dependencies) {
    if (dependencies.npmCommand === null) {
        return check("PRODUCTION_DEPENDENCIES_INVALID", false, true, {
            remediation: REMEDIATION.dependencies,
        });
    }
    const result = await safeRun(dependencies, dependencies.npmCommand.command, [
        ...dependencies.npmCommand.argsPrefix,
        "ls",
        "--omit=dev",
        "--json",
        "--depth=0",
    ]);
    try {
        const parsed = object(JSON.parse(redactDiagnosticText(result.stdout)));
        if (!successful(result)
            || parsed.name !== dependencies.projectMetadata.productId
            || parsed.version !== dependencies.projectMetadata.version) {
            throw new Error("invalid dependency tree");
        }
        return check("PRODUCTION_DEPENDENCIES_OK", true, true, {
            count: Object.keys(object(parsed.dependencies)).length,
        });
    }
    catch {
        return check("PRODUCTION_DEPENDENCIES_INVALID", false, true, {
            remediation: REMEDIATION.dependencies,
        });
    }
}
async function toolCountCheck(dependencies) {
    try {
        const names = await dependencies.probeRegisteredTools();
        const valid = names.length === EXPECTED_TOOL_NAMES.length
            && names.every((name, index) => name === EXPECTED_TOOL_NAMES[index]);
        return valid
            ? check("MCP_TOOL_COUNT_OK", true, true, { count: names.length })
            : check("MCP_TOOL_COUNT_INVALID", false, true, {
                count: names.length,
                remediation: REMEDIATION.metadata,
            });
    }
    catch {
        return check("MCP_TOOL_COUNT_INVALID", false, true, { remediation: REMEDIATION.metadata });
    }
}
export async function probeRegisteredToolsInProcess() {
    const server = new McpServer({
        name: `${PROJECT_METADATA.productId}-doctor`,
        version: PROJECT_METADATA.version,
    });
    const client = new Client({
        name: `${PROJECT_METADATA.productId}-doctor-client`,
        version: PROJECT_METADATA.version,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerTools(server);
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const response = await client.listTools();
        return Object.freeze(response.tools.map((tool) => tool.name));
    }
    finally {
        await client.close().catch(() => undefined);
        await server.close().catch(() => undefined);
    }
}
async function rhwpCheck(dependencies) {
    try {
        const runtimePackage = object(await dependencies.readJson("package.json"));
        const expectedVersion = object(runtimePackage.optionalDependencies)["@rhwp/core"];
        const rhwpPackage = object(await dependencies.readJson("node_modules/@rhwp/core/package.json"));
        const version = cleanVersion(String(rhwpPackage.version ?? ""));
        if (rhwpPackage.name !== "@rhwp/core" || version === undefined || version !== expectedVersion) {
            throw new Error("invalid optional package");
        }
        return check("RHWP_AVAILABLE", true, false, { version });
    }
    catch {
        return check("RHWP_UNAVAILABLE", false, false, { remediation: REMEDIATION.optional });
    }
}
async function pinnedFixtureCheck(dependencies) {
    try {
        const provenance = object(await dependencies.readJson("tests/fixtures/rhwp/provenance.json"));
        const fixture = await dependencies.statRegular("tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp");
        const bytes = await dependencies.readBytes("tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp");
        if (!fixture.regular || !safeSize(provenance.bytes) || !safeHash(provenance.sha256)
            || fixture.size !== provenance.bytes || bytes.byteLength !== provenance.bytes
            || sha256(bytes) !== provenance.sha256)
            throw new Error("fixture unavailable");
        return check("PINNED_HWP_FIXTURE_AVAILABLE", true, false, { count: 1 });
    }
    catch {
        return check("PINNED_HWP_FIXTURE_UNAVAILABLE", false, false, {
            remediation: REMEDIATION.fixture,
        });
    }
}
async function safeRun(dependencies, command, args) {
    try {
        const result = await dependencies.runCommand({
            command,
            args: Object.freeze([...args]),
            cwdCode: "RUNTIME_ROOT",
            shell: false,
            windowsHide: true,
            timeoutMs: COMMAND_TIMEOUT_MS,
            maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
        });
        return Object.freeze({
            code: result.code,
            signal: result.signal,
            timedOut: result.timedOut,
            truncated: result.truncated,
            terminationFailed: result.terminationFailed === true,
            stdout: redactDiagnosticText(result.stdout),
            stderr: redactDiagnosticText(result.stderr),
        });
    }
    catch {
        return Object.freeze({
            code: null,
            signal: null,
            timedOut: false,
            truncated: false,
            terminationFailed: false,
            stdout: "",
            stderr: "",
        });
    }
}
export function executeBoundedCommand(specification, runtimeRoot, dependencies = {}) {
    const platform = dependencies.platform ?? process.platform;
    if (platform === "win32") {
        return executeWindowsBoundedCommand(specification, runtimeRoot, dependencies);
    }
    return new Promise((resolvePromise) => {
        const spawnProcess = dependencies.spawnProcess ?? spawn;
        const terminateProcessTree = dependencies.terminateProcessTree
            ?? ((pid) => terminateDocumentProcessTreeByPid(pid));
        let settled = false;
        let timedOut = false;
        let truncated = false;
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        const child = spawnProcess(specification.command, [...specification.args], {
            cwd: runtimeRoot,
            shell: false,
            windowsHide: true,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const append = (current, chunk) => {
            const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = specification.maxOutputBytes - stdout.byteLength - stderr.byteLength;
            if (remaining <= 0) {
                truncated = true;
                return current;
            }
            if (incoming.byteLength > remaining)
                truncated = true;
            return Buffer.concat([current, incoming.subarray(0, Math.max(0, remaining))]);
        };
        child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
        child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise(result);
        };
        const timer = setTimeout(() => {
            if (settled)
                return;
            timedOut = true;
            void (async () => {
                let treeGone = false;
                try {
                    treeGone = child.pid === undefined ? child.exitCode !== null : await terminateProcessTree(child.pid);
                }
                catch {
                    treeGone = false;
                }
                if (!treeGone) {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    try {
                        child.unref();
                    }
                    catch { }
                }
                finish({
                    code: null,
                    signal: null,
                    timedOut: true,
                    truncated,
                    terminationFailed: !treeGone,
                    stdout: stdout.toString("utf8"),
                    stderr: stderr.toString("utf8"),
                });
            })();
        }, specification.timeoutMs);
        child.once("error", () => finish({
            code: null,
            signal: null,
            timedOut,
            truncated,
            terminationFailed: false,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
        }));
        child.once("close", (code, signal) => {
            if (timedOut)
                return;
            finish({
                code,
                signal,
                timedOut,
                truncated,
                terminationFailed: false,
                stdout: stdout.toString("utf8"),
                stderr: stderr.toString("utf8"),
            });
        });
    });
}
async function executeWindowsBoundedCommand(specification, runtimeRoot, dependencies) {
    const spawnProcess = dependencies.spawnProcess ?? spawn;
    const superviseProcessTree = dependencies.superviseProcessTree ?? superviseDocumentProcessTree;
    const runnerPath = dependencies.runnerPath ?? resolveDoctorRunnerPath();
    const frame = encodeBoundedJsonFrame({
        schemaVersion: DOCTOR_RUNNER_SCHEMA_VERSION,
        command: specification.command,
        args: [...specification.args],
    }, DOCTOR_RUNNER_MAX_FRAME_BYTES);
    const child = spawnProcess(process.execPath, [runnerPath], {
        cwd: runtimeRoot,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let truncated = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const append = (current, chunk) => {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = specification.maxOutputBytes - stdout.byteLength - stderr.byteLength;
        if (remaining <= 0) {
            truncated = true;
            return current;
        }
        if (incoming.byteLength > remaining)
            truncated = true;
        return Buffer.concat([current, incoming.subarray(0, Math.max(0, remaining))]);
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const terminalPromise = new Promise((resolveTerminal) => {
        let terminal = false;
        const finish = (code, signal) => {
            if (terminal)
                return;
            terminal = true;
            resolveTerminal(Object.freeze({ code, signal }));
        };
        child.once("error", () => finish(null, null));
        child.once("close", (code, signal) => finish(code, signal));
    });
    const supervisorReceiptPromise = receipt(superviseProcessTree(child));
    const readyStream = child.stdio[3];
    const readyReceiptPromise = receipt(readyStream === null || readyStream === undefined || !("on" in readyStream)
        ? Promise.reject(new Error("doctor runner control pipe unavailable"))
        : waitForDoctorRunnerReady(readyStream, Math.min(specification.timeoutMs, 2_000)));
    let deadlineTimer;
    const deadlinePromise = new Promise((resolveDeadline) => {
        deadlineTimer = setTimeout(() => resolveDeadline(Object.freeze({ kind: "deadline" })), specification.timeoutMs);
    });
    const startupPromise = Promise.all([supervisorReceiptPromise, readyReceiptPromise]).then(([supervisor, ready]) => Object.freeze({ kind: "startup", supervisor, ready }));
    const startupResult = await Promise.race([startupPromise, deadlinePromise]);
    if (startupResult.kind === "deadline") {
        const [supervisor] = await Promise.all([supervisorReceiptPromise, readyReceiptPromise]);
        const gone = await terminateGatedRunner(child, supervisor);
        destroyChildPipes(child, !gone);
        return commandResult(null, null, true, truncated, !gone, stdout, stderr);
    }
    if (!startupResult.supervisor.ok || !startupResult.ready.ok) {
        if (deadlineTimer !== undefined)
            clearTimeout(deadlineTimer);
        const gone = await terminateGatedRunner(child, startupResult.supervisor);
        destroyChildPipes(child, !gone);
        return commandResult(null, null, false, truncated, !gone, stdout, stderr);
    }
    const input = child.stdin;
    if (input === null) {
        if (deadlineTimer !== undefined)
            clearTimeout(deadlineTimer);
        const gone = await startupResult.supervisor.value.terminate().catch(() => false);
        destroyChildPipes(child, !gone);
        return commandResult(null, null, false, truncated, !gone, stdout, stderr);
    }
    const dispatchPromise = new Promise((resolveDispatch) => {
        input.end(frame, (error) => resolveDispatch(Object.freeze({
            kind: "dispatch",
            ok: error == null,
        })));
    });
    const dispatchResult = await Promise.race([dispatchPromise, terminalPromise, deadlinePromise]);
    if ("kind" in dispatchResult && dispatchResult.kind === "deadline") {
        const gone = await startupResult.supervisor.value.terminate().catch(() => false);
        destroyChildPipes(child, !gone);
        return commandResult(null, null, true, truncated, !gone, stdout, stderr);
    }
    if (!("kind" in dispatchResult)) {
        if (deadlineTimer !== undefined)
            clearTimeout(deadlineTimer);
        const gone = await startupResult.supervisor.value.terminate().catch(() => false);
        destroyChildPipes(child, !gone);
        return commandResult(dispatchResult.code, dispatchResult.signal, false, truncated, !gone, stdout, stderr);
    }
    if (dispatchResult.kind !== "dispatch" || !dispatchResult.ok) {
        if (deadlineTimer !== undefined)
            clearTimeout(deadlineTimer);
        const gone = await startupResult.supervisor.value.terminate().catch(() => false);
        destroyChildPipes(child, !gone);
        return commandResult(null, null, false, truncated, !gone, stdout, stderr);
    }
    const completion = await Promise.race([terminalPromise, deadlinePromise]);
    if (deadlineTimer !== undefined)
        clearTimeout(deadlineTimer);
    const gone = await startupResult.supervisor.value.terminate().catch(() => false);
    destroyChildPipes(child, !gone);
    if ("kind" in completion)
        return commandResult(null, null, true, truncated, !gone, stdout, stderr);
    return commandResult(completion.code, completion.signal, false, truncated, !gone, stdout, stderr);
}
function waitForDoctorRunnerReady(stream, timeoutMs) {
    return new Promise((resolveReady, rejectReady) => {
        let settled = false;
        let bytes = Buffer.alloc(0);
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            stream.removeListener("data", onData);
            stream.removeListener("end", onEnd);
            stream.removeListener("error", onError);
            if (error !== undefined)
                rejectReady(error);
            else
                resolveReady();
        };
        const onData = (chunk) => {
            bytes = Buffer.concat([bytes, chunk]);
            if (bytes.byteLength > Buffer.byteLength(DOCTOR_RUNNER_READY, "utf8")) {
                finish(new Error("invalid doctor runner READY frame"));
            }
        };
        const onEnd = () => {
            if (bytes.toString("utf8") !== DOCTOR_RUNNER_READY) {
                finish(new Error("invalid doctor runner READY frame"));
            }
            else
                finish();
        };
        const onError = () => finish(new Error("doctor runner READY pipe failed"));
        const timer = setTimeout(() => finish(new Error("doctor runner READY timed out")), timeoutMs);
        stream.on("data", onData);
        stream.once("end", onEnd);
        stream.once("error", onError);
    });
}
async function terminateGatedRunner(child, supervisor) {
    if (supervisor.ok)
        return supervisor.value.terminate().catch(() => false);
    if (child.pid === undefined)
        return child.exitCode !== null;
    return terminateDocumentProcessTreeByPid(child.pid).catch(() => false);
}
function destroyChildPipes(child, unref) {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    const control = child.stdio[3];
    if (control !== null && control !== undefined && "destroy" in control
        && typeof control.destroy === "function")
        control.destroy();
    if (unref) {
        try {
            child.unref();
        }
        catch { }
    }
}
function commandResult(code, signal, timedOut, truncated, terminationFailed, stdout, stderr) {
    return Object.freeze({
        code,
        signal,
        timedOut,
        truncated,
        terminationFailed,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
    });
}
async function receipt(promise) {
    try {
        return Object.freeze({ ok: true, value: await promise });
    }
    catch {
        return Object.freeze({ ok: false });
    }
}
function resolveDoctorRunnerPath() {
    return fileURLToPath(new URL(import.meta.url.endsWith(".ts")
        ? "../dist/workers/doctor-command-runner.js"
        : "./workers/doctor-command-runner.js", import.meta.url));
}
async function resolveNpmCommand() {
    const executableDirectory = dirname(process.execPath);
    const candidates = process.platform === "win32"
        ? [join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js")]
        : [
            resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
            resolve(executableDirectory, "..", "share", "node_modules", "npm", "bin", "npm-cli.js"),
            "/usr/share/nodejs/npm/bin/npm-cli.js",
        ];
    for (const candidate of candidates) {
        try {
            const metadata = await lstat(candidate);
            if (!metadata.isSymbolicLink() && metadata.isFile()) {
                return Object.freeze({ command: process.execPath, argsPrefix: Object.freeze([candidate]) });
            }
        }
        catch {
            // Try the next fixed installation layout.
        }
    }
    return null;
}
export async function createDoctorRuntimeAccess(runtimeRoot) {
    const lexicalRoot = resolve(runtimeRoot);
    const rootMetadata = await lstat(lexicalRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
        throw new Error("unsafe diagnostic runtime root");
    }
    const canonicalRoot = await realpath(lexicalRoot);
    if (!samePath(lexicalRoot, canonicalRoot))
        throw new Error("linked diagnostic runtime root");
    const boundary = Object.freeze({ lexicalRoot, canonicalRoot });
    return Object.freeze({
        readJson: async (path) => JSON.parse(new TextDecoder().decode(await readBoundedRuntimeFile(boundary, path, JSON_LIMIT_BYTES))),
        readBytes: (path, maximumBytes) => readBoundedRuntimeFile(boundary, path, maximumBytes),
        statRegular: async (path) => {
            try {
                const { metadata } = await assertOwnedRuntimePath(boundary, path);
                return { regular: metadata.isFile(), size: metadata.size };
            }
            catch {
                return { regular: false, size: 0 };
            }
        },
        sameCanonicalKordocLink: async () => {
            try {
                const vendor = await assertOwnedRuntimePath(boundary, "vendor/kordoc-core");
                if (!vendor.metadata.isDirectory())
                    return false;
                const nodeModules = await assertOwnedRuntimePath(boundary, "node_modules");
                if (!nodeModules.metadata.isDirectory())
                    return false;
                const link = await assertOwnedRuntimePath(boundary, "node_modules/kordoc", true);
                if (!link.metadata.isSymbolicLink())
                    return false;
                return samePath(await realpath(link.absolute), vendor.canonical);
            }
            catch {
                return false;
            }
        },
    });
}
async function readBoundedRuntimeFile(boundary, path, maximumBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > KORDOC_TOTAL_LIMIT_BYTES) {
        throw new Error("invalid diagnostic read budget");
    }
    const { absolute, metadata } = await assertOwnedRuntimePath(boundary, path);
    if (!metadata.isFile() || metadata.size > maximumBytes) {
        throw new Error("unsafe diagnostic file");
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > maximumBytes || !sameFileIdentity(metadata, opened)) {
            throw new Error("diagnostic file changed");
        }
        const bytes = await handle.readFile();
        const final = await handle.stat();
        if (bytes.byteLength !== opened.size || bytes.byteLength > maximumBytes
            || !sameFileIdentity(opened, final) || final.size !== opened.size
            || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
            throw new Error("diagnostic file changed");
        }
        return bytes;
    }
    finally {
        await handle.close();
    }
}
async function assertOwnedRuntimePath(boundary, path, allowFinalLink = false) {
    if (!safeRelativeFile(path))
        throw new Error("unsafe diagnostic path");
    const absolute = resolve(boundary.lexicalRoot, ...path.split("/"));
    const fromRoot = relative(boundary.lexicalRoot, absolute);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        throw new Error("diagnostic path escapes runtime");
    }
    let current = boundary.lexicalRoot;
    const segments = path.split("/");
    let metadata = await lstat(current);
    let canonical = boundary.canonicalRoot;
    for (const [index, segment] of segments.entries()) {
        current = join(current, segment);
        metadata = await lstat(current);
        const final = index === segments.length - 1;
        if (metadata.isSymbolicLink()) {
            if (!final || !allowFinalLink)
                throw new Error("linked diagnostic path component");
            canonical = await realpath(current);
            if (!isWithinBoundary(boundary, canonical))
                throw new Error("diagnostic link escapes runtime");
            continue;
        }
        if (!final && !metadata.isDirectory())
            throw new Error("diagnostic ancestor is not a directory");
        canonical = await realpath(current);
        if (!isWithinBoundary(boundary, canonical) || !samePath(current, canonical)) {
            throw new Error("diagnostic path component is redirected");
        }
    }
    return Object.freeze({ absolute, canonical, metadata });
}
function isWithinBoundary(boundary, candidate) {
    if (samePath(candidate, boundary.canonicalRoot))
        return true;
    const suffix = relative(boundary.canonicalRoot, candidate);
    return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function renderHumanReport(report) {
    const lines = [
        `${report.code} (schema ${report.schemaVersion})`,
        `required: ${report.required.passed} passed, ${report.required.failed} failed`,
        `optional: ${report.optional.available} available, ${report.optional.unavailable} unavailable`,
    ];
    for (const item of report.checks) {
        const details = [
            item.version === undefined ? "" : ` version=${item.version}`,
            item.count === undefined ? "" : ` count=${item.count}`,
        ].join("");
        lines.push(`${item.ok ? "PASS" : item.required ? "FAIL" : "OPTIONAL"} ${item.code}${details}`);
        if (item.remediation !== undefined)
            lines.push(`  ${item.remediation}`);
    }
    return `${lines.join("\n")}\n`;
}
function check(code, ok, required, extra = {}) {
    return Object.freeze({ code, ok, required, ...extra });
}
function successful(result) {
    return result.code === 0 && !result.timedOut && !result.truncated
        && result.terminationFailed !== true;
}
function cleanVersion(value) {
    const match = value.match(/(?:^|\s|v)(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\s|$)/u);
    return match?.[1];
}
function isSupportedPython(version) {
    const [major, minor] = version.split(".").map(Number);
    return major === 3 && minor !== undefined && minor >= 10;
}
function object(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
function isExactStringArray(value, expected) {
    return Array.isArray(value)
        && value.length === expected.length
        && value.every((item, index) => item === expected[index]);
}
function safeRelativeFile(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 512
        && !value.includes("\\")
        && !value.startsWith("/")
        && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function safeHash(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function safeSize(value) {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= KORDOC_FILE_LIMIT_BYTES;
}
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function samePath(left, right) {
    if (process.platform !== "win32")
        return left === right;
    return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
}
function sameFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
    doctorMain().then((code) => {
        process.exitCode = code;
    }).catch(() => {
        process.stderr.write("DOCTOR_INTERNAL_ERROR: reinstall the plugin from a verified release.\n");
        process.exitCode = 1;
    });
}
