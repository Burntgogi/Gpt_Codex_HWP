import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_RELEASE_STAGES,
  runCli,
  runReleaseVerification,
  runStageCommand,
  terminateProcessTree,
} from "../scripts/release-verify.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_SHA256 =
  "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd";
const EXPECTED_STAGES = [
  "metadata",
  "build",
  "node-tests",
  "python-tests",
  "real-hwp",
  "hwpx-roundtrip",
  "nine-tools",
  "kordoc-provenance",
  "production-dependencies",
  "audit",
  "privacy",
  "runtime-diff",
  "release-artifacts",
];
const VERSIONS = Object.freeze({
  node: "v22.22.2",
  npm: "10.9.7",
  python: "3.12.0",
});

test("release verification package scripts use the exact public entry points", async () => {
  const rootPackage = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const sourcePackage = JSON.parse(await readFile(
    join(ROOT, "packages", "gpt-codex-hwp", "package.json"),
    "utf8",
  ));

  assert.equal(rootPackage.scripts["release:verify"], "node scripts/release-verify.mjs");
  assert.equal(
    rootPackage.scripts["verify:compact-runtime"],
    "node packages/gpt-codex-hwp/release-scripts/verify-compact-runtime.mjs",
  );
  assert.equal(sourcePackage.scripts.build, "tsc -p tsconfig.json");
  assert.equal(sourcePackage.scripts.test, "node --import tsx --test --test-concurrency=1 tests/*.test.ts");
  assert.equal(sourcePackage.scripts["test:python"], "python -m unittest scripts.hwpx-safe-edit.test_hwpx_safe_edit");
  assert.equal(
    sourcePackage.scripts["verify:compact-runtime"],
    "node release-scripts/verify-compact-runtime.mjs",
  );
});

test("release verification runs the exact required stage contract in order", async () => {
  const calls = [];
  const receipt = await runReleaseVerification({
    root: ROOT,
    platform: "test-platform",
    arch: "test-arch",
    versions: VERSIONS,
    resolveFixture: async () => ({ sha256: FIXTURE_SHA256 }),
    runStage: async (stage) => {
      calls.push(stage);
      return { status: "passed" };
    },
  });

  assert.deepEqual(REQUIRED_RELEASE_STAGES, EXPECTED_STAGES);
  assert.equal(Object.isFrozen(REQUIRED_RELEASE_STAGES), true);
  assert.deepEqual(calls.map((stage) => stage.name), EXPECTED_STAGES);
  assert.ok(calls.every((stage) => stage.cwd === ROOT));
  assert.deepEqual(
    calls.map(({ name, tool, args, env, evidence }) => ({
      name,
      tool,
      args,
      env,
      evidence,
    })),
    expectedStageCommands(),
  );
  assert.deepEqual(Object.keys(receipt), [
    "schemaVersion",
    "status",
    "platform",
    "arch",
    "node",
    "npm",
    "python",
    "stages",
    "toolCount",
    "fixtureSha256",
  ]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.platform, "test-platform");
  assert.equal(receipt.arch, "test-arch");
  assert.equal(receipt.node, VERSIONS.node);
  assert.equal(receipt.npm, VERSIONS.npm);
  assert.equal(receipt.python, VERSIONS.python);
  assert.equal(receipt.toolCount, 9);
  assert.equal(receipt.fixtureSha256, FIXTURE_SHA256);
  assert.deepEqual(receipt.stages.map(({ name, status }) => ({ name, status })),
    EXPECTED_STAGES.map((name) => ({ name, status: "passed" })));
  assert.ok(receipt.stages.every((stage) =>
    Number.isInteger(stage.elapsedMs) && stage.elapsedMs >= 0));
});

for (const failure of [
  { label: "skipped", result: { status: "skipped" }, expectedStatus: "skipped" },
  { label: "missing", result: undefined, expectedStatus: "failed" },
  {
    label: "nonzero",
    result: { status: "failed", code: 9, stdout: "private document", stderr: "private path" },
    expectedStatus: "failed",
  },
]) {
  test(`release verification fails closed for a ${failure.label} stage`, async () => {
    const calls = [];
    const failAt = 4;
    const receipt = await runReleaseVerification({
      root: ROOT,
      platform: "test-platform",
      arch: "test-arch",
      versions: VERSIONS,
      resolveFixture: async () => ({ sha256: FIXTURE_SHA256 }),
      runStage: async (stage) => {
        calls.push(stage.name);
        return calls.length === failAt ? failure.result : { status: "passed" };
      },
    });

    assert.equal(receipt.status, "failed");
    assert.deepEqual(calls, EXPECTED_STAGES.slice(0, failAt));
    assert.equal(receipt.stages.length, failAt);
    assert.equal(receipt.stages.at(-1).status, failure.expectedStatus);
    assert.equal(receipt.stages.some((stage) => stage.name === "real-hwp"), false);
  });
}

