import assert from "node:assert/strict";
import test from "node:test";

const sourceRunner = await import("../scripts/source-node-tests-isolated.mjs").catch(() => ({}));

test("source Node test entrypoint exposes the isolated fixed-inventory runner", () => {
  assert.equal(typeof sourceRunner.runSourceNodeTestsIsolated, "function");
});

test("source Node test entrypoint delegates all 41 files to the bounded runner", async () => {
  const files = [];
  let output = "";
  let exitCode;

  const passed = await sourceRunner.runSourceNodeTestsIsolated({
    runFile: async (file) => { files.push(file); return true; },
    stdout: { write: (value) => { output += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, true);
  assert.equal(files.length, 41);
  assert.equal(new Set(files).size, 41);
  assert.equal(output, "SOURCE_NODE_TEST_FILES status=passed files=41\n");
  assert.equal(exitCode, 0);
});
