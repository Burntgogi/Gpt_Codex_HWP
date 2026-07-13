import { detectFormat, detectOle2Format, detectZipFormat, } from "kordoc";
import { z } from "zod";
import { resolveLocalPath } from "../shared/paths.js";
import { readFileBounded } from "../shared/files.js";
import { toolError, toolSuccess } from "../shared/result.js";
export const HWP_DETECT_FORMAT_TOOL_NAME = "hwp_detect_format";
export async function handleHwpDetectFormat(input) {
    let filePath;
    try {
        filePath = resolveLocalPath(input.file_path, "file_path");
        const bytes = await readFileBounded(filePath, "source document");
        const buffer = toArrayBuffer(bytes);
        const detected = await refineContainerFormat(buffer);
        const details = {
            file_path: filePath,
            file_size_bytes: bytes.byteLength,
        };
        if (detected.containerFormat !== undefined) {
            details.container_format = detected.containerFormat;
        }
        if (detected.warning !== undefined) {
            details.detection_warning = detected.warning;
        }
        return toolSuccess(`Detected ${detected.format} document format.`, {
            format: detected.format,
            details,
        });
    }
    catch (error) {
        const message = errorMessage(error);
        return toolError(`Could not detect the document format: ${message}`, {
            code: errorCode(error, "DETECT_ERROR"),
            error: message,
            file_path: safeResolvedPath(input.file_path),
        });
    }
}
export function registerHwpDetectFormat(server) {
    server.registerTool(HWP_DETECT_FORMAT_TOOL_NAME, {
        title: "Detect HWP document format",
        description: "Detect the exact requested local document format before applying the HWP/HWPX-only read contract.",
        inputSchema: {
            file_path: z.string().min(1).describe("Local document path to inspect."),
        },
        annotations: {
            readOnlyHint: true,
        },
    }, handleHwpDetectFormat);
}
async function refineContainerFormat(buffer) {
    const initialFormat = detectFormat(buffer);
    if (initialFormat === "hwpx") {
        try {
            return {
                format: await detectZipFormat(buffer),
                containerFormat: "zip",
            };
        }
        catch (error) {
            return {
                format: "unknown",
                containerFormat: "zip",
                warning: `Could not inspect the ZIP container: ${errorMessage(error)}`,
            };
        }
    }
    if (initialFormat === "hwp") {
        try {
            return {
                format: detectOle2Format(buffer),
                containerFormat: "ole2",
            };
        }
        catch (error) {
            return {
                format: "unknown",
                containerFormat: "ole2",
                warning: `Could not inspect the OLE2 container: ${errorMessage(error)}`,
            };
        }
    }
    return { format: initialFormat };
}
function toArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
function safeResolvedPath(path) {
    try {
        return typeof path === "string"
            ? resolveLocalPath(path, "file_path")
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
