import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import { REQUIRED_RELEASE_STAGES } from "../../../scripts/release-verify.mjs";
import { finalizeVerifiedWindowsSupervisor } from "../src/workers/document-child-client.js";
import {
  APPROVED_BENCHMARK_SIZES_MIB,
  BENCHMARK_CONCURRENCY,
  BENCHMARK_RECEIPT_SCHEMA_VERSION,
  assertIgnoredBenchmarkOutput,
  assertCaseProcessGone,
  benchmarkImplementationInputPaths,
  benchmarkImplementationSha256,
  buildParentFailureReceipt,
  cleanupOwnedBenchmarkCase,
  createOwnedBenchmarkCase,
  executeBounded,
  formatBenchmarkProgress,
  parseBenchmarkArguments,
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

test("benchmark policy accepts only bounded approved sizes with fixed sequential execution", () => {
  assert.deepEqual(APPROVED_BENCHMARK_SIZES_MIB, [10, 100, 256, 512]);
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
  assert.throws(() => validateCaseSizeMiB(11), { code: "BENCHMARK_ARGUMENTS_INVALID" });
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
    "writeFileSync(4, JSON.stringify({ elapsedMs: 25, peakRssDeltaBytes: 4096 }) + '\\n');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(child.pid));",
    "setTimeout(() => process.exit(9), 50);",
  ].join("\n"), "utf8");
  const result = await executeBounded(process.execPath, [fixture], {
    cwd: PACKAGE_ROOT,
    timeoutMs: 5_000,
    env: process.env,
    controlFrame: { bounded: true },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.processGone, true);
  assert.ok(result.elapsedMs > 0);
  assert.deepEqual(result.caseMetrics, { elapsedMs: 25, peakRssDeltaBytes: 4096 });
  const descendantPid = Number(result.stdout);
  assert.ok(Number.isSafeInteger(descendantPid));
  assert.throws(() => process.kill(descendantPid, 0));
});

test("benchmark policy does not confuse verified tree termination with delayed helper close", async (t) => {
  let releaseExit: ((code: number | null) => void) | undefined;
  const exitReceipt = new Promise<number | null>((resolveExit) => {
    releaseExit = resolveExit;
  });
  let forcedCloseCount = 0;
  const stages: string[] = [];
  const gone = await finalizeVerifiedWindowsSupervisor({
    exitReceipt,
    gracefulExitMs: 5,
    forcedExitMs: 50,
    forceClose: () => {
      forcedCloseCount += 1;
      stages.push(`stage=force-close count=${forcedCloseCount}`);
      releaseExit!(null);
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
    "writeFileSync(4, JSON.stringify({ elapsedMs: 25, peakRssDeltaBytes: 4096 }) + '\\n');",
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
  const pids = JSON.parse(result.stdout) as number[];
  assert.equal(result.status, "failed");
  assert.equal(result.processGone, true);
  assert.equal(pids.length, descendantCount);
  let goneCount = 0;
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid));
    assert.throws(() => process.kill(pid, 0));
    goneCount += 1;
  }
  t.diagnostic(
    `stage=spawned count=${pids.length} stage=identity-gone count=${goneCount}`,
  );
});

test("benchmark policy aborts evidence when verified termination fails", () => {
  assert.throws(() => assertCaseProcessGone({ processGone: false }), {
    code: "BENCHMARK_TERMINATION_FAILED",
  });
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
    { ...receipt, sourcePath: ["C:\\Us", "ers\\alice\\sample.hwpx"].join("") },
    { ...receipt, error: "raw parser error" },
    { ...receipt, status: "failed", errorCode: "ENOENT: C:\\private" },
    { ...receipt, actualBytes: 0 },
    { ...receipt, executionMode: "supervised-child" },
    { ...receipt, copiedBytes: 0 },
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
    copiedBytes: 100 * 1024 * 1024 - 32,
    responseBytes: 0,
    errorCode: "ENGINE_OOM",
  }));

  const failed = buildParentFailureReceipt(100, "ENGINE_TIMEOUT", {
    actualBytes: 100 * 1024 * 1024 - 32,
    sourceSha256: "d".repeat(64),
  }, { elapsedMs: 60_123, peakRssDeltaBytes: 8192 });
  assert.equal(failed.elapsedMs, 60_123);
  assert.equal(failed.peakRssDeltaBytes, 8192);
  assert.throws(() => buildParentFailureReceipt(100, "ENGINE_CRASH", {
    actualBytes: 0,
    sourceSha256: null,
  }, null), { code: "BENCHMARK_TELEMETRY_UNAVAILABLE" });
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

