import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCanonicalTemporaryDirectory } from "../../../scripts/canonical-temp.mjs";

import type {
  DocumentEngineExecutionContext,
  DocumentEngineFacade,
} from "../src/shared/document-engine.js";
import type {
  DocumentSnapshot,
  SpoolDocumentSnapshot,
  WorkerDocumentSnapshot,
} from "../src/shared/document-snapshot.js";
import { createMcpServer } from "../src/mcp-main.js";
import {
  createToolExecutionContext,
  runWithToolExecutionContext,
} from "../src/shared/tool-context.js";
import { writeDocumentRenderResultExclusively } from "../src/shared/document-render-output.js";
import { registerHwpCreateSvgAsset } from "../src/tools/assets.js";
import { registerHwpDetectFormat } from "../src/tools/detect.js";
import { handleHwpRead } from "../src/tools/read.js";
import { createDocumentChildClient } from "../src/workers/document-child-client.js";
import { createDocumentWorkerClient } from "../src/workers/document-worker-client.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const HWP_FIXTURE = join(
  FIXTURE_ROOT,
  "rhwp",
  "re-01-hangul-only-hancom.hwp",
);
const WORKER_FIXTURE = new URL(
  "./fixtures/workers/engine-test-worker.mjs",
  import.meta.url,
);
const CHILD_FIXTURE = fileURLToPath(new URL(
  "./fixtures/workers/engine-test-child.mjs",
  import.meta.url,
));
const MAX_PROGRESS = 1_000_000;
const ALLOWED_MESSAGES = new Set([
  "Starting document operation.",
  "Processing document.",
  "Document operation complete.",
]);

test("MCP progress clamps hostile numeric input and rejects hostile stages", async () => {
  const notifications: Array<Readonly<Record<string, unknown>>> = [];
  const context = createToolExecutionContext({
    signal: new AbortController().signal,
    _meta: {
      progressToken: "edge-token",
      privatePath: "C:\\private\\document.hwpx",
    },
    sendNotification: async (notification) => {
      notifications.push(notification.params);
    },
  } as never);
  await (context.reportProgress as (
    stage: string,
    progress: number,
    total?: number,
  ) => Promise<void>)("HOSTILE_DOCUMENT_TEXT", 1, 2);
  await context.reportProgress("processing", Number.NaN, 2);
  await context.reportProgress("processing", Number.POSITIVE_INFINITY, 2);
  await context.reportProgress("processing", -4.8, 3.9);
  await context.reportProgress("processing", 2.9, 4.9);
  await context.reportProgress("processing", 2.1, 4.9);
  await context.reportProgress("processing", 1.9, 4.9);
  await context.reportProgress("processing", 3.9, 3.9);
  await context.reportProgress(
    "processing",
    Number.MAX_VALUE,
    Number.MAX_VALUE,
  );
  assert.deepEqual(
    notifications.map(({ progress, total }) => [progress, total]),
    [[0, 3], [2, 4], [MAX_PROGRESS, MAX_PROGRESS]],
  );
  assert.doesNotMatch(
    JSON.stringify(notifications),
    /HOSTILE_DOCUMENT_TEXT|private|document\.hwpx/iu,
  );
});

test("MCP progress notification rejection yields to request abort", async () => {
  const abort = new AbortController();
  let sends = 0;
  const context = createToolExecutionContext({
    signal: abort.signal,
    _meta: { progressToken: 91 },
    sendNotification: async () => {
      sends += 1;
      abort.abort();
      throw new Error("notification failure with PRIVATE_DOCUMENT_TEXT");
    },
  } as never);
  await assert.rejects(
    context.reportProgress("starting", 0),
    (error: unknown) => errorCode(error) === "REQUEST_CANCELLED",
  );
  await assert.rejects(
    context.reportProgress("processing", 1, 2),
    (error: unknown) => errorCode(error) === "REQUEST_CANCELLED",
  );
  assert.equal(context.signal.aborted, true);
  assert.equal(sends, 1);

  const wrapperAbort = new AbortController();
  let handlerCalls = 0;
  await assert.rejects(
    runWithToolExecutionContext({
      signal: wrapperAbort.signal,
      _meta: { progressToken: 92 },
      sendNotification: async () => {
        wrapperAbort.abort();
        throw new Error("notification failed");
      },
    } as never, async () => {
      handlerCalls += 1;
      return undefined;
    }),
    (error: unknown) => errorCode(error) === "REQUEST_CANCELLED",
  );
  assert.equal(handlerCalls, 0);
});

