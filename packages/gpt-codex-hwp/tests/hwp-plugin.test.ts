import assert from "node:assert/strict";
import {
  access,
  link,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import JSZip from "jszip";
import {
  markdownToHwpx,
  parse,
  placeSealHwpx,
  validateHwpx,
  type ParseOptions,
  type ParseResult,
  type RenderSvgOptions,
  type RenderSvgResult,
  type ValidateResult,
} from "kordoc";
import { createCanonicalTemporaryDirectory } from "../../../scripts/canonical-temp.mjs";

import {
  inspectHwpxFontReferences,
  normalizeGeneratedFontReferences,
} from "../src/shared/hwpx-font-integrity.js";
import {
  createAllowedRootsPolicy,
  resetActiveAllowedRootsPolicy,
  setActiveAllowedRootsPolicy,
} from "../src/shared/allowed-roots.js";
import { writeFilesExclusively } from "../src/shared/output.js";
import {
  MAX_FILL_VALUES,
  MAX_HIGHLIGHT_CHARACTERS,
  MAX_HIGHLIGHT_TERMS,
  MAX_MCP_RESPONSE_BYTES,
  MAX_PREVIEW_SVG_BYTES,
  assertFillValueBudget,
  assertHighlightBudget,
  assertSerializedBudget,
  assertUtf8Budget,
} from "../src/shared/resource-limits.js";

interface DetectToolModule {
  handleHwpDetectFormat(input: {
    file_path: string;
  }): Promise<CallToolResult>;
}

type ParseDocument = (
  input: string | ArrayBuffer | Buffer,
  options?: ParseOptions & {
    snapshotMetadata?: Readonly<{
      sizeBytes: number;
      sha256: string;
      shallowFormat: { candidate: string };
      protection: { status: string };
    }>;
  },
) => Promise<ParseResult>;

interface ReadToolModule {
  handleHwpRead(
    input: {
      file_path: string;
      output_dir?: string;
      markdown_output_path?: string;
      pages?: string;
      extract_images?: boolean;
    },
    parseDocument?: ParseDocument,
  ): Promise<CallToolResult>;
}

type RenderDocument = (
  input: ArrayBuffer | Uint8Array,
  options?: RenderSvgOptions,
) => Promise<RenderSvgResult>;

interface GenerationFacadeOptions {
  readonly preset?: "official" | "report" | "plan" | "notice" | "minutes";
  readonly renderPreview?: boolean;
}

interface GenerationFacadeFixture {
  readonly bytes: Uint8Array;
  readonly validation?: Readonly<{
    ok: boolean;
    issues: readonly Readonly<{ code?: string; message: string; entry?: string }>[];
    entryCount: number;
  }>;
  readonly resultMetadata?: Readonly<Record<string, unknown>>;
  readonly preview?: Readonly<{
    svg: string;
    metadata: Readonly<Record<string, unknown>>;
  }>;
}

type GenerateThroughFacade = (
  markdown: string,
  options: GenerationFacadeOptions,
) => Promise<GenerationFacadeFixture>;

interface WriteToolModule {
  handleHwpGenerateHwpx(
    input: {
      markdown: string;
      output_path: string;
      preset?: "official" | "report" | "plan" | "notice" | "minutes";
      validate?: boolean;
      preview_svg_path?: string;
    },
    facade?: object,
  ): Promise<CallToolResult>;
  handleHwpValidate(
    input: { file_path: string },
    facade?: object,
  ): Promise<CallToolResult>;
}

interface PreviewToolModule {
  handleHwpRenderPreview(
    input: {
      file_path: string;
      output_svg_path: string;
      reflow?: boolean;
      highlight?: string[];
    },
    dependencies?: RenderDocument | {
      renderDocument?: RenderDocument;
      loadRhwpBackend?: () => Promise<
        | { available: true; backend: unknown }
        | { available: false; reason: string }
      >;
    },
  ): Promise<CallToolResult>;
}

const SOURCE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fixturePath = join(SOURCE_ROOT, "tests", "fixtures", "simple.md");
let tmpRoot = "";
let simplePath = "";
const generatedPaths = new Set<string>();
let simpleHwpxBytes: Uint8Array;

test("shared resource budgets accept their exact boundary and reject limit plus one", () => {
  assert.doesNotThrow(() =>
    assertHighlightBudget(Array(MAX_HIGHLIGHT_TERMS).fill("x")),
  );
  assert.throws(
    () => assertHighlightBudget(Array(MAX_HIGHLIGHT_TERMS + 1).fill("x")),
    /highlight/iu,
  );
  assert.doesNotThrow(() =>
    assertHighlightBudget(Array(64).fill("x".repeat(256))),
  );
  assert.throws(
    () => assertHighlightBudget([...Array(64).fill("x".repeat(256)), "x"]),
    /highlight/iu,
  );
  assert.doesNotThrow(() =>
    assertFillValueBudget({ field: Array(MAX_FILL_VALUES).fill("") }),
  );
  assert.throws(
    () => assertFillValueBudget({ field: Array(MAX_FILL_VALUES + 1).fill("") }),
    /value count/iu,
  );
  assert.doesNotThrow(() => assertSerializedBudget({ text: "123" }, 14));
  assert.throws(() => assertSerializedBudget({ text: "1234" }, 14), /serialized/iu);
  assert.doesNotThrow(() => assertUtf8Budget("1234", 4, "test payload"));
  assert.throws(() => assertUtf8Budget("12345", 4, "test payload"), /test payload/iu);
});

async function loadDetectTool(): Promise<DetectToolModule> {
  try {
    return (await import("../src/tools/detect.js")) as DetectToolModule;
  } catch (error: unknown) {
    assert.fail(
      `The hwp_detect_format module should be implemented: ${errorMessage(error)}`,
    );
  }
}

async function loadReadTool(): Promise<ReadToolModule> {
  try {
    const module = await import("../src/tools/read.js");
    return {
      handleHwpRead: (input, parseDocument) => module.handleHwpRead(
        input,
        parseDocument === undefined
          ? undefined
          : testReadFacade(parseDocument) as never,
      ),
    };
  } catch (error: unknown) {
    assert.fail(`The hwp_read module should be implemented: ${errorMessage(error)}`);
  }
}

async function loadWriteTool(): Promise<WriteToolModule> {
  try {
    return (await import("../src/tools/write.js")) as WriteToolModule;
  } catch (error: unknown) {
    assert.fail(
      `The HWPX generation and validation module should be implemented: ${errorMessage(error)}`,
    );
  }
}

async function loadPreviewTool(): Promise<PreviewToolModule> {
  try {
    const module = await import("../src/tools/preview.js");
    return {
      handleHwpRenderPreview: (input, dependencies) => {
        const renderer = typeof dependencies === "function"
          ? dependencies
          : dependencies?.renderDocument;
        return module.handleHwpRenderPreview(
          input,
          renderer === undefined
            ? undefined
            : testPreviewFacade(renderer) as never,
        );
      },
    };
  } catch (error: unknown) {
    assert.fail(
      `The HWPX preview module should be implemented: ${errorMessage(error)}`,
    );
  }
}

function testReadFacade(parseDocument: ParseDocument): object {
  return {
    async parse(
      snapshot: {
        metadata: Readonly<{
          sizeBytes: number;
          sha256: string;
          shallowFormat: { candidate: string };
          protection: { status: string };
        }>;
        verifySourceUnchanged(): Promise<void>;
        cleanup(): Promise<void>;
      },
      options: { pages?: string },
    ) {
      const verifySourceUnchanged = () => snapshot.verifySourceUnchanged();
      let parsed: ParseResult;
      try {
        parsed = await parseDocument(new ArrayBuffer(0), {
          ...(options.pages === undefined ? {} : { pages: options.pages }),
          snapshotMetadata: snapshot.metadata,
        });
      } finally {
        await snapshot.cleanup();
      }
      await verifySourceUnchanged();
      if (!parsed.success) {
        const error = new Error(parsed.error) as Error & { code: string };
        error.code = parsed.code ?? "PARSE_ERROR";
        throw error;
      }
      return {
        payload: {
          markdown: parsed.markdown,
          fileType: parsed.fileType,
          ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
          ...(parsed.pageCount === undefined ? {} : { pageCount: parsed.pageCount }),
          ...(parsed.isImageBased === undefined
            ? {}
            : { isImageBased: parsed.isImageBased }),
          warnings: (parsed.warnings ?? []).map((warning) => ({ ...warning })),
          images: (parsed.images ?? []).map((image) => ({
            filename: image.filename,
            mimeType: image.mimeType,
            bytes: Uint8Array.from(image.data).buffer,
          })),
        },
        snapshotMetadata: snapshot.metadata,
        verifySourceUnchanged,
      };
    },
  };
}

function testPreviewFacade(renderDocument: RenderDocument): object {
  return {
    async render(
      snapshot: {
        metadata: unknown;
        verifySourceUnchanged(): Promise<void>;
        cleanup(): Promise<void>;
      },
      options: RenderSvgOptions,
    ) {
      let rendered: RenderSvgResult;
      try {
        rendered = await renderDocument(new Uint8Array(0), options);
      } finally {
        await snapshot.cleanup();
      }
      await snapshot.verifySourceUnchanged();
      return {
        payload: {
          svg: rendered.svg,
          metadata: {
            backend: "kordoc",
            pageCount: rendered.pageCount,
            width: rendered.width,
            height: rendered.height,
            warnings: [...rendered.warnings],
            stats: { ...rendered.stats },
          },
        },
        snapshotMetadata: snapshot.metadata,
        verifySourceUnchanged: () => snapshot.verifySourceUnchanged(),
      };
    },
  };
}

function structuredDetails(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function parseWithImage(
  filename: string,
  data: Uint8Array,
): ParseDocument {
  return async () => ({
    success: true,
    fileType: "hwp",
    markdown: `![image](${filename})`,
    blocks: [],
    images: [
      {
        filename,
        data,
        mimeType: "image/png",
      },
    ],
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function arrayBufferOf(...bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function renderedSvg(svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'): RenderSvgResult {
  return {
    svg,
    width: 595.28,
    height: 841.89,
    pageCount: 1,
    warnings: [],
    stats: { texts: 1, images: 0, tables: 0 },
  };
}

function renderedDocumentPreview(
  svg = '<svg xmlns="http://www.w3.org/2000/svg"/>',
): Readonly<{ svg: string; metadata: Readonly<Record<string, unknown>> }> {
  const rendered = renderedSvg(svg);
  return {
    svg: rendered.svg,
    metadata: {
      backend: "kordoc",
      pageCount: rendered.pageCount,
      width: rendered.width,
      height: rendered.height,
      warnings: [...rendered.warnings],
      stats: { ...rendered.stats },
    },
  };
}

function testGenerationFacade(generate: GenerateThroughFacade): object {
  return {
    async generate(markdown: string, options: GenerationFacadeOptions) {
      const fixture = await generate(markdown, options);
      const bytes = Uint8Array.from(fixture.bytes);
      const resultMetadata = fixture.resultMetadata ?? {
        operation: "generateHwpx",
        fontNormalization: {
          changed: false,
          changedReferenceCount: 0,
        },
      };
      let cleaned = false;
      return {
        payload: {
          bytes: Uint8Array.from(bytes).buffer,
          metadata: resultMetadata,
        },
        validation: fixture.validation ?? {
          ok: true,
          issues: [],
          entryCount: 1,
        },
        resultMetadata,
        ...(fixture.preview === undefined ? {} : { preview: fixture.preview }),
        async verifySourceUnchanged() {},
        async writeOutputExclusively(
          outputPath: string,
          outputOptions: Readonly<{
            companionFiles?: readonly Readonly<{
              path: string;
              data: string | Uint8Array;
            }>[];
          }> = {},
        ) {
          assert.equal(cleaned, false);
          return writeFilesExclusively([
            { path: outputPath, data: bytes },
            ...(outputOptions.companionFiles ?? []),
          ]);
        },
        async cleanup() {
          cleaned = true;
        },
      };
    },
  };
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

before(async () => {
  tmpRoot = await createCanonicalTemporaryDirectory({ prefix: "gpt-codex-hwp-source-tests-" });
  simplePath = join(tmpRoot, "simple.hwpx");
  const markdown = await readFile(fixturePath, "utf8");
  simpleHwpxBytes = (
    await normalizeGeneratedFontReferences(await markdownToHwpx(markdown))
  ).bytes;
  await writeFile(simplePath, simpleHwpxBytes);
  generatedPaths.add(simplePath);
});

after(async () => {
  for (const path of generatedPaths) {
    await rm(path, { recursive: true, force: true });
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

test("hwp_detect_format refines the generated ZIP container to HWPX", async () => {
  const { handleHwpDetectFormat } = await loadDetectTool();

  const result = await handleHwpDetectFormat({ file_path: simplePath });

  assert.equal(result.isError, false);
  assert.deepEqual(structuredDetails(result), {
    format: "hwpx",
    details: {
      file_path: simplePath,
      file_size_bytes: (await stat(simplePath)).size,
      container_format: "zip",
    },
  });
});

test("hwp_detect_format treats unknown as a valid result and reads only the requested file", async () => {
  const { handleHwpDetectFormat } = await loadDetectTool();
  const exactFileDir = join(tmpRoot, "exact-file-detection");
  const requestedPath = join(exactFileDir, "requested.bin");
  const siblingPath = join(exactFileDir, "sibling.hwpx");
  await mkdir(exactFileDir, { recursive: true });
  await writeFile(requestedPath, "not a document");
  await writeFile(siblingPath, simpleHwpxBytes);
  generatedPaths.add(exactFileDir);

  const result = await handleHwpDetectFormat({ file_path: requestedPath });
  const details = structuredDetails(result);

  assert.equal(result.isError, false);
  assert.equal(details.format, "unknown");
  assert.deepEqual(details.details, {
    file_path: requestedPath,
    file_size_bytes: (await stat(requestedPath)).size,
    detection_warning: "The OLE2 container is not a supported HWP document.",
  });
});

test("hwp_detect_format preserves Korean NFC and NFD filename paths", async (t) => {
  const { handleHwpDetectFormat } = await loadDetectTool();
  const filenameBase = "한글문서";
  const names = [
    `${filenameBase.normalize("NFC")}.hwpx`,
    `${filenameBase.normalize("NFD")}.hwpx`,
  ];
  assert.notEqual(names[0], names[1]);

  for (const filename of names) {
    await t.test(filename.normalize("NFC") === filename ? "NFC" : "NFD", async () => {
      const filePath = join(tmpRoot, filename);
      await writeFile(filePath, simpleHwpxBytes);
      generatedPaths.add(filePath);

      const result = await handleHwpDetectFormat({ file_path: filePath });
      const details = structuredDetails(result);

      assert.equal(result.isError, false);
      assert.equal(details.format, "hwpx");
      assert.equal(
        (details.details as Record<string, unknown>).file_path,
        filePath,
      );
    });
  }
});

test("hwp_read round-trips Korean heading, paragraph, and table text", async () => {
  const { handleHwpRead } = await loadReadTool();

  const result = await handleHwpRead({ file_path: simplePath, pages: "1" });
  const details = structuredDetails(result);

  assert.equal(result.isError, false);
  assert.match(String(details.markdown), /테스트 문서/);
  assert.match(String(details.markdown), /첫 번째 문단입니다/);
  assert.match(String(details.markdown), /홍길동/);
  assert.ok(details.metadata && typeof details.metadata === "object");
  assert.ok(Array.isArray(details.warnings));
  assert.deepEqual(details.assets, []);
});

test("hwp_read shares one immutable snapshot's format, protection, hash, and pages with the facade", async () => {
  const { handleHwpRead } = await loadReadTool();
  let callCount = 0;
  const parseDocument: ParseDocument = async (input, options) => {
    callCount += 1;
    assert.ok(input instanceof ArrayBuffer);
    assert.equal(input.byteLength, 0);
    assert.equal(options?.pages, "1-2");
    assert.equal(options?.snapshotMetadata?.sizeBytes, (await stat(simplePath)).size);
    assert.equal(options?.snapshotMetadata?.shallowFormat.candidate, "hwpx");
    assert.equal(
      options?.snapshotMetadata?.protection.status,
      "requires-engine-validation",
    );
    assert.match(String(options?.snapshotMetadata?.sha256), /^[0-9a-f]{64}$/u);
    return {
      success: true,
      fileType: "hwpx",
      markdown: "테스트",
      blocks: [],
    };
  };

  const result = await handleHwpRead(
    { file_path: simplePath, pages: "1-2" },
    parseDocument,
  );

  assert.equal(result.isError, false);
  assert.equal(callCount, 1);
});

test("hwp_read rejects non-HWP/HWPX formats before Kordoc parsing", async () => {
  const { handleHwpRead } = await loadReadTool();
  const pdfPath = join(tmpRoot, "unsupported.pdf");
  const docxPath = join(tmpRoot, "unsupported.docx");
  generatedPaths.add(pdfPath);
  generatedPaths.add(docxPath);
  await writeFile(pdfPath, Buffer.from("%PDF-1.7\n"));
  const docx = new JSZip();
  docx.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  docx.file("word/document.xml", "<document/>");
  await writeFile(docxPath, await docx.generateAsync({ type: "uint8array" }));

  let parseCalls = 0;
  for (const filePath of [pdfPath, docxPath]) {
    const result = await handleHwpRead(
      { file_path: filePath },
      async () => {
        parseCalls += 1;
        return {
          success: false,
          fileType: "unknown",
          error: "Only HWP and HWPX documents are supported.",
          code: "UNSUPPORTED_FORMAT",
        } as ParseResult;
      },
    );
    const details = structuredDetails(result);
    assert.equal(result.isError, true);
    assert.equal(details.code, "UNSUPPORTED_FORMAT");
    assert.equal(details.file_path, filePath);
    assert.deepEqual(details.supported_formats, ["hwp", "hwpx"]);
  }
  assert.equal(parseCalls, 1);
});

test("hwp_read preserves a signed-document refusal returned by the isolate facade", async () => {
  const { handleHwpRead } = await loadReadTool();
  const signedPath = join(tmpRoot, "signed-read.hwpx");
  generatedPaths.add(signedPath);
  const zip = await JSZip.loadAsync(await markdownToHwpx("서명된 본문"));
  zip.file("_xmlsignatures/sig1.xml", "<Signature/>");
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(
    signedPath,
    await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );
  let parseCalls = 0;

  const result = await handleHwpRead(
    { file_path: signedPath },
    async () => {
      parseCalls += 1;
      return {
        success: false,
        fileType: "hwpx",
        error: "The exact HWPX package contains an electronic-signature entry.",
        code: "SIGNED_DOCUMENT",
      };
    },
  );

  assert.equal(result.isError, true);
  assert.equal(structuredDetails(result).code, "SIGNED_DOCUMENT");
  assert.equal(parseCalls, 1);
});

test("hwp_read propagates structured parse failure codes as MCP errors", async () => {
  const { handleHwpRead } = await loadReadTool();
  const parseDocument: ParseDocument = async () => ({
    success: false,
    fileType: "hwp",
    error: "The document is DRM protected.",
    code: "DRM_PROTECTED",
  });

  const result = await handleHwpRead({ file_path: simplePath }, parseDocument);
  const details = structuredDetails(result);

  assert.equal(result.isError, true);
  assert.equal(details.code, "DRM_PROTECTED");
  assert.equal(details.error, "The document is DRM protected.");
});

test("hwp_read propagates ENCRYPTED as a structured MCP error", async () => {
  const { handleHwpRead } = await loadReadTool();
  const parseDocument: ParseDocument = async () => ({
    success: false,
    fileType: "hwp",
    error: "The document is encrypted.",
    code: "ENCRYPTED",
  });

  const result = await handleHwpRead({ file_path: simplePath }, parseDocument);
  const details = structuredDetails(result);

  assert.equal(result.isError, true);
  assert.equal(details.code, "ENCRYPTED");
  assert.equal(details.error, "The document is encrypted.");
});

test("hwp_read accepts exactly 64,000 inline Markdown characters", async () => {
  const { handleHwpRead } = await loadReadTool();
  const markdown = "가".repeat(64_000);
  const result = await handleHwpRead(
    { file_path: simplePath },
    async () => ({
      success: true,
      fileType: "hwpx",
      markdown,
      blocks: [],
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(structuredDetails(result).markdown, markdown);
});

test("hwp_read requires markdown_output_path above 64,000 characters", async () => {
  const { handleHwpRead } = await loadReadTool();
  const result = await handleHwpRead(
    { file_path: simplePath },
    async () => ({
      success: true,
      fileType: "hwpx",
      markdown: "가".repeat(64_001),
      blocks: [],
    }),
  );

  assert.equal(result.isError, true);
  const resultDetails = structuredDetails(result);
  assert.equal(resultDetails.code, "RESPONSE_TOO_LARGE");
  assert.equal(resultDetails.markdown_characters, 64_001);
  assert.equal(resultDetails.maximum_inline_characters, 64_000);
  assert.match(String(resultDetails.guidance), /markdown_output_path/u);
});

test("hwp_read parses once and saves complete Markdown with a 64,000-character preview", async () => {
  const { handleHwpRead } = await loadReadTool();
  const outputPath = join(tmpRoot, "complete-read.md");
  const fullMarkdown = "가".repeat(64_001);
  let parseCalls = 0;
  generatedPaths.add(outputPath);

  const result = await handleHwpRead(
    { file_path: simplePath, markdown_output_path: outputPath },
    async () => {
      parseCalls += 1;
      return {
        success: true,
        fileType: "hwpx",
        markdown: fullMarkdown,
        blocks: [],
      };
    },
  );

  const details = structuredDetails(result);
  assert.equal(result.isError, false);
  assert.equal(String(details.markdown).length, 64_000);
  assert.equal(details.markdown_truncated, true);
  assert.equal(details.markdown_path, outputPath);
  assert.equal(details.markdown_characters, 64_001);
  assert.equal(details.markdown_bytes, Buffer.byteLength(fullMarkdown, "utf8"));
  assert.equal(details.recommended_chunk_characters, 64_000);
  assert.equal(typeof details.source_fingerprint, "string");
  assert.equal(String(details.source_fingerprint).length, 64);
  assert.equal(await readFile(outputPath, "utf8"), fullMarkdown);
  assert.equal(parseCalls, 1);
});

test("hwp_read refuses unsafe Markdown output targets without overwriting", async (t) => {
  const { handleHwpRead } = await loadReadTool();
  setActiveAllowedRootsPolicy(
    await createAllowedRootsPolicy(JSON.stringify([tmpRoot])),
  );
  t.after(() => resetActiveAllowedRootsPolicy());
  const root = join(tmpRoot, "markdown-output-safety");
  const existingPath = join(root, "existing.md");
  const sourcePath = join(root, "source.md");
  const hardlinkPath = join(root, "source-hardlink.md");
  const original = Buffer.from(simpleHwpxBytes);
  generatedPaths.add(root);
  await mkdir(root, { recursive: true });
  await writeFile(existingPath, original);
  await writeFile(sourcePath, original);
  await link(sourcePath, hardlinkPath);

  const parseDocument: ParseDocument = async () => ({
    success: true,
    fileType: "hwp",
    markdown: "본문",
    blocks: [],
  });

  for (const [name, filePath, outputPath, expectedCode] of [
    ["existing output", simplePath, existingPath, "OUTPUT_CONFLICT"],
    ["source-equal output", sourcePath, sourcePath, "PATH_ALIAS"],
    ["source hardlink", sourcePath, hardlinkPath, "PATH_ALIAS"],
    ["wrong extension", simplePath, join(root, "wrong.txt"), "INVALID_MARKDOWN_OUTPUT_PATH"],
  ] as const) {
    await t.test(name, async () => {
      const result = await handleHwpRead(
        { file_path: filePath, markdown_output_path: outputPath },
        parseDocument,
      );
      assert.equal(result.isError, true);
      assert.equal(structuredDetails(result).code, expectedCode);
    });
  }

  assert.deepEqual(await readFile(existingPath), original);
  assert.deepEqual(await readFile(sourcePath), original);
  assert.deepEqual(await readFile(hardlinkPath), original);
});

test("hwp_read budgets the aggregate result before writing Markdown output", async () => {
  const { handleHwpRead } = await loadReadTool();
  const outputPath = join(tmpRoot, "must-not-be-written.md");
  generatedPaths.add(outputPath);

  const result = await handleHwpRead(
    { file_path: simplePath, markdown_output_path: outputPath },
    async () => ({
      success: true,
      fileType: "hwpx",
      markdown: "작은 본문",
      blocks: [],
      metadata: { padding: "x".repeat(MAX_MCP_RESPONSE_BYTES) },
    }),
  );

  assert.equal(result.isError, true);
  assert.equal(structuredDetails(result).code, "RESPONSE_TOO_LARGE");
  assert.equal(await pathExists(outputPath), false);
});

test("hwp_read rejects an aggregate MCP result above eight MiB", async () => {
  const { handleHwpRead } = await loadReadTool();
  const result = await handleHwpRead(
    { file_path: simplePath },
    async () => ({
      success: true,
      fileType: "hwpx",
      markdown: "작은 본문",
      blocks: [],
      metadata: { padding: "x".repeat(MAX_MCP_RESPONSE_BYTES) },
    }),
  );

  assert.equal(result.isError, true);
  const resultDetails = structuredDetails(result);
  assert.equal(resultDetails.code, "RESPONSE_TOO_LARGE");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`x{${MAX_MCP_RESPONSE_BYTES}}`, "u"));
});

test("hwp_read budgets the final MCP result rather than details alone", async () => {
  const { handleHwpRead } = await loadReadTool();
  const result = await handleHwpRead(
    { file_path: simplePath },
    async () => ({
      success: true,
      fileType: "hwpx",
      markdown: "작은 본문",
      blocks: [],
      metadata: { padding: "x".repeat(4_300_000) },
    }),
  );

  assert.equal(result.isError, true);
  const resultDetails = structuredDetails(result);
  assert.equal(resultDetails.code, "RESPONSE_TOO_LARGE");
  assert.ok(Number(resultDetails.response_bytes) > MAX_MCP_RESPONSE_BYTES);
});

test("hwp_read returns image names and an explicit warning without raw bytes when output_dir is absent", async () => {
  const { handleHwpRead } = await loadReadTool();
  const parseDocument: ParseDocument = async () => ({
    success: true,
    fileType: "hwp",
    markdown: "![도장](seal.png)",
    blocks: [],
    images: [
      {
        filename: "seal.png",
        data: Uint8Array.from([1, 2, 3, 4]),
        mimeType: "image/png",
      },
    ],
  });

  const result = await handleHwpRead(
    { file_path: simplePath, extract_images: true },
    parseDocument,
  );
  const details = structuredDetails(result);
  const warnings = details.warnings as Array<Record<string, unknown>>;

  assert.equal(result.isError, false);
  assert.deepEqual(details.assets, ["seal.png"]);
  assert.ok(
    warnings.some((warning) => warning.code === "IMAGES_NOT_WRITTEN"),
  );
  assert.doesNotMatch(JSON.stringify(details), /"data"\s*:/);
});

test("hwp_read writes extracted bytes inside output_dir using safe filenames", async () => {
  const { handleHwpRead } = await loadReadTool();
  const outputDir = join(tmpRoot, "extracted-images");
  const outsidePath = join(tmpRoot, "escaped.png");
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  generatedPaths.add(outputDir);
  generatedPaths.add(outsidePath);
  const parseDocument: ParseDocument = async () => ({
    success: true,
    fileType: "hwp",
    markdown: "![도장](escaped.png)",
    blocks: [],
    images: [
      {
        filename: "../../escaped?.png",
        data: imageBytes,
        mimeType: "image/png",
      },
    ],
  });

  const result = await handleHwpRead(
    {
      file_path: simplePath,
      output_dir: outputDir,
      extract_images: true,
    },
    parseDocument,
  );
  const details = structuredDetails(result);
  const assets = details.assets as string[];

  assert.equal(result.isError, false);
  assert.equal(assets.length, 1);
  assert.equal(dirname(assets[0]!), outputDir);
  assert.doesNotMatch(basename(assets[0]!), /[<>:"/\\|?*]/);
  assert.deepEqual(await readFile(assets[0]!), Buffer.from(imageBytes));
  assert.equal(await pathExists(outsidePath), false);
});

test("hwp_read never overwrites the source when a sanitized asset name matches its basename", async () => {
  const { handleHwpRead } = await loadReadTool();
  const outputDir = join(tmpRoot, "source-name-collision");
  const sourcePath = join(outputDir, "source_.png");
  const sourceBytes = Buffer.from(simpleHwpxBytes);
  const imageBytes = Uint8Array.from([10, 20, 30, 40]);
  generatedPaths.add(outputDir);
  await mkdir(outputDir, { recursive: true });
  await writeFile(sourcePath, sourceBytes);

  const result = await handleHwpRead(
    {
      file_path: sourcePath,
      output_dir: outputDir,
      extract_images: true,
    },
    parseWithImage("source?.png", imageBytes),
  );
  const details = structuredDetails(result);
  const assets = details.assets as string[];

  assert.equal(result.isError, false);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assert.equal(assets.length, 1);
  assert.notEqual(assets[0], sourcePath);
  assert.equal(basename(assets[0]!), "source__2.png");
  assert.deepEqual(await readFile(assets[0]!), Buffer.from(imageBytes));
});

test("hwp_read preserves an unrelated existing output file and selects a filesystem suffix", async () => {
  const { handleHwpRead } = await loadReadTool();
  const outputDir = join(tmpRoot, "existing-output-collision");
  const existingPath = join(outputDir, "seal.png");
  const existingBytes = Buffer.from("unrelated existing file");
  const imageBytes = Uint8Array.from([50, 60, 70, 80]);
  generatedPaths.add(outputDir);
  await mkdir(outputDir, { recursive: true });
  await writeFile(existingPath, existingBytes);

  const result = await handleHwpRead(
    {
      file_path: simplePath,
      output_dir: outputDir,
      extract_images: true,
    },
    parseWithImage("seal.png", imageBytes),
  );
  const details = structuredDetails(result);
  const assets = details.assets as string[];

  assert.equal(result.isError, false);
  assert.deepEqual(await readFile(existingPath), existingBytes);
  assert.deepEqual(assets.map((asset) => basename(asset)), ["seal_2.png"]);
  assert.deepEqual(await readFile(assets[0]!), Buffer.from(imageBytes));
});

test("hwp_read does not follow an existing final-component hardlink or symlink", async (t) => {
  const { handleHwpRead } = await loadReadTool();
  const testRoot = join(tmpRoot, "final-link-collision");
  const outputDir = join(testRoot, "output");
  const targetDir = join(testRoot, "targets");
  const imageBytes = Uint8Array.from([90, 91, 92, 93]);
  generatedPaths.add(testRoot);
  await mkdir(outputDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  await t.test("hardlink", async () => {
    const targetPath = join(targetDir, "hardlink-target.bin");
    const linkedPath = join(outputDir, "linked.png");
    const targetBytes = Buffer.from("hardlink target bytes");
    await writeFile(targetPath, targetBytes);
    await link(targetPath, linkedPath);

    const result = await handleHwpRead(
      {
        file_path: simplePath,
        output_dir: outputDir,
        extract_images: true,
      },
      parseWithImage("linked.png", imageBytes),
    );
    const assets = structuredDetails(result).assets as string[];

    assert.equal(result.isError, false);
    assert.deepEqual(await readFile(targetPath), targetBytes);
    assert.deepEqual(await readFile(linkedPath), targetBytes);
    assert.deepEqual(assets.map((asset) => basename(asset)), ["linked_2.png"]);
  });

  await t.test("symlink", async (symlinkTest) => {
    const targetPath = join(targetDir, "symlink-target.bin");
    const linkedPath = join(outputDir, "symlinked.png");
    const targetBytes = Buffer.from("symlink target bytes");
    await writeFile(targetPath, targetBytes);

    try {
      await symlink(targetPath, linkedPath, "file");
    } catch (error: unknown) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(errorCode(error) ?? "")) {
        symlinkTest.skip(
          `File symlink creation is unavailable (${errorCode(error)}).`,
        );
        return;
      }
      throw error;
    }

    const result = await handleHwpRead(
      {
        file_path: simplePath,
        output_dir: outputDir,
        extract_images: true,
      },
      parseWithImage("symlinked.png", imageBytes),
    );
    const assets = structuredDetails(result).assets as string[];

    assert.equal(result.isError, false);
    assert.deepEqual(await readFile(targetPath), targetBytes);
    assert.deepEqual(await readFile(linkedPath), targetBytes);
    assert.deepEqual(assets.map((asset) => basename(asset)), ["symlinked_2.png"]);
  });
});

test("hwp_read rejects a junction used as output_dir or an output path component", async (t) => {
  const { handleHwpRead } = await loadReadTool();
  const testRoot = join(tmpRoot, "junction-output-rejection");
  const targetDir = join(testRoot, "junction-target");
  const junctionPath = join(testRoot, "output-junction");
  generatedPaths.add(testRoot);
  await mkdir(targetDir, { recursive: true });

  try {
    await symlink(targetDir, junctionPath, "junction");
  } catch (error: unknown) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(errorCode(error) ?? "")) {
      t.skip(`Windows junction creation is unavailable (${errorCode(error)}).`);
      return;
    }
    throw error;
  }

  try {
    await t.test("junction is the output_dir", async () => {
      const result = await handleHwpRead(
        {
          file_path: simplePath,
          output_dir: junctionPath,
          extract_images: true,
        },
        parseWithImage("direct.png", Uint8Array.from([1, 3, 5, 7])),
      );
      const details = structuredDetails(result);

      assert.equal(result.isError, true);
      assert.equal(details.code, "UNSAFE_OUTPUT_DIR");
      assert.equal(await pathExists(join(targetDir, "direct.png")), false);
    });

    await t.test("junction is an output_dir path component", async () => {
      const nestedOutputDir = join(junctionPath, "nested");
      const result = await handleHwpRead(
        {
          file_path: simplePath,
          output_dir: nestedOutputDir,
          extract_images: true,
        },
        parseWithImage("nested.png", Uint8Array.from([2, 4, 6, 8])),
      );
      const details = structuredDetails(result);

      assert.equal(result.isError, true);
      assert.equal(details.code, "UNSAFE_OUTPUT_DIR");
      assert.equal(await pathExists(join(targetDir, "nested")), false);
    });
  } finally {
    await rm(junctionPath, { force: true });
  }
});

test("hwp_generate_hwpx creates a valid, readable document and forced-reflow SVG preview", async () => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-integration");
  const outputPath = join(testRoot, "generated.hwpx");
  const previewPath = join(testRoot, "generated.svg");
  generatedPaths.add(testRoot);
  const markdown = [
    "# 2026년 분기 보고서",
    "",
    "한국어 본문과 표, 수식, 차트를 포함합니다.",
    "",
    "| 항목 | 값 |",
    "| --- | ---: |",
    "| 매출 | 120 |",
    "| 비용 | 80 |",
    "",
    "$$",
    "\\frac{매출}{비용} = \\frac{120}{80}",
    "$$",
    "",
    "```chart",
    "type: column",
    "cat: 1분기, 2분기, 3분기",
    "매출: 100, 120, 150",
    "비용: 80, 90, 110",
    "```",
  ].join("\n");

  const result = await handleHwpGenerateHwpx({
    markdown,
    output_path: outputPath,
    preview_svg_path: previewPath,
  });
  const details = structuredDetails(result);

  assert.equal(result.isError, false);
  assert.equal(details.output_path, outputPath);
  assert.equal(details.preview_svg_path, previewPath);
  assert.equal((details.preview as Record<string, unknown>).page_count, 1);

  const generated = await readFile(outputPath);
  const validation = await validateHwpx(generated);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));

  const parsed = await parse(outputPath, { filePath: outputPath });
  assert.equal(parsed.success, true);
  if (!parsed.success) {
    assert.fail(parsed.error);
  }
  assert.match(parsed.markdown, /2026년 분기 보고서/);
  assert.match(parsed.markdown, /한국어 본문과 표/);
  assert.match(parsed.markdown, /항목/);
  assert.match(parsed.markdown, /매출/);
  assert.match(parsed.markdown, /비용/);
  assert.match(parsed.markdown, /\\frac/);

  const tableBlock = parsed.blocks.find((block) => block.type === "table") as
    | {
        type: "table";
        table: {
          rows: number;
          cols: number;
          hasHeader?: boolean;
          cells: Array<Array<{ text: string; isHeader?: boolean }>>;
        };
      }
    | undefined;
  assert.ok(tableBlock, "generated HWPX must parse a structural table block");
  assert.equal(tableBlock.table.rows, 3);
  assert.equal(tableBlock.table.cols, 2);
  assert.equal(tableBlock.table.hasHeader, true);
  assert.deepEqual(
    tableBlock.table.cells.map((row) => row.map((cell) => cell.text)),
    [
      ["항목", "값"],
      ["매출", "120"],
      ["비용", "80"],
    ],
  );
  assert.deepEqual(
    tableBlock.table.cells[0]?.map((cell) => cell.isHeader),
    [true, true],
  );

  const archive = await JSZip.loadAsync(generated);
  const chartEntry = archive.file("Chart/chart1.xml");
  assert.ok(chartEntry, "generated HWPX must contain Chart/chart1.xml");
  const chartXml = await chartEntry.async("string");
  for (const category of ["1분기", "2분기", "3분기"]) {
    assert.match(chartXml, new RegExp(`<c:v>${category}</c:v>`));
  }
  assert.match(
    chartXml,
    /<c:v>매출<\/c:v>[\s\S]*?<c:numCache>[\s\S]*?<c:v>100<\/c:v>[\s\S]*?<c:v>120<\/c:v>[\s\S]*?<c:v>150<\/c:v>/,
  );
  assert.match(
    chartXml,
    /<c:v>비용<\/c:v>[\s\S]*?<c:numCache>[\s\S]*?<c:v>80<\/c:v>[\s\S]*?<c:v>90<\/c:v>[\s\S]*?<c:v>110<\/c:v>/,
  );

  const svg = await readFile(previewPath, "utf8");
  assert.match(svg, /^\s*<svg\b/);
  assert.ok(svg.length > 100);
});

test("hwp_generate_hwpx normalizes real report font references before writing", async () => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-font-normalization");
  const outputPath = join(testRoot, "report.hwpx");
  generatedPaths.add(testRoot);

  const result = await handleHwpGenerateHwpx({
    markdown: "# 글꼴 점검\n\n공문서 본문의 장평 정책은 유지합니다.",
    output_path: outputPath,
    preset: "report",
  });
  const details = structuredDetails(result);
  const normalization = details.font_normalization as Record<string, unknown>;

  assert.equal(result.isError, false);
  assert.equal(normalization.changed, true);
  assert.ok(Number(normalization.changed_reference_count) > 0);
  assert.deepEqual(
    (await inspectHwpxFontReferences(await readFile(outputPath))).issues,
    [],
  );
});

test("hwp_generate_hwpx writes the facade-authorized normalized bytes and preview", async () => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-normalized-byte-flow");
  const outputPath = join(testRoot, "normalized.hwpx");
  const previewPath = join(testRoot, "normalized.svg");
  const normalized = Uint8Array.from([9, 8, 7, 6]);
  generatedPaths.add(testRoot);
  const calls: Array<{
    markdown: string;
    options: GenerationFacadeOptions;
  }> = [];

  const result = await handleHwpGenerateHwpx(
    {
      markdown: "normalized flow",
      output_path: outputPath,
      preview_svg_path: previewPath,
    },
    testGenerationFacade(async (markdown, options) => {
      calls.push({ markdown, options });
      return {
        bytes: normalized,
        validation: { ok: true, issues: [], entryCount: 4 },
        resultMetadata: {
          operation: "generateHwpx",
          fontNormalization: {
            changed: true,
            changedReferenceCount: 5,
          },
        },
        preview: renderedDocumentPreview(),
      };
    }),
  );

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [{
    markdown: "normalized flow",
    options: { renderPreview: true },
  }]);
  assert.deepEqual(Uint8Array.from(await readFile(outputPath)), normalized);
  assert.equal(await readFile(previewPath, "utf8"), renderedSvg().svg);
  assert.deepEqual(structuredDetails(result).font_normalization, {
    changed: true,
    changed_reference_count: 5,
  });
});

test("hwp_generate_hwpx preserves a typed isolated font-normalization failure", async () => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-font-normalization-failure");
  const outputPath = join(testRoot, "failed.hwpx");
  const previewPath = join(testRoot, "failed.svg");
  generatedPaths.add(testRoot);

  const result = await handleHwpGenerateHwpx(
    {
      markdown: "font failure",
      output_path: outputPath,
      preview_svg_path: previewPath,
    },
    testGenerationFacade(async () => {
      throw codedError(
        "HWPX_FONT_REFERENCE_ERROR",
        "Generated HWPX has invalid font references.",
      );
    }),
  );
  const details = structuredDetails(result);

  assert.equal(result.isError, true);
  assert.equal(details.code, "HWPX_FONT_REFERENCE_ERROR");
  assert.equal(await pathExists(outputPath), false);
  assert.equal(await pathExists(previewPath), false);
});

test("hwp_generate_hwpx maps every preset exactly and passes undefined when omitted", async (t) => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-presets");
  generatedPaths.add(testRoot);
  const presets = [
    "official",
    "report",
    "plan",
    "notice",
    "minutes",
  ] as const;

  for (const preset of presets) {
    await t.test(preset, async () => {
      const calls: GenerationFacadeOptions[] = [];
      const outputPath = join(testRoot, `${preset}.hwpx`);
      const result = await handleHwpGenerateHwpx(
        { markdown: "# 테스트", output_path: outputPath, preset },
        testGenerationFacade(async (_markdown, options) => {
          calls.push(options);
          return { bytes: Uint8Array.from([1, 2, 3]) };
        }),
      );

      assert.equal(result.isError, false);
      assert.deepEqual(calls, [{ preset }]);
    });
  }

  await t.test("no preset", async () => {
    const calls: GenerationFacadeOptions[] = [];
    const outputPath = join(testRoot, "default.hwpx");
    const result = await handleHwpGenerateHwpx(
      { markdown: "# 테스트", output_path: outputPath },
      testGenerationFacade(async (_markdown, options) => {
        calls.push(options);
        return { bytes: Uint8Array.from([4, 5, 6]) };
      }),
    );

    assert.equal(result.isError, false);
    assert.deepEqual(calls, [{}]);
  });
});

test("hwp_generate_hwpx rejects a facade-invalid candidate before writing", async () => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-invalid");
  const outputPath = join(testRoot, "invalid.hwpx");
  const previewPath = join(testRoot, "invalid.svg");
  generatedPaths.add(testRoot);

  const result = await handleHwpGenerateHwpx(
    {
      markdown: "invalid fixture",
      output_path: outputPath,
      preview_svg_path: previewPath,
    },
    testGenerationFacade(async (_markdown, options) => {
      assert.deepEqual(options, { renderPreview: true });
      return {
        bytes: Uint8Array.from([9, 8, 7]),
        validation: {
        ok: false,
          issues: [{ entry: "Contents/section0.xml", message: "broken XML" }],
        entryCount: 2,
        },
      };
    }),
  );
  const details = structuredDetails(result);

  assert.equal(result.isError, true);
  assert.equal(details.code, "HWPX_VALIDATION_FAILED");
  assert.equal(await pathExists(outputPath), false);
  assert.equal(await pathExists(previewPath), false);
});

test("hwp_generate_hwpx rejects validate false before generation", async () => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-skip-validation");
  const outputPath = join(testRoot, "unchecked.hwpx");
  generatedPaths.add(testRoot);
  let generateCalls = 0;

  const result = await handleHwpGenerateHwpx(
    {
      markdown: "unchecked",
      output_path: outputPath,
      validate: false,
    },
    testGenerationFacade(async () => {
      generateCalls += 1;
      return { bytes: Uint8Array.from([11, 12, 13]) };
    }),
  );
  const details = structuredDetails(result);

  assert.equal(result.isError, true);
  assert.equal(details.code, "VALIDATION_REQUIRED");
  assert.equal(generateCalls, 0);
  assert.equal(await pathExists(outputPath), false);
});

