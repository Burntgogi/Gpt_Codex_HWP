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
const ALLOWED_ROOTS_CASES = Object.freeze([
  "allowed roots: absent configuration preserves unrestricted local paths",
  "allowed roots: malformed, empty, relative, duplicate, and oversized configuration fails closed without values",
  "allowed roots: normal descendants and missing output parents return canonical safe paths",
  "allowed roots: prefix siblings, traversal, and mixed separators fail with a stable redacted error",
  "allowed roots: an existing final symlink is rejected even when it targets the allowed tree",
  "allowed roots: a configured symlink or junction root is rejected without disclosure",
  "allowed roots: a hard link reached through an outside path is rejected",
  "allowed roots: Unicode normalization aliases cannot escape the configured root",
  "allowed roots: platform root and case semantics follow the filesystem",
  "allowed roots: UNC semantics are capability-skipped when no test share is available",
  "allowed roots: inaccessible UNC configuration fails closed without the server or share name",
  "allowed roots: active policy is enforced at snapshot, bounded-read, output, and MCP result boundaries",
  "allowed roots: MCP startup rejects malformed configuration without echoing environment values and sync server creation remains available",
  "allowed roots: the MCP executable exits before transport startup and redacts malformed environment input",
  "allowed roots: all nine MCP tools return the same redacted denial for blocked user paths",
  "allowed roots: hwp_read blocks Markdown and extracted-image destinations before writing",
  "allowed roots: an existing linked output parent is rejected",
  "allowed roots: a directory-link swap between authorization and snapshot verification is rejected",
].map((pattern, index) => Object.freeze({
  id: `ar${String(index + 1).padStart(2, "0")}`,
  pattern: `^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
  allowAllSkipped: index === 9 || index === 10,
})));

export async function runMacNodeTestsDiagnostic(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const runFile = options.runFile ?? ((file) => executeTestFile(file, {
    spawnProcess: options.spawnProcess ?? spawn,
    terminateTree: options.terminateTree ?? terminateTree,
    testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
    closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
  }));
  const runAllowedRootsCase = options.runAllowedRootsCase ?? ((record) => executeTestFile(
    "allowed-roots.test.ts",
    {
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      testNamePattern: record.pattern,
      allowAllSkipped: record.allowAllSkipped,
    },
  ));

  for (const file of TEST_FILES) {
    let passed = false;
    try { passed = await runFile(file) === true; } catch { passed = false; }
    if (!passed) {
      if (file === "allowed-roots.test.ts") {
        for (const record of ALLOWED_ROOTS_CASES) {
          let casePassed = false;
          try { casePassed = await runAllowedRootsCase(record) === true; } catch { casePassed = false; }
          if (!casePassed) {
            stdout.write(`MAC_NODE_TEST_CASE case=${record.id} status=failed\n`);
            setExitCode(1);
            return false;
          }
        }
        stdout.write("MAC_NODE_TEST_CASE case=aggregate status=failed\n");
        setExitCode(1);
        return false;
      }
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
      const args = ["--import", "tsx", "--test", "--test-concurrency=1"];
      if (options.testNamePattern !== undefined) {
        args.push(`--test-name-pattern=${options.testNamePattern}`);
      }
      args.push(`tests/${file}`);
      child = options.spawnProcess(process.execPath, args, {
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
      else finish(code === 0 && signal === null && validTapReceipt(
        chunks, capturedBytes, options.allowAllSkipped === true,
      ));
    });
    testTimer = setTimeout(stopUnverified, options.testTimeoutMs);
  });
}

function validTapReceipt(chunks, capturedBytes, allowAllSkipped = false) {
  if (capturedBytes < 1 || capturedBytes > MAX_CAPTURE_BYTES) return false;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes)); }
  catch { return false; }
  const tests = Number(/^# tests ([1-9][0-9]*)$/mu.exec(text)?.[1]);
  const passed = Number(/^# pass ([0-9]+)$/mu.exec(text)?.[1]);
  const skipped = Number(/^# skipped ([0-9]+)$/mu.exec(text)?.[1]);
  const validExecution = passed >= 1 || (allowAllSkipped && passed === 0 && skipped === tests);
  return Number.isSafeInteger(tests) && Number.isSafeInteger(passed)
    && Number.isSafeInteger(skipped) && validExecution && tests === passed + skipped
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
