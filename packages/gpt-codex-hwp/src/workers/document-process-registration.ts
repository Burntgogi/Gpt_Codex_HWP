import { randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fstatSync,
  readSync,
  writeSync,
} from "node:fs";

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
