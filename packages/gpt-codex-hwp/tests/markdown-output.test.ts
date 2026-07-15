import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertMarkdownOutputByteLength,
  MAX_INLINE_MARKDOWN_CHARACTERS,
  MAX_MARKDOWN_OUTPUT_BYTES,
  MarkdownDeliveryError,
  planMarkdownDelivery,
  RECOMMENDED_CHUNK_CHARACTERS,
} from "../src/shared/markdown-output.js";

test("the inline Markdown boundary is exactly 64,000 characters", () => {
  assert.equal(MAX_INLINE_MARKDOWN_CHARACTERS, 64_000);
  assert.equal(RECOMMENDED_CHUNK_CHARACTERS, 64_000);

  const plan = planMarkdownDelivery("가".repeat(64_000));

  assert.equal(plan.inlineMarkdown.length, 64_000);
  assert.equal(plan.truncated, false);
  assert.equal(plan.outputPath, undefined);
  assert.equal(plan.characters, 64_000);
  assert.equal(plan.bytes, 192_000);
  assert.equal(plan.recommendedChunkCharacters, 64_000);
});

test("inline Markdown above 64,000 characters requires a file path", () => {
  assert.throws(
    () => planMarkdownDelivery("가".repeat(64_001)),
    (error: unknown) => {
      assert.ok(error instanceof MarkdownDeliveryError);
      assert.equal(error.code, "RESPONSE_TOO_LARGE");
      assert.equal(error.details.maximum_inline_characters, 64_000);
      assert.match(String(error.details.guidance), /markdown_output_path/u);
      return true;
    },
  );
});

test("a Markdown output path returns a context-safe preview", () => {
  const markdown = "가".repeat(64_001);
  const plan = planMarkdownDelivery(markdown, "result.MD");

  assert.equal(plan.inlineMarkdown, markdown.slice(0, 64_000));
  assert.equal(plan.truncated, true);
  assert.equal(plan.outputPath, resolve("result.MD"));
  assert.equal(plan.characters, 64_001);
  assert.equal(plan.bytes, Buffer.byteLength(markdown, "utf8"));
  assert.equal(plan.recommendedChunkCharacters, 64_000);
});

test("the Markdown output path must use the .md extension", () => {
  assert.throws(
    () => planMarkdownDelivery("본문", "result.txt"),
    (error: unknown) =>
      error instanceof MarkdownDeliveryError &&
      error.code === "INVALID_MARKDOWN_OUTPUT_PATH",
  );
});

test("the derived Markdown byte boundary is exactly 256 MiB", () => {
  assert.equal(MAX_MARKDOWN_OUTPUT_BYTES, 256 * 1024 * 1024);
  assert.doesNotThrow(() =>
    assertMarkdownOutputByteLength(256 * 1024 * 1024),
  );
  assert.throws(
    () => assertMarkdownOutputByteLength(256 * 1024 * 1024 + 1),
    (error: unknown) =>
      error instanceof MarkdownDeliveryError &&
      error.code === "MARKDOWN_OUTPUT_LIMIT",
  );
});

test("invalid Markdown byte lengths are rejected", () => {
  for (const bytes of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(
      () => assertMarkdownOutputByteLength(bytes),
      (error: unknown) =>
        error instanceof MarkdownDeliveryError &&
        error.code === "MARKDOWN_OUTPUT_LIMIT",
    );
  }
});
