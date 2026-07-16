import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createCanonicalReleaseTemp,
  REQUIRED_RELEASE_STAGES,
  runCli,
  runReleaseArtifactsStage,
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
  "public-tree",
  "public-history",
  "privacy",
  "runtime-diff",
  "document-benchmark",
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
    rootPackage.scripts["release:artifacts"],
    "node packages/gpt-codex-hwp/release-scripts/build-release-artifacts.mjs",
  );
  assert.equal(
    rootPackage.scripts["verify:release-artifacts"],
    "node scripts/verify-release-artifacts.mjs",
  );
  assert.equal(
    rootPackage.scripts["verify:compact-runtime"],
    "node packages/gpt-codex-hwp/release-scripts/verify-compact-runtime.mjs",
  );
  assert.equal(
    sourcePackage.scripts.build,
    "tsc -p tsconfig.json && node scripts/copy-build-assets.mjs",
  );
  assert.equal(sourcePackage.scripts.test, "node --import tsx --test --test-concurrency=1 tests/*.test.ts");
  assert.equal(sourcePackage.scripts["test:python"], "python -m unittest scripts.hwpx-safe-edit.test_hwpx_safe_edit");
  assert.equal(
    sourcePackage.scripts["verify:compact-runtime"],
    "node release-scripts/verify-compact-runtime.mjs",
  );
  assert.equal(
    sourcePackage.scripts["release:artifacts"],
    "node release-scripts/build-release-artifacts.mjs",
  );
  const releaseSource = await readFile(join(ROOT, "scripts", "release-verify.mjs"), "utf8");
  assert.match(releaseSource, /clock: \(\) => performance\.now\(\),/u);
  assert.doesNotMatch(releaseSource, /clock: performance\.now,/u);
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
    calls.map(({ name, tool, args, commands, kind, env, evidence }) => ({
      name,
      tool,
      args,
      commands,
      ...(kind === undefined ? {} : { kind }),
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

test("release stages install source dependencies and keep temp nine-tools as runtime authority", async () => {
  const calls = [];
  await runReleaseVerification({
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

  const build = calls.find((stage) => stage.name === "build");
  assert.deepEqual(build.commands, [
    {
      tool: "npm",
      args: ["ci", "--prefix", "packages/gpt-codex-hwp", "--ignore-scripts"],
    },
    { tool: "npm", args: ["run", "build"] },
  ]);
  const productionDependencies = calls.find(
    (stage) => stage.name === "production-dependencies",
  );
  assert.deepEqual(productionDependencies.commands, [
    {
      tool: "npm",
      args: [
        "--prefix",
        "packages/gpt-codex-hwp",
        "ls",
        "--omit=dev",
        "--all",
        "--json",
      ],
    },
    { tool: "npm", args: ["run", "verify:source-dependencies"] },
  ]);
  const nineToolsIndex = calls.findIndex((stage) => stage.name === "nine-tools");
  const productionDependenciesIndex = calls.findIndex(
    (stage) => stage.name === "production-dependencies",
  );
  assert.ok(nineToolsIndex < productionDependenciesIndex);
  assert.deepEqual(calls[nineToolsIndex], {
    name: "nine-tools",
    tool: "npm",
    args: ["run", "verify:compact-runtime"],
    cwd: ROOT,
    env: {},
  });
  assert.equal(
    JSON.stringify(productionDependencies).includes("plugins/gpt-codex-hwp"),
    false,
  );
});

test("release artifacts stage owns a fresh output, verifies it independently, and cleans it", async () => {
  const events = [];
  const hashes = {
    "gpt-codex-hwp-0.1.4.spdx.json": "a".repeat(64),
    "gpt-codex-hwp-0.1.4.zip": "b".repeat(64),
    "provenance.json": "c".repeat(64),
  };
  const buildReceipt = {
    schemaVersion: 1,
    status: "passed",
    commit: "d".repeat(40),
    tree: "e".repeat(40),
    reproducibleEpoch: 1_700_000_000,
    files: ["SHA256SUMS", "gpt-codex-hwp-0.1.4.spdx.json", "gpt-codex-hwp-0.1.4.zip", "provenance.json"],
    hashes,
    runtimeFiles: 102,
    productionPackages: 10,
  };
  const verifyReceipt = {
    schemaVersion: 1,
    status: "passed",
    commit: buildReceipt.commit,
    tree: buildReceipt.tree,
    reproducibleEpoch: buildReceipt.reproducibleEpoch,
    runtimeFiles: buildReceipt.runtimeFiles,
    productionPackages: buildReceipt.productionPackages,
    toolCount: 9,
    hashes,
  };
  let invocation = 0;
  const result = await runReleaseArtifactsStage({
    name: "release-artifacts",
    kind: "release-artifacts",
    cwd: ROOT,
    env: {},
  }, {
    deadlineAt: performance.now() + 10_000,
    createTemp: async () => "OWNED_TEMP",
    runCommand: async (command) => {
      events.push(command);
      const receipt = invocation++ === 0 ? buildReceipt : verifyReceipt;
      return { status: "passed", stdout: `${JSON.stringify(receipt)}\n`, stderr: "" };
    },
    removeTemp: async (path) => { events.push({ cleanup: path }); },
  });
  assert.deepEqual(result, { status: "passed" });
  assert.deepEqual(events, [
    {
      tool: "node",
      args: [
        "packages/gpt-codex-hwp/release-scripts/build-release-artifacts.mjs",
        "--output",
        join("OWNED_TEMP", "artifacts"),
      ],
    },
    {
      tool: "node",
      args: [
        "scripts/verify-release-artifacts.mjs",
        "--artifacts",
        join("OWNED_TEMP", "artifacts"),
        "--root",
        ROOT,
      ],
    },
    { cleanup: "OWNED_TEMP" },
  ]);
});

test("release artifacts stage rejects missing receipts and preserves owned temp evidence", async () => {
  const events = [];
  const result = await runReleaseArtifactsStage({
    name: "release-artifacts",
    kind: "release-artifacts",
    cwd: ROOT,
    env: {},
  }, {
    createTemp: async () => "OWNED_TEMP",
    runCommand: async () => ({ status: "passed", stdout: "", stderr: "" }),
    removeTemp: async (path) => { events.push(path); },
  });
  assert.deepEqual(result, { status: "failed" });
  assert.deepEqual(events, []);
});

test("release artifacts stage preserves late temp evidence after its deadline", async () => {
  const events = [];
  const result = await runReleaseArtifactsStage({
    name: "release-artifacts", kind: "release-artifacts", cwd: ROOT, env: {},
  }, {
    createTemp: async () => { events.push("created"); return "LATE_OWNED_TEMP"; },
    runCommand: async () => { events.push("unexpected-command"); return { status: "failed" }; },
    removeTemp: async (path) => { await Promise.resolve(); events.push(`removed:${path}`); },
    deadlineAt: 10,
    clock: () => 11,
  });
  assert.deepEqual(result, { status: "failed" });
  assert.deepEqual(events, ["created"]);
});

test("release artifacts stage preserves a real temp after an expired deadline", async (t) => {
  const owned = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-expired-"));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const result = await runReleaseArtifactsStage({
    name: "release-artifacts", kind: "release-artifacts", cwd: ROOT, env: {},
  }, {
    createTemp: async () => owned,
    runCommand: async () => { throw new Error("must not run"); },
    deadlineAt: 1,
    clock: () => 2,
  });
  assert.deepEqual(result, { status: "failed" });
  assert.equal((await lstat(owned)).isDirectory(), true);
});

test("release temp cleanup quarantines first and never deletes a swapped replacement", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-cleanup-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const owned = join(parent, "owned");
  const savedOwned = join(parent, "saved-owned");
  await mkdir(owned);
  const info = await lstat(owned);
  const identity = { dev: info.dev, ino: info.ino, canonical: await realpath(owned) };
  const module = await import(
    `${new URL("../scripts/release-verify.mjs", import.meta.url).href}?cleanup-race=${Date.now()}`
  );
  assert.equal(typeof module.removeOwnedTempForTest, "function");
  let replacement;
  await assert.rejects(
    module.removeOwnedTempForTest(owned, identity, {
      afterQuarantine: async (quarantine) => {
        await rename(quarantine, savedOwned);
        await mkdir(quarantine);
        replacement = join(quarantine, "sentinel.txt");
        await writeFile(replacement, "preserve", "utf8");
      },
    }),
    { code: "RELEASE_VERIFY_TEMP_INVALID" },
  );
  assert.equal(await readFile(replacement, "utf8"), "preserve");
  assert.equal((await lstat(savedOwned)).isDirectory(), true);
});

test("release temp cleanup preserves a file swapped after quarantine", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-file-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const owned = join(parent, "owned");
  const artifacts = join(owned, "artifacts");
  const savedArtifact = join(parent, "saved-provenance.json");
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "provenance.json"), "owned", "utf8");
  const info = await lstat(owned);
  const identity = { dev: info.dev, ino: info.ino, canonical: await realpath(owned) };
  const { removeOwnedTempForTest } = await import(
    `${new URL("../scripts/release-verify.mjs", import.meta.url).href}?file-race=${Date.now()}`
  );
  let replacement;
  await assert.rejects(
    removeOwnedTempForTest(owned, identity, {
      afterQuarantine: async (quarantine) => {
        const quarantinedArtifact = join(quarantine, "artifacts", "provenance.json");
        await rename(quarantinedArtifact, savedArtifact);
        replacement = quarantinedArtifact;
        await writeFile(replacement, "preserve", "utf8");
      },
    }),
    { code: "RELEASE_VERIFY_TEMP_INVALID" },
  );
  assert.equal(await readFile(replacement, "utf8"), "preserve");
  assert.equal(await readFile(savedArtifact, "utf8"), "owned");
});

