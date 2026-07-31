import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DECISION_KEYS = Object.freeze([
  "approvedAt",
  "displayRoundingDecimals",
  "schemaVersion",
  "thresholds",
  "v8Aggregation",
]);
const THRESHOLD_KEYS = Object.freeze([
  "absoluteRssBytesPerSession",
  "maxCvBasisPoints",
  "maxPerformanceRegressionBasisPoints",
  "maxPerSegmentPrivateRegressionBasisPoints",
  "private20SessionBytes",
  "recoveryDeadlineMs",
  "recoveryMultiplierBasisPoints",
  "relativeRssReductionBasisPoints",
]);
const FIXED_THRESHOLDS = Object.freeze({
  absoluteRssBytesPerSession: 74_763_468,
  relativeRssReductionBasisPoints: 1_000,
  private20SessionBytes: 891_289_600,
  maxCvBasisPoints: 500,
  recoveryDeadlineMs: 2_000,
  recoveryMultiplierBasisPoints: 11_000,
  maxPerformanceRegressionBasisPoints: 1_500,
  maxPerSegmentPrivateRegressionBasisPoints: 500,
});
const FIXED_AGGREGATION = "equal-weight-per-session-private-arithmetic-mean";
const ISO_UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const SESSION_COUNTS = Object.freeze([1, 5, 20]);
const ARMS = Object.freeze(["control", "candidate"]);
const QUALIFICATION_COMMAND_IDS = Object.freeze(["build", "idle", "documents", "recovery"]);