test("hwp_generate_hwpx preserves pre-existing output and preview files", async (t) => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-conflicts");
  generatedPaths.add(testRoot);
  await mkdir(testRoot, { recursive: true });
  const facade = testGenerationFacade(async (_markdown, options) => ({
    bytes: Uint8Array.from([21, 22, 23]),
    validation: { ok: true, issues: [], entryCount: 4 },
    ...(options.renderPreview === true
      ? { preview: renderedDocumentPreview() }
      : {}),
  }));

  await t.test("main output conflict", async () => {
    const outputPath = join(testRoot, "existing.hwpx");
    const sentinel = Buffer.from("existing HWPX sentinel");
    await writeFile(outputPath, sentinel);

    const result = await handleHwpGenerateHwpx(
      { markdown: "test", output_path: outputPath },
      facade,
    );

    assert.equal(result.isError, true);
    assert.equal(structuredDetails(result).code, "OUTPUT_CONFLICT");
    assert.deepEqual(await readFile(outputPath), sentinel);
  });

  await t.test("preview conflict leaves main output absent", async () => {
    const outputPath = join(testRoot, "not-created.hwpx");
    const previewPath = join(testRoot, "existing.svg");
    const sentinel = Buffer.from("existing SVG sentinel");
    await writeFile(previewPath, sentinel);

    const result = await handleHwpGenerateHwpx(
      {
        markdown: "test",
        output_path: outputPath,
        preview_svg_path: previewPath,
      },
      facade,
    );

    assert.equal(result.isError, true);
    assert.equal(structuredDetails(result).code, "OUTPUT_CONFLICT");
    assert.equal(await pathExists(outputPath), false);
    assert.deepEqual(await readFile(previewPath), sentinel);
  });
});

