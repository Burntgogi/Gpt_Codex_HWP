import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertHwpxOutputPath } from "../src/shared/document-contract.js";
import { handleHwpInsertImage } from "../src/tools/assets.js";
import {
  handleHwpFillForm,
  handleHwpPatchDocument,
} from "../src/tools/patch.js";
import { handleHwpGenerateHwpx } from "../src/tools/write.js";

const REJECTED_OUTPUTS = ["result.hwp", "result", "result.docx"] as const;

test("document contract accepts only a nonempty HWPX output path", () => {
  assert.doesNotThrow(() => assertHwpxOutputPath("result.hwpx"));
  assert.doesNotThrow(() => assertHwpxOutputPath("RESULT.HWPX"));

  for (const value of [
    ...REJECTED_OUTPUTS,
    "",
    "   ",
    ".hwpx",
    undefined,
    1,
    { toString: () => "secret-output.hwp" },
  ]) {
    assert.throws(
      () => assertHwpxOutputPath(value),
      (error: unknown) => {
        assert.equal(errorCode(error), "HWPX_OUTPUT_REQUIRED");
        const diagnostic = error instanceof Error ? error.message : String(error);
        assert.equal(diagnostic, "Document output must use a nonempty .hwpx path.");
        assert.doesNotMatch(diagnostic, /result|secret|\.hwp\b|\.docx/iu);
        return true;
      },
    );
  }
});

test("document contract rejects conversion-style HWP and extensionless outputs", () => {
  for (const output of ["converted.hwp", "converted"]) {
    assert.throws(
      () => assertHwpxOutputPath(output),
      (error: unknown) => errorCode(error) === "HWPX_OUTPUT_REQUIRED",
    );
  }
});

test("document contract rejects generation outputs before engine dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-output-contract-generate-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let dispatches = 0;

  for (const name of REJECTED_OUTPUTS) {
    const output = join(root, name);
    const result = await handleHwpGenerateHwpx(
      { markdown: "# test", output_path: output },
      {
        markdownToHwpx: async () => {
          dispatches += 1;
          return new ArrayBuffer(0);
        },
      },
    );
    assertContractResult(result, [output]);
    await assert.rejects(access(output));
  }

  assert.equal(dispatches, 0);
});

test("document contract rejects patch outputs before source read or engine dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-output-contract-patch-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let dispatches = 0;
  const source = join(root, "missing-source.hwpx");

  for (const name of REJECTED_OUTPUTS) {
    const output = join(root, name);
    const result = await handleHwpPatchDocument(
      {
        file_path: source,
        edited_markdown: "changed",
        output_path: output,
      },
      {
        detectDocumentFormat: async () => {
          dispatches += 1;
          return "hwpx";
        },
      },
    );
    assertContractResult(result, [output, source]);
    await assert.rejects(access(output));
  }

  assert.equal(dispatches, 0);
});

test("document contract rejects fill outputs before source read or engine dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-output-contract-fill-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let dispatches = 0;
  const source = join(root, "missing-source.hwpx");

  for (const name of REJECTED_OUTPUTS) {
    const output = join(root, name);
    const result = await handleHwpFillForm(
      {
        file_path: source,
        fields: { name: "value" },
        output_path: output,
      },
      {
        detectDocumentFormat: async () => {
          dispatches += 1;
          return "hwpx";
        },
      },
    );
    assertContractResult(result, [output, source]);
    await assert.rejects(access(output));
  }

  assert.equal(dispatches, 0);
});

test("document contract rejects image-placement outputs before source read or engine dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-output-contract-image-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let dispatches = 0;
  const source = join(root, "missing-source.hwpx");
  const image = join(root, "missing-image.png");

  for (const name of REJECTED_OUTPUTS) {
    const output = join(root, name);
    const result = await handleHwpInsertImage(
      {
        file_path: source,
        image_path: image,
        output_path: output,
        anchor_text: "anchor",
      },
      {
        validateDocument: async () => {
          dispatches += 1;
          return { ok: true, issues: [], entryCount: 0 };
        },
      },
    );
    assertContractResult(result, [output, source, image]);
    await assert.rejects(access(output));
  }

  assert.equal(dispatches, 0);
});

function assertContractResult(
  result: Awaited<ReturnType<typeof handleHwpGenerateHwpx>>,
  privatePaths: readonly string[],
): void {
  assert.equal(result.isError, true);
  assert.equal(errorCode(result.structuredContent), "HWPX_OUTPUT_REQUIRED");
  const diagnostic = JSON.stringify(result);
  for (const path of privatePaths) {
    assert.doesNotMatch(diagnostic, new RegExp(escapeRegExp(path), "iu"));
  }
}

function errorCode(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "code" in value) {
    return typeof value.code === "string" ? value.code : undefined;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
