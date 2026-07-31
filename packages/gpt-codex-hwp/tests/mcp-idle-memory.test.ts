import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPrivacySafeReport,
  nearestRank,
  parseBenchmarkArguments,
  parseSessionCounts,
  runBenchmarkArm,
  sampleWindowsKnownProcesses,
  settleBeforeSampling,
  summarizeSamplingTiming,
  summarizeSamples,
  validateBenchmarkReport,
} from "../benchmarks/mcp-idle-memory.mjs";
import {
  publicRuntimeIdentity,
  summarizePairStatistics,
  validateIdleMemoryReportV2,
} from "../benchmarks/idle-memory-report.mjs";
import { validateArmWorkerReceipt } from "../benchmarks/node-memory-arm-receipt.mjs";
import { snapshotProcessTreeIdentities } from "../benchmarks/process-tree-ledger.mjs";

const CONTROL_MCP = "C:\\bench-control\\dist\\mcp.js";
const CANDIDATE_MCP = "C:\\bench-candidate\\dist\\mcp.js";
const OUTPUT = "C:\\bench-output\\idle.json";
const CONTROL_REVISION = "6983ffaf7e0a392bc9852a121ae14895ab4160fb";
const CANDIDATE_REVISION = "05efdd9a901e82567887d50d1501ce7fd2ee9370";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const ARM_FIXTURE = join(TEST_ROOT, "fixtures", "node-memory-arm-fixture.mjs");

function armReceiptFixture() {
  return {
    schemaVersion: 1,
    status: "ok",
    toolCount: 9,
    toolContractSha256: HASH_A,
    unexpectedStderrBytes: 0,
    remainingDescendants: 0,
    cleanup: { observedIdentityCount: 1, remainingIdentityCount: 0 },
    result: {
      pair: 1,
      arm: "candidate",
      sessionCount: 1,
      rssBytes: { median: 100, p95: 110, min: 90, max: 120 },
      privateBytes: { median: 50, p95: 55, min: 45, max: 60 },
      descendantCount: { median: 0, p95: 0, min: 0, max: 0 },
      settling: { requestedMs: 5_000, actualMs: 5_000 },
      samplingTiming: {
        actualIntervalMedianMs: 100,
        actualIntervalP95Ms: 101,
        actualIntervalMaxMs: 101,
        durationMs: 5_900,
      },
    },
  };
}

function completeIdleReportFixture() {
  const identity = (revision: string, safeArgs: readonly string[]) => ({
    revision,
    runtimeArtifactSha256: HASH_A,
    lockfileSha256: HASH_B,
    benchmarkSha256: HASH_C,
    safeArgs,
    nodeVersion: "v22.22.2",
    toolContractSha256: HASH_D,
  });
  const results = [];
  for (let pair = 1; pair <= 5; pair += 1) {
    for (const sessionCount of [1, 5, 20]) {
      for (const arm of ["control", "candidate"] as const) {
        const bytes = sessionCount * 1_000_000 + pair * 1_000 + (arm === "control" ? 100 : 0);
        results.push({
          pair,
          arm,
          sessionCount,
          rssBytes: { median: bytes, p95: bytes + 10, min: bytes - 10, max: bytes + 20 },
          privateBytes: { median: bytes / 2, p95: bytes / 2 + 10, min: bytes / 2 - 10, max: bytes / 2 + 20 },
          descendantCount: { median: sessionCount, p95: sessionCount, min: sessionCount, max: sessionCount },
          settling: { requestedMs: 5_000, actualMs: 5_000 },
          samplingTiming: {
            actualIntervalMedianMs: 100,
            actualIntervalP95Ms: 101,
            actualIntervalMaxMs: 101,
            durationMs: 5_900,
          },
        });
      }
    }
  }
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
      control: identity(CONTROL_REVISION, []),
      candidate: identity(CANDIDATE_REVISION, ["--max-semi-space-size=1"]),
    },
    results,
  };
}

test("idle benchmark accepts only the complete ordered 1,5,20 session set", () => {
  assert.deepEqual(parseSessionCounts("1,5,20"), [1, 5, 20]);
  for (const invalid of ["", "1", "2", "1,20", "20,5,1", "1,5,20,20"]) {
    assert.throws(
      () => parseSessionCounts(invalid),
      /sessions must be exactly 1,5,20/u,
      invalid,
    );
  }
});

