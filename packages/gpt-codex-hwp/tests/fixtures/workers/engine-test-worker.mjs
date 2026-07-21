import { parentPort, workerData } from "node:worker_threads";

const mode = workerData?.mode ?? "success";
const delayMs = Number.isInteger(workerData?.delayMs) ? workerData.delayMs : 250;
const lateDelayMs = Number.isInteger(workerData?.lateDelayMs)
  ? workerData.lateDelayMs
  : 25;

if (parentPort === null) throw new Error("worker fixture requires parentPort");

if (mode === "crash-before-ready") {
  throw new Error("fixture startup crash: C:\\private\\document.hwp");
}

parentPort.once("message", (request) => {
  if (mode === "failure-before-ready") {
    parentPort.postMessage({
      ...event(request, "failure"),
      error: {
        code: "ENGINE_CRASH",
        message: "The document engine stopped unexpectedly.",
      },
    });
    return;
  }
  if (mode === "malformed") {
    parentPort.postMessage({ type: "ready", privatePath: "C:\\private" });
    return;
  }

  parentPort.postMessage(event(request, "ready"));

  if (mode === "crash-after-ready") {
    throw new Error("fixture engine crash: SECRET_DOCUMENT_FRAGMENT");
  }
  if (mode === "oom") {
    throw new Error("Reached heap limit Allocation failed - JavaScript heap out of memory");
  }
  if (mode === "slow" || mode === "ignore-abort") {
    setTimeout(() => sendResult(request), delayMs);
    return;
  }
  if (mode === "progress") {
    parentPort.postMessage({ ...event(request, "progress"), completed: 1, total: 3 });
    parentPort.postMessage({ ...event(request, "progress"), completed: 2, total: 3 });
  }
  if (mode === "late-result") {
    sendResult(request);
    setTimeout(() => sendResult(request), lateDelayMs);
    return;
  }
  sendResult(request);
});

function event(request, type) {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    type,
  };
}

function sendResult(request) {
  const payload = resultPayload(request.operation);
  parentPort.postMessage({
    ...event(request, "result"),
    payload,
    outputByteLength: resultByteLength(request.operation, payload),
  });
}

function resultPayload(operation) {
  switch (operation) {
    case "detect":
      return { format: "unknown" };
    case "parse":
      return { markdown: "", fileType: "hwpx", warnings: [], images: [] };
    case "render":
      return { svg: "" };
    case "generateHwpx":
    case "patchHwpx":
    case "fillHwpx":
    case "insertImage":
      return { bytes: new ArrayBuffer(0) };
    case "validateHwpx":
      return { ok: true, issues: [], entryCount: 0 };
    default:
      throw new Error("unsupported fixture operation");
  }
}

function resultByteLength(operation, payload) {
  switch (operation) {
    case "detect":
      return Buffer.byteLength(payload.format);
    case "parse":
      return 6;
    case "render":
      return 0;
    case "generateHwpx":
    case "patchHwpx":
    case "fillHwpx":
    case "insertImage":
      return payload.bytes.byteLength;
    case "validateHwpx":
      return 38;
  }
}
