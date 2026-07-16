import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { authorizeExistingPath } from "./allowed-roots.js";
export const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
export async function readFileBounded(path, label, maximumBytes = MAX_DOCUMENT_BYTES, options = {}) {
    const safeLabel = normalizedLabel(label);
    validateReadOptions(maximumBytes, options);
    if (typeof path !== "string" || path.trim().length === 0) {
        throw readFailedError(safeLabel);
    }
    const authorizedPath = await authorizeExistingPath(path);
    try {
        const handle = await openFileForBoundedRead(authorizedPath);
        try {
            return await readExactFile(handle, authorizedPath, safeLabel, maximumBytes, options);
        }
        finally {
            try {
                await handle.close();
            }
            catch {
                throw readFailedError(safeLabel);
            }
        }
    }
    catch (error) {
        if (error instanceof FileLimitError || error instanceof FileReadError) {
            throw error;
        }
        if (errorCode(error) === "ENOENT") {
            throw new FileReadError("ENOENT", `Could not read ${safeLabel} safely.`);
        }
        throw readFailedError(safeLabel);
    }
}
export function openFileForBoundedRead(path) {
    return process.platform === "win32"
        ? open(path, "r")
        : open(path, constants.O_RDONLY | constants.O_NONBLOCK);
}
async function readExactFile(handle, path, label, maximumBytes, options) {
    const initialHandleStatus = await handle.stat({ bigint: true });
    if (!initialHandleStatus.isFile()) {
        throw new FileReadError("INVALID_FILE_TYPE", `${label} must be a regular file.`);
    }
    if (initialHandleStatus.size > BigInt(maximumBytes)) {
        throw new FileLimitError(`${label} exceeds the ${maximumBytes}-byte safety limit.`);
    }
    const initialIdentity = identityOf(initialHandleStatus);
    assertSameIdentity(initialIdentity, await pathIdentity(path, label), label);
    const sizeBytes = Number(initialHandleStatus.size);
    options.allocationObserver?.(sizeBytes);
    const bytes = Buffer.allocUnsafeSlow(sizeBytes);
    let position = 0;
    while (position < sizeBytes) {
        const requested = Math.min(READ_CHUNK_BYTES, sizeBytes - position);
        const { bytesRead } = await handle.read(bytes, position, requested, position);
        if (bytesRead === 0)
            throw sourceChangedError(label);
        position += bytesRead;
    }
    await options.testHooks?.afterSourceRead?.();
    assertSameIdentity(initialIdentity, identityOf(await handle.stat({ bigint: true })), label);
    assertSameIdentity(initialIdentity, await pathIdentity(path, label), label);
    return bytes;
}
function validateReadOptions(maximumBytes, options) {
    if (!Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 0 ||
        typeof options !== "object" ||
        options === null) {
        throw invalidOptionsError();
    }
    if (options.allocationObserver !== undefined &&
        typeof options.allocationObserver !== "function") {
        throw invalidOptionsError();
    }
    const hooks = options.testHooks;
    if (hooks !== undefined) {
        if (typeof hooks !== "object" || hooks === null) {
            throw invalidOptionsError();
        }
        if (hooks.afterSourceRead !== undefined &&
            typeof hooks.afterSourceRead !== "function") {
            throw invalidOptionsError();
        }
    }
}
async function pathIdentity(path, label) {
    try {
        return identityOf(await stat(path, { bigint: true }));
    }
    catch {
        throw sourceChangedError(label);
    }
}
function identityOf(status) {
    return {
        device: status.dev,
        inode: status.ino,
        size: status.size,
        modified: status.mtimeNs,
        changed: status.ctimeNs,
    };
}
function assertSameIdentity(expected, actual, label) {
    if (expected.device !== actual.device ||
        expected.inode !== actual.inode ||
        expected.size !== actual.size ||
        expected.modified !== actual.modified ||
        expected.changed !== actual.changed) {
        throw sourceChangedError(label);
    }
}
function normalizedLabel(label) {
    if (typeof label === "string" &&
        /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/u.test(label.trim())) {
        return label.trim();
    }
    return "file";
}
export class FileLimitError extends Error {
    code = "FILE_SIZE_LIMIT";
    constructor(message) {
        super(message);
        this.name = "FileLimitError";
    }
}
export class FileReadError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "FileReadError";
    }
}
function sourceChangedError(label) {
    return new FileReadError("SOURCE_CHANGED", `${normalizedLabel(label)} changed while it was read.`);
}
function readFailedError(label) {
    return new FileReadError("FILE_READ_ERROR", `Could not read ${normalizedLabel(label)} safely.`);
}
function invalidOptionsError() {
    return new FileReadError("INVALID_READ_OPTIONS", "Bounded file read options are invalid.");
}
function errorCode(error) {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
