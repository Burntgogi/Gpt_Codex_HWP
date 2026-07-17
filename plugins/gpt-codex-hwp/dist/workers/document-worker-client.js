import { Worker } from "node:worker_threads";
import { DocumentEngineRunError, createDocumentEngineRunError, normalizeDocumentEngineError, } from "./document-errors.js";
import { createDocumentEventValidator, createWireDocumentRequest, documentWorkerRequestBytes, MAX_WORKER_INPUT_BYTES, validateLogicalDocumentRequest, } from "./document-protocol.js";
import { defaultDocumentDeadlineMs } from "./document-execution-policy.js";
export const DOCUMENT_WORKER_RESOURCE_LIMITS = Object.freeze({
    maxOldGenerationSizeMb: 768,
    maxYoungGenerationSizeMb: 64,
    codeRangeSizeMb: 64,
    stackSizeMb: 8,
});
export function createDocumentWorkerClient(dependencies = {}) {
    const workerFactory = dependencies.workerFactory ?? ((options) => new Worker(new URL("./document-worker.js", import.meta.url), options));
    const terminationDeadlineMs = dependencies.terminationDeadlineMs ?? 2_000;
    return {
        async run(request, snapshot, options = {}) {
            const requestStartedAt = Date.now();
            try {
                validateLogicalDocumentRequest(request);
            }
            catch {
                await cleanupSnapshot(snapshot);
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            if ((request.operation === "generateHwpx" && snapshot !== undefined) ||
                (request.operation !== "generateHwpx" && snapshot?.transport !== "worker")) {
                await cleanupUnknownSnapshot(snapshot);
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            if (options.signal?.aborted === true) {
                await cleanupSnapshot(snapshot);
                throw createDocumentEngineRunError("REQUEST_CANCELLED");
            }
            let deadlineMs;
            try {
                deadlineMs = normalizeDeadline(options.deadlineMs ?? defaultDocumentDeadlineMs(request.operation));
            }
            catch (error) {
                await cleanupSnapshot(snapshot);
                throw error;
            }
            let preflight;
            try {
                preflight = workerRequestPreflight(request, snapshot, options);
            }
            catch (error) {
                await cleanupSnapshot(snapshot);
                if (error instanceof DocumentEngineRunError)
                    throw error;
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            let worker;
            try {
                worker = workerFactory({
                    resourceLimits: { ...DOCUMENT_WORKER_RESOURCE_LIMITS },
                    stdout: true,
                    stderr: true,
                });
            }
            catch (error) {
                await cleanupSnapshot(snapshot);
                if (isSignalAborted(options.signal)) {
                    throw createDocumentEngineRunError("REQUEST_CANCELLED");
                }
                if (Date.now() - requestStartedAt >= deadlineMs) {
                    throw createDocumentEngineRunError("ENGINE_TIMEOUT");
                }
                throw new DocumentEngineRunError(normalizeDocumentEngineError(error, {
                    ready: false,
                    stage: "startup",
                }));
            }
            const remainingDeadlineMs = deadlineMs - (Date.now() - requestStartedAt);
            if (remainingDeadlineMs <= 0) {
                const terminated = await confirmWorkerTermination(worker, terminationDeadlineMs);
                await cleanupSnapshot(snapshot);
                if (!terminated) {
                    throw createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
                        stage: "shutdown",
                        remediation: "check_installation",
                    });
                }
                throw createDocumentEngineRunError("ENGINE_TIMEOUT");
            }
            return runWorker(request, snapshot, options, remainingDeadlineMs, worker, terminationDeadlineMs, preflight);
        },
    };
}
async function runWorker(request, snapshot, options, deadlineMs, worker, terminationDeadlineMs, preflight) {
    const startedAt = Date.now();
    const validator = createDocumentEventValidator(request.requestId, request.operation, preflight.documentBytes);
    let ready = false;
    let settling = false;
    let deadlineTimer;
    let abortListener;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    return new Promise((resolve, reject) => {
        const onStdout = (chunk) => {
            stdoutBytes = Math.min(64 * 1024, stdoutBytes + chunk.byteLength);
        };
        const onStderr = (chunk) => {
            stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.byteLength);
        };
        worker.stdout?.on("data", onStdout);
        worker.stderr?.on("data", onStderr);
        const detachListeners = () => {
            worker.off("message", onMessage);
            worker.off("error", onError);
            worker.off("exit", onExit);
            if (deadlineTimer !== undefined)
                clearTimeout(deadlineTimer);
            if (abortListener !== undefined && options.signal !== undefined) {
                options.signal.removeEventListener("abort", abortListener);
            }
        };
        const settle = (outcome) => {
            if (settling)
                return;
            settling = true;
            detachListeners();
            void (async () => {
                let terminalError = "error" in outcome ? outcome.error : undefined;
                const termination = beginWorkerTermination(worker, terminationDeadlineMs);
                const terminationOutcome = await termination.outcome;
                if (terminationOutcome !== "confirmed") {
                    if (terminationOutcome === "timeout") {
                        void termination.receipt.then(async (lateOutcome) => {
                            if (lateOutcome !== "confirmed")
                                return;
                            worker.stdout?.off("data", onStdout);
                            worker.stderr?.off("data", onStderr);
                            try {
                                await cleanupSnapshot(snapshot);
                            }
                            catch { }
                        });
                    }
                    reject(createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
                        stage: "shutdown",
                        remediation: "check_installation",
                    }));
                    return;
                }
                worker.stdout?.off("data", onStdout);
                worker.stderr?.off("data", onStderr);
                try {
                    await cleanupSnapshot(snapshot);
                }
                catch (error) {
                    terminalError ??= error;
                }
                if (terminalError !== undefined) {
                    if (terminalError instanceof DocumentEngineRunError) {
                        reject(terminalError);
                        return;
                    }
                    reject(new DocumentEngineRunError(normalizeDocumentEngineError(terminalError, {
                        ready,
                        ...(!("terminationReason" in outcome) || outcome.terminationReason === undefined
                            ? {}
                            : { terminationReason: outcome.terminationReason }),
                        stage: ready ? request.operation : "startup",
                        elapsedMs: Math.max(0, Date.now() - startedAt),
                    })));
                    return;
                }
                resolve(outcome.result);
            })();
        };
        const onMessage = (value) => {
            if (settling)
                return;
            try {
                const event = validator.accept(value);
                if (event.type === "ready") {
                    ready = true;
                    return;
                }
                if (event.type === "progress") {
                    options.onProgress?.(event.completed, event.total);
                    return;
                }
                if (event.type === "metrics") {
                    options.onMetrics?.(Object.freeze({ copiedBytes: event.copiedBytes }));
                    return;
                }
                if (event.type === "failure") {
                    settle({
                        error: event.error.code === "ENGINE_OOM" || ready
                            ? new DocumentEngineRunError(event.error)
                            : createDocumentEngineRunError("ENGINE_INIT_FAILED", {
                                stage: "startup",
                            }),
                    });
                    return;
                }
                settle({ result: event.payload });
            }
            catch (error) {
                settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
            }
        };
        const onError = (error) => settle({ error });
        const onExit = (code) => {
            if (!settling)
                settle({ error: new Error(`worker exit ${code}`) });
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.on("exit", onExit);
        abortListener = () => settle({
            error: new Error("cancelled"),
            terminationReason: "abort",
        });
        options.signal?.addEventListener("abort", abortListener, { once: true });
        if (options.signal?.aborted === true) {
            abortListener();
            return;
        }
        deadlineTimer = setTimeout(() => settle({
            error: new Error("deadline"),
            terminationReason: "deadline",
        }), deadlineMs);
        deadlineTimer.unref();
        try {
            const transports = {};
            const transferList = [];
            let actualDocumentBytes = 0;
            let actualImageBytes = 0;
            if (request.operation !== "generateHwpx") {
                if (snapshot?.transport !== "worker") {
                    throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
                }
                const buffer = snapshot.takeTransferable();
                actualDocumentBytes = buffer.byteLength;
                if (actualDocumentBytes !== preflight.documentBytes) {
                    throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
                }
                transports.document = { transport: "buffer", buffer };
                transferList.push(buffer);
            }
            if (request.operation === "insertImage") {
                if (options.imageInput?.transport !== "buffer") {
                    throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
                }
                actualImageBytes = options.imageInput.buffer.byteLength;
                if (actualImageBytes !== preflight.imageBytes) {
                    throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
                }
                if (transferList.includes(options.imageInput.buffer)) {
                    throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
                }
                transports.image = {
                    transport: "buffer",
                    buffer: options.imageInput.buffer,
                };
                transferList.push(options.imageInput.buffer);
            }
            const actualBytes = documentWorkerRequestBytes({ input: request.input, options: request.options }, actualDocumentBytes, actualImageBytes);
            if (actualBytes !== preflight.aggregateBytes || actualBytes > MAX_WORKER_INPUT_BYTES) {
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            let wire;
            try {
                wire = createWireDocumentRequest(request, transports, "worker");
            }
            catch {
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            worker.postMessage(wire, transferList);
        }
        catch (error) {
            settle({ error });
        }
    });
}
function workerRequestPreflight(request, snapshot, options) {
    const documentBytes = request.operation === "generateHwpx"
        ? 0
        : snapshot?.metadata.sizeBytes ?? Number.NaN;
    let imageBytes = 0;
    if (request.operation === "insertImage") {
        if (options.imageInput?.transport !== "buffer") {
            throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
        }
        imageBytes = options.imageInput.buffer.byteLength;
    }
    const aggregateBytes = documentWorkerRequestBytes({ input: request.input, options: request.options }, documentBytes, imageBytes);
    if (aggregateBytes > MAX_WORKER_INPUT_BYTES) {
        throw createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
            remediation: "reduce_input",
        });
    }
    return Object.freeze({ documentBytes, imageBytes, aggregateBytes });
}
function beginWorkerTermination(worker, deadlineMs) {
    let termination;
    try {
        termination = worker.terminate();
    }
    catch {
        const receipt = Promise.resolve("rejected");
        return { receipt, outcome: receipt };
    }
    const receipt = termination.then(() => "confirmed", () => "rejected");
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deadlineMs);
    });
    const outcome = Promise.race([receipt, timeout]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
    return { receipt, outcome };
}
async function confirmWorkerTermination(worker, deadlineMs) {
    return (await beginWorkerTermination(worker, deadlineMs).outcome) === "confirmed";
}
function normalizeDeadline(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
            remediation: "reduce_input",
        });
    }
    return value;
}
async function cleanupSnapshot(snapshot) {
    if (snapshot !== undefined)
        await snapshot.cleanup();
}
async function cleanupUnknownSnapshot(snapshot) {
    if (snapshot !== undefined)
        await snapshot.cleanup();
}
function isSignalAborted(signal) {
    return signal?.aborted === true;
}