test("release temp cleanup follows platform path case semantics", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-case-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const owned = join(parent, "owned");
  await mkdir(owned);
  const info = await lstat(owned);
  const identity = { dev: info.dev, ino: info.ino, canonical: await realpath(owned) };
  const { removeOwnedTempForTest } = await import(
    `${new URL("../scripts/release-verify.mjs", import.meta.url).href}?case=${Date.now()}`
  );
  const cleanupPath = process.platform === "win32" ? owned.toUpperCase() : owned;
  await removeOwnedTempForTest(cleanupPath, identity);
  await assert.rejects(lstat(owned), { code: "ENOENT" });
});

test("release temp cleanup accepts a canonical ancestor alias", async (t) => {
  const realParent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-real-parent-"));
  const aliasParent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-alias-parent-"));
  const alias = join(aliasParent, "temp-alias");
  t.after(async () => {
    try { await unlink(alias); } catch {}
    await rm(aliasParent, { recursive: true, force: true });
    await rm(realParent, { recursive: true, force: true });
  });
  try {
    await symlink(realParent, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("directory alias creation is unavailable");
      return;
    }
    throw error;
  }
  const owned = join(alias, "owned");
  await mkdir(owned);
  const info = await lstat(owned);
  const identity = { dev: info.dev, ino: info.ino, canonical: await realpath(owned) };
  const { removeOwnedTempForTest } = await import(
    `${new URL("../scripts/release-verify.mjs", import.meta.url).href}?canonical-alias=${Date.now()}`
  );
  await removeOwnedTempForTest(owned, identity);
  await assert.rejects(lstat(join(realParent, "owned")), { code: "ENOENT" });
});