test("release verification redacts command output, document data, paths, and environment", async () => {
  const forbidden = [
    "PRIVATE_STDOUT",
    "PRIVATE_STDERR",
    "DOCUMENT_BODY",
    "PRIVATE_WORKSPACE_PATH",
    "PRIVATE_ENV_VALUE",
  ];
  const receipt = await runReleaseVerification({
    root: "PRIVATE_WORKSPACE_PATH",
    platform: "test-platform",
    arch: "test-arch",
    versions: VERSIONS,
    resolveFixture: async () => ({ sha256: FIXTURE_SHA256 }),
    runStage: async () => ({
      status: "passed",
      stdout: "PRIVATE_STDOUT DOCUMENT_BODY",
      stderr: "PRIVATE_STDERR",
      path: "PRIVATE_WORKSPACE_PATH",
      env: { TOKEN: "PRIVATE_ENV_VALUE" },
    }),
  });
  const serialized = JSON.stringify(receipt);

  for (const value of forbidden) assert.equal(serialized.includes(value), false);
  for (const forbiddenKey of ["stdout", "stderr", "command", "args", "cwd", "env", "document"] ) {
    assert.equal(serialized.includes(`\"${forbiddenKey}\"`), false);
  }
});

test("release verification converts runner exceptions to a redacted failure", async () => {
  const secret = "PRIVATE_THROWN_STAGE_DETAIL";
  const receipt = await runReleaseVerification({
    root: ROOT,
    platform: "test-platform",
    arch: "test-arch",
    versions: VERSIONS,
    resolveFixture: async () => ({ sha256: FIXTURE_SHA256 }),
    runStage: async () => {
      throw new Error(secret);
    },
  });

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.stages.length, 1);
  assert.equal(receipt.stages[0].status, "failed");
  assert.equal(JSON.stringify(receipt).includes(secret), false);
});

test("release verification CLI emits only the receipt and exits nonzero on failure", async () => {
  const failedReceipt = Object.freeze({
    schemaVersion: 1,
    status: "failed",
    platform: "test-platform",
    arch: "test-arch",
    node: VERSIONS.node,
    npm: VERSIONS.npm,
    python: VERSIONS.python,
    stages: Object.freeze([
      Object.freeze({ name: "metadata", status: "failed", elapsedMs: 1 }),
    ]),
    toolCount: 9,
    fixtureSha256: FIXTURE_SHA256,
  });
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  await runCli({
    runVerification: async () => failedReceipt,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    setExitCode: (code) => { exitCode = code; },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout), failedReceipt);
  assert.equal(stderr, "");
});

