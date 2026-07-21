import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { lstat, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { resolveHwpFixture } from "../packages/gpt-codex-hwp/release-scripts/hwp-fixture.mjs";
import { createCanonicalTemporaryDirectory } from "./canonical-temp.mjs";
import {
  noReplaceGitArguments,
  releaseSubprocessEnvironment,
} from "./release-subprocess-environment.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_MAX_OUTPUT_BYTES = 4 * 1024;
const TASKKILL_TIMEOUT_MS = 2_000;
const MAX_STAGE_COMMANDS = 4;
const RELEASE_CLEANUP_RESERVE_MS = 10_000;
const TOOL_COUNT = 9;
const executeFile = promisify(execFile);
const GIT_IDENTITY_PATTERN = /^[a-f0-9]{40}$/u;

export const REQUIRED_RELEASE_STAGES = Object.freeze([
  "metadata",
  "build",
  "node-tests",
  "python-tests",
  "real-hwp",
  "hwpx-roundtrip",
  "nine-tools",
  "kordoc-provenance",
  "production-dependencies",
  "audit",
  "public-tree",
  "public-history",
  "privacy",
  "runtime-diff",
  "document-benchmark",
  "release-artifacts",
]);

export async function runReleaseVerification(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw releaseError("RELEASE_VERIFY_OPTIONS_INVALID");
  }
  const root = requiredRoot(options.root ?? PROJECT_ROOT);
  const platform = safeIdentity(options.platform ?? process.platform, "platform");
  const arch = safeIdentity(options.arch ?? process.arch, "arch");
  const versions = options.versions === undefined
    ? await probeToolVersions(root)
    : validateVersions(options.versions);
  const fixtureResolver = options.resolveFixture ?? (() =>
    resolveHwpFixture({ requireTracked: true }));
  if (typeof fixtureResolver !== "function") {
    throw releaseError("RELEASE_VERIFY_FIXTURE_RESOLVER_INVALID");
  }
  const fixture = await fixtureResolver();
  const fixtureSha256 = fixture?.sha256;
  if (typeof fixtureSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(fixtureSha256)) {
    throw releaseError("RELEASE_VERIFY_FIXTURE_INVALID");
  }

  const collectSourceIdentity = options.collectSourceIdentity ?? collectReleaseSourceIdentity;
  if (typeof collectSourceIdentity !== "function") {
    throw releaseError("RELEASE_VERIFY_SOURCE_IDENTITY_INVALID");
  }
  const beforeIdentity = validatedSourceIdentity(await collectSourceIdentity(root));

  const now = options.now ?? Date.now;
  if (typeof now !== "function") throw releaseError("RELEASE_VERIFY_CLOCK_INVALID");
  const injectedRunner = options.runStage;
  if (injectedRunner !== undefined && typeof injectedRunner !== "function") {
    throw releaseError("RELEASE_VERIFY_RUNNER_INVALID");
  }
  const runStage = injectedRunner ?? ((stage) => runStageCommand(stage, {
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    expectedSourceIdentity: beforeIdentity,
  }));
  const diagnosticObserver = options.diagnosticObserver;
  if (diagnosticObserver !== undefined && typeof diagnosticObserver !== "function") {
    throw releaseError("RELEASE_VERIFY_DIAGNOSTIC_OBSERVER_INVALID");
  }

  const stages = [];
  for (const stage of releaseStageDefinitions(root)) {
    const started = safeNow(now);
    let outcome;
    try {
      outcome = await runStage(stage);
    } catch {
      outcome = { status: "failed" };
    }
    const elapsedMs = Math.max(0, Math.round(safeNow(now) - started));
    let status = normalizedStageStatus(outcome);
    if (stage.name === "release-artifacts" && status === "passed"
      && !sameSourceIdentity(optionalPassedSourceIdentity(outcome), beforeIdentity)) {
      status = "failed";
    }
    stages.push(Object.freeze({ name: stage.name, status, elapsedMs }));
    if (status !== "passed") {
      const diagnostic = stage.name === "document-benchmark"
        ? normalizedDocumentBenchmarkDiagnostic(outcome?.diagnostic)
        : undefined;
      if (diagnostic !== undefined && diagnosticObserver !== undefined) {
        try {
          diagnosticObserver(diagnostic);
        } catch {
          // Diagnostics are best-effort and must not affect the release decision.
        }
      }
      await observeFinalSourceIdentity(collectSourceIdentity, root);
      return releaseReceipt({
        status: "failed",
        platform,
        arch,
        versions,
        stages,
        fixtureSha256,
        sourceIdentity: null,
      });
    }
  }

  const afterIdentity = await observeFinalSourceIdentity(collectSourceIdentity, root);
  if (!sameSourceIdentity(beforeIdentity, afterIdentity)) {
    return releaseReceipt({
      status: "failed",
      platform,
      arch,
      versions,
      stages,
      fixtureSha256,
      sourceIdentity: null,
    });
  }

  return releaseReceipt({
    status: "passed",
    platform,
    arch,
    versions,
    stages,
    fixtureSha256,
    sourceIdentity: beforeIdentity,
  });
}

