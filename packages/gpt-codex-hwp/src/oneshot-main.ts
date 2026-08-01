import { extname, isAbsolute } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PROJECT_METADATA } from "./generated/project-metadata.js";
import {
  configureAllowedRootsForMcp,
  createMcpServer,
} from "./mcp-main.js";
import { readFileBounded } from "./shared/files.js";
import {
  preflightExclusiveOutput,
  writeFilesExclusively,
} from "./shared/output.js";
import {
  assertUtf8Budget,
  MAX_MCP_RESPONSE_BYTES,
} from "./shared/resource-limits.js";
import { toolDefinitions } from "./tools/index.js";
import { MAX_DOCUMENT_DEADLINE_MS } from "./workers/document-execution-policy.js";
import { subscribeDocumentChildTerminationReceipts } from "./workers/document-child-termination-channel.js";
import {
  normalizeProcessTreeTerminationReceipt,
  type ProcessTreeTerminationReceipt,
} from "./workers/registered-process-supervisor.js";

export interface OneShotPaths {
  readonly requestPath: string;
  readonly responsePath: string;
}

export interface OneShotRequest {
  readonly schemaVersion: 1;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface OneShotRunOptions {
  readonly signal?: AbortSignal;
}

export const MAX_ONESHOT_REQUEST_BYTES = 32 * 1024 * 1024;
export const ONESHOT_CLEANUP_ALLOWANCE_MS = 15_000;
export const ONESHOT_TOOL_TIMEOUT_MS =
  MAX_DOCUMENT_DEADLINE_MS + ONESHOT_CLEANUP_ALLOWANCE_MS;

export const ONESHOT_CLEANUP_EVIDENCE_ENV =
  "GPT_CODEX_HWP_ONESHOT_CLEANUP_EVIDENCE";

interface OneShotCleanupEvidenceCollectorOptions {
  readonly platform?: NodeJS.Platform;
  readonly subscribe?: (
    observer: (message: unknown) => void,
  ) => () => void;
}

export function createOneShotCleanupEvidenceCollector(
  options: OneShotCleanupEvidenceCollectorOptions = {},
): Readonly<{ finish(): string }> {
  const receipts: ProcessTreeTerminationReceipt[] = [];
  let duplicate = false;
  let finished = false;
  const unsubscribe = (
    options.subscribe ?? subscribeDocumentChildTerminationReceipts
  )((message) => {
    if (receipts.length >= 2) {
      duplicate = true;
      return;
    }
    receipts.push(normalizeProcessTreeTerminationReceipt(message));
  });
  return Object.freeze({
    finish(): string {
      if (finished) throw new Error("One-shot cleanup evidence is unavailable.");
      finished = true;
      unsubscribe();
      if (duplicate || receipts.length !== 1) {
        throw new Error("One-shot cleanup evidence is invalid.");
      }
      const receipt = receipts[0];
      const platform = options.platform ?? process.platform;
      if (platform === "win32") {
        if (!receipt.gone || receipt.proof !== "windows-job-empty") {
          throw new Error("One-shot cleanup evidence is unverified.");
        }
        return "ONESHOT_CLEANUP proof=windows-job-empty observedProcessTrees=1 remainingProcessTrees=0\n";
      }
      if ((platform !== "linux" && platform !== "darwin")
        || !receipt.gone || receipt.proof !== "registered-groups-empty"
        || !("registeredIdentityCount" in receipt)
        || receipt.registeredIdentityCount < 1
        || receipt.remainingIdentityCount !== 0) {
        throw new Error("One-shot cleanup evidence is unverified.");
      }
      return `ONESHOT_CLEANUP proof=registered-groups-empty observedProcessTrees=${receipt.registeredIdentityCount} remainingProcessTrees=0\n`;
    },
  });
}

const TOOL_NAMES = new Set(toolDefinitions.map(({ name }) => name));

export function parseOneShotArguments(argv: readonly string[]): OneShotPaths {
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

export function parseOneShotRequest(bytes: Uint8Array): OneShotRequest {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
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
  } catch {
    throw new Error("Invalid one-shot request.");
  }
}

export function callOneShotTool(
  client: Pick<Client, "callTool">,
  request: OneShotRequest,
  options: OneShotRunOptions = {},
) {
  return client.callTool(
    { name: request.tool, arguments: request.arguments },
    undefined,
    { timeout: ONESHOT_TOOL_TIMEOUT_MS, signal: options.signal },
  );
}

export async function runOneShot(
  argv: readonly string[] = process.argv.slice(2),
  options: OneShotRunOptions = {},
): Promise<0 | 1 | 2> {
  let client: Client | undefined;
  let server: McpServer | undefined;
  try {
    const paths = parseOneShotArguments(argv);
    await configureAllowedRootsForMcp();
    const request = parseOneShotRequest(await readFileBounded(
      paths.requestPath,
      "one-shot request",
      MAX_ONESHOT_REQUEST_BYTES,
      { directPath: true },
    ));
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
    await writeFilesExclusively(
      [{ path: response.path, data: serialized, mode: 0o600 }],
      {
        sourcePaths: [paths.requestPath],
        expectedDirectoryIdentities: response.expectedDirectoryIdentities,
      },
    );
    return result.isError === true ? 1 : 0;
  } catch {
    return 2;
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

function isJsonPath(value: string): boolean {
  return isAbsolute(value) && extname(value).toLowerCase() === ".json";
}

function comparablePath(value: string): string {
  return process.platform === "win32"
    ? value.toLocaleLowerCase("en-US")
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runOneShotEntry(
  argv: readonly string[] = process.argv.slice(2),
): Promise<0 | 1 | 2> {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let code: 0 | 1 | 2 = 2;
  let cleanupEvidence: ReturnType<typeof createOneShotCleanupEvidenceCollector> | undefined;
  let cleanupEvidenceReceipt = "";
  try {
    const evidenceMode = process.env[ONESHOT_CLEANUP_EVIDENCE_ENV];
    delete process.env[ONESHOT_CLEANUP_EVIDENCE_ENV];
    if (evidenceMode !== undefined) {
      if (evidenceMode !== "stdout") throw new Error("Invalid one-shot cleanup evidence mode.");
      cleanupEvidence = createOneShotCleanupEvidenceCollector();
    }
    code = await runOneShot(argv, { signal: controller.signal });
    if (code === 0 && cleanupEvidence !== undefined) {
      cleanupEvidenceReceipt = cleanupEvidence.finish();
    }
  } catch {
    code = 2;
  } finally {
    if (code !== 0 && cleanupEvidence !== undefined) {
      try { cleanupEvidence.finish(); } catch {}
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
  } catch {
    process.exitCode = 2;
  }
  return code;
}
