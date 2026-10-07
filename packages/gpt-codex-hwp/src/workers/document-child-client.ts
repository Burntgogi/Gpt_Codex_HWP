import {
  execFile,
  spawn,
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { SpoolDocumentSnapshot } from "../shared/document-snapshot.js";
import { applyWindowsOwnerOnlyAcl } from "../shared/windows-owner-only-acl.js";
import {
  BoundedFrameDecoder,
  encodeBoundedJsonFrame,
  parseBoundedJsonFrame,
} from "./bounded-frame.js";
import {
  DocumentEngineRunError,
  createDocumentEngineRunError,
  normalizeDocumentEngineError,
} from "./document-errors.js";
import {
  defaultDocumentDeadlineMs,
  HeavyChildGate,
  type DocumentEngineClient,
  type DocumentEngineRunOptions,
  type IsolatedDocumentResult,
  type IntegrityVerifiedResultSpool,
} from "./document-execution-policy.js";
import {
  createChildDocumentEventValidator,
  createWireDocumentRequest,
  MAX_CHILD_INLINE_RESULT_BYTES,
  MAX_CHILD_REQUEST_FRAME_BYTES,
  type DocumentEngineOperation,
  type DocumentResultSpoolReceipt,
  type DocumentResultPayload,
  type LogicalDocumentRequest,
  validateLogicalDocumentRequest,
} from "./document-protocol.js";
import {
  DOCUMENT_START_FRAME,
  DOCUMENT_REGISTRATION_ENV,
} from "./document-process-registration.js";
import { publishDocumentChildTerminationReceipt } from "./document-child-termination-channel.js";
import {
  normalizeProcessTreeTerminationReceipt,
  unverifiedTermination,
  type ProcessTreeTerminationReceipt,
  type UnverifiedTerminationReason,
} from "./registered-process-supervisor.js";
import {
  MAX_DRAIN_ACCOUNTED_BYTES,
  observeChildProcessClose,
  resolveWindowsSystemExecutable,
  waitWithTimeout,
  type ChildLifecycleSupervisor,
  type ChildProcessCloseReceipt,
} from "./child-process-primitives.js";
import {
  createPosixProcessTreeSupervisor,
} from "./posix-process-telemetry.js";
import {
  createWindowsJobSupervisor,
  isGatedRootGoneError,
  isSupervisorHelperUnclosedError,
  type WindowsSupervisorHostedBoundary,
  type WindowsSupervisorHostedLateBoundary,
  type WindowsSupervisorHostedPhaseBoundary,
} from "./windows-job-supervisor-client.js";

export {
  observeChildProcessClose,
  resolveWindowsSystemExecutable,
  type ChildLifecycleSupervisor,
  type ChildProcessCloseReceipt,
} from "./child-process-primitives.js";
export {
  bindMacosProcessRecords,
  snapshotMacosIdentityTree,
} from "./macos-process-identity.js";
export {
  createPosixProcessTelemetryTrackerForTest,
  createPosixProcessTreeSupervisorForTest,
  snapshotLinuxProcessForTest,
  snapshotRegisteredPosixProcessGroupIdentity,
  type PosixProcessTelemetryTestRecord,
  type PosixProcessTelemetryTracker,
  type PosixProcessTreeSupervisorTestDependencies,
  type PosixTelemetryIntervalHandle,
} from "./posix-process-telemetry.js";
export {
  classifyWindowsSupervisorPreframeDiagnostic,
  cleanupWindowsSupervisorHelper,
  createJobHelperEnvironment,
  finalizeVerifiedWindowsSupervisor,
  isGatedRootGoneError,
  isSupervisorHelperUnclosedError,
  observeWindowsSupervisorLateReadyForTest,
  readWindowsSupervisorReadyFrameForTest,
  resolveWindowsJobSupervisorScript,
  type WindowsSupervisorHostedBoundary,
  type WindowsSupervisorHostedLateBoundary,
  type WindowsSupervisorHostedPhaseBoundary,
} from "./windows-job-supervisor-client.js";

const execFileAsync = promisify(execFile);
const TREE_KILL_GRACE_MS = 100;
const OUTPUT_SPOOL_PREFIX = "gpt-codex-hwp-result-";
const OUTPUT_SPOOL_FILENAME = "output.bin";
const OUTPUT_READ_CHUNK_BYTES = 1024 * 1024;

export interface DocumentChildSpawnSpecification {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

export interface DocumentChildClientDependencies {
  readonly childEntry?: string;
  readonly childArguments?: readonly string[];
  readonly startGateEntry?: string;
  readonly benchmarkRegistrationDescriptors?: Readonly<{
    writeFd: number;
    ackFd: number;
  }>;
  readonly spoolRoot?: string;
  readonly heavyChildGate?: HeavyChildGate;
  readonly spawnFactory?: (
    specification: DocumentChildSpawnSpecification,
  ) => ChildProcess;
  readonly treeTerminator?: (child: ChildProcess) => Promise<boolean>;
  readonly outputSpoolCleanupHooks?: Readonly<{
    unlink?: (path: string) => Promise<void>;
    rmdir?: (path: string) => Promise<void>;
  }>;
  /** Test seam: pauses after the private output spool is fully secured. */
  readonly outputSpoolReadyHook?: () => void | Promise<void>;
  readonly controlFrameAllocationObserver?: (bytes: number) => void;
  readonly jobSupervisorFactory?: (
    child: ChildProcess,
    readyDeadlineMs: number,
  ) => Promise<ChildLifecycleSupervisor>;
  readonly jobSupervisorFrameObserver?: (frame: string) => void;
  /** Test seam: explicitly orders a synthetic startup/request deadline. */
  readonly startupDeadlineSignalForTest?: Readonly<{
    observed(): boolean;
    wait(): Promise<void>;
  }>;
}

interface OutputSpoolOwner {
  readonly directoryPath: string;
  readonly filePath: string;
  readonly handle: FileHandle;
  readonly directoryDevice: bigint;
  readonly directoryInode: bigint;
  readonly fileDevice: bigint;
  readonly fileInode: bigint;
  handleClosed: boolean;
  cleaned: boolean;
  quarantinePath?: string;
  readonly cleanupUnlink: (path: string) => Promise<void>;
  readonly cleanupRmdir: (path: string) => Promise<void>;
}

interface StartGateOwner {
  readonly sendStart: (callback: (error?: Error | null) => void) => void;
  readonly close: () => void;
  started: boolean;
  closed: boolean;
  failure?: Error;
  settleStart?: (error?: unknown) => void;
}

type ProcessTreeTerminator = (
  child: ChildProcess,
) => Promise<ProcessTreeTerminationReceipt>;

interface ChildStartupCapture {
  readonly oomDetector: StreamingOomDetector;
  readonly drainReceipt: { stdoutBytes: number; stderrBytes: number };
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
  readonly terminal: {
    error?: Error;
    exit?: { code: number | null; signal: NodeJS.Signals | null };
    observedAt?: number;
  };
  readonly closeReceipt: Promise<ChildProcessCloseReceipt>;
  detachTerminal(): void;
  detachAll(): void;
}

type StartupTerminationReason = "deadline" | "abort";

interface StartupLifecycleState {
  readonly deadlineAt: number;
  terminationReason(): StartupTerminationReason | undefined;
  waitForTermination(): Promise<StartupTerminationReason>;
  handoffAbort(callback: () => void): void;
  dispose(): void;
}

type StartupPhaseOutcome<Value> =
  | Readonly<{ kind: "completed"; value: Value }>
  | Readonly<{ kind: "failed"; error: unknown }>
  | Readonly<{ kind: "terminated"; reason: StartupTerminationReason }>;

const verifiedResultSpools = new WeakSet<object>();

export function isIntegrityVerifiedResultSpool(
  value: unknown,
): value is IntegrityVerifiedResultSpool {
  return typeof value === "object" && value !== null &&
    verifiedResultSpools.has(value);
}

export function createDocumentChildClient(
  dependencies: DocumentChildClientDependencies = {},
): DocumentEngineClient<SpoolDocumentSnapshot> {
  const childEntry = dependencies.childEntry ?? fileURLToPath(
    new URL("./document-child.js", import.meta.url),
  );
  const childArguments = dependencies.childArguments ?? [];
  const startGateEntry = dependencies.startGateEntry ?? fileURLToPath(
    import.meta.url.endsWith(".ts")
      ? new URL("../../dist/workers/document-child-start-gate.js", import.meta.url)
      : new URL("./document-child-start-gate.js", import.meta.url),
  );
  if (!isAbsolute(startGateEntry)) {
    throw new Error("absolute document child start gate entry is required");
  }
  const gate = dependencies.heavyChildGate ?? new HeavyChildGate();
  const spawnFactory = dependencies.spawnFactory ?? ((specification) =>
    spawn(specification.command, [...specification.args], specification.options));
  const legacyTreeTerminator = dependencies.treeTerminator ?? terminateProcessTree;
  const fallbackTerminator: ProcessTreeTerminator = async (child) => {
    try {
      await legacyTreeTerminator(child);
    } catch {
      // Generic cleanup has no identity-bound proof authority.
    }
    return unverifiedTermination("termination");
  };

  return {
    concurrencyManaged: true,
    async run<Operation extends DocumentEngineOperation>(
      request: Extract<LogicalDocumentRequest, { operation: Operation }>,
      snapshot: SpoolDocumentSnapshot | undefined,
      options: DocumentEngineRunOptions = {},
    ): Promise<IsolatedDocumentResult<Operation>> {
      const requestStartedAt = performance.now();
      try {
        validateLogicalDocumentRequest(request);
      } catch {
        await cleanupSnapshot(snapshot);
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
      }
      if (
        (request.operation === "generateHwpx" && snapshot !== undefined) ||
        (request.operation !== "generateHwpx" && snapshot?.transport !== "spool")
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
      let release: (() => void) | undefined;
      try {
        release = await gate.acquire(options.signal, deadlineMs);
      } catch (error: unknown) {
        await cleanupSnapshot(snapshot);
        throw error;
      }

      let remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
      if (remainingDeadlineMs <= 0) {
        release();
        await cleanupSnapshot(snapshot);
        throw createDocumentEngineRunError("ENGINE_TIMEOUT");
      }

      const startupLifecycle = createStartupLifecycleState(
        options.signal,
        requestStartedAt + deadlineMs,
        dependencies.startupDeadlineSignalForTest,
      );
      const initialTerminationReason = startupLifecycle.terminationReason();
      if (initialTerminationReason !== undefined) {
        startupLifecycle.dispose();
        release();
        await cleanupSnapshot(snapshot);
        throw startupTerminationError(initialTerminationReason);
      }

      let outputOwner: OutputSpoolOwner | undefined;
      try {
        outputOwner = await createPrivateOutputSpool(
          dependencies.spoolRoot ?? tmpdir(),
          dependencies.outputSpoolCleanupHooks,
        );
        await dependencies.outputSpoolReadyHook?.();
      } catch (error: unknown) {
        const terminationReason = startupLifecycle.terminationReason();
        startupLifecycle.dispose();
        release();
        if (outputOwner !== undefined) await cleanupOutputSpool(outputOwner);
        await cleanupSnapshot(snapshot);
        if (terminationReason !== undefined) {
          throw startupTerminationError(terminationReason);
        }
        throw new DocumentEngineRunError(normalizeDocumentEngineError(error, {
          ready: false,
          stage: "startup",
        }));
      }

      remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
      const postSpoolTerminationReason = startupLifecycle.terminationReason();
      if (postSpoolTerminationReason !== undefined) {
        startupLifecycle.dispose();
        release();
        await cleanupOutputSpool(outputOwner);
        await cleanupSnapshot(snapshot);
        throw startupTerminationError(postSpoolTerminationReason);
      }

      let child: ChildProcess | undefined;
      let startGate: StartGateOwner | undefined;
      let startupCapture: ChildStartupCapture | undefined;
      try {
        const input = request.operation === "generateHwpx"
          ? undefined
          : requireSpool(snapshot);
        const imageInputFd = options.imageInput?.transport === "spool"
          ? options.imageInput.fd
          : undefined;
        const registrationDescriptors = dependencies.benchmarkRegistrationDescriptors === undefined
          ? []
          : [
              dependencies.benchmarkRegistrationDescriptors.writeFd,
              dependencies.benchmarkRegistrationDescriptors.ackFd,
            ];
        const stdio: StdioOptions = [
          "pipe", "pipe", "pipe",
          input?.fd ?? "ignore",
          imageInputFd ?? "ignore",
          outputOwner.handle.fd,
          "pipe",
          "pipe",
          ...registrationDescriptors,
        ];
        const specification: DocumentChildSpawnSpecification = {
          command: process.execPath,
          args: process.platform === "win32"
            ? [
                "--import",
                pathToFileURL(startGateEntry).href,
                childEntry,
                ...childArguments,
              ]
            : [startGateEntry, childEntry, ...childArguments],
          options: {
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            env: {
              ...minimalChildEnvironment(),
              [DOCUMENT_REGISTRATION_ENV]: dependencies.benchmarkRegistrationDescriptors === undefined
                ? "0"
                : "1",
            },
            stdio,
          },
        };
        const preSpawnTerminationReason = startupLifecycle.terminationReason();
        if (preSpawnTerminationReason !== undefined) {
          throw startupTerminationError(preSpawnTerminationReason);
        }
        child = spawnFactory(specification);
        startupCapture = createChildStartupCapture(child);
        startGate = requireStartGateOwner(child);
      } catch (error: unknown) {
        const terminationReason = startupLifecycle.terminationReason();
        if (child !== undefined) {
          closeStartGate(startGate);
          const capture = startupCapture ?? createChildStartupCapture(child);
          await terminateGatedChildByHandle(child, capture.closeReceipt);
          await cleanupFailedPreDispatch(
            child,
            snapshot,
            outputOwner,
            release,
            capture,
            startupLifecycle,
            startGate,
          );
          throw terminationFailedError();
        }
        startupLifecycle.dispose();
        release();
        await cleanupOutputSpool(outputOwner);
        await cleanupSnapshot(snapshot);
        if (terminationReason !== undefined) {
          throw startupTerminationError(terminationReason);
        }
        if (error instanceof DocumentEngineRunError) throw error;
        throw new DocumentEngineRunError(normalizeDocumentEngineError(error, {
          ready: false,
          stage: "startup",
        }));
      }

      const spawnedChild = child!;
      const childStartGate = startGate!;
      const childStartupCapture = startupCapture!;
      let supervisedTerminator: ProcessTreeTerminator = fallbackTerminator;
      const supervisorFactory = dependencies.jobSupervisorFactory ??
        (process.platform === "win32"
          ? (childProcess: ChildProcess, readyMs: number) =>
              createWindowsJobSupervisor(
                childProcess,
                readyMs,
                dependencies.jobSupervisorFrameObserver,
              )
          : (childProcess: ChildProcess) =>
              createPosixProcessTreeSupervisor(childProcess, process.platform));
      const supervisorPromise = Promise.resolve().then(() => supervisorFactory(
        spawnedChild,
        Math.min(5_000, remainingDeadlineMs),
      ));
      const supervisorOutcome = await waitForStartupPhase(
        supervisorPromise,
        startupLifecycle,
      );
      if (supervisorOutcome.kind === "failed") {
        closeStartGate(childStartGate);
        if (isSupervisorHelperUnclosedError(supervisorOutcome.error)) {
          retainUnverifiedPreDispatch(
            spawnedChild,
            snapshot,
            outputOwner,
            release,
            childStartupCapture,
            startupLifecycle,
            childStartGate,
          );
          throw terminationFailedError();
        }
        if (!isGatedRootGoneError(supervisorOutcome.error)) {
          await terminateGatedChildByHandle(spawnedChild, childStartupCapture.closeReceipt);
        }
        await cleanupFailedPreDispatch(
          spawnedChild,
          snapshot,
          outputOwner,
          release,
          childStartupCapture,
          startupLifecycle,
          childStartGate,
        );
        throw terminationFailedError();
      }
      if (supervisorOutcome.kind === "terminated") {
        closeStartGate(childStartGate);
        retainUntilLateSupervisor(
          supervisorPromise,
          spawnedChild,
          snapshot,
          outputOwner,
          release,
          childStartupCapture,
          startupLifecycle,
          childStartGate,
        );
        throw terminationFailedError();
      }
      supervisedTerminator = createVerifiedTerminator(
        supervisorOutcome.value,
        childStartGate,
      );

      remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
      if (startupLifecycle.terminationReason() !== undefined) {
        closeStartGate(childStartGate);
        return terminateExpiredStartup(
          spawnedChild,
          snapshot,
          outputOwner,
          release,
          supervisedTerminator,
          childStartupCapture,
          startupLifecycle,
          childStartGate,
        );
      }

      const startOutcome = await waitForStartupPhase(
        writeStartFrame(childStartGate),
        startupLifecycle,
      );
      if (startOutcome.kind === "terminated") {
        closeStartGate(childStartGate);
        return terminateExpiredStartup(
          spawnedChild,
          snapshot,
          outputOwner,
          release,
          supervisedTerminator,
          childStartupCapture,
          startupLifecycle,
          childStartGate,
        );
      }
      if (startOutcome.kind === "failed") {
        closeStartGate(childStartGate);
        const receipt = await terminateWithReceipt(
          supervisedTerminator,
          spawnedChild,
          "channel",
        );
        if (!receipt.gone) {
          scheduleCleanupAfterActualExit(
            spawnedChild,
            snapshot,
            outputOwner,
            release,
            childStartupCapture,
            supervisedTerminator,
            childStartGate,
          );
          startupLifecycle.dispose();
          throw terminationFailedError();
        }
        await cleanupFailedPreDispatch(
          spawnedChild,
          snapshot,
          outputOwner,
          release,
          childStartupCapture,
          startupLifecycle,
          childStartGate,
        );
        throw createDocumentEngineRunError("ENGINE_INIT_FAILED", { stage: "startup" });
      }

      remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
      if (startupLifecycle.terminationReason() !== undefined) {
        closeStartGate(childStartGate);
        return terminateExpiredStartup(
          spawnedChild,
          snapshot,
          outputOwner,
          release,
          supervisedTerminator,
          childStartupCapture,
          startupLifecycle,
          childStartGate,
        );
      }

      return runChild(
        request,
        snapshot,
        options,
        remainingDeadlineMs,
        spawnedChild,
        release,
        outputOwner,
        supervisedTerminator,
        dependencies.controlFrameAllocationObserver,
        childStartupCapture,
        startupLifecycle,
        childStartGate,
        dependencies.startupDeadlineSignalForTest,
      );
    },
  };
}

function requireStartGateOwner(child: ChildProcess): StartGateOwner {
  const stream = (
    child.stdio as unknown as Array<(
      NodeJS.WritableStream & { destroy(): void }
    ) | null | undefined>
  )[7];
  if (stream === null || stream === undefined ||
    typeof stream.write !== "function" || typeof stream.destroy !== "function") {
    throw new Error("document child start gate pipe unavailable");
  }
  let owner!: StartGateOwner;
  const onError = (error: Error): void => {
    owner.failure ??= error;
    owner.settleStart?.(error);
  };
  const onClose = (): void => {
    owner.closed = true;
    owner.failure ??= new Error("document child start gate closed");
    owner.settleStart?.(owner.failure);
    stream.removeListener("error", onError);
  };
  owner = {
    sendStart: (callback) => stream.write(DOCUMENT_START_FRAME, callback),
    close: () => stream.destroy(),
    started: false,
    closed: false,
  };
  stream.on("error", onError);
  stream.once("close", onClose);
  return owner;
}

async function writeStartFrame(owner: StartGateOwner): Promise<void> {
  if (owner.started || owner.closed) throw new Error("document child start gate unavailable");
  if (owner.failure !== undefined) throw owner.failure;
  owner.started = true;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (owner.settleStart === settle) owner.settleStart = undefined;
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    owner.settleStart = settle;
    try {
      owner.sendStart(settle);
    } catch (error: unknown) {
      settle(error);
    }
  });
}

function closeStartGate(owner: StartGateOwner | undefined): void {
  if (owner === undefined || owner.closed) return;
  owner.closed = true;
  owner.failure ??= new Error("document child start gate closed");
  owner.settleStart?.(owner.failure);
  try {
    owner.close();
  } catch {
    // Closing the private gate is best-effort after ownership has been retained.
  }
}

function waitForStartupPhase<Value>(
  phase: Promise<Value>,
  startupLifecycle: StartupLifecycleState,
): Promise<StartupPhaseOutcome<Value>> {
  return Promise.race([
    phase.then<StartupPhaseOutcome<Value>, StartupPhaseOutcome<Value>>(
      (value) => {
        const reason = startupLifecycle.terminationReason();
        return reason === undefined
          ? { kind: "completed", value }
          : { kind: "terminated", reason };
      },
      (error: unknown) => {
        const reason = startupLifecycle.terminationReason();
        return reason === undefined
          ? { kind: "failed", error }
          : { kind: "terminated", reason };
      },
    ),
    startupLifecycle.waitForTermination().then<StartupPhaseOutcome<Value>>(
      (reason) => ({ kind: "terminated", reason }),
    ),
  ]);
}

function retainUntilLateSupervisor(
  supervisorPromise: Promise<ChildLifecycleSupervisor>,
  child: ChildProcess,
  snapshot: SpoolDocumentSnapshot | undefined,
  outputOwner: OutputSpoolOwner,
  release: () => void,
  capture: ChildStartupCapture,
  startupLifecycle: StartupLifecycleState,
  startGate: StartGateOwner,
): void {
  const retention = { child, snapshot, outputOwner, release, capture, startGate };
  unsafeChildRetentions.add(retention);
  startupLifecycle.dispose();

  const finalizeGatedRoot = async (): Promise<void> => {
    const close = await capture.closeReceipt;
    if (close.error !== null) return;
    await drainCapturedChildStreams(child);
    closeStartGate(startGate);
    capture.detachAll();
    try {
      await cleanupSnapshot(snapshot);
      await cleanupOutputSpool(outputOwner);
      release();
      unsafeChildRetentions.delete(retention);
    } catch {
      // Exact root close is known, but owned-resource cleanup remains fail-closed.
    }
  };

  const finalizeWithProof = async (
    supervisor: ChildLifecycleSupervisor,
  ): Promise<void> => {
    const terminator = createVerifiedTerminator(supervisor, startGate);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const receipt = await terminateWithReceipt(terminator, child);
      if (!receipt.gone) {
        await unrefDelay(100);
        continue;
      }
      await drainCapturedChildStreams(child);
      closeStartGate(startGate);
      capture.detachAll();
      try {
        await cleanupSnapshot(snapshot);
        await cleanupOutputSpool(outputOwner);
        release();
        unsafeChildRetentions.delete(retention);
      } catch {
        // Fail closed: recognized absence is required but cleanup must also complete.
      }
      return;
    }
    // The provisional record deliberately retains ownership after unverified cleanup.
  };

  void supervisorPromise.then(
    (supervisor) => {
      void finalizeWithProof(supervisor).catch(() => {
        // A late supervisor failure leaves the provisional retention intact.
      });
    },
    (error: unknown) => {
      if (isGatedRootGoneError(error)) {
        void finalizeGatedRoot().catch(() => {
          // Exact root close is known, but owned-resource cleanup remains fail-closed.
        });
      }
      // Untyped late readiness rejection has no proof authority; retain fail-closed.
    },
  ).catch(() => {
    // Both handlers are non-throwing, but keep the terminal chain rejection-safe.
  });
}

