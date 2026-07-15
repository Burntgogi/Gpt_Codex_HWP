import assert from "node:assert/strict";
import test from "node:test";

import { toolError, toolSuccess } from "../src/shared/result.js";

function textAt(
  content: ReturnType<typeof toolSuccess>["content"],
  index: number,
): string {
  const item = content[index];
  assert.equal(item?.type, "text");
  if (item?.type !== "text") {
    throw new Error(`Expected text content at index ${index}`);
  }
  return item.text;
}

test("toolSuccess returns a readable summary and JSON details", () => {
  const details = { outputPath: "C:/documents/result.hwpx", pageCount: 2 };
  const result = toolSuccess("Created the HWPX document.", details);

  assert.equal(result.isError, false);
  assert.equal(textAt(result.content, 0), "Created the HWPX document.");
  assert.deepEqual(JSON.parse(textAt(result.content, 1)), details);
  assert.deepEqual(result.structuredContent, details);
});

test("toolError marks failures and preserves machine-readable details", () => {
  const details = { code: "UNSUPPORTED_DOCUMENT", encrypted: true };
  const result = toolError("The encrypted document cannot be processed.", details);

  assert.equal(result.isError, true);
  assert.equal(
    textAt(result.content, 0),
    "The encrypted document cannot be processed.",
  );
  assert.deepEqual(JSON.parse(textAt(result.content, 1)), details);
  assert.deepEqual(result.structuredContent, details);
});

test("tool results reject an empty human-readable summary", () => {
  assert.throws(() => toolSuccess("  ", {}), /summary.*empty/i);
  assert.throws(() => toolError("", { code: "ERROR" }), /summary.*empty/i);
});