test("hwp_generate_hwpx requests an isolated preview before creating outputs", async () => {
  const { handleHwpGenerateHwpx } = await loadWriteTool();
  const testRoot = join(tmpRoot, "generation-preview-failure");
  const outputPath = join(testRoot, "not-created.hwpx");
  const previewPath = join(testRoot, "not-created.svg");
  generatedPaths.add(testRoot);
  const calls: GenerationFacadeOptions[] = [];

  const result = await handleHwpGenerateHwpx(
    {
      markdown: "test",
      output_path: outputPath,
      preview_svg_path: previewPath,
    },
    testGenerationFacade(async (_markdown, options) => {
      calls.push(options);
      throw codedError("HWPX_RENDER_FAILED", "Preview rendering failed.");
    }),
  );

  assert.equal(result.isError, true);
  assert.deepEqual(calls, [{ renderPreview: true }]);
  assert.equal(structuredDetails(result).code, "HWPX_RENDER_FAILED");
  assert.equal(await pathExists(outputPath), false);
  assert.equal(await pathExists(previewPath), false);
});

test("hwp_validate returns normal success for valid and invalid bytes", async (t) => {
  const { handleHwpValidate } = await loadWriteTool();
  const testRoot = join(tmpRoot, "validate-files");
  generatedPaths.add(testRoot);
  await mkdir(testRoot, { recursive: true });

  await t.test("valid HWPX", async () => {
    const validPath = join(testRoot, "valid.hwpx");
    await writeFile(validPath, simpleHwpxBytes);

    const result = await handleHwpValidate({ file_path: validPath });
    const details = structuredDetails(result);

    assert.equal(result.isError, false);
    assert.equal(details.ok, true);
    assert.deepEqual(details.issues, []);
    assert.ok(Number(details.entry_count) > 0);
  });

  await t.test("plain invalid bytes", async () => {
    const invalidPath = join(testRoot, "plain.bin");
    await writeFile(invalidPath, "not a HWPX ZIP");

    const result = await handleHwpValidate({ file_path: invalidPath });
    const details = structuredDetails(result);

    assert.equal(result.isError, false);
    assert.equal(details.ok, false);
    assert.ok(Array.isArray(details.issues));
    assert.ok((details.issues as unknown[]).length > 0);
  });
});

