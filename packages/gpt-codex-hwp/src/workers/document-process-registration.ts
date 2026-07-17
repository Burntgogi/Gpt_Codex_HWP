import { randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fstatSync,
  readSync,
  writeSync,
} from "node:fs";
import { performance } from "node:perf_hooks";

import {
  normalizeProcessTreeTerminationReceipt,
  unverifiedTermination,
  type ProcessTreeTerminationReceipt,
  type RegisteredProcessGroupSupervisor,
  type UnverifiedTerminationReason,
} from "./registered-process-supervisor.js";

export const DOCUMENT_START_DESCRIPTOR = 7;
export const BENCHMARK_REGISTRATION_DESCRIPTOR = 8;
export const BENCHMARK_ACK_DESCRIPTOR = 9;
export const DOCUMENT_START_FRAME = "GPT_CODEX_HWP_START_V1\n";
export const MAX_REGISTRATION_FRAME_BYTES = 1_024;
export const MAX_REGISTRATION_CHANNEL_BYTES = 16 * 1_024;
export const MAX_REGISTERED_DOCUMENT_GROUPS = 16;

export interface RegisterFrame {
  readonly schemaVersion: 1;
  readonly type: "register";
  readonly nonce: string;
  readonly pid: number;
  readonly parentPid: number;
}

export interface AckFrame {
  readonly schemaVersion: 1;
  readonly type: "ack";
  readonly nonce: string;
  readonly status: "accepted" | "rejected";
}

export type RegistrationCoordinatorState = "open" | "closing" | "sealed" | "failed";

