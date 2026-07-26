import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import JSZip from "jszip";

import { REQUIRED_RELEASE_STAGES } from "../../../scripts/release-verify.mjs";
import {
  isRetryablePosixRealDetectTelemetryGap,
  rethrowWithLinuxRealDetectDiagnostic,
} from "../benchmarks/hosted-platform-diagnostics.mjs";
import { finalizeVerifiedWindowsSupervisor } from "../src/workers/document-child-client.js";
import { createDocumentWorkerClient } from "../src/workers/document-worker-client.js";
import {
  createRegisteredPosixProcessGroupSupervisor,
  normalizeProcessTreeTerminationReceipt,
} from "../src/workers/registered-process-supervisor.js";
import {
  APPROVED_BENCHMARK_SIZES_MIB,
  BENCHMARK_CONCURRENCY,
  BENCHMARK_RECEIPT_SCHEMA_VERSION,
  LOCAL_EXPERIMENTAL_BENCHMARK_SIZES_MIB,
  PR_SMOKE_BENCHMARK_SIZES_MIB,
  VERIFIED_SUPPORT_BENCHMARK_SIZES_MIB,
  assertIgnoredBenchmarkOutput,
  assertCaseProcessGone,
  benchmarkImplementationInputPaths,
  benchmarkImplementationSha256,
  buildParentFailureReceipt,
  cleanupOwnedBenchmarkCase,
  createOwnedBenchmarkCase,
  executeBounded,
  classifyBenchmarkSupervisorFrame,
  formatBenchmarkFailure,
  formatBenchmarkCaseFailure,
  formatBenchmarkSnapshotFailure,
  formatBenchmarkProbeFailure,
  formatBenchmarkProgress,
  parseBenchmarkArguments,
  resolveLargeBenchmarkEvidencePath,
  runBenchmark,
  runBenchmarkCaseWithTelemetryRetry,
  validateBenchmarkReceipt,
  validateCaseSizeMiB,
  validateLargeBenchmarkEvidence,
} from "../benchmarks/document-engine-benchmark.mjs";
import {
  generatePaddedHwpx,
  paddingEntryPlan,
  validateRequestedBytes,
} from "../benchmarks/generate-padded-hwpx.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const BENCHMARK_ENTRY = join(PACKAGE_ROOT, "benchmarks", "document-engine-benchmark.mjs");
const HOSTED_DIAGNOSTIC_ENTRY = join(
  PACKAGE_ROOT,
  "benchmarks",
  "hosted-platform-diagnostics.mjs",
);
const CI_WORKFLOW = join(REPOSITORY_ROOT, ".github", "workflows", "ci.yml");
const MACOS_BACKEND_PROBE = new URL(
  "./fixtures/workers/backend-init-probe.mjs",
  import.meta.url,
);

test("hosted diagnostic formatters accept only exact bounded tuples", async () => {
  const {
    formatHostedMacBackendDiagnostic,
    formatHostedMacWorkerDiagnostic,
    formatHostedWindowsSupervisorLateDiagnostic,
    formatHostedWindowsSupervisorDiagnostic,
    formatLinuxRealDetectDiagnostic,
  } = await import("../benchmarks/hosted-platform-diagnostics.mjs");

  assert.equal(
    formatHostedWindowsSupervisorDiagnostic({ boundary: "ready-mode-1" }),
    "HOSTED_WINDOWS_SUPERVISOR boundary=ready-mode-1",
  );
  assert.equal(
    formatHostedWindowsSupervisorLateDiagnostic({ boundary: "ready-late" }),
    "HOSTED_WINDOWS_SUPERVISOR_LATE boundary=ready-late",
  );
  assert.equal(
    formatHostedMacBackendDiagnostic({ boundary: "backend-ready" }),
    "HOSTED_MAC_BACKEND boundary=backend-ready",
  );
  assert.equal(
    formatHostedMacWorkerDiagnostic({ boundary: "result" }),
    "HOSTED_MAC_WORKER boundary=result",
  );
  assert.equal(
    formatLinuxRealDetectDiagnostic({
      status: "failed",
      processGone: true,
      telemetryEnded: true,
      framePresent: true,
      rssPresent: false,
      stage: "error-rss-receipt",
    }),
    "LINUX_REAL_DETECT status=failed processGone=true telemetryEnded=true framePresent=true rssPresent=false stage=error-rss-receipt",
  );
});

test("hosted diagnostic formatters reject raw, unknown, extra-key, and oversized input", async () => {
  const {
    formatHostedMacBackendDiagnostic,
    formatHostedMacWorkerDiagnostic,
    formatHostedWindowsSupervisorLateDiagnostic,
    formatHostedWindowsSupervisorDiagnostic,
    formatLinuxRealDetectDiagnostic,
  } = await import("../benchmarks/hosted-platform-diagnostics.mjs");
  const invalidWindows = [
    { boundary: "unknown" },
    { boundary: "C:\\private\\document.hwpx" },
    { boundary: "ready-mode-1\nPRIVATE" },
    { boundary: "x".repeat(1_024) },
    { boundary: "ready-mode-1", extra: true },
  ];
  for (const value of invalidWindows) {
    assert.throws(() => formatHostedWindowsSupervisorDiagnostic(value), {
      code: "HOSTED_DIAGNOSTIC_INVALID",
    });
    assert.throws(() => formatHostedWindowsSupervisorLateDiagnostic(value), {
      code: "HOSTED_DIAGNOSTIC_INVALID",
    });
  }
  for (const value of [
    { boundary: "ready-mode-1" },
    { boundary: "ready-late\nPRIVATE" },
    { boundary: "ready-late", extra: "C:\\private\\file" },
  ]) {
    assert.throws(() => formatHostedWindowsSupervisorLateDiagnostic(value), {
      code: "HOSTED_DIAGNOSTIC_INVALID",
    });
  }
  assert.throws(() => formatHostedMacBackendDiagnostic({
    boundary: "backend-ready",
    path: "/private/document.hwpx",
  }), { code: "HOSTED_DIAGNOSTIC_INVALID" });
  assert.throws(() => formatHostedMacWorkerDiagnostic({ boundary: "worker-error\nraw" }), {
    code: "HOSTED_DIAGNOSTIC_INVALID",
  });
  assert.throws(() => formatLinuxRealDetectDiagnostic({
    status: "failed",
    processGone: true,
    telemetryEnded: true,
    framePresent: true,
    rssPresent: false,
    stage: "PRIVATE_STAGE",
  }), { code: "HOSTED_DIAGNOSTIC_INVALID" });
});