function createVerifiedTerminator(
  supervisor: ChildLifecycleSupervisor,
  startGate: StartGateOwner,
): ProcessTreeTerminator {
  return async () => {
    const receipt = await terminateWithReceipt(
      async () => supervisor.terminate(),
      undefined,
    );
    if (receipt.gone) closeStartGate(startGate);
    return receipt;
  };
}

async function terminateWithReceipt(
  terminator: ProcessTreeTerminator,
  child: ChildProcess | undefined,
  failureReason: UnverifiedTerminationReason = "termination",
): Promise<ProcessTreeTerminationReceipt> {
  try {
    return normalizeProcessTreeTerminationReceipt(
      await terminator(child as ChildProcess),
      failureReason,
    );
  } catch {
    return unverifiedTermination(failureReason);
  }
}

function terminationFailedError(): DocumentEngineRunError {
  return createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
    stage: "shutdown",
    remediation: "check_installation",
  });
}

async function cleanupFailedPreDispatch(
  child: ChildProcess,
  snapshot: SpoolDocumentSnapshot | undefined,
  outputOwner: OutputSpoolOwner,
  release: () => void,
  capture: ChildStartupCapture,
  startupLifecycle: StartupLifecycleState,
  startGate: StartGateOwner | undefined,
): Promise<void> {
  const close = await waitWithTimeout(capture.closeReceipt, 1_000);
  if (close === undefined || close.error !== null) {
    startupLifecycle.dispose();
    retainUntilGatedRootClose(
      child,
      snapshot,
      outputOwner,
      release,
      capture,
      startGate,
    );
    return;
  }
  closeStartGate(startGate);
  await drainCapturedChildStreams(child);
  capture.detachAll();
  startupLifecycle.dispose();
  await cleanupSnapshot(snapshot);
  await cleanupOutputSpool(outputOwner);
  release();
}

