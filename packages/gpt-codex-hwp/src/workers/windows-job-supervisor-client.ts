import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  MAX_DRAIN_ACCOUNTED_BYTES,
  observeChildProcessClose,
  resolveWindowsSystemExecutable,
  waitWithTimeout,
  type ChildLifecycleSupervisor,
  type ChildProcessCloseReceipt,
} from "./child-process-primitives.js";
import {
  unverifiedTermination,
  type ProcessTreeTerminationReceipt,
} from "./registered-process-supervisor.js";

const WINDOWS_SUPERVISOR_TERMINATION_FRAME_MS = 15_000;
const WINDOWS_HOSTED_LATE_OBSERVER_MS = 10_000;

const gatedRootGoneErrors = new WeakSet<object>();
interface SupervisorHelperRetention {
  readonly helper: ChildProcess;
  readonly closeReceipt: Promise<ChildProcessCloseReceipt>;
}

const supervisorHelperUnclosedErrors = new WeakMap<object, SupervisorHelperRetention>();
const supervisorHelperRetentionsByProcess = new WeakMap<object, SupervisorHelperRetention>();
const supervisorHelperCleanupPromises = new WeakMap<object, Promise<boolean>>();
const releasedSupervisorHelpers = new WeakSet<object>();
const unsafeSupervisorHelperRetentions = new Set<SupervisorHelperRetention>();

function gatedRootGoneError(): Error {
  const error = new Error("Windows Job authority unavailable after gated root cleanup");
  gatedRootGoneErrors.add(error);
  return error;
}

function supervisorHelperUnclosedError(
  helper: ChildProcess,
  closeReceipt: Promise<ChildProcessCloseReceipt>,
): Error {
  const error = new Error("Windows Job supervisor cleanup unverified");
  supervisorHelperUnclosedErrors.set(
    error,
    retainUnclosedWindowsSupervisorHelper(helper, closeReceipt),
  );
  return error;
}

export function isGatedRootGoneError(error: unknown): boolean {
  return typeof error === "object" && error !== null && gatedRootGoneErrors.has(error);
}

export function isSupervisorHelperUnclosedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && supervisorHelperUnclosedErrors.has(error);
}

