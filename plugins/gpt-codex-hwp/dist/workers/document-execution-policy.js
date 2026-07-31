import { createDocumentEngineRunError, } from "./document-errors.js";
import { documentLogicalRequestBytes, MAX_WORKER_INPUT_BYTES, } from "./document-protocol.js";
export { documentLogicalRequestBytes };
export const WORKER_INPUT_MAX_BYTES = MAX_WORKER_INPUT_BYTES;
export const CHILD_WORKING_SET_MAX_BYTES = 1_536 * 1024 * 1024;
export const MAX_DOCUMENT_DEADLINE_MS = 300_000;
export function maxWorkerSnapshotBytesForRequest(request, imageBytes = 0) {
    const reservedBytes = checkedByteSum(documentLogicalRequestBytes(request), imageBytes);
    return Math.max(0, WORKER_INPUT_MAX_BYTES - reservedBytes);
}
export function defaultDocumentDeadlineMs(operation) {
    return operation === "detect" ||
        operation === "parse" ||
        operation === "validateHwpx"
        ? 60_000
        : MAX_DOCUMENT_DEADLINE_MS;
}
export function selectDocumentExecution(selection) {
    requireSafeNonNegativeInteger(selection.inputBytes);
    requireSafeNonNegativeInteger(selection.imageBytes ?? 0);
    requireSafeNonNegativeInteger(selection.logicalBytes ?? 0);
    requireSafeNonNegativeInteger(selection.estimatedWorkingSetBytes);
    const aggregateInputBytes = checkedByteSum(selection.inputBytes, selection.imageBytes ?? 0, selection.logicalBytes ?? 0);
    const effectiveWorkingSetBytes = Math.max(checkedByteProduct(aggregateInputBytes, 3), selection.estimatedWorkingSetBytes);
    if (effectiveWorkingSetBytes > CHILD_WORKING_SET_MAX_BYTES) {
        throw resourceLimitError();
    }
    if (selection.executionClass === "heavy") {
        if (selection.snapshotTransport === "worker")
            throw resourceLimitError();
        return "child";
    }
    if (selection.snapshotTransport === "spool") {
        return "child";
    }
    if (selection.snapshotTransport === "worker" &&
        aggregateInputBytes > WORKER_INPUT_MAX_BYTES) {
        throw resourceLimitError();
    }
    return "worker";
}
export function createIsolatedDocumentEngine(dependencies) {
    const gate = dependencies.heavyChildGate ?? new HeavyChildGate();
    return {
        async run(request, snapshot, options = {}) {
            const startedAt = Date.now();
            if ((request.operation === "generateHwpx" && snapshot !== undefined) ||
                (request.operation !== "generateHwpx" && snapshot === undefined)) {
                await cleanupOnPreDispatch(snapshot);
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            if (options.signal?.aborted === true) {
                await cleanupOnPreDispatch(snapshot);
                throw createDocumentEngineRunError("REQUEST_CANCELLED");
            }
            const inputBytes = snapshot?.metadata.sizeBytes ?? 0;
            const imageBytes = options.imageInput?.transport === "buffer"
                ? options.imageInput.buffer.byteLength
                : options.imageInput?.sizeBytes ?? 0;
            let logicalBytes;
            let aggregateInputBytes;
            let estimatedWorkingSetBytes;
            let selected;
            try {
                logicalBytes = documentLogicalRequestBytes(request);
                aggregateInputBytes = checkedByteSum(inputBytes, imageBytes, logicalBytes);
                estimatedWorkingSetBytes = Math.max(checkedByteProduct(aggregateInputBytes, 3), options.estimatedWorkingSetBytes ?? 0);
                selected = selectDocumentExecution({
                    operation: request.operation,
                    snapshotTransport: snapshot?.transport ?? "none",
                    inputBytes,
                    imageBytes,
                    logicalBytes,
                    estimatedWorkingSetBytes,
                    executionClass: request.operation === "insertImage"
                        ? "heavy"
                        : options.executionClass ?? "worker-safe",
                });
            }
            catch (error) {
                await cleanupOnPreDispatch(snapshot);
                throw error;
            }
            const client = selected === "worker"
                ? dependencies.workerClient
                : dependencies.childClient;
            if (selected !== "child" || client.concurrencyManaged === true) {
                return runSelectedClient(client, request, snapshot, options);
            }
            const deadlineMs = options.deadlineMs ??
                defaultDocumentDeadlineMs(request.operation);
            let release;
            try {
                release = await gate.acquire(options.signal, deadlineMs);
            }
            catch (error) {
                await cleanupOnPreDispatch(snapshot);
                throw error;
            }
            const remainingDeadlineMs = deadlineMs - (Date.now() - startedAt);
            if (remainingDeadlineMs <= 0) {
                release();
                await cleanupOnPreDispatch(snapshot);
                throw createDocumentEngineRunError("ENGINE_TIMEOUT");
            }
            try {
                return await runSelectedClient(client, request, snapshot, {
                    ...options,
                    deadlineMs: remainingDeadlineMs,
                });
            }
            finally {
                release();
            }
        },
    };
}
function runSelectedClient(client, request, snapshot, options) {
    const run = client.run;
    return run(request, snapshot, options);
}
export class HeavyChildGate {
    #active = 0;
    #waiters = [];
    get activeCount() {
        return this.#active;
    }
    get queuedCount() {
        return this.#waiters.length;
    }
    async acquire(signal, deadlineMs) {
        if (signal?.aborted === true) {
            throw createDocumentEngineRunError("REQUEST_CANCELLED");
        }
        if (this.#active === 0) {
            this.#active = 1;
            return this.#releaseOnce();
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                ...(signal === undefined ? {} : { signal }),
                active: true,
            };
            if (signal !== undefined) {
                waiter.abort = () => {
                    if (!waiter.active)
                        return;
                    waiter.active = false;
                    this.#removeWaiter(waiter);
                    this.#clearWaiter(waiter);
                    reject(createDocumentEngineRunError("REQUEST_CANCELLED"));
                };
                signal.addEventListener("abort", waiter.abort, { once: true });
            }
            this.#waiters.push(waiter);
            if (deadlineMs !== undefined) {
                waiter.deadlineTimer = setTimeout(() => {
                    if (!waiter.active)
                        return;
                    waiter.active = false;
                    this.#removeWaiter(waiter);
                    this.#clearWaiter(waiter);
                    reject(createDocumentEngineRunError("ENGINE_TIMEOUT"));
                }, deadlineMs);
                waiter.deadlineTimer.unref();
            }
        });
    }
    #releaseOnce() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.#active = 0;
            while (this.#waiters.length > 0) {
                const waiter = this.#waiters.shift();
                if (!waiter.active)
                    continue;
                waiter.active = false;
                this.#clearWaiter(waiter);
                this.#active = 1;
                waiter.resolve(this.#releaseOnce());
                break;
            }
        };
    }
    #removeWaiter(waiter) {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0)
            this.#waiters.splice(index, 1);
    }
    #clearWaiter(waiter) {
        if (waiter.signal !== undefined && waiter.abort !== undefined) {
            waiter.signal.removeEventListener("abort", waiter.abort);
        }
        if (waiter.deadlineTimer !== undefined) {
            clearTimeout(waiter.deadlineTimer);
        }
    }
}
async function cleanupOnPreDispatch(snapshot) {
    if (snapshot !== undefined)
        await snapshot.cleanup();
}
function requireSafeNonNegativeInteger(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw resourceLimitError();
}
function checkedByteSum(...values) {
    let total = 0;
    for (const value of values) {
        requireSafeNonNegativeInteger(value);
        if (value > Number.MAX_SAFE_INTEGER - total)
            throw resourceLimitError();
        total += value;
    }
    return total;
}
function checkedByteProduct(value, multiplier) {
    requireSafeNonNegativeInteger(value);
    requireSafeNonNegativeInteger(multiplier);
    if (value !== 0 && multiplier > Math.floor(Number.MAX_SAFE_INTEGER / value)) {
        throw resourceLimitError();
    }
    return value * multiplier;
}
function resourceLimitError() {
    return createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
        remediation: "reduce_input",
    });
}