export interface ProcessRegistrationCoordinator {
  readonly state: RegistrationCoordinatorState;
  start(): void;
  beginClosing(): Promise<void>;
  seal(): Promise<void>;
  terminateRegisteredGroups(): Promise<ProcessTreeTerminationReceipt>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const START_BYTES = TEXT_ENCODER.encode(DOCUMENT_START_FRAME);

const enum PrivateExitCode {
  DescriptorProbe = 71,
  RegistrationWrite = 72,
  RegistrationAck = 73,
  RegistrationClose = 74,
  StartFrame = 75,
  LifelineData = 76,
  LifelineError = 77,
  LifelineEnd = 78,
  Unexpected = 79,
}

export function parseRegisterFrame(value: unknown): RegisterFrame {
  try {
    return validateRegisterValue(parseFrameValue(value));
  } catch {
    throw new Error("invalid register frame");
  }
}

export function parseAckFrame(value: unknown): AckFrame {
  try {
    return validateAckValue(parseFrameValue(value));
  } catch {
    throw new Error("invalid ack frame");
  }
}

export function encodeRegisterFrame(frame: RegisterFrame): Uint8Array {
  try {
    return encodeFrame(validateRegisterValue(frame));
  } catch {
    throw new Error("invalid register frame");
  }
}

export function encodeAckFrame(frame: AckFrame): Uint8Array {
  try {
    return encodeFrame(validateAckValue(frame));
  } catch {
    throw new Error("invalid ack frame");
  }
}

export function createProcessRegistrationCoordinator(options: Readonly<{
  casePid: number;
  registrationInput: NodeJS.ReadableStream;
  acknowledgementOutput: NodeJS.WritableStream;
  supervisor: RegisteredProcessGroupSupervisor;
  caseExited: Promise<void>;
  deadlineAt: number;
}>): ProcessRegistrationCoordinator {
  if (!isSafePositiveInteger(options.casePid) ||
    !Number.isFinite(options.deadlineAt) ||
    options.deadlineAt <= performance.now()) {
    throw new Error("invalid registration coordinator options");
  }
  let state: RegistrationCoordinatorState = "open";
  let started = false;
  let closingRequested = false;
  let readableEnded = false;
  let readableClosed = false;
  let caseExited = false;
  let channelBytes = 0;
  let pendingFrame = Buffer.alloc(0);
  let inFlightRegistrations = 0;
  let retainedGroups = 0;
  let poisonReason: UnverifiedTerminationReason | undefined;
  let queueTail: Promise<void> = Promise.resolve();
  let authorityCleanupTail: Promise<void> = Promise.resolve();
  let sealPromise: Promise<void> | undefined;
  let pendingAckReject: ((error: Error) => void) | undefined;
  const nonces = new Set<string>();
  const pids = new Set<number>();
  const registrationSettlements = new Set<Promise<void>>();
  let resolveReadableEnd!: () => void;
  const readableEnd = new Promise<void>((resolvePromise) => {
    resolveReadableEnd = resolvePromise;
  });
  let acknowledgementCloseSettled = false;
  let settleAcknowledgementClose!: (receipt: Readonly<{
    closed: boolean;
    error: Error | null;
  }>) => void;
  const acknowledgementCloseReceipt = new Promise<Readonly<{
    closed: boolean;
    error: Error | null;
  }>>((resolvePromise) => {
    settleAcknowledgementClose = resolvePromise;
  });
  const remaining = Math.max(0, options.deadlineAt - performance.now());
  const deadlineTimer = setTimeout(() => {
    fail("deadline");
  }, remaining);
  deadlineTimer.unref();

  const onAcknowledgementError = (error: Error): void => {
    if (!acknowledgementCloseSettled) {
      acknowledgementCloseSettled = true;
      settleAcknowledgementClose({ closed: false, error });
    }
    pendingAckReject?.(error);
    fail("channel");
  };
  const onAcknowledgementClose = (): void => {
    options.acknowledgementOutput.removeListener("error", onAcknowledgementError);
    if (!acknowledgementCloseSettled) {
      acknowledgementCloseSettled = true;
      settleAcknowledgementClose({ closed: true, error: null });
    }
  };
  options.acknowledgementOutput.on("error", onAcknowledgementError);
  options.acknowledgementOutput.once("close", onAcknowledgementClose);

  void options.caseExited.then(
    () => { caseExited = true; },
    () => { fail("channel"); },
  ).catch(() => { fail("channel"); });

  const enqueue = (operation: () => void | Promise<void>): Promise<void> => {
    const result = queueTail.then(operation);
    queueTail = result.catch(() => {});
    return result;
  };
  const currentState = (): RegistrationCoordinatorState => state;

  const runAcknowledgementOperation = (
    operation: (settle: (error?: Error | null) => void) => void,
  ): Promise<void> => bounded(new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        if (pendingAckReject === rejectAck) pendingAckReject = undefined;
        if (error === undefined || error === null) resolvePromise();
        else rejectPromise(error);
      };
      const rejectAck = (error: Error): void => settle(error);
      pendingAckReject = rejectAck;
      try {
        operation(settle);
      } catch (error: unknown) {
        settle(error instanceof Error ? error : new Error("ACK write failed"));
      }
    }));

  const writeAcknowledgement = (frame: AckFrame): Promise<void> =>
    runAcknowledgementOperation((settle) => {
      options.acknowledgementOutput.write(
        Buffer.from(encodeAckFrame(frame)),
        (error?: Error | null) => settle(error),
      );
    });

  const scheduleAuthorityCleanup = (): void => {
    authorityCleanupTail = authorityCleanupTail.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let receipt: ProcessTreeTerminationReceipt;
        try {
          receipt = normalizeProcessTreeTerminationReceipt(
            await options.supervisor.terminate(),
          );
        } catch {
          receipt = unverifiedTermination("termination");
        }
        if (receipt.gone === true && receipt.proof === "registered-groups-empty") return;
      }
    }).catch(() => {
      // Retention remains owned and a later public termination can retry authority.
    });
  };

  const reserveAndQueue = (bytes: Buffer): void => {
    if (state === "failed" || state === "sealed") return;
    let frame: RegisterFrame;
    try {
      frame = parseRegisterFrame(bytes);
    } catch {
      fail("channel");
      return;
    }
    if (nonces.has(frame.nonce) || pids.has(frame.pid) ||
      nonces.size >= MAX_REGISTERED_DOCUMENT_GROUPS ||
      inFlightRegistrations !== 0) {
      fail("channel");
      return;
    }
    nonces.add(frame.nonce);
    pids.add(frame.pid);
    inFlightRegistrations += 1;
    void enqueue(async () => {
      let retained = false;
      try {
        if (state === "failed" || state === "sealed") return;
        const commitState = currentState();
        if (commitState === "open" && frame.parentPid !== options.casePid) {
          fail("channel");
          throw new Error("registration frame parent mismatch");
        }
        const expectedParentPid = commitState === "open" ? options.casePid : undefined;
        const registration = Promise.resolve().then(() =>
          options.supervisor.registerRoot(frame.pid, expectedParentPid));
        const ownedRegistration = registration.then((identity) => {
          retained = true;
          retainedGroups += 1;
          if (state === "failed") scheduleAuthorityCleanup();
          return identity;
        });
        let settlement!: Promise<void>;
        settlement = ownedRegistration.then(
          () => { registrationSettlements.delete(settlement); },
          () => { registrationSettlements.delete(settlement); },
        );
        registrationSettlements.add(settlement);
        await bounded(ownedRegistration);
        if (currentState() === "failed" || currentState() === "sealed") {
          scheduleAuthorityCleanup();
          throw new Error("registration coordinator poisoned after retention");
        }
        const status = state === "open" ? "accepted" : "rejected";
        await writeAcknowledgement({
          schemaVersion: 1,
          type: "ack",
          nonce: frame.nonce,
          status,
        });
      } catch {
        fail(poisonReason ?? (retained ? "channel" : "identity"));
        if (retained) scheduleAuthorityCleanup();
        throw new Error("registration coordinator job failed");
      } finally {
        inFlightRegistrations -= 1;
      }
    });
  };

  const onData = (chunk: string | Buffer | Uint8Array): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    channelBytes += bytes.byteLength;
    if (channelBytes > MAX_REGISTRATION_CHANNEL_BYTES) {
      fail("channel");
      return;
    }
    if (state === "failed") return;
    if (inFlightRegistrations !== 0) {
      fail("channel");
      return;
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.byteLength : newline + 1;
      const segment = bytes.subarray(offset, end);
      if (pendingFrame.byteLength + segment.byteLength > MAX_REGISTRATION_FRAME_BYTES) {
        fail("channel");
        return;
      }
      pendingFrame = Buffer.concat([pendingFrame, segment]);
      offset = end;
      if (newline !== -1) {
        const complete = pendingFrame;
        pendingFrame = Buffer.alloc(0);
        reserveAndQueue(complete);
        if (currentState() === "failed") return;
        if (offset < bytes.byteLength && inFlightRegistrations !== 0) {
          fail("channel");
          return;
        }
      }
    }
  };
  const onEnd = (): void => {
    readableEnded = true;
    if (pendingFrame.byteLength !== 0) fail("channel");
    resolveReadableEnd();
  };
  const onError = (): void => { fail("channel"); };
  const onClose = (): void => {
    readableClosed = true;
    if (!readableEnded) fail("channel");
  };

  function fail(reason: UnverifiedTerminationReason): void {
    poisonReason ??= reason;
    state = "failed";
    clearTimeout(deadlineTimer);
    pendingAckReject?.(new Error("registration acknowledgement channel failed"));
    try {
      const destroy = (options.acknowledgementOutput as { destroy?: (error?: Error) => void })
        .destroy;
      destroy?.call(options.acknowledgementOutput);
    } catch {
      // The channel is already permanently unverified.
    }
  }

  function bounded<Value>(promise: Promise<Value>): Promise<Value> {
    const milliseconds = options.deadlineAt - performance.now();
    if (milliseconds <= 0) {
      fail("deadline");
      return Promise.reject(new Error("registration coordinator deadline exceeded"));
    }
    return new Promise<Value>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        fail("deadline");
        rejectPromise(new Error("registration coordinator deadline exceeded"));
      }, milliseconds);
      timer.unref();
      void promise.then(
        (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      );
    });
  }

  const coordinator: ProcessRegistrationCoordinator = {
    get state() { return state; },
    start(): void {
      if (started) return;
      started = true;
      options.registrationInput.on("data", onData);
      options.registrationInput.once("end", onEnd);
      options.registrationInput.once("error", onError);
      options.registrationInput.once("close", onClose);
    },
    beginClosing(): Promise<void> {
      closingRequested = true;
      return enqueue(() => {
        if (state === "failed") {
          throw new Error("registration coordinator failed");
        }
        if (state === "open") state = "closing";
      });
    },
    seal(): Promise<void> {
      if (sealPromise !== undefined) return sealPromise;
      if (!started || !closingRequested) {
        return Promise.reject(new Error("registration coordinator is not closing"));
      }
      if (state === "failed") {
        return Promise.reject(new Error("registration coordinator failed"));
      }
      sealPromise = bounded((async () => {
        await readableEnd;
        await options.caseExited;
        caseExited = true;
        await queueTail;
        if (currentState() === "failed" || !readableEnded || readableClosed && !readableEnded ||
          pendingFrame.byteLength !== 0 || inFlightRegistrations !== 0 || !caseExited) {
          throw new Error("registration coordinator failed to seal");
        }
        await runAcknowledgementOperation((settle) => {
            const end = (options.acknowledgementOutput as {
              end?: (callback?: () => void) => void;
            }).end;
            if (end === undefined) {
              settle();
              return;
            }
            end.call(options.acknowledgementOutput, () => settle());
        });
        const closeReceipt = await bounded(acknowledgementCloseReceipt);
        if (!closeReceipt.closed || closeReceipt.error !== null) {
          throw closeReceipt.error ?? new Error("ACK channel failed to close cleanly");
        }
        if (poisonReason !== undefined || currentState() !== "closing") {
          throw new Error("registration coordinator failed before ACK channel close");
        }
        state = "sealed";
        clearTimeout(deadlineTimer);
      })()).catch((error: unknown) => {
        fail(poisonReason ?? "channel");
        throw error;
      });
      return sealPromise;
    },
    async terminateRegisteredGroups(): Promise<ProcessTreeTerminationReceipt> {
      try {
        await bounded(Promise.all([
          queueTail,
          ...registrationSettlements,
        ]));
      } catch {
        // Deadline/channel poison keeps proof unverified, but authority still runs.
      }
      let receipt: ProcessTreeTerminationReceipt;
      if (retainedGroups === 0 && state === "sealed") {
        receipt = Object.freeze({ gone: true, proof: "registered-groups-empty" });
      } else {
        try {
          receipt = normalizeProcessTreeTerminationReceipt(
            await options.supervisor.terminate(),
          );
        } catch {
          receipt = unverifiedTermination("termination");
        }
      }
      if (poisonReason !== undefined || state === "failed") {
        return unverifiedTermination(poisonReason ?? "channel");
      }
      if (state !== "sealed") return unverifiedTermination("registration");
      return receipt;
    },
  };
  return coordinator;
}