export async function createWindowsJobSupervisor(
  child: ChildProcess,
  readyDeadlineMs: number,
  frameObserver?: (frame: string) => void,
  forceTracker = false,
  hostedDiagnosticObserver?: (boundary: WindowsSupervisorHostedBoundary) => void,
  hostedDiagnosticLateObserver?: (boundary: WindowsSupervisorHostedLateBoundary) => void,
  hostedDiagnosticPhaseObserver?: (boundary: WindowsSupervisorHostedPhaseBoundary) => void,
): Promise<ChildLifecycleSupervisor> {
  if (child.pid === undefined) throw new Error("child pid unavailable");
  const targetCloseReceipt = observeChildProcessClose(child);
  const powershell = resolveWindowsSystemExecutable(
    "powershell.exe",
    "win32",
    process.env.SystemRoot,
  );
  const script = resolveWindowsJobSupervisorScript();
  const helper = spawn(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-TargetPid",
    String(child.pid),
    ...(forceTracker ? ["-ForceTracker"] : []),
    ...(hostedDiagnosticPhaseObserver === undefined ? [] : ["-HostedDiagnostic"]),
  ], {
    shell: false,
    windowsHide: true,
    env: createJobHelperEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closeReceipt = observeChildProcessClose(helper);
  let stdinFailed = helper.stdin === null;
  helper.stdin?.on("error", () => { stdinFailed = true; });
  let stderrBytes = 0;
  helper.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes = Math.min(MAX_DRAIN_ACCOUNTED_BYTES, stderrBytes + chunk.byteLength);
  });
  helper.stderr?.on("error", () => { stderrBytes = Math.max(1, stderrBytes); });
  if (helper.stdout === null || helper.stdin === null || helper.stderr === null) {
    if (!await cleanupWindowsSupervisorHelper(helper, closeReceipt)) {
      throw supervisorHelperUnclosedError(helper, closeReceipt);
    }
    throw new Error("job supervisor pipes unavailable");
  }
  const lines = new BoundedSupervisorLineReader(helper.stdout, 128);
  let readyMode: 1 | 2;
  let invalidFrame = false;
  try {
    const ready = await readWindowsSupervisorReadyFrame({
      timeoutMs: readyDeadlineMs,
      next: (timeoutMs) => lines.next(timeoutMs),
      phaseObserver: hostedDiagnosticPhaseObserver,
    });
    frameObserver?.(ready);
    const readyMatch = new RegExp(
      `^GPT_CODEX_HWP_JOB READY ${child.pid} ([12]) [0-9]+$`,
      "u",
    ).exec(ready);
    if (readyMatch === null) {
      invalidFrame = true;
      throw new Error("invalid job supervisor READY frame");
    }
    readyMode = Number(readyMatch[1]) as 1 | 2;
    emitHostedWindowsBoundary(
      hostedDiagnosticObserver,
      readyMode === 1 ? "ready-mode-1" : "ready-mode-2",
    );
  } catch (error: unknown) {
    const preCleanupTranscript = lines.transcriptReceipt();
    const preCleanupStderrPresent = stderrBytes > 0;
    const productionBoundary = classifyWindowsSupervisorPreframeDiagnostic({
      helperSpawnFailed: false,
      stderrPresent: preCleanupStderrPresent,
      ...preCleanupTranscript,
      invalidFrame,
    });
    let lateBoundary: WindowsSupervisorHostedLateBoundary | undefined;
    if (productionBoundary === "frame-timeout" &&
      hostedDiagnosticLateObserver !== undefined) {
      emitHostedWindowsBoundary(hostedDiagnosticObserver, productionBoundary);
      lateBoundary = await observeWindowsSupervisorLateReady({
        targetPid: child.pid,
        timeoutMs: WINDOWS_HOSTED_LATE_OBSERVER_MS,
        next: (timeoutMs) => lines.next(timeoutMs),
        transcriptReceipt: () => lines.transcriptReceipt(),
        stderrPresent: () => stderrBytes > 0,
        phaseObserver: hostedDiagnosticPhaseObserver,
      });
    }
    if (!await cleanupWindowsSupervisorHelper(helper, closeReceipt)) {
      if (lateBoundary === undefined) {
        emitHostedWindowsBoundary(hostedDiagnosticObserver, "helper-close");
      } else {
        emitHostedWindowsLateBoundary(hostedDiagnosticLateObserver, "helper-close");
      }
      throw supervisorHelperUnclosedError(helper, closeReceipt);
    }
    const helperClose = await closeReceipt;
    if (lateBoundary === undefined) {
      emitHostedWindowsBoundary(
        hostedDiagnosticObserver,
        classifyWindowsSupervisorPreframeDiagnostic({
        helperSpawnFailed: helperClose.error !== null,
        stderrPresent: preCleanupStderrPresent,
        ...preCleanupTranscript,
        invalidFrame,
        }),
      );
    } else {
      emitHostedWindowsLateBoundary(hostedDiagnosticLateObserver, lateBoundary);
    }
    throw error;
  }

  let commandSent = false;
  let gatedRootGone = false;
  let helperCleanupVerified = true;
  let verifiedReceipt: ProcessTreeTerminationReceipt | undefined;
  let activeTermination: Promise<ProcessTreeTerminationReceipt> | undefined;
  let processTreeRss: Readonly<{
    baselineBytes: number;
    peakBytes: number;
  }> | undefined;
  const supervisor: ChildLifecycleSupervisor = {
    processTreeTelemetryReady: Promise.resolve(true),
    processTreeRss: () => processTreeRss,
    terminate(): Promise<ProcessTreeTerminationReceipt> {
      if (verifiedReceipt?.gone === true) return Promise.resolve(verifiedReceipt);
      activeTermination ??= (async () => {
        let proved = false;
        try {
          if (!commandSent) {
            commandSent = true;
            helper.stdin!.end("TERMINATE\n");
          }
          let frame = await lines.next(WINDOWS_SUPERVISOR_TERMINATION_FRAME_MS);
          if (forceTracker && /^GPT_CODEX_HWP_JOB TRACKER [0-9]+ [0-9]+$/u.test(frame)) {
            frameObserver?.(frame);
            frame = await lines.next(WINDOWS_SUPERVISOR_TERMINATION_FRAME_MS);
          }
          frameObserver?.(frame);
          processTreeRss = parseProcessTreeRssFrame(frame);
          const gone = await lines.next(WINDOWS_SUPERVISOR_TERMINATION_FRAME_MS);
          frameObserver?.(gone);
          const matchingGone = gone === `GPT_CODEX_HWP_JOB GONE 0 ${readyMode}`;
          const authorityGone = readyMode === 1 && matchingGone;
          const finalized = await finalizeVerifiedWindowsSupervisor({
            closeReceipt,
            forceClose: () => helper.kill(),
            allowForceClose: authorityGone,
            transcriptReceipt: () => Object.freeze({
              stdinFailed,
              stderrBytes,
              ...lines.transcriptReceipt(),
            }),
          });
          if (!finalized) {
            frameObserver?.("GPT_CODEX_HWP_JOB ERROR finalizer invalid");
            emitHostedWindowsBoundary(hostedDiagnosticObserver, "helper-close");
            return unverifiedTermination("termination");
          }
          if (readyMode === 2 && matchingGone) {
            const targetClose = await waitWithTimeout(targetCloseReceipt, 5_000);
            gatedRootGone = targetClose !== undefined && targetClose.error === null;
            return unverifiedTermination("identity");
          }
          if (!matchingGone || !authorityGone) {
            frameObserver?.("GPT_CODEX_HWP_JOB ERROR termination invalid");
            emitHostedWindowsBoundary(hostedDiagnosticObserver, "termination-receipt");
            return unverifiedTermination("identity");
          }
          verifiedReceipt = Object.freeze({
            gone: true,
            proof: "windows-job-empty",
          });
          proved = true;
          return verifiedReceipt;
        } catch {
          frameObserver?.("GPT_CODEX_HWP_JOB ERROR channel invalid");
          emitHostedWindowsBoundary(hostedDiagnosticObserver, "termination-receipt");
          return unverifiedTermination("channel");
        } finally {
          if (!proved) {
            if (!await cleanupWindowsSupervisorHelper(helper, closeReceipt)) {
              helperCleanupVerified = false;
            }
          }
          activeTermination = undefined;
        }
      })();
      return activeTermination;
    },
  };
  if (readyMode !== 1) {
    await supervisor.terminate();
    if (gatedRootGone) throw gatedRootGoneError();
    if (!helperCleanupVerified) throw supervisorHelperUnclosedError(helper, closeReceipt);
    throw new Error("Windows Job authority unavailable");
  }
  return supervisor;
}

