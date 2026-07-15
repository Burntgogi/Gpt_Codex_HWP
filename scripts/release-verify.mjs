import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveHwpFixture } from "../packages/gpt-codex-hwp/release-scripts/hwp-fixture.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_MAX_OUTPUT_BYTES = 4 * 1024;
const TASKKILL_TIMEOUT_MS = 2_000;
const MAX_STAGE_COMMANDS = 4;
const TOOL_COUNT = 9;

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
  "privacy",
  "runtime-diff",
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

  const now = options.now ?? Date.now;
  if (typeof now !== "function") throw releaseError("RELEASE_VERIFY_CLOCK_INVALID");
  const injectedRunner = options.runStage;
  if (injectedRunner !== undefined && typeof injectedRunner !== "function") {
    throw releaseError("RELEASE_VERIFY_RUNNER_INVALID");
  }
  const runStage = injectedRunner ?? ((stage) => runStageCommand(stage, {
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  }));

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
    const status = normalizedStageStatus(outcome);
    stages.push(Object.freeze({ name: stage.name, status, elapsedMs }));
    if (status !== "passed") {
      return releaseReceipt({
        status: "failed",
        platform,
        arch,
        versions,
        stages,
        fixtureSha256,
      });
    }
  }

  return releaseReceipt({
    status: "passed",
    platform,
    arch,
    versions,
    stages,
    fixtureSha256,
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
    if (remainingTimeoutMs <= 0) return Object.freeze({ status: "failed" });
    result = await executeCommand({
      ...invocations[index],
      cwd,
      env,
      timeoutMs: remainingTimeoutMs,
      maxOutputBytes,
      outputBudget,
      captureOutput: evidence !== undefined && index === invocations.length - 1,
    });
    if (result.status !== "passed") return Object.freeze({ status: "failed" });
  }
  const passed = result.status === "passed"
    && (evidence === undefined || hasRequiredNodeTestSummary(result, evidence));
  return Object.freeze({ status: passed ? "passed" : "failed" });
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
    npmStage("privacy", [
      "--prefix",
      "packages/gpt-codex-hwp",
      "run",
      "test:focused",
      "--",
      "tests/public-runtime-privacy.test.ts",
    ], root, none),
    npmStage("runtime-diff", ["run", "runtime:check"], root, none),
    nodeStage("release-artifacts", [
      "packages/gpt-codex-hwp/release-scripts/build-release-artifacts.mjs",
    ], root, none),
  ];
  if (JSON.stringify(stages.map((stage) => stage.name))
    !== JSON.stringify(REQUIRED_RELEASE_STAGES)) {
    throw releaseError("RELEASE_VERIFY_STAGE_CONTRACT_INVALID");
  }
  return Object.freeze(stages);
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

function releaseReceipt({ status, platform, arch, versions, stages, fixtureSha256 }) {
  return Object.freeze({
    schemaVersion: 1,
    status,
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
    env: { ...process.env },
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
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof value !== "string") {
      throw releaseError("RELEASE_VERIFY_STAGE_INVALID");
    }
  }
  const environment = { ...process.env, ...overrides };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
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
