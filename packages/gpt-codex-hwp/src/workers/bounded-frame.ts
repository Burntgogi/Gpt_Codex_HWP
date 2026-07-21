const FRAME_HEADER_BYTES = 4;
const BINARY_TAG = "$gptCodexHwpArrayBuffer";

export class BoundedFrameDecoder {
  readonly #header = Buffer.alloc(FRAME_HEADER_BYTES);
  readonly #maxFrameBytes: number;
  readonly #onPayloadAllocation?: (bytes: number) => void;
  #headerBytes = 0;
  #payload: Buffer | undefined;
  #payloadBytes = 0;
  #failed = false;

  constructor(
    maxFrameBytes: number,
    onPayloadAllocation?: (bytes: number) => void,
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0 || maxFrameBytes > 0xffff_ffff) {
      throw new Error("invalid frame limit");
    }
    this.#maxFrameBytes = maxFrameBytes;
    this.#onPayloadAllocation = onPayloadAllocation;
  }

  push(chunk: Uint8Array): Buffer[] {
    if (this.#failed) throw new Error("frame decoder failed");
    const frames: Buffer[] = [];
    let offset = 0;
    try {
      while (offset < chunk.byteLength) {
        if (this.#payload === undefined) {
          const headerCopy = Math.min(
            FRAME_HEADER_BYTES - this.#headerBytes,
            chunk.byteLength - offset,
          );
          this.#header.set(chunk.subarray(offset, offset + headerCopy), this.#headerBytes);
          this.#headerBytes += headerCopy;
          offset += headerCopy;
          if (this.#headerBytes < FRAME_HEADER_BYTES) continue;
          const length = this.#header.readUInt32BE(0);
          if (length === 0 || length > this.#maxFrameBytes) {
            throw new Error("invalid frame length");
          }
          this.#onPayloadAllocation?.(length);
          this.#payload = Buffer.allocUnsafeSlow(length);
          this.#payloadBytes = 0;
        }
        const payloadCopy = Math.min(
          this.#payload.byteLength - this.#payloadBytes,
          chunk.byteLength - offset,
        );
        this.#payload.set(
          chunk.subarray(offset, offset + payloadCopy),
          this.#payloadBytes,
        );
        this.#payloadBytes += payloadCopy;
        offset += payloadCopy;
        if (this.#payloadBytes === this.#payload.byteLength) {
          frames.push(this.#payload);
          this.#payload = undefined;
          this.#payloadBytes = 0;
          this.#headerBytes = 0;
        }
      }
      return frames;
    } catch (error: unknown) {
      this.#failed = true;
      this.#payload = undefined;
      throw error;
    }
  }

  finish(): void {
    if (this.#failed) throw new Error("frame decoder failed");
    if (this.#headerBytes !== 0 || this.#payload !== undefined) {
      this.#failed = true;
      this.#payload = undefined;
      throw new Error("partial frame at end of stream");
    }
  }
}

export function encodeBoundedJsonFrame(
  value: unknown,
  maxFrameBytes: number,
): Buffer {
  const json = JSON.stringify(value, (_key, candidate: unknown) => {
    if (candidate instanceof ArrayBuffer) {
      return {
        [BINARY_TAG]: Buffer.from(candidate).toString("base64"),
      };
    }
    return candidate;
  });
  if (json === undefined) throw new Error("frame value is not serializable");
  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength === 0 || payload.byteLength > maxFrameBytes) {
    throw new Error("invalid frame length");
  }
  const frame = Buffer.allocUnsafeSlow(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export function parseBoundedJsonFrame(payload: Uint8Array): unknown {
  return JSON.parse(Buffer.from(payload).toString("utf8"), (_key, candidate: unknown) => {
    if (!isTaggedArrayBuffer(candidate)) return candidate;
    const encoded = candidate[BINARY_TAG];
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new Error("invalid binary frame payload");
    }
    const decoded = Buffer.from(encoded, "base64");
    const exact = new Uint8Array(decoded.byteLength);
    exact.set(decoded);
    return exact.buffer;
  });
}

function isTaggedArrayBuffer(
  value: unknown,
): value is Record<typeof BINARY_TAG, string> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === BINARY_TAG &&
    typeof (value as Record<string, unknown>)[BINARY_TAG] === "string";
}