function retainUntilGatedRootClose(
  child: ChildProcess,
  snapshot: SpoolDocumentSnapshot | undefined,
  outputOwner: OutputSpoolOwner,
  release: () => void,
  capture: ChildStartupCapture,
  startGate: StartGateOwner | undefined,
): void {
  const retention = { child, snapshot, outputOwner, release, capture, startGate };
  unsafeChildRetentions.add(retention);
  void capture.closeReceipt.then(async (close) => {
    if (close.error !== null) return;
    closeStartGate(startGate);
    await drainCapturedChildStreams(child);
    capture.detachAll();
    await cleanupSnapshot(snapshot);
    await cleanupOutputSpool(outputOwner);
    release();
    unsafeChildRetentions.delete(retention);
  }).catch(() => {
    // A missing exact close receipt retains the gate and owned spools fail-closed.
  });
}

function retainUnverifiedPreDispatch(
  child: ChildProcess,
  snapshot: SpoolDocumentSnapshot | undefined,
  outputOwner: OutputSpoolOwner,
  release: () => void,
  capture: ChildStartupCapture,
  startupLifecycle: StartupLifecycleState,
  startGate: StartGateOwner | undefined,
): void {
  unsafeChildRetentions.add({ child, snapshot, outputOwner, release, capture, startGate });
  startupLifecycle.dispose();
}

