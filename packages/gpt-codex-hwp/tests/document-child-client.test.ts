import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmdir as removeDirectory, unlink as removeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as childClientModule from "../src/workers/document-child-client.js";
import { HeavyChildGate } from "../src/workers/document-execution-policy.js";
import type { SpoolDocumentSnapshot } from "../src/shared/document-snapshot.js";
import {
  createRegisteredPosixProcessGroupSupervisor,
  type ProcessTreeTerminationReceipt,
  type RegisteredProcessGroupIdentity,
  type RegisteredProcessGroupSupervisor,
} from "../src/workers/registered-process-supervisor.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/workers/engine-test-child.mjs", import.meta.url),
);
const startGatePath = fileURLToPath(
  new URL("../dist/workers/document-child-start-gate.js", import.meta.url),
);
const sourceClientPath = fileURLToPath(
  new URL("../src/workers/document-child-client.ts", import.meta.url),
);
const createProductionDocumentChildClient = childClientModule.createDocumentChildClient;
const isIntegrityVerifiedResultSpool = (
  childClientModule as unknown as {
    isIntegrityVerifiedResultSpool(value: unknown): boolean;
  }
).isIntegrityVerifiedResultSpool;
const terminateDocumentProcessTreeByPid = (
  childClientModule as unknown as {
    terminateDocumentProcessTreeByPid(
      pid: number,
      dependencies: Record<string, unknown>,
    ): Promise<boolean>;
  }
).terminateDocumentProcessTreeByPid;
const resolveWindowsSystemExecutable = (
  childClientModule as unknown as {
    resolveWindowsSystemExecutable(
      name: string,
      platform: NodeJS.Platform,
      systemRoot?: string,
    ): string;
  }
).resolveWindowsSystemExecutable;
const validateWindowsAclReceipt = (
  childClientModule as unknown as {
    validateWindowsAclReceipt(
      value: unknown,
      currentSid: string,
    ): boolean;
  }
).validateWindowsAclReceipt;
const createAclHelperEnvironment = (
  childClientModule as unknown as {
    createAclHelperEnvironment(
      path: string,
      sid: string,
      kind: "directory" | "file",
      source: NodeJS.ProcessEnv,
    ): NodeJS.ProcessEnv;
  }
).createAclHelperEnvironment;
const createJobHelperEnvironment = (
  childClientModule as unknown as {
    createJobHelperEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  }
).createJobHelperEnvironment;
const snapshotMacosIdentityTree = (
  childClientModule as unknown as {
    snapshotMacosIdentityTree(
      retained: ReadonlyMap<string, Readonly<{
        pid: number;
        parentPid: number;
        identity: string;
        startOrder: number;
        rssBytes: number;
        depth: number;
      }>>,
      identitySource: (
        pids?: readonly number[],
      ) => Promise<ReadonlyMap<number, Readonly<{
        parentPid: number;
        identity: string;
        startOrder: number;
      }>>>,
    ): Promise<readonly Readonly<{
      pid: number;
      parentPid: number;
      identity: string;
      startOrder: number;
      rssBytes: number;
    }>[]>;
  }
).snapshotMacosIdentityTree;

function createDocumentChildClient(
  dependencies: Record<string, unknown> = {},
) {
  return createProductionDocumentChildClient({
    ...dependencies,
    jobSupervisorFactory: "jobSupervisorFactory" in dependencies
      ? dependencies.jobSupervisorFactory
      : async (child: ReturnType<typeof spawn>) => ({
          terminate: async () => {
            const gone = child.pid === undefined
              ? true
              : await terminateDocumentProcessTreeByPid(child.pid, {});
            return gone
              ? { gone: true as const, proof: "registered-groups-empty" as const }
              : { gone: false as const, proof: "unverified" as const, reason: "termination" as const };
          },
        }),
  } as never);
}

test("document child start gate spawn order and descriptor isolation", async () => {
  const owned = createOwnedFiles();
  const specifications: Array<Readonly<{
    args: readonly string[];
    stdio: unknown;
  }>> = [];
  try {
    for (const benchmarkRegistrationDescriptors of [
      undefined,
      { writeFd: owned.inputFd, ackFd: owned.imageFd },
    ] as const) {
      const client = createProductionDocumentChildClient({
        childEntry: fixturePath,
        childArguments: ["success", "250"],
        startGateEntry: startGatePath,
        ...(benchmarkRegistrationDescriptors === undefined
          ? {}
          : { benchmarkRegistrationDescriptors }),
        spawnFactory: (specification) => {
          specifications.push({
            args: specification.args,
            stdio: specification.options.stdio,
          });
          throw new Error("capture spawn specification");
        },
      } as never);
      await assert.rejects(
        client.run(
          detectRequest(`start-gate-spec-${specifications.length}`),
          spoolSnapshot(owned.inputFd, 3),
        ),
        (error: unknown) => safeCode(error) === "ENGINE_INIT_FAILED",
      );
    }

    assert.equal(specifications.length, 2);
    for (const specification of specifications) {
      assert.deepEqual(specification.args, [
        "--import",
        pathToFileURL(startGatePath).href,
        fixturePath,
        "success",
        "250",
      ]);
      const stdio = specification.stdio as unknown[];
      assert.equal(stdio[7], "pipe");
    }
    assert.equal((specifications[0]!.stdio as unknown[]).length, 8);
    assert.deepEqual(
      (specifications[1]!.stdio as unknown[]).slice(8),
      [owned.inputFd, owned.imageFd],
    );
  } finally {
    owned.cleanup();
  }
});

test("document child start gate waits for supervisor readiness before one START and stdin dispatch", async () => {
  const owned = createOwnedFiles();
  const events: string[] = [];
  let releaseSupervisor!: () => void;
  const supervisorReady = new Promise<void>((resolve) => {
    releaseSupervisor = resolve;
  });
  let spawned: ReturnType<typeof spawn> | undefined;
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      startGateEntry: startGatePath,
      spawnFactory: (specification) => {
        const child = spawn(
          specification.command,
          [...specification.args],
          specification.options,
        );
        spawned = child;
        const startWriter = child.stdio[7];
        if (startWriter === null || startWriter === undefined || !("write" in startWriter)) {
          events.push("gate-missing");
        } else {
          const write = startWriter.write.bind(startWriter);
          startWriter.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
            events.push(`start:${Buffer.from(chunk).toString("utf8")}`);
            return Reflect.apply(write, startWriter, [chunk, ...args]);
          }) as typeof startWriter.write;
        }
        const end = child.stdin!.end.bind(child.stdin);
        child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
          events.push("dispatch");
          return end(...args);
        }) as typeof child.stdin.end;
        return child;
      },
      jobSupervisorFactory: async (child) => {
        events.push("supervisor-pending");
        await supervisorReady;
        events.push("supervisor-ready");
        return {
          terminate: async () => terminateChildWithProof(child, "registered-groups-empty"),
        };
      },
    } as never);
    const pending = client.run(
      detectRequest("start-gate-order"),
      spoolSnapshot(owned.inputFd, 3),
    );
    await waitFor(() => events.includes("supervisor-pending"));
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepEqual(events, ["supervisor-pending"]);

    releaseSupervisor();
    assert.deepEqual(await pending, { format: "unknown" });
    assert.deepEqual(events, [
      "supervisor-pending",
      "supervisor-ready",
      `start:GPT_CODEX_HWP_START_V1\n`,
      "dispatch",
    ]);
  } finally {
    if (spawned !== undefined && spawned.exitCode === null && spawned.signalCode === null) {
      spawned.kill("SIGKILL");
    }
    owned.cleanup();
  }
});

