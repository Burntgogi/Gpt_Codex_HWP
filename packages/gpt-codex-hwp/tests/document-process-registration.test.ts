import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { snapshotRegisteredPosixProcessGroupIdentity } from "../src/workers/document-child-client.js";
import * as registrationProtocol from "../src/workers/document-process-registration.js";
import {
  BENCHMARK_ACK_DESCRIPTOR,
  BENCHMARK_REGISTRATION_DESCRIPTOR,
  closeChildRegistrationDescriptors,
  closeChildRegistrationDescriptorsSync,
  DOCUMENT_START_DESCRIPTOR,
  DOCUMENT_START_FRAME,
  DOCUMENT_REGISTRATION_ENV,
  MAX_REGISTRATION_CHANNEL_BYTES,
  MAX_REGISTRATION_FRAME_BYTES,
  MAX_REGISTERED_DOCUMENT_GROUPS,
  encodeAckFrame,
  encodeRegisterFrame,
  parseAckFrame,
  parseRegisterFrame,
  type AckFrame,
  type RegisterFrame,
} from "../src/workers/document-process-registration.js";
import {
  createRegisteredPosixProcessGroupSupervisor,
  type ProcessTreeTerminationReceipt,
  type RegisteredProcessGroupIdentity,
  type RegisteredProcessGroupSupervisor,
} from "../src/workers/registered-process-supervisor.js";

const FIXTURE_ENTRY = fileURLToPath(new URL(
  "./fixtures/workers/gated-payload-marker.mjs",
  import.meta.url,
));
const START_GATE = fileURLToPath(new URL(
  "../src/workers/document-child-start-gate.ts",
  import.meta.url,
));
const REGISTRATION_RACE_FIXTURE = fileURLToPath(new URL(
  "./fixtures/workers/registration-race-case.mjs",
  import.meta.url,
));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VALID_NONCE = "123e4567-e89b-42d3-a456-426614174000";
const VALID_REGISTER: RegisterFrame = {
  schemaVersion: 1,
  type: "register",
  nonce: VALID_NONCE,
  pid: 123,
  parentPid: 45,
};
const VALID_ACK: AckFrame = {
  schemaVersion: 1,
  type: "ack",
  nonce: VALID_NONCE,
  status: "accepted",
};

type RegistrationCoordinatorState = "open" | "closing" | "sealed" | "failed";

interface ProcessRegistrationCoordinator {
  readonly state: RegistrationCoordinatorState;
  start(): void;
  beginClosing(): Promise<void>;
  seal(): Promise<void>;
  terminateRegisteredGroups(): Promise<ProcessTreeTerminationReceipt>;
}

const createProcessRegistrationCoordinator = (
  registrationProtocol as unknown as Readonly<{
    createProcessRegistrationCoordinator(options: Readonly<{
      casePid: number;
      registrationInput: NodeJS.ReadableStream;
      acknowledgementOutput: NodeJS.WritableStream;
      supervisor: RegisteredProcessGroupSupervisor;
      deadlineAt: number;
      caseExited: Promise<void>;
    }>): ProcessRegistrationCoordinator;
  }>
).createProcessRegistrationCoordinator;

test("registration frames use the fixed descriptor protocol limits", () => {
  assert.equal(DOCUMENT_START_DESCRIPTOR, 7);
  assert.equal(BENCHMARK_REGISTRATION_DESCRIPTOR, 8);
  assert.equal(BENCHMARK_ACK_DESCRIPTOR, 9);
  assert.equal(MAX_REGISTRATION_FRAME_BYTES, 1_024);
  assert.equal(MAX_REGISTRATION_CHANNEL_BYTES, 16 * 1_024);
  assert.equal(MAX_REGISTERED_DOCUMENT_GROUPS, 16);
  assert.equal(DOCUMENT_START_FRAME, "GPT_CODEX_HWP_START_V1\n");
});

test("async child registration close waits for ACK-reader close before registration-writer close", async () => {
  const events: string[] = [];
  const acknowledgementClosed = deferred<void>();
  const closing = closeChildRegistrationDescriptors(async (descriptor) => {
    if (descriptor === BENCHMARK_ACK_DESCRIPTOR) {
      events.push("ack:start");
      await acknowledgementClosed.promise;
      events.push("ack:closed");
      return;
    }
    assert.equal(descriptor, BENCHMARK_REGISTRATION_DESCRIPTOR);
    events.push("registration:closed");
  });

  try {
    await waitFor(() => events.length > 0);
    assert.deepEqual(events, ["ack:start"]);
  } finally {
    acknowledgementClosed.resolve();
    await closing;
  }
  assert.deepEqual(events, ["ack:start", "ack:closed", "registration:closed"]);
});

test("Windows-sync child registration close calls ACK reader before registration writer", () => {
  const descriptors: number[] = [];
  closeChildRegistrationDescriptorsSync((descriptor) => descriptors.push(descriptor));
  assert.deepEqual(descriptors, [
    BENCHMARK_ACK_DESCRIPTOR,
    BENCHMARK_REGISTRATION_DESCRIPTOR,
  ]);
});

test("register frames round-trip one exact newline-terminated schema 1 frame", () => {
  const encoded = encodeRegisterFrame(VALID_REGISTER);
  assert.equal(encoded[encoded.byteLength - 1], 0x0a);
  assert.equal(new TextDecoder().decode(encoded).endsWith("\n\n"), false);
  assert.deepEqual(parseRegisterFrame(encoded), VALID_REGISTER);
  assert.deepEqual(parseRegisterFrame(rawFrame({
    parentPid: 45,
    pid: 123,
    nonce: VALID_NONCE,
    type: "register",
    schemaVersion: 1,
  })), VALID_REGISTER);
});

test("register frames reject missing extra or invalid exact-shape fields", () => {
  const invalid = [
    { ...VALID_REGISTER, extra: true },
    without(VALID_REGISTER, "parentPid"),
    { ...VALID_REGISTER, schemaVersion: 2 },
    { ...VALID_REGISTER, type: "ack" },
    { ...VALID_REGISTER, nonce: VALID_NONCE.toUpperCase() },
    { ...VALID_REGISTER, nonce: "123e4567-e89b-02d3-a456-426614174000" },
    { ...VALID_REGISTER, nonce: "123e4567-e89b-42d3-7456-426614174000" },
    { ...VALID_REGISTER, nonce: "not-a-uuid" },
    { ...VALID_REGISTER, pid: 0 },
    { ...VALID_REGISTER, pid: -1 },
    { ...VALID_REGISTER, pid: 1.5 },
    { ...VALID_REGISTER, pid: Number.MAX_SAFE_INTEGER + 1 },
    { ...VALID_REGISTER, parentPid: 0 },
    { ...VALID_REGISTER, parentPid: -1 },
    { ...VALID_REGISTER, parentPid: 1.5 },
    { ...VALID_REGISTER, parentPid: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of invalid) {
    assert.throws(() => parseRegisterFrame(rawFrame(value)), /invalid register frame/u);
  }
});

test("ack frames round-trip accepted and rejected exact schema 1 frames", () => {
  for (const status of ["accepted", "rejected"] as const) {
    const frame: AckFrame = { ...VALID_ACK, status };
    assert.deepEqual(parseAckFrame(encodeAckFrame(frame)), frame);
  }
});

test("ack frames reject missing extra noncanonical and invalid fields", () => {
  const invalid = [
    { ...VALID_ACK, extra: true },
    without(VALID_ACK, "status"),
    { ...VALID_ACK, schemaVersion: 0 },
    { ...VALID_ACK, type: "register" },
    { ...VALID_ACK, status: "pending" },
    { ...VALID_ACK, nonce: VALID_NONCE.toUpperCase() },
    { ...VALID_ACK, nonce: "123e4567-e89b-12d3-a456-426614174000" },
  ];
  for (const value of invalid) {
    assert.throws(() => parseAckFrame(rawFrame(value)), /invalid ack frame/u);
  }
});

test("registration parsers reject oversized partial trailing and invalid UTF-8 frames", () => {
  const exact = encodeRegisterFrame(VALID_REGISTER);
  for (const value of [
    Buffer.alloc(MAX_REGISTRATION_FRAME_BYTES + 1, 0x61),
    exact.subarray(0, exact.byteLength - 1),
    Buffer.concat([exact, Buffer.from("x")]),
    Buffer.concat([exact, Buffer.from("\n")]),
    Buffer.from([0xff, 0x0a]),
  ]) {
    assert.throws(() => parseRegisterFrame(value), /invalid register frame/u);
  }
  assert.throws(
    () => encodeRegisterFrame({ ...VALID_REGISTER, nonce: "x".repeat(2_000) }),
    /invalid register frame/u,
  );
});

test("registered process registration retains sixteen exact groups and proves only all-groups absence", async () => {
  const casePid = 4_000;
  const roots = Array.from({ length: MAX_REGISTERED_DOCUMENT_GROUPS }, (_, index) =>
    registeredIdentity(5_000 + index, casePid));
  const identities = new Map(roots.map((identity) => [identity.pid, identity]));
  const signals: Array<Readonly<{ processGroupId: number; signal: NodeJS.Signals | 0 }>> = [];
  const supervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async (pid) => identities.get(pid),
    signalGroup: (processGroupId, signal) => {
      signals.push({ processGroupId, signal });
      if (signal === 0) throw errno("ESRCH");
    },
    delay: async () => {},
    terminationGraceMs: 0,
  });

  for (const root of roots) {
    assert.deepEqual(await supervisor.registerRoot(root.pid, casePid), root);
  }
  identities.set(6_000, registeredIdentity(6_000, casePid));
  await assert.rejects(supervisor.registerRoot(6_000, casePid));
  assert.deepEqual(await supervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
  });
  assert.deepEqual(
    signals,
    [
      ...roots.map((root) => ({
        processGroupId: root.processGroupId,
        signal: "SIGTERM" as const,
      })),
      ...roots.map((root) => ({
        processGroupId: root.processGroupId,
        signal: 0 as const,
      })),
    ],
  );
});