export async function runCli(options = {}) {
  const runVerification = options.runVerification ?? runReleaseVerification;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  try {
    const receipt = await runVerification();
    stdout.write(`${JSON.stringify(receipt)}\n`);
    setExitCode(receipt?.status === "passed" ? 0 : 1);
    return receipt;
  } catch {
    stderr.write("RELEASE_VERIFY_FAILED\n");
    setExitCode(1);
    return undefined;
  }
}

export async function runStageCommand(stage, options = {}) {
  if (stage?.kind === "release-artifacts") {
    const timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
      "timeout",
    );
    const maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "output bound",
    );
    const cwd = requiredRoot(stage.cwd);
    const env = stageEnvironment(stage.env);
    const expectedSourceIdentity = validatedSourceIdentity(
      options.expectedSourceIdentity ?? await collectReleaseSourceIdentity(cwd),
    );
    const outputBudget = { used: 0, limit: maxOutputBytes };
    const started = performance.now();
    const deadlineAt = started + timeoutMs;
    return await runReleaseArtifactsStage(stage, {
      deadlineAt,
      clock: () => performance.now(),
      expectedSourceIdentity,
      runCommand: async (logical) => {
        const remainingTimeoutMs = Math.ceil(
          deadlineAt - performance.now() - RELEASE_CLEANUP_RESERVE_MS,
        );
        if (remainingTimeoutMs <= 0) return Object.freeze({ status: "failed" });
        return await executeCommand({
          ...resolveInvocation(logical),
          cwd,
          env,
          timeoutMs: remainingTimeoutMs,
          maxOutputBytes,
          outputBudget,
          captureOutput: true,
        });
      },
    });
  }
  const invocations = resolveStageInvocations(stage);
  const evidence = validateStageEvidence(stage.evidence);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
    "timeout",
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "output bound",
  );
  const cwd = requiredRoot(stage.cwd);
  const env = stageEnvironment(stage.env);
  const outputBudget = { used: 0, limit: maxOutputBytes };
  const started = performance.now();
  let result;
  for (let index = 0; index < invocations.length; index += 1) {
    const remainingTimeoutMs = Math.ceil(timeoutMs - (performance.now() - started));
    if (remainingTimeoutMs <= 0) {
      return failedStageOutcome(stage.name, index, undefined);
    }
    result = await executeCommand({
      ...invocations[index],
      cwd,
      env,
      timeoutMs: remainingTimeoutMs,
      maxOutputBytes,
      outputBudget,
      captureOutput: stage.name === "document-benchmark"
        || (evidence !== undefined && index === invocations.length - 1),
    });
    if (result.status !== "passed") return failedStageOutcome(stage.name, index, result);
  }
  const passed = result.status === "passed"
    && (evidence === undefined || hasRequiredNodeTestSummary(result, evidence));
  return Object.freeze({ status: passed ? "passed" : "failed" });
}

function failedStageOutcome(stageName, commandIndex, result) {
  if (stageName !== "document-benchmark") return Object.freeze({ status: "failed" });
  const diagnostic = Object.freeze({
    kind: "document-benchmark",
    command: commandIndex + 1,
    receipt: selectDocumentBenchmarkFailureReceipt(result),
  });
  return Object.freeze({ status: "failed", diagnostic });
}

