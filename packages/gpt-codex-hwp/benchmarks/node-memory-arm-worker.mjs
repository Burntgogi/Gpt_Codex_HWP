import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  assertCleanStderrReceipt,
  closeBenchmarkSession,
  observeStderrLifecycle,
  sampleProcessTrees,
  settleBeforeSampling,
  summarizeSamples,
  summarizeSamplingTiming,
  waitForStderrLifecycle,
} from "./mcp-idle-memory.mjs";
import {
  observeIdentityLedger,
  snapshotLedgerIdentities,
  snapshotProcessTreeIdentities,
  terminateIdentityLedgerProcesses,
  waitForIdentityLedgerGone,
} from "./process-tree-ledger.mjs";

const EXPECTED_TOOL_COUNT = 9;
const SAMPLE_COUNT = 60;
const SAMPLE_INTERVAL_MS = 100;
const CONTROL_ARGS = Object.freeze([]);
const CANDIDATE_ARGS = Object.freeze(["--max-semi-space-size=1"]);
const SPEC_KEYS = Object.freeze(["schemaVersion", "arm", "pair", "sessionCount", "mcpPath", "nodeArgs"]);

export function validateArmWorkerSpec(value) {
  if (!isRecord(value) || !hasExactKeys(value, SPEC_KEYS)
    || value.schemaVersion !== 1
    || (value.arm !== "control" && value.arm !== "candidate")
    || !Number.isSafeInteger(value.pair) || value.pair < 1 || value.pair > 5
    || ![1, 5, 20].includes(value.sessionCount)
    || typeof value.mcpPath !== "string" || !isAbsolute(value.mcpPath)
    || !Array.isArray(value.nodeArgs)
    || JSON.stringify(value.nodeArgs) !== JSON.stringify(value.arm === "candidate" ? CANDIDATE_ARGS : CONTROL_ARGS)) {
    throw new Error("ARM_WORKER_SPEC_INVALID");
  }
  return value;
}