test("hwp_validate reports invalid font references and accepts normalized references", async (t) => {
  const { handleHwpValidate } = await loadWriteTool();
  const testRoot = join(tmpRoot, "validate-font-references");
  const invalidPath = join(testRoot, "invalid-fonts.hwpx");
  const validPath = join(testRoot, "valid-fonts.hwpx");
  generatedPaths.add(testRoot);
  await mkdir(testRoot, { recursive: true });
  const raw = new Uint8Array(await markdownToHwpx(
    "# 글꼴 검증\n\n구조는 정상이지만 언어권별 참조를 검사합니다.",
    { gongmun: { preset: "report" } },
  ));
  const normalized = await normalizeGeneratedFontReferences(raw);
  await writeFile(invalidPath, raw);
  await writeFile(validPath, normalized.bytes);

  await t.test("invalid references are normal validation issues", async () => {
    const result = await handleHwpValidate({ file_path: invalidPath });
    const details = structuredDetails(result);

    assert.equal(result.isError, false);
    assert.equal(details.ok, false);
    assert.ok((details.issues as Array<{ code?: string }>).some(
      (issue) => issue.code === "FONT_REF_INVALID",
    ));
  });

  await t.test("normalized language-specific references pass", async () => {
    const result = await handleHwpValidate({ file_path: validPath });
    const details = structuredDetails(result);

    assert.equal(result.isError, false);
    assert.equal(details.ok, true);
    assert.deepEqual(details.issues, []);
  });
});

