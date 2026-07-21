import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";
import * as kordoc from "kordoc";

import {
  inspectHwpxFontReferences,
  normalizeGeneratedFontReferences,
} from "../src/shared/hwpx-font-integrity.js";
import {
  createDocumentComputeBackend,
} from "../src/workers/document-compute-backend.js";
import { DOCUMENT_ENGINE_ERROR_MESSAGES } from "../src/workers/document-errors.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("mutation preflight rejects invalid structure, fonts, and character-shape references before every mutation call", async () => {
  const counts = { patchHwpx: 0, fillHwpx: 0, placeSealHwpx: 0 };
  const recordingKordoc = {
    ...kordoc,
    async patchHwpx(): Promise<never> {
      counts.patchHwpx += 1;
      throw new Error("patch mutation must not run");
    },
    async fillHwpx(): Promise<never> {
      counts.fillHwpx += 1;
      throw new Error("fill mutation must not run");
    },
    async placeSealHwpx(): Promise<never> {
      counts.placeSealHwpx += 1;
      throw new Error("image mutation must not run");
    },
  };
  const backend = createDocumentComputeBackend({
    kordoc: recordingKordoc as typeof kordoc,
    loadRhwp: async () => ({ available: false }) as never,
  });
  const fixtures = await invalidMutationSources();

  for (const [fixtureName, source] of fixtures) {
    for (const operation of ["patchHwpx", "fillHwpx", "insertImage"] as const) {
      const before = { ...counts };
      let caught: unknown;
      try {
        await backend.execute(
          mutationRequest(operation) as never,
          {
            document: exactArrayBuffer(source),
            ...(operation === "insertImage"
              ? { image: exactArrayBuffer(ONE_PIXEL_PNG) }
              : {}),
          },
        );
      } catch (error: unknown) {
        caught = error;
      }

      assert.deepEqual(counts, before, `${fixtureName}/${operation} dispatched mutation work`);
      assert.equal(
        errorCode(caught),
        "SOURCE_HWPX_INVALID",
        `${fixtureName}/${operation}`,
      );
      assert.equal(
        errorMessage(caught),
        DOCUMENT_ENGINE_ERROR_MESSAGES.SOURCE_HWPX_INVALID,
        `${fixtureName}/${operation}`,
      );
      assert.doesNotMatch(
        errorMessage(caught),
        /private-anchor|private-field|private-markdown|section0|fontRef|charPrIDRef/iu,
      );
    }
  }
});

test("character-shape validation accepts a referenced nonzero ID and rejects a missing referenced ID", async () => {
  const valid = (await normalizeGeneratedFontReferences(
    await kordoc.markdownToHwpx("문자 모양 참조"),
  )).bytes;
  const remapped = await remapCharacterShape(valid, "0", "500");
  const accepted = await inspectHwpxFontReferences(remapped);
  assert.equal(
    accepted.issues.some((issue) => issue.code === "CHAR_PR_REFERENCE_INVALID"),
    false,
  );

  const missing = await remapCharacterShape(remapped, "500", "999999", false);
  const rejected = await inspectHwpxFontReferences(missing);
  assert.ok(
    rejected.issues.some((issue) =>
      issue.code === "CHAR_PR_REFERENCE_INVALID" && issue.char_pr_id === "999999"
    ),
  );
});

test("patch backend always enables semantic verification and preserves complete metadata", async () => {
  const source = (await normalizeGeneratedFontReferences(
    await kordoc.markdownToHwpx("원문"),
  )).bytes;
  let receivedOptions: unknown;
  const backend = recordingBackend({
    async patchHwpx(_source, _markdown, options) {
      receivedOptions = options;
      return {
        success: true,
        data: source,
        applied: 1,
        skipped: [],
        verification: {
          stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
          diffs: [],
        },
      };
    },
  });

  const result = await backend.execute(
    mutationRequest("patchHwpx") as never,
    { document: exactArrayBuffer(source) },
  );

  assert.deepEqual(receivedOptions, { verify: true });
  assert.deepEqual(result.metadata, {
    operation: "patchHwpx",
    applied: 1,
    skipped: [],
    verification: {
      stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
      diffs: [],
    },
  });
});

test("patch backend reports unsuccessful and missing-data engine results as PATCH_FAILED", async (t) => {
  const source = (await normalizeGeneratedFontReferences(
    await kordoc.markdownToHwpx("원문"),
  )).bytes;
  for (const [name, result] of [
    ["explicit failure", { success: false, applied: 0, skipped: [], error: "private detail" }],
    ["missing data", { success: true, applied: 1, skipped: [] }],
  ] as const) {
    await t.test(name, async () => {
      const backend = recordingBackend({
        async patchHwpx() {
          return result as never;
        },
      });
      await assert.rejects(
        backend.execute(
          mutationRequest("patchHwpx") as never,
          { document: exactArrayBuffer(source) },
        ),
        fixedEngineError("PATCH_FAILED"),
      );
    });
  }
});

