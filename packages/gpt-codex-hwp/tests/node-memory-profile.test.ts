import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_V8_FLAGS,
  CONTROL_V8_FLAGS,
  shouldAdoptV8Profile,
} from "../benchmarks/mcp-idle-memory.mjs";

test("semi-space-only recovery candidate preserves default old-space capacity", () => {
  assert.deepEqual(CONTROL_V8_FLAGS, []);
  assert.deepEqual(CANDIDATE_V8_FLAGS, ["--max-semi-space-size=1"]);
});

test("V8 profile adoption requires safe function and performance gates", () => {
  assert.equal(shouldAdoptV8Profile({
    functionalPass: true,
    oomDetected: false,
    privateReduction: 0.10,
    performanceRegression: 0.15,
  }), true);
  assert.equal(shouldAdoptV8Profile({
    functionalPass: true,
    oomDetected: false,
    privateReduction: 0.099,
    performanceRegression: 0,
  }), false);
  assert.equal(shouldAdoptV8Profile({
    functionalPass: false,
    oomDetected: false,
    privateReduction: 0.20,
    performanceRegression: 0,
  }), false);
  assert.equal(shouldAdoptV8Profile({
    functionalPass: true,
    oomDetected: true,
    privateReduction: 0.20,
    performanceRegression: 0,
  }), false);
  assert.equal(shouldAdoptV8Profile({
    functionalPass: true,
    oomDetected: false,
    privateReduction: 0.20,
    performanceRegression: 0.151,
  }), false);
});
