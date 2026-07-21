import { parentPort, workerData } from "node:worker_threads";

if (parentPort === null || typeof workerData?.backendUrl !== "string") {
  process.exitCode = 1;
} else {
  let backendModule;
  try {
    backendModule = await import(workerData.backendUrl);
  } catch {
    parentPort.postMessage("backend-import");
  }
  if (backendModule !== undefined) {
    if (typeof backendModule.initializeDocumentComputeBackend !== "function") {
      parentPort.postMessage("backend-import");
    } else {
      try {
        await backendModule.initializeDocumentComputeBackend();
        parentPort.postMessage("BACKEND_READY");
      } catch {
        parentPort.postMessage("backend-init");
      }
    }
  }
}
