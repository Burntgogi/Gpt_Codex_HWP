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
const ASSETS_CASES = Object.freeze([
  "image snapshot acquisition cleans a document snapshot when the image open fails",
  "Python XML policy rejects encoded DTDs and protection manifests",
  "hwp_create_svg_asset escapes a structured spec and renders a real PNG",
  "hwp_create_svg_asset accepts safe inline SVG and rejects active content without artifacts",
  "hwp_create_svg_asset reserves both outputs atomically and preserves SVG on renderer failure",
  "hwp_create_svg_asset treats an unsafe PNG output parent as a hard failure",
  "after-paragraph inserts a normalized PNG after a body anchor and passes structural gates",
  "after-paragraph inserts inside the same table-cell subList",
  "after-paragraph ignores a hidden-comment anchor before the eligible body anchor",
  "image insertion rejects a source path swapped and restored after snapshot capture",
  "seal-anchor calls the real Kordoc placement path and preserves placement metadata",
  "image insertion rejects missing and ambiguous anchors before creating output",
  "image insertion rejects non-HWPX, bad images, existing output, and source/image aliases",
  "image insertion rejects encrypted and signed HWPX packages",
  "image insertion rejects case-equivalent duplicate protection manifests",
  "image insertion sanitizes SVG inputs even when XML comments precede the root",
  "image insertion rejects a dangling manifest href before editing",
].map((pattern, index) => Object.freeze({
  id: `as${String(index + 1).padStart(2, "0")}`,
  pattern: `^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
  allowAllSkipped: index === 5,
})));
const COMPACT_RUNTIME_CASES = Object.freeze([
  "obsolete public-source references are absent from split release suites",
  "compact runtime package exclusions handle scoped and ordinary paths",
  "compact runtime budgets accept exact limits and reject one byte above",
  "compact runtime anchors Kordoc links to the canonical local vendor target",
  "compact runtime summarizes regular files, links, and exact exclusion evidence",
  "installed runtime npm invocation resolver is injectable without environment mutation",
  "installed runtime child timeout terminates the subprocess",
  "installed runtime child failures do not expose arguments or output",
  "installed runtime child start failures do not expose executable paths",
  "compact command, npm, and tool children receive one scrubbed environment",
  "MCP SDK merges safe defaults with only the no-replace transport override",
  "installed runtime allowFailure preserves raw diagnostic streams",
  "POSIX descendant timeout kills a SIGTERM-resistant process group",
  "npm-ls parser fails closed for invalid results",
  "npm-ls failures redact raw streams and dependency problem details",
  "npm-audit and MCP-stderr failures expose only sanitized evidence",
  "compact runtime CLI accepts only release mode or one diagnostic sample",
  "tool-smoke arguments bind file size and semantic oracle mode",
  "plain compact runtime CLI rejects ambient diagnostic override without leaking it",
  "read-only compact runtime HWP smokes verify the hash after every tool call",
  "read-only compact runtime HWP smokes reject missing semantic evidence",
  "read-only compact runtime HWP smokes accept general diagnostic evidence",
  "read-only compact runtime tool failures do not expose structured content",
  "compact runtime tools receive an owned verified HWP copy",
  "owned HWP copy uses one bounded source handle and fsyncs exact bytes",
  "owned HWP copy rejects changed sources and sanitizes filesystem failures",
  "owned HWP copy post-hashes the source even when destination verification fails",
  "MCP read-only smoke calls the advertised routes and rejects empty routing",
  "classic HWP preview smoke uses the actual isolated runtime route",
  "classic HWP preview smoke rejects non-rhwp or non-SVG evidence",
  "compact integrity hashing rejects a fixture above 512 MiB without exposing its path",
  "compact cleanup verifies owned and source HWP bytes even after a failed smoke",
  "missing sample cleanup creates no compact temp residue",
  "installed runtime gate is serialized in normal npm test",
  "installed runtime skill metadata omits the HML claim",
  "installed runtime verifies provenance, npm ls, and all nine tools",
  "compact runtime staging canonicalizes an injected temporary parent",
].map((pattern, index) => Object.freeze({
  id: `cr${String(index + 1).padStart(2, "0")}`,
  pattern: `^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
})));
const DOCTOR_CASES = Object.freeze([
  "doctor contract reports safe required and optional capability results",
  "doctor contract treats a missing Python runtime as an optional capability",
  "doctor contract treats Python older than 3.10 as optional unavailable",
  "doctor contract keeps optional capabilities separate from required failures",
  "doctor contract maps hostile probe output to stable codes without leaking it",
  "doctor contract rejects an impossible shared Kordoc verifier result",
  "doctor maps shared Kordoc verifier failures to a stable non-leaking code",
  "doctor registration probe rejects wrong missing duplicate extra and throwing registrations",
  "doctor registration probe lists the actual private in-process MCP registry",
  "doctor runtime access rejects linked file and directory ancestors without reading outside bytes",
  "doctor bounded command injects detached group termination and fails closed when it remains alive",
  "doctor timeout still terminates the tree after root exit when close was not observed",
  "Windows doctor gate sends no command before Job readiness and verifies cleanup on normal close",
  "Windows doctor request stdin retains owner-lifetime error handling after its end callback",
  "Windows doctor supervisor failure terminates the gated runner by its exact child handle",
  "Windows doctor gate never dispatches through a forced cleanup-only tracker",
  "Windows doctor gate rejects abnormal READY without dispatch and still finalizes the supervisor",
  "doctor bounded command removes a real descendant after timeout",
  "doctor timeout terminates a grandchild after its parent exits but inherited pipes remain open",
  "Windows doctor Job removes a grandchild after the command parent exits",
  "doctor contract rejects unsupported arguments and emits JSON only in json mode",
].map((pattern, index) => Object.freeze({
  id: `dc${String(index + 1).padStart(2, "0")}`,
  pattern: `^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
  allowAllSkipped: (index >= 12 && index <= 16) || index === 19,
})));
const SVG_ASSET_BOUNDARIES = new Set([
  "root", "handler-import", "sharp-import", "handler", "handler-error",
  "handler-warning", "svg-read", "svg-content", "png-read", "png-magic",
  "metadata", "dimensions", "validation", "render", "path-or-build",
  "passed", "diagnostic-failed",
]);
const COMPACT_RUNTIME_STAGES = new Set([
  "startup", "fixture", "source-hash", "temporary-root", "fixture-copy",
  "runtime-build", "provenance", "lockfile", "npm-ci", "npm-ls", "npm-audit",
  "public-runtime-measure", "node-modules-measure", "installed-tree-measure",
  "node-modules-read", "node-modules-lstat", "node-modules-directory",
  "node-modules-file", "node-modules-link-target", "node-modules-link-expected",
  "node-modules-link-path-rejected", "node-modules-link-target-rejected",
  "node-modules-link-allowed", "node-modules-entry-rejected",
  "installed-tree-read", "installed-tree-lstat", "installed-tree-directory",
  "installed-tree-file", "installed-tree-link-target", "installed-tree-link-expected",
  "installed-tree-link-path-rejected", "installed-tree-link-target-rejected",
  "installed-tree-link-allowed", "installed-tree-entry-rejected",
  "installed-summary", "budgets", "mcp", "tool-smoke", "source-verify", "cleanup",
  "passed", "diagnostic-failed",
]);
const DOCTOR_ORPHAN_STAGES = new Set([
  "execute", "timed-out", "termination", "elapsed", "pid", "wait-gone", "sentinel",
]);
const DOCTOR_ORPHAN_CODES = Object.freeze([
  "DOCTOR_ORPHAN_EXECUTE", "DOCTOR_ORPHAN_TIMED_OUT", "DOCTOR_ORPHAN_TERMINATION",
  "DOCTOR_ORPHAN_ELAPSED", "DOCTOR_ORPHAN_PID", "DOCTOR_ORPHAN_WAIT_GONE",
  "DOCTOR_ORPHAN_SENTINEL",
]);

export async function runMacNodeTestsDiagnostic(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const receiptPrefix = options.receiptPrefix === "WINDOWS" ? "WINDOWS" : "MAC";
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
  const runAssetsCase = options.runAssetsCase ?? ((record) => executeTestFile(
    "assets.test.ts",
    {
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      testNamePattern: record.pattern,
      allowAllSkipped: record.allowAllSkipped,
    },
  ));
  const runCompactRuntimeCase = options.runCompactRuntimeCase ?? ((record) => executeTestFile(
    "compact-runtime.test.ts",
    {
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      testNamePattern: record.pattern,
    },
  ));
  const runDoctorCase = options.runDoctorCase ?? ((record) => executeTestFile(
    "doctor.test.ts",
    {
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      testNamePattern: record.pattern,
      allowAllSkipped: record.allowAllSkipped,
    },
  ));
  const runDoctorOrphanDiagnostic = options.runDoctorOrphanDiagnostic
    ?? executeDoctorOrphanDiagnostic;
  const runAssetsRenderDiagnostic = options.runAssetsRenderDiagnostic
    ?? (() => executeSvgAssetDiagnostic({
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
    }));
  const runCompactRuntimeDiagnostic = options.runCompactRuntimeDiagnostic
    ?? executeCompactRuntimeDiagnostic;

  for (const file of TEST_FILES) {
    let passed = false;
    try { passed = await runFile(file) === true; } catch { passed = false; }
    if (!passed) {
      if (file === "allowed-roots.test.ts") {
        for (const record of ALLOWED_ROOTS_CASES) {
          let casePassed = false;
          try { casePassed = await runAllowedRootsCase(record) === true; } catch { casePassed = false; }
          if (!casePassed) {
            stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${record.id} status=failed\n`);
            setExitCode(1);
            return false;
          }
        }
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=aggregate status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "assets.test.ts") {
        for (const record of ASSETS_CASES) {
          let casePassed = false;
          try { casePassed = await runAssetsCase(record) === true; } catch { casePassed = false; }
          if (!casePassed) {
            if (record.id === "as03") {
              let boundary = "diagnostic-failed";
              try {
                const candidate = await runAssetsRenderDiagnostic();
                if (SVG_ASSET_BOUNDARIES.has(candidate)) boundary = candidate;
              } catch {}
              stdout.write(`${receiptPrefix}_SVG_ASSET boundary=${boundary}\n`);
            }
            stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${record.id} status=failed\n`);
            setExitCode(1);
            return false;
          }
        }
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=aggregate status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "compact-runtime.test.ts") {
        for (const record of COMPACT_RUNTIME_CASES) {
          let casePassed = false;
          try { casePassed = await runCompactRuntimeCase(record) === true; } catch { casePassed = false; }
          if (!casePassed) {
            if (record.id === "cr36") {
              let stage = "diagnostic-failed";
              try {
                const candidate = await runCompactRuntimeDiagnostic();
                if (COMPACT_RUNTIME_STAGES.has(candidate)) stage = candidate;
              } catch {}
              stdout.write(`${receiptPrefix}_COMPACT_RUNTIME stage=${stage}\n`);
            }
            stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${record.id} status=failed\n`);
            setExitCode(1);
            return false;
          }
        }
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=aggregate status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "doctor.test.ts") {
        for (const record of DOCTOR_CASES) {
          let casePassed = false;
          try { casePassed = await runDoctorCase(record) === true; } catch { casePassed = false; }
          if (!casePassed) {
            if (record.id === "dc19") {
              let stage = "diagnostic-failed";
              try {
                const candidate = await runDoctorOrphanDiagnostic();
                if (DOCTOR_ORPHAN_STAGES.has(candidate)) stage = candidate;
              } catch {}
              stdout.write(`${receiptPrefix}_DOCTOR_ORPHAN stage=${stage}\n`);
            }
            stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${record.id} status=failed\n`);
            setExitCode(1);
            return false;
          }
        }
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=doctor-aggregate status=failed\n`);
        setExitCode(1);
        return false;
      }
      stdout.write(`${receiptPrefix}_NODE_TEST_FILE file=${file} status=failed\n`);
      setExitCode(1);
      return false;
    }
  }
  stdout.write(`${receiptPrefix}_NODE_TEST_FILES status=passed files=${TEST_FILES.length}\n`);
  setExitCode(0);
  return true;
}

