import { MAX_MCP_RESPONSE_BYTES, serializedBytes, } from "./resource-limits.js";
export function toolSuccess(summary, details) {
    return buildToolResult(summary, details, false);
}
export function toolError(summary, details) {
    return buildToolResult(summary, details, true);
}
export async function commitBudgetedToolSuccess(summary, details, commitOutput) {
    const result = toolSuccess(summary, details);
    if (result.isError === true)
        return result;
    await commitOutput();
    return result;
}
function buildToolResult(summary, details, isError) {
    const readableSummary = summary.trim();
    if (readableSummary.length === 0) {
        throw new Error("Tool result summary must not be empty.");
    }
    const safeDetails = immutableDetailsSnapshot(sanitizeSensitivePathError(details));
    const result = assembleToolResult(readableSummary, safeDetails, isError);
    const responseBytes = serializedBytes(result);
    if (responseBytes <= MAX_MCP_RESPONSE_BYTES)
        return result;
    return oversizedToolResult(responseBytes);
}
function assembleToolResult(summary, details, isError) {
    return {
        content: [
            { type: "text", text: summary },
            { type: "text", text: JSON.stringify(details, null, 2) },
        ],
        structuredContent: details,
        isError,
    };
}
function oversizedToolResult(responseBytes) {
    const details = {
        code: "RESPONSE_TOO_LARGE",
        error: "The tool result exceeds the eight MiB MCP response limit.",
        response_bytes: responseBytes,
        maximum_response_bytes: MAX_MCP_RESPONSE_BYTES,
    };
    const result = assembleToolResult("The tool result is too large for one MCP response.", details, true);
    if (serializedBytes(result) > MAX_MCP_RESPONSE_BYTES) {
        throw new Error("Bounded MCP response fallback exceeds its safety limit.");
    }
    return result;
}
function sanitizeSensitivePathError(details) {
    if (details.code !== "PATH_OUTSIDE_ALLOWED_ROOTS")
        return details;
    return {
        code: "PATH_OUTSIDE_ALLOWED_ROOTS",
        error: "Path is outside configured allowed roots.",
    };
}
function immutableDetailsSnapshot(details) {
    const serialized = JSON.stringify(details);
    if (serialized === undefined) {
        throw new Error("Tool result details must be JSON serializable.");
    }
    const snapshot = JSON.parse(serialized);
    if (!isRecord(snapshot)) {
        throw new Error("Tool result details must serialize to a JSON object.");
    }
    return freezeJson(snapshot);
}
function freezeJson(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            freezeJson(item);
        return Object.freeze(value);
    }
    if (isRecord(value)) {
        for (const item of Object.values(value))
            freezeJson(item);
        return Object.freeze(value);
    }
    return value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