function selectDocumentBenchmarkFailureReceipt(result) {
  const lines = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`
    .split(/\r?\n/u)
    .map((line) => line.trim());
  const patterns = [
    /^BENCHMARK_TERMINATION_FAILED stage=[a-z0-9-]+$/u,
    /^BENCHMARK_SNAPSHOT_FAILURE stage=[a-z0-9-]+$/u,
    /^BENCHMARK_CASE_FAILURE phase=(?:facade|snapshot|detect|probe|unknown) engineCode=[A-Z_]+ stage=[a-zA-Z0-9-]+$/u,
    /^BENCHMARK_PROBE_FAILURE engineCode=[A-Z_]+$/u,
    /^BENCHMARK_CASE requestedMiB=10 status=failed(?: errorCode=[A-Z_]+)?$/u,
    /^BENCHMARK_[A-Z_]+(?: stage=[a-z0-9-]+)?$/u,
  ];
  for (const pattern of patterns) {
    const match = lines.findLast((line) => pattern.test(line));
    if (match !== undefined) return match;
  }
  return "BENCHMARK_DIAGNOSTIC_UNAVAILABLE";
}

function normalizedDocumentBenchmarkDiagnostic(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "command,kind,receipt"
    || value.kind !== "document-benchmark"
    || ![1, 2].includes(value.command)
    || typeof value.receipt !== "string"
    || !isSafeDocumentBenchmarkReceipt(value.receipt)) {
    return undefined;
  }
  return Object.freeze({
    kind: "document-benchmark",
    command: value.command,
    receipt: value.receipt,
  });
}

function isSafeDocumentBenchmarkReceipt(value) {
  return value === "BENCHMARK_DIAGNOSTIC_UNAVAILABLE"
    || /^BENCHMARK_TERMINATION_FAILED stage=[a-z0-9-]+$/u.test(value)
    || /^BENCHMARK_SNAPSHOT_FAILURE stage=[a-z0-9-]+$/u.test(value)
    || /^BENCHMARK_CASE_FAILURE phase=(?:facade|snapshot|detect|probe|unknown) engineCode=[A-Z_]+ stage=[a-zA-Z0-9-]+$/u.test(value)
    || /^BENCHMARK_PROBE_FAILURE engineCode=[A-Z_]+$/u.test(value)
    || /^BENCHMARK_CASE requestedMiB=10 status=failed(?: errorCode=[A-Z_]+)?$/u.test(value)
    || /^BENCHMARK_[A-Z_]+(?: stage=[a-z0-9-]+)?$/u.test(value);
}

export function formatDocumentBenchmarkDiagnostic(value) {
  const diagnostic = normalizedDocumentBenchmarkDiagnostic(value);
  return diagnostic === undefined
    ? undefined
    : `DOCUMENT_BENCHMARK_FIRST_FAILURE command=${diagnostic.command} ${diagnostic.receipt}`;
}

export async function runReleaseArtifactsStage(stage, options = {}) {
  if (stage === null || typeof stage !== "object" || Array.isArray(stage)
    || stage.name !== "release-artifacts" || stage.kind !== "release-artifacts"
    || Object.hasOwn(stage, "tool") || Object.hasOwn(stage, "args")
    || Object.hasOwn(stage, "commands")) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  const cwd = requiredRoot(stage.cwd);
  stageEnvironment(stage.env);
  const createTemp = options.createTemp ?? (() => createCanonicalReleaseTemp());
  const removeTemp = options.removeTemp;
  const runCommand = options.runCommand ?? ((logical) => runStageCommand({
    name: "release-artifacts-command",
    ...logical,
    cwd,
    env: stage.env,
  }));
  const clock = options.clock ?? (() => performance.now());
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  if (typeof createTemp !== "function"
    || (removeTemp !== undefined && typeof removeTemp !== "function")
    || typeof runCommand !== "function" || typeof clock !== "function"
    || (deadlineAt !== Number.POSITIVE_INFINITY && !Number.isFinite(deadlineAt))) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  let expectedSourceIdentity;
  try {
    expectedSourceIdentity = validatedSourceIdentity(
      options.expectedSourceIdentity ?? await collectReleaseSourceIdentity(cwd),
    );
  } catch {
    return failedArtifactStageOutcome();
  }
  let ownedTemp;
  let ownedIdentity;
  let status = "failed";
  try {
    ownedTemp = await createTemp();
    if (typeof ownedTemp !== "string" || ownedTemp.length === 0) {
      throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
    }
    if (removeTemp === undefined) ownedIdentity = await tempIdentity(ownedTemp);
    if (deadlineAt !== Number.POSITIVE_INFINITY && clock() >= deadlineAt) {
      throw releaseError("RELEASE_VERIFY_TIMEOUT");
    }
    const output = join(ownedTemp, "artifacts");
    const build = await runCommand({
      tool: "node",
      args: [
        "packages/gpt-codex-hwp/release-scripts/build-release-artifacts.mjs",
        "--output",
        output,
      ],
    });
    const buildReceipt = parseArtifactStageReceipt(build, "build");
    if (buildReceipt !== undefined) {
      const verify = await runCommand({
        tool: "node",
        args: [
          "scripts/verify-release-artifacts.mjs",
          "--artifacts",
          output,
          "--root",
          cwd,
        ],
      });
      const verifyReceipt = parseArtifactStageReceipt(verify, "verify");
      status = verifyReceipt !== undefined
        && matchingArtifactReceipts(buildReceipt, verifyReceipt)
        && sameSourceIdentity(buildReceipt, expectedSourceIdentity)
        && sameSourceIdentity(verifyReceipt, expectedSourceIdentity)
        ? "passed" : "failed";
    }
  } catch {
    status = "failed";
  } finally {
    if (ownedTemp !== undefined && status === "passed") {
      try {
        if (removeTemp !== undefined) {
          await removeTemp(ownedTemp);
        } else {
          await removeOwnedTemp(ownedTemp, ownedIdentity);
        }
      }
      catch { status = "failed"; }
    }
  }
  return status === "passed"
    ? passedArtifactStageOutcome(expectedSourceIdentity)
    : failedArtifactStageOutcome();
}

export async function createCanonicalReleaseTemp(parent = tmpdir()) {
  const requestedParent = requiredRoot(parent);
  try {
    return await createCanonicalTemporaryDirectory({
      parent: requestedParent,
      prefix: "gpt-codex-hwp-release-verify-",
    });
  } catch {
    throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  }
}

function parseArtifactStageReceipt(result, kind) {
  if (result?.status !== "passed" || typeof result.stdout !== "string"
    || typeof result.stderr !== "string" || result.stderr !== "") return undefined;
  const lines = result.stdout.split(/\r?\n/u);
  if (lines.at(-1) !== "") return undefined;
  lines.pop();
  if (lines.length !== 1) return undefined;
  let receipt;
  try { receipt = JSON.parse(lines[0]); } catch { return undefined; }
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.schemaVersion !== 1 || receipt.status !== "passed"
    || !/^[a-f0-9]{40}$/u.test(receipt.commit) || !/^[a-f0-9]{40}$/u.test(receipt.tree)
    || !Number.isSafeInteger(receipt.reproducibleEpoch)
    || !Number.isSafeInteger(receipt.runtimeFiles) || receipt.runtimeFiles <= 0
    || !Number.isSafeInteger(receipt.productionPackages) || receipt.productionPackages <= 0
    || !validArtifactHashes(receipt.hashes)) return undefined;
  const baseKeys = [
    "commit", "hashes", "productionPackages", "reproducibleEpoch", "runtimeFiles",
    "schemaVersion", "status", "tree",
  ];
  if (kind === "build") {
    const expectedFiles = ["SHA256SUMS", ...Object.keys(receipt.hashes)].sort();
    if (JSON.stringify(Object.keys(receipt).sort())
      !== JSON.stringify([...baseKeys, "files"].sort())
      || JSON.stringify(receipt.files) !== JSON.stringify(expectedFiles)) return undefined;
  } else if (kind === "verify") {
    if (JSON.stringify(Object.keys(receipt).sort())
      !== JSON.stringify([...baseKeys, "toolCount"].sort()) || receipt.toolCount !== 9) return undefined;
  } else return undefined;
  return receipt;
}

function validArtifactHashes(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const names = Object.keys(value).sort();
  return names.length === 3 && names.includes("provenance.json")
    && names.some((name) => /^gpt-codex-hwp-[0-9A-Za-z.+-]+\.zip$/u.test(name))
    && names.some((name) => /^gpt-codex-hwp-[0-9A-Za-z.+-]+\.spdx\.json$/u.test(name))
    && Object.values(value).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash));
}

function matchingArtifactReceipts(build, verify) {
  return build.commit === verify.commit && build.tree === verify.tree
    && build.reproducibleEpoch === verify.reproducibleEpoch
    && build.runtimeFiles === verify.runtimeFiles
    && build.productionPackages === verify.productionPackages
    && JSON.stringify(build.hashes) === JSON.stringify(verify.hashes);
}

function passedArtifactStageOutcome(sourceIdentity) {
  const identity = validatedSourceIdentity(sourceIdentity);
  return Object.freeze({ status: "passed", commit: identity.commit, tree: identity.tree });
}

function failedArtifactStageOutcome() {
  return Object.freeze({ status: "failed", commit: null, tree: null });
}

function validatedSourceIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "commit,tree"
    || typeof value.commit !== "string" || !GIT_IDENTITY_PATTERN.test(value.commit)
    || typeof value.tree !== "string" || !GIT_IDENTITY_PATTERN.test(value.tree)) {
    throw releaseError("RELEASE_VERIFY_SOURCE_IDENTITY_INVALID");
  }
  return Object.freeze({ commit: value.commit, tree: value.tree });
}

function optionalPassedSourceIdentity(value) {
  try {
    return validatedSourceIdentity({ commit: value?.commit, tree: value?.tree });
  } catch {
    return undefined;
  }
}

function sameSourceIdentity(left, right) {
  return left !== undefined && right !== undefined
    && left?.commit === right?.commit && left?.tree === right?.tree;
}

async function observeFinalSourceIdentity(collector, root) {
  try {
    return validatedSourceIdentity(await collector(root));
  } catch {
    return undefined;
  }
}

export async function collectReleaseSourceIdentity(root = PROJECT_ROOT) {
  const cwd = requiredRoot(root);
  const commit = releaseGitIdentity(await releaseGit(cwd, ["rev-parse", "--verify", "HEAD"]));
  const tree = releaseGitIdentity(await releaseGit(
    cwd,
    ["rev-parse", "--verify", `${commit}^{tree}`],
  ));
  return Object.freeze({ commit, tree });
}

async function releaseGit(root, args) {
  try {
    const result = await executeFile("git", noReplaceGitArguments(args), {
      cwd: root,
      encoding: "utf8",
      env: releaseSubprocessEnvironment(),
      maxBuffer: 4 * 1024,
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.stderr !== "") throw releaseError("RELEASE_VERIFY_GIT_INVALID");
    return result.stdout;
  } catch {
    throw releaseError("RELEASE_VERIFY_GIT_INVALID");
  }
}

function releaseGitIdentity(value) {
  const lines = String(value).split(/\r?\n/u);
  if (lines.at(-1) !== "") throw releaseError("RELEASE_VERIFY_GIT_INVALID");
  lines.pop();
  if (lines.length !== 1 || !GIT_IDENTITY_PATTERN.test(lines[0])) {
    throw releaseError("RELEASE_VERIFY_GIT_INVALID");
  }
  return lines[0];
}

async function tempIdentity(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  return Object.freeze({ dev: info.dev, ino: info.ino, canonical: await realpath(path) });
}

async function removeOwnedTemp(path, identity, hooks = {}) {
  if (identity === undefined) throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)
    || (hooks.afterQuarantine !== undefined && typeof hooks.afterQuarantine !== "function")) {
    throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== identity.dev
    || info.ino !== identity.ino || !samePath(await realpath(path), identity.canonical)) {
    throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  }
  const tree = await snapshotOwnedTemp(path);
  const quarantine = join(dirname(path), `.gpt-codex-hwp-release-quarantine-${randomUUID()}`);
  await rename(path, quarantine);
  await hooks.afterQuarantine?.(quarantine);
  const canonicalQuarantine = join(dirname(identity.canonical), basename(quarantine));
  await assertOwnedTempDirectory(quarantine, identity, canonicalQuarantine);
  const rootEntries = await readdir(quarantine);
  const expectedRootEntries = tree.artifacts === undefined ? [] : ["artifacts"];
  if (JSON.stringify(rootEntries.sort()) !== JSON.stringify(expectedRootEntries)) {
    throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  }
  if (tree.artifacts !== undefined) {
    await removeOwnedArtifactDirectory(
      join(quarantine, "artifacts"),
      tree.artifacts,
      join(canonicalQuarantine, "artifacts"),
    );
  }
  await assertOwnedTempDirectory(quarantine, identity, canonicalQuarantine);
  if ((await readdir(quarantine)).length !== 0) throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  await rmdir(quarantine);
}

async function assertOwnedTempDirectory(path, identity, expectedCanonical = identity.canonical) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== identity.dev
    || info.ino !== identity.ino || !samePath(await realpath(path), expectedCanonical)) {
    throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  }
}

async function snapshotOwnedTemp(path) {
  const rootEntries = await readdir(path);
  if (rootEntries.length > 1 || (rootEntries.length === 1 && rootEntries[0] !== "artifacts")) {
    throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  }
  return Object.freeze({
    artifacts: rootEntries.length === 0
      ? undefined
      : await snapshotOwnedArtifactDirectory(join(path, "artifacts")),
  });
}

async function snapshotOwnedArtifactDirectory(path) {
  const identity = await tempIdentity(path);
  const entries = await readdir(path);
  if (entries.length > 4 || entries.some((name) => !isReleaseArtifactName(name))) {
    throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  }
  const files = [];
  for (const name of entries) {
    const file = join(path, name);
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
    files.push(Object.freeze({ name, dev: info.dev, ino: info.ino, size: info.size }));
  }
  return Object.freeze({ identity, files: Object.freeze(files) });
}

async function removeOwnedArtifactDirectory(path, snapshot, expectedCanonical) {
  await assertOwnedTempDirectory(path, snapshot.identity, expectedCanonical);
  const entries = (await readdir(path)).sort();
  const expected = snapshot.files.map(({ name }) => name).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  }
  for (const record of snapshot.files) {
    await assertOwnedTempDirectory(path, snapshot.identity, expectedCanonical);
    const file = join(path, record.name);
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.dev !== record.dev
      || info.ino !== record.ino || info.size !== record.size) {
      throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
    }
    await unlink(file);
  }
  await assertOwnedTempDirectory(path, snapshot.identity, expectedCanonical);
  if ((await readdir(path)).length !== 0) throw releaseError("RELEASE_VERIFY_TEMP_INVALID");
  await rmdir(path);
}

function isReleaseArtifactName(name) {
  return name === "SHA256SUMS" || name === "provenance.json"
    || /^gpt-codex-hwp-[0-9A-Za-z.+-]+\.(?:zip|spdx\.json)$/u.test(name);
}

function samePath(left, right) {
  const normalizedLeft = resolve(left).replace(/[\\/]+$/u, "");
  const normalizedRight = resolve(right).replace(/[\\/]+$/u, "");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export async function removeOwnedTempForTest(path, identity, hooks) {
  return await removeOwnedTemp(path, identity, hooks);
}

async function withinDeadline(promise, deadlineAt, clock) {
  if (deadlineAt === Number.POSITIVE_INFINITY) return await promise;
  const remaining = Math.ceil(deadlineAt - clock());
  if (remaining <= 0) throw releaseError("RELEASE_VERIFY_TIMEOUT");
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(releaseError("RELEASE_VERIFY_TIMEOUT")), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function releaseStageDefinitions(root) {
  const requiredRhwp = Object.freeze({ HWP_REQUIRE_RHWP: "1" });
  const none = Object.freeze({});
  const realHwpEvidence = nodeTestEvidence(
    "real external HWP preview leaves the read-only sample unchanged",
  );
  const hwpxRoundtripEvidence = nodeTestEvidence(
    "hwp_generate_hwpx creates a valid, readable document and forced-reflow SVG preview",
  );
  const stages = [
    npmStage("metadata", ["run", "check:metadata"], root, none),
    compositeStage("build", [
      fixedCommand("npm", [
        "ci",
        "--prefix",
        "packages/gpt-codex-hwp",
        "--ignore-scripts",
      ]),
      fixedCommand("npm", ["run", "build"]),
    ], root, none),
    npmStage("node-tests", ["test"], root, requiredRhwp),
    npmStage("python-tests", ["run", "test:python"], root, none),
    npmStage("real-hwp", [
      "--prefix",
      "packages/gpt-codex-hwp",
      "run",
      "test:focused",
      "--",
      "--test-reporter=tap",
      "--test-name-pattern=real external HWP",
      "tests/rhwp-backend.test.ts",
    ], root, requiredRhwp, realHwpEvidence),
    npmStage("hwpx-roundtrip", [
      "--prefix",
      "packages/gpt-codex-hwp",
      "run",
      "test:focused",
      "--",
      "--test-reporter=tap",
      "--test-name-pattern=hwp_generate_hwpx creates a valid, readable document and forced-reflow SVG preview",
      "tests/hwp-plugin.test.ts",
    ], root, none, hwpxRoundtripEvidence),
    npmStage("nine-tools", ["run", "verify:compact-runtime"], root, none),
    nodeStage("kordoc-provenance", [
      "scripts/kordoc-core-runtime.mjs",
      "verify",
      "packages/gpt-codex-hwp/vendor/kordoc-core",
    ], root, none),
    compositeStage("production-dependencies", [
      fixedCommand("npm", [
        "--prefix",
        "packages/gpt-codex-hwp",
        "ls",
        "--omit=dev",
        "--all",
        "--json",
      ]),
      fixedCommand("npm", ["run", "verify:source-dependencies"]),
    ], root, none),
    npmStage("audit", [
      "--prefix",
      "packages/gpt-codex-hwp",
      "audit",
      "--omit=dev",
      "--json",
    ], root, none),
    npmStage("public-tree", ["run", "security:scan-tree"], root, none),
    npmStage("public-history", ["run", "security:scan-history"], root, none),
    npmStage("privacy", [
      "--prefix",
      "packages/gpt-codex-hwp",
      "run",
      "test:focused",
      "--",
      "tests/public-runtime-privacy.test.ts",
    ], root, none),
    npmStage("runtime-diff", ["run", "runtime:check"], root, none),
    documentBenchmarkStage(root, none),
    Object.freeze({
      name: "release-artifacts",
      kind: "release-artifacts",
      cwd: root,
      env: none,
    }),
  ];
  if (JSON.stringify(stages.map((stage) => stage.name))
    !== JSON.stringify(REQUIRED_RELEASE_STAGES)) {
    throw releaseError("RELEASE_VERIFY_STAGE_CONTRACT_INVALID");
  }
  return Object.freeze(stages);
}

function documentBenchmarkStage(root, env) {
  const small = fixedCommand("npm", [
    "--prefix",
    "packages/gpt-codex-hwp",
    "run",
    "benchmark:documents",
    "--",
    "--sizes",
    "10",
    "--output",
    `.superpowers/benchmarks/release-10m-${process.pid}.json`,
  ]);
  if (process.env.HWP_BENCH_REQUIRE_LARGE !== "1") {
    return npmStage("document-benchmark", small.args, root, env);
  }
  const evidencePath = process.env.HWP_BENCH_LARGE_EVIDENCE
    ?? ".superpowers/benchmarks/large.json";
  return compositeStage("document-benchmark", [
    small,
    fixedCommand("node", [
      "packages/gpt-codex-hwp/benchmarks/document-engine-benchmark.mjs",
      "--validate-large",
      evidencePath,
    ]),
  ], root, env);
}

function npmStage(name, args, cwd, env, evidence) {
  const stage = {
    name,
    tool: "npm",
    args: Object.freeze([...args]),
    cwd,
    env,
  };
  if (evidence !== undefined) stage.evidence = evidence;
  return Object.freeze(stage);
}

function nodeStage(name, args, cwd, env) {
  return Object.freeze({
    name,
    tool: "node",
    args: Object.freeze([...args]),
    cwd,
    env,
  });
}

function compositeStage(name, commands, cwd, env, evidence) {
  const stage = {
    name,
    commands: Object.freeze([...commands]),
    cwd,
    env,
  };
  if (evidence !== undefined) stage.evidence = evidence;
  return Object.freeze(stage);
}

function fixedCommand(tool, args) {
  return Object.freeze({ tool, args: Object.freeze([...args]) });
}

function nodeTestEvidence(targetName) {
  return Object.freeze({
    kind: "node-test-summary",
    tests: 1,
    passes: 1,
    skips: 0,
    targetName,
  });
}

function normalizedStageStatus(outcome) {
  if (outcome?.status === "passed") return "passed";
  if (outcome?.status === "skipped") return "skipped";
  return "failed";
}

function validateStageEvidence(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.kind !== "node-test-summary"
    || Object.keys(value).sort().join(",") !== "kind,passes,skips,targetName,tests") {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  for (const field of ["tests", "passes", "skips"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
    }
  }
  if (value.tests === 0 || value.passes + value.skips > value.tests) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  if (typeof value.targetName !== "string" || value.targetName.length === 0
    || value.targetName.length > 512 || /[\r\n]/u.test(value.targetName)) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  return value;
}

function hasRequiredNodeTestSummary(result, evidence) {
  const output = `${result.stdout}\n${result.stderr}`;
  const metrics = {
    tests: tapMetric(output, "tests"),
    passes: tapMetric(output, "pass"),
    failures: tapMetric(output, "fail"),
    cancelled: tapMetric(output, "cancelled"),
    skips: tapMetric(output, "skipped"),
    todo: tapMetric(output, "todo"),
  };
  return metrics.tests === evidence.tests
    && metrics.passes === evidence.passes
    && metrics.failures === 0
    && metrics.cancelled === 0
    && metrics.skips === evidence.skips
    && metrics.todo === 0
    && hasSingleTopLevelPlan(output, evidence.tests)
    && hasExactPassedTarget(output, evidence.targetName);
}

function tapMetric(output, label) {
  const pattern = new RegExp(`^# ${label} ([0-9]+)\\r?$`, "gmu");
  const matches = [...output.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  return Number(matches[0][1]);
}

function hasSingleTopLevelPlan(output, expectedTests) {
  const plans = [...output.matchAll(/^1\.\.([0-9]+)\r?$/gmu)];
  return plans.length === 1 && Number(plans[0][1]) === expectedTests;
}

function hasExactPassedTarget(output, targetName) {
  const expectedLine = `ok 1 - ${targetName}`;
  return output.split(/\r?\n/u).filter((line) => line === expectedLine).length === 1;
}

function releaseReceipt({
  status,
  platform,
  arch,
  versions,
  stages,
  fixtureSha256,
  sourceIdentity,
}) {
  const passedIdentity = status === "passed" ? validatedSourceIdentity(sourceIdentity) : null;
  return Object.freeze({
    schemaVersion: 2,
    status,
    commit: passedIdentity?.commit ?? null,
    tree: passedIdentity?.tree ?? null,
    platform,
    arch,
    node: versions.node,
    npm: versions.npm,
    python: versions.python,
    stages: Object.freeze([...stages]),
    toolCount: TOOL_COUNT,
    fixtureSha256,
  });
}

async function probeToolVersions(root) {
  const npmResult = await executeLogicalCommand({
    tool: "npm",
    args: ["--version"],
    cwd: root,
  });
  const pythonResult = await executeLogicalCommand({
    tool: "python",
    args: ["--version"],
    cwd: root,
  });
  const npm = singleVersion(npmResult, /^([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/u);
  const python = singleVersion(
    pythonResult,
    /^Python\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/u,
  );
  return validateVersions({ node: process.version, npm, python });
}

async function executeLogicalCommand({ tool, args, cwd }) {
  const invocation = resolveInvocation({ tool, args });
  const result = await executeCommand({
    ...invocation,
    cwd,
    env: releaseSubprocessEnvironment(),
    timeoutMs: VERSION_TIMEOUT_MS,
    maxOutputBytes: VERSION_MAX_OUTPUT_BYTES,
    captureOutput: true,
  });
  if (result.status !== "passed") throw releaseError("RELEASE_VERIFY_TOOLCHAIN_UNAVAILABLE");
  return `${result.stdout}\n${result.stderr}`.trim();
}

function singleVersion(value, pattern) {
  const lines = String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw releaseError("RELEASE_VERIFY_TOOLCHAIN_VERSION_INVALID");
  const match = pattern.exec(lines[0]);
  if (!match) throw releaseError("RELEASE_VERIFY_TOOLCHAIN_VERSION_INVALID");
  return match[1];
}

function validateVersions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw releaseError("RELEASE_VERIFY_TOOLCHAIN_VERSION_INVALID");
  }
  const versionPattern = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
  const versions = {
    node: value.node,
    npm: value.npm,
    python: value.python,
  };
  if (!Object.values(versions).every((version) =>
    typeof version === "string" && versionPattern.test(version))) {
    throw releaseError("RELEASE_VERIFY_TOOLCHAIN_VERSION_INVALID");
  }
  return Object.freeze(versions);
}

function resolveInvocation(stage) {
  if (stage === null || typeof stage !== "object" || Array.isArray(stage)) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  if (!Array.isArray(stage.args) || !stage.args.every((arg) => typeof arg === "string")) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  if (stage.tool === "node") {
    return { command: process.execPath, args: [...stage.args] };
  }
  if (stage.tool === "python") {
    return { command: "python", args: [...stage.args] };
  }
  if (stage.tool !== "npm") throw releaseError("RELEASE_VERIFY_STAGE_INVALID");

  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.length > 0) {
    return { command: process.execPath, args: [npmExecPath, ...stage.args] };
  }
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...stage.args],
    };
  }
  return { command: "npm", args: [...stage.args] };
}

