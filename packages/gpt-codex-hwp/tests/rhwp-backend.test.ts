import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import CFB from "cfb";
import JSZip from "jszip";
import {
  markdownToHwpx,
  type ParseOptions,
  type ParseResult,
  type RenderSvgOptions,
  type RenderSvgResult,
} from "kordoc";

import { resolveHwpFixture } from "../release-scripts/hwp-fixture.mjs";
import { createCanonicalTemporaryDirectory } from "../../../scripts/canonical-temp.mjs";
import {
  RhwpBackendLoader,
  checkRhwpBackend,
  inspectRhwpPreflightProtection,
  loadRhwpBackend,
  type RhwpBackend,
  type RhwpBackendLoadResult,
  type RhwpDocument,
} from "../src/tools/rhwp-backend.js";
import {
  handleHwpRenderPreview as handleIsolatedHwpRenderPreview,
  type HwpRenderPreviewInput,
} from "../src/tools/preview.js";

interface PreviewDependencies {
  renderDocument(
    input: ArrayBuffer | Uint8Array,
    options?: RenderSvgOptions,
  ): Promise<RenderSvgResult>;
  detectDocumentFormat?(input: ArrayBuffer): Promise<"hwp" | "hwpx" | "unknown">;
  parseDocument?(
    input: string | ArrayBuffer | Buffer,
    options?: ParseOptions,
  ): Promise<ParseResult>;
  loadRhwpBackend?(): Promise<RhwpBackendLoadResult>;
}

let tmpRoot = "";

before(async () => {
  tmpRoot = await createCanonicalTemporaryDirectory({ prefix: "gpt-codex-hwp-rhwp-backend-" });
});

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