test("hwp_validate returns a normal invalid result for shallow unknown bytes without facade dispatch", async () => {
  const { handleHwpValidate } = await loadWriteTool();
  const invalidPath = join(tmpRoot, "font-inspection-skip.bin");
  generatedPaths.add(invalidPath);
  await writeFile(invalidPath, "not a HWPX package");
  let facadeCalls = 0;

  const result = await handleHwpValidate(
    { file_path: invalidPath },
    {
      async validate() {
        facadeCalls += 1;
        throw new Error("shallow unknown input must not reach the facade");
      },
    },
  );

  assert.equal(result.isError, false);
  assert.equal(structuredDetails(result).ok, false);
  assert.equal(facadeCalls, 0);
  assert.deepEqual(structuredDetails(result).issues, [{
    code: "UNSUPPORTED_FORMAT",
    message: "The document is not a valid HWPX package.",
  }]);
});

test("hwp_validate reports a missing exact path as a tool error", async () => {
  const { handleHwpValidate } = await loadWriteTool();
  const missingPath = join(tmpRoot, "missing-validation-input.hwpx");

  const result = await handleHwpValidate({ file_path: missingPath });
  const details = structuredDetails(result);

  assert.equal(result.isError, true);
  assert.equal(details.code, "SNAPSHOT_OPEN_FAILED");
  assert.equal(details.file_path, missingPath);
});