export async function runArmWorker(spec, dependencies = {}) {
  validateArmWorkerSpec(spec);
  const sessions = [];
  const ledger = new Map();
  let toolContractSha256;
  let measurement;
  let cleanupReceipt = { observedIdentityCount: 0, remainingIdentityCount: 0 };
  let stderrBytes = 0;
  let primaryFailure;

  try {
    const startups = await Promise.allSettled(Array.from(
      { length: spec.sessionCount },
      async () => {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [...spec.nodeArgs, spec.mcpPath],
          cwd: dirname(dirname(spec.mcpPath)),
          stderr: "pipe",
        });
        const client = new Client({ name: "gpt-codex-hwp-idle-arm-worker", version: "1" });
        const session = { client, transport, pid: null, stderrLifecycle: null };
        sessions.push(session);
        await withTimeout(client.connect(transport), 10_000, "BENCHMARK_MCP_CONNECT_TIMEOUT");
        if (transport.stderr === null || transport.stderr === undefined) {
          throw new Error("BENCHMARK_STDERR_STREAM_INVALID");
        }
        session.stderrLifecycle = observeStderrLifecycle(transport.stderr);
        const tools = await client.listTools(undefined, { timeout: 10_000 });
        if (tools.tools.length !== EXPECTED_TOOL_COUNT) {
          throw new Error("ARM_WORKER_TOOL_CONTRACT_INVALID");
        }
        const currentHash = sha256(Buffer.from(canonicalJson(tools.tools), "utf8"));
        toolContractSha256 ??= currentHash;
        if (currentHash !== toolContractSha256) {
          throw new Error("ARM_WORKER_TOOL_CONTRACT_INVALID");
        }
        if (!Number.isSafeInteger(transport.pid) || transport.pid <= 0) {
          throw new Error("ARM_WORKER_PROCESS_IDENTITY_INVALID");
        }
        session.pid = transport.pid;
      },
    ));
    const startupFailure = startups.find(({ status }) => status === "rejected");
    if (startupFailure?.status === "rejected") throw startupFailure.reason;

    const rootPids = sessions.map(({ pid }) => pid);
    observeIdentityLedger(ledger, await snapshotProcessTreeIdentities(rootPids));
    const settling = await (dependencies.settle ?? settleBeforeSampling)();
    const sampled = await (dependencies.sample ?? sampleProcessTrees)(
      rootPids,
      SAMPLE_COUNT,
      SAMPLE_INTERVAL_MS,
    );
    const samplingTiming = summarizeSamplingTiming(sampled.timestamps, SAMPLE_INTERVAL_MS);
    if (sampled.samples.some(({ missingRootCount }) => missingRootCount !== 0)) {
      throw new Error("BENCHMARK_PROCESS_SET_CHANGED");
    }
    observeIdentityLedger(ledger, await snapshotProcessTreeIdentities(rootPids));
    measurement = {
      pair: spec.pair,
      arm: spec.arm,
      sessionCount: spec.sessionCount,
      rssBytes: summarizeSamples(sampled.samples.map(({ rssBytes }) => rssBytes)),
      privateBytes: sampled.samples.every(({ privateBytes }) => Number.isSafeInteger(privateBytes))
        ? summarizeSamples(sampled.samples.map(({ privateBytes }) => privateBytes))
        : "unsupported",
      descendantCount: summarizeSamples(sampled.samples.map(({ descendantCount }) => descendantCount)),
      settling,
      samplingTiming,
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    const rootPids = sessions.map(({ pid, transport }) => pid ?? transport.pid)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    if (rootPids.length > 0) {
      try {
        observeIdentityLedger(ledger, await snapshotProcessTreeIdentities(rootPids));
      } catch (error) {
        if (ledger.size === 0 && primaryFailure === undefined) primaryFailure = error;
      }
    }
    const closes = await Promise.allSettled(sessions.map(closeBenchmarkSession));
    if (closes.some(({ status }) => status === "rejected") && primaryFailure === undefined) {
      primaryFailure = new Error("BENCHMARK_CLIENT_CLOSE_FAILED");
    }
    const stderrReceipts = await Promise.allSettled(sessions.map(async (session) => {
      if (session.stderrLifecycle === null && session.transport.stderr !== undefined) {
        session.stderrLifecycle = observeStderrLifecycle(session.transport.stderr);
      }
      if (session.stderrLifecycle === null) throw new Error("BENCHMARK_STDERR_STREAM_INVALID");
      return waitForStderrLifecycle(session.stderrLifecycle, 5_000);
    }));
    for (const outcome of stderrReceipts) {
      if (outcome.status === "rejected") {
        primaryFailure ??= outcome.reason;
        continue;
      }
      stderrBytes += outcome.value.bytes;
      try { assertCleanStderrReceipt(outcome.value); }
      catch (error) { primaryFailure ??= error; }
    }
    if (ledger.size > 0) {
      try {
        await terminateIdentityLedgerProcesses({ ledger });
      } catch (error) {
        primaryFailure ??= error;
      }
      cleanupReceipt = await waitForIdentityLedgerGone({
        ledger,
        timeoutMs: 5_000,
        snapshot: () => snapshotLedgerIdentities(ledger),
      });
      if (cleanupReceipt.remainingIdentityCount !== 0) {
        primaryFailure ??= new Error("BENCHMARK_PROCESS_IDENTITIES_REMAIN");
      }
    }
  }

  if (primaryFailure !== undefined) throw primaryFailure;
  if (measurement === undefined || typeof toolContractSha256 !== "string") {
    throw new Error("BENCHMARK_MEASUREMENT_MISSING");
  }
  return {
    schemaVersion: 1,
    status: "ok",
    toolCount: EXPECTED_TOOL_COUNT,
    toolContractSha256,
    unexpectedStderrBytes: stderrBytes,
    remainingDescendants: cleanupReceipt.remainingIdentityCount,
    cleanup: cleanupReceipt,
    result: measurement,
  };
}

async function readPrivateSpec(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("ARM_WORKER_SPEC_INVALID");
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 2 || status.size > 64 * 1024) {
    throw new Error("ARM_WORKER_SPEC_INVALID");
  }
  return validateArmWorkerSpec(JSON.parse(await readFile(path, "utf8")));
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("ARM_WORKER_TOOL_CONTRACT_INVALID");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function safeErrorCode(error) {
  const message = error instanceof Error ? error.message : "ARM_WORKER_FAILED";
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(message) ? message : "ARM_WORKER_FAILED";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  let receipt;
  try {
    const spec = await readPrivateSpec(process.env.GPT_CODEX_HWP_ARM_SPEC);
    receipt = await runArmWorker(spec);
  } catch (error) {
    receipt = { schemaVersion: 1, status: "error", code: safeErrorCode(error) };
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
