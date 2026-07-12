import { markdownToHwpx, renderHwpxToSvg, validateHwpx, } from "kordoc";
import { z } from "zod";
import { HwpxFontReferenceError, inspectHwpxFontReferences, normalizeGeneratedFontReferences, } from "../shared/hwpx-font-integrity.js";
import { writeFilesExclusively } from "../shared/output.js";
import { readFileBounded } from "../shared/files.js";
import { resolveLocalPath } from "../shared/paths.js";
import { inspectExactDocumentProtection } from "../shared/protection.js";
import { toolError, toolSuccess } from "../shared/result.js";
import { detectPreciseDocumentFormat } from "./rhwp-backend.js";
export const HWP_GENERATE_HWPX_TOOL_NAME = "hwp_generate_hwpx";
export const HWP_VALIDATE_TOOL_NAME = "hwp_validate";
const MAX_MARKDOWN_INPUT_CHARACTERS = 5_000_000;
const defaultDependencies = {
    markdownToHwpx,
    normalizeGeneratedFontReferences,
    inspectHwpxFontReferences,
    validateHwpx,
    renderHwpxToSvg,
};
export async function handleHwpGenerateHwpx(input, dependencyOverrides = {}) {
    let outputPath;
    let previewPath;
    try {
        outputPath = resolveLocalPath(input.output_path, "output_path");
        previewPath =
            input.preview_svg_path === undefined
                ? undefined
                : resolveLocalPath(input.preview_svg_path, "preview_svg_path");
        if (input.markdown.length > MAX_MARKDOWN_INPUT_CHARACTERS) {
            return toolError("Markdown exceeds the safe generation input limit.", {
                code: "INPUT_TOO_LARGE",
                maximum_characters: MAX_MARKDOWN_INPUT_CHARACTERS,
                actual_characters: input.markdown.length,
            });
        }
        if (input.validate === false) {
            return toolError("Generated HWPX must pass structural validation before it can be written.", {
                code: "VALIDATION_REQUIRED",
                output_path: outputPath,
                preview_svg_path: previewPath,
            });
        }
        const dependencies = { ...defaultDependencies, ...dependencyOverrides };
        const generationOptions = input.preset === undefined
            ? undefined
            : { gongmun: { preset: input.preset } };
        const rawGenerated = await dependencies.markdownToHwpx(input.markdown, generationOptions);
        const normalized = await dependencies.normalizeGeneratedFontReferences(rawGenerated);
        const generated = normalized.bytes;
        const checked = await dependencies.validateHwpx(generated);
        const validation = validationDetails(checked);
        if (!checked.ok) {
            return toolError("Generated HWPX failed structural validation; no artifact was written.", {
                code: "HWPX_VALIDATION_FAILED",
                output_path: outputPath,
                validation,
            });
        }
        const fontInspection = await dependencies.inspectHwpxFontReferences(generated);
        if (fontInspection.issues.length > 0) {
            throw new HwpxFontReferenceError("Generated HWPX still has invalid font references after normalization.", fontInspection.issues);
        }
        const preview = previewPath === undefined
            ? undefined
            : await dependencies.renderHwpxToSvg(generated, { reflow: true });
        const files = [
            { path: outputPath, data: new Uint8Array(generated) },
        ];
        if (previewPath !== undefined && preview !== undefined) {
            files.push({ path: previewPath, data: preview.svg });
        }
        await writeFilesExclusively(files);
        const details = {
            output_path: outputPath,
            validation,
            font_normalization: {
                changed: normalized.changed,
                changed_reference_count: normalized.changed_reference_count,
            },
        };
        if (previewPath !== undefined && preview !== undefined) {
            details.preview_svg_path = previewPath;
            details.preview = previewDetails(preview);
        }
        return toolSuccess("Generated HWPX document.", details);
    }
    catch (error) {
        const message = errorMessage(error);
        if (error instanceof HwpxFontReferenceError) {
            return toolError(`Could not normalize HWPX font references: ${message}`, {
                code: error.code,
                error: message,
                issues: error.issues.map((issue) => ({ ...issue })),
                output_path: outputPath ?? safeResolvedPath(input.output_path),
                preview_svg_path: previewPath ?? safeResolvedPath(input.preview_svg_path),
            });
        }
        return toolError(`Could not generate the HWPX document: ${message}`, {
            code: errorCode(error, "HWPX_GENERATION_ERROR"),
            error: message,
            output_path: outputPath ?? safeResolvedPath(input.output_path),
            preview_svg_path: previewPath ?? safeResolvedPath(input.preview_svg_path),
        });
    }
}
export async function handleHwpValidate(input, validateDocument = validateHwpx, inspectFontReferences = inspectHwpxFontReferences) {
    let filePath;
    try {
        filePath = resolveLocalPath(input.file_path, "file_path");
        const bytes = await readFileBounded(filePath, "source document");
        const preciseFormat = await detectPreciseDocumentFormat(exactArrayBuffer(bytes));
        if (preciseFormat === "hwp" || preciseFormat === "hwpx") {
            const protection = await inspectExactDocumentProtection(bytes, preciseFormat);
            if (protection !== undefined) {
                return toolError(`Could not validate the protected document: ${protection.error}`, {
                    code: protection.code,
                    error: protection.error,
                    file_path: filePath,
                    format: preciseFormat,
                });
            }
        }
        const validation = await validateDocument(bytes);
        const fontIssues = preciseFormat === "hwpx" && validation.ok
            ? (await inspectFontReferences(bytes)).issues
            : [];
        const issues = [
            ...validation.issues.map((issue) => ({ ...issue })),
            ...fontIssues.map((issue) => ({ ...issue })),
        ];
        const ok = validation.ok && issues.length === 0;
        return toolSuccess(ok
            ? "HWPX structure is valid."
            : "HWPX structure has validation issues.", {
            file_path: filePath,
            ok,
            issues,
            entry_count: validation.entryCount,
        });
    }
    catch (error) {
        const message = errorMessage(error);
        return toolError(`Could not validate the HWPX document: ${message}`, {
            code: errorCode(error, "HWPX_VALIDATION_ERROR"),
            error: message,
            file_path: filePath ?? safeResolvedPath(input.file_path),
        });
    }
}
export function registerHwpGenerateHwpx(server) {
    server.registerTool(HWP_GENERATE_HWPX_TOOL_NAME, {
        title: "Generate HWPX document",
        description: "Generate a new HWPX document from Markdown, optionally applying a Korean public-document preset and producing an SVG preview.",
        inputSchema: {
            markdown: z
                .string()
                .min(1)
                .max(MAX_MARKDOWN_INPUT_CHARACTERS)
                .describe("Markdown document content."),
            output_path: z
                .string()
                .min(1)
                .describe("New local .hwpx path; existing files are never overwritten."),
            preset: z
                .enum(["official", "report", "plan", "notice", "minutes"])
                .optional()
                .describe("Optional Korean public-document formatting preset."),
            validate: z
                .literal(true)
                .optional()
                .describe("Validation is mandatory; omit this field or pass true."),
            preview_svg_path: z
                .string()
                .min(1)
                .optional()
                .describe("Optional new local SVG preview path."),
        },
        annotations: {
            readOnlyHint: false,
        },
    }, (args) => handleHwpGenerateHwpx(args));
}
export function registerHwpValidate(server) {
    server.registerTool(HWP_VALIDATE_TOOL_NAME, {
        title: "Validate HWPX structure",
        description: "Validate the ZIP and XML structure of the exact requested local HWPX file.",
        inputSchema: {
            file_path: z.string().min(1).describe("Local HWPX path to validate."),
        },
        annotations: {
            readOnlyHint: true,
        },
    }, (args) => handleHwpValidate(args));
}
function validationDetails(validation) {
    return {
        ok: validation.ok,
        issues: validation.issues.map((issue) => ({ ...issue })),
        entry_count: validation.entryCount,
    };
}
function previewDetails(preview) {
    return {
        page_count: preview.pageCount,
        dimensions: {
            width: preview.width,
            height: preview.height,
        },
        warnings: [...preview.warnings],
        stats: { ...preview.stats },
    };
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
function exactArrayBuffer(bytes) {
    const copy = Uint8Array.from(bytes);
    return copy.buffer;
}