function gateError(code) {
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

function exactTimestamp(value) {
  if (typeof value !== "string" || !ISO_UTC_MILLISECONDS_PATTERN.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function qualificationSemanticDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function safeInteger(value, { minimum = 0 } = {}) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function qualificationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateQualificationManifest(value) {
  if (!exactKeys(value, [
    "candidateRevision",
    "commandIds",
    "controlRevision",
    "decisionFileSha256",
    "decisionSha256",
    "evidenceDigests",
    "evidenceFileDigests",
    "generatedAt",
    "measurementStartedAt",
    "schemaVersion",
  ]) || value.schemaVersion !== 1
    || !exactTimestamp(value.measurementStartedAt) || !exactTimestamp(value.generatedAt)
    || !REVISION_PATTERN.test(value.controlRevision)
    || !REVISION_PATTERN.test(value.candidateRevision)
    || !SHA256_PATTERN.test(value.decisionFileSha256)
    || !SHA256_PATTERN.test(value.decisionSha256)
    || !exactKeys(value.evidenceDigests, ["documents", "idle", "recovery"])
    || Object.values(value.evidenceDigests).some((digest) => !SHA256_PATTERN.test(digest))
    || !exactKeys(value.evidenceFileDigests, ["documents", "idle", "recovery"])
    || Object.values(value.evidenceFileDigests).some((digest) => !SHA256_PATTERN.test(digest))
    || !sameArray(value.commandIds, QUALIFICATION_COMMAND_IDS)) {
    throw qualificationError("QUALIFICATION_MANIFEST_INVALID");
  }
  return value;
}

function validateRuntimeIdentity(value, expectedArgs) {
  if (!exactKeys(value, [
    "benchmarkSha256",
    "lockfileSha256",
    "nodeVersion",
    "revision",
    "runtimeArtifactSha256",
    "safeArgs",
    "toolContractSha256",
  ]) || !REVISION_PATTERN.test(value.revision)
    || !sameArray(value.safeArgs, expectedArgs)
    || typeof value.nodeVersion !== "string" || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.nodeVersion)
    || [
      value.benchmarkSha256,
      value.lockfileSha256,
      value.runtimeArtifactSha256,
      value.toolContractSha256,
    ].some((digest) => !SHA256_PATTERN.test(digest))) {
    throw qualificationError("QUALIFICATION_IDENTITY_MISMATCH");
  }
}

function validateSummary(value, { unsupported = false } = {}) {
  if (unsupported && value === "unsupported") return;
  if (!exactKeys(value, ["max", "median", "min", "p95"])
    || ![value.min, value.median, value.p95, value.max].every((item) => safeInteger(item))
    || value.min > value.median || value.median > value.p95 || value.p95 > value.max) {
    throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
  }
}

function validateIdleEvidence(value) {
  if (!exactKeys(value, [
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
  ]) || value.schemaVersion !== 2 || value.runtime !== "node"
    || !["win32", "linux", "darwin"].includes(value.platform)
    || typeof value.arch !== "string" || value.arch.length === 0
    || !sameArray(value.sessionCounts, SESSION_COUNTS)
    || value.pairCount !== 5 || value.sampleCount !== 60
    || value.sampleIntervalMs !== 100 || value.settleMs !== 5_000
    || value.toolCount !== 9 || !safeInteger(value.unexpectedStderrBytes)
    || value.v8Aggregation !== FIXED_AGGREGATION
    || !exactKeys(value.cleanup, ["observedIdentityCount", "remainingIdentityCount"])
    || !safeInteger(value.cleanup.observedIdentityCount, { minimum: 1 })
    || !safeInteger(value.cleanup.remainingIdentityCount)
    || !exactKeys(value.runtimeIdentities, ["candidate", "control"])
    || !Array.isArray(value.results)) {
    throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
  }
  validateRuntimeIdentity(value.runtimeIdentities.control, []);
  validateRuntimeIdentity(value.runtimeIdentities.candidate, ["--max-semi-space-size=1"]);
  const expected = new Set();
  for (let pair = 1; pair <= value.pairCount; pair += 1) {
    for (const arm of ARMS) {
      for (const sessionCount of SESSION_COUNTS) expected.add(`${pair}:${arm}:${sessionCount}`);
    }
  }
  if (value.results.length !== expected.size) {
    throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
  }
  for (const result of value.results) {
    if (!exactKeys(result, [
      "arm",
      "descendantCount",
      "pair",
      "privateBytes",
      "rssBytes",
      "samplingTiming",
      "sessionCount",
      "settling",
    ]) || !safeInteger(result.pair, { minimum: 1 })
      || !ARMS.includes(result.arm) || !SESSION_COUNTS.includes(result.sessionCount)
      || !exactKeys(result.settling, ["actualMs", "requestedMs"])
      || result.settling.requestedMs !== 5_000 || !safeInteger(result.settling.actualMs, { minimum: 5_000 })
      || !exactKeys(result.samplingTiming, [
        "actualIntervalMaxMs", "actualIntervalMedianMs", "actualIntervalP95Ms", "durationMs",
      ])) {
      throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
    }
    const key = `${result.pair}:${result.arm}:${result.sessionCount}`;
    if (!expected.delete(key)) throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
    validateSummary(result.rssBytes);
    validateSummary(result.privateBytes, { unsupported: true });
    validateSummary(result.descendantCount);
    if (![result.samplingTiming.actualIntervalMaxMs,
      result.samplingTiming.actualIntervalMedianMs,
      result.samplingTiming.actualIntervalP95Ms,
      result.samplingTiming.durationMs].every((item) => safeInteger(item, { minimum: 1 }))) {
      throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
    }
    const timing = result.samplingTiming;
    if (timing.actualIntervalMedianMs > timing.actualIntervalP95Ms
      || timing.actualIntervalP95Ms > timing.actualIntervalMaxMs
      || timing.actualIntervalMaxMs > 150 || timing.durationMs > 8_850
      || result.settling.actualMs > 60_000) {
      throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
    }
  }
  if (expected.size !== 0) throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
  return value;
}

function validateDocumentReceipt(value, sizeMiB, sourceSha256) {
  if (!isPlainObject(value) || value.schemaVersion !== 2
    || value.requestedMiB !== sizeMiB || value.sourceSha256 !== sourceSha256
    || !["passed", "resource-refused", "failed"].includes(value.status)
    || !safeInteger(value.elapsedMs) || !safeInteger(value.peakRssDeltaBytes)
    || typeof value.dispatchStarted !== "boolean") {
    throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
  }
}

function validateDocumentEvidence(value) {
  if (!exactKeys(value, ["attempts", "pairCount", "results", "schemaVersion", "sizesMiB", "sources"])
    || value.schemaVersion !== 1 || !sameArray(value.sizesMiB, [10, 100])
    || value.pairCount !== 5 || !Array.isArray(value.sources) || value.sources.length !== 2
    || !Array.isArray(value.attempts) || !Array.isArray(value.results)) {
    throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
  }
  const sourceBySize = new Map();
  for (const source of value.sources) {
    if (!exactKeys(source, ["sha256", "sizeMiB"]) || !value.sizesMiB.includes(source.sizeMiB)
      || !SHA256_PATTERN.test(source.sha256) || sourceBySize.has(source.sizeMiB)) {
      throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
    }
    sourceBySize.set(source.sizeMiB, source.sha256);
  }
  const matrixKeys = new Set();
  for (const sizeMiB of value.sizesMiB) {
    for (let pair = 1; pair <= value.pairCount; pair += 1) {
      for (const arm of ARMS) matrixKeys.add(`${sizeMiB}:${pair}:${arm}`);
    }
  }
  const expected = new Set(matrixKeys);
  if (value.results.length !== expected.size) {
    throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
  }
  for (const result of value.results) {
    if (!exactKeys(result, ["arm", "pair", "receipt", "sizeMiB", "sourceSha256"])
      || !value.sizesMiB.includes(result.sizeMiB)
      || !safeInteger(result.pair, { minimum: 1 }) || !ARMS.includes(result.arm)
      || result.sourceSha256 !== sourceBySize.get(result.sizeMiB)) {
      throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
    }
    const key = `${result.sizeMiB}:${result.pair}:${result.arm}`;
    if (!expected.delete(key)) throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
    validateDocumentReceipt(result.receipt, result.sizeMiB, result.sourceSha256);
  }
  if (expected.size !== 0) throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
  if (value.attempts.length < matrixKeys.size || value.attempts.length > matrixKeys.size * 2) {
    throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
  }
  const attemptsByKey = new Map();
  for (const attempt of value.attempts) {
    if (!exactKeys(attempt, ["arm", "attempt", "outcome", "pair", "sizeMiB", "sourceSha256"])
      || !value.sizesMiB.includes(attempt.sizeMiB)
      || !safeInteger(attempt.pair, { minimum: 1 }) || !ARMS.includes(attempt.arm)
      || ![1, 2].includes(attempt.attempt)
      || !["passed", "retryable-infrastructure"].includes(attempt.outcome)
      || attempt.sourceSha256 !== sourceBySize.get(attempt.sizeMiB)) {
      throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
    }
    const key = `${attempt.sizeMiB}:${attempt.pair}:${attempt.arm}`;
    if (!matrixKeys.has(key)) throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
    attemptsByKey.set(key, [...(attemptsByKey.get(key) ?? []), attempt]);
  }
  for (const key of matrixKeys) {
    const attempts = attemptsByKey.get(key) ?? [];
    const validSingle = attempts.length === 1
      && attempts[0].attempt === 1 && attempts[0].outcome === "passed";
    const validRetry = attempts.length === 2
      && attempts[0].attempt === 1 && attempts[0].outcome === "retryable-infrastructure"
      && attempts[1].attempt === 2 && attempts[1].outcome === "passed";
    if (!validSingle && !validRetry) {
      throw qualificationError("QUALIFICATION_CARDINALITY_INVALID");
    }
  }
  return value;
}

function validateRecoveryEvidence(value) {
  if (!exactKeys(value, [
    "deadlineMs",
    "finalBytes",
    "finalIdentityCount",
    "peakBytes",
    "preCallMedianBytes",
    "preCallP95Bytes",
    "recovered",
    "recoveryThresholdBytes",
    "sampleTargetsMs",
    "schemaVersion",
  ]) || value.schemaVersion !== 1 || value.deadlineMs !== 2_000
    || !sameArray(value.sampleTargetsMs, [250, 500, 1_000, 1_500, 2_000])
    || ![value.finalBytes, value.finalIdentityCount, value.peakBytes,
      value.preCallMedianBytes, value.preCallP95Bytes,
      value.recoveryThresholdBytes].every((item) => safeInteger(item))
    || typeof value.recovered !== "boolean") {
    throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function populationCvBasisPoints(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return values.every((value) => value === 0) ? 0 : Number.POSITIVE_INFINITY;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.round((Math.sqrt(variance) / mean) * 10_000);
}

function differenceBasisPoints(control, candidate) {
  if (control <= 0) throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
  return Math.round(((control - candidate) / control) * 10_000);
}

function regressionBasisPoints(control, candidate) {
  return -differenceBasisPoints(control, candidate);
}

function metricGroups(results, field) {
  const groups = new Map();
  for (const result of results) {
    const value = result[field];
    if (value === "unsupported") throw qualificationError("QUALIFICATION_EVIDENCE_INVALID");
    const key = `${result.arm}:${result.sessionCount}`;
    groups.set(key, [...(groups.get(key) ?? []), value.median]);
  }
  return groups;
}

export function evaluateNodeMemoryQualification(input) {
  if (!exactKeys(input, ["decision", "documents", "idle", "manifest", "recovery"])) {
    throw qualificationError("QUALIFICATION_INPUT_INVALID");
  }
  const decision = validateGateDecision(input.decision);
  const manifest = validateQualificationManifest(input.manifest);
  const idle = validateIdleEvidence(input.idle);
  const documents = validateDocumentEvidence(input.documents);
  const recovery = validateRecoveryEvidence(input.recovery);

  const approvedAt = Date.parse(decision.approvedAt);
  const measurementStartedAt = Date.parse(manifest.measurementStartedAt);
  const generatedAt = Date.parse(manifest.generatedAt);
  if (!(approvedAt < measurementStartedAt && measurementStartedAt <= generatedAt)) {
    throw qualificationError("QUALIFICATION_DECISION_STALE");
  }
  if (manifest.controlRevision !== idle.runtimeIdentities.control.revision
    || manifest.candidateRevision !== idle.runtimeIdentities.candidate.revision) {
    throw qualificationError("QUALIFICATION_IDENTITY_MISMATCH");
  }
  if (manifest.decisionSha256 !== qualificationSemanticDigest(decision)
    || manifest.evidenceDigests.idle !== qualificationSemanticDigest(idle)
    || manifest.evidenceDigests.documents !== qualificationSemanticDigest(documents)
    || manifest.evidenceDigests.recovery !== qualificationSemanticDigest(recovery)) {
    throw qualificationError("QUALIFICATION_EVIDENCE_DIGEST_MISMATCH");
  }
  if (idle.runtimeIdentities.control.toolContractSha256
    !== idle.runtimeIdentities.candidate.toolContractSha256) {
    throw qualificationError("QUALIFICATION_TOOL_CONTRACT_INVALID");
  }

  const failedGates = [];
  if (idle.unexpectedStderrBytes !== 0) failedGates.push("idle.unexpected-stderr");
  if (idle.cleanup.remainingIdentityCount !== 0) failedGates.push("idle.cleanup");

  const rssGroups = metricGroups(idle.results, "rssBytes");
  const privateGroups = metricGroups(idle.results, "privateBytes");
  for (const arm of ARMS) {
    for (const sessionCount of SESSION_COUNTS) {
      for (const [metric, groups] of [["rss", rssGroups], ["private", privateGroups]]) {
        if (populationCvBasisPoints(groups.get(`${arm}:${sessionCount}`))
          > decision.thresholds.maxCvBasisPoints) {
          failedGates.push(`idle.cv.${metric}.${arm}.session-${sessionCount}`);
        }
      }
    }
  }
  for (const sessionCount of SESSION_COUNTS) {
    const candidateRss = median(rssGroups.get(`candidate:${sessionCount}`));
    if (candidateRss / sessionCount > decision.thresholds.absoluteRssBytesPerSession) {
      failedGates.push(`idle.absolute-rss.session-${sessionCount}`);
    }
  }
  for (const sessionCount of SESSION_COUNTS) {
    const controlRss = median(rssGroups.get(`control:${sessionCount}`));
    const candidateRss = median(rssGroups.get(`candidate:${sessionCount}`));
    if (differenceBasisPoints(controlRss, candidateRss)
      < decision.thresholds.relativeRssReductionBasisPoints) {
      failedGates.push(`idle.relative-rss-reduction.session-${sessionCount}`);
    }
  }
  const candidatePrivate20 = median(privateGroups.get("candidate:20"));
  if (candidatePrivate20 > decision.thresholds.private20SessionBytes) {
    failedGates.push("idle.private-total.session-20");
  }
  for (const sessionCount of SESSION_COUNTS) {
    const controlPrivate = median(privateGroups.get(`control:${sessionCount}`));
    const candidatePrivate = median(privateGroups.get(`candidate:${sessionCount}`));
    if (regressionBasisPoints(controlPrivate, candidatePrivate)
      > decision.thresholds.maxPerSegmentPrivateRegressionBasisPoints) {
      failedGates.push(`idle.private-regression.session-${sessionCount}`);
    }
  }
  const expectedRecoveryThreshold = Math.max(
    recovery.preCallP95Bytes,
    Math.floor(
      recovery.preCallMedianBytes * decision.thresholds.recoveryMultiplierBasisPoints / 10_000,
    ),
  );
  if (recovery.deadlineMs !== decision.thresholds.recoveryDeadlineMs
    || recovery.recoveryThresholdBytes !== expectedRecoveryThreshold
    || !recovery.recovered || recovery.finalBytes > recovery.recoveryThresholdBytes
    || recovery.finalIdentityCount !== 0) {
    failedGates.push("recovery.two-second");
  }
  for (const sizeMiB of documents.sizesMiB) {
    const rows = documents.results.filter((result) => result.sizeMiB === sizeMiB);
    if (rows.some((result) => result.receipt.status !== "passed")) {
      failedGates.push(`documents.status.size-${sizeMiB}`);
      continue;
    }
    const controlElapsed = median(rows.filter(({ arm }) => arm === "control")
      .map(({ receipt }) => receipt.elapsedMs));
    const candidateElapsed = median(rows.filter(({ arm }) => arm === "candidate")
      .map(({ receipt }) => receipt.elapsedMs));
    if (regressionBasisPoints(controlElapsed, candidateElapsed)
      > decision.thresholds.maxPerformanceRegressionBasisPoints) {
      failedGates.push(`documents.performance.size-${sizeMiB}`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    decision: failedGates.length === 0 ? "go" : "no-go",
    failedGates: Object.freeze(failedGates),
    inputDigest: qualificationSemanticDigest({ decision, manifest, idle, documents, recovery }),
  });
}

export function validateGateDecision(value) {
  if (!exactKeys(value, DECISION_KEYS) || value.schemaVersion !== 1
    || !exactTimestamp(value.approvedAt)
    || value.v8Aggregation !== FIXED_AGGREGATION
    || value.displayRoundingDecimals !== 2
    || !exactKeys(value.thresholds, THRESHOLD_KEYS)) {
    throw gateError("GATE_DECISION_INVALID");
  }
  for (const key of THRESHOLD_KEYS) {
    if (!Number.isSafeInteger(value.thresholds[key]) || value.thresholds[key] < 0
      || value.thresholds[key] !== FIXED_THRESHOLDS[key]) {
      throw gateError("GATE_DECISION_INVALID");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    approvedAt: value.approvedAt,
    thresholds: Object.freeze({ ...FIXED_THRESHOLDS }),
    v8Aggregation: FIXED_AGGREGATION,
    displayRoundingDecimals: 2,
  });
}

function createGateDecision(now) {
  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.valueOf())) {
    throw gateError("GATE_DECISION_CLOCK_INVALID");
  }
  return validateGateDecision({
    schemaVersion: 1,
    approvedAt: timestamp.toISOString(),
    thresholds: { ...FIXED_THRESHOLDS },
    v8Aggregation: FIXED_AGGREGATION,
    displayRoundingDecimals: 2,
  });
}

function parseDecisionCli(arguments_) {
  if (!Array.isArray(arguments_)) {
    throw gateError("GATE_DECISION_USAGE_INVALID");
  }
  if (arguments_.length === 5 && arguments_[0] === "evaluate"
    && arguments_[1] === "--input" && typeof arguments_[2] === "string" && arguments_[2].length > 0
    && arguments_[3] === "--output" && typeof arguments_[4] === "string" && arguments_[4].length > 0) {
    return { action: "evaluate", inputPath: arguments_[2], outputPath: arguments_[4] };
  }
  if (arguments_.length !== 4 || arguments_[0] !== "decision") {
    throw gateError("GATE_DECISION_USAGE_INVALID");
  }
  const [, action, option, path] = arguments_;
  if (action === "create" && option === "--output" && typeof path === "string" && path.length > 0) {
    return { action, path };
  }
  if (action === "verify" && option === "--input" && typeof path === "string" && path.length > 0) {
    return { action, path };
  }
  throw gateError("GATE_DECISION_USAGE_INVALID");
}

export async function runNodeMemoryGateCli(
  arguments_,
  { io = process, now = () => new Date() } = {},
) {
  const request = parseDecisionCli(arguments_);
  if (request.action === "evaluate") {
    let input;
    try {
      input = JSON.parse(await readFile(request.inputPath, "utf8"));
      const result = evaluateNodeMemoryQualification(input);
      const outputPath = resolve(request.outputPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
      io.stdout.write(`NODE_MEMORY_QUALIFICATION_${result.decision === "go" ? "GO" : "NO_GO"}\n`);
      return result.decision === "go" ? 0 : 1;
    } catch (error) {
      const code = typeof error?.code === "string" && error.code.startsWith("QUALIFICATION_")
        ? error.code
        : "QUALIFICATION_INPUT_INVALID";
      (io.stderr ?? io.stdout).write(`NODE_MEMORY_QUALIFICATION_INVALID code=${code}\n`);
      return 2;
    }
  }
  if (request.action === "create") {
    const decision = createGateDecision(now);
    const outputPath = resolve(request.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(decision, null, 2)}\n`, { flag: "wx" })
      .catch((error) => {
        if (error?.code === "EEXIST") throw gateError("GATE_DECISION_EXISTS");
        throw error;
      });
  } else {
    let value;
    try {
      value = JSON.parse(await readFile(request.path, "utf8"));
    } catch (error) {
      if (error?.code?.startsWith?.("GATE_DECISION_")) throw error;
      throw gateError("GATE_DECISION_INVALID");
    }
    validateGateDecision(value);
  }
  io.stdout.write("NODE_MEMORY_GATE_DECISION_OK\n");
  return 0;
}

async function main() {
  try {
    process.exitCode = await runNodeMemoryGateCli(process.argv.slice(2));
  } catch (error) {
    const code = typeof error?.code === "string" && error.code.startsWith("GATE_DECISION_")
      ? error.code
      : "GATE_DECISION_INTERNAL_ERROR";
    process.stderr.write(`NODE_MEMORY_GATE_DECISION_FAILED code=${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