async function terminateExpiredStartup(
  child: ChildProcess,
  snapshot: SpoolDocumentSnapshot | undefined,
  outputOwner: OutputSpoolOwner,
  release: () => void,
  treeTerminator: ProcessTreeTerminator,
  startupCapture: ChildStartupCapture,
  startupLifecycle: StartupLifecycleState,
  startGate: StartGateOwner,
): Promise<never> {
  const receipt = await terminateWithReceipt(treeTerminator, child);
  if (!receipt.gone) {
    startupLifecycle.dispose();
    scheduleCleanupAfterActualExit(
      child,
      snapshot,
      outputOwner,
      release,
      startupCapture,
      treeTerminator,
      startGate,
    );
    throw terminationFailedError();
  }
  await drainCapturedChildStreams(child);
  startupCapture.detachAll();
  const terminationReason = startupLifecycle.terminationReason();
  startupLifecycle.dispose();
  await cleanupSnapshot(snapshot);
  await cleanupOutputSpool(outputOwner);
  release();
  if (startupCapture.oomDetector.matched) {
    throw createDocumentEngineRunError("ENGINE_OOM", {
      stage: "startup",
      remediation: "reduce_input",
    });
  }
  if (terminationReason !== undefined) {
    throw startupTerminationError(terminationReason);
  }
  if (startupCapture.terminal.observedAt !== undefined) {
    throw createDocumentEngineRunError("ENGINE_INIT_FAILED", {
      stage: "startup",
    });
  }
  throw createDocumentEngineRunError("ENGINE_TIMEOUT");
}