test("registered process registration rejects duplicate exact roots while allowing distinct PIDs with equal telemetry identity", async () => {
  const casePid = 4_100;
  const identities = new Map<number, RegisteredProcessGroupIdentity>([
    [5_100, registeredIdentity(5_100, casePid, "shared-stable-identity", 17)],
    [5_101, registeredIdentity(5_101, casePid, "shared-stable-identity", 17)],
  ]);
  const supervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async (pid) => identities.get(pid),
  });

  await supervisor.registerRoot(5_100, casePid);
  await supervisor.registerRoot(5_101, casePid);
  await assert.rejects(supervisor.registerRoot(5_100, casePid));
  await assert.rejects(supervisor.registerRoot(5_101, casePid));
});

test("registered process termination cleans every retained group after a partial failure and retries unverified proof", async () => {
  const casePid = 4_200;
  const roots = [
    registeredIdentity(5_200, casePid),
    registeredIdentity(5_201, casePid),
    registeredIdentity(5_202, casePid),
  ];
  const identities = new Map(roots.map((identity) => [identity.pid, identity]));
  let attempt = 1;
  const events: string[] = [];
  const probes = new Map<number, number>();
  const supervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async (pid) => identities.get(pid),
    signalGroup: (processGroupId, signal) => {
      events.push(`${String(attempt)}:${String(signal)}:${String(processGroupId)}`);
      if (signal !== 0) {
        if (attempt === 1 && processGroupId === roots[1]!.pid && signal === "SIGKILL") {
          throw errno("EPERM");
        }
        return;
      }
      const probe = (probes.get(processGroupId) ?? 0) + 1;
      probes.set(processGroupId, probe);
      if (processGroupId === roots[0]!.pid ||
        processGroupId === roots[2]!.pid && probe === 2 ||
        processGroupId === roots[1]!.pid && attempt === 2) {
        throw errno("ESRCH");
      }
      if (processGroupId === roots[1]!.pid) throw errno("EPERM");
    },
    delay: async () => { events.push(`${String(attempt)}:wait`); },
    terminationGraceMs: 0,
  });
  for (const root of roots) await supervisor.registerRoot(root.pid, casePid);

  assert.deepEqual(await supervisor.terminate(), {
    gone: false,
    proof: "unverified",
    reason: "permission",
  });
  assert.deepEqual(events, [
    "1:SIGTERM:5200", "1:SIGTERM:5201", "1:SIGTERM:5202", "1:wait",
    "1:0:5200", "1:0:5201", "1:0:5202",
    "1:SIGKILL:5201", "1:SIGKILL:5202", "1:wait",
    "1:0:5201", "1:0:5202",
  ]);
  attempt = 2;
  assert.deepEqual(await supervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
  });
  assert.deepEqual(events.slice(-3), ["2:SIGTERM:5201", "2:wait", "2:0:5201"]);
});

test("registered process termination permits normal reparenting after exact identity retention", async () => {
  const casePid = 4_300;
  const root = registeredIdentity(5_300, casePid);
  let observed = root;
  const signals: Array<NodeJS.Signals | 0> = [];
  const supervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async () => observed,
    signalGroup: (_processGroupId, signal) => {
      signals.push(signal);
      if (signal === 0) throw errno("ESRCH");
    },
    delay: async () => {},
    terminationGraceMs: 0,
  });
  await supervisor.registerRoot(root.pid, casePid);
  observed = Object.freeze({ ...root, parentPid: 1 });

  assert.deepEqual(await supervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
  });
  assert.deepEqual(signals, ["SIGTERM", 0]);
});

test("registered process termination never signals a root with drifted stable identity fields", async (t) => {
  const casePid = 4_310;
  const root = registeredIdentity(5_310, casePid, "stable-5310", 53_100);
  for (const [label, changed] of [
    ["process group", { ...root, processGroupId: root.processGroupId + 1 }],
    ["identity", { ...root, identity: `${root.identity}-reused` }],
    ["start order", { ...root, startOrder: root.startOrder + 1 }],
  ] as const) {
    await t.test(label, async () => {
      let observed: RegisteredProcessGroupIdentity = root;
      const signals: Array<NodeJS.Signals | 0> = [];
      const supervisor = createRegisteredPosixProcessGroupSupervisor({
        inspectIdentity: async () => observed,
        signalGroup: (_processGroupId, signal) => { signals.push(signal); },
        delay: async () => {},
        terminationGraceMs: 0,
      });
      await supervisor.registerRoot(root.pid, casePid);
      observed = changed;
      assert.deepEqual(await supervisor.terminate(), {
        gone: false,
        proof: "unverified",
        reason: "identity",
      });
      assert.deepEqual(signals, []);
    });
  }
});

test("registered process authorization rejects parent and stable identity drift between snapshots", async (t) => {
  const casePid = 4_320;
  const root = registeredIdentity(5_320, casePid, "stable-5320", 53_200);
  for (const [label, changed] of [
    ["parent", { ...root, parentPid: 1 }],
    ["process group", { ...root, processGroupId: root.processGroupId + 1 }],
    ["identity", { ...root, identity: `${root.identity}-changed` }],
    ["start order", { ...root, startOrder: root.startOrder + 1 }],
  ] as const) {
    await t.test(label, async () => {
      let reads = 0;
      const supervisor = createRegisteredPosixProcessGroupSupervisor({
        inspectIdentity: async () => ++reads === 1 ? root : changed,
      });
      await assert.rejects(
        supervisor.registerRoot(root.pid, casePid),
        /identity unavailable/u,
      );
    });
  }
});

test("registered process proof is invalidated when registry generation changes during termination", async () => {
  const casePid = 4_400;
  const first = registeredIdentity(5_400, casePid);
  const second = registeredIdentity(5_401, casePid);
  const identities = new Map([[first.pid, first], [second.pid, second]]);
  const delayEntered = deferred<void>();
  const releaseDelay = deferred<void>();
  let delays = 0;
  const supervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async (pid) => identities.get(pid),
    signalGroup: (_processGroupId, signal) => {
      if (signal === 0) throw errno("ESRCH");
    },
    delay: async () => {
      delays += 1;
      if (delays === 1) {
        delayEntered.resolve();
        await releaseDelay.promise;
      }
    },
    terminationGraceMs: 0,
  });
  await supervisor.registerRoot(first.pid, casePid);
  const terminating = supervisor.terminate();
  await delayEntered.promise;
  await supervisor.registerRoot(second.pid, casePid);
  releaseDelay.resolve();

  assert.deepEqual(await terminating, {
    gone: false,
    proof: "unverified",
    reason: "registration",
  });
  assert.deepEqual(await supervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
  });
});

test("registered process proof stays unverified while a reserved registration is pending", async () => {
  const casePid = 4_450;
  const first = registeredIdentity(5_450, casePid);
  const second = registeredIdentity(5_451, casePid);
  const secondInspection = deferred<void>();
  const releaseSecondInspection = deferred<void>();
  const supervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async (pid) => {
      if (pid === second.pid) {
        secondInspection.resolve();
        await releaseSecondInspection.promise;
      }
      return pid === first.pid ? first : second;
    },
    signalGroup: (_processGroupId, signal) => {
      if (signal === 0) throw errno("ESRCH");
    },
    delay: async () => {},
    terminationGraceMs: 0,
  });
  await supervisor.registerRoot(first.pid, casePid);
  const registering = supervisor.registerRoot(second.pid, casePid);
  await secondInspection.promise;

  assert.deepEqual(await supervisor.terminate(), {
    gone: false,
    proof: "unverified",
    reason: "registration",
  });
  releaseSecondInspection.resolve();
  await registering;
  assert.deepEqual(await supervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
  });
});