test("hwp_render_preview renders generated HWPX with explicit reflow", async () => {
  const { handleHwpRenderPreview } = await loadPreviewTool();
  const testRoot = join(tmpRoot, "preview-integration");
  const outputPath = join(testRoot, "preview.svg");
  generatedPaths.add(testRoot);

  const result = await handleHwpRenderPreview({
    file_path: simplePath,
    output_svg_path: outputPath,
    reflow: true,
  });
  const details = structuredDetails(result);

  assert.equal(result.isError, false);
  assert.equal(details.output_svg_path, outputPath);
  assert.ok(Number(details.page_count) >= 1);
  assert.deepEqual(Object.keys(details).sort(), [
    "dimensions",
    "output_svg_path",
    "page_count",
    "stats",
    "warnings",
  ]);
  assert.doesNotMatch(JSON.stringify(details), /<svg/i);
  const svg = await readFile(outputPath, "utf8");
  assert.match(svg, /^\s*<svg\b/);
  assert.ok(svg.length > 100);
});

test("hwp_render_preview accepts the real embedded icon after seal-anchor insertion", { timeout: 60_000 }, async () => {
  const { handleHwpRenderPreview } = await loadPreviewTool();
  const testRoot = join(tmpRoot, "preview-embedded-icon");
  const sourcePath = join(testRoot, "sealed.hwpx");
  const outputPath = join(testRoot, "sealed.svg");
  generatedPaths.add(testRoot);
  await mkdir(testRoot, { recursive: true });

  const source = await markdownToHwpx("# Embedded icon regression\n\nApproval: (인)");
  const icon = await readFile(join(SOURCE_ROOT, "assets", "gpt-codex-hwp-icon.png"));
  assert.equal(icon.byteLength, 331_169);
  const placed = await placeSealHwpx(source, [{
    anchor: "(인)",
    image: new Uint8Array(icon.buffer, icon.byteOffset, icon.byteLength),
    ext: "png",
    mode: "overlap",
  }]);
  await writeFile(sourcePath, new Uint8Array(placed.buffer));

  const result = await handleHwpRenderPreview({
    file_path: sourcePath,
    output_svg_path: outputPath,
    reflow: true,
  });
  const details = structuredDetails(result);

  assert.equal(result.isError, false, JSON.stringify(details));
  assert.equal(details.output_svg_path, outputPath);
  const svg = await readFile(outputPath, "utf8");
  assert.ok(Buffer.byteLength(svg, "utf8") > 400_000);
  const embedded = svg.match(/data:image\/png;base64,([A-Za-z0-9+/]+=*)/u);
  assert.ok(embedded);
  assert.ok(embedded[1].length > 64 * 1024);
});