async function runChild<Operation extends DocumentEngineOperation>(
  request: Extract<LogicalDocumentRequest, { operation: Operation }>,
  snapshot: SpoolDocumentSnapshot | undefined,
  options: DocumentEngineRunOptions,
  deadlineMs: number,
  child: ChildProcess,
  release: () => void,
  outputOwner: OutputSpoolOwner,
  treeTerminator: ProcessTreeTerminator,
  controlFrameAllocationObserver?: (bytes: number) => void,
  startupCapture?: ChildStartupCapture,
  startupLifecycle?: StartupLifecycleState,
  startGate?: StartGateOwner,
  testDeadlineSignal?: Readonly<{
    observed(): boolean;
    wait(): Promise<void>;
  }>,
): Promise<IsolatedDocumentResult<Operation>> {
  const startedAt = Date.now();
  const validator = createChildDocumentEventValidator(
    request.requestId,
    request.operation,
    request.operation === "generateHwpx"
      ? 0
      : snapshot?.metadata.sizeBytes ?? 0,
  );
  let ready = false;
  let settling = false;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const capture = startupCapture ?? createChildStartupCapture(child);
  const drainReceipt = capture.drainReceipt;
  const oomDetector = capture.oomDetector;
  const controlDecoder = new BoundedFrameDecoder(
    MAX_CHILD_INLINE_RESULT_BYTES,
    controlFrameAllocationObserver,
  );
  const controlStream = (
    child.stdio as unknown as Array<NodeJS.ReadableStream | null | undefined>
  )[6];
  if (controlStream == null) {
    throw createDocumentEngineRunError("ENGINE_INIT_FAILED");
  }

  return new Promise<IsolatedDocumentResult<Operation>>((resolve, reject) => {
    const onStdout = capture.onStdout;
    const onStderr = capture.onStderr;
    const requestInput = child.stdin;
    let requestDispatchSettled = false;

    const detachListeners = (): void => {
      child.off("error", onError);
      child.off("exit", onExit);
      controlStream.off("data", onControlData);
      controlStream.off("end", onControlEnd);
      controlStream.off("error", onControlError);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (startupLifecycle !== undefined) {
        startupLifecycle.dispose();
      } else if (abortListener !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener("abort", abortListener);
      }
    };

    const settle = (
      outcome:
        | { readonly result: DocumentResultPayload<Operation> }
        | { readonly spoolReceipt: DocumentResultSpoolReceipt<Operation> }
        | { readonly error: unknown; readonly terminationReason?: "deadline" | "abort" },
    ): void => {
      if (settling) return;
      settling = true;
      detachListeners();
      void (async () => {
        let terminalError = "error" in outcome ? outcome.error : undefined;
        const receipt = await terminateWithReceipt(treeTerminator, child);
        publishDocumentChildTerminationReceipt(receipt);
        if (!receipt.gone) {
          scheduleCleanupAfterActualExit(
            child,
            snapshot,
            outputOwner,
            release,
            capture,
            treeTerminator,
            startGate,
          );
          reject(terminationFailedError());
          return;
        }
        await drainCapturedChildStreams(child);
        capture.detachAll();
        if (oomDetector.matched) {
          terminalError = createDocumentEngineRunError("ENGINE_OOM", {
            stage: ready ? request.operation : "startup",
            remediation: "reduce_input",
          });
        }
        try {
          await cleanupSnapshot(snapshot);
        } catch (error: unknown) {
          terminalError ??= error;
        }

        let resolvedResult: IsolatedDocumentResult<Operation> | undefined;
        if (terminalError === undefined) {
          try {
            if ("spoolReceipt" in outcome) {
              resolvedResult = await verifyOutputSpool(
                outputOwner,
                outcome.spoolReceipt,
              ) as IsolatedDocumentResult<Operation>;
            } else {
              await assertEmptyOutputSpool(outputOwner);
              await cleanupOutputSpool(outputOwner);
              resolvedResult = (outcome as {
                result: DocumentResultPayload<Operation>;
              }).result;
            }
          } catch {
            terminalError = createDocumentEngineRunError(
              "ENGINE_PROTOCOL_ERROR",
            );
          }
        }
        if (terminalError !== undefined) {
          try {
            await cleanupOutputSpool(outputOwner);
          } catch (error: unknown) {
            terminalError = error;
          }
        }
        release();

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
        resolve(resolvedResult!);
      })();
    };

    const settleRequestDispatch = (error?: unknown): void => {
      if (requestDispatchSettled) return;
      requestDispatchSettled = true;
      if (error !== undefined && error !== null) settle({ error });
    };
    const onRequestInputError = (error: Error): void => settleRequestDispatch(error);
    const onRequestInputOwnerClose = (): void => {
      requestInput?.removeListener("error", onRequestInputError);
    };
    requestInput?.on("error", onRequestInputError);
    child.once("close", onRequestInputOwnerClose);

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
        if (event.type === "metrics") {
          options.onMetrics?.(Object.freeze({ copiedBytes: event.copiedBytes }));
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
        if (event.type === "spoolResult") {
          settle({ spoolReceipt: event.receipt });
          return;
        }
        settle({ result: event.payload });
      } catch {
        settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
      }
    };
    const onError = (error: Error): void => settle({ error });
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!settling) settle({ error: new Error(`child exit ${code ?? signal ?? "unknown"}`) });
    };

    const onControlData = (chunk: Buffer): void => {
      if (settling) return;
      try {
        for (const frame of controlDecoder.push(chunk)) {
          onMessage(parseBoundedJsonFrame(frame));
        }
      } catch {
        settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
      }
    };
    const onControlEnd = (): void => {
      if (settling) return;
      try {
        controlDecoder.finish();
      } catch {
        settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
      }
    };
    const onControlError = (): void => {
      if (!settling) {
        settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
      }
    };

    controlStream.on("data", onControlData);
    controlStream.on("end", onControlEnd);
    controlStream.on("error", onControlError);
    child.on("error", onError);
    child.on("exit", onExit);
    capture.detachTerminal();
    abortListener = () => settle({
      error: new Error("cancelled"),
      terminationReason: "abort",
    });
    if (startupLifecycle !== undefined) {
      startupLifecycle.handoffAbort(abortListener);
      const startupTerminationReason = startupLifecycle.terminationReason();
      if (startupTerminationReason !== undefined) {
        settle({
          error: new Error(startupTerminationReason),
          terminationReason: startupTerminationReason,
        });
        return;
      }
    } else {
      options.signal?.addEventListener("abort", abortListener, { once: true });
      if (options.signal?.aborted === true) {
        abortListener();
        return;
      }
    }
    if (testDeadlineSignal === undefined) {
      deadlineTimer = setTimeout(() => settle({
        error: new Error("deadline"),
        terminationReason: "deadline",
      }), deadlineMs);
      deadlineTimer.unref();
    } else {
      void testDeadlineSignal.wait().then(
        () => settle({ error: new Error("deadline"), terminationReason: "deadline" }),
        () => settle({ error: new Error("deadline"), terminationReason: "deadline" }),
      );
    }

    if (capture.terminal.error !== undefined || capture.terminal.exit !== undefined) {
      settle({
        error: capture.terminal.error ?? new Error("child exited during startup"),
      });
      return;
    }
    if (oomDetector.matched) {
      settle({
        error: createDocumentEngineRunError("ENGINE_OOM", {
          stage: "startup",
          remediation: "reduce_input",
        }),
      });
      return;
    }

    try {
      const transports: Record<string, unknown> = {};
      if (request.operation !== "generateHwpx") {
        if (snapshot?.transport !== "spool") {
          throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
        }
        transports.document = {
          transport: "spool",
          descriptor: 3,
          sizeBytes: snapshot.metadata.sizeBytes,
        };
      }
      if (request.operation === "insertImage") {
        if (options.imageInput?.transport === "spool") {
          transports.image = {
            transport: "spool",
            descriptor: 4,
            sizeBytes: options.imageInput.sizeBytes,
          };
        } else {
          throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
        }
      }
      const wire = createWireDocumentRequest(request, transports, "child");
      const frame = encodeBoundedJsonFrame(wire, MAX_CHILD_REQUEST_FRAME_BYTES);
      if (requestInput === null) throw new Error("child stdin unavailable");
      requestInput.end(frame, (error?: Error | null) => settleRequestDispatch(error));
    } catch (error: unknown) {
      settleRequestDispatch(error);
    }
  });
}