export type WindowsSupervisorHostedBoundary =
  | "helper-spawn"
  | "preframe-stderr"
  | "preframe-exit"
  | "frame-timeout"
  | "frame-invalid"
  | "ready-mode-2"
  | "ready-mode-1"
  | "termination-receipt"
  | "helper-close";

export type WindowsSupervisorHostedLateBoundary =
  | "ready-late"
  | "late-preframe-error"
  | "observer-timeout"
  | "helper-close"
  | "target-close";

export type WindowsSupervisorHostedPhaseBoundary =
  | "script-entry"
  | "assembly-path"
  | "assembly-verify"
  | "assembly-load"
  | "job-create"
  | "job-created"
  | "limits-created"
  | "limits-sized"
  | "limits-applied"
  | "target-open"
  | "target-identity"
  | "job-bind"
  | "snapshot"
  | "baseline-rss"
  | "ready-write";

const WINDOWS_SUPERVISOR_PHASE_PATTERN = /^GPT_CODEX_HWP_JOB PHASE (script-entry|assembly-path|assembly-verify|assembly-load|job-create|job-created|limits-created|limits-sized|limits-applied|target-open|target-identity|job-bind|snapshot|baseline-rss|ready-write)$/u;

export function classifyWindowsSupervisorPreframeDiagnostic(receipt: Readonly<{
  helperSpawnFailed: boolean;
  stderrPresent: boolean;
  stdoutEnded: boolean;
  stdoutFailed: boolean;
  protocolFailed: boolean;
  invalidFrame: boolean;
}>): Exclude<WindowsSupervisorHostedBoundary,
  "ready-mode-1" | "ready-mode-2" | "termination-receipt" | "helper-close"> {
  if (receipt.helperSpawnFailed) return "helper-spawn";
  if (receipt.stderrPresent) return "preframe-stderr";
  if (receipt.protocolFailed || receipt.invalidFrame) return "frame-invalid";
  if (receipt.stdoutEnded || receipt.stdoutFailed) return "preframe-exit";
  return "frame-timeout";
}