for (const closingWins of [false, true]) {
  test(`registration coordinator linearizes ${closingWins ? "closing before" : "retain before"} ACK`, async () => {
    const casePid = 6_100 + Number(closingWins);
    const frame = registerFrame(casePid + 100, casePid);
    const identityEntered = deferred<void>();
    const releaseIdentity = deferred<void>();
    const events: string[] = [];
    const supervisor: RegisteredProcessGroupSupervisor = {
      async registerRoot(pid, expectedParentPid) {
        events.push(`identity:${String(expectedParentPid)}`);
        identityEntered.resolve();
        await releaseIdentity.promise;
        events.push("retain");
        return registeredIdentity(pid, casePid);
      },
      async terminate() {
        return { gone: true, proof: "registered-groups-empty" };
      },
    };
    const acknowledgements: AckFrame[] = [];
    const acknowledgementOutput = ackRecorder((acknowledgement, callback) => {
      events.push(`ack:${acknowledgement.status}`);
      acknowledgements.push(acknowledgement);
      callback();
    });
    const registrationInput = new PassThrough();
    const coordinator = createProcessRegistrationCoordinator({
      casePid,
      registrationInput,
      acknowledgementOutput,
      supervisor,
      deadlineAt: performance.now() + 5_000,
      caseExited: Promise.resolve(),
    });
    coordinator.start();

    if (closingWins) {
      await coordinator.beginClosing();
      registrationInput.write(encodeRegisterFrame(frame));
      await identityEntered.promise;
    } else {
      registrationInput.write(encodeRegisterFrame(frame));
      await identityEntered.promise;
    }
    const closing = closingWins ? Promise.resolve() : coordinator.beginClosing();
    releaseIdentity.resolve();
    await waitFor(() => acknowledgements.length === 1);
    registrationInput.end();
    await closing;
    await coordinator.seal();

    assert.equal(coordinator.state, "sealed");
    assert.deepEqual(acknowledgements, [{
      schemaVersion: 1,
      type: "ack",
      nonce: frame.nonce,
      status: closingWins ? "rejected" : "accepted",
    }]);
    assert.ok(events.indexOf("retain") < events.indexOf(`ack:${closingWins ? "rejected" : "accepted"}`));
    assert.equal(events[0], `identity:${closingWins ? "undefined" : String(casePid)}`);
  });
}

test("registration closing reparent retains with no parent constraint and rejects before cleanup", async (t) => {
  await t.test("closing accepts a reparented inherited-channel frame", async () => {
    const casePid = 6_110;
    const frame = registerFrame(6_111, 1);
    const expectedParents: Array<number | undefined> = [];
    const retained: number[] = [];
    let cleanupCalls = 0;
    const acknowledgements: AckFrame[] = [];
    const registrationInput = new PassThrough();
    const coordinator = createProcessRegistrationCoordinator({
      casePid,
      registrationInput,
      acknowledgementOutput: ackRecorder((acknowledgement, callback) => {
        acknowledgements.push(acknowledgement);
        callback();
      }),
      supervisor: {
        async registerRoot(pid, expectedParentPid) {
          expectedParents.push(expectedParentPid);
          retained.push(pid);
          return registeredIdentity(pid, frame.parentPid);
        },
        async terminate() {
          cleanupCalls += 1;
          return { gone: true, proof: "registered-groups-empty" };
        },
      },
      deadlineAt: performance.now() + 5_000,
      caseExited: Promise.resolve(),
    });
    coordinator.start();
    await coordinator.beginClosing();
    registrationInput.write(encodeRegisterFrame(frame));
    await waitFor(() => acknowledgements.length === 1, 250);
    registrationInput.end();
    await coordinator.seal();

    assert.deepEqual(expectedParents, [undefined]);
    assert.deepEqual(retained, [frame.pid]);
    assert.deepEqual(acknowledgements, [{
      schemaVersion: 1,
      type: "ack",
      nonce: frame.nonce,
      status: "rejected",
    }]);
    assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
      gone: true,
      proof: "registered-groups-empty",
    });
    assert.equal(cleanupCalls, 1);
  });

  await t.test("open rejects the same wrong-parent frame without ACK", async () => {
    const casePid = 6_120;
    const frame = registerFrame(6_121, 1);
    let registrationCalls = 0;
    let acknowledgements = 0;
    const registrationInput = new PassThrough();
    const coordinator = createProcessRegistrationCoordinator({
      casePid,
      registrationInput,
      acknowledgementOutput: ackRecorder((_acknowledgement, callback) => {
        acknowledgements += 1;
        callback();
      }),
      supervisor: {
        async registerRoot(pid) {
          registrationCalls += 1;
          return registeredIdentity(pid, frame.parentPid);
        },
        async terminate() {
          return { gone: true, proof: "registered-groups-empty" };
        },
      },
      deadlineAt: performance.now() + 5_000,
      caseExited: Promise.resolve(),
    });
    coordinator.start();
    registrationInput.write(encodeRegisterFrame(frame));
    await waitFor(() => coordinator.state === "failed");
    registrationInput.end();

    assert.equal(registrationCalls, 0);
    assert.equal(acknowledgements, 0);
    assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
      gone: false,
      proof: "unverified",
      reason: "channel",
    });
  });
});

test("registration coordinator linearizes retained groups and waits for serialized ACK callbacks", async () => {
  const casePid = 6_200;
  const first = registerFrame(6_201, casePid);
  const second = registerFrame(6_202, casePid);
  const events: string[] = [];
  const ackReleases = [deferred<void>(), deferred<void>()];
  const supervisor = immediateRegisteredSupervisor(casePid, events);
  const acknowledgementOutput = ackRecorder((acknowledgement, callback) => {
    events.push(`ack:${acknowledgement.nonce}`);
    const index = acknowledgement.nonce === first.nonce ? 0 : 1;
    void ackReleases[index]!.promise.then(() => callback());
  });
  let writeInvocations = 0;
  const originalWrite = acknowledgementOutput.write.bind(acknowledgementOutput);
  acknowledgementOutput.write = ((...arguments_: Parameters<typeof originalWrite>) => {
    writeInvocations += 1;
    return originalWrite(...arguments_);
  }) as typeof acknowledgementOutput.write;
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput,
    supervisor,
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  registrationInput.write(encodeRegisterFrame(first));
  await waitFor(() => events.includes(`ack:${first.nonce}`));
  assert.equal(writeInvocations, 1);
  ackReleases[0]!.resolve();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  registrationInput.write(encodeRegisterFrame(second));
  await waitFor(() => events.includes(`ack:${second.nonce}`));
  const closing = coordinator.beginClosing();
  registrationInput.end();
  const sealing = coordinator.seal();
  let closingSettled = false;
  let sealingSettled = false;
  void closing.then(() => { closingSettled = true; });
  void sealing.then(() => { sealingSettled = true; });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  assert.equal(closingSettled, false);
  assert.equal(sealingSettled, false);
  assert.equal(writeInvocations, 2);
  assert.deepEqual(events, [
    `retain:${first.pid}`,
    `ack:${first.nonce}`,
    `retain:${second.pid}`,
    `ack:${second.nonce}`,
  ]);

  ackReleases[1]!.resolve();
  await closing;
  await sealing;
  assert.deepEqual(events, [
    `retain:${first.pid}`,
    `ack:${first.nonce}`,
    `retain:${second.pid}`,
    `ack:${second.nonce}`,
  ]);
});

test("registration ACK failure retains the group and poisons termination proof", async () => {
  const casePid = 6_300;
  const frame = registerFrame(6_301, casePid);
  const retained: number[] = [];
  const supervisor: RegisteredProcessGroupSupervisor = {
    async registerRoot(pid) {
      retained.push(pid);
      return registeredIdentity(pid, casePid);
    },
    async terminate() {
      return { gone: true, proof: "registered-groups-empty" };
    },
  };
  const acknowledgementOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("injected ACK failure"));
    },
  });
  acknowledgementOutput.on("error", () => {});
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput,
    supervisor,
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  registrationInput.end(encodeRegisterFrame(frame));

  await waitFor(() => coordinator.state === "failed");
  assert.deepEqual(retained, [frame.pid]);
  await assert.rejects(coordinator.beginClosing(), /registration coordinator failed/u);
  await assert.rejects(coordinator.seal());
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: false,
    proof: "unverified",
    reason: "channel",
  });
});

test("registration ACK callback followed by stream error permanently poisons the owner channel", async () => {
  const casePid = 6_310;
  const frame = registerFrame(6_311, casePid);
  let terminateCalls = 0;
  const supervisor: RegisteredProcessGroupSupervisor = {
    async registerRoot(pid) {
      return registeredIdentity(pid, casePid);
    },
    async terminate() {
      terminateCalls += 1;
      return { gone: true, proof: "registered-groups-empty" };
    },
  };
  const acknowledgementOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
      queueMicrotask(() => {
        acknowledgementOutput.emit("error", new Error("injected post-callback ACK error"));
      });
    },
  });
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput,
    supervisor,
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  registrationInput.end(encodeRegisterFrame(frame));

  await waitFor(() => coordinator.state === "failed");
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: false,
    proof: "unverified",
    reason: "channel",
  });
  assert.ok(terminateCalls >= 1);
});

test("registration ACK end error rejects sealing without an uncaught stream error", async () => {
  const casePid = 6_320;
  const acknowledgementOutput = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) { callback(new Error("injected ACK end error")); },
  });
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput,
    supervisor: immediateRegisteredSupervisor(casePid),
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  await coordinator.beginClosing();
  registrationInput.end();

  await assert.rejects(coordinator.seal(), /ACK|registration/u);
  assert.equal(coordinator.state, "failed");
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: false,
    proof: "unverified",
    reason: "channel",
  });
});

test("registration sealing remains pending after ACK finish until the clean close", async () => {
  const casePid = 6_321;
  const acknowledgementOutput = new Writable({
    autoDestroy: false,
    write(_chunk, _encoding, callback) { callback(); },
  });
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput,
    supervisor: immediateRegisteredSupervisor(casePid),
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  await coordinator.beginClosing();
  registrationInput.end();

  let sealingSettled = false;
  const sealing = coordinator.seal().finally(() => { sealingSettled = true; });
  await once(acknowledgementOutput, "finish");
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(sealingSettled, false);
  assert.equal(coordinator.state, "closing");

  acknowledgementOutput.destroy();
  await sealing;
  assert.equal(coordinator.state, "sealed");
});

