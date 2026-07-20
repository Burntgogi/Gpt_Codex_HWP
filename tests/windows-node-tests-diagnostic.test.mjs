import assert from "node:assert/strict";
import test from "node:test";

import { runWindowsNodeTestsDiagnostic } from "../scripts/windows-node-tests-diagnostic.mjs";

test("Windows Node diagnostic reports only the fixed failed repository filename", async () => {
  let output = "";
  let sourceCalls = 0;
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "release-verify.test.mjs",
    runSourceDiagnostic: async () => { sourceCalls += 1; return true; },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(sourceCalls, 0);
  assert.equal(
    output,
    "WINDOWS_REPOSITORY_TEST_FILE file=release-verify.test.mjs status=failed\n",
  );
});

test("Windows Node diagnostic delegates to the bounded source diagnostic after repository success", async () => {
  let output = "";
  let sourceOptions;
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async () => true,
    runSourceDiagnostic: async (options) => {
      sourceOptions = options;
      options.stdout.write("WINDOWS_NODE_TEST_FILES status=passed files=41\n");
      return true;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, true);
  assert.equal(sourceOptions.receiptPrefix, "WINDOWS");
  assert.equal(output.startsWith("WINDOWS_REPOSITORY_TEST_FILES status=passed files="), true);
  assert.equal(output.endsWith("WINDOWS_NODE_TEST_FILES status=passed files=41\n"), true);
});

test("Windows Node diagnostic converts a source diagnostic exception to one fixed receipt", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async () => true,
    runSourceDiagnostic: async () => { throw new Error("private diagnostic failure"); },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output.endsWith("WINDOWS_SOURCE_NODE_DIAGNOSTIC status=failed\n"),
    true,
  );
  assert.doesNotMatch(output, /private diagnostic failure/u);
});