test("idle benchmark uses hand-checked nearest-rank statistics", () => {
  assert.equal(nearestRank([40, 10, 30, 20], 0.5), 20);
  assert.equal(nearestRank([40, 10, 30, 20], 0.95), 40);
  assert.deepEqual(summarizeSamples([40, 10, 30, 20]), {
    median: 20,
    p95: 40,
    min: 10,
    max: 40,
  });
  assert.throws(() => summarizeSamples([]), /at least one sample/u);
});

test("idle benchmark settles for at least 5000 monotonic milliseconds", async () => {
  let nowMs = 100;
  const receipt = await settleBeforeSampling({
    durationMs: 5_000,
    now: () => nowMs,
    delay: async (milliseconds: number) => { nowMs += milliseconds; },
  });
  assert.deepEqual(receipt, { requestedMs: 5_000, actualMs: 5_000 });
});

test("sampling timing reports actual intervals and rejects schedule drift", () => {
  assert.deepEqual(summarizeSamplingTiming([0, 101, 201, 300], 100), {
    actualIntervalMedianMs: 100,
    actualIntervalP95Ms: 101,
    actualIntervalMaxMs: 101,
    durationMs: 300,
  });
  assert.throws(
    () => summarizeSamplingTiming([0, 100, 350], 100),
    /SAMPLING_INTERVAL_UNSTABLE/u,
  );
});

test("Windows known-PID sampler sustains sixty 100ms fixed targets", {
  skip: process.platform !== "win32" ? "Windows process sampler only" : false,
}, async () => {
  const target = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  try {
    assert.ok(Number.isSafeInteger(target.pid));
    const identities = await snapshotProcessTreeIdentities([target.pid as number]);
    const sampled = await sampleWindowsKnownProcesses(identities, 60, 100);
    assert.equal(sampled.samples.length, 60);
    assert.equal(sampled.timestamps.length, 60);
    assert.equal(sampled.samples.every(({ missingRootCount }) => missingRootCount === 0), true);
    assert.doesNotThrow(() => summarizeSamplingTiming(sampled.timestamps, 100));
  } finally {
    if (target.exitCode === null && target.signalCode === null) target.kill("SIGKILL");
    if (target.exitCode === null && target.signalCode === null) await once(target, "close");
  }
});

test("idle benchmark CLI requires explicit absolute control, candidate, and output paths", () => {
  assert.deepEqual(
    parseBenchmarkArguments([
      "--sessions", "1,5,20",
      "--pairs", "5",
      "--control-mcp", CONTROL_MCP,
      "--candidate-mcp", CANDIDATE_MCP,
      "--output", OUTPUT,
      "--control-revision", CONTROL_REVISION,
      "--candidate-revision", CANDIDATE_REVISION,
      "--candidate-node-arg=--max-semi-space-size=1",
    ]),
    {
      sessionCounts: [1, 5, 20],
      pairCount: 5,
      controlMcpPath: CONTROL_MCP,
      candidateMcpPath: CANDIDATE_MCP,
      outputPath: OUTPUT,
      controlRevision: CONTROL_REVISION,
      candidateRevision: CANDIDATE_REVISION,
      candidateNodeArgs: ["--max-semi-space-size=1"],
    },
  );
  assert.throws(
    () => parseBenchmarkArguments([
      "--sessions", "1,5,20",
      "--pairs", "5",
      "--control-mcp", "relative-control.js",
      "--candidate-mcp", CANDIDATE_MCP,
      "--output", OUTPUT,
      "--control-revision", CONTROL_REVISION,
      "--candidate-revision", CANDIDATE_REVISION,
    ]),
    /control MCP path must be absolute/u,
  );
});

test("idle benchmark validates deterministic aggregate reports and rejects private data", () => {
  const report = completeIdleReportFixture();
  assert.deepEqual(validateBenchmarkReport(report), report);
  assert.doesNotThrow(() => assertPrivacySafeReport(report));
  assert.throws(
    () => validateBenchmarkReport({ ...report, settleMs: 0 }),
    /IDLE_REPORT_INVALID/u,
  );

  const homePath = ["C:", "Users", "fixture", "idle.json"].join("\\");
  const credentialKey = ["OPENAI", "API", "KEY"].join("_");

  for (const privateValue of [
    { ...report, username: "fixture" },
    { ...report, outputPath: homePath },
    { ...report, environment: { [credentialKey]: "redacted" } },
    { ...report, pid: 1234 },
  ]) {
    assert.throws(
      () => assertPrivacySafeReport(privateValue),
      /privacy-safe aggregate fields/u,
    );
  }
});

