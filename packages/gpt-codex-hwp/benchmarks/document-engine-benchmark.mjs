import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { generatePaddedHwpx } from "./generate-padded-hwpx.mjs";
import { createProcessRegistrationCoordinator } from "../src/workers/document-process-registration.ts";
import {
  createRegisteredPosixProcessGroupSupervisor,
  normalizeProcessTreeTerminationReceipt,
  unverifiedTermination,
} from "../src/workers/registered-process-supervisor.ts";

export const APPROVED_BENCHMARK_SIZES_MIB = Object.freeze([10, 100, 256, 512]);
export const BENCHMARK_CONCURRENCY = 1;
export const BENCHMARK_RECEIPT_SCHEMA_VERSION = 2;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const MAX_CASE_OUTPUT_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const CASE_DEADLINE_MS = 10 * 60 * 1000;
const POSIX_TELEMETRY_FLUSH_MS = 20_000;
const LARGE_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CASE_METADATA_FILENAME = "case-source.json";
const CASE_CONTROL_FILENAME = ".case-owner-control";
const CASE_PREFIX = ".document-benchmark-case-";
const MAX_CASE_CONTROL_BYTES = 4 * 1024;
const MAX_CASE_TELEMETRY_BYTES = 512 * 1024;
const STRICT_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_ERROR_CODES = new Set([
  "ENGINE_OOM",
  "ENGINE_RESOURCE_LIMIT",
  "ENGINE_TIMEOUT",
  "ENGINE_CRASH",
  "ENGINE_INIT_FAILED",
  "ENGINE_PROTOCOL_ERROR",
  "ENGINE_TERMINATION_FAILED",
  "BENCHMARK_PROBE_FAILED",
  "BENCHMARK_SOURCE_CHANGED",
]);
const SAFE_PROBE_ERROR_CODES = new Set([...SAFE_ERROR_CODES, "ENGINE_INIT_FAILED"]);
const SAFE_CASE_PHASES = new Set(["facade", "snapshot", "detect", "probe"]);
const SAFE_SNAPSHOT_STAGES = new Set([
  "source-authorize", "source-open", "spool-directory-create",
  "spool-directory-acl", "spool-directory-sid", "spool-directory-icacls",
  "spool-directory-verify", "spool-file-create", "spool-file-acl",
  "spool-file-sid", "spool-file-icacls", "spool-file-verify",
  "spool-copy", "spool-sync", "spool-file-reacl", "spool-verify",
  "spool-file-reacl-sid", "spool-file-reacl-icacls", "spool-file-reacl-verify",
  "source-reauthorize", "source-verify",
]);
for (const prefix of ["spool-directory", "spool-file", "spool-file-reacl"]) {
  for (const reason of [
    "process", "exception", "unprotected", "extra-rule", "missing-required", "invalid-rule",
    "invalid-output",
  ]) SAFE_SNAPSHOT_STAGES.add(`${prefix}-verify-${reason}`);
}
const SAFE_ENGINE_STAGES = new Set([
  "startup", "detect", "parse", "render", "generateHwpx", "patchHwpx",
  "fillHwpx", "validateHwpx", "insertImage", "shutdown",
]);
const SAFE_BENCHMARK_DIAGNOSTIC_STAGES = new Set([
  "ready-mode-1",
  "ready-mode-2",
  "error-startup",
  "error-baseline-rss",
  "error-sampling",
  "error-termination",
  "error-rss-receipt",
  "finalizer",
  "channel",
  "windows-startup",
  "windows-baseline-rss",
  "windows-sampling",
  "windows-termination",
  "windows-termination-discovery-or-rss-unavailable",
  "windows-termination-retained-handle-unavailable",
  "windows-termination-scan-exhausted",
  "windows-rss-receipt",
  "windows-finalizer",
  "windows-channel",
  "posix-root-authority",
  "posix-telemetry-initialize",
  "posix-telemetry-sample",
]);
const RECEIPT_KEYS = [
  "actualBytes",
  "arch",
  "copiedBytes",
  "dispatchStarted",
  "elapsedMs",
  "errorCode",
  "executionMode",
  "operation",
  "outputSha256",
  "peakRssDeltaBytes",
  "platform",
  "requestedMiB",
  "responseBytes",
  "runtime",
  "schemaVersion",
  "sourceSha256",
  "status",
];
const CASE_OUTCOME_KEYS = ["errorCode", "responseBytes", "status"];

export function classifyBenchmarkSupervisorFrame(frame) {
  if (typeof frame !== "string") return "channel";
  const windowsError = /^GPT_CODEX_HWP_JOB ERROR (startup|baseline-rss|sampling|termination|termination-(?:discovery-or-rss-unavailable|retained-handle-unavailable|scan-exhausted)|rss-receipt|finalizer|channel) [A-Za-z0-9_-]+$/u.exec(frame);
  if (windowsError !== null) return `windows-${windowsError[1]}`;
  const posixError = /^GPT_CODEX_HWP_POSIX ERROR (root-authority|telemetry-initialize|telemetry-sample)$/u.exec(frame);
  if (posixError !== null) return `posix-${posixError[1]}`;
  const ready = /^GPT_CODEX_HWP_JOB READY [1-9][0-9]* ([12]) [0-9]+$/u.exec(frame);
  if (ready !== null) return ready[1] === "1" ? "ready-mode-1" : "ready-mode-2";
  if (/^GPT_CODEX_HWP_JOB (?:RSS [0-9]+ [0-9]+|GONE 0 [12])$/u.test(frame)) {
    return "finalizer";
  }
  return "channel";
}

export function formatBenchmarkFailure(error) {
  const code = typeof error?.code === "string"
    && /^BENCHMARK_[A-Z_]+$/u.test(error.code)
    ? error.code
    : "BENCHMARK_FAILED";
  const stage = SAFE_BENCHMARK_DIAGNOSTIC_STAGES.has(error?.diagnosticStage)
    ? error.diagnosticStage
    : undefined;
  return stage === undefined ? code : `${code} stage=${stage}`;
}