test("MCP cancellation reaches the preview exclusive-open boundary", async (t) => {
  const directory = await createCanonicalTemporaryDirectory({
    prefix: "hwp-mcp-preview-cancel-",
  });
  const outputPath = join(directory, "preview.svg");
  const abort = new AbortController();
  let failureStage = "setup";
  try {
    failureStage = "rejection";
    await assert.rejects(
      writeDocumentRenderResultExclusively({
        payload: { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" },
        async verifySourceUnchanged() {},
      }, outputPath, {
        signal: abort.signal,
        beforeOpen: async () => {
          failureStage = "cancellation";
          abort.abort();
        },
      }),
      (error: unknown) => errorCode(error) === "REQUEST_CANCELLED",
    );
    failureStage = "output-absence";
    await assert.rejects(access(outputPath));
  } catch (error: unknown) {
    t.diagnostic(`MCP_PREVIEW_CANCELLATION_FAILURE_${failureStage.toUpperCase().replaceAll("-", "_")}`);
    throw error;
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error: unknown) {
      t.diagnostic("MCP_PREVIEW_CANCELLATION_FAILURE_CLEANUP");
      throw error;
    }
  }
});

test("MCP cancellation precedes read output_dir creation with zero images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hwp-mcp-read-cancel-"));
  const outputDir = join(directory, "must-not-exist");
  const abort = new AbortController();
  try {
    const result = await handleHwpRead({
      file_path: HWP_FIXTURE,
      extract_images: true,
      output_dir: outputDir,
    }, {
      async parse(snapshot) {
        const metadata = snapshot.metadata;
        await snapshot.cleanup();
        abort.abort();
        return {
          payload: {
            fileType: "hwp",
            markdown: "",
            images: [],
          },
          snapshotMetadata: metadata,
        };
      },
    } as unknown as DocumentEngineFacade, {
      signal: abort.signal,
      async reportProgress() {},
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /REQUEST_CANCELLED/u);
    await assert.rejects(access(outputDir));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP progress statically preserves args and extra in all nine registrations", async () => {
  const toolSources = await Promise.all([
    "assets.ts",
    "detect.ts",
    "patch.ts",
    "preview.ts",
    "read.ts",
    "write.ts",
  ].map((name) => readFile(new URL(`../src/tools/${name}`, import.meta.url), "utf8")));
  assert.equal(
    toolSources.join("\n").match(/\(args, extra\)\s*=>/gu)?.length,
    9,
  );
  assert.doesNotMatch(toolSources.join("\n"), /\(args\)\s*=>\s*handleHwp/gu);
});

