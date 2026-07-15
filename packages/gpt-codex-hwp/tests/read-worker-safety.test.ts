import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import JSZip from "jszip";
import { markdownToHwpx } from "kordoc";

import { openDocumentSnapshot } from "../src/shared/document-snapshot.js";
import { handleHwpDetectFormat } from "../src/tools/detect.js";
import { handleHwpRead } from "../src/tools/read.js";
import { handleHwpRenderPreview } from "../src/tools/preview.js";
import { createDocumentChildClient } from "../src/workers/document-child-client.js";
import { createDocumentEngineRunError } from "../src/workers/document-errors.js";
import { createIsolatedDocumentEngine } from "../src/workers/document-execution-policy.js";
import { createDocumentWorkerClient } from "../src/workers/document-worker-client.js";
import type {
  DocumentEngineOperation,
  DocumentResultPayload,
  LogicalDocumentRequest,
} from "../src/workers/document-protocol.js";

const PACKAGE_ROOT = new URL("../", import.meta.url);
const BUILT_CHILD = new URL("dist/workers/document-child.js", PACKAGE_ROOT);
const BUILT_WORKER = new URL("dist/workers/document-worker.js", PACKAGE_ROOT);

test("read worker safety opens one worker snapshot and sends no path to the engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-worker-"));
  try {
    const sourcePath = join(root, "source.hwpx");
    const source = new Uint8Array(await markdownToHwpx("# 격리 읽기\n\n본문"));
    await writeFile(sourcePath, source);
    const sha256 = digest(source);
    const requests: LogicalDocumentRequest[] = [];
    const metadata: unknown[] = [];
    const engineModule = await loadFacade();
    const facade = engineModule.createDocumentEngineFacade({
      isolatedEngine: recordingEngine(requests, metadata, {
        parse: {
          markdown: "# 격리 읽기\n\n본문",
          fileType: "hwpx",
          warnings: [],
          images: [],
        },
      }),
      requestIdFactory: () => "task5-worker-read",
    });

    const result = await handleHwpRead(
      { file_path: sourcePath, pages: "1" },
      facade,
    );

    assert.equal(result.isError, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.operation, "parse");
    assert.deepEqual(requests[0]?.options, { pages: "1" });
    assert.doesNotMatch(JSON.stringify(requests[0]), /(?:file|source|spool)[_-]?path/iu);
    assert.equal(metadata.length, 1);
    assert.equal((metadata[0] as { sha256: string }).sha256, sha256);
    assert.equal((metadata[0] as { sizeBytes: number }).sizeBytes, source.byteLength);
    assert.equal((metadata[0] as { shallowFormat: { candidate: string } }).shallowFormat.candidate, "hwpx");
    assert.equal((metadata[0] as { protection: { status: string } }).protection.status, "requires-engine-validation");
    assert.equal(digest(await readFile(sourcePath)), sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read worker safety uses shallow unknown metadata without starting an engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-detect-"));
  try {
    const sourcePath = join(root, "unknown.bin");
    await writeFile(sourcePath, "not a document");
    let calls = 0;
    const engineModule = await loadFacade();
    const facade = engineModule.createDocumentEngineFacade({
      isolatedEngine: {
        async run(): Promise<never> {
          calls += 1;
          throw new Error("unknown input must not enter an isolate");
        },
      },
    });

    const result = await handleHwpDetectFormat({ file_path: sourcePath }, facade);

    assert.equal(result.isError, false);
    assert.equal(result.structuredContent?.format, "unknown");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read worker safety returns stable isolate errors and the next call still succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-errors-"));
  try {
    const sourcePath = join(root, "source.hwpx");
    await writeFile(sourcePath, new Uint8Array(await markdownToHwpx("# 오류 격리")));
    let calls = 0;
    const engineModule = await loadFacade();
    const facade = engineModule.createDocumentEngineFacade({
      isolatedEngine: {
        async run(_request: LogicalDocumentRequest, snapshot: { cleanup(): Promise<void> }) {
          calls += 1;
          await snapshot.cleanup();
          if (calls === 1) throw createDocumentEngineRunError("ENGINE_CRASH", { stage: "parse" });
          return {
            markdown: "복구됨",
            fileType: "hwpx",
            warnings: [],
            images: [],
          };
        },
      } as never,
      requestIdFactory: () => `task5-error-${calls}`,
    });

    const failed = await handleHwpRead({ file_path: sourcePath }, facade);
    const succeeded = await handleHwpRead({ file_path: sourcePath }, facade);

    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent?.code, "ENGINE_CRASH");
    assert.equal(
      failed.structuredContent?.error,
      "The document engine stopped unexpectedly.",
    );
    assert.equal(succeeded.isError, false);
    assert.equal(succeeded.structuredContent?.markdown, "복구됨");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read worker safety uses a fresh real worker below the threshold and cleans its snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-real-worker-"));
  try {
    const sourcePath = join(root, "source.hwpx");
    await writeFile(sourcePath, new Uint8Array(await markdownToHwpx("# 실제 워커\n\n본문")));
    const snapshot = await openDocumentSnapshot(sourcePath);
    assert.equal(snapshot.transport, "worker");
    const engineModule = await loadFacade();
    const facade = engineModule.createDocumentEngineFacade({
      isolatedEngine: createIsolatedDocumentEngine({
        workerClient: createDocumentWorkerClient({
          workerFactory: (options) => new Worker(BUILT_WORKER, options),
        }),
        childClient: createDocumentChildClient({
          childEntry: BUILT_CHILD.pathname.slice(1).replaceAll("/", "\\"),
        }),
      }),
      requestIdFactory: () => "task5-real-worker",
    });

    const result = await facade.parse(snapshot, { pages: "1" });

    assert.equal(result.payload.fileType, "hwpx");
    assert.match(result.payload.markdown, /실제 워커/u);
    assert.equal(result.snapshotMetadata.sha256, digest(await readFile(sourcePath)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read worker safety keeps preview requests path-free and preserves exclusive output", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-preview-"));
  try {
    const sourcePath = join(root, "source.hwpx");
    const outputPath = join(root, "existing.svg");
    const source = new Uint8Array(await markdownToHwpx("# 미리보기 격리"));
    const sentinel = Buffer.from("existing preview");
    await writeFile(sourcePath, source);
    await writeFile(outputPath, sentinel);
    const requests: LogicalDocumentRequest[] = [];
    const metadata: unknown[] = [];
    const engineModule = await loadFacade();
    const facade = engineModule.createDocumentEngineFacade({
      isolatedEngine: recordingEngine(requests, metadata, {
        render: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>',
          metadata: {
            backend: "kordoc",
            pageCount: 1,
            width: 612,
            height: 792,
            warnings: [],
            stats: {},
          },
        },
      }),
      requestIdFactory: () => "task5-preview",
    });

    const result = await handleHwpRenderPreview({
      file_path: sourcePath,
      output_svg_path: outputPath,
      reflow: true,
      highlight: ["미리보기"],
    }, facade);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "OUTPUT_CONFLICT");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.operation, "render");
    assert.deepEqual(requests[0]?.options, {
      reflow: true,
      highlights: ["미리보기"],
    });
    assert.doesNotMatch(JSON.stringify(requests[0]), /(?:file|source|spool)[_-]?path/iu);
    assert.deepEqual(await readFile(outputPath), sentinel);
    assert.equal(digest(await readFile(sourcePath)), digest(source));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read worker safety production routes do not import in-process Kordoc or rhwp", async () => {
  for (const path of [
    new URL("../src/tools/detect.ts", import.meta.url),
    new URL("../src/tools/read.ts", import.meta.url),
    new URL("../src/tools/preview.ts", import.meta.url),
  ]) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /from\s+["']kordoc["']/u);
    assert.doesNotMatch(source, /rhwp-backend/u);
  }
});

