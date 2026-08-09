import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertRegisteredExactSkipPattern,
  parseNodeTestProfileArguments,
  resolveNodeTestProfile,
  SOURCE_NODE_TEST_FILES,
} from "./node-test-profiles.mjs";
import { terminateProcessTree as terminateReleaseProcessTree } from "./release-verify.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(PROJECT_ROOT, "packages/gpt-codex-hwp");
const MAX_CAPTURE_BYTES = 512 * 1024;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;
const MAX_TEST_TIMEOUT_MS = 600_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DOCUMENT_PROCESS_TEST_TIMEOUT_MS = 300_000;
const DOCUMENT_WORKER_OPERATIONS_TEST_TIMEOUT_MS = 600_000;
const MAX_BENCHMARK_DIAGNOSTIC_RECEIPT_BYTES = 384;
const MAX_BENCHMARK_REGISTERED_IDENTITIES = 32;
const TEST_FILES = SOURCE_NODE_TEST_FILES;
const KORDOC_CORE_OUTER_STAGES = new Set([
  "setup", "first-build", "second-build", "generated-assertions",
  "package-assertions", "layout-assertions", "provenance-assertions",
  "verify-first", "verify-second", "body-complete",
]);
const KORDOC_CORE_BUILD_STAGES = new Set([
  "output-check", "input-validate", "parent-create", "output-create",
  "file-write", "package-write", "file-records", "provenance-write", "verify",
]);
const KORDOC_CORE_STAGES = new Set([
  ...KORDOC_CORE_OUTER_STAGES,
  ...[...KORDOC_CORE_BUILD_STAGES].map((stage) => `first-build-${stage}`),
]);
const KORDOC_CORE_PROGRESS_CODES = Object.freeze(
  [
    ...[...KORDOC_CORE_OUTER_STAGES].map((stage) =>
      `KORDOC_KC01_STAGE_${stage.toUpperCase().replaceAll("-", "_")}`),
    ...[...KORDOC_CORE_BUILD_STAGES].map((stage) =>
      `KORDOC_KC01_BUILD_STAGE_${stage.toUpperCase().replaceAll("-", "_")}`),
  ],
);
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
  testName: pattern,
  allowAllSkipped: index === 12,
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
const DOCUMENT_SEQUENTIAL_STAGES = new Set([
  "close", "begin-closing", "seal", "parse", "parents", "retained", "count",
  "read-0", "read-1", "pid-0", "pid-1", "closed-0", "closed-1", "body-complete",
  "terminate-begin", "terminate-complete", "cleanup-begin", "cleanup-complete",
]);
const DOCUMENT_SEQUENTIAL_CODES = Object.freeze([
  "DOCUMENT_SEQUENTIAL_CLOSE", "DOCUMENT_SEQUENTIAL_BEGIN_CLOSING",
  "DOCUMENT_SEQUENTIAL_SEAL", "DOCUMENT_SEQUENTIAL_PARSE",
  "DOCUMENT_SEQUENTIAL_PARENTS", "DOCUMENT_SEQUENTIAL_RETAINED", "DOCUMENT_SEQUENTIAL_COUNT",
  "DOCUMENT_SEQUENTIAL_READ_0", "DOCUMENT_SEQUENTIAL_READ_1",
  "DOCUMENT_SEQUENTIAL_PID_0", "DOCUMENT_SEQUENTIAL_PID_1",
  "DOCUMENT_SEQUENTIAL_CLOSED_0", "DOCUMENT_SEQUENTIAL_CLOSED_1",
  "DOCUMENT_SEQUENTIAL_BODY_COMPLETE",
]);
const DOCUMENT_SEQUENTIAL_PROGRESS_CODES = Object.freeze(
  [...DOCUMENT_SEQUENTIAL_STAGES].map((stage) =>
    `DOCUMENT_SEQUENTIAL_STAGE_${stage.toUpperCase().replaceAll("-", "_")}`),
);
const DOCUMENT_DESCRIPTOR_MISMATCH_STAGES = new Set([
  "close", "output-absence", "exit-code", "stdout", "stderr", "body-complete",
]);
const DOCUMENT_DESCRIPTOR_MISMATCH_CODES = Object.freeze(
  [...DOCUMENT_DESCRIPTOR_MISMATCH_STAGES].map((stage) =>
    `DOCUMENT_DESCRIPTOR_MISMATCH_${stage.toUpperCase().replaceAll("-", "_")}`),
);
const DOCUMENT_DESCRIPTOR_MISMATCH_PROGRESS_CODES = Object.freeze(
  [...DOCUMENT_DESCRIPTOR_MISMATCH_STAGES].map((stage) =>
    `DOCUMENT_DESCRIPTOR_MISMATCH_STAGE_${stage.toUpperCase().replaceAll("-", "_")}`),
);
const DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_KINDS = new Set([
  "bad-descriptor", "unhandled-error", "broken-pipe", "runtime-warning",
  "node-internal", "other",
]);
const DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_CODES = Object.freeze(
  [...DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_KINDS].map((kind) =>
    `DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_${kind.toUpperCase().replaceAll("-", "_")}`),
);
const MCP_PREVIEW_CANCELLATION_STAGES = new Set([
  "setup", "rejection", "cancellation", "output-absence", "cleanup",
]);
const MCP_PREVIEW_CANCELLATION_CODES = Object.freeze(
  [...MCP_PREVIEW_CANCELLATION_STAGES].map((stage) =>
    `MCP_PREVIEW_CANCELLATION_FAILURE_${stage.toUpperCase().replaceAll("-", "_")}`),
);
const MCP_RUNNING_CHILD_STAGES = new Set([
  "setup", "isolation-ready", "connection-ready", "request-issued",
  "request-rejected-before-start", "request-resolved-before-start", "start-timeout",
  "first-start", "abort-rejection", "signal", "recovery", "reuse", "lifecycle",
  "connection-cleanup", "fixture-cleanup", "cleanup-complete",
]);
const MCP_RUNNING_CHILD_CODES = Object.freeze(
  [...MCP_RUNNING_CHILD_STAGES].map((stage) =>
    `MCP_RUNNING_CHILD_STAGE_${stage.toUpperCase().replaceAll("-", "_")}`),
);
const BENCHMARK_DIAGNOSTIC_STAGES = new Set([
  "ready-mode-1", "ready-mode-2", "error-startup", "error-baseline-rss",
  "error-sampling", "error-termination", "error-rss-receipt", "finalizer", "channel",
  "windows-startup", "windows-baseline-rss", "windows-sampling", "windows-termination",
  "windows-termination-discovery-or-rss-unavailable",
  "windows-termination-retained-handle-unavailable", "windows-termination-scan-exhausted",
  "windows-rss-receipt", "windows-finalizer", "windows-channel", "posix-root-authority",
  "posix-telemetry-initialize", "posix-telemetry-sample",
]);
const NODE_COMPLETION_KINDS = new Set([
  "passed", "test-failure", "cancelled", "nonzero-clean-tap", "invalid-summary",
  "child-signal",
]);
const NODE_FAILURE_KINDS = new Set([
  "test-timeout", "hook-failure", "test-code", "async-failure", "cancelled", "unknown",
]);
const NODE_TEST_CODE_REASONS = new Set([
  "assertion", "async-activity", "test-failure", "unknown",
]);
const NODE_ASSERTION_ORIGINS = new Set(["register-root", "test-body", "unknown"]);
const NODE_RUNNER_FAILURE_KINDS = new Set([
  "spawn-error", "missing-stdout", "stdout-error", "child-error", "invalid-chunk",
  "capture-limit", "runner-timeout", "unknown",
]);