test("Linux real-detect diagnostic emits the safe tuple and rethrows the original failure", async () => {
  const { rethrowWithLinuxRealDetectDiagnostic } = await import(
    "../benchmarks/hosted-platform-diagnostics.mjs"
  );
  const failure = Object.assign(new Error("PRIVATE RAW ERROR"), {
    telemetryDiagnostic: {
      status: "failed",
      processGone: true,
      telemetryEnded: true,
      framePresent: false,
      rssPresent: true,
      stage: "error-sampling",
    },
  });
  const lines: string[] = [];
  assert.throws(
    () => rethrowWithLinuxRealDetectDiagnostic(failure, (line: string) => lines.push(line)),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(lines, [
    "LINUX_REAL_DETECT status=failed processGone=true telemetryEnded=true framePresent=false rssPresent=true stage=error-sampling",
  ]);
});

test("POSIX real-detect retry accepts only the exact missing-RSS telemetry gap", async (t) => {
  const exact = {
    code: "BENCHMARK_TELEMETRY_UNAVAILABLE",
    telemetryDiagnostic: {
      status: "failed",
      processGone: true,
      telemetryEnded: true,
      framePresent: true,
      rssPresent: false,
      stage: "posix-telemetry-sample",
    },
  };
  assert.equal(isRetryablePosixRealDetectTelemetryGap(exact), true);
  assert.equal(isRetryablePosixRealDetectTelemetryGap({
    ...exact,
    code: "ENGINE_CRASH",
  }), false);
  assert.equal(isRetryablePosixRealDetectTelemetryGap({
    ...exact,
    telemetryDiagnostic: { ...exact.telemetryDiagnostic, rssPresent: true },
  }), false);
  assert.equal(isRetryablePosixRealDetectTelemetryGap({
    ...exact,
    telemetryDiagnostic: { ...exact.telemetryDiagnostic, privatePath: "/private/file" },
  }), false);
  await t.test("benchmark case uses fresh ownership for the one retry", async () => {
    const transient = Object.assign(new Error("transient telemetry"), exact);
    const calls: string[] = [];
    const receipt = await runBenchmarkCaseWithTelemetryRetry(256, "owned-parent", {
      platform: "darwin",
      runCase: async (sizeMiB: number, outputParent: string) => {
        calls.push(`${sizeMiB}:${outputParent}`);
        if (calls.length === 1) throw transient;
        return "fresh-receipt";
      },
    });
    assert.equal(receipt, "fresh-receipt");
    assert.deepEqual(calls, ["256:owned-parent", "256:owned-parent"]);

    for (const [platform, failure] of [
      ["win32", transient],
      ["darwin", Object.assign(new Error("other"), { ...exact, code: "ENGINE_CRASH" })],
      ["linux", Object.assign(new Error("extra"), {
        ...exact,
        telemetryDiagnostic: { ...exact.telemetryDiagnostic, privatePath: "/private/file" },
      })],
    ] as const) {
      let attempts = 0;
      await assert.rejects(
        runBenchmarkCaseWithTelemetryRetry(256, "owned-parent", {
          platform,
          runCase: async () => {
            attempts += 1;
            throw failure;
          },
        }),
        (error: unknown) => error === failure,
      );
      assert.equal(attempts, 1);
    }
  });
});

test("hosted platform wrappers return only bounded classifier tuples", async () => {
  const {
    runHostedMacDiagnostics,
    runHostedWindowsSupervisorDiagnostic,
  } = await import("../benchmarks/hosted-platform-diagnostics.mjs");
  const target = { kill() {} };
  assert.deepEqual(await runHostedWindowsSupervisorDiagnostic({
    platform: "win32",
    arch: "x64",
    spawnTarget: () => target,
    observeTargetClose: async () => ({ code: 0, signal: null, error: null }),
    superviseTarget: async (_target: unknown, observe: (boundary: string) => void) => {
      observe("ready-mode-1");
      return {
        terminate: async () => ({ gone: true, proof: "windows-job-empty" }),
      };
    },
  }), { production: { boundary: "target-close" } });
  assert.deepEqual(await runHostedWindowsSupervisorDiagnostic({
    platform: "win32",
    arch: "x64",
    spawnTarget: () => target,
    observeTargetClose: async () => ({ code: 1, signal: null, error: null }),
    superviseTarget: async (_target: unknown, observe: (boundary: string) => void) => {
      observe("preframe-stderr");
      throw new Error("PRIVATE RAW ERROR");
    },
  }), { production: { boundary: "preframe-stderr" } });
  assert.deepEqual(await runHostedWindowsSupervisorDiagnostic({
    platform: "win32",
    arch: "x64",
    spawnTarget: () => target,
    observeTargetClose: async () => ({
      code: "PRIVATE",
      signal: 17,
      error: null,
    }),
    superviseTarget: async (_target: unknown, observe: (boundary: string) => void) => {
      observe("preframe-stderr");
      throw new Error("PRIVATE RAW ERROR");
    },
  }), { production: { boundary: "target-close" } });
  assert.deepEqual(await runHostedWindowsSupervisorDiagnostic({
    platform: "win32",
    arch: "x64",
    spawnTarget: () => target,
    observeTargetClose: async () => ({ code: 1, signal: null, error: null }),
    superviseTarget: async (_target: unknown, observe: (boundary: string) => void) => {
      observe("ready-mode-1");
      return {
        terminate: async () => {
          observe("helper-close");
          return { gone: false, proof: "unverified", reason: "termination" };
        },
      };
    },
  }), { production: { boundary: "helper-close" } });
  const boundedTargetClose = await Promise.race([
    runHostedWindowsSupervisorDiagnostic({
      platform: "win32",
      arch: "x64",
      targetCloseTimeoutMs: 5,
      spawnTarget: () => target,
      observeTargetClose: async () => await new Promise(() => {}),
      superviseTarget: async (_target: unknown, observe: (boundary: string) => void) => {
        observe("ready-mode-1");
        return {
          terminate: async () => ({ gone: true, proof: "windows-job-empty" }),
        };
      },
    }),
    new Promise<"unbounded">((resolveTimeout) => {
      setTimeout(() => resolveTimeout("unbounded"), 100);
    }),
  ]);
  assert.deepEqual(boundedTargetClose, { production: { boundary: "target-close" } });

  assert.deepEqual(await runHostedWindowsSupervisorDiagnostic({
    platform: "win32",
    arch: "x64",
    spawnTarget: () => target,
    observeTargetClose: async () => ({ code: 0, signal: null, error: null }),
    superviseTarget: async (
      _target: unknown,
      observeProduction: (boundary: string) => void,
      observeLate: (boundary: string) => void,
    ) => {
      observeProduction("frame-timeout");
      observeLate("ready-late");
      throw new Error("PRIVATE RAW ERROR");
    },
  }), {
    production: { boundary: "frame-timeout" },
    late: { boundary: "ready-late" },
  });
  assert.deepEqual(await runHostedWindowsSupervisorDiagnostic({
    platform: "win32",
    arch: "x64",
    spawnTarget: () => target,
    observeTargetClose: async () => ({
      code: 0,
      signal: null,
      error: null,
      extra: "C:\\private\\file",
    }),
    superviseTarget: async (
      _target: unknown,
      observeProduction: (boundary: string) => void,
      observeLate: (boundary: string) => void,
    ) => {
      observeProduction("frame-timeout");
      observeLate("ready-late");
      throw new Error("PRIVATE RAW ERROR");
    },
  }), {
    production: { boundary: "frame-timeout" },
    late: { boundary: "target-close" },
  });
  assert.deepEqual(await runHostedMacDiagnostics({
    platform: "darwin",
    arch: "arm64",
    probeBackend: async () => "backend-ready",
    probeWorker: async () => "result",
  }), {
    backend: { boundary: "backend-ready" },
    worker: { boundary: "result" },
  });
  assert.deepEqual(await runHostedMacDiagnostics({
    platform: "darwin",
    arch: "arm64",
    probeBackend: async () => { throw new Error("/private/backend/path"); },
    probeWorker: async () => { throw new Error("PRIVATE WORKER STDERR"); },
  }), {
    backend: { boundary: "worker-error" },
    worker: { boundary: "worker-error" },
  });
});

test("hosted platform classifiers run after build and before the PR profile and 10 MiB smoke", async () => {
  const workflow = await readFile(CI_WORKFLOW, "utf8");
  const windowsStart = workflow.indexOf("\n  windows:\n");
  const macosStart = workflow.indexOf("\n  macos:\n");
  const linuxStart = workflow.indexOf("\n  linux:\n");
  assert.ok(windowsStart >= 0 && windowsStart < macosStart && macosStart < linuxStart);

  const windows = workflow.slice(windowsStart, macosStart);
  const macos = workflow.slice(macosStart, linuxStart);
  const windowsBuild = windows.indexOf("name: Build source package");
  const windowsDiagnostic = windows.indexOf("name: Classify hosted Windows supervisor boundary");
  const windowsProfile = windows.indexOf("name: Run Windows PR Node profile");
  const windowsSmoke = windows.indexOf("name: Run 10 MiB document smoke");
  const macBuild = macos.indexOf("name: Build source package");
  const macDiagnostic = macos.indexOf("name: Classify hosted macOS worker boundaries");
  const macProfile = macos.indexOf("name: Run macOS PR Node profile");
  const macSmoke = macos.indexOf("name: Run 10 MiB document smoke");
  assert.ok(
    windowsBuild >= 0
      && windowsBuild < windowsDiagnostic
      && windowsDiagnostic < windowsProfile
      && windowsProfile < windowsSmoke,
  );
  assert.ok(
    macBuild >= 0
      && macBuild < macDiagnostic
      && macDiagnostic < macProfile
      && macProfile < macSmoke,
  );
  assert.match(windows, /run: npm --prefix packages\/gpt-codex-hwp run diagnose:hosted -- --windows-supervisor/u);
  assert.match(macos, /run: npm --prefix packages\/gpt-codex-hwp run diagnose:hosted -- --mac-worker/u);
});

test("hosted macOS worker classifier never coerces a missing result observation to success", async () => {
  const source = await readFile(HOSTED_DIAGNOSTIC_ENTRY, "utf8");
  assert.doesNotMatch(source, /return boundary === "result" \? boundary : "result";/u);
});

test("benchmark policy accepts only bounded approved sizes with fixed sequential execution", () => {
  assert.deepEqual(PR_SMOKE_BENCHMARK_SIZES_MIB, [10]);
  assert.deepEqual(VERIFIED_SUPPORT_BENCHMARK_SIZES_MIB, [100]);
  assert.deepEqual(LOCAL_EXPERIMENTAL_BENCHMARK_SIZES_MIB, [256, 512]);
  assert.deepEqual(APPROVED_BENCHMARK_SIZES_MIB, [10, 100, 256, 512]);
  for (const role of [
    PR_SMOKE_BENCHMARK_SIZES_MIB,
    VERIFIED_SUPPORT_BENCHMARK_SIZES_MIB,
    LOCAL_EXPERIMENTAL_BENCHMARK_SIZES_MIB,
    APPROVED_BENCHMARK_SIZES_MIB,
  ]) assert.equal(Object.isFrozen(role), true);
  assert.equal(BENCHMARK_CONCURRENCY, 1);
  assert.deepEqual(
    parseBenchmarkArguments([
      "--sizes",
      "10,100,256,512",
      "--output",
      ".superpowers/benchmarks/results.json",
    ], { env: { HWP_BENCH_LARGE: "1" } }),
    {
      sizesMiB: [10, 100, 256, 512],
      outputPath: resolve(REPOSITORY_ROOT, ".superpowers/benchmarks/results.json"),
    },
  );
  for (const args of [
    ["--sizes", "1", "--output", ".superpowers/benchmarks/results.json"],
    ["--sizes", "10,10", "--output", ".superpowers/benchmarks/results.json"],
    ["--sizes", "10", "--output", ".superpowers/benchmarks/results.json", "--jobs", "2"],
  ]) {
    assert.throws(() => parseBenchmarkArguments(args), { code: "BENCHMARK_ARGUMENTS_INVALID" });
  }
  assert.throws(() => validateRequestedBytes(512 * 1024 * 1024 + 1), {
    code: "BENCHMARK_SIZE_INVALID",
  });
  assert.equal(validateCaseSizeMiB(10), 10);
  assert.deepEqual(
    parseBenchmarkArguments([
      "--sizes",
      "256,512",
      "--output",
      ".superpowers/benchmarks/experimental.json",
    ], { env: { HWP_BENCH_LARGE: "1" } }).sizesMiB,
    [256, 512],
  );
  assert.throws(
    () => parseBenchmarkArguments([
      "--sizes",
      "256,512",
      "--output",
      ".superpowers/benchmarks/experimental.json",
    ], { env: {} }),
    { code: "BENCHMARK_LARGE_DISABLED" },
  );
  assert.equal(
    resolveLargeBenchmarkEvidencePath(".superpowers/benchmarks/release-large.json"),
    resolve(REPOSITORY_ROOT, ".superpowers/benchmarks/release-large.json"),
  );
  for (const value of ["", "   ", null, 42]) {
    assert.throws(
      () => resolveLargeBenchmarkEvidencePath(value as string),
      { code: "BENCHMARK_ARGUMENTS_INVALID" },
    );
  }
  assert.throws(() => validateCaseSizeMiB(11), { code: "BENCHMARK_ARGUMENTS_INVALID" });
});

test("benchmark diagnostics expose only bounded stage labels", () => {
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_JOB READY 123 1 456"),
    "ready-mode-1",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_JOB READY 123 2 456"),
    "ready-mode-2",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_JOB RSS 100 200"),
    "finalizer",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("PRIVATE_DOCUMENT_CONTENT"),
    "channel",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_JOB ERROR termination-scan-exhausted tracked_tree_did_not_reach_zero"),
    "windows-termination-scan-exhausted",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_JOB ERROR termination invalid"),
    "windows-termination",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_POSIX ERROR root-authority"),
    "posix-root-authority",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_POSIX ERROR telemetry-sample"),
    "posix-telemetry-sample",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_JOB ERROR finalizer invalid"),
    "windows-finalizer",
  );
  assert.equal(
    classifyBenchmarkSupervisorFrame("GPT_CODEX_HWP_JOB ERROR channel invalid"),
    "windows-channel",
  );
  assert.equal(
    formatBenchmarkFailure({
      code: "BENCHMARK_TERMINATION_FAILED",
      diagnosticStage: "ready-mode-2",
      privateValue: "PRIVATE_DOCUMENT_CONTENT",
    }),
    "BENCHMARK_TERMINATION_FAILED stage=ready-mode-2",
  );
  assert.equal(
    formatBenchmarkFailure({ code: "secret-value", diagnosticStage: "PRIVATE_STAGE_VALUE" }),
    "BENCHMARK_FAILED",
  );
});

