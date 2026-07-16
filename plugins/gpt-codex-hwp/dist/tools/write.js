import { z } from "zod";
import { HwpxOutputRequiredError, assertHwpxOutputPath, } from "../shared/document-contract.js";
import { defaultDocumentEngineFacade, } from "../shared/document-engine.js";
import { openDocumentSnapshot } from "../shared/document-snapshot.js";
import { resolveLocalPath } from "../shared/paths.js";
import { toolError, toolSuccess } from "../shared/result.js";
import { runWithToolExecutionContext, toDocumentEngineExecutionContext, } from "../shared/tool-context.js";
import { maxWorkerSnapshotBytesForRequest } from "../workers/document-execution-policy.js";
export const HWP_GENERATE_HWPX_TOOL_NAME = "hwp_generate_hwpx";
export const HWP_VALIDATE_TOOL_NAME = "hwp_validate";
const MAX_MARKDOWN_INPUT_CHARACTERS = 5_000_000;
export async function handleHwpGenerateHwpx(input, facade = defaultDocumentEngineFacade, context) {
    let outputPath;
    let previewPath;
    try {
        outputPath = resolveLocalPath(input.output_path, "output_path");
        assertHwpxOutputPath(outputPath);
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
        const generatedResult = await facade.generate(input.markdown, {
            ...(input.preset === undefined ? {} : { preset: input.preset }),
            ...(previewPath === undefined ? {} : { renderPreview: true }),
        }, toDocumentEngineExecutionContext(context));
        try {
            const checked = generatedResult.validation;
            const validation = validationDetails(checked);
            if (!checked.ok) {
                return toolError("Generated HWPX failed structural validation; no artifact was written.", {
                    code: "HWPX_VALIDATION_FAILED",
                    output_path: outputPath,
                    validation,
                });
            }
            const preview = previewPath === undefined
                ? undefined
                : generatedResult.preview;
            if (previewPath !== undefined && preview === undefined) {
                throw protocolError();
            }
            const presentedPreview = preview === undefined
                ? undefined
                : previewDetails(preview);
            await generatedResult.writeOutputExclusively(outputPath, {
                ...(previewPath === undefined || preview === undefined
                    ? {}
                    : {
                        companionFiles: [{
                                path: previewPath,
                                data: preview.svg,
                            }],
                    }),
            });
            const fontNormalization = readFontNormalization(generatedResult.resultMetadata);
            const details = {
                output_path: outputPath,
                validation,
                font_normalization: {
                    changed: fontNormalization.changed,
                    changed_reference_count: fontNormalization.changedReferenceCount,
                },
            };
            if (previewPath !== undefined && preview !== undefined) {
                details.preview_svg_path = previewPath;
                details.preview = presentedPreview;
            }
            return toolSuccess("Generated HWPX document.", details);
        }
        finally {
            await generatedResult.cleanup();
        }
    }
    catch (error) {
        const message = errorMessage(error);
        if (error instanceof HwpxOutputRequiredError) {
            return toolError("HWPX output is required.", {
                code: error.code,
                error: message,
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
export async function handleHwpValidate(input, facade = defaultDocumentEngineFacade, context) {
    let filePath;
    try {
        filePath = resolveLocalPath(input.file_path, "file_path");
        const snapshot = await openDocumentSnapshot(filePath, {
            workerInputMaxBytes: maxWorkerSnapshotBytesForRequest({
                input: {},
                options: {},
            }),
        });
        if (snapshot.metadata.shallowFormat.candidate === "unknown") {
            try {
                await snapshot.verifySourceUnchanged();
                return toolSuccess("HWPX structure has validation issues.", {
                    file_path: filePath,
                    ok: false,
                    issues: [{
                            code: "UNSUPPORTED_FORMAT",
                            message: "The document is not a valid HWPX package.",
                        }],
                    entry_count: 1,
                });
            }
            finally {
                await snapshot.cleanup();
            }
        }
        const validationResult = await facade.validate(snapshot, {}, toDocumentEngineExecutionContext(context));
        const validation = validationResult.payload;
        const issues = validation.issues.map((issue) => ({ ...issue }));
        const ok = validation.ok;
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
export function registerHwpGenerateHwpx(server, facade = defaultDocumentEngineFacade) {
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
    }, (args, extra) => runWithToolExecutionContext(extra, (context) => handleHwpGenerateHwpx(args, facade, context)));
}
export function registerHwpValidate(server, facade = defaultDocumentEngineFacade) {
    server.registerTool(HWP_VALIDATE_TOOL_NAME, {
        title: "Validate HWPX structure",
        description: "Validate the ZIP and XML structure of the exact requested local HWPX file.",
        inputSchema: {
            file_path: z.string().min(1).describe("Local HWPX path to validate."),
        },
        annotations: {
            readOnlyHint: true,
        },
    }, (args, extra) => runWithToolExecutionContext(extra, (context) => handleHwpValidate(args, facade, context)));
}
function validationDetails(validation) {
    return {
        ok: validation.ok,
        issues: validation.issues.map((issue) => ({ ...issue })),
        entry_count: validation.entryCount,
    };
}
function readFontNormalization(metadata) {
    if (isRecord(metadata) && isRecord(metadata.fontNormalization) &&
        typeof metadata.fontNormalization.changed === "boolean" &&
        Number.isSafeInteger(metadata.fontNormalization.changedReferenceCount) &&
        Number(metadata.fontNormalization.changedReferenceCount) >= 0) {
        return {
            changed: metadata.fontNormalization.changed,
            changedReferenceCount: Number(metadata.fontNormalization.changedReferenceCount),
        };
    }
    return { changed: false, changedReferenceCount: 0 };
}
function previewDetails(preview) {
    const metadata = preview.metadata;
    if (!isRecord(metadata) ||
        !Number.isSafeInteger(metadata.pageCount) || Number(metadata.pageCount) < 1 ||
        typeof metadata.width !== "number" || !Number.isFinite(metadata.width) ||
        metadata.width <= 0 ||
        typeof metadata.height !== "number" || !Number.isFinite(metadata.height) ||
        metadata.height <= 0 ||
        !Array.isArray(metadata.warnings) ||
        !metadata.warnings.every((warning) => typeof warning === "string") ||
        !isRecord(metadata.stats)) {
        throw protocolError();
    }
    return {
        page_count: Number(metadata.pageCount),
        dimensions: {
            width: metadata.width,
            height: metadata.height,
        },
        warnings: [...metadata.warnings],
        stats: { ...metadata.stats },
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
function protocolError() {
    const error = new Error("The isolated engine returned an invalid HWPX result.");
    Object.assign(error, { code: "ENGINE_PROTOCOL_ERROR" });
    return error;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