export function parseBenchmarkArguments(args, options = {}) {
  if (!Array.isArray(args) || args.length !== 4
    || args[0] !== "--sizes" || args[2] !== "--output") {
    throw benchmarkError("BENCHMARK_ARGUMENTS_INVALID");
  }
  const sizesMiB = String(args[1]).split(",").map(Number);
  if (sizesMiB.length === 0
    || new Set(sizesMiB).size !== sizesMiB.length
    || !sizesMiB.every((size) => APPROVED_BENCHMARK_SIZES_MIB.includes(size))) {
    throw benchmarkError("BENCHMARK_ARGUMENTS_INVALID");
  }
  if (sizesMiB.some((size) => size > 10)
    && (options.env ?? process.env).HWP_BENCH_LARGE !== "1") {
    throw benchmarkError("BENCHMARK_LARGE_DISABLED");
  }
  if (typeof args[3] !== "string" || args[3].trim().length === 0) {
    throw benchmarkError("BENCHMARK_ARGUMENTS_INVALID");
  }
  return {
    sizesMiB,
    outputPath: resolve(options.repositoryRoot ?? REPOSITORY_ROOT, args[3]),
  };
}

export function validateCaseSizeMiB(sizeMiB) {
  if (!APPROVED_BENCHMARK_SIZES_MIB.includes(sizeMiB)) {
    throw benchmarkError("BENCHMARK_ARGUMENTS_INVALID");
  }
  return sizeMiB;
}

export async function assertIgnoredBenchmarkOutput(
  outputPath,
  options = {},
) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  if (typeof outputPath !== "string" || outputPath.trim().length === 0) {
    throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
  }
  const absolute = resolve(outputPath);
  const lexical = relative(repositoryRoot, absolute);
  if (lexical === "" || lexical === ".." || lexical.startsWith(`..${sep}`)
    || isAbsolute(lexical)) {
    throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
  }
  const normalized = lexical.split(sep).join("/");
  if (!normalized.includes("/")
    || /^(?:packages|plugins|src|dist|public|benchmarks)(?:\/|$)/iu.test(normalized)
    || /(?:^|\/)(?:src|dist|public|runtime)(?:\/|$)/iu.test(normalized)) {
    throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
  }
  const outputParent = dirname(absolute);
  await rejectPathAliases(repositoryRoot, outputParent);
  await assertSafeExistingTarget(absolute);
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", outputParent], {
    cwd: repositoryRoot,
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  if (ignored.status !== 0) throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
  return absolute;
}

async function assertSafeExistingTarget(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
    }
    if (comparable(await realpath(path)) !== comparable(path)) {
      throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function rejectPathAliases(repositoryRoot, outputParent) {
  const rootReal = await realpath(repositoryRoot);
  if (comparable(rootReal) !== comparable(repositoryRoot)) {
    throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
  }
  const pathParts = relative(repositoryRoot, outputParent).split(sep).filter(Boolean);
  let current = repositoryRoot;
  for (const part of pathParts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
      const canonical = await realpath(current);
      if (comparable(canonical) !== comparable(current)) {
        throw benchmarkError("BENCHMARK_OUTPUT_UNSAFE");
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

function comparable(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function validateBenchmarkReceipt(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== RECEIPT_KEYS.join(",")
    || value.schemaVersion !== BENCHMARK_RECEIPT_SCHEMA_VERSION
    || typeof value.platform !== "string" || !/^[a-z0-9_-]+$/iu.test(value.platform)
    || typeof value.arch !== "string" || !/^[a-z0-9_-]+$/iu.test(value.arch)
    || typeof value.runtime !== "string" || !/^node-v\d+\.\d+\.\d+$/u.test(value.runtime)
    || !APPROVED_BENCHMARK_SIZES_MIB.includes(value.requestedMiB)
    || !safeNonNegative(value.actualBytes)
    || value.operation !== "detectFormat"
    || !["transferable-worker", "supervised-child"].includes(value.executionMode)
    || !["passed", "resource-refused", "failed"].includes(value.status)
    || !safeNonNegative(value.elapsedMs)
    || !safeNonNegative(value.peakRssDeltaBytes)
    || !safeNonNegative(value.copiedBytes)
    || typeof value.dispatchStarted !== "boolean"
    || !safeNonNegative(value.responseBytes)
    || !hashOrNull(value.outputSha256)
    || !hashOrNull(value.sourceSha256)
    || !validErrorCode(value.status, value.errorCode)) {
    throw benchmarkError("BENCHMARK_RECEIPT_INVALID");
  }
  const requestedBytes = value.requestedMiB * 1024 * 1024;
  const expectedMode = value.requestedMiB === 10
    ? "transferable-worker"
    : "supervised-child";
  const sourcePresent = hash(value.sourceSha256);
  const sourceSemantics = sourcePresent
    ? value.actualBytes > 0
      && value.actualBytes <= requestedBytes
      && requestedBytes - value.actualBytes <= 4096
      && value.copiedBytes <= value.actualBytes
    : value.status === "failed"
      && value.dispatchStarted === false
      && value.actualBytes === 0
      && value.copiedBytes === 0;
  const statusSemantics = value.status === "passed"
    ? value.dispatchStarted === true
      && value.copiedBytes === value.actualBytes
      && value.errorCode === null
      && value.responseBytes > 0
    : value.responseBytes === 0
      && (value.dispatchStarted || value.copiedBytes === 0);
  if (value.executionMode !== expectedMode
    || value.outputSha256 !== null
    || !sourceSemantics
    || !statusSemantics) {
    throw benchmarkError("BENCHMARK_RECEIPT_INVALID");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES
    || /(?:[A-Z]:\\|\/Users\/|\/home\/|\\Users\\|\r|\n)/u.test(serialized)) {
    throw benchmarkError("BENCHMARK_RECEIPT_INVALID");
  }
  return value;
}

function safeNonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function hashOrNull(value) {
  return value === null || hash(value);
}

function validErrorCode(status, code) {
  if (status === "passed") return code === null;
  if (typeof code !== "string" || !SAFE_ERROR_CODES.has(code)) return false;
  if (status === "resource-refused") {
    return code === "ENGINE_RESOURCE_LIMIT" || code === "ENGINE_OOM";
  }
  return true;
}

export async function validateLargeBenchmarkEvidence(path, options = {}) {
  try {
    await assertIgnoredBenchmarkOutput(path, options);
  } catch {
    throw benchmarkError("BENCHMARK_EVIDENCE_INVALID");
  }
  let evidence;
  let evidenceStatus;
  try {
    evidenceStatus = await lstat(path);
    if (evidenceStatus.isSymbolicLink() || !evidenceStatus.isFile()
      || evidenceStatus.size <= 0 || evidenceStatus.size > MAX_RECEIPT_BYTES
      || comparable(await realpath(path)) !== comparable(resolve(path))) {
      throw benchmarkError("BENCHMARK_EVIDENCE_INVALID");
    }
    const serialized = await readFile(path, "utf8");
    if (Buffer.byteLength(serialized) !== evidenceStatus.size
      || /(?:[A-Z]:\\|\/Users\/|\/home\/|\\Users\\)/u.test(serialized)) {
      throw benchmarkError("BENCHMARK_EVIDENCE_INVALID");
    }
    evidence = JSON.parse(serialized);
  } catch {
    throw benchmarkError("BENCHMARK_EVIDENCE_INVALID");
  }
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? LARGE_EVIDENCE_MAX_AGE_MS;
  const generatedAt = STRICT_ISO_TIMESTAMP.test(evidence?.generatedAt ?? "")
    ? Date.parse(evidence.generatedAt)
    : Number.NaN;
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)
    || Object.keys(evidence).sort().join(")") !== "concurrency)generatedAt)implementationSha256)receipts)schemaVersion"
    || evidence.schemaVersion !== BENCHMARK_RECEIPT_SCHEMA_VERSION
    || evidence.concurrency !== BENCHMARK_CONCURRENCY
    || !Number.isFinite(generatedAt) || generatedAt > now
    || now - generatedAt > maxAgeMs
    || evidenceStatus.mtimeMs > now + 1_000
    || Math.abs(evidenceStatus.mtimeMs - generatedAt) > 60_000
    || !Array.isArray(evidence.receipts)
    || evidence.receipts.length !== 3) {
    throw benchmarkError("BENCHMARK_EVIDENCE_INVALID");
  }
  if (!hash(evidence.implementationSha256)
    || evidence.implementationSha256 !== await benchmarkImplementationSha256()) {
    throw benchmarkError("BENCHMARK_EVIDENCE_INVALID");
  }
  const receipts = evidence.receipts.map(validateBenchmarkReceipt);
  const host = receipts[0];
  if (receipts.map((receipt) => receipt.requestedMiB).join(",") !== "100,256,512"
    || receipts.some((receipt) => receipt.status === "failed")
    || receipts.some((receipt) => receipt.platform !== host.platform
      || receipt.arch !== host.arch || receipt.runtime !== host.runtime)) {
    throw benchmarkError("BENCHMARK_EVIDENCE_INVALID");
  }
  return evidence;
}

export function formatBenchmarkProgress(receipt) {
  if (!APPROVED_BENCHMARK_SIZES_MIB.includes(receipt?.requestedMiB)
    || !["passed", "resource-refused", "failed"].includes(receipt?.status)) {
    throw benchmarkError("BENCHMARK_RECEIPT_INVALID");
  }
  const errorCode = typeof receipt.errorCode === "string"
    && SAFE_ERROR_CODES.has(receipt.errorCode)
    ? ` errorCode=${receipt.errorCode}`
    : "";
  return `BENCHMARK_CASE requestedMiB=${receipt.requestedMiB} status=${receipt.status}${errorCode}`;
}

export async function createOwnedBenchmarkCase(outputParent) {
  const parent = resolve(outputParent);
  await assertIgnoredBenchmarkOutput(join(parent, "case-boundary.json"));
  await mkdir(parent, { recursive: true });
  const path = await mkdtemp(join(parent, CASE_PREFIX));
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()
    || dirname(path) !== parent || comparable(await realpath(path)) !== comparable(path)) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
  const token = randomUUID();
  const control = Object.freeze({
    token,
    ownedRoot: parent,
    ownedCase: path,
    device: String(info.dev),
    inode: String(info.ino),
  });
  const marker = await open(join(path, CASE_CONTROL_FILENAME), "wx", 0o600);
  try {
    await marker.writeFile(`${JSON.stringify(control)}\n`, "utf8");
    await marker.sync();
  } finally {
    await marker.close();
  }
  return Object.freeze({ path, parent, device: info.dev, inode: info.ino, control });
}

export async function cleanupOwnedBenchmarkCase(owner) {
  const path = resolve(owner?.path ?? "");
  const parent = resolve(owner?.parent ?? "");
  const lexical = relative(parent, path);
  if (dirname(path) !== parent || !lexical.startsWith(CASE_PREFIX)
    || lexical.includes(sep)) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()
    || info.dev !== owner.device || info.ino !== owner.inode
    || comparable(await realpath(path)) !== comparable(path)) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
  await rm(path, { recursive: true, force: false });
}