export function runDocumentChildStartGate(): void {
  try {
    const registrationPresent = probeRegistrationDescriptors();
    if (registrationPresent) registerDocumentProcess();
    readStartFrame();
    installLifelineWatcher();
  } catch {
    privateExit(PrivateExitCode.Unexpected);
  }
}

function parseFrameValue(value: unknown): unknown {
  if (!(value instanceof Uint8Array) ||
    value.byteLength < 2 ||
    value.byteLength > MAX_REGISTRATION_FRAME_BYTES ||
    value[value.byteLength - 1] !== 0x0a) {
    throw new Error("invalid bounded frame");
  }
  for (let index = 0; index < value.byteLength - 1; index += 1) {
    if (value[index] === 0x0a) throw new Error("trailing frame data");
  }
  const json = TEXT_DECODER.decode(value.subarray(0, value.byteLength - 1));
  return JSON.parse(json);
}

function encodeFrame(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("frame is not serializable");
  const payload = TEXT_ENCODER.encode(json);
  if (payload.byteLength + 1 > MAX_REGISTRATION_FRAME_BYTES) {
    throw new Error("frame exceeds limit");
  }
  const frame = new Uint8Array(payload.byteLength + 1);
  frame.set(payload);
  frame[frame.byteLength - 1] = 0x0a;
  return frame;
}

