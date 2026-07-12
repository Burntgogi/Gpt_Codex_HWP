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
    return {
        content: [
            { type: "text", text: readableSummary },
            { type: "text", text: JSON.stringify(details, null, 2) },
        ],
        structuredContent: details,
        isError,
    };
}
