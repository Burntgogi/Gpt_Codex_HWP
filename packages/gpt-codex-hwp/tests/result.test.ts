import assert from "node:assert/strict";
import test from "node:test";

import { toolError, toolSuccess } from "../src/shared/result.js";
import {
  MAX_MCP_RESPONSE_BYTES,
  serializedBytes,
} from "../src/shared/resource-limits.js";

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

test("tool results enforce the final eight MiB MCP serialization boundary", () => {
  let summary = "S";
  let baseBytes = serializedBytes(uncheckedToolResult(summary, { padding: "" }, false));
  while ((MAX_MCP_RESPONSE_BYTES - baseBytes) % 2 !== 0) {
    summary += "S";
    baseBytes = serializedBytes(uncheckedToolResult(summary, { padding: "" }, false));
  }
  const paddingCharacters = (MAX_MCP_RESPONSE_BYTES - baseBytes) / 2;
  assert.ok(Number.isSafeInteger(paddingCharacters) && paddingCharacters > 0);

  const boundary = toolSuccess(summary, { padding: "x".repeat(paddingCharacters) });
  assert.equal(boundary.isError, false);
  assert.equal(serializedBytes(boundary), MAX_MCP_RESPONSE_BYTES);

  const oversized = toolSuccess(summary, { padding: "x".repeat(paddingCharacters + 1) });
  const oversizedBytes = serializedBytes(uncheckedToolResult(
    summary,
    { padding: "x".repeat(paddingCharacters + 1) },
    false,
  ));
  assert.equal(oversized.isError, true);
  assert.ok(serializedBytes(oversized) <= MAX_MCP_RESPONSE_BYTES);
  assert.deepEqual(oversized.structuredContent, {
    code: "RESPONSE_TOO_LARGE",
    error: "The tool result exceeds the eight MiB MCP response limit.",
    response_bytes: oversizedBytes,
    maximum_response_bytes: MAX_MCP_RESPONSE_BYTES,
  });
});

test("oversized tool errors collapse to the same bounded non-recursive fallback", () => {
  const details = {
    code: "VALIDATION_FAILED",
    issues: ["x".repeat(MAX_MCP_RESPONSE_BYTES)],
  };
  const result = toolError("Could not process the document.", details);
  assert.equal(result.isError, true);
  assert.ok(serializedBytes(result) <= MAX_MCP_RESPONSE_BYTES);
  assert.deepEqual(result.structuredContent, {
    code: "RESPONSE_TOO_LARGE",
    error: "The tool result exceeds the eight MiB MCP response limit.",
    response_bytes: serializedBytes(uncheckedToolResult(
      "Could not process the document.",
      details,
      true,
    )),
    maximum_response_bytes: MAX_MCP_RESPONSE_BYTES,
  });
});

function uncheckedToolResult(
  summary: string,
  details: Record<string, unknown>,
  isError: boolean,
): ReturnType<typeof toolSuccess> {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(details, null, 2) },
    ],
    structuredContent: details,
    isError,
  };
}