test("benchmark policy requires fresh exact sequential large evidence", async (t) => {
  const root = join(REPOSITORY_ROOT, ".superpowers", "benchmarks");
  await mkdir(root, { recursive: true });
  const evidencePath = join(root, `policy-large-${process.pid}.json`);
  t.after(() => rm(evidencePath, { force: true }));
  const now = Date.now();
  const implementationSha256 = await benchmarkImplementationSha256();
  const receipt = (requestedMiB: number) => ({
    schemaVersion: BENCHMARK_RECEIPT_SCHEMA_VERSION,
    platform: "win32",
    arch: "x64",
    runtime: "node-v22.17.0",
    requestedMiB,
    actualBytes: requestedMiB * 1024 * 1024 - 32,
    operation: "detectFormat",
    executionMode: "supervised-child",
    status: "resource-refused",
    elapsedMs: 125,
    peakRssDeltaBytes: 4096,
    copiedBytes: requestedMiB * 1024 * 1024 - 32,
    responseBytes: 0,
    errorCode: "ENGINE_RESOURCE_LIMIT",
    sourceSha256: "b".repeat(64),
    outputSha256: null,
  });
  await writeFile(evidencePath, `${JSON.stringify({
    schemaVersion: BENCHMARK_RECEIPT_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    concurrency: 1,
    implementationSha256,
    receipts: [receipt(100), receipt(256), receipt(512)],
  })}\n`, "utf8");
  assert.deepEqual(
    (await validateLargeBenchmarkEvidence(evidencePath, { now, maxAgeMs: 60_000 }))
      .receipts.map((entry: { requestedMiB: number }) => entry.requestedMiB),
    [100, 256, 512],
  );
  await assert.rejects(
    validateLargeBenchmarkEvidence(evidencePath, { now: now + 60_001, maxAgeMs: 60_000 }),
    { code: "BENCHMARK_EVIDENCE_INVALID" },
  );

  const staleImplementation = JSON.parse(await readFile(evidencePath, "utf8"));
  staleImplementation.implementationSha256 = "0".repeat(64);
  await writeFile(evidencePath, `${JSON.stringify(staleImplementation)}\n`, "utf8");
  await assert.rejects(
    validateLargeBenchmarkEvidence(evidencePath, { now, maxAgeMs: 60_000 }),
    { code: "BENCHMARK_EVIDENCE_INVALID" },
  );
  staleImplementation.implementationSha256 = implementationSha256;
  await writeFile(evidencePath, `${JSON.stringify(staleImplementation)}\n`, "utf8");

  const mixedHost = JSON.parse(await readFile(evidencePath, "utf8"));
  mixedHost.receipts[1].arch = "arm64";
  await writeFile(evidencePath, `${JSON.stringify(mixedHost)}\n`, "utf8");
  await assert.rejects(
    validateLargeBenchmarkEvidence(evidencePath, { now, maxAgeMs: 60_000 }),
    { code: "BENCHMARK_EVIDENCE_INVALID" },
  );

  mixedHost.receipts[1].arch = "x64";
  mixedHost.generatedAt = [
    "Thu, 16 Jul 2026 00:00:00 GMT (C:\\Us",
    "ers\\alice)",
  ].join("");
  await writeFile(evidencePath, `${JSON.stringify(mixedHost)}\n`, "utf8");
  await assert.rejects(
    validateLargeBenchmarkEvidence(evidencePath, { now, maxAgeMs: 60_000 }),
    { code: "BENCHMARK_EVIDENCE_INVALID" },
  );
});

test("benchmark policy makes bounded document evidence a default release stage", () => {
  assert.equal(REQUIRED_RELEASE_STAGES.includes("document-benchmark"), true);
});

test("benchmark policy emits path-free per-case progress", () => {
  assert.equal(
    formatBenchmarkProgress({ requestedMiB: 512, status: "resource-refused" }),
    "BENCHMARK_CASE requestedMiB=512 status=resource-refused",
  );
  assert.throws(
    () => formatBenchmarkProgress({ requestedMiB: 42, status: "passed" }),
    { code: "BENCHMARK_RECEIPT_INVALID" },
  );
});
