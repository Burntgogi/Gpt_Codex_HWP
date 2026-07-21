import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(PROJECT_ROOT, "packages/gpt-codex-hwp");
const TEST_MODULE = "scripts.hwpx-safe-edit.test_hwpx_safe_edit";
const EXPECTED_TEST_COUNT = 20;
const TEST_ID_PATTERN = /^scripts\.hwpx-safe-edit\.test_hwpx_safe_edit\.SafeEditTests\.test_[a-z0-9_]+$/u;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DISCOVERY_PROGRAM = [
  "import json, unittest",
  `suite = unittest.defaultTestLoader.loadTestsFromName(${JSON.stringify(TEST_MODULE)})`,
  "def flatten(value):",
  "    for item in value:",
  "        if isinstance(item, unittest.TestSuite):",
  "            yield from flatten(item)",
  "        else:",
  "            yield item.id()",
  "print(json.dumps(list(flatten(suite)), separators=(',', ':')))",
].join("\n");

export async function runHostedPythonTestsDiagnostic(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const discoverTests = options.discoverTests
    ?? (() => discoverPythonTests({ timeoutMs }));
  const runFullSuite = options.runFullSuite
    ?? (() => executePythonTest([TEST_MODULE], { timeoutMs }));
  const runTest = options.runTest
    ?? ((id) => executePythonTest([id], { timeoutMs }));

  let ids;
  try {
    ids = await discoverTests();
  } catch {
    return failAggregate(stdout, setExitCode);
  }
  if (!validDiscoveredTests(ids)) return failAggregate(stdout, setExitCode);

  let fullSuitePassed = false;
  try {
    fullSuitePassed = await runFullSuite() === true;
  } catch {
    fullSuitePassed = false;
  }
  if (fullSuitePassed) {
    stdout.write(`MAC_PYTHON_TESTS status=passed tests=${EXPECTED_TEST_COUNT}\n`);
    setExitCode(0);
    return true;
  }

  for (const [index, id] of ids.entries()) {
    let passed = false;
    try {
      passed = await runTest(id) === true;
    } catch {
      passed = false;
    }
    if (!passed) {
      const ordinal = String(index + 1).padStart(2, "0");
      stdout.write(`MAC_PYTHON_TEST_CASE case=py${ordinal} status=failed\n`);
      setExitCode(1);
      return false;
    }
  }
  return failAggregate(stdout, setExitCode);
}

function discoverPythonTests({ timeoutMs }) {
  const result = spawnSync("python", ["-c", DISCOVERY_PROGRAM], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: safePythonEnvironment(),
    maxBuffer: MAX_DISCOVERY_BYTES,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error("PYTHON_TEST_DISCOVERY_FAILED");
  }
  if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > MAX_DISCOVERY_BYTES) {
    throw new Error("PYTHON_TEST_DISCOVERY_INVALID");
  }
  return JSON.parse(result.stdout);
}

function executePythonTest(names, { timeoutMs }) {
  const result = spawnSync("python", ["-m", "unittest", ...names], {
    cwd: PACKAGE_ROOT,
    env: safePythonEnvironment(),
    shell: false,
    stdio: "ignore",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return result.error === undefined && result.signal === null && result.status === 0;
}

function validDiscoveredTests(ids) {
  return Array.isArray(ids)
    && ids.length === EXPECTED_TEST_COUNT
    && new Set(ids).size === EXPECTED_TEST_COUNT
    && ids.every((id) => typeof id === "string" && TEST_ID_PATTERN.test(id));
}

function safePythonEnvironment() {
  const env = Object.create(null);
  for (const key of [
    "HOME", "LANG", "LC_ALL", "PATH", "PATHEXT", "SYSTEMROOT",
    "TEMP", "TMP", "TMPDIR", "USERPROFILE", "WINDIR",
  ]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return env;
}

function boundedTimeout(value) {
  if (Number.isSafeInteger(value) && value >= 1_000 && value <= 120_000) return value;
  return DEFAULT_TIMEOUT_MS;
}

function failAggregate(stdout, setExitCode) {
  stdout.write("MAC_PYTHON_TEST_CASE case=python-aggregate status=failed\n");
  setExitCode(1);
  return false;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runHostedPythonTestsDiagnostic();
}
