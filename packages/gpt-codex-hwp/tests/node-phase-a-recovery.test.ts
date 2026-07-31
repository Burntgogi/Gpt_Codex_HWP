import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runRecoveryCli, runRecoveryProbe } from "../benchmarks/node-phase-a-recovery.mjs";

test("recovery succeeds only when two-second RSS and identities both recover", async () => {
  const receipt = await runRecoveryProbe({
    operation: async () => undefined,
    preCallSamples: [100, 100, 100, 100],
    postCallSamples: [180, 150, 130, 110, 109],
    postCallIdentityCounts: [1, 1, 1, 0, 0],
  });
  assert.deepEqual(receipt, {
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
  });
});

test("recovery fails when RSS or an identity remains after two seconds", async () => {
  const receipt = await runRecoveryProbe({
    operation: async () => undefined,
    preCallSamples: [100, 100, 100, 100],
    postCallSamples: [180, 150, 130, 121, 120],
    postCallIdentityCounts: [1, 1, 1, 1, 1],
  });
  assert.equal(receipt.recovered, false);
  assert.equal(receipt.deadlineMs, 2_000);
  assert.equal(receipt.recoveryThresholdBytes, 110);
  assert.equal(receipt.finalIdentityCount, 1);
});

test("recovery CLI writes one privacy-safe 100 MiB receipt exclusively", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-recovery-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "recovery.json");
  const receipt = {
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
  const io = { stdout: { write() {} } };

  assert.equal(await runRecoveryCli([
    "--size", "100", "--output", output,
  ], { createReceipt: async () => receipt, io }), 0);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), receipt);
  assert.doesNotMatch(JSON.stringify(receipt), /Users|AppData|sourcePath|pid/iu);
  await assert.rejects(
    () => runRecoveryCli([
      "--size", "100", "--output", output,
    ], { createReceipt: async () => receipt, io }),
    { code: "EEXIST" },
  );
});
