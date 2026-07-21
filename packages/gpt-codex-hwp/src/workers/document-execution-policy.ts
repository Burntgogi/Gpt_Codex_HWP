import type {
  DocumentSnapshot,
  SpoolDocumentSnapshot,
  WorkerDocumentSnapshot,
} from "../shared/document-snapshot.js";
import {
  createDocumentEngineRunError,
  type DocumentEngineRunError,
} from "./document-errors.js";
import {
  documentLogicalRequestBytes,
  MAX_WORKER_INPUT_BYTES,
  type DocumentLogicalRequestContent,
  type DocumentEngineOperation,
  type DocumentResultSpoolEncoding,
  type DocumentResultPayload,
  type DocumentSpoolEligibleOperation,
  type LogicalDocumentRequest,
  type SafeJsonValue,
} from "./document-protocol.js";

export { documentLogicalRequestBytes };
export type { DocumentLogicalRequestContent };

export const WORKER_INPUT_MAX_BYTES = MAX_WORKER_INPUT_BYTES;
export const CHILD_WORKING_SET_MAX_BYTES = 1_536 * 1024 * 1024;

export type DocumentExecutionClass = "worker-safe" | "heavy";
export type DocumentExecutionTransport = "worker" | "child";

export interface DocumentExecutionSelection {
  readonly operation: DocumentEngineOperation;
  readonly snapshotTransport: "worker" | "spool" | "none";
  readonly inputBytes: number;
  readonly imageBytes?: number;
  readonly logicalBytes?: number;
  readonly estimatedWorkingSetBytes: number;
  readonly executionClass: DocumentExecutionClass;
}

export function maxWorkerSnapshotBytesForRequest(
  request: DocumentLogicalRequestContent,
  imageBytes = 0,
): number {
  const reservedBytes = checkedByteSum(
    documentLogicalRequestBytes(request),
    imageBytes,
  );
  return Math.max(0, WORKER_INPUT_MAX_BYTES - reservedBytes);
}

export interface DocumentEngineRunOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly onProgress?: (completed: number, total: number) => void;
  readonly onMetrics?: (metrics: DocumentEngineMetrics) => void;
  readonly executionClass?: DocumentExecutionClass;
  readonly estimatedWorkingSetBytes?: number;
  readonly imageInput?: Readonly<
    | { transport: "buffer"; buffer: ArrayBuffer }
    | { transport: "spool"; fd: number; sizeBytes: number }
  >;
}

export interface DocumentEngineMetrics {
  readonly copiedBytes: number;
}

export interface IntegrityVerifiedResultSpool<
  Operation extends DocumentEngineOperation = DocumentEngineOperation,
> {
  readonly transport: "spool";
  readonly metadata: Readonly<{
    operation: Operation;
    encoding: DocumentResultSpoolEncoding;
    sizeBytes: number;
    sha256: string;
    resultMetadata?: SafeJsonValue;
  }>;
  takeHandle(): Readonly<{ fd: number; sizeBytes: number }>;
  cleanup(): Promise<void>;
}

export type IsolatedDocumentResult<Operation extends DocumentEngineOperation> =
  | DocumentResultPayload<Operation>
  | (Operation extends DocumentSpoolEligibleOperation
    ? IntegrityVerifiedResultSpool<Operation>
    : never);

export type SnapshotForOperation<
  Operation extends DocumentEngineOperation,
  Snapshot extends DocumentSnapshot,
> = Operation extends "generateHwpx" ? undefined : Snapshot;

export interface DocumentEngineClient<
  Snapshot extends DocumentSnapshot = DocumentSnapshot,
> {
  readonly concurrencyManaged?: true;
  run<Operation extends DocumentEngineOperation>(
    request: Extract<LogicalDocumentRequest, { operation: Operation }>,
    snapshot: SnapshotForOperation<Operation, Snapshot>,
    options?: DocumentEngineRunOptions,
  ): Promise<IsolatedDocumentResult<Operation>>;
}

export interface IsolatedDocumentEngine {
  run<Operation extends DocumentEngineOperation>(
    request: Extract<LogicalDocumentRequest, { operation: Operation }>,
    snapshot: SnapshotForOperation<Operation, DocumentSnapshot>,
    options?: DocumentEngineRunOptions,
  ): Promise<IsolatedDocumentResult<Operation>>;
}

