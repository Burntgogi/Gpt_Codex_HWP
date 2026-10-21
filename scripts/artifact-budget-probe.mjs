import { spawn, execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { noReplaceGitArguments, releaseSubprocessEnvironment } from "./release-subprocess-environment.mjs";

const executeFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineCommit = "f02d7ff416f76ee34fbd3bc0f31ab501988148fc";
const captureBytes = 512 * 1024;
const phaseNames = new Set([
  "body-enter", "body-complete", "body-error", "fixture-enter", "fixture-ready",
  "fixture-cleanup-enter", "fixture-cleanup-complete", "fixture-cleanup-error",
  "prepare-enter", "prepare-complete", "prepare-error",
]);
const failureKinds = new Set([
  "test-timeout", "hook-failure", "test-code", "async-failure", "cancelled", "unknown",
]);
const runnerKinds = new Set([
  "spawn-error", "missing-stdout", "stdout-error", "child-error", "invalid-chunk",
  "capture-limit", "runner-timeout", "unknown",
]);
let stage = "arguments";
let ownedRoot;
let baselineRoot;
let worktreeCreated = false;
let cleanupFailed = false;
const results = [];

function boundedOrdinal(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 999 ? value : null;
}

function safeSnapshot(value) {
  if (value === null || typeof value !== "object") return null;
  const result = {
    reportedCompletionOrdinal: boundedOrdinal(value.reportedCompletionOrdinal),
    reportedCompletionKind: ["passed", "failed", "unavailable"].includes(value.reportedCompletionKind)
      ? value.reportedCompletionKind : "unavailable",
  };
  for (const key of [
    "tapPlanAvailable", "tapSummaryAvailable", "spawnObserved", "exitObserved",
    "stdoutEndObserved", "closeObserved", "deadlineExpired", "graceExpired", "terminationSettled",
  ]) result[key] = typeof value[key] === "boolean" ? value[key] : null;
  result.terminationResult = typeof value.terminationResult === "boolean" ? value.terminationResult : null;
  return result;
}

async function git(arguments_, cwd = root) {
  return executeFile("git", noReplaceGitArguments(arguments_), {
    cwd, env: releaseSubprocessEnvironment(), timeout: 30_000,
    encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true,
  });
}

function phaseReader(variant) {
  let retained = 0;
  let stopped = false;
  let line = "";
  let discardLine = false;
  let emitted = 0;
  let latest = null;
  return {
    accept(bytes) {
      if (stopped) return;
      if (!Buffer.isBuffer(bytes) || retained + bytes.length > captureBytes) {
        stopped = true;
        return;
      }
      retained += bytes.length;
      for (const character of bytes.toString("utf8")) {
        if (character === "\n") {
          if (!discardLine) {
            const match = /^(?:# )?HWP_ARTIFACT_PHASE ordinal=([1-9][0-9]?) phase=([a-z-]+) elapsedMs=([0-9]{1,6})\r?$/u.exec(line);
            if (match !== null && Number(match[1]) <= 64 && Number(match[3]) <= 600_000
              && phaseNames.has(match[2])) {
              latest = { ordinal: Number(match[1]), phase: match[2], elapsedMs: Number(match[3]) };
              if (emitted++ < 512) process.stdout.write(
                `ARTIFACT_BUDGET_PHASE variant=${variant} ordinal=${latest.ordinal} phase=${latest.phase} elapsedMs=${latest.elapsedMs}\n`,
              );
            }
          }
          line = "";
          discardLine = false;
        } else if (!discardLine) {
          if (line.length >= 512) { line = ""; discardLine = true; }
          else line += character;
        }
      }
    },
    latest: () => latest,
  };
}

async function probe(variant, repositoryRoot) {
  const { executeBoundedNodeTestFile } = await import(
    pathToFileURL(join(repositoryRoot, "scripts", "macos-node-tests-diagnostic.mjs")).href,
  );
  let failedOrdinal = null;
  let failureKind = "unknown";
  let completionKind = "unavailable";
  let runnerFailureKind = null;
  let snapshot = null;
  const phases = phaseReader(variant);
  const started = performance.now();
  process.stdout.write(`ARTIFACT_BUDGET_START variant=${variant} deadlineMs=120000 captureBytes=${captureBytes}\n`);
  const passed = await executeBoundedNodeTestFile("release-artifacts.test.ts", {
    maximumTopLevelTests: 999,
    spawnProcess(command, arguments_, options) {
      const child = spawn(command, arguments_, options);
      child.stdout?.on("data", (bytes) => phases.accept(bytes));
      return child;
    },
    onFailedTopLevelOrdinal(value) { failedOrdinal = boundedOrdinal(value); },
    onFailedTopLevelFailureKind(value) { failureKind = failureKinds.has(value) ? value : "unknown"; },
    onCompletionKind(value) { completionKind = ["passed", "failed"].includes(value) ? value : "unavailable"; },
    onRunnerFailureKind(value) { runnerFailureKind = runnerKinds.has(value) ? value : "unknown"; },
    onFailureSnapshot(value) { snapshot = safeSnapshot(value); },
  });
  const result = {
    variant, passed: passed === true, elapsedMs: Math.floor(performance.now() - started),
    failedOrdinal, failureKind, completionKind, runnerFailureKind, snapshot, lastObservedPhase: phases.latest(),
  };
  process.stdout.write(`ARTIFACT_BUDGET_RESULT ${JSON.stringify(result)}\n`);
  results.push(result);
}

try {
  const order = process.env.HWP_ARTIFACT_PROBE_ORDER;
  if (!["baseline-first", "candidate-first"].includes(order)
    || process.env.HWP_ARTIFACT_BUDGET_PROBE !== "1") throw new Error("probe arguments");
  if (process.platform !== "win32" && process.env.HWP_ARTIFACT_PROBE_ALLOW_HOST !== "1") {
    throw new Error("probe platform");
  }
  const npmPath = process.env.npm_execpath;
  if (typeof npmPath !== "string" || !isAbsolute(npmPath)
    || !(await lstat(npmPath)).isFile()) throw new Error("npm prerequisite");
  const canonicalTemp = await realpath(tmpdir());
  const canonicalReportRoot = await realpath(process.env.RUNNER_TEMP ?? canonicalTemp);
  ownedRoot = await mkdtemp(join(canonicalTemp, "hwp-artifact-budget-"));
  baselineRoot = join(ownedRoot, "baseline");
  stage = "baseline-checkout";
  await git(["worktree", "add", "--detach", baselineRoot, baselineCommit]);
  worktreeCreated = true;
  stage = "matched-observer";
  for (const path of [
    "scripts/macos-node-tests-diagnostic.mjs",
    "packages/gpt-codex-hwp/tests/release-artifacts.test.ts",
  ]) await copyFile(join(root, path), join(baselineRoot, path));
  stage = "baseline-dependencies";
  await executeFile(process.execPath, [npmPath, "ci", "--ignore-scripts", "--prefix",
    join(baselineRoot, "packages", "gpt-codex-hwp")], {
    cwd: baselineRoot, env: process.env, timeout: 600_000,
    maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const variants = order === "baseline-first"
    ? [["baseline", baselineRoot], ["candidate", root]]
    : [["candidate", root], ["baseline", baselineRoot]];
  for (const [variant, directory] of variants) {
    stage = `${variant}-execution`;
    await probe(variant, directory);
  }
  stage = "report";
  const reportPath = resolve(process.env.ARTIFACT_BUDGET_REPORT ?? join(canonicalReportRoot,
    `hwp-artifact-budget-${process.pid}.json`));
  const withinTemp = relative(canonicalReportRoot, reportPath);
  if (withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("report boundary");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ schemaVersion: 1, order, baselineCommit,
    deadlineMs: 120_000, captureBytes, results }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.exitCode = results.find((result) => result.variant === "candidate")?.passed === true ? 0 : 1;
} catch {
  process.stdout.write(`ARTIFACT_BUDGET_PROBE status=failed stage=${stage}\n`);
  process.exitCode = 1;
} finally {
  if (worktreeCreated) {
    try { await git(["worktree", "remove", "--force", baselineRoot]); }
    catch { cleanupFailed = true; }
  }
  if (ownedRoot !== undefined && !cleanupFailed) {
    try { await rm(ownedRoot, { recursive: true, force: true }); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) {
    process.stdout.write("ARTIFACT_BUDGET_PROBE status=failed stage=owned-worktree-cleanup\n");
    process.exitCode = 1;
  }
}