test("release verification CLI redacts unexpected failures and exits nonzero", async () => {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  await runCli({
    runVerification: async () => {
      throw new Error("PRIVATE_UNEXPECTED_FAILURE");
    },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    setExitCode: (code) => { exitCode = code; },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /^RELEASE_VERIFY_FAILED\n$/u);
  assert.equal(stderr.includes("PRIVATE_UNEXPECTED_FAILURE"), false);
});

test("stage command execution is fail-closed and never returns process output", async () => {
  const passed = await runStageCommand(nodeStage("pass", ""), {
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
  });
  assert.deepEqual(passed, { status: "passed" });

  const failed = await runStageCommand(
    nodeStage(
      "nonzero",
      'process.stdout.write("PRIVATE_STDOUT"); process.stderr.write("PRIVATE_STDERR"); process.exit(7);',
    ),
    { timeoutMs: 2_000, maxOutputBytes: 1_024 },
  );
  assert.deepEqual(failed, { status: "failed" });
  assert.equal(JSON.stringify(failed).includes("PRIVATE_"), false);
});

test("stage command execution enforces output and timeout bounds", async () => {
  const excessiveOutput = await runStageCommand(
    nodeStage("output-bound", 'process.stdout.write("x".repeat(4096));'),
    { timeoutMs: 2_000, maxOutputBytes: 64 },
  );
  assert.deepEqual(excessiveOutput, { status: "failed" });

  const started = Date.now();
  const timedOut = await runStageCommand(
    nodeStage("timeout", "setInterval(() => {}, 1000);"),
    { timeoutMs: 100, maxOutputBytes: 1_024 },
  );
  assert.deepEqual(timedOut, { status: "failed" });
  assert.ok(Date.now() - started < 5_000);
});

test("Windows process-tree termination bounds taskkill and falls back", async (t) => {
  for (const scenario of ["spawn-throw", "spawn-error", "nonzero", "timeout"]) {
    await t.test(scenario, async () => {
      const fallbackSignals = [];
      const killerSignals = [];
      const killerUnrefs = [];
      const childUnrefs = [];
      const destroyedStreams = [];
      const killer = new EventEmitter();
      killer.kill = (signal) => {
        killerSignals.push(signal);
        return true;
      };
      killer.unref = () => killerUnrefs.push("unref");
      const child = {
        pid: 4242,
        stdout: { destroy: () => destroyedStreams.push("stdout") },
        stderr: { destroy: () => destroyedStreams.push("stderr") },
        kill: (signal) => {
          fallbackSignals.push(signal);
          return true;
        },
        unref: () => childUnrefs.push("unref"),
      };
      const spawnProcess = (command, args, options) => {
        assert.equal(command, "taskkill.exe");
        assert.deepEqual(args, ["/pid", "4242", "/t", "/f"]);
        assert.deepEqual(options, {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        });
        if (scenario === "spawn-throw") throw new Error("controlled spawn failure");
        if (scenario === "spawn-error") {
          queueMicrotask(() => killer.emit("error", new Error("controlled taskkill error")));
        }
        if (scenario === "nonzero") queueMicrotask(() => killer.emit("close", 7));
        return killer;
      };

      const started = Date.now();
      const result = await terminateProcessTree(child, {
        platform: "win32",
        spawnProcess,
        taskkillTimeoutMs: 20,
      });

      assert.equal(result, false);
      assert.deepEqual(fallbackSignals, ["SIGKILL"]);
      assert.deepEqual(killerSignals, scenario === "timeout" ? ["SIGKILL"] : []);
      assert.deepEqual(killerUnrefs, scenario === "spawn-throw" ? [] : ["unref"]);
      assert.deepEqual(childUnrefs, ["unref"]);
      assert.deepEqual(destroyedStreams, ["stdout", "stderr"]);
      assert.ok(Date.now() - started < 1_000);
    });
  }

  await t.test("successful taskkill needs no fallback", async () => {
    const killer = new EventEmitter();
    killer.kill = () => true;
    const killerUnrefs = [];
    killer.unref = () => killerUnrefs.push("unref");
    const fallbackSignals = [];
    const child = {
      pid: 4242,
      kill: (signal) => {
        fallbackSignals.push(signal);
        return true;
      },
    };
    const resultPromise = terminateProcessTree(child, {
      platform: "win32",
      spawnProcess: () => {
        queueMicrotask(() => killer.emit("close", 0));
        return killer;
      },
      taskkillTimeoutMs: 20,
    });

    assert.equal(await resultPromise, true);
    assert.deepEqual(fallbackSignals, []);
    assert.deepEqual(killerUnrefs, ["unref"]);
  });
});

test("POSIX process-tree termination preserves TERM-delay-KILL ordering", async () => {
  const calls = [];
  const child = { pid: 4242 };
  const result = await terminateProcessTree(child, {
    platform: "linux",
    signalGroup: (target, signal) => calls.push(["signal", target, signal]),
    sleep: async (milliseconds) => calls.push(["delay", milliseconds]),
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [
    ["signal", child, "SIGTERM"],
    ["delay", 250],
    ["signal", child, "SIGKILL"],
  ]);
});

test("stage command requires one passed and zero skipped focused test", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-oracle-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const testPath = join(root, "oracle.test.mjs");
  const evidence = Object.freeze({
    kind: "node-test-summary",
    tests: 1,
    passes: 1,
    skips: 0,
    targetName: "expected smoke",
  });

  await writeFile(
    testPath,
    'import test from "node:test"; test("expected smoke", () => {});\n',
  );
  const zeroMatch = await runStageCommand({
    name: "zero-match",
    tool: "node",
    args: [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=renamed smoke",
      testPath,
    ],
    cwd: ROOT,
    env: {},
    evidence,
  });
  assert.deepEqual(zeroMatch, { status: "failed" });

  await writeFile(
    testPath,
    'import test from "node:test"; test("expected smoke", (t) => t.skip("optional"));\n',
  );
  const skipped = await runStageCommand({
    name: "skipped-test",
    tool: "node",
    args: ["--test", "--test-reporter=tap", testPath],
    cwd: ROOT,
    env: {},
    evidence,
  });
  assert.deepEqual(skipped, { status: "failed" });

  await writeFile(
    testPath,
    'import test from "node:test"; test("unexpected smoke", () => {});\n',
  );
  const wrongTarget = await runStageCommand({
    name: "wrong-target",
    tool: "node",
    args: ["--test", "--test-reporter=tap", testPath],
    cwd: ROOT,
    env: {},
    evidence,
  });
  assert.deepEqual(wrongTarget, { status: "failed" });

  await writeFile(
    testPath,
    'import test from "node:test"; test("expected smoke", () => {});\n',
  );
  const passed = await runStageCommand({
    name: "passed-test",
    tool: "node",
    args: ["--test", "--test-reporter=tap", testPath],
    cwd: ROOT,
    env: {},
    evidence,
  });
  assert.deepEqual(passed, { status: "passed" });
});

test("actual npm-wrapped real-HWP and HWPX stages satisfy their evidence oracles", {
  timeout: 60_000,
}, async () => {
  const captured = [];
  await runReleaseVerification({
    root: ROOT,
    platform: "test-platform",
    arch: "test-arch",
    versions: VERSIONS,
    resolveFixture: async () => ({ sha256: FIXTURE_SHA256 }),
    runStage: async (stage) => {
      captured.push(stage);
      return { status: "passed" };
    },
  });
  const focused = captured.filter((stage) =>
    stage.name === "real-hwp" || stage.name === "hwpx-roundtrip");
  assert.deepEqual(focused.map((stage) => stage.name), ["real-hwp", "hwpx-roundtrip"]);

  for (const stage of focused) {
    const result = await runStageCommand(stage, {
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    assert.deepEqual(result, { status: "passed" });
    assert.deepEqual(Object.keys(result), ["status"]);
  }
});

function nodeStage(name, source) {
  return {
    name,
    tool: "node",
    args: ["-e", source],
    cwd: ROOT,
    env: {},
  };
}

function expectedStageCommands() {
  const noEvidence = undefined;
  const realHwpEvidence = {
    kind: "node-test-summary",
    tests: 1,
    passes: 1,
    skips: 0,
    targetName: "real external HWP preview leaves the read-only sample unchanged",
  };
  const hwpxEvidence = {
    kind: "node-test-summary",
    tests: 1,
    passes: 1,
    skips: 0,
    targetName: "hwp_generate_hwpx creates a valid, readable document and forced-reflow SVG preview",
  };
  return [
    {
      name: "metadata",
      tool: "npm",
      args: ["run", "check:metadata"],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "build",
      tool: "npm",
      args: ["run", "build"],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "node-tests",
      tool: "npm",
      args: ["test"],
      env: { HWP_REQUIRE_RHWP: "1" },
      evidence: noEvidence,
    },
    {
      name: "python-tests",
      tool: "npm",
      args: ["run", "test:python"],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "real-hwp",
      tool: "npm",
      args: [
        "--prefix",
        "packages/gpt-codex-hwp",
        "run",
        "test:focused",
        "--",
        "--test-reporter=tap",
        "--test-name-pattern=real external HWP",
        "tests/rhwp-backend.test.ts",
      ],
      env: { HWP_REQUIRE_RHWP: "1" },
      evidence: realHwpEvidence,
    },
    {
      name: "hwpx-roundtrip",
      tool: "npm",
      args: [
        "--prefix",
        "packages/gpt-codex-hwp",
        "run",
        "test:focused",
        "--",
        "--test-reporter=tap",
        "--test-name-pattern=hwp_generate_hwpx creates a valid, readable document and forced-reflow SVG preview",
        "tests/hwp-plugin.test.ts",
      ],
      env: {},
      evidence: hwpxEvidence,
    },
    {
      name: "nine-tools",
      tool: "npm",
      args: ["run", "verify:compact-runtime"],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "kordoc-provenance",
      tool: "node",
      args: [
        "scripts/kordoc-core-runtime.mjs",
        "verify",
        "packages/gpt-codex-hwp/vendor/kordoc-core",
      ],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "production-dependencies",
      tool: "npm",
      args: ["run", "verify:dependencies"],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "audit",
      tool: "npm",
      args: ["--prefix", "packages/gpt-codex-hwp", "audit", "--omit=dev", "--json"],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "privacy",
      tool: "npm",
      args: [
        "--prefix",
        "packages/gpt-codex-hwp",
        "run",
        "test:focused",
        "--",
        "tests/public-runtime-privacy.test.ts",
      ],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "runtime-diff",
      tool: "npm",
      args: ["run", "runtime:check"],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "release-artifacts",
      tool: "node",
      args: ["packages/gpt-codex-hwp/release-scripts/build-release-artifacts.mjs"],
      env: {},
      evidence: noEvidence,
    },
  ];
}
