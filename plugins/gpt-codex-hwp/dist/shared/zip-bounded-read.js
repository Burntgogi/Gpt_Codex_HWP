export class ZipEntryTooLargeError extends Error {
    code = "ZIP_ENTRY_TOO_LARGE";
    constructor(label, maximumBytes) {
        super(`${label} decompresses beyond the ${maximumBytes}-byte safety limit.`);
        this.name = "ZipEntryTooLargeError";
    }
}
/**
 * Decompresses one ZIP entry while counting the bytes actually produced.
 * The size declared in the ZIP headers is attacker-controlled, so this stops
 * at maximumBytes even when the header understates the entry.
 */
export function readZipEntryBounded(entry, maximumBytes, label) {
    return new Promise((resolvePromise, rejectPromise) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const stream = entry.internalStream("uint8array");
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            try {
                stream.pause();
            }
            catch { }
            rejectPromise(error);
        };
        stream.on("data", (chunk) => {
            if (settled)
                return;
            total += chunk.byteLength;
            if (total > maximumBytes) {
                fail(new ZipEntryTooLargeError(label, maximumBytes));
                return;
            }
            chunks.push(chunk);
        });
        stream.on("error", fail);
        stream.on("end", () => {
            if (settled)
                return;
            settled = true;
            const result = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.byteLength;
            }
            resolvePromise(result);
        });
        stream.resume();
    });
}