export async function superviseDocumentProcessTree(
  child: ChildProcess,
  options: Readonly<{
    frameObserver?: (frame: string) => void;
    deferProcessTreeTelemetryStop?: boolean;
    hostedDiagnosticObserver?: (boundary: WindowsSupervisorHostedBoundary) => void;
    hostedDiagnosticLateObserver?: (boundary: WindowsSupervisorHostedLateBoundary) => void;
    hostedDiagnosticPhaseObserver?: (boundary: WindowsSupervisorHostedPhaseBoundary) => void;
  }> = {},
): Promise<ChildLifecycleSupervisor> {
  if (child.pid === undefined) throw new Error("child pid unavailable");
  if (process.platform === "win32") {
    return createWindowsJobSupervisor(
      child,
      5_000,
      options.frameObserver,
      false,
      options.hostedDiagnosticObserver,
      options.hostedDiagnosticLateObserver,
      options.hostedDiagnosticPhaseObserver,
    );
  }
  return createPosixProcessTreeSupervisor(child, process.platform, {
    deferProcessTreeTelemetryStop: options.deferProcessTreeTelemetryStop,
    frameObserver: options.frameObserver,
  });
}

/** Test-only authority-failure entrypoint; production callers cannot disable Job assignment. */
export async function superviseDocumentProcessTreeWithForcedTrackerForTest(
  child: ChildProcess,
  frameObserver?: (frame: string) => void,
): Promise<ChildLifecycleSupervisor> {
  if (process.platform !== "win32") throw new Error("Windows tracker test is unavailable");
  return createWindowsJobSupervisor(child, 5_000, frameObserver, true);
}

export async function terminateGatedChildByHandle(
  child: ChildProcess,
  closeReceipt: Promise<ChildProcessCloseReceipt> = observeChildProcessClose(child),
  timeoutMs = 1_000,
): Promise<boolean> {
  let closed = await waitWithTimeout(closeReceipt, 1);
  if (closed !== undefined) return closed.error === null;
  if (child.exitCode === null && child.signalCode === null) {
    let alive = false;
    try { alive = child.kill(0); } catch { alive = false; }
    if (alive) {
      try { child.kill("SIGKILL"); } catch { /* exact close remains authoritative */ }
    }
  }
  closed = await waitWithTimeout(closeReceipt, timeoutMs);
  return closed !== undefined && closed.error === null;
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  return pid === undefined ? true : terminateDocumentProcessTreeByPid(pid);
}

export interface ProcessTreeTerminationDependencies {
  readonly platform?: NodeJS.Platform;
  readonly systemRoot?: string;
  readonly kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  readonly isAlive?: (pid: number) => boolean;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly execFile?: (
    command: string,
    args: readonly string[],
  ) => Promise<void>;
}

export async function terminateDocumentProcessTreeByPid(
  pid: number,
  dependencies: ProcessTreeTerminationDependencies = {},
): Promise<boolean> {
  const platform = dependencies.platform ?? process.platform;
  const kill = dependencies.kill ?? ((target, signal) => process.kill(target, signal));
  const isAlive = dependencies.isAlive ?? isProcessAlive;
  const delay = dependencies.delay ?? boundedDelay;
  if (platform === "win32") {
    const command = resolveWindowsSystemExecutable(
      "taskkill.exe",
      platform,
      dependencies.systemRoot ?? process.env.SystemRoot,
    );
    try {
      if (dependencies.execFile !== undefined) {
        await dependencies.execFile(command, ["/PID", String(pid), "/T", "/F"]);
      } else {
        await execFileAsync(command, ["/PID", String(pid), "/T", "/F"], {
          timeout: 2_000,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        });
      }
    } catch {
      // The bounded liveness check determines the safe result.
    }
    await delay(TREE_KILL_GRACE_MS);
    return !isAlive(pid);
  }
  try { kill(-pid, "SIGTERM"); } catch {}
  await delay(TREE_KILL_GRACE_MS);
  if (!isAlive(-pid)) return true;
  try { kill(-pid, "SIGKILL"); } catch {}
  await delay(TREE_KILL_GRACE_MS);
  return !isAlive(-pid);
}

function scheduleCleanupAfterActualExit(
  child: ChildProcess,
  snapshot: SpoolDocumentSnapshot | undefined,
  outputOwner: OutputSpoolOwner,
  release: () => void,
  capture: ChildStartupCapture,
  treeTerminator: ProcessTreeTerminator,
  startGate?: StartGateOwner,
): void {
  const retention = { child, snapshot, outputOwner, release, capture, startGate };
  unsafeChildRetentions.add(retention);
  void (async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const receipt = await terminateWithReceipt(treeTerminator, child);
      if (!receipt.gone) {
        await unrefDelay(100);
        continue;
      }
      await drainCapturedChildStreams(child);
      closeStartGate(startGate);
      capture.detachAll();
      try {
        await cleanupSnapshot(snapshot);
        await cleanupOutputSpool(outputOwner);
        release();
        unsafeChildRetentions.delete(retention);
      } catch {
        // Fail closed: the gate remains occupied after unsafe cleanup.
      }
      return;
    }
    // The retained record deliberately owns the gate and spools for process lifetime.
  })();
}

