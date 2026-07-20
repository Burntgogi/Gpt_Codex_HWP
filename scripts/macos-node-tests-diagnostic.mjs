import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(PROJECT_ROOT, "packages/gpt-codex-hwp");
const MAX_CAPTURE_BYTES = 512 * 1024;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const TEST_FILES = Object.freeze([
  "allowed-roots.test.ts", "assets.test.ts", "benchmark-policy.test.ts",
  "bounded-frame.test.ts", "build-assets.test.ts", "compact-runtime.test.ts",
  "doctor-command-runner.test.ts", "doctor.test.ts", "document-child-client.test.ts",
  "document-contract.test.ts", "document-mutation-preflight.test.ts",
  "document-process-registration.test.ts", "document-protocol.test.ts",
  "document-snapshot.test.ts", "document-worker-client.test.ts",
  "document-worker-operations.test.ts", "files.test.ts", "font-integrity.test.ts",
  "hwp-fixture-integrity.test.ts", "hwp-fixture.test.ts", "hwp-plugin.test.ts",
  "hwpx-anchor.test.ts", "kordoc-core-runtime.test.ts", "markdown-output.test.ts",
  "mcp-cancellation-progress.test.ts", "mcp-smoke.test.ts",
  "output-budget-atomicity.test.ts", "patch.test.ts", "paths.test.ts",
  "protection.test.ts", "public-runtime-privacy.test.ts", "read-worker-safety.test.ts",
  "release-artifacts.test.ts", "release-metadata.test.ts", "result.test.ts",
  "rhwp-backend.test.ts", "runtime-projection.test.ts", "tools.test.ts",
  "validation-regressions.test.ts", "windows-hosted-diagnostic.test.ts",
  "write-worker-safety.test.ts",
]);

export async function runMacNodeTestsDiagnostic(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const runFile = options.runFile ?? ((file) => executeTestFile(file, {
    spawnProcess: options.spawnProcess ?? spawn,
    terminateTree: options.terminateTree ?? terminateTree,
    testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
    closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
  }));

  for (const file of TEST_FILES) {
    let passed = false;
    try { passed = await runFile(file) === true; } catch { passed = false; }
    if (!passed) {
      stdout.write(`MAC_NODE_TEST_FILE file=${file} status=failed\n`);
      setExitCode(1);
      return false;
    }
  }
  stdout.write(`MAC_NODE_TEST_FILES status=passed files=${TEST_FILES.length}\n`);
  setExitCode(0);
  return true;
}

function executeTestFile(file, options) {
  return new Promise((resolveTest) => {
    let child;
    let settled = false;
    let stopping = false;
    let capturedBytes = 0;
    const chunks = [];
    let testTimer;
    let closeTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(testTimer);
      clearTimeout(closeTimer);
      child?.stdout?.destroy();
      resolveTest(value);
    };
    const stopUnverified = () => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(testTimer);
      try { void options.terminateTree(child); } catch {}
      if (settled) return;
      closeTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.unref?.();
        finish(false);
      }, options.closeTimeoutMs);
    };
    try {
      child = options.spawnProcess(process.execPath, [
        "--import", "tsx", "--test", "--test-concurrency=1", `tests/${file}`,
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
      if (stopping) finish(false);
      else finish(code === 0 && signal === null && validTapReceipt(chunks, capturedBytes));
    });
    testTimer = setTimeout(stopUnverified, options.testTimeoutMs);
  });
}

function validTapReceipt(chunks, capturedBytes) {
  if (capturedBytes < 1 || capturedBytes > MAX_CAPTURE_BYTES) return false;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes)); }
  catch { return false; }
  const tests = /^# tests ([1-9][0-9]*)$/mu.exec(text)?.[1];
  const passed = /^# pass ([1-9][0-9]*)$/mu.exec(text)?.[1];
  return tests !== undefined && tests === passed
    && /^# fail 0$/mu.test(text)
    && /^# cancelled 0$/mu.test(text);
}

function terminateTree(child) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(-pid, "SIGKILL"); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return true;
    try { return child.kill("SIGKILL") === true; } catch { return false; }
  }
}

function boundedTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) return fallback;
  return value;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runMacNodeTestsDiagnostic();
}
