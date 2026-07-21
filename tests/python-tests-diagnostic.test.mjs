import assert from "node:assert/strict";
import test from "node:test";

const diagnostic = await import("../scripts/python-tests-diagnostic.mjs").catch(() => ({}));

const CASE_IDS = Array.from(
  { length: 20 },
  (_, index) => `scripts.hwpx-safe-edit.test_hwpx_safe_edit.SafeEditTests.test_case_${index + 1}`,
);

test("hosted Python diagnostic exposes one bounded runner", () => {
  assert.equal(typeof diagnostic.runHostedPythonTestsDiagnostic, "function");
});

test("hosted Python diagnostic emits one bounded ordinal for the first isolated failure", async () => {
  const calls = [];
  let output = "";
  let exitCode;

  const passed = await diagnostic.runHostedPythonTestsDiagnostic({
    discoverTests: async () => CASE_IDS,
    runFullSuite: async () => false,
    runTest: async (id) => {
      calls.push(id);
      return id !== CASE_IDS[7];
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, false);
  assert.deepEqual(calls, CASE_IDS.slice(0, 8));
  assert.equal(output, "MAC_PYTHON_TEST_CASE case=py08 status=failed\n");
  assert.equal(exitCode, 1);
});

test("hosted Python diagnostic redacts discovery and aggregate failures", async () => {
  for (const discoverTests of [
    async () => { throw new Error("PRIVATE/path/document.hwpx credential-marker"); },
    async () => CASE_IDS.slice(0, 19),
  ]) {
    let output = "";
    const passed = await diagnostic.runHostedPythonTestsDiagnostic({
      discoverTests,
      stdout: { write: (value) => { output += value; } },
      setExitCode() {},
    });
    assert.equal(passed, false);
    assert.equal(output, "MAC_PYTHON_TEST_CASE case=python-aggregate status=failed\n");
    assert.doesNotMatch(output, /PRIVATE|credential-marker|\.hwpx|[\\/]/u);
  }
});

test("hosted Python diagnostic emits one all-pass receipt without isolated reruns", async () => {
  let output = "";
  let isolatedCalls = 0;
  let exitCode;

  const passed = await diagnostic.runHostedPythonTestsDiagnostic({
    discoverTests: async () => CASE_IDS,
    runFullSuite: async () => true,
    runTest: async () => { isolatedCalls += 1; return true; },
    stdout: { write: (value) => { output += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, true);
  assert.equal(isolatedCalls, 0);
  assert.equal(output, "MAC_PYTHON_TESTS status=passed tests=20\n");
  assert.equal(exitCode, 0);
});

test("hosted Python diagnostic reports an aggregate when only the full suite fails", async () => {
  let output = "";
  const passed = await diagnostic.runHostedPythonTestsDiagnostic({
    discoverTests: async () => CASE_IDS,
    runFullSuite: async () => false,
    runTest: async () => true,
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });

  assert.equal(passed, false);
  assert.equal(output, "MAC_PYTHON_TEST_CASE case=python-aggregate status=failed\n");
});