export interface IsolatedDocumentEngineDependencies {
  readonly workerClient: DocumentEngineClient<WorkerDocumentSnapshot>;
  readonly childClient: DocumentEngineClient<SpoolDocumentSnapshot>;
  readonly heavyChildGate?: HeavyChildGate;
}

export function defaultDocumentDeadlineMs(
  operation: DocumentEngineOperation,
): number {
  return operation === "detect" ||
      operation === "parse" ||
      operation === "validateHwpx"
    ? 60_000
    : 300_000;
}

export function selectDocumentExecution(
  selection: DocumentExecutionSelection,
): DocumentExecutionTransport {
  requireSafeNonNegativeInteger(selection.inputBytes);
  requireSafeNonNegativeInteger(selection.imageBytes ?? 0);
  requireSafeNonNegativeInteger(selection.logicalBytes ?? 0);
  requireSafeNonNegativeInteger(selection.estimatedWorkingSetBytes);
  const aggregateInputBytes = checkedByteSum(
    selection.inputBytes,
    selection.imageBytes ?? 0,
    selection.logicalBytes ?? 0,
  );
  const effectiveWorkingSetBytes = Math.max(
    checkedByteProduct(aggregateInputBytes, 3),
    selection.estimatedWorkingSetBytes,
  );
  if (effectiveWorkingSetBytes > CHILD_WORKING_SET_MAX_BYTES) {
    throw resourceLimitError();
  }
  if (selection.executionClass === "heavy") {
    if (selection.snapshotTransport === "worker") throw resourceLimitError();
    return "child";
  }
  if (selection.snapshotTransport === "spool") {
    return "child";
  }
  if (
    selection.snapshotTransport === "worker" &&
    aggregateInputBytes > WORKER_INPUT_MAX_BYTES
  ) {
    throw resourceLimitError();
  }
  return "worker";
}

export function createIsolatedDocumentEngine(
  dependencies: IsolatedDocumentEngineDependencies,
): IsolatedDocumentEngine {
  const gate = dependencies.heavyChildGate ?? new HeavyChildGate();
  return {
    async run<Operation extends DocumentEngineOperation>(
      request: Extract<LogicalDocumentRequest, { operation: Operation }>,
      snapshot: DocumentSnapshot | undefined,
      options: DocumentEngineRunOptions = {},
    ): Promise<IsolatedDocumentResult<Operation>> {
      const startedAt = Date.now();
      if (
        (request.operation === "generateHwpx" && snapshot !== undefined) ||
        (request.operation !== "generateHwpx" && snapshot === undefined)
      ) {
        await cleanupOnPreDispatch(snapshot);
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
      }
      if (options.signal?.aborted === true) {
        await cleanupOnPreDispatch(snapshot);
        throw createDocumentEngineRunError("REQUEST_CANCELLED");
      }
      const inputBytes = snapshot?.metadata.sizeBytes ?? 0;
      const imageBytes = options.imageInput?.transport === "buffer"
        ? options.imageInput.buffer.byteLength
        : options.imageInput?.sizeBytes ?? 0;
      let logicalBytes: number;
      let aggregateInputBytes: number;
      let estimatedWorkingSetBytes: number;
      let selected: DocumentExecutionTransport;
      try {
        logicalBytes = documentLogicalRequestBytes(request);
        aggregateInputBytes = checkedByteSum(
          inputBytes,
          imageBytes,
          logicalBytes,
        );
        estimatedWorkingSetBytes = Math.max(
          checkedByteProduct(aggregateInputBytes, 3),
          options.estimatedWorkingSetBytes ?? 0,
        );
        selected = selectDocumentExecution({
          operation: request.operation,
          snapshotTransport: snapshot?.transport ?? "none",
          inputBytes,
          imageBytes,
          logicalBytes,
          estimatedWorkingSetBytes,
          executionClass: request.operation === "insertImage"
            ? "heavy"
            : options.executionClass ?? "worker-safe",
        });
      } catch (error: unknown) {
        await cleanupOnPreDispatch(snapshot);
        throw error;
      }

      const client = selected === "worker"
        ? dependencies.workerClient
        : dependencies.childClient;
      if (selected !== "child" || client.concurrencyManaged === true) {
        return runSelectedClient(client, request, snapshot, options);
      }
      const deadlineMs = options.deadlineMs ??
        defaultDocumentDeadlineMs(request.operation);
      let release: () => void;
      try {
        release = await gate.acquire(options.signal, deadlineMs);
      } catch (error: unknown) {
        await cleanupOnPreDispatch(snapshot);
        throw error;
      }
      const remainingDeadlineMs = deadlineMs - (Date.now() - startedAt);
      if (remainingDeadlineMs <= 0) {
        release();
        await cleanupOnPreDispatch(snapshot);
        throw createDocumentEngineRunError("ENGINE_TIMEOUT");
      }
      try {
        return await runSelectedClient(client, request, snapshot, {
          ...options,
          deadlineMs: remainingDeadlineMs,
        });
      } finally {
        release();
      }
    },
  };
}

