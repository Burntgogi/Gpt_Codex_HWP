import { isAbsolute, win32 } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_NODE_ARGS = Object.freeze([
  Object.freeze([]),
  Object.freeze(["--max-semi-space-size=1"]),
]);
const SESSION_COUNTS = Object.freeze([1, 5, 20]);
const ARMS = Object.freeze(["control", "candidate"]);
const PAIR_COUNT = 5;
const SAMPLE_COUNT = 60;
const SAMPLE_INTERVAL_MS = 100;
const SETTLE_MS = 5_000;
const MAX_INTERVAL_MS = 150;
const AGGREGATION = "equal-weight-per-session-private-arithmetic-mean";
const IDENTITY_KEYS = Object.freeze([
  "benchmarkSha256",
  "lockfileSha256",
  "nodeVersion",
  "revision",
  "runtimeArtifactSha256",
  "safeArgs",
  "toolContractSha256",
]);
const REPORT_KEYS = Object.freeze([
  "arch",
  "cleanup",
  "pairCount",
  "platform",
  "results",
  "runtime",
  "runtimeIdentities",
  "sampleCount",
  "sampleIntervalMs",
  "schemaVersion",
  "sessionCounts",
  "settleMs",
  "toolCount",
  "unexpectedStderrBytes",
  "v8Aggregation",
]);
const RESULT_KEYS = Object.freeze([
  "arm",
  "descendantCount",
  "pair",
  "privateBytes",
  "rssBytes",
  "samplingTiming",
  "sessionCount",
  "settling",
]);

function reportError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sameStrings(left, right) {
  return Array.isArray(left) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function safeArgs(value) {
  return SAFE_NODE_ARGS.some((allowed) => sameStrings(value, allowed));
}

function anyPlatformAbsolute(value) {
  return typeof value === "string" && (isAbsolute(value) || win32.isAbsolute(value));
}

function requireSha256(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw reportError("IDLE_RUNTIME_IDENTITY_INVALID");
  }
  return value;
}

function requireRevision(value) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw reportError("IDLE_RUNTIME_IDENTITY_INVALID");
  }
  return value;
}

export function publicRuntimeIdentity(spec, measured) {
  if (!isPlainObject(spec) || !isPlainObject(measured)
    || !anyPlatformAbsolute(spec.command) || !anyPlatformAbsolute(spec.cwd)
    || !Array.isArray(spec.args) || spec.args.some((value) => typeof value !== "string")
    || !safeArgs(spec.safeArgs)
    || spec.args.length !== spec.safeArgs.length + 1
    || !sameStrings(spec.args.slice(0, -1), spec.safeArgs)
    || !anyPlatformAbsolute(spec.args.at(-1))
    || typeof measured.nodeVersion !== "string"
    || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(measured.nodeVersion)) {
    throw reportError("IDLE_RUNTIME_IDENTITY_INVALID");
  }
  return Object.freeze({
    revision: requireRevision(spec.revision),
    runtimeArtifactSha256: requireSha256(measured.runtimeArtifactSha256),
    lockfileSha256: requireSha256(measured.lockfileSha256),
    benchmarkSha256: requireSha256(measured.benchmarkSha256),
    safeArgs: Object.freeze([...spec.safeArgs]),
    nodeVersion: measured.nodeVersion,
    toolContractSha256: requireSha256(measured.toolContractSha256),
  });
}

export function summarizePairStatistics(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100
    || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw reportError("IDLE_PAIR_STATISTICS_INVALID");
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Object.freeze({
    pairMedians: Object.freeze([...values]),
    mean,
    populationCvBasisPoints: Math.round((Math.sqrt(variance) / mean) * 10_000),
  });
}

function validateSummary(value, allowUnsupported = false) {
  if (allowUnsupported && value === "unsupported") return;
  if (!exactKeys(value, ["max", "median", "min", "p95"])) {
    throw reportError("IDLE_RESULT_INVALID");
  }
  const numbers = [value.min, value.median, value.p95, value.max];
  if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)
    || value.min > value.median || value.median > value.p95 || value.p95 > value.max) {
    throw reportError("IDLE_RESULT_INVALID");
  }
}

function validateSettling(value) {
  if (!exactKeys(value, ["actualMs", "requestedMs"])
    || value.requestedMs !== SETTLE_MS || !Number.isSafeInteger(value.actualMs)
    || value.actualMs < SETTLE_MS || value.actualMs > 60_000) {
    throw reportError("IDLE_RESULT_INVALID");
  }
}

