import assert from "node:assert/strict";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { markdownToHwpx } from "kordoc";

import type { DocumentEngineFacade } from "../src/shared/document-engine.js";
import { prepareDocumentRenderOutput } from "../src/shared/document-render-output.js";
import {
  captureExistingOutputDirectoryIdentity,
  preflightExclusiveOutput,
  writeFileRangeAndFilesExclusively,
  writeFileRangeExclusively,
  writeFilesExclusively,
} from "../src/shared/output.js";
import { MAX_MCP_RESPONSE_BYTES } from "../src/shared/resource-limits.js";
import {
  createInlineDocumentResultEvent,
  measureDocumentResultByteLength,
} from "../src/workers/document-protocol.js";
import { handleHwpRead } from "../src/tools/read.js";
import { handleHwpRenderPreview } from "../src/tools/preview.js";
import {
  handleHwpFillForm,
  handleHwpPatchDocument,
} from "../src/tools/patch.js";
import { handleHwpGenerateHwpx } from "../src/tools/write.js";
import {
  handleHwpCreateSvgAsset,
  handleHwpInsertImage,
} from "../src/tools/assets.js";
import { createCanonicalTemporaryDirectory } from "../../../scripts/canonical-temp.mjs";

test("defense-in-depth: hwp_read budgets oversized facade details before image and Markdown destinations", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-read-",
  });
  const sourcePath = join(root, "source.hwpx");
  const outputDir = join(root, "images");
  const markdownPath = join(root, "document.md");
  const sourceBytes = Buffer.from(await markdownToHwpx("# Atomic output"));
  await writeFile(sourcePath, sourceBytes);
  try {
    const [title, author, creator, description, version] = oversizedStrings();
    const facade = readFacade({
      fileType: "hwpx",
      markdown: "small markdown",
      metadata: { title, author, creator, description, version },
      images: [{
        filename: "seal.png",
        mimeType: "image/png",
        bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
      }],
    });

    const result = await handleHwpRead({
      file_path: sourcePath,
      output_dir: outputDir,
      markdown_output_path: markdownPath,
      extract_images: true,
    }, facade);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "RESPONSE_TOO_LARGE");
    assert.ok(Number(result.structuredContent?.response_bytes) > MAX_MCP_RESPONSE_BYTES);
    await assertMissing(outputDir);
    await assertMissing(markdownPath);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hwp_read does not create an empty image directory", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-empty-",
  });
  const sourcePath = join(root, "source.hwpx");
  const outputDir = join(root, "images");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("# No images")));
  try {
    const result = await handleHwpRead({
      file_path: sourcePath,
      output_dir: outputDir,
      extract_images: true,
    }, readFacade({ fileType: "hwpx", markdown: "no images", images: [] }));

    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent?.assets, []);
    await assertMissing(outputDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hwp_read rechecks source identity after response budgeting and before commit", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-source-",
  });
  const sourcePath = join(root, "source.hwpx");
  const markdownPath = join(root, "out", "document.md");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("# Source check")));
  let commitVerifications = 0;
  try {
    const result = await handleHwpRead({
      file_path: sourcePath,
      markdown_output_path: markdownPath,
    }, {
      async parse(snapshot) {
        const metadata = snapshot.metadata;
        try {
          await snapshot.verifySourceUnchanged();
          return {
            payload: { fileType: "hwpx", markdown: "committed markdown" },
            snapshotMetadata: metadata,
            async verifySourceUnchanged() { commitVerifications += 1; },
          };
        } finally {
          await snapshot.cleanup();
        }
      },
    } as unknown as DocumentEngineFacade);

    assert.equal(result.isError, false);
    assert.equal(commitVerifications, 1);
    assert.equal(await readFile(markdownPath, "utf8"), "committed markdown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replaced planned image directory fails with OUTPUT_CONFLICT and no suffix reselection", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-race-",
  });
  const outputDir = join(root, "images");
  const displacedDir = join(root, "images-displaced");
  const plannedPath = join(outputDir, "seal.png");
  await mkdir(outputDir);
  try {
    const identity = await captureExistingOutputDirectoryIdentity(outputDir);
    assert.ok(identity);

    await assert.rejects(
      writeFilesExclusively(
        [{ path: plannedPath, data: Uint8Array.from([1, 2, 3]) }],
        {
          expectedDirectoryIdentities: [identity],
          async beforeOpen() {
            await rename(outputDir, displacedDir);
            await mkdir(outputDir);
          },
        },
      ),
      (error: unknown) =>
        typeof error === "object" && error !== null &&
        "code" in error && error.code === "OUTPUT_CONFLICT",
    );
    await assertMissing(plannedPath);
    await assertMissing(join(outputDir, "seal_2.png"));
    await assertMissing(join(displacedDir, "seal.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive output preflight rejects existing targets and preserves parent identity", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-preflight-",
  });
  const outputDir = join(root, "output");
  const outputPath = join(outputDir, "response.json");
  const movedDirectory = join(root, "moved");
  try {
    await mkdir(outputDir);
    await writeFile(outputPath, "sentinel");
    await assert.rejects(preflightExclusiveOutput(outputPath));
    await rm(outputPath);

    const preflight = await preflightExclusiveOutput(outputPath);
    await rename(outputDir, movedDirectory);
    await mkdir(outputDir);
    await assert.rejects(
      writeFilesExclusively(
        [{ path: preflight.path, data: "response" }],
        { expectedDirectoryIdentities: preflight.expectedDirectoryIdentities },
      ),
      (error: unknown) => (error as { code?: string }).code === "OUTPUT_CONFLICT",
    );
    await assertMissing(outputPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive writers recheck parent identity after open and before payload bytes", async (t) => {
  for (const kind of ["files", "range", "range-and-files"] as const) {
    await t.test(kind, async () => {
      const root = await createCanonicalTemporaryDirectory({
        prefix: `gpt-codex-hwp-parent-swap-${kind}-`,
      });
      const outputDir = join(root, "output");
      const outputPath = join(outputDir, "document.bin");
      const companionPath = join(outputDir, "preview.txt");
      const inputPath = join(root, "input.bin");
      const payload = Buffer.from("authorized payload bytes");
      await mkdir(outputDir);
      await writeFile(inputPath, payload);
      const input = await open(inputPath, "r");
      let openCount = 0;
      let identityChanged = false;
      const unitTestAfterOpen = async (): Promise<void> => {
        openCount += 1;
        if (openCount !== (kind === "range-and-files" ? 2 : 1)) return;
        identityChanged = true;
      };
      const unitTestDirectoryIdentityCheck = (): void => {
        if (!identityChanged) return;
        throw Object.assign(new Error("simulated stable parent replacement"), {
          code: "UNSAFE_OUTPUT_PATH",
        });
      };

      try {
        const write = kind === "files"
          ? writeFilesExclusively(
              [{ path: outputPath, data: payload }],
              { unitTestAfterOpen, unitTestDirectoryIdentityCheck } as never,
            )
          : kind === "range"
            ? writeFileRangeExclusively(
                outputPath,
                { fd: input.fd, offset: 0, sizeBytes: payload.byteLength },
                { unitTestAfterOpen, unitTestDirectoryIdentityCheck } as never,
              )
            : writeFileRangeAndFilesExclusively(
                outputPath,
                { fd: input.fd, offset: 0, sizeBytes: payload.byteLength },
                [{ path: companionPath, data: "preview" }],
                { unitTestAfterOpen, unitTestDirectoryIdentityCheck } as never,
              );
        await assert.rejects(
          write,
          (error: unknown) =>
            typeof error === "object" && error !== null && "code" in error &&
            (error.code === "UNSAFE_OUTPUT_PATH" || error.code === "OUTPUT_CONFLICT"),
        );
        assert.equal((await stat(outputPath)).size, 0);
        if (kind === "range-and-files") {
          assert.equal((await stat(companionPath)).size, 0);
        } else {
          await assertMissing(companionPath);
        }
      } finally {
        await input.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("exclusive writers reject unused expected directory identities before output creation", async (t) => {
  for (const kind of ["files", "range", "range-and-files"] as const) {
    await t.test(kind, async () => {
      const root = await createCanonicalTemporaryDirectory({
        prefix: `gpt-codex-hwp-unused-identity-${kind}-`,
      });
      const unusedDir = join(root, "unused");
      const outputDir = join(root, "must-not-be-created");
      const outputPath = join(outputDir, "document.bin");
      const companionPath = join(outputDir, "preview.txt");
      const inputPath = join(root, "input.bin");
      const payload = Buffer.from("payload");
      await mkdir(unusedDir);
      await writeFile(inputPath, payload);
      const identity = await captureExistingOutputDirectoryIdentity(unusedDir);
      assert.ok(identity);
      const input = await open(inputPath, "r");
      try {
        const options = { expectedDirectoryIdentities: [identity] };
        const write = kind === "files"
          ? writeFilesExclusively([{ path: outputPath, data: payload }], options)
          : kind === "range"
            ? writeFileRangeExclusively(
                outputPath,
                { fd: input.fd, offset: 0, sizeBytes: payload.byteLength },
                options,
              )
            : writeFileRangeAndFilesExclusively(
                outputPath,
                { fd: input.fd, offset: 0, sizeBytes: payload.byteLength },
                [{ path: companionPath, data: "preview" }],
                options,
              );
        await assert.rejects(
          write,
          (error: unknown) => (error as { code?: string }).code === "OUTPUT_CONFLICT",
        );
        await assertMissing(outputDir);
      } finally {
        await input.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("render preparation validates metadata without creating the destination", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-prepare-",
  });
  const outputPath = join(root, "preview.svg");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>';
  try {
    const prepared = await prepareDocumentRenderOutput({
      payload: { svg, metadata: { backend: "kordoc", pageCount: 1 } },
      async verifySourceUnchanged() {},
    });
    assert.deepEqual(prepared.metadata, { backend: "kordoc", pageCount: 1 });
    await assertMissing(outputPath);
    await prepared.writeExclusively(outputPath);
    assert.equal(await readFile(outputPath, "utf8"), svg);
    await prepared.cleanup();
    await prepared.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defense-in-depth: hwp_render_preview rejects oversized facade details before creating SVG output", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-preview-",
  });
  const sourcePath = join(root, "source.hwpx");
  const outputPath = join(root, "preview.svg");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("# Preview")));
  try {
    const padding = Array.from({ length: 5 }, () => "p".repeat(860_000));
    const result = await handleHwpRenderPreview({
      file_path: sourcePath,
      output_svg_path: outputPath,
    }, {
      async render(snapshot) {
        const metadata = snapshot.metadata;
        try {
          await snapshot.verifySourceUnchanged();
          return {
            payload: {
              svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
              metadata: {
                backend: "kordoc",
                pageCount: 1,
                width: 612,
                height: 792,
                warnings: [],
                stats: { padding },
              },
            },
            snapshotMetadata: metadata,
            async verifySourceUnchanged() {},
          };
        } finally {
          await snapshot.cleanup();
        }
      },
    } as unknown as DocumentEngineFacade);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "RESPONSE_TOO_LARGE");
    await assertMissing(outputPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defense-in-depth: hwp_generate_hwpx rejects oversized facade preview details before writing outputs", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-generate-",
  });
  const outputPath = join(root, "generated.hwpx");
  const previewPath = join(root, "generated.svg");
  let writes = 0;
  try {
    const result = await handleHwpGenerateHwpx({
      markdown: "# Generated",
      output_path: outputPath,
      preview_svg_path: previewPath,
    }, {
      async generate() {
        return authorizedHwpxResult({
          resultMetadata: {
            operation: "generateHwpx",
            fontNormalization: { changed: false, changedReferenceCount: 0 },
          },
          preview: {
            svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            metadata: {
              backend: "kordoc",
              pageCount: 1,
              width: 612,
              height: 792,
              warnings: [],
              stats: { padding: oversizedStrings() },
            },
          },
          onWrite: () => { writes += 1; },
        });
      },
    } as unknown as DocumentEngineFacade);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "RESPONSE_TOO_LARGE");
    assert.equal(writes, 0);
    await assertMissing(outputPath);
    await assertMissing(previewPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defense-in-depth: hwp_patch_document rejects oversized facade verification before writing output", async () => {
  const fixture = await mutationFixture("patch");
  let writes = 0;
  try {
    const result = await handleHwpPatchDocument({
      file_path: fixture.sourcePath,
      edited_markdown: "# Patched",
      output_path: fixture.outputPath,
    }, {
      async patch(snapshot) {
        await consumeSnapshot(snapshot);
        return authorizedHwpxResult({
          resultMetadata: {
            operation: "patchHwpx",
            applied: 1,
            skipped: [],
            verification: {
              stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
              diffs: oversizedStrings(),
            },
          },
          onWrite: () => { writes += 1; },
        });
      },
    } as unknown as DocumentEngineFacade);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "RESPONSE_TOO_LARGE");
    assert.equal(writes, 0);
    await assertMissing(fixture.outputPath);
  } finally {
    await fixture.cleanup();
  }
});

test("defense-in-depth: hwp_fill_form rejects oversized facade field details before writing output", async () => {
  const fixture = await mutationFixture("fill");
  let writes = 0;
  try {
    const values = oversizedStrings();
    const fields = Object.fromEntries(
      values.map((value, index) => [`field-${index}`, value]),
    );
    const result = await handleHwpFillForm({
      file_path: fixture.sourcePath,
      fields,
      output_path: fixture.outputPath,
      mask_values: false,
    }, {
      async fill(snapshot) {
        await consumeSnapshot(snapshot);
        return authorizedHwpxResult({
          resultMetadata: {
            operation: "fillHwpx",
            filled: values.map((value, index) => ({
              label: `field-${index}`,
              value,
              row: index,
              col: 0,
            })),
            unmatched: [],
            rejected: [],
          },
          onWrite: () => { writes += 1; },
        });
      },
    } as unknown as DocumentEngineFacade);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "RESPONSE_TOO_LARGE");
    assert.equal(writes, 0);
    await assertMissing(fixture.outputPath);
  } finally {
    await fixture.cleanup();
  }
});

test("defense-in-depth: hwp_insert_image rejects oversized facade warnings before writing output", async () => {
  const fixture = await mutationFixture("insert-image");
  const imagePath = join(fixture.root, "seal.png");
  await writeFile(
    imagePath,
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
  );
  let writes = 0;
  try {
    const result = await handleHwpInsertImage({
      file_path: fixture.sourcePath,
      image_path: imagePath,
      output_path: fixture.outputPath,
      anchor_text: "(인)",
      mode: "seal-anchor",
    }, {
      async insertImage(documentSnapshot, imageSnapshot) {
        await Promise.all([
          consumeSnapshot(documentSnapshot),
          consumeSnapshot(imageSnapshot),
        ]);
        return authorizedHwpxResult({
          resultMetadata: {
            operation: "insertImage",
            mode: "seal-anchor",
            placed: [{
              anchor: "(인)",
              occurrence: 0,
              sectionIndex: 0,
              mode: "overlap",
              posXMm: 0,
              posYMm: 0,
              sizeMm: 12,
              entry: "BinData/image1.png",
              warnings: Array.from({ length: 500 }, () => "w".repeat(8_600)),
            }],
          },
          onWrite: () => { writes += 1; },
        });
      },
    } as unknown as DocumentEngineFacade);

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "RESPONSE_TOO_LARGE");
    assert.equal(writes, 0);
    await assertMissing(fixture.outputPath);
  } finally {
    await fixture.cleanup();
  }
});

test("defense-in-depth: hwp_create_svg_asset budgets an oversized PNG fallback warning before writing SVG", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-svg-",
  });
  const svgPath = join(root, "asset.svg");
  const pngPath = join(root, "asset.png");
  try {
    const result = await handleHwpCreateSvgAsset({
      prompt_or_spec: '<svg width="10" height="10"></svg>',
      output_svg_path: svgPath,
      output_png_path: pngPath,
    }, {
      async validateSvg() {},
      async renderSvgToPng() {
        throw new Error("r".repeat(4_300_000));
      },
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "RESPONSE_TOO_LARGE");
    await assertMissing(svgPath);
    await assertMissing(pngPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol accepts exact-schema metadata below the one-MiB aggregate ceiling", () => {
  const bounded = Array.from({ length: 5 }, () => "b".repeat(180_000));
  const [title, author, creator, description, version] = bounded;
  const parsePayload = {
    markdown: "normal read",
    fileType: "hwpx" as const,
    warnings: [],
    images: [],
    metadata: { title, author, creator, description, version },
  };
  const patchPayload = {
    bytes: Uint8Array.from([1]).buffer,
    metadata: {
      operation: "patchHwpx",
      applied: 1,
      skipped: [],
      verification: {
        stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
        diffs: bounded,
      },
    },
  };
  const fillPayload = {
    bytes: Uint8Array.from([1]).buffer,
    metadata: {
      operation: "fillHwpx",
      filled: bounded.map((value, index) => ({
        label: `field-${index}`,
        value,
        row: index,
        col: 0,
      })),
      unmatched: [],
      rejected: [],
    },
  };
  const insertPayload = {
    bytes: Uint8Array.from([1]).buffer,
    metadata: {
      operation: "insertImage",
      mode: "seal-anchor",
      placed: [{
        anchor: "(인)",
        occurrence: 0,
        sectionIndex: 0,
        mode: "overlap",
        posXMm: 0,
        posYMm: 0,
        sizeMm: 12,
        entry: "BinData/image1.png",
        warnings: Array.from({ length: 100 }, () => "w".repeat(8_000)),
      }],
    },
  };

  for (const [requestId, operation, payload] of [
    ["atomic-normal-parse", "parse", parsePayload],
    ["atomic-normal-patch", "patchHwpx", patchPayload],
    ["atomic-normal-fill", "fillHwpx", fillPayload],
    ["atomic-normal-insert", "insertImage", insertPayload],
  ] as const) {
    assert.ok(measureDocumentResultByteLength(operation, payload) > 0);
    const event = createInlineDocumentResultEvent(requestId, operation, payload);
    assert.equal(event.type, "result");
  }
});

test("hwp_read commits image and Markdown for protocol-valid near-ceiling metadata", async () => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-output-budget-near-limit-",
  });
  const sourcePath = join(root, "source.hwpx");
  const outputDir = join(root, "images");
  const markdownPath = join(root, "document.md");
  const sourceBytes = Buffer.from(await markdownToHwpx("# Near limit"));
  await writeFile(sourcePath, sourceBytes);
  try {
    const bounded = Array.from({ length: 5 }, () => "n".repeat(180_000));
    const [title, author, creator, description, version] = bounded;
    const payload = {
      fileType: "hwpx" as const,
      markdown: "near-limit markdown",
      warnings: [],
      images: [{
        filename: "seal.png",
        mimeType: "image/png",
        bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
      }],
      metadata: { title, author, creator, description, version },
    };
    assert.ok(measureDocumentResultByteLength("parse", payload) > 900_000);

    const result = await handleHwpRead({
      file_path: sourcePath,
      output_dir: outputDir,
      markdown_output_path: markdownPath,
      extract_images: true,
    }, readFacade(payload));

    assert.equal(result.isError, false);
    const assets = result.structuredContent?.assets as string[];
    assert.equal(assets.length, 1);
    assert.deepEqual(
      await readFile(assets[0]!),
      Buffer.from(payload.images[0]!.bytes),
    );
    assert.equal(await readFile(markdownPath, "utf8"), payload.markdown);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function readFacade(
  payload: Readonly<Record<string, unknown>>,
): DocumentEngineFacade {
  return {
    async parse(snapshot) {
      const metadata = snapshot.metadata;
      const verifySourceUnchanged = () => snapshot.verifySourceUnchanged();
      try {
        await verifySourceUnchanged();
        return {
          payload,
          snapshotMetadata: metadata,
          verifySourceUnchanged,
        } as never;
      } finally {
        await snapshot.cleanup();
      }
    },
  } as unknown as DocumentEngineFacade;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

function oversizedStrings(): string[] {
  // Deliberately exceeds the current one-MiB aggregate Safe JSON guard. These
  // facade-contract-violation fixtures keep the tool boundary fail-closed if a
  // future engine contract permits larger metadata.
  return Array.from({ length: 5 }, () => "z".repeat(860_000));
}

async function mutationFixture(label: string): Promise<{
  readonly root: string;
  readonly sourcePath: string;
  readonly outputPath: string;
  cleanup(): Promise<void>;
}> {
  const root = await createCanonicalTemporaryDirectory({
    prefix: `gpt-codex-hwp-output-budget-${label}-`,
  });
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx(`# ${label}`)));
  return {
    root,
    sourcePath,
    outputPath: join(root, "output.hwpx"),
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

async function consumeSnapshot(snapshot: {
  verifySourceUnchanged(): Promise<void>;
  cleanup(): Promise<void>;
}): Promise<void> {
  try {
    await snapshot.verifySourceUnchanged();
  } finally {
    await snapshot.cleanup();
  }
}

function authorizedHwpxResult({
  resultMetadata,
  validation = { ok: true, issues: [], entryCount: 1 },
  preview,
  onWrite,
}: {
  readonly resultMetadata: Readonly<Record<string, unknown>>;
  readonly validation?: Readonly<{
    ok: boolean;
    issues: readonly Readonly<Record<string, unknown>>[];
    entryCount: number;
  }>;
  readonly preview?: Readonly<{
    svg: string;
    metadata: Readonly<Record<string, unknown>>;
  }>;
  readonly onWrite: () => void;
}): object {
  let cleaned = false;
  return {
    payload: {
      bytes: Uint8Array.from([1, 2, 3]).buffer,
      metadata: resultMetadata,
    },
    resultMetadata,
    validation,
    ...(preview === undefined ? {} : { preview }),
    async writeOutputExclusively(
      outputPath: string,
      options: Readonly<{
        companionFiles?: readonly Readonly<{
          path: string;
          data: string | Uint8Array;
        }>[];
      }> = {},
    ) {
      assert.equal(cleaned, false);
      onWrite();
      await writeFilesExclusively([
        { path: outputPath, data: Uint8Array.from([1, 2, 3]) },
        ...(options.companionFiles ?? []),
      ]);
    },
    async cleanup() { cleaned = true; },
  };
}