test("registration ACK error after finish but before close rejects sealing and poisons proof", async () => {
  const casePid = 6_322;
  const acknowledgementOutput = new Writable({
    autoDestroy: false,
    write(_chunk, _encoding, callback) { callback(); },
  });
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput,
    supervisor: immediateRegisteredSupervisor(casePid),
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  await coordinator.beginClosing();
  registrationInput.end();

  const sealing = coordinator.seal();
  void sealing.catch(() => {});
  await once(acknowledgementOutput, "finish");
  acknowledgementOutput.emit("error", new Error("injected pre-close ACK error"));

  await assert.rejects(sealing, /ACK|registration/u);
  assert.equal(coordinator.state, "failed");
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: false,
    proof: "unverified",
    reason: "channel",
  });
});

test("registration ACK close after deadline cannot resurrect a failed coordinator", async () => {
  const casePid = 6_323;
  const originalSetTimeout = globalThis.setTimeout;
  let triggerDeadline!: () => void;
  globalThis.setTimeout = ((
    callback: (...arguments_: unknown[]) => void,
    _milliseconds?: number,
    ...arguments_: unknown[]
  ) => {
    const handle = originalSetTimeout(() => {}, 60_000);
    triggerDeadline = () => callback(...arguments_);
    return handle;
  }) as typeof setTimeout;

  const acknowledgementOutput = new Writable({
    autoDestroy: false,
    write(_chunk, _encoding, callback) { callback(); },
  });
  const registrationInput = new PassThrough();
  let coordinator: ProcessRegistrationCoordinator;
  try {
    coordinator = createProcessRegistrationCoordinator({
      casePid,
      registrationInput,
      acknowledgementOutput,
      supervisor: immediateRegisteredSupervisor(casePid),
      deadlineAt: performance.now() + 5_000,
      caseExited: Promise.resolve(),
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  coordinator.start();
  await coordinator.beginClosing();
  registrationInput.end();

  const sealing = coordinator.seal();
  void sealing.catch(() => {});
  await once(acknowledgementOutput, "finish");
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  const closed = once(acknowledgementOutput, "close");

  triggerDeadline();
  assert.equal(coordinator.state, "failed");
  await closed;

  await assert.rejects(sealing, /deadline|registration/u);
  assert.equal(coordinator.state, "failed");
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: false,
    proof: "unverified",
    reason: "deadline",
  });
});

test("registration coordinator rejects an already-expired monotonic deadline synchronously", () => {
  assert.throws(() => createProcessRegistrationCoordinator({
    casePid: 6_330,
    registrationInput: new PassThrough(),
    acknowledgementOutput: new PassThrough(),
    supervisor: immediateRegisteredSupervisor(6_330),
    deadlineAt: performance.now(),
    caseExited: Promise.resolve(),
  }), /invalid registration coordinator options/u);
});

test("registration coordinator deadline timer is unrefed", () => {
  const originalSetTimeout = globalThis.setTimeout;
  let deadlineHandle: NodeJS.Timeout | undefined;
  globalThis.setTimeout = ((...arguments_: Parameters<typeof setTimeout>) => {
    const handle = originalSetTimeout(...arguments_);
    deadlineHandle = handle;
    return handle;
  }) as typeof setTimeout;
  const registrationInput = new PassThrough();
  const acknowledgementOutput = new PassThrough();
  try {
    createProcessRegistrationCoordinator({
      casePid: 6_340,
      registrationInput,
      acknowledgementOutput,
      supervisor: immediateRegisteredSupervisor(6_340),
      deadlineAt: performance.now() + 60_000,
      caseExited: Promise.resolve(),
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.notEqual(deadlineHandle, undefined);
  assert.equal(deadlineHandle!.hasRef(), false);
  registrationInput.destroy();
  acknowledgementOutput.destroy();
});

test("registration deadline keeps late identity retention owned and retries authority cleanup", { timeout: 5_000 }, async () => {
  const keepAlive = setInterval(() => {}, 25);
  const casePid = 6_345;
  const frame = registerFrame(6_346, casePid);
  const identityEntered = deferred<void>();
  const releaseIdentity = deferred<void>();
  let retained = false;
  let cleaned = false;
  let acknowledgements = 0;
  let terminateCalls = 0;
  const supervisor: RegisteredProcessGroupSupervisor = {
    async registerRoot(pid) {
      identityEntered.resolve();
      await releaseIdentity.promise;
      retained = true;
      return registeredIdentity(pid, casePid);
    },
    async terminate() {
      terminateCalls += 1;
      if (!retained) {
        return { gone: false, proof: "unverified", reason: "registration" };
      }
      cleaned = true;
      return { gone: true, proof: "registered-groups-empty" };
    },
  };
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput: ackRecorder((_acknowledgement, callback) => {
      acknowledgements += 1;
      callback();
    }),
    supervisor,
    deadlineAt: performance.now() + 75,
    caseExited: Promise.resolve(),
  });
  try {
    coordinator.start();
    registrationInput.write(encodeRegisterFrame(frame));
    await identityEntered.promise;
    const receipt = await coordinator.terminateRegisteredGroups();
    assert.deepEqual(receipt, {
      gone: false,
      proof: "unverified",
      reason: "deadline",
    });
    assert.equal(terminateCalls, 1);
    assert.equal(acknowledgements, 0);

    releaseIdentity.resolve();
    await waitFor(() => cleaned && terminateCalls >= 2);
    assert.equal(coordinator.state, "failed");
    assert.equal(acknowledgements, 0);
    assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
      gone: false,
      proof: "unverified",
      reason: "deadline",
    });
  } finally {
    clearInterval(keepAlive);
    registrationInput.end();
  }
});

test("registration replay reserves the nonce before asynchronous identity retention", async () => {
  const casePid = 6_350;
  const first = registerFrame(6_351, casePid);
  const identityEntered = deferred<void>();
  const releaseIdentity = deferred<void>();
  let registrationCalls = 0;
  const supervisor: RegisteredProcessGroupSupervisor = {
    async registerRoot(pid) {
      registrationCalls += 1;
      identityEntered.resolve();
      await releaseIdentity.promise;
      return registeredIdentity(pid, casePid);
    },
    async terminate() {
      return { gone: true, proof: "registered-groups-empty" };
    },
  };
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput: ackRecorder((_acknowledgement, callback) => callback()),
    supervisor,
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  registrationInput.write(encodeRegisterFrame(first));
  await identityEntered.promise;
  registrationInput.write(encodeRegisterFrame({ ...first, pid: first.pid + 1 }));
  await waitFor(() => coordinator.state === "failed");

  assert.equal(registrationCalls, 1);
  releaseIdentity.resolve();
  registrationInput.end();
});

test("registration overlapping pre-ACK bootstrap poisons the sequential transport without retaining a second group", async () => {
  const casePid = 6_360;
  const first = registerFrame(6_361, casePid);
  const second = registerFrame(6_362, casePid);
  const identityEntered = deferred<void>();
  const releaseIdentity = deferred<void>();
  const retained: number[] = [];
  let registrationCalls = 0;
  const supervisor: RegisteredProcessGroupSupervisor = {
    async registerRoot(pid) {
      registrationCalls += 1;
      identityEntered.resolve();
      await releaseIdentity.promise;
      retained.push(pid);
      return registeredIdentity(pid, casePid);
    },
    async terminate() {
      return { gone: true, proof: "registered-groups-empty" };
    },
  };
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput: ackRecorder((_acknowledgement, callback) => callback()),
    supervisor,
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  registrationInput.write(encodeRegisterFrame(first));
  await identityEntered.promise;
  registrationInput.write(encodeRegisterFrame(second));
  await waitFor(() => coordinator.state === "failed");
  assert.equal(registrationCalls, 1);
  releaseIdentity.resolve();
  registrationInput.end();
  await waitFor(() => retained.length === 1);
  assert.deepEqual(retained, [first.pid]);
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: false,
    proof: "unverified",
    reason: "channel",
  });
});

test("registration strict trailing transport never accepts a frame followed by partial bytes", async (t) => {
  await t.test("same chunk", async () => {
    const casePid = 6_370;
    const frame = registerFrame(6_371, casePid);
    let acknowledgements = 0;
    let registrationCalls = 0;
    const registrationInput = new PassThrough();
    const coordinator = createProcessRegistrationCoordinator({
      casePid,
      registrationInput,
      acknowledgementOutput: ackRecorder((_acknowledgement, callback) => {
        acknowledgements += 1;
        callback();
      }),
      supervisor: {
        async registerRoot(pid) {
          registrationCalls += 1;
          return registeredIdentity(pid, casePid);
        },
        async terminate() {
          return { gone: true, proof: "registered-groups-empty" };
        },
      },
      deadlineAt: performance.now() + 5_000,
      caseExited: Promise.resolve(),
    });
    coordinator.start();
    registrationInput.write(Buffer.concat([
      Buffer.from(encodeRegisterFrame(frame)),
      Buffer.from("{partial"),
    ]));

    await waitFor(() => coordinator.state === "failed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    assert.equal(acknowledgements, 0);
    assert.equal(registrationCalls, 0);
    registrationInput.end();
  });

  await t.test("before ACK while held open", async () => {
    const casePid = 6_380;
    const frame = registerFrame(6_381, casePid);
    const identityEntered = deferred<void>();
    const releaseIdentity = deferred<void>();
    let acknowledgements = 0;
    let retained = false;
    let cleanupCalls = 0;
    const registrationInput = new PassThrough();
    const coordinator = createProcessRegistrationCoordinator({
      casePid,
      registrationInput,
      acknowledgementOutput: ackRecorder((_acknowledgement, callback) => {
        acknowledgements += 1;
        callback();
      }),
      supervisor: {
        async registerRoot(pid) {
          identityEntered.resolve();
          await releaseIdentity.promise;
          retained = true;
          return registeredIdentity(pid, casePid);
        },
        async terminate() {
          cleanupCalls += 1;
          return retained
            ? { gone: true, proof: "registered-groups-empty" }
            : { gone: false, proof: "unverified", reason: "registration" };
        },
      },
      deadlineAt: performance.now() + 5_000,
      caseExited: Promise.resolve(),
    });
    coordinator.start();
    registrationInput.write(encodeRegisterFrame(frame));
    await identityEntered.promise;
    registrationInput.write(Buffer.from("{partial"));

    await waitFor(() => coordinator.state === "failed");
    releaseIdentity.resolve();
    await waitFor(() => retained && cleanupCalls >= 1);
    assert.equal(acknowledgements, 0);
    registrationInput.end();
    assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
      gone: false,
      proof: "unverified",
      reason: "channel",
    });
  });
});

