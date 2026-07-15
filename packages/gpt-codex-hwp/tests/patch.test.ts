import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import CFB from "cfb";
import { markdownToHwpx, parse, validateHwpx } from "kordoc";
import JSZip from "jszip";

import { normalizeGeneratedFontReferences } from "../src/shared/hwpx-font-integrity.js";
import { createDocumentEngineRunError } from "../src/workers/document-errors.js";
import {
  handleHwpFillForm,
  handleHwpPatchDocument,
} from "../src/tools/patch.js";
import { MAX_FILL_VALUES } from "../src/shared/resource-limits.js";

function details(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ENOENT");
    return true;
  });
}

test("hwp_patch_document patches a real HWPX without mutating the source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const outputPath = join(root, "patched.hwpx");
  const source = await validHwpx("# 제목\n\n첫 번째 문단입니다.");
  await writeFile(sourcePath, source);
  const sourceHash = sha256(source);

  const parsed = await parse(source);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const edited = parsed.markdown.replace(
    "첫 번째 문단입니다.",
    "수정된 문단입니다.",
  );

  const result = await handleHwpPatchDocument({
    file_path: sourcePath,
    edited_markdown: edited,
    output_path: outputPath,
  });

  assert.equal(result.isError, false);
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /semantically verified/iu,
  );
  assert.deepEqual(details(result), {
    output_path: resolve(outputPath),
    format: "hwpx",
    applied: 1,
    skipped: [],
    verification: {
      stats: { added: 0, removed: 0, modified: 0, unchanged: 2 },
      diffs: [],
    },
    complete: true,
  });

  const output = await readFile(outputPath);
  const validation = await validateHwpx(output);
  assert.equal(validation.ok, true);
  const reparsed = await parse(output);
  assert.equal(reparsed.success, true);
  if (reparsed.success) {
    assert.match(reparsed.markdown, /수정된 문단입니다\./u);
    assert.doesNotMatch(reparsed.markdown, /첫 번째 문단입니다\./u);
  }
  assert.equal(sha256(await readFile(sourcePath)), sourceHash);
});

test("hwp_patch_document rejects verify false before file access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-verify-required-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "missing-source.hwpx");
  const outputPath = join(root, "output.hwpx");
  let dependencyCalls = 0;
  const unexpected = async () => {
    dependencyCalls += 1;
    throw new Error("verification opt-out must return before dependencies");
  };

  const result = await handleHwpPatchDocument(
    {
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: outputPath,
      verify: false,
    },
    { patch: unexpected } as never,
  );

  assert.equal(details(result).code, "VERIFICATION_REQUIRED");
  assert.equal(dependencyCalls, 0);
  await assertMissing(sourcePath);
  await assertMissing(outputPath);
});

test("hwp_patch_document requires complete isolated verification metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-verify-stats-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const missingStatsOutput = join(root, "missing-stats.hwpx");
  const source = await validHwpx("원문");
  await writeFile(sourcePath, source);
  let writeCalls = 0;

  const missingStats = await handleHwpPatchDocument(
    {
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: missingStatsOutput,
    },
    {
      async patch(snapshot: SnapshotLike) {
        await snapshot.cleanup();
        return fakeMutationResult(
          source,
          {
            operation: "patchHwpx",
            applied: 1,
            skipped: [],
            verification: null,
          },
          { ok: true, issues: [], entryCount: 1 },
          () => { writeCalls += 1; },
        );
      },
    } as never,
  );
  assert.equal(details(missingStats).code, "PATCH_INCOMPLETE");
  assert.equal(writeCalls, 0);
  await assertMissing(missingStatsOutput);
});

test("hwp_patch_document rejects binary HWP before parsing or patching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-read-only-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwp");
  const outputPath = join(root, "patched.hwpx");
  await writeFile(sourcePath, syntheticHwpWithFlags(0));
  let unexpectedCalls = 0;
  const unexpected = async () => {
    unexpectedCalls += 1;
    throw new Error("must not be called");
  };

  const result = await handleHwpPatchDocument(
    {
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: outputPath,
    },
    { patch: unexpected } as never,
  );

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "HWP_READ_ONLY");
  assert.doesNotMatch(JSON.stringify(result), /experimental HWP export/iu);
  assert.match(JSON.stringify(result), /create or edit an HWPX document/iu);
  assert.deepEqual(details(result), {
    code: "HWP_READ_ONLY",
    file_path: resolve(sourcePath),
    output_path: resolve(outputPath),
    format: "hwp",
  });
  assert.equal(unexpectedCalls, 0);
  await assertMissing(outputPath);
});

