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
    runFile: async (file, options) => {
      options.onSpawn();
      files.push(file);
      return true;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, true);
  assert.equal(files.length, 41);
  assert.equal(new Set(files).size, 41);
  assert.equal(
    output,
    "SOURCE_NODE_TEST_FILES status=passed files=41\n"
      + "SOURCE_NODE_TEST_PROFILE profile=full executedFileCount=41 deferredCaseCount=0 failed=0\n",
  );
  assert.equal(exitCode, 0);
});

test("source Node PR profile defers only the exact installed-runtime stress", async () => {
  const optionsByFile = new Map();
  let output = "";
  const passed = await sourceRunner.runSourceNodeTestsIsolated({
    profile: "pr",
    runFile: async (file, options) => {
      options.onSpawn();
      optionsByFile.set(file, options);
      return true;
    },
    stdout: { write: (value) => { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, true);
  assert.equal(
    optionsByFile.get("compact-runtime.test.ts").testSkipPattern,
    "^installed runtime verifies provenance, npm ls, and all nine tools$",
  );
  assert.equal(optionsByFile.get("benchmark-policy.test.ts").testSkipPattern, undefined);
  assert.match(output, /profile=pr executedFileCount=41 deferredCaseCount=1 failed=0/u);
});
