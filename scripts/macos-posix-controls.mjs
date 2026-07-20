import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(PROJECT_ROOT, "packages/gpt-codex-hwp");
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const CONTROLS = Object.freeze([
  Object.freeze({
    name: "real-detect",
    pattern: "^benchmark policy records a real nonempty detect dispatch before its one defensive copy$",
  }),
  Object.freeze({
    name: "abnormal-descendant",
    pattern: "^benchmark policy verifies descendant termination after abnormal case exit$",
  }),
]);

export async function runMacPosixControls(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const runControl = options.runControl
    ?? ((control) => executeControl(control, {
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateControlTree,
      controlTimeoutMs: boundedTimeout(
        options.controlTimeoutMs,
        DEFAULT_CONTROL_TIMEOUT_MS,
      ),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
    }));
  let passed = true;

  for (const control of CONTROLS) {
    let controlPassed = false;
    try {
      controlPassed = await runControl(control) === true;
    } catch {
      controlPassed = false;
    }
    stdout.write(
      `MAC_POSIX_CONTROL name=${control.name} status=${controlPassed ? "passed" : "failed"}\n`,
    );
    if (!controlPassed) passed = false;
  }

  setExitCode(passed ? 0 : 1);
  return passed;
}

function executeControl(control, options) {
  return new Promise((resolveControl) => {
    let settled = false;
    let stopping = false;
    let capturedBytes = 0;
    const chunks = [];
    let controlTimer;
    let closeTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(controlTimer);
      clearTimeout(closeTimer);
      child?.stdout?.destroy();
      resolveControl(value);
    };
    const stopUnverified = () => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(controlTimer);
      try {
        void options.terminateTree(child);
      } catch {
        // A signal request is not proof; exact close remains required below.
      }
      if (settled) return;
      closeTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.unref?.();
        finish(false);
      }, options.closeTimeoutMs);
    };
    let child;
    try {
      child = options.spawnProcess(process.execPath, [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        `--test-name-pattern=${control.pattern}`,
        "tests/benchmark-policy.test.ts",
      ], {
        cwd: PACKAGE_ROOT,
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        shell: false,
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }
    if (child.stdout === null || child.stdout === undefined || !("on" in child.stdout)) {
      stopUnverified();
      return;
    }
    child.stdout.once("error", stopUnverified);
    child.stdout.on("data", (chunk) => {
      if (settled || stopping || !Buffer.isBuffer(chunk)) {
        if (!Buffer.isBuffer(chunk)) stopUnverified();
        return;
      }
      capturedBytes += chunk.byteLength;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        stopUnverified();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", stopUnverified);
    child.once("close", (code, signal) => {
      if (stopping) {
        finish(false);
        return;
      }
      finish(
        code === 0
          && signal === null
          && validControlTapReceipt(control, chunks, capturedBytes),
      );
    });
    controlTimer = setTimeout(stopUnverified, options.controlTimeoutMs);
  });
}

function validControlTapReceipt(control, chunks, capturedBytes) {
  if (capturedBytes < 1 || capturedBytes > MAX_CAPTURE_BYTES) return false;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes));
  } catch {
    return false;
  }
  const normalized = text.replaceAll("\r\n", "\n");
  const escapedName = control.pattern.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const subtest = new RegExp(`^# Subtest: ${escapedName}$`, "gmu");
  const passed = new RegExp(`^ok [1-9][0-9]* - ${escapedName}$`, "gmu");
  return [...normalized.matchAll(subtest)].length === 1
    && [...normalized.matchAll(passed)].length === 1
    && /^# pass 1$/mu.test(normalized)
    && /^# fail 0$/mu.test(normalized)
    && /^# cancelled 0$/mu.test(normalized);
}

function terminateControlTree(child) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else child.kill("SIGKILL");
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    try {
      return child.kill("SIGKILL") === true;
    } catch {
      return false;
    }
  }
}

function boundedTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) return fallback;
  return value;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runMacPosixControls();
}