const unsafeChildRetentions = new Set<object>();

function unrefDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function drainCapturedChildStreams(child: ChildProcess): Promise<void> {
  const waits: Array<Promise<void>> = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null || stream.readableEnded || stream.destroyed) continue;
    waits.push(new Promise<void>((resolve) => {
      const done = (): void => {
        stream.off("end", done);
        stream.off("close", done);
        stream.off("error", done);
        resolve();
      };
      stream.once("end", done);
      stream.once("close", done);
      stream.once("error", done);
    }));
  }
  if (waits.length > 0) {
    await waitWithTimeout(Promise.all(waits), 500);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function boundedDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const OOM_SIGNATURES = [
  "heap out of memory",
  "reached heap limit",
  "allocation failed",
  "array buffer allocation failed",
  "enomem",
] as const;

class StreamingOomDetector {
  readonly #states = OOM_SIGNATURES.map(() => 0);
  matched = false;

  push(chunk: Uint8Array): void {
    if (this.matched) return;
    for (const rawByte of chunk) {
      const byte = rawByte >= 0x41 && rawByte <= 0x5a
        ? rawByte + 0x20
        : rawByte;
      for (let index = 0; index < OOM_SIGNATURES.length; index += 1) {
        const pattern = OOM_SIGNATURES[index]!;
        let state = this.#states[index]!;
        const expected = pattern.charCodeAt(state);
        if (byte === expected) {
          state += 1;
        } else {
          state = byte === pattern.charCodeAt(0) ? 1 : 0;
        }
        if (state === pattern.length) {
          this.matched = true;
          return;
        }
        this.#states[index] = state;
      }
    }
  }
}

function createChildStartupCapture(child: ChildProcess): ChildStartupCapture {
  const oomDetector = new StreamingOomDetector();
  const closeReceipt = observeChildProcessClose(child);
  const drainReceipt = { stdoutBytes: 0, stderrBytes: 0 };
  const terminal: ChildStartupCapture["terminal"] = {};
  const onStdout = (chunk: Buffer): void => {
    drainReceipt.stdoutBytes = Math.min(
      MAX_DRAIN_ACCOUNTED_BYTES,
      drainReceipt.stdoutBytes + chunk.byteLength,
    );
  };
  const onStderr = (chunk: Buffer): void => {
    oomDetector.push(chunk);
    drainReceipt.stderrBytes = Math.min(
      MAX_DRAIN_ACCOUNTED_BYTES,
      drainReceipt.stderrBytes + chunk.byteLength,
    );
  };
  const onError = (error: Error): void => {
    terminal.error ??= error;
    terminal.observedAt ??= Date.now();
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    terminal.exit ??= { code, signal };
    terminal.observedAt ??= Date.now();
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.on("error", onError);
  child.on("exit", onExit);
  let terminalAttached = true;
  let streamsAttached = true;
  const detachTerminal = (): void => {
    if (!terminalAttached) return;
    terminalAttached = false;
    child.off("error", onError);
    child.off("exit", onExit);
  };
  return {
    oomDetector,
    drainReceipt,
    onStdout,
    onStderr,
    terminal,
    closeReceipt,
    detachTerminal,
    detachAll(): void {
      detachTerminal();
      if (!streamsAttached) return;
      streamsAttached = false;
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
    },
  };
}

function requireSpool(
  snapshot: SpoolDocumentSnapshot | undefined,
): Readonly<{ fd: number; sizeBytes: number }> {
  if (snapshot?.transport !== "spool") {
    throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
  }
  return snapshot.takeSpoolHandle();
}

async function createPrivateOutputSpool(
  root: string,
  cleanupHooks: DocumentChildClientDependencies["outputSpoolCleanupHooks"],
): Promise<OutputSpoolOwner> {
  if (!isAbsolute(root)) throw new Error("invalid output spool root");
  let directoryPath: string | undefined;
  let filePath: string | undefined;
  let handle: FileHandle | undefined;
  try {
    directoryPath = await mkdtemp(join(root, OUTPUT_SPOOL_PREFIX));
    await setOwnerOnlyAccess(directoryPath, "directory", 0o700);
    filePath = join(directoryPath, OUTPUT_SPOOL_FILENAME);
    handle = await open(filePath, "wx+", 0o600);
    await setOwnerOnlyAccess(filePath, "file", 0o600);
    const directoryStatus = await lstat(directoryPath, { bigint: true });
    const fileStatus = await handle.stat({ bigint: true });
    if (
      !directoryStatus.isDirectory() ||
      directoryStatus.isSymbolicLink() ||
      !fileStatus.isFile()
    ) {
      throw new Error("invalid output spool identity");
    }
    return {
      directoryPath,
      filePath,
      handle,
      directoryDevice: directoryStatus.dev,
      directoryInode: directoryStatus.ino,
      fileDevice: fileStatus.dev,
      fileInode: fileStatus.ino,
      handleClosed: false,
      cleaned: false,
      cleanupUnlink: cleanupHooks?.unlink ?? unlink,
      cleanupRmdir: cleanupHooks?.rmdir ?? rmdir,
    };
  } catch (error: unknown) {
    if (handle !== undefined) {
      try { await handle.close(); } catch {}
    }
    if (filePath !== undefined) {
      try { await unlink(filePath); } catch {}
    }
    if (directoryPath !== undefined) {
      try { await rmdir(directoryPath); } catch {}
    }
    throw error;
  }
}

async function verifyOutputSpool<Operation extends DocumentEngineOperation>(
  owner: OutputSpoolOwner,
  receipt: DocumentResultSpoolReceipt<Operation>,
): Promise<IntegrityVerifiedResultSpool<Operation>> {
  const before = await owner.handle.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.dev !== owner.fileDevice ||
    before.ino !== owner.fileInode ||
    before.size !== BigInt(receipt.sizeBytes)
  ) {
    throw new Error("output spool size mismatch");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafeSlow(
    Math.min(OUTPUT_READ_CHUNK_BYTES, receipt.sizeBytes),
  );
  let position = 0;
  while (position < receipt.sizeBytes) {
    const requested = Math.min(buffer.byteLength, receipt.sizeBytes - position);
    const { bytesRead } = await owner.handle.read(
      buffer,
      0,
      requested,
      position,
    );
    if (bytesRead === 0) throw new Error("output spool truncated");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await owner.handle.stat({ bigint: true });
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    hash.digest("hex") !== receipt.sha256
  ) {
    throw new Error("output spool hash mismatch");
  }

  let taken = false;
  const metadata = Object.freeze({
    operation: receipt.operation,
    encoding: receipt.encoding,
    sizeBytes: receipt.sizeBytes,
    sha256: receipt.sha256,
    ...(receipt.metadata === undefined
      ? {}
      : { resultMetadata: receipt.metadata }),
  });
  const result: IntegrityVerifiedResultSpool<Operation> = Object.freeze({
    transport: "spool" as const,
    metadata,
    takeHandle(): Readonly<{ fd: number; sizeBytes: number }> {
      if (taken || owner.cleaned || owner.handleClosed) {
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
      }
      taken = true;
      return Object.freeze({ fd: owner.handle.fd, sizeBytes: receipt.sizeBytes });
    },
    async cleanup(): Promise<void> {
      await cleanupOutputSpool(owner);
    },
  });
  verifiedResultSpools.add(result);
  return result;
}

async function assertEmptyOutputSpool(owner: OutputSpoolOwner): Promise<void> {
  const status = await owner.handle.stat({ bigint: true });
  if (
    status.dev !== owner.fileDevice ||
    status.ino !== owner.fileInode ||
    status.size !== 0n
  ) {
    throw new Error("unexpected output spool content");
  }
}

async function cleanupOutputSpool(owner: OutputSpoolOwner): Promise<void> {
  if (owner.cleaned) return;
  if (!owner.handleClosed) {
    await owner.handle.close();
    owner.handleClosed = true;
  }
  if (owner.quarantinePath === undefined) {
    const directoryStatus = await lstat(owner.directoryPath, { bigint: true });
    const fileStatus = await lstat(owner.filePath, { bigint: true });
    if (
      !directoryStatus.isDirectory() ||
      directoryStatus.isSymbolicLink() ||
      directoryStatus.dev !== owner.directoryDevice ||
      directoryStatus.ino !== owner.directoryInode ||
      !fileStatus.isFile() ||
      fileStatus.isSymbolicLink() ||
      fileStatus.dev !== owner.fileDevice ||
      fileStatus.ino !== owner.fileInode
    ) {
      throw new Error("output spool cleanup identity mismatch");
    }
    const quarantinePath = join(
      dirname(owner.directoryPath),
      `.gpt-codex-hwp-result-quarantine-${randomUUID()}`,
    );
    await rename(owner.directoryPath, quarantinePath);
    owner.quarantinePath = quarantinePath;
  }
  const quarantinePath = owner.quarantinePath;
  const directoryStatus = await lstat(quarantinePath, { bigint: true });
  if (
    !directoryStatus.isDirectory() ||
    directoryStatus.isSymbolicLink() ||
    directoryStatus.dev !== owner.directoryDevice ||
    directoryStatus.ino !== owner.directoryInode
  ) {
    throw new Error("output spool quarantine identity mismatch");
  }
  const entries = await readdir(quarantinePath);
  const filename = basename(owner.filePath);
  if (entries.length > 1 || (entries.length === 1 && entries[0] !== filename)) {
    throw new Error("output spool cleanup contents changed");
  }
  if (entries.length === 1) {
    const quarantinedFile = join(quarantinePath, filename);
    const fileStatus = await lstat(quarantinedFile, { bigint: true });
    if (
      !fileStatus.isFile() ||
      fileStatus.isSymbolicLink() ||
      fileStatus.dev !== owner.fileDevice ||
      fileStatus.ino !== owner.fileInode
    ) {
      throw new Error("output spool quarantined file identity mismatch");
    }
    await owner.cleanupUnlink(quarantinedFile);
  }
  await owner.cleanupRmdir(quarantinePath);
  owner.cleaned = true;
}

async function setOwnerOnlyAccess(
  path: string,
  kind: "directory" | "file",
  mode: number,
): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, mode);
    return;
  }
  if (await applyWindowsOwnerOnlyAcl(path, kind) !== "OK") {
    throw new Error("could not apply owner-only spool access");
  }
}