test("read worker safety routes an above-threshold valid HWPX through the real supervised child and cleans spools", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-child-"));
  const snapshotRoot = join(root, "snapshot-spools");
  const resultRoot = join(root, "result-spools");
  await mkdir(snapshotRoot);
  await mkdir(resultRoot);
  try {
    const sourcePath = join(root, "large.hwpx");
    const largeText = "가".repeat(3_000_000);
    const base = await markdownToHwpx(`# 대용량 자식 격리\n\n${largeText}`);
    const archive = await JSZip.loadAsync(base);
    archive.file(
      "Preview/task5-padding.bin",
      new Uint8Array(64 * 1024 * 1024 + 4096),
      { compression: "STORE" },
    );
    await writeFile(sourcePath, await archive.generateAsync({ type: "uint8array" }));
    const snapshot = await openDocumentSnapshot(sourcePath, { spoolRoot: snapshotRoot });
    assert.equal(snapshot.transport, "spool");
    const engineModule = await loadFacade();
    const isolatedEngine = createIsolatedDocumentEngine({
      workerClient: createDocumentWorkerClient(),
      childClient: createDocumentChildClient({
        childEntry: BUILT_CHILD.pathname.slice(1).replaceAll("/", "\\"),
        spoolRoot: resultRoot,
        jobSupervisorFactory: async (child) => ({
          terminate: async () => {
            if (child.exitCode !== null || child.signalCode !== null) return true;
            child.kill();
            await Promise.race([
              once(child, "exit"),
              new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
            ]);
            return child.exitCode !== null || child.signalCode !== null;
          },
        }),
      }),
    });
    const facade = engineModule.createDocumentEngineFacade({
      isolatedEngine,
      requestIdFactory: () => "task5-large-child",
    });

    const result = await facade.parse(snapshot, { pages: "1" });

    assert.equal(result.payload.fileType, "hwpx");
    assert.match(result.payload.markdown, /대용량 자식 격리/u);
    assert.ok(Buffer.byteLength(result.payload.markdown, "utf8") > 8 * 1024 * 1024);
    assert.deepEqual(await readdir(snapshotRoot), []);
    assert.deepEqual(await readdir(resultRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function loadFacade(): Promise<{
  createDocumentEngineFacade(options: Record<string, unknown>): {
    detect(snapshot: unknown): Promise<{ payload: { format: string } }>;
  };
}> {
  try {
    return await import("../src/shared/document-engine.js") as never;
  } catch (error: unknown) {
    assert.fail(`document engine facade is missing: ${errorMessage(error)}`);
  }
}

function recordingEngine(
  requests: LogicalDocumentRequest[],
  metadata: unknown[],
  payloads: Partial<Record<DocumentEngineOperation, unknown>>,
) {
  return {
    async run<Operation extends DocumentEngineOperation>(
      request: Extract<LogicalDocumentRequest, { operation: Operation }>,
      snapshot: {
        transport: string;
        metadata: unknown;
        cleanup(): Promise<void>;
      },
    ): Promise<DocumentResultPayload<Operation>> {
      assert.equal(snapshot.transport, "worker");
      requests.push(request);
      metadata.push(snapshot.metadata);
      await snapshot.cleanup();
      const payload = payloads[request.operation];
      assert.notEqual(payload, undefined);
      return payload as DocumentResultPayload<Operation>;
    },
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
