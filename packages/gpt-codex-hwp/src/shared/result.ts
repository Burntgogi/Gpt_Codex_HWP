import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  MAX_MCP_RESPONSE_BYTES,
  serializedBytes,
} from "./resource-limits.js";

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

export async function commitBudgetedToolSuccess(
  summary: string,
  details: ToolResultDetails,
  commitOutput: () => Promise<void>,
): Promise<CallToolResult> {
  const result = toolSuccess(summary, details);
  if (result.isError === true) return result;
  await commitOutput();
  return result;
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

  const safeDetails = immutableDetailsSnapshot(
    sanitizeSensitivePathError(details),
  );
  const result = assembleToolResult(readableSummary, safeDetails, isError);
  const responseBytes = serializedBytes(result);
  if (responseBytes <= MAX_MCP_RESPONSE_BYTES) return result;
  return oversizedToolResult(responseBytes);
}

function assembleToolResult(
  summary: string,
  details: ToolResultDetails,
  isError: boolean,
): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(details, null, 2) },
    ],
    structuredContent: details,
    isError,
  };
}

function oversizedToolResult(responseBytes: number): CallToolResult {
  const details = {
    code: "RESPONSE_TOO_LARGE",
    error: "The tool result exceeds the eight MiB MCP response limit.",
    response_bytes: responseBytes,
    maximum_response_bytes: MAX_MCP_RESPONSE_BYTES,
  };
  const result = assembleToolResult(
    "The tool result is too large for one MCP response.",
    details,
    true,
  );
  if (serializedBytes(result) > MAX_MCP_RESPONSE_BYTES) {
    throw new Error("Bounded MCP response fallback exceeds its safety limit.");
  }
  return result;
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

function immutableDetailsSnapshot(
  details: ToolResultDetails,
): ToolResultDetails {
  const serialized = JSON.stringify(details);
  if (serialized === undefined) {
    throw new Error("Tool result details must be JSON serializable.");
  }
  const snapshot: unknown = JSON.parse(serialized);
  if (!isRecord(snapshot)) {
    throw new Error("Tool result details must serialize to a JSON object.");
  }
  return freezeJson(snapshot) as ToolResultDetails;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) freezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
