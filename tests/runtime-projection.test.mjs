import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRuntime, compareRuntime } from "../scripts/project-runtime.mjs";
import { verifyKordocCoreRuntime } from "../scripts/kordoc-core-runtime.mjs";
import { createCanonicalTemporaryDirectory } from "../scripts/canonical-temp.mjs";
import { releaseSubprocessEnvironment } from "../scripts/release-subprocess-environment.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SOURCE = join(ROOT, "packages", "gpt-codex-hwp");
const TOOL_NAMES = [
  "hwp_create_svg_asset",
  "hwp_detect_format",
  "hwp_fill_form",
  "hwp_generate_hwpx",
  "hwp_insert_image",
  "hwp_patch_document",
  "hwp_read",
  "hwp_render_preview",
  "hwp_validate",
];
const ROOT_DOCUMENTS = [
  "LICENSE",
  "NOTICE",
  "README.en.md",
  "README.md",
  "RELEASE_NOTES.en.md",
  "RELEASE_NOTES.md",
  "THIRD_PARTY_NOTICES.md",
];
const PYTHON_RUNTIME_FILES = ["hwpxlib.py", "insert_image.py", "verify.py"];
const READ_ONLY_RUNTIME_FILES = ["scripts/kordoc-runtime-verifier.mjs"];
const GENERATED_FILES = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "package-lock.json",
  "package.json",
];
const PACKAGE_RUNTIME_FILES = [".npmrc"];
const SKILL_ICON_FILES = [
  "skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon-64.png",
  "skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon.png",
];
const FORBIDDEN_SEGMENTS = new Set([
  "node_modules", "src", "tests", "fixtures", "release-scripts", ".superpowers", "artifacts", "tmp",
  "plans", "specs", "evidence", "temporary",
]);
const FORBIDDEN_EXTENSIONS = new Set([".hwp", ".hwpx", ".map", ".pem", ".p12", ".pfx"]);

let temporaryRoot;
let expectedRoot;
let actualRoot;

before(async () => {
  temporaryRoot = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-projection-test-",
  });
  expectedRoot = join(temporaryRoot, "expected");
  actualRoot = join(temporaryRoot, "actual");
  await buildRuntime({ root: ROOT, outputRoot: expectedRoot });
  await buildRuntime({ root: ROOT, outputRoot: actualRoot });
});

after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("runtime compiler receives an explicit validated scrubbed subprocess environment", async () => {
  const probePath = join(temporaryRoot, "compiler-environment-probe.cjs");
  const evidencePath = join(temporaryRoot, "compiler-environment-evidence.json");
  const output = join(temporaryRoot, "compiler-environment-runtime");
  await writeFile(probePath, [
    'const { writeFileSync } = require("node:fs")',
    `const evidencePath = ${JSON.stringify(evidencePath)}`,
    "const forbiddenGitKeys = Object.keys(process.env).filter((key) => /^GIT_/i.test(key) && key !== 'GIT_NO_REPLACE_OBJECTS')",
    "const evidence = { forbiddenGitKeyCount: forbiddenGitKeys.length, hasNodeTestContext: Object.keys(process.env).some((key) => /^NODE_TEST_CONTEXT$/i.test(key)), noReplace: process.env.GIT_NO_REPLACE_OBJECTS === '1' }",
    "writeFileSync(evidencePath, JSON.stringify(evidence))",
    "if (evidence.forbiddenGitKeyCount !== 0 || evidence.hasNodeTestContext || !evidence.noReplace) process.exit(91)",
  ].join(";"), "utf8");

  const hostile = {
    GIT_DIR: "hostile-dir",
    GIT_WORK_TREE: "hostile-worktree",
    GIT_OBJECT_DIRECTORY: "hostile-objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "hostile-alternates",
    GIT_REPLACE_REF_BASE: "hostile-replacements",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "hostile-hooks",
    NODE_TEST_CONTEXT: "hostile-test-context",
    NODE_OPTIONS: `--require=${probePath}`,
  };
  const original = new Map();
  try {
    for (const [key, value] of Object.entries(hostile)) {
      original.set(key, process.env[key]);
      process.env[key] = value;
    }
    await buildRuntime({
      root: ROOT,
      outputRoot: output,
      subprocessEnvironment: releaseSubprocessEnvironment(),
    });
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")), {
    forbiddenGitKeyCount: 0,
    hasNodeTestContext: false,
    noReplace: true,
  });

  for (const subprocessEnvironment of [
    null,
    [],
    { SAFE: 1 },
    { "BAD\0KEY": "value" },
    { SAFE: "bad\0value" },
  ]) {
    await assert.rejects(
      buildRuntime({
        root: ROOT,
        outputRoot: join(temporaryRoot, `invalid-environment-${Math.random()}`),
        subprocessEnvironment,
      }),
      /subprocessEnvironment/u,
    );
  }
});

