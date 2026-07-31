import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  observeChildProcessClose,
  superviseDocumentProcessTree,
  terminateGatedChildByHandle,
} from "../dist/workers/document-child-client.js";
import {
  DOCUMENT_REGISTRATION_ENV,
  DOCUMENT_START_FRAME,
} from "../dist/workers/document-process-registration.js";
import {
  observeIdentityLedger,
  snapshotLedgerIdentities,
  snapshotProcessTreeIdentities,
  waitForIdentityLedgerGone,
} from "./process-tree-ledger.mjs";

const MAX_STREAM_BYTES = 64 * 1024;
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const START_GATE_ENTRY = resolve(PACKAGE_ROOT, "dist", "workers", "document-child-start-gate.js");
const SAFE_ENVIRONMENT_NAMES = process.platform === "win32"
  ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
  : ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER"];

export async function runSupervisedArm({
  command,
  args,
  cwd,
  timeoutMs = 30_000,
  environment = {},
}) {
  validateLaunch({ command, args, cwd, timeoutMs, environment });
  const target = resolve(cwd, args[0]);
  const childArgs = process.platform === "win32"
    ? ["--import", pathToFileURL(START_GATE_ENTRY).href, target]
    : [START_GATE_ENTRY, target];
  const child = spawn(command, childArgs, {
    cwd,
    detached: process.platform !== "win32",
    env: {
      ...defaultRuntimeEnvironment(),
      ...environment,
      [DOCUMENT_REGISTRATION_ENV]: "0",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const closeReceipt = observeChildProcessClose(child);
  const exitReceipt = observeChildExit(child);
  const gate = child.stdio?.[7];
  const stdout = collectBoundedStream(child.stdout, "ARM_WORKER_RECEIPT_INVALID");
  const stderr = collectBoundedStream(child.stderr, "ARM_WORKER_STDERR_LIMIT");
  const ledger = new Map();
  let supervisor;
  let primaryFailure;
  let outcome;

  try {
    await waitForSpawn(child);
    if (gate === null || gate === undefined || typeof gate.write !== "function") {
      throw new Error("ARM_WORKER_START_GATE_INVALID");
    }
    supervisor = await superviseDocumentProcessTree(child);
    observeIdentityLedger(ledger, await snapshotRootWithRetry(child.pid));
    await writeStartFrame(gate);
    outcome = await waitForWorkerCompletion(exitReceipt, stdout.firstFrame, timeoutMs);
    if (outcome === "timeout") primaryFailure = new Error("ARM_WORKER_TIMEOUT");
    if (outcome?.kind === "receipt") {
      const graceOutcome = await Promise.race([
        exitReceipt.then((receipt) => ({ kind: "exit", receipt })),
        new Promise((resolveGrace) => setTimeout(() => resolveGrace({ kind: "receipt" }), 100)),
      ]);
      outcome = graceOutcome;
    }
  } catch (error) {
    primaryFailure = error instanceof Error ? error : new Error("ARM_WORKER_FAILED");
  } finally {
    try { gate?.destroy(); } catch {}
    const terminated = supervisor === undefined
      ? await terminateGatedChildByHandle(child, closeReceipt)
      : await supervisor.terminate().then((receipt) => receipt?.gone === true, () => false);
    if (!terminated) throw new Error("ARM_WORKER_SUPERVISOR_CLEANUP_FAILED");
  }

  const cleanup = ledger.size === 0
    ? { observedIdentityCount: 0, remainingIdentityCount: 0 }
    : await waitForIdentityLedgerGone({
        ledger,
        timeoutMs: 5_000,
        snapshot: () => snapshotLedgerIdentities(ledger),
      });
  if (cleanup.remainingIdentityCount !== 0) throw new Error("ARM_WORKER_LEDGER_CLEANUP_FAILED");

  const [stdoutReceipt, stderrReceipt] = await Promise.all([stdout.closed, stderr.closed]);
  if (stderrReceipt.bytes !== 0) throw new Error("ARM_WORKER_STDERR_NONZERO");
  if (primaryFailure !== undefined) throw primaryFailure;
  if (outcome?.kind === "exit"
    && (outcome.receipt.code !== 0 || outcome.receipt.signal !== null || outcome.receipt.error !== null)) {
    throw new Error("ARM_WORKER_EXIT_NONZERO");
  }
  return parseSingleReceipt(stdoutReceipt.bytesValue);
}

function validateLaunch({ command, args, cwd, timeoutMs, environment }) {
  if (typeof command !== "string" || !isAbsolute(command)
    || !Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string" || !isAbsolute(args[0])
    || typeof cwd !== "string" || !isAbsolute(cwd)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
    || environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("ARM_WORKER_LAUNCH_INVALID");
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || typeof value !== "string"
      || Buffer.byteLength(value, "utf8") > 32 * 1024) {
      throw new Error("ARM_WORKER_LAUNCH_INVALID");
    }
  }
}

function defaultRuntimeEnvironment() {
  return Object.fromEntries(SAFE_ENVIRONMENT_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value.startsWith("()") ? [] : [[name, value]];
  }));
}