test("benchmark shutdown preserves an earlier bounded startup diagnostic", async () => {
  const result = await executeBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 100,
    env: process.env,
    controlFrame: Object.freeze({}),
    supervisorFactory: async () => {
      throw new Error("synthetic startup failure");
    },
  });
  assert.equal(result.status, "termination-failed");
  assert.equal(result.diagnosticStage, "error-startup");
  assert.deepEqual(result.telemetryDiagnostic, {
    status: "failed",
    processGone: false,
    telemetryEnded: true,
    framePresent: false,
    rssPresent: false,
    stage: "error-startup",
  });
});

test("benchmark source does not overwrite a classified supervisor startup frame", async () => {
  const source = await readFile(BENCHMARK_ENTRY, "utf8");
  assert.match(
    source,
    /if \(diagnosticStage === "channel"\) diagnosticStage = "error-startup";/u,
  );
  assert.doesNotMatch(source, /\.catch\(\(error\) => \{\s*diagnosticStage = "error-startup";/u);
});

test("benchmark policy records a real nonempty detect dispatch before its one defensive copy", { timeout: 120_000 }, async (t) => {
  const outputPaths = [0, 1].map((attempt) => join(
    REPOSITORY_ROOT,
    ".superpowers",
    "benchmarks",
    `real-detect-${process.pid}-${Date.now()}-${attempt}.json`,
  ));
  t.after(async () => {
    await Promise.all(outputPaths.map((path) => rm(path, { force: true })));
  });

  let evidence;
  for (const [attempt, outputPath] of outputPaths.entries()) {
    try {
      evidence = await runBenchmark({
        sizesMiB: [10],
        outputPath,
      });
      break;
    } catch (error: unknown) {
      const retry = process.platform !== "win32"
        && attempt === 0
        && isRetryablePosixRealDetectTelemetryGap(error);
      if (retry) continue;
      rethrowWithLinuxRealDetectDiagnostic(error, (line: string) => t.diagnostic(line));
    }
  }
  assert.ok(evidence);
  const receipt = evidence.receipts[0];

  assert.ok(receipt);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.dispatchStarted, true);
  assert.equal(receipt.actualBytes > 0, true);
  assert.equal(receipt.copiedBytes, receipt.actualBytes);
});

test("benchmark policy requires one-shot inherited control for internal case execution", async () => {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    join(PACKAGE_ROOT, "benchmarks", "document-engine-benchmark.mjs"),
    "--case",
    "10",
  ], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, HWP_BENCH_CASE_TOKEN: "00000000-0000-0000-0000-000000000000" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  assert.notEqual(exitCode, 0);
});