function emitHostedWindowsBoundary(
  observer: ((boundary: WindowsSupervisorHostedBoundary) => void) | undefined,
  boundary: WindowsSupervisorHostedBoundary,
): void {
  try { observer?.(boundary); } catch {}
}

function emitHostedWindowsLateBoundary(
  observer: ((boundary: WindowsSupervisorHostedLateBoundary) => void) | undefined,
  boundary: WindowsSupervisorHostedLateBoundary,
): void {
  try { observer?.(boundary); } catch {}
}

export function observeWindowsSupervisorLateReadyForTest(options: Readonly<{
  targetPid: number;
  timeoutMs: number;
  next: (timeoutMs: number) => Promise<string>;
  transcriptReceipt: () => Readonly<{
    stdoutEnded: boolean;
    stdoutFailed: boolean;
    protocolFailed: boolean;
    queuedFrames: number;
    partialBytes: number;
  }>;
  stderrPresent: () => boolean;
  phaseObserver?: (boundary: WindowsSupervisorHostedPhaseBoundary) => void;
}>): Promise<WindowsSupervisorHostedLateBoundary> {
  return observeWindowsSupervisorLateReady(options);
}

export function readWindowsSupervisorReadyFrameForTest(options: Readonly<{
  timeoutMs: number;
  next: (timeoutMs: number) => Promise<string>;
  phaseObserver?: (boundary: WindowsSupervisorHostedPhaseBoundary) => void;
}>): Promise<string> {
  return readWindowsSupervisorReadyFrame(options);
}

async function readWindowsSupervisorReadyFrame(options: Readonly<{
  timeoutMs: number;
  next: (timeoutMs: number) => Promise<string>;
  phaseObserver?: (boundary: WindowsSupervisorHostedPhaseBoundary) => void;
}>): Promise<string> {
  const deadlineAt = performance.now() + options.timeoutMs;
  while (true) {
    const remainingMs = Math.ceil(deadlineAt - performance.now());
    if (remainingMs <= 0) throw new Error("job supervisor frame timeout");
    const frame = await options.next(remainingMs);
    const phase = parseWindowsSupervisorPhase(frame);
    if (phase === undefined || options.phaseObserver === undefined) return frame;
    emitHostedWindowsPhaseBoundary(options.phaseObserver, phase);
  }
}