test("hwp_patch_document rejects a DOCX-like ZIP before patching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-docx-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "misleading.hwpx");
  const outputPath = join(root, "output.hwpx");
  const zip = new JSZip();
  zip.file("word/document.xml", "<w:document/>");
  await writeFile(sourcePath, await zip.generateAsync({ type: "uint8array" }));

  const result = await handleHwpPatchDocument({
    file_path: sourcePath,
    edited_markdown: "수정",
    output_path: outputPath,
  });

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "UNSUPPORTED_PATCH_FORMAT");
  assert.equal(details(result).format, "unknown");
  await assertMissing(outputPath);
});

test("hwp_patch_document rejects a real partial patch without writing an artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-partial-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const outputPath = join(root, "partial.hwpx");
  const source = await validHwpx("기존 문단");
  await writeFile(sourcePath, source);
  const parsed = await parse(source);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;

  const result = await handleHwpPatchDocument({
    file_path: sourcePath,
    edited_markdown: `${parsed.markdown}\n\n추가 문단`,
    output_path: outputPath,
  });

  assert.equal(result.isError, true);
  const resultDetails = details(result);
  assert.equal(resultDetails.code, "PATCH_INCOMPLETE");
  assert.equal(resultDetails.complete, false);
  assert.equal(resultDetails.applied, 0);
  assert.ok(Array.isArray(resultDetails.skipped));
  assert.equal(resultDetails.skipped.length, 1);
  assert.equal(
    (resultDetails.verification as { stats: { added: number } }).stats.added,
    1,
  );
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /incomplete|skipped|residual/iu);
  await assertMissing(outputPath);
});

test("hwp_patch_document does not write a typed PATCH_FAILED result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  await writeFile(
    sourcePath,
    await validHwpx("원문"),
  );

  const outputPath = join(root, "failure.hwpx");
  const result = await handleHwpPatchDocument(
    {
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: outputPath,
    },
    {
      async patch(snapshot: SnapshotLike) {
        await snapshot.cleanup();
        throw createDocumentEngineRunError("PATCH_FAILED");
      },
    } as never,
  );

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "PATCH_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /private detail/iu);
  await assertMissing(outputPath);
});

test("hwp_fill_form fills a real HWPX form and validates it without mutating the source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "form.hwpx");
  const outputPath = join(root, "filled.hwpx");
  const source = await validHwpx(
    "| 성명 | ( ) | 연락처 | ( ) |\n| --- | --- | --- | --- |",
  );
  await writeFile(sourcePath, source);
  const sourceHash = sha256(source);

  const result = await handleHwpFillForm({
    file_path: sourcePath,
    fields: { 성명: "홍길동", 연락처: "010-1234-5678" },
    output_path: outputPath,
  });

  assert.equal(result.isError, false);
  const resultDetails = details(result);
  assert.equal(resultDetails.output_path, resolve(outputPath));
  assert.deepEqual(resultDetails.unmatched, []);
  assert.deepEqual(resultDetails.rejected, []);
  assert.deepEqual(
    (resultDetails.filled as Array<{ label: string; value_length: number }>).map(
      ({ label, value_length }) => ({ label, value_length }),
    ),
    [
      { label: "성명", value_length: 3 },
      { label: "연락처", value_length: 13 },
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /홍길동|010-1234-5678/u);
  assert.equal(
    (resultDetails.validation as { ok: boolean }).ok,
    true,
  );

  const output = await readFile(outputPath);
  assert.equal((await validateHwpx(output)).ok, true);
  const reparsed = await parse(output);
  assert.equal(reparsed.success, true);
  if (reparsed.success) {
    assert.match(reparsed.markdown, /홍길동/u);
    assert.match(reparsed.markdown, /010-1234-5678/u);
  }
  assert.equal(sha256(await readFile(sourcePath)), sourceHash);
});

test("hwp_fill_form rejects total array values above the budget before file access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-value-limit-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "missing.hwpx");
  const outputPath = join(root, "output.hwpx");
  let dependencyCalls = 0;
  const result = await handleHwpFillForm(
    {
      file_path: sourcePath,
      fields: { repeated: Array(MAX_FILL_VALUES + 1).fill("") },
      output_path: outputPath,
    },
    {
      fill: async () => {
        dependencyCalls += 1;
        throw new Error("fill must not run");
      },
    } as never,
  );
  assert.equal(details(result).code, "INPUT_TOO_LARGE");
  assert.equal(dependencyCalls, 0);
  await assertMissing(sourcePath);
  await assertMissing(outputPath);
});