test("runtime compiler preserves exact keys from a null-prototype environment", async () => {
  const probePath = join(temporaryRoot, "compiler-record-fidelity-probe.cjs");
  const evidencePath = join(temporaryRoot, "compiler-record-fidelity-evidence.json");
  const output = join(temporaryRoot, "compiler-record-fidelity-runtime");
  await writeFile(probePath, [
    'const { writeFileSync } = require("node:fs")',
    `const evidencePath = ${JSON.stringify(evidencePath)}`,
    "const evidence = { ownPrototypeName: Object.hasOwn(process.env, '__proto__'), prototypeName: process.env.__proto__, ownConstructorName: Object.hasOwn(process.env, 'constructor'), constructorName: process.env.constructor, safeValue: process.env.SAFE_RUNTIME_VALUE }",
    "writeFileSync(evidencePath, JSON.stringify(evidence))",
    "if (!evidence.ownPrototypeName || evidence.prototypeName !== 'runtime-prototype-name' || !evidence.ownConstructorName || evidence.constructorName !== 'runtime-constructor-name' || evidence.safeValue !== 'runtime-safe-value') process.exit(92)",
  ].join(";"), "utf8");
  const subprocessEnvironment = Object.create(null);
  for (const [key, value] of Object.entries(releaseSubprocessEnvironment())) {
    subprocessEnvironment[key] = value;
  }
  subprocessEnvironment.NODE_OPTIONS = `--require=${probePath}`;
  subprocessEnvironment.__proto__ = "runtime-prototype-name";
  subprocessEnvironment.constructor = "runtime-constructor-name";
  subprocessEnvironment.SAFE_RUNTIME_VALUE = "runtime-safe-value";

  await buildRuntime({
    root: ROOT,
    outputRoot: output,
    subprocessEnvironment,
  });
  assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")), {
    ownPrototypeName: true,
    prototypeName: "runtime-prototype-name",
    ownConstructorName: true,
    constructorName: "runtime-constructor-name",
    safeValue: "runtime-safe-value",
  });

  const invalidEnvironment = Object.create(null);
  invalidEnvironment.SAFE_RUNTIME_VALUE = { unexpected: true };
  await assert.rejects(
    buildRuntime({
      root: ROOT,
      outputRoot: join(temporaryRoot, "invalid-object-environment"),
      subprocessEnvironment: invalidEnvironment,
    }),
    /subprocessEnvironment/u,
  );
});

test("runtime projection contains the exact sorted allowlist and no special entries", async () => {
  const actual = await regularEntries(actualRoot);
  const expected = [
    ...GENERATED_FILES,
    ...PACKAGE_RUNTIME_FILES,
    ...ROOT_DOCUMENTS,
    ...await prefixedFiles(join(SOURCE, "assets"), "assets"),
    ...await prefixedFiles(join(actualRoot, "dist"), "dist"),
    ...PYTHON_RUNTIME_FILES.map((name) => `scripts/hwpx-safe-edit/${name}`),
    ...READ_ONLY_RUNTIME_FILES,
    ...await prefixedFiles(join(SOURCE, "skills", "gpt-codex-hwp"), "skills/gpt-codex-hwp"),
    ...SKILL_ICON_FILES,
    ...await prefixedFiles(join(SOURCE, "vendor", "kordoc-core"), "vendor/kordoc-core"),
  ].sort(comparePaths);

  assert.deepEqual(actual.map(({ path }) => path), expected);
  for (const requiredPath of [
    "dist/doctor.js",
    "dist/workers/document-child-start-gate.js",
    "dist/workers/document-process-registration.js",
    "dist/workers/gpt-codex-hwp-job.dll",
    "dist/workers/registered-process-supervisor.js",
  ]) {
    assert.ok(actual.some(({ path }) => path === requiredPath), requiredPath);
  }
  assert.ok(actual.every(({ kind }) => kind === "file"));
  for (const { path } of actual) {
    const segments = path.split("/");
    assert.equal(segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)), false, path);
    assert.equal(FORBIDDEN_EXTENSIONS.has(extname(path).toLowerCase()), false, path);
    if (extname(path).toLowerCase() === ".dll") {
      assert.equal(path, "dist/workers/gpt-codex-hwp-job.dll");
    }
  }
});

