import { Worker, type ResourceLimits, type WorkerOptions } from "node:worker_threads";

import type { WorkerDocumentSnapshot } from "../shared/document-snapshot.js";
import {
  DocumentEngineRunError,
  createDocumentEngineRunError,
  normalizeDocumentEngineError,
} from "./document-errors.js";
import type {
  DocumentEngineClient,
  DocumentEngineRunOptions,
} from "./document-execution-policy.js";
import {
  createDocumentEventValidator,
  createWireDocumentRequest,
  documentWorkerRequestBytes,
  MAX_WORKER_INPUT_BYTES,
  type DocumentEngineOperation,
  type DocumentResultPayload,
  type LogicalDocumentRequest,
  validateLogicalDocumentRequest,
} from "./document-protocol.js";
import { defaultDocumentDeadlineMs } from "./document-execution-policy.js";

export const DOCUMENT_WORKER_RESOURCE_LIMITS: Readonly<ResourceLimits> =
  Object.freeze({
    maxOldGenerationSizeMb: 768,
    maxYoungGenerationSizeMb: 64,
    codeRangeSizeMb: 64,
    stackSizeMb: 8,
  });

export interface DocumentWorkerLike {
  readonly stdout?: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  off(event: "message", listener: (value: unknown) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number) => void): this;
  postMessage(value: unknown, transferList?: readonly Transferable[]): void;
  terminate(): Promise<number>;
}

export interface DocumentWorkerClientDependencies {
  readonly workerFactory?: (options: WorkerOptions) => DocumentWorkerLike;
  readonly terminationDeadlineMs?: number;
}

export function createDocumentWorkerClient(
  dependencies: DocumentWorkerClientDependencies = {},
): DocumentEngineClient<WorkerDocumentSnapshot> {
  const workerFactory = dependencies.workerFactory ?? ((options: WorkerOptions) =>
    new Worker(new URL("./document-worker.js", import.meta.url), options));
  const terminationDeadlineMs = dependencies.terminationDeadlineMs ?? 2_000;

  return {
    async run<Operation extends DocumentEngineOperation>(
      request: Extract<LogicalDocumentRequest, { operation: Operation }>,
      snapshot: WorkerDocumentSnapshot | undefined,
      options: DocumentEngineRunOptions = {},
    ): Promise<DocumentResultPayload<Operation>> {
      const requestStartedAt = Date.now();
      try {
        validateLogicalDocumentRequest(request);
      } catch {
        await cleanupSnapshot(snapshot);
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
      }
      if (
        (request.operation === "generateHwpx" && snapshot !== undefined) ||
        (request.operation !== "generateHwpx" && snapshot?.transport !== "worker")
      ) {
        await cleanupUnknownSnapshot(snapshot);
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
      }
      if (options.signal?.aborted === true) {
        await cleanupSnapshot(snapshot);
        throw createDocumentEngineRunError("REQUEST_CANCELLED");
      }
      let deadlineMs: number;
      try {
        deadlineMs = normalizeDeadline(
          options.deadlineMs ?? defaultDocumentDeadlineMs(request.operation),
        );
      } catch (error: unknown) {
        await cleanupSnapshot(snapshot);
        throw error;
      }
      let preflight: WorkerRequestPreflight;
      try {
        preflight = workerRequestPreflight(request, snapshot, options);
      } catch (error: unknown) {
        await cleanupSnapshot(snapshot);
        if (error instanceof DocumentEngineRunError) throw error;
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
      }
      let worker: DocumentWorkerLike;
      try {
        worker = workerFactory({
          resourceLimits: { ...DOCUMENT_WORKER_RESOURCE_LIMITS },
          stdout: true,
          stderr: true,
        });
      } catch (error: unknown) {
        await cleanupSnapshot(snapshot);
        if (isSignalAborted(options.signal)) {
          throw createDocumentEngineRunError("REQUEST_CANCELLED");
        }
        if (Date.now() - requestStartedAt >= deadlineMs) {
          throw createDocumentEngineRunError("ENGINE_TIMEOUT");
        }
        throw new DocumentEngineRunError(normalizeDocumentEngineError(error, {
          ready: false,
          stage: "startup",
        }));
      }

      const remainingDeadlineMs = deadlineMs - (Date.now() - requestStartedAt);
      if (remainingDeadlineMs <= 0) {
        const terminated = await confirmWorkerTermination(
          worker,
          terminationDeadlineMs,
        );
        await cleanupSnapshot(snapshot);
        if (!terminated) {
          throw createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
            stage: "shutdown",
            remediation: "check_installation",
          });
        }
        throw createDocumentEngineRunError("ENGINE_TIMEOUT");
      }

      return runWorker(
        request,
        snapshot,
        options,
        remainingDeadlineMs,
        worker,
        terminationDeadlineMs,
        preflight,
      );
    },
  };
}