test("registration coordinator fails closed on replay malformed oversized partial and overflow frames", async (t) => {
  const casePid = 6_400;
  const first = registerFrame(6_401, casePid);
  const cases: ReadonlyArray<readonly [string, Buffer]> = [
    ["replayed nonce", Buffer.concat([
      Buffer.from(encodeRegisterFrame(first)),
      Buffer.from(encodeRegisterFrame({ ...first, pid: first.pid + 1 })),
    ])],
    ["malformed JSON", Buffer.from("{bad-json}\n")],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["oversized frame", Buffer.alloc(MAX_REGISTRATION_FRAME_BYTES + 1, 0x61)],
    ["partial frame", Buffer.from(encodeRegisterFrame(first).subarray(0, -1))],
    ["registration overflow", Buffer.concat(Array.from(
      { length: MAX_REGISTERED_DOCUMENT_GROUPS + 1 },
      (_, index) => paddedRegisterFrame(registerFrame(6_500 + index, casePid)),
    ))],
  ];

  for (const [label, bytes] of cases) {
    await t.test(label, async () => {
      const registrationInput = new PassThrough();
      const coordinator = createProcessRegistrationCoordinator({
        casePid,
        registrationInput,
        acknowledgementOutput: ackRecorder((_acknowledgement, callback) => callback()),
        supervisor: immediateRegisteredSupervisor(casePid),
        deadlineAt: performance.now() + 5_000,
        caseExited: Promise.resolve(),
      });
      coordinator.start();
      registrationInput.end(bytes);
      await waitFor(() => coordinator.state === "failed");
      await assert.rejects(coordinator.seal());
      assert.equal(coordinator.state, "failed");
    });
  }
});

test("registration coordinator accepts exact 1024-byte frames sixteen groups and 16KiB channel", async () => {
  const casePid = 6_600;
  let acknowledgements = 0;
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput: ackRecorder((_acknowledgement, callback) => {
      acknowledgements += 1;
      callback();
    }),
    supervisor: immediateRegisteredSupervisor(casePid),
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  for (let index = 0; index < MAX_REGISTERED_DOCUMENT_GROUPS; index += 1) {
    registrationInput.write(paddedRegisterFrame(registerFrame(6_800 + index, casePid)));
    await waitFor(() => acknowledgements === index + 1);
  }
  await coordinator.beginClosing();
  registrationInput.end();
  await coordinator.seal();
  assert.equal(acknowledgements, MAX_REGISTERED_DOCUMENT_GROUPS);
  assert.equal(coordinator.state, "sealed");
});

test("registration coordinator rejects a seventeenth minimal sequential group below the byte cap", async () => {
  const casePid = 6_610;
  let acknowledgements = 0;
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput: ackRecorder((_acknowledgement, callback) => {
      acknowledgements += 1;
      callback();
    }),
    supervisor: immediateRegisteredSupervisor(casePid),
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  for (let index = 0; index < MAX_REGISTERED_DOCUMENT_GROUPS; index += 1) {
    registrationInput.write(encodeRegisterFrame(registerFrame(6_900 + index, casePid)));
    await waitFor(() => acknowledgements === index + 1);
  }
  registrationInput.write(encodeRegisterFrame(registerFrame(7_000, casePid)));
  await waitFor(() => coordinator.state === "failed");
  registrationInput.end();
  await assert.rejects(coordinator.seal());
  assert.equal(acknowledgements, MAX_REGISTERED_DOCUMENT_GROUPS);
});

test("registration coordinator rejects the first byte beyond the exact 16KiB channel cap", async () => {
  const casePid = 6_620;
  let acknowledgements = 0;
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput: ackRecorder((_acknowledgement, callback) => {
      acknowledgements += 1;
      callback();
    }),
    supervisor: immediateRegisteredSupervisor(casePid),
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  for (let index = 0; index < MAX_REGISTERED_DOCUMENT_GROUPS; index += 1) {
    registrationInput.write(paddedRegisterFrame(registerFrame(7_100 + index, casePid)));
    await waitFor(() => acknowledgements === index + 1);
  }
  registrationInput.write(Buffer.from(" "));
  await waitFor(() => coordinator.state === "failed");
  registrationInput.end();
  assert.equal(acknowledgements, MAX_REGISTERED_DOCUMENT_GROUPS);
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: false,
    proof: "unverified",
    reason: "channel",
  });
});

test("document child gate blocks payload until exact START and preserves entry arguments", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-start-gate-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = join(temporaryRoot, "marker.json");
  const payloadArgument = `payload-${randomUUID()}`;
  const child = spawnGatedFixture(markerPath, payloadArgument);
  t.after(() => terminate(child));
  await assertFileMissing(markerPath, 200);
  await sendStart(child, DOCUMENT_START_FRAME);
  await waitForFile(markerPath);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), [
    FIXTURE_ENTRY,
    markerPath,
    payloadArgument,
  ]);

  closeStartChannel(child);
  const result = await waitForClose(child);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("document child gate accepts representative split START writes on the same fd 7 pipe", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-start-gate-split-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const cases = [
    ["prefix", [DOCUMENT_START_FRAME.slice(0, 1), DOCUMENT_START_FRAME.slice(1)]],
    ["newline", [DOCUMENT_START_FRAME.slice(0, 7), DOCUMENT_START_FRAME.slice(7, -1), "\n"]],
  ] as const;

  for (const [label, chunks] of cases) {
    const markerPath = join(temporaryRoot, `${label}.json`);
    const child = spawnGatedFixture(markerPath, label);
    t.after(() => terminate(child));
    const startWriter = child.stdio[DOCUMENT_START_DESCRIPTOR] as Writable | null;
    assert.notEqual(startWriter, null, label);

    await sendStartChunks(startWriter!, chunks);
    await waitForFile(markerPath);
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), [
      FIXTURE_ENTRY,
      markerPath,
      label,
    ]);

    closeStartChannel(child);
    const result = await waitForClose(child);
    assert.notEqual(result.code, 0, label);
    assert.equal(result.stdout, "", label);
    assert.equal(result.stderr, "", label);
  }
});

test("document child gate exits on an extra post-START byte after payload evaluation", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-start-gate-post-start-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = join(temporaryRoot, "marker.json");
  const child = spawnGatedFixture(markerPath, "post-start-extra-byte");
  t.after(() => terminate(child));
  const startWriter = child.stdio[DOCUMENT_START_DESCRIPTOR] as Writable | null;
  assert.notEqual(startWriter, null);

  await sendStartChunks(startWriter!, [DOCUMENT_START_FRAME]);
  await waitForFile(markerPath);
  await sendStartChunks(startWriter!, [Buffer.from([0x78])]);
  const result = await waitForClose(child);

  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), [
    FIXTURE_ENTRY,
    markerPath,
    "post-start-extra-byte",
  ]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("document child gate rejects EOF partial extended and incorrect START without payload evaluation", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-start-gate-invalid-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const cases = [
    ["eof", Buffer.alloc(0)],
    ["partial", Buffer.from(DOCUMENT_START_FRAME.slice(0, -1))],
    ["extended", Buffer.from(`${DOCUMENT_START_FRAME}x`)],
    ["incorrect", Buffer.from(DOCUMENT_START_FRAME.replace("V1", "V2"))],
  ] as const;

  for (const [label, bytes] of cases) {
    const markerPath = join(temporaryRoot, `${label}.json`);
    const child = spawnGatedFixture(markerPath, label);
    t.after(() => terminate(child));
    await closeStartChannel(child, bytes);
    const result = await waitForClose(child);
    await assert.rejects(access(markerPath), { code: "ENOENT" }, label);
    assert.notEqual(result.code, 0, label);
    assert.equal(result.stdout, "", label);
    assert.equal(result.stderr, "", label);
  }
});

