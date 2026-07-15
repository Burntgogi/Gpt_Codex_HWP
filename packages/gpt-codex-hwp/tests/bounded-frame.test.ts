import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedFrameDecoder,
  encodeBoundedJsonFrame,
  parseBoundedJsonFrame,
} from "../src/workers/bounded-frame.js";
import { MAX_CHILD_REQUEST_FRAME_BYTES } from "../src/workers/document-protocol.js";

test("bounded frame decoder handles partial headers and payloads with one exact allocation", () => {
  const allocations: number[] = [];
  const decoder = new BoundedFrameDecoder(64, (bytes) => allocations.push(bytes));
  const frame = encodeBoundedJsonFrame({ ok: true }, 64);
  const decoded = [
    ...decoder.push(frame.subarray(0, 2)),
    ...decoder.push(frame.subarray(2, 5)),
    ...decoder.push(frame.subarray(5)),
  ];
  decoder.finish();
  assert.deepEqual(decoded.map(parseBoundedJsonFrame), [{ ok: true }]);
  assert.deepEqual(allocations, [11]);
});

test("bounded frame decoder rejects an oversized header before payload allocation", () => {
  const allocations: number[] = [];
  const decoder = new BoundedFrameDecoder(8 * 1024 * 1024, (bytes) => allocations.push(bytes));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(9 * 1024 * 1024);
  assert.throws(() => decoder.push(header), /frame length/u);
  assert.deepEqual(allocations, []);
});

test("bounded frame decoder handles multiple frames and rejects trailing partial data", () => {
  const decoder = new BoundedFrameDecoder(64);
  const first = encodeBoundedJsonFrame({ sequence: 1 }, 64);
  const second = encodeBoundedJsonFrame({ sequence: 2 }, 64);
  assert.deepEqual(
    decoder.push(Buffer.concat([first, second])).map(parseBoundedJsonFrame),
    [{ sequence: 1 }, { sequence: 2 }],
  );
  decoder.push(Buffer.from([0, 0]));
  assert.throws(() => decoder.finish(), /partial frame/u);
});

test("bounded JSON frames round-trip ArrayBuffer without Node structured clone", () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const frame = encodeBoundedJsonFrame({ bytes }, 128);
  const decoder = new BoundedFrameDecoder(128);
  const [payload] = decoder.push(frame);
  decoder.finish();
  const decoded = parseBoundedJsonFrame(payload!) as { bytes: ArrayBuffer };
  assert.deepEqual(new Uint8Array(decoded.bytes), new Uint8Array([1, 2, 3]));
});

test("bounded request frames preserve the five-million non-ASCII character contract", () => {
  assert.equal(MAX_CHILD_REQUEST_FRAME_BYTES, 32 * 1024 * 1024);
  const frame = encodeBoundedJsonFrame({
    protocolVersion: 1,
    requestId: "non-ascii-boundary",
    operation: "generateHwpx",
    input: { markdown: "가".repeat(5_000_000) },
    options: {},
  }, MAX_CHILD_REQUEST_FRAME_BYTES);
  assert.ok(frame.byteLength > 8 * 1024 * 1024);
  assert.ok(frame.byteLength <= MAX_CHILD_REQUEST_FRAME_BYTES + 4);
});
