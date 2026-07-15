import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fstatSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BoundedFrameDecoder, encodeBoundedJsonFrame, parseBoundedJsonFrame } from "./bounded-frame.js";
import {
  encodeDocumentResultSpool,
  initializeDocumentComputeBackend,
  isRhwpCapabilityError,
  type DocumentComputeProgress,
} from "./document-compute-backend.js";
import {
  DOCUMENT_ENGINE_ERROR_MESSAGES,
  createDocumentEngineRunError,
  isDocumentEngineRunError,
  normalizeDocumentEngineError,
  type DocumentEnginePublicError,
} from "./document-errors.js";
import {
  DOCUMENT_PROTOCOL_VERSION,
  MAX_CHILD_INLINE_RESULT_BYTES,
  MAX_CHILD_REQUEST_FRAME_BYTES,
  MAX_DOCUMENT_ENGINE_RESULT_BYTES,
  createInlineDocumentResultEvent,
  measureDocumentResultByteLength,
  resultSpoolEncoding,
  type DocumentEngineOperation,
  type DocumentResultPayload,
  type DocumentSpoolEligibleOperation,
  type WireDocumentRequest,
  validateWireDocumentRequest,
} from "./document-protocol.js";

const CONTROL_DESCRIPTOR = 6;
const OUTPUT_DESCRIPTOR = 5;
const IMAGE_HELPER_CONTROL_BYTES = 64 * 1024;

void run();

async function run(): Promise<void> {
  let request: WireDocumentRequest;
  try {
    request = validateWireDocumentRequest(await readRequest());
  } catch {
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
    const payload = await backend.execute(
      request as never,
      inputs,
      (progress) => sendProgress(request, progress),
    );
    await sendResult(request, payload);
  } catch (error: unknown) {
    sendControl({
      ...event(request, "failure"),
      error: publicError(error, ready, request.operation),
    });
  }
}

async function runAfterParagraphInsert(
  request: Extract<WireDocumentRequest, { operation: "insertImage" }>,
  backend: Awaited<ReturnType<typeof initializeDocumentComputeBackend>>,
): Promise<void> {
  if (request.input.document.transport !== "spool" ||
    request.input.document.descriptor !== 3 ||
    request.input.image.transport !== "spool" ||
    request.input.image.descriptor !== 4) throw new Error("image inputs are not inherited");
  const source = readExact(3, request.input.document.sizeBytes);
  await backend.assertMutableHwpx(source);
  await runImageHelper(
    request,
    request.input.document.sizeBytes,
    request.input.image.sizeBytes,
  );
  const sizeBytes = fstatSync(OUTPUT_DESCRIPTOR).size;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 ||
    sizeBytes > MAX_DOCUMENT_ENGINE_RESULT_BYTES) throw new Error("result spool exceeds its limit");
  const output = readExact(OUTPUT_DESCRIPTOR, sizeBytes);
  await backend.validateExactHwpx(output);
  sendControl({
    ...event(request, "spoolResult"),
    receipt: {
      descriptor: OUTPUT_DESCRIPTOR,
      operation: "insertImage",
      encoding: "binary",
      sizeBytes,
      sha256: createHash("sha256").update(new Uint8Array(output)).digest("hex"),
    },
  });
}

async function runImageHelper(
  request: Extract<WireDocumentRequest, { operation: "insertImage" }>,
  sourceSize: number,
  imageSize: number,
): Promise<void> {
  const script = fileURLToPath(new URL(
    "../../scripts/hwpx-safe-edit/insert_image.py",
    import.meta.url,
  ));
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
    imageSize,
    anchorText: request.input.anchorText,
    occurrence: request.options.anchorOccurrence ?? 0,
    ...(request.options.sizeMm === undefined
      ? {}
      : { widthMm: request.options.sizeMm }),
  }, IMAGE_HELPER_CONTROL_BYTES);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const helper = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe", 3, 4, 5],
    });
    let outputBytes = 0;
    let errorBytes = 0;
    helper.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 64 * 1024) helper.kill();
    });
    helper.stderr?.on("data", (chunk: Buffer) => {
      errorBytes += chunk.byteLength;
      if (errorBytes > 64 * 1024) helper.kill();
    });
    helper.stdin?.on("error", () => undefined);
    helper.stdin?.end(control);
    helper.once("error", rejectPromise);
    helper.once("exit", (code) => {
      if (code === 0 && outputBytes <= 64 * 1024 && errorBytes <= 64 * 1024) {
        resolvePromise();
      } else {
        rejectPromise(createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR"));
      }
    });
  });
}