async function runWorker<Operation extends DocumentEngineOperation>(
  request: Extract<LogicalDocumentRequest, { operation: Operation }>,
  snapshot: WorkerDocumentSnapshot | undefined,
  options: DocumentEngineRunOptions,
  deadlineMs: number,
  worker: DocumentWorkerLike,
  terminationDeadlineMs: number,
  preflight: WorkerRequestPreflight,
): Promise<DocumentResultPayload<Operation>> {
  const startedAt = Date.now();
  const validator = createDocumentEventValidator(request.requestId, request.operation);
  let ready = false;
  let settling = false;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;

  return new Promise<DocumentResultPayload<Operation>>((resolve, reject) => {
    const onStdout = (chunk: Buffer): void => {
      stdoutBytes = Math.min(64 * 1024, stdoutBytes + chunk.byteLength);
    };
    const onStderr = (chunk: Buffer): void => {
      stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.byteLength);
    };
    worker.stdout?.on("data", onStdout);
    worker.stderr?.on("data", onStderr);
    const detachListeners = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (abortListener !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener("abort", abortListener);
      }
    };

    const settle = (
      outcome:
        | { readonly result: DocumentResultPayload<Operation> }
        | { readonly error: unknown; readonly terminationReason?: "deadline" | "abort" },
    ): void => {
      if (settling) return;
      settling = true;
      detachListeners();
      void (async () => {
        let terminalError = "error" in outcome ? outcome.error : undefined;
        const termination = beginWorkerTermination(worker, terminationDeadlineMs);
        const terminationOutcome = await termination.outcome;
        if (terminationOutcome !== "confirmed") {
          if (terminationOutcome === "timeout") {
            void termination.receipt.then(async (lateOutcome) => {
              if (lateOutcome !== "confirmed") return;
              worker.stdout?.off("data", onStdout);
              worker.stderr?.off("data", onStderr);
              try { await cleanupSnapshot(snapshot); } catch {}
            });
          }
          reject(createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
            stage: "shutdown",
            remediation: "check_installation",
          }));
          return;
        }
        worker.stdout?.off("data", onStdout);
        worker.stderr?.off("data", onStderr);
        try {
          await cleanupSnapshot(snapshot);
        } catch (error: unknown) {
          terminalError ??= error;
        }

        if (terminalError !== undefined) {
          if (terminalError instanceof DocumentEngineRunError) {
            reject(terminalError);
            return;
          }
          reject(new DocumentEngineRunError(normalizeDocumentEngineError(
            terminalError,
            {
              ready,
              ...(!("terminationReason" in outcome) || outcome.terminationReason === undefined
                ? {}
                : { terminationReason: outcome.terminationReason }),
              stage: ready ? request.operation : "startup",
              elapsedMs: Math.max(0, Date.now() - startedAt),
            },
          )));
          return;
        }
        resolve((outcome as { result: DocumentResultPayload<Operation> }).result);
      })();
    };

    const onMessage = (value: unknown): void => {
      if (settling) return;
      try {
        const event = validator.accept(value);
        if (event.type === "ready") {
          ready = true;
          return;
        }
        if (event.type === "progress") {
          options.onProgress?.(event.completed, event.total);
          return;
        }
        if (event.type === "failure") {
          settle({
            error: event.error.code === "ENGINE_OOM" || ready
              ? new DocumentEngineRunError(event.error)
              : createDocumentEngineRunError("ENGINE_INIT_FAILED", {
                  stage: "startup",
                }),
          });
          return;
        }
        settle({ result: event.payload });
      } catch (error: unknown) {
        settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
      }
    };
    const onError = (error: Error): void => settle({ error });
    const onExit = (code: number): void => {
      if (!settling) settle({ error: new Error(`worker exit ${code}`) });
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    abortListener = () => settle({
      error: new Error("cancelled"),
      terminationReason: "abort",
    });
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.signal?.aborted === true) {
      abortListener();
      return;
    }
    deadlineTimer = setTimeout(() => settle({
      error: new Error("deadline"),
      terminationReason: "deadline",
    }), deadlineMs);
    deadlineTimer.unref();

    try {
      const transports: Record<string, unknown> = {};
      const transferList: Transferable[] = [];
      let actualDocumentBytes = 0;
      let actualImageBytes = 0;
      if (request.operation !== "generateHwpx") {
        if (snapshot?.transport !== "worker") {
          throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
        }
        const buffer = snapshot.takeTransferable();
        actualDocumentBytes = buffer.byteLength;
        if (actualDocumentBytes !== preflight.documentBytes) {
          throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
        }
        transports.document = { transport: "buffer", buffer };
        transferList.push(buffer);
      }
      if (request.operation === "insertImage") {
        if (options.imageInput?.transport !== "buffer") {
          throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
        }
        actualImageBytes = options.imageInput.buffer.byteLength;
        if (actualImageBytes !== preflight.imageBytes) {
          throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
        }
        if (transferList.includes(options.imageInput.buffer)) {
          throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
        }
        transports.image = {
          transport: "buffer",
          buffer: options.imageInput.buffer,
        };
        transferList.push(options.imageInput.buffer);
      }
      const actualBytes = documentWorkerRequestBytes(
        { input: request.input, options: request.options },
        actualDocumentBytes,
        actualImageBytes,
      );
      if (actualBytes !== preflight.aggregateBytes || actualBytes > MAX_WORKER_INPUT_BYTES) {
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
      }
      let wire;
      try {
        wire = createWireDocumentRequest(request, transports, "worker");
      } catch {
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
      }
      worker.postMessage(wire, transferList);
    } catch (error: unknown) {
      settle({ error });
    }
  });
}

