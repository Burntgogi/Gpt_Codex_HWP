import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
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
import { fileURLToPath } from "node:url";

import * as childClientModule from "../src/workers/document-child-client.js";
import { HeavyChildGate } from "../src/workers/document-execution-policy.js";
import type { SpoolDocumentSnapshot } from "../src/shared/document-snapshot.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/workers/engine-test-child.mjs", import.meta.url),
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

function createDocumentChildClient(
  dependencies: Record<string, unknown> = {},
) {
  return createProductionDocumentChildClient({
    ...dependencies,
    jobSupervisorFactory: "jobSupervisorFactory" in dependencies
      ? dependencies.jobSupervisorFactory
      : async (child: ReturnType<typeof spawn>) => ({
          terminate: async () => child.pid === undefined
            ? true
            : terminateDocumentProcessTreeByPid(child.pid, {}),
        }),
  } as never);
}

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
        ),
        (error: unknown) => safeCode(error) === code &&
          !JSON.stringify(error).includes("AWS_SECRET_ACCESS_KEY"),
      );
      assert.deepEqual(
        await childClient("success").run(
          detectRequest(`child-recovery-${mode}`),
          spoolSnapshot(owned.inputFd, 3),
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
          deadlineMs: 1_500,
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
    assert.match(supervisorFrames[1] ?? "", /^GPT_CODEX_HWP_JOB GONE 0 [12]$/u);
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
      (error: unknown) => safeCode(error) === "ENGINE_CRASH",
    );
    assert.match(supervisorFrames[0] ?? "", /^GPT_CODEX_HWP_JOB READY [0-9]+ 2 [0-9]+$/u);
    assert.match(supervisorFrames[1] ?? "", /^GPT_CODEX_HWP_JOB TRACKER [0-9]+ [0-9]+$/u);
    assert.ok(Number.parseInt(supervisorFrames[1]!.split(" ").at(-2)!, 10) < 200, supervisorFrames[1]);
    assert.ok(Number.parseInt(supervisorFrames[1]!.split(" ").at(-1)!, 10) >= 3, supervisorFrames[1]);
    context.diagnostic(supervisorFrames[1]!);
    assert.equal(supervisorFrames[2], "GPT_CODEX_HWP_JOB GONE 0 2");
    observedPids = readPidLog(pidLog);
    assert.ok(observedPids.length >= 2);
    assert.match(readFileSync(pidLog, "utf8"), /^EXIT [0-9]+$/mu);
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
        { deadlineMs: 1_800 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
    );
    assert.match(supervisorFrames[0] ?? "", /^GPT_CODEX_HWP_JOB READY [0-9]+ 2 [0-9]+$/u);
    assert.match(supervisorFrames[1] ?? "", /^GPT_CODEX_HWP_JOB TRACKER [0-9]+ [0-9]+$/u);
    assert.ok(Number.parseInt(supervisorFrames[1]!.split(" ").at(-2)!, 10) < 200, supervisorFrames[1]);
    assert.ok(Number.parseInt(supervisorFrames[1]!.split(" ").at(-1)!, 10) >= 10, supervisorFrames[1]);
    context.diagnostic(supervisorFrames[1]!);
    assert.equal(supervisorFrames[2], "GPT_CODEX_HWP_JOB GONE 0 2");
    observedPids = readPidLog(pidLog);
    assert.ok(observedPids.length >= 10);
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
      (error: unknown) => safeCode(error) === "ENGINE_INIT_FAILED",
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
          terminate: async () => child.pid === undefined
            ? true
            : terminateDocumentProcessTreeByPid(child.pid, {}),
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

test("document child client drains startup output and preserves OOM precedence during supervisor wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-startup-output-oom-"));
  const owned = createOwnedFiles();
  try {
    const client = createProductionDocumentChildClient({
      childEntry: fixturePath,
      childArguments: ["startup-large-oom", "250"],
      spoolRoot: root,
      jobSupervisorFactory: async (child) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return {
          terminate: async () => child.pid === undefined
            ? true
            : terminateDocumentProcessTreeByPid(child.pid, {}),
        };
      },
    });
    await assert.rejects(
      client.run(
        detectRequest("startup-output-oom"),
        spoolSnapshot(owned.inputFd, 3),
        { deadlineMs: 1_000 },
      ),
      (error: unknown) => safeCode(error) === "ENGINE_OOM" &&
        !JSON.stringify(error).includes("heap out of memory"),
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup fatal OOM outranks a supervisor readiness failure", async () => {
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
      (error: unknown) => safeCode(error) === "ENGINE_OOM" &&
        !JSON.stringify(error).includes("heap out of memory"),
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    owned.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor readiness failure preserves an earlier abort and dispatches no frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "hwp-supervisor-abort-first-"));
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
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("supervisor failed after abort");
      },
    });
    await assert.rejects(
      client.run(
        detectRequest("supervisor-abort-first"),
        spoolSnapshot(owned.inputFd, 3),
        { signal: abort.signal, deadlineMs: 5_000 },
      ),
      (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
    );
    assert.equal(dispatches, 0);
    assert.deepEqual(readdirSync(root), []);
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
          if (!allowGone || descendantPid === undefined) return false;
          try { process.kill(descendantPid, "SIGKILL"); } catch {}
          await waitUntilProcessIsGone(descendantPid);
          return true;
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
          (spawned?.pid === undefined || !isPidAlive(spawned.pid)),
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
      { deadlineMs: 1_000 },
    );
    const secondSnapshot = spoolSnapshot(secondOwned.inputFd, 3);
    const second = childClient("success", gate).run(
      detectRequest("child-gate-second"),
      secondSnapshot,
      { signal: abort.signal, deadlineMs: 1_000 },
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
      { deadlineMs: 1_000 },
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
      (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
    );
    assert.equal(snapshot.cleanupCalls, 1);
    assert.deepEqual(readdirSync(root), []);
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition was not met before deadline");
}

function safeCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
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
