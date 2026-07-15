import {
  parentPort,
  type Transferable as WorkerTransferable,
} from "node:worker_threads";

import {
  DOCUMENT_ENGINE_ERROR_MESSAGES,
  isDocumentEngineRunError,
  normalizeDocumentEngineError,
  type DocumentEnginePublicError,
} from "./document-errors.js";
import {
  initializeDocumentComputeBackend,
  type DocumentComputeProgress,
} from "./document-compute-backend.js";
import {
  DOCUMENT_PROTOCOL_VERSION,
  measureDocumentResultByteLength,
  type DocumentEngineOperation,
  type DocumentResultPayload,
  type WireDocumentRequest,
  validateWireDocumentRequest,
} from "./document-protocol.js";

if (parentPort === null) throw new Error("document worker requires a parent port");

const port = parentPort;
let accepted = false;

port.on("message", (value: unknown) => {
  if (accepted) return;
  accepted = true;
  void run(value);
});

async function run(value: unknown): Promise<void> {
  let request: WireDocumentRequest;
  try {
    request = validateWireDocumentRequest(value);
  } catch {
    throw new Error("invalid document worker request");
  }

  let ready = false;
  try {
    const backend = await initializeDocumentComputeBackend();
    port.postMessage(event(request, "ready"));
    ready = true;
    const inputs = transferredInputs(request);
    const payload = await backend.execute(
      request as never,
      inputs,
      (progress) => postProgress(request, progress),
    );
    const outputByteLength = measureDocumentResultByteLength(
      request.operation,
      payload,
    );
    port.postMessage(
      {
        ...event(request, "result"),
        payload,
        outputByteLength,
      },
      transferableResults(request.operation, payload),
    );
  } catch (error: unknown) {
    port.postMessage({
      ...event(request, "failure"),
      error: publicError(error, ready, request.operation),
    });
  }
}

function transferredInputs(request: WireDocumentRequest): Readonly<{
  document?: ArrayBuffer;
  image?: ArrayBuffer;
}> {
  if (request.operation === "generateHwpx") return {};
  if (request.input.document.transport !== "buffer") {
    throw new Error("worker document input is not transferred");
  }
  if (request.operation !== "insertImage") {
    return { document: request.input.document.buffer };
  }
  if (request.input.image.transport !== "buffer") {
    throw new Error("worker image input is not transferred");
  }
  return {
    document: request.input.document.buffer,
    image: request.input.image.buffer,
  };
}

function transferableResults(
  operation: DocumentEngineOperation,
  payload: DocumentResultPayload<DocumentEngineOperation>,
): WorkerTransferable[] {
  if (operation === "parse") {
    return (payload as DocumentResultPayload<"parse">).images.map(
      (image) => image.bytes,
    );
  }
  if (
    operation === "generateHwpx" || operation === "patchHwpx" ||
    operation === "fillHwpx" || operation === "insertImage"
  ) {
    return [(payload as DocumentResultPayload<"generateHwpx">).bytes];
  }
  return [];
}

function postProgress(
  request: WireDocumentRequest,
  progress: DocumentComputeProgress,
): void {
  if (progress.stage !== request.operation) return;
  port.postMessage({
    ...event(request, "progress"),
    completed: progress.completed,
    total: progress.total,
  });
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