function validateRegisterValue(value: unknown): RegisterFrame {
  if (!isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "type", "nonce", "pid", "parentPid"]) ||
    value.schemaVersion !== 1 ||
    value.type !== "register" ||
    typeof value.nonce !== "string" ||
    !UUID_PATTERN.test(value.nonce) ||
    !isSafePositiveInteger(value.pid) ||
    !isSafePositiveInteger(value.parentPid)) {
    throw new Error("invalid register frame");
  }
  return {
    schemaVersion: 1,
    type: "register",
    nonce: value.nonce,
    pid: value.pid,
    parentPid: value.parentPid,
  };
}

function validateAckValue(value: unknown): AckFrame {
  if (!isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "type", "nonce", "status"]) ||
    value.schemaVersion !== 1 ||
    value.type !== "ack" ||
    typeof value.nonce !== "string" ||
    !UUID_PATTERN.test(value.nonce) ||
    (value.status !== "accepted" && value.status !== "rejected")) {
    throw new Error("invalid ack frame");
  }
  return {
    schemaVersion: 1,
    type: "ack",
    nonce: value.nonce,
    status: value.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index]);
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function probeRegistrationDescriptors(): boolean {
  let registration: boolean;
  let acknowledgement: boolean;
  try {
    registration = descriptorPresent(BENCHMARK_REGISTRATION_DESCRIPTOR);
    acknowledgement = descriptorPresent(BENCHMARK_ACK_DESCRIPTOR);
  } catch {
    privateExit(PrivateExitCode.DescriptorProbe);
  }
  if (registration !== acknowledgement) privateExit(PrivateExitCode.DescriptorProbe);
  return registration;
}