test("backend status reports a missing dynamic import without throwing", async () => {
  const loader = new RhwpBackendLoader({
    importModule: async () => {
      throw Object.assign(new Error("Cannot find package @rhwp/core"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    },
    resolveModule: () => assert.fail("resolve must not run"),
    readBinary: async () => assert.fail("read must not run"),
  });

  const status = await checkRhwpBackend(loader);

  assert.equal(status.available, false);
  if (status.available) return;
  assert.match(status.reason, /missing|cannot find|unavailable/iu);
});

test("backend status rejects a malformed module API cleanly", async () => {
  const loader = new RhwpBackendLoader({
    importModule: async () => ({ default: async () => undefined }),
    resolveModule: () => assert.fail("resolve must not run"),
    readBinary: async () => assert.fail("read must not run"),
  });

  const status = await checkRhwpBackend(loader);

  assert.equal(status.available, false);
  if (status.available) return;
  assert.match(status.reason, /api|hwpdocument|version/iu);
});

test("backend status reports an initialization failure deterministically and initializes only once", async () => {
  let initializes = 0;
  const loader = new RhwpBackendLoader({
    importModule: async () => validRhwpModule(() => {
      initializes += 1;
      throw new Error("WASM initialization failed");
    }),
    resolveModule: () => join(tmpRoot, "init-failure", "rhwp.js"),
    readBinary: async () => Uint8Array.from([0, 97, 115, 109]),
  });

  const [first, second] = await Promise.all([
    checkRhwpBackend(loader),
    checkRhwpBackend(loader),
  ]);

  assert.equal(first.available, false);
  assert.deepEqual(second, first);
  assert.equal(initializes, 1);
});

test("backend loader initializes once and preserves a preexisting measureTextWidth", async () => {
  const globalWithMeasure = globalThis as typeof globalThis & {
    measureTextWidth?: (font: string, text: string) => number;
  };
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "measureTextWidth",
  );
  const sentinel = () => 321;
  Object.defineProperty(globalThis, "measureTextWidth", {
    configurable: true,
    writable: true,
    value: sentinel,
  });
  let imports = 0;
  let resolves = 0;
  let reads = 0;
  let initializes = 0;

  try {
    const loader = new RhwpBackendLoader({
      importModule: async (specifier) => {
        imports += 1;
        assert.equal(specifier, "@rhwp/core");
        return validRhwpModule(() => {
          initializes += 1;
        });
      },
      resolveModule: (specifier) => {
        resolves += 1;
        assert.equal(specifier, "@rhwp/core");
        return join(tmpRoot, "node_modules", "@rhwp", "core", "rhwp.js");
      },
      readBinary: async (path) => {
        reads += 1;
        assert.equal(
          path,
          join(tmpRoot, "node_modules", "@rhwp", "core", "rhwp_bg.wasm"),
        );
        return Uint8Array.from([0, 97, 115, 109]);
      },
    });

    const [first, second, status] = await Promise.all([
      loader.load(),
      loader.load(),
      checkRhwpBackend(loader),
    ]);

    assert.equal(first.available, true);
    assert.equal(second.available, true);
    assert.equal(status.available, true);
    assert.equal(imports, 1);
    assert.equal(resolves, 1);
    assert.equal(reads, 1);
    assert.equal(initializes, 1);
    assert.equal(globalWithMeasure.measureTextWidth, sentinel);
  } finally {
    if (originalDescriptor === undefined) {
      delete globalWithMeasure.measureTextWidth;
    } else {
      Object.defineProperty(globalThis, "measureTextWidth", originalDescriptor);
    }
  }
});

test("backend accepts a preview-only HwpDocument surface", async () => {
  class PreviewOnlyDocument {
    constructor(_bytes: Uint8Array) {}
    pageCount(): number { return 1; }
    renderPageSvg(): string { return "<svg/>"; }
    getSourceFormat(): string { return "hwp"; }
    free(): void {}
  }
  const loader = new RhwpBackendLoader({
    importModule: async () => ({
      default: async () => undefined,
      HwpDocument: PreviewOnlyDocument,
      version: () => "preview-only-test",
    }),
    resolveModule: () => join(tmpRoot, "preview-only", "rhwp.js"),
    readBinary: async () => Uint8Array.from([0, 97, 115, 109]),
  });

  const loaded = await loader.load();
  assert.equal(loaded.available, true);
  if (!loaded.available) return;
  const document = loaded.backend.createDocument(Uint8Array.from([1]));
  assert.equal(document.pageCount(), 1);
  assert.equal(document.renderPageSvg(0), "<svg/>");
  document.free();
});

test("backend createDocument frees an allocated malformed document before rejecting it", async () => {
  let freeCalls = 0;
  class MalformedDocument {
    constructor(_bytes: Uint8Array) {}
    pageCount(): number { return 1; }
    free(): void { freeCalls += 1; }
  }
  const loader = new RhwpBackendLoader({
    importModule: async () => ({
      default: async () => undefined,
      HwpDocument: MalformedDocument,
      version: () => "0.7.17-malformed-test",
    }),
    resolveModule: () => join(tmpRoot, "malformed", "rhwp.js"),
    readBinary: async () => Uint8Array.from([0, 97, 115, 109]),
  });
  const loaded = await loader.load();
  assert.equal(loaded.available, true);
  if (!loaded.available) return;

  assert.throws(() => loaded.backend.createDocument(Uint8Array.from([1])));
  assert.equal(freeCalls, 1);
});

test("rhwp preview fallback frees the document and never returns SVG through MCP", async () => {
  const sourcePath = join(tmpRoot, "preview-source.hwp");
  const outputPath = join(tmpRoot, "preview.svg");
  await writeFile(sourcePath, syntheticHwpWithFlags(0));
  let freeCalls = 0;
  const document = mockDocument({
    renderPageSvg: () => '<svg width="595" height="842"><text>ok</text></svg>',
    free: () => { freeCalls += 1; },
  });

  const result = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: outputPath },
    previewDependencies(availableBackend(() => document)),
  );
  const content = details(result);

  assert.equal(result.isError, false);
  assert.equal(content.backend, "rhwp");
  assert.equal(content.page_count, 1);
  assert.equal(content.degraded_font_metrics, true);
  assert.equal(freeCalls, 1);
  assert.doesNotMatch(JSON.stringify(content), /<svg/iu);
  assert.match(await readFile(outputPath, "utf8"), /^<svg/iu);
});