function collectBoundedStream(stream, limitCode) {
  if (stream === null || stream === undefined) throw new Error("ARM_WORKER_STREAM_INVALID");
  let byteCount = 0;
  const chunks = [];
  let streamFailure;
  let frameSeen = false;
  let resolveFrame;
  const firstFrame = new Promise((resolveFirstFrame) => { resolveFrame = resolveFirstFrame; });
  stream.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += bytes.byteLength;
    if (byteCount > MAX_STREAM_BYTES) {
      streamFailure ??= new Error(limitCode);
      stream.destroy(streamFailure);
      return;
    }
    chunks.push(bytes);
    if (!frameSeen && bytes.includes(0x0a)) {
      frameSeen = true;
      resolveFrame();
    }
  });
  stream.once("error", (error) => { streamFailure ??= error; });
  const closed = new Promise((resolveClosed, rejectClosed) => {
    stream.once("close", () => {
      if (streamFailure !== undefined) rejectClosed(streamFailure);
      else resolveClosed(Object.freeze({
        bytes: byteCount,
        bytesValue: Buffer.concat(chunks, byteCount),
      }));
    });
  });
  return Object.freeze({ closed, firstFrame });
}

function waitForSpawn(child) {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolveSpawn, rejectSpawn) => {
    const spawned = () => {
      child.removeListener("error", failed);
      resolveSpawn();
    };
    const failed = (error) => {
      child.removeListener("spawn", spawned);
      rejectSpawn(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

function observeChildExit(child) {
  return new Promise((resolveExit) => {
    let childError = null;
    const onError = (error) => { childError ??= error; };
    child.on("error", onError);
    child.once("exit", (code, signal) => {
      child.removeListener("error", onError);
      resolveExit(Object.freeze({ code, signal, error: childError }));
    });
  });
}

async function snapshotRootWithRetry(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("ARM_WORKER_PROCESS_IDENTITY_INVALID");
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await snapshotProcessTreeIdentities([pid]);
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ARM_WORKER_PROCESS_IDENTITY_INVALID");
}

function writeStartFrame(gate) {
  return new Promise((resolveWrite, rejectWrite) => {
    gate.write(DOCUMENT_START_FRAME, (error) => {
      if (error === undefined || error === null) resolveWrite();
      else rejectWrite(error);
    });
  });
}

async function waitForWorkerCompletion(exitReceipt, firstFrame, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      exitReceipt.then((receipt) => ({ kind: "exit", receipt })),
      firstFrame.then(() => ({ kind: "receipt" })),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseSingleReceipt(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
    throw new Error("ARM_WORKER_RECEIPT_INVALID");
  }
  const lines = bytes.toString("utf8").split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1) throw new Error("ARM_WORKER_RECEIPT_INVALID");
  try {
    const value = JSON.parse(lines[0]);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("ARM_WORKER_RECEIPT_INVALID");
    }
    return value;
  } catch {
    throw new Error("ARM_WORKER_RECEIPT_INVALID");
  }
}
