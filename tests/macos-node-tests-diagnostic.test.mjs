import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  classifyNodeTestCompletion,
  executeBoundedNodeTestFile,
  failedTopLevelFailureKind,
  failedTopLevelAssertionOrigin,
  failedTopLevelOrdinal,
  failedTopLevelTestCodeReason,
  runMacNodeTestsDiagnostic,
} from "../scripts/macos-node-tests-diagnostic.mjs";

test("macOS Node diagnostic classifies assertion origins without exposing stack paths", () => {
  const registrationCallback = [
    "not ok 45 - sequential registration",
    "  failureType: 'testCodeFailure'",
    "  code: 'ERR_ASSERTION'",
    "  stack: |-",
    "      Object.registerRoot (/private/runner/document-process-registration.test.ts:2399:16)",
    "# fail 1",
  ].join("\n");
  const testBody = registrationCallback.replace(
    "Object.registerRoot",
    "TestContext.<anonymous>",
  );

  assert.equal(failedTopLevelAssertionOrigin(registrationCallback), "register-root");
  assert.equal(failedTopLevelAssertionOrigin(testBody), "test-body");
  assert.equal(failedTopLevelAssertionOrigin("not ok 1 - malformed\n# fail 1"), undefined);
});

test("macOS Node diagnostic emits one fixed success receipt after every allowlisted file", async () => {
  const files = [];
  let output = "";
  let exitCode;
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => { files.push(file); return true; },
    stdout: { write: (value) => { output += value; } },
    setExitCode: (value) => { exitCode = value; },
  });
  assert.equal(passed, true);
  assert.equal(files.length, 41);
  assert.equal(new Set(files).size, 41);
  assert.equal(output, "MAC_NODE_TEST_FILES status=passed files=41\n");
  assert.equal(exitCode, 0);
});

test("macOS Node diagnostic reveals only the public failed filename and redacts errors", async () => {
  let output = "";
  let exitCode;
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => {
      if (file === "bounded-frame.test.ts") {
        throw new Error(`PRIVATE/path ${["AWS", "_SECRET_ACCESS_KEY=", "value"].join("")}`);
      }
      return true;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode: (value) => { exitCode = value; },
  });
  assert.equal(passed, false);
  assert.equal(output, "MAC_NODE_TEST_FILE file=bounded-frame.test.ts status=failed\n");
  assert.doesNotMatch(output, /PRIVATE|AWS_SECRET_ACCESS_KEY|[\\/]/u);
  assert.equal(exitCode, 1);
});

test("macOS Node diagnostic requires a nonempty exact TAP summary", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end("TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n");
        child.emit("close", 0, null);
      });
      return child;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "MAC_NODE_TEST_CASE case=ar01 status=failed\n");
});

test("macOS Node diagnostic accepts capability skips when every executed test passes", async () => {
  let output = "";
  let calls = 0;
  const passed = await runMacNodeTestsDiagnostic({
    spawnProcess() {
      calls += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end("TAP version 13\n1..3\n# tests 3\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n");
        child.emit("close", 0, null);
      });
      return child;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, true);
  assert.equal(calls, 41);
  assert.equal(output, "MAC_NODE_TEST_FILES status=passed files=41\n");
});

test("source Node diagnostic gives only document worker operations the measured extended bound", async () => {
  let ordinaryTimeout;
  let documentWorkerTimeout;
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file, fileOptions) => {
      if (file === "allowed-roots.test.ts") ordinaryTimeout = fileOptions?.testTimeoutMs;
      if (file === "document-worker-operations.test.ts") {
        documentWorkerTimeout = fileOptions?.testTimeoutMs;
      }
      return file !== "files.test.ts";
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(ordinaryTimeout, 120_000);
  assert.equal(documentWorkerTimeout, 300_000);
  assert.equal(output, "MAC_NODE_TEST_FILE file=files.test.ts status=failed\n");
});

