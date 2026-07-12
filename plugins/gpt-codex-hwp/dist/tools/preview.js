import { parse, renderHwpxToSvg, } from "kordoc";
import { z } from "zod";
import { writeFilesExclusively } from "../shared/output.js";
import { readFileBounded } from "../shared/files.js";
import { resolveLocalPath } from "../shared/paths.js";
import { inspectExactDocumentProtection } from "../shared/protection.js";
import { toolError, toolSuccess } from "../shared/result.js";
import { MAX_HIGHLIGHT_TERMS, MAX_PREVIEW_SVG_BYTES, assertHighlightBudget, assertUtf8Budget, } from "../shared/resource-limits.js";
import { detectPreciseDocumentFormat, inspectRhwpPreflightProtection, loadRhwpBackend, } from "./rhwp-backend.js";
export const HWP_RENDER_PREVIEW_TOOL_NAME = "hwp_render_preview";
const defaultPreviewDependencies = {
    renderDocument: renderHwpxToSvg,
    detectDocumentFormat: detectPreciseDocumentFormat,
    inspectExactProtection: inspectExactDocumentProtection,
    parseDocument: parse,
    loadRhwpBackend,
};
export async function handleHwpRenderPreview(input, dependencyOverrides = {}) {
    let filePath;
    let outputPath;
    try {
        if (input.highlight !== undefined) {
            assertHighlightBudget(input.highlight);
        }
        filePath = resolveLocalPath(input.file_path, "file_path");
        outputPath = resolveLocalPath(input.output_svg_path, "output_svg_path");
        // The source is fully read before any output directory or file is created.
        const pristineBytes = Uint8Array.from(await readFileBounded(filePath, "source document"));
        const dependencies = {
            ...defaultPreviewDependencies,
            ...(typeof dependencyOverrides === "function"
                ? { renderDocument: dependencyOverrides }
                : dependencyOverrides),
        };
        const options = {};
        if (input.reflow !== undefined) {
            options.reflow = input.reflow;
        }
        if (input.highlight !== undefined) {
            options.highlights = [...input.highlight];
        }
        const format = await dependencies.detectDocumentFormat(exactArrayBuffer(pristineBytes));
        if (format !== "hwp" && format !== "hwpx") {
            return toolError(`Preview supports only precise HWP or HWPX input (detected: ${format}).`, {
                code: "UNSUPPORTED_PREVIEW_FORMAT",
                file_path: filePath,
                output_svg_path: outputPath,
                format,
            });
        }
        const exactProtection = await dependencies.inspectExactProtection(Uint8Array.from(pristineBytes), format);
        if (exactProtection !== undefined) {
            return toolError(`The document is not eligible for preview: ${exactProtection.error}`, {
                code: exactProtection.code,
                error: exactProtection.error,
                file_path: filePath,
                output_svg_path: outputPath,
                format,
            });
        }
        let rendered;
        try {
            rendered = await dependencies.renderDocument(Uint8Array.from(pristineBytes), options);
        }
        catch (primaryError) {
            return await renderWithRhwpFallback({
                filePath,
                outputPath,
                bytes: pristineBytes,
                format,
                primaryError,
                reflow: input.reflow,
                highlights: input.highlight,
            }, dependencies);
        }
        assertUtf8Budget(rendered.svg, MAX_PREVIEW_SVG_BYTES, "SVG preview", "PREVIEW_TOO_LARGE");
        await writeFilesExclusively([{ path: outputPath, data: rendered.svg }], { sourcePaths: [filePath] });
        return toolSuccess("Rendered HWPX SVG preview.", {
            output_svg_path: outputPath,
            page_count: rendered.pageCount,
            dimensions: {
                width: rendered.width,
                height: rendered.height,
            },
            warnings: [...rendered.warnings],
            stats: { ...rendered.stats },
        });
    }
    catch (error) {
        const message = errorMessage(error);
        return toolError(`Could not render the HWPX preview: ${message}`, {
            code: errorCode(error, "HWPX_PREVIEW_ERROR"),
            error: message,
            file_path: filePath ?? safeResolvedPath(input.file_path),
            output_svg_path: outputPath ?? safeResolvedPath(input.output_svg_path),
        });
    }
}
async function renderWithRhwpFallback(input, dependencies) {
    const primaryMessage = errorMessage(input.primaryError);
    const primaryCode = errorCode(input.primaryError, "HWPX_PREVIEW_ERROR");
    // Deliberately omit filePath so encrypted/DRM/distribution checks are made
    // against the exact in-memory bytes rather than a path shortcut.
    const preflight = await dependencies.parseDocument(exactArrayBuffer(input.bytes));
    if (!preflight.success) {
        return toolError(`The document is not eligible for rhwp preview fallback: ${preflight.error}`, {
            code: preflight.code ?? "PARSE_ERROR",
            error: preflight.error,
            file_path: input.filePath,
            output_svg_path: input.outputPath,
            format: input.format,
            primary_error: { code: primaryCode, message: primaryMessage },
        });
    }
    const protection = inspectRhwpPreflightProtection(preflight);
    if (protection !== undefined) {
        return toolError(`The document is not eligible for rhwp preview fallback: ${protection.error}`, {
            code: protection.code,
            error: protection.error,
            file_path: input.filePath,
            output_svg_path: input.outputPath,
            format: input.format,
            primary_error: { code: primaryCode, message: primaryMessage },
        });
    }
    const loaded = await dependencies.loadRhwpBackend();
    if (!loaded.available) {
        return primaryPreviewFailure(input, primaryCode, primaryMessage, {
            code: "MISSING_RHWP_BACKEND",
            reason: loaded.reason,
        });
    }
    try {
        let candidate;
        let document;
        try {
            document = loaded.backend.createDocument(Uint8Array.from(input.bytes));
            const pageCount = document.pageCount();
            if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
                throw new Error("rhwp fallback returned no valid pages.");
            }
            const svg = document.renderPageSvg(0);
            if (typeof svg !== "string" || !/^\s*<svg\b/iu.test(svg)) {
                throw new Error("rhwp fallback returned an empty or invalid SVG preview.");
            }
            const warnings = [
                "rhwp fallback uses a Unicode-width heuristic in Node; font metrics and line wrapping may differ from Hancom.",
                "This SVG is a preview only; Hancom GUI visual fidelity has not been verified.",
            ];
            if (input.reflow !== undefined) {
                warnings.push("The rhwp fallback does not apply the Kordoc reflow option.");
            }
            if ((input.highlights?.length ?? 0) > 0) {
                warnings.push("The rhwp fallback does not apply requested text highlights.");
            }
            candidate = {
                svg,
                pageCount,
                dimensions: parseSvgDimensions(svg),
                warnings,
            };
        }
        finally {
            if (document !== undefined) {
                releasePreviewDocument(document);
            }
        }
        if (candidate === undefined) {
            throw new Error("rhwp fallback produced no SVG candidate.");
        }
        assertUtf8Budget(candidate.svg, MAX_PREVIEW_SVG_BYTES, "SVG preview", "PREVIEW_TOO_LARGE");
        // Commit only after WASM cleanup succeeds so a cleanup error cannot leave
        // an artifact behind while MCP reports failure.
        await writeFilesExclusively([{ path: input.outputPath, data: candidate.svg }], { sourcePaths: [input.filePath] });
        return toolSuccess("Rendered an SVG preview with the optional rhwp fallback.", {
            output_svg_path: input.outputPath,
            backend: "rhwp",
            backend_version: loaded.backend.version,
            page_count: candidate.pageCount,
            ...(candidate.dimensions === undefined
                ? {}
                : { dimensions: candidate.dimensions }),
            degraded_font_metrics: true,
            primary_error: { code: primaryCode, message: primaryMessage },
            warnings: candidate.warnings,
        });
    }
    catch (error) {
        const fallbackMessage = errorMessage(error);
        return toolError(`Kordoc preview failed, and the rhwp fallback also failed: ${fallbackMessage}`, {
            code: errorCode(error, "RHWP_PREVIEW_FALLBACK_FAILED"),
            error: fallbackMessage,
            file_path: input.filePath,
            output_svg_path: input.outputPath,
            format: input.format,
            primary_error: { code: primaryCode, message: primaryMessage },
            fallback: {
                code: "RHWP_PREVIEW_FALLBACK_FAILED",
                reason: fallbackMessage,
            },
        });
    }
}
function releasePreviewDocument(document) {
    try {
        document.free();
    }
    catch (error) {
        const wrapped = new Error(`Could not free the rhwp preview document: ${errorMessage(error)}`);
        wrapped.code = "RHWP_BACKEND_CLEANUP_FAILED";
        throw wrapped;
    }
}
function primaryPreviewFailure(input, primaryCode, primaryMessage, fallback) {
    return toolError(`Could not render the HWPX preview: ${primaryMessage}`, {
        code: primaryCode,
        error: primaryMessage,
        file_path: input.filePath,
        output_svg_path: input.outputPath,
        primary_error: { code: primaryCode, message: primaryMessage },
        fallback,
    });
}
function parseSvgDimensions(svg) {
    const rootTag = /<svg\b[^>]*>/iu.exec(svg.slice(0, 4096))?.[0];
    if (rootTag === undefined)
        return undefined;
    const width = numericSvgAttribute(rootTag, "width");
    const height = numericSvgAttribute(rootTag, "height");
    if (width !== undefined && height !== undefined) {
        return { width, height };
    }
    const viewBox = /\bviewBox\s*=\s*["']\s*[-+0-9.eE]+[ ,]+[-+0-9.eE]+[ ,]+([-+0-9.eE]+)[ ,]+([-+0-9.eE]+)\s*["']/iu.exec(rootTag);
    const viewWidth = Number(viewBox?.[1]);
    const viewHeight = Number(viewBox?.[2]);
    return positiveFinite(viewWidth) && positiveFinite(viewHeight)
        ? { width: viewWidth, height: viewHeight }
        : undefined;
}
function numericSvgAttribute(rootTag, attribute) {
    const match = new RegExp(`\\b${attribute}\\s*=\\s*["']\\s*([-+0-9.eE]+)(?:px)?\\s*["']`, "iu").exec(rootTag);
    const value = Number(match?.[1]);
    return positiveFinite(value) ? value : undefined;
}
function positiveFinite(value) {
    return Number.isFinite(value) && value > 0 && value <= 10_000_000;
}
function exactArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
export function registerHwpRenderPreview(server) {
    server.registerTool(HWP_RENDER_PREVIEW_TOOL_NAME, {
        title: "Render HWP/HWPX SVG preview",
        description: "Render the exact requested HWPX file with Kordoc, or fall back to optional rhwp for precise HWP/HWPX input, writing a new local SVG without returning its payload through MCP.",
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
    }, (args) => handleHwpRenderPreview(args));
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