export async function runBenchmark({ sizesMiB, outputPath, onReceipt }) {
  if (onReceipt !== undefined && typeof onReceipt !== "function") {
    throw benchmarkError("BENCHMARK_ARGUMENTS_INVALID");
  }
  const safeOutput = await assertIgnoredBenchmarkOutput(outputPath);
  await mkdir(dirname(safeOutput), { recursive: true });
  await assertFreshOutput(safeOutput);
  const implementationSha256 = await benchmarkImplementationSha256();
  const receipts = [];
  for (const sizeMiB of sizesMiB) {
    const receipt = await runBenchmarkCaseWithTelemetryRetry(sizeMiB, dirname(safeOutput));
    receipts.push(receipt);
    onReceipt?.(receipt);
  }
  if (implementationSha256 !== await benchmarkImplementationSha256()) {
    throw benchmarkError("BENCHMARK_SOURCE_CHANGED");
  }
  const evidence = Object.freeze({
    schemaVersion: BENCHMARK_RECEIPT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    concurrency: BENCHMARK_CONCURRENCY,
    implementationSha256,
    receipts,
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) {
    throw benchmarkError("BENCHMARK_RECEIPT_INVALID");
  }
  const temporaryReceipt = join(
    dirname(safeOutput),
    `.benchmark-receipt-${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporaryReceipt, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertIgnoredBenchmarkOutput(safeOutput);
    await assertFreshOutput(safeOutput);
    await rename(temporaryReceipt, safeOutput);
    await validateWrittenEvidence(safeOutput, evidence);
  } finally {
    await rm(temporaryReceipt, { force: true });
  }
  return evidence;
}

async function assertFreshOutput(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw benchmarkError("BENCHMARK_OUTPUT_EXISTS");
}

export async function runBenchmarkCaseWithTelemetryRetry(
  sizeMiB,
  outputParent,
  dependencies = {},
) {
  const runCase = dependencies.runCase ?? runFreshCase;
  const platform = dependencies.platform ?? process.platform;
  try {
    return await runCase(sizeMiB, outputParent);
  } catch (error) {
    if ((platform !== "linux" && platform !== "darwin")
      || !isRetryablePosixBenchmarkTelemetryGap(error)) {
      throw error;
    }
  }
  return runCase(sizeMiB, outputParent);
}

function isRetryablePosixBenchmarkTelemetryGap(error) {
  if (error?.code !== "BENCHMARK_TELEMETRY_UNAVAILABLE") return false;
  const diagnostic = error.telemetryDiagnostic;
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)
    || Object.keys(diagnostic).sort().join(",")
      !== "framePresent,processGone,rssPresent,stage,status,telemetryEnded") {
    return false;
  }
  return diagnostic.status === "failed"
    && diagnostic.processGone === true
    && diagnostic.telemetryEnded === true
    && diagnostic.framePresent === true
    && diagnostic.rssPresent === false
    && diagnostic.stage === "posix-telemetry-sample";
}

async function validateWrittenEvidence(path, expected) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) {
    throw benchmarkError("BENCHMARK_RECEIPT_INVALID");
  }
  const actual = JSON.parse(await readFile(path, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw benchmarkError("BENCHMARK_RECEIPT_INVALID");
  }
}

async function runFreshCase(sizeMiB, outputParent) {
  const owner = await createOwnedBenchmarkCase(outputParent);
  let result;
  try {
    result = await executeBounded(process.execPath, [
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      "--case",
      String(sizeMiB),
    ], {
      cwd: PACKAGE_ROOT,
      timeoutMs: CASE_DEADLINE_MS,
      env: process.env,
      controlFrame: owner.control,
    });
    forwardSafeCaseDiagnostics(result.stderr);
    assertCaseProcessGone(result);
    let receipt;
    if (result.status === "passed") {
      try {
        const outcome = validateCaseOutcome(JSON.parse(result.stdout.trim()));
        receipt = await parentCaseReceipt(
          sizeMiB,
          owner.path,
          outcome,
          result.caseMetrics,
        );
      } catch {
        receipt = await parentFailureReceipt(
          sizeMiB,
          owner.path,
          "ENGINE_PROTOCOL_ERROR",
          result,
        );
      }
    } else {
      const code = result.status === "timeout"
        ? "ENGINE_TIMEOUT"
        : "ENGINE_CRASH";
      receipt = await parentFailureReceipt(sizeMiB, owner.path, code, result);
    }
    return validateBenchmarkReceipt(receipt);
  } finally {
    if (result?.processGone === true) await cleanupOwnedBenchmarkCase(owner);
  }
}

export function formatBenchmarkProbeFailure(error) {
  const code = typeof error?.code === "string" && SAFE_PROBE_ERROR_CODES.has(error.code)
    ? error.code
    : "ENGINE_CRASH";
  return `BENCHMARK_PROBE_FAILURE engineCode=${code}`;
}

export function formatBenchmarkCaseFailure(error, phase) {
  let code = "ENGINE_CRASH";
  let stage = "unknown";
  try {
    if (typeof error?.code === "string" && SAFE_PROBE_ERROR_CODES.has(error.code)) {
      code = error.code;
    }
    if (typeof error?.details?.stage === "string" && SAFE_ENGINE_STAGES.has(error.details.stage)) {
      stage = error.details.stage;
    }
  } catch {}
  const safePhase = SAFE_CASE_PHASES.has(phase) ? phase : "unknown";
  return `BENCHMARK_CASE_FAILURE phase=${safePhase} engineCode=${code} stage=${stage}`;
}

function forwardSafeCaseDiagnostics(stderr) {
  if (typeof stderr !== "string") return;
  for (const line of stderr.split(/\r?\n/u)) {
    const probe = /^BENCHMARK_PROBE_FAILURE engineCode=([A-Z_]+)$/u.exec(line);
    if (probe !== null && SAFE_PROBE_ERROR_CODES.has(probe[1])) {
      process.stderr.write(`${line}\n`);
      continue;
    }
    const failure = /^BENCHMARK_CASE_FAILURE phase=(facade|snapshot|detect|probe|unknown) engineCode=([A-Z_]+) stage=(startup|detect|parse|render|generateHwpx|patchHwpx|fillHwpx|validateHwpx|insertImage|shutdown|unknown)$/u.exec(line);
    if (failure !== null && SAFE_PROBE_ERROR_CODES.has(failure[2])) {
      process.stderr.write(`${line}\n`);
      continue;
    }
    const snapshot = /^BENCHMARK_SNAPSHOT_FAILURE stage=([a-z-]+)$/u.exec(line);
    if (snapshot !== null && (SAFE_SNAPSHOT_STAGES.has(snapshot[1]) || snapshot[1] === "unknown")) {
      process.stderr.write(`${line}\n`);
    }
  }
}

export function formatBenchmarkSnapshotFailure(stage) {
  return `BENCHMARK_SNAPSHOT_FAILURE stage=${SAFE_SNAPSHOT_STAGES.has(stage) ? stage : "unknown"}`;
}

export function assertCaseProcessGone(result) {
  if (result?.processGone !== true) {
    throw benchmarkError("BENCHMARK_TERMINATION_FAILED", result?.diagnosticStage);
  }
}

export async function executeBounded(
  command,
  args,
  { cwd, timeoutMs, env, controlFrame, supervisorFactory },
) {
  return await new Promise((resolvePromise) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    const caseExited = new Promise((resolveExit) => {
      child.once("close", () => resolveExit());
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;
    let stopping;
    let telemetryBytes = 0;
    let telemetryBuffer = "";
    let caseMetrics = null;
    let telemetryEnded = false;
    let registrationCoordinator;
    let coordinatorSetup;
    let diagnosticStage = "channel";
    let resolveTelemetryEnd;
    const telemetryEnd = new Promise((resolveEnd) => {
      resolveTelemetryEnd = resolveEnd;
    });
    const finish = (status, processGone = true, mergedMetrics = null, telemetryDiagnostic) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        status,
        stdout,
        stderr,
        processGone,
        diagnosticStage,
        elapsedMs: Math.max(1, Math.round(performance.now() - started)),
        caseMetrics: mergedMetrics,
        ...(telemetryDiagnostic === undefined ? {} : { telemetryDiagnostic }),
      });
    };
    const supervisor = (supervisorFactory === undefined
      ? import("../src/workers/document-child-client.ts")
        .then(({ superviseDocumentProcessTree }) => superviseDocumentProcessTree(child, {
          deferProcessTreeTelemetryStop: process.platform !== "win32",
          frameObserver: (frame) => {
            diagnosticStage = classifyBenchmarkSupervisorFrame(frame);
          },
        }))
      : Promise.resolve().then(() => supervisorFactory(child))).catch((error) => {
        if (diagnosticStage === "channel") diagnosticStage = "error-startup";
        throw error;
      });
    const ensureRegistrationCoordinator = (caseSupervisor) => {
      if (process.platform === "win32") return Promise.resolve(undefined);
      coordinatorSetup ??= (async () => {
        if (typeof caseSupervisor.registerProcessTreeTelemetryRoot !== "function") {
          throw benchmarkError("BENCHMARK_TELEMETRY_UNAVAILABLE");
        }
        if (child.pid === undefined || child.stdio[5] === null || child.stdio[6] === null) {
          throw benchmarkError("BENCHMARK_TERMINATION_FAILED");
        }
        const { snapshotRegisteredPosixProcessGroupIdentity } = await import(
          "../src/workers/document-child-client.ts"
        );
        const nestedAuthority = createRegisteredPosixProcessGroupSupervisor({
          inspectIdentity: (pid) => snapshotRegisteredPosixProcessGroupIdentity(
            pid,
            process.platform,
          ),
        });
        const nestedWithTelemetry = {
          async registerRoot(pid, expectedParentPid) {
            const identity = await nestedAuthority.registerRoot(pid, expectedParentPid);
            caseSupervisor.registerProcessTreeTelemetryRoot(identity);
            return identity;
          },
          terminate: () => nestedAuthority.terminate(),
        };
        registrationCoordinator = createProcessRegistrationCoordinator({
          casePid: child.pid,
          registrationInput: child.stdio[5],
          acknowledgementOutput: child.stdio[6],
          supervisor: nestedWithTelemetry,
          caseExited,
          deadlineAt: started + timeoutMs,
        });
        registrationCoordinator.start();
        return registrationCoordinator;
      })();
      return coordinatorSetup;
    };
    const stop = (status) => {
      stopping ??= (async () => {
        const termination = await terminateCaseProcessTree(
          child,
          supervisor,
          ensureRegistrationCoordinator,
        );
        await Promise.race([
          telemetryEnd,
          new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
        ]);
        const rss = termination.processTreeRss;
        const completeTelemetry = telemetryEnded
          && telemetryBuffer.length === 0
          && caseMetrics !== null
          && rss !== undefined;
        const mergedMetrics = completeTelemetry
          ? Object.freeze({
              ...caseMetrics,
              peakRssDeltaBytes: Math.max(0, rss.peakBytes - rss.baselineBytes),
            })
          : null;
        if (!termination.gone) {
          if (diagnosticStage !== "ready-mode-2"
            && diagnosticStage !== "error-startup"
            && diagnosticStage !== "error-baseline-rss"
            && diagnosticStage !== "error-sampling"
            && diagnosticStage !== "error-rss-receipt"
            && !diagnosticStage.startsWith("windows-")
            && !diagnosticStage.startsWith("posix-")) {
            diagnosticStage = "error-termination";
          }
        } else if (rss === undefined) {
          if (!diagnosticStage.startsWith("posix-")) diagnosticStage = "error-rss-receipt";
        } else if (!completeTelemetry) {
          diagnosticStage = "error-sampling";
        } else {
          diagnosticStage = "finalizer";
        }
        const finalStatus = termination.gone && completeTelemetry ? status : "termination-failed";
        finish(
          finalStatus,
          termination.gone,
          mergedMetrics,
          finalStatus === "termination-failed"
            ? Object.freeze({
                status: "failed",
                processGone: termination.gone,
                telemetryEnded,
                framePresent: caseMetrics !== null,
                rssPresent: rss !== undefined,
                stage: diagnosticStage,
              })
            : undefined,
        );
      })();
      return stopping;
    };
    const collect = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next) > MAX_CASE_OUTPUT_BYTES) {
        overflow = true;
        void stop("failed");
        return target;
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    const telemetry = child.stdio[4];
    telemetry.setEncoding("utf8");
    telemetry.on("data", (chunk) => {
      telemetryBytes += Buffer.byteLength(chunk);
      telemetryBuffer += chunk;
      if (telemetryBytes > MAX_CASE_TELEMETRY_BYTES
        || Buffer.byteLength(telemetryBuffer) > MAX_CASE_CONTROL_BYTES) {
        overflow = true;
        void stop("failed");
        return;
      }
      for (let newline = telemetryBuffer.indexOf("\n"); newline >= 0;
        newline = telemetryBuffer.indexOf("\n")) {
        const frame = telemetryBuffer.slice(0, newline);
        telemetryBuffer = telemetryBuffer.slice(newline + 1);
        try {
          const metric = JSON.parse(frame);
          if (metric === null || typeof metric !== "object" || Array.isArray(metric)
            || Object.keys(metric).sort().join(",") !== "copiedBytes,dispatchStarted,elapsedMs"
            || !safeNonNegative(metric.elapsedMs)
            || !safeNonNegative(metric.copiedBytes)
            || typeof metric.dispatchStarted !== "boolean"
            || (!metric.dispatchStarted && metric.copiedBytes !== 0)
            || (caseMetrics !== null && (metric.elapsedMs < caseMetrics.elapsedMs
              || metric.copiedBytes < caseMetrics.copiedBytes
              || (caseMetrics.dispatchStarted && !metric.dispatchStarted)))) {
            throw benchmarkError("BENCHMARK_TELEMETRY_INVALID");
          }
          caseMetrics = Object.freeze(metric);
        } catch {
          diagnosticStage = "error-sampling";
          overflow = true;
          void stop("failed");
          return;
        }
      }
    });
    const onTelemetryEnd = () => {
      if (telemetryEnded) return;
      telemetryEnded = true;
      resolveTelemetryEnd();
    };
    telemetry.once("end", onTelemetryEnd);
    telemetry.once("close", onTelemetryEnd);
    telemetry.once("error", () => {
      diagnosticStage = "error-sampling";
      overflow = true;
      onTelemetryEnd();
      void stop("failed");
    });
    child.once("error", () => { void stop("failed"); });
    child.once("close", (code, signal) => {
      if (stopping !== undefined) return;
      void stop(!overflow && code === 0 && signal === null ? "passed" : "failed");
    });
    void supervisor.then(async (caseSupervisor) => {
      await ensureRegistrationCoordinator(caseSupervisor);
      const ready = await exactTelemetryReady(
        caseSupervisor.processTreeTelemetryReady,
        Math.min(5_000, Math.max(1, started + timeoutMs - performance.now() - 25)),
      );
      const control = child.stdio[3];
      if (ready !== true || stopping !== undefined || control === null ||
        typeof control.end !== "function") {
        if (ready !== true && !diagnosticStage.startsWith("posix-")) {
          diagnosticStage = "error-baseline-rss";
        }
        closeCaseControl(control);
        void stop("failed");
        return;
      }
      control.once("error", () => { void stop("failed"); });
      control.end(`${JSON.stringify(controlFrame)}\n`);
    }).catch(() => {
      closeCaseControl(child.stdio[3]);
      void stop("failed");
    });
    const timer = setTimeout(() => {
      void stop("timeout");
    }, timeoutMs);
    timer.unref();
  });
}

async function terminateCaseProcessTree(
  child,
  supervisorPromise,
  ensureRegistrationCoordinator,
) {
  if (child.pid === undefined) return { gone: true };
  let supervisor;
  try {
    supervisor = await supervisorPromise;
  } catch {
    await genericProcessTreeCleanup(child.pid);
    return { gone: false };
  }

  let coordinator;
  let coordinatorReady = process.platform === "win32";
  let rootReceipt = unverifiedTermination("termination");
  let nestedReceipt = process.platform === "win32"
    ? { gone: true, proof: "registered-groups-empty" }
    : unverifiedTermination("registration");
  let registrationDrained = process.platform === "win32";
  let telemetryFlushed = process.platform === "win32";
  let processTreeRss;
  try {
    try {
      coordinator = await ensureRegistrationCoordinator(supervisor);
      coordinatorReady = process.platform === "win32" || coordinator !== undefined;
      await coordinator?.beginClosing();
    } catch {
      coordinatorReady = false;
    }

    rootReceipt = await terminateAuthority(
      supervisor,
      process.platform === "win32" ? "windows-job-empty" : "registered-groups-empty",
      child.pid,
    );

    if (coordinator !== undefined) {
      try {
        await coordinator.seal();
        registrationDrained = coordinator.state === "sealed";
      } catch {
        registrationDrained = false;
      }
      if (registrationDrained) {
        telemetryFlushed = await exactTelemetryReady(
          supervisor.flushProcessTreeTelemetry?.(),
          POSIX_TELEMETRY_FLUSH_MS,
        );
      }
      try {
        nestedReceipt = normalizeProcessTreeTerminationReceipt(
          await coordinator.terminateRegisteredGroups(),
          "registration",
        );
      } catch {
        nestedReceipt = unverifiedTermination("registration");
      }
    }
  } finally {
    try {
      supervisor.finishProcessTreeTelemetry?.();
      processTreeRss = telemetryFlushed ? supervisor.processTreeRss?.() : undefined;
    } catch {
      processTreeRss = undefined;
    }
  }

  const rootGone = rootReceipt.gone === true
    && rootReceipt.proof === (process.platform === "win32"
      ? "windows-job-empty"
      : "registered-groups-empty");
  const nestedGone = nestedReceipt.gone === true
    && nestedReceipt.proof === "registered-groups-empty";
  return {
    gone: rootGone && coordinatorReady && registrationDrained && nestedGone,
    processTreeRss,
  };
}

async function terminateAuthority(supervisor, expectedProof, pid) {
  let receipt = unverifiedTermination("termination");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      receipt = normalizeProcessTreeTerminationReceipt(
        await supervisor.terminate(),
        "termination",
      );
    } catch {
      receipt = unverifiedTermination("termination");
    }
    if (receipt.gone === true && receipt.proof === expectedProof) return receipt;
    await genericProcessTreeCleanup(pid);
  }
  return receipt.gone === true
    ? unverifiedTermination("termination")
    : receipt;
}

async function genericProcessTreeCleanup(pid) {
  const { terminateDocumentProcessTreeByPid } = await import(
    "../src/workers/document-child-client.ts"
  );
  await terminateDocumentProcessTreeByPid(pid).catch(() => false);
}

async function exactTelemetryReady(readiness, timeoutMs) {
  if (readiness === undefined) return false;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(readiness).then(
        (value) => value === true,
        () => false,
      ),
      new Promise((resolveWait) => {
        timer = setTimeout(() => resolveWait(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function closeCaseControl(control) {
  if (control === null || control === undefined) return;
  control.on?.("error", () => {});
  try {
    control.end?.();
  } catch {
    try { control.destroy?.(); } catch {}
  }
}

async function runCase(sizeMiB, ownedRoot, ownedCase, telemetry) {
  validateCaseSizeMiB(sizeMiB);
  const requestedBytes = sizeMiB * 1024 * 1024;
  await assertCaseBoundary(ownedRoot, ownedCase);
  const sourcePath = join(ownedCase, "source.hwpx");
  const started = telemetry.started;
  let outcome;
  let phase = "facade";
  let snapshotStage = "source-authorize";
  const source = await generatePaddedHwpx({ outputPath: sourcePath, requestedBytes });
  await writeCaseMetadata(ownedCase, source);
  let facade;
  try {
    facade = await createCaseFacade();
    phase = "snapshot";
    const { openDocumentSnapshot } = await import("../src/shared/document-snapshot.ts");
    const snapshot = await openDocumentSnapshot(sourcePath, {
      testHooks: {
        spoolRoot: ownedCase,
        onDiagnosticStage: (stage) => { snapshotStage = stage; },
      },
    });
    let responseBytes = 0;
    phase = "detect";
    try {
      const result = await facade.detect(snapshot, {
        deadlineMs: Math.max(1, CASE_DEADLINE_MS - Math.ceil(performance.now() - started) - 30_000),
        onMetrics: (metrics) => telemetry.observeMetrics(metrics),
      });
      if (result.payload.format !== "hwpx") {
        throw Object.assign(new Error("unexpected format"), { code: "ENGINE_PROTOCOL_ERROR" });
      }
      responseBytes = Buffer.byteLength(JSON.stringify(result.payload));
    } catch (error) {
      process.stderr.write(`${formatBenchmarkCaseFailure(error, phase)}\n`);
      const errorCode = safeEngineErrorCode(error);
      outcome = {
        responseBytes: 0,
        status: errorCode === "ENGINE_RESOURCE_LIMIT" || errorCode === "ENGINE_OOM"
          ? "resource-refused"
          : "failed",
        errorCode,
      };
    }
    if (outcome === undefined) {
      outcome = {
        responseBytes,
        status: "passed",
        errorCode: null,
      };
    }
  } catch (error) {
    if (phase === "snapshot") {
      process.stderr.write(`${formatBenchmarkSnapshotFailure(snapshotStage)}\n`);
    }
    process.stderr.write(`${formatBenchmarkCaseFailure(error, phase)}\n`);
    const errorCode = safeEngineErrorCode(error);
    outcome = {
      responseBytes: 0,
      status: errorCode === "ENGINE_RESOURCE_LIMIT" || errorCode === "ENGINE_OOM"
        ? "resource-refused"
        : "failed",
      errorCode,
    };
  }
  try {
    phase = "probe";
    if (facade === undefined) throw benchmarkError("BENCHMARK_PROBE_FAILED");
    await runNormalProbe(ownedCase, facade);
  } catch (error) {
    process.stderr.write(`${formatBenchmarkProbeFailure(error)}\n`);
    outcome = {
      responseBytes: 0,
      status: "failed",
      errorCode: "BENCHMARK_PROBE_FAILED",
    };
  }
  return validateCaseOutcome(outcome);
}

async function assertCaseBoundary(ownedRoot, ownedCase) {
  if (!isAbsolute(ownedRoot) || !isAbsolute(ownedCase)
    || dirname(resolve(ownedCase)) !== resolve(ownedRoot)
    || !relative(resolve(ownedRoot), resolve(ownedCase)).startsWith(CASE_PREFIX)) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
  await assertIgnoredBenchmarkOutput(join(resolve(ownedRoot), "case-boundary.json"));
  const info = await lstat(ownedCase);
  if (!info.isDirectory() || info.isSymbolicLink()
    || comparable(await realpath(ownedCase)) !== comparable(resolve(ownedCase))) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
}

async function readInheritedCaseControl(fd = 3) {
  const stream = createReadStream(null, { fd, autoClose: true });
  return await new Promise((resolveControl, rejectControl) => {
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      stream.destroy(benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID"));
    }, 5_000);
    timer.unref();
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CASE_CONTROL_BYTES) {
        stream.destroy(benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID"));
      } else {
        chunks.push(chunk);
      }
    });
    stream.once("error", (error) => {
      clearTimeout(timer);
      rejectControl(error);
    });
    stream.once("end", () => {
      clearTimeout(timer);
      try {
        const control = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolveControl(control);
      } catch {
        rejectControl(benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID"));
      }
    });
  });
}

async function consumeInheritedCaseControl() {
  const control = await readInheritedCaseControl();
  if (control === null || typeof control !== "object" || Array.isArray(control)
    || Object.keys(control).sort().join(",") !== "device,inode,ownedCase,ownedRoot,token"
    || typeof control.token !== "string" || !/^[0-9a-f-]{36}$/u.test(control.token)
    || typeof control.device !== "string" || !/^\d+$/u.test(control.device)
    || typeof control.inode !== "string" || !/^\d+$/u.test(control.inode)) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
  await assertCaseBoundary(control.ownedRoot, control.ownedCase);
  const caseInfo = await lstat(control.ownedCase, { bigint: true });
  if (String(caseInfo.dev) !== control.device || String(caseInfo.ino) !== control.inode) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
  const markerPath = join(control.ownedCase, CASE_CONTROL_FILENAME);
  const markerInfo = await lstat(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()
    || markerInfo.size <= 0 || markerInfo.size > MAX_CASE_CONTROL_BYTES) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (JSON.stringify(marker) !== JSON.stringify(control)) {
    throw benchmarkError("BENCHMARK_CASE_OWNERSHIP_INVALID");
  }
  await rm(markerPath, { force: false });
  return control;
}

async function writeCaseMetadata(root, source) {
  const path = join(root, CASE_METADATA_FILENAME);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      actualBytes: source.actualBytes,
      sourceSha256: source.sha256,
    })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function parentFailureReceipt(sizeMiB, root, errorCode, metrics) {
  try {
    return await parentCaseReceipt(sizeMiB, root, {
      status: "failed",
      responseBytes: 0,
      errorCode,
    }, metrics?.caseMetrics);
  } catch (error) {
    if (error?.code === "BENCHMARK_TELEMETRY_UNAVAILABLE") {
      const failure = benchmarkError(error.code, metrics?.diagnosticStage);
      if (metrics?.telemetryDiagnostic !== undefined) {
        failure.telemetryDiagnostic = metrics.telemetryDiagnostic;
      }
      throw failure;
    }
    throw error;
  }
}

async function parentCaseReceipt(sizeMiB, root, outcome, metrics) {
  let source;
  try {
    const path = join(root, CASE_METADATA_FILENAME);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error();
    const value = JSON.parse(await readFile(path, "utf8"));
    if (Object.keys(value).sort().join(",") !== "actualBytes,sourceSha256"
      || !safeNonNegative(value.actualBytes) || !hash(value.sourceSha256)) throw new Error();
    source = value;
  } catch {
    source = { actualBytes: 0, sourceSha256: null };
  }
  return validateBenchmarkReceipt(buildReceipt(
    sizeMiB,
    outcome,
    source,
    metrics,
  ));
}

async function createCaseFacade() {
  const [
    { createDocumentEngineFacade },
    { createDocumentChildClient },
    { createIsolatedDocumentEngine, HeavyChildGate },
    { createDocumentWorkerClient },
  ] = await Promise.all([
    import("../src/shared/document-engine.ts"),
    import("../src/workers/document-child-client.ts"),
    import("../src/workers/document-execution-policy.ts"),
    import("../src/workers/document-worker-client.ts"),
  ]);
  const heavyChildGate = new HeavyChildGate();
  const childClient = createDocumentChildClient({
    childEntry: join(PACKAGE_ROOT, "dist", "workers", "document-child.js"),
    startGateEntry: join(PACKAGE_ROOT, "dist", "workers", "document-child-start-gate.js"),
    ...(process.platform === "win32"
      ? {}
      : { benchmarkRegistrationDescriptors: { writeFd: 5, ackFd: 6 } }),
    heavyChildGate,
  });
  const workerClient = createDocumentWorkerClient({
    workerFactory: (options) => new Worker(
      join(PACKAGE_ROOT, "dist", "workers", "document-worker.js"),
      options,
    ),
  });
  return createDocumentEngineFacade({
    isolatedEngine: createIsolatedDocumentEngine({ workerClient, childClient }),
  });
}

async function runNormalProbe(root, facade) {
  const path = join(root, "normal-probe.hwpx");
  await generatePaddedHwpx({ outputPath: path, requestedBytes: 128 * 1024 });
  const { openDocumentSnapshot } = await import("../src/shared/document-snapshot.ts");
  const result = await facade.parse(await openDocumentSnapshot(path), {}, {
    deadlineMs: 30_000,
  });
  if (typeof result.payload.markdown !== "string") {
    throw benchmarkError("BENCHMARK_PROBE_FAILED");
  }
}

function buildReceipt(sizeMiB, outcome, source, metrics) {
  if (
    !safeNonNegative(metrics?.elapsedMs) ||
    !safeNonNegative(metrics?.peakRssDeltaBytes) ||
    !safeNonNegative(metrics?.copiedBytes) ||
    typeof metrics?.dispatchStarted !== "boolean"
  ) {
    throw benchmarkError("BENCHMARK_TELEMETRY_UNAVAILABLE");
  }
  return {
    schemaVersion: BENCHMARK_RECEIPT_SCHEMA_VERSION,
    platform: process.platform,
    arch: process.arch,
    runtime: `node-${process.version}`,
    requestedMiB: sizeMiB,
    actualBytes: source.actualBytes,
    operation: "detectFormat",
    executionMode: sizeMiB === 10 ? "transferable-worker" : "supervised-child",
    status: outcome.status,
    elapsedMs: metrics.elapsedMs,
    peakRssDeltaBytes: metrics.peakRssDeltaBytes,
    copiedBytes: metrics.copiedBytes,
    dispatchStarted: metrics.dispatchStarted,
    responseBytes: outcome.responseBytes,
    errorCode: outcome.errorCode,
    sourceSha256: source.sourceSha256,
    outputSha256: null,
  };
}

export function buildParentFailureReceipt(sizeMiB, errorCode, source, metrics) {
  return buildReceipt(sizeMiB, {
    status: "failed",
    responseBytes: 0,
    errorCode,
  }, source, metrics);
}

function validateCaseOutcome(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== CASE_OUTCOME_KEYS.join(",")
    || !["passed", "resource-refused", "failed"].includes(value.status)
    || !safeNonNegative(value.responseBytes)
    || !validErrorCode(value.status, value.errorCode)
    || (value.status === "passed"
      ? value.responseBytes === 0
      : value.responseBytes !== 0)) {
    throw benchmarkError("BENCHMARK_RECEIPT_INVALID");
  }
  return Object.freeze(value);
}

export function benchmarkImplementationInputPaths() {
  return Object.freeze([
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL("./generate-padded-hwpx.mjs", import.meta.url)),
    join(PACKAGE_ROOT, "package.json"),
    join(PACKAGE_ROOT, "package-lock.json"),
    join(PACKAGE_ROOT, "tsconfig.json"),
    join(PACKAGE_ROOT, "scripts", "copy-build-assets.mjs"),
    join(PACKAGE_ROOT, "src"),
    join(PACKAGE_ROOT, "vendor", "kordoc-core"),
  ]);
}

export async function benchmarkImplementationSha256(options = {}) {
  const hashState = createHash("sha256");
  const roots = benchmarkImplementationInputPaths();
  const readInput = options.readInput ?? readFile;
  const files = [];
  const collect = async (path) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw benchmarkError("BENCHMARK_SOURCE_CHANGED");
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await collect(join(path, entry));
    } else if (info.isFile()) {
      files.push(path);
    }
  };
  for (const root of roots) await collect(root);
  for (const path of files.sort()) {
    hashState.update(relative(REPOSITORY_ROOT, path).split(sep).join("/"));
    hashState.update("\0");
    hashState.update(await readInput(path));
    hashState.update("\0");
  }
  return hashState.digest("hex");
}

function createCaseTelemetry(fd = 4) {
  const stream = createWriteStream(null, { fd, autoClose: true });
  stream.on("error", () => {});
  const started = performance.now();
  let copiedBytes = 0;
  let dispatchStarted = false;
  const snapshot = () => {
    return Object.freeze({
      elapsedMs: Math.max(1, Math.round(performance.now() - started)),
      copiedBytes,
      dispatchStarted,
    });
  };
  const emit = () => {
    if (!stream.destroyed) stream.write(`${JSON.stringify(snapshot())}\n`);
  };
  const reporter = setInterval(emit, 250);
  reporter.unref();
  emit();
  return Object.freeze({
    started,
    snapshot,
    observeMetrics(metrics) {
      if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)
        || Object.keys(metrics).join(",") !== "copiedBytes"
        || !safeNonNegative(metrics.copiedBytes)
        || metrics.copiedBytes < copiedBytes
        || (!dispatchStarted && metrics.copiedBytes !== 0)) {
        throw benchmarkError("BENCHMARK_TELEMETRY_INVALID");
      }
      dispatchStarted = true;
      copiedBytes = metrics.copiedBytes;
      emit();
    },
    async close() {
      clearInterval(reporter);
      emit();
      if (!stream.destroyed) {
        await new Promise((resolveClose) => stream.end(resolveClose));
      }
    },
  });
}

function safeEngineErrorCode(error) {
  if (error?.code === "SOURCE_CHANGED") return "BENCHMARK_SOURCE_CHANGED";
  return SAFE_ERROR_CODES.has(error?.code) ? error.code : "ENGINE_CRASH";
}

function benchmarkError(code, diagnosticStage) {
  return Object.assign(new Error(code), {
    code,
    ...(SAFE_BENCHMARK_DIAGNOSTIC_STAGES.has(diagnosticStage)
      ? { diagnosticStage }
      : {}),
  });
}

async function main() {
  if (process.argv[2] === "--case") {
    const [size] = process.argv.slice(3);
    if (process.argv.length !== 4) {
      throw benchmarkError("BENCHMARK_ARGUMENTS_INVALID");
    }
    const telemetry = createCaseTelemetry();
    try {
      const control = await consumeInheritedCaseControl();
      process.stdout.write(`${JSON.stringify(await runCase(
        validateCaseSizeMiB(Number(size)),
        control.ownedRoot,
        control.ownedCase,
        telemetry,
      ))}\n`);
    } finally {
      await telemetry.close();
    }
    return;
  }
  if (process.argv[2] === "--validate-large") {
    if (process.argv.length !== 4) throw benchmarkError("BENCHMARK_ARGUMENTS_INVALID");
    await validateLargeBenchmarkEvidence(resolve(process.argv[3]));
    process.stdout.write("BENCHMARK_EVIDENCE_VALID\n");
    return;
  }
  const parsed = parseBenchmarkArguments(process.argv.slice(2));
  const evidence = await runBenchmark({
    ...parsed,
    onReceipt: (receipt) => {
      process.stdout.write(`${formatBenchmarkProgress(receipt)}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    concurrency: evidence.concurrency,
    statuses: evidence.receipts.map((receipt) => receipt.status),
  })}\n`);
  if (evidence.receipts.some((receipt) => receipt.status === "failed")) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${formatBenchmarkFailure(error)}\n`);
    process.exitCode = 1;
  });
}
