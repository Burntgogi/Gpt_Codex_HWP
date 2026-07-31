import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { runBenchmarkArm } from "./mcp-idle-memory.mjs";

if (process.argv.length !== 4 || process.argv[2] !== "--mcp"
  || !isAbsolute(process.argv[3])) {
  process.stderr.write("usage: node node-memory-arm-smoke.mjs --mcp <absolute-dist-mcp.js>\n");
  process.exitCode = 2;
} else {
  try {
    await access(process.argv[3]);
    const measurement = await runBenchmarkArm({
      arm: "candidate",
      pair: 1,
      sessionCount: 1,
      mcpPath: process.argv[3],
      nodeArgs: ["--max-semi-space-size=1"],
    });
    process.stdout.write(
      `NODE_MEMORY_ARM_SMOKE_OK tools=${measurement.toolCount} observed=${measurement.cleanup.observedIdentityCount} remaining=${measurement.cleanup.remainingIdentityCount} maxIntervalMs=${measurement.result.samplingTiming.actualIntervalMaxMs}\n`,
    );
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.message)
      ? error.message
      : "NODE_MEMORY_ARM_SMOKE_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