test("macOS Node diagnostic narrows an allowed-roots aggregate failure to one fixed case id", async () => {
  const cases = [];
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "allowed-roots.test.ts",
    runAllowedRootsCase: async (record) => {
      cases.push(record.id);
      return record.id !== "ar03";
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.deepEqual(cases, ["ar01", "ar02", "ar03"]);
  assert.equal(output, "MAC_NODE_TEST_CASE case=ar03 status=failed\n");
});

test("macOS Node diagnostic reports fixed aggregate id when every allowed-roots case passes alone", async () => {
  let output = "";
  let cases = 0;
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "allowed-roots.test.ts",
    runAllowedRootsCase: async () => { cases += 1; return true; },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(cases, 18);
  assert.equal(output, "MAC_NODE_TEST_CASE case=allowed-roots-aggregate status=failed\n");
});

test("macOS Node diagnostic narrows an assets aggregate failure to one fixed case id", async () => {
  const cases = [];
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "assets.test.ts",
    runAssetsCase: async (record) => {
      cases.push(record.id);
      return record.id !== "as03";
    },
    runAssetsRenderDiagnostic: async () => "handler-warning",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.deepEqual(cases, ["as01", "as02", "as03"]);
  assert.equal(
    output,
    "MAC_SVG_ASSET boundary=handler-warning\nMAC_NODE_TEST_CASE case=as03 status=failed\n",
  );
});

test("macOS SVG diagnostic output is fixed and redacts invalid diagnostic values", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "assets.test.ts",
    runAssetsCase: async (record) => record.id !== "as03",
    runAssetsRenderDiagnostic: async () =>
      `C:\\private ${["AWS", "_SECRET_ACCESS_KEY=value"].join("")}`,
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "MAC_SVG_ASSET boundary=diagnostic-failed\nMAC_NODE_TEST_CASE case=as03 status=failed\n",
  );
});

test("macOS Node diagnostic reports the fixed aggregate id when every assets case passes alone", async () => {
  let output = "";
  let cases = 0;
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "assets.test.ts",
    runAssetsCase: async () => { cases += 1; return true; },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(cases, 17);
  assert.equal(output, "MAC_NODE_TEST_CASE case=assets-aggregate status=failed\n");
});

test("macOS Node diagnostic narrows a compact-runtime aggregate failure to one fixed case id", async () => {
  const cases = [];
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "compact-runtime.test.ts",
    runCompactRuntimeCase: async (record) => {
      cases.push(record.id);
      return record.id !== "cr03";
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.deepEqual(cases, ["cr01", "cr02", "cr03"]);
  assert.equal(output, "MAC_NODE_TEST_CASE case=cr03 status=failed\n");
});

test("macOS Node diagnostic narrows a doctor aggregate failure to one fixed case id", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "doctor.test.ts",
    runDoctorCase: async (record) => record.id !== "dc18",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "MAC_NODE_TEST_CASE case=dc18 status=failed\n");
});

test("macOS Node diagnostic emits a bounded orphan-cleanup stage", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "doctor.test.ts",
    runDoctorCase: async (record) => record.id !== "dc19",
    runDoctorOrphanDiagnostic: async () => "wait-gone",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "MAC_DOCTOR_ORPHAN stage=wait-gone\nMAC_NODE_TEST_CASE case=dc19 status=failed\n",
  );
});

test("macOS Node diagnostic maps document registration failure to one bounded ordinal", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "document-process-registration.test.ts",
    runDocumentProcessDiagnostic: async () => "dp51",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "MAC_NODE_TEST_CASE case=dp51 status=failed\n");
});

test("macOS Node diagnostic emits a bounded sequential-registration stage", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "document-process-registration.test.ts",
    runDocumentProcessDiagnostic: async () => "dp45",
    runDocumentSequentialDiagnostic: async () => "begin-closing",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "MAC_DOCUMENT_SEQUENTIAL stage=begin-closing\nMAC_NODE_TEST_CASE case=dp45 status=failed\n",
  );
});

test("macOS Node diagnostic isolates a sequential failure after cleanup completes", async () => {
  let output = "";
  let isolatedReruns = 0;
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "document-process-registration.test.ts",
    runDocumentProcessDiagnostic: async () => ({
      caseId: "dp45",
      failureKind: "test-timeout",
      testCodeReason: "async-activity",
      assertionOrigin: "register-root",
      stage: "cleanup-complete",
    }),
    runDocumentSequentialDiagnostic: async () => {
      isolatedReruns += 1;
      return { passed: true, stage: "cleanup-complete" };
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(isolatedReruns, 1);
  assert.equal(
    output,
    "MAC_DOCUMENT_SEQUENTIAL stage=cleanup-complete\n"
      + "MAC_DOCUMENT_SEQUENTIAL_ISOLATED status=passed\n"
      + "MAC_DOCUMENT_SEQUENTIAL_FAILURE kind=test-timeout\n"
      + "MAC_DOCUMENT_SEQUENTIAL_TEST_CODE reason=async-activity\n"
      + "MAC_DOCUMENT_SEQUENTIAL_ASSERTION origin=register-root\n"
      + "MAC_NODE_TEST_CASE case=dp45 status=failed\n",
  );
});

test("macOS Node diagnostic distinguishes a passing document-registration rerun", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "document-process-registration.test.ts",
    runDocumentProcessDiagnostic: async () => ({ caseId: "document-rerun-passed" }),
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "MAC_NODE_TEST_CASE case=document-rerun-passed status=failed\n",
  );
});