test("hwp_render_preview without reflow or with false fails clearly and creates no output", async (t) => {
  const { handleHwpRenderPreview } = await loadPreviewTool();
  const testRoot = join(tmpRoot, "preview-no-reflow");
  generatedPaths.add(testRoot);

  for (const [label, reflow] of [
    ["default", undefined],
    ["false", false],
  ] as const) {
    await t.test(label, async () => {
      const outputPath = join(testRoot, `${label}.svg`);
      const result = await handleHwpRenderPreview(
        {
          file_path: simplePath,
          output_svg_path: outputPath,
          ...(reflow === undefined ? {} : { reflow }),
        },
        {
          loadRhwpBackend: async () => ({
            available: false,
            reason: "rhwp fallback disabled for the primary-renderer failure contract test",
          }),
        },
      );
      const details = structuredDetails(result);

      assert.equal(result.isError, true);
      assert.equal(typeof details.code, "string");
      assert.ok(String(details.error).length > 0);
      assert.equal(await pathExists(outputPath), false);
    });
  }
});

test("hwp_render_preview sends only highlight options to the facade and returns metadata without SVG content", async () => {
  const { handleHwpRenderPreview } = await loadPreviewTool();
  const testRoot = join(tmpRoot, "preview-highlight");
  const outputPath = join(testRoot, "highlight.svg");
  generatedPaths.add(testRoot);
  let receivedBytes: Uint8Array | undefined;
  let receivedOptions: RenderSvgOptions | undefined;

  const result = await handleHwpRenderPreview(
    {
      file_path: simplePath,
      output_svg_path: outputPath,
      reflow: false,
      highlight: ["테스트", "홍길동"],
    },
    async (input, options) => {
      receivedBytes = new Uint8Array(
        input instanceof ArrayBuffer ? input : input.buffer,
        input instanceof ArrayBuffer ? 0 : input.byteOffset,
        input instanceof ArrayBuffer ? input.byteLength : input.byteLength,
      );
      receivedOptions = options;
      return {
        ...renderedSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>'),
        width: 612,
        height: 1584,
        pageCount: 2,
        warnings: ["one warning"],
        stats: { texts: 2, images: 1, tables: 1 },
      };
    },
  );
  const details = structuredDetails(result);

  assert.equal(result.isError, false);
  assert.deepEqual(receivedBytes, new Uint8Array(0));
  assert.deepEqual(receivedOptions, {
    reflow: false,
    highlights: ["테스트", "홍길동"],
  });
  assert.deepEqual(details, {
    output_svg_path: outputPath,
    page_count: 2,
    dimensions: { width: 612, height: 1584 },
    warnings: ["one warning"],
    stats: { texts: 2, images: 1, tables: 1 },
  });
});