test("rhwp preview facade stages receive no source path or source bytes", async () => {
  const sourcePath = join(tmpRoot, "preview-pristine-bytes.hwp");
  const outputPath = join(tmpRoot, "preview-pristine-bytes.svg");
  const original = syntheticHwpWithFlags(0);
  await writeFile(sourcePath, original);
  const observations: number[] = [];

  const result = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: outputPath },
    {
      renderDocument: async (input) => {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        observations.push(bytes[0]!);
        bytes[0] = 9;
        throw new Error("primary failed after mutation");
      },
      detectDocumentFormat: async (input) => {
        const bytes = new Uint8Array(input);
        observations.push(bytes[0]!);
        bytes[0] = 8;
        return "hwp";
      },
      parseDocument: async (input) => {
        assert.ok(input instanceof ArrayBuffer);
        const bytes = new Uint8Array(input);
        observations.push(bytes[0]!);
        bytes[0] = 7;
        return parseSuccess("hwp");
      },
      loadRhwpBackend: async () => availableBackend((bytes) => {
        observations.push(bytes[0]!);
        bytes[0] = 6;
        return mockDocument();
      }),
    },
  );

  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  assert.deepEqual(observations, [undefined, undefined, undefined]);
  assert.deepEqual(await readFile(sourcePath), Buffer.from(original));
});

test("rhwp preview fallback frees the document when rendering throws", async () => {
  const sourcePath = join(tmpRoot, "preview-failure-source.hwp");
  const outputPath = join(tmpRoot, "preview-failure.svg");
  await writeFile(sourcePath, syntheticHwpWithFlags(0));
  let freeCalls = 0;
  const document = mockDocument({
    renderPageSvg: () => { throw new Error("render exploded"); },
    free: () => { freeCalls += 1; },
  });

  const result = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: outputPath },
    previewDependencies(availableBackend(() => document)),
  );

  assert.equal(result.isError, true);
  assert.equal(freeCalls, 1);
  await assert.rejects(access(outputPath));
});

test("rhwp preview rejects a Kordoc distribution sentinel before loading rhwp", async () => {
  const sourcePath = join(tmpRoot, "distribution-sentinel.hwp");
  const outputPath = join(tmpRoot, "distribution-sentinel.svg");
  await writeFile(sourcePath, syntheticHwpWithFlags(0));
  let loads = 0;

  const result = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: outputPath },
    {
      renderDocument: async () => { throw new Error("primary failed"); },
      detectDocumentFormat: async () => "hwp",
      parseDocument: async () => ({
        ...parseSuccess("hwp"),
        markdown: "상위 버전의 배포용 문서입니다. 문서를 읽으려면 최신 버전의 한글 뷰어를 사용하십시오.",
      }),
      loadRhwpBackend: async () => {
        loads += 1;
        return { available: false, reason: "must not load" };
      },
    },
  );

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "DRM_PROTECTED");
  assert.equal(loads, 0);
  await assert.rejects(access(outputPath));
});

test("rhwp preview rejects an exact HWP distribution flag", async () => {
  const sourcePath = join(tmpRoot, "distribution-flag.hwp");
  const outputPath = join(tmpRoot, "distribution-flag.svg");
  await writeFile(sourcePath, syntheticHwpWithFlags(1 << 2));
  let parseCalls = 0;
  let loads = 0;

  const result = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: outputPath },
    failingPreviewFacade(
      "DRM_PROTECTED",
      "The exact HWP FileHeader marks this document as distribution-protected.",
    ),
  );

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "DRM_PROTECTED");
  assert.equal(parseCalls, 0);
  assert.equal(loads, 0);
  await assert.rejects(access(outputPath));
});

test("rhwp preview converts a thrown preflight into a structured error", async () => {
  const sourcePath = join(tmpRoot, "preview-preflight-throws.hwp");
  const outputPath = join(tmpRoot, "preview-preflight-throws.svg");
  await writeFile(sourcePath, syntheticHwpWithFlags(0));

  const result = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: outputPath },
    {
      renderDocument: async () => { throw new Error("primary failed"); },
      detectDocumentFormat: async () => "hwp",
      parseDocument: async () => { throw new Error("preflight threw"); },
    },
  );

  assert.equal(result.isError, true);
  assert.match(String(details(result).error), /preflight threw/iu);
  await assert.rejects(access(outputPath));
});

test("rhwp preview reports a throwing free before creating output", async () => {
  const sourcePath = join(tmpRoot, "preview-free-throws.hwp");
  const outputPath = join(tmpRoot, "preview-free-throws.svg");
  await writeFile(sourcePath, syntheticHwpWithFlags(0));
  const document = mockDocument({
    renderPageSvg: () => '<svg width="10" height="10"/>',
    free: () => { throw new Error("free failed"); },
  });

  const result = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: outputPath },
    previewDependencies(availableBackend(() => document)),
  );

  assert.equal(result.isError, true);
  await assert.rejects(access(outputPath));
});