test("Windows source diagnostic reports only an allowlisted output-budget case", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "output-budget-atomicity.test.ts",
    runOutputBudgetAtomicityDiagnostic: async () => "ob05",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_NODE_TEST_CASE case=ob05 status=failed\n");
});

test("output-budget diagnostic rejects a non-allowlisted case identifier", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "output-budget-atomicity.test.ts",
    runOutputBudgetAtomicityDiagnostic: async () => "ob16/private-path",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_NODE_TEST_CASE case=output-budget-aggregate status=failed\n");
  assert.doesNotMatch(output, /private-path/u);
});

test("macOS Node diagnostic preserves the first document-registration receipt without rerunning", async () => {
  let output = "";
  let reruns = 0;
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async () => true,
    runDocumentFile: async () => ({ passed: false, caseId: "dp45", stage: "closed-1" }),
    runDocumentProcessDiagnostic: async () => {
      reruns += 1;
      return { passed: true, caseId: "document-rerun-passed" };
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(reruns, 0);
  assert.equal(
    output,
    "MAC_DOCUMENT_SEQUENTIAL stage=closed-1\nMAC_NODE_TEST_CASE case=dp45 status=failed\n",
  );
});

test("macOS Node diagnostic maps benchmark failure to one bounded ordinal", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "benchmark-policy.test.ts",
    runBenchmarkPolicyDiagnostic: async () => "bp17",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "MAC_NODE_TEST_CASE case=bp17 status=failed\n");
});

test("shared Node diagnostic maps MCP cancellation failure to one bounded ordinal", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "mcp-cancellation-progress.test.ts",
    runMcpCancellationProgressDiagnostic: async () => "mp10",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_NODE_TEST_CASE case=mp10 status=failed\n");
});

test("shared Node diagnostic emits one allowlisted preview cancellation failure stage", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "mcp-cancellation-progress.test.ts",
    runMcpCancellationProgressDiagnostic: async () => ({
      caseId: "mp03",
      completionKind: "test-failure",
      failureKind: "async-failure",
      testCodeReason: "async-activity",
      assertionOrigin: "test-body",
      runnerFailureKind: "runner-timeout",
      stage: "output-absence",
    }),
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "WINDOWS_MCP_PREVIEW_CANCELLATION stage=output-absence\n"
      + "WINDOWS_MCP_PREVIEW_CANCELLATION_FAILURE kind=async-failure\n"
      + "WINDOWS_MCP_PREVIEW_CANCELLATION_COMPLETION kind=test-failure\n"
      + "WINDOWS_MCP_PREVIEW_CANCELLATION_TEST_CODE reason=async-activity\n"
      + "WINDOWS_MCP_PREVIEW_CANCELLATION_ASSERTION origin=test-body\n"
      + "WINDOWS_MCP_PREVIEW_CANCELLATION_RUNNER kind=runner-timeout\n"
      + "WINDOWS_NODE_TEST_CASE case=mp03 status=failed\n",
  );
});

test("shared Node diagnostic redacts an unknown preview cancellation failure stage", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "mcp-cancellation-progress.test.ts",
    runMcpCancellationProgressDiagnostic: async () => ({
      caseId: "mp03",
      stage: "private/runner/secret",
    }),
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_NODE_TEST_CASE case=mp03 status=failed\n");
  assert.doesNotMatch(output, /private|runner|secret|[\\/]/u);
});

test("shared Node diagnostic maps Kordoc Core source failure to one bounded ordinal", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "kordoc-core-runtime.test.ts",
    runKordocCoreDiagnostic: async () => "kc07",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_NODE_TEST_CASE case=kc07 status=failed\n");
});

test("shared Node diagnostic emits the bounded Kordoc Core stage", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "kordoc-core-runtime.test.ts",
    runKordocCoreDiagnostic: async () => ({
      caseId: "kc01",
      stage: "second-build",
    }),
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "WINDOWS_KORDOC_CORE stage=second-build\n"
      + "WINDOWS_NODE_TEST_CASE case=kc01 status=failed\n",
  );
});