interface WorkerRequestPreflight {
  readonly documentBytes: number;
  readonly imageBytes: number;
  readonly aggregateBytes: number;
}

function workerRequestPreflight(
  request: LogicalDocumentRequest,
  snapshot: WorkerDocumentSnapshot | undefined,
  options: DocumentEngineRunOptions,
): WorkerRequestPreflight {
  const documentBytes = request.operation === "generateHwpx"
    ? 0
    : snapshot?.metadata.sizeBytes ?? Number.NaN;
  let imageBytes = 0;
  if (request.operation === "insertImage") {
    if (options.imageInput?.transport !== "buffer") {
      throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
    }
    imageBytes = options.imageInput.buffer.byteLength;
  }
  const aggregateBytes = documentWorkerRequestBytes(
    { input: request.input, options: request.options },
    documentBytes,
    imageBytes,
  );
  if (aggregateBytes > MAX_WORKER_INPUT_BYTES) {
    throw createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
      remediation: "reduce_input",
    });
  }
  return Object.freeze({ documentBytes, imageBytes, aggregateBytes });
}

type WorkerTerminationOutcome = "confirmed" | "rejected" | "timeout";

function beginWorkerTermination(
  worker: DocumentWorkerLike,
  deadlineMs: number,
): {
  readonly receipt: Promise<Exclude<WorkerTerminationOutcome, "timeout">>;
  readonly outcome: Promise<WorkerTerminationOutcome>;
} {
  let termination: Promise<number>;
  try {
    termination = worker.terminate();
  } catch {
    const receipt = Promise.resolve("rejected" as const);
    return { receipt, outcome: receipt };
  }
  const receipt = termination.then(
    () => "confirmed" as const,
    () => "rejected" as const,
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  const outcome = Promise.race([receipt, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return { receipt, outcome };
}

async function confirmWorkerTermination(
  worker: DocumentWorkerLike,
  deadlineMs: number,
): Promise<boolean> {
  return (await beginWorkerTermination(worker, deadlineMs).outcome) === "confirmed";
}

function normalizeDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
      remediation: "reduce_input",
    });
  }
  return value;
}

async function cleanupSnapshot(
  snapshot: WorkerDocumentSnapshot | undefined,
): Promise<void> {
  if (snapshot !== undefined) await snapshot.cleanup();
}

async function cleanupUnknownSnapshot(
  snapshot: { cleanup(): Promise<void> } | undefined,
): Promise<void> {
  if (snapshot !== undefined) await snapshot.cleanup();
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