test("hwp_render_preview rejects excessive highlights before file access", async () => {
  const { handleHwpRenderPreview } = await loadPreviewTool();
  const outputPath = join(tmpRoot, "highlight-limit.svg");
  const result = await handleHwpRenderPreview({
    file_path: join(tmpRoot, "missing-highlight-source.hwpx"),
    output_svg_path: outputPath,
    highlight: Array(MAX_HIGHLIGHT_TERMS + 1).fill("x"),
  });
  assert.equal(structuredDetails(result).code, "INPUT_TOO_LARGE");
  assert.equal(await pathExists(outputPath), false);
});

test("hwp_render_preview rejects an oversized SVG before creating output", async () => {
  const { handleHwpRenderPreview } = await loadPreviewTool();
  const outputPath = join(tmpRoot, "oversized-preview.svg");
  const oversized = `<svg>${"x".repeat(MAX_PREVIEW_SVG_BYTES)}</svg>`;
  const result = await handleHwpRenderPreview(
    {
      file_path: simplePath,
      output_svg_path: outputPath,
      reflow: true,
    },
    async () => renderedSvg(oversized),
  );
  assert.equal(structuredDetails(result).code, "PREVIEW_TOO_LARGE");
  assert.equal(await pathExists(outputPath), false);
});

test("hwp_render_preview rejects source aliases and preserves pre-existing outputs", async (t) => {
  const { handleHwpRenderPreview } = await loadPreviewTool();
  const testRoot = join(tmpRoot, "preview-output-safety");
  generatedPaths.add(testRoot);
  await mkdir(testRoot, { recursive: true });
  const sourceBefore = await readFile(simplePath);
  const renderer: RenderDocument = async () => renderedSvg();

  await t.test("exact source path", async () => {
    const result = await handleHwpRenderPreview(
      { file_path: simplePath, output_svg_path: simplePath, reflow: true },
      renderer,
    );

    assert.equal(result.isError, true);
    assert.equal(structuredDetails(result).code, "PATH_ALIAS");
    assert.deepEqual(await readFile(simplePath), sourceBefore);
  });

  await t.test("hardlink to source", async () => {
    const hardlinkPath = join(testRoot, "source-hardlink.svg");
    await link(simplePath, hardlinkPath);

    const result = await handleHwpRenderPreview(
      { file_path: simplePath, output_svg_path: hardlinkPath, reflow: true },
      renderer,
    );

    assert.equal(result.isError, true);
    assert.equal(structuredDetails(result).code, "PATH_ALIAS");
    assert.deepEqual(await readFile(simplePath), sourceBefore);
    assert.deepEqual(await readFile(hardlinkPath), sourceBefore);
  });

  await t.test("unrelated existing file", async () => {
    const outputPath = join(testRoot, "existing.svg");
    const sentinel = Buffer.from("unrelated preview sentinel");
    await writeFile(outputPath, sentinel);

    const result = await handleHwpRenderPreview(
      { file_path: simplePath, output_svg_path: outputPath, reflow: true },
      renderer,
    );

    assert.equal(result.isError, true);
    assert.equal(structuredDetails(result).code, "OUTPUT_CONFLICT");
    assert.deepEqual(await readFile(outputPath), sentinel);
  });

  await t.test("symlink output", async (symlinkTest) => {
    const targetPath = join(testRoot, "symlink-target.bin");
    const outputPath = join(testRoot, "linked-output.svg");
    const sentinel = Buffer.from("symlink target sentinel");
    await writeFile(targetPath, sentinel);

    try {
      await symlink(targetPath, outputPath, "file");
    } catch (error: unknown) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(errorCode(error) ?? "")) {
        symlinkTest.skip(
          `File symlink creation is unavailable (${errorCode(error)}).`,
        );
        return;
      }
      throw error;
    }

    const result = await handleHwpRenderPreview(
      { file_path: simplePath, output_svg_path: outputPath, reflow: true },
      renderer,
    );

    assert.equal(result.isError, true);
    assert.equal(structuredDetails(result).code, "OUTPUT_CONFLICT");
    assert.deepEqual(await readFile(targetPath), sentinel);
    assert.deepEqual(await readFile(outputPath), sentinel);
  });
});

test("exclusive output helper rejects an executed Windows junction without writing through it", async (t) => {
  const testRoot = join(tmpRoot, "exclusive-output-junction");
  const targetDir = join(testRoot, "junction-target");
  const junctionPath = join(testRoot, "output-junction");
  const escapedPath = join(targetDir, "escaped.svg");
  generatedPaths.add(testRoot);
  await mkdir(targetDir, { recursive: true });

  try {
    await symlink(targetDir, junctionPath, "junction");
  } catch (error: unknown) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(errorCode(error) ?? "")) {
      t.skip(`Windows junction creation is unavailable (${errorCode(error)}).`);
      return;
    }
    throw error;
  }

  try {
    await assert.rejects(
      writeFilesExclusively([
        { path: join(junctionPath, "escaped.svg"), data: "must not escape" },
      ]),
      (error: unknown) => {
        assert.equal(errorCode(error), "UNSAFE_OUTPUT_PATH");
        return true;
      },
    );
    assert.equal(await pathExists(escapedPath), false);
  } finally {
    await rm(junctionPath, { force: true });
  }
});