test("shared Node diagnostic emits the bounded Kordoc first-build stage", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "kordoc-core-runtime.test.ts",
    runKordocCoreDiagnostic: async () => ({
      caseId: "kc01",
      stage: "first-build-file-records",
    }),
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "WINDOWS_KORDOC_CORE stage=first-build-file-records\n"
      + "WINDOWS_NODE_TEST_CASE case=kc01 status=failed\n",
  );
});

test("shared Node diagnostic rejects an unknown Kordoc first-build stage", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "kordoc-core-runtime.test.ts",
    runKordocCoreDiagnostic: async () => ({
      caseId: "kc01",
      stage: "first-build-private-value",
    }),
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(output, "WINDOWS_NODE_TEST_CASE case=kc01 status=failed\n");
});

test("top-level TAP ordinal parser rejects nested, passing, and out-of-range lines", () => {
  assert.equal(failedTopLevelOrdinal("TAP version 13\nnot ok 19 - private\n# fail 1\n", 51), 19);
  assert.equal(failedTopLevelOrdinal("    not ok 3 - nested\n# fail 1\n", 51), undefined);
  assert.equal(failedTopLevelOrdinal("not ok 52 - outside\n# fail 1\n", 51), undefined);
  assert.equal(failedTopLevelOrdinal("not ok 19 - private\n# fail 0\n", 51), undefined);
});

test("top-level TAP failure parser exposes only fixed Node failure classes", () => {
  assert.equal(failedTopLevelFailureKind(
    "not ok 45 - private\n  failureType: 'testTimeoutFailure'\n# fail 1\n",
  ), "test-timeout");
  assert.equal(failedTopLevelFailureKind(
    "not ok 45 - private\n  failureType: 'hookFailed'\n# fail 1\n",
  ), "hook-failure");
  assert.equal(failedTopLevelFailureKind(
    "not ok 45 - private\n  failureType: 'testCodeFailure'\n# fail 1\n",
  ), "test-code");
  assert.equal(failedTopLevelFailureKind(
    "not ok 45 - private\n  failureType: 'PRIVATE/path'\n# fail 1\n",
  ), "unknown");
  assert.equal(failedTopLevelFailureKind(
    "ok 45 - private\n  failureType: 'testTimeoutFailure'\n# fail 0\n",
  ), undefined);
});

test("Node TAP completion classifier exposes only fixed bounded outcomes", () => {
  const clean = "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n";
  assert.equal(classifyNodeTestCompletion(clean, 0, null), "passed");
  assert.equal(classifyNodeTestCompletion(clean, 1, null), "nonzero-clean-tap");
  assert.equal(classifyNodeTestCompletion(
    "not ok 1 - private\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n",
    1,
    null,
  ), "test-failure");
  assert.equal(classifyNodeTestCompletion("PRIVATE/path", 1, null), "invalid-summary");
  assert.equal(classifyNodeTestCompletion(clean, null, "SIGKILL"), "child-signal");
});

test("Node test-code parser exposes only fixed non-content reasons", () => {
  assert.equal(failedTopLevelTestCodeReason(
    "not ok 45 - private\n  failureType: 'testCodeFailure'\n  code: 'ERR_ASSERTION'\n# fail 1\n",
  ), "assertion");
  assert.equal(failedTopLevelTestCodeReason(
    "not ok 45 - private\n  failureType: 'testCodeFailure'\n# Warning: generated asynchronous activity after the test ended\n# fail 1\n",
  ), "async-activity");
  assert.equal(failedTopLevelTestCodeReason(
    "not ok 45 - private\n  failureType: 'testCodeFailure'\n  code: 'ERR_TEST_FAILURE'\n# fail 1\n",
  ), "test-failure");
  assert.equal(failedTopLevelTestCodeReason(
    "not ok 45 - private\n  failureType: 'testTimeoutFailure'\n  code: 'ERR_TEST_FAILURE'\n# fail 1\n",
  ), undefined);
});

test("macOS Node diagnostic reports the fixed aggregate id when every compact-runtime case passes alone", async () => {
  let output = "";
  let cases = 0;
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "compact-runtime.test.ts",
    runCompactRuntimeCase: async () => { cases += 1; return true; },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(cases, 37);
  assert.equal(output, "MAC_NODE_TEST_CASE case=compact-runtime-aggregate status=failed\n");
});