async function sendResult(
  request: WireDocumentRequest,
  payload: DocumentResultPayload<DocumentEngineOperation>,
): Promise<void> {
  const measured = measureDocumentResultByteLength(request.operation, payload);
  if (measured <= MAX_CHILD_INLINE_RESULT_BYTES) {
    try {
      const inline = createInlineDocumentResultEvent(
        request.requestId,
        request.operation,
        payload,
      );
      const frame = encodeBoundedJsonFrame(inline, MAX_CHILD_INLINE_RESULT_BYTES);
      writeAll(CONTROL_DESCRIPTOR, frame);
      return;
    } catch {
      if (request.operation === "detect" || request.operation === "validateHwpx") {
        throw new Error("inline result could not be framed");
      }
    }
  }
  if (request.operation === "detect" || request.operation === "validateHwpx") {
    throw new Error("inline-only result exceeds its limit");
  }
  const operation = request.operation as DocumentSpoolEligibleOperation;
  const encoded = encodeDocumentResultSpool(operation, payload as never);
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
    },
  });
}

function inheritedInputs(request: WireDocumentRequest): Readonly<{
  document?: ArrayBuffer;
  image?: ArrayBuffer;
}> {
  if (request.operation === "generateHwpx") return {};
  if (request.input.document.transport !== "spool" ||
    request.input.document.descriptor !== 3) {
    throw new Error("child document input is not inherited");
  }
  const document = readExact(3, request.input.document.sizeBytes);
  if (request.operation !== "insertImage") return { document };
  if (request.input.image.transport !== "spool" ||
    request.input.image.descriptor !== 4) {
    throw new Error("child image input is not inherited");
  }
  return {
    document,
    image: readExact(4, request.input.image.sizeBytes),
  };
}

function readExact(fd: number, sizeBytes: number): ArrayBuffer {
  const bytes = Buffer.allocUnsafeSlow(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const count = readSync(fd, bytes, offset, sizeBytes - offset, offset);
    if (count === 0) throw new Error("inherited input spool is truncated");
    offset += count;
  }
  const exact = new Uint8Array(sizeBytes);
  exact.set(bytes);
  return exact.buffer;
}

function readRequest(): Promise<unknown> {
  const decoder = new BoundedFrameDecoder(MAX_CHILD_REQUEST_FRAME_BYTES);
  return new Promise((resolvePromise, rejectPromise) => {
    let accepted = false;
    let parsed: unknown;
    process.stdin.on("data", (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 1 || (accepted && frames.length > 0)) {
          throw new Error("multiple request frames");
        }
        if (frames.length === 1) {
          accepted = true;
          parsed = parseBoundedJsonFrame(frames[0]!);
        }
      } catch (error: unknown) {
        rejectPromise(error);
      }
    });
    process.stdin.on("end", () => {
      try {
        decoder.finish();
        if (!accepted) rejectPromise(new Error("missing request frame"));
        else resolvePromise(parsed);
      } catch (error: unknown) {
        rejectPromise(error);
      }
    });
    process.stdin.on("error", rejectPromise);
  });
}

function sendProgress(
  request: WireDocumentRequest,
  progress: DocumentComputeProgress,
): void {
  if (progress.stage !== request.operation) return;
  sendControl({
    ...event(request, "progress"),
    completed: progress.completed,
    total: progress.total,
  });
}

function sendControl(value: unknown): void {
  writeAll(
    CONTROL_DESCRIPTOR,
    encodeBoundedJsonFrame(value, MAX_CHILD_INLINE_RESULT_BYTES),
  );
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (count === 0) throw new Error("could not write isolate output");
    offset += count;
  }
}

function event(request: WireDocumentRequest, type: string): Readonly<{
  protocolVersion: typeof DOCUMENT_PROTOCOL_VERSION;
  requestId: string;
  type: string;
}> {
  return {
    protocolVersion: DOCUMENT_PROTOCOL_VERSION,
    requestId: request.requestId,
    type,
  };
}

function publicError(
  error: unknown,
  ready: boolean,
  operation: DocumentEngineOperation,
): DocumentEnginePublicError {
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
