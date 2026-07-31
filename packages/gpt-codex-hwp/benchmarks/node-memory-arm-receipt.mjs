const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export function validateArmWorkerReceipt(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) receiptInvalid();
  if (value.status === "error") {
    if (!hasExactKeys(value, ["schemaVersion", "status", "code"])
      || typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.code)) {
      receiptInvalid();
    }
    throw new Error(value.code);
  }
  if (value.status !== "ok" || !hasExactKeys(value, [
    "schemaVersion",
    "status",
    "toolCount",
    "toolContractSha256",
    "unexpectedStderrBytes",
    "remainingDescendants",
    "cleanup",
    "result",
  ])) receiptInvalid();
  if (value.toolCount !== 9 || typeof value.toolContractSha256 !== "string"
    || !HASH_PATTERN.test(value.toolContractSha256)
    || value.unexpectedStderrBytes !== 0 || value.remainingDescendants !== 0) {
    receiptInvalid();
  }
  validateCleanup(value.cleanup, value.result);
  validateResult(value.result);
  return value;
}

function validateCleanup(cleanup, result) {
  if (!isRecord(cleanup) || !hasExactKeys(cleanup, ["observedIdentityCount", "remainingIdentityCount"])
    || !Number.isSafeInteger(cleanup.observedIdentityCount) || cleanup.observedIdentityCount < 1
    || !Number.isSafeInteger(cleanup.remainingIdentityCount) || cleanup.remainingIdentityCount < 0) {
    receiptInvalid();
  }
  if (cleanup.remainingIdentityCount !== 0) throw new Error("ARM_WORKER_CLEANUP_FAILED");
  if (isRecord(result) && Number.isSafeInteger(result.sessionCount)
    && cleanup.observedIdentityCount < result.sessionCount) {
    receiptInvalid();
  }
}

function validateResult(result) {
  if (!isRecord(result) || !hasExactKeys(result, [
    "pair",
    "arm",
    "sessionCount",
    "rssBytes",
    "privateBytes",
    "descendantCount",
    "settling",
    "samplingTiming",
  ])
    || !Number.isSafeInteger(result.pair) || result.pair < 1 || result.pair > 5
    || (result.arm !== "control" && result.arm !== "candidate")
    || ![1, 5, 20].includes(result.sessionCount)) {
    receiptInvalid();
  }
  validateSummary(result.rssBytes);
  if (result.privateBytes !== "unsupported") validateSummary(result.privateBytes);
  validateSummary(result.descendantCount);
  if (!isRecord(result.settling)
    || !hasExactKeys(result.settling, ["requestedMs", "actualMs"])
    || result.settling.requestedMs !== 5_000
    || !Number.isSafeInteger(result.settling.actualMs)
    || result.settling.actualMs < result.settling.requestedMs) {
    receiptInvalid();
  }
  const timing = result.samplingTiming;
  if (!isRecord(timing) || !hasExactKeys(timing, [
    "actualIntervalMedianMs",
    "actualIntervalP95Ms",
    "actualIntervalMaxMs",
    "durationMs",
  ])
    || !Number.isSafeInteger(timing.actualIntervalMedianMs) || timing.actualIntervalMedianMs < 1
    || !Number.isSafeInteger(timing.actualIntervalP95Ms)
    || timing.actualIntervalP95Ms < timing.actualIntervalMedianMs
    || !Number.isSafeInteger(timing.actualIntervalMaxMs)
    || timing.actualIntervalMaxMs < timing.actualIntervalP95Ms
    || timing.actualIntervalMaxMs > 150
    || !Number.isSafeInteger(timing.durationMs) || timing.durationMs < 1) {
    receiptInvalid();
  }
}

function validateSummary(summary) {
  if (!isRecord(summary) || !hasExactKeys(summary, ["median", "p95", "min", "max"])) receiptInvalid();
  const { median, p95, min, max } = summary;
  if (![median, p95, min, max].every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    || min > median || median > p95 || p95 > max) {
    receiptInvalid();
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function receiptInvalid() {
  throw new Error("ARM_WORKER_RECEIPT_INVALID");
}