test("fill backend reports an unreadable result as FILL_VERIFICATION_FAILED", async () => {
  const source = (await normalizeGeneratedFontReferences(
    await kordoc.markdownToHwpx("| 성명 | ( ) |\n| --- | --- |"),
  )).bytes;
  let parseCalls = 0;
  const backend = recordingBackend({
    async parse(input, options) {
      parseCalls += 1;
      if (parseCalls === 1) return kordoc.parse(input, options);
      return {
        success: false,
        fileType: "hwpx",
        code: "CORRUPTED",
        error: "private post-fill detail",
      };
    },
    async fillHwpx() {
      return { buffer: exactArrayBuffer(source), filled: [], unmatched: [] };
    },
  });

  await assert.rejects(
    backend.execute(
      mutationRequest("fillHwpx") as never,
      { document: exactArrayBuffer(source) },
    ),
    fixedEngineError("FILL_VERIFICATION_FAILED"),
  );
});

test("mutation backend maps invalid candidate output to HWPX_VALIDATION_FAILED", async () => {
  const source = (await normalizeGeneratedFontReferences(
    await kordoc.markdownToHwpx("원문"),
  )).bytes;
  const invalidZip = await JSZip.loadAsync(source);
  invalidZip.remove("Contents/section0.xml");
  const invalid = await invalidZip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
  const backend = recordingBackend({
    async patchHwpx() {
      return {
        success: true,
        data: invalid,
        applied: 1,
        skipped: [],
        verification: {
          stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
          diffs: [],
        },
      };
    },
  });

  await assert.rejects(
    backend.execute(
      mutationRequest("patchHwpx") as never,
      { document: exactArrayBuffer(source) },
    ),
    fixedEngineError("HWPX_VALIDATION_FAILED"),
  );
});

async function invalidMutationSources(): Promise<readonly (readonly [string, Uint8Array])[]> {
  const valid = (await normalizeGeneratedFontReferences(
    await kordoc.markdownToHwpx("private-anchor"),
  )).bytes;

  const missingSection = await JSZip.loadAsync(valid);
  missingSection.remove("Contents/section0.xml");

  const invalidCharacterShape = await JSZip.loadAsync(valid);
  const section = invalidCharacterShape.file("Contents/section0.xml");
  assert.ok(section);
  invalidCharacterShape.file(
    "Contents/section0.xml",
    (await section.async("string")).replace(
      /charPrIDRef="[0-9]+"/u,
      'charPrIDRef="999999"',
    ),
  );

  return [
    [
      "invalid-structure",
      await missingSection.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
    ],
    ["invalid-font", new Uint8Array(await kordoc.markdownToHwpx("private-field"))],
    [
      "invalid-default-character-shape",
      await invalidCharacterShape.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
      }),
    ],
  ];
}

function mutationRequest(operation: "patchHwpx" | "fillHwpx" | "insertImage") {
  const base = {
    protocolVersion: 1 as const,
    requestId: `preflight-${operation}`,
    operation,
    options: {},
  };
  if (operation === "patchHwpx") {
    return {
      ...base,
      input: {
        document: { transport: "buffer", buffer: new ArrayBuffer(0) },
        markdown: "private-markdown",
      },
    };
  }
  if (operation === "fillHwpx") {
    return {
      ...base,
      input: {
        document: { transport: "buffer", buffer: new ArrayBuffer(0) },
        fields: { label: "private-field" },
      },
    };
  }
  return {
    ...base,
    input: {
      document: { transport: "buffer", buffer: new ArrayBuffer(0) },
      image: { transport: "buffer", buffer: new ArrayBuffer(0) },
      anchorText: "private-anchor",
    },
    options: { mode: "seal-anchor" as const, anchorOccurrence: 0 },
  };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordingBackend(overrides: Partial<typeof kordoc>) {
  return createDocumentComputeBackend({
    kordoc: { ...kordoc, ...overrides },
    loadRhwp: async () => ({ available: false }) as never,
  });
}

function fixedEngineError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal(errorCode(error), code);
    assert.equal(
      errorMessage(error),
      DOCUMENT_ENGINE_ERROR_MESSAGES[
        code as keyof typeof DOCUMENT_ENGINE_ERROR_MESSAGES
      ],
    );
    assert.doesNotMatch(errorMessage(error), /private/iu);
    return true;
  };
}

async function remapCharacterShape(
  source: Uint8Array,
  from: string,
  to: string,
  updateHeader = true,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(source);
  if (updateHeader) {
    const header = zip.file("Contents/header.xml");
    assert.ok(header);
    zip.file(
      "Contents/header.xml",
      (await header.async("string")).replace(
        new RegExp(`(<hh:charPr\\b[^>]*\\bid=")${from}("[^>]*>)`, "u"),
        `$1${to}$2`,
      ),
    );
  }
  for (const name of Object.keys(zip.files).filter((entry) =>
    /^Contents\/section[0-9]+\.xml$/u.test(entry)
  )) {
    const section = zip.file(name);
    assert.ok(section);
    zip.file(
      name,
      (await section.async("string")).replaceAll(
        `charPrIDRef="${from}"`,
        `charPrIDRef="${to}"`,
      ),
    );
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