for (const scenario of [
  { label: "abort", deadlineMs: 5_000, waitMs: 1_500, abort: true },
  { label: "deadline", deadlineMs: 2_000, waitMs: 3_500, abort: false },
] as const) {
  test(`document child stalled supervisor readiness yields to ${scenario.label}`, {
    timeout: 10_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), `hwp-stalled-supervisor-${scenario.label}-`));
    const owned = createOwnedFiles();
    const abort = new AbortController();
    let rejectSupervisor!: (error: Error) => void;
    const supervisorReady = new Promise<never>((_resolve, reject) => {
      rejectSupervisor = reject;
    });
    let supervisorEntered = false;
    let spawned: ReturnType<typeof spawn> | undefined;
    let gateClosed = false;
    let startWrites = 0;
    let dispatches = 0;
    try {
      const client = createProductionDocumentChildClient({
        childEntry: fixturePath,
        childArguments: ["success", "250"],
        startGateEntry: startGatePath,
        spoolRoot: root,
        spawnFactory: (specification) => {
          const child = spawn(
            specification.command,
            [...specification.args],
            specification.options,
          );
          spawned = child;
          const startWriter = child.stdio[7];
          assert.ok(startWriter !== null && startWriter !== undefined && "write" in startWriter);
          startWriter.once("close", () => {
            gateClosed = true;
          });
          const write = startWriter.write.bind(startWriter);
          startWriter.write = ((...args: Parameters<typeof startWriter.write>) => {
            startWrites += 1;
            return write(...args);
          }) as typeof startWriter.write;
          const end = child.stdin!.end.bind(child.stdin);
          child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
            dispatches += 1;
            return end(...args);
          }) as typeof child.stdin.end;
          return child;
        },
        treeTerminator: async (child) => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          return true;
        },
        jobSupervisorFactory: async () => {
          supervisorEntered = true;
          return supervisorReady;
        },
      } as never);
      const settled = client.run(
        detectRequest(`stalled-supervisor-${scenario.label}`),
        spoolSnapshot(owned.inputFd, 3),
        { signal: abort.signal, deadlineMs: scenario.deadlineMs },
      ).then(
        () => ({ kind: "value" as const }),
        (error: unknown) => ({ kind: "error" as const, code: safeCode(error) }),
      );
      await waitFor(() => supervisorEntered);
      if (scenario.abort) abort.abort();
      const outcome = await Promise.race([
        settled,
        new Promise<Readonly<{ kind: "stalled" }>>((resolve) => {
          setTimeout(() => resolve({ kind: "stalled" }), scenario.waitMs);
        }),
      ]);
      if (outcome.kind === "stalled") {
        rejectSupervisor(new Error("release stalled supervisor for test cleanup"));
        await settled;
        assert.fail(`stalled supervisor ignored ${scenario.label}`);
      }
      assert.deepEqual(outcome, { kind: "error", code: "ENGINE_TERMINATION_FAILED" });
      assert.equal(startWrites, 0);
      assert.equal(dispatches, 0);
      await waitFor(() => gateClosed);

      rejectSupervisor(new Error("late supervisor rejection"));
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      rejectSupervisor?.(new Error("test cleanup"));
      if (spawned !== undefined && spawned.exitCode === null && spawned.signalCode === null) {
        spawned.kill("SIGKILL");
      }
      owned.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("document child late supervisor proof releases provisional startup retention", {
  timeout: 10_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-late-supervisor-proof-"));
  const owned = createOwnedFiles();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  const abort = new AbortController();
  const gate = new HeavyChildGate();
  let resolveSupervisor!: (supervisor: {
    terminate(): Promise<
      | Readonly<{ gone: true; proof: "registered-groups-empty" }>
      | Readonly<{ gone: false; proof: "unverified"; reason: "identity" }>
    >;
  }) => void;
  const supervisorReady = new Promise<Parameters<typeof resolveSupervisor>[0]>((resolve) => {
    resolveSupervisor = resolve;
  });
  let supervisorEntered = false;
  let allowProof = false;
  let terminationCalls = 0;
  let spawned: ReturnType<typeof spawn> | undefined;
  let dispatches = 0;
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      startGateEntry: startGatePath,
      spoolRoot: root,
      heavyChildGate: gate,
      spawnFactory: (specification) => {
        const child = spawn(
          specification.command,
          [...specification.args],
          specification.options,
        );
        spawned = child;
        const end = child.stdin!.end.bind(child.stdin);
        child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
          dispatches += 1;
          return end(...args);
        }) as typeof child.stdin.end;
        return child;
      },
      treeTerminator: async (child) => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        return true;
      },
      jobSupervisorFactory: async () => {
        supervisorEntered = true;
        return supervisorReady;
      },
    } as never);
    const settled = client.run(
      detectRequest("late-supervisor-proof"),
      snapshot,
      { signal: abort.signal, deadlineMs: 5_000 },
    );
    await waitFor(() => supervisorEntered);
    abort.abort();
    await assert.rejects(
      settled,
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    assert.equal(snapshot.cleanupCalls, 0);
    assert.equal(dispatches, 0);

    resolveSupervisor({
      async terminate() {
        terminationCalls += 1;
        return allowProof
          ? { gone: true as const, proof: "registered-groups-empty" as const }
          : { gone: false as const, proof: "unverified" as const, reason: "identity" as const };
      },
    });
    await waitFor(() => terminationCalls >= 1);
    await new Promise((resolve) => setTimeout(resolve, 125));
    assert.equal(snapshot.cleanupCalls, 0);

    allowProof = true;
    await waitFor(() => snapshot.cleanupCalls === 1);
    await waitFor(() => readdirSync(root).length === 0);
    const release = await gate.acquire(undefined, 500);
    release();
  } finally {
    allowProof = true;
    if (spawned !== undefined && spawned.exitCode === null && spawned.signalCode === null) {
      spawned.kill("SIGKILL");
    }
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    label: "abort",
    deadlineMs: 5_000,
    waitMs: 1_500,
    expectedCode: "REQUEST_CANCELLED",
    abort: true,
  },
  {
    label: "deadline",
    deadlineMs: 2_000,
    waitMs: 3_500,
    expectedCode: "ENGINE_TIMEOUT",
    abort: false,
  },
] as const) {
  test(`document child stalled START callback yields to ${scenario.label}`, {
    timeout: 10_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), `hwp-stalled-start-${scenario.label}-`));
    const owned = createOwnedFiles();
    const abort = new AbortController();
    let spawned: ReturnType<typeof spawn> | undefined;
    let startWriter: ReturnType<typeof spawn>["stdio"][number] | undefined;
    let stalledCallback: ((error?: Error | null) => void) | undefined;
    let startWrites = 0;
    let dispatches = 0;
    let gateClosed = false;
    try {
      const client = createProductionDocumentChildClient({
        childEntry: fixturePath,
        childArguments: ["success", "250"],
        startGateEntry: startGatePath,
        spoolRoot: root,
        spawnFactory: (specification) => {
          const child = spawn(
            specification.command,
            [...specification.args],
            specification.options,
          );
          spawned = child;
          startWriter = child.stdio[7];
          assert.ok(startWriter !== null && startWriter !== undefined && "write" in startWriter);
          startWriter.once("close", () => {
            gateClosed = true;
          });
          startWriter.write = ((
            _chunk: Uint8Array | string,
            callback?: (error?: Error | null) => void,
          ) => {
            startWrites += 1;
            stalledCallback = callback;
            return true;
          }) as typeof startWriter.write;
          const end = child.stdin!.end.bind(child.stdin);
          child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
            dispatches += 1;
            return end(...args);
          }) as typeof child.stdin.end;
          return child;
        },
        jobSupervisorFactory: async (child) => ({
          terminate: async () => terminateChildWithProof(child, "registered-groups-empty"),
        }),
      } as never);
      const settled = client.run(
        detectRequest(`stalled-start-${scenario.label}`),
        spoolSnapshot(owned.inputFd, 3),
        { signal: abort.signal, deadlineMs: scenario.deadlineMs },
      ).then(
        () => ({ kind: "value" as const }),
        (error: unknown) => ({ kind: "error" as const, code: safeCode(error) }),
      );
      await waitFor(() => startWrites === 1);
      if (scenario.abort) abort.abort();
      const outcome = await Promise.race([
        settled,
        new Promise<Readonly<{ kind: "stalled" }>>((resolve) => {
          setTimeout(() => resolve({ kind: "stalled" }), scenario.waitMs);
        }),
      ]);
      if (outcome.kind === "stalled") {
        stalledCallback?.(new Error("release stalled START callback for test cleanup"));
        await settled;
        assert.fail(`stalled START callback ignored ${scenario.label}`);
      }
      assert.deepEqual(outcome, { kind: "error", code: scenario.expectedCode });
      assert.equal(startWrites, 1);
      assert.equal(dispatches, 0);
      await waitFor(() => gateClosed);

      stalledCallback?.(new Error("late START callback failure"));
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      stalledCallback?.(new Error("test cleanup"));
      if (startWriter !== null && startWriter !== undefined && "destroy" in startWriter) {
        startWriter.destroy();
      }
      if (spawned !== undefined && spawned.exitCode === null && spawned.signalCode === null) {
        spawned.kill("SIGKILL");
      }
      owned.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const callbackMode of ["success", "error"] as const) {
  test(`document child start gate retains owner-lifetime error handling after ${callbackMode} callback`, {
    timeout: 10_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), `hwp-gate-owner-error-${callbackMode}-`));
    const owned = createOwnedFiles();
    let listenersAfterCallback = -1;
    let laterErrorEmitted = false;
    let retainedStartWriter: ReturnType<typeof spawn>["stdio"][number] | undefined;
    try {
      const client = createProductionDocumentChildClient({
        childEntry: fixturePath,
        childArguments: ["success", "250"],
        startGateEntry: startGatePath,
        spoolRoot: root,
        spawnFactory: (specification) => {
          const child = spawn(
            specification.command,
            [...specification.args],
            specification.options,
          );
          const startWriter = child.stdio[7];
          assert.ok(startWriter !== null && startWriter !== undefined && "write" in startWriter);
          retainedStartWriter = startWriter;
          const write = startWriter.write.bind(startWriter);
          startWriter.write = ((
            chunk: Uint8Array | string,
            callback?: (error?: Error | null) => void,
          ) => write(chunk, (nativeError?: Error | null) => {
            callback?.(
              callbackMode === "error"
                ? new Error("injected START callback failure")
                : nativeError,
            );
            listenersAfterCallback = startWriter.listenerCount("error");
            if (listenersAfterCallback > 0) {
              laterErrorEmitted = true;
              startWriter.emit("error", new Error("later fd7 pipe failure"));
            }
          })) as typeof startWriter.write;
          return child;
        },
        jobSupervisorFactory: async (child) => ({
          terminate: async () => terminateChildWithProof(child, "registered-groups-empty"),
        }),
      } as never);
      const settled = client.run(
        detectRequest(`gate-owner-error-${callbackMode}`),
        spoolSnapshot(owned.inputFd, 3),
      );
      if (callbackMode === "success") {
        assert.deepEqual(await settled, { format: "unknown" });
      } else {
        await assert.rejects(
          settled,
          (error: unknown) => safeCode(error) === "ENGINE_INIT_FAILED",
        );
      }
      assert.equal(listenersAfterCallback, 1);
      assert.equal(laterErrorEmitted, true);
      await waitFor(() => retainedStartWriter?.listenerCount("error") === 0);
    } finally {
      owned.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("document child start gate rejection closes fd7 without START or payload dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-start-gate-rejection-"));
  const markerPath = join(root, "payload-ran.txt");
  const owned = createOwnedFiles();
  let spawned: ReturnType<typeof spawn> | undefined;
  let startWrites = 0;
  let dispatches = 0;
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["gate-payload-marker", "250", markerPath],
      startGateEntry: startGatePath,
      spoolRoot: root,
      spawnFactory: (specification) => {
        const child = spawn(
          specification.command,
          [...specification.args],
          specification.options,
        );
        spawned = child;
        const startWriter = child.stdio[7];
        if (startWriter !== null && startWriter !== undefined && "write" in startWriter) {
          const write = startWriter.write.bind(startWriter);
          startWriter.write = ((...args: Parameters<typeof startWriter.write>) => {
            startWrites += 1;
            return write(...args);
          }) as typeof startWriter.write;
        }
        const end = child.stdin!.end.bind(child.stdin);
        child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
          dispatches += 1;
          return end(...args);
        }) as typeof child.stdin.end;
        return child;
      },
      treeTerminator: async (child) => {
        child.kill("SIGKILL");
        return true;
      },
      jobSupervisorFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error("registration rejected");
      },
    } as never);
    await assert.rejects(
      client.run(
        detectRequest("start-gate-rejection"),
        spoolSnapshot(owned.inputFd, 3),
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    assert.equal(startWrites, 0);
    assert.equal(dispatches, 0);
    assert.equal(existsSync(markerPath), false);
  } finally {
    if (spawned !== undefined && spawned.exitCode === null && spawned.signalCode === null) {
      spawned.kill("SIGKILL");
    }
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("typed termination receipts accept only recognized proof", async () => {
  for (const [label, firstReceipt, succeeds] of [
    ["windows", { gone: true, proof: "windows-job-empty" }, true],
    ["posix", { gone: true, proof: "registered-groups-empty" }, true],
    ["forged", { gone: true, proof: "taskkill-empty" }, false],
    ["false", { gone: false, proof: "unverified", reason: "identity" }, false],
    ["throw", undefined, false],
  ] as const) {
    const owned = createOwnedFiles();
    let calls = 0;
    try {
      const client = createProductionDocumentChildClient({
        childEntry: fixturePath,
        childArguments: ["success", "250"],
        startGateEntry: startGatePath,
        jobSupervisorFactory: async (child) => ({
          terminate: async () => {
            calls += 1;
            if (calls > 1) {
              return terminateChildWithProof(child, "registered-groups-empty");
            }
            if (firstReceipt === undefined) throw new Error("termination failed");
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            return firstReceipt;
          },
        }),
      } as never);
      const outcome = client.run(
        detectRequest(`typed-termination-${label}`),
        spoolSnapshot(owned.inputFd, 3),
      );
      if (succeeds) {
        assert.deepEqual(await outcome, { format: "unknown" }, label);
      } else {
        await assert.rejects(
          outcome,
          (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
          label,
        );
        await waitFor(() => calls > 1);
      }
    } finally {
      owned.cleanup();
    }
  }
});

test("typed termination registered POSIX authority binds stable group identity before signalling", async () => {
  const identity: RegisteredProcessGroupIdentity = Object.freeze({
    pid: 4242,
    parentPid: 3131,
    processGroupId: 4242,
    identity: "start-9001",
    startOrder: 9001,
  });
  let identityReads = 0;
  const signals: Array<NodeJS.Signals | 0> = [];
  const supervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async () => {
      identityReads += 1;
      return identity;
    },
    signalGroup: (_processGroupId, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") throw errno("ESRCH");
    },
    delay: async () => {},
  });

  assert.deepEqual(await supervisor.registerRoot(4242, 3131), identity);
  assert.equal(identityReads, 2);
  assert.deepEqual(await supervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
  });
  assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL"]);
});

test("typed termination registered POSIX authority rejects wrong leader parent and changed identity", async () => {
  const base: RegisteredProcessGroupIdentity = Object.freeze({
    pid: 5151,
    parentPid: 4141,
    processGroupId: 5151,
    identity: "start-10",
    startOrder: 10,
  });
  for (const [label, identity, expectedParent] of [
    ["leader", { ...base, processGroupId: 9999 }, 4141],
    ["parent", base, 9999],
  ] as const) {
    const supervisor = createRegisteredPosixProcessGroupSupervisor({
      inspectIdentity: async () => identity,
    });
    await assert.rejects(
      supervisor.registerRoot(5151, expectedParent),
      new RegExp(label === "leader" ? "group leader" : "parent identity", "u"),
    );
  }

  let reads = 0;
  let signals = 0;
  const changed = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async () => {
      reads += 1;
      return reads <= 2 ? base : { ...base, identity: "reused", startOrder: 11 };
    },
    signalGroup: () => { signals += 1; },
  });
  await changed.registerRoot(5151, 4141);
  assert.deepEqual(await changed.terminate(), {
    gone: false,
    proof: "unverified",
    reason: "identity",
  });
  assert.equal(signals, 0);
});

test("typed termination registered POSIX authority maps ESRCH EPERM and other errors", async () => {
  const identity: RegisteredProcessGroupIdentity = Object.freeze({
    pid: 6161,
    parentPid: 5151,
    processGroupId: 6161,
    identity: "start-20",
    startOrder: 20,
  });
  for (const [code, expected] of [
    ["ESRCH", { gone: true, proof: "registered-groups-empty" }],
    ["EPERM", { gone: false, proof: "unverified", reason: "permission" }],
    ["EACCES", { gone: false, proof: "unverified", reason: "termination" }],
  ] as const) {
    const supervisor = createRegisteredPosixProcessGroupSupervisor({
      inspectIdentity: async () => identity,
      signalGroup: () => { throw errno(code); },
      delay: async () => {},
    });
    await supervisor.registerRoot(6161, 5151);
    assert.deepEqual(await supervisor.terminate(), expected, code);
  }
});

test("parent lifeline removes a registered detached child group after forced parent exit", {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-parent-lifeline-"));
  const pidLog = join(root, "pids.txt");
  const parentScript = [
    `import { createDocumentChildClient } from ${JSON.stringify(pathToFileURL(sourceClientPath).href)};`,
    `const client = createDocumentChildClient({ childEntry: ${JSON.stringify(fixturePath)}, childArguments: [\"lifeline-hold\", \"250\", ${JSON.stringify(pidLog)}], startGateEntry: ${JSON.stringify(startGatePath)}, spoolRoot: ${JSON.stringify(root)} });`,
    "void client.run({ protocolVersion: 1, requestId: 'parent-lifeline', operation: 'generateHwpx', input: { markdown: '# lifeline' }, options: {} }, undefined, { deadlineMs: 20000 });",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const parent = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    parentScript,
  ], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  let pids: number[] = [];
  try {
    await waitFor(() => {
      if (!existsSync(pidLog)) return false;
      pids = readPidLog(pidLog);
      return pids.length >= 2;
    });
    parent.kill("SIGKILL");
    await waitFor(() => pids.every((pid) => !isPidAlive(pid)), 10_000);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client returns a result, drains logs, and cleans once", async () => {
  const owned = createOwnedFiles();
  try {
    const snapshot = spoolSnapshot(owned.inputFd, 3);
    const result = await createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
    }).run(
      detectRequest("child-success"),
      snapshot,
    );
    assert.deepEqual(result, { format: "unknown" });
    assert.equal(snapshot.cleanupCalls, 1);
  } finally {
    owned.cleanup();
  }
});

