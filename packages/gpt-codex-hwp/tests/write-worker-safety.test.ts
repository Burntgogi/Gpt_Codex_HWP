import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { markdownToHwpx } from "kordoc";

import {
  handleHwpGenerateHwpx,
  handleHwpValidate,
} from "../src/tools/write.js";
import {
  handleHwpFillForm,
  handleHwpPatchDocument,
} from "../src/tools/patch.js";
import { handleHwpInsertImage } from "../src/tools/assets.js";
import { createDocumentEngineFacade } from "../src/shared/document-engine.js";
import { openDocumentSnapshot } from "../src/shared/document-snapshot.js";

test("write worker safety routes generation through one path-free facade request", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task6-generate-"));
  try {
    const outputPath = join(root, "generated.hwpx");
    const previewPath = join(root, "generated.svg");
    const previewSvg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const generated = new Uint8Array(await markdownToHwpx("# 격리 생성\n\n본문"));
    const calls: unknown[] = [];
    const facade = {
      async generate(markdown: string, options: unknown) {
        calls.push({ markdown, options });
        return {
          payload: {
            bytes: exactArrayBuffer(generated),
            metadata: {
              operation: "generateHwpx",
              fontNormalization: {
                changed: false,
                changedReferenceCount: 0,
              },
            },
          },
          resultMetadata: {
            operation: "generateHwpx",
            fontNormalization: {
              changed: false,
              changedReferenceCount: 0,
            },
          },
          validation: { ok: true, issues: [], entryCount: 8 },
          preview: {
            svg: previewSvg,
            metadata: {
              backend: "kordoc",
              pageCount: 1,
              width: 595.28,
              height: 841.89,
              warnings: [],
              stats: { paragraphs: 2 },
            },
          },
          async verifySourceUnchanged() {},
          async writeOutputExclusively(
            outputPath: string,
            outputOptions: {
              companionFiles?: readonly Array<{
                path: string;
                data: string | Uint8Array;
              }>;
            } = {},
          ) {
            assert.deepEqual(outputOptions.companionFiles, [{
              path: previewPath,
              data: previewSvg,
            }]);
            await writeFile(outputPath, generated, { flag: "wx" });
            await writeFile(previewPath, previewSvg, { flag: "wx" });
            return [outputPath];
          },
          async cleanup() {},
        };
      },
    };

    const result = await handleHwpGenerateHwpx({
      markdown: "# 격리 생성\n\n본문",
      output_path: outputPath,
      preset: "report",
      preview_svg_path: previewPath,
    }, facade as never);

    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      markdown: "# 격리 생성\n\n본문",
      options: { preset: "report", renderPreview: true },
    });
    assert.doesNotMatch(JSON.stringify(calls[0]), /(?:file|source|output|spool|image)[_-]?path/iu);
    assert.equal(digest(await readFile(outputPath)), digest(generated));
    assert.equal(await readFile(previewPath, "utf8"), previewSvg);
    assert.equal(result.structuredContent?.preview_svg_path, previewPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write worker safety opens one immutable snapshot for validation and sends no path", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task6-validate-"));
  try {
    const sourcePath = join(root, "source.hwpx");
    const source = new Uint8Array(await markdownToHwpx("# 격리 검증"));
    await writeFile(sourcePath, source);
    const calls: unknown[] = [];
    const facade = {
      async validate(snapshot: {
        transport: string;
        metadata: unknown;
        cleanup(): Promise<void>;
      }) {
        calls.push({ transport: snapshot.transport, metadata: snapshot.metadata });
        await snapshot.cleanup();
        return {
          payload: { ok: true, issues: [], entryCount: 8 },
          snapshotMetadata: snapshot.metadata,
        };
      },
    };

    const result = await handleHwpValidate({ file_path: sourcePath }, facade as never);

    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { transport: string }).transport, "worker");
    assert.equal(
      ((calls[0] as { metadata: { sha256: string } }).metadata.sha256),
      digest(source),
    );
    assert.doesNotMatch(JSON.stringify(calls[0]), /(?:file|source|output|spool|image)[_-]?path/iu);
    assert.equal(digest(await readFile(sourcePath)), digest(source));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write tool production routes do not import in-process Kordoc or rhwp", async () => {
  const source = await readFile(new URL("../src/tools/write.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']kordoc["']/u);
  assert.doesNotMatch(source, /rhwp-backend/u);
});

