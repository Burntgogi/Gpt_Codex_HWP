import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import test from "node:test";

import {
  createDocumentWorkerClient,
  DOCUMENT_WORKER_RESOURCE_LIMITS,
} from "../src/workers/document-worker-client.js";
import {
  CHILD_WORKING_SET_MAX_BYTES,
  HeavyChildGate,
  createIsolatedDocumentEngine,
  defaultDocumentDeadlineMs,
  selectDocumentExecution,
} from "../src/workers/document-execution-policy.js";
import * as executionPolicyModule from "../src/workers/document-execution-policy.js";
import type { WorkerDocumentSnapshot } from "../src/shared/document-snapshot.js";

const fixtureUrl = new URL("./fixtures/workers/engine-test-worker.mjs", import.meta.url);

test("document worker client returns an exact result, detaches input, and cleans once", async () => {
  const snapshot = workerSnapshot(new Uint8Array([1, 2, 3]).buffer);
  const result = await workerClient("success").run(detectRequest("worker-success"), snapshot);
  assert.deepEqual(result, { format: "unknown" });
  assert.equal(snapshot.observedBuffer.byteLength, 0);
  assert.equal(snapshot.cleanupCalls, 1);
  assert.deepEqual(DOCUMENT_WORKER_RESOURCE_LIMITS, {
    maxOldGenerationSizeMb: 768,
    maxYoungGenerationSizeMb: 64,
    codeRangeSizeMb: 64,
    stackSizeMb: 8,
  });
});

test("document worker client captures worker stdout and stderr instead of inheriting MCP stdio", async () => {
  let captured: Parameters<typeof Worker>[1] | undefined;
  const client = createDocumentWorkerClient({
    workerFactory: (options) => {
      captured = options;
      return new Worker(fixtureUrl, { ...options, workerData: { mode: "success" } });
    },
  });
  await client.run(
    detectRequest("worker-captured-stdio"),
    workerSnapshot(new ArrayBuffer(1)),
  );
  assert.equal(captured?.stdout, true);
  assert.equal(captured?.stderr, true);
});

test("document worker client forwards only validated monotonic progress", async () => {
  const progress: Array<[number, number]> = [];
  const result = await workerClient("progress").run(
    detectRequest("worker-progress"),
    workerSnapshot(new ArrayBuffer(1)),
    { onProgress: (completed, total) => progress.push([completed, total]) },
  );
  assert.deepEqual(result, { format: "unknown" });
  assert.deepEqual(progress, [[1, 3], [2, 3]]);
});

test("document worker client supports every path-free logical operation", async () => {
  const requests = [
    detectRequest("all-detect"),
    { protocolVersion: 1, requestId: "all-parse", operation: "parse", input: {}, options: {} },
    { protocolVersion: 1, requestId: "all-render", operation: "render", input: {}, options: {} },
    { protocolVersion: 1, requestId: "all-generate", operation: "generateHwpx", input: { markdown: "# test" }, options: {} },
    { protocolVersion: 1, requestId: "all-patch", operation: "patchHwpx", input: { markdown: "patch" }, options: {} },
    { protocolVersion: 1, requestId: "all-fill", operation: "fillHwpx", input: { fields: { name: "value" } }, options: {} },
    { protocolVersion: 1, requestId: "all-validate", operation: "validateHwpx", input: {}, options: {} },
    { protocolVersion: 1, requestId: "all-image", operation: "insertImage", input: { anchorText: "anchor" }, options: {} },
  ] as const;
  for (const request of requests) {
    const snapshot = request.operation === "generateHwpx"
      ? undefined
      : workerSnapshot(new ArrayBuffer(1));
    const image = request.operation === "insertImage"
      ? { imageInput: { transport: "buffer" as const, buffer: new ArrayBuffer(1) } }
      : {};
    await assert.doesNotReject(
      workerClient("success").run(request as never, snapshot, image),
      request.operation,
    );
  }
});