test("MCP progress behavior covers all nine public registrations", async () => {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "task-7-all-tools", version: "0.0.0" });
  const notifications: Array<Readonly<Record<string, unknown>>> = [];
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const originalOnMessage = clientTransport.onmessage;
  clientTransport.onmessage = (message, extra) => {
    if (message.method === "notifications/progress") {
      notifications.push(message.params);
      return;
    }
    originalOnMessage?.(message, extra);
  };
  const missing = join(tmpdir(), "task-7-missing-document.hwpx");
  const calls = [
    ["hwp_detect_format", { file_path: missing }],
    ["hwp_read", { file_path: missing }],
    ["hwp_generate_hwpx", { markdown: "x", output_path: `${missing}.hwp` }],
    ["hwp_validate", { file_path: missing }],
    ["hwp_render_preview", { file_path: missing, output_svg_path: `${missing}.svg` }],
    ["hwp_patch_document", { file_path: missing, edited_markdown: "x", output_path: missing }],
    ["hwp_fill_form", { file_path: missing, fields: {}, output_path: missing }],
    ["hwp_create_svg_asset", { prompt_or_spec: "not-json", output_svg_path: `${missing}.svg` }],
    ["hwp_insert_image", {
      file_path: missing,
      image_path: `${missing}.png`,
      output_path: missing,
      anchor_text: "anchor",
    }],
  ] as const;

  try {
    for (const [index, [name, args]] of calls.entries()) {
      const token = `all-nine-${index}`;
      const before = notifications.length;
      await client.callTool({ name, arguments: args, _meta: { progressToken: token } });
      const current = notifications.slice(before);
      assert.deepEqual(current.map((item) => item.progressToken), [token, token]);
      assert.deepEqual(current.map((item) => item.progress), [0, MAX_PROGRESS]);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP cancellation before the authorization boundary creates no output", async () => {
  const root = await mkdtemp(join(tmpdir(), "hwp-mcp-cancel-output-"));
  const outputPath = join(root, "cancelled.svg");
  let releaseValidation!: () => void;
  let markValidationStarted!: () => void;
  const validationStarted = new Promise<void>((resolve) => {
    markValidationStarted = resolve;
  });
  const validationRelease = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  const server = new McpServer({ name: "task-7-output", version: "0.0.0" });
  registerHwpCreateSvgAsset(server, {
    validateSvg: async () => {
      markValidationStarted();
      await validationRelease;
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "task-7-output-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const abort = new AbortController();

  try {
    const running = client.callTool(
      {
        name: "hwp_create_svg_asset",
        arguments: {
          prompt_or_spec: JSON.stringify({ width: 10, height: 10, elements: [] }),
          output_svg_path: outputPath,
        },
      },
      undefined,
      { signal: abort.signal, timeout: 2_000 },
    );
    await validationStarted;
    abort.abort();
    releaseValidation();
    await assert.rejects(running, /abort/iu);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(readFile(outputPath), /ENOENT/u);
    const recovered = await client.listTools();
    assert.equal(recovered.tools.length, 1);
  } finally {
    releaseValidation();
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP progress preserves the caller token and filters unsafe reports", async () => {
  const facade = facadeWithDetect(async (snapshot, context) => {
    context?.onProgress?.(Number.NaN, 3);
    context?.onProgress?.(-5, 3);
    context?.onProgress?.(2, 4);
    context?.onProgress?.(2, 4);
    context?.onProgress?.(1, 4);
    context?.onProgress?.(8, 4);
    context?.onProgress?.(Number.MAX_VALUE, Number.MAX_VALUE);
    return finishDetect(snapshot);
  });
  const connection = await connectDetectServer(facade);
  const notifications: Array<Readonly<Record<string, unknown>>> = [];
  const originalOnMessage = connection.clientTransport.onmessage;
  connection.clientTransport.onmessage = (message, extra) => {
    if (message.method === "notifications/progress") {
      notifications.push(message.params);
      return;
    }
    originalOnMessage?.(message, extra);
  };

  try {
    const result = await connection.client.callTool({
      name: "hwp_detect_format",
      arguments: { file_path: HWP_FIXTURE },
      _meta: {
        progressToken: "caller-token-7",
        privateDocumentText: "MUST_NOT_ESCAPE",
      },
    });
    assert.equal(result.isError, false);
    assert.ok(notifications.length >= 2);
    assert.ok(notifications.every((notification) =>
      notification.progressToken === "caller-token-7"));
    assert.ok(notifications.every((notification) =>
      typeof notification.progress === "number" &&
      Number.isSafeInteger(notification.progress) &&
      notification.progress >= 0 &&
      notification.progress <= MAX_PROGRESS));
    assert.ok(notifications.every((notification) =>
      notification.total === undefined ||
      (typeof notification.total === "number" &&
        Number.isSafeInteger(notification.total) &&
        notification.total >= 0 &&
        notification.total <= MAX_PROGRESS &&
        Number(notification.progress) <= notification.total)));
    assert.ok(notifications.every((notification) =>
      typeof notification.message === "string" &&
      ALLOWED_MESSAGES.has(notification.message)));
    for (let index = 1; index < notifications.length; index += 1) {
      assert.ok(
        Number(notifications[index]!.progress) >
          Number(notifications[index - 1]!.progress),
        "duplicate or regressing progress escaped",
      );
    }
    assert.doesNotMatch(JSON.stringify(notifications), /MUST_NOT_ESCAPE|re-01/iu);
  } finally {
    await connection.close();
  }
});

for (const engine of ["worker", "supervised child"] as const) {
  test(`MCP cancellation reaches a running ${engine} and the server recovers`, async (t) => {
    const enterRunningChildStage = (stage: string): void => {
      if (engine === "supervised child") {
        t.diagnostic(`MCP_RUNNING_CHILD_STAGE_${stage}`);
      }
    };
    enterRunningChildStage("SETUP");
    let observedSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const isolated = isolatedCancellationFacade(engine, () => resolveStarted());
    enterRunningChildStage("ISOLATION_READY");
    const facade = facadeWithDetect(async (snapshot, context) => {
      observedSignal = context?.signal;
      return isolated.facade.detect(snapshot, context);
    });
    const connection = await connectDetectServer(facade);
    enterRunningChildStage("CONNECTION_READY");
    const abort = new AbortController();
    let bodyCompleted = false;

    try {
      const running = connection.client.callTool(
        {
          name: "hwp_detect_format",
          arguments: { file_path: HWP_FIXTURE },
        },
        undefined,
        { signal: abort.signal, timeout: 5_000 },
      );
      enterRunningChildStage("REQUEST_ISSUED");
      let firstStartObserved = false;
      let startTimer: NodeJS.Timeout | undefined;
      const earlySettlement = running.then(
        (result) => {
          if (!firstStartObserved) enterRunningChildStage("REQUEST_RESOLVED_BEFORE_START");
          return Promise.reject(new Error(
            `engine settled before start: ${JSON.stringify(result)}`,
          ));
        },
        (error: unknown) => {
          if (!firstStartObserved) enterRunningChildStage("REQUEST_REJECTED_BEFORE_START");
          return Promise.reject(error);
        },
      );
      const startDeadline = new Promise<never>((_resolve, reject) => {
        startTimer = setTimeout(() => {
          if (!firstStartObserved) enterRunningChildStage("START_TIMEOUT");
          reject(new Error("engine did not start"));
        }, 2_500);
      });
      try {
        await Promise.race([started, earlySettlement, startDeadline]);
        firstStartObserved = true;
      } finally {
        if (startTimer !== undefined) clearTimeout(startTimer);
      }
      enterRunningChildStage("FIRST_START");
      abort.abort();
      await assert.rejects(running, /abort/iu);
      enterRunningChildStage("ABORT_REJECTION");
      assert.equal(observedSignal?.aborted, true);
      enterRunningChildStage("SIGNAL");

      const recovered = await connection.client.callTool({
        name: "hwp_detect_format",
        arguments: { file_path: HWP_FIXTURE },
      });
      enterRunningChildStage("RECOVERY");
      assert.equal(recovered.isError, false);
      assert.equal(isolated.requestCount(), 2);
      assert.equal(isolated.clientCreations(), 1);
      enterRunningChildStage("REUSE");
      await isolated.assertLifecycleClean();
      enterRunningChildStage("LIFECYCLE");
      bodyCompleted = true;
    } finally {
      if (bodyCompleted) enterRunningChildStage("CONNECTION_CLEANUP");
      await connection.close();
      if (bodyCompleted) enterRunningChildStage("FIXTURE_CLEANUP");
      await isolated.cleanup();
      if (bodyCompleted) enterRunningChildStage("CLEANUP_COMPLETE");
    }
  });
}

for (const engine of ["worker", "supervised child"] as const) {
  test(`MCP cancellation recovery survives a real ${engine} crash`, async () => {
    const isolated = isolatedCancellationFacade(
      engine,
      undefined,
      "crash-after-ready",
    );
    const connection = await connectDetectServer(isolated.facade);
    try {
      const crashed = await connection.client.callTool({
        name: "hwp_detect_format",
        arguments: { file_path: HWP_FIXTURE },
      });
      assert.equal(crashed.isError, true);
      assert.doesNotMatch(
        JSON.stringify(crashed),
        /SECRET_DOCUMENT_FRAGMENT|AWS_SECRET_ACCESS_KEY|private\\document/iu,
      );
      const recovered = await connection.client.callTool({
        name: "hwp_detect_format",
        arguments: { file_path: HWP_FIXTURE },
      });
      assert.equal(recovered.isError, false);
      assert.equal(isolated.requestCount(), 2);
      assert.equal(isolated.clientCreations(), 1);
      await isolated.assertLifecycleClean();
    } finally {
      await connection.close();
      await isolated.cleanup();
    }
  });
}

test("MCP progress notification failure is non-fatal while active", async () => {
  const facade = facadeWithDetect(async (snapshot, context) => {
    context?.onProgress?.(1, 2);
    return finishDetect(snapshot);
  });
  const connection = await connectDetectServer(facade);
  const originalOnMessage = connection.clientTransport.onmessage;
  connection.clientTransport.onmessage = (message, extra) => {
    if (message.method === "notifications/progress") {
      throw new Error("synthetic notification delivery failure");
    }
    originalOnMessage?.(message, extra);
  };

  try {
    const result = await connection.client.callTool({
      name: "hwp_detect_format",
      arguments: { file_path: HWP_FIXTURE },
      _meta: { progressToken: 77 },
    });
    assert.equal(result.isError, false);
  } finally {
    await connection.close();
  }
});

test("supervised child fixture mode follows the child entry on every platform", () => {
  assert.deepEqual(
    withChildFixtureMode(["gate", "child", "success", "1000"], "child", "ignore-abort"),
    ["gate", "child", "ignore-abort", "1000"],
  );
  assert.deepEqual(
    withChildFixtureMode(
      ["--import", "gate", "child", "success", "1000"],
      "child",
      "ignore-abort",
    ),
    ["--import", "gate", "child", "ignore-abort", "1000"],
  );
  assert.throws(
    () => withChildFixtureMode(["gate", "success"], "child", "ignore-abort"),
    /fixture arguments/iu,
  );
  assert.throws(
    () => withChildFixtureMode(["child"], "child", "ignore-abort"),
    /fixture arguments/iu,
  );
  assert.throws(
    () => withChildFixtureMode(["child", "success", "child"], "child", "ignore-abort"),
    /fixture arguments/iu,
  );
});

function facadeWithDetect(
  detect: (
    snapshot: DocumentSnapshot,
    context?: DocumentEngineExecutionContext,
  ) => ReturnType<DocumentEngineFacade["detect"]>,
): DocumentEngineFacade {
  return { detect } as unknown as DocumentEngineFacade;
}

async function finishDetect(snapshot: DocumentSnapshot) {
  const metadata = snapshot.metadata;
  try {
    await snapshot.verifySourceUnchanged();
    return { payload: { format: "hwp" as const }, snapshotMetadata: metadata };
  } finally {
    await snapshot.cleanup();
  }
}

async function connectDetectServer(facade: DocumentEngineFacade) {
  const server = new McpServer({ name: "task-7-test", version: "0.0.0" });
  // Task 7 makes the registration seam explicit so an in-memory MCP request
  // exercises the same context adapter as the public server.
  registerHwpDetectFormat(server, facade);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "task-7-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    clientTransport,
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
  };
}

function isolatedCancellationFacade(
  engine: "worker" | "supervised child",
  started?: () => void,
  firstMode?: string,
): {
  facade: DocumentEngineFacade;
  requestCount(): number;
  clientCreations(): number;
  assertLifecycleClean(): Promise<void>;
  cleanup(): Promise<void>;
} {
  let calls = 0;
  let activeMode = "success";
  let snapshotCleanups = 0;
  let firstWorkerExited = false;
  let firstRootPid: number | undefined;
  let firstDescendantPid: number | undefined;
  const spoolRoot = engine === "supervised child"
    ? mkdtempSync(join(tmpdir(), "hwp-mcp-owned-spool-"))
    : undefined;
  const runIsolated = engine === "worker"
    ? (() => {
        const client = createDocumentWorkerClient({
          workerFactory: (workerOptions) => {
            const first = calls === 1;
            const worker = new Worker(WORKER_FIXTURE, {
              ...workerOptions,
              workerData: { mode: activeMode, delayMs: 1_000 },
            });
            if (first) {
              started?.();
              worker.once("exit", () => {
                firstWorkerExited = true;
              });
            }
            return worker;
          },
        });
        return (request: ReturnType<typeof detectRequest>, options: {
          signal?: AbortSignal;
          deadlineMs: number;
          onProgress: (completed: number, total: number) => void;
        }) => client.run(
          request,
          workerSnapshot(new ArrayBuffer(3), () => snapshotCleanups += 1),
          options,
        );
      })()
    : (() => {
        const client = createDocumentChildClient({
          childEntry: CHILD_FIXTURE,
          childArguments: ["success", "1000"],
          spoolRoot,
          spawnFactory: (specification) => {
            const args = withChildFixtureMode(
              specification.args,
              CHILD_FIXTURE,
              activeMode,
            );
            const child = spawn(
              specification.command,
              args,
              specification.options,
            );
            if (calls === 1) {
              firstRootPid = child.pid;
            }
            return child;
          },
        });
        return (request: ReturnType<typeof detectRequest>, options: {
          signal?: AbortSignal;
          deadlineMs: number;
          onProgress: (completed: number, total: number) => void;
        }) => client.run(
          request,
          ownedSpoolSnapshot(() => snapshotCleanups += 1),
          options,
        );
      })();
  const facade = facadeWithDetect(async (sourceSnapshot, context) => {
    calls += 1;
    const metadata = sourceSnapshot.metadata;
    await sourceSnapshot.cleanup();
    const request = detectRequest(
      `mcp-${engine === "worker" ? "worker" : "child"}-${calls}`,
    );
    activeMode = calls === 1
      ? firstMode ?? (engine === "worker" ? "slow" : "ignore-abort")
      : "success";
    if (engine === "supervised child" && activeMode === "crash-after-ready") {
      activeMode = "descendant-then-crash";
    }
    const options = {
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
      deadlineMs: engine === "supervised child" ? 5_000 : 2_000,
      onProgress: (completed: number, total: number) => {
        if (calls === 1 && engine === "supervised child" &&
          total === Number.MAX_SAFE_INTEGER) {
          firstDescendantPid = completed;
        }
        context?.onProgress?.(completed, total);
        started?.();
      },
    };
    const payload = await runIsolated(request, options);
    return {
      payload: payload as { format: "unknown" },
      snapshotMetadata: metadata,
    };
  });
  return {
    facade,
    requestCount: () => calls,
    clientCreations: () => 1,
    async assertLifecycleClean() {
      assert.equal(snapshotCleanups, 2);
      if (engine === "worker") {
        assert.equal(firstWorkerExited, true);
      } else {
        assert.ok(firstRootPid !== undefined && firstRootPid > 0);
        assert.ok(firstDescendantPid !== undefined && firstDescendantPid > 0);
        await waitForProcessGone(firstRootPid);
        await waitForProcessGone(firstDescendantPid);
        assert.deepEqual(await readdir(spoolRoot!), []);
      }
    },
    async cleanup() {
      if (spoolRoot !== undefined) {
        await rm(spoolRoot, { recursive: true, force: true });
      }
    },
  };
}

function withChildFixtureMode(
  args: readonly string[],
  childEntry: string,
  mode: string,
): string[] {
  const childEntryIndex = args.indexOf(childEntry);
  if (childEntryIndex < 0 || childEntryIndex !== args.lastIndexOf(childEntry)
    || childEntryIndex + 1 >= args.length) {
    throw new Error("invalid supervised child fixture arguments");
  }
  const updated = [...args];
  updated[childEntryIndex + 1] = mode;
  return updated;
}

function detectRequest(requestId: string) {
  return {
    protocolVersion: 1,
    requestId,
    operation: "detect",
    input: {},
    options: {},
  } as const;
}

function workerSnapshot(
  buffer: ArrayBuffer,
  cleaned: () => void,
): WorkerDocumentSnapshot {
  let taken = false;
  let cleanupComplete = false;
  return {
    transport: "worker",
    metadata: fixtureMetadata(buffer.byteLength),
    takeTransferable() {
      if (taken) throw new Error("snapshot already consumed");
      taken = true;
      return buffer;
    },
    async verifySourceUnchanged() {},
    async cleanup() {
      if (cleanupComplete) return;
      cleanupComplete = true;
      cleaned();
    },
  };
}

function ownedSpoolSnapshot(cleaned: () => void): SpoolDocumentSnapshot {
  const owned = createOwnedInput();
  let cleanupComplete = false;
  return {
    transport: "spool",
    metadata: fixtureMetadata(3),
    takeSpoolHandle: () => ({ fd: owned.fd, sizeBytes: 3 }),
    async verifySourceUnchanged() {},
    async cleanup() {
      if (cleanupComplete) return;
      cleanupComplete = true;
      owned.cleanup();
      cleaned();
    },
  };
}

function fixtureMetadata(sizeBytes: number) {
  return {
    sizeBytes,
    sha256: "0".repeat(64),
    shallowFormat: {
      candidate: "unknown" as const,
      container: "unknown" as const,
      exact: false as const,
    },
    protection: {
      status: "requires-engine-validation" as const,
      candidateFormat: "unknown" as const,
      exact: false as const,
    },
  };
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

function createOwnedInput() {
  const directory = mkdtempSync(join(tmpdir(), "hwp-mcp-child-"));
  const fd = openSync(join(directory, "input.bin"), "w+");
  return {
    fd,
    cleanup() {
      try { closeSync(fd); } catch {}
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function waitForProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (errorCode(error) === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.fail(`owned process ${pid} remained alive`);
}