test("document child registration accepts a matching ACK and closes channels before payload", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-accepted-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = join(temporaryRoot, "marker.json");
  const payloadArgument = `registered-${randomUUID()}`;
  const child = spawnGatedFixture(markerPath, payloadArgument, "both");
  t.after(() => terminate(child));
  const registrationOutput = child.stdio[BENCHMARK_REGISTRATION_DESCRIPTOR] as Readable | null;
  assert.notEqual(registrationOutput, null);

  const registration = await receiveRegisterFrame(registrationOutput!);
  assert.deepEqual(registration, {
    schemaVersion: 1,
    type: "register",
    nonce: registration.nonce,
    pid: child.pid,
    parentPid: process.pid,
  });
  await assertFileMissing(markerPath, 100);
  assert.equal(registrationOutput!.readableEnded, false);
  const registrationEof = observeReadableEof(registrationOutput!);
  sendAck(child, {
    schemaVersion: 1,
    type: "ack",
    nonce: registration.nonce,
    status: "accepted",
  });
  await registrationEof;
  assert.equal(registrationOutput!.readableEnded, true);
  assert.equal(child.stdio[BENCHMARK_REGISTRATION_DESCRIPTOR], registrationOutput);
  await assertFileMissing(markerPath, 100);

  await sendStart(child, DOCUMENT_START_FRAME);
  await waitForFile(markerPath);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), [
    FIXTURE_ENTRY,
    markerPath,
    payloadArgument,
  ]);

  closeStartChannel(child);
  const result = await waitForClose(child);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("document child registration remains gated across delayed ACK and START delivery", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-delayed-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = join(temporaryRoot, "marker.json");
  const payloadArgument = `delayed-${randomUUID()}`;
  const child = spawnGatedFixture(markerPath, payloadArgument, "both");
  t.after(() => terminate(child));

  const registrationOutput = child.stdio[BENCHMARK_REGISTRATION_DESCRIPTOR] as Readable | null;
  assert.notEqual(registrationOutput, null);
  const registration = await receiveRegisterFrame(registrationOutput!);
  await assertFileMissing(markerPath, 250);
  sendAck(child, {
    schemaVersion: 1,
    type: "ack",
    nonce: registration.nonce,
    status: "accepted",
  });
  await assertFileMissing(markerPath, 250);

  await sendStart(child, DOCUMENT_START_FRAME);
  await waitForFile(markerPath);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), [
    FIXTURE_ENTRY,
    markerPath,
    payloadArgument,
  ]);

  closeStartChannel(child);
  const result = await waitForClose(child);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("document child registration rejects rejected and wrong-nonce ACKs before payload", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-rejected-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  for (const ackCase of ["rejected", "wrong-nonce"] as const) {
    const markerPath = join(temporaryRoot, `${ackCase}.json`);
    const child = spawnGatedFixture(markerPath, ackCase, "both");
    t.after(() => terminate(child));
    const registrationOutput = child.stdio[BENCHMARK_REGISTRATION_DESCRIPTOR] as Readable | null;
    assert.notEqual(registrationOutput, null, ackCase);
    const registration = await receiveRegisterFrame(registrationOutput!);
    assert.equal(registration.pid, child.pid, ackCase);
    assert.equal(registration.parentPid, process.pid, ackCase);
    sendAck(child, {
      schemaVersion: 1,
      type: "ack",
      nonce: ackCase === "wrong-nonce" ? randomUUID() : registration.nonce,
      status: ackCase === "rejected" ? "rejected" : "accepted",
    });

    const result = await waitForClose(child);
    await assert.rejects(access(markerPath), { code: "ENOENT" }, ackCase);
    assert.notEqual(result.code, 0, ackCase);
    assert.equal(result.stdout, "", ackCase);
    assert.equal(result.stderr, "", ackCase);
  }
});

test("document child registration rejects concatenated ACK frames before payload", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-concatenated-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = join(temporaryRoot, "payload.json");
  const child = spawnGatedFixture(markerPath, "concatenated", "both");
  t.after(() => terminate(child));
  const registrationOutput = child.stdio[BENCHMARK_REGISTRATION_DESCRIPTOR] as Readable | null;
  assert.notEqual(registrationOutput, null);
  const registration = await receiveRegisterFrame(registrationOutput!);
  const acknowledgement = child.stdio[9] as Writable | null;
  assert.notEqual(acknowledgement, null);
  acknowledgement!.end(Buffer.concat([
    Buffer.from(encodeAckFrame({
      schemaVersion: 1,
      type: "ack",
      nonce: registration.nonce,
      status: "accepted",
    })),
    Buffer.from(encodeAckFrame({
      schemaVersion: 1,
      type: "ack",
      nonce: randomUUID(),
      status: "accepted",
    })),
  ]));

  const result = await waitForClose(child);
  await assert.rejects(access(markerPath), { code: "ENOENT" });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("document child registration rejects a one-present descriptor pair", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-mismatch-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = join(temporaryRoot, "marker.json");
  const child = spawnGatedFixture(markerPath, "fd8-only", "registration-only");
  t.after(() => terminate(child));

  const result = await waitForClose(child);
  await assert.rejects(access(markerPath), { code: "ENOENT" });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("registration descriptor ownership produces clean EOF after case and bootstrap exit", { timeout: 15_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-eof-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = join(temporaryRoot, "payload.json");
  const caseChild = spawnRegistrationCase([
    "--descriptor-case",
    markerPath,
    START_GATE,
    REGISTRATION_RACE_FIXTURE,
  ]);
  const caseClose = waitForClose(caseChild);
  const caseExit = caseClose.then(() => {});
  t.after(() => terminate(caseChild));
  assert.ok(caseChild.stdio[5] instanceof Readable);
  assert.ok(caseChild.stdio[6] instanceof Writable);
  const retained: number[] = [];
  const observedParentPids: Array<number | undefined> = [];
  const supervisor: RegisteredProcessGroupSupervisor = {
    async registerRoot(pid, expectedParentPid) {
      observedParentPids.push(expectedParentPid);
      retained.push(pid);
      return registeredIdentity(pid, caseChild.pid!);
    },
    async terminate() {
      return { gone: true, proof: "registered-groups-empty" };
    },
  };
  const coordinator = createProcessRegistrationCoordinator({
    casePid: caseChild.pid!,
    registrationInput: caseChild.stdio[5]!,
    acknowledgementOutput: caseChild.stdio[6]!,
    supervisor,
    deadlineAt: performance.now() + 10_000,
    caseExited: caseExit,
  });
  coordinator.start();

  await waitForFile(markerPath);
  await waitForFile(`${markerPath}.helper`);
  const payload = JSON.parse(await readFile(markerPath, "utf8")) as {
    payloadPid: number;
    helperPid: number;
    registrationDeclared: boolean;
    ipcConnected: boolean;
  };
  const helper = JSON.parse(await readFile(`${markerPath}.helper`, "utf8")) as {
    pid: number;
    registrationDeclared: boolean;
  };
  const closing = coordinator.beginClosing();
  await caseExit;
  const caseResult = await caseClose;
  await closing;
  await coordinator.seal();

  assert.equal(caseResult.code, 0);
  const caseMessage = JSON.parse(caseResult.stdout.trim()) as { bootstrapPid: number };
  assert.deepEqual(observedParentPids, [caseChild.pid]);
  assert.deepEqual(retained, [caseMessage.bootstrapPid]);
  assert.equal(payload.payloadPid, caseMessage.bootstrapPid);
  assert.equal(payload.registrationDeclared, false);
  assert.equal(payload.ipcConnected, false);
  assert.equal(helper.registrationDeclared, false);
  await waitForPidAbsent(payload.payloadPid);
  await waitForPidAbsent(payload.helperPid);
  await waitForPidAbsent(helper.pid);
  assert.equal(coordinator.state, "sealed");
});

test("registration sequential transport completes two real bootstrap ACK handshakes without multiplexing", { timeout: 120_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-sequential-"));
  let diagnosticStage = "CLEANUP_PENDING";
  const enterDiagnosticStage = (stage: string): void => {
    diagnosticStage = stage;
    t.diagnostic(`DOCUMENT_SEQUENTIAL_STAGE_${stage}`);
  };
  t.after(async () => {
    enterDiagnosticStage("CLEANUP_BEGIN");
    await rm(temporaryRoot, { recursive: true, force: true });
    enterDiagnosticStage("CLEANUP_COMPLETE");
  });
  const markerPrefix = join(temporaryRoot, "payload");
  const caseChild = spawnRegistrationCase([
    "--sequential-case",
    markerPrefix,
    START_GATE,
    REGISTRATION_RACE_FIXTURE,
  ]);
  const caseExit = childExitPromise(caseChild);
  t.after(() => {
    enterDiagnosticStage("TERMINATE_BEGIN");
    terminate(caseChild);
    enterDiagnosticStage("TERMINATE_COMPLETE");
  });
  const retained: number[] = [];
  const observedParentPids: Array<number | undefined> = [];
  const supervisor: RegisteredProcessGroupSupervisor = {
    async registerRoot(pid, expectedParentPid) {
      observedParentPids.push(expectedParentPid);
      retained.push(pid);
      return registeredIdentity(pid, caseChild.pid!);
    },
    async terminate() {
      return { gone: true, proof: "registered-groups-empty" };
    },
  };
  const coordinator = createProcessRegistrationCoordinator({
    casePid: caseChild.pid!,
    registrationInput: caseChild.stdio[5]!,
    acknowledgementOutput: caseChild.stdio[6]!,
    supervisor,
    deadlineAt: performance.now() + 15_000,
    caseExited: caseExit,
  });
  coordinator.start();
  try {
    enterDiagnosticStage("CLOSE");
    const result = await waitForClose(caseChild, 30_000);
    enterDiagnosticStage("BEGIN_CLOSING");
    await coordinator.beginClosing();
    enterDiagnosticStage("SEAL");
    await coordinator.seal();
    enterDiagnosticStage("PARSE");
    const { bootstrapPids, closedBootstrapPids } = JSON.parse(result.stdout.trim()) as {
      bootstrapPids: number[];
      closedBootstrapPids: number[];
    };
    enterDiagnosticStage("PARENTS");
    assert.deepEqual(observedParentPids, bootstrapPids.map(() => caseChild.pid));
    enterDiagnosticStage("RETAINED");
    assert.deepEqual(retained, bootstrapPids);
    enterDiagnosticStage("COUNT");
    assert.equal(bootstrapPids.length, 2);
    for (let index = 0; index < 2; index += 1) {
      enterDiagnosticStage(index === 0 ? "READ_0" : "READ_1");
      const payload = JSON.parse(await readFile(`${markerPrefix}-${index}.json`, "utf8")) as {
        payloadPid: number;
      };
      enterDiagnosticStage(index === 0 ? "PID_0" : "PID_1");
      assert.equal(payload.payloadPid, bootstrapPids[index]);
      enterDiagnosticStage(index === 0 ? "CLOSED_0" : "CLOSED_1");
      assert.equal(closedBootstrapPids[index], payload.payloadPid);
    }
    enterDiagnosticStage("BODY_COMPLETE");
  } catch {
    throw new Error(`DOCUMENT_SEQUENTIAL_${diagnosticStage}`);
  }
});

test("registration overlapping real bootstraps fail before either payload and leave both PIDs absent", { timeout: 20_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-overlap-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPrefix = join(temporaryRoot, "payload");
  const identityBarrierPath = join(temporaryRoot, "identity-entered");
  const caseChild = spawnRegistrationCase([
    "--overlap-case",
    markerPrefix,
    identityBarrierPath,
    START_GATE,
    REGISTRATION_RACE_FIXTURE,
  ]);
  const caseExit = childExitPromise(caseChild);
  t.after(() => terminate(caseChild));
  const releaseIdentity = deferred<void>();
  let registrations = 0;
  const coordinator = createProcessRegistrationCoordinator({
    casePid: caseChild.pid!,
    registrationInput: caseChild.stdio[5]!,
    acknowledgementOutput: caseChild.stdio[6]!,
    supervisor: {
      async registerRoot(pid) {
        registrations += 1;
        await writeFile(identityBarrierPath, "entered", "utf8");
        await releaseIdentity.promise;
        return registeredIdentity(pid, caseChild.pid!);
      },
      async terminate() {
        return { gone: true, proof: "registered-groups-empty" };
      },
    },
    deadlineAt: performance.now() + 15_000,
    caseExited: caseExit,
  });
  coordinator.start();
  const { bootstrapPids } = await readJsonLine<{ bootstrapPids: number[] }>(caseChild.stdout!);
  await waitFor(() => coordinator.state === "failed");
  assert.equal(registrations, 1);
  releaseIdentity.resolve();
  await waitForClose(caseChild);

  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(access(`${markerPrefix}-${index}.json`), { code: "ENOENT" });
  }
  assert.equal(bootstrapPids.length, 2);
  for (const pid of bootstrapPids) await waitForPidAbsent(pid);
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: false,
    proof: "unverified",
    reason: "channel",
  });
});

