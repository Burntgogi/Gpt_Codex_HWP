import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "compatibility-gate.mjs");
const gate = await import("../scripts/compatibility-gate.mjs").catch(() => ({}));

function capture(args) {
  let stdout = "";
  let stderr = "";
  let exitCode;
  const result = gate.runCompatibilityGateCli({
    args,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    setExitCode: (value) => { exitCode = value; },
  });
  return { result, stdout, stderr, exitCode };
}

test("compatibility gate accepts only the complete desktop and Linux success grammars", () => {
  assert.equal(typeof gate.runCompatibilityGateCli, "function");
  assert.deepEqual(capture([
    "--require", "large=success",
    "--require", "receipt=success",
  ]), {
    result: { passed: true, requirementCount: 2 },
    stdout: "COMPATIBILITY_GATE_PASSED requirements=2\n",
    stderr: "",
    exitCode: 0,
  });
  assert.deepEqual(capture([
    "--require", "node=success",
    "--require", "python=success",
    "--require", "large=success",
  ]), {
    result: { passed: true, requirementCount: 3 },
    stdout: "COMPATIBILITY_GATE_PASSED requirements=3\n",
    stderr: "",
    exitCode: 0,
  });
});

test("compatibility gate fails closed for every non-success step outcome", () => {
  for (const outcome of ["failure", "cancelled", "skipped", "timed_out", "unknown"]) {
    const desktop = capture([
      "--require", `large=${outcome}`,
      "--require", "receipt=success",
    ]);
    assert.deepEqual(desktop, {
      result: { passed: false, requirementCount: 2 },
      stdout: "",
      stderr: "COMPATIBILITY_GATE_FAILED\n",
      exitCode: 1,
    }, outcome);
    assert.doesNotMatch(desktop.stderr, new RegExp(outcome, "u"), outcome);
  }

  for (const position of ["node", "python", "large"]) {
    const args = [
      "--require", "node=success",
      "--require", "python=success",
      "--require", "large=success",
    ];
    const index = args.findIndex((value) => value.startsWith(`${position}=`));
    args[index] = `${position}=failure`;
    assert.equal(capture(args).exitCode, 1, position);
  }
});

test("compatibility gate rejects incomplete, reordered, duplicate, or hostile grammars", () => {
  const hostile = "opaque-private-token";
  const cases = [
    [],
    ["--require", "large=success"],
    ["--require", "receipt=success", "--require", "large=success"],
    ["--require", "large=success", "--require", "large=success"],
    ["--require", "node=success", "--require", "large=success", "--require", "python=success"],
    ["--require", "node=success", "--require", "python=success"],
    ["--require", "large=success", "--require", "receipt=success", "extra"],
    ["--require", "extra=success", "--require", "receipt=success"],
    ["--require", "large=SUCCESS", "--require", "receipt=success"],
    ["--require", "large=", "--require", "receipt=success"],
    ["--require", "large=success\nsecret", "--require", "receipt=success"],
    ["--require", "large=../private/document.hwpx", "--require", "receipt=success"],
    ["--require", "large=success || true", "--require", "receipt=success"],
    ["--require", "large=success;exit0", "--require", "receipt=success"],
    ["--require", "large=success&&true", "--require", "receipt=success"],
    ["--require", `large=${hostile.repeat(8)}`, "--require", "receipt=success"],
    ["--require=large=success", "--require", "receipt=success"],
  ];
  for (const args of cases) {
    const captured = capture(args);
    assert.deepEqual(captured, {
      result: undefined,
      stdout: "",
      stderr: "COMPATIBILITY_GATE_USAGE\n",
      exitCode: 2,
    }, JSON.stringify(args));
    assert.doesNotMatch(captured.stderr, /opaque|private|document|secret/iu);
    assert.ok(Buffer.byteLength(captured.stderr) <= 64);
  }
});

test("compatibility gate treats explicit non-array inputs as usage errors", () => {
  for (const args of [null, {}, "large=success"]) {
    assert.throws(
      () => gate.parseCompatibilityGateArguments(args),
      { code: "COMPATIBILITY_GATE_USAGE" },
    );
  }

  const originalArgv = process.argv;
  try {
    process.argv = [process.execPath, SCRIPT,
      "--require", "large=success",
      "--require", "receipt=success"];
    for (const args of [null, {}, "large=success"]) {
      assert.deepEqual(capture(args), {
        result: undefined,
        stdout: "",
        stderr: "COMPATIBILITY_GATE_USAGE\n",
        exitCode: 2,
      });
    }
  } finally {
    process.argv = originalArgv;
  }
});

test("compatibility argument parser returns only a frozen bounded decision", () => {
  assert.equal(typeof gate.parseCompatibilityGateArguments, "function");
  const parsed = gate.parseCompatibilityGateArguments([
    "--require", "large=success",
    "--require", "receipt=failure",
  ]);
  assert.deepEqual(parsed, { passed: false, requirementCount: 2 });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(JSON.stringify(parsed).includes("failure"), false);
});

test("compatibility gate executable uses the same fixed redacted contract", () => {
  const passed = spawnSync(process.execPath, [
    SCRIPT,
    "--require", "large=success",
    "--require", "receipt=success",
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "COMPATIBILITY_GATE_PASSED requirements=2\n");
  assert.equal(passed.stderr, "");

  const failed = spawnSync(process.execPath, [
    SCRIPT,
    "--require", "large=opaque-private-token",
    "--require", "receipt=success",
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "COMPATIBILITY_GATE_FAILED\n");
  assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /opaque|private|token/iu);
});
