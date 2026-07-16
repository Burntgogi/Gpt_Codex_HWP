import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  BoundedFrameDecoder,
  parseBoundedJsonFrame,
} from "./bounded-frame.js";

export const DOCTOR_RUNNER_SCHEMA_VERSION = 1;
export const DOCTOR_RUNNER_MAX_FRAME_BYTES = 32 * 1024;
export const DOCTOR_RUNNER_READY = "GPT_CODEX_HWP_DOCTOR_RUNNER READY 1\n";
const DOCTOR_RUNNER_INPUT_TIMEOUT_MS = 15_000;
const MAX_COMMAND_BYTES = 4 * 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_TOTAL_ARGUMENT_BYTES = 24 * 1024;

export interface DoctorRunnerRequest {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly args: readonly string[];
}

export function parseDoctorRunnerRequest(value: unknown): DoctorRunnerRequest {
  if (!plainObject(value)) throw new Error("invalid doctor runner request");
  const keys = Object.keys(value);
  if (keys.length !== 3 || keys[0] !== "schemaVersion" || keys[1] !== "command"
    || keys[2] !== "args" || value.schemaVersion !== DOCTOR_RUNNER_SCHEMA_VERSION
    || !boundedString(value.command, MAX_COMMAND_BYTES) || !Array.isArray(value.args)
    || value.args.length > MAX_ARGUMENTS) {
    throw new Error("invalid doctor runner request");
  }
  let totalArgumentBytes = 0;
  for (const argument of value.args) {
    if (!boundedString(argument, MAX_ARGUMENT_BYTES, true)) {
      throw new Error("invalid doctor runner request");
    }
    totalArgumentBytes += Buffer.byteLength(argument, "utf8");
    if (totalArgumentBytes > MAX_TOTAL_ARGUMENT_BYTES) {
      throw new Error("invalid doctor runner request");
    }
  }
  return Object.freeze({
    schemaVersion: DOCTOR_RUNNER_SCHEMA_VERSION,
    command: value.command,
    args: Object.freeze([...value.args]),
  });
}

export async function readDoctorRunnerRequest(
  input: NodeJS.ReadableStream,
  timeoutMs = DOCTOR_RUNNER_INPUT_TIMEOUT_MS,
): Promise<DoctorRunnerRequest> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOCTOR_RUNNER_INPUT_TIMEOUT_MS) {
    throw new Error("invalid doctor runner input timeout");
  }
  const decoder = new BoundedFrameDecoder(DOCTOR_RUNNER_MAX_FRAME_BYTES);
  const frames: Buffer[] = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      if (error !== undefined) reject(error);
      else {
        try {
          decoder.finish();
          if (frames.length !== 1) throw new Error("doctor runner requires exactly one frame");
          resolve(parseDoctorRunnerRequest(parseBoundedJsonFrame(frames[0]!)));
        } catch (caught: unknown) {
          reject(caught);
        }
      }
    };
    const onData = (chunk: Buffer): void => {
      try {
        frames.push(...decoder.push(chunk));
        if (frames.length > 1) finish(new Error("doctor runner received duplicate frames"));
      } catch (error: unknown) {
        finish(error);
      }
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new Error("doctor runner input failed"));
    const timer = setTimeout(
      () => finish(new Error("doctor runner input timed out")),
      timeoutMs,
    );
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

export async function runDoctorCommandRunner(): Promise<number> {
  const control = createWriteStream("", { fd: 3, autoClose: true });
  await new Promise<void>((resolve, reject) => {
    control.end(DOCTOR_RUNNER_READY, (error?: Error | null) => {
      if (error == null) resolve();
      else reject(error);
    });
  });
  const request = await readDoctorRunnerRequest(process.stdin);
  return new Promise((resolve) => {
    const child = spawn(request.command, [...request.args], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("error", () => finish(127));
    child.once("close", (code, signal) => finish(code ?? (signal === null ? 1 : 128)));
  });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  runDoctorCommandRunner().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.exitCode = 127;
  });
}