async function observeWindowsSupervisorLateReady(options: Readonly<{
  targetPid: number;
  timeoutMs: number;
  next: (timeoutMs: number) => Promise<string>;
  transcriptReceipt: () => Readonly<{
    stdoutEnded: boolean;
    stdoutFailed: boolean;
    protocolFailed: boolean;
    queuedFrames: number;
    partialBytes: number;
  }>;
  stderrPresent: () => boolean;
  phaseObserver?: (boundary: WindowsSupervisorHostedPhaseBoundary) => void;
}>): Promise<WindowsSupervisorHostedLateBoundary> {
  if (!Number.isSafeInteger(options.targetPid) || options.targetPid <= 0 ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 ||
    options.timeoutMs > WINDOWS_HOSTED_LATE_OBSERVER_MS) {
    return "late-preframe-error";
  }
  const deadlineAt = performance.now() + options.timeoutMs;
  while (true) {
    const remainingMs = Math.ceil(deadlineAt - performance.now());
    if (remainingMs <= 0) return classifyWindowsSupervisorLateTimeout(options);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.resolve().then(() => options.next(remainingMs)).then(
        (frame) => Object.freeze({ kind: "frame" as const, frame }),
        () => Object.freeze({ kind: "error" as const }),
      ),
      new Promise<Readonly<{ kind: "timeout" }>>((resolve) => {
        timer = setTimeout(() => resolve(Object.freeze({ kind: "timeout" })), remainingMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.kind === "timeout") return classifyWindowsSupervisorLateTimeout(options);
    if (outcome.kind === "error") return "late-preframe-error";
    const phase = parseWindowsSupervisorPhase(outcome.frame);
    if (phase !== undefined && options.phaseObserver !== undefined) {
      emitHostedWindowsPhaseBoundary(options.phaseObserver, phase);
      continue;
    }
    if (!windowsSupervisorTranscriptIsClean(options)) return "late-preframe-error";
    const ready = new RegExp(
      `^GPT_CODEX_HWP_JOB READY ${options.targetPid} [12] [0-9]+$`,
      "u",
    ).test(outcome.frame);
    return ready ? "ready-late" : "late-preframe-error";
  }
}

function classifyWindowsSupervisorLateTimeout(options: Readonly<{
  transcriptReceipt: () => Readonly<{
    stdoutEnded: boolean;
    stdoutFailed: boolean;
    protocolFailed: boolean;
    queuedFrames: number;
    partialBytes: number;
  }>;
  stderrPresent: () => boolean;
}>): WindowsSupervisorHostedLateBoundary {
  return windowsSupervisorTranscriptIsClean(options)
    ? "observer-timeout"
    : "late-preframe-error";
}

function windowsSupervisorTranscriptIsClean(options: Readonly<{
  transcriptReceipt: () => Readonly<{
    stdoutEnded: boolean;
    stdoutFailed: boolean;
    protocolFailed: boolean;
    queuedFrames: number;
    partialBytes: number;
  }>;
  stderrPresent: () => boolean;
}>): boolean {
  try {
    const transcript = options.transcriptReceipt();
    return !options.stderrPresent() && !transcript.stdoutEnded &&
      !transcript.stdoutFailed && !transcript.protocolFailed &&
      transcript.queuedFrames === 0 && transcript.partialBytes === 0;
  } catch {
    return false;
  }
}

function parseWindowsSupervisorPhase(frame: string): WindowsSupervisorHostedPhaseBoundary | undefined {
  const match = WINDOWS_SUPERVISOR_PHASE_PATTERN.exec(frame);
  return match?.[1] as WindowsSupervisorHostedPhaseBoundary | undefined;
}

function emitHostedWindowsPhaseBoundary(
  observer: ((boundary: WindowsSupervisorHostedPhaseBoundary) => void) | undefined,
  boundary: WindowsSupervisorHostedPhaseBoundary,
): void {
  try { observer?.(boundary); } catch {}
}

export async function finalizeVerifiedWindowsSupervisor({
  closeReceipt,
  forceClose,
  allowForceClose,
  transcriptReceipt,
  gracefulExitMs = 1_000,
  forcedExitMs = 4_000,
}: {
  readonly closeReceipt: Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
  }>>;
  readonly forceClose: () => boolean;
  readonly allowForceClose: boolean;
  readonly transcriptReceipt: () => Readonly<{
    stdinFailed: boolean;
    stderrBytes: number;
    stdoutEnded: boolean;
    stdoutFailed: boolean;
    protocolFailed: boolean;
    queuedFrames: number;
    partialBytes: number;
  }>;
  readonly gracefulExitMs?: number;
  readonly forcedExitMs?: number;
}): Promise<boolean> {
  const gracefulClose = await waitWithTimeout(closeReceipt, gracefulExitMs);
  if (gracefulClose !== undefined) {
    return gracefulClose.code === 0 && gracefulClose.signal === null &&
      gracefulClose.error === null && cleanWindowsSupervisorTranscript(transcriptReceipt);
  }
  let closeRequested = false;
  try {
    closeRequested = forceClose();
  } catch {
    closeRequested = false;
  }
  const forcedClose = await waitWithTimeout(closeReceipt, forcedExitMs);
  return allowForceClose && closeRequested && forcedClose !== undefined && forcedClose.code === null &&
    forcedClose.signal === "SIGTERM" && forcedClose.error === null &&
    cleanWindowsSupervisorTranscript(transcriptReceipt);
}

function cleanWindowsSupervisorTranscript(
  receipt: () => Readonly<{
    stdinFailed: boolean;
    stderrBytes: number;
    stdoutEnded: boolean;
    stdoutFailed: boolean;
    protocolFailed: boolean;
    queuedFrames: number;
    partialBytes: number;
  }>,
): boolean {
  try {
    const value = receipt();
    return value.stdinFailed === false && value.stderrBytes === 0 && value.stdoutEnded === true &&
      value.stdoutFailed === false && value.protocolFailed === false && value.queuedFrames === 0 &&
      value.partialBytes === 0;
  } catch {
    return false;
  }
}

function parseProcessTreeRssFrame(frame: string): Readonly<{
  baselineBytes: number;
  peakBytes: number;
}> {
  const match = /^GPT_CODEX_HWP_JOB RSS ([0-9]+) ([0-9]+)$/u.exec(frame);
  if (match === null) throw new Error("invalid job supervisor RSS frame");
  const baselineBytes = Number(match[1]);
  const peakBytes = Number(match[2]);
  if (
    !Number.isSafeInteger(baselineBytes) ||
    baselineBytes <= 0 ||
    !Number.isSafeInteger(peakBytes) ||
    peakBytes < baselineBytes
  ) {
    throw new Error("invalid job supervisor RSS values");
  }
  return Object.freeze({ baselineBytes, peakBytes });
}

export function resolveWindowsJobSupervisorScript(): string {
  return fileURLToPath(new URL("./windows-job-supervisor.ps1", import.meta.url));
}

class BoundedSupervisorLineReader {
  readonly #buffer: Buffer;
  #length = 0;
  #queue: string[] = [];
  #waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  #failed: Error | undefined;
  #stdoutEnded = false;
  #stdoutFailed = false;
  #protocolFailed = false;

  constructor(stream: NodeJS.ReadableStream, maxLineBytes: number) {
    this.#buffer = Buffer.alloc(maxLineBytes);
    stream.on("data", (chunk: Buffer) => this.#push(chunk));
    stream.on("end", () => {
      this.#stdoutEnded = true;
      this.#fail(new Error("job supervisor stream ended"));
    });
    stream.on("error", () => {
      this.#stdoutFailed = true;
      this.#fail(new Error("job supervisor stream failed"));
    });
    stream.on("close", () => {
      if (this.#stdoutEnded) return;
      this.#stdoutFailed = true;
      this.#fail(new Error("job supervisor stream closed before end"));
    });
  }

  next(timeoutMs: number): Promise<string> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift()!);
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    return new Promise<string>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.#waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("job supervisor frame timeout"));
      }, timeoutMs);
      const resolveOnce = waiter.resolve;
      const rejectOnce = waiter.reject;
      waiter.resolve = (line) => {
        clearTimeout(timer);
        resolveOnce(line);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        rejectOnce(error);
      };
    });
  }

  transcriptReceipt(): Readonly<{
    stdoutEnded: boolean;
    stdoutFailed: boolean;
    protocolFailed: boolean;
    queuedFrames: number;
    partialBytes: number;
  }> {
    return Object.freeze({
      stdoutEnded: this.#stdoutEnded,
      stdoutFailed: this.#stdoutFailed,
      protocolFailed: this.#protocolFailed,
      queuedFrames: this.#queue.length,
      partialBytes: this.#length,
    });
  }

  #push(chunk: Buffer): void {
    if (this.#failed !== undefined) return;
    for (const byte of chunk) {
      if (byte === 0x0a) {
        const end = this.#length > 0 && this.#buffer[this.#length - 1] === 0x0d
          ? this.#length - 1
          : this.#length;
        const line = this.#buffer.toString("ascii", 0, end);
        this.#length = 0;
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#queue.push(line);
        else waiter.resolve(line);
        continue;
      }
      if (
        (byte < 0x20 && byte !== 0x0d) ||
        byte > 0x7e ||
        this.#length >= this.#buffer.byteLength
      ) {
        this.#protocolFailed = true;
        this.#fail(new Error("invalid job supervisor frame"));
        return;
      }
      this.#buffer[this.#length] = byte;
      this.#length += 1;
    }
  }

  #fail(error: Error): void {
    if (this.#failed !== undefined) return;
    this.#failed = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

export function cleanupWindowsSupervisorHelper(
  helper: ChildProcess,
  closeReceipt: Promise<ChildProcessCloseReceipt>,
  timeoutMs = 1_000,
): Promise<boolean> {
  const existing = supervisorHelperCleanupPromises.get(helper);
  if (existing !== undefined) return existing;
  const cleanup = performWindowsSupervisorHelperCleanup(helper, closeReceipt, timeoutMs);
  supervisorHelperCleanupPromises.set(helper, cleanup);
  return cleanup;
}

async function performWindowsSupervisorHelperCleanup(
  helper: ChildProcess,
  closeReceipt: Promise<ChildProcessCloseReceipt>,
  timeoutMs: number,
): Promise<boolean> {
  let closed = await waitWithTimeout(closeReceipt, 1);
  const firstWaitMs = Math.max(1, Math.floor(timeoutMs / 2));
  if (closed === undefined) {
    try { helper.kill(); } catch { /* escalate below */ }
    closed = await waitWithTimeout(closeReceipt, firstWaitMs);
  }
  if (closed === undefined) {
    try { helper.kill("SIGKILL"); } catch { /* bounded cleanup is exhausted */ }
    closed = await waitWithTimeout(closeReceipt, Math.max(1, timeoutMs - firstWaitMs));
  }
  if (closed === undefined) {
    retainUnclosedWindowsSupervisorHelper(helper, closeReceipt);
    return false;
  }
  releaseClosedWindowsSupervisorHelper(helper);
  return true;
}

function retainUnclosedWindowsSupervisorHelper(
  helper: ChildProcess,
  closeReceipt: Promise<ChildProcessCloseReceipt>,
): SupervisorHelperRetention {
  const existing = supervisorHelperRetentionsByProcess.get(helper);
  if (existing !== undefined) return existing;
  const retention = Object.freeze({ helper, closeReceipt });
  supervisorHelperRetentionsByProcess.set(helper, retention);
  unsafeSupervisorHelperRetentions.add(retention);
  void closeReceipt.then(() => {
    releaseClosedWindowsSupervisorHelper(helper);
    unsafeSupervisorHelperRetentions.delete(retention);
    supervisorHelperRetentionsByProcess.delete(helper);
  }, () => {
    // A rejected receipt cannot prove close; retain the exact helper owner.
  });
  return retention;
}

function releaseClosedWindowsSupervisorHelper(helper: ChildProcess): void {
  if (releasedSupervisorHelpers.has(helper)) return;
  releasedSupervisorHelpers.add(helper);
  for (const stream of [helper.stdin, helper.stdout, helper.stderr]) {
    try { stream?.destroy(); } catch { /* cleanup remains best effort */ }
  }
  try { helper.unref(); } catch { /* cleanup remains best effort */ }
}

function minimalWindowsHelperEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "LANG", "LC_ALL"] as const) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function createJobHelperEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = minimalWindowsHelperEnvironment(source);
  for (const key of ["TEMP", "TMP"] as const) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