function systemExecutable(name: string): string {
  return resolveWindowsSystemExecutable(
    name,
    process.platform,
    process.env.SystemRoot,
  );
}

function createStartupLifecycleState(
  signal: AbortSignal | undefined,
  deadlineAt: number,
  testDeadlineSignal?: Readonly<{
    observed(): boolean;
    wait(): Promise<void>;
  }>,
): StartupLifecycleState {
  let abortObservedAt = signal?.aborted === true
    ? performance.now()
    : undefined;
  let abortCallback: (() => void) | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let terminationPromise: Promise<StartupTerminationReason> | undefined;
  let resolveTermination: ((reason: StartupTerminationReason) => void) | undefined;
  let disposed = false;
  let testDeadlineWaitArmed = false;
  const terminationReason = (): StartupTerminationReason | undefined => {
    const now = performance.now();
    if (abortObservedAt !== undefined && abortObservedAt < deadlineAt) {
      return "abort";
    }
    if (testDeadlineSignal?.observed() === true ||
      (testDeadlineSignal === undefined && now >= deadlineAt)) return "deadline";
    return abortObservedAt === undefined ? undefined : "abort";
  };
  const publishTermination = (): void => {
    const reason = terminationReason();
    if (reason === undefined) return;
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    resolveTermination?.(reason);
    resolveTermination = undefined;
  };
  const armDeadline = (): void => {
    if (disposed || resolveTermination === undefined) return;
    if (testDeadlineSignal !== undefined) {
      if (testDeadlineWaitArmed) return;
      testDeadlineWaitArmed = true;
      void testDeadlineSignal.wait().then(
        () => { if (!disposed) publishTermination(); },
        () => { if (!disposed) publishTermination(); },
      );
      return;
    }
    if (deadlineTimer !== undefined) return;
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) {
      publishTermination();
      return;
    }
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      publishTermination();
      if (resolveTermination !== undefined) armDeadline();
    }, Math.max(1, Math.ceil(remainingMs)));
  };
  const onAbort = (): void => {
    abortObservedAt ??= performance.now();
    publishTermination();
    if (terminationReason() === "abort") abortCallback?.();
  };
  if (signal !== undefined && abortObservedAt === undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    deadlineAt,
    terminationReason,
    waitForTermination(): Promise<StartupTerminationReason> {
      const current = terminationReason();
      if (current !== undefined) return Promise.resolve(current);
      terminationPromise ??= new Promise<StartupTerminationReason>((resolve) => {
        resolveTermination = resolve;
      });
      armDeadline();
      return terminationPromise;
    },
    handoffAbort(callback: () => void): void {
      abortCallback = callback;
      if (terminationReason() === "abort") callback();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      resolveTermination = undefined;
      abortCallback = undefined;
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function startupTerminationError(
  reason: StartupTerminationReason,
): DocumentEngineRunError {
  return createDocumentEngineRunError(
    reason === "abort" ? "REQUEST_CANCELLED" : "ENGINE_TIMEOUT",
  );
}

function normalizeDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
      remediation: "reduce_input",
    });
  }
  return value;
}

export const MINIMAL_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  // Lets the child find the per-user Windows py.exe launcher.
  "LOCALAPPDATA",
]);

function minimalChildEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_CHILD_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function cleanupSnapshot(
  snapshot: SpoolDocumentSnapshot | undefined,
): Promise<void> {
  if (snapshot !== undefined) await snapshot.cleanup();
}

async function cleanupUnknownSnapshot(
  snapshot: { cleanup(): Promise<void> } | undefined,
): Promise<void> {
  if (snapshot !== undefined) await snapshot.cleanup();
}