test("Windows source diagnostic accepts only the POSIX compact-runtime capability skip", async () => {
  let cr13AllowAllSkipped;
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async (file) => file !== "compact-runtime.test.ts",
    runCompactRuntimeCase: async (record) => {
      if (record.id === "cr13") cr13AllowAllSkipped = record.allowAllSkipped;
      return record.id !== "cr14";
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(cr13AllowAllSkipped, true);
  assert.equal(output, "WINDOWS_NODE_TEST_CASE case=cr14 status=failed\n");
});

test("macOS Node diagnostic emits one bounded compact-runtime stage for cr36", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "compact-runtime.test.ts",
    runCompactRuntimeCase: async (record) => record.id !== "cr36",
    runCompactRuntimeDiagnostic: async () => "node-modules-measure",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "MAC_COMPACT_RUNTIME stage=node-modules-measure\nMAC_NODE_TEST_CASE case=cr36 status=failed\n",
  );
});

test("macOS compact-runtime diagnostic accepts the fixed installed-tree link stage", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "compact-runtime.test.ts",
    runCompactRuntimeCase: async (record) => record.id !== "cr36",
    runCompactRuntimeDiagnostic: async () => "installed-tree-link-allowed",
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "MAC_COMPACT_RUNTIME stage=installed-tree-link-allowed\nMAC_NODE_TEST_CASE case=cr36 status=failed\n",
  );
});

test("macOS compact-runtime diagnostic redacts invalid stage values", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "compact-runtime.test.ts",
    runCompactRuntimeCase: async (record) => record.id !== "cr36",
    runCompactRuntimeDiagnostic: async () =>
      `C:\\private ${["AWS", "_SECRET_ACCESS_KEY=value"].join("")}`,
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "MAC_COMPACT_RUNTIME stage=diagnostic-failed\nMAC_NODE_TEST_CASE case=cr36 status=failed\n",
  );
});

test("source Node diagnostic uses the fixed Windows receipt prefix only when requested", async () => {
  let output = "";
  const passed = await runMacNodeTestsDiagnostic({
    receiptPrefix: "WINDOWS",
    runFile: async () => true,
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, true);
  assert.equal(output, "WINDOWS_NODE_TEST_FILES status=passed files=41\n");
});

test("bounded Node runner returns only an allowlisted fixed failure diagnostic", async () => {
  let observed;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end("TAP version 13\n  error: 'KORDOC_DEFAULT_BUILD'\n# fail 1\n");
    child.emit("close", 1, null);
  });
  const passed = await executeBoundedNodeTestFile("fixture.test.mjs", {
    repository: true,
    spawnProcess: () => child,
    fixedDiagnostics: ["KORDOC_DEFAULT_BUILD", "KORDOC_DEFAULT_CLEANUP"],
    onFixedDiagnostic: (value) => { observed = value; },
  });
  assert.equal(passed, false);
  assert.equal(observed, "KORDOC_DEFAULT_BUILD");
});

test("bounded Node runner returns the last allowlisted fixed progress diagnostic", async () => {
  let observed;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end([
      "TAP version 13",
      "not ok 1 - fixed diagnostic probe",
      "# DOCUMENT_SEQUENTIAL_STAGE_CLOSE",
      "# DOCUMENT_SEQUENTIAL_STAGE_SEAL",
      "# fail 1",
      "",
    ].join("\n"));
    child.emit("close", 1, null);
  });
  const passed = await executeBoundedNodeTestFile("fixture.test.mjs", {
    repository: true,
    spawnProcess: () => child,
    fixedProgressDiagnostics: [
      "DOCUMENT_SEQUENTIAL_STAGE_CLOSE",
      "DOCUMENT_SEQUENTIAL_STAGE_SEAL",
    ],
    onFixedProgressDiagnostic: (value) => { observed = value; },
  });
  assert.equal(passed, false);
  assert.equal(observed, "DOCUMENT_SEQUENTIAL_STAGE_SEAL");
});

test("bounded Node runner classifies invalid stdout without exposing content", async () => {
  let runnerFailureKind;
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  queueMicrotask(() => child.stdout.emit("data", "PRIVATE/path"));
  const passed = await executeBoundedNodeTestFile("fixture.test.mjs", {
    repository: true,
    spawnProcess: () => child,
    terminateTree: () => {
      child.emit("close", null, "SIGKILL");
      return true;
    },
    closeTimeoutMs: 25,
    onRunnerFailureKind: (value) => { runnerFailureKind = value; },
  });
  assert.equal(passed, false);
  assert.equal(runnerFailureKind, "invalid-chunk");
});