function validateSamplingTiming(value) {
  if (!exactKeys(value, [
    "actualIntervalMaxMs",
    "actualIntervalMedianMs",
    "actualIntervalP95Ms",
    "durationMs",
  ])) throw reportError("IDLE_RESULT_INVALID");
  const { actualIntervalMedianMs, actualIntervalP95Ms, actualIntervalMaxMs, durationMs } = value;
  if (![actualIntervalMedianMs, actualIntervalP95Ms, actualIntervalMaxMs, durationMs]
    .every((number) => Number.isSafeInteger(number) && number > 0)
    || actualIntervalMedianMs > actualIntervalP95Ms
    || actualIntervalP95Ms > actualIntervalMaxMs
    || actualIntervalMaxMs > MAX_INTERVAL_MS
    || durationMs > (SAMPLE_COUNT - 1) * MAX_INTERVAL_MS) {
    throw reportError("IDLE_RESULT_INVALID");
  }
}

function validateRuntimeIdentity(value, expectedSafeArgs) {
  if (!exactKeys(value, IDENTITY_KEYS) || !REVISION_PATTERN.test(value.revision)
    || !SHA256_PATTERN.test(value.runtimeArtifactSha256)
    || !SHA256_PATTERN.test(value.lockfileSha256)
    || !SHA256_PATTERN.test(value.benchmarkSha256)
    || !SHA256_PATTERN.test(value.toolContractSha256)
    || !sameStrings(value.safeArgs, expectedSafeArgs)
    || typeof value.nodeVersion !== "string"
    || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.nodeVersion)) {
    throw reportError("IDLE_RUNTIME_IDENTITY_INVALID");
  }
}

export function validateIdleMemoryReportV2(value) {
  if (!exactKeys(value, REPORT_KEYS) || value.schemaVersion !== 2 || value.runtime !== "node"
    || !["win32", "linux", "darwin"].includes(value.platform)
    || typeof value.arch !== "string" || value.arch.length === 0
    || !sameStrings(value.sessionCounts, SESSION_COUNTS)
    || value.pairCount !== PAIR_COUNT || value.sampleCount !== SAMPLE_COUNT
    || value.sampleIntervalMs !== SAMPLE_INTERVAL_MS || value.settleMs !== SETTLE_MS
    || value.toolCount !== 9 || !Number.isSafeInteger(value.unexpectedStderrBytes)
    || value.unexpectedStderrBytes < 0
    || !exactKeys(value.cleanup, ["observedIdentityCount", "remainingIdentityCount"])
    || !Number.isSafeInteger(value.cleanup.observedIdentityCount)
    || value.cleanup.observedIdentityCount < 1
    || value.cleanup.remainingIdentityCount !== 0
    || value.v8Aggregation !== AGGREGATION
    || !exactKeys(value.runtimeIdentities, ["candidate", "control"])
    || !Array.isArray(value.results)) {
    throw reportError("IDLE_REPORT_INVALID");
  }
  validateRuntimeIdentity(value.runtimeIdentities.control, []);
  validateRuntimeIdentity(value.runtimeIdentities.candidate, ["--max-semi-space-size=1"]);
  if (value.runtimeIdentities.control.toolContractSha256
    !== value.runtimeIdentities.candidate.toolContractSha256) {
    throw reportError("IDLE_RUNTIME_IDENTITY_INVALID");
  }
  const expected = new Set();
  for (let pair = 1; pair <= PAIR_COUNT; pair += 1) {
    for (const arm of ARMS) {
      for (const sessionCount of SESSION_COUNTS) expected.add(`${pair}:${arm}:${sessionCount}`);
    }
  }
  if (value.results.length !== expected.size) throw reportError("IDLE_RESULTS_INCOMPLETE");
  for (const result of value.results) {
    if (!exactKeys(result, RESULT_KEYS) || !Number.isSafeInteger(result.pair)
      || !ARMS.includes(result.arm) || !SESSION_COUNTS.includes(result.sessionCount)) {
      throw reportError("IDLE_RESULT_INVALID");
    }
    const key = `${result.pair}:${result.arm}:${result.sessionCount}`;
    if (!expected.delete(key)) throw reportError("IDLE_RESULTS_INCOMPLETE");
    validateSummary(result.rssBytes);
    validateSummary(result.privateBytes, true);
    validateSummary(result.descendantCount);
    validateSettling(result.settling);
    validateSamplingTiming(result.samplingTiming);
  }
  if (expected.size !== 0) throw reportError("IDLE_RESULTS_INCOMPLETE");
  return value;
}