test("benchmark policy verifies descendant termination after abnormal case exit", async (t) => {
  const fixture = join(
    REPOSITORY_ROOT,
    ".superpowers",
    "benchmarks",
    `abnormal-case-${process.pid}.mjs`,
  );
  await mkdir(dirname(fixture), { recursive: true });
  t.after(() => rm(fixture, { force: true }));
  await writeFile(fixture, [
    "import { spawn } from 'node:child_process';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "readFileSync(3, 'utf8');",
    "writeFileSync(4, JSON.stringify({ elapsedMs: 25, copiedBytes: 0, dispatchStarted: false }) + '\\n');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(child.pid));",
    "setTimeout(() => process.exit(9), 50);",
  ].join("\n"), "utf8");
  const result = await executeBounded(process.execPath, [fixture], {
    cwd: PACKAGE_ROOT,
    // Hosted macOS can spend more than five seconds establishing the
    // identity-bound process-group and RSS baseline before releasing fd 3.
    // Keep this control bounded, but leave enough room to exercise the
    // abnormal-exit cleanup instead of timing out during supervision setup.
    timeoutMs: 15_000,
    env: process.env,
    controlFrame: { bounded: true },
  });
  const telemetryDiagnostic = JSON.stringify(result.telemetryDiagnostic ?? null);
  assert.equal(result.processGone, true, telemetryDiagnostic);
  assert.equal(result.status, "failed", telemetryDiagnostic);
  assert.ok(result.elapsedMs > 0);
  assert.deepEqual(result.caseMetrics, {
    elapsedMs: 25,
    copiedBytes: 0,
    dispatchStarted: false,
    peakRssDeltaBytes: result.caseMetrics.peakRssDeltaBytes,
  });
  assert.ok(result.caseMetrics.peakRssDeltaBytes >= 0);
  const descendantPid = Number(result.stdout);
  assert.ok(Number.isSafeInteger(descendantPid));
});

test("benchmark policy does not confuse verified tree termination with delayed helper close", async (t) => {
  let releaseClose: ((receipt: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
  }>) => void) | undefined;
  const closeReceipt = new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
  }>>((resolveClose) => {
    releaseClose = resolveClose;
  });
  let forcedCloseCount = 0;
  const stages: string[] = [];
  const gone = await finalizeVerifiedWindowsSupervisor({
    closeReceipt,
    allowForceClose: true,
    transcriptReceipt: () => ({
      stdinFailed: false,
      stderrBytes: 0,
      stdoutEnded: true,
      stdoutFailed: false,
      protocolFailed: false,
      queuedFrames: 0,
      partialBytes: 0,
    }),
    gracefulExitMs: 5,
    forcedExitMs: 50,
    forceClose: () => {
      forcedCloseCount += 1;
      stages.push(`stage=force-close count=${forcedCloseCount}`);
      releaseClose!({ code: null, signal: "SIGTERM", error: null });
      return true;
    },
  });
  stages.unshift("stage=tree-gone count=1");
  t.diagnostic(stages.join(" "));
  assert.equal(gone, true);
  assert.equal(forcedCloseCount, 1);
});

test("benchmark policy bounds synthetic child-tree stress and verifies every identity gone", async (t) => {
  const descendantCount = 24;
  const registeredIdentity = Object.freeze({
    pid: 7_016,
    parentPid: 7_000,
    processGroupId: 7_016,
    identity: "opaque-test-identity",
    startOrder: 16,
  });
  let identityPresent = true;
  const identitySupervisor = createRegisteredPosixProcessGroupSupervisor({
    inspectIdentity: async () => identityPresent ? registeredIdentity : undefined,
    signalGroup: (_processGroupId, signal) => {
      if (signal === "SIGTERM") identityPresent = false;
      if (signal === 0 && !identityPresent) {
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      }
    },
    delay: async () => {},
  });
  await identitySupervisor.registerRoot(registeredIdentity.pid, registeredIdentity.parentPid);
  assert.deepEqual(await identitySupervisor.terminate(), {
    gone: true,
    proof: "registered-groups-empty",
    registeredIdentityCount: 1,
    remainingIdentityCount: 0,
  });
  const fixture = join(
    REPOSITORY_ROOT,
    ".superpowers",
    "benchmarks",
    `tree-stress-${process.pid}.mjs`,
  );
  await mkdir(dirname(fixture), { recursive: true });
  t.after(() => rm(fixture, { force: true }));
  await writeFile(fixture, [
    "import { spawn } from 'node:child_process';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "readFileSync(3, 'utf8');",
    "writeFileSync(4, JSON.stringify({ elapsedMs: 25, copiedBytes: 0, dispatchStarted: false }) + '\\n');",
    `const children = Array.from({ length: ${descendantCount} }, () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));`,
    "process.stdout.write(JSON.stringify(children.map((child) => child.pid)));",
    "setTimeout(() => process.exit(9), 250);",
  ].join("\n"), "utf8");
  const result = await executeBounded(process.execPath, [fixture], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 10_000,
    env: process.env,
    controlFrame: { bounded: true },
  });
  const benchmarkModule = await import("../benchmarks/document-engine-benchmark.mjs");
  assert.equal(typeof benchmarkModule.formatBenchmarkProcessTreeProgress, "function");
  assert.equal(typeof benchmarkModule.combineBenchmarkProcessTreeIdentityCounts, "function");
  assert.deepEqual(benchmarkModule.combineBenchmarkProcessTreeIdentityCounts(
    {
      gone: true,
      proof: "registered-groups-empty",
      registeredIdentityCount: 1,
      remainingIdentityCount: 0,
    },
    {
      gone: true,
      proof: "registered-groups-empty",
      registeredIdentityCount: 2,
      remainingIdentityCount: 0,
    },
    2,
  ), { registeredIdentityCount: 3, remainingIdentityCount: 0 });
  assert.deepEqual(benchmarkModule.combineBenchmarkProcessTreeIdentityCounts(
    {
      gone: true,
      proof: "registered-groups-empty",
      registeredIdentityCount: 1,
      remainingIdentityCount: 0,
    },
    { gone: true, proof: "registered-groups-empty" },
    0,
  ), { registeredIdentityCount: 1, remainingIdentityCount: 0 });
  assert.deepEqual(benchmarkModule.combineBenchmarkProcessTreeIdentityCounts(
    {
      gone: true,
      proof: "registered-groups-empty",
      registeredIdentityCount: 1,
      remainingIdentityCount: 0,
    },
    { gone: true, proof: "registered-groups-empty" },
    2,
  ), { registeredIdentityCount: null, remainingIdentityCount: null });
  assert.deepEqual(benchmarkModule.combineBenchmarkProcessTreeIdentityCounts(
    {
      gone: false,
      proof: "unverified",
      reason: "deadline",
      registeredIdentityCount: 1,
      remainingIdentityCount: 1,
    },
    {
      gone: false,
      proof: "unverified",
      reason: "deadline",
      registeredIdentityCount: 2,
      remainingIdentityCount: 1,
    },
    2,
  ), { registeredIdentityCount: 3, remainingIdentityCount: 2 });
  const processTreeProgress = benchmarkModule.formatBenchmarkProcessTreeProgress({
    diagnosticStage: result.diagnosticStage,
    rootCleanup: result.rootCleanup,
    processGroupCleanup: result.processGroupCleanup,
    registeredIdentityCount: result.registeredIdentityCount,
    remainingIdentityCount: result.remainingIdentityCount,
  });
  t.diagnostic(processTreeProgress);
  assert.equal(
    processTreeProgress,
    `BENCHMARK_PROCESS_TREE diagnosticStage=finalizer rootCleanup=gone processGroupCleanup=gone registeredIdentityCount=${process.platform === "win32" ? "unavailable" : "1"} remainingIdentityCount=${process.platform === "win32" ? "unavailable" : "0"}`,
  );
  assert.throws(() => benchmarkModule.formatBenchmarkProcessTreeProgress({
    diagnosticStage: result.diagnosticStage,
    rootCleanup: result.rootCleanup,
    processGroupCleanup: result.processGroupCleanup,
    registeredIdentityCount: result.registeredIdentityCount,
    remainingIdentityCount: result.remainingIdentityCount,
    privatePath: "/fixture/opaque/document.hwpx",
  }), { code: "BENCHMARK_RECEIPT_INVALID" });
  assert.throws(() => benchmarkModule.formatBenchmarkProcessTreeProgress({
    diagnosticStage: result.diagnosticStage,
    rootCleanup: result.rootCleanup,
    processGroupCleanup: result.processGroupCleanup,
    registeredIdentityCount: 33,
    remainingIdentityCount: 0,
  }), { code: "BENCHMARK_RECEIPT_INVALID" });
  const pids = JSON.parse(result.stdout) as number[];
  assert.equal(result.processGone, true);
  assert.equal(result.diagnosticStage, "finalizer");
  assert.equal(result.rootCleanup, "gone");
  assert.equal(result.processGroupCleanup, "gone");
  assert.equal(
    result.registeredIdentityCount,
    process.platform === "win32" ? null : 1,
  );
  assert.equal(
    result.remainingIdentityCount,
    process.platform === "win32" ? null : 0,
  );
  assert.notEqual(result.caseMetrics, null);
  assert.equal(result.status, "failed");
  assert.equal(pids.length, descendantCount);
  assert.equal(new Set(pids).size, descendantCount);
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid));
  }
  t.diagnostic(
    `stage=spawned count=${pids.length} stage=registered-group-empty count=1`,
  );
});