test("bounded Node runner reports definitive failure after provisional progress", async () => {
  const observed = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end([
      "TAP version 13",
      "not ok 1 - fixed diagnostic probe",
      "# DOCUMENT_SEQUENTIAL_STAGE_TERMINATE_COMPLETE",
      "  error: 'DOCUMENT_SEQUENTIAL_CLOSED_1'",
      "# fail 1",
      "",
    ].join("\n"));
    child.emit("close", 1, null);
  });
  await executeBoundedNodeTestFile("fixture.test.mjs", {
    repository: true,
    spawnProcess: () => child,
    fixedDiagnostics: ["DOCUMENT_SEQUENTIAL_CLOSED_1"],
    onFixedDiagnostic: (value) => { observed.push(`failure:${value}`); },
    fixedProgressDiagnostics: ["DOCUMENT_SEQUENTIAL_STAGE_TERMINATE_COMPLETE"],
    onFixedProgressDiagnostic: (value) => { observed.push(`progress:${value}`); },
  });
  assert.deepEqual(observed, [
    "progress:DOCUMENT_SEQUENTIAL_STAGE_TERMINATE_COMPLETE",
    "failure:DOCUMENT_SEQUENTIAL_CLOSED_1",
  ]);
});

test("macOS Node diagnostic accepts all-skipped TAP only for the fixed Windows-only assets case", async () => {
  let output = "";
  let call = 0;
  const argsSeen = [];
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "assets.test.ts",
    spawnProcess(_command, args) {
      call += 1;
      argsSeen.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(call === 6
          ? "TAP version 13\n1..17\n# tests 17\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 17\n"
          : "TAP version 13\n1..17\n# tests 17\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 16\n");
        child.emit("close", 0, null);
      });
      return child;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(call, 17);
  assert.equal(argsSeen.every((args) => args.some(
    (value) => value.startsWith("--test-name-pattern=^"),
  )), true);
  assert.equal(output, "MAC_NODE_TEST_CASE case=assets-aggregate status=failed\n");
});

test("macOS Node diagnostic rejects all-skipped TAP for a non-capability assets case", async () => {
  let output = "";
  let call = 0;
  const passed = await runMacNodeTestsDiagnostic({
    runFile: async (file) => file !== "assets.test.ts",
    spawnProcess() {
      call += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end("TAP version 13\n1..17\n# tests 17\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 17\n");
        child.emit("close", 0, null);
      });
      return child;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(call, 1);
  assert.equal(output, "MAC_NODE_TEST_CASE case=as01 status=failed\n");
});

test("macOS Node diagnostic accepts all-skipped TAP only for the two fixed UNC capability cases", async () => {
  let output = "";
  const argsSeen = [];
  let call = 0;
  const passed = await runMacNodeTestsDiagnostic({
    spawnProcess(_command, args) {
      call += 1;
      argsSeen.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        const caseIndex = call - 1;
        if (call === 1) {
          child.stdout.end("TAP version 13\n1..18\n# tests 18\n# pass 17\n# fail 1\n# cancelled 0\n# skipped 0\n");
          child.emit("close", 1, null);
          return;
        }
        if (caseIndex === 10 || caseIndex === 11) {
          child.stdout.end("TAP version 13\n1..18\n# tests 18\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 18\n");
        } else {
          child.stdout.end("TAP version 13\n1..18\n# tests 18\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 17\n");
        }
        child.emit("close", 0, null);
      });
      return child;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(call, 19);
  assert.equal(argsSeen.slice(1).every((args) => args.some(
    (value) => value.startsWith("--test-name-pattern=^allowed roots:"),
  )), true);
  assert.equal(output, "MAC_NODE_TEST_CASE case=allowed-roots-aggregate status=failed\n");
});

test("macOS Node diagnostic rejects all-skipped TAP for a non-capability case", async () => {
  let output = "";
  let call = 0;
  const passed = await runMacNodeTestsDiagnostic({
    spawnProcess() {
      call += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(call === 1
          ? "TAP version 13\n1..18\n# tests 18\n# pass 17\n# fail 1\n# cancelled 0\n# skipped 0\n"
          : "TAP version 13\n1..18\n# tests 18\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 18\n");
        child.emit("close", call === 1 ? 1 : 0, null);
      });
      return child;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(call, 2);
  assert.equal(output, "MAC_NODE_TEST_CASE case=ar01 status=failed\n");
});
