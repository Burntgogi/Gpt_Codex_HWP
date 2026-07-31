import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateNodeMemoryQualification,
  runNodeMemoryGateCli,
  validateGateDecision,
} from "../scripts/node-memory-gate.mjs";
import {
  completePassingFixture,
  DECISION,
  semanticDigest,
  summary,
} from "./fixtures/node-memory-qualification-fixture.mjs";

test("gate decision accepts only the pre-approved raw-byte contract", () => {
  assert.deepEqual(validateGateDecision(DECISION), DECISION);
  assert.throws(
    () => validateGateDecision({
      ...DECISION,
      thresholds: { ...DECISION.thresholds, absoluteRssBytesPerSession: 77_594_624 },
    }),
    /GATE_DECISION_INVALID/u,
  );
  assert.throws(
    () => validateGateDecision({ ...DECISION, displayRoundingDecimals: 1 }),
    /GATE_DECISION_INVALID/u,
  );
});

test("gate decision rejects timestamp, key, and aggregation drift", () => {
  assert.throws(
    () => validateGateDecision({ ...DECISION, approvedAt: "2026-07-29" }),
    /GATE_DECISION_INVALID/u,
  );
  assert.throws(
    () => validateGateDecision({ ...DECISION, extra: true }),
    /GATE_DECISION_INVALID/u,
  );
  assert.throws(
    () => validateGateDecision({ ...DECISION, v8Aggregation: "session-weighted" }),
    /GATE_DECISION_INVALID/u,
  );
});

test("qualification is Go only when every fixed gate passes", () => {
  const result = evaluateNodeMemoryQualification(completePassingFixture());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.decision, "go");
  assert.deepEqual(result.failedGates, []);
  assert.match(result.inputDigest, /^[a-f0-9]{64}$/u);
});

test("qualification rejects stale candidate evidence before metrics", () => {
  const fixture = completePassingFixture();
  fixture.idle.runtimeIdentities.candidate.revision = "1".repeat(40);
  assert.throws(
    () => evaluateNodeMemoryQualification(fixture),
    /QUALIFICATION_IDENTITY_MISMATCH/u,
  );
});

test("qualification binds distinct control and candidate build hashes independently", () => {
  const fixture = completePassingFixture();
  fixture.idle.runtimeIdentities.control.lockfileSha256 = "1".repeat(64);
  fixture.idle.runtimeIdentities.candidate.lockfileSha256 = "2".repeat(64);
  fixture.idle.runtimeIdentities.control.benchmarkSha256 = "3".repeat(64);
  fixture.idle.runtimeIdentities.candidate.benchmarkSha256 = "4".repeat(64);
  fixture.manifest.evidenceDigests.idle = semanticDigest(fixture.idle);

  assert.equal(evaluateNodeMemoryQualification(fixture).decision, "go");
});

test("qualification rejects an incomplete document attempt ledger", () => {
  const fixture = completePassingFixture();
  fixture.documents.attempts.pop();
  assert.throws(
    () => evaluateNodeMemoryQualification(fixture),
    /QUALIFICATION_CARDINALITY_INVALID/u,
  );
});

test("qualification rejects idle sampling intervals outside the measured contract", () => {
  const fixture = completePassingFixture();
  fixture.idle.results[0].samplingTiming.actualIntervalMaxMs = 1_000;
  fixture.manifest.evidenceDigests.idle = semanticDigest(fixture.idle);
  assert.throws(
    () => evaluateNodeMemoryQualification(fixture),
    /QUALIFICATION_EVIDENCE_INVALID/u,
  );
});

test("qualification reports CV failure without confusing it with invalid evidence", () => {
  const fixture = completePassingFixture();
  const result = fixture.idle.results.find((row) => row.pair === 5
    && row.arm === "candidate" && row.sessionCount === 5);
  result.rssBytes = summary(500_000_000);
  fixture.manifest.evidenceDigests.idle = semanticDigest(fixture.idle);
  const decision = evaluateNodeMemoryQualification(fixture);
  assert.equal(decision.decision, "no-go");
  assert.deepEqual(decision.failedGates, ["idle.cv.rss.candidate.session-5"]);
});