test("document worker client maps pre-ready crash, post-ready crash, OOM, and malformed events", async () => {
  for (const [mode, code] of [
    ["crash-before-ready", "ENGINE_INIT_FAILED"],
    ["failure-before-ready", "ENGINE_INIT_FAILED"],
    ["crash-after-ready", "ENGINE_CRASH"],
    ["oom", "ENGINE_OOM"],
    ["malformed", "ENGINE_PROTOCOL_ERROR"],
  ] as const) {
    await assert.rejects(
      workerClient(mode).run(detectRequest(`worker-${mode}`), workerSnapshot(new ArrayBuffer(1))),
      (error: unknown) => safeCode(error) === code && !JSON.stringify(error).includes("private"),
    );
    assert.deepEqual(
      await workerClient("success").run(
        detectRequest(`worker-recovery-${mode}`),
        workerSnapshot(new ArrayBuffer(1)),
      ),
      { format: "unknown" },
    );
  }
});

test("document worker client rejects an invalid deadline before dispatch and still cleans", async () => {
  let dispatches = 0;
  const snapshot = workerSnapshot(new ArrayBuffer(1));
  const client = createDocumentWorkerClient({
    workerFactory: () => {
      dispatches += 1;
      return new Worker(fixtureUrl, { workerData: { mode: "success" } });
    },
  });
  await assert.rejects(
    client.run(detectRequest("worker-invalid-deadline"), snapshot, { deadlineMs: 0 }),
    (error: unknown) => safeCode(error) === "ENGINE_RESOURCE_LIMIT",
  );

  assert.deepEqual(
    await workerClient("success").run(
      detectRequest("worker-after-timeout"),
      workerSnapshot(new ArrayBuffer(1)),
    ),
    { format: "unknown" },
  );
  assert.equal(dispatches, 0);
  assert.equal(snapshot.cleanupCalls, 1);
});

test("document worker client rejects operation-incompatible snapshots before factory dispatch", async () => {
  let dispatches = 0;
  const client = createDocumentWorkerClient({
    workerFactory: () => {
      dispatches += 1;
      return new Worker(fixtureUrl, { workerData: { mode: "success" } });
    },
  });
  const spool = fakeSpoolSnapshot();
  await assert.rejects(
    client.run(detectRequest("worker-wrong-spool") as never, spool as never),
    (error: unknown) => safeCode(error) === "ENGINE_PROTOCOL_ERROR",
  );
  const generationSnapshot = workerSnapshot(new ArrayBuffer(1));
  await assert.rejects(
    client.run(
      {
        protocolVersion: 1,
        requestId: "worker-generate-with-source",
        operation: "generateHwpx",
        input: { markdown: "# test" },
        options: {},
      } as never,
      generationSnapshot as never,
    ),
    (error: unknown) => safeCode(error) === "ENGINE_PROTOCOL_ERROR",
  );
  assert.equal(dispatches, 0);
  assert.equal(spool.cleanupCalls, 1);
  assert.equal(generationSnapshot.cleanupCalls, 1);
});

