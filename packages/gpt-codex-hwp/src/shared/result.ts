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

  const safeDetails = sanitizeSensitivePathError(details);
  return {
    content: [
      { type: "text", text: readableSummary },
      { type: "text", text: JSON.stringify(safeDetails, null, 2) },
    ],
    structuredContent: safeDetails,
    isError,
  };
}

function sanitizeSensitivePathError(
  details: ToolResultDetails,
): ToolResultDetails {
  if (details.code !== "PATH_OUTSIDE_ALLOWED_ROOTS") return details;
  return {
    code: "PATH_OUTSIDE_ALLOWED_ROOTS",
    error: "Path is outside configured allowed roots.",
  };
}