async function executeCompactRuntimeDiagnostic() {
  let stage = "startup";
  try {
    const { verifyCompactRuntime } = await import(pathToFileURL(resolve(
      PACKAGE_ROOT,
      "release-scripts/verify-compact-runtime.mjs",
    )).href);
    await verifyCompactRuntime({
      sourceRoot: PROJECT_ROOT,
      onDiagnosticStage: (candidate) => {
        stage = COMPACT_RUNTIME_STAGES.has(candidate) ? candidate : "diagnostic-failed";
      },
    });
    return "passed";
  } catch {
    return stage;
  }
}

async function executeDoctorOrphanDiagnostic() {
  let stage = "diagnostic-failed";
  await executeBoundedNodeTestFile("doctor.test.ts", {
    testNamePattern: DOCTOR_CASES[18].pattern,
    fixedDiagnostics: DOCTOR_ORPHAN_CODES,
    onFixedDiagnostic: (code) => {
      const candidate = code.slice("DOCTOR_ORPHAN_".length).toLowerCase().replaceAll("_", "-");
      stage = DOCTOR_ORPHAN_STAGES.has(candidate) ? candidate : "diagnostic-failed";
    },
  });
  return stage;
}

function executeSvgAssetDiagnostic(options) {
  return new Promise((resolveDiagnostic) => {
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
      resolveDiagnostic(value);
    };
    const stopUnverified = () => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(testTimer);
      try { void options.terminateTree(child); } catch {}
      closeTimer = setTimeout(() => finish("diagnostic-failed"), options.closeTimeoutMs);
    };
    try {
      child = options.spawnProcess(process.execPath, [
        "--import", "tsx", "benchmarks/macos-svg-asset-diagnostic.mjs",
      ], {
        cwd: PACKAGE_ROOT,
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        shell: false,
        windowsHide: true,
      });
    } catch {
      finish("diagnostic-failed");
      return;
    }
    if (child.stdout === null || child.stdout === undefined || !("on" in child.stdout)) {
      stopUnverified();
      return;
    }
    child.stdout.once("error", stopUnverified);
    child.stdout.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk) || capturedBytes + chunk.byteLength > 1024) {
        stopUnverified();
        return;
      }
      capturedBytes += chunk.byteLength;
      chunks.push(chunk);
    });
    child.once("error", stopUnverified);
    child.once("close", (code, signal) => {
      if (stopping || code !== 0 || signal !== null) {
        finish("diagnostic-failed");
        return;
      }
      let text = "";
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { finish("diagnostic-failed"); return; }
      const match = /^MAC_SVG_ASSET boundary=([a-z-]+)\n?$/u.exec(text);
      finish(match !== null && SVG_ASSET_BOUNDARIES.has(match[1])
        ? match[1]
        : "diagnostic-failed");
    });
    testTimer = setTimeout(stopUnverified, options.testTimeoutMs);
  });
}

