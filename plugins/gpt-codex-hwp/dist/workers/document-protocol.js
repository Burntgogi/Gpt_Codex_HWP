import { DOCUMENT_ENGINE_ERROR_MESSAGES, DocumentProtocolError, isDocumentEngineErrorCode, isDocumentEngineRemediation, isDocumentEngineStage, isDocumentProtocolError, } from "./document-errors.js";
export const DOCUMENT_PROTOCOL_VERSION = 1;
export const MAX_DOCUMENT_ENGINE_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_DOCUMENT_ENGINE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_ENGINE_RESULT_BYTES = 512 * 1024 * 1024;
export const MAX_WORKER_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_WORKER_RESULT_BYTES = 64 * 1024 * 1024;
export const MAX_WORKER_INLINE_HWPX_RESULT_BYTES = MAX_WORKER_RESULT_BYTES;
export const MAX_CHILD_INLINE_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_CHILD_REQUEST_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS = 5_000_000;
export const MAX_IMAGE_DIMENSION_PX = 10_000;
export const MAX_IMAGE_PIXELS = 40_000_000;
// These are delivery boundaries, not the later main-process inline/MCP boundary.
export const MAX_DOCUMENT_PARSE_MARKDOWN_BYTES = 256 * 1024 * 1024;
export const MAX_DOCUMENT_RENDER_SVG_BYTES = 128 * 1024 * 1024;
export const MAX_INLINE_MARKDOWN_CHARACTERS = 64_000;
export const MAX_SAFE_JSON_DEPTH = 16;
export const MAX_SAFE_JSON_NODES = 10_000;
export const MAX_SAFE_JSON_STRING_CHARACTERS = 1_000_000;
export const MAX_SAFE_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_VALIDATION_ISSUES = 10_000;
const MAX_FILL_VALUES = 10_000;
const MAX_FILL_FIELD_KEY_CHARACTERS = 10_000;
const MAX_FILL_FORMAT_CHARACTERS = 256;
const MAX_PARSE_PAGES_CHARACTERS = 256;
const MAX_HIGHLIGHT_TERMS = 256;
const MAX_HIGHLIGHT_CHARACTERS = 16_384;
const MAX_PARSE_WARNINGS = 1_000;
const MAX_PARSE_IMAGES = 256;
const MAX_PARSE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PARSE_IMAGE_AGGREGATE_BYTES = 128 * 1024 * 1024;
const MAX_VALIDATION_MESSAGE_CHARACTERS = 10_000;
const MAX_VALIDATION_ENTRY_CHARACTERS = 4_096;
const MAX_VALIDATION_ENTRY_COUNT = 1_000_000;
const PARSE_IMAGE_MIME_TYPES = new Set([
    "image/bmp",
    "image/emf",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/tiff",
    "image/webp",
    "image/wmf",
]);
export const DOCUMENT_ENGINE_OPERATIONS = [
    "detect",
    "parse",
    "render",
    "generateHwpx",
    "patchHwpx",
    "fillHwpx",
    "validateHwpx",
    "insertImage",
];
export function validateLogicalDocumentRequest(value) {
    return protocolBoundary(() => {
        parseRequest(value, "logical");
        return value;
    });
}
export function validateWireDocumentRequest(value, boundary) {
    return protocolBoundary(() => {
        requireTransportBoundary(boundary);
        parseRequest(value, "wire", boundary);
        return value;
    });
}
export function createWireDocumentRequest(logicalValue, transportValue, boundary) {
    return protocolBoundary(() => {
        requireTransportBoundary(boundary);
        const logical = parseRequest(logicalValue, "logical");
        const transportKeys = requiredTransportKeys(logical.operation);
        const transports = exactRecord(transportValue, transportKeys);
        const input = createWireInput(logical, transports);
        const wire = {
            protocolVersion: DOCUMENT_PROTOCOL_VERSION,
            requestId: logical.requestId,
            operation: logical.operation,
            input,
            options: { ...logical.options },
        };
        parseRequest(wire, "wire", boundary);
        return wire;
    });
}
export function documentLogicalRequestBytes(value) {
    return protocolBoundary(() => {
        const content = exactRecord(value, ["input", "options"], ["protocolVersion", "requestId", "operation"]);
        return serializedLogicalRequestBytes(content.input, content.options);
    });
}
export function documentWorkerRequestBytes(value, documentBytes = 0, imageBytes = 0) {
    return protocolBoundary(() => checkedSafeByteSum(documentLogicalRequestBytes(value), documentBytes, imageBytes));
}
export function createDocumentEventValidator(expectedRequestId, expectedOperation, maximumCopiedBytes = MAX_DOCUMENT_ENGINE_INPUT_BYTES) {
    const validator = createEventValidator(expectedRequestId, expectedOperation, false, maximumCopiedBytes);
    return {
        accept(value) {
            return validator.accept(value);
        },
    };
}
export function createChildDocumentEventValidator(expectedRequestId, expectedOperation, maximumCopiedBytes = MAX_DOCUMENT_ENGINE_INPUT_BYTES) {
    return createEventValidator(expectedRequestId, expectedOperation, true, maximumCopiedBytes);
}
function createEventValidator(expectedRequestId, expectedOperation, childMode, maximumCopiedBytes) {
    return protocolBoundary(() => {
        requireRequestId(expectedRequestId);
        requireOperation(expectedOperation);
        requireIntegerInRange(maximumCopiedBytes, 0, MAX_DOCUMENT_ENGINE_INPUT_BYTES);
        let readyAccepted = false;
        let terminalAccepted = false;
        let progressTotal;
        let progressCompleted = -1;
        let copiedBytes = 0;
        return {
            accept(value) {
                return protocolBoundary(() => {
                    if (terminalAccepted) {
                        throw new DocumentProtocolError("A terminal document engine event was already accepted.");
                    }
                    const event = parseEvent(value, expectedRequestId, expectedOperation, childMode);
                    switch (event.type) {
                        case "failure":
                            terminalAccepted = true;
                            return event;
                        case "ready":
                            if (readyAccepted)
                                protocolFailure();
                            readyAccepted = true;
                            return event;
                        case "progress":
                            if (!readyAccepted)
                                protocolFailure();
                            if ((progressTotal !== undefined && event.total !== progressTotal) ||
                                event.completed < progressCompleted) {
                                protocolFailure();
                            }
                            progressTotal = event.total;
                            progressCompleted = event.completed;
                            return event;
                        case "metrics":
                            if (!readyAccepted ||
                                event.copiedBytes < copiedBytes ||
                                event.copiedBytes > maximumCopiedBytes) {
                                protocolFailure();
                            }
                            copiedBytes = event.copiedBytes;
                            return event;
                        case "result":
                            if (!readyAccepted)
                                protocolFailure();
                            terminalAccepted = true;
                            return event;
                        case "spoolResult":
                            if (!readyAccepted || !childMode)
                                protocolFailure();
                            terminalAccepted = true;
                            return event;
                    }
                });
            },
        };
    });
}
export function createInlineDocumentResultEvent(requestId, operation, payload) {
    return protocolBoundary(() => {
        requireRequestId(requestId);
        requireOperation(operation);
        const outputByteLength = measureResultInternal(operation, payload);
        if (outputByteLength > MAX_CHILD_INLINE_RESULT_BYTES)
            protocolFailure();
        const event = {
            protocolVersion: DOCUMENT_PROTOCOL_VERSION,
            requestId,
            type: "result",
            payload,
            outputByteLength,
        };
        parseEvent(event, requestId, operation, true);
        return event;
    });
}
export function measureDocumentResultByteLength(operation, payload) {
    return protocolBoundary(() => {
        requireOperation(operation);
        const total = measureResultInternal(operation, payload);
        if (total > MAX_DOCUMENT_ENGINE_RESULT_BYTES)
            protocolFailure();
        return total;
    });
}
function parseRequest(value, mode, boundary) {
    const root = exactRecord(value, [
        "protocolVersion",
        "requestId",
        "operation",
        "input",
        "options",
    ]);
    if (root.protocolVersion !== DOCUMENT_PROTOCOL_VERSION)
        protocolFailure();
    requireRequestId(root.requestId);
    requireOperation(root.operation);
    const input = readRecord(root.input);
    const options = readRecord(root.options);
    validateRequestPayload(root.operation, input, options, mode, boundary);
    const parsed = {
        raw: value,
        requestId: root.requestId,
        operation: root.operation,
        input,
        options,
    };
    if (mode === "wire") {
        if (boundary === undefined)
            protocolFailure();
        enforceWireRequestBoundary(parsed, boundary);
    }
    return parsed;
}
function validateRequestPayload(operation, input, options, mode, boundary) {
    const needsDocument = operation !== "generateHwpx";
    const documentKey = mode === "wire" && needsDocument ? ["document"] : [];
    switch (operation) {
        case "detect":
            requireKeys(input, documentKey);
            requireKeys(options, []);
            break;
        case "parse":
            requireKeys(input, documentKey);
            validateParseOptions(options);
            break;
        case "render":
            requireKeys(input, documentKey);
            validateRenderOptions(options);
            break;
        case "generateHwpx":
            requireKeys(input, ["markdown"]);
            requireBoundedString(input.markdown, MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS);
            validateGenerateOptions(options);
            break;
        case "patchHwpx":
            requireKeys(input, [...documentKey, "markdown"]);
            requireBoundedString(input.markdown, MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS);
            requireKeys(options, []);
            break;
        case "fillHwpx":
            requireKeys(input, [...documentKey, "fields"]);
            validateFillOptions(options, validateFillFields(input.fields));
            break;
        case "validateHwpx":
            requireKeys(input, documentKey);
            validateValidateOptions(options);
            break;
        case "insertImage":
            requireKeys(input, mode === "wire" ? ["document", "image", "anchorText"] : ["anchorText"]);
            requireTrimmedString(input.anchorText, 10_000);
            validateInsertImageOptions(options);
            break;
    }
    if (mode === "wire" && needsDocument) {
        if (boundary === undefined)
            protocolFailure();
        validateTransport(input.document, "document", boundary);
    }
    if (mode === "wire" && operation === "insertImage") {
        if (boundary === undefined)
            protocolFailure();
        validateTransport(input.image, "image", boundary);
    }
}
function requiredTransportKeys(operation) {
    if (operation === "generateHwpx")
        return [];
    return operation === "insertImage" ? ["document", "image"] : ["document"];
}
function createWireInput(logical, transports) {
    switch (logical.operation) {
        case "detect":
        case "parse":
        case "render":
        case "validateHwpx":
            return { document: transports.document };
        case "generateHwpx":
            return { markdown: logical.input.markdown };
        case "patchHwpx":
            return { document: transports.document, markdown: logical.input.markdown };
        case "fillHwpx":
            return { document: transports.document, fields: logical.input.fields };
        case "insertImage":
            return {
                document: transports.document,
                image: transports.image,
                anchorText: logical.input.anchorText,
            };
    }
}
function enforceWireRequestBoundary(request, boundary) {
    if (boundary !== "worker")
        return;
    const logicalBytes = serializedLogicalRequestBytes(logicalInputForRequest(request), request.options);
    const transportBytes = [];
    if (request.operation !== "generateHwpx") {
        transportBytes.push(bufferTransportByteLength(request.input.document));
    }
    if (request.operation === "insertImage") {
        transportBytes.push(bufferTransportByteLength(request.input.image));
    }
    if (checkedSafeByteSum(logicalBytes, ...transportBytes) > MAX_WORKER_INPUT_BYTES) {
        protocolFailure();
    }
}
function logicalInputForRequest(request) {
    switch (request.operation) {
        case "detect":
        case "parse":
        case "render":
        case "validateHwpx":
            return {};
        case "generateHwpx":
        case "patchHwpx":
            return { markdown: request.input.markdown };
        case "fillHwpx":
            return { fields: request.input.fields };
        case "insertImage":
            return { anchorText: request.input.anchorText };
    }
}
function serializedLogicalRequestBytes(input, options) {
    const serialized = JSON.stringify({ input, options });
    if (typeof serialized !== "string")
        protocolFailure();
    return utf8Bytes(serialized);
}
function bufferTransportByteLength(value) {
    const transport = exactRecord(value, ["transport", "buffer"]);
    if (transport.transport !== "buffer")
        protocolFailure();
    return exactArrayBufferByteLength(transport.buffer);
}
function checkedSafeByteSum(...values) {
    let total = 0;
    for (const value of values) {
        requireIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER);
        if (value > Number.MAX_SAFE_INTEGER - total)
            protocolFailure();
        total += value;
    }
    return total;
}
function validateTransport(value, kind, boundary) {
    const transport = readRecord(value);
    if (transport.transport === "buffer") {
        if (boundary !== "worker")
            protocolFailure();
        requireKeys(transport, ["transport", "buffer"]);
        const byteLength = exactArrayBufferByteLength(transport.buffer);
        const minimum = kind === "image" ? 1 : 0;
        const maximum = kind === "image"
            ? MAX_DOCUMENT_ENGINE_IMAGE_BYTES
            : MAX_WORKER_INPUT_BYTES;
        requireIntegerInRange(byteLength, minimum, maximum);
        return;
    }
    if (transport.transport === "spool") {
        if (boundary !== "child")
            protocolFailure();
        requireKeys(transport, ["transport", "descriptor", "sizeBytes"]);
        const expectedDescriptor = kind === "image" ? 4 : 3;
        if (transport.descriptor !== expectedDescriptor)
            protocolFailure();
        requireIntegerInRange(transport.sizeBytes, kind === "image" ? 1 : 0, kind === "image"
            ? MAX_DOCUMENT_ENGINE_IMAGE_BYTES
            : MAX_DOCUMENT_ENGINE_INPUT_BYTES);
        return;
    }
    protocolFailure();
}
function parseEvent(value, expectedRequestId, expectedOperation, childMode = false) {
    const event = readRecord(value);
    if (event.protocolVersion !== DOCUMENT_PROTOCOL_VERSION)
        protocolFailure();
    if (event.requestId !== expectedRequestId)
        protocolFailure();
    switch (event.type) {
        case "ready":
            requireKeys(event, ["protocolVersion", "requestId", "type"]);
            return value;
        case "progress":
            requireKeys(event, [
                "protocolVersion",
                "requestId",
                "type",
                "completed",
                "total",
            ]);
            requireIntegerInRange(event.total, 1, Number.MAX_SAFE_INTEGER);
            requireIntegerInRange(event.completed, 0, event.total);
            return value;
        case "metrics":
            requireKeys(event, [
                "protocolVersion",
                "requestId",
                "type",
                "copiedBytes",
            ]);
            requireIntegerInRange(event.copiedBytes, 0, MAX_DOCUMENT_ENGINE_INPUT_BYTES);
            return value;
        case "result": {
            requireKeys(event, [
                "protocolVersion",
                "requestId",
                "type",
                "payload",
                "outputByteLength",
            ]);
            requireIntegerInRange(event.outputByteLength, 0, childMode
                ? MAX_CHILD_INLINE_RESULT_BYTES
                : maximumWorkerInlineResultBytes(expectedOperation));
            const measured = measureResultInternal(expectedOperation, event.payload);
            if (measured !== event.outputByteLength)
                protocolFailure();
            return value;
        }
        case "spoolResult": {
            if (!childMode)
                protocolFailure();
            requireKeys(event, [
                "protocolVersion",
                "requestId",
                "type",
                "receipt",
            ]);
            validateSpoolResultReceipt(event.receipt, expectedOperation);
            return value;
        }
        case "failure":
            requireKeys(event, ["protocolVersion", "requestId", "type", "error"]);
            validateFailure(event.error);
            return value;
        default:
            return protocolFailure();
    }
}
function validateSpoolResultReceipt(value, expectedOperation) {
    if (expectedOperation === "detect" || expectedOperation === "validateHwpx") {
        protocolFailure();
    }
    const isHwpxResult = isHwpxResultOperation(expectedOperation);
    const receipt = exactRecord(value, [
        "descriptor",
        "operation",
        "encoding",
        "sizeBytes",
        "sha256",
        ...(isHwpxResult ? ["metadata"] : []),
    ]);
    if (receipt.descriptor !== 5 || receipt.operation !== expectedOperation) {
        protocolFailure();
    }
    if (receipt.encoding !== resultSpoolEncoding(expectedOperation)) {
        protocolFailure();
    }
    requireIntegerInRange(receipt.sizeBytes, 1, MAX_DOCUMENT_ENGINE_RESULT_BYTES);
    if (typeof receipt.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(receipt.sha256)) {
        protocolFailure();
    }
    if (isHwpxResult) {
        validateHwpxResultMetadata(expectedOperation, receipt.metadata);
    }
}
export function resultSpoolEncoding(operation) {
    switch (operation) {
        case "parse":
            return "document-result-v1";
        case "render":
            return "render-result-v1";
        case "generateHwpx":
        case "patchHwpx":
        case "fillHwpx":
        case "insertImage":
            return "hwpx-result-v1";
    }
}
export function validateDocumentResultSpoolMetadata(operation, metadata) {
    return protocolBoundary(() => {
        validateHwpxResultMetadata(operation, metadata);
        return metadata;
    });
}
function isHwpxResultOperation(operation) {
    return operation === "generateHwpx" || operation === "patchHwpx" ||
        operation === "fillHwpx" || operation === "insertImage";
}
export function maximumWorkerInlineResultBytes(operation) {
    requireOperation(operation);
    return MAX_WORKER_RESULT_BYTES;
}
function validateHwpxResultMetadata(operation, value) {
    if (!isHwpxResultOperation(operation))
        protocolFailure();
    const metadata = readRecord(value);
    if (metadata.operation !== operation)
        protocolFailure();
    switch (operation) {
        case "generateHwpx": {
            requireKeys(metadata, ["operation", "fontNormalization"]);
            const normalization = exactRecord(metadata.fontNormalization, ["changed", "changedReferenceCount"]);
            if (typeof normalization.changed !== "boolean")
                protocolFailure();
            requireIntegerInRange(normalization.changedReferenceCount, 0, Number.MAX_SAFE_INTEGER);
            break;
        }
        case "patchHwpx": {
            requireKeys(metadata, ["operation", "applied", "skipped", "verification"]);
            requireIntegerInRange(metadata.applied, 0, Number.MAX_SAFE_INTEGER);
            const skipped = readArray(metadata.skipped);
            if (skipped.length > MAX_FILL_VALUES)
                protocolFailure();
            for (const value of skipped) {
                const item = exactRecord(value, ["reason"], ["before", "after", "partial"]);
                requireSafeText(item.reason, 10_000);
                for (const key of ["before", "after"]) {
                    if (Object.hasOwn(item, key))
                        requireSafeText(item[key], 10_000);
                }
                if (Object.hasOwn(item, "partial") && typeof item.partial !== "boolean") {
                    protocolFailure();
                }
            }
            if (metadata.verification !== null) {
                const verification = exactRecord(metadata.verification, ["stats", "diffs"]);
                validateDiffStats(verification.stats);
                if (!Array.isArray(verification.diffs))
                    protocolFailure();
            }
            break;
        }
        case "fillHwpx": {
            requireKeys(metadata, ["operation", "filled", "unmatched", "rejected"]);
            const filled = readArray(metadata.filled);
            if (filled.length > MAX_FILL_VALUES)
                protocolFailure();
            for (const value of filled) {
                const field = exactRecord(value, ["label", "value", "row", "col"], ["key"]);
                requireSafeText(field.label, MAX_FILL_FIELD_KEY_CHARACTERS);
                requireBoundedString(field.value, MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS);
                requireIntegerInRange(field.row, 0, Number.MAX_SAFE_INTEGER);
                requireIntegerInRange(field.col, 0, Number.MAX_SAFE_INTEGER);
                if (Object.hasOwn(field, "key")) {
                    requireSafeText(field.key, MAX_FILL_FIELD_KEY_CHARACTERS);
                }
            }
            validateBoundedStringList(metadata.unmatched, MAX_FILL_VALUES);
            validateBoundedStringList(metadata.rejected, MAX_FILL_VALUES);
            break;
        }
        case "insertImage":
            validateImageResultMetadata(metadata);
            break;
    }
    safeJsonBytes(value);
}
function validateDiffStats(value) {
    const stats = exactRecord(value, ["added", "removed", "modified", "unchanged"]);
    for (const key of ["added", "removed", "modified", "unchanged"]) {
        requireIntegerInRange(stats[key], 0, Number.MAX_SAFE_INTEGER);
    }
}
function validateBoundedStringList(value, maximum) {
    const list = readArray(value);
    if (list.length > maximum)
        protocolFailure();
    for (const item of list)
        requireSafeText(item, MAX_FILL_FIELD_KEY_CHARACTERS);
}
function validateImageResultMetadata(metadata) {
    if (metadata.mode === "seal-anchor") {
        requireKeys(metadata, ["operation", "mode", "placed"]);
        const placed = readArray(metadata.placed);
        if (placed.length === 0 || placed.length > MAX_FILL_VALUES)
            protocolFailure();
        for (const value of placed) {
            const placement = exactRecord(value, [
                "anchor",
                "occurrence",
                "sectionIndex",
                "mode",
                "posXMm",
                "posYMm",
                "sizeMm",
                "entry",
                "warnings",
            ]);
            requireSafeText(placement.anchor, 10_000);
            requireIntegerInRange(placement.occurrence, 0, Number.MAX_SAFE_INTEGER);
            requireIntegerInRange(placement.sectionIndex, 0, Number.MAX_SAFE_INTEGER);
            if (placement.mode !== "overlap" && placement.mode !== "right") {
                protocolFailure();
            }
            for (const key of ["posXMm", "posYMm", "sizeMm"]) {
                requireNumberInRange(placement[key], -1_000_000, 1_000_000);
            }
            requireSafeText(placement.entry, MAX_VALIDATION_ENTRY_CHARACTERS);
            if (isAbsoluteOrTraversingPath(placement.entry))
                protocolFailure();
            validateBoundedStringList(placement.warnings, MAX_PARSE_WARNINGS);
        }
        return;
    }
    if (metadata.mode !== "after-paragraph")
        protocolFailure();
    requireKeys(metadata, ["operation", "mode", "placement"]);
    const placement = exactRecord(metadata.placement, [
        "imageEntry",
        "itemId",
        "sectionIndex",
        "removedLinesegarray",
        "displayWidthHu",
        "displayHeightHu",
        "warnings",
    ]);
    requireSafeText(placement.imageEntry, MAX_VALIDATION_ENTRY_CHARACTERS);
    if (isAbsoluteOrTraversingPath(placement.imageEntry))
        protocolFailure();
    requireSafeText(placement.itemId, MAX_VALIDATION_ENTRY_CHARACTERS);
    requireIntegerInRange(placement.sectionIndex, 0, Number.MAX_SAFE_INTEGER);
    requireIntegerInRange(placement.removedLinesegarray, 0, Number.MAX_SAFE_INTEGER);
    requireIntegerInRange(placement.displayWidthHu, 1, Number.MAX_SAFE_INTEGER);
    requireIntegerInRange(placement.displayHeightHu, 1, Number.MAX_SAFE_INTEGER);
    validateBoundedStringList(placement.warnings, MAX_PARSE_WARNINGS);
}
function measureResultInternal(operation, value) {
    const payload = readRecord(value);
    switch (operation) {
        case "detect":
            requireKeys(payload, ["format"]);
            if (payload.format !== "hwp" &&
                payload.format !== "hwpx" &&
                payload.format !== "unknown") {
                protocolFailure();
            }
            return utf8Bytes(payload.format);
        case "parse": {
            return measureParseResult(payload);
        }
        case "render": {
            requireKeys(payload, ["svg"], ["metadata"]);
            if (typeof payload.svg !== "string")
                protocolFailure();
            const primary = utf8Bytes(payload.svg);
            if (primary > MAX_DOCUMENT_RENDER_SVG_BYTES)
                protocolFailure();
            return checkedResultTotal(primary, metadataBytes(payload));
        }
        case "generateHwpx":
        case "patchHwpx":
        case "fillHwpx":
        case "insertImage": {
            requireKeys(payload, ["bytes"], ["metadata"]);
            const primary = exactArrayBufferByteLength(payload.bytes);
            if (primary > MAX_DOCUMENT_ENGINE_RESULT_BYTES)
                protocolFailure();
            return checkedResultTotal(primary, metadataBytes(payload));
        }
        case "validateHwpx":
            validateValidationResult(payload);
            return safeJsonBytes(value);
    }
}
function measureParseResult(payload) {
    requireKeys(payload, [
        "markdown",
        "fileType",
        "warnings",
        "images",
    ], ["metadata", "pageCount", "isImageBased"]);
    if (typeof payload.markdown !== "string")
        protocolFailure();
    const markdownBytes = utf8Bytes(payload.markdown);
    if (markdownBytes > MAX_DOCUMENT_PARSE_MARKDOWN_BYTES)
        protocolFailure();
    if (payload.fileType !== "hwp" && payload.fileType !== "hwpx") {
        protocolFailure();
    }
    if (Object.hasOwn(payload, "pageCount")) {
        requireIntegerInRange(payload.pageCount, 1, Number.MAX_SAFE_INTEGER);
    }
    if (Object.hasOwn(payload, "isImageBased") &&
        typeof payload.isImageBased !== "boolean") {
        protocolFailure();
    }
    const warnings = readArray(payload.warnings);
    if (warnings.length > MAX_PARSE_WARNINGS)
        protocolFailure();
    for (const warningValue of warnings) {
        const warning = exactRecord(warningValue, ["code", "message"], ["page"]);
        if (Object.hasOwn(warning, "page")) {
            requireIntegerInRange(warning.page, 1, Number.MAX_SAFE_INTEGER);
        }
        requireSafeCode(warning.code, 128);
        requireSafeText(warning.message, 10_000);
    }
    const images = readArray(payload.images);
    if (images.length > MAX_PARSE_IMAGES)
        protocolFailure();
    let imageBytes = 0;
    let aggregateImageContentBytes = 0;
    for (const imageValue of images) {
        const image = exactRecord(imageValue, ["filename", "mimeType", "bytes"]);
        requireSafeImageFilename(image.filename);
        if (typeof image.mimeType !== "string" ||
            !PARSE_IMAGE_MIME_TYPES.has(image.mimeType)) {
            protocolFailure();
        }
        const bytes = exactArrayBufferByteLength(image.bytes);
        requireIntegerInRange(bytes, 1, MAX_PARSE_IMAGE_BYTES);
        aggregateImageContentBytes += bytes;
        if (aggregateImageContentBytes > MAX_PARSE_IMAGE_AGGREGATE_BYTES) {
            protocolFailure();
        }
        imageBytes = checkedResultTotal(imageBytes, checkedResultTotal(bytes, utf8Bytes(image.filename) + utf8Bytes(image.mimeType)));
    }
    let total = checkedResultTotal(markdownBytes, utf8Bytes(payload.fileType));
    if (Object.hasOwn(payload, "pageCount")) {
        total = checkedResultTotal(total, utf8Bytes(String(payload.pageCount)));
    }
    if (Object.hasOwn(payload, "isImageBased")) {
        total = checkedResultTotal(total, payload.isImageBased ? 4 : 5);
    }
    total = checkedResultTotal(total, safeJsonBytes(payload.warnings));
    total = checkedResultTotal(total, imageBytes);
    return checkedResultTotal(total, parseMetadataBytes(payload));
}
function parseMetadataBytes(payload) {
    if (!Object.hasOwn(payload, "metadata"))
        return 0;
    const metadata = exactRecord(payload.metadata, [], [
        "title",
        "author",
        "creator",
        "createdAt",
        "modifiedAt",
        "pageCount",
        "version",
        "description",
        "keywords",
    ]);
    for (const key of [
        "title",
        "author",
        "creator",
        "createdAt",
        "modifiedAt",
        "version",
        "description",
    ]) {
        if (Object.hasOwn(metadata, key)) {
            requireMetadataString(metadata[key]);
        }
    }
    if (Object.hasOwn(metadata, "pageCount")) {
        requireIntegerInRange(metadata.pageCount, 1, Number.MAX_SAFE_INTEGER);
    }
    if (Object.hasOwn(metadata, "keywords")) {
        const keywords = readArray(metadata.keywords);
        if (keywords.length > 256)
            protocolFailure();
        for (const keyword of keywords)
            requireMetadataString(keyword);
    }
    return safeJsonBytes(payload.metadata);
}
function metadataBytes(payload) {
    return Object.hasOwn(payload, "metadata")
        ? safeJsonBytes(payload.metadata)
        : 0;
}
function checkedResultTotal(primary, metadata) {
    if (primary > MAX_DOCUMENT_ENGINE_RESULT_BYTES - metadata)
        protocolFailure();
    return primary + metadata;
}
function validateValidationResult(payload) {
    requireKeys(payload, ["ok", "issues", "entryCount"]);
    if (typeof payload.ok !== "boolean")
        protocolFailure();
    requireIntegerInRange(payload.entryCount, 0, MAX_VALIDATION_ENTRY_COUNT);
    const issues = readArray(payload.issues);
    if (issues.length > MAX_DOCUMENT_VALIDATION_ISSUES)
        protocolFailure();
    if (payload.entryCount < issues.length)
        protocolFailure();
    for (const issueValue of issues) {
        const issue = exactRecord(issueValue, ["message"], ["code", "entry"]);
        if (Object.hasOwn(issue, "code"))
            requireSafeCode(issue.code, 128);
        requireTrimmedString(issue.message, MAX_VALIDATION_MESSAGE_CHARACTERS);
        if (Object.hasOwn(issue, "entry")) {
            requireTrimmedString(issue.entry, MAX_VALIDATION_ENTRY_CHARACTERS);
            if (isAbsoluteOrTraversingPath(issue.entry))
                protocolFailure();
        }
    }
}
function validateFailure(value) {
    const error = exactRecord(value, ["code", "message"], ["details"]);
    if (!isDocumentEngineErrorCode(error.code))
        protocolFailure();
    if (error.message !== DOCUMENT_ENGINE_ERROR_MESSAGES[error.code]) {
        protocolFailure();
    }
    if (Object.hasOwn(error, "details")) {
        const details = exactRecord(error.details, [], ["stage", "elapsedMs", "remediation"]);
        if (Object.hasOwn(details, "stage") && !isDocumentEngineStage(details.stage)) {
            protocolFailure();
        }
        if (Object.hasOwn(details, "elapsedMs")) {
            requireIntegerInRange(details.elapsedMs, 0, Number.MAX_SAFE_INTEGER);
        }
        if (Object.hasOwn(details, "remediation") &&
            !isDocumentEngineRemediation(details.remediation)) {
            protocolFailure();
        }
    }
}
function validateParseOptions(options) {
    requireKeys(options, [], ["pages"]);
    if (!Object.hasOwn(options, "pages"))
        return;
    if (typeof options.pages !== "string" ||
        options.pages.length > MAX_PARSE_PAGES_CHARACTERS ||
        !/^\s*\d+\s*(?:-\s*\d+\s*)?(?:,\s*\d+\s*(?:-\s*\d+\s*)?)*$/u.test(options.pages)) {
        protocolFailure();
    }
    for (const token of options.pages.match(/\d+/gu) ?? []) {
        requireIntegerInRange(Number(token), 1, Number.MAX_SAFE_INTEGER);
    }
}
function validateRenderOptions(options) {
    requireKeys(options, [], ["reflow", "highlights"]);
    if (Object.hasOwn(options, "reflow") && typeof options.reflow !== "boolean") {
        protocolFailure();
    }
    if (Object.hasOwn(options, "highlights")) {
        const highlights = readArray(options.highlights);
        if (highlights.length > MAX_HIGHLIGHT_TERMS)
            protocolFailure();
        let total = 0;
        for (const highlight of highlights) {
            if (typeof highlight !== "string" ||
                highlight.length === 0 ||
                highlight.length > 256) {
                protocolFailure();
            }
            total += highlight.length;
            if (total > MAX_HIGHLIGHT_CHARACTERS)
                protocolFailure();
        }
    }
}
function validateGenerateOptions(options) {
    requireKeys(options, [], ["preset"]);
    if (Object.hasOwn(options, "preset") &&
        options.preset !== "official" &&
        options.preset !== "report" &&
        options.preset !== "plan" &&
        options.preset !== "notice" &&
        options.preset !== "minutes") {
        protocolFailure();
    }
}
function validateFillOptions(options, fields) {
    requireKeys(options, [], ["formats", "requireUnique"]);
    if (Object.hasOwn(options, "requireUnique") &&
        typeof options.requireUnique !== "boolean") {
        protocolFailure();
    }
    if (Object.hasOwn(options, "formats")) {
        const formats = readRecord(options.formats);
        const keys = Object.keys(formats);
        if (keys.length > MAX_FILL_VALUES)
            protocolFailure();
        for (const key of keys) {
            if (key.length > MAX_FILL_FIELD_KEY_CHARACTERS ||
                !Object.hasOwn(fields, key)) {
                protocolFailure();
            }
            requireBoundedString(formats[key], MAX_FILL_FORMAT_CHARACTERS);
        }
    }
}
function validateValidateOptions(options) {
    requireKeys(options, [], ["maxIssues"]);
    if (Object.hasOwn(options, "maxIssues")) {
        requireIntegerInRange(options.maxIssues, 1, 10_000);
    }
}
function validateInsertImageOptions(options) {
    requireKeys(options, [], [
        "mode",
        "sizeMm",
        "anchorOccurrence",
        "widthPx",
        "heightPx",
    ]);
    if (Object.hasOwn(options, "mode") &&
        options.mode !== "after-paragraph" &&
        options.mode !== "seal-anchor") {
        protocolFailure();
    }
    if (Object.hasOwn(options, "sizeMm")) {
        requireNumberInRange(options.sizeMm, 1, 200);
    }
    if (Object.hasOwn(options, "anchorOccurrence")) {
        requireIntegerInRange(options.anchorOccurrence, 0, Number.MAX_SAFE_INTEGER);
    }
    if (Object.hasOwn(options, "widthPx")) {
        requireIntegerInRange(options.widthPx, 1, MAX_IMAGE_DIMENSION_PX);
    }
    if (Object.hasOwn(options, "heightPx")) {
        requireIntegerInRange(options.heightPx, 1, MAX_IMAGE_DIMENSION_PX);
    }
    if (typeof options.widthPx === "number" &&
        typeof options.heightPx === "number" &&
        options.widthPx * options.heightPx > MAX_IMAGE_PIXELS) {
        protocolFailure();
    }
}
function validateFillFields(value) {
    const fields = readRecord(value);
    let valueCount = 0;
    let characterCount = 0;
    for (const key of Object.keys(fields)) {
        if (key.length > MAX_FILL_FIELD_KEY_CHARACTERS)
            protocolFailure();
        const fieldValue = fields[key];
        const values = Array.isArray(fieldValue) ? readStringArray(fieldValue) : [fieldValue];
        if (values.length === 0)
            protocolFailure();
        valueCount += values.length;
        if (valueCount > MAX_FILL_VALUES)
            protocolFailure();
        for (const item of values) {
            if (typeof item !== "string")
                protocolFailure();
            characterCount += item.length;
            if (characterCount > MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS) {
                protocolFailure();
            }
        }
    }
    return fields;
}
function safeJsonBytes(value) {
    const state = { nodes: 0, stringCharacters: 0, stack: new WeakSet() };
    const serialized = canonicalSafeJson(value, 0, state);
    const bytes = utf8Bytes(serialized);
    if (bytes > MAX_SAFE_JSON_BYTES)
        protocolFailure();
    return bytes;
}
function canonicalSafeJson(value, depth, state) {
    state.nodes += 1;
    if (state.nodes > MAX_SAFE_JSON_NODES || depth > MAX_SAFE_JSON_DEPTH) {
        protocolFailure();
    }
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            protocolFailure();
        return JSON.stringify(value);
    }
    if (typeof value === "string") {
        countSafeJsonString(value, state);
        return JSON.stringify(value);
    }
    if (typeof value !== "object" || value === null)
        protocolFailure();
    if (state.stack.has(value))
        protocolFailure();
    state.stack.add(value);
    try {
        if (Reflect.getPrototypeOf(value) === Array.prototype) {
            const values = readArray(value);
            return `[${values
                .map((item) => canonicalSafeJson(item, depth + 1, state))
                .join(",")}]`;
        }
        const record = readRecord(value);
        const keys = Object.keys(record).sort();
        const parts = [];
        for (const key of keys) {
            if (isForbiddenChannelKey(key))
                protocolFailure();
            countSafeJsonString(key, state);
            parts.push(`${JSON.stringify(key)}:${canonicalSafeJson(record[key], depth + 1, state)}`);
        }
        return `{${parts.join(",")}}`;
    }
    finally {
        state.stack.delete(value);
    }
}
function countSafeJsonString(value, state) {
    state.stringCharacters += value.length;
    if (state.stringCharacters > MAX_SAFE_JSON_STRING_CHARACTERS) {
        protocolFailure();
    }
}
function readRecord(value) {
    if (typeof value !== "object" || value === null)
        protocolFailure();
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        protocolFailure();
    const snapshot = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string")
            protocolFailure();
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)) {
            protocolFailure();
        }
        snapshot[key] = descriptor.value;
    }
    return snapshot;
}
function exactRecord(value, required, optional = []) {
    const record = readRecord(value);
    requireKeys(record, required, optional);
    return record;
}
function requireKeys(record, required, optional = []) {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(record);
    if (keys.some((key) => !allowed.has(key)) ||
        required.some((key) => !Object.hasOwn(record, key))) {
        protocolFailure();
    }
}
function readArray(value) {
    if (typeof value !== "object" || value === null)
        protocolFailure();
    if (Reflect.getPrototypeOf(value) !== Array.prototype)
        protocolFailure();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string"))
        protocolFailure();
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0) {
        protocolFailure();
    }
    const length = lengthDescriptor.value;
    const result = [];
    for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)) {
            protocolFailure();
        }
        result.push(descriptor.value);
    }
    if (keys.length !== length + 1)
        protocolFailure();
    return result;
}
function readStringArray(value) {
    return readArray(value);
}
function exactArrayBufferByteLength(value) {
    if (typeof value !== "object" || value === null)
        protocolFailure();
    if (Reflect.getPrototypeOf(value) !== ArrayBuffer.prototype)
        protocolFailure();
    if (Reflect.ownKeys(value).length !== 0)
        protocolFailure();
    const getter = Reflect.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
    if (getter === undefined)
        protocolFailure();
    return getter.call(value);
}
function requireOperation(value) {
    if (typeof value !== "string" ||
        !DOCUMENT_ENGINE_OPERATIONS.includes(value)) {
        protocolFailure();
    }
}
function requireTransportBoundary(value) {
    if (value !== "worker" && value !== "child")
        protocolFailure();
}
function requireRequestId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
        protocolFailure();
    }
}
function requireBoundedString(value, maximum) {
    if (typeof value !== "string" || value.length > maximum)
        protocolFailure();
}
function requireTrimmedString(value, maximum) {
    if (typeof value !== "string" ||
        value.length > maximum ||
        value.trim().length === 0) {
        protocolFailure();
    }
}
function requireSafeCode(value, maximum) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum ||
        !/^[A-Za-z0-9_-]+$/u.test(value)) {
        protocolFailure();
    }
}
function requireSafeText(value, maximum) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum ||
        value.trim().length === 0 ||
        /[\u0000-\u001F\u007F]/u.test(value)) {
        protocolFailure();
    }
}
function requireSafeImageFilename(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > 255 ||
        value === "." ||
        value === ".." ||
        /[<>:"/\\|?*\u0000-\u001F\u007F]/u.test(value) ||
        isAbsoluteOrTraversingPath(value)) {
        protocolFailure();
    }
}
function requireMetadataString(value) {
    if (typeof value !== "string" ||
        value.length > MAX_SAFE_JSON_STRING_CHARACTERS ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
        protocolFailure();
    }
}
function requireIntegerInRange(value, minimum, maximum) {
    if (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum) {
        protocolFailure();
    }
}
function requireNumberInRange(value, minimum, maximum) {
    if (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum) {
        protocolFailure();
    }
}
function isForbiddenChannelKey(key) {
    const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
    return new Set([
        "path",
        "filepath",
        "sourcepath",
        "outputpath",
        "imagepath",
        "command",
        "cwd",
        "env",
        "environment",
        "stdout",
        "stderr",
        "fields",
        "fieldvalues",
        "formvalues",
    ]).has(normalized);
}
function isAbsoluteOrTraversingPath(value) {
    return (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u.test(value) ||
        /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value));
}
function utf8Bytes(value) {
    return Buffer.byteLength(value, "utf8");
}
function protocolBoundary(action) {
    try {
        return action();
    }
    catch (error) {
        if (isDocumentProtocolError(error))
            throw error;
        throw new DocumentProtocolError();
    }
}
function protocolFailure() {
    throw new DocumentProtocolError();
}