test("registration stale prior ACK never dispatches the next bootstrap payload", { timeout: 20_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-stale-ack-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const payloadMarkerPath = join(temporaryRoot, "payload.txt");
  const firstAckBarrierPath = join(temporaryRoot, "first-ack-enqueued");
  const caseChild = spawnRegistrationCase([
    "--stale-ack-case",
    payloadMarkerPath,
    firstAckBarrierPath,
    START_GATE,
    REGISTRATION_RACE_FIXTURE,
  ]);
  const caseExit = childExitPromise(caseChild);
  t.after(() => terminate(caseChild));
  const retained: number[] = [];
  const acknowledgementChannel = caseChild.stdio[6]!;
  acknowledgementChannel.on("error", () => {});
  let firstAckEnqueued = false;
  const acknowledgementOutput = new Writable({
    write(chunk, _encoding, callback) {
      acknowledgementChannel.write(chunk, (error) => {
        if (error !== null && error !== undefined) {
          callback(error);
          return;
        }
        if (firstAckEnqueued) {
          callback();
          return;
        }
        firstAckEnqueued = true;
        callback();
        // The coordinator's writeAcknowledgement continuation and finally run as
        // microtasks before this check-phase barrier becomes visible to the fixture.
        setImmediate(() => {
          void writeFile(firstAckBarrierPath, "enqueued", "utf8").catch(
            (writeError: unknown) => acknowledgementOutput.destroy(
              writeError instanceof Error ? writeError : new Error("ACK barrier write failed"),
            ),
          );
        });
      });
    },
    final(callback) {
      if (acknowledgementChannel.destroyed || acknowledgementChannel.writableEnded) {
        callback();
      } else {
        acknowledgementChannel.end(callback);
      }
    },
  });
  acknowledgementOutput.on("error", () => {});
  const coordinator = createProcessRegistrationCoordinator({
    casePid: caseChild.pid!,
    registrationInput: caseChild.stdio[5]!,
    acknowledgementOutput,
    supervisor: {
      async registerRoot(pid) {
        retained.push(pid);
        return registeredIdentity(pid, caseChild.pid!);
      },
      async terminate() {
        return { gone: true, proof: "registered-groups-empty" };
      },
    },
    deadlineAt: performance.now() + 15_000,
    caseExited: caseExit,
  });
  coordinator.start();
  const result = await waitForClose(caseChild);
  await coordinator.beginClosing();
  await coordinator.seal();

  const pids = JSON.parse(result.stdout.trim()) as { firstPid: number; secondPid: number };
  assert.deepEqual(retained, [pids.firstPid, pids.secondPid]);
  await assert.rejects(access(payloadMarkerPath), { code: "ENOENT" });
  await waitForPidAbsent(pids.firstPid);
  await waitForPidAbsent(pids.secondPid);
});

test("registration clean EOF does not seal before the exact case exit", async () => {
  const casePid = 6_700;
  const caseExit = deferred<void>();
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput: ackRecorder((_acknowledgement, callback) => callback()),
    supervisor: immediateRegisteredSupervisor(casePid),
    deadlineAt: performance.now() + 5_000,
    caseExited: caseExit.promise,
  });
  coordinator.start();
  await coordinator.beginClosing();
  registrationInput.end();
  let sealed = false;
  const sealing = coordinator.seal().then(() => { sealed = true; });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  assert.equal(sealed, false);
  caseExit.resolve();
  await sealing;
  assert.equal(coordinator.state, "sealed");
});

test("registration channel close without readable end poisons clean EOF proof", async () => {
  const casePid = 6_701;
  const registrationInput = new PassThrough();
  const coordinator = createProcessRegistrationCoordinator({
    casePid,
    registrationInput,
    acknowledgementOutput: ackRecorder((_acknowledgement, callback) => callback()),
    supervisor: immediateRegisteredSupervisor(casePid),
    deadlineAt: performance.now() + 5_000,
    caseExited: Promise.resolve(),
  });
  coordinator.start();
  await coordinator.beginClosing();
  registrationInput.destroy();
  await waitFor(() => coordinator.state === "failed");
  await assert.rejects(coordinator.seal());
});

test("registration clean EOF remains pending while an unused inherited write duplicate is leaked", { timeout: 15_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("requires POSIX descriptor inheritance and process-group cleanup");
    return;
  }
  const caseChild = spawnRegistrationCase(["--leak-case"]);
  const caseExit = childExitPromise(caseChild);
  t.after(() => terminate(caseChild));
  const coordinator = createProcessRegistrationCoordinator({
    casePid: caseChild.pid!,
    registrationInput: caseChild.stdio[5]!,
    acknowledgementOutput: caseChild.stdio[6]!,
    supervisor: immediateRegisteredSupervisor(caseChild.pid!),
    deadlineAt: performance.now() + 10_000,
    caseExited: caseExit,
  });
  coordinator.start();
  await coordinator.beginClosing();
  const { holderPid } = await readJsonLine<{ holderPid: number }>(caseChild.stdout!);
  t.after(() => killPid(holderPid));

  let sealed = false;
  const sealing = coordinator.seal().then(() => { sealed = true; });
  let closed = false;
  const closing = waitForClose(caseChild).then((result) => {
    closed = true;
    return result;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  assert.equal(sealed, false);
  assert.equal(closed, false);
  killPid(holderPid);
  const result = await closing;
  await sealing;
  assert.equal(result.code, 0);
  await waitForPidAbsent(holderPid);
  assert.equal(coordinator.state, "sealed");
});

test("post-snapshot registration race rejects a reparented bootstrap before payload and leaves every PID absent", { timeout: 20_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX SIGTERM handler race");
    return;
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-registration-race-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const pidLogPath = join(temporaryRoot, "pids.txt");
  const payloadMarkerPath = join(temporaryRoot, "payload.txt");
  const caseChild = spawnRegistrationCase([
    "--race-case",
    pidLogPath,
    payloadMarkerPath,
    START_GATE,
    REGISTRATION_RACE_FIXTURE,
  ]);
  const caseExit = childExitPromise(caseChild);
  t.after(() => terminate(caseChild));
  const supervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: (pid) => snapshotRegisteredPosixProcessGroupIdentity(
      pid,
      process.platform,
    ),
  });
  const coordinator = createProcessRegistrationCoordinator({
    casePid: caseChild.pid!,
    registrationInput: caseChild.stdio[5]!,
    acknowledgementOutput: caseChild.stdio[6]!,
    supervisor,
    deadlineAt: performance.now() + 15_000,
    caseExited: caseExit,
  });
  coordinator.start();
  await waitForStreamText(caseChild.stdout!, "READY\n");
  await coordinator.beginClosing();
  process.kill(caseChild.pid!, "SIGTERM");
  await waitForClose(caseChild);
  await coordinator.seal();
  assert.deepEqual(await coordinator.terminateRegisteredGroups(), {
    gone: true,
    proof: "registered-groups-empty",
  });
  await assert.rejects(access(payloadMarkerPath), { code: "ENOENT" });
  const pids = (await readFile(pidLogPath, "utf8"))
    .trim().split(/\r?\n/u).map(Number);
  assert.ok(pids.length >= 2);
  for (const pid of pids) await waitForPidAbsent(pid);
});