export function executeBoundedNodeTestFile(file, options = {}) {
  return new Promise((resolveTest) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const terminateProcessTree = options.terminateTree ?? terminateTree;
    const testTimeoutMs = boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS);
    const closeTimeoutMs = boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
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
      try { void terminateProcessTree(child); } catch {}
      if (settled) return;
      closeTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.unref?.();
        finish(false);
      }, closeTimeoutMs);
    };
    try {
      const repository = options.repository === true;
      const args = repository
        ? ["--test"]
        : ["--import", "tsx", "--test", "--test-concurrency=1"];
      if (options.testNamePattern !== undefined) {
        args.push(`--test-name-pattern=${options.testNamePattern}`);
      }
      args.push(`tests/${file}`);
      child = spawnProcess(process.execPath, args, {
        cwd: repository ? PROJECT_ROOT : PACKAGE_ROOT,
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
      } else {
        forwardFixedDiagnostic(chunks, capturedBytes, options);
        finish(code === 0 && signal === null && validTapReceipt(
          chunks, capturedBytes, options.allowAllSkipped === true,
        ));
      }
    });
    testTimer = setTimeout(stopUnverified, testTimeoutMs);
  });
}

const executeTestFile = executeBoundedNodeTestFile;

function forwardFixedDiagnostic(chunks, capturedBytes, options) {
  if (!Array.isArray(options.fixedDiagnostics)
    || typeof options.onFixedDiagnostic !== "function") return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return; }
  for (const code of options.fixedDiagnostics) {
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) continue;
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`^  error: '${escaped}'$`, "mu").test(text)) {
      try { options.onFixedDiagnostic(code); } catch {}
      return;
    }
  }
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
