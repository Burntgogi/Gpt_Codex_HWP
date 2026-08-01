import assert from "node:assert/strict";
import test from "node:test";

import { createMcpServer } from "../src/mcp-main.js";
import {
  getSharp,
  inspectSharpRuntimeForTests,
  resetSharpRuntimeForTests,
  setSharpImporterForTests,
} from "../src/shared/sharp-runtime.js";

test("MCP registration leaves the Sharp runtime unloaded", () => {
  resetSharpRuntimeForTests();
  createMcpServer();
  assert.deepEqual(inspectSharpRuntimeForTests(), {
    loadCount: 0,
    configured: false,
  });
});

test("concurrent first image operations share one bounded Sharp runtime", async () => {
  resetSharpRuntimeForTests();
  const [first, second] = await Promise.all([getSharp(), getSharp()]);

  assert.equal(first, second);
  assert.deepEqual(inspectSharpRuntimeForTests(), {
    loadCount: 1,
    configured: true,
  });
  assert.equal(first.concurrency(), 1);
  assert.equal(first.cache().memory.max, 0);
  assert.equal(first.cache().files.max, 0);
  assert.equal(first.cache().items.max, 0);
});

test("a Sharp loader failure is bounded and cached", async (t) => {
  let attempts = 0;
  resetSharpRuntimeForTests();
  setSharpImporterForTests(async () => {
    attempts += 1;
    throw new Error("private loader detail");
  });
  t.after(() => resetSharpRuntimeForTests());

  await assert.rejects(getSharp(), {
    name: "SharpRuntimeUnavailableError",
    message: "Image processing runtime is unavailable.",
  });
  await assert.rejects(getSharp(), {
    name: "SharpRuntimeUnavailableError",
    message: "Image processing runtime is unavailable.",
  });
  assert.equal(attempts, 1);
  assert.deepEqual(inspectSharpRuntimeForTests(), {
    loadCount: 1,
    configured: false,
  });
});