function resolveStageInvocations(stage) {
  if (stage === null || typeof stage !== "object" || Array.isArray(stage)) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  if (stage.commands === undefined) return Object.freeze([resolveInvocation(stage)]);
  if (Object.hasOwn(stage, "tool") || Object.hasOwn(stage, "args")
    || !Array.isArray(stage.commands) || stage.commands.length === 0
    || stage.commands.length > MAX_STAGE_COMMANDS) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  const invocations = stage.commands.map((command) => {
    if (command === null || typeof command !== "object" || Array.isArray(command)
      || Object.keys(command).sort().join(",") !== "args,tool") {
      throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
    }
    return resolveInvocation(command);
  });
  return Object.freeze(invocations);
}

function stageEnvironment(overrides) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof value !== "string"
      || /^GIT_/iu.test(key)) {
      throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
    }
  }
  try {
    return releaseSubprocessEnvironment(process.env, overrides);
  } catch {
    throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
  }
}

async function executeCommand({
  command,
  args,
  cwd,
  env,
  timeoutMs,
  maxOutputBytes,
  outputBudget: sharedOutputBudget,
  captureOutput,
}) {
  const outputBudget = sharedOutputBudget ?? { used: 0, limit: maxOutputBytes };
  if (outputBudget === null || typeof outputBudget !== "object"
    || !Number.isSafeInteger(outputBudget.used) || outputBudget.used < 0
    || outputBudget.limit !== maxOutputBytes) {
    throw releaseError("RELEASE_VERIFY_OUTPUT_BOUND_INVALID");
  }
  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolvePromise({ status: "failed", stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    let timer;

    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        status,
        stdout: captureOutput ? stdout : "",
        stderr: captureOutput ? stderr : "",
      });
    };
    const stop = async () => {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(timer);
      try {
        await terminateProcessTree(child);
      } catch {
        // Termination failures remain a failed, redacted stage result.
      }
      finish("failed");
    };
    const observe = (stream, target) => {
      stream?.on("data", (chunk) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const bytes = Buffer.byteLength(text);
        outputBudget.used += bytes;
        if (target === "stdout") {
          if (captureOutput && outputBudget.used <= outputBudget.limit) stdout += text;
        } else {
          if (captureOutput && outputBudget.used <= outputBudget.limit) stderr += text;
        }
        if (outputBudget.used > outputBudget.limit) void stop();
      });
    };
    observe(child.stdout, "stdout");
    observe(child.stderr, "stderr");
    child.once("error", () => finish("failed"));
    child.once("close", (code) => {
      if (terminating) return;
      finish(code === 0 ? "passed" : "failed");
    });
    timer = setTimeout(() => { void stop(); }, timeoutMs);
  });
}

