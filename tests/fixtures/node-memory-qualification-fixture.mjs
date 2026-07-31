import { createHash } from "node:crypto";

export const CONTROL_REVISION = "a".repeat(40);
export const CANDIDATE_REVISION = "c".repeat(40);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

export const DECISION = Object.freeze({
  schemaVersion: 1,
  approvedAt: "2026-07-29T00:00:00.000Z",
  thresholds: Object.freeze({
    absoluteRssBytesPerSession: 74_763_468,
    relativeRssReductionBasisPoints: 1_000,
    private20SessionBytes: 891_289_600,
    maxCvBasisPoints: 500,
    recoveryDeadlineMs: 2_000,
    recoveryMultiplierBasisPoints: 11_000,
    maxPerformanceRegressionBasisPoints: 1_500,
    maxPerSegmentPrivateRegressionBasisPoints: 500,
  }),
  v8Aggregation: "equal-weight-per-session-private-arithmetic-mean",
  displayRoundingDecimals: 2,
});

export function semanticDigest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function summary(median) {
  return { min: median, median, p95: median, max: median };
}

function idleFixture() {
  const rss = {
    control: { 1: 80_000_000, 5: 400_000_000, 20: 1_600_000_000 },
    candidate: { 1: 70_000_000, 5: 350_000_000, 20: 1_400_000_000 },
  };
  const privateBytes = {
    control: { 1: 42_000_000, 5: 205_000_000, 20: 790_000_000 },
    candidate: { 1: 42_500_000, 5: 207_000_000, 20: 800_000_000 },
  };
  const results = [];
  for (let pair = 1; pair <= 5; pair += 1) {
    for (const arm of ["control", "candidate"]) {
      for (const sessionCount of [1, 5, 20]) {
        results.push({
          pair,
          arm,
          sessionCount,
          rssBytes: summary(rss[arm][sessionCount]),
          privateBytes: summary(privateBytes[arm][sessionCount]),
          descendantCount: summary(sessionCount),
          settling: { requestedMs: 5_000, actualMs: 5_000 },
          samplingTiming: {
            actualIntervalMedianMs: 100,
            actualIntervalP95Ms: 101,
            actualIntervalMaxMs: 102,
            durationMs: 5_900,
          },
        });
      }
    }
  }
  const identity = (revision, safeArgs, runtimeArtifactSha256) => ({
    revision,
    runtimeArtifactSha256,
    lockfileSha256: HASH_A,
    benchmarkSha256: HASH_B,
    safeArgs,
    nodeVersion: "v22.22.2",
    toolContractSha256: HASH_C,
  });
  return {
    schemaVersion: 2,
    runtime: "node",
    platform: "win32",
    arch: "x64",
    sessionCounts: [1, 5, 20],
    pairCount: 5,
    sampleCount: 60,
    sampleIntervalMs: 100,
    settleMs: 5_000,
    toolCount: 9,
    unexpectedStderrBytes: 0,
    cleanup: { observedIdentityCount: 60, remainingIdentityCount: 0 },
    v8Aggregation: "equal-weight-per-session-private-arithmetic-mean",
    runtimeIdentities: {
      control: identity(CONTROL_REVISION, [], HASH_D),
      candidate: identity(CANDIDATE_REVISION, ["--max-semi-space-size=1"], HASH_B),
    },
    results,
  };
}

function benchmarkReceipt({ sizeMiB, sourceSha256, elapsedMs, peakRssDeltaBytes }) {
  return {
    schemaVersion: 2,
    platform: "win32",
    arch: "x64",
    runtime: "node-v22.22.2",
    requestedMiB: sizeMiB,
    actualBytes: sizeMiB * 1024 * 1024,
    operation: "detectFormat",
    executionMode: sizeMiB === 10 ? "transferable-worker" : "supervised-child",
    status: "passed",
    elapsedMs,
    peakRssDeltaBytes,
    copiedBytes: sizeMiB * 1024 * 1024,
    dispatchStarted: true,
    responseBytes: 17,
    errorCode: null,
    sourceSha256,
    outputSha256: null,
  };
}

function documentsFixture() {
  const sources = [
    { sizeMiB: 10, sha256: HASH_A },
    { sizeMiB: 100, sha256: HASH_B },
  ];
  const attempts = [];
  const results = [];
  for (const { sizeMiB, sha256 } of sources) {
    for (let pair = 1; pair <= 5; pair += 1) {
      for (const arm of pair % 2 === 1 ? ["control", "candidate"] : ["candidate", "control"]) {
        attempts.push({ sizeMiB, pair, arm, attempt: 1, outcome: "passed", sourceSha256: sha256 });
        results.push({
          sizeMiB,
          pair,
          arm,
          sourceSha256: sha256,
          receipt: benchmarkReceipt({
            sizeMiB,
            sourceSha256: sha256,
            elapsedMs: arm === "control" ? 1_000 : 1_050,
            peakRssDeltaBytes: sizeMiB * 1024 * 1024,
          }),
        });
      }
    }
  }
  return { schemaVersion: 1, sizesMiB: [10, 100], pairCount: 5, sources, attempts, results };
}

function recoveryFixture() {
  return {
    schemaVersion: 1,
    deadlineMs: 2_000,
    sampleTargetsMs: [250, 500, 1_000, 1_500, 2_000],
    preCallMedianBytes: 100,
    preCallP95Bytes: 100,
    recoveryThresholdBytes: 110,
    peakBytes: 180,
    finalBytes: 109,
    finalIdentityCount: 0,
    recovered: true,
  };
}

export function completePassingFixture({
  measurementStartedAt = "2026-07-29T00:00:01.000Z",
  generatedAt = "2026-07-29T00:01:00.000Z",
  controlRevision = CONTROL_REVISION,
  candidateRevision = CANDIDATE_REVISION,
} = {}) {
  const idle = idleFixture();
  idle.runtimeIdentities.control.revision = controlRevision;
  idle.runtimeIdentities.candidate.revision = candidateRevision;
  const documents = documentsFixture();
  const recovery = recoveryFixture();
  const manifest = {
    schemaVersion: 1,
    measurementStartedAt,
    generatedAt,
    controlRevision,
    candidateRevision,
    decisionSha256: semanticDigest(DECISION),
    decisionFileSha256: semanticDigest(DECISION),
    evidenceDigests: {
      idle: semanticDigest(idle),
      documents: semanticDigest(documents),
      recovery: semanticDigest(recovery),
    },
    evidenceFileDigests: {
      idle: semanticDigest(idle),
      documents: semanticDigest(documents),
      recovery: semanticDigest(recovery),
    },
    commandIds: ["build", "idle", "documents", "recovery"],
  };
  return { decision: structuredClone(DECISION), manifest, idle, documents, recovery };
}