test("write worker safety routes patch through one snapshot and preserves operation metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task6-patch-"));
  try {
    const sourcePath = join(root, "source.hwpx");
    const outputPath = join(root, "patched.hwpx");
    const source = new Uint8Array(await markdownToHwpx("# 원본\n\n본문"));
    const patched = new Uint8Array(await markdownToHwpx("# 수정\n\n본문"));
    await writeFile(sourcePath, source);
    const calls: unknown[] = [];
    const facade = {
      async patch(snapshot: {
        transport: string;
        metadata: unknown;
        cleanup(): Promise<void>;
      }, markdown: string) {
        calls.push({
          transport: snapshot.transport,
          metadata: snapshot.metadata,
          markdown,
        });
        await snapshot.cleanup();
        return {
          payload: {
            bytes: exactArrayBuffer(patched),
            metadata: {
              operation: "patchHwpx",
              applied: 2,
              skipped: [],
              verification: { stats: { added: 0, removed: 0, modified: 0 } },
            },
          },
          validation: { ok: true, issues: [], entryCount: 8 },
          resultMetadata: {
            operation: "patchHwpx",
            applied: 2,
            skipped: [],
            verification: { stats: { added: 0, removed: 0, modified: 0 } },
          },
          snapshotMetadata: snapshot.metadata,
          async verifySourceUnchanged() {},
          async writeOutputExclusively(outputPath: string) {
            await writeFile(outputPath, patched, { flag: "wx" });
            return [outputPath];
          },
          async cleanup() {},
        };
      },
    };

    const result = await handleHwpPatchDocument({
      file_path: sourcePath,
      edited_markdown: "# 수정\n\n본문",
      output_path: outputPath,
    }, facade as never);

    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { transport: string }).transport, "worker");
    assert.equal(
      (calls[0] as { metadata: { sha256: string } }).metadata.sha256,
      digest(source),
    );
    assert.doesNotMatch(JSON.stringify(calls[0]), /(?:file|source|output|spool|image)[_-]?path/iu);
    assert.equal(result.structuredContent?.applied, 2);
    assert.deepEqual(result.structuredContent?.skipped, []);
    assert.deepEqual(result.structuredContent?.verification, {
      stats: { added: 0, removed: 0, modified: 0 },
    });
    assert.equal(digest(await readFile(outputPath)), digest(patched));
    assert.equal(digest(await readFile(sourcePath)), digest(source));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write worker safety routes fill through one snapshot and preserves matched metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task6-fill-"));
  try {
    const sourcePath = join(root, "source.hwpx");
    const outputPath = join(root, "filled.hwpx");
    const source = new Uint8Array(await markdownToHwpx("| 성명 | ( ) |\n| --- | --- |"));
    const filled = new Uint8Array(await markdownToHwpx("| 성명 | 홍길동 |\n| --- | --- |"));
    await writeFile(sourcePath, source);
    const calls: unknown[] = [];
    const facade = {
      async fill(snapshot: {
        transport: string;
        metadata: unknown;
        cleanup(): Promise<void>;
      }, fields: unknown, options: unknown) {
        calls.push({
          transport: snapshot.transport,
          metadata: snapshot.metadata,
          fields,
          options,
        });
        await snapshot.cleanup();
        return {
          payload: {
            bytes: exactArrayBuffer(filled),
            metadata: {
              operation: "fillHwpx",
              filled: [{ label: "성명", value: "홍길동", count: 1 }],
              unmatched: ["부서"],
              rejected: [],
            },
          },
          validation: { ok: true, issues: [], entryCount: 8 },
          resultMetadata: {
            operation: "fillHwpx",
            filled: [{ label: "성명", value: "홍길동", count: 1 }],
            unmatched: ["부서"],
            rejected: [],
          },
          snapshotMetadata: snapshot.metadata,
          async verifySourceUnchanged() {},
          async writeOutputExclusively(outputPath: string) {
            await writeFile(outputPath, filled, { flag: "wx" });
            return [outputPath];
          },
          async cleanup() {},
        };
      },
    };

    const result = await handleHwpFillForm({
      file_path: sourcePath,
      fields: { 성명: "홍길동", 부서: "개발" },
      formats: { 성명: "text" },
      require_unique: true,
      output_path: outputPath,
    }, facade as never);

    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { transport: string }).transport, "worker");
    assert.deepEqual((calls[0] as { fields: unknown }).fields, {
      성명: "홍길동",
      부서: "개발",
    });
    assert.deepEqual((calls[0] as { options: unknown }).options, {
      formats: { 성명: "text" },
      requireUnique: true,
    });
    assert.doesNotMatch(JSON.stringify(calls[0]), /(?:file|source|output|spool|image)[_-]?path/iu);
    assert.equal(result.structuredContent?.filled_count, 1);
    assert.deepEqual(result.structuredContent?.unmatched, ["부서"]);
    assert.deepEqual(result.structuredContent?.rejected, []);
    assert.equal(digest(await readFile(outputPath)), digest(filled));
    assert.equal(digest(await readFile(sourcePath)), digest(source));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patch and fill production routes do not import in-process Kordoc or rhwp", async () => {
  const source = await readFile(new URL("../src/tools/patch.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']kordoc["']/u);
  assert.doesNotMatch(source, /rhwp-backend/u);
});