test("benchmark registration measures accepted-group RSS outside the case and terminates the retained group", { timeout: 20_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX benchmark registration descriptors");
    return;
  }
  const fixture = join(
    REPOSITORY_ROOT,
    ".superpowers",
    "benchmarks",
    `rss-descendant-${process.pid}.mjs`,
  );
  await mkdir(dirname(fixture), { recursive: true });
  t.after(() => rm(fixture, { force: true }));
  const startGatePath = fileURLToPath(new URL(
    "../src/workers/document-child-start-gate.ts",
    import.meta.url,
  ));
  await writeFile(fixture, [
    "import { spawn } from 'node:child_process';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "if (process.argv[2] === '--payload') {",
    "  const bytes = Buffer.alloc(80 * 1024 * 1024);",
    "  for (let offset = 0; offset < bytes.length; offset += 4096) bytes[offset] = 1;",
    "  process.stdout.write('READY\\n');",
    "  setInterval(() => {}, 1000);",
    "} else {",
    "  readFileSync(3, 'utf8');",
    "  const baseline = process.memoryUsage().rss;",
    `  const child = spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(startGatePath)}, ${JSON.stringify(fixture)}, '--payload'], { detached: true, env: { ...process.env, GPT_CODEX_HWP_REGISTRATION: '1' }, stdio: ['ignore', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe', 5, 6] });`,
    "  child.stdio[7].write('GPT_CODEX_HWP_START_V1\\n');",
    "  child.stdout.once('data', () => {",
    "    const rootRssDeltaBytes = Math.max(0, process.memoryUsage().rss - baseline);",
    "    process.stdout.write(JSON.stringify({ childPid: child.pid, rootRssDeltaBytes }));",
    "    writeFileSync(4, JSON.stringify({ elapsedMs: 1100, copiedBytes: 0, dispatchStarted: false }) + '\\n');",
    "    setTimeout(() => process.exit(9), 1100);",
    "  });",
    "}",
  ].join("\n"), "utf8");

  let attempts = 0;
  const runFixture = async () => {
    attempts += 1;
    return await executeBounded(process.execPath, [fixture], {
      cwd: PACKAGE_ROOT,
      timeoutMs: 10_000,
      env: process.env,
      controlFrame: { bounded: true },
    });
  };
  let result = await runFixture();
  if (result.processGone
    && result.status === "termination-failed"
    && result.caseMetrics === null
    && result.diagnosticStage === "posix-telemetry-sample") {
    result = await runFixture();
  }
  t.diagnostic(`stage=rss-fixture attempts=${attempts}`);

  assert.ok(attempts === 1 || attempts === 2);
  assert.equal(result.processGone, true);
  assert.equal(result.diagnosticStage, "finalizer");
  assert.notEqual(result.caseMetrics, null);
  assert.equal(result.status, "failed");
  const root = JSON.parse(result.stdout) as {
    childPid: number;
    rootRssDeltaBytes: number;
  };
  assert.ok(root.rootRssDeltaBytes < 16 * 1024 * 1024);
  assert.ok(result.caseMetrics.peakRssDeltaBytes > 48 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(root.childPid));
});

test("benchmark policy aborts evidence when verified termination fails", () => {
  assert.throws(() => assertCaseProcessGone({
    processGone: false,
    diagnosticStage: "error-termination",
  }), {
    code: "BENCHMARK_TERMINATION_FAILED",
    diagnosticStage: "error-termination",
  });
});

test("benchmark fallback cannot prove identity-aware termination after an unverified receipt", async () => {
  const result = await executeBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 100,
    env: process.env,
    controlFrame: { bounded: true },
    supervisorFactory: async () => ({
      terminate: async () => ({ gone: false, proof: "unverified", reason: "deadline" }),
      processTreeRss: () => ({ baselineBytes: 1, peakBytes: 2 }),
    }),
  });
  assert.equal(result.processGone, false);
  assert.equal(result.status, "termination-failed");
  assert.equal(result.caseMetrics, null);
});

test("benchmark registration proof rejects a truthy forged successful receipt object", async () => {
  const result = await executeBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 100,
    env: process.env,
    controlFrame: { bounded: true },
    supervisorFactory: async (child) => ({
      processTreeTelemetryReady: Promise.resolve(true),
      terminate: async () => {
        child.kill("SIGKILL");
        return { gone: true, proof: "tracker-empty" };
      },
      processTreeRss: () => ({ baselineBytes: 1, peakBytes: 2 }),
    }),
  });
  assert.equal(result.processGone, false);
  assert.equal(result.status, "termination-failed");
  assert.equal(result.caseMetrics, null);
});

test("benchmark registration proof rejects an extra-key receipt with the expected proof literal", async () => {
  const validCountedReceipt = Object.freeze({
    gone: true,
    proof: "registered-groups-empty",
    registeredIdentityCount: 16,
    remainingIdentityCount: 0,
  });
  assert.deepEqual(
    normalizeProcessTreeTerminationReceipt(validCountedReceipt),
    validCountedReceipt,
  );
  for (const invalid of [
    { ...validCountedReceipt, registeredIdentityCount: -1 },
    { ...validCountedReceipt, registeredIdentityCount: 17 },
    { ...validCountedReceipt, remainingIdentityCount: -1 },
    { ...validCountedReceipt, remainingIdentityCount: 17 },
    { ...validCountedReceipt, registeredIdentityCount: 1, remainingIdentityCount: 2 },
  ]) {
    assert.deepEqual(normalizeProcessTreeTerminationReceipt(invalid), {
      gone: false,
      proof: "unverified",
      reason: "termination",
    });
  }
  const expectedProof = process.platform === "win32"
    ? "windows-job-empty"
    : "registered-groups-empty";
  const result = await executeBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 100,
    env: process.env,
    controlFrame: { bounded: true },
    supervisorFactory: async (child) => ({
      processTreeTelemetryReady: Promise.resolve(true),
      registerProcessTreeTelemetryRoot: () => {},
      finishProcessTreeTelemetry: () => {},
      terminate: async () => {
        child.kill("SIGKILL");
        return { gone: true, proof: expectedProof, extra: true };
      },
      processTreeRss: () => ({ baselineBytes: 1, peakBytes: 2 }),
    }),
  });
  assert.equal(result.processGone, false);
  assert.equal(result.status, "termination-failed");
  assert.equal(result.caseMetrics, null);
});

