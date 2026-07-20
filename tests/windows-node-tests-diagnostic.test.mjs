import assert from "node:assert/strict";
import test from "node:test";

import { runWindowsNodeTestsDiagnostic } from "../scripts/windows-node-tests-diagnostic.mjs";

test("Windows Node diagnostic reports only the fixed failed repository filename", async () => {
  let output = "";
  let sourceCalls = 0;
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "governance-docs.test.mjs",
    runSourceDiagnostic: async () => { sourceCalls += 1; return true; },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(sourceCalls, 0);
  assert.equal(
    output,
    "WINDOWS_REPOSITORY_TEST_FILE file=governance-docs.test.mjs status=failed\n",
  );
});

test("Windows Node diagnostic gives only the Git-history policy file an extended bound", async () => {
  let observedTimeout;
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file, options) => {
      if (file === "public-content-policy.test.mjs") {
        observedTimeout = options.testTimeoutMs;
        return false;
      }
      return true;
    },
    runPublicContentDiagnostic: async () => "pc23",
    stdout: { write() {} },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(observedTimeout, 300_000);
});

test("Windows Node diagnostic narrows release verification to one fixed case id", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "release-verify.test.mjs",
    runReleaseVerifyCase: async (record) => record.id !== "rv17",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_REPOSITORY_TEST_CASE case=rv17 status=failed\n");
});

test("Windows Node diagnostic emits a bounded real-document release stage", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "release-verify.test.mjs",
    runReleaseVerifyCase: async (record) => record.id !== "rv32",
    runReleaseOracleDiagnostic: async () => "hwpx-roundtrip",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "WINDOWS_RELEASE_ORACLE stage=hwpx-roundtrip\n"
      + "WINDOWS_REPOSITORY_TEST_CASE case=rv32 status=failed\n",
  );
});

test("Windows Node diagnostic maps public-content failure to one bounded ordinal", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "public-content-policy.test.mjs",
    runPublicContentDiagnostic: async () => "pc61",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_REPOSITORY_TEST_CASE case=pc61 status=failed\n");
});

test("Windows Node diagnostic preserves the bounded metadata stage from the public-content rerun", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "public-content-policy.test.mjs",
    runPublicContentDiagnostic: async () => ({ caseId: "pc23", stage: "commit-header" }),
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "WINDOWS_PUBLIC_CONTENT_METADATA stage=commit-header\n"
      + "WINDOWS_REPOSITORY_TEST_CASE case=pc23 status=failed\n",
  );
});

test("Windows Node diagnostic maps runtime-projection failure to one bounded ordinal", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "runtime-projection.test.mjs",
    runRuntimeProjectionDiagnostic: async () => "rp25",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_REPOSITORY_TEST_CASE case=rp25 status=failed\n");
});

test("Windows Node diagnostic narrows the Kordoc repository failure to one fixed case id", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "kordoc-runtime-ownership.test.mjs",
    runKordocCase: async (record) => record.id !== "ko03",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_REPOSITORY_TEST_CASE case=ko03 status=failed\n");
});

test("Windows Node diagnostic emits a bounded stage for the default Kordoc builder case", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "kordoc-runtime-ownership.test.mjs",
    runKordocCase: async (record) => record.id !== "ko02",
    runKordocDefaultDiagnostic: async () => "cleanup",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "WINDOWS_KORDOC_DEFAULT stage=cleanup\n"
      + "WINDOWS_REPOSITORY_TEST_CASE case=ko02 status=failed\n",
  );
});

test("Windows Node diagnostic reports a fixed aggregate when isolated Kordoc cases pass", async () => {
  let output = "";
  const passed = await runWindowsNodeTestsDiagnostic({
    runRepositoryFile: async (file) => file !== "kordoc-runtime-ownership.test.mjs",
    runKordocCase: async () => true,
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_REPOSITORY_TEST_CASE case=aggregate status=failed\n");
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
