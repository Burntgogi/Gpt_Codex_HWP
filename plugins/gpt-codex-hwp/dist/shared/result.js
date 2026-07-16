export function toolSuccess(summary, details) {
    return buildToolResult(summary, details, false);
}
export function toolError(summary, details) {
    return buildToolResult(summary, details, true);
}
function buildToolResult(summary, details, isError) {
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
function sanitizeSensitivePathError(details) {
    if (details.code !== "PATH_OUTSIDE_ALLOWED_ROOTS")
        return details;
    return {
        code: "PATH_OUTSIDE_ALLOWED_ROOTS",
        error: "Path is outside configured allowed roots.",
    };
}