test("benchmark registration telemetry gate writes fd3 only after exact bounded true readiness", { timeout: 15_000 }, async (t) => {
  const rejectedReadiness = Promise.reject(new Error("injected readiness failure"));
  void rejectedReadiness.catch(() => {});
  const stalledReadiness = new Promise<boolean>(() => {});
  const readinessCases: ReadonlyArray<readonly [
    string,
    Promise<boolean> | undefined,
    boolean,
  ]> = [
    ["true", Promise.resolve(true), true],
    ["false", Promise.resolve(false), false],
    ["missing", undefined, false],
    ["rejected", rejectedReadiness, false],
    ["never-settling", stalledReadiness, false],
  ];
  const caseScript = [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const control = readFileSync(3);",
    "if (control.length > 0) process.stdout.write('FD3_CONTROL_RECEIVED');",
    "writeFileSync(4, JSON.stringify({ elapsedMs: 25, copiedBytes: 0, dispatchStarted: false }) + '\\n');",
  ].join("");

  for (const [label, readiness, expectControl] of readinessCases) {
    await t.test(label, async () => {
      let terminateCalls = 0;
      let telemetryFlushReceipts = 0;
      const result = await executeBounded(process.execPath, ["-e", caseScript], {
        cwd: PACKAGE_ROOT,
        timeoutMs: 300,
        env: process.env,
        controlFrame: { bounded: true },
        supervisorFactory: async (child) => ({
          ...(readiness === undefined ? {} : { processTreeTelemetryReady: readiness }),
          registerProcessTreeTelemetryRoot: () => {},
          finishProcessTreeTelemetry: () => {},
          flushProcessTreeTelemetry: async () => {
            telemetryFlushReceipts += 1;
            return true;
          },
          terminate: async () => {
            terminateCalls += 1;
            child.kill("SIGKILL");
            return process.platform === "win32"
              ? { gone: true, proof: "windows-job-empty" }
              : { gone: true, proof: "registered-groups-empty" };
          },
          processTreeRss: () => ({ baselineBytes: 1, peakBytes: 2 }),
        }),
      });
      assert.equal(result.stdout.includes("FD3_CONTROL_RECEIVED"), expectControl, label);
      assert.equal(terminateCalls, 1, label);
      assert.equal(result.processGone, true, label);
      assert.equal(
        telemetryFlushReceipts,
        process.platform === "win32" ? 0 : 1,
        `${label}: telemetry-flush-receipt`,
      );
      if (expectControl) {
        assert.equal(result.status, "passed", label);
      } else {
        assert.equal(result.status, "termination-failed", label);
        assert.equal(result.caseMetrics, null, label);
      }
    });
  }
});

test("benchmark shutdown finalizes telemetry only after exact root authority", async () => {
  const events: string[] = [];
  const caseScript = [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "readFileSync(3);",
    "writeFileSync(4, JSON.stringify({ elapsedMs: 25, copiedBytes: 0, dispatchStarted: false }) + '\\n');",
  ].join("");
  const result = await executeBounded(process.execPath, ["-e", caseScript], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 1_000,
    env: process.env,
    controlFrame: { bounded: true },
    supervisorFactory: async () => ({
      processTreeTelemetryReady: Promise.resolve(true),
      registerProcessTreeTelemetryRoot: () => { events.push("telemetry-root"); },
      terminate: async () => {
        events.push("root-authority");
        return process.platform === "win32"
          ? { gone: true, proof: "windows-job-empty" }
          : { gone: true, proof: "registered-groups-empty" };
      },
      finishProcessTreeTelemetry: () => { events.push("telemetry-finalizer"); },
      flushProcessTreeTelemetry: async () => {
        events.push("telemetry-flush-receipt");
        return true;
      },
      processTreeRss: () => {
        events.push("rss-read");
        return { baselineBytes: 1, peakBytes: 2 };
      },
    }),
  });

  assert.equal(result.processGone, true);
  assert.equal(result.status, "passed");
  assert.deepEqual(events, process.platform === "win32"
    ? ["root-authority", "telemetry-finalizer", "rss-read"]
    : [
        "root-authority",
        "telemetry-flush-receipt",
        "telemetry-finalizer",
        "rss-read",
      ]);
});

test("macOS arm64 worker initializes the built document compute backend", {
  skip: process.platform !== "darwin" || process.arch !== "arm64"
    ? "macOS arm64 worker diagnostic"
    : false,
  timeout: 30_000,
}, async () => {
  const backendUrl = new URL(
    "../dist/workers/document-compute-backend.js",
    import.meta.url,
  ).href;
  const worker = new Worker(MACOS_BACKEND_PROBE, {
    workerData: { backendUrl },
    stdout: true,
    stderr: true,
  });
  const outcome = await new Promise<
    "BACKEND_READY" | "worker-error" | "worker-exit" | "backend-import" | "backend-init"
  >((resolveOutcome) => {
    let settled = false;
    const settle = (value: "BACKEND_READY" | "worker-error" | "worker-exit" |
      "backend-import" | "backend-init"): void => {
      if (settled) return;
      settled = true;
      resolveOutcome(value);
    };
    worker.once("message", (value: unknown) => {
      settle(value === "BACKEND_READY" || value === "backend-import" || value === "backend-init"
        ? value
        : "worker-error");
    });
    worker.once("error", () => settle("worker-error"));
    worker.once("exit", () => settle("worker-exit"));
  });
  await worker.terminate();
  assert.equal(outcome, "BACKEND_READY");
});

test("macOS arm64 normal HWPX becomes READY before the real worker result", {
  skip: process.platform !== "darwin" || process.arch !== "arm64"
    ? "macOS arm64 worker diagnostic"
    : false,
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-macos-worker-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "normal-probe.hwpx");
  await generatePaddedHwpx({ outputPath: sourcePath, requestedBytes: 128 * 1024 });
  const source = await readFile(sourcePath);
  const documentBuffer = source.buffer.slice(
    source.byteOffset,
    source.byteOffset + source.byteLength,
  );
  const events: string[] = [];
  const client = createDocumentWorkerClient({
    workerFactory: (options) => {
      const worker = new Worker(
        join(PACKAGE_ROOT, "dist", "workers", "document-worker.js"),
        options,
      );
      worker.on("message", (value: unknown) => {
        if (typeof value !== "object" || value === null || !("type" in value)) return;
        const type = (value as { type?: unknown }).type;
        if (type === "ready" || type === "result" || type === "failure") events.push(type);
      });
      return worker;
    },
  });
  const result = await client.run(
    { protocolVersion: 1, requestId: "macos-normal-probe", operation: "parse", input: {}, options: {} },
    {
      transport: "worker",
      metadata: {
        sizeBytes: documentBuffer.byteLength,
        sha256: "0".repeat(64),
        shallowFormat: { candidate: "hwpx", container: "zip", exact: true },
        protection: { status: "clear", candidateFormat: "hwpx", exact: true },
      },
      takeTransferable: () => documentBuffer,
      async verifySourceUnchanged() {},
      async cleanup() {},
    },
    { deadlineMs: 30_000 },
  );
  assert.equal(typeof result.markdown, "string");
  assert.deepEqual(events.filter((event) => event === "ready" || event === "result"), [
    "ready",
    "result",
  ]);
});

test("benchmark source wires one reusable facade and ordered nested shutdown", async () => {
  const source = await readFile(BENCHMARK_ENTRY, "utf8");
  assert.match(source, /facade = await createCaseFacade\(\)/u);
  assert.match(source, /await runNormalProbe\(ownedCase, facade\)/u);
  assert.match(source, /benchmarkRegistrationDescriptors: \{ writeFd: 5, ackFd: 6 \}/u);
  assert.match(source, /process\.platform === "win32"\s*\? \{\}\s*: \{ benchmarkRegistrationDescriptors/u);
  const beginClosing = source.indexOf("await coordinator?.beginClosing()");
  const rootAuthority = source.indexOf("rootReceipt = await terminateAuthority");
  const seal = source.indexOf("await coordinator.seal()", rootAuthority);
  const nestedAuthority = source.indexOf("await coordinator.terminateRegisteredGroups()", seal);
  const finalizer = source.indexOf("supervisor.finishProcessTreeTelemetry?.()", nestedAuthority);
  assert.ok(beginClosing >= 0);
  assert.ok(beginClosing < rootAuthority);
  assert.ok(rootAuthority < seal);
  assert.ok(seal < nestedAuthority);
  assert.ok(nestedAuthority < finalizer);
});

test("benchmark policy requires a non-aliased output beneath a Git-ignored directory", async (t) => {
  const ignored = join(REPOSITORY_ROOT, ".superpowers", "benchmarks", "policy.json");
  await assert.doesNotReject(assertIgnoredBenchmarkOutput(ignored));

  for (const rejected of [
    join(REPOSITORY_ROOT, "benchmark.json"),
    join(REPOSITORY_ROOT, "packages", "gpt-codex-hwp", "benchmark.json"),
    join(REPOSITORY_ROOT, "packages", "gpt-codex-hwp", "src", "benchmark.json"),
    join(REPOSITORY_ROOT, "packages", "gpt-codex-hwp", "dist", "benchmark.json"),
    join(REPOSITORY_ROOT, "plugins", "benchmark.json"),
    join(REPOSITORY_ROOT, "unignored-benchmark-policy", "receipt.key"),
  ]) {
    await assert.rejects(assertIgnoredBenchmarkOutput(rejected), {
      code: "BENCHMARK_OUTPUT_UNSAFE",
    });
  }

  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-benchmark-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = join(root, "alias");
  const target = join(REPOSITORY_ROOT, ".superpowers", "benchmarks");
  await mkdir(target, { recursive: true });
  try {
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(target, alias, process.platform === "win32" ? "junction" : "dir"));
  } catch (error) {
    t.skip(`path aliases unavailable: ${error instanceof Error ? error.name : "unknown"}`);
    return;
  }
  await assert.rejects(assertIgnoredBenchmarkOutput(join(alias, "receipt.json")), {
    code: "BENCHMARK_OUTPUT_UNSAFE",
  });
});