function rawFrame(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function without(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

type RegistrationMode = "absent" | "both" | "registration-only";
const fixtureCloseReceipts = new WeakMap<ChildProcess, Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>>>();

function observeFixtureClose(child: ChildProcess): void {
  const receipt = new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  void receipt.catch(() => {});
  fixtureCloseReceipts.set(child, receipt);
}

function spawnGatedFixture(
  markerPath: string,
  payloadArgument: string,
  registrationMode: RegistrationMode = "absent",
): ChildProcess {
  const stdio: Array<"ignore" | "pipe"> = [
    "ignore",
    "pipe",
    "pipe",
    "ignore",
    "ignore",
    "ignore",
    "ignore",
    "pipe",
  ];
  if (registrationMode !== "absent") stdio.push("pipe");
  if (registrationMode === "both") stdio.push("pipe");
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    ...(process.platform === "win32"
      ? ["--import", pathToFileURL(START_GATE).href, FIXTURE_ENTRY]
      : [START_GATE, FIXTURE_ENTRY]),
    markerPath,
    payloadArgument,
  ], {
    detached: true,
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      [DOCUMENT_REGISTRATION_ENV]: registrationMode === "absent" ? "0" : "1",
    },
    stdio,
  });
  observeFixtureClose(child);
  return child;
}

function spawnRegistrationCase(arguments_: readonly string[]): ChildProcess {
  const child = spawn(process.execPath, [REGISTRATION_RACE_FIXTURE, ...arguments_], {
    cwd: PACKAGE_ROOT,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe"],
  });
  observeFixtureClose(child);
  return child;
}

async function receiveRegisterFrame(registration: Readable): Promise<RegisterFrame> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let encoded = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("timed out waiting for registration frame"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      registration.removeListener("data", onData);
      registration.removeListener("end", onEnd);
      registration.removeListener("error", onError);
    };
    const fail = (error: unknown): void => {
      cleanup();
      rejectPromise(error);
    };
    const onData = (chunk: Buffer): void => {
      encoded = Buffer.concat([encoded, chunk]);
      if (encoded.byteLength > MAX_REGISTRATION_FRAME_BYTES) {
        fail(new Error("registration frame exceeded its bound"));
        return;
      }
      const newline = encoded.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== encoded.byteLength - 1) {
        fail(new Error("registration frame had trailing data"));
        return;
      }
      try {
        const frame = parseRegisterFrame(encoded);
        cleanup();
        resolvePromise(frame);
      } catch (error: unknown) {
        fail(error);
      }
    };
    const onEnd = (): void => fail(new Error("registration channel ended before a frame"));
    const onError = (error: Error): void => fail(error);
    registration.on("data", onData);
    registration.once("end", onEnd);
    registration.once("error", onError);
  });
}

function observeReadableEof(stream: Readable): Promise<void> {
  if (stream.readableEnded) return Promise.resolve();
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("timed out waiting for registration writer EOF"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const onEnd = (): void => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

async function sendStart(child: ChildProcess, frame: string | Buffer): Promise<void> {
  const writer = child.stdio[7] as Writable | null;
  assert.notEqual(writer, null);
  await sendStartChunks(writer!, [frame]);
}

async function sendStartChunks(
  writer: Writable,
  chunks: readonly (string | Buffer)[],
): Promise<void> {
  for (const chunk of chunks) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      writer.write(chunk, (error?: Error | null) => {
        if (error === undefined || error === null) resolvePromise();
        else rejectPromise(error);
      });
    });
  }
}

async function closeStartChannel(child: ChildProcess, frame?: Buffer): Promise<void> {
  const writer = child.stdio[7] as Writable | null;
  assert.notEqual(writer, null);
  writer!.end(frame);
}

function sendAck(child: ChildProcess, frame: AckFrame): void {
  const acknowledgement = child.stdio[9] as Writable | null;
  assert.notEqual(acknowledgement, null);
  acknowledgement!.end(encodeAckFrame(frame));
}

async function assertFileMissing(path: string, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await assert.rejects(access(path), { code: "ENOENT" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("timed out waiting for gated payload marker");
}

async function waitForStreamText(stream: Readable, expected: string): Promise<void> {
  stream.setEncoding("utf8");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let text = "";
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("timed out waiting for fixture stream text"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const onData = (chunk: string): void => {
      text += chunk;
      if (!text.includes(expected)) return;
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    const onEnd = (): void => {
      cleanup();
      rejectPromise(new Error("fixture stream ended before expected text"));
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

async function readJsonLine<Value>(stream: Readable): Promise<Value> {
  stream.setEncoding("utf8");
  return new Promise<Value>((resolvePromise, rejectPromise) => {
    let text = "";
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("timed out waiting for fixture JSON line"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const onData = (chunk: string): void => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try {
        resolvePromise(JSON.parse(text.slice(0, newline)) as Value);
      } catch (error: unknown) {
        rejectPromise(error);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    const onEnd = (): void => {
      cleanup();
      rejectPromise(new Error("fixture stream ended before JSON line"));
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

async function waitForClose(child: ChildProcess, timeoutMs = 5_000): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("invalid wait-for-close timeout");
  }
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
      stdout,
      stderr,
    };
  }
  const observedClose = fixtureCloseReceipts.get(child);
  return await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      terminate(child);
      rejectPromise(new Error("timed out waiting for gated fixture exit"));
    }, timeoutMs);
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    };
    if (observedClose !== undefined) {
      void observedClose.then(
        (receipt) => settle(receipt.code, receipt.signal),
        (error: unknown) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      );
      return;
    }
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", settle);
  });
}

function childExitPromise(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const observedClose = fixtureCloseReceipts.get(child);
  if (observedClose !== undefined) return observedClose.then(() => undefined);
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", () => resolvePromise());
  });
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid!, "SIGKILL");
  } catch {
    // The detached child may already have exited between the state check and signal.
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForPidAbsent(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`fixture PID ${pid} survived cleanup`);
}

function registeredIdentity(
  pid: number,
  parentPid: number,
  identity = `test-identity:${pid}`,
  startOrder = pid,
): RegisteredProcessGroupIdentity {
  return Object.freeze({
    pid,
    parentPid,
    processGroupId: pid,
    identity,
    startOrder,
  });
}

function registerFrame(pid: number, parentPid: number): RegisterFrame {
  return Object.freeze({
    schemaVersion: 1,
    type: "register",
    nonce: randomUUID(),
    pid,
    parentPid,
  });
}

function paddedRegisterFrame(frame: RegisterFrame): Buffer {
  const encoded = Buffer.from(encodeRegisterFrame(frame));
  return Buffer.concat([
    Buffer.alloc(MAX_REGISTRATION_FRAME_BYTES - encoded.byteLength, 0x20),
    encoded,
  ]);
}

function immediateRegisteredSupervisor(
  expectedParentPid: number,
  events: string[] = [],
): RegisteredProcessGroupSupervisor {
  return {
    async registerRoot(pid, observedExpectedParentPid) {
      if (observedExpectedParentPid !== undefined) {
        assert.equal(observedExpectedParentPid, expectedParentPid);
      }
      events.push(`retain:${pid}`);
      return registeredIdentity(pid, expectedParentPid);
    },
    async terminate() {
      return { gone: true, proof: "registered-groups-empty" };
    },
  };
}

function ackRecorder(
  onWrite: (acknowledgement: AckFrame, callback: (error?: Error | null) => void) => void,
): Writable {
  const output = new Writable({
    write(chunk, _encoding, callback) {
      try {
        onWrite(parseAckFrame(Buffer.from(chunk)), callback);
      } catch (error: unknown) {
        callback(error instanceof Error ? error : new Error("invalid ACK write"));
      }
    },
  });
  output.on("error", () => {});
  return output;
}

function deferred<Value = void>(): Readonly<{
  promise: Promise<Value>;
  resolve(value?: Value): void;
  reject(error: unknown): void;
}> {
  let resolvePromise!: (value: Value | PromiseLike<Value>) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return {
    promise,
    resolve(value) { resolvePromise(value as Value); },
    reject(error) { rejectPromise(error); },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("timed out waiting for registration test condition");
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