export async function terminateProcessTree(child, options = {}) {
  if (child === null || typeof child !== "object" || Array.isArray(child)) {
    throw releaseError("RELEASE_VERIFY_PROCESS_INVALID");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw releaseError("RELEASE_VERIFY_TERMINATION_OPTIONS_INVALID");
  }
  if (child.pid === undefined) return true;

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const spawnProcess = options.spawnProcess ?? spawn;
    if (typeof spawnProcess !== "function") {
      throw releaseError("RELEASE_VERIFY_TERMINATION_OPTIONS_INVALID");
    }
    const taskkillTimeoutMs = positiveInteger(
      options.taskkillTimeoutMs ?? TASKKILL_TIMEOUT_MS,
      "taskkill timeout",
    );
    const taskkillSucceeded = await runWindowsTaskkill({
      pid: child.pid,
      spawnProcess,
      timeoutMs: taskkillTimeoutMs,
    });
    if (!taskkillSucceeded) attemptDirectChildKill(child);
    return taskkillSucceeded;
  }

  const signalGroup = options.signalGroup ?? signalPosixProcessGroup;
  const sleep = options.sleep ?? delay;
  if (typeof signalGroup !== "function" || typeof sleep !== "function") {
    throw releaseError("RELEASE_VERIFY_TERMINATION_OPTIONS_INVALID");
  }
  signalGroup(child, "SIGTERM");
  await sleep(250);
  signalGroup(child, "SIGKILL");
  return true;
}

