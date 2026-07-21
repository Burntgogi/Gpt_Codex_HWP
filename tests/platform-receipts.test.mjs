import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildPlatformReceipt,
  collectPlatformExpectation,
  createPlatformReceipt,
  DEFAULT_PLATFORM_CHECKSUM_PATH,
  DEFAULT_PLATFORM_RECEIPT_PATH,
  hashTrackedRuntimeAtHead,
  PINNED_HWP_FIXTURE_SHA256,
  REQUIRED_PLATFORM_STAGES,
  runPlatformReceiptCli,
  validatePlatformReceipt,
  verifyPlatformReceiptFile,
  writePlatformReceiptChecksum,
} from "../scripts/platform-receipts.mjs";

const EXPECTED = Object.freeze({
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  version: "0.2.0",
  platform: "darwin",
  arch: "arm64",
  runtimeSha256: "c".repeat(64),
});

function validReceipt() {
  return {
    schemaVersion: 1,
    commit: EXPECTED.commit,
    tree: EXPECTED.tree,
    version: EXPECTED.version,
    platform: EXPECTED.platform,
    arch: EXPECTED.arch,
    toolchains: {
      node: "v22.22.2",
      npm: "10.9.7",
      python: "3.12.11",
    },
    stages: REQUIRED_PLATFORM_STAGES.map((name, index) => ({
      name,
      status: "passed",
      elapsedMs: index + 1,
    })),
    toolCount: 9,
    fixtureSha256: PINNED_HWP_FIXTURE_SHA256,
    sourceUnchanged: true,
    hwpxRoundTrip: true,
    runtimeSha256: EXPECTED.runtimeSha256,
    skippedRequiredGates: 0,
  };
}

function validReleaseReceipt(
  platform = EXPECTED.platform,
  arch = EXPECTED.arch,
  identity = EXPECTED,
) {
  return {
    schemaVersion: 2,
    status: "passed",
    commit: identity.commit,
    tree: identity.tree,
    platform,
    arch,
    node: "v22.22.2",
    npm: "10.9.7",
    python: "3.12.11",
    stages: REQUIRED_PLATFORM_STAGES.map((name, index) => ({
      name,
      status: "passed",
      elapsedMs: index + 1,
    })),
    toolCount: 9,
    fixtureSha256: PINNED_HWP_FIXTURE_SHA256,
  };
}

function failedReleaseReceipt(stageName) {
  const stageIndex = REQUIRED_PLATFORM_STAGES.indexOf(stageName);
  assert.notEqual(stageIndex, -1);
  const receipt = validReleaseReceipt();
  receipt.status = "failed";
  receipt.commit = null;
  receipt.tree = null;
  receipt.stages = receipt.stages.slice(0, stageIndex + 1);
  receipt.stages[stageIndex].status = "failed";
  return receipt;
}

test("platform receipt accepts exact current-head redacted evidence", () => {
  const validated = validatePlatformReceipt(validReceipt(), EXPECTED);

  assert.deepEqual(validated, validReceipt());
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.toolchains), true);
  assert.equal(Object.isFrozen(validated.stages), true);
  assert.equal(Object.isFrozen(validated.stages[0]), true);
});

test("platform receipt rejects stale or mismatched identity", () => {
  for (const [field, value] of [
    ["commit", "d".repeat(40)],
    ["tree", "e".repeat(40)],
    ["version", "0.2.1"],
    ["platform", "win32"],
    ["arch", "x64"],
    ["runtimeSha256", "f".repeat(64)],
  ]) {
    const receipt = validReceipt();
    receipt[field] = value;
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_IDENTITY_MISMATCH/u,
      field,
    );
  }
});

test("platform receipt requires every gate once, passed, and measured", () => {
  const mutations = [
    (receipt) => receipt.stages.pop(),
    (receipt) => receipt.stages.push({ ...receipt.stages[0] }),
    (receipt) => { receipt.stages[0].status = "skipped"; },
    (receipt) => { receipt.stages[0].status = "failed"; },
    (receipt) => { receipt.stages[0].elapsedMs = -1; },
    (receipt) => { receipt.skippedRequiredGates = 1; },
  ];
  for (const mutate of mutations) {
    const receipt = validReceipt();
    mutate(receipt);
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_GATE_INVALID/u,
    );
  }
});

