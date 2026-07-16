import { createHash, randomUUID } from "node:crypto";
import { read as readFd } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { writeDocumentRenderResultExclusively, } from "./document-render-output.js";
import { writeFileRangeAndFilesExclusively, writeFilesExclusively, } from "./output.js";
import { decodeDocumentResultSpool, } from "../workers/document-compute-backend.js";
import { createDocumentChildClient, isIntegrityVerifiedResultSpool, } from "../workers/document-child-client.js";
import { createIsolatedDocumentEngine, } from "../workers/document-execution-policy.js";
import { DOCUMENT_PROTOCOL_VERSION, validateDocumentResultSpoolMetadata, } from "../workers/document-protocol.js";
import { createDocumentWorkerClient } from "../workers/document-worker-client.js";
export function createDocumentEngineFacade(dependencies = {}) {
    const isolatedEngine = dependencies.isolatedEngine ?? createDefaultIsolatedEngine();
    const requestIdFactory = dependencies.requestIdFactory ?? randomUUID;
    return Object.freeze({
        async detect(snapshot, context = {}) {
            if (snapshot.metadata.shallowFormat.candidate === "unknown") {
                try {
                    await snapshot.verifySourceUnchanged();
                    return {
                        payload: { format: "unknown" },
                        snapshotMetadata: snapshot.metadata,
                    };
                }
                finally {
                    await snapshot.cleanup();
                }
            }
            return run("detect", snapshot, {}, {}, context);
        },
        parse(snapshot, options = {}, context = {}) {
            return run("parse", snapshot, {}, copyDefined(options), context);
        },
        render(snapshot, options = {}, context = {}) {
            return runRender(snapshot, {
                ...(options.reflow === undefined ? {} : { reflow: options.reflow }),
                ...(options.highlights === undefined
                    ? {}
                    : { highlights: [...options.highlights] }),
            }, context);
        },
        generate(markdown, options = {}, context = {}) {
            return runGenerate(markdown, options, context);
        },
        validate(snapshot, options = {}, context = {}) {
            return run("validateHwpx", snapshot, {}, options.maxIssues === undefined ? {} : { maxIssues: options.maxIssues }, context);
        },
        patch(snapshot, markdown, context = {}) {
            return runMutation("patchHwpx", snapshot, { markdown }, {}, context);
        },
        fill(snapshot, fields, options = {}, context = {}) {
            return runMutation("fillHwpx", snapshot, { fields: copyFillFields(fields) }, {
                ...(options.formats === undefined
                    ? {}
                    : { formats: { ...options.formats } }),
                ...(options.requireUnique === undefined
                    ? {}
                    : { requireUnique: options.requireUnique }),
            }, context);
        },
        insertImage(snapshot, imageSnapshot, anchorText, options = {}, context = {}) {
            return runImageMutation(snapshot, imageSnapshot, anchorText, options, context);
        },
    });
    async function run(operation, snapshot, input, options, context) {
        const request = {
            protocolVersion: DOCUMENT_PROTOCOL_VERSION,
            requestId: requestIdFactory(),
            operation,
            input,
            options,
        };
        const execute = isolatedEngine.run;
        const result = await execute(request, snapshot, toRunOptions(context));
        const payload = await decodeResult(operation, result);
        await snapshot.verifySourceUnchanged();
        return { payload, snapshotMetadata: snapshot.metadata };
    }
    async function runGenerate(markdown, options, context) {
        const request = {
            protocolVersion: DOCUMENT_PROTOCOL_VERSION,
            requestId: requestIdFactory(),
            operation: "generateHwpx",
            input: { markdown },
            options: options.preset === undefined ? {} : { preset: options.preset },
        };
        const result = await isolatedEngine.run(request, undefined, toRunOptions(context));
        return authorizeHwpxResult("generateHwpx", result, [], context, options.renderPreview === true);
    }
    async function runMutation(operation, snapshot, input, options, context) {
        const request = {
            protocolVersion: DOCUMENT_PROTOCOL_VERSION,
            requestId: requestIdFactory(),
            operation,
            input,
            options,
        };
        const execute = isolatedEngine.run;
        const result = await execute(request, snapshot, toRunOptions(context));
        return authorizeHwpxResult(operation, result, [snapshot], context);
    }
    async function runImageMutation(snapshot, imageSnapshot, anchorText, options, context) {
        if (snapshot.transport !== "spool" || imageSnapshot.transport !== "spool") {
            await Promise.allSettled([snapshot.cleanup(), imageSnapshot.cleanup()]);
            throw engineProtocolError();
        }
        const request = {
            protocolVersion: DOCUMENT_PROTOCOL_VERSION,
            requestId: requestIdFactory(),
            operation: "insertImage",
            input: { anchorText },
            options: {
                ...(options.mode === undefined ? {} : { mode: options.mode }),
                ...(options.sizeMm === undefined ? {} : { sizeMm: options.sizeMm }),
                ...(options.anchorOccurrence === undefined
                    ? {}
                    : { anchorOccurrence: options.anchorOccurrence }),
            },
        };
        const imageHandle = imageSnapshot.takeSpoolHandle();
        let result;
        try {
            result = await isolatedEngine.run(request, snapshot, {
                ...toRunOptions(context),
                imageInput: {
                    transport: "spool",
                    fd: imageHandle.fd,
                    sizeBytes: imageHandle.sizeBytes,
                },
            });
            await imageSnapshot.verifySourceUnchanged();
        }
        catch (error) {
            if (result !== undefined && isIntegrityVerifiedResultSpool(result)) {
                await result.cleanup();
            }
            await imageSnapshot.cleanup();
            throw error;
        }
        await imageSnapshot.cleanup();
        return authorizeHwpxResult("insertImage", result, [snapshot, imageSnapshot], context);
    }
    async function authorizeHwpxResult(operation, result, sourceSnapshots, context, renderPreview = false) {
        const spoolResult = isIntegrityVerifiedResultSpool(result) ? result : undefined;
        const authorizedInlineBytes = spoolResult === undefined
            ? Uint8Array.from(new Uint8Array(result.bytes))
            : undefined;
        let range;
        let resultMetadata;
        let validation;
        let preview;
        try {
            resultMetadata = validateDocumentResultSpoolMetadata(operation, spoolResult?.metadata.resultMetadata ??
                result.metadata);
            const candidateSnapshot = () => {
                if (spoolResult === undefined) {
                    if (authorizedInlineBytes === undefined)
                        throw engineProtocolError();
                    return createCandidateWorkerSnapshot(authorizedInlineBytes.buffer);
                }
                range ??= spoolResult.takeHandle();
                return createCandidateSpoolSnapshot(range, spoolResult.metadata.sha256);
            };
            validation = await run("validateHwpx", candidateSnapshot(), {}, {}, context);
            if (renderPreview && validation.payload.ok) {
                const rendered = await runRender(candidateSnapshot(), { reflow: true }, context);
                preview = await decodeRenderResult(rendered.payload);
            }
            for (const sourceSnapshot of sourceSnapshots) {
                await sourceSnapshot.verifySourceUnchanged();
            }
        }
        catch (error) {
            if (spoolResult !== undefined)
                await spoolResult.cleanup();
            throw error;
        }
        let committed = false;
        let cleaned = false;
        const verifySourceUnchanged = async () => {
            for (const sourceSnapshot of sourceSnapshots) {
                await sourceSnapshot.verifySourceUnchanged();
            }
        };
        return Object.freeze({
            payload: result,
            validation: validation.payload,
            ...(sourceSnapshots[0] === undefined
                ? {}
                : { snapshotMetadata: sourceSnapshots[0].metadata }),
            resultMetadata,
            ...(preview === undefined ? {} : { preview }),
            verifySourceUnchanged,
            async writeOutputExclusively(outputPath, options = {}) {
                if (committed || cleaned)
                    throw engineProtocolError();
                if (!validation.payload.ok)
                    throw engineProtocolError();
                requireNotAborted(context.signal);
                const companions = options.companionFiles ?? [];
                const beforeOpen = async () => {
                    requireNotAborted(context.signal);
                    if (range !== undefined && spoolResult !== undefined &&
                        await hashFdRange(range.fd, range.sizeBytes) !==
                            spoolResult.metadata.sha256) {
                        throw engineProtocolError();
                    }
                    await verifySourceUnchanged();
                };
                let written;
                if (range === undefined) {
                    if (authorizedInlineBytes === undefined)
                        throw engineProtocolError();
                    written = await writeFilesExclusively([
                        { path: outputPath, data: authorizedInlineBytes },
                        ...companions,
                    ], { sourcePaths: options.sourcePaths, beforeOpen });
                }
                else {
                    written = await writeFileRangeAndFilesExclusively(outputPath, { fd: range.fd, offset: 0, sizeBytes: range.sizeBytes }, companions, { sourcePaths: options.sourcePaths, beforeOpen });
                }
                committed = true;
                return written;
            },
            async cleanup() {
                if (cleaned)
                    return;
                cleaned = true;
                if (spoolResult !== undefined)
                    await spoolResult.cleanup();
            },
        });
    }
    async function runRender(snapshot, options, context) {
        const request = {
            protocolVersion: DOCUMENT_PROTOCOL_VERSION,
            requestId: requestIdFactory(),
            operation: "render",
            input: {},
            options,
        };
        const result = await isolatedEngine.run(request, snapshot, toRunOptions(context));
        try {
            await snapshot.verifySourceUnchanged();
        }
        catch (error) {
            if (isIntegrityVerifiedResultSpool(result))
                await result.cleanup();
            throw error;
        }
        return {
            payload: result,
            snapshotMetadata: snapshot.metadata,
            verifySourceUnchanged: () => snapshot.verifySourceUnchanged(),
        };
    }
}
export const defaultDocumentEngineFacade = createDocumentEngineFacade();
async function decodeResult(operation, result) {
    if (!isIntegrityVerifiedResultSpool(result)) {
        return result;
    }
    if (operation === "detect" || operation === "validateHwpx") {
        await result.cleanup();
        throw new Error("Detect results cannot use a spool transport.");
    }
    return decodeDocumentResultSpool(result);
}
async function decodeRenderResult(result) {
    return isIntegrityVerifiedResultSpool(result)
        ? decodeDocumentResultSpool(result)
        : result;
}
function createCandidateWorkerSnapshot(bytes) {
    const transferable = bytes.slice(0);
    let taken = false;
    let disposed = false;
    const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    return Object.freeze({
        transport: "worker",
        metadata: Object.freeze({
            sizeBytes: bytes.byteLength,
            sha256,
            shallowFormat: Object.freeze({
                candidate: "hwpx",
                container: "zip",
                exact: false,
            }),
            protection: Object.freeze({
                status: "requires-engine-validation",
                candidateFormat: "hwpx",
                exact: false,
            }),
        }),
        takeTransferable() {
            if (taken || disposed)
                throw new Error("Candidate snapshot was already consumed.");
            taken = true;
            return transferable;
        },
        async verifySourceUnchanged() { },
        async cleanup() {
            disposed = true;
        },
    });
}
function createCandidateSpoolSnapshot(range, sha256) {
    let taken = false;
    return Object.freeze({
        transport: "spool",
        metadata: Object.freeze({
            sizeBytes: range.sizeBytes,
            sha256,
            shallowFormat: Object.freeze({
                candidate: "hwpx",
                container: "zip",
                exact: false,
            }),
            protection: Object.freeze({
                status: "requires-engine-validation",
                candidateFormat: "hwpx",
                exact: false,
            }),
        }),
        takeSpoolHandle() {
            if (taken)
                throw engineProtocolError();
            taken = true;
            return range;
        },
        async verifySourceUnchanged() {
            if (await hashFdRange(range.fd, range.sizeBytes) !== sha256) {
                throw engineProtocolError();
            }
        },
        async cleanup() { },
    });
}
async function hashFdRange(fd, sizeBytes) {
    if (!Number.isSafeInteger(fd) || fd < 0 ||
        !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
        throw engineProtocolError();
    }
    const buffer = Buffer.allocUnsafeSlow(Math.min(1024 * 1024, sizeBytes));
    const hash = createHash("sha256");
    let position = 0;
    while (position < sizeBytes) {
        const requested = Math.min(buffer.byteLength, sizeBytes - position);
        const bytesRead = await new Promise((resolve, reject) => {
            readFd(fd, buffer, 0, requested, position, (error, count) => {
                if (error === null)
                    resolve(count);
                else
                    reject(error);
            });
        });
        if (bytesRead === 0)
            throw engineProtocolError();
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
    }
    return hash.digest("hex");
}
function engineProtocolError() {
    const error = new Error("The isolated engine returned an invalid HWPX result.");
    Object.assign(error, { code: "ENGINE_PROTOCOL_ERROR" });
    return error;
}
function requireNotAborted(signal) {
    if (signal?.aborted !== true)
        return;
    const error = new Error("The request was cancelled.");
    Object.assign(error, { code: "REQUEST_CANCELLED" });
    throw error;
}
export { writeDocumentRenderResultExclusively };
function toRunOptions(context) {
    return {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
        ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
    };
}
function copyDefined(options) {
    return options.pages === undefined ? {} : { pages: options.pages };
}
function copyFillFields(fields) {
    return Object.fromEntries(Object.entries(fields).map(([key, value]) => [
        key,
        typeof value === "string" ? value : [...value],
    ]));
}
function createDefaultIsolatedEngine() {
    const workerEntry = runtimeEntry("document-worker.js");
    const childEntry = runtimeEntry("document-child.js");
    return createIsolatedDocumentEngine({
        workerClient: createDocumentWorkerClient({
            workerFactory: (options) => new Worker(workerEntry, options),
        }),
        childClient: createDocumentChildClient({
            childEntry: fileURLToPath(childEntry),
        }),
    });
}
function runtimeEntry(filename) {
    return import.meta.url.endsWith(".ts")
        ? new URL(`../../dist/workers/${filename}`, import.meta.url)
        : new URL(`../workers/${filename}`, import.meta.url);
}