test("qualification returns stable No-Go gates for valid measured failures", () => {
  const fixture = completePassingFixture();
  for (const result of fixture.idle.results) {
    if (result.arm === "candidate" && result.sessionCount === 1) {
      result.rssBytes = summary(78_000_000);
    }
  }
  fixture.recovery = { ...fixture.recovery, finalBytes: 120, recovered: false };
  fixture.manifest.evidenceDigests.idle = semanticDigest(fixture.idle);
  fixture.manifest.evidenceDigests.recovery = semanticDigest(fixture.recovery);

  const result = evaluateNodeMemoryQualification(fixture);
  assert.equal(result.decision, "no-go");
  assert.deepEqual(result.failedGates, [
    "idle.absolute-rss.session-1",
    "idle.relative-rss-reduction.session-1",
    "recovery.two-second",
  ]);
});

test("decision CLI creates once, verifies, and emits a fixed receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "node-memory-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "nested", "decision.json");
  let output = "";
  const io = { stdout: { write(value) { output += value; } } };
  const now = () => new Date("2026-07-29T01:02:03.004Z");

  assert.equal(await runNodeMemoryGateCli([
    "decision", "create", "--output", outputPath,
  ], { io, now }), 0);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written.approvedAt, "2026-07-29T01:02:03.004Z");
  assert.deepEqual(validateGateDecision(written), written);
  await assert.rejects(
    () => runNodeMemoryGateCli(["decision", "create", "--output", outputPath], { io, now }),
    /GATE_DECISION_EXISTS/u,
  );
  assert.equal(await runNodeMemoryGateCli([
    "decision", "verify", "--input", outputPath,
  ], { io, now }), 0);
  assert.equal(
    output,
    "NODE_MEMORY_GATE_DECISION_OK\nNODE_MEMORY_GATE_DECISION_OK\n",
  );
  assert.doesNotMatch(output, /Users|AppData|node-memory-gate/iu);
});

test("evaluate CLI returns 0 for Go, 1 for No-Go, and 2 for invalid evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "node-memory-evaluate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const io = {
    stdout: { write() {} },
    stderr: { write() {} },
  };

  const goInput = join(root, "go-input.json");
  const goOutput = join(root, "go-output.json");
  await writeFile(goInput, JSON.stringify(completePassingFixture()));
  assert.equal(await runNodeMemoryGateCli([
    "evaluate", "--input", goInput, "--output", goOutput,
  ], { io }), 0);
  assert.equal(JSON.parse(await readFile(goOutput, "utf8")).decision, "go");

  const noGo = completePassingFixture();
  noGo.recovery = { ...noGo.recovery, finalBytes: 120, recovered: false };
  noGo.manifest.evidenceDigests.recovery = semanticDigest(noGo.recovery);
  const noGoInput = join(root, "no-go-input.json");
  const noGoOutput = join(root, "no-go-output.json");
  await writeFile(noGoInput, JSON.stringify(noGo));
  assert.equal(await runNodeMemoryGateCli([
    "evaluate", "--input", noGoInput, "--output", noGoOutput,
  ], { io }), 1);
  assert.deepEqual(JSON.parse(await readFile(noGoOutput, "utf8")).failedGates, [
    "recovery.two-second",
  ]);

  const invalidInput = join(root, "invalid-input.json");
  const invalidOutput = join(root, "invalid-output.json");
  await writeFile(invalidInput, JSON.stringify({ invalid: true }));
  assert.equal(await runNodeMemoryGateCli([
    "evaluate", "--input", invalidInput, "--output", invalidOutput,
  ], { io }), 2);
  await assert.rejects(() => readFile(invalidOutput), { code: "ENOENT" });
});
