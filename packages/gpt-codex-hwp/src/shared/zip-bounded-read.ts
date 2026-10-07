import type JSZip from "jszip";

// JSZip implements internalStream on entries but omits it from its typings.
interface JSZipEntryStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): JSZipEntryStream;
  on(event: "error", listener: (error: unknown) => void): JSZipEntryStream;
  on(event: "end", listener: () => void): JSZipEntryStream;
  pause(): JSZipEntryStream;
  resume(): JSZipEntryStream;
}

export class ZipEntryTooLargeError extends Error {
  readonly code = "ZIP_ENTRY_TOO_LARGE";

  constructor(label: string, maximumBytes: number) {
    super(`${label} decompresses beyond the ${maximumBytes}-byte safety limit.`);
    this.name = "ZipEntryTooLargeError";
  }
}

/**
 * Decompresses one ZIP entry while counting the bytes actually produced.
 * The size declared in the ZIP headers is attacker-controlled, so this stops
 * at maximumBytes even when the header understates the entry.
 */
export function readZipEntryBounded(
  entry: JSZip.JSZipObject,
  maximumBytes: number,
  label: string,
): Promise<Uint8Array> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const stream = (entry as unknown as {
      internalStream(type: "uint8array"): JSZipEntryStream;
    }).internalStream("uint8array");
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try { stream.pause(); } catch {}
      rejectPromise(error);
    };
    stream.on("data", (chunk: Uint8Array) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > maximumBytes) {
        fail(new ZipEntryTooLargeError(label, maximumBytes));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
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