test("projection refuses plans specs and temporary evidence nested below an allowlisted source tree", async () => {
  for (const [segment, name] of [
    ["plans", "public-source-plan.txt"],
    ["specs", "public-source-spec.txt"],
    ["evidence", "temporary-evidence.txt"],
  ]) {
    const sourceDirectory = join(SOURCE, "assets", segment);
    const sourcePath = join(sourceDirectory, name);
    const output = join(temporaryRoot, `forbidden-${segment}`);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, "must not ship\n", "utf8");
    try {
      await assert.rejects(
        buildRuntime({ root: ROOT, outputRoot: output }),
        new RegExp(`Forbidden runtime path was staged: assets/${segment}/`, "u"),
      );
      await assert.rejects(lstat(output), { code: "ENOENT" });
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  }
});

test("projection rejects forbidden filename tokens without substring false positives", async () => {
  for (const [index, name] of [
    "implementation-plan.md",
    "api.spec.txt",
    "release_evidence.json",
    "temporary-evidence.txt",
  ].entries()) {
    const sourcePath = join(SOURCE, "assets", name);
    const output = join(temporaryRoot, `forbidden-filename-${index}`);
    await writeFile(sourcePath, "must not ship\n", { encoding: "utf8", flag: "wx" });
    try {
      await assert.rejects(
        buildRuntime({ root: ROOT, outputRoot: output }),
        new RegExp(`Forbidden runtime path was staged: assets/${name.replaceAll(".", "\\.")}$`, "u"),
      );
      await assert.rejects(lstat(output), { code: "ENOENT" });
    } finally {
      await rm(sourcePath, { force: true });
    }
  }

  const binaryNearMiss = "planet.png";
  const binarySourcePath = join(SOURCE, "assets", binaryNearMiss);
  await writeFile(binarySourcePath, "allowed filename near miss\n", {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await assert.rejects(
      buildRuntime({ root: ROOT, outputRoot: join(temporaryRoot, "allowed-binary-near-miss") }),
      (error) => {
        assert.doesNotMatch(error.message, /Forbidden runtime path was staged/u);
        assert.match(
          error.message,
          /Runtime privacy violation \(binary not allowlisted\): assets\/planet\.png/u,
        );
        return true;
      },
    );
  } finally {
    await rm(binarySourcePath, { force: true });
  }

  const allowed = ["planning.md", "specification.md", "evidenced.md"];
  for (const name of allowed) {
    await writeFile(join(SOURCE, "assets", name), "allowed near miss\n", {
      encoding: "utf8",
      flag: "wx",
    });
  }
  const output = join(temporaryRoot, "allowed-filename-near-misses");
  try {
    await assert.doesNotReject(buildRuntime({ root: ROOT, outputRoot: output }));
    for (const name of allowed) {
      assert.equal(await readFile(join(output, "assets", name), "utf8"), "allowed near miss\n");
    }
  } finally {
    await Promise.all(allowed.map((name) => rm(join(SOURCE, "assets", name), { force: true })));
  }
});

test("root runtime fixtures canonicalize an injected aliased temp parent", async (t) => {
  const alias = await temporaryDirectoryAlias(t, "root-runtime-parent-");
  if (alias === undefined) return;
  const root = await createCanonicalTemporaryDirectory({
    parent: alias.path,
    prefix: "root-runtime-fixture-",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  assert.equal(dirname(root), alias.canonicalParent);
  const output = join(root, "runtime");
  await assert.doesNotReject(buildRuntime({ root: ROOT, outputRoot: output }));
});

test("package-local npm policy is projected byte-for-byte into the public runtime", async () => {
  const [rootPolicy, sourcePolicy, runtimePolicy] = await Promise.all([
    readFile(join(ROOT, ".npmrc")),
    readFile(join(SOURCE, ".npmrc")),
    readFile(join(actualRoot, ".npmrc")),
  ]);
  assert.deepEqual(sourcePolicy, rootPolicy);
  assert.deepEqual(runtimePolicy, sourcePolicy);
});

test("runtime copies exactly the two declared skill icons from package assets", async () => {
  const skillAssets = (await regularEntries(join(actualRoot, "skills", "gpt-codex-hwp", "assets")))
    .map(({ path }) => path);
  assert.deepEqual(skillAssets, ["gpt-codex-hwp-icon-64.png", "gpt-codex-hwp-icon.png"]);
  for (const name of skillAssets) {
    assert.equal(
      await sha256(join(actualRoot, "skills", "gpt-codex-hwp", "assets", name)),
      await sha256(join(SOURCE, "assets", name)),
    );
  }
});

test("runtime skill documents exactly the nine supported MCP tools", async () => {
  const skill = await readFile(join(actualRoot, "skills", "gpt-codex-hwp", "SKILL.md"), "utf8");
  const documented = [...new Set([...skill.matchAll(/`(hwp_[a-z_]+)`/gu)].map((match) => match[1]))]
    .sort(comparePaths);
  assert.deepEqual(documented, TOOL_NAMES);
});

test("runtime preserves the pinned compact Kordoc provenance", async () => {
  const record = await verifyKordocCoreRuntime(join(actualRoot, "vendor", "kordoc-core"));
  assert.equal(record.source.name, "kordoc");
  assert.equal(record.source.version, "3.18.1");
  assert.equal(record.archive.sha512, record.source.integrity);
});

test("two independently built projections have identical path and SHA-256 records", async () => {
  await assert.doesNotReject(compareRuntime({ expectedRoot, actualRoot }));
  assert.deepEqual(await hashedEntries(actualRoot), await hashedEntries(expectedRoot));
});

test("runtime contains no checkout-specific absolute path", async () => {
  const checkout = ROOT.replaceAll("\\", "/").toLowerCase();
  for (const { path } of await regularEntries(actualRoot)) {
    if ([".png"].includes(extname(path).toLowerCase())) continue;
    const text = (await readFile(join(actualRoot, ...path.split("/")), "utf8"))
      .replaceAll("\\", "/")
      .toLowerCase();
    assert.equal(text.includes(checkout), false, path);
  }
});

test("runtime drift reports only relative path and expected and actual hashes", async () => {
  const changedPath = join(actualRoot, "README.md");
  const expectedHash = await sha256(join(expectedRoot, "README.md"));
  await copyFile(join(expectedRoot, "README.md"), changedPath);
  await writeFile(changedPath, Buffer.concat([await readFile(changedPath), Buffer.from("\nchanged\n")]));
  const actualHash = await sha256(changedPath);

  try {
    await assert.rejects(
      compareRuntime({ expectedRoot, actualRoot }),
      (error) => {
        assert.equal(error?.code, "RUNTIME_DRIFT");
        assert.equal(error?.message, `RUNTIME_DRIFT: README.md expected=${expectedHash} actual=${actualHash}`);
        assert.equal(error.message.includes(temporaryRoot), false);
        return true;
      },
    );
  } finally {
    await copyFile(join(expectedRoot, "README.md"), changedPath);
  }
});

test("fresh compiler output cannot include a stale source dist file", async () => {
  const staleSource = join(SOURCE, "dist", "stale-output-must-not-ship.js");
  const output = join(temporaryRoot, "fresh-dist");
  await writeFile(staleSource, "throw new Error('stale');\n", "utf8");
  try {
    await buildRuntime({ root: ROOT, outputRoot: output });
    await assert.rejects(lstat(join(output, "dist", "stale-output-must-not-ship.js")), { code: "ENOENT" });
  } finally {
    await rm(staleSource, { force: true });
  }
});

test("comparison ignores only actual top-level node_modules", async () => {
  const sentinel = join(actualRoot, "node_modules", "sentinel.txt");
  await mkdir(dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "installed dependency sentinel\n", "utf8");
  try {
    await assert.doesNotReject(compareRuntime({ expectedRoot, actualRoot }));
    const extra = join(actualRoot, "unexpected.txt");
    await writeFile(extra, "unexpected\n", "utf8");
    try {
      await assert.rejects(compareRuntime({ expectedRoot, actualRoot }), (error) => {
        assert.equal(error?.code, "RUNTIME_DRIFT");
        assert.match(error.message, /^RUNTIME_DRIFT: unexpected\.txt expected=<missing> actual=[a-f0-9]{64}$/u);
        return true;
      });
    } finally {
      await rm(extra, { force: true });
    }
  } finally {
    await rm(join(actualRoot, "node_modules"), { recursive: true, force: true });
  }
});

test("comparison rejects a regular file masquerading as top-level node_modules", async () => {
  const nodeModules = join(actualRoot, "node_modules");
  await writeFile(nodeModules, "not a dependency directory\n", "utf8");
  try {
    await assert.rejects(
      compareRuntime({ expectedRoot, actualRoot }),
      /Actual runtime node_modules must be a non-symbolic-link directory/u,
    );
  } finally {
    await rm(nodeModules, { force: true });
  }
});

test("comparison rejects a top-level node_modules symbolic link or junction", async (t) => {
  const nodeModules = join(actualRoot, "node_modules");
  try {
    await symlink(expectedRoot, nodeModules, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`node_modules link creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  try {
    await assert.rejects(
      compareRuntime({ expectedRoot, actualRoot }),
      /Actual runtime node_modules must be a non-symbolic-link directory/u,
    );
  } finally {
    await unlink(nodeModules);
  }
});

test("Kordoc provenance rejects tampering, extra files, source maps, and links", async (t) => {
  const source = join(expectedRoot, "vendor", "kordoc-core");
  for (const scenario of ["tamper", "extra", "map"]) {
    await t.test(scenario, async () => {
      const copy = join(temporaryRoot, `kordoc-${scenario}`);
      await cp(source, copy, { recursive: true, errorOnExist: true, force: false });
      if (scenario === "tamper") await writeFile(join(copy, "LICENSE"), "tampered\n", "utf8");
      if (scenario === "extra") await writeFile(join(copy, "extra.txt"), "extra\n", "utf8");
      if (scenario === "map") await writeFile(join(copy, "dist", "forbidden.map"), "{}\n", "utf8");
      await assert.rejects(verifyKordocCoreRuntime(copy));
    });
  }

  await t.test("link", async (linkTest) => {
    const copy = join(temporaryRoot, "kordoc-link");
    await cp(source, copy, { recursive: true, errorOnExist: true, force: false });
    const windows = process.platform === "win32";
    const target = join(copy, "dist", windows ? "linked-dist" : "linked-license");
    try {
      await symlink(
        join(copy, windows ? "dist" : "LICENSE"),
        target,
        windows ? "junction" : "file",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        linkTest.skip(`link creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      verifyKordocCoreRuntime(copy),
      /Vendored Kordoc links are forbidden/u,
    );
  });
});

test("projection rejects a symbolic link in an allowed source subtree", async (t) => {
  const sourceLink = join(SOURCE, "assets", "forbidden-link.png");
  try {
    await symlink(join(SOURCE, "assets", "gpt-codex-hwp-icon.png"), sourceLink, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  try {
    await assert.rejects(
      buildRuntime({ root: ROOT, outputRoot: join(temporaryRoot, "source-link-output") }),
      /Runtime entries must be regular files/u,
    );
  } finally {
    await rm(sourceLink, { force: true });
  }
});

test("atomic projection refuses pre-existing unowned stage and backup paths", async () => {
  const output = join(temporaryRoot, "collision-output");
  const stage = join(temporaryRoot, ".collision-output.stage-collision");
  await mkdir(stage);
  await assert.rejects(
    buildRuntime({ root: ROOT, outputRoot: output, swapId: "collision" }),
    /Runtime staging path already exists/u,
  );
  assert.equal((await lstat(stage)).isDirectory(), true);

  await rm(stage, { recursive: true, force: true });
  await mkdir(output);
  await writeFile(join(output, "old.txt"), "old runtime\n", "utf8");
  const backup = join(temporaryRoot, ".collision-output.backup-collision");
  await mkdir(backup);
  await assert.rejects(
    buildRuntime({ root: ROOT, outputRoot: output, swapId: "collision" }),
    /Runtime backup path already exists/u,
  );
  assert.equal(await readFile(join(output, "old.txt"), "utf8"), "old runtime\n");
  assert.equal((await lstat(backup)).isDirectory(), true);
});

async function temporaryDirectoryAlias(t, prefix) {
  const base = await createCanonicalTemporaryDirectory({ prefix });
  const canonicalParent = join(base, "canonical");
  const path = join(base, "alias");
  await mkdir(canonicalParent);
  try {
    await symlink(canonicalParent, path, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) {
      t.skip(`directory aliases are unavailable (${error.code})`);
      return undefined;
    }
    throw error;
  }
  t.after(async () => rm(base, { recursive: true, force: true }));
  return { canonicalParent: await realpath(canonicalParent), path };
}

test("successful atomic projection removes its owned stage and backup", async () => {
  const output = join(temporaryRoot, "successful-swap-output");
  const stage = join(temporaryRoot, ".successful-swap-output.stage-successful-swap");
  const backup = join(temporaryRoot, ".successful-swap-output.backup-successful-swap");
  await mkdir(output);
  await writeFile(join(output, "old.txt"), "old runtime\n", "utf8");

  await buildRuntime({ root: ROOT, outputRoot: output, swapId: "successful-swap" });

  assert.equal((await lstat(join(output, "dist", "mcp.js"))).isFile(), true);
  await assert.rejects(lstat(join(output, "old.txt")), { code: "ENOENT" });
  await assert.rejects(lstat(stage), { code: "ENOENT" });
  await assert.rejects(lstat(backup), { code: "ENOENT" });
});

test("atomic projection restores the prior runtime when promotion fails", async () => {
  const output = join(temporaryRoot, "rollback-output");
  await mkdir(output);
  await writeFile(join(output, "old.txt"), "old runtime\n", "utf8");
  let rejectedPromotion = false;
  const injectedRename = async (source, destination) => {
    if (!rejectedPromotion && source.includes(".rollback-output.stage-") && destination === output) {
      rejectedPromotion = true;
      const error = new Error("injected promotion failure");
      error.code = "EIO";
      throw error;
    }
    await rename(source, destination);
  };

  await assert.rejects(
    buildRuntime({ root: ROOT, outputRoot: output, fileSystem: { rename: injectedRename } }),
    /injected promotion failure/u,
  );
  assert.equal(rejectedPromotion, true);
  assert.equal(await readFile(join(output, "old.txt"), "utf8"), "old runtime\n");
  assert.deepEqual(
    (await readdir(temporaryRoot)).filter((name) => name.startsWith(".rollback-output.")),
    [],
  );
});

test("failed promotion rollback preserves staged and backup projection evidence", async () => {
  const output = join(temporaryRoot, "promotion-rollback-failure-output");
  const stage = join(temporaryRoot, ".promotion-rollback-failure-output.stage-promotion-rollback");
  const backup = join(temporaryRoot, ".promotion-rollback-failure-output.backup-promotion-rollback");
  await mkdir(output);
  await writeFile(join(output, "old.txt"), "old runtime\n", "utf8");
  const injectedRename = async (source, destination) => {
    if ((source === stage && destination === output) || (source === backup && destination === output)) {
      const error = new Error("injected rename failure");
      error.code = "EIO";
      throw error;
    }
    await rename(source, destination);
  };

  try {
    await assert.rejects(
      buildRuntime({
        root: ROOT,
        outputRoot: output,
        swapId: "promotion-rollback",
        fileSystem: { rename: injectedRename },
      }),
      (error) => {
        assert.equal(error?.code, "RUNTIME_ROLLBACK_FAILED");
        assert.equal(
          error?.message,
          "RUNTIME_ROLLBACK_FAILED: promotion failed and the prior runtime could not be restored; staged runtime and backup evidence preserved",
        );
        assert.equal(error.message.includes(temporaryRoot), false);
        return true;
      },
    );
    await assert.rejects(lstat(output), { code: "ENOENT" });
    assert.equal((await lstat(join(stage, "dist", "mcp.js"))).isFile(), true);
    assert.equal(await readFile(join(backup, "old.txt"), "utf8"), "old runtime\n");
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
});

test("backup cleanup failure keeps the committed new runtime and old backup evidence", async () => {
  const output = join(temporaryRoot, "cleanup-failure-output");
  const stage = join(temporaryRoot, ".cleanup-failure-output.stage-cleanup-failure");
  const backup = join(temporaryRoot, ".cleanup-failure-output.backup-cleanup-failure");
  await mkdir(output);
  await writeFile(join(output, "old.txt"), "old runtime\n", "utf8");
  let rejectedBackupCleanup = false;
  const injectedRm = async (path, options) => {
    if (!rejectedBackupCleanup && path === backup) {
      rejectedBackupCleanup = true;
      const error = new Error("injected backup cleanup failure");
      error.code = "EIO";
      throw error;
    }
    await rm(path, options);
  };

  try {
    await assert.rejects(
      buildRuntime({
        root: ROOT,
        outputRoot: output,
        swapId: "cleanup-failure",
        fileSystem: { rm: injectedRm },
      }),
      (error) => {
        assert.equal(error?.code, "RUNTIME_BACKUP_CLEANUP_FAILED");
        assert.equal(
          error?.message,
          "RUNTIME_BACKUP_CLEANUP_FAILED: new runtime remains live; remaining backup evidence left untouched",
        );
        assert.equal(error.message.includes(temporaryRoot), false);
        return true;
      },
    );
    assert.equal(rejectedBackupCleanup, true);
    assert.equal((await lstat(join(output, "dist", "mcp.js"))).isFile(), true);
    await assert.rejects(lstat(join(output, "old.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(backup, "old.txt"), "utf8"), "old runtime\n");
    await assert.rejects(lstat(stage), { code: "ENOENT" });
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
});

test("partially deleted backup is never promoted after cleanup failure", async () => {
  const output = join(temporaryRoot, "partial-cleanup-output");
  const stage = join(temporaryRoot, ".partial-cleanup-output.stage-partial-cleanup");
  const backup = join(temporaryRoot, ".partial-cleanup-output.backup-partial-cleanup");
  await mkdir(output);
  await writeFile(join(output, "old.txt"), "old runtime\n", "utf8");
  await writeFile(join(output, "remaining-evidence.txt"), "old backup evidence\n", "utf8");
  const injectedRm = async (path, options) => {
    if (path === backup) {
      await rm(join(path, "old.txt"), { force: true });
      const error = new Error("injected partial backup cleanup failure");
      error.code = "EIO";
      throw error;
    }
    await rm(path, options);
  };

  try {
    await assert.rejects(
      buildRuntime({
        root: ROOT,
        outputRoot: output,
        swapId: "partial-cleanup",
        fileSystem: { rm: injectedRm },
      }),
      (error) => {
        assert.equal(error?.code, "RUNTIME_BACKUP_CLEANUP_FAILED");
        assert.equal(
          error?.message,
          "RUNTIME_BACKUP_CLEANUP_FAILED: new runtime remains live; remaining backup evidence left untouched",
        );
        assert.equal(error.message.includes(temporaryRoot), false);
        return true;
      },
    );
    assert.equal((await lstat(join(output, "dist", "mcp.js"))).isFile(), true);
    await assert.rejects(lstat(join(output, "remaining-evidence.txt")), { code: "ENOENT" });
    await assert.rejects(lstat(join(backup, "old.txt")), { code: "ENOENT" });
    assert.equal(
      await readFile(join(backup, "remaining-evidence.txt"), "utf8"),
      "old backup evidence\n",
    );
    await assert.rejects(lstat(stage), { code: "ENOENT" });
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
});

async function prefixedFiles(root, prefix) {
  return (await regularEntries(root)).map(({ path }) => `${prefix}/${path}`);
}

async function hashedEntries(root) {
  const result = [];
  for (const { path, kind } of await regularEntries(root)) {
    assert.equal(kind, "file", path);
    result.push({ path, sha256: await sha256(join(root, ...path.split("/"))) });
  }
  return result;
}

async function regularEntries(root, base = root) {
  const result = [];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    const entryPath = relative(base, path).replaceAll("\\", "/");
    if (metadata.isSymbolicLink()) result.push({ path: entryPath, kind: "link" });
    else if (metadata.isDirectory()) result.push(...await regularEntries(path, base));
    else if (metadata.isFile()) result.push({ path: entryPath, kind: "file" });
    else result.push({ path: entryPath, kind: "special" });
  }
  return result;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}
