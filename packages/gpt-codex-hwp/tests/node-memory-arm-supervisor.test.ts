import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runSupervisedArm } from "../benchmarks/node-memory-arm-supervisor.mjs";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(TEST_ROOT, "fixtures", "node-memory-arm-fixture.mjs");

test("supervisor returns the single bounded worker receipt", async () => {
  const receipt = await runSupervisedArm({
    command: process.execPath,
    args: [FIXTURE],
    cwd: TEST_ROOT,
    timeoutMs: 5_000,
    environment: { ARM_FIXTURE_MODE: "ok" },
  });
  assert.deepEqual(receipt, { schemaVersion: 1, status: "ok" });
});

test("supervisor rejects stderr emitted before worker shutdown", async () => {
  await assert.rejects(
    () => runSupervisedArm({
      command: process.execPath,
      args: [FIXTURE],
      cwd: TEST_ROOT,
      timeoutMs: 5_000,
      environment: { ARM_FIXTURE_MODE: "late-stderr" },
    }),
    /ARM_WORKER_STDERR_NONZERO/u,
  );
});

test("supervisor rejects more than one JSON receipt frame", async () => {
  await assert.rejects(
    () => runSupervisedArm({
      command: process.execPath,
      args: [FIXTURE],
      cwd: TEST_ROOT,
      timeoutMs: 5_000,
      environment: { ARM_FIXTURE_MODE: "two-frames" },
    }),
    /ARM_WORKER_RECEIPT_INVALID/u,
  );
});

test("supervisor timeout removes its worker and spawned descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-arm-test-"));
  const statePath = join(root, "state.json");
  try {
    await assert.rejects(
      () => runSupervisedArm({
        command: process.execPath,
        args: [FIXTURE],
        cwd: TEST_ROOT,
        timeoutMs: 1_000,
        environment: {
          ARM_FIXTURE_MODE: "hang-with-child",
          ARM_FIXTURE_STATE: statePath,
        },
      }),
      /ARM_WORKER_TIMEOUT/u,
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(processExists(state.rootPid), false);
    assert.equal(processExists(state.childPid), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function processExists(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
