import type { ChildProcess } from "node:child_process";
import { win32 } from "node:path";

import type {
  ProcessTreeTerminationReceipt,
  RegisteredProcessGroupIdentity,
} from "./registered-process-supervisor.js";

export const MAX_DRAIN_ACCOUNTED_BYTES = 64 * 1024;

export interface ChildLifecycleSupervisor {
  terminate(): Promise<ProcessTreeTerminationReceipt>;
  /** Optional telemetry readiness only; never process-tree authority or START gating. */
  readonly processTreeTelemetryReady?: Promise<boolean>;
  /** Benchmark-only telemetry anchor; the identity is already authority-retained. */
  registerProcessTreeTelemetryRoot?(identity: RegisteredProcessGroupIdentity): void;
  /** Synchronously freezes complete telemetry or latches it unavailable. */
  finishProcessTreeTelemetry?(): void;
  /** Benchmark-only wait for a sample covering every registered telemetry root. */
  flushProcessTreeTelemetry?(): Promise<boolean>;
  processTreeRss?(): Readonly<{
    baselineBytes: number;
    peakBytes: number;
  }> | undefined;
}

export interface ChildProcessCloseReceipt {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | null;
}

const childProcessCloseReceipts = new WeakMap<object, Promise<ChildProcessCloseReceipt>>();

export function observeChildProcessClose(child: ChildProcess): Promise<ChildProcessCloseReceipt> {
  const existing = childProcessCloseReceipts.get(child);
  if (existing !== undefined) return existing;
  const receipt = new Promise<ChildProcessCloseReceipt>((resolve) => {
    let childError: Error | null = null;
    const onError = (error: Error): void => { childError ??= error; };
    child.on("error", onError);
    child.once("close", (code, signal) => {
      child.removeListener("error", onError);
      resolve(Object.freeze({ code, signal, error: childError }));
    });
  });
  childProcessCloseReceipts.set(child, receipt);
  return receipt;
}

export function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

export function resolveWindowsSystemExecutable(
  name: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot?: string,
): string {
  if (platform !== "win32") return name;
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    throw new Error("absolute SystemRoot is required");
  }
  if (name.toLowerCase() === "powershell.exe") {
    return win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      name,
    );
  }
  return win32.join(systemRoot, "System32", name);
}
