import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const mode = process.env.ARM_FIXTURE_MODE;
const armSpecPath = process.env.GPT_CODEX_HWP_ARM_SPEC;

if (typeof armSpecPath === "string" && armSpecPath.length > 0) {
  const spec = JSON.parse(await readFile(armSpecPath, "utf8"));
  const bytes = spec.sessionCount * 1_000_000;
  const summary = { median: bytes, p95: bytes, min: bytes, max: bytes };
  const receipt = {
    schemaVersion: 1,
    status: "ok",
    toolCount: 9,
    toolContractSha256: "a".repeat(64),
    unexpectedStderrBytes: 0,
    remainingDescendants: 0,
    cleanup: { observedIdentityCount: spec.sessionCount, remainingIdentityCount: 0 },
    result: {
      pair: spec.pair,
      arm: spec.arm,
      sessionCount: spec.sessionCount,
      rssBytes: summary,
      privateBytes: summary,
      descendantCount: { median: 0, p95: 0, min: 0, max: 0 },
      settling: { requestedMs: 5_000, actualMs: 5_000 },
      samplingTiming: {
        actualIntervalMedianMs: 100,
        actualIntervalP95Ms: 100,
        actualIntervalMaxMs: 100,
        durationMs: 5_900,
      },
    },
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} else if (mode === "ok") {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "ok" })}\n`, () => process.exit(0));
} else if (mode === "late-stderr") {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "ok" })}\n`, () => {
    process.stderr.write("x", () => process.exit(0));
  });
} else if (mode === "two-frames") {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "ok" })}\n`);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "extra" })}\n`, () => process.exit(0));
} else if (mode === "hang-with-child") {
  const statePath = process.env.ARM_FIXTURE_STATE;
  if (typeof statePath !== "string" || statePath.length === 0) process.exit(80);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  await writeFile(statePath, `${JSON.stringify({ rootPid: process.pid, childPid: child.pid })}\n`, "utf8");
  setInterval(() => {}, 1_000);
} else {
  process.exit(81);
}