test("hwp_fill_form applies per-field formats and surfaces unmatched labels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-format-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "form.hwpx");
  const outputPath = join(root, "filled.hwpx");
  await writeFile(
    sourcePath,
    await validHwpx("| 생년월일 | ( ) |\n| --- | --- |"),
  );

  const result = await handleHwpFillForm({
    file_path: sourcePath,
    fields: { 생년월일: "19900315", 없는필드: "값" },
    formats: { 생년월일: "date:yy.mm.dd" },
    output_path: outputPath,
    mask_values: false,
  });

  assert.equal(result.isError, false);
  const resultDetails = details(result);
  assert.deepEqual(resultDetails.unmatched, ["없는필드"]);
  assert.equal(
    (resultDetails.filled as Array<{ value: string }>)[0]?.value,
    "90.03.15",
  );
  const reparsed = await parse(await readFile(outputPath));
  assert.equal(reparsed.success, true);
  if (reparsed.success) assert.match(reparsed.markdown, /90\.03\.15/u);
});

test("hwp_fill_form require_unique rejects repeated scalar labels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-unique-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "form.hwpx");
  const outputPath = join(root, "filled.hwpx");
  await writeFile(
    sourcePath,
    await validHwpx("| 성명 | ( ) |\n| --- | --- |\n| 성명 | ( ) |"),
  );

  const result = await handleHwpFillForm({
    file_path: sourcePath,
    fields: { 성명: "홍길동" },
    output_path: outputPath,
    require_unique: true,
  });

  assert.equal(result.isError, false);
  const resultDetails = details(result);
  assert.deepEqual(resultDetails.filled, []);
  assert.deepEqual(resultDetails.unmatched, []);
  assert.deepEqual(resultDetails.rejected, ["성명"]);
  const reparsed = await parse(await readFile(outputPath));
  assert.equal(reparsed.success, true);
  if (reparsed.success) assert.doesNotMatch(reparsed.markdown, /홍길동/u);
});

test("hwp_fill_form require_unique allows array values for repeated labels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-array-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "form.hwpx");
  const outputPath = join(root, "filled.hwpx");
  await writeFile(
    sourcePath,
    await validHwpx("| 성명 | ( ) |\n| --- | --- |\n| 성명 | ( ) |"),
  );

  const result = await handleHwpFillForm({
    file_path: sourcePath,
    fields: { 성명: ["홍길동", "김철수"] },
    output_path: outputPath,
    require_unique: true,
    mask_values: false,
  });

  assert.equal(result.isError, false);
  const resultDetails = details(result);
  assert.deepEqual(resultDetails.rejected, []);
  assert.deepEqual(
    (resultDetails.filled as Array<{ value: string }>).map(
      (field) => field.value,
    ),
    ["홍길동", "김철수"],
  );
  const reparsed = await parse(await readFile(outputPath));
  assert.equal(reparsed.success, true);
  if (reparsed.success) {
    assert.match(reparsed.markdown, /홍길동/u);
    assert.match(reparsed.markdown, /김철수/u);
  }
});

test("hwp_fill_form masks filled values by default from every result channel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-mask-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "form.hwpx");
  const outputPath = join(root, "filled.hwpx");
  const secret = "비밀값-Ω-4937";
  await writeFile(
    sourcePath,
    await validHwpx("| 성명 | ( ) |\n| --- | --- |"),
  );

  const result = await handleHwpFillForm({
    file_path: sourcePath,
    fields: { 성명: secret },
    output_path: outputPath,
  });

  assert.equal(result.isError, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
  const masked = (details(result).filled as Array<Record<string, unknown>>)[0];
  assert.ok(masked);
  assert.equal("value" in masked, false);
  assert.equal(masked.value_length, [...secret].length);

  const reparsed = await parse(await readFile(outputPath));
  assert.equal(reparsed.success, true);
  if (reparsed.success) assert.match(reparsed.markdown, new RegExp(secret, "u"));
});

