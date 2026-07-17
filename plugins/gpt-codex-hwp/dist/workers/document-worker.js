import { parentPort, } from "node:worker_threads";
import { DOCUMENT_ENGINE_ERROR_MESSAGES, createDocumentEngineRunError, isDocumentEngineRunError, normalizeDocumentEngineError, } from "./document-errors.js";
import { initializeDocumentComputeBackend, isRhwpCapabilityError, } from "./document-compute-backend.js";
import { DOCUMENT_PROTOCOL_VERSION, maximumWorkerInlineResultBytes, measureDocumentResultByteLength, validateWireDocumentRequest, } from "./document-protocol.js";
if (parentPort === null)
    throw new Error("document worker requires a parent port");
const port = parentPort;
let accepted = false;
port.on("message", (value) => {
    if (accepted)
        return;
    accepted = true;
    void run(value);
});
async function run(value) {
    let request;
    try {
        request = validateWireDocumentRequest(value, "worker");
    }
    catch {
        throw new Error("invalid document worker request");
    }
    let ready = false;
    try {
        const backend = await initializeDocumentComputeBackend();
        port.postMessage(event(request, "ready"));
        ready = true;
        const inputs = transferredInputs(request);
        postMetrics(request, 0);
        const payload = await backend.execute(request, inputs, (progress) => postProgress(request, progress), (metrics) => postMetrics(request, metrics.copiedBytes));
        const outputByteLength = measureDocumentResultByteLength(request.operation, payload);
        if (outputByteLength > maximumWorkerInlineResultBytes(request.operation)) {
            throw createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
                stage: request.operation,
                remediation: "reduce_input",
            });
        }
        port.postMessage({
            ...event(request, "result"),
            payload,
            outputByteLength,
        }, transferableResults(request.operation, payload));
    }
    catch (error) {
        port.postMessage({
            ...event(request, "failure"),
            error: publicError(error, ready, request.operation),
        });
    }
}
function transferredInputs(request) {
    if (request.operation === "generateHwpx")
        return {};
    if (request.input.document.transport !== "buffer") {
        throw new Error("worker document input is not transferred");
    }
    if (request.operation !== "insertImage") {
        return { document: request.input.document.buffer };
    }
    if (request.input.image.transport !== "buffer") {
        throw new Error("worker image input is not transferred");
    }
    return {
        document: request.input.document.buffer,
        image: request.input.image.buffer,
    };
}
function transferableResults(operation, payload) {
    if (operation === "parse") {
        return payload.images.map((image) => image.bytes);
    }
    if (operation === "generateHwpx" || operation === "patchHwpx" ||
        operation === "fillHwpx" || operation === "insertImage") {
        return [payload.bytes];
    }
    return [];
}
function postProgress(request, progress) {
    if (progress.stage !== request.operation)
        return;
    port.postMessage({
        ...event(request, "progress"),
        completed: progress.completed,
        total: progress.total,
    });
}
function postMetrics(request, copiedBytes) {
    port.postMessage({
        ...event(request, "metrics"),
        copiedBytes,
    });
}
function event(request, type) {
    return {
        protocolVersion: DOCUMENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        type,
    };
}
function publicError(error, ready, operation) {
    if (isRhwpCapabilityError(error)) {
        return {
            code: "ENGINE_INIT_FAILED",
            message: DOCUMENT_ENGINE_ERROR_MESSAGES.ENGINE_INIT_FAILED,
            details: { stage: "render", remediation: "check_installation" },
        };
    }
    if (isDocumentEngineRunError(error)) {
        return {
            code: error.code,
            message: DOCUMENT_ENGINE_ERROR_MESSAGES[error.code],
            ...(error.details === undefined ? {} : { details: error.details }),
        };
    }
    return normalizeDocumentEngineError(error, {
        ready,
        stage: ready ? operation : "startup",
    });
}
