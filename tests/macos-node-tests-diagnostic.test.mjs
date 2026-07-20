import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runMacNodeTestsDiagnostic } from "../scripts/macos-node-tests-diagnostic.mjs";

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
  assert.equal(output, "MAC_NODE_TEST_CASE case=aggregate status=failed\n");
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
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.deepEqual(cases, ["as01", "as02", "as03"]);
  assert.equal(output, "MAC_NODE_TEST_CASE case=as03 status=failed\n");
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
  assert.equal(output, "MAC_NODE_TEST_CASE case=aggregate status=failed\n");
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
  assert.equal(output, "MAC_NODE_TEST_CASE case=aggregate status=failed\n");
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
  assert.equal(output, "MAC_NODE_TEST_CASE case=aggregate status=failed\n");
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