test("platform receipt requires nine tools and immutable HWP/HWPX results", () => {
  for (const [field, value] of [
    ["toolCount", 8],
    ["fixtureSha256", "0".repeat(64)],
    ["sourceUnchanged", false],
    ["hwpxRoundTrip", false],
  ]) {
    const receipt = validReceipt();
    receipt[field] = value;
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_EVIDENCE_INVALID/u,
      field,
    );
  }
});

test("platform receipt requires the pinned Node and npm toolchains with Python 3.12", () => {
  for (const [toolchain, value] of [
    ["node", "v22.22.1"],
    ["npm", "10.9.6"],
    ["python", "3.11.9"],
  ]) {
    const receipt = validReceipt();
    receipt.toolchains[toolchain] = value;
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_EVIDENCE_INVALID/u,
      toolchain,
    );
  }
});

test("platform receipt rejects logs paths environment and document content", () => {
  for (const [key, value] of [
    ["logs", "private diagnostic output"],
    ["path", "workspace/document.hwpx"],
    ["environment", { HWP_TEST_FIXTURE: "fixture.hwp" }],
    ["documentContent", "private document text"],
  ]) {
    const receipt = validReceipt();
    receipt[key] = value;
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_SHAPE_INVALID/u,
      key,
    );
  }

  const nested = validReceipt();
  nested.stages[0].stdout = "private diagnostic output";
  assert.throws(
    () => validatePlatformReceipt(nested, EXPECTED),
    /PLATFORM_RECEIPT_SHAPE_INVALID/u,
  );
});

test("platform receipt errors do not echo untrusted evidence", () => {
  const marker = "private-document-marker";
  const receipt = validReceipt();
  receipt.logs = marker;

  assert.throws(
    () => validatePlatformReceipt(receipt, EXPECTED),
    (error) => {
      assert.match(error.message, /^PLATFORM_RECEIPT_[A-Z_]+$/u);
      assert.doesNotMatch(error.message, new RegExp(marker, "u"));
      return true;
    },
  );
});

test("platform receipt derives strict evidence only from a complete passed release receipt", () => {
  const receipt = buildPlatformReceipt(validReleaseReceipt(), EXPECTED);

  assert.deepEqual(receipt, validReceipt());

  for (const mutate of [
    (value) => { value.status = "failed"; },
    (value) => { value.schemaVersion = 1; },
    (value) => { value.commit = "d".repeat(40); },
    (value) => { value.tree = "e".repeat(40); },
    (value) => { value.stages.pop(); },
    (value) => { value.stages[0].status = "skipped"; },
    (value) => { value.toolCount = 8; },
    (value) => { value.logs = "private diagnostic output"; },
  ]) {
    const releaseReceipt = validReleaseReceipt();
    mutate(releaseReceipt);
    assert.throws(
      () => buildPlatformReceipt(releaseReceipt, EXPECTED),
      /PLATFORM_RECEIPT_RELEASE_INVALID/u,
    );
  }
});

test("platform expectation binds exact clean HEAD tree version platform and runtime projection", async (t) => {
  const root = await createRepository(t);
  const firstHead = git(root, "rev-parse", "HEAD");
  const firstTree = git(root, "rev-parse", "HEAD^{tree}");

  const first = await collectPlatformExpectation({
    root,
    expectedCommit: firstHead,
    platform: "win32",
    arch: "x64",
  });
  assert.equal(first.commit, firstHead);
  assert.equal(first.tree, firstTree);
  assert.equal(first.version, "0.2.0");
  assert.equal(first.platform, "win32");
  assert.equal(first.arch, "x64");
  assert.match(first.runtimeSha256, /^[a-f0-9]{64}$/u);

  await writeFile(join(root, "plugins", "gpt-codex-hwp", "runtime.txt"), "runtime\r\n", "utf8");
  assert.equal(
    await hashTrackedRuntimeAtHead(root, firstHead),
    first.runtimeSha256,
    "runtime hash must bind HEAD blobs rather than checkout line endings",
  );
  await writeFile(join(root, "plugins", "gpt-codex-hwp", "runtime.txt"), "runtime\n", "utf8");
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");

  await assert.rejects(
    collectPlatformExpectation({
      root,
      expectedCommit: "f".repeat(40),
      platform: "win32",
      arch: "x64",
    }),
    /PLATFORM_RECEIPT_HEAD_MISMATCH/u,
  );

  await writeFile(join(root, "plugins", "gpt-codex-hwp", "runtime.txt"), "changed\n", "utf8");
  await assert.rejects(
    collectPlatformExpectation({
      root,
      expectedCommit: firstHead,
      platform: "win32",
      arch: "x64",
    }),
    /PLATFORM_RECEIPT_SOURCE_DIRTY/u,
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "change runtime");

  const secondHead = git(root, "rev-parse", "HEAD");
  const second = await collectPlatformExpectation({
    root,
    expectedCommit: secondHead,
    platform: "win32",
    arch: "x64",
  });
  assert.notEqual(second.runtimeSha256, first.runtimeSha256);
});