function runSelectedClient<Operation extends DocumentEngineOperation>(
  client: DocumentEngineClient,
  request: Extract<LogicalDocumentRequest, { operation: Operation }>,
  snapshot: DocumentSnapshot | undefined,
  options: DocumentEngineRunOptions,
): Promise<IsolatedDocumentResult<Operation>> {
  const run = client.run as unknown as (
    request: Extract<LogicalDocumentRequest, { operation: Operation }>,
    snapshot: DocumentSnapshot | undefined,
    options: DocumentEngineRunOptions,
  ) => Promise<IsolatedDocumentResult<Operation>>;
  return run(request, snapshot, options);
}

interface GateWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: DocumentEngineRunError) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
  deadlineTimer?: NodeJS.Timeout;
  active: boolean;
}

export class HeavyChildGate {
  #active = 0;
  readonly #waiters: GateWaiter[] = [];

  get activeCount(): number {
    return this.#active;
  }

  get queuedCount(): number {
    return this.#waiters.length;
  }

  async acquire(
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<() => void> {
    if (signal?.aborted === true) {
      throw createDocumentEngineRunError("REQUEST_CANCELLED");
    }
    if (this.#active === 0) {
      this.#active = 1;
      return this.#releaseOnce();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: GateWaiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        active: true,
      };
      if (signal !== undefined) {
        waiter.abort = () => {
          if (!waiter.active) return;
          waiter.active = false;
          this.#removeWaiter(waiter);
          this.#clearWaiter(waiter);
          reject(createDocumentEngineRunError("REQUEST_CANCELLED"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#waiters.push(waiter);
      if (deadlineMs !== undefined) {
        waiter.deadlineTimer = setTimeout(() => {
          if (!waiter.active) return;
          waiter.active = false;
          this.#removeWaiter(waiter);
          this.#clearWaiter(waiter);
          reject(createDocumentEngineRunError("ENGINE_TIMEOUT"));
        }, deadlineMs);
        waiter.deadlineTimer.unref();
      }
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active = 0;
      while (this.#waiters.length > 0) {
        const waiter = this.#waiters.shift()!;
        if (!waiter.active) continue;
        waiter.active = false;
        this.#clearWaiter(waiter);
        this.#active = 1;
        waiter.resolve(this.#releaseOnce());
        break;
      }
    };
  }

  #removeWaiter(waiter: GateWaiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
  }

  #clearWaiter(waiter: GateWaiter): void {
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
    if (waiter.deadlineTimer !== undefined) {
      clearTimeout(waiter.deadlineTimer);
    }
  }
}

async function cleanupOnPreDispatch(
  snapshot: DocumentSnapshot | undefined,
): Promise<void> {
  if (snapshot !== undefined) await snapshot.cleanup();
}

function requireSafeNonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw resourceLimitError();
}

function checkedByteSum(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    requireSafeNonNegativeInteger(value);
    if (value > Number.MAX_SAFE_INTEGER - total) throw resourceLimitError();
    total += value;
  }
  return total;
}

function checkedByteProduct(value: number, multiplier: number): number {
  requireSafeNonNegativeInteger(value);
  requireSafeNonNegativeInteger(multiplier);
  if (value !== 0 && multiplier > Math.floor(Number.MAX_SAFE_INTEGER / value)) {
    throw resourceLimitError();
  }
  return value * multiplier;
}

function resourceLimitError(): DocumentEngineRunError {
  return createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
    remediation: "reduce_input",
  });
}
