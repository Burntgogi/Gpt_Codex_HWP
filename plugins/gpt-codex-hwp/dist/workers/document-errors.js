export const DOCUMENT_ENGINE_ERROR_CODES = [
    "ENGINE_TIMEOUT",
    "ENGINE_CRASH",
    "ENGINE_INIT_FAILED",
    "ENGINE_OOM",
    "ENGINE_RESOURCE_LIMIT",
    "ENGINE_TERMINATION_FAILED",
    "REQUEST_CANCELLED",
    "ENGINE_PROTOCOL_ERROR",
    "UNSUPPORTED_FORMAT",
    "ENCRYPTED",
    "DRM_PROTECTED",
    "SIGNED_DOCUMENT",
    "INVALID_HWP_FILE_HEADER",
    "INVALID_HWPX_PROTECTION_METADATA",
    "SOURCE_HWPX_INVALID",
    "PATCH_FAILED",
    "FILL_VERIFICATION_FAILED",
    "HWPX_VALIDATION_FAILED",
    "ANCHOR_NOT_FOUND",
    "AMBIGUOUS_ANCHOR",
    "INVALID_IMAGE",
    "UNSAFE_SVG",
];
export const DOCUMENT_ENGINE_ERROR_MESSAGES = {
    ENGINE_TIMEOUT: "The document engine exceeded its time limit.",
    ENGINE_CRASH: "The document engine stopped unexpectedly.",
    ENGINE_INIT_FAILED: "The document engine could not be initialized.",
    ENGINE_OOM: "The document engine exceeded its memory limit.",
    ENGINE_RESOURCE_LIMIT: "The document engine request exceeds the configured resource budget.",
    ENGINE_TERMINATION_FAILED: "The document engine process tree could not be terminated safely.",
    REQUEST_CANCELLED: "The document engine request was cancelled.",
    ENGINE_PROTOCOL_ERROR: "The document engine returned an invalid protocol message.",
    UNSUPPORTED_FORMAT: "The document is not a supported HWP or HWPX file.",
    ENCRYPTED: "The document is encrypted and cannot be processed.",
    DRM_PROTECTED: "The document is DRM or distribution protected and cannot be processed.",
    SIGNED_DOCUMENT: "The document is digitally signed and cannot be processed.",
    INVALID_HWP_FILE_HEADER: "The HWP file header is invalid and cannot be processed.",
    INVALID_HWPX_PROTECTION_METADATA: "The HWPX protection metadata is invalid and cannot be processed.",
    SOURCE_HWPX_INVALID: "The source HWPX failed structural validation and cannot be edited.",
    PATCH_FAILED: "The document engine could not apply the requested patch.",
    FILL_VERIFICATION_FAILED: "The filled HWPX could not be verified as readable.",
    HWPX_VALIDATION_FAILED: "The generated HWPX candidate failed validation.",
    ANCHOR_NOT_FOUND: "The requested image anchor was not found.",
    AMBIGUOUS_ANCHOR: "The image anchor is ambiguous; specify a zero-based occurrence.",
    INVALID_IMAGE: "The image could not be decoded safely.",
    UNSAFE_SVG: "The SVG image contains unsupported or unsafe content.",
};
export const DOCUMENT_ENGINE_STAGES = [
    "startup",
    "detect",
    "parse",
    "render",
    "generateHwpx",
    "patchHwpx",
    "fillHwpx",
    "validateHwpx",
    "insertImage",
    "shutdown",
];
export const DOCUMENT_ENGINE_REMEDIATIONS = [
    "retry",
    "reduce_input",
    "check_installation",
];
const documentProtocolErrors = new WeakSet();
export class DocumentProtocolError extends Error {
    details;
    code = "ENGINE_PROTOCOL_ERROR";
    constructor(message = DOCUMENT_ENGINE_ERROR_MESSAGES.ENGINE_PROTOCOL_ERROR, details) {
        super(message);
        this.details = details;
        this.name = "DocumentProtocolError";
        documentProtocolErrors.add(this);
    }
}
const documentEngineRunErrors = new WeakSet();
export class DocumentEngineRunError extends Error {
    code;
    details;
    constructor(publicError) {
        super(publicError.message);
        this.name = "DocumentEngineRunError";
        this.code = publicError.code;
        if (publicError.details !== undefined)
            this.details = publicError.details;
        documentEngineRunErrors.add(this);
    }
}
export function isDocumentEngineRunError(value) {
    return ((typeof value === "object" || typeof value === "function") &&
        value !== null &&
        documentEngineRunErrors.has(value));
}
export function createDocumentEngineRunError(code, details) {
    return new DocumentEngineRunError({
        code,
        message: DOCUMENT_ENGINE_ERROR_MESSAGES[code],
        ...(details === undefined ? {} : { details }),
    });
}
export function isDocumentProtocolError(value) {
    return ((typeof value === "object" || typeof value === "function") &&
        value !== null &&
        documentProtocolErrors.has(value));
}
export function normalizeDocumentEngineError(error, context = {}) {
    const message = readErrorMessage(error);
    const safeContext = readFailureContext(context);
    const code = classifyDocumentEngineError(message, safeContext);
    const details = safeDocumentEngineErrorDetails(safeContext);
    return {
        code,
        message: DOCUMENT_ENGINE_ERROR_MESSAGES[code],
        ...(details === undefined ? {} : { details }),
    };
}
export function isDocumentEngineErrorCode(value) {
    return (typeof value === "string" &&
        DOCUMENT_ENGINE_ERROR_CODES.includes(value));
}
export function isDocumentEngineStage(value) {
    return (typeof value === "string" &&
        DOCUMENT_ENGINE_STAGES.includes(value));
}
export function isDocumentEngineRemediation(value) {
    return (typeof value === "string" &&
        DOCUMENT_ENGINE_REMEDIATIONS.includes(value));
}
function classifyDocumentEngineError(errorMessage, context) {
    if (hasKnownOutOfMemorySignature(errorMessage))
        return "ENGINE_OOM";
    if (context.terminationReason === "deadline")
        return "ENGINE_TIMEOUT";
    if (context.terminationReason === "abort")
        return "REQUEST_CANCELLED";
    if (context.ready !== true)
        return "ENGINE_INIT_FAILED";
    return "ENGINE_CRASH";
}
function hasKnownOutOfMemorySignature(message) {
    return /(?:heap out of memory|reached heap limit|allocation failed|array buffer allocation failed|\benomem\b)/iu.test(message);
}
function readErrorMessage(error) {
    try {
        if (typeof error === "string")
            return error;
        if ((typeof error !== "object" && typeof error !== "function") || error === null) {
            return "";
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(error, "message");
        return descriptor !== undefined && "value" in descriptor &&
            typeof descriptor.value === "string"
            ? descriptor.value
            : "";
    }
    catch {
        return "";
    }
}
function readFailureContext(value) {
    const context = {};
    try {
        if ((typeof value !== "object" && typeof value !== "function") || value === null) {
            return context;
        }
        const read = (key) => {
            const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
            return descriptor !== undefined && "value" in descriptor
                ? descriptor.value
                : undefined;
        };
        const ready = read("ready");
        if (typeof ready === "boolean")
            context.ready = ready;
        const terminationReason = read("terminationReason");
        if (terminationReason === "deadline" || terminationReason === "abort") {
            context.terminationReason = terminationReason;
        }
        context.stage = read("stage");
        context.elapsedMs = read("elapsedMs");
        context.remediation = read("remediation");
    }
    catch {
        return {};
    }
    return context;
}
function safeDocumentEngineErrorDetails(context) {
    const details = {};
    if (isDocumentEngineStage(context.stage))
        details.stage = context.stage;
    if (typeof context.elapsedMs === "number" &&
        Number.isSafeInteger(context.elapsedMs) &&
        context.elapsedMs >= 0) {
        details.elapsedMs = context.elapsedMs;
    }
    if (isDocumentEngineRemediation(context.remediation)) {
        details.remediation = context.remediation;
    }
    return Object.keys(details).length === 0 ? undefined : details;
}
