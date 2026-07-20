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
  assert.equal(output, "MAC_NODE_TEST_FILE file=allowed-roots.test.ts status=failed\n");
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