async function runWindowsTaskkill({ pid, spawnProcess, timeoutMs }) {
  return await new Promise((resolvePromise) => {
    let killer;
    try {
      killer = spawnProcess("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolvePromise(false);
      return;
    }
    if (killer === null || typeof killer !== "object"
      || typeof killer.once !== "function") {
      resolvePromise(false);
      return;
    }
    safelyUnref(killer);

    let settled = false;
    let timer;
    const finish = (succeeded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(succeeded);
    };
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        killer.kill("SIGKILL");
      } catch {
        // The hard timeout remains authoritative even if taskkill cannot be killed.
      }
      resolvePromise(false);
    }, timeoutMs);
  });
}

function attemptDirectChildKill(child) {
  try {
    if (typeof child.kill === "function") child.kill("SIGKILL");
  } catch {
    // The release stage is already failed; the fallback must never block completion.
  }
  for (const stream of [child.stdout, child.stderr]) {
    try {
      if (typeof stream?.destroy === "function") stream.destroy();
    } catch {
      // Closing inherited pipes is best-effort after the stage has already failed.
    }
  }
  safelyUnref(child);
}

function safelyUnref(handle) {
  try {
    if (typeof handle.unref === "function") handle.unref();
  } catch {
    // A failed unref must not keep the release gate waiting on cleanup.
  }
}

function signalPosixProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    if (child.exitCode === null) {
      try {
        child.kill(signal);
      } catch {
        // The group signaling error remains authoritative.
      }
    }
    throw error;
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw releaseError(`RELEASE_VERIFY_${label.toUpperCase().replaceAll(" ", "_")}_INVALID`);
  }
  return value;
}

function requiredRoot(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw releaseError("RELEASE_VERIFY_ROOT_INVALID");
  }
  return resolve(value);
}

function safeIdentity(value, field) {
  if (typeof value !== "string" || !/^[0-9A-Za-z._-]+$/u.test(value)) {
    throw releaseError(`RELEASE_VERIFY_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function safeNow(now) {
  const value = now();
  if (!Number.isFinite(value)) throw releaseError("RELEASE_VERIFY_CLOCK_INVALID");
  return value;
}

function releaseError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runCli();
}