test("document child client forwards only validated monotonic progress", async () => {
  const owned = createOwnedFiles();
  try {
    const progress: Array<[number, number]> = [];
    const result = await childClient("progress").run(
      detectRequest("child-progress"),
      spoolSnapshot(owned.inputFd, 3),
      { onProgress: (completed, total) => progress.push([completed, total]) },
    );
    assert.deepEqual(result, { format: "unknown" });
    assert.deepEqual(progress, [[1, 3], [2, 3]]);
  } finally {
    owned.cleanup();
  }
});

test("document child client forwards exact cumulative copy metrics", async () => {
  const owned = createOwnedFiles();
  try {
    const observed: number[] = [];
    const result = await scriptedChildClient([
      { copiedBytes: 0 },
      { copiedBytes: 2 },
      { copiedBytes: 4 },
    ]).run(
      detectRequest("child-metrics-exact"),
      spoolSnapshot(owned.inputFd, 4),
      { onMetrics: (metrics) => observed.push(metrics.copiedBytes) },
    );
    assert.deepEqual(result, { format: "unknown" });
    assert.deepEqual(observed, [0, 2, 4]);
  } finally {
    owned.cleanup();
  }
});

test("document child client rejects decreasing, oversized, and extended copy metrics", async () => {
  for (const [label, metricEvents] of [
    ["decreasing", [
      { copiedBytes: 0 },
      { copiedBytes: 3 },
      { copiedBytes: 2 },
    ]],
    ["oversized", [
      { copiedBytes: 0 },
      { copiedBytes: 5 },
    ]],
    ["extended", [
      { copiedBytes: 0 },
      { copiedBytes: 4, privateValue: "forbidden" },
    ]],
  ] as const) {
    const owned = createOwnedFiles();
    try {
      await assert.rejects(
        scriptedChildClient(metricEvents).run(
          detectRequest(`child-metrics-${label}`),
          spoolSnapshot(owned.inputFd, 4),
        ),
        (error: unknown) => safeCode(error) === "ENGINE_PROTOCOL_ERROR",
      );
    } finally {
      owned.cleanup();
    }
  }
});

test("document child client settles once and ignores late terminal events", async () => {
  const owned = createOwnedFiles();
  try {
    const result = await childClient("late-result").run(
      detectRequest("child-late"),
      spoolSnapshot(owned.inputFd, 3),
    );
    assert.deepEqual(result, { format: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    owned.cleanup();
  }
});

test("document child client removes its sole abort listener on success", async () => {
  const owned = createOwnedFiles();
  const observed = countingSignal();
  try {
    await childClient("success").run(
      detectRequest("child-listener-cleanup"),
      spoolSnapshot(owned.inputFd, 3),
      { signal: observed.signal },
    );
    assert.deepEqual(observed.counts, { added: 1, removed: 1 });
  } finally {
    owned.cleanup();
  }
});

test("document child client maps lifecycle failures and recovers", async () => {
  for (const [mode, code] of [
    ["crash-before-ready", "ENGINE_INIT_FAILED"],
    ["failure-before-ready", "ENGINE_INIT_FAILED"],
    ["crash-after-ready", "ENGINE_CRASH"],
    ["oom", "ENGINE_OOM"],
    ["malformed", "ENGINE_PROTOCOL_ERROR"],
  ] as const) {
    const owned = createOwnedFiles();
    try {
      await assert.rejects(
        childClient(mode).run(
          detectRequest(`child-${mode}`),
          spoolSnapshot(owned.inputFd, 3),
          { deadlineMs: 5_000 },
        ),
        (error: unknown) => safeCode(error) === code &&
          !JSON.stringify(error).includes("AWS_SECRET_ACCESS_KEY"),
        mode,
      );
      assert.deepEqual(
        await childClient("success").run(
          detectRequest(`child-recovery-${mode}`),
          spoolSnapshot(owned.inputFd, 3),
          { deadlineMs: 5_000 },
        ),
        { format: "unknown" },
      );
    } finally {
      owned.cleanup();
    }
  }
});

test("document child client detects a real constrained fatal V8 OOM from stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-fatal-oom-test-"));
  const owned = createOwnedFiles();
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["fatal-oom", "250"],
      spoolRoot: root,
      spawnFactory: (specification) => spawn(
        specification.command,
        ["--max-old-space-size=16", ...specification.args],
        specification.options,
      ),
    });
    await assert.rejects(
      client.run(
        detectRequest("child-real-fatal-oom"),
        spoolSnapshot(owned.inputFd, 3),
        { deadlineMs: 5_000 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_OOM",
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client terminates an ignoring process tree on timeout", async () => {
  const owned = createOwnedFiles();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  let descendantPid: number | undefined;
  try {
    await assert.rejects(
      createProductionDocumentChildClient({
        childEntry: fixturePath,
        childArguments: ["ignore-abort", "250"],
      }).run(
        detectRequest("child-tree-timeout"),
        snapshot,
        {
          // The production deadline includes Windows supervisor startup. Leave
          // bounded startup headroom so this case observes the descendant and
          // specifically exercises post-dispatch tree cleanup on timeout.
          deadlineMs: 3_000,
          onProgress: (completed, total) => {
            if (total === Number.MAX_SAFE_INTEGER) descendantPid = completed;
          },
        },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
    );
    assert.equal(typeof descendantPid, "number");
    assert.equal(snapshot.cleanupCalls, 1);
    await waitUntilProcessIsGone(descendantPid!);
    assert.deepEqual(
      await childClient("success").run(
        detectRequest("child-after-tree-timeout"),
        spoolSnapshot(owned.inputFd, 3),
      ),
      { format: "unknown" },
    );
  } finally {
    owned.cleanup();
  }
});

test("document child client terminates an ignoring process tree on cancellation", async () => {
  const owned = createOwnedFiles();
  const abort = new AbortController();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  let descendantPid: number | undefined;
  try {
    const pending = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["ignore-abort", "250"],
    }).run(
      detectRequest("child-tree-cancel"),
      snapshot,
      {
        signal: abort.signal,
        deadlineMs: 3_000,
        onProgress: (completed, total) => {
          if (total !== Number.MAX_SAFE_INTEGER) return;
          descendantPid = completed;
          abort.abort();
        },
      },
    );
    await assert.rejects(
      pending,
      (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
    );
    assert.equal(typeof descendantPid, "number");
    assert.equal(snapshot.cleanupCalls, 1);
    await waitUntilProcessIsGone(descendantPid!);
  } finally {
    owned.cleanup();
  }
});

test("Windows lifecycle supervisor removes a detached descendant after the engine parent crashes", {
  skip: process.platform !== "win32" ? "Windows Job Objects are Windows-only" : false,
}, async () => {
  const owned = createOwnedFiles();
  let descendantPid: number | undefined;
  let descendantObservedAlive = false;
  const supervisorFrames: string[] = [];
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["descendant-then-crash", "250"],
      treeTerminator: async () => true,
      jobSupervisorFrameObserver: (frame) => supervisorFrames.push(frame),
    });
    await assert.rejects(
      client.run(
        detectRequest("child-descendant-crash"),
        spoolSnapshot(owned.inputFd, 3),
        {
          deadlineMs: 5_000,
          onProgress: (completed, total) => {
            if (total !== Number.MAX_SAFE_INTEGER) return;
            descendantPid = completed;
            try {
              process.kill(completed, 0);
              descendantObservedAlive = true;
            } catch {}
          },
        },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_CRASH",
    );
    assert.match(supervisorFrames[0] ?? "", /^GPT_CODEX_HWP_JOB READY [0-9]+ [12] [0-9]+$/u);
    assert.match(supervisorFrames[1] ?? "", /^GPT_CODEX_HWP_JOB RSS [1-9][0-9]* [1-9][0-9]*$/u);
    assert.match(supervisorFrames[2] ?? "", /^GPT_CODEX_HWP_JOB GONE 0 [12]$/u);
    assert.equal(typeof descendantPid, "number");
    assert.equal(descendantObservedAlive, true);
    await waitUntilProcessIsGone(descendantPid!);
  } finally {
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    owned.cleanup();
  }
});