function descriptorPresent(descriptor: number): boolean {
  try {
    fstatSync(descriptor);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EBADF") return false;
    throw error;
  }
}

function registerDocumentProcess(): void {
  const nonce = randomUUID();
  const frame = encodeRegisterFrame({
    schemaVersion: 1,
    type: "register",
    nonce,
    pid: process.pid,
    parentPid: process.ppid,
  });
  try {
    writeAll(BENCHMARK_REGISTRATION_DESCRIPTOR, frame);
  } catch {
    privateExit(PrivateExitCode.RegistrationWrite);
  }

  let acknowledgement: AckFrame;
  try {
    acknowledgement = parseAckFrame(readOneRegistrationFrame(BENCHMARK_ACK_DESCRIPTOR));
  } catch {
    privateExit(PrivateExitCode.RegistrationAck);
  }
  if (acknowledgement.nonce !== nonce || acknowledgement.status !== "accepted") {
    privateExit(PrivateExitCode.RegistrationAck);
  }
  try {
    closeSync(BENCHMARK_REGISTRATION_DESCRIPTOR);
    closeSync(BENCHMARK_ACK_DESCRIPTOR);
  } catch {
    privateExit(PrivateExitCode.RegistrationClose);
  }
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("registration write failed");
    offset += written;
  }
}

function readOneRegistrationFrame(descriptor: number): Uint8Array {
  const frame = Buffer.allocUnsafeSlow(MAX_REGISTRATION_FRAME_BYTES);
  const readBuffer = Buffer.allocUnsafeSlow(MAX_REGISTRATION_CHANNEL_BYTES);
  let frameBytes = 0;
  while (true) {
    const count = readSync(descriptor, readBuffer, 0, readBuffer.byteLength, null);
    if (count === 0) throw new Error("registration channel ended");
    const newline = readBuffer.subarray(0, count).indexOf(0x0a);
    if (newline !== -1 && newline !== count - 1) throw new Error("trailing registration data");
    if (frameBytes + count > MAX_REGISTRATION_FRAME_BYTES) {
      throw new Error("registration frame exceeds limit");
    }
    frame.set(readBuffer.subarray(0, count), frameBytes);
    frameBytes += count;
    if (newline !== -1) return frame.subarray(0, frameBytes);
  }
}

function readStartFrame(): void {
  const received = Buffer.allocUnsafeSlow(START_BYTES.byteLength + 1);
  let offset = 0;
  try {
    while (offset < START_BYTES.byteLength) {
      const count = readSync(
        DOCUMENT_START_DESCRIPTOR,
        received,
        offset,
        received.byteLength - offset,
        null,
      );
      if (count === 0) privateExit(PrivateExitCode.StartFrame);
      offset += count;
      if (offset > START_BYTES.byteLength) privateExit(PrivateExitCode.StartFrame);
    }
  } catch {
    privateExit(PrivateExitCode.StartFrame);
  }
  if (!received.subarray(0, offset).equals(START_BYTES)) {
    privateExit(PrivateExitCode.StartFrame);
  }
}

function installLifelineWatcher(): void {
  let terminal = false;
  const lifeline = createReadStream("", {
    fd: DOCUMENT_START_DESCRIPTOR,
    autoClose: false,
  });
  lifeline.on("data", () => {
    if (terminal) return;
    terminal = true;
    privateExit(PrivateExitCode.LifelineData);
  });
  lifeline.on("error", () => {
    if (terminal) return;
    terminal = true;
    privateExit(PrivateExitCode.LifelineError);
  });
  lifeline.on("end", () => {
    if (terminal) return;
    terminal = true;
    if (process.platform === "win32") privateExit(PrivateExitCode.LifelineEnd);
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      privateExit(PrivateExitCode.LifelineEnd);
    }
  });
  lifeline.resume();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function privateExit(code: PrivateExitCode): never {
  process.exit(code);
}