test("hwp_fill_form rejects an exact encrypted-marker HWPX", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-encrypted-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "encrypted.hwpx");
  const outputPath = join(root, "filled.hwpx");
  const zip = new JSZip();
  zip.file("mimetype", "application/hwp+zip");
  zip.file(
    "META-INF/manifest.xml",
    "<manifest><encryption-data/></manifest>",
  );
  zip.file(
    "Contents/content.hpf",
    '<opf:package xmlns:opf="opf"><opf:manifest><opf:item id="s" href="section0.xml"/></opf:manifest><opf:spine><opf:itemref idref="s"/></opf:spine></opf:package>',
  );
  zip.file(
    "Contents/section0.xml",
    '<hs:sec xmlns:hs="hs" xmlns:hp="hp"><hp:p><hp:run><hp:t>성명: </hp:t></hp:run></hp:p></hs:sec>',
  );
  const encryptedBytes = await zip.generateAsync({ type: "uint8array" });
  const encryptedBuffer = Uint8Array.from(encryptedBytes).buffer;
  const parserResult = await parse(encryptedBuffer);
  assert.equal(parserResult.success, false);
  if (!parserResult.success) assert.equal(parserResult.code, "ENCRYPTED");
  await writeFile(sourcePath, encryptedBytes);
  const result = await handleHwpFillForm({
    file_path: sourcePath,
    fields: { 성명: "절대기록금지-90210" },
    output_path: outputPath,
  });

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "ENCRYPTED");
  await assertMissing(outputPath);
});

test("hwp_fill_form gives actionable preserve guidance for binary HWP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-binary-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwp");
  const outputPath = join(root, "filled.hwpx");
  await writeFile(sourcePath, syntheticHwpWithFlags(0));

  const result = await handleHwpFillForm(
    {
      file_path: sourcePath,
      fields: { 성명: "홍길동" },
      output_path: outputPath,
    },
    {
      fill: async () => {
        throw new Error("unsupported HWP fill must not execute");
      },
    } as never,
  );

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "UNSUPPORTED_HWP_PRESERVE_FILL");
  const text = JSON.stringify(result);
  assert.match(text, /HWPX/u);
  assert.doesNotMatch(text, /hwp_patch_document/u);
  await assertMissing(outputPath);
});

test("hwp_patch_document validates HWPX bytes before writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-invalid-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const outputPath = join(root, "patched.hwpx");
  const source = await validHwpx("원문");
  await writeFile(sourcePath, source);
  let writeCalls = 0;

  const result = await handleHwpPatchDocument(
    {
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: outputPath,
    },
    {
      async patch(snapshot: SnapshotLike) {
        await snapshot.cleanup();
        return fakeMutationResult(
          source,
          {
            operation: "patchHwpx",
            applied: 1,
            skipped: [],
            verification: {
              stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
              diffs: [],
            },
          },
          {
            ok: false,
            issues: [{ message: "invalid test output" }],
            entryCount: 0,
          },
          () => { writeCalls += 1; },
        );
      },
    } as never,
  );

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "HWPX_VALIDATION_FAILED");
  assert.equal(writeCalls, 0);
  await assertMissing(outputPath);
});

test("hwp_patch_document never overwrites its source, aliases, or existing outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-output-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const source = await validHwpx("원문");
  await writeFile(sourcePath, source);
  const sourceHash = sha256(source);

  await t.test("source equality", async () => {
    const result = await handleHwpPatchDocument({
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: sourcePath,
    });
    assert.equal(result.isError, true);
    assert.equal(details(result).code, "PATH_ALIAS");
    assert.equal(sha256(await readFile(sourcePath)), sourceHash);
  });

  await t.test("existing unrelated output", async () => {
    const outputPath = join(root, "existing.hwpx");
    const sentinel = Buffer.from("do-not-overwrite");
    await writeFile(outputPath, sentinel);
    const result = await handleHwpPatchDocument({
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: outputPath,
    });
    assert.equal(result.isError, true);
    assert.equal(details(result).code, "OUTPUT_CONFLICT");
    assert.deepEqual(await readFile(outputPath), sentinel);
    assert.equal(sha256(await readFile(sourcePath)), sourceHash);
  });

  await t.test("hardlink alias", async () => {
    const outputPath = join(root, "hardlink.hwpx");
    await link(sourcePath, outputPath);
    const result = await handleHwpPatchDocument({
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: outputPath,
    });
    assert.equal(result.isError, true);
    assert.equal(details(result).code, "PATH_ALIAS");
    assert.equal(sha256(await readFile(sourcePath)), sourceHash);
    assert.equal(sha256(await readFile(outputPath)), sourceHash);
  });
});

