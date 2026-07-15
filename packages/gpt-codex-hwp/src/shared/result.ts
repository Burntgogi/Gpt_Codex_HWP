import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolResultDetails = Record<string, unknown>;

export function toolSuccess(
  summary: string,
  details: ToolResultDetails,
): CallToolResult {
  return buildToolResult(summary, details, false);
}

export function toolError(
  summary: string,
  details: ToolResultDetails,
): CallToolResult {
  return buildToolResult(summary, details, true);
}

function buildToolResult(
  summary: string,
  details: ToolResultDetails,
  isError: boolean,
): CallToolResult {
  const readableSummary = summary.trim();
  if (readableSummary.length === 0) {
    throw new Error("Tool result summary must not be empty.");
  }

  return {
    content: [
      { type: "text", text: readableSummary },
      { type: "text", text: JSON.stringify(details, null, 2) },
    ],
    structuredContent: details,
    isError,
  };
}