test("benchmark policy gives the parent an owned case directory and bounded cleanup", async () => {
  const outputParent = join(REPOSITORY_ROOT, ".superpowers", "benchmarks");
  await mkdir(outputParent, { recursive: true });
  const ownedCase = await createOwnedBenchmarkCase(outputParent);
  await writeFile(join(ownedCase.path, "owned.bin"), "owned", "utf8");
  await cleanupOwnedBenchmarkCase(ownedCase);
  await assert.rejects(stat(ownedCase.path), { code: "ENOENT" });
});

test("benchmark policy streams a valid exact bounded HWPX with unreferenced stored padding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-benchmark-generate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "sample.hwpx");
  const requestedBytes = 10 * 1024 * 1024;
  const result = await generatePaddedHwpx({ outputPath, requestedBytes });
  const status = await stat(outputPath);
  assert.equal(status.size, result.actualBytes);
  assert.ok(status.size <= requestedBytes);
  assert.ok(requestedBytes - status.size <= 4096);
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);

  const archive = await JSZip.loadAsync(await readFile(outputPath));
  assert.equal(await archive.file("mimetype")?.async("string"), "application/hwp+zip");
  assert.ok(archive.file("Contents/section0.xml"));
  assert.ok(archive.file("benchmark/pad.bin"));
  const padData = (archive.file("benchmark/pad.bin") as unknown as {
    _data: { compressedSize: number; uncompressedSize: number };
  })._data;
  assert.equal(padData.compressedSize, padData.uncompressedSize);
  const manifest = await archive.file("Contents/content.hpf")?.async("string");
  assert.doesNotMatch(manifest ?? "", /benchmark\/pad\.bin/u);
});

test("benchmark policy bounds every deterministic padding entry", () => {
  const maximumEntryBytes = 128 * 1024 * 1024;
  const plan = paddingEntryPlan(512 * 1024 * 1024 - 64 * 1024);
  assert.equal(plan[0]?.name, "benchmark/pad.bin");
  assert.equal(plan.reduce((total, entry) => total + entry.bytes, 0), 512 * 1024 * 1024 - 64 * 1024);
  assert.ok(plan.every((entry) => entry.bytes > 0 && entry.bytes <= maximumEntryBytes));
  assert.equal(new Set(plan.map((entry) => entry.name)).size, plan.length);
});

test("benchmark policy validates privacy-safe exact-schema receipts", () => {
  const receipt = {
    schemaVersion: BENCHMARK_RECEIPT_SCHEMA_VERSION,
    platform: "win32",
    arch: "x64",
    runtime: "node-v22.17.0",
    requestedMiB: 10,
    actualBytes: 10 * 1024 * 1024 - 32,
    operation: "detectFormat",
    executionMode: "transferable-worker",
    status: "passed",
    dispatchStarted: true,
    elapsedMs: 125,
    peakRssDeltaBytes: 4096,
    copiedBytes: 10 * 1024 * 1024 - 32,
    responseBytes: 512,
    errorCode: null,
    sourceSha256: "a".repeat(64),
    outputSha256: null,
  };
  assert.deepEqual(validateBenchmarkReceipt(receipt), receipt);
  for (const unsafe of [
    {
      ...receipt,
      sourcePath: ["C:", "\\", "Users", "\\alice\\sample.hwpx"].join(""),
    },
    { ...receipt, error: "raw parser error" },
    { ...receipt, status: "failed", errorCode: "ENOENT: C:\\private" },
    { ...receipt, actualBytes: 0 },
    { ...receipt, executionMode: "supervised-child" },
    { ...receipt, copiedBytes: 0 },
    { ...receipt, copiedBytes: receipt.actualBytes * 2 },
    { ...receipt, outputSha256: "c".repeat(64) },
  ]) {
    assert.throws(() => validateBenchmarkReceipt(unsafe), {
      code: "BENCHMARK_RECEIPT_INVALID",
    });
  }
  assert.doesNotThrow(() => validateBenchmarkReceipt({
    ...receipt,
    requestedMiB: 100,
    actualBytes: 100 * 1024 * 1024 - 32,
    executionMode: "supervised-child",
    status: "resource-refused",
    dispatchStarted: false,
    copiedBytes: 0,
    responseBytes: 0,
    errorCode: "ENGINE_OOM",
  }));

  const failed = buildParentFailureReceipt(100, "ENGINE_TIMEOUT", {
    actualBytes: 100 * 1024 * 1024 - 32,
    sourceSha256: "d".repeat(64),
  }, {
    elapsedMs: 60_123,
    peakRssDeltaBytes: 8192,
    copiedBytes: 17,
    dispatchStarted: true,
  });
  assert.equal(failed.elapsedMs, 60_123);
  assert.equal(failed.peakRssDeltaBytes, 8192);
  assert.equal(failed.copiedBytes, 17);
  assert.equal(failed.dispatchStarted, true);
  assert.throws(() => buildParentFailureReceipt(100, "ENGINE_CRASH", {
    actualBytes: 0,
    sourceSha256: null,
  }, null), { code: "BENCHMARK_TELEMETRY_UNAVAILABLE" });

  assert.doesNotThrow(() => validateBenchmarkReceipt({
    ...receipt,
    status: "failed",
    copiedBytes: 17,
    responseBytes: 0,
    errorCode: "ENGINE_CRASH",
  }));
});

test("benchmark implementation digest covers build config, asset copy, and vendored Kordoc", async () => {
  const inputs = benchmarkImplementationInputPaths();
  const required = [
    join(PACKAGE_ROOT, "tsconfig.json"),
    join(PACKAGE_ROOT, "scripts", "copy-build-assets.mjs"),
    join(PACKAGE_ROOT, "vendor", "kordoc-core"),
  ];
  for (const path of required) assert.equal(inputs.includes(path), true);

  const baseline = await benchmarkImplementationSha256();
  const changedPaths = [
    required[0],
    required[1],
    join(required[2], "PROVENANCE.json"),
    join(PACKAGE_ROOT, "src", "workers", "document-child-client.ts"),
    join(PACKAGE_ROOT, "src", "workers", "windows-job-supervisor.ps1"),
  ];
  for (const changedPath of changedPaths) {
    const changed = await benchmarkImplementationSha256({
      readInput: async (path: string) => {
        const bytes = await readFile(path);
        return path === changedPath ? Buffer.concat([bytes, Buffer.from("changed")]) : bytes;
      },
    });
    assert.notEqual(changed, baseline);
  }
});