test("schema v2 requires every pair arm and session exactly once", () => {
  const report = completeIdleReportFixture();
  assert.equal(report.results.length, 30);
  assert.doesNotThrow(() => validateIdleMemoryReportV2(report));
  assert.throws(
    () => validateIdleMemoryReportV2({ ...report, results: [] }),
    /IDLE_RESULTS_INCOMPLETE/u,
  );
  assert.throws(
    () => validateIdleMemoryReportV2({ ...report, results: [...report.results, report.results[0]] }),
    /IDLE_RESULTS_INCOMPLETE/u,
  );
});

test("pair statistics expose population CV from unrounded values", () => {
  assert.deepEqual(summarizePairStatistics([100, 102, 98, 101, 99]), {
    pairMedians: [100, 102, 98, 101, 99],
    mean: 100,
    populationCvBasisPoints: 141,
  });
});

test("schema v2 preserves high-CV evidence for the qualification gate", () => {
  const report = completeIdleReportFixture();
  const results = report.results.map((result) => result.pair === 5
    && result.arm === "candidate" && result.sessionCount === 1
    ? {
        ...result,
        rssBytes: { median: 9_000_000, p95: 9_000_000, min: 9_000_000, max: 9_000_000 },
      }
    : result);
  assert.doesNotThrow(() => validateIdleMemoryReportV2({ ...report, results }));
  const medians = results.filter((result) => result.arm === "candidate"
    && result.sessionCount === 1).map((result) => result.rssBytes.median);
  assert.ok(summarizePairStatistics(medians).populationCvBasisPoints > 500);
});

test("public runtime identity omits private launch paths", () => {
  const identity = publicRuntimeIdentity({
    revision: CANDIDATE_REVISION,
    command: "C:\\private\\node.exe",
    args: ["--max-semi-space-size=1", "C:\\private\\dist\\mcp.js"],
    cwd: "C:\\private",
    safeArgs: ["--max-semi-space-size=1"],
  }, {
    runtimeArtifactSha256: HASH_A,
    lockfileSha256: HASH_B,
    benchmarkSha256: HASH_C,
    nodeVersion: "v22.22.2",
    toolContractSha256: HASH_D,
  });
  assert.deepEqual(identity, completeIdleReportFixture().runtimeIdentities.candidate);
  assert.doesNotMatch(JSON.stringify(identity), /private|cwd|command/iu);
});

test("arm worker receipt requires exact cleanup and aggregate keys", () => {
  const receipt = armReceiptFixture();
  assert.deepEqual(validateArmWorkerReceipt(receipt), receipt);
  assert.throws(
    () => validateArmWorkerReceipt({ ...receipt, cleanup: undefined }),
    /ARM_WORKER_RECEIPT_INVALID/u,
  );
  assert.throws(
    () => validateArmWorkerReceipt({
      ...receipt,
      cleanup: { observedIdentityCount: 1, remainingIdentityCount: 1 },
    }),
    /ARM_WORKER_CLEANUP_FAILED/u,
  );
  assert.throws(
    () => validateArmWorkerReceipt({ ...receipt, privatePath: "C:\\private" }),
    /ARM_WORKER_RECEIPT_INVALID/u,
  );
});

test("runBenchmarkArm receives its result through the supervised worker boundary", async () => {
  const measurement = await runBenchmarkArm({
    arm: "candidate",
    pair: 1,
    sessionCount: 1,
    mcpPath: ARM_FIXTURE,
    nodeArgs: ["--max-semi-space-size=1"],
    dependencies: { armWorkerPath: ARM_FIXTURE },
  });
  assert.deepEqual(measurement, {
    toolCount: 9,
    toolContractSha256: HASH_A,
    unexpectedStderrBytes: 0,
    remainingDescendants: 0,
    cleanup: { observedIdentityCount: 1, remainingIdentityCount: 0 },
    result: {
      pair: 1,
      arm: "candidate",
      sessionCount: 1,
      rssBytes: { median: 1_000_000, p95: 1_000_000, min: 1_000_000, max: 1_000_000 },
      privateBytes: { median: 1_000_000, p95: 1_000_000, min: 1_000_000, max: 1_000_000 },
      descendantCount: { median: 0, p95: 0, min: 0, max: 0 },
      settling: { requestedMs: 5_000, actualMs: 5_000 },
      samplingTiming: {
        actualIntervalMedianMs: 100,
        actualIntervalP95Ms: 100,
        actualIntervalMaxMs: 100,
        durationMs: 5_900,
      },
    },
  });
});