test("document worker client rejects pre-abort without dispatch and maps timeout/cancel", async () => {
  const pre = new AbortController();
  pre.abort();
  let dispatches = 0;
  const noDispatch = createDocumentWorkerClient({
    workerFactory: () => {
      dispatches += 1;
      return new Worker(fixtureUrl, { workerData: { mode: "success" } });
    },
  });
  await assert.rejects(
    noDispatch.run(detectRequest("worker-pre-abort"), workerSnapshot(new ArrayBuffer(1)), {
      signal: pre.signal,
    }),
    (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
  );
  assert.equal(dispatches, 0);

  await assert.rejects(
    workerClient("slow", 200).run(
      detectRequest("worker-timeout"),
      workerSnapshot(new ArrayBuffer(1)),
      { deadlineMs: 20 },
    ),
    (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
  );

  const active = new AbortController();
  const pending = workerClient("ignore-abort", 500).run(
    detectRequest("worker-cancel"),
    workerSnapshot(new ArrayBuffer(1)),
    { signal: active.signal, deadlineMs: 1_000 },
  );
  setTimeout(() => active.abort(), 20);
  await assert.rejects(pending, (error: unknown) => safeCode(error) === "REQUEST_CANCELLED");
  assert.deepEqual(
    await workerClient("success").run(
      detectRequest("worker-after-cancel"),
      workerSnapshot(new ArrayBuffer(1)),
    ),
    { format: "unknown" },
  );
});

test("document worker client closes the factory-to-listener abort gap", async () => {
  const abort = new AbortController();
  const snapshot = workerSnapshot(new ArrayBuffer(1));
  const client = createDocumentWorkerClient({
    workerFactory: (options) => {
      abort.abort();
      return new Worker(fixtureUrl, {
        ...options,
        workerData: { mode: "success" },
      });
    },
  });
  await assert.rejects(
    client.run(detectRequest("worker-factory-abort"), snapshot, {
      signal: abort.signal,
    }),
    (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
  );
  assert.equal(snapshot.takeCalls, 0);
  assert.equal(snapshot.cleanupCalls, 1);
});

test("document worker deadline includes factory startup and prevents postMessage", async () => {
  let posts = 0;
  const snapshot = workerSnapshot(new ArrayBuffer(1));
  const client = createDocumentWorkerClient({
    workerFactory: (options) => {
      const worker = new Worker(fixtureUrl, {
        ...options,
        workerData: { mode: "slow", delayMs: 1_000 },
      });
      const post = worker.postMessage.bind(worker);
      worker.postMessage = ((...args: Parameters<typeof worker.postMessage>) => {
        posts += 1;
        return post(...args);
      }) as typeof worker.postMessage;
      const until = Date.now() + 50;
      while (Date.now() < until) {}
      return worker;
    },
  });
  await assert.rejects(
    client.run(detectRequest("worker-startup-deadline"), snapshot, { deadlineMs: 20 }),
    (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
  );
  assert.equal(posts, 0);
  assert.equal(snapshot.takeCalls, 0);
  assert.equal(snapshot.cleanupCalls, 1);
});

test("worker factory failures preserve abort and deadline precedence", async () => {
  const abort = new AbortController();
  const abortedSnapshot = workerSnapshot(new ArrayBuffer(1));
  const abortedClient = createDocumentWorkerClient({
    workerFactory: () => {
      abort.abort();
      throw new Error("factory failed");
    },
  });
  await assert.rejects(
    abortedClient.run(detectRequest("worker-factory-aborted"), abortedSnapshot, {
      signal: abort.signal,
    }),
    (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
  );
  assert.equal(abortedSnapshot.cleanupCalls, 1);

  const expiredSnapshot = workerSnapshot(new ArrayBuffer(1));
  const expiredClient = createDocumentWorkerClient({
    workerFactory: () => {
      const until = Date.now() + 30;
      while (Date.now() < until) {}
      throw new Error("factory failed");
    },
  });
  await assert.rejects(
    expiredClient.run(detectRequest("worker-factory-expired"), expiredSnapshot, {
      deadlineMs: 10,
    }),
    (error: unknown) => safeCode(error) === "ENGINE_TIMEOUT",
  );
  assert.equal(expiredSnapshot.cleanupCalls, 1);
});

test("worker termination rejection has priority over a successful result", async () => {
  const snapshot = workerSnapshot(new ArrayBuffer(1));
  const client = createDocumentWorkerClient({
    workerFactory: (options) => {
      const worker = new Worker(fixtureUrl, {
        ...options,
        workerData: { mode: "success" },
      });
      const terminate = worker.terminate.bind(worker);
      worker.terminate = async () => {
        await terminate();
        throw new Error("termination receipt unavailable");
      };
      return worker;
    },
  });
  await assert.rejects(
    client.run(detectRequest("worker-terminate-reject"), snapshot),
    (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
  );
  assert.equal(snapshot.cleanupCalls, 0);
});

test("worker delayed termination retains transferred ownership until confirmed", async () => {
  let confirmTermination: ((value: number) => void) | undefined;
  const snapshot = workerSnapshot(new ArrayBuffer(1));
  const client = createDocumentWorkerClient({
    terminationDeadlineMs: 20,
    workerFactory: (options) => {
      const worker = new Worker(fixtureUrl, {
        ...options,
        workerData: { mode: "success" },
      });
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => new Promise<number>((resolve) => {
        confirmTermination = async (value: number) => {
          await terminate();
          resolve(value);
        };
      });
      return worker;
    },
  } as never);
  await assert.rejects(
    client.run(detectRequest("worker-terminate-delayed"), snapshot),
    (error: unknown) => safeCode(error) === "ENGINE_TERMINATION_FAILED",
  );
  assert.equal(snapshot.cleanupCalls, 0);
  confirmTermination!(0);
  await waitFor(() => snapshot.cleanupCalls === 1);
});

test("document worker client settles once and ignores late events", async () => {
  const result = await workerClient("late-result").run(
    detectRequest("worker-late"),
    workerSnapshot(new ArrayBuffer(1)),
  );
  assert.deepEqual(result, { format: "unknown" });
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("document worker client removes its sole abort listener on success", async () => {
  const observed = countingSignal();
  await workerClient("success").run(
    detectRequest("worker-listener-cleanup"),
    workerSnapshot(new ArrayBuffer(1)),
    { signal: observed.signal },
  );
  assert.deepEqual(observed.counts, { added: 1, removed: 1 });
});

test("document execution policy has fixed deadlines, thresholds, and pre-dispatch refusal", async () => {
  assert.equal(defaultDocumentDeadlineMs("detect"), 60_000);
  assert.equal(defaultDocumentDeadlineMs("parse"), 60_000);
  assert.equal(defaultDocumentDeadlineMs("validateHwpx"), 60_000);
  assert.equal(defaultDocumentDeadlineMs("render"), 300_000);
  assert.equal(defaultDocumentDeadlineMs("insertImage"), 300_000);
  assert.equal(
    selectDocumentExecution({
      operation: "detect",
      snapshotTransport: "worker",
      inputBytes: 64 * 1024 * 1024,
      estimatedWorkingSetBytes: CHILD_WORKING_SET_MAX_BYTES,
      executionClass: "worker-safe",
    }),
    "worker",
  );
  assert.equal(
    selectDocumentExecution({
      operation: "detect",
      snapshotTransport: "spool",
      inputBytes: 64 * 1024 * 1024 + 1,
      estimatedWorkingSetBytes: CHILD_WORKING_SET_MAX_BYTES,
      executionClass: "worker-safe",
    }),
    "child",
  );
  assert.throws(
    () => selectDocumentExecution({
      operation: "detect",
      snapshotTransport: "worker",
      inputBytes: 1,
      estimatedWorkingSetBytes: CHILD_WORKING_SET_MAX_BYTES + 1,
      executionClass: "heavy",
    }),
    (error: unknown) => safeCode(error) === "ENGINE_RESOURCE_LIMIT",
  );
  assert.throws(
    () => selectDocumentExecution({
      operation: "insertImage",
      snapshotTransport: "worker",
      inputBytes: 1,
      estimatedWorkingSetBytes: 3,
      executionClass: "heavy",
    }),
    (error: unknown) => safeCode(error) === "ENGINE_RESOURCE_LIMIT",
  );
  assert.throws(
    () => selectDocumentExecution({
      operation: "insertImage",
      snapshotTransport: "worker",
      inputBytes: 64 * 1024 * 1024,
      imageBytes: 25 * 1024 * 1024,
      logicalBytes: 6,
      estimatedWorkingSetBytes: 300 * 1024 * 1024,
      executionClass: "worker-safe",
    } as never),
    (error: unknown) => safeCode(error) === "ENGINE_RESOURCE_LIMIT",
  );
  assert.throws(
    () => selectDocumentExecution({
      operation: "detect",
      snapshotTransport: "worker",
      inputBytes: Number.MAX_SAFE_INTEGER,
      imageBytes: 1,
      logicalBytes: 1,
      estimatedWorkingSetBytes: 1,
      executionClass: "worker-safe",
    } as never),
    (error: unknown) => safeCode(error) === "ENGINE_RESOURCE_LIMIT",
  );
});

test("logical request bytes are reserved before choosing worker or child snapshot transport", () => {
  const policy = executionPolicyModule as unknown as {
    documentLogicalRequestBytes?: (request: { input: unknown; options: unknown }) => number;
    maxWorkerSnapshotBytesForRequest?: (
      request: { input: unknown; options: unknown },
      imageBytes?: number,
    ) => number;
  };
  assert.equal(typeof policy.documentLogicalRequestBytes, "function");
  assert.equal(typeof policy.maxWorkerSnapshotBytesForRequest, "function");
  const logicalRequest = { input: { markdown: "patch" }, options: {} };
  const logicalBytes = policy.documentLogicalRequestBytes!(logicalRequest);
  const snapshotBudget = policy.maxWorkerSnapshotBytesForRequest!(logicalRequest);
  assert.equal(snapshotBudget + logicalBytes, 64 * 1024 * 1024);
  assert.equal(
    selectDocumentExecution({
      operation: "patchHwpx",
      executionClass: "worker-safe",
      snapshotTransport: "worker",
      inputBytes: snapshotBudget,
      logicalBytes,
      estimatedWorkingSetBytes: (snapshotBudget + logicalBytes) * 3,
    }),
    "worker",
  );
  assert.equal(
    selectDocumentExecution({
      operation: "patchHwpx",
      executionClass: "worker-safe",
      snapshotTransport: "spool",
      inputBytes: snapshotBudget + 1,
      logicalBytes,
      estimatedWorkingSetBytes: (snapshotBudget + logicalBytes + 1) * 3,
    }),
    "child",
  );
});

test("hybrid engine cannot override insertImage native-heavy routing to worker-safe", async () => {
  let workerRuns = 0;
  let childRuns = 0;
  const snapshot = workerSnapshot(new ArrayBuffer(1));
  const engine = createIsolatedDocumentEngine({
    workerClient: { run: async () => { workerRuns += 1; return { bytes: new ArrayBuffer(0) }; } },
    childClient: { run: async () => { childRuns += 1; return { bytes: new ArrayBuffer(0) }; } },
  });
  await assert.rejects(
    engine.run(
      {
        protocolVersion: 1,
        requestId: "image-heavy-override",
        operation: "insertImage",
        input: { anchorText: "anchor" },
        options: {},
      },
      snapshot,
      {
        executionClass: "worker-safe",
        imageInput: { transport: "buffer", buffer: new ArrayBuffer(1) },
      },
    ),
    (error: unknown) => safeCode(error) === "ENGINE_RESOURCE_LIMIT",
  );
  assert.equal(workerRuns, 0);
  assert.equal(childRuns, 0);
  assert.equal(snapshot.cleanupCalls, 1);
});

test("hybrid engine refuses resources before dispatch and cleans its snapshot", async () => {
  let workerRuns = 0;
  let childRuns = 0;
  const engine = createIsolatedDocumentEngine({
    workerClient: { run: async () => { workerRuns += 1; return { format: "unknown" }; } },
    childClient: { run: async () => { childRuns += 1; return { format: "unknown" }; } },
    heavyChildGate: new HeavyChildGate(),
  });
  const snapshot = workerSnapshot(new ArrayBuffer(1));
  await assert.rejects(
    engine.run(detectRequest("resource-refusal"), snapshot, {
      executionClass: "heavy",
      estimatedWorkingSetBytes: CHILD_WORKING_SET_MAX_BYTES + 1,
    }),
    (error: unknown) => safeCode(error) === "ENGINE_RESOURCE_LIMIT",
  );
  assert.equal(workerRuns, 0);
  assert.equal(childRuns, 0);
  assert.equal(snapshot.cleanupCalls, 1);
});

test("hybrid engine cannot lower the aggregate working-set estimate", async () => {
  let childRuns = 0;
  const snapshot = fakeSpoolSnapshot(512 * 1024 * 1024);
  const engine = createIsolatedDocumentEngine({
    workerClient: { run: async () => ({ bytes: new ArrayBuffer(0) }) },
    childClient: {
      run: async () => {
        childRuns += 1;
        return { bytes: new ArrayBuffer(0) };
      },
    },
  });
  await assert.rejects(
    engine.run(
      {
        protocolVersion: 1,
        requestId: "aggregate-estimate-floor",
        operation: "insertImage",
        input: { anchorText: "anchor" },
        options: {},
      },
      snapshot,
      {
        estimatedWorkingSetBytes: 0,
        imageInput: {
          transport: "spool",
          fd: 4,
          sizeBytes: 25 * 1024 * 1024,
        },
      },
    ),
    (error: unknown) => safeCode(error) === "ENGINE_RESOURCE_LIMIT",
  );
  assert.equal(childRuns, 0);
  assert.equal(snapshot.cleanupCalls, 1);
});

test("hybrid engine cleans a spool snapshot when its external gate wait aborts", async () => {
  const gate = new HeavyChildGate();
  const release = await gate.acquire();
  const abort = new AbortController();
  const snapshot = fakeSpoolSnapshot();
  const engine = createIsolatedDocumentEngine({
    workerClient: { run: async () => ({ format: "unknown" }) },
    childClient: { run: async () => ({ format: "unknown" }) },
    heavyChildGate: gate,
  });
  const pending = engine.run(detectRequest("hybrid-gate-abort"), snapshot, {
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(
    pending,
    (error: unknown) => safeCode(error) === "REQUEST_CANCELLED",
  );
  assert.equal(snapshot.cleanupCalls, 1);
  release();
});

function workerClient(mode: string, delayMs = 250) {
  return createDocumentWorkerClient({
    workerFactory: (options) => new Worker(fixtureUrl, {
      ...options,
      workerData: { mode, delayMs },
    }),
  });
}

function detectRequest(requestId: string) {
  return { protocolVersion: 1, requestId, operation: "detect", input: {}, options: {} } as const;
}

function workerSnapshot(buffer: ArrayBuffer): WorkerDocumentSnapshot & {
  readonly observedBuffer: ArrayBuffer;
  takeCalls: number;
  cleanupCalls: number;
} {
  let taken = false;
  return {
    transport: "worker",
    metadata: {
      sizeBytes: buffer.byteLength,
      sha256: "0".repeat(64),
      shallowFormat: { candidate: "unknown", container: "unknown", exact: false },
      protection: { status: "requires-engine-validation", candidateFormat: "unknown", exact: false },
    },
    observedBuffer: buffer,
    takeCalls: 0,
    cleanupCalls: 0,
    takeTransferable() {
      this.takeCalls += 1;
      if (taken) throw new Error("taken");
      taken = true;
      return buffer;
    },
    async verifySourceUnchanged() {},
    async cleanup() { this.cleanupCalls += 1; },
  };
}

function safeCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function fakeSpoolSnapshot(sizeBytes = 1) {
  return {
    transport: "spool" as const,
    metadata: {
      sizeBytes,
      sha256: "0".repeat(64),
      shallowFormat: { candidate: "unknown" as const, container: "unknown" as const, exact: false as const },
      protection: { status: "requires-engine-validation" as const, candidateFormat: "unknown" as const, exact: false as const },
    },
    cleanupCalls: 0,
    takeSpoolHandle() { return { fd: 3, sizeBytes }; },
    async verifySourceUnchanged() {},
    async cleanup() { this.cleanupCalls += 1; },
  };
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before deadline");
}