test("hwp_patch_document rejects an exact DRM-protected HWPX", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-patch-protected-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const outputPath = join(root, "patched.hwpx");
  const protectedZip = await JSZip.loadAsync(await validHwpx("원문"));
  protectedZip.file(
    "META-INF/manifest.xml",
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:drm/></manifest:manifest>',
  );
  protectedZip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(
    sourcePath,
    await protectedZip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );

  const result = await handleHwpPatchDocument({
    file_path: sourcePath,
    edited_markdown: "수정",
    output_path: outputPath,
  });

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "DRM_PROTECTED");
  await assertMissing(outputPath);
});

test("patch and fill reject exact signed HWPX bytes before mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-signed-mutation-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "signed.hwpx");
  const signed = await JSZip.loadAsync(
    await validHwpx("| 성명 | ( ) |\n| --- | --- |\n\n수정 전"),
  );
  signed.file("_xmlsignatures/sig1.xml", "<Signature/>");
  signed.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(
    sourcePath,
    await signed.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );

  const patchOutput = join(root, "patched.hwpx");
  const patched = await handleHwpPatchDocument({
    file_path: sourcePath,
    edited_markdown: "수정 후",
    output_path: patchOutput,
  });
  assert.equal(patched.isError, true);
  assert.equal(details(patched).code, "SIGNED_DOCUMENT");
  await assertMissing(patchOutput);

  const fillOutput = join(root, "filled.hwpx");
  const filled = await handleHwpFillForm({
    file_path: sourcePath,
    fields: { 성명: "홍길동" },
    output_path: fillOutput,
  });
  assert.equal(filled.isError, true);
  assert.equal(details(filled).code, "SIGNED_DOCUMENT");
  await assertMissing(fillOutput);
});

test("hwp_patch_document returns HWP_READ_ONLY for protected binary HWP before parsing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-signed-binary-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "signed.hwp");
  const outputPath = join(root, "patched.hwpx");
  await writeFile(sourcePath, syntheticHwpWithFlags(0x80));
  let parseCalls = 0;

  const result = await handleHwpPatchDocument(
    {
      file_path: sourcePath,
      edited_markdown: "수정",
      output_path: outputPath,
    },
    {
      patch: async () => {
        parseCalls += 1;
        throw new Error("patch must not run");
      },
    } as never,
  );

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "HWP_READ_ONLY");
  assert.equal(parseCalls, 0);
  await assertMissing(outputPath);
});

test("hwp_fill_form refuses invalid or unreadable generated HWPX before writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-verify-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "form.hwpx");
  await writeFile(
    sourcePath,
    await validHwpx("| 성명 | ( ) |\n| --- | --- |"),
  );

  await t.test("structural validation failure", async () => {
    const outputPath = join(root, "invalid.hwpx");
    let writeCalls = 0;
    const result = await handleHwpFillForm(
      {
        file_path: sourcePath,
        fields: { 성명: "홍길동" },
        output_path: outputPath,
      },
      {
        async fill(snapshot: SnapshotLike) {
          await snapshot.cleanup();
          return fakeMutationResult(
            await validHwpx("| 성명 | 홍길동 |\n| --- | --- |"),
            {
              operation: "fillHwpx",
              filled: [{ label: "성명", value: "홍길동" }],
              unmatched: [],
              rejected: [],
            },
            {
              ok: false,
              issues: [{ message: "invalid test output" }],
              entryCount: 0,
            },
            () => { writeCalls += 1; },
          );
        },
      } as never,
    );
    assert.equal(result.isError, true);
    assert.equal(details(result).code, "HWPX_VALIDATION_FAILED");
    assert.equal(writeCalls, 0);
    await assertMissing(outputPath);
  });

  await t.test("post-fill parse failure", async () => {
    const outputPath = join(root, "unreadable.hwpx");
    const result = await handleHwpFillForm(
      {
        file_path: sourcePath,
        fields: { 성명: "홍길동" },
        output_path: outputPath,
      },
      {
        async fill(snapshot: SnapshotLike) {
          await snapshot.cleanup();
          throw createDocumentEngineRunError("FILL_VERIFICATION_FAILED");
        },
      } as never,
    );
    assert.equal(result.isError, true);
    assert.equal(details(result).code, "FILL_VERIFICATION_FAILED");
    await assertMissing(outputPath);
  });
});