test("release artifact staging canonicalizes a temporary-directory ancestor alias", async (t) => {
  const realParent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-stage-real-parent-"));
  const aliasParent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-stage-alias-parent-"));
  const alias = join(aliasParent, "temp-alias");
  let created;
  t.after(async () => {
    if (created !== undefined) await rm(created, { recursive: true, force: true });
    try { await unlink(alias); } catch {}
    await rm(aliasParent, { recursive: true, force: true });
    await rm(realParent, { recursive: true, force: true });
  });
  try {
    await symlink(realParent, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`directory alias creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  created = await createCanonicalReleaseTemp(alias);
  assert.equal(dirname(created), await realpath(realParent));
  assert.equal(await realpath(dirname(created)), dirname(created));
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

test("composite stage commands execute sequentially", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-sequence-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const marker = join(root, "sequence.txt");
  const first = [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'installed', 'utf8')",
    marker,
  ];
  const second = [
    "-e",
    [
      "const fs = require('node:fs')",
      "if (fs.readFileSync(process.argv[1], 'utf8') !== 'installed') process.exit(9)",
      "fs.writeFileSync(process.argv[1], 'verified', 'utf8')",
    ].join(";"),
    marker,
  ];

  const result = await runStageCommand({
    name: "sequential-composite",
    commands: [
      { tool: "node", args: first },
      { tool: "node", args: second },
    ],
    cwd: ROOT,
    env: {},
  }, { timeoutMs: 2_000, maxOutputBytes: 1_024 });

  assert.deepEqual(result, { status: "passed" });
  assert.equal(await readFile(marker, "utf8"), "verified");
});

test("composite stage commands fail fast before later commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-fail-fast-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const firstMarker = join(root, "first.txt");
  const forbiddenMarker = join(root, "must-not-run.txt");

  const result = await runStageCommand({
    name: "failed-composite",
    commands: [
      {
        tool: "node",
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'ran', 'utf8'); process.exit(7)",
          firstMarker,
        ],
      },
      {
        tool: "node",
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'unexpected', 'utf8')",
          forbiddenMarker,
        ],
      },
    ],
    cwd: ROOT,
    env: {},
  }, { timeoutMs: 2_000, maxOutputBytes: 1_024 });

  assert.deepEqual(result, { status: "failed" });
  assert.equal(await readFile(firstMarker, "utf8"), "ran");
  await assert.rejects(readFile(forbiddenMarker, "utf8"), { code: "ENOENT" });
});

test("composite stage fails closed when its final verification command fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-final-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const installedMarker = join(root, "installed.txt");
  const verifiedMarker = join(root, "verification-ran.txt");

  const result = await runStageCommand({
    name: "failed-final-verification",
    commands: [
      {
        tool: "node",
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'installed', 'utf8')",
          installedMarker,
        ],
      },
      {
        tool: "node",
        args: [
          "-e",
          [
            "require('node:fs').writeFileSync(process.argv[1], 'ran', 'utf8')",
            "process.stdout.write('PRIVATE_INSTALL_OUTPUT')",
            "process.stderr.write('PRIVATE_VERIFY_FAILURE')",
            "process.exit(7)",
          ].join(";"),
          verifiedMarker,
        ],
      },
    ],
    cwd: ROOT,
    env: {},
  }, { timeoutMs: 2_000, maxOutputBytes: 1_024 });

  assert.deepEqual(result, { status: "failed" });
  assert.equal(await readFile(installedMarker, "utf8"), "installed");
  assert.equal(await readFile(verifiedMarker, "utf8"), "ran");
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});

test("composite stage shares one aggregate output bound across commands", async () => {
  const result = await runStageCommand({
    name: "aggregate-output-bound",
    commands: [
      { tool: "node", args: ["-e", 'process.stdout.write("x".repeat(40))'] },
      { tool: "node", args: ["-e", 'process.stderr.write("y".repeat(40))'] },
    ],
    cwd: ROOT,
    env: {},
  }, { timeoutMs: 2_000, maxOutputBytes: 64 });

  assert.deepEqual(result, { status: "failed" });
});

test("composite stage shares one aggregate timeout across commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-total-timeout-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const firstMarker = join(root, "first.txt");
  const started = Date.now();

  const result = await runStageCommand({
    name: "aggregate-timeout",
    commands: [
      {
        tool: "node",
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'ran', 'utf8'); setTimeout(() => {}, 80)",
          firstMarker,
        ],
      },
      {
        tool: "node",
        args: [
          "-e",
          "setTimeout(() => {}, 150)",
        ],
      },
    ],
    cwd: ROOT,
    env: {},
  }, { timeoutMs: 180, maxOutputBytes: 1_024 });

  assert.deepEqual(result, { status: "failed" });
  assert.equal(await readFile(firstMarker, "utf8"), "ran");
  assert.ok(Date.now() - started < 1_000);
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
  const documentBenchmarkArgs = [
    "--prefix",
    "packages/gpt-codex-hwp",
    "run",
    "benchmark:documents",
    "--",
    "--sizes",
    "10",
    "--output",
    `.superpowers/benchmarks/release-10m-${process.pid}.json`,
  ];
  const documentBenchmark = process.env.HWP_BENCH_REQUIRE_LARGE === "1"
    ? {
        name: "document-benchmark",
        tool: undefined,
        args: undefined,
        commands: [
          { tool: "npm", args: documentBenchmarkArgs },
          {
            tool: "node",
            args: [
              "packages/gpt-codex-hwp/benchmarks/document-engine-benchmark.mjs",
              "--validate-large",
              process.env.HWP_BENCH_LARGE_EVIDENCE
                ?? ".superpowers/benchmarks/large.json",
            ],
          },
        ],
        env: {},
        evidence: noEvidence,
      }
    : {
        name: "document-benchmark",
        tool: "npm",
        args: documentBenchmarkArgs,
        commands: undefined,
        env: {},
        evidence: noEvidence,
      };
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
      commands: undefined,
      env: {},
      evidence: noEvidence,
    },
    {
      name: "build",
      tool: undefined,
      args: undefined,
      commands: [
        {
          tool: "npm",
          args: ["ci", "--prefix", "packages/gpt-codex-hwp", "--ignore-scripts"],
        },
        { tool: "npm", args: ["run", "build"] },
      ],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "node-tests",
      tool: "npm",
      args: ["test"],
      commands: undefined,
      env: { HWP_REQUIRE_RHWP: "1" },
      evidence: noEvidence,
    },
    {
      name: "python-tests",
      tool: "npm",
      args: ["run", "test:python"],
      commands: undefined,
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
      commands: undefined,
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
      commands: undefined,
      env: {},
      evidence: hwpxEvidence,
    },
    {
      name: "nine-tools",
      tool: "npm",
      args: ["run", "verify:compact-runtime"],
      commands: undefined,
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
      commands: undefined,
      env: {},
      evidence: noEvidence,
    },
    {
      name: "production-dependencies",
      tool: undefined,
      args: undefined,
      commands: [
        {
          tool: "npm",
          args: [
            "--prefix",
            "packages/gpt-codex-hwp",
            "ls",
            "--omit=dev",
            "--all",
            "--json",
          ],
        },
        { tool: "npm", args: ["run", "verify:source-dependencies"] },
      ],
      env: {},
      evidence: noEvidence,
    },
    {
      name: "audit",
      tool: "npm",
      args: ["--prefix", "packages/gpt-codex-hwp", "audit", "--omit=dev", "--json"],
      commands: undefined,
      env: {},
      evidence: noEvidence,
    },
    {
      name: "public-tree",
      tool: "npm",
      args: ["run", "security:scan-tree"],
      commands: undefined,
      env: {},
      evidence: noEvidence,
    },
    {
      name: "public-history",
      tool: "npm",
      args: ["run", "security:scan-history"],
      commands: undefined,
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
      commands: undefined,
      env: {},
      evidence: noEvidence,
    },
    {
      name: "runtime-diff",
      tool: "npm",
      args: ["run", "runtime:check"],
      commands: undefined,
      env: {},
      evidence: noEvidence,
    },
    documentBenchmark,
    {
      name: "release-artifacts",
      tool: undefined,
      args: undefined,
      commands: undefined,
      kind: "release-artifacts",
      env: {},
      evidence: noEvidence,
    },
  ];
}