test("preview rejects exact signed HWPX bytes before renderer or backend", async () => {
  const sourcePath = join(tmpRoot, "signed-source.hwpx");
  const previewPath = join(tmpRoot, "signed-preview.svg");
  const zip = await JSZip.loadAsync(await markdownToHwpx("서명된 문서"));
  zip.file("_xmlsignatures/sig1.xml", "<Signature/>");
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(
    sourcePath,
    await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );

  let renderCalls = 0;
  let backendLoads = 0;
  const result = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: previewPath, reflow: true },
    failingPreviewFacade(
      "SIGNED_DOCUMENT",
      "The exact HWPX package contains an electronic-signature entry.",
    ),
  );

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "SIGNED_DOCUMENT");
  assert.equal(renderCalls, 0);
  assert.equal(backendLoads, 0);
  await assert.rejects(access(previewPath));
});

test("real isolated HWPX preview works when the optional backend is installed", { timeout: 30_000 }, async (t) => {
  if (!await requireRhwpBackend(t)) return;
  const testRoot = join(tmpRoot, "real-core");
  const sourcePath = join(testRoot, "source.hwpx");
  const previewPath = join(testRoot, "preview.svg");
  await mkdir(testRoot, { recursive: true });
  const source = new Uint8Array(await markdownToHwpx("# 실제 rhwp\n\n한글 문단입니다."));
  await writeFile(sourcePath, source);
  const sourceHash = sha256(source);

  const preview = await handleHwpRenderPreview(
    { file_path: sourcePath, output_svg_path: previewPath, reflow: true },
  );

  assert.equal(preview.isError, false, JSON.stringify(preview.structuredContent));
  assert.match(await readFile(previewPath, "utf8"), /^\s*<svg\b/iu);
  assert.equal(sha256(await readFile(sourcePath)), sourceHash);
});

test("real external HWP preview leaves the read-only sample unchanged", { timeout: 30_000 }, async (t) => {
  const fixture = await resolveHwpFixture({ requireTracked: true });
  if (!await requireRhwpBackend(t)) return;
  assert.equal(sha256(await readFile(fixture.path)), fixture.sha256);
  const ownedInputPath = join(tmpRoot, "external-hwp-owned-copy.hwp");
  const outputPath = join(tmpRoot, "external-hwp-preview.svg");
  await copyFile(fixture.path, ownedInputPath);
  assert.equal(sha256(await readFile(ownedInputPath)), fixture.sha256);

  let result: CallToolResult | undefined;
  try {
    result = await handleHwpRenderPreview(
      { file_path: ownedInputPath, output_svg_path: outputPath },
    );
  } finally {
    assert.equal(sha256(await readFile(ownedInputPath)), fixture.sha256);
    assert.equal(sha256(await readFile(fixture.path)), fixture.sha256);
  }

  assert.ok(result);
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  assert.equal(details(result).backend, "rhwp");
  assert.match(await readFile(outputPath, "utf8"), /^\s*<svg\b/iu);
});

async function requireRhwpBackend(t: TestContext): Promise<boolean> {
  const status = await checkRhwpBackend();
  if (status.available) return true;
  if (process.env.HWP_REQUIRE_RHWP === "1") {
    assert.fail(`required @rhwp/core unavailable: ${status.reason}`);
  }
  t.skip(`optional @rhwp/core unavailable: ${status.reason}`);
  return false;
}

function validRhwpModule(onInit: () => void): unknown {
  class MockDocument {
    constructor(_bytes: Uint8Array) {}
    pageCount(): number { return 1; }
    renderPageSvg(): string { return "<svg/>"; }
    getSourceFormat(): string { return "hwp"; }
    free(): void {}
  }
  return {
    default: async (input: unknown) => {
      assert.ok(input);
      onInit();
    },
    HwpDocument: MockDocument,
    version: () => "0.7.17-test",
  };
}

