import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import JSZip from "jszip";
import { markdownToHwpx } from "kordoc";

import { openDocumentSnapshot } from "../src/shared/document-snapshot.js";
import { prepareDocumentRenderOutput } from "../src/shared/document-render-output.js";
import { captureExistingOutputDirectoryIdentity } from "../src/shared/output.js";
import { handleHwpDetectFormat } from "../src/tools/detect.js";
import { handleHwpRead } from "../src/tools/read.js";
import { handleHwpRenderPreview } from "../src/tools/preview.js";
import {
  createDocumentChildClient,
  isIntegrityVerifiedResultSpool,
} from "../src/workers/document-child-client.js";
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
const FIXTURE_CHILD = new URL(
  "tests/fixtures/workers/engine-test-child.mjs",
  PACKAGE_ROOT,
);

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

test("real isolate maps exact-unknown ZIP and OLE candidates to stable tool format errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-unsupported-"));
  try {
    const docx = new JSZip();
    docx.file("[Content_Types].xml", [
      '<?xml version="1.0"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      "</Types>",
    ].join(""));
    docx.file("word/document.xml", "<w:document/>");
    const invalidOle = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(invalidOle);
    const fixtures = [
      { name: "DOCX", path: join(root, "foreign.docx"), bytes: await docx.generateAsync({ type: "uint8array" }) },
      { name: "invalid OLE", path: join(root, "invalid.hwp"), bytes: invalidOle },
    ] as const;

    for (const fixture of fixtures) {
      await writeFile(fixture.path, fixture.bytes);
      const previewPath = `${fixture.path}.svg`;
      const read = await handleHwpRead({ file_path: fixture.path });
      const preview = await handleHwpRenderPreview({
        file_path: fixture.path,
        output_svg_path: previewPath,
      });
      assert.equal(read.structuredContent?.code, "UNSUPPORTED_FORMAT", fixture.name);
      assert.equal(preview.structuredContent?.code, "UNSUPPORTED_PREVIEW_FORMAT", fixture.name);
      await assert.rejects(readFile(previewPath), (error: unknown) =>
        (error as { code?: string }).code === "ENOENT");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detect restores a bounded stable warning for exact-unknown containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-warning-"));
  try {
    const path = join(root, "foreign.docx");
    const archive = new JSZip();
    archive.file("[Content_Types].xml", "<Types/>");
    archive.file("word/document.xml", "<w:document/>");
    await writeFile(path, await archive.generateAsync({ type: "uint8array" }));

    const detected = await handleHwpDetectFormat({ file_path: path });

    assert.equal(detected.structuredContent?.format, "unknown");
    const warning = (detected.structuredContent?.details as { detection_warning?: unknown })
      ?.detection_warning;
    assert.equal(warning, "The ZIP container is not a supported HWPX document.");
    assert.ok(Buffer.byteLength(String(warning), "utf8") <= 256);
  } finally {
    await rm(root, { recursive: true, force: true });
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
            if (child.exitCode === null && child.signalCode === null) {
              child.kill();
              await Promise.race([
                once(child, "exit"),
                new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
              ]);
            }
            return child.exitCode !== null || child.signalCode !== null
              ? { gone: true as const, proof: "registered-groups-empty" as const }
              : { gone: false as const, proof: "unverified" as const, reason: "termination" as const };
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

test("parent streams a branded render spool with metadata without materializing the SVG", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-render-stream-"));
  const inputPath = join(root, "source.hwpx");
  const outputPath = join(root, "preview.svg");
  const resultRoot = join(root, "result-spools");
  await mkdir(resultRoot);
  await writeFile(inputPath, "owned source");
  try {
    const engineModule = await import("../src/shared/document-engine.js") as Record<string, unknown>;
    const writeRender = Reflect.get(
      engineModule,
      "writeDocumentRenderResultExclusively",
    ) as undefined | ((...args: unknown[]) => Promise<Record<string, unknown>>);
    assert.equal(typeof writeRender, "function");

    const sourceHandle = await open(inputPath, "r");
    let sourceClosed = false;
    const child = createDocumentChildClient({
      childEntry: FIXTURE_CHILD.pathname.slice(1).replaceAll("/", "\\"),
      childArguments: ["render-spool", String(9 * 1024 * 1024)],
      spoolRoot: resultRoot,
      jobSupervisorFactory: unitTestChildSupervisor,
    });
    const result = await child.run({
      protocolVersion: 1,
      requestId: "task5-stream-render",
      operation: "render",
      input: {},
      options: {},
    }, {
      transport: "spool",
      metadata: {
        sizeBytes: 12,
        sha256: digest(Buffer.from("owned source")),
        candidateFormat: "unknown",
        protection: "unknown",
      },
      takeSpoolHandle: () => ({ fd: sourceHandle.fd, sizeBytes: 12 }),
      async verifySourceUnchanged() {},
      async cleanup() {
        if (sourceClosed) return;
        sourceClosed = true;
        await sourceHandle.close();
      },
    } as never);

    let sourceVerifications = 0;
    const metadata = await writeRender!({
      payload: result,
      snapshotMetadata: {},
      async verifySourceUnchanged() {
        sourceVerifications += 1;
      },
    }, outputPath, {
      sourcePaths: [inputPath],
    });
    assert.deepEqual(metadata, {
      backend: "kordoc",
      pageCount: 3,
      width: 612,
      height: 792,
    });
    const output = await readFile(outputPath);
    assert.equal(output.byteLength, 9 * 1024 * 1024);
    assert.match(output.subarray(0, 64).toString("utf8"), /^<svg\b/u);
    assert.match(output.subarray(-64).toString("utf8"), /<\/svg>$/u);
    assert.equal(sourceVerifications, 1);
    assert.deepEqual(await readdir(resultRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render spool validation and cancellation create no output and always clean the spool", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-render-invalid-"));
  const sourcePath = join(root, "source.hwpx");
  const resultRoot = join(root, "result-spools");
  await writeFile(sourcePath, "owned source");
  await mkdir(resultRoot);
  try {
    const engineModule = await import("../src/shared/document-engine.js") as Record<string, unknown>;
    const writeRender = Reflect.get(
      engineModule,
      "writeDocumentRenderResultExclusively",
    ) as (...args: unknown[]) => Promise<unknown>;
    const safe = testRenderSpool('<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>');
    const invalidUtf8 = Buffer.from(safe);
    invalidUtf8[invalidUtf8.byteLength - 8] = 0xff;
    const truncated = testRenderSpool('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
      declaredSvgBytesDelta: 1,
    });
    const oversizedHeader = testRenderSpool("", {
      declaredSvgBytes: 128 * 1024 * 1024 + 1,
    });
    const active = testRenderSpool(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a>rest"/></svg>',
    );
    const cases = [
      { name: "invalid UTF-8", bytes: invalidUtf8, code: "ENGINE_PROTOCOL_ERROR" },
      { name: "truncated", bytes: truncated, code: "ENGINE_PROTOCOL_ERROR" },
      { name: "oversized", bytes: oversizedHeader, code: "PREVIEW_TOO_LARGE" },
      { name: "active content", bytes: active, code: "ENGINE_PROTOCOL_ERROR" },
    ] as const;

    for (const scenario of cases) {
      const result = await fixtureRenderSpool(
        sourcePath,
        resultRoot,
        ["spool-base64", scenario.bytes.toString("base64")],
        `task5-invalid-${scenario.name.replaceAll(/[^a-z0-9-]/giu, "-")}`,
      );
      assert.equal(isIntegrityVerifiedResultSpool(result), true);
      const outputPath = join(root, `${scenario.name}.svg`);
      let verified = 0;
      await assert.rejects(
        writeRender({
          payload: result,
          async verifySourceUnchanged() { verified += 1; },
        }, outputPath, { sourcePaths: [sourcePath] }),
        (error: unknown) => (error as { code?: string }).code === scenario.code,
      );
      assert.equal(verified, 0, scenario.name);
      await assertMissing(outputPath);
      assert.throws(
        () => (result as { takeHandle(): unknown }).takeHandle(),
        (error: unknown) => (error as { code?: string }).code === "ENGINE_PROTOCOL_ERROR",
      );
    }

    const cancelled = await fixtureRenderSpool(
      sourcePath,
      resultRoot,
      ["spool-base64", safe.toString("base64")],
      "task5-cancelled-render",
    );
    const controller = new AbortController();
    controller.abort();
    const cancelledPath = join(root, "cancelled.svg");
    await assert.rejects(
      writeRender({
        payload: cancelled,
        async verifySourceUnchanged() { assert.fail("cancelled before verification"); },
      }, cancelledPath, { sourcePaths: [sourcePath], signal: controller.signal }),
      (error: unknown) => (error as { code?: string }).code === "REQUEST_CANCELLED",
    );
    await assertMissing(cancelledPath);
    assert.throws(
      () => (cancelled as { takeHandle(): unknown }).takeHandle(),
      (error: unknown) => (error as { code?: string }).code === "ENGINE_PROTOCOL_ERROR",
    );

    const changed = await fixtureRenderSpool(
      sourcePath,
      resultRoot,
      ["spool-base64", safe.toString("base64")],
      "task5-changed-render",
    );
    const changedPath = join(root, "changed.svg");
    await assert.rejects(
      writeRender({
        payload: changed,
        async verifySourceUnchanged() { throw new Error("source changed"); },
      }, changedPath, { sourcePaths: [sourcePath] }),
      (error: unknown) => (error as { code?: string }).code === "ENGINE_PROTOCOL_ERROR",
    );
    await assertMissing(changedPath);

    const coded = await fixtureRenderSpool(
      sourcePath,
      resultRoot,
      ["spool-base64", safe.toString("base64")],
      "task5-coded-render-error",
    );
    const codedPath = join(root, "coded.svg");
    await assert.rejects(
      writeRender({
        payload: coded,
        async verifySourceUnchanged() {
          throw Object.assign(new Error("sensitive verifier detail"), {
            code: "ATTACKER_CONTROLLED_CODE",
          });
        },
      }, codedPath, { sourcePaths: [sourcePath] }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "ENGINE_PROTOCOL_ERROR");
        assert.equal(
          (error as Error).message,
          "The document engine returned an invalid protocol message.",
        );
        assert.doesNotMatch(String(error), /sensitive|attacker/iu);
        return true;
      },
    );
    await assertMissing(codedPath);

    const descriptorFailure = await fixtureRenderSpool(
      sourcePath,
      resultRoot,
      ["spool-base64", safe.toString("base64")],
      "task5-descriptor-read-error",
    );
    const descriptorPath = join(root, "descriptor.svg");
    await assert.rejects(
      writeRender({
        payload: descriptorFailure,
        async verifySourceUnchanged() { assert.fail("descriptor failed first"); },
      }, descriptorPath, {
        sourcePaths: [sourcePath],
        async unitTestReadInto() {
          throw Object.assign(new Error("sensitive fd C:\\private\\result.svg"), {
            code: "EBADF",
            path: "C:\\private\\result.svg",
          });
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "ENGINE_PROTOCOL_ERROR");
        assert.equal(
          (error as Error).message,
          "The document engine returned an invalid protocol message.",
        );
        assert.doesNotMatch(String(error), /EBADF|private|result\.svg/iu);
        return true;
      },
    );
    await assertMissing(descriptorPath);
    assert.deepEqual(await readdir(resultRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview releases each taken render spool exactly once across every terminal path", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-render-spool-cleanup-"));
  const sourcePath = join(root, "source.hwpx");
  const resultRoot = join(root, "result-spools");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("# Spool cleanup")));
  await mkdir(resultRoot);

  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>';
  const safeBytes = testRenderSpool(safeSvg);
  try {
    await t.test("prepare failure", async () => {
      const truncated = testRenderSpool(safeSvg, { declaredSvgBytesDelta: 1 });
      const tracked = await trackedFixtureRenderSpool(
        sourcePath,
        resultRoot,
        truncated,
        "cleanup-prepare-failure",
      );
      const outputPath = join(root, "prepare-failure.svg");
      const result = await handleHwpRenderPreview(
        { file_path: sourcePath, output_svg_path: outputPath },
        renderSpoolFacade(tracked.spool),
      );

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.code, "ENGINE_PROTOCOL_ERROR");
      assert.deepEqual(tracked.counts(), { unlink: 1, rmdir: 1 });
      await assertMissing(outputPath);
    });

    await t.test("response-budget failure", async () => {
      const tracked = await trackedFixtureRenderSpool(
        sourcePath,
        resultRoot,
        safeBytes,
        "cleanup-budget-failure",
      );
      const oversizedOutputPath = join(root, `${"p".repeat(4_300_000)}.svg`);
      const result = await handleHwpRenderPreview(
        { file_path: sourcePath, output_svg_path: oversizedOutputPath },
        renderSpoolFacade(tracked.spool),
      );

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.code, "RESPONSE_TOO_LARGE");
      assert.deepEqual(tracked.counts(), { unlink: 1, rmdir: 1 });
    });

    await t.test("commit failure", async () => {
      const tracked = await trackedFixtureRenderSpool(
        sourcePath,
        resultRoot,
        safeBytes,
        "cleanup-commit-failure",
      );
      const outputPath = join(root, "existing.svg");
      await writeFile(outputPath, "sentinel");
      const result = await handleHwpRenderPreview(
        { file_path: sourcePath, output_svg_path: outputPath },
        renderSpoolFacade(tracked.spool),
      );

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.code, "OUTPUT_CONFLICT");
      assert.equal(await readFile(outputPath, "utf8"), "sentinel");
      assert.deepEqual(tracked.counts(), { unlink: 1, rmdir: 1 });
    });

    await t.test("success", async () => {
      const tracked = await trackedFixtureRenderSpool(
        sourcePath,
        resultRoot,
        safeBytes,
        "cleanup-success",
      );
      const outputPath = join(root, "success.svg");
      const result = await handleHwpRenderPreview(
        { file_path: sourcePath, output_svg_path: outputPath },
        renderSpoolFacade(tracked.spool),
      );

      assert.equal(result.isError, false);
      assert.equal(await readFile(outputPath, "utf8"), safeSvg);
      assert.deepEqual(tracked.counts(), { unlink: 1, rmdir: 1 });
    });

    assert.deepEqual(await readdir(resultRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read and inline or spooled preview reverify the source at the writer open boundary", { timeout: 60_000 }, async (t) => {
  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>safe</text></svg>';

  await t.test("read", async () => {
    const fixture = await sourceSwapFixture("read");
    try {
      const outputPath = join(fixture.outputDir, "document.md");
      const result = await handleHwpRead({
        file_path: fixture.sourcePath,
        markdown_output_path: outputPath,
      }, {
        async parse(snapshot) {
          const snapshotMetadata = snapshot.metadata;
          const verifySourceUnchanged = swapSourceAfterOutputPreparation(
            snapshot.verifySourceUnchanged,
            fixture,
          );
          try {
            await snapshot.verifySourceUnchanged();
            return {
              payload: { fileType: "hwpx", markdown: "safe markdown" },
              snapshotMetadata,
              verifySourceUnchanged,
            } as never;
          } finally {
            await snapshot.cleanup();
          }
        },
      } as never);

      assert.equal(result.isError, true);
      await assertMissing(outputPath);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("inline preview", async () => {
    const fixture = await sourceSwapFixture("inline-preview");
    try {
      const outputPath = join(fixture.outputDir, "preview.svg");
      const result = await handleHwpRenderPreview({
        file_path: fixture.sourcePath,
        output_svg_path: outputPath,
      }, {
        async render(snapshot) {
          const snapshotMetadata = snapshot.metadata;
          const verifySourceUnchanged = swapSourceAfterOutputPreparation(
            snapshot.verifySourceUnchanged,
            fixture,
          );
          try {
            await snapshot.verifySourceUnchanged();
            return {
              payload: { svg: safeSvg },
              snapshotMetadata,
              verifySourceUnchanged,
            };
          } finally {
            await snapshot.cleanup();
          }
        },
      } as never);

      assert.equal(result.isError, true);
      await assertMissing(outputPath);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("spooled preview", async () => {
    const fixture = await sourceSwapFixture("spooled-preview");
    const resultRoot = join(fixture.root, "result-spools");
    await mkdir(resultRoot);
    try {
      const spool = await fixtureRenderSpool(
        fixture.sourcePath,
        resultRoot,
        ["spool-base64", testRenderSpool(safeSvg).toString("base64")],
        "source-swap-spooled-preview",
      );
      const outputPath = join(fixture.outputDir, "preview.svg");
      const result = await handleHwpRenderPreview({
        file_path: fixture.sourcePath,
        output_svg_path: outputPath,
      }, {
        async render(snapshot) {
          const snapshotMetadata = snapshot.metadata;
          const verifySourceUnchanged = swapSourceAfterOutputPreparation(
            snapshot.verifySourceUnchanged,
            fixture,
          );
          try {
            await snapshot.verifySourceUnchanged();
            return { payload: spool, snapshotMetadata, verifySourceUnchanged } as never;
          } finally {
            await snapshot.cleanup();
          }
        },
      } as never);

      assert.equal(result.isError, true);
      await assertMissing(outputPath);
      assert.deepEqual(await readdir(resultRoot), []);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("inline and spooled render writers enforce the same expected directory identity", { timeout: 60_000 }, async (t) => {
  for (const kind of ["inline", "spooled"] as const) {
    await t.test(kind, async () => {
      const root = await mkdtemp(join(tmpdir(), `gpt-codex-hwp-render-identity-${kind}-`));
      const sourcePath = join(root, "source.hwpx");
      const outputDir = join(root, "output");
      const displacedDir = join(root, "output-displaced");
      const outputPath = join(outputDir, "preview.svg");
      const resultRoot = join(root, "result-spools");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>identity</text></svg>';
      await writeFile(sourcePath, Buffer.from(await markdownToHwpx("# identity")));
      await mkdir(outputDir);
      await mkdir(resultRoot);
      try {
        const identity = await captureExistingOutputDirectoryIdentity(outputDir);
        assert.ok(identity);
        const payload = kind === "inline"
          ? { svg }
          : await fixtureRenderSpool(
              sourcePath,
              resultRoot,
              ["spool-base64", testRenderSpool(svg).toString("base64")],
              "render-expected-directory-identity",
            );
        const prepared = await prepareDocumentRenderOutput({
          payload: payload as never,
          async verifySourceUnchanged() {},
        });
        try {
          await rename(outputDir, displacedDir);
          await mkdir(outputDir);
          await assert.rejects(
            prepared.writeExclusively(outputPath, {
              expectedDirectoryIdentities: [identity],
            }),
            (error: unknown) => (error as { code?: string }).code === "OUTPUT_CONFLICT",
          );
          await assertMissing(outputPath);
          await assertMissing(join(displacedDir, "preview.svg"));
        } finally {
          await prepared.cleanup();
        }
        assert.deepEqual(await readdir(resultRoot), []);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("inline and spooled render writers verify the source after caller beforeOpen", { timeout: 60_000 }, async (t) => {
  for (const kind of ["inline", "spooled"] as const) {
    await t.test(kind, async () => {
      const fixture = await sourceSwapFixture(`caller-before-open-${kind}`);
      const resultRoot = join(fixture.root, "result-spools");
      const outputPath = join(fixture.outputDir, "preview.svg");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>caller</text></svg>';
      await mkdir(resultRoot);
      const sourceSnapshot = await openDocumentSnapshot(fixture.sourcePath);
      let checks = 0;
      try {
        const payload = kind === "inline"
          ? { svg }
          : await fixtureRenderSpool(
              fixture.sourcePath,
              resultRoot,
              ["spool-base64", testRenderSpool(svg).toString("base64")],
              "render-caller-before-open",
            );
        const prepared = await prepareDocumentRenderOutput({
          payload: payload as never,
          async verifySourceUnchanged() {
            checks += 1;
            await sourceSnapshot.verifySourceUnchanged();
          },
        });
        try {
          await assert.rejects(
            prepared.writeExclusively(outputPath, {
              sourcePaths: [fixture.sourcePath],
              async beforeOpen() {
                await writeFile(fixture.sourcePath, fixture.replacement);
              },
            }),
            (error: unknown) =>
              (error as { code?: string }).code === "ENGINE_PROTOCOL_ERROR",
          );
          assert.equal(checks, 1);
          await assertMissing(outputPath);
        } finally {
          await prepared.cleanup();
        }
        assert.deepEqual(await readdir(resultRoot), []);
      } finally {
        await sourceSnapshot.cleanup();
        await fixture.cleanup();
      }
    });
  }
});

test("validated render spool preserves an existing output without partial replacement", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task5-render-conflict-"));
  const sourcePath = join(root, "source.hwpx");
  const outputPath = join(root, "existing.svg");
  const resultRoot = join(root, "result-spools");
  const sentinel = Buffer.from("existing output");
  await writeFile(sourcePath, "owned source");
  await writeFile(outputPath, sentinel);
  await mkdir(resultRoot);
  try {
    const { writeDocumentRenderResultExclusively: writeRender } = await import(
      "../src/shared/document-engine.js"
    );
    const spool = await fixtureRenderSpool(
      sourcePath,
      resultRoot,
      ["spool-base64", testRenderSpool('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64")],
      "task5-conflict-render",
    );
    await assert.rejects(
      writeRender({
        payload: spool,
        snapshotMetadata: {} as never,
        async verifySourceUnchanged() {},
      }, outputPath, { sourcePaths: [sourcePath] }),
      (error: unknown) => (error as { code?: string }).code === "OUTPUT_CONFLICT",
    );
    assert.deepEqual(await readFile(outputPath), sentinel);
    assert.deepEqual(await readdir(resultRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP cancellation reaches the spooled preview exclusive-open boundary", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task7-spool-cancel-"));
  const sourcePath = join(root, "source.hwpx");
  const outputPath = join(root, "cancelled.svg");
  const resultRoot = join(root, "result-spools");
  const abort = new AbortController();
  await writeFile(sourcePath, "owned source");
  await mkdir(resultRoot);
  try {
    const { writeDocumentRenderResultExclusively: writeRender } = await import(
      "../src/shared/document-engine.js"
    );
    const spool = await fixtureRenderSpool(
      sourcePath,
      resultRoot,
      ["spool-base64", testRenderSpool('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64")],
      "task7-cancelled-spool-render",
    );
    await assert.rejects(
      writeRender({
        payload: spool,
        snapshotMetadata: {} as never,
        async verifySourceUnchanged() {},
      }, outputPath, {
        sourcePaths: [sourcePath],
        signal: abort.signal,
        beforeOpen: async () => abort.abort(),
      }),
      (error: unknown) => (error as { code?: string }).code === "REQUEST_CANCELLED",
    );
    await assertMissing(outputPath);
    assert.deepEqual(await readdir(resultRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function unitTestChildSupervisor(child: {
  exitCode: number | null;
  signalCode: string | null;
  kill(): boolean;
}) {
  return {
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const deadline = Date.now() + 2_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
      }
      return child.exitCode !== null || child.signalCode !== null
        ? { gone: true as const, proof: "registered-groups-empty" as const }
        : { gone: false as const, proof: "unverified" as const, reason: "termination" as const };
    },
  };
}

async function fixtureRenderSpool(
  sourcePath: string,
  spoolRoot: string,
  childArguments: readonly string[],
  requestId: string,
  outputSpoolCleanupHooks?: Readonly<{
    unlink?: (path: string) => Promise<void>;
    rmdir?: (path: string) => Promise<void>;
  }>,
): Promise<unknown> {
  const source = await readFile(sourcePath);
  const handle = await open(sourcePath, "r");
  let closed = false;
  const child = createDocumentChildClient({
    childEntry: FIXTURE_CHILD.pathname.slice(1).replaceAll("/", "\\"),
    childArguments,
    spoolRoot,
    jobSupervisorFactory: unitTestChildSupervisor,
    ...(outputSpoolCleanupHooks === undefined
      ? {}
      : { outputSpoolCleanupHooks }),
  });
  return child.run({
    protocolVersion: 1,
    requestId,
    operation: "render",
    input: {},
    options: {},
  }, {
    transport: "spool",
    metadata: {
      sizeBytes: source.byteLength,
      sha256: digest(source),
      candidateFormat: "unknown",
      protection: "unknown",
    },
    takeSpoolHandle: () => ({ fd: handle.fd, sizeBytes: source.byteLength }),
    async verifySourceUnchanged() {},
    async cleanup() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  } as never);
}

async function trackedFixtureRenderSpool(
  sourcePath: string,
  spoolRoot: string,
  bytes: Buffer,
  requestId: string,
): Promise<{
  readonly spool: unknown;
  counts(): Readonly<{ unlink: number; rmdir: number }>;
}> {
  let unlinkCount = 0;
  let rmdirCount = 0;
  const spool = await fixtureRenderSpool(
    sourcePath,
    spoolRoot,
    ["spool-base64", bytes.toString("base64")],
    requestId,
    {
      async unlink(path) {
        unlinkCount += 1;
        await unlink(path);
      },
      async rmdir(path) {
        rmdirCount += 1;
        await rmdir(path);
      },
    },
  );
  return {
    spool,
    counts: () => ({ unlink: unlinkCount, rmdir: rmdirCount }),
  };
}

function renderSpoolFacade(spool: unknown): Parameters<typeof handleHwpRenderPreview>[1] {
  return {
    async render(snapshot) {
      const snapshotMetadata = snapshot.metadata;
      try {
        await snapshot.verifySourceUnchanged();
        return {
          payload: spool,
          snapshotMetadata,
          async verifySourceUnchanged() {},
        } as never;
      } finally {
        await snapshot.cleanup();
      }
    },
  } as never;
}

async function sourceSwapFixture(label: string): Promise<{
  readonly root: string;
  readonly sourcePath: string;
  readonly outputDir: string;
  readonly replacement: Uint8Array;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `gpt-codex-hwp-source-swap-${label}-`));
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx(`# ${label} source`)));
  return {
    root,
    sourcePath,
    outputDir: join(root, "prepared-output"),
    replacement: new Uint8Array(await markdownToHwpx(`# ${label} replacement`)),
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

function swapSourceAfterOutputPreparation(
  verifySourceUnchanged: () => Promise<void>,
  fixture: Readonly<{
    sourcePath: string;
    outputDir: string;
    replacement: Uint8Array;
  }>,
): () => Promise<void> {
  let swapped = false;
  return async () => {
    if (!swapped && await pathExists(fixture.outputDir)) {
      swapped = true;
      await writeFile(fixture.sourcePath, fixture.replacement);
    }
    await verifySourceUnchanged();
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

function testRenderSpool(
  svg: string,
  options: Readonly<{
    declaredSvgBytes?: number;
    declaredSvgBytesDelta?: number;
  }> = {},
): Buffer {
  const svgBytes = Buffer.from(svg, "utf8");
  const declaredSvgBytes = options.declaredSvgBytes ??
    svgBytes.byteLength + (options.declaredSvgBytesDelta ?? 0);
  const header = Buffer.from(JSON.stringify({ version: 1, svgBytes: declaredSvgBytes }));
  const encoded = Buffer.alloc(4 + header.byteLength + svgBytes.byteLength);
  encoded.writeUInt32BE(header.byteLength, 0);
  header.copy(encoded, 4);
  svgBytes.copy(encoded, 4 + header.byteLength);
  return encoded;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(
    readFile(path),
    (error: unknown) => (error as { code?: string }).code === "ENOENT",
  );
}

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
