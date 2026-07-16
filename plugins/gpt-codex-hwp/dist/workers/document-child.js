import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fstatSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedFrameDecoder, encodeBoundedJsonFrame, parseBoundedJsonFrame } from "./bounded-frame.js";
import { encodeDocumentResultSpool, documentResultSpoolMetadata, initializeDocumentComputeBackend, isRhwpCapabilityError, } from "./document-compute-backend.js";
import { DOCUMENT_ENGINE_ERROR_MESSAGES, createDocumentEngineRunError, isDocumentEngineRunError, normalizeDocumentEngineError, } from "./document-errors.js";
import { DOCUMENT_PROTOCOL_VERSION, MAX_CHILD_INLINE_RESULT_BYTES, MAX_CHILD_REQUEST_FRAME_BYTES, MAX_DOCUMENT_ENGINE_RESULT_BYTES, createInlineDocumentResultEvent, measureDocumentResultByteLength, resultSpoolEncoding, validateDocumentResultSpoolMetadata, validateWireDocumentRequest, } from "./document-protocol.js";
const CONTROL_DESCRIPTOR = 6;
const OUTPUT_DESCRIPTOR = 5;
const IMAGE_HELPER_CONTROL_BYTES = 64 * 1024;
void run();
async function run() {
    let request;
    try {
        request = validateWireDocumentRequest(await readRequest());
    }
    catch {
        process.exitCode = 19;
        return;
    }
    let ready = false;
    try {
        const backend = await initializeDocumentComputeBackend();
        sendControl(event(request, "ready"));
        ready = true;
        if (request.operation === "insertImage" && request.options.mode !== "seal-anchor") {
            await runAfterParagraphInsert(request, backend);
            return;
        }
        const inputs = inheritedInputs(request);
        const payload = await backend.execute(request, inputs, (progress) => sendProgress(request, progress));
        await sendResult(request, payload);
    }
    catch (error) {
        sendControl({
            ...event(request, "failure"),
            error: publicError(error, ready, request.operation),
        });
    }
}
async function runAfterParagraphInsert(request, backend) {
    if (request.input.document.transport !== "spool" ||
        request.input.document.descriptor !== 3 ||
        request.input.image.transport !== "spool" ||
        request.input.image.descriptor !== 4)
        throw new Error("image inputs are not inherited");
    const source = readExact(3, request.input.document.sizeBytes);
    const image = readExact(4, request.input.image.sizeBytes);
    const prepared = await backend.prepareImageInsertion(source, image, request.input.anchorText, request.options.anchorOccurrence);
    const metadata = await runImageHelper(request, request.input.document.sizeBytes, prepared.image, prepared.occurrence);
    const sizeBytes = fstatSync(OUTPUT_DESCRIPTOR).size;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 ||
        sizeBytes > MAX_DOCUMENT_ENGINE_RESULT_BYTES)
        throw new Error("result spool exceeds its limit");
    const sha256 = hashDescriptor(OUTPUT_DESCRIPTOR, sizeBytes);
    sendControl({
        ...event(request, "spoolResult"),
        receipt: {
            descriptor: OUTPUT_DESCRIPTOR,
            operation: "insertImage",
            encoding: resultSpoolEncoding("insertImage"),
            sizeBytes,
            sha256,
            metadata,
        },
    });
}
async function runImageHelper(request, sourceSize, image, occurrence) {
    const script = fileURLToPath(new URL("../../scripts/hwpx-safe-edit/insert_image.py", import.meta.url));
    const command = process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "py.exe")
        : "/usr/bin/python3";
    const args = [
        ...(process.platform === "win32" ? ["-3"] : []),
        script,
        "--descriptor-mode",
    ];
    const control = encodeBoundedJsonFrame({
        sourceSize,
        imageSize: image.byteLength,
        anchorText: request.input.anchorText,
        occurrence,
        ...(request.options.sizeMm === undefined
            ? {}
            : { widthMm: request.options.sizeMm }),
    }, IMAGE_HELPER_CONTROL_BYTES);
    return new Promise((resolvePromise, rejectPromise) => {
        const helper = spawn(command, args, {
            shell: false,
            windowsHide: true,
            env: minimalPythonEnvironment(),
            stdio: ["pipe", "pipe", "pipe", 3, "pipe", 5],
        });
        let outputBytes = 0;
        let errorBytes = 0;
        const outputChunks = [];
        helper.stdout?.on("data", (chunk) => {
            outputBytes += chunk.byteLength;
            if (outputBytes > 64 * 1024)
                helper.kill();
            else
                outputChunks.push(Buffer.from(chunk));
        });
        helper.stderr?.on("data", (chunk) => {
            errorBytes += chunk.byteLength;
            if (errorBytes > 64 * 1024)
                helper.kill();
        });
        helper.stdin?.on("error", () => undefined);
        helper.stdin?.end(control);
        const imageInput = helper.stdio[4];
        if (imageInput === null) {
            helper.kill();
            rejectPromise(createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR"));
            return;
        }
        imageInput.on("error", () => undefined);
        imageInput.end(Buffer.from(image));
        helper.once("error", rejectPromise);
        helper.once("exit", (code) => {
            if (code === 0 && outputBytes <= 64 * 1024 && errorBytes <= 64 * 1024) {
                try {
                    resolvePromise(afterParagraphMetadata(Buffer.concat(outputChunks)));
                }
                catch (error) {
                    rejectPromise(error);
                }
            }
            else {
                rejectPromise(createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR"));
            }
        });
    });
}
function afterParagraphMetadata(encoded) {
    let value;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded));
    }
    catch {
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
    }
    if (!isRecord(value) || !hasExactKeys(value, [
        "ok",
        "image_entry",
        "item_id",
        "section_index",
        "removed_linesegarray",
        "display_width_hu",
        "display_height_hu",
        "warnings",
    ]) || value.ok !== true || typeof value.image_entry !== "string" ||
        typeof value.item_id !== "string" ||
        !isSafeNonNegativeInteger(value.section_index) ||
        !isSafeNonNegativeInteger(value.removed_linesegarray) ||
        !isSafePositiveInteger(value.display_width_hu) ||
        !isSafePositiveInteger(value.display_height_hu) ||
        !Array.isArray(value.warnings) ||
        !value.warnings.every((warning) => typeof warning === "string")) {
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
    }
    return validateDocumentResultSpoolMetadata("insertImage", {
        operation: "insertImage",
        mode: "after-paragraph",
        placement: {
            imageEntry: value.image_entry,
            itemId: value.item_id,
            sectionIndex: value.section_index,
            removedLinesegarray: value.removed_linesegarray,
            displayWidthHu: value.display_width_hu,
            displayHeightHu: value.display_height_hu,
            warnings: [...value.warnings],
        },
    });
}
async function sendResult(request, payload) {
    const measured = measureDocumentResultByteLength(request.operation, payload);
    if (measured <= MAX_CHILD_INLINE_RESULT_BYTES) {
        try {
            const inline = createInlineDocumentResultEvent(request.requestId, request.operation, payload);
            const frame = encodeBoundedJsonFrame(inline, MAX_CHILD_INLINE_RESULT_BYTES);
            writeAll(CONTROL_DESCRIPTOR, frame);
            return;
        }
        catch {
            if (request.operation === "detect" || request.operation === "validateHwpx") {
                throw new Error("inline result could not be framed");
            }
        }
    }
    if (request.operation === "detect" || request.operation === "validateHwpx") {
        throw new Error("inline-only result exceeds its limit");
    }
    const operation = request.operation;
    const encoded = encodeDocumentResultSpool(operation, payload);
    if (encoded.byteLength === 0 || encoded.byteLength > MAX_DOCUMENT_ENGINE_RESULT_BYTES) {
        throw new Error("result spool exceeds its limit");
    }
    writeAll(OUTPUT_DESCRIPTOR, encoded);
    sendControl({
        ...event(request, "spoolResult"),
        receipt: {
            descriptor: OUTPUT_DESCRIPTOR,
            operation,
            encoding: resultSpoolEncoding(operation),
            sizeBytes: encoded.byteLength,
            sha256: createHash("sha256").update(encoded).digest("hex"),
            ...(operation === "generateHwpx" || operation === "patchHwpx" ||
                operation === "fillHwpx" || operation === "insertImage"
                ? {
                    metadata: documentResultSpoolMetadata(operation, payload),
                }
                : {}),
        },
    });
}
function inheritedInputs(request) {
    if (request.operation === "generateHwpx")
        return {};
    if (request.input.document.transport !== "spool" ||
        request.input.document.descriptor !== 3) {
        throw new Error("child document input is not inherited");
    }
    const document = readExact(3, request.input.document.sizeBytes);
    if (request.operation !== "insertImage")
        return { document };
    if (request.input.image.transport !== "spool" ||
        request.input.image.descriptor !== 4) {
        throw new Error("child image input is not inherited");
    }
    return {
        document,
        image: readExact(4, request.input.image.sizeBytes),
    };
}
function readExact(fd, sizeBytes) {
    const bytes = Buffer.allocUnsafeSlow(sizeBytes);
    let offset = 0;
    while (offset < sizeBytes) {
        const count = readSync(fd, bytes, offset, sizeBytes - offset, offset);
        if (count === 0)
            throw new Error("inherited input spool is truncated");
        offset += count;
    }
    const exact = new Uint8Array(sizeBytes);
    exact.set(bytes);
    return exact.buffer;
}
function hashDescriptor(fd, sizeBytes) {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafeSlow(Math.min(1024 * 1024, sizeBytes));
    let position = 0;
    while (position < sizeBytes) {
        const requested = Math.min(buffer.byteLength, sizeBytes - position);
        const count = readSync(fd, buffer, 0, requested, position);
        if (count === 0)
            throw new Error("result spool is truncated");
        hash.update(buffer.subarray(0, count));
        position += count;
    }
    return hash.digest("hex");
}
function minimalPythonEnvironment() {
    const result = {
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
    };
    for (const key of [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ]) {
        const value = process.env[key];
        if (value !== undefined)
            result[key] = value;
    }
    return result;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sorted = [...expected].sort();
    return actual.length === sorted.length &&
        actual.every((key, index) => key === sorted[index]);
}
function isSafeNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isSafePositiveInteger(value) {
    return isSafeNonNegativeInteger(value) && value > 0;
}
function readRequest() {
    const decoder = new BoundedFrameDecoder(MAX_CHILD_REQUEST_FRAME_BYTES);
    return new Promise((resolvePromise, rejectPromise) => {
        let accepted = false;
        let parsed;
        process.stdin.on("data", (chunk) => {
            try {
                const frames = decoder.push(chunk);
                if (frames.length > 1 || (accepted && frames.length > 0)) {
                    throw new Error("multiple request frames");
                }
                if (frames.length === 1) {
                    accepted = true;
                    parsed = parseBoundedJsonFrame(frames[0]);
                }
            }
            catch (error) {
                rejectPromise(error);
            }
        });
        process.stdin.on("end", () => {
            try {
                decoder.finish();
                if (!accepted)
                    rejectPromise(new Error("missing request frame"));
                else
                    resolvePromise(parsed);
            }
            catch (error) {
                rejectPromise(error);
            }
        });
        process.stdin.on("error", rejectPromise);
    });
}
function sendProgress(request, progress) {
    if (progress.stage !== request.operation)
        return;
    sendControl({
        ...event(request, "progress"),
        completed: progress.completed,
        total: progress.total,
    });
}
function sendControl(value) {
    writeAll(CONTROL_DESCRIPTOR, encodeBoundedJsonFrame(value, MAX_CHILD_INLINE_RESULT_BYTES));
}
function writeAll(fd, bytes) {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (count === 0)
            throw new Error("could not write isolate output");
        offset += count;
    }
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
