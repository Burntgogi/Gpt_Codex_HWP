import { z } from "zod";
import { getDefaultDocumentEngineFacade } from "../shared/lazy-document-engine.js";
import { prepareDocumentRenderOutput } from "../shared/document-render-output.js";
import { openDocumentSnapshot } from "../shared/document-snapshot.js";
import { resolveLocalPath } from "../shared/paths.js";
import { commitBudgetedToolSuccess, toolError, } from "../shared/result.js";
import { runWithToolExecutionContext, toDocumentEngineExecutionContext, } from "../shared/tool-context.js";
import { MAX_HIGHLIGHT_TERMS, assertHighlightBudget, } from "../shared/resource-limits.js";
import { maxWorkerSnapshotBytesForRequest } from "../workers/document-execution-policy.js";
export const HWP_RENDER_PREVIEW_TOOL_NAME = "hwp_render_preview";
export async function handleHwpRenderPreview(input, documentEngine, context) {
    let filePath;
    let outputPath;
    try {
        if (input.highlight !== undefined) {
            assertHighlightBudget(input.highlight);
        }
        filePath = resolveLocalPath(input.file_path, "file_path");
        outputPath = resolveLocalPath(input.output_svg_path, "output_svg_path");
        const renderOptions = {
            ...(input.reflow === undefined ? {} : { reflow: input.reflow }),
            ...(input.highlight === undefined
                ? {}
                : { highlights: [...input.highlight] }),
        };
        const snapshot = await openDocumentSnapshot(filePath, {
            workerInputMaxBytes: maxWorkerSnapshotBytesForRequest({
                input: {},
                options: renderOptions,
            }),
        });
        if (snapshot.metadata.shallowFormat.candidate === "unknown") {
            try {
                await snapshot.verifySourceUnchanged();
                return toolError("Preview supports only precise HWP or HWPX input (detected: unknown).", {
                    code: "UNSUPPORTED_PREVIEW_FORMAT",
                    file_path: filePath,
                    output_svg_path: outputPath,
                    format: "unknown",
                });
            }
            finally {
                await snapshot.cleanup();
            }
        }
        const resolvedDocumentEngine = documentEngine ?? await getDefaultDocumentEngineFacade();
        const rendered = await resolvedDocumentEngine.render(snapshot, renderOptions, toDocumentEngineExecutionContext(context));
        const prepared = await prepareDocumentRenderOutput(rendered, {
            ...(context === undefined ? {} : { signal: context.signal }),
        });
        try {
            const metadata = safeRecord(prepared.metadata);
            let summary;
            let details;
            if (metadata?.backend === "rhwp") {
                const warnings = [
                    "rhwp uses a Unicode-width heuristic in Node; font metrics and line wrapping may differ from Hancom.",
                    "This SVG is a preview only; Hancom GUI visual fidelity has not been verified.",
                ];
                if (input.reflow !== undefined) {
                    warnings.push("The rhwp backend does not apply the Kordoc reflow option.");
                }
                if ((input.highlight?.length ?? 0) > 0) {
                    warnings.push("The rhwp backend does not apply requested text highlights.");
                }
                summary = "Rendered an SVG preview with the optional rhwp backend.";
                details = {
                    output_svg_path: outputPath,
                    backend: "rhwp",
                    ...(typeof metadata.version === "string"
                        ? { backend_version: metadata.version }
                        : {}),
                    ...(safePositiveInteger(metadata.pageCount) === undefined
                        ? {}
                        : { page_count: safePositiveInteger(metadata.pageCount) }),
                    degraded_font_metrics: true,
                    warnings,
                };
            }
            else {
                summary = "Rendered HWPX SVG preview.";
                details = {
                    output_svg_path: outputPath,
                    ...(safePositiveInteger(metadata?.pageCount) === undefined
                        ? {}
                        : { page_count: safePositiveInteger(metadata?.pageCount) }),
                    ...(safeDimensions(metadata) === undefined
                        ? {}
                        : { dimensions: safeDimensions(metadata) }),
                    warnings: safeStringArray(metadata?.warnings),
                    stats: safeRecord(metadata?.stats) ?? {},
                };
            }
            return await commitBudgetedToolSuccess(summary, details, async () => {
                await prepared.writeExclusively(outputPath, {
                    sourcePaths: [filePath],
                    ...(context === undefined ? {} : { signal: context.signal }),
                });
            });
        }
        finally {
            await prepared.cleanup();
        }
    }
    catch (error) {
        const message = errorMessage(error);
        const code = errorCode(error, "HWPX_PREVIEW_ERROR");
        if (code === "UNSUPPORTED_FORMAT") {
            return toolError("Preview supports only precise HWP or HWPX input (detected: unknown).", {
                code: "UNSUPPORTED_PREVIEW_FORMAT",
                error: message,
                file_path: filePath ?? safeResolvedPath(input.file_path),
                output_svg_path: outputPath ?? safeResolvedPath(input.output_svg_path),
                format: "unknown",
            });
        }
        return toolError(`Could not render the HWPX preview: ${message}`, {
            code,
            error: message,
            file_path: filePath ?? safeResolvedPath(input.file_path),
            output_svg_path: outputPath ?? safeResolvedPath(input.output_svg_path),
        });
    }
}
export function registerHwpRenderPreview(server, documentEngine) {
    server.registerTool(HWP_RENDER_PREVIEW_TOOL_NAME, {
        title: "Render HWP/HWPX SVG preview",
        description: "Render the exact requested HWP/HWPX file in an isolated engine, writing a new local SVG without returning its payload through MCP.",
        inputSchema: {
            file_path: z.string().min(1).describe("Local HWP or HWPX path to render."),
            output_svg_path: z
                .string()
                .min(1)
                .describe("New local SVG path; existing files are never overwritten."),
            reflow: z
                .boolean()
                .optional()
                .describe("Synthesize layout when the HWPX has no layout cache."),
            highlight: z
                .array(z.string().min(1).max(256))
                .max(MAX_HIGHLIGHT_TERMS)
                .optional()
                .describe("Case-insensitive text strings to highlight in the preview."),
        },
        annotations: {
            readOnlyHint: false,
        },
    }, (args, extra) => runWithToolExecutionContext(extra, (context) => handleHwpRenderPreview(args, documentEngine, context)));
}
function safeRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function safePositiveInteger(value) {
    return Number.isSafeInteger(value) && Number(value) > 0
        ? Number(value)
        : undefined;
}
function safeDimensions(metadata) {
    const width = metadata?.width;
    const height = metadata?.height;
    return typeof width === "number" && Number.isFinite(width) && width > 0 &&
        typeof height === "number" && Number.isFinite(height) && height > 0
        ? { width, height }
        : undefined;
}
function safeStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? [...value]
        : [];
}
function safeResolvedPath(path) {
    try {
        return typeof path === "string"
            ? resolveLocalPath(path, "path")
            : undefined;
    }
    catch {
        return undefined;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function errorCode(error, fallback) {
    if (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.length > 0) {
        return error.code;
    }
    return fallback;
}