export async function runMacNodeTestsDiagnostic(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const actualSetExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const receiptPrefix = options.receiptPrefix === "WINDOWS" ? "WINDOWS" : "MAC";
  const emitProfileReceipt = options.profile !== undefined || options.emitProfileReceipt === true;
  const requestedProfile = options.profile ?? "full";
  let profilePlan;
  try {
    profilePlan = await resolveNodeTestProfile(requestedProfile);
  } catch {
    if (emitProfileReceipt) {
      stdout.write(
        `${receiptPrefix}_NODE_TEST_PROFILE profile=invalid executedFileCount=0 deferredCaseCount=0 failed=1\n`,
      );
    }
    actualSetExitCode(1);
    return false;
  }
  let executedFileCount = 0;
  const onTestFileSpawn = () => { executedFileCount += 1; };
  let profileReceiptWritten = false;
  const setExitCode = (code) => {
    if (emitProfileReceipt && !profileReceiptWritten) {
      profileReceiptWritten = true;
      stdout.write(
        `${receiptPrefix}_NODE_TEST_PROFILE profile=${profilePlan.name} executedFileCount=${executedFileCount} deferredCaseCount=${profilePlan.deferredCaseCount} failed=${code === 0 ? 0 : 1}\n`,
      );
    }
    actualSetExitCode(code);
  };
  const runFile = options.runFile ?? ((file, fileOptions) => executeTestFile(file, {
    spawnProcess: options.spawnProcess ?? spawn,
    terminateTree: options.terminateTree ?? terminateTree,
    testTimeoutMs: fileOptions.testTimeoutMs,
    closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
    testSkipPattern: fileOptions.testSkipPattern,
    onSpawn: onTestFileSpawn,
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
      onSpawn: onTestFileSpawn,
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
      onSpawn: onTestFileSpawn,
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
      allowAllSkipped: record.allowAllSkipped,
      onSpawn: onTestFileSpawn,
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
      onSpawn: onTestFileSpawn,
    },
  ));
  const runDoctorOrphanDiagnostic = options.runDoctorOrphanDiagnostic
    ?? (() => executeDoctorOrphanDiagnostic({ onSpawn: onTestFileSpawn }));
  const runDocumentProcessDiagnostic = options.runDocumentProcessDiagnostic
    ?? (() => executeDocumentProcessDiagnostic({
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DOCUMENT_PROCESS_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      onSpawn: onTestFileSpawn,
    }));
  const runDocumentFile = options.runDocumentFile
    ?? (options.runFile === undefined ? runDocumentProcessDiagnostic : undefined);
  const runDocumentSequentialDiagnostic = options.runDocumentSequentialDiagnostic
    ?? (() => executeDocumentSequentialDiagnostic({ onSpawn: onTestFileSpawn }));
  const runDocumentDescriptorMismatchDiagnostic = options.runDocumentDescriptorMismatchDiagnostic
    ?? (() => executeDocumentDescriptorMismatchDiagnostic({ onSpawn: onTestFileSpawn }));
  const runBenchmarkPolicyDiagnostic = options.runBenchmarkPolicyDiagnostic
    ?? ((fileOptions = {}) => executeBenchmarkPolicyDiagnostic({
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      testSkipPattern: fileOptions.testSkipPattern,
      onSpawn: onTestFileSpawn,
    }));
  const runBenchmarkFile = options.runBenchmarkFile
    ?? (options.runFile === undefined ? runBenchmarkPolicyDiagnostic : undefined);
  const runMcpCancellationProgressDiagnostic = options.runMcpCancellationProgressDiagnostic
    ?? (() => executeMcpCancellationProgressDiagnostic({
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      onSpawn: onTestFileSpawn,
    }));
  const runOutputBudgetAtomicityDiagnostic = options.runOutputBudgetAtomicityDiagnostic
    ?? (() => executeOutputBudgetAtomicityDiagnostic({ onSpawn: onTestFileSpawn }));
  const runPatchDiagnostic = options.runPatchDiagnostic
    ?? (() => executePatchDiagnostic({ onSpawn: onTestFileSpawn }));
  const runPublicRuntimePrivacyDiagnostic = options.runPublicRuntimePrivacyDiagnostic
    ?? (() => executePublicRuntimePrivacyDiagnostic({
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      onSpawn: onTestFileSpawn,
    }));
  const runReadWorkerSafetyDiagnostic = options.runReadWorkerSafetyDiagnostic
    ?? (() => executeSourceOrdinalDiagnostic(
      "read-worker-safety.test.ts", 17, "rw", { onSpawn: onTestFileSpawn },
    ));
  const runWriteWorkerSafetyDiagnostic = options.runWriteWorkerSafetyDiagnostic
    ?? (() => executeSourceOrdinalDiagnostic(
      "write-worker-safety.test.ts", 10, "ww", { onSpawn: onTestFileSpawn },
    ));
  const runKordocCoreDiagnostic = options.runKordocCoreDiagnostic
    ?? (() => executeKordocCoreDiagnostic({ onSpawn: onTestFileSpawn }));
  const runAssetsRenderDiagnostic = options.runAssetsRenderDiagnostic
    ?? (() => executeSvgAssetDiagnostic({
      spawnProcess: options.spawnProcess ?? spawn,
      terminateTree: options.terminateTree ?? terminateTree,
      testTimeoutMs: boundedTimeout(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS),
      closeTimeoutMs: boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      onSpawn: onTestFileSpawn,
    }));
  const runCompactRuntimeDiagnostic = options.runCompactRuntimeDiagnostic
    ?? executeCompactRuntimeDiagnostic;

  const compactRuntimeCases = COMPACT_RUNTIME_CASES.filter((record) => !profilePlan.isDeferred(
    "compact-runtime.test.ts",
    record.testName,
  ));
  for (const file of profilePlan.testFiles) {
    let passed = false;
    let benchmarkReceipt;
    let documentReceipt;
    const testTimeoutMs = boundedTimeout(
      options.testTimeoutMs,
      file === "document-child-client.test.ts"
        ? DOCUMENT_PROCESS_TEST_TIMEOUT_MS
        : file === "document-worker-operations.test.ts"
          ? DOCUMENT_WORKER_OPERATIONS_TEST_TIMEOUT_MS
          : DEFAULT_TEST_TIMEOUT_MS,
    );
    const testSkipPattern = profilePlan.skipPatternFor(file);
    try {
      if (file === "benchmark-policy.test.ts" && typeof runBenchmarkFile === "function") {
        benchmarkReceipt = await runBenchmarkFile({
          testSkipPattern,
          profile: profilePlan.name,
          onSpawn: onTestFileSpawn,
        });
        passed = benchmarkReceipt?.passed === true;
      } else if (file === "document-process-registration.test.ts"
        && typeof runDocumentFile === "function") {
        documentReceipt = await runDocumentFile();
        passed = documentReceipt?.passed === true;
      } else {
        passed = await runFile(file, {
          testTimeoutMs,
          testSkipPattern,
          profile: profilePlan.name,
          onSpawn: onTestFileSpawn,
        }) === true;
      }
    } catch { passed = false; }
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
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=allowed-roots-aggregate status=failed\n`);
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
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=assets-aggregate status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "compact-runtime.test.ts") {
        for (const record of compactRuntimeCases) {
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
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=compact-runtime-aggregate status=failed\n`);
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
      if (file === "document-process-registration.test.ts") {
        let caseId = "aggregate";
        let completionKind;
        let failureKind;
        let runnerFailureKind;
        let testCodeReason;
        let assertionOrigin;
        let descriptorMismatchStage;
        let descriptorMismatchStderrKind;
        let firstFailureStage;
        try {
          const candidate = documentReceipt ?? await runDocumentProcessDiagnostic();
          if (typeof candidate === "string"
            && /^dp(?:0[1-9]|[1-4][0-9]|5[0-3])$/u.test(candidate)) {
            caseId = candidate;
          } else if (candidate !== null && typeof candidate === "object") {
            if (/^(?:dp(?:0[1-9]|[1-4][0-9]|5[0-3])|document-(?:aggregate|rerun-passed))$/u
              .test(candidate.caseId)) {
              caseId = candidate.caseId;
            }
            if (DOCUMENT_SEQUENTIAL_STAGES.has(candidate.stage)) {
              firstFailureStage = candidate.stage;
            }
            if (DOCUMENT_DESCRIPTOR_MISMATCH_STAGES.has(candidate.descriptorMismatchStage)) {
              descriptorMismatchStage = candidate.descriptorMismatchStage;
            }
            if (DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_KINDS.has(candidate.descriptorMismatchStderrKind)) {
              descriptorMismatchStderrKind = candidate.descriptorMismatchStderrKind;
            }
            if (["test-timeout", "hook-failure", "test-code", "async-failure", "cancelled", "unknown"]
              .includes(candidate.failureKind)) {
              failureKind = candidate.failureKind;
            }
            if (["passed", "test-failure", "cancelled", "nonzero-clean-tap", "invalid-summary", "child-signal"]
              .includes(candidate.completionKind)) {
              completionKind = candidate.completionKind;
            }
            if (["assertion", "async-activity", "test-failure", "unknown"]
              .includes(candidate.testCodeReason)) {
              testCodeReason = candidate.testCodeReason;
            }
            if (["register-root", "test-body", "unknown"].includes(candidate.assertionOrigin)) {
              assertionOrigin = candidate.assertionOrigin;
            }
            if (["spawn-error", "missing-stdout", "stdout-error", "child-error", "invalid-chunk", "capture-limit", "runner-timeout"]
              .includes(candidate.runnerFailureKind)) {
              runnerFailureKind = candidate.runnerFailureKind;
            }
          }
        } catch {}
        if (caseId === "dp45") {
          stdout.write(
            `${receiptPrefix}_DOCUMENT_DESCRIPTOR_MISMATCH stage=${descriptorMismatchStage ?? "diagnostic-failed"}\n`,
          );
          if (descriptorMismatchStage === "stderr") {
            stdout.write(
              `${receiptPrefix}_DOCUMENT_DESCRIPTOR_MISMATCH_STDERR kind=${descriptorMismatchStderrKind ?? "unclassified"}\n`,
            );
          }
          let isolatedStatus = "failed";
          try {
            const candidate = await runDocumentDescriptorMismatchDiagnostic();
            if (candidate?.passed === true) isolatedStatus = "passed";
          } catch {}
          stdout.write(
            `${receiptPrefix}_DOCUMENT_DESCRIPTOR_MISMATCH_ISOLATED status=${isolatedStatus}\n`,
          );
        }
        if (caseId === "dp47") {
          let stage = firstFailureStage ?? "diagnostic-failed";
          let isolatedStatus;
          if (firstFailureStage === undefined || firstFailureStage === "cleanup-complete") {
            try {
              const candidate = await runDocumentSequentialDiagnostic();
              if (typeof candidate === "string") {
                if (DOCUMENT_SEQUENTIAL_STAGES.has(candidate)) stage = candidate;
              } else if (candidate !== null && typeof candidate === "object") {
                if (firstFailureStage === undefined
                  && DOCUMENT_SEQUENTIAL_STAGES.has(candidate.stage)) stage = candidate.stage;
                if (candidate.passed === true) isolatedStatus = "passed";
                else if (candidate.passed === false) isolatedStatus = "failed";
              }
            } catch {}
          }
          stdout.write(`${receiptPrefix}_DOCUMENT_SEQUENTIAL stage=${stage}\n`);
          if (isolatedStatus !== undefined) {
            stdout.write(`${receiptPrefix}_DOCUMENT_SEQUENTIAL_ISOLATED status=${isolatedStatus}\n`);
          }
          if (failureKind !== undefined) {
            stdout.write(`${receiptPrefix}_DOCUMENT_SEQUENTIAL_FAILURE kind=${failureKind}\n`);
          }
          if (completionKind !== undefined) {
            stdout.write(`${receiptPrefix}_DOCUMENT_SEQUENTIAL_COMPLETION kind=${completionKind}\n`);
          }
          if (testCodeReason !== undefined) {
            stdout.write(`${receiptPrefix}_DOCUMENT_SEQUENTIAL_TEST_CODE reason=${testCodeReason}\n`);
          }
          if (assertionOrigin !== undefined) {
            stdout.write(`${receiptPrefix}_DOCUMENT_SEQUENTIAL_ASSERTION origin=${assertionOrigin}\n`);
          }
          if (runnerFailureKind !== undefined) {
            stdout.write(`${receiptPrefix}_DOCUMENT_SEQUENTIAL_RUNNER kind=${runnerFailureKind}\n`);
          }
        }
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "benchmark-policy.test.ts") {
        let caseId = "aggregate";
        let assertionOrigin;
        let completionKind;
        let failureKind;
        let runnerFailureKind;
        let testCodeReason;
        let diagnosticStage;
        let rootCleanup;
        let processGroupCleanup;
        let registeredIdentityCount;
        let remainingIdentityCount;
        try {
          const candidate = benchmarkReceipt ?? await runBenchmarkPolicyDiagnostic({
            testSkipPattern,
            profile: profilePlan.name,
            onSpawn: onTestFileSpawn,
          });
          if (typeof candidate === "string") {
            if (/^bp(?:0[1-9]|[12][0-9]|3[0-9])$/u.test(candidate)) caseId = candidate;
            else if (candidate === "aggregate") caseId = "benchmark-aggregate";
          } else if (candidate !== null && typeof candidate === "object") {
            if (/^bp(?:0[1-9]|[12][0-9]|3[0-9])$/u.test(candidate.caseId)) {
              caseId = candidate.caseId;
            } else if (["benchmark-aggregate", "benchmark-rerun-passed"].includes(candidate.caseId)) {
              caseId = candidate.caseId;
            }
            if (["passed", "test-failure", "cancelled", "nonzero-clean-tap", "invalid-summary", "child-signal"]
              .includes(candidate.completionKind)) completionKind = candidate.completionKind;
            if (["test-timeout", "hook-failure", "test-code", "async-failure", "cancelled", "unknown"]
              .includes(candidate.failureKind)) failureKind = candidate.failureKind;
            if (["assertion", "async-activity", "test-failure", "unknown"]
              .includes(candidate.testCodeReason)) testCodeReason = candidate.testCodeReason;
            if (["register-root", "test-body", "unknown"].includes(candidate.assertionOrigin)) {
              assertionOrigin = candidate.assertionOrigin;
            }
            if (["spawn-error", "missing-stdout", "stdout-error", "child-error", "invalid-chunk", "capture-limit", "runner-timeout"]
              .includes(candidate.runnerFailureKind)) runnerFailureKind = candidate.runnerFailureKind;
            if (BENCHMARK_DIAGNOSTIC_STAGES.has(candidate.diagnosticStage)) {
              diagnosticStage = candidate.diagnosticStage;
            }
            if (["gone", "unverified"].includes(candidate.rootCleanup)) {
              rootCleanup = candidate.rootCleanup;
            }
            if (["gone", "unverified"].includes(candidate.processGroupCleanup)) {
              processGroupCleanup = candidate.processGroupCleanup;
            }
            if (validBenchmarkIdentityCounts(
              candidate.registeredIdentityCount,
              candidate.remainingIdentityCount,
            )) {
              registeredIdentityCount = candidate.registeredIdentityCount;
              remainingIdentityCount = candidate.remainingIdentityCount;
            }
          }
        } catch {}
        stdout.write(`${formatBenchmarkDiagnosticReceipt({
          receiptPrefix,
          caseId,
          failureKind,
          completionKind,
          diagnosticStage,
          assertionOrigin,
          rootCleanup,
          processGroupCleanup,
          registeredIdentityCount,
          remainingIdentityCount,
          testCodeReason,
          runnerFailureKind,
        })}\n`);
        setExitCode(1);
        return false;
      }
      if (file === "mcp-cancellation-progress.test.ts") {
        let caseId = "aggregate";
        let assertionOrigin;
        let completionKind;
        let failureKind;
        let runnerFailureKind;
        let stage;
        let runningChildStage;
        let testCodeReason;
        try {
          const candidate = await runMcpCancellationProgressDiagnostic();
          if (typeof candidate === "string") {
            if (/^mp(?:0[1-9]|1[0-3])$/u.test(candidate)) caseId = candidate;
            else if (candidate === "aggregate") caseId = "mcp-cancellation-aggregate";
          } else if (candidate !== null && typeof candidate === "object") {
            if (/^mp(?:0[1-9]|1[0-3])$/u.test(candidate.caseId)) caseId = candidate.caseId;
            else if (candidate.caseId === "mcp-cancellation-aggregate"
              || candidate.caseId === "mcp-cancellation-rerun-passed") {
              caseId = candidate.caseId;
            }
            if (["passed", "test-failure", "cancelled", "nonzero-clean-tap", "invalid-summary", "child-signal"]
              .includes(candidate.completionKind)) completionKind = candidate.completionKind;
            if (["test-timeout", "hook-failure", "test-code", "async-failure", "cancelled", "unknown"]
              .includes(candidate.failureKind)) failureKind = candidate.failureKind;
            if (["assertion", "async-activity", "test-failure", "unknown"]
              .includes(candidate.testCodeReason)) testCodeReason = candidate.testCodeReason;
            if (["register-root", "test-body", "unknown"].includes(candidate.assertionOrigin)) {
              assertionOrigin = candidate.assertionOrigin;
            }
            if (["spawn-error", "missing-stdout", "stdout-error", "child-error", "invalid-chunk", "capture-limit", "runner-timeout"]
              .includes(candidate.runnerFailureKind)) runnerFailureKind = candidate.runnerFailureKind;
            if (MCP_PREVIEW_CANCELLATION_STAGES.has(candidate.stage)) stage = candidate.stage;
            if (MCP_RUNNING_CHILD_STAGES.has(candidate.runningChildStage)) {
              runningChildStage = candidate.runningChildStage;
            }
          }
        } catch {}
        if (caseId === "mp03" && stage !== undefined) {
          stdout.write(`${receiptPrefix}_MCP_PREVIEW_CANCELLATION stage=${stage}\n`);
        }
        if (caseId === "mp03" && failureKind !== undefined) {
          stdout.write(`${receiptPrefix}_MCP_PREVIEW_CANCELLATION_FAILURE kind=${failureKind}\n`);
        }
        if (caseId === "mp03" && completionKind !== undefined) {
          stdout.write(`${receiptPrefix}_MCP_PREVIEW_CANCELLATION_COMPLETION kind=${completionKind}\n`);
        }
        if (caseId === "mp03" && testCodeReason !== undefined) {
          stdout.write(`${receiptPrefix}_MCP_PREVIEW_CANCELLATION_TEST_CODE reason=${testCodeReason}\n`);
        }
        if (caseId === "mp03" && assertionOrigin !== undefined) {
          stdout.write(`${receiptPrefix}_MCP_PREVIEW_CANCELLATION_ASSERTION origin=${assertionOrigin}\n`);
        }
        if (caseId === "mp03" && runnerFailureKind !== undefined) {
          stdout.write(`${receiptPrefix}_MCP_PREVIEW_CANCELLATION_RUNNER kind=${runnerFailureKind}\n`);
        }
        if (caseId === "mp10" && runningChildStage !== undefined) {
          stdout.write(
            `${receiptPrefix}_MCP_RUNNING_CHILD stage=${runningChildStage}\n`,
          );
        }
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "kordoc-core-runtime.test.ts") {
        let caseId = "aggregate";
        let stage;
        try {
          const candidate = await runKordocCoreDiagnostic();
          if (typeof candidate === "string") {
            if (/^kc(?:0[1-9]|10)$/u.test(candidate)) caseId = candidate;
            else if (candidate === "aggregate") caseId = "kordoc-core-aggregate";
          } else if (candidate !== null && typeof candidate === "object") {
            if (/^(?:kc(?:0[1-9]|10)|kordoc-core-aggregate)$/u.test(candidate.caseId)) {
              caseId = candidate.caseId;
            }
            if (KORDOC_CORE_STAGES.has(candidate.stage)) stage = candidate.stage;
          }
        } catch {}
        if (stage !== undefined) {
          stdout.write(`${receiptPrefix}_KORDOC_CORE stage=${stage}\n`);
        }
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "output-budget-atomicity.test.ts") {
        let caseId = "output-budget-aggregate";
        try {
          const candidate = await runOutputBudgetAtomicityDiagnostic();
          if (/^ob(?:0[1-9]|1[0-5])$/u.test(candidate)) caseId = candidate;
        } catch {}
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "patch.test.ts") {
        let caseId = "patch-aggregate";
        try {
          const candidate = await runPatchDiagnostic();
          if (/^pa(?:0[1-9]|1[0-9]|2[0-3])$/u.test(candidate)) caseId = candidate;
        } catch {}
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "public-runtime-privacy.test.ts") {
        let caseId = "public-runtime-privacy-aggregate";
        try {
          const candidate = await runPublicRuntimePrivacyDiagnostic();
          if (typeof candidate === "string") {
            if (/^pr(?:0[1-9]|1[0-5])$/u.test(candidate)) caseId = candidate;
          } else if (candidate !== null && typeof candidate === "object") {
            if (/^pr(?:0[1-9]|1[0-5])$/u.test(candidate.caseId)) {
              caseId = candidate.caseId;
            } else if (["public-runtime-privacy-aggregate", "public-runtime-privacy-rerun-passed"]
              .includes(candidate.caseId)) {
              caseId = candidate.caseId;
            }
            if (caseId === "pr07" && /^pr07s0[1-8]$/u.test(candidate.nestedCaseId)) {
              caseId = candidate.nestedCaseId;
            }
          }
        } catch {}
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "read-worker-safety.test.ts") {
        let caseId = "read-worker-safety-aggregate";
        try {
          const candidate = await runReadWorkerSafetyDiagnostic();
          if (/^rw(?:0[1-9]|1[0-7])$/u.test(candidate)) caseId = candidate;
        } catch {}
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      if (file === "write-worker-safety.test.ts") {
        let caseId = "write-worker-safety-aggregate";
        try {
          const candidate = await runWriteWorkerSafetyDiagnostic();
          if (/^ww(?:0[1-9]|10)$/u.test(candidate)) caseId = candidate;
        } catch {}
        stdout.write(`${receiptPrefix}_NODE_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      stdout.write(`${receiptPrefix}_NODE_TEST_FILE file=${file} status=failed\n`);
      setExitCode(1);
      return false;
    }
  }
  stdout.write(`${receiptPrefix}_NODE_TEST_FILES status=passed files=${profilePlan.testFiles.length}\n`);
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

async function executeDoctorOrphanDiagnostic(options = {}) {
  let stage = "diagnostic-failed";
  await executeBoundedNodeTestFile("doctor.test.ts", {
    onSpawn: options.onSpawn,
    testNamePattern: DOCTOR_CASES[18].pattern,
    fixedDiagnostics: DOCTOR_ORPHAN_CODES,
    onFixedDiagnostic: (code) => {
      const candidate = code.slice("DOCTOR_ORPHAN_".length).toLowerCase().replaceAll("_", "-");
      stage = DOCTOR_ORPHAN_STAGES.has(candidate) ? candidate : "diagnostic-failed";
    },
  });
  return stage;
}

async function executeDocumentProcessDiagnostic(options = {}) {
  let completionKind;
  let ordinal;
  let failureKind;
  let runnerFailureKind;
  let stage;
  let testCodeReason;
  let assertionOrigin;
  let descriptorMismatchStage;
  let descriptorMismatchStderrKind;
  const passed = await executeBoundedNodeTestFile("document-process-registration.test.ts", {
    onSpawn: options.onSpawn,
    spawnProcess: options.spawnProcess,
    terminateTree: options.terminateTree,
    testTimeoutMs: options.testTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    maximumTopLevelTests: 53,
    onCompletionKind: (value) => { completionKind = value; },
    onFailedTopLevelOrdinal: (value) => { ordinal = value; },
    onFailedTopLevelFailureKind: (value) => { failureKind = value; },
    onFailedTopLevelTestCodeReason: (value) => { testCodeReason = value; },
    onFailedTopLevelAssertionOrigin: (value) => { assertionOrigin = value; },
    onRunnerFailureKind: (value) => { runnerFailureKind = value; },
    fixedDiagnostics: [
      ...DOCUMENT_SEQUENTIAL_CODES,
      ...DOCUMENT_DESCRIPTOR_MISMATCH_CODES,
      ...DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_CODES,
    ],
    onFixedDiagnostic: (code) => {
      if (code.startsWith("DOCUMENT_SEQUENTIAL_")) {
        const candidate = code.slice("DOCUMENT_SEQUENTIAL_".length)
          .toLowerCase().replaceAll("_", "-");
        if (DOCUMENT_SEQUENTIAL_STAGES.has(candidate)) stage = candidate;
      } else if (code.startsWith("DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_")) {
        const candidate = code.slice("DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_".length)
          .toLowerCase().replaceAll("_", "-");
        if (DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_KINDS.has(candidate)) {
          descriptorMismatchStage = "stderr";
          descriptorMismatchStderrKind = candidate;
        }
      } else if (code.startsWith("DOCUMENT_DESCRIPTOR_MISMATCH_")) {
        const candidate = code.slice("DOCUMENT_DESCRIPTOR_MISMATCH_".length)
          .toLowerCase().replaceAll("_", "-");
        if (DOCUMENT_DESCRIPTOR_MISMATCH_STAGES.has(candidate)) descriptorMismatchStage = candidate;
      }
    },
    fixedProgressDiagnostics: [
      ...DOCUMENT_SEQUENTIAL_PROGRESS_CODES,
      ...DOCUMENT_DESCRIPTOR_MISMATCH_PROGRESS_CODES,
      ...DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_CODES,
    ],
    onFixedProgressDiagnostic: (code) => {
      if (code.startsWith("DOCUMENT_SEQUENTIAL_STAGE_")) {
        const candidate = code.slice("DOCUMENT_SEQUENTIAL_STAGE_".length)
          .toLowerCase().replaceAll("_", "-");
        if (DOCUMENT_SEQUENTIAL_STAGES.has(candidate)) stage = candidate;
      } else if (code.startsWith("DOCUMENT_DESCRIPTOR_MISMATCH_STAGE_")) {
        const candidate = code.slice("DOCUMENT_DESCRIPTOR_MISMATCH_STAGE_".length)
          .toLowerCase().replaceAll("_", "-");
        if (DOCUMENT_DESCRIPTOR_MISMATCH_STAGES.has(candidate)) descriptorMismatchStage = candidate;
      } else if (code.startsWith("DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_")) {
        const candidate = code.slice("DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_".length)
          .toLowerCase().replaceAll("_", "-");
        if (DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_KINDS.has(candidate)) {
          descriptorMismatchStderrKind = candidate;
        }
      }
    },
  });
  return {
    passed,
    caseId: ordinal !== undefined
      ? `dp${String(ordinal).padStart(2, "0")}`
      : passed ? "document-rerun-passed" : "document-aggregate",
    completionKind,
    failureKind,
    runnerFailureKind,
    stage,
    testCodeReason,
    assertionOrigin,
    descriptorMismatchStage,
    descriptorMismatchStderrKind,
  };
}

async function executeDocumentSequentialDiagnostic(options = {}) {
  let stage = "diagnostic-failed";
  const passed = await executeBoundedNodeTestFile("document-process-registration.test.ts", {
    onSpawn: options.onSpawn,
    testTimeoutMs: DOCUMENT_PROCESS_TEST_TIMEOUT_MS,
    testNamePattern: "^registration sequential transport completes two real bootstrap ACK handshakes without multiplexing$",
    fixedDiagnostics: DOCUMENT_SEQUENTIAL_CODES,
    onFixedDiagnostic: (code) => {
      const candidate = code.slice("DOCUMENT_SEQUENTIAL_".length).toLowerCase().replaceAll("_", "-");
      stage = DOCUMENT_SEQUENTIAL_STAGES.has(candidate) ? candidate : "diagnostic-failed";
    },
    fixedProgressDiagnostics: DOCUMENT_SEQUENTIAL_PROGRESS_CODES,
    onFixedProgressDiagnostic: (code) => {
      const candidate = code.slice("DOCUMENT_SEQUENTIAL_STAGE_".length)
        .toLowerCase().replaceAll("_", "-");
      if (DOCUMENT_SEQUENTIAL_STAGES.has(candidate)) stage = candidate;
    },
  });
  return { passed, stage };
}

async function executeDocumentDescriptorMismatchDiagnostic(options = {}) {
  let stderrKind;
  const passed = await executeBoundedNodeTestFile("document-process-registration.test.ts", {
    onSpawn: options.onSpawn,
    testTimeoutMs: DOCUMENT_PROCESS_TEST_TIMEOUT_MS,
    testNamePattern: "^document child registration rejects an inert acknowledgement peer$",
    fixedDiagnostics: DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_CODES,
    onFixedDiagnostic: (code) => {
      const candidate = code.slice("DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_".length)
        .toLowerCase().replaceAll("_", "-");
      if (DOCUMENT_DESCRIPTOR_MISMATCH_STDERR_KINDS.has(candidate)) stderrKind = candidate;
    },
  });
  return { passed, stderrKind };
}

async function executeBenchmarkPolicyDiagnostic(options = {}) {
  let assertionOrigin;
  let completionKind;
  let failureKind;
  let ordinal;
  let runnerFailureKind;
  let testCodeReason;
  let processTreeProgress;
  const passed = await executeBoundedNodeTestFile("benchmark-policy.test.ts", {
    onSpawn: options.onSpawn,
    spawnProcess: options.spawnProcess,
    terminateTree: options.terminateTree,
    testTimeoutMs: options.testTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    testSkipPattern: options.testSkipPattern,
    maximumTopLevelTests: 39,
    onCompletionKind: (value) => { completionKind = value; },
    onFailedTopLevelFailureKind: (value) => { failureKind = value; },
    onFailedTopLevelOrdinal: (value) => { ordinal = value; },
    onFailedTopLevelTestCodeReason: (value) => { testCodeReason = value; },
    onFailedTopLevelAssertionOrigin: (value) => { assertionOrigin = value; },
    onRunnerFailureKind: (value) => { runnerFailureKind = value; },
    onBenchmarkProcessTreeProgress: (value) => { processTreeProgress = value; },
  });
  return {
    assertionOrigin,
    passed,
    caseId: ordinal === undefined
      ? passed ? "benchmark-rerun-passed" : "benchmark-aggregate"
      : `bp${String(ordinal).padStart(2, "0")}`,
    completionKind,
    failureKind,
    runnerFailureKind,
    testCodeReason,
    ...(processTreeProgress ?? {}),
  };
}

async function executeMcpCancellationProgressDiagnostic(options = {}) {
  let assertionOrigin;
  let completionKind;
  let failureKind;
  let ordinal;
  let runnerFailureKind;
  let stage;
  let runningChildStage;
  let testCodeReason;
  const passed = await executeBoundedNodeTestFile("mcp-cancellation-progress.test.ts", {
    onSpawn: options.onSpawn,
    spawnProcess: options.spawnProcess,
    terminateTree: options.terminateTree,
    testTimeoutMs: options.testTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    maximumTopLevelTests: 14,
    onCompletionKind: (value) => { completionKind = value; },
    onFailedTopLevelFailureKind: (value) => { failureKind = value; },
    onFailedTopLevelOrdinal: (value) => { ordinal = value; },
    onFailedTopLevelTestCodeReason: (value) => { testCodeReason = value; },
    onFailedTopLevelAssertionOrigin: (value) => { assertionOrigin = value; },
    onRunnerFailureKind: (value) => { runnerFailureKind = value; },
    fixedProgressDiagnostics: [
      ...MCP_PREVIEW_CANCELLATION_CODES,
      ...MCP_RUNNING_CHILD_CODES,
    ],
    onFixedProgressDiagnostic: (code) => {
      if (code.startsWith("MCP_PREVIEW_CANCELLATION_FAILURE_")) {
        const candidate = code.slice("MCP_PREVIEW_CANCELLATION_FAILURE_".length)
          .toLowerCase().replaceAll("_", "-");
        if (MCP_PREVIEW_CANCELLATION_STAGES.has(candidate)) stage = candidate;
      } else if (code.startsWith("MCP_RUNNING_CHILD_STAGE_")) {
        const candidate = code.slice("MCP_RUNNING_CHILD_STAGE_".length)
          .toLowerCase().replaceAll("_", "-");
        if (MCP_RUNNING_CHILD_STAGES.has(candidate)) runningChildStage = candidate;
      }
    },
  });
  return {
    assertionOrigin,
    caseId: ordinal === undefined
      ? passed ? "mcp-cancellation-rerun-passed" : "mcp-cancellation-aggregate"
      : `mp${String(ordinal).padStart(2, "0")}`,
    completionKind,
    failureKind,
    runnerFailureKind,
    runningChildStage,
    stage,
    testCodeReason,
  };
}

async function executeKordocCoreDiagnostic(options = {}) {
  let ordinal;
  let stage;
  await executeBoundedNodeTestFile("kordoc-core-runtime.test.ts", {
    onSpawn: options.onSpawn,
    maximumTopLevelTests: 10,
    onFailedTopLevelOrdinal: (value) => { ordinal = value; },
    fixedProgressDiagnostics: KORDOC_CORE_PROGRESS_CODES,
    onFixedProgressDiagnostic: (code) => {
      if (code.startsWith("KORDOC_KC01_BUILD_STAGE_")) {
        const candidate = code.slice("KORDOC_KC01_BUILD_STAGE_".length)
          .toLowerCase().replaceAll("_", "-");
        if (KORDOC_CORE_BUILD_STAGES.has(candidate)) stage = `first-build-${candidate}`;
        return;
      }
      const candidate = code.slice("KORDOC_KC01_STAGE_".length)
        .toLowerCase().replaceAll("_", "-");
      if (KORDOC_CORE_OUTER_STAGES.has(candidate)) stage = candidate;
    },
  });
  return {
    caseId: ordinal === undefined
      ? "kordoc-core-aggregate"
      : `kc${String(ordinal).padStart(2, "0")}`,
    stage,
  };
}

async function executeSourceOrdinalDiagnostic(file, maximum, prefix, options = {}) {
  let ordinal;
  await executeBoundedNodeTestFile(file, {
    onSpawn: options.onSpawn,
    maximumTopLevelTests: maximum,
    onFailedTopLevelOrdinal: (value) => { ordinal = value; },
  });
  return ordinal === undefined ? "aggregate" : `${prefix}${String(ordinal).padStart(2, "0")}`;
}

async function executeOutputBudgetAtomicityDiagnostic(options = {}) {
  return executeSourceOrdinalDiagnostic("output-budget-atomicity.test.ts", 15, "ob", options);
}

async function executePatchDiagnostic(options = {}) {
  return executeSourceOrdinalDiagnostic("patch.test.ts", 23, "pa", options);
}

async function executePublicRuntimePrivacyDiagnostic(options = {}) {
  let ordinal;
  let nestedOrdinal;
  const passed = await executeBoundedNodeTestFile("public-runtime-privacy.test.ts", {
    onSpawn: options.onSpawn,
    spawnProcess: options.spawnProcess,
    terminateTree: options.terminateTree,
    testTimeoutMs: options.testTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    maximumTopLevelTests: 15,
    onFailedTopLevelOrdinal: (value) => { ordinal = value; },
    maximumNestedTests: 8,
    onFailedNestedOrdinal: (value) => { nestedOrdinal = value; },
  });
  const caseId = ordinal === undefined
    ? (passed ? "public-runtime-privacy-rerun-passed" : "public-runtime-privacy-aggregate")
    : `pr${String(ordinal).padStart(2, "0")}`;
  return {
    caseId,
    nestedCaseId: ordinal === 7 && nestedOrdinal !== undefined
      ? `pr07s${String(nestedOrdinal).padStart(2, "0")}`
      : undefined,
  };
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
    let childClosed = false;
    let terminationSettled = false;
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
      closeTimer = setTimeout(() => finish("diagnostic-failed"), options.closeTimeoutMs);
      void Promise.resolve().then(() => options.terminateTree(child)).catch(() => false)
        .then(() => {
          terminationSettled = true;
          if (childClosed) finish("diagnostic-failed");
        });
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
      if (stopping) {
        childClosed = true;
        if (terminationSettled) finish("diagnostic-failed");
        return;
      }
      if (code !== 0 || signal !== null) {
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
    const testTimeoutMs = boundedTimeout(
      options.testTimeoutMs,
      DEFAULT_TEST_TIMEOUT_MS,
      MAX_TEST_TIMEOUT_MS,
    );
    const closeTimeoutMs = boundedTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    let child;
    let settled = false;
    let stopping = false;
    let capturedBytes = 0;
    const chunks = [];
    let testTimer;
    let closeTimer;
    let childClosed = false;
    let terminationSettled = false;
    let runnerFailureReported = false;
    const reportRunnerFailure = (kind) => {
      if (runnerFailureReported || typeof options.onRunnerFailureKind !== "function") return;
      runnerFailureReported = true;
      try { options.onRunnerFailureKind(kind); } catch {}
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(testTimer);
      clearTimeout(closeTimer);
      child?.stdout?.destroy();
      resolveTest(value);
    };
    const stopUnverified = (kind) => {
      if (settled || stopping) return;
      reportRunnerFailure(kind);
      stopping = true;
      clearTimeout(testTimer);
      closeTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.unref?.();
        finish(false);
      }, closeTimeoutMs);
      void Promise.resolve().then(() => terminateProcessTree(child)).catch(() => false)
        .then(() => {
          terminationSettled = true;
          if (childClosed) finish(false);
        });
    };
    try {
      const repository = options.repository === true;
      const args = repository
        ? ["--test"]
        : ["--import", "tsx", "--test", "--test-concurrency=1"];
      if (options.testNamePattern !== undefined) {
        args.push(`--test-name-pattern=${options.testNamePattern}`);
      }
      if (options.testSkipPattern !== undefined) {
        assertRegisteredExactSkipPattern(options.testSkipPattern, file);
        args.push(`--test-skip-pattern=${options.testSkipPattern}`);
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
      reportRunnerFailure("spawn-error");
      finish(false);
      return;
    }
    child.once("spawn", () => {
      try { options.onSpawn?.(); } catch {}
    });
    if (child.stdout === null || child.stdout === undefined || !("on" in child.stdout)) {
      stopUnverified("missing-stdout");
      return;
    }
    child.stdout.once("error", () => stopUnverified("stdout-error"));
    child.stdout.on("data", (chunk) => {
      if (settled || stopping || !Buffer.isBuffer(chunk)) {
        if (!Buffer.isBuffer(chunk)) stopUnverified("invalid-chunk");
        return;
      }
      capturedBytes += chunk.byteLength;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        stopUnverified("capture-limit");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => stopUnverified("child-error"));
    child.once("close", (code, signal) => {
      if (stopping) {
        childClosed = true;
        if (terminationSettled) finish(false);
      } else {
        forwardFixedProgressDiagnostic(chunks, capturedBytes, options);
        forwardFixedDiagnostic(chunks, capturedBytes, options);
        forwardBenchmarkProcessTreeProgress(chunks, capturedBytes, options);
        forwardFailedTopLevelOrdinal(chunks, capturedBytes, options);
        forwardFailedNestedOrdinal(chunks, capturedBytes, options);
        forwardFailedTopLevelFailureKind(chunks, capturedBytes, options);
        forwardFailedTopLevelTestCodeReason(chunks, capturedBytes, options);
        forwardFailedTopLevelAssertionOrigin(chunks, capturedBytes, options);
        forwardCompletionKind(chunks, capturedBytes, code, signal, options);
        finish(code === 0 && signal === null && validTapReceipt(
          chunks, capturedBytes, options.allowAllSkipped === true,
        ));
      }
    });
    testTimer = setTimeout(() => stopUnverified("runner-timeout"), testTimeoutMs);
  });
}

const executeTestFile = executeBoundedNodeTestFile;

function forwardFailedTopLevelOrdinal(chunks, capturedBytes, options) {
  if (typeof options.onFailedTopLevelOrdinal !== "function"
    || !Number.isSafeInteger(options.maximumTopLevelTests)
    || options.maximumTopLevelTests < 1 || options.maximumTopLevelTests > 999) return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes)); }
  catch { return; }
  const ordinal = failedTopLevelOrdinal(text, options.maximumTopLevelTests);
  if (ordinal === undefined) return;
  try { options.onFailedTopLevelOrdinal(ordinal); } catch {}
}

function forwardFailedNestedOrdinal(chunks, capturedBytes, options) {
  if (typeof options.onFailedNestedOrdinal !== "function"
    || !Number.isSafeInteger(options.maximumNestedTests)
    || options.maximumNestedTests < 1 || options.maximumNestedTests > 999) return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes)); }
  catch { return; }
  const ordinal = failedNestedOrdinal(text, options.maximumNestedTests);
  if (ordinal === undefined) return;
  try { options.onFailedNestedOrdinal(ordinal); } catch {}
}

function forwardCompletionKind(chunks, capturedBytes, code, signal, options) {
  if (typeof options.onCompletionKind !== "function") return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes)); }
  catch { text = ""; }
  const kind = classifyNodeTestCompletion(text, code, signal);
  try { options.onCompletionKind(kind); } catch {}
}

export function classifyNodeTestCompletion(text, code, signal) {
  if (signal !== null) return "child-signal";
  if (typeof text !== "string") return "invalid-summary";
  const tests = Number(/^# tests ([0-9]+)$/mu.exec(text)?.[1]);
  const passed = Number(/^# pass ([0-9]+)$/mu.exec(text)?.[1]);
  const failed = Number(/^# fail ([0-9]+)$/mu.exec(text)?.[1]);
  const cancelled = Number(/^# cancelled ([0-9]+)$/mu.exec(text)?.[1]);
  const skipped = Number(/^# skipped ([0-9]+)$/mu.exec(text)?.[1]);
  if (![tests, passed, failed, cancelled, skipped].every(Number.isSafeInteger)
    || tests < 1 || tests !== passed + failed + cancelled + skipped) {
    return "invalid-summary";
  }
  if (failed > 0) return "test-failure";
  if (cancelled > 0) return "cancelled";
  if (code !== 0) return "nonzero-clean-tap";
  return "passed";
}

function forwardFailedTopLevelFailureKind(chunks, capturedBytes, options) {
  if (typeof options.onFailedTopLevelFailureKind !== "function") return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes)); }
  catch { return; }
  const kind = failedTopLevelFailureKind(text);
  if (kind === undefined) return;
  try { options.onFailedTopLevelFailureKind(kind); } catch {}
}

export function failedTopLevelFailureKind(text) {
  if (typeof text !== "string" || !/^not ok [1-9][0-9]* - /mu.test(text)
    || !/^# fail [1-9][0-9]*$/mu.test(text)) return undefined;
  const raw = /^  failureType: '([^'\r\n]{1,64})'$/mu.exec(text)?.[1];
  if (raw === "testTimeoutFailure") return "test-timeout";
  if (raw === "hookFailed") return "hook-failure";
  if (raw === "testCodeFailure" || raw === "subtestsFailed") return "test-code";
  if (raw === "uncaughtException" || raw === "unhandledRejection") return "async-failure";
  if (raw === "cancelledByParent") return "cancelled";
  return "unknown";
}

function forwardFailedTopLevelTestCodeReason(chunks, capturedBytes, options) {
  if (typeof options.onFailedTopLevelTestCodeReason !== "function") return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes)); }
  catch { return; }
  const reason = failedTopLevelTestCodeReason(text);
  if (reason === undefined) return;
  try { options.onFailedTopLevelTestCodeReason(reason); } catch {}
}

export function failedTopLevelTestCodeReason(text) {
  if (typeof text !== "string" || !/^not ok [1-9][0-9]* - /mu.test(text)
    || !/^# fail [1-9][0-9]*$/mu.test(text)
    || !/^  failureType: 'testCodeFailure'$/mu.test(text)) return undefined;
  if (/^  code: 'ERR_ASSERTION'$/mu.test(text)) return "assertion";
  if (/generated asynchronous activity after (?:the )?test ended/iu.test(text)) {
    return "async-activity";
  }
  if (/^  code: 'ERR_TEST_FAILURE'$/mu.test(text)) return "test-failure";
  return "unknown";
}

function forwardFailedTopLevelAssertionOrigin(chunks, capturedBytes, options) {
  if (typeof options.onFailedTopLevelAssertionOrigin !== "function") return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, capturedBytes)); }
  catch { return; }
  const origin = failedTopLevelAssertionOrigin(text);
  if (origin === undefined) return;
  try { options.onFailedTopLevelAssertionOrigin(origin); } catch {}
}

export function failedTopLevelAssertionOrigin(text) {
  if (typeof text !== "string" || !/^not ok [1-9][0-9]* - /mu.test(text)
    || !/^# fail [1-9][0-9]*$/mu.test(text)
    || !/^  failureType: 'testCodeFailure'$/mu.test(text)
    || !/^  code: 'ERR_ASSERTION'$/mu.test(text)) return undefined;
  const candidates = [
    ["register-root", text.search(/^ {4,8}(?:at )?Object\.registerRoot \(/mu)],
    ["test-body", text.search(/^ {4,8}(?:at )?TestContext\.<anonymous> \(/mu)],
  ].filter(([, index]) => index >= 0).sort((left, right) => left[1] - right[1]);
  if (candidates.length > 0) return candidates[0][0];
  return "unknown";
}

export function formatBenchmarkDiagnosticReceipt(value) {
  const receiptPrefix = value?.receiptPrefix === "WINDOWS" ? "WINDOWS" : "MAC";
  const caseId = /^(?:bp(?:0[1-9]|[12][0-9]|3[0-9])|benchmark-(?:aggregate|rerun-passed))$/u
    .test(value?.caseId) ? value.caseId : "benchmark-aggregate";
  const failureKind = NODE_FAILURE_KINDS.has(value?.failureKind) ? value.failureKind : "unknown";
  const completionKind = NODE_COMPLETION_KINDS.has(value?.completionKind)
    ? value.completionKind : "unknown";
  const diagnosticStage = BENCHMARK_DIAGNOSTIC_STAGES.has(value?.diagnosticStage)
    ? value.diagnosticStage : "unknown";
  const assertionOrigin = NODE_ASSERTION_ORIGINS.has(value?.assertionOrigin)
    ? value.assertionOrigin : "unknown";
  const rootCleanup = ["gone", "unverified"].includes(value?.rootCleanup)
    ? value.rootCleanup : "unknown";
  const processGroupCleanup = ["gone", "unverified"].includes(value?.processGroupCleanup)
    ? value.processGroupCleanup : "unknown";
  const countsAvailable = validBenchmarkIdentityCounts(
    value?.registeredIdentityCount,
    value?.remainingIdentityCount,
  );
  const registeredIdentityCount = countsAvailable ? value.registeredIdentityCount : "unavailable";
  const remainingIdentityCount = countsAvailable ? value.remainingIdentityCount : "unavailable";
  const testCodeReason = NODE_TEST_CODE_REASONS.has(value?.testCodeReason)
    ? value.testCodeReason : "unknown";
  const runnerFailureKind = NODE_RUNNER_FAILURE_KINDS.has(value?.runnerFailureKind)
    ? value.runnerFailureKind : "unknown";
  const required = `${receiptPrefix}_BENCHMARK_RECEIPT caseId=${caseId} status=failed`
    + ` failureKind=${failureKind} completionKind=${completionKind}`
    + ` diagnosticStage=${diagnosticStage} assertionOrigin=${assertionOrigin}`
    + ` rootCleanup=${rootCleanup} processGroupCleanup=${processGroupCleanup}`
    + ` registeredIdentityCount=${registeredIdentityCount}`
    + ` remainingIdentityCount=${remainingIdentityCount}`;
  const complete = `${required} testCodeReason=${testCodeReason}`
    + ` runnerFailureKind=${runnerFailureKind} truncated=false`;
  if (Buffer.byteLength(complete) <= MAX_BENCHMARK_DIAGNOSTIC_RECEIPT_BYTES) return complete;
  return `${required} truncated=true`;
}

function validBenchmarkIdentityCounts(registered, remaining) {
  return Number.isSafeInteger(registered) && Number.isSafeInteger(remaining)
    && registered >= 0 && remaining >= 0 && remaining <= registered
    && registered <= MAX_BENCHMARK_REGISTERED_IDENTITIES;
}

export function failedTopLevelOrdinal(text, maximumTopLevelTests) {
  if (typeof text !== "string" || !Number.isSafeInteger(maximumTopLevelTests)
    || maximumTopLevelTests < 1 || maximumTopLevelTests > 999
    || !/^# fail [1-9][0-9]*$/mu.test(text)) return undefined;
  const match = /^not ok ([1-9][0-9]*) - /mu.exec(text);
  if (match === null) return undefined;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) && ordinal <= maximumTopLevelTests ? ordinal : undefined;
}

export function failedNestedOrdinal(text, maximumNestedTests) {
  if (typeof text !== "string" || !Number.isSafeInteger(maximumNestedTests)
    || maximumNestedTests < 1 || maximumNestedTests > 999
    || !/^# fail [1-9][0-9]*$/mu.test(text)) return undefined;
  const matches = [...text.matchAll(/^ {4}not ok ([1-9][0-9]*) - /gmu)];
  if (matches.length !== 1) return undefined;
  const ordinal = Number(matches[0][1]);
  return Number.isSafeInteger(ordinal) && ordinal <= maximumNestedTests ? ordinal : undefined;
}

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

function forwardFixedProgressDiagnostic(chunks, capturedBytes, options) {
  if (!Array.isArray(options.fixedProgressDiagnostics)
    || typeof options.onFixedProgressDiagnostic !== "function") return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return; }
  const allowlisted = new Set(options.fixedProgressDiagnostics.filter((code) =>
    typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)));
  let observed;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("# ")) continue;
    const candidate = line.slice(2);
    if (allowlisted.has(candidate)) observed = candidate;
  }
  if (observed === undefined) return;
  try { options.onFixedProgressDiagnostic(observed); } catch {}
}

function forwardBenchmarkProcessTreeProgress(chunks, capturedBytes, options) {
  if (typeof options.onBenchmarkProcessTreeProgress !== "function") return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return; }
  const lines = text.split(/\r?\n/u).filter((line) =>
    line.startsWith("# BENCHMARK_PROCESS_TREE "));
  if (lines.length !== 1) return;
  const match = /^# BENCHMARK_PROCESS_TREE diagnosticStage=([a-z0-9-]+) rootCleanup=(gone|unverified|unknown) processGroupCleanup=(gone|unverified|unknown) registeredIdentityCount=(unavailable|[0-9]{1,2}) remainingIdentityCount=(unavailable|[0-9]{1,2})$/u.exec(lines[0]);
  if (match === null || !(BENCHMARK_DIAGNOSTIC_STAGES.has(match[1]) || match[1] === "unknown")) {
    return;
  }
  const unavailable = match[4] === "unavailable" && match[5] === "unavailable";
  const registeredIdentityCount = unavailable ? null : Number(match[4]);
  const remainingIdentityCount = unavailable ? null : Number(match[5]);
  if (!unavailable && !validBenchmarkIdentityCounts(
    registeredIdentityCount,
    remainingIdentityCount,
  )) return;
  try {
    options.onBenchmarkProcessTreeProgress(Object.freeze({
      diagnosticStage: match[1],
      rootCleanup: match[2],
      processGroupCleanup: match[3],
      registeredIdentityCount,
      remainingIdentityCount,
    }));
  } catch {}
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
  if (process.platform === "win32") return terminateReleaseProcessTree(child);
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(-pid, "SIGKILL"); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return true;
    try { return child.kill("SIGKILL") === true; } catch { return false; }
  }
}

function boundedTimeout(value, fallback, maximum = 120_000) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return fallback;
  return value;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  let profile;
  try { profile = parseNodeTestProfileArguments(process.argv.slice(2)); }
  catch {
    process.stderr.write("Invalid Node test profile.\n");
    process.exitCode = 1;
  }
  if (profile !== undefined) await runMacNodeTestsDiagnostic({ profile });
}