test("hwp_fill_form does not overwrite an existing destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-output-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "form.hwpx");
  const outputPath = join(root, "existing.hwpx");
  const source = await validHwpx("| 성명 | ( ) |\n| --- | --- |");
  const sentinel = Buffer.from("fill-output-sentinel");
  await writeFile(sourcePath, source);
  await writeFile(outputPath, sentinel);

  const result = await handleHwpFillForm({
    file_path: sourcePath,
    fields: { 성명: "홍길동" },
    output_path: outputPath,
  });

  assert.equal(result.isError, true);
  assert.equal(details(result).code, "OUTPUT_CONFLICT");
  assert.deepEqual(await readFile(outputPath), sentinel);
  assert.equal(sha256(await readFile(sourcePath)), sha256(source));
});

test("hwp_fill_form masks submitted values from post-fill error results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-fill-error-mask-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "form.hwpx");
  const secret = "오류에도-숨길값-77881";
  await writeFile(
    sourcePath,
    await validHwpx("| 성명 | ( ) |\n| --- | --- |"),
  );

  await t.test("validation issue", async () => {
    const outputPath = join(root, "validation-error.hwpx");
    let writeCalls = 0;
    const result = await handleHwpFillForm(
      {
        file_path: sourcePath,
        fields: { 성명: secret },
        output_path: outputPath,
        mask_values: true,
      },
      {
        async fill(snapshot: SnapshotLike) {
          await snapshot.cleanup();
          return fakeMutationResult(
            await validHwpx("| 성명 | 값 |\n| --- | --- |"),
            {
              operation: "fillHwpx",
              filled: [{ label: "성명", value: secret }],
              unmatched: [],
              rejected: [],
            },
            {
              ok: false,
              issues: [{
                message: `invalid value ${secret}`,
                entry: `Contents/${secret}.xml`,
              }],
              entryCount: 1,
            },
            () => { writeCalls += 1; },
          );
        },
      } as never,
    );

    assert.equal(result.isError, true);
    assert.equal(details(result).code, "HWPX_VALIDATION_FAILED");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
    assert.equal(writeCalls, 0);
    await assertMissing(outputPath);
  });

  await t.test("post-fill parse error", async () => {
    const outputPath = join(root, "parse-error.hwpx");
    const result = await handleHwpFillForm(
      {
        file_path: sourcePath,
        fields: { 성명: secret },
        output_path: outputPath,
        mask_values: true,
      },
      {
        async fill(snapshot: SnapshotLike) {
          await snapshot.cleanup();
          const error = new Error(`cannot parse ${secret}`);
          Object.assign(error, { code: `PRIVATE_${secret}` });
          throw error;
        },
      } as never,
    );

    assert.equal(result.isError, true);
    assert.equal(details(result).code, "FILL_ERROR");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
    await assertMissing(outputPath);
  });
});

function syntheticHwpWithFlags(flags: number): Uint8Array {
  const container = CFB.utils.cfb_new();
  const header = Buffer.alloc(256);
  header.write("HWP Document File", 0, "ascii");
  header.writeUInt32LE(0x05000302, 32);
  header.writeUInt32LE(flags, 36);
  CFB.utils.cfb_add(container, "FileHeader", header);
  return Uint8Array.from(CFB.write(container, { type: "buffer" }) as Buffer);
}

async function validHwpx(markdown: string): Promise<Uint8Array> {
  return (await normalizeGeneratedFontReferences(
    await markdownToHwpx(markdown),
  )).bytes;
}

interface SnapshotLike {
  readonly metadata?: unknown;
  cleanup(): Promise<void>;
}

function fakeMutationResult(
  bytes: Uint8Array,
  resultMetadata: Record<string, unknown>,
  validation: Readonly<{
    ok: boolean;
    issues: readonly Readonly<{ message: string; entry?: string }>[];
    entryCount: number;
  }>,
  onWrite: () => void,
) {
  return {
    payload: {
      bytes: exactArrayBuffer(bytes),
      metadata: resultMetadata,
    },
    resultMetadata,
    validation,
    async verifySourceUnchanged() {},
    async writeOutputExclusively(path: string) {
      onWrite();
      await writeFile(path, bytes, { flag: "wx" });
      return [path];
    },
    async cleanup() {},
  };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