for (const mode of ["after-paragraph", "seal-anchor"] as const) {
  test(`write worker safety routes ${mode} image insertion through owned spools`, async () => {
    const root = await mkdtemp(join(tmpdir(), `gpt-codex-hwp-task6-${mode}-`));
    try {
      const sourcePath = join(root, "source.hwpx");
      const imagePath = join(root, "source.png");
      const outputPath = join(root, "inserted.hwpx");
      const source = new Uint8Array(await markdownToHwpx("# 결재\n\n(인)"));
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const inserted = new Uint8Array(await markdownToHwpx("# 결재\n\n(인)\n\n이미지"));
      await writeFile(sourcePath, source);
      await writeFile(imagePath, image);
      const calls: unknown[] = [];
      const resultMetadata = mode === "seal-anchor"
        ? {
            operation: "insertImage",
            mode,
            placed: [{
              anchor: "(인)", occurrence: 0, sectionIndex: 0,
              mode: "overlap", posXMm: 0, posYMm: 0, sizeMm: 20,
              entry: "BinData/image1.png", warnings: [],
            }],
          }
        : {
            operation: "insertImage",
            mode,
            placement: {
              imageEntry: "BinData/image1.png",
              itemId: "image1",
              sectionIndex: 0,
              removedLinesegarray: 1,
              displayWidthHu: 5669,
              displayHeightHu: 5669,
              warnings: [],
            },
          };
      const facade = {
        async insertImage(
          documentSnapshot: { transport: string; metadata: unknown; cleanup(): Promise<void> },
          imageSnapshot: { transport: string; metadata: unknown; cleanup(): Promise<void> },
          anchorText: string,
          options: unknown,
        ) {
          calls.push({
            document: { transport: documentSnapshot.transport, metadata: documentSnapshot.metadata },
            image: { transport: imageSnapshot.transport, metadata: imageSnapshot.metadata },
            anchorText,
            options,
          });
          await documentSnapshot.cleanup();
          await imageSnapshot.cleanup();
          return {
            payload: { bytes: exactArrayBuffer(inserted), metadata: resultMetadata },
            resultMetadata,
            validation: { ok: true, issues: [], entryCount: 8 },
            snapshotMetadata: documentSnapshot.metadata,
            async verifySourceUnchanged() {},
            async writeOutputExclusively(path: string) {
              await writeFile(path, inserted, { flag: "wx" });
              return [path];
            },
            async cleanup() {},
          };
        },
      };

      const result = await handleHwpInsertImage({
        file_path: sourcePath,
        image_path: imagePath,
        output_path: outputPath,
        anchor_text: "(인)",
        mode,
        size_mm: 20,
        anchor_occurrence: 0,
      }, facade as never);

      assert.equal(result.isError, false);
      assert.equal(calls.length, 1);
      const call = calls[0] as {
        document: { transport: string; metadata: { sha256: string } };
        image: { transport: string; metadata: { sha256: string } };
        options: unknown;
      };
      assert.equal(call.document.transport, "spool");
      assert.equal(call.image.transport, "spool");
      assert.equal(call.document.metadata.sha256, digest(source));
      assert.equal(call.image.metadata.sha256, digest(image));
      assert.deepEqual(call.options, {
        mode,
        sizeMm: 20,
        anchorOccurrence: 0,
      });
      assert.doesNotMatch(JSON.stringify(calls), /(?:file|source|output|image)[_-]?path/iu);
      assert.equal(result.structuredContent?.image_entry, "BinData/image1.png");
      assert.equal(digest(await readFile(outputPath)), digest(inserted));
      assert.equal(digest(await readFile(sourcePath)), digest(source));
      assert.equal(digest(await readFile(imagePath)), digest(image));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("image insertion production route has no in-process Kordoc or path-based helper", async () => {
  const source = await readFile(new URL("../src/tools/assets.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']kordoc["']/u);
  assert.doesNotMatch(source, /insert_image\.py/u);
  assert.doesNotMatch(source, /placeSealHwpx/u);
});

test("authorized inline HWPX bytes remain immutable when the exposed engine payload is changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task6-inline-ownership-"));
  try {
    const outputPath = join(root, "authorized.hwpx");
    const original = new Uint8Array(await markdownToHwpx("# immutable inline candidate"));
    const metadata = {
      operation: "generateHwpx",
      fontNormalization: { changed: false, changedReferenceCount: 0 },
    };
    const inlinePayload = {
      bytes: exactArrayBuffer(original),
      metadata,
    };
    const facade = createDocumentEngineFacade({
      isolatedEngine: {
        async run(request: { operation: string }, snapshot?: { cleanup(): Promise<void> }) {
          if (request.operation === "generateHwpx") return inlinePayload;
          if (request.operation === "validateHwpx") {
            await snapshot?.cleanup();
            return { ok: true, issues: [], entryCount: 1 };
          }
          throw new Error("unexpected operation");
        },
      } as never,
      requestIdFactory: () => "inline_ownership",
    });
    const authorized = await facade.generate("# immutable inline candidate");
    try {
      const exposed = (authorized.payload as { bytes: ArrayBuffer }).bytes;
      new Uint8Array(exposed)[0] ^= 0xff;
      await authorized.writeOutputExclusively(outputPath);
    } finally {
      await authorized.cleanup();
    }

    assert.equal(digest(await readFile(outputPath)), digest(original));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation validates preview metadata before opening either output", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-task6-preview-preflight-"));
  try {
    const outputPath = join(root, "generated.hwpx");
    const previewPath = join(root, "generated.svg");
    const generated = new Uint8Array(await markdownToHwpx("# preview preflight"));
    const facade = {
      async generate() {
        return {
          payload: { bytes: exactArrayBuffer(generated) },
          validation: { ok: true, issues: [], entryCount: 1 },
          resultMetadata: {
            operation: "generateHwpx",
            fontNormalization: { changed: false, changedReferenceCount: 0 },
          },
          preview: {
            svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            metadata: { backend: "kordoc" },
          },
          async verifySourceUnchanged() {},
          async writeOutputExclusively(
            path: string,
            options: { companionFiles?: readonly Array<{ path: string; data: string | Uint8Array }> },
          ) {
            await writeFile(path, generated, { flag: "wx" });
            for (const companion of options.companionFiles ?? []) {
              await writeFile(companion.path, companion.data, { flag: "wx" });
            }
            return [path];
          },
          async cleanup() {},
        };
      },
    };

    const result = await handleHwpGenerateHwpx({
      markdown: "# preview preflight",
      output_path: outputPath,
      preview_svg_path: previewPath,
    }, facade as never);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "ENGINE_PROTOCOL_ERROR");
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    await assert.rejects(readFile(previewPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the common HWPX mutation writer rechecks cancellation after source verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-common-writer-cancel-"));
  const sourcePath = join(root, "source.hwpx");
  const outputDir = join(root, "prepared-output");
  const outputPath = join(outputDir, "patched.hwpx");
  const source = new Uint8Array(await markdownToHwpx("# source"));
  const patched = new Uint8Array(await markdownToHwpx("# patched"));
  await writeFile(sourcePath, source);
  const controller = new AbortController();
  const ownedSnapshot = await openDocumentSnapshot(sourcePath);
  const abortingSnapshot = {
    transport: ownedSnapshot.transport,
    metadata: ownedSnapshot.metadata,
    ...("takeTransferable" in ownedSnapshot
      ? { takeTransferable: () => ownedSnapshot.takeTransferable() }
      : { takeSpoolHandle: () => ownedSnapshot.takeSpoolHandle() }),
    async verifySourceUnchanged() {
      await ownedSnapshot.verifySourceUnchanged();
      try {
        await access(outputDir);
        controller.abort();
      } catch (error: unknown) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
    },
    cleanup: () => ownedSnapshot.cleanup(),
  };
  const facade = createDocumentEngineFacade({
    isolatedEngine: {
      async run(
        request: { operation: string },
        snapshot?: { cleanup(): Promise<void> },
      ) {
        await snapshot?.cleanup();
        if (request.operation === "patchHwpx") {
          return {
            bytes: exactArrayBuffer(patched),
            metadata: {
              operation: "patchHwpx",
              applied: 1,
              skipped: [],
              verification: {
                stats: { added: 0, removed: 0, modified: 1, unchanged: 0 },
                diffs: [],
              },
            },
          };
        }
        if (request.operation === "validateHwpx") {
          return { ok: true, issues: [], entryCount: 1 };
        }
        throw new Error(`unexpected operation: ${request.operation}`);
      },
    } as never,
    requestIdFactory: () => "common-writer-cancel",
  });

  try {
    const authorized = await facade.patch(
      abortingSnapshot as never,
      "# patched",
      { signal: controller.signal },
    );
    try {
      await assert.rejects(
        authorized.writeOutputExclusively(outputPath, {
          sourcePaths: [sourcePath],
        }),
        (error: unknown) => (error as { code?: string }).code === "REQUEST_CANCELLED",
      );
      await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    } finally {
      await authorized.cleanup();
    }
  } finally {
    await ownedSnapshot.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
