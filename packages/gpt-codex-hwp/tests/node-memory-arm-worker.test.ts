import assert from "node:assert/strict";
import test from "node:test";

import { validateArmWorkerSpec } from "../benchmarks/node-memory-arm-worker.mjs";

const MCP_PATH = "C:\\runtime\\dist\\mcp.js";

test("arm worker accepts only the exact private launch contract", () => {
  const spec = {
    schemaVersion: 1,
    arm: "candidate",
    pair: 1,
    sessionCount: 1,
    mcpPath: MCP_PATH,
    nodeArgs: ["--max-semi-space-size=1"],
  };
  assert.deepEqual(validateArmWorkerSpec(spec), spec);
  assert.throws(
    () => validateArmWorkerSpec({ ...spec, nodeArgs: ["--max-old-space-size=32"] }),
    /ARM_WORKER_SPEC_INVALID/u,
  );
  assert.throws(
    () => validateArmWorkerSpec({ ...spec, mcpPath: "relative/mcp.js" }),
    /ARM_WORKER_SPEC_INVALID/u,
  );
  assert.throws(
    () => validateArmWorkerSpec({ ...spec, outputPath: "C:\\private\\receipt.json" }),
    /ARM_WORKER_SPEC_INVALID/u,
  );
});

test("control arm rejects candidate-only V8 flags", () => {
  assert.throws(
    () => validateArmWorkerSpec({
      schemaVersion: 1,
      arm: "control",
      pair: 1,
      sessionCount: 1,
      mcpPath: MCP_PATH,
      nodeArgs: ["--max-semi-space-size=1"],
    }),
    /ARM_WORKER_SPEC_INVALID/u,
  );
});