test("forced Windows tracker retains a vanished intermediate before parent crash", {
  skip: process.platform !== "win32" ? "Windows process tracking is Windows-only" : false,
}, async (context) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-tracker-orphan-chain-"));
  const pidLog = join(root, "pids.txt");
  const owned = createOwnedFiles();
  const supervisorFrames: string[] = [];
  let observedPids: number[] = [];
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["multilevel-orphan-then-crash", "250", pidLog],
      forceWindowsTracker: true,
      jobSupervisorFrameObserver: (frame) => supervisorFrames.push(frame),
    });
    await assert.rejects(
      client.run(
        detectRequest("forced-tracker-orphan-chain"),
        spoolSnapshot(owned.inputFd, 3),
        { deadlineMs: 5_000 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    assert.match(supervisorFrames[0] ?? "", /^GPT_CODEX_HWP_JOB READY [0-9]+ 2 [0-9]+$/u);
    const trackerFrame = supervisorFrames[1] ?? "";
    if (/^GPT_CODEX_HWP_JOB TRACKER [0-9]+ [0-9]+$/u.test(trackerFrame)) {
      assert.ok(Number.parseInt(trackerFrame.split(" ").at(-2)!, 10) < 200, trackerFrame);
      assert.ok(Number.parseInt(trackerFrame.split(" ").at(-1)!, 10) >= 3, trackerFrame);
      assert.match(supervisorFrames[2] ?? "", /^GPT_CODEX_HWP_JOB RSS [1-9][0-9]* [1-9][0-9]*$/u);
      assert.equal(supervisorFrames[3], "GPT_CODEX_HWP_JOB GONE 0 2");
    } else {
      assert.equal(trackerFrame, "GPT_CODEX_HWP_JOB ERROR sampling Access_is_denied");
    }
    context.diagnostic(trackerFrame);
    await new Promise((resolve) => setTimeout(resolve, 250));
    observedPids = readPidLog(pidLog);
    assert.ok(observedPids.length >= 2);
    if (trackerFrame.startsWith("GPT_CODEX_HWP_JOB TRACKER ")) {
      assert.match(readFileSync(pidLog, "utf8"), /^EXIT [0-9]+$/mu);
    }
    for (const pid of observedPids.slice(1)) await waitUntilProcessIsGone(pid);
  } finally {
    for (const pid of observedPids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("forced Windows tracker catches descendants spawned during timeout settlement", {
  skip: process.platform !== "win32" ? "Windows process tracking is Windows-only" : false,
}, async (context) => {
  const root = mkdtempSync(join(tmpdir(), "hwp-tracker-spawn-race-"));
  const pidLog = join(root, "pids.txt");
  const owned = createOwnedFiles();
  const supervisorFrames: string[] = [];
  let observedPids: number[] = [];
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["spawn-race-timeout", "250", pidLog],
      forceWindowsTracker: true,
      jobSupervisorFrameObserver: (frame) => supervisorFrames.push(frame),
    });
    await assert.rejects(
      client.run(
        detectRequest("forced-tracker-spawn-race"),
        spoolSnapshot(owned.inputFd, 3),
        { deadlineMs: 2_500 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    assert.match(supervisorFrames[0] ?? "", /^GPT_CODEX_HWP_JOB READY [0-9]+ 2 [0-9]+$/u);
    const trackerFrame = supervisorFrames[1] ?? "";
    if (/^GPT_CODEX_HWP_JOB TRACKER [0-9]+ [0-9]+$/u.test(trackerFrame)) {
      assert.ok(Number.parseInt(trackerFrame.split(" ").at(-2)!, 10) < 200, trackerFrame);
      assert.ok(Number.parseInt(trackerFrame.split(" ").at(-1)!, 10) >= 10, trackerFrame);
      assert.match(supervisorFrames[2] ?? "", /^GPT_CODEX_HWP_JOB RSS [1-9][0-9]* [1-9][0-9]*$/u);
      assert.equal(supervisorFrames[3], "GPT_CODEX_HWP_JOB GONE 0 2");
    } else {
      assert.equal(trackerFrame, "GPT_CODEX_HWP_JOB ERROR sampling Access_is_denied");
    }
    context.diagnostic(trackerFrame);
    await new Promise((resolve) => setTimeout(resolve, 250));
    observedPids = readPidLog(pidLog);
    assert.ok(observedPids.length >= 1);
    for (const pid of observedPids) await waitUntilProcessIsGone(pid);
  } finally {
    for (const pid of observedPids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows child refuses framed request dispatch when supervision is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-job-unavailable-"));
  const owned = createOwnedFiles();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  let dispatches = 0;
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      spoolRoot: root,
      jobSupervisorFactory: async () => {
        throw new Error("job assignment unavailable");
      },
      spawnFactory: (specification) => {
        const child = spawn(specification.command, [...specification.args], specification.options);
        const end = child.stdin!.end.bind(child.stdin);
        child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
          dispatches += 1;
          return end(...args);
        }) as typeof child.stdin.end;
        return child;
      },
    });
    await assert.rejects(
      client.run(detectRequest("job-unavailable"), snapshot),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    assert.equal(dispatches, 0);
    assert.equal(snapshot.cleanupCalls, 1);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client captures async spawn errors while supervisor readiness is pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-startup-async-error-"));
  const owned = createOwnedFiles();
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["slow", "5000"],
      spoolRoot: root,
      spawnFactory: (specification) => {
        const child = spawn(specification.command, [...specification.args], specification.options);
        setTimeout(() => child.emit("error", new Error("async spawn failure")), 10);
        return child;
      },
      jobSupervisorFactory: async (child) => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return {
          terminate: async () => {
            const gone = child.pid === undefined
              ? true
              : await terminateDocumentProcessTreeByPid(child.pid, {});
            return gone
              ? { gone: true as const, proof: "registered-groups-empty" as const }
              : { gone: false as const, proof: "unverified" as const, reason: "termination" as const };
          },
        };
      },
    });
    await assert.rejects(
      client.run(
        detectRequest("startup-async-error"),
        spoolSnapshot(owned.inputFd, 3),
      ),
      (error: unknown) => safeCode(error) === "ENGINE_INIT_FAILED",
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child start gate prevents payload OOM before supervisor readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-startup-output-oom-"));
  const owned = createOwnedFiles();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["startup-large-oom", "250"],
      spoolRoot: root,
      jobSupervisorFactory: async (child) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return {
          terminate: async () => {
            const gone = child.pid === undefined
              ? true
              : await terminateDocumentProcessTreeByPid(child.pid, {});
            return gone
              ? { gone: true as const, proof: "registered-groups-empty" as const }
              : { gone: false as const, proof: "unverified" as const, reason: "termination" as const };
          },
        };
      },
    });
    await assert.rejects(
      client.run(
        detectRequest("startup-output-oom"),
        snapshot,
        { deadlineMs: 1_000 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    await waitFor(() => snapshot.cleanupCalls === 1 && readdirSync(root).length === 0);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child start gate maps supervisor readiness failure before payload to unverified termination", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-startup-oom-supervisor-failure-"));
  const owned = createOwnedFiles();
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["startup-large-oom", "250"],
      spoolRoot: root,
      jobSupervisorFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw new Error("supervisor readiness failed");
      },
    });
    await assert.rejects(
      client.run(
        detectRequest("startup-oom-supervisor-failure"),
        spoolSnapshot(owned.inputFd, 3),
        { deadlineMs: 2_000 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED" &&
        !JSON.stringify(error).includes("heap out of memory"),
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child start gate keeps supervisor rejection unverified after an earlier abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-supervisor-abort-first-"));
  const owned = createOwnedFiles();
  const abort = new AbortController();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  let dispatches = 0;
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      spoolRoot: root,
      spawnFactory: (specification) => {
        const child = spawn(specification.command, [...specification.args], specification.options);
        const end = child.stdin!.end.bind(child.stdin);
        child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
          dispatches += 1;
          return end(...args);
        }) as typeof child.stdin.end;
        return child;
      },
      jobSupervisorFactory: async () => {
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("supervisor failed after abort");
      },
    });
    await assert.rejects(
      client.run(
        detectRequest("supervisor-abort-first"),
        snapshot,
        { signal: abort.signal, deadlineMs: 5_000 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    assert.equal(dispatches, 0);
    assert.equal(snapshot.cleanupCalls, 0);
    assert.ok(readdirSync(root).length >= 1);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor readiness failure preserves a deadline before a later abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-supervisor-deadline-first-"));
  const owned = createOwnedFiles();
  const abort = new AbortController();
  let dispatches = 0;
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      spoolRoot: root,
      spawnFactory: (specification) => {
        const child = spawn(specification.command, [...specification.args], specification.options);
        const end = child.stdin!.end.bind(child.stdin);
        child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
          dispatches += 1;
          return end(...args);
        }) as typeof child.stdin.end;
        return child;
      },
      jobSupervisorFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        abort.abort();
        throw new Error("supervisor failed after deadline");
      },
    });
    await assert.rejects(
      client.run(
        detectRequest("supervisor-deadline-first"),
        spoolSnapshot(owned.inputFd, 3),
        { signal: abort.signal, deadlineMs: 1 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
    );
    assert.equal(dispatches, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("root exit cannot release ownership before an independent full-tree GONE receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-root-exit-tree-retention-"));
  const owned = createOwnedFiles();
  const gate = new HeavyChildGate();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  let descendantPid: number | undefined;
  let allowGone = false;
  let terminationCalls = 0;
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["descendant-then-crash", "250"],
      heavyChildGate: gate,
      spoolRoot: root,
      jobSupervisorFactory: async () => ({
        terminate: async () => {
          terminationCalls += 1;
          if (!allowGone || descendantPid === undefined) {
            return { gone: false as const, proof: "unverified" as const, reason: "termination" as const };
          }
          try { process.kill(descendantPid, "SIGKILL"); } catch {}
          await waitUntilProcessIsGone(descendantPid);
          return { gone: true as const, proof: "registered-groups-empty" as const };
        },
      }),
    });
    await assert.rejects(
      client.run(
        detectRequest("root-exit-tree-retention"),
        snapshot,
        {
          deadlineMs: 5_000,
          onProgress: (completed, total) => {
            if (total === Number.MAX_SAFE_INTEGER) descendantPid = completed;
          },
        },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    assert.equal(typeof descendantPid, "number");
    assert.ok(terminationCalls >= 1);
    assert.equal(gate.activeCount, 1);
    assert.equal(snapshot.cleanupCalls, 0);
    assert.equal(readdirSync(root).length, 1);

    allowGone = true;
    await waitFor(() => gate.activeCount === 0 && snapshot.cleanupCalls === 1);
    await waitFor(() => readdirSync(root).length === 0);
  } finally {
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client does not mask a failed tree termination as timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-termination-failure-test-"));
  const owned = createOwnedFiles();
  const gate = new HeavyChildGate();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  let spawned: ReturnType<typeof spawn> | undefined;
  let allowGone = false;
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["slow", "5000"],
      heavyChildGate: gate,
      spoolRoot: root,
      spawnFactory: (specification) => {
        spawned = spawn(specification.command, [...specification.args], specification.options);
        return spawned;
      },
      treeTerminator: async () => false,
      jobSupervisorFactory: async () => ({
        terminate: async () => allowGone &&
          (spawned?.pid === undefined || !isPidAlive(spawned.pid))
          ? { gone: true as const, proof: "registered-groups-empty" as const }
          : { gone: false as const, proof: "unverified" as const, reason: "termination" as const },
      }),
    } as never);
    await assert.rejects(
      client.run(
        detectRequest("tree-termination-failure"),
        snapshot,
        { deadlineMs: 1_500 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    assert.equal(gate.activeCount, 1);
    assert.equal(snapshot.cleanupCalls, 0);
    assert.equal(readdirSync(root).length, 1);
    allowGone = true;
    spawned!.kill("SIGKILL");
    await waitFor(() => gate.activeCount === 0 && snapshot.cleanupCalls === 1);
    await waitFor(() => readdirSync(root).length === 0);
  } finally {
    spawned?.kill("SIGKILL");
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX tree termination targets the process group and verifies it is gone", async () => {
  const calls: Array<[number, string | number]> = [];
  let alive = true;
  const gone = await terminateDocumentProcessTreeByPid(4242, {
    platform: "linux",
    kill: (pid: number, signal: string | number) => {
      calls.push([pid, signal]);
      if (signal === "SIGKILL") alive = false;
    },
    isAlive: () => alive,
    delay: async () => {},
  });
  assert.equal(gone, true);
  assert.deepEqual(calls, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);

  const stuck = await terminateDocumentProcessTreeByPid(4343, {
    platform: "linux",
    kill: () => {},
    isAlive: () => true,
    delay: async () => {},
  });
  assert.equal(stuck, false);
});

test("platform supervisors bind exact identities and bound topology sampling in source", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/workers/document-child-client.ts", import.meta.url)),
    "utf8",
  );
  const windows = readFileSync(
    fileURLToPath(new URL("../src/workers/windows-job-supervisor.ps1", import.meta.url)),
    "utf8",
  );
  assert.match(source, /expectedIdentity: child\.identity/u);
  assert.match(source, /statBefore[\s\S]*status[\s\S]*statAfter/u);
  assert.match(source, /Linux VmRSS unavailable/u);
  assert.match(source, /sampleRequested = true/u);
  assert.match(source, /proc_pidinfo\(pid, 3/u);
  assert.match(source, /pbi_start_tvsec/u);
  assert.doesNotMatch(source, /pid=,ppid=,lstart=,rss=/u);
  assert.match(windows, /NtQueryInformationProcess/u);
  assert.match(windows, /RecordFromHandle\(\$process, \$TargetPid\)/u);
  assert.match(windows, /OpenProcess\(0x00101001/u);
  assert.match(windows, /OpenProcess\(0x00101101/u);
  assert.match(windows, /WorkingSetHandle\(\$entry\.Handle\)/u);
  assert.match(windows, /TerminateHandle\(\$entry\.Handle\)/u);
  assert.doesNotMatch(windows, /WorkingSetExact|TerminateExact/u);
  assert.match(windows, /terminationRss = Measure-TrackedWorkingSet/u);
});

test("Linux retained traversal validates actual parentage and bounds work before enqueue", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/workers/document-child-client.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /if \(child\.parentPid !== process\.pid\) continue;/u);
  assert.match(
    source,
    /if \(queued\.size >= MAX_TRACKED_PROCESS_IDENTITIES\)[\s\S]*queued\.add\(key\)/u,
  );
  assert.match(source, /readBoundedProcText\(`/u);
  assert.doesNotMatch(source, /readFile\(`\/proc\/\$\{pid\}\/(?:stat|status)`/u);
  assert.match(source, /await opendir\(`\/proc\/\$\{pid\}\/task`\)/u);
  assert.doesNotMatch(source, /readdir\(`\/proc\/\$\{pid\}\/task`/u);
  assert.doesNotMatch(source, /Promise\.all\(taskDirectories/u);
});

test("macOS topology binds ps between kernel identity snapshots and cleanup is identity-only", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/workers/document-child-client.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /pbi_ppid/u);
  assert.match(source, /"ppid": info\.pbi_ppid/u);
  assert.match(source, /const identitiesBefore = await macosKernelIdentities/u);
  assert.match(source, /const psRecords = await snapshotMacosPsRecords/u);
  assert.match(source, /const identitiesAfter = await macosKernelIdentities/u);
  assert.match(source, /before\.parentPid !== after\.parentPid/u);
  assert.match(source, /psRecord\.parentPid !== before\.parentPid/u);
  assert.match(source, /os\.kill\(pid, 0\)/u);
  assert.match(source, /snapshotMacosIdentityTree/u);
  assert.match(source, /const identitiesBefore = await macosKernelIdentities\(\);/u);
  assert.doesNotMatch(source, /if size == 0:\s*\n\s*if len\(sys\.argv\) > 1:/u);
  assert.match(source, /snapshotPosixIdentity/u);

  const identityTreeStart = source.indexOf("async function snapshotMacosIdentityTree");
  const identityTreeEnd = source.indexOf("async function snapshotLinuxRetainedTree", identityTreeStart);
  assert.ok(identityTreeStart >= 0 && identityTreeEnd > identityTreeStart);
  const identityTree = source.slice(identityTreeStart, identityTreeEnd);
  assert.equal([...identityTree.matchAll(/await identitySource\(\)/gu)].length, 2);
  assert.match(identityTree, /sameMacosKernelIdentity\(before, after\)/u);
  assert.match(identityTree, /childrenByParent/u);
  assert.match(identityTree, /queue\.push\(record\)/u);
  assert.match(identityTree, /pendingCandidates/u);
  assert.match(identityTree, /queriedPids\.add\(candidate\.parent\.pid\)/u);
  assert.match(identityTree, /identitySource\(\[\.\.\.queriedPids\]\)/u);
  assert.match(identityTree, /MAX_MACOS_IDENTITY_STABILIZATION_ROUNDS/u);
  assert.match(identityTree, /MAX_TRACKED_PROCESS_IDENTITIES/u);
  assert.doesNotMatch(identityTree, /snapshotMacosPsRecords|\/bin\/ps/u);
});

test("macOS identity-only cleanup stabilizes an after-only child before returning the root", async () => {
  const rootIdentity = Object.freeze({
    parentPid: 1,
    identity: "10:1",
    startOrder: 10_000_001,
  });
  const childIdentity = Object.freeze({
    parentPid: 100,
    identity: "11:2",
    startOrder: 11_000_002,
  });
  const grandchildIdentity = Object.freeze({
    parentPid: 101,
    identity: "12:3",
    startOrder: 12_000_003,
  });
  const retained = new Map([[
    "100:10:1",
    Object.freeze({
      pid: 100,
      ...rootIdentity,
      rssBytes: 0,
      depth: 0,
    }),
  ]]);
  let fullSnapshot = 0;
  const targetedQueries: number[][] = [];

  const records = await snapshotMacosIdentityTree(retained, async (pids = []) => {
    if (pids.length === 0) {
      fullSnapshot += 1;
      return fullSnapshot === 1
        ? new Map([[100, rootIdentity]])
        : new Map([
            [100, rootIdentity],
            [101, childIdentity],
            [102, grandchildIdentity],
          ]);
    }
    targetedQueries.push([...pids].sort((left, right) => left - right));
    return new Map(
      pids.flatMap((pid) => {
        const identity = new Map([
          [100, rootIdentity],
          [101, childIdentity],
          [102, grandchildIdentity],
        ]).get(pid);
        return identity === undefined ? [] : [[pid, identity] as const];
      }),
    );
  });

  assert.deepEqual(
    records.map((record) => record.pid).sort((left, right) => left - right),
    [100, 101, 102],
  );
  assert.deepEqual(targetedQueries, [[100, 101], [101, 102]]);
});

test("macOS identity-only cleanup rebinds a changed child only after an exact pair requery", async () => {
  const rootIdentity = Object.freeze({
    parentPid: 1,
    identity: "20:1",
    startOrder: 20_000_001,
  });
  const reusedBefore = Object.freeze({
    parentPid: 999,
    identity: "19:9",
    startOrder: 19_000_009,
  });
  const childAfter = Object.freeze({
    parentPid: 200,
    identity: "21:2",
    startOrder: 21_000_002,
  });
  const retained = new Map([[
    "200:20:1",
    Object.freeze({ pid: 200, ...rootIdentity, rssBytes: 0, depth: 0 }),
  ]]);
  let fullSnapshot = 0;
  const targetedQueries: number[][] = [];

  const records = await snapshotMacosIdentityTree(retained, async (pids = []) => {
    if (pids.length === 0) {
      fullSnapshot += 1;
      return fullSnapshot === 1
        ? new Map([[200, rootIdentity], [201, reusedBefore]])
        : new Map([[200, rootIdentity], [201, childAfter]]);
    }
    targetedQueries.push([...pids].sort((left, right) => left - right));
    return new Map([[200, rootIdentity], [201, childAfter]]);
  });

  assert.deepEqual(records.map((record) => record.pid).sort((left, right) => left - right), [200, 201]);
  assert.deepEqual(targetedQueries, [[200, 201]]);
});

test("macOS identity-only cleanup fails closed when a reachable child never stabilizes", async () => {
  const rootIdentity = Object.freeze({
    parentPid: 1,
    identity: "30:1",
    startOrder: 30_000_001,
  });
  const retained = new Map([[
    "300:30:1",
    Object.freeze({ pid: 300, ...rootIdentity, rssBytes: 0, depth: 0 }),
  ]]);
  let fullSnapshot = 0;
  let targetedQueries = 0;

  await assert.rejects(
    snapshotMacosIdentityTree(retained, async (pids = []) => {
      if (pids.length === 0) {
        fullSnapshot += 1;
        return new Map([
          [300, rootIdentity],
          ...(fullSnapshot === 1
            ? []
            : [[301, Object.freeze({
                parentPid: 300,
                identity: "31:1",
                startOrder: 31_000_001,
              })] as const]),
        ]);
      }
      targetedQueries += 1;
      return new Map([
        [300, rootIdentity],
        [301, Object.freeze({
          parentPid: 300,
          identity: `31:${targetedQueries + 1}`,
          startOrder: 31_000_001 + targetedQueries,
        })],
      ]);
    }),
    /macOS child identity stabilization rounds exhausted/u,
  );
  assert.equal(targetedQueries, 4);
});

test("macOS identity-only cleanup requires the accepted parent to remain exact", async () => {
  const rootIdentity = Object.freeze({
    parentPid: 1,
    identity: "33:1",
    startOrder: 33_000_001,
  });
  const childIdentity = Object.freeze({
    parentPid: 330,
    identity: "34:1",
    startOrder: 34_000_001,
  });
  const retained = new Map([[
    "330:33:1",
    Object.freeze({ pid: 330, ...rootIdentity, rssBytes: 0, depth: 0 }),
  ]]);
  let fullSnapshot = 0;

  await assert.rejects(
    snapshotMacosIdentityTree(retained, async (pids = []) => {
      if (pids.length === 0) {
        fullSnapshot += 1;
        return fullSnapshot === 1
          ? new Map([[330, rootIdentity]])
          : new Map([[330, rootIdentity], [331, childIdentity]]);
      }
      return new Map([
        [330, Object.freeze({ ...rootIdentity, parentPid: 2 })],
        [331, childIdentity],
      ]);
    }),
    /accepted macOS parent identity changed during stabilization/u,
  );
});

test("macOS identity-only cleanup fails closed when a new candidate chain exhausts rounds", async () => {
  const rootIdentity = Object.freeze({
    parentPid: 1,
    identity: "35:1",
    startOrder: 35_000_001,
  });
  const identities = new Map<number, Readonly<{
    parentPid: number;
    identity: string;
    startOrder: number;
  }>>([[350, rootIdentity]]);
  for (let offset = 1; offset <= 5; offset += 1) {
    identities.set(350 + offset, Object.freeze({
      parentPid: 349 + offset,
      identity: `${35 + offset}:1`,
      startOrder: (35 + offset) * 1_000_000 + 1,
    }));
  }
  const retained = new Map([[
    "350:35:1",
    Object.freeze({ pid: 350, ...rootIdentity, rssBytes: 0, depth: 0 }),
  ]]);
  let fullSnapshot = 0;
  let targetedQueries = 0;

  await assert.rejects(
    snapshotMacosIdentityTree(retained, async (pids = []) => {
      if (pids.length === 0) {
        fullSnapshot += 1;
        return fullSnapshot === 1
          ? new Map([[350, rootIdentity]])
          : identities;
      }
      targetedQueries += 1;
      return new Map(pids.map((pid) => [pid, identities.get(pid)!] as const));
    }),
    /macOS child identity stabilization rounds exhausted/u,
  );
  assert.equal(targetedQueries, 4);
});

test("macOS identity-only cleanup enforces the 4096-record cap", async () => {
  const rootIdentity = Object.freeze({
    parentPid: 1,
    identity: "40:1",
    startOrder: 40_000_001,
  });
  const retained = new Map([[
    "400:40:1",
    Object.freeze({ pid: 400, ...rootIdentity, rssBytes: 0, depth: 0 }),
  ]]);
  let fullSnapshot = 0;

  await assert.rejects(
    snapshotMacosIdentityTree(retained, async () => {
      fullSnapshot += 1;
      if (fullSnapshot === 1) return new Map([[400, rootIdentity]]);
      return new Map([
        [400, rootIdentity],
        ...Array.from({ length: 4_096 }, (_, index) => {
          const pid = index + 401;
          return [pid, Object.freeze({
            parentPid: 400,
            identity: `41:${index}`,
            startOrder: 41_000_000 + index,
          })] as const;
        }),
      ]);
    }),
    /macOS after snapshot identity limit exceeded/u,
  );
});

type TestPosixTelemetryTracker = Readonly<{
  initialize(): Promise<void>;
  registerRoot?(identity: RegisteredProcessGroupIdentity): void;
  sample(): Promise<void>;
  disableTelemetry(): void;
  telemetryAvailable(): boolean;
  processTreeRss(): Readonly<{ baselineBytes: number; peakBytes: number }>;
}>;

type TestPosixIntervalHandle = Readonly<{ unref(): void }>;

const createPosixProcessTreeSupervisorForTest = (
  childClientModule as unknown as {
    createPosixProcessTreeSupervisorForTest(
      child: ReturnType<typeof spawn>,
      platform: "linux" | "darwin",
      dependencies: Readonly<{
        registeredSupervisor: RegisteredProcessGroupSupervisor;
        tracker: TestPosixTelemetryTracker;
        scheduleInterval: (
          callback: () => void,
          milliseconds: number,
        ) => TestPosixIntervalHandle;
        clearScheduledInterval: (handle: TestPosixIntervalHandle) => void;
        deferProcessTreeTelemetryStop?: boolean;
      }>,
    ): Promise<Readonly<{
      readonly processTreeTelemetryReady?: Promise<boolean>;
      registerProcessTreeTelemetryRoot?(
        identity: RegisteredProcessGroupIdentity,
      ): void;
      finishProcessTreeTelemetry?(): void;
      processTreeRss?(): Readonly<{ baselineBytes: number; peakBytes: number }> | undefined;
      terminate(): Promise<ProcessTreeTerminationReceipt>;
    }>>;
  }
).createPosixProcessTreeSupervisorForTest;

test("POSIX telemetry initialize cannot delay registered readiness or termination", async () => {
  const rootPid = 8_101;
  const signals: Array<NodeJS.Signals | 0> = [];
  const initialize = telemetryDeferred<void>();
  let scheduled = 0;
  const creating = createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryRegisteredSupervisor(rootPid, signals),
      tracker: telemetryTracker({ initialize: () => initialize.promise }),
      scheduleInterval: () => {
        scheduled += 1;
        return { unref() {} };
      },
      clearScheduledInterval: () => {},
    },
  );
  const supervisor = await telemetryBounded(creating);
  if (supervisor === TELEMETRY_STALLED) {
    assert.fail("telemetry initialization delayed registered supervisor readiness");
  }
  assert.equal(supervisor.processTreeRss?.(), undefined);
  assert.equal(
    await telemetryBounded(supervisor.processTreeTelemetryReady as Promise<boolean>, 25),
    TELEMETRY_STALLED,
  );

  const receipt = await telemetryBounded(supervisor.terminate());
  if (receipt === TELEMETRY_STALLED) {
    assert.fail("telemetry initialization delayed registered group termination");
  }
  assert.deepEqual(receipt, { gone: true, proof: "registered-groups-empty" });
  assert.equal(await supervisor.processTreeTelemetryReady, false);
  assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL", 0]);
  assert.equal(scheduled, 0);
  assert.deepEqual(
    await supervisor.terminate(),
    { gone: true, proof: "registered-groups-empty" },
  );
  assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL", 0]);
});

test("POSIX telemetry sample cannot delay registered termination or expose pending RSS", async () => {
  const rootPid = 8_102;
  const signals: Array<NodeJS.Signals | 0> = [];
  const sample = telemetryDeferred<void>();
  const sampleStarted = telemetryDeferred<void>();
  let scheduledCallback: (() => void) | undefined;
  let cleared = 0;
  let telemetryDisabled = false;
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryRegisteredSupervisor(rootPid, signals),
      tracker: telemetryTracker({
        initialize: async () => {},
        sample: () => {
          sampleStarted.resolve();
          return sample.promise;
        },
        disableTelemetry: () => {
          telemetryDisabled = true;
        },
        telemetryAvailable: () => !telemetryDisabled,
      }),
      scheduleInterval: (callback) => {
        scheduledCallback = callback;
        return { unref() {} };
      },
      clearScheduledInterval: () => {
        cleared += 1;
      },
    },
  );
  assert.ok(scheduledCallback !== undefined);
  assert.equal(await supervisor.processTreeTelemetryReady, true);
  scheduledCallback();
  await sampleStarted.promise;

  const termination = supervisor.terminate();
  const receipt = await telemetryBounded(termination);
  if (receipt === TELEMETRY_STALLED) {
    sample.resolve();
    await termination;
    assert.fail("in-flight telemetry sample delayed registered group termination");
  }
  assert.deepEqual(receipt, { gone: true, proof: "registered-groups-empty" });
  assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL", 0]);
  assert.equal(supervisor.processTreeRss?.(), undefined);
  assert.equal(cleared, 1);

  sample.reject(new Error("late telemetry sample rejection"));
  await new Promise((resolve) => setTimeout(resolve, 25));
});

for (const lateOutcome of ["resolve", "reject"] as const) {
  test(`POSIX late telemetry initialize ${lateOutcome} is absorbed after termination`, async () => {
    const rootPid = lateOutcome === "resolve" ? 8_103 : 8_104;
    const initialize = telemetryDeferred<void>();
    let scheduled = 0;
    const creating = createPosixProcessTreeSupervisorForTest(
      { pid: rootPid } as ReturnType<typeof spawn>,
      "linux",
      {
        registeredSupervisor: telemetryRegisteredSupervisor(rootPid, []),
        tracker: telemetryTracker({ initialize: () => initialize.promise }),
        scheduleInterval: () => {
          scheduled += 1;
          return { unref() {} };
        },
        clearScheduledInterval: () => {},
      },
    );
    const supervisor = await telemetryBounded(creating);
    if (supervisor === TELEMETRY_STALLED) {
      if (lateOutcome === "resolve") initialize.resolve();
      else initialize.reject(new Error("release blocking initialize"));
      await creating.catch(() => undefined);
      assert.fail(`telemetry initialize ${lateOutcome} delayed registered readiness`);
    }
    assert.deepEqual(
      await supervisor.terminate(),
      { gone: true, proof: "registered-groups-empty" },
    );
    assert.equal(await supervisor.processTreeTelemetryReady, false);
    if (lateOutcome === "resolve") initialize.resolve();
    else initialize.reject(new Error("late telemetry initialize rejection"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(supervisor.processTreeRss?.(), undefined);
    assert.equal(scheduled, 0);
  });
}

test("POSIX telemetry failure stays unavailable without delaying registered authority", async () => {
  for (const failurePoint of ["initialize", "sample"] as const) {
    const rootPid = failurePoint === "initialize" ? 8_105 : 8_106;
    const disabled = telemetryDeferred<void>();
    let scheduledCallback: (() => void) | undefined;
    const supervisor = await createPosixProcessTreeSupervisorForTest(
      { pid: rootPid } as ReturnType<typeof spawn>,
      "linux",
      {
        registeredSupervisor: telemetryRegisteredSupervisor(rootPid, []),
        tracker: telemetryTracker({
          initialize: failurePoint === "initialize"
            ? async () => { throw new Error("initialize failed"); }
            : async () => {},
          sample: async () => { throw new Error("sample failed"); },
          disableTelemetry: () => disabled.resolve(),
        }),
        scheduleInterval: (callback) => {
          scheduledCallback = callback;
          return { unref() {} };
        },
        clearScheduledInterval: () => {},
      },
    );
    if (failurePoint === "sample") {
      assert.ok(scheduledCallback !== undefined);
      scheduledCallback();
    }
    assert.notEqual(await telemetryBounded(disabled.promise), TELEMETRY_STALLED);
    assert.equal(
      await supervisor.processTreeTelemetryReady,
      failurePoint === "sample",
    );
    assert.equal(supervisor.processTreeRss?.(), undefined);
    assert.deepEqual(
      await supervisor.terminate(),
      { gone: true, proof: "registered-groups-empty" },
    );
  }
});

test("POSIX telemetry scheduler failure keeps readiness and RSS unavailable", async () => {
  for (const failurePoint of ["schedule", "unref"] as const) {
    const rootPid = failurePoint === "schedule" ? 8_107 : 8_108;
    let cleared = 0;
    const supervisor = await createPosixProcessTreeSupervisorForTest(
      { pid: rootPid } as ReturnType<typeof spawn>,
      "linux",
      {
        registeredSupervisor: telemetryRegisteredSupervisor(rootPid, []),
        tracker: telemetryTracker(),
        scheduleInterval: () => {
          if (failurePoint === "schedule") throw new Error("schedule failed");
          return {
            unref() { throw new Error("unref failed"); },
          };
        },
        clearScheduledInterval: () => {
          cleared += 1;
        },
      },
    );
    assert.equal(await supervisor.processTreeTelemetryReady, false);
    assert.equal(supervisor.processTreeRss?.(), undefined);
    assert.equal(cleared, failurePoint === "unref" ? 1 : 0);
    assert.deepEqual(
      await supervisor.terminate(),
      { gone: true, proof: "registered-groups-empty" },
    );
  }
});

test("POSIX telemetry freezes only a complete active RSS receipt at stop", async () => {
  const rootPid = 8_109;
  const active = telemetryDeferred<void>();
  let cleared = 0;
  const expected = Object.freeze({ baselineBytes: 31, peakBytes: 47 });
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryRegisteredSupervisor(rootPid, []),
      tracker: telemetryTracker({
        initialize: async () => {},
        processTreeRss: () => expected,
      }),
      scheduleInterval: () => {
        active.resolve();
        return { unref() {} };
      },
      clearScheduledInterval: () => {
        cleared += 1;
      },
    },
  );
  assert.notEqual(await telemetryBounded(active.promise), TELEMETRY_STALLED);
  assert.equal(await supervisor.processTreeTelemetryReady, true);
  assert.deepEqual(supervisor.processTreeRss?.(), expected);
  assert.deepEqual(
    await supervisor.terminate(),
    { gone: true, proof: "registered-groups-empty" },
  );
  assert.deepEqual(supervisor.processTreeRss?.(), expected);
  assert.equal(cleared, 1);
});

test("POSIX benchmark telemetry roots preserve baseline and require a covering post-registration sample", async () => {
  const rootPid = 8_115;
  const firstSample = telemetryDeferred<void>();
  const secondSample = telemetryDeferred<void>();
  const sampleStarted = [telemetryDeferred<void>(), telemetryDeferred<void>()];
  const registeredRoots: RegisteredProcessGroupIdentity[] = [];
  let scheduledCallback: (() => void) | undefined;
  let sampleCalls = 0;
  let peakBytes = 47;
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryRegisteredSupervisor(rootPid, []),
      tracker: telemetryTracker({
        initialize: async () => {},
        registerRoot: (identity) => { registeredRoots.push(identity); },
        sample: () => {
          const call = sampleCalls;
          sampleCalls += 1;
          sampleStarted[call]!.resolve();
          return call === 0 ? firstSample.promise : secondSample.promise;
        },
        processTreeRss: () => ({ baselineBytes: 31, peakBytes }),
      }),
      scheduleInterval: (callback) => {
        scheduledCallback = callback;
        return { unref() {} };
      },
      clearScheduledInterval: () => {},
      deferProcessTreeTelemetryStop: true,
    },
  );
  assert.equal(await supervisor.processTreeTelemetryReady, true);
  assert.deepEqual(supervisor.processTreeRss?.(), { baselineBytes: 31, peakBytes: 47 });
  assert.ok(scheduledCallback !== undefined);
  scheduledCallback();
  await sampleStarted[0]!.promise;
  const nested = Object.freeze({
    pid: 8_215,
    parentPid: rootPid,
    processGroupId: 8_215,
    identity: "nested:8215",
    startOrder: 8_215,
  });
  supervisor.registerProcessTreeTelemetryRoot!(nested);
  assert.deepEqual(registeredRoots, [nested]);
  assert.equal(supervisor.processTreeRss?.(), undefined);
  assert.throws(() => supervisor.registerProcessTreeTelemetryRoot!(nested));

  firstSample.resolve();
  await sampleStarted[1]!.promise;
  assert.equal(supervisor.processTreeRss?.(), undefined);
  peakBytes = 96;
  secondSample.resolve();
  await waitFor(() => supervisor.processTreeRss?.()?.peakBytes === 96);
  assert.deepEqual(supervisor.processTreeRss?.(), { baselineBytes: 31, peakBytes: 96 });

  assert.deepEqual(await supervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
  });
  assert.deepEqual(supervisor.processTreeRss?.(), { baselineBytes: 31, peakBytes: 96 });
  supervisor.finishProcessTreeTelemetry!();
  supervisor.finishProcessTreeTelemetry!();
  assert.deepEqual(supervisor.processTreeRss?.(), { baselineBytes: 31, peakBytes: 96 });
});

test("POSIX benchmark telemetry finalizer never freezes an uncovered registered-root generation", async () => {
  const rootPid = 8_116;
  const sample = telemetryDeferred<void>();
  const sampleStarted = telemetryDeferred<void>();
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryRegisteredSupervisor(rootPid, []),
      tracker: telemetryTracker({
        initialize: async () => {},
        registerRoot: () => {},
        sample: () => {
          sampleStarted.resolve();
          return sample.promise;
        },
        processTreeRss: () => ({ baselineBytes: 41, peakBytes: 99 }),
      }),
      scheduleInterval: () => ({ unref() {} }),
      clearScheduledInterval: () => {},
      deferProcessTreeTelemetryStop: true,
    },
  );
  await supervisor.processTreeTelemetryReady;
  supervisor.registerProcessTreeTelemetryRoot!(Object.freeze({
    pid: 8_216,
    parentPid: rootPid,
    processGroupId: 8_216,
    identity: "nested:8216",
    startOrder: 8_216,
  }));
  await sampleStarted.promise;
  assert.deepEqual(await supervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
  });
  supervisor.finishProcessTreeTelemetry!();
  assert.equal(supervisor.processTreeRss?.(), undefined);
  sample.resolve();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(supervisor.processTreeRss?.(), undefined);
});

test("POSIX termination retries after an unverified receipt and caches later proof", async () => {
  const rootPid = 8_110;
  const receipts: ProcessTreeTerminationReceipt[] = [
    Object.freeze({ gone: false, proof: "unverified", reason: "deadline" }),
    Object.freeze({ gone: true, proof: "registered-groups-empty" }),
  ];
  let authorityCalls = 0;
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryScriptedRegisteredSupervisor(rootPid, async () => {
        const receipt = receipts[authorityCalls];
        authorityCalls += 1;
        if (receipt === undefined) throw new Error("unexpected authority retry");
        return receipt;
      }),
      tracker: telemetryTracker(),
      scheduleInterval: () => ({ unref() {} }),
      clearScheduledInterval: () => {},
    },
  );

  assert.deepEqual(await supervisor.terminate(), receipts[0]);
  assert.deepEqual(await supervisor.terminate(), receipts[1]);
  assert.deepEqual(await supervisor.terminate(), receipts[1]);
  assert.equal(authorityCalls, 2);
});

test("POSIX termination retries after authority rejection", async () => {
  const rootPid = 8_111;
  const verified = Object.freeze({
    gone: true as const,
    proof: "registered-groups-empty" as const,
  });
  let authorityCalls = 0;
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryScriptedRegisteredSupervisor(rootPid, async () => {
        authorityCalls += 1;
        if (authorityCalls === 1) throw new Error("first authority attempt rejected");
        return verified;
      }),
      tracker: telemetryTracker(),
      scheduleInterval: () => ({ unref() {} }),
      clearScheduledInterval: () => {},
    },
  );

  await assert.rejects(supervisor.terminate(), /first authority attempt rejected/u);
  assert.deepEqual(await supervisor.terminate(), verified);
  assert.equal(authorityCalls, 2);
});

test("POSIX termination deduplicates concurrent authority attempts", async () => {
  const rootPid = 8_112;
  const attempt = telemetryDeferred<ProcessTreeTerminationReceipt>();
  const unverified = Object.freeze({
    gone: false as const,
    proof: "unverified" as const,
    reason: "deadline" as const,
  });
  let authorityCalls = 0;
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryScriptedRegisteredSupervisor(rootPid, () => {
        authorityCalls += 1;
        return attempt.promise;
      }),
      tracker: telemetryTracker(),
      scheduleInterval: () => ({ unref() {} }),
      clearScheduledInterval: () => {},
    },
  );

  const first = supervisor.terminate();
  const concurrent = supervisor.terminate();
  assert.equal(first, concurrent);
  assert.equal(authorityCalls, 1);
  attempt.resolve(unverified);
  assert.deepEqual(await first, unverified);
  assert.deepEqual(await concurrent, unverified);
});

test("POSIX termination reuses verified proof without another authority attempt", async () => {
  const rootPid = 8_113;
  const verified = Object.freeze({
    gone: true as const,
    proof: "registered-groups-empty" as const,
  });
  let authorityCalls = 0;
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryScriptedRegisteredSupervisor(rootPid, async () => {
        authorityCalls += 1;
        return verified;
      }),
      tracker: telemetryTracker(),
      scheduleInterval: () => ({ unref() {} }),
      clearScheduledInterval: () => {},
    },
  );

  assert.deepEqual(await supervisor.terminate(), verified);
  assert.deepEqual(await supervisor.terminate(), verified);
  assert.equal(authorityCalls, 1);
});

test("POSIX termination retries never resurrect stopped pending telemetry", async () => {
  const rootPid = 8_114;
  const initialize = telemetryDeferred<void>();
  let authorityCalls = 0;
  let scheduled = 0;
  const supervisor = await createPosixProcessTreeSupervisorForTest(
    { pid: rootPid } as ReturnType<typeof spawn>,
    "linux",
    {
      registeredSupervisor: telemetryScriptedRegisteredSupervisor(rootPid, async () => {
        authorityCalls += 1;
        return authorityCalls === 1
          ? Object.freeze({ gone: false, proof: "unverified", reason: "deadline" })
          : Object.freeze({ gone: true, proof: "registered-groups-empty" });
      }),
      tracker: telemetryTracker({ initialize: () => initialize.promise }),
      scheduleInterval: () => {
        scheduled += 1;
        return { unref() {} };
      },
      clearScheduledInterval: () => {},
    },
  );

  assert.deepEqual(
    await supervisor.terminate(),
    { gone: false, proof: "unverified", reason: "deadline" },
  );
  assert.equal(await supervisor.processTreeTelemetryReady, false);
  initialize.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(scheduled, 0);
  assert.equal(supervisor.processTreeRss?.(), undefined);
  assert.deepEqual(
    await supervisor.terminate(),
    { gone: true, proof: "registered-groups-empty" },
  );
  assert.equal(await supervisor.processTreeTelemetryReady, false);
  assert.equal(supervisor.processTreeRss?.(), undefined);
  assert.equal(authorityCalls, 2);
});

test("Windows supervisor always performs discovery-free retained-handle cleanup", () => {
  const windows = readFileSync(
    fileURLToPath(new URL("../src/workers/windows-job-supervisor.ps1", import.meta.url)),
    "utf8",
  );
  assert.match(windows, /function Invoke-RetainedTerminationPass/u);
  assert.match(windows, /function Stop-RetainedHandles/u);
  assert.match(windows, /catch \{[\s\S]*Invoke-RetainedTerminationPass/u);
  assert.match(
    windows,
    /finally \{[\s\S]*Stop-RetainedHandles[\s\S]*foreach \(\$entry in @\(\$retained\.Values\)\)/u,
  );
  assert.match(
    windows,
    /RecordFromHandle\(\$process, \$TargetPid\)[\s\S]*catch \{[\s\S]*CloseHandle\(\$process\)[\s\S]*\$process = \[IntPtr\]::Zero/u,
  );
  assert.match(windows, /if \(-not \$discoveryComplete\) \{ return \$false \}/u);
});

test("Windows system executables fail closed without an absolute SystemRoot", () => {
  assert.throws(() => resolveWindowsSystemExecutable("taskkill.exe", "win32", undefined));
  assert.throws(() => resolveWindowsSystemExecutable("taskkill.exe", "win32", "relative"));
  assert.equal(
    resolveWindowsSystemExecutable("taskkill.exe", "win32", "C:\\Windows"),
    "C:\\Windows\\System32\\taskkill.exe",
  );
});

test("Windows ACL receipt permits only current user and SYSTEM with protected full control", () => {
  const currentSid = "S-1-5-21-1000";
  const valid = {
    protected: true,
    rules: [
      { sid: currentSid, allow: true, full: true },
      { sid: "S-1-5-18", allow: true, full: true },
    ],
  };
  assert.equal(validateWindowsAclReceipt(valid, currentSid), true);
  assert.equal(validateWindowsAclReceipt({ ...valid, protected: false }, currentSid), false);
  assert.equal(validateWindowsAclReceipt({
    ...valid,
    rules: [...valid.rules, { sid: "S-1-1-0", allow: true, full: true }],
  }, currentSid), false);
  assert.equal(validateWindowsAclReceipt({
    ...valid,
    rules: [{ sid: currentSid, allow: true, full: false }],
  }, currentSid), false);
});

test("Windows ACL helper environment does not propagate ambient secrets", () => {
  const environment = createAclHelperEnvironment(
    "C:\\safe\\spool.bin",
    "S-1-5-21-1000",
    "file",
    {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      LANG: "ko_KR.UTF-8",
      AWS_SECRET_ACCESS_KEY: "must-not-propagate",
      OPENAI_API_KEY: "must-not-propagate",
      PATH: "C:\\untrusted",
    },
  );
  assert.deepEqual(environment, {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    LANG: "ko_KR.UTF-8",
    GPT_CODEX_HWP_ACL_PATH: "C:\\safe\\spool.bin",
    GPT_CODEX_HWP_ACL_SID: "S-1-5-21-1000",
    GPT_CODEX_HWP_ACL_KIND: "file",
  });
});

test("Windows Job helper environment contains only required runtime variables", () => {
  assert.deepEqual(createJobHelperEnvironment({
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    LANG: "ko_KR.UTF-8",
    AWS_SECRET_ACCESS_KEY: "must-not-propagate",
    OPENAI_API_KEY: "must-not-propagate",
    PATH: "C:\\untrusted",
  }), {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    LANG: "ko_KR.UTF-8",
  });
});

test("document child client makes a waiting heavy request abortable and runs one child at a time", async () => {
  const gate = new HeavyChildGate();
  const firstOwned = createOwnedFiles();
  const secondOwned = createOwnedFiles();
  const abort = new AbortController();
  try {
    const first = childClient("slow", gate, 120).run(
      detectRequest("child-gate-first"),
      spoolSnapshot(firstOwned.inputFd, 3),
      { deadlineMs: 5_000 },
    );
    const secondSnapshot = spoolSnapshot(secondOwned.inputFd, 3);
    const second = childClient("success", gate).run(
      detectRequest("child-gate-second"),
      secondSnapshot,
      { signal: abort.signal, deadlineMs: 5_000 },
    );
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(second, (error: unknown) => safeCode(error) === "REQUEST_CANCELLED");
    assert.equal(secondSnapshot.takeCalls, 0);
    assert.equal(secondSnapshot.cleanupCalls, 1);
    assert.deepEqual(await first, { format: "unknown" });
    assert.equal(gate.activeCount, 0);
  } finally {
    firstOwned.cleanup();
    secondOwned.cleanup();
  }
});

test("one reused document child client serializes two child-eligible registration transport requests", async () => {
  const gate = new HeavyChildGate();
  const client = childClient("slow", gate, 100);
  const firstOwned = createOwnedFiles();
  const secondOwned = createOwnedFiles();
  try {
    const first = client.run(
      detectRequest("registration-sequential-first"),
      spoolSnapshot(firstOwned.inputFd, 3),
      { deadlineMs: 5_000 },
    );
    const second = client.run(
      detectRequest("registration-sequential-second"),
      spoolSnapshot(secondOwned.inputFd, 3),
      { deadlineMs: 5_000 },
    );
    await waitFor(() => gate.activeCount === 1 &&
      (gate as unknown as { queuedCount: number }).queuedCount === 1);
    assert.deepEqual(await first, { format: "unknown" });
    assert.equal(gate.activeCount, 1);
    assert.deepEqual(await second, { format: "unknown" });
    assert.equal(gate.activeCount, 0);
  } finally {
    firstOwned.cleanup();
    secondOwned.cleanup();
  }
});

test("document child client includes gate wait in the request deadline", async () => {
  const gate = new HeavyChildGate();
  const root = mkdtempSync(join(tmpdir(), "hwp-gate-deadline-test-"));
  const firstOwned = createOwnedFiles();
  const secondOwned = createOwnedFiles();
  try {
    const firstClient = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["slow", "150"],
      heavyChildGate: gate,
      spoolRoot: root,
    });
    const secondClient = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      heavyChildGate: gate,
      spoolRoot: root,
    });
    const first = firstClient.run(
      detectRequest("gate-deadline-first"),
      spoolSnapshot(firstOwned.inputFd, 3),
      { deadlineMs: 5_000 },
    );
    const secondSnapshot = spoolSnapshot(secondOwned.inputFd, 3);
    await assert.rejects(
      secondClient.run(
        detectRequest("gate-deadline-second"),
        secondSnapshot,
        { deadlineMs: 30 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
    );
    assert.equal(secondSnapshot.takeCalls, 0);
    assert.equal(secondSnapshot.cleanupCalls, 1);
    assert.deepEqual(await first, { format: "unknown" });
    assert.equal(gate.activeCount, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    firstOwned.cleanup();
    secondOwned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client includes private spool and spawn time before framed dispatch", async () => {
  const gate = new HeavyChildGate();
  const root = mkdtempSync(join(tmpdir(), "hwp-startup-deadline-test-"));
  const owned = createOwnedFiles();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  let dispatches = 0;
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      heavyChildGate: gate,
      spoolRoot: root,
      spawnFactory: (specification) => {
        const child = spawn(
          specification.command,
          [...specification.args],
          specification.options,
        );
        const originalEnd = child.stdin!.end.bind(child.stdin);
        child.stdin!.end = ((...args: Parameters<typeof child.stdin.end>) => {
          dispatches += 1;
          return originalEnd(...args);
        }) as typeof child.stdin.end;
        const waitUntil = Date.now() + 75;
        while (Date.now() < waitUntil) {
          // Deliberately consume the remaining startup budget.
        }
        return child;
      },
    });
    await assert.rejects(
      client.run(
        detectRequest("startup-deadline"),
        snapshot,
        { deadlineMs: 50 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
    );
    assert.equal(dispatches, 0);
    assert.equal(snapshot.cleanupCalls, 1);
    assert.equal(gate.activeCount, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("heavy child gate removes an aborted waiter immediately", async () => {
  const gate = new HeavyChildGate();
  const release = await gate.acquire();
  const abort = new AbortController();
  const waiting = gate.acquire(abort.signal);
  assert.equal((gate as unknown as { queuedCount: number }).queuedCount, 1);
  abort.abort();
  await assert.rejects(
    waiting,
    (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
  );
  assert.equal((gate as unknown as { queuedCount: number }).queuedCount, 0);
  release();
  assert.equal(gate.activeCount, 0);
});

test("document child client performs bounded real external allocation while parent survives", async () => {
  const owned = createOwnedFiles();
  try {
    const progress: Array<[number, number]> = [];
    const result = await childClient("external-memory-stress").run(
      {
        protocolVersion: 1,
        requestId: "child-external-memory",
        operation: "render",
        input: {},
        options: {},
      },
      spoolSnapshot(owned.inputFd, 3),
      { onProgress: (completed, total) => progress.push([completed, total]) },
    );
    assert.equal(isIntegrityVerifiedResultSpool(result), true);
    assert.deepEqual(progress, [[16, 16]]);
    const spool = result as unknown as {
      takeHandle(): { fd: number; sizeBytes: number };
      cleanup(): Promise<void>;
    };
    const handle = spool.takeHandle();
    const bytes = Buffer.alloc(handle.sizeBytes);
    assert.equal(readSync(handle.fd, bytes, 0, bytes.length, 0), bytes.length);
    const evidence = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    assert.equal(evidence?.allocatedBytes, 16 * 1024 * 1024);
    assert.ok(Number(evidence?.externalBytes) >= 16 * 1024 * 1024);
    await spool.cleanup();
  } finally {
    owned.cleanup();
  }
});

test("document child client verifies parent-owned fd 5 spools for content-bearing operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-output-spool-test-"));
  const owned = createOwnedFiles();
  const requests = childOperationRequests();
  try {
    for (const request of requests) {
      const client = createDocumentChildClient({
        childEntry: fixturePath,
        childArguments: ["spool-result", "1024"],
        spoolRoot: root,
      } as never);
      const snapshot = request.operation === "generateHwpx"
        ? undefined
        : spoolSnapshot(owned.inputFd, 3);
      const result = await client.run(request as never, snapshot, request.operation === "insertImage"
        ? { imageInput: { transport: "spool", fd: owned.imageFd, sizeBytes: 1 } }
        : {});
      assert.equal(isIntegrityVerifiedResultSpool(result), true);
      const spool = result as unknown as {
        readonly metadata: { operation: string; sizeBytes: number; sha256: string };
        takeHandle(): { fd: number; sizeBytes: number };
        cleanup(): Promise<void>;
      };
      assert.equal(spool.metadata.operation, request.operation);
      assert.equal(spool.metadata.sizeBytes, 1024);
      assert.match(spool.metadata.sha256, /^[0-9a-f]{64}$/u);
      const handle = spool.takeHandle();
      const bytes = Buffer.alloc(handle.sizeBytes);
      assert.equal(readSync(handle.fd, bytes, 0, bytes.length, 0), bytes.length);
      assert.equal(bytes[0], 0x4b);
      assert.throws(() => spool.takeHandle());
      await spool.cleanup();
      await spool.cleanup();
      assert.deepEqual(readdirSync(root), []);
    }
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client verifies a 9 MiB spool without control-channel payload cloning", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-large-output-test-"));
  const owned = createOwnedFiles();
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["spool-result", String(9 * 1024 * 1024)],
      spoolRoot: root,
    } as never);
    const result = await client.run(
      { protocolVersion: 1, requestId: "large-render", operation: "render", input: {}, options: {} },
      spoolSnapshot(owned.inputFd, 3),
    );
    assert.equal(isIntegrityVerifiedResultSpool(result), true);
    const spool = result as unknown as { metadata: { sizeBytes: number }; cleanup(): Promise<void> };
    assert.equal(spool.metadata.sizeBytes, 9 * 1024 * 1024);
    await spool.cleanup();
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client rejects tampered spool size and hash and cleans owned output", async () => {
  for (const mode of ["spool-size-tamper", "spool-hash-tamper"] as const) {
    const root = mkdtempSync(join(tmpdir(), "hwp-tampered-output-test-"));
    const owned = createOwnedFiles();
    try {
      const client = createDocumentChildClient({
        childEntry: fixturePath,
        childArguments: [mode, "1024"],
        spoolRoot: root,
      } as never);
      await assert.rejects(
        client.run(
          {
            protocolVersion: 1,
            requestId: `tamper-${mode}`,
            operation: "render",
            input: {},
            options: {},
          },
          spoolSnapshot(owned.inputFd, 3),
        ),
        (error: unknown) => safeCode(error) === "ENGINE_PROTOCOL_ERROR",
      );
      assert.deepEqual(readdirSync(root), []);
    } finally {
      owned.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("output spool cleanup retries after quarantine unlink failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-output-unlink-retry-"));
  const owned = createOwnedFiles();
  let failOnce = true;
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["spool-result", "1024"],
      spoolRoot: root,
      outputSpoolCleanupHooks: {
        unlink: async (path: string) => {
          if (failOnce) {
            failOnce = false;
            throw new Error("injected unlink failure");
          }
          await removeFile(path);
        },
      },
    } as never);
    const result = await client.run(
      { protocolVersion: 1, requestId: "unlink-retry", operation: "render", input: {}, options: {} },
      spoolSnapshot(owned.inputFd, 3),
    );
    const spool = result as unknown as { cleanup(): Promise<void> };
    await assert.rejects(spool.cleanup(), /injected unlink failure/u);
    assert.equal(readdirSync(root).length, 1);
    await spool.cleanup();
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("output spool cleanup retries after quarantine rmdir failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-output-rmdir-retry-"));
  const owned = createOwnedFiles();
  let failOnce = true;
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["spool-result", "1024"],
      spoolRoot: root,
      outputSpoolCleanupHooks: {
        rmdir: async (path: string) => {
          if (failOnce) {
            failOnce = false;
            throw new Error("injected rmdir failure");
          }
          await removeDirectory(path);
        },
      },
    } as never);
    const result = await client.run(
      { protocolVersion: 1, requestId: "rmdir-retry", operation: "render", input: {}, options: {} },
      spoolSnapshot(owned.inputFd, 3),
    );
    const spool = result as unknown as { cleanup(): Promise<void> };
    await assert.rejects(spool.cleanup(), /injected rmdir failure/u);
    assert.equal(readdirSync(root).length, 1);
    await spool.cleanup();
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client rejects oversized inline declaration and cleans output spool", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-inline-limit-test-"));
  const owned = createOwnedFiles();
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["inline-oversize-declaration", "250"],
      spoolRoot: root,
    } as never);
    await assert.rejects(
      client.run(detectRequest("inline-oversize"), spoolSnapshot(owned.inputFd, 3)),
      (error: unknown) => safeCode(error) === "ENGINE_PROTOCOL_ERROR",
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client rejects a 9 MiB control frame before payload allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-control-frame-attack-"));
  const owned = createOwnedFiles();
  const allocations: number[] = [];
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["inline-9m-attack", "250"],
      spoolRoot: root,
      controlFrameAllocationObserver: (bytes: number) => allocations.push(bytes),
    } as never);
    await assert.rejects(
      client.run(detectRequest("inline-9m-attack"), spoolSnapshot(owned.inputFd, 3)),
      (error: unknown) => safeCode(error) === "ENGINE_PROTOCOL_ERROR",
    );
    assert.equal(allocations.some((bytes) => bytes >= 9 * 1024 * 1024), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client does not spawn when pre-aborted and cleans once", async () => {
  const owned = createOwnedFiles();
  const abort = new AbortController();
  abort.abort();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  let dispatches = 0;
  try {
    const client = createDocumentChildClient({
      spawnFactory: () => {
        dispatches += 1;
        throw new Error("must not dispatch");
      },
    });
    await assert.rejects(
      client.run(detectRequest("child-pre-abort"), snapshot, { signal: abort.signal }),
      (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
    );
    assert.equal(dispatches, 0);
    assert.equal(snapshot.cleanupCalls, 1);
  } finally {
    owned.cleanup();
  }
});

test("document child client rejects a worker snapshot before spawn", async () => {
  let dispatches = 0;
  const snapshot = fakeWorkerSnapshot();
  const client = createDocumentChildClient({
    spawnFactory: () => {
      dispatches += 1;
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(
    client.run(detectRequest("child-wrong-worker") as never, snapshot as never),
    (error: unknown) => safeCode(error) === "ENGINE_PROTOCOL_ERROR",
  );
  assert.equal(dispatches, 0);
  assert.equal(snapshot.cleanupCalls, 1);
});

test("document child client closes the spawn-to-listener abort gap", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-spawn-abort-test-"));
  const owned = createOwnedFiles();
  const abort = new AbortController();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      spoolRoot: root,
      spawnFactory: (specification) => {
        abort.abort();
        return spawn(specification.command, [...specification.args], specification.options);
      },
    });
    await assert.rejects(
      client.run(detectRequest("child-spawn-abort"), snapshot, {
        signal: abort.signal,
      }),
      (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
    );
    await waitFor(() => snapshot.cleanupCalls === 1 && readdirSync(root).length === 0);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client does not spawn when aborted during output spool creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-spool-abort-test-"));
  const owned = createOwnedFiles();
  const abort = new AbortController();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  const gate = new HeavyChildGate();
  let spawns = 0;
  try {
    const client = createDocumentChildClient({
      spoolRoot: root,
      heavyChildGate: gate,
      outputSpoolReadyHook: async () => {
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      spawnFactory: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    });
    await assert.rejects(
      client.run(detectRequest("child-spool-abort"), snapshot, {
        signal: abort.signal,
        deadlineMs: 5_000,
      }),
      (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
    );
    assert.equal(spawns, 0);
    assert.equal(snapshot.cleanupCalls, 1);
    assert.equal(gate.activeCount, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup failure preserves abort when abort precedes the deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-spool-abort-first-test-"));
  const owned = createOwnedFiles();
  const abort = new AbortController();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  try {
    const client = createDocumentChildClient({
      spoolRoot: root,
      outputSpoolReadyHook: async () => {
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("spool startup failed after abort");
      },
    });
    await assert.rejects(
      client.run(detectRequest("child-spool-abort-first"), snapshot, {
        signal: abort.signal,
        deadlineMs: 5_000,
      }),
      (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
    );
    assert.equal(snapshot.cleanupCalls, 1);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup failure preserves deadline when deadline precedes a later abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-spool-deadline-first-test-"));
  const owned = createOwnedFiles();
  const abort = new AbortController();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  try {
    const client = createDocumentChildClient({
      spoolRoot: root,
      outputSpoolReadyHook: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        abort.abort();
        throw new Error("spool startup failed after deadline");
      },
    });
    await assert.rejects(
      client.run(detectRequest("child-spool-deadline-first"), snapshot, {
        signal: abort.signal,
        deadlineMs: 1,
      }),
      (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
    );
    assert.equal(snapshot.cleanupCalls, 1);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn failure preserves an abort observed inside spawnFactory", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-spawn-failure-abort-test-"));
  const owned = createOwnedFiles();
  const abort = new AbortController();
  const snapshot = spoolSnapshot(owned.inputFd, 3);
  try {
    const client = createDocumentChildClient({
      spoolRoot: root,
      spawnFactory: () => {
        abort.abort();
        throw new Error("spawn failed after abort");
      },
    });
    await assert.rejects(
      client.run(detectRequest("child-spawn-failure-abort"), snapshot, {
        signal: abort.signal,
        deadlineMs: 5_000,
      }),
      (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
    );
    assert.equal(snapshot.cleanupCalls, 1);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document child client uses only framed stdin and fd 6 for control messages", async () => {
  const owned = createOwnedFiles();
  let capturedStdio: unknown;
  try {
    const client = createDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["success", "250"],
      spawnFactory: (specification) => {
        capturedStdio = specification.options.stdio;
        return spawn(
          specification.command,
          [...specification.args],
          specification.options,
        );
      },
    });
    const result = await client.run(
      {
        protocolVersion: 1,
        requestId: "child-image-spool",
        operation: "insertImage",
        input: { anchorText: "anchor" },
        options: {},
      },
      spoolSnapshot(owned.inputFd, 3),
      {
        imageInput: {
          transport: "spool",
          fd: owned.imageFd,
          sizeBytes: 1,
        },
      },
    );
    assert.equal(result.bytes.byteLength, 0);
    const stdio = capturedStdio as unknown[];
    assert.deepEqual(stdio.slice(0, 5), [
      "pipe", "pipe", "pipe", owned.inputFd, owned.imageFd,
    ]);
    assert.equal(typeof stdio[5], "number");
    assert.notEqual(stdio[5], owned.inputFd);
    assert.notEqual(stdio[5], owned.imageFd);
    assert.equal(stdio[6], "pipe");
  } finally {
    owned.cleanup();
  }
});

function childClient(
  mode: string,
  heavyChildGate = new HeavyChildGate(),
  delayMs = 250,
) {
  return createDocumentChildClient({
    childEntry: fixturePath,
    childArguments: [mode, String(delayMs)],
    heavyChildGate,
  });
}

function scriptedChildClient(
  metricEvents: readonly Readonly<Record<string, unknown>>[],
) {
  const script = `
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const frame = Buffer.concat(chunks);
  const size = frame.readUInt32BE(0);
  const request = JSON.parse(frame.subarray(4, 4 + size).toString("utf8"));
  const event = (type) => ({ protocolVersion: 1, requestId: request.requestId, type });
  const send = (value) => {
    const body = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    fs.writeSync(6, header);
    fs.writeSync(6, body);
  };
  send(event("ready"));
  for (const metric of ${JSON.stringify(metricEvents)}) {
    send({ ...event("metrics"), ...metric });
  }
  send({ ...event("result"), payload: { format: "unknown" }, outputByteLength: 7 });
});
`;
  return createDocumentChildClient({
    spawnFactory: (specification) => spawn(
      specification.command,
      ["-e", script],
      specification.options,
    ),
  });
}

function detectRequest(requestId: string) {
  return { protocolVersion: 1, requestId, operation: "detect", input: {}, options: {} } as const;
}

function childOperationRequests() {
  return [
    { protocolVersion: 1, requestId: "spool-parse", operation: "parse", input: {}, options: {} },
    { protocolVersion: 1, requestId: "spool-render", operation: "render", input: {}, options: {} },
    { protocolVersion: 1, requestId: "spool-generate", operation: "generateHwpx", input: { markdown: "# test" }, options: {} },
    { protocolVersion: 1, requestId: "spool-patch", operation: "patchHwpx", input: { markdown: "patch" }, options: {} },
    { protocolVersion: 1, requestId: "spool-fill", operation: "fillHwpx", input: { fields: { name: "value" } }, options: {} },
    { protocolVersion: 1, requestId: "spool-image", operation: "insertImage", input: { anchorText: "anchor" }, options: {} },
  ] as const;
}

function spoolSnapshot(fd: number, sizeBytes: number): SpoolDocumentSnapshot & {
  takeCalls: number;
  cleanupCalls: number;
} {
  return {
    transport: "spool",
    metadata: {
      sizeBytes,
      sha256: "0".repeat(64),
      shallowFormat: { candidate: "unknown", container: "unknown", exact: false },
      protection: { status: "requires-engine-validation", candidateFormat: "unknown", exact: false },
    },
    takeCalls: 0,
    cleanupCalls: 0,
    takeSpoolHandle() { this.takeCalls += 1; return { fd, sizeBytes }; },
    async verifySourceUnchanged() {},
    async cleanup() { this.cleanupCalls += 1; },
  };
}

function fakeWorkerSnapshot() {
  return {
    transport: "worker" as const,
    metadata: {
      sizeBytes: 1,
      sha256: "0".repeat(64),
      shallowFormat: { candidate: "unknown" as const, container: "unknown" as const, exact: false as const },
      protection: { status: "requires-engine-validation" as const, candidateFormat: "unknown" as const, exact: false as const },
    },
    cleanupCalls: 0,
    takeTransferable() { return new ArrayBuffer(1); },
    async verifySourceUnchanged() {},
    async cleanup() { this.cleanupCalls += 1; },
  };
}

function createOwnedFiles() {
  const directory = mkdtempSync(join(tmpdir(), "hwp-engine-client-test-"));
  const inputPath = join(directory, "input.bin");
  const outputPath = join(directory, "output.bin");
  const imagePath = join(directory, "image.bin");
  const inputFd = openSync(inputPath, "w+");
  const outputFd = openSync(outputPath, "w+");
  const imageFd = openSync(imagePath, "w+");
  return {
    inputFd,
    outputFd,
    imageFd,
    outputPath,
    cleanup() {
      try { closeSync(inputFd); } catch {}
      try { closeSync(outputFd); } catch {}
      try { closeSync(imageFd); } catch {}
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function waitUntilProcessIsGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant process ${pid} survived tree termination`);
}

