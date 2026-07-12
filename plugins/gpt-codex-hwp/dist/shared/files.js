import { open } from "node:fs/promises";
export const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
export async function readFileBounded(path, label, maximumBytes = MAX_DOCUMENT_BYTES) {
    const handle = await open(path, "r");
    try {
        const status = await handle.stat();
        if (!status.isFile()) {
            throw new FileLimitError(`${label} must be a regular file.`);
        }
        if (status.size > maximumBytes) {
            throw new FileLimitError(`${label} exceeds the ${maximumBytes}-byte safety limit.`);
        }
        const chunks = [];
        let total = 0;
        while (true) {
            const remaining = maximumBytes + 1 - total;
            if (remaining <= 0) {
                throw new FileLimitError(`${label} exceeded the ${maximumBytes}-byte safety limit while being read.`);
            }
            const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
            const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
            if (bytesRead === 0)
                break;
            total += bytesRead;
            if (total > maximumBytes) {
                throw new FileLimitError(`${label} exceeds the ${maximumBytes}-byte safety limit.`);
            }
            chunks.push(chunk.subarray(0, bytesRead));
        }
        return Buffer.concat(chunks, total);
    }
    finally {
        await handle.close();
    }
}
export class FileLimitError extends Error {
    code = "FILE_SIZE_LIMIT";
    constructor(message) {
        super(message);
        this.name = "FileLimitError";
    }
}