test("release evidence requires exactly one fresh passed 100 MiB receipt", async (t) => {
  const root = join(REPOSITORY_ROOT, ".superpowers", "benchmarks");
  await mkdir(root, { recursive: true });
  const evidencePath = join(root, `policy-supported-100-${process.pid}.json`);
  const missingPath = join(root, `policy-supported-100-missing-${process.pid}.json`);
  t.after(() => rm(evidencePath, { force: true }));
  const now = Date.now();
  const implementationSha256 = await benchmarkImplementationSha256();
  const receipt = (
    requestedMiB: number,
    status: "passed" | "resource-refused" | "failed" = "passed",
  ) => ({
    schemaVersion: BENCHMARK_RECEIPT_SCHEMA_VERSION,
    platform: "win32",
    arch: "x64",
    runtime: "node-v22.17.0",
    requestedMiB,
    actualBytes: requestedMiB * 1024 * 1024 - 32,
    operation: "detectFormat",
    executionMode: requestedMiB === 10 ? "transferable-worker" : "supervised-child",
    status,
    dispatchStarted: status === "passed",
    elapsedMs: 125,
    peakRssDeltaBytes: 4096,
    copiedBytes: status === "passed" ? requestedMiB * 1024 * 1024 - 32 : 0,
    responseBytes: status === "passed" ? 128 : 0,
    errorCode: status === "passed"
      ? null
      : status === "resource-refused" ? "ENGINE_RESOURCE_LIMIT" : "ENGINE_CRASH",
    sourceSha256: "b".repeat(64),
    outputSha256: null,
  });
  const evidence = (receipts: ReturnType<typeof receipt>[], overrides = {}) => ({
    schemaVersion: BENCHMARK_RECEIPT_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    concurrency: 1,
    implementationSha256,
    receipts,
    ...overrides,
  });
  const writeEvidence = async (value: ReturnType<typeof evidence> | string) => {
    await writeFile(
      evidencePath,
      typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
      "utf8",
    );
  };

  await writeEvidence(evidence([receipt(100)]));
  assert.deepEqual(
    (await validateLargeBenchmarkEvidence(evidencePath, { now, maxAgeMs: 60_000 }))
      .receipts.map((entry: { requestedMiB: number }) => entry.requestedMiB),
    [100],
  );

  await assert.rejects(
    validateLargeBenchmarkEvidence(missingPath, { now, maxAgeMs: 60_000 }),
    { code: "BENCHMARK_EVIDENCE_INVALID" },
  );
  for (const invalid of [
    "",
    evidence([]),
    evidence([receipt(100), receipt(100)]),
    evidence([receipt(10), receipt(100)]),
    evidence([receipt(256)]),
    evidence([receipt(512)]),
    evidence([receipt(100), receipt(256)]),
    evidence([receipt(100), receipt(512)]),
    evidence([receipt(100, "resource-refused")]),
    evidence([receipt(100, "failed")]),
    evidence([receipt(100)], { implementationSha256: "0".repeat(64) }),
    evidence([receipt(100)], { generatedAt: new Date(now + 1).toISOString() }),
    evidence([receipt(100)], { generatedAt: new Date(now - 60_001).toISOString() }),
  ]) {
    await writeEvidence(invalid);
    await assert.rejects(
      validateLargeBenchmarkEvidence(evidencePath, { now, maxAgeMs: 60_000 }),
      { code: "BENCHMARK_EVIDENCE_INVALID" },
    );
  }

  await writeEvidence(evidence([receipt(100)]));
  await assert.rejects(
    validateLargeBenchmarkEvidence(evidencePath, { now: now + 60_001, maxAgeMs: 60_000 }),
    { code: "BENCHMARK_EVIDENCE_INVALID" },
  );
});

test("experimental 256 and 512 MiB receipts remain schema-valid diagnostics", () => {
  const receipt = (requestedMiB: 256 | 512, status: "resource-refused" | "failed") => ({
    schemaVersion: BENCHMARK_RECEIPT_SCHEMA_VERSION,
    platform: "linux",
    arch: "x64",
    runtime: "node-v22.17.0",
    requestedMiB,
    actualBytes: requestedMiB * 1024 * 1024 - 32,
    operation: "detectFormat",
    executionMode: "supervised-child",
    status,
    dispatchStarted: false,
    elapsedMs: 125,
    peakRssDeltaBytes: 4096,
    copiedBytes: 0,
    responseBytes: 0,
    errorCode: status === "resource-refused" ? "ENGINE_RESOURCE_LIMIT" : "ENGINE_CRASH",
    sourceSha256: "b".repeat(64),
    outputSha256: null,
  });
  assert.equal(validateBenchmarkReceipt(receipt(256, "resource-refused")).requestedMiB, 256);
  assert.equal(validateBenchmarkReceipt(receipt(512, "failed")).requestedMiB, 512);
});

test("benchmark policy makes bounded document evidence a default release stage", () => {
  assert.equal(REQUIRED_RELEASE_STAGES.includes("document-benchmark"), true);
});

test("benchmark policy emits path-free per-case progress", () => {
  assert.equal(
    formatBenchmarkProgress({
      requestedMiB: 512,
      status: "resource-refused",
      errorCode: "ENGINE_RESOURCE_LIMIT",
    }),
    "BENCHMARK_CASE requestedMiB=512 status=resource-refused errorCode=ENGINE_RESOURCE_LIMIT",
  );
  assert.equal(
    formatBenchmarkProgress({
      requestedMiB: 512,
      status: "failed",
      errorCode: "C:\\private\\document.hwpx",
    }),
    "BENCHMARK_CASE requestedMiB=512 status=failed",
  );
  assert.throws(
    () => formatBenchmarkProgress({ requestedMiB: 42, status: "passed" }),
    { code: "BENCHMARK_RECEIPT_INVALID" },
  );
});

test("benchmark probe diagnostics expose only an allowlisted engine code", () => {
  assert.equal(
    formatBenchmarkProbeFailure({ code: "ENGINE_TERMINATION_FAILED" }),
    "BENCHMARK_PROBE_FAILURE engineCode=ENGINE_TERMINATION_FAILED",
  );
  assert.equal(
    formatBenchmarkProbeFailure({ code: "C:\\private\\document.hwpx" }),
    "BENCHMARK_PROBE_FAILURE engineCode=ENGINE_CRASH",
  );
});

test("benchmark case diagnostics expose only allowlisted phases, codes, and stages", () => {
  assert.equal(
    formatBenchmarkCaseFailure(
      { code: "ENGINE_INIT_FAILED", details: { stage: "startup" } },
      "detect",
    ),
    "BENCHMARK_CASE_FAILURE phase=detect engineCode=ENGINE_INIT_FAILED stage=startup",
  );
  assert.equal(
    formatBenchmarkCaseFailure(
      {
        code: "C:\\private\\document.hwpx",
        details: { stage: `${["AWS", "_SECRET_ACCESS_KEY"].join("")}=value` },
      },
      "C:\\private",
    ),
    "BENCHMARK_CASE_FAILURE phase=unknown engineCode=ENGINE_CRASH stage=unknown",
  );
});

test("benchmark snapshot diagnostics expose only a fixed internal stage", () => {
  assert.equal(
    formatBenchmarkSnapshotFailure("spool-file-acl"),
    "BENCHMARK_SNAPSHOT_FAILURE stage=spool-file-acl",
  );
  for (const reason of [
    "process",
    "exception",
    "unprotected",
    "extra-rule",
    "missing-required",
    "invalid-rule",
    "invalid-output",
  ]) {
    assert.equal(
      formatBenchmarkSnapshotFailure(`spool-directory-verify-${reason}`),
      `BENCHMARK_SNAPSHOT_FAILURE stage=spool-directory-verify-${reason}`,
    );
    assert.equal(
      formatBenchmarkSnapshotFailure(`spool-file-verify-${reason}`),
      `BENCHMARK_SNAPSHOT_FAILURE stage=spool-file-verify-${reason}`,
    );
    assert.equal(
      formatBenchmarkSnapshotFailure(`spool-file-reacl-verify-${reason}`),
      `BENCHMARK_SNAPSHOT_FAILURE stage=spool-file-reacl-verify-${reason}`,
    );
  }
  assert.equal(
    formatBenchmarkSnapshotFailure(`C:\\private ${["AWS", "_SECRET_ACCESS_KEY=value"].join("")}`),
    "BENCHMARK_SNAPSHOT_FAILURE stage=unknown",
  );
});

test("Windows owner-only ACL application is shared and replaces rather than amends DACLs", async () => {
  const snapshotSource = await readFile(
    join(PACKAGE_ROOT, "src", "shared", "document-snapshot.ts"),
    "utf8",
  );
  const childSource = await readFile(
    join(PACKAGE_ROOT, "src", "workers", "document-child-client.ts"),
    "utf8",
  );
  for (const source of [snapshotSource, childSource]) {
    assert.match(source, /applyWindowsOwnerOnlyAcl/u);
    assert.doesNotMatch(source, /icacls\.exe/u);
  }
  assert.match(snapshotSource, /verify-process/u);
  assert.match(snapshotSource, /verify-invalid-output/u);
});