function readPidLog(path: string): number[] {
  return [...new Set(readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => /^[0-9]+$/u.test(line))
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const TELEMETRY_STALLED = Symbol("telemetry-stalled");

function telemetryDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value as T | PromiseLike<T>),
    reject: rejectPromise,
  };
}

async function telemetryBounded<T>(
  promise: Promise<T>,
  timeoutMs = 250,
): Promise<T | typeof TELEMETRY_STALLED> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TELEMETRY_STALLED>((resolve) => {
        timer = setTimeout(() => resolve(TELEMETRY_STALLED), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function telemetryTracker(
  overrides: Partial<TestPosixTelemetryTracker> = {},
): TestPosixTelemetryTracker {
  let disabled = false;
  return {
    initialize: overrides.initialize ?? (async () => {}),
    registerRoot: overrides.registerRoot ?? (() => {}),
    sample: overrides.sample ?? (async () => {}),
    disableTelemetry: overrides.disableTelemetry ?? (() => {
      disabled = true;
    }),
    telemetryAvailable: overrides.telemetryAvailable ?? (() => !disabled),
    processTreeRss: overrides.processTreeRss ?? (() => ({
      baselineBytes: 11,
      peakBytes: 22,
    })),
  };
}

function telemetryRegisteredSupervisor(
  rootPid: number,
  signals: Array<NodeJS.Signals | 0>,
): RegisteredProcessGroupSupervisor {
  const rootIdentity = Object.freeze({
    pid: rootPid,
    parentPid: process.pid,
    processGroupId: rootPid,
    identity: `test:${rootPid}`,
    startOrder: rootPid,
  });
  let livenessProbes = 0;
  return createRegisteredPosixProcessGroupSupervisor({
    rootIdentity,
    inspectIdentity: async () => rootIdentity,
    signalGroup: (_processGroupId, signal) => {
      signals.push(signal);
      if (signal !== 0) return;
      livenessProbes += 1;
      if (livenessProbes >= 2) throw errno("ESRCH");
    },
    delay: async () => {},
    terminationGraceMs: 0,
  });
}

function telemetryScriptedRegisteredSupervisor(
  rootPid: number,
  terminate: () => Promise<ProcessTreeTerminationReceipt>,
): RegisteredProcessGroupSupervisor {
  let registered = false;
  const identity = Object.freeze({
    pid: rootPid,
    parentPid: process.pid,
    processGroupId: rootPid,
    identity: `scripted:${rootPid}`,
    startOrder: rootPid,
  });
  return {
    async registerRoot(pid, expectedParentPid) {
      assert.equal(registered, false);
      assert.equal(pid, rootPid);
      assert.equal(expectedParentPid, process.pid);
      registered = true;
      return identity;
    },
    terminate() {
      assert.equal(registered, true);
      return terminate();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition was not met before deadline");
}

async function terminateChildWithProof(
  child: ReturnType<typeof spawn>,
  proof: "windows-job-empty" | "registered-groups-empty",
) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  return { gone: true as const, proof };
}

function safeCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function countingSignal(): {
  readonly signal: AbortSignal;
  readonly counts: { added: number; removed: number };
} {
  const signal = new AbortController().signal;
  const counts = { added: 0, removed: 0 };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperties(signal, {
    addEventListener: {
      value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
        counts.added += 1;
        return add(...args);
      },
    },
    removeEventListener: {
      value: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
        counts.removed += 1;
        return remove(...args);
      },
    },
  });
  return { signal, counts };
}
