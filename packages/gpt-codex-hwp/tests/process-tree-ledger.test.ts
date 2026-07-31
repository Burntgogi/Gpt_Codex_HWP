import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  observeIdentityLedger,
  selectProcessTreeIdentities,
  snapshotLedgerIdentities,
  snapshotProcessTreeIdentities,
  terminateIdentityLedgerProcesses,
  waitForIdentityLedgerGone,
} from "../benchmarks/process-tree-ledger.mjs";
import {
  assertCleanStderrReceipt,
  observeStderrLifecycle,
} from "../benchmarks/mcp-idle-memory.mjs";

test("cleanup rejects an observed child after its root exits", async () => {
  const ledger = new Map();
  observeIdentityLedger(ledger, [
    { pid: 10, parentPid: 1, startIdentity: "root-1" },
    { pid: 11, parentPid: 10, startIdentity: "child-1" },
  ]);
  const receipt = await waitForIdentityLedgerGone({
    ledger,
    timeoutMs: 10,
    pollIntervalMs: 1,
    snapshot: async () => [{ pid: 11, parentPid: 1, startIdentity: "child-1" }],
  });
  assert.deepEqual(receipt, { observedIdentityCount: 2, remainingIdentityCount: 1 });
});

test("PID reuse with a different start identity is not the observed process", async () => {
  const ledger = new Map([
    ["10:root-1", { pid: 10, parentPid: 1, startIdentity: "root-1" }],
  ]);
  const receipt = await waitForIdentityLedgerGone({
    ledger,
    timeoutMs: 10,
    pollIntervalMs: 1,
    snapshot: async () => [{ pid: 10, parentPid: 1, startIdentity: "root-2" }],
  });
  assert.deepEqual(receipt, { observedIdentityCount: 1, remainingIdentityCount: 0 });
});

test("cleanup terminates only processes whose current start identity is still exact", async () => {
  const ledger = new Map([
    ["10:root-1", { pid: 10, parentPid: 1, startIdentity: "root-1" }],
    ["11:child-1", { pid: 11, parentPid: 10, startIdentity: "child-1" }],
  ]);
  const terminated: number[] = [];
  await terminateIdentityLedgerProcesses({
    ledger,
    snapshot: async () => [
      { pid: 10, parentPid: 1, startIdentity: "root-1" },
      { pid: 11, parentPid: 1, startIdentity: "reused" },
      { pid: 20, parentPid: 1, startIdentity: "unrelated" },
    ],
    terminate: (pid: number) => { terminated.push(pid); },
  });
  assert.deepEqual(terminated, [10]);
  await assert.rejects(
    () => terminateIdentityLedgerProcesses({
      ledger: new Map([["10:wrong", { pid: 10, parentPid: 1, startIdentity: "root-1" }]]),
      snapshot: async () => [],
      terminate: () => {},
    }),
    /PROCESS_LEDGER_INVALID/u,
  );
});

test("identity ledger retains late descendants without exposing them in its receipt", () => {
  const ledger = new Map();
  observeIdentityLedger(ledger, [{ pid: 10, parentPid: 1, startIdentity: "root-1" }]);
  observeIdentityLedger(ledger, [
    { pid: 10, parentPid: 1, startIdentity: "root-1" },
    { pid: 12, parentPid: 10, startIdentity: "late-1" },
  ]);
  assert.equal(ledger.size, 2);
  assert.throws(
    () => observeIdentityLedger(ledger, [{ pid: 0, parentPid: 1, startIdentity: "bad" }]),
    /PROCESS_IDENTITY_INVALID/u,
  );
});

test("process-tree selection retains descendants by exact start identity", () => {
  assert.deepEqual(selectProcessTreeIdentities([10], [
    { pid: 10, parentPid: 1, startIdentity: "root-1" },
    { pid: 11, parentPid: 10, startIdentity: "child-1" },
    { pid: 12, parentPid: 11, startIdentity: "grandchild-1" },
    { pid: 20, parentPid: 1, startIdentity: "unrelated-1" },
  ]), [
    { pid: 10, parentPid: 1, startIdentity: "root-1" },
    { pid: 11, parentPid: 10, startIdentity: "child-1" },
    { pid: 12, parentPid: 11, startIdentity: "grandchild-1" },
  ]);
});

test("Windows process snapshot ignores the system Idle PID zero row", {
  skip: process.platform !== "win32" ? "Windows CIM snapshot only" : false,
}, async () => {
  const identities = await snapshotProcessTreeIdentities([process.pid]);
  assert.equal(identities.some(({ pid }) => pid === process.pid), true);
});

test("Windows process snapshot excludes its transient CIM sampler", {
  skip: process.platform !== "win32" ? "Windows CIM snapshot only" : false,
}, async () => {
  const identities = await snapshotProcessTreeIdentities([process.pid]);
  const ledger = observeIdentityLedger(new Map(), identities);
  const current = await snapshotLedgerIdentities(ledger);
  const currentKeys = new Set(current.map(({ pid, startIdentity }) => `${pid}:${startIdentity}`));
  assert.equal(
    identities.every(({ pid, startIdentity }) => currentKeys.has(`${pid}:${startIdentity}`)),
    true,
  );
});

test("stderr lifecycle includes bytes emitted during close and fails closed", async () => {
  const stream = new PassThrough();
  const lifecycle = observeStderrLifecycle(stream);
  stream.end("late stderr");
  const receipt = await lifecycle.closed;
  assert.deepEqual(receipt, { bytes: 11, closed: true });
  assert.throws(() => assertCleanStderrReceipt(receipt), /BENCHMARK_STDERR_NONZERO/u);
});