function mockDocument(overrides: Partial<{
  pageCount: () => number;
  renderPageSvg: (page: number) => string;
  sourceFormat: string;
  free: () => void;
}> = {}): RhwpDocument {
  return {
    pageCount: overrides.pageCount ?? (() => 1),
    renderPageSvg: overrides.renderPageSvg ?? (() => "<svg/>"),
    getSourceFormat: () => overrides.sourceFormat ?? "hwp",
    free: overrides.free ?? (() => undefined),
  };
}

function availableBackend(
  createDocument: (bytes: Uint8Array) => RhwpDocument,
): RhwpBackendLoadResult {
  const backend: RhwpBackend = {
    version: "0.7.17-mock",
    createDocument,
  };
  return { available: true, backend };
}

async function handleHwpRenderPreview(
  input: HwpRenderPreviewInput,
  dependencies?: Partial<PreviewDependencies> | object,
): Promise<CallToolResult> {
  if (dependencies === undefined) {
    return handleIsolatedHwpRenderPreview(input);
  }
  const facade = "render" in dependencies
    ? dependencies
    : previewFacade(dependencies as Partial<PreviewDependencies>);
  return handleIsolatedHwpRenderPreview(input, facade as never);
}

function previewFacade(dependencies: Partial<PreviewDependencies>): object {
  return {
    async render(
      snapshot: {
        metadata: unknown;
        verifySourceUnchanged(): Promise<void>;
        cleanup(): Promise<void>;
      },
      options: RenderSvgOptions,
    ) {
      try {
        try {
          const rendered = await (dependencies.renderDocument ??
            (async () => { throw new Error("primary renderer failed"); }))(
            new Uint8Array(0),
            options,
          );
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
        } catch (primaryError: unknown) {
          const parsed = await (dependencies.parseDocument ??
            (async () => parseSuccess("hwp")))(new ArrayBuffer(0));
          if (!parsed.success) throw codedError(parsed.code ?? "PARSE_ERROR", parsed.error);
          const protection = inspectRhwpPreflightProtection(parsed);
          if (protection !== undefined) {
            throw codedError(protection.code, protection.error);
          }
          const loaded = await (dependencies.loadRhwpBackend ?? loadRhwpBackend)();
          if (!loaded.available) throw primaryError;
          let document: RhwpDocument | undefined;
          let svg: string;
          let pageCount: number;
          try {
            document = loaded.backend.createDocument(new Uint8Array(0));
            pageCount = document.pageCount();
            svg = document.renderPageSvg(0);
          } finally {
            document?.free();
          }
          await snapshot.verifySourceUnchanged();
          return {
            payload: {
              svg,
              metadata: {
                backend: "rhwp",
                version: loaded.backend.version,
                pageCount,
                page: 1,
              },
            },
            snapshotMetadata: snapshot.metadata,
            verifySourceUnchanged: () => snapshot.verifySourceUnchanged(),
          };
        }
      } finally {
        await snapshot.cleanup();
      }
    },
  };
}

function failingPreviewFacade(code: string, message: string): object {
  return {
    async render(snapshot: {
      verifySourceUnchanged(): Promise<void>;
      cleanup(): Promise<void>;
    }): Promise<never> {
      try {
        await snapshot.verifySourceUnchanged();
        throw codedError(code, message);
      } finally {
        await snapshot.cleanup();
      }
    },
  };
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function previewDependencies(
  backend: RhwpBackendLoadResult,
): Partial<PreviewDependencies> {
  return {
    renderDocument: async () => { throw new Error("primary renderer failed"); },
    detectDocumentFormat: async () => "hwp",
    parseDocument: async () => parseSuccess("hwp"),
    loadRhwpBackend: async () => backend,
  };
}

function parseSuccess(fileType: "hwp" | "hwpx") {
  return {
    success: true as const,
    fileType,
    markdown: "",
    blocks: [],
    images: [],
  };
}

function details(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syntheticHwpWithFlags(flags: number, headerLength = 256): Uint8Array {
  const container = CFB.utils.cfb_new();
  const header = Buffer.alloc(headerLength);
  if (headerLength >= 32) {
    header.write("HWP Document File", 0, "ascii");
  }
  if (headerLength >= 40) {
    header.writeUInt32LE(0x05000302, 32);
    header.writeUInt32LE(flags, 36);
  }
  CFB.utils.cfb_add(container, "FileHeader", header);
  return Uint8Array.from(CFB.write(container, { type: "buffer" }) as Buffer);
}