test("platform expectation canonicalizes a repository-root path alias", async (t) => {
  const root = await createRepository(t);
  const aliasParent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-platform-alias-"));
  const alias = join(aliasParent, "repository");
  t.after(async () => {
    await unlink(alias).catch(() => {});
    await rm(aliasParent, { recursive: true, force: true });
  });
  try {
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`path aliases unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const expectedCommit = git(root, "rev-parse", "HEAD");
  const expectation = await collectPlatformExpectation({
    root: alias,
    expectedCommit,
    platform: "win32",
    arch: "x64",
  });
  assert.equal(expectation.commit, expectedCommit);
  assert.match(expectation.runtimeSha256, /^[a-f0-9]{64}$/u);
});

test("platform expectation rejects tracked files reached through a directory junction", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows directory junctions are unavailable on this platform");
    return;
  }

  const root = await createRepository(t);
  const expectedCommit = git(root, "rev-parse", "HEAD");
  const pluginsPath = join(root, "plugins");
  const outsideRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-platform-junction-"));
  const outsidePluginsPath = join(outsideRoot, "plugins");
  let junctionCreated = false;

  await rename(pluginsPath, outsidePluginsPath);
  try {
    try {
      await symlink(outsidePluginsPath, pluginsPath, "junction");
      junctionCreated = true;
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
    await assert.rejects(
      collectPlatformExpectation({
        root,
        expectedCommit,
        platform: "win32",
        arch: "x64",
      }),
      /PLATFORM_RECEIPT_SOURCE_DIRTY/u,
    );
  } finally {
    if (junctionCreated) await unlink(pluginsPath);
    await rename(outsidePluginsPath, pluginsPath);
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("platform expectation rejects assume-unchanged and skip-worktree index flags", async (t) => {
  const root = await createRepository(t);
  const expectedCommit = git(root, "rev-parse", "HEAD");
  const runtimePath = "plugins/gpt-codex-hwp/runtime.txt";

  for (const [setFlag, clearFlag] of [
    ["--assume-unchanged", "--no-assume-unchanged"],
    ["--skip-worktree", "--no-skip-worktree"],
  ]) {
    git(root, "update-index", setFlag, "--", runtimePath);
    await assert.rejects(
      collectPlatformExpectation({
        root,
        expectedCommit,
        platform: "win32",
        arch: "x64",
      }),
      /PLATFORM_RECEIPT_INDEX_INVALID/u,
      setFlag,
    );
    git(root, "update-index", clearFlag, "--", runtimePath);
  }
});

test("platform expectation rejects fsmonitor-valid tracked files hidden by a v1 hook", async (t) => {
  const root = await createRepository(t);
  const expectedCommit = git(root, "rev-parse", "HEAD");
  const runtimePath = "plugins/gpt-codex-hwp/runtime.txt";
  const hookPath = join(root, ".git", "hooks", "fsmonitor-no-changes");
  await writeFile(hookPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  git(root, "config", "core.fsmonitor", ".git/hooks/fsmonitor-no-changes");
  git(root, "config", "core.fsmonitorHookVersion", "1");
  git(root, "update-index", "--fsmonitor");
  git(root, "update-index", "--fsmonitor-valid", "--", runtimePath);
  await writeFile(join(root, ...runtimePath.split("/")), "changed\n", "utf8");

  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.match(git(root, "ls-files", "-v", "--", runtimePath), /^H /u);
  assert.match(git(root, "ls-files", "-f", "--", runtimePath), /^h /u);
  await assert.rejects(
    collectPlatformExpectation({
      root,
      expectedCommit,
      platform: "win32",
      arch: "x64",
    }),
    /PLATFORM_RECEIPT_INDEX_INVALID/u,
  );
});

test("platform expectation rejects same-size tracked bytes hidden by restored stat data", async (t) => {
  const root = await createRepository(t);
  const expectedCommit = git(root, "rev-parse", "HEAD");
  const runtimePath = "plugins/gpt-codex-hwp/runtime.txt";
  const absoluteRuntimePath = join(root, ...runtimePath.split("/"));
  const cachedTime = new Date("2001-01-01T00:00:00.000Z");
  git(root, "config", "core.trustctime", "false");
  git(root, "config", "core.checkStat", "minimal");
  await utimes(absoluteRuntimePath, cachedTime, cachedTime);
  git(root, "update-index", "--refresh");
  const cachedStat = await stat(absoluteRuntimePath);
  await writeFile(absoluteRuntimePath, "changed\n", "utf8");
  await utimes(absoluteRuntimePath, cachedStat.atime, cachedStat.mtime);

  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.match(git(root, "ls-files", "-v", "--", runtimePath), /^H /u);
  assert.match(git(root, "ls-files", "-f", "--", runtimePath), /^H /u);
  await assert.rejects(
    collectPlatformExpectation({
      root,
      expectedCommit,
      platform: "win32",
      arch: "x64",
    }),
    /PLATFORM_RECEIPT_SOURCE_DIRTY/u,
  );
});

test("platform expectation rejects Git replacement semantics before binding evidence", async (t) => {
  const root = await createRepository(t);
  const original = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "plugins", "gpt-codex-hwp", "runtime.txt"), "replacement\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "replacement tree");
  const replacement = git(root, "rev-parse", "HEAD");
  git(root, "reset", "--hard", original);
  git(root, "replace", original, replacement);
  git(root, "reset", "--hard", original);

  await assert.rejects(
    collectPlatformExpectation({
      root,
      expectedCommit: original,
      platform: "win32",
      arch: "x64",
    }),
    /PLATFORM_RECEIPT_REPOSITORY_SEMANTICS_INVALID/u,
  );
});

test("platform receipt production writes exclusively then verifies and checksums independently", async (t) => {
  const root = await createRepository(t);
  const expectedCommit = git(root, "rev-parse", "HEAD");
  const expectedTree = git(root, "rev-parse", "HEAD^{tree}");
  const runVerification = async () => validReleaseReceipt(
    "win32",
    "x64",
    { commit: expectedCommit, tree: expectedTree },
  );

  const created = await createPlatformReceipt({
    root,
    expectedCommit,
    platform: "win32",
    arch: "x64",
    runVerification,
  });
  const verified = await verifyPlatformReceiptFile({
    root,
    expectedCommit,
    platform: "win32",
    arch: "x64",
  });
  assert.deepEqual(verified, created);

  const checksum = await writePlatformReceiptChecksum({
    root,
    expectedCommit,
    platform: "win32",
    arch: "x64",
  });
  assert.match(checksum, /^[a-f0-9]{64}  platform-receipt\.json\n$/u);
  assert.equal(
    await readFile(join(root, DEFAULT_PLATFORM_CHECKSUM_PATH), "utf8"),
    checksum,
  );

  await assert.rejects(
    createPlatformReceipt({
      root,
      expectedCommit,
      platform: "win32",
      arch: "x64",
      runVerification,
    }),
    /PLATFORM_RECEIPT_OUTPUT_EXISTS/u,
  );
  assert.match(
    await readFile(join(root, DEFAULT_PLATFORM_RECEIPT_PATH), "utf8"),
    /"sourceUnchanged": true/u,
  );
});

test("platform receipt rejects a mismatched release identity before writing", async (t) => {
  const root = await createRepository(t);
  const expectedCommit = git(root, "rev-parse", "HEAD");
  const expectedTree = git(root, "rev-parse", "HEAD^{tree}");
  const mismatched = validReleaseReceipt(
    "win32",
    "x64",
    { commit: expectedCommit, tree: expectedTree },
  );
  mismatched.tree = "f".repeat(40);

  await assert.rejects(
    createPlatformReceipt({
      root,
      expectedCommit,
      platform: "win32",
      arch: "x64",
      runVerification: async () => mismatched,
    }),
    /PLATFORM_RECEIPT_RELEASE_INVALID/u,
  );
  await assert.rejects(
    readFile(join(root, DEFAULT_PLATFORM_RECEIPT_PATH), "utf8"),
    { code: "ENOENT" },
  );
});

test("platform receipt creation keeps failed stage provenance private", async () => {
  await assert.rejects(
    createPlatformReceipt({
      root: process.cwd(),
      expectedCommit: EXPECTED.commit,
      platform: EXPECTED.platform,
      arch: EXPECTED.arch,
      collectExpectation: async () => EXPECTED,
      runVerification: async () => failedReleaseReceipt("node-tests"),
    }),
    (error) => {
      assert.equal(error?.code, "PLATFORM_RECEIPT_RELEASE_INVALID");
      assert.equal(error?.message, "PLATFORM_RECEIPT_RELEASE_INVALID");
      assert.equal(Object.hasOwn(error, "stage"), false);
      return true;
    },
  );
});

test("platform receipt creation refuses stage provenance from invalid failed receipt fields", async () => {
  const marker = "PRIVATE/path/document.hwpx AWS_SECRET_ACCESS_KEY=marker";
  const mutations = [
    (receipt) => { receipt.platform = "win32"; },
    (receipt) => { receipt.arch = "x64"; },
    (receipt) => { receipt.node = "v22.22.1"; },
    (receipt) => { receipt.npm = "10.9.6"; },
    (receipt) => { receipt.python = "3.11.9"; },
    (receipt) => { receipt.toolCount = 8; },
    (receipt) => { receipt.fixtureSha256 = "0".repeat(64); },
    (receipt) => { receipt.logs = marker; },
  ];

  for (const mutate of mutations) {
    const failed = failedReleaseReceipt("node-tests");
    mutate(failed);
    await assert.rejects(
      createPlatformReceipt({
        root: process.cwd(),
        expectedCommit: EXPECTED.commit,
        platform: EXPECTED.platform,
        arch: EXPECTED.arch,
        collectExpectation: async () => EXPECTED,
        runVerification: async () => failed,
      }),
      (error) => {
        assert.equal(error?.code, "PLATFORM_RECEIPT_RELEASE_INVALID");
        assert.equal(error?.stage, undefined);
        assert.equal(error?.message, "PLATFORM_RECEIPT_RELEASE_INVALID");
        assert.doesNotMatch(error?.message, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        return true;
      },
    );
  }
});

test("platform receipt creation rejects a pre-existing Windows junction output directory", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows directory junctions are unavailable on this platform");
    return;
  }

  const root = await createRepository(t);
  const expectedCommit = git(root, "rev-parse", "HEAD");
  const expectedTree = git(root, "rev-parse", "HEAD^{tree}");
  const outputRoot = join(root, "release-receipts");
  const outsideRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-platform-output-junction-"));
  let junctionCreated = false;

  try {
    try {
      await symlink(outsideRoot, outputRoot, "junction");
      junctionCreated = true;
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`directory junctions unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    let result = "accepted";
    try {
      await createPlatformReceipt({
        root,
        expectedCommit,
        platform: "win32",
        arch: "x64",
        runVerification: async () => validReleaseReceipt(
          "win32",
          "x64",
          { commit: expectedCommit, tree: expectedTree },
        ),
      });
    } catch (error) {
      result = error?.code;
    }
    const escapedWrite = await readFile(join(outsideRoot, "platform-receipt.json"))
      .then(() => true, (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });

    assert.deepEqual(
      { result, escapedWrite },
      { result: "PLATFORM_RECEIPT_OUTPUT_INVALID", escapedWrite: false },
    );
  } finally {
    if (junctionCreated) await unlink(outputRoot);
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("platform receipt CLI fails with stable redacted diagnostics", async () => {
  const marker = "private-user-workspace-marker";
  let stdout = "";
  let stderr = "";
  let exitCode;

  const result = await runPlatformReceiptCli({
    args: ["verify"],
    env: {},
    root: `C:/${marker}`,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(result, undefined);
  assert.equal(stdout, "");
  assert.equal(stderr, "PLATFORM_RECEIPT_EXPECTED_HEAD_INVALID\n");
  assert.doesNotMatch(stderr, new RegExp(marker, "u"));
  assert.equal(exitCode, 1);
});

test("platform receipt CLI reports only the allowlisted failed release stage", async () => {
  for (const stage of REQUIRED_PLATFORM_STAGES) {
    let stdout = "";
    let stderr = "";
    let exitCode;

    const result = await runPlatformReceiptCli({
      args: ["create"],
      env: { EXPECTED_HEAD_SHA: EXPECTED.commit },
      root: process.cwd(),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      setExitCode: (value) => { exitCode = value; },
      collectExpectation: async () => EXPECTED,
      runVerification: async () => failedReleaseReceipt(stage),
    });

    assert.equal(result, undefined, stage);
    assert.equal(stdout, "", stage);
    assert.equal(
      stderr,
      `PLATFORM_RECEIPT_RELEASE_INVALID stage=${stage}\n`,
      stage,
    );
    assert.equal(exitCode, 1, stage);
  }
});

test("platform receipt CLI emits only a validated first document benchmark failure", async () => {
  let stdout = "";
  let stderr = "";
  let exitCode;

  const result = await runPlatformReceiptCli({
    args: ["create"],
    env: { EXPECTED_HEAD_SHA: EXPECTED.commit },
    root: process.cwd(),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    setExitCode: (value) => { exitCode = value; },
    collectExpectation: async () => EXPECTED,
    runVerification: async (options) => {
      options.diagnosticObserver({
        kind: "document-benchmark",
        command: 1,
        receipt: "PRIVATE/path/document.hwpx",
      });
      options.diagnosticObserver({
        kind: "document-benchmark",
        command: 1,
        receipt: "BENCHMARK_TERMINATION_FAILED stage=windows-termination-scan-exhausted",
      });
      return failedReleaseReceipt("document-benchmark");
    },
  });

  assert.equal(result, undefined);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    "DOCUMENT_BENCHMARK_FIRST_FAILURE command=1 BENCHMARK_TERMINATION_FAILED stage=windows-termination-scan-exhausted\n"
      + "PLATFORM_RECEIPT_RELEASE_INVALID stage=document-benchmark\n",
  );
  assert.doesNotMatch(stderr, /PRIVATE|\.hwpx|[\\/]/u);
  assert.equal(exitCode, 1);
});

test("platform receipt CLI rejects an authentic failed-stage error replayed from an earlier call", async () => {
  let captured;
  try {
    await createPlatformReceipt({
      root: process.cwd(),
      expectedCommit: EXPECTED.commit,
      platform: EXPECTED.platform,
      arch: EXPECTED.arch,
      collectExpectation: async () => EXPECTED,
      runVerification: async () => failedReleaseReceipt("node-tests"),
    });
  } catch (error) {
    captured = error;
  }
  assert.equal(captured?.code, "PLATFORM_RECEIPT_RELEASE_INVALID");

  let stdout = "";
  let stderr = "";
  let exitCode;
  const result = await runPlatformReceiptCli({
    args: ["create"],
    env: { EXPECTED_HEAD_SHA: EXPECTED.commit },
    root: process.cwd(),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    setExitCode: (value) => { exitCode = value; },
    collectExpectation: async () => EXPECTED,
    runVerification: async () => { throw captured; },
  });

  assert.equal(result, undefined);
  assert.equal(stdout, "");
  assert.equal(stderr, "PLATFORM_RECEIPT_RELEASE_INVALID\n");
  assert.equal(exitCode, 1);
});

test("platform receipt CLI never echoes malformed stage evidence or arbitrary errors", async () => {
  const marker = "PRIVATE/path/document.hwpx AWS_SECRET_ACCESS_KEY=marker";
  for (const runVerification of [
    async () => {
      const receipt = failedReleaseReceipt("node-tests");
      receipt.stages.at(-1).stdout = marker;
      return receipt;
    },
    async () => {
      const error = new Error(marker);
      error.stage = `node-tests\n${marker}`;
      throw error;
    },
    async () => {
      const error = new Error(marker);
      error.code = "PLATFORM_RECEIPT_RELEASE_INVALID";
      error.stage = "node-tests";
      throw error;
    },
  ]) {
    let stderr = "";
    const result = await runPlatformReceiptCli({
      args: ["create"],
      env: { EXPECTED_HEAD_SHA: EXPECTED.commit },
      root: process.cwd(),
      stdout: { write() {} },
      stderr: { write: (value) => { stderr += value; } },
      setExitCode() {},
      collectExpectation: async () => EXPECTED,
      runVerification,
    });

    assert.equal(result, undefined);
    assert.match(stderr, /^PLATFORM_RECEIPT_[A-Z_]+\n$/u);
    assert.doesNotMatch(stderr, /stage=/u);
    assert.doesNotMatch(stderr, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

async function createRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-platform-receipt-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Gpt_Codex_HWP contributors");
  git(root, "config", "user.email", "224273819+Burntgogi@users.noreply.github.com");
  await mkdir(join(root, "plugins", "gpt-codex-hwp"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"version":"0.2.0"}\n', "utf8");
  await writeFile(join(root, "plugins", "gpt-codex-hwp", "runtime.txt"), "runtime\n", "utf8");
  await writeFile(join(root, ".gitattributes"), "*.txt text\n", "utf8");
  await writeFile(join(root, ".gitignore"), "release-receipts/\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture");
  return root;
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}
