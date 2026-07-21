import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProjectMetadata, pluginVersion } from "../../../scripts/project-metadata.mjs";
import { buildRuntime } from "../../../scripts/project-runtime.mjs";
import { createCanonicalTemporaryDirectory } from "../../../scripts/canonical-temp.mjs";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(TEST_ROOT, "..");
const REPOSITORY_ROOT = resolve(SOURCE_ROOT, "../..");

test("public runtime projection stages only branded executable files", { timeout: 120_000 }, async (t) => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-runtime-suite-",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const output = join(root, "runtime");
  const result = await buildRuntime({ root: REPOSITORY_ROOT, outputRoot: output });
  const metadata = await loadProjectMetadata(REPOSITORY_ROOT);

  assert.equal(result.outputRoot, output);
  const required = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "assets/gpt-codex-hwp-banner.png",
    "assets/gpt-codex-hwp-icon.png",
    "assets/gpt-codex-hwp-icon-64.png",
    "assets/gpt-codex-hwp-icon-128.png",
    "dist/doctor.js",
    "dist/mcp.js",
    "dist/workers/document-child-start-gate.js",
    "dist/workers/document-process-registration.js",
    "dist/workers/registered-process-supervisor.js",
    "dist/workers/gpt-codex-hwp-job.dll",
    "dist/workers/windows-job-supervisor.ps1",
    "scripts/hwpx-safe-edit/hwpxlib.py",
    "scripts/hwpx-safe-edit/insert_image.py",
    "scripts/hwpx-safe-edit/verify.py",
    "scripts/kordoc-runtime-verifier.mjs",
    "skills/gpt-codex-hwp/SKILL.md",
    "skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon-64.png",
    "skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon.png",
    "package.json",
    "package-lock.json",
    "README.md",
    "README.en.md",
    "RELEASE_NOTES.md",
    "RELEASE_NOTES.en.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "vendor/kordoc-core/PROVENANCE.json",
    "vendor/kordoc-core/LICENSE",
    "vendor/kordoc-core/package.json",
    "vendor/kordoc-core/README.md",
    "vendor/kordoc-core/dist/index.js",
  ];
  for (const path of required) await access(join(output, ...path.split("/")));
  for (const forbidden of [
    "src",
    "tests",
    "plans",
    "specs",
    "evidence",
    "temporary-evidence.txt",
    "tsconfig.json",
    "release-scripts",
    "node_modules",
    "scripts/hwpx-safe-edit/test_hwpx_safe_edit.py",
  ]) {
    await assert.rejects(lstat(join(output, ...forbidden.split("/"))), { code: "ENOENT" });
  }

  const packageJson = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
  assert.equal(packageJson.name, metadata.productId);
  assert.equal(packageJson.version, metadata.version);
  assert.deepEqual(packageJson.scripts, {
    doctor: "node dist/doctor.js",
    start: "node dist/mcp.js",
  });
  assert.equal(packageJson.devDependencies, undefined);

  const packageLock = JSON.parse(await readFile(join(output, "package-lock.json"), "utf8"));
  assert.equal(packageLock.name, metadata.productId);
  assert.equal(packageLock.version, metadata.version);
  assert.equal(packageLock.packages[""]?.name, metadata.productId);
  assert.equal(packageLock.packages[""]?.version, metadata.version);
  assert.equal(packageLock.packages[""]?.devDependencies, undefined);

  const pluginManifest = JSON.parse(
    await readFile(join(output, ".codex-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(pluginManifest.name, metadata.productId);
  assert.equal(pluginManifest.version, pluginVersion(metadata));
  assert.equal(pluginManifest.license, "Apache-2.0");
  assert.equal(pluginManifest.author.name, metadata.developerName);
  assert.equal(pluginManifest.interface.displayName, metadata.displayName);
  assert.equal(pluginManifest.interface.developerName, metadata.developerName);
  assert.equal(pluginManifest.interface.composerIcon, "./assets/gpt-codex-hwp-icon-64.png");
  assert.equal(pluginManifest.interface.logo, "./assets/gpt-codex-hwp-icon.png");
  assert.deepEqual(
    await readFile(join(output, "vendor", "kordoc-core", "dist", "index.js")),
    await readFile(join(SOURCE_ROOT, "vendor", "kordoc-core", "dist", "index.js")),
  );
  assert.deepEqual(
    await readFile(join(output, "dist", "workers", "windows-job-supervisor.ps1")),
    await readFile(join(SOURCE_ROOT, "src", "workers", "windows-job-supervisor.ps1")),
  );
  assert.deepEqual(
    await readFile(join(output, "dist", "workers", "gpt-codex-hwp-job.dll")),
    await readFile(join(SOURCE_ROOT, "src", "workers", "gpt-codex-hwp-job.dll")),
  );

  const notice = await readFile(join(output, "NOTICE"), "utf8");
  assert.match(notice, /Copyright 2026 Gpt_Codex_HWP contributors/u);
  const mcp = JSON.parse(await readFile(join(output, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), [metadata.productId]);

  assert.ok(result.files.length > 0);
  for (const file of result.files) {
    assert.doesNotMatch(file.path, /(?:^|\/)(?:src|tests|node_modules|release-scripts)(?:\/|$)/iu);
    assert.doesNotMatch(file.path, /(?:^|\/)\.env(?:\.|$)/iu);
    assert.equal([".hwp", ".hwpx", ".hml", ".docx", ".pdf", ".map"].includes(extname(file.path).toLowerCase()), false);
    if (extname(file.path).toLowerCase() === ".dll") {
      assert.equal(file.path, "dist/workers/gpt-codex-hwp-job.dll");
    }
  }
});

test("package runtime projection refuses plans specs and temporary evidence below copied assets", { timeout: 120_000 }, async (t) => {
  for (const [segment, name] of [
    ["plans", "package-plan.txt"],
    ["specs", "package-spec.txt"],
    ["evidence", "temporary-evidence.txt"],
  ]) {
    const sourceDirectory = join(SOURCE_ROOT, "assets", segment);
    const sourcePath = join(sourceDirectory, name);
    const outputRoot = await createCanonicalTemporaryDirectory({
      prefix: `gpt-codex-hwp-runtime-forbidden-${segment}-`,
    });
    t.after(async () => rm(outputRoot, { recursive: true, force: true }));
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, "must not ship\n", "utf8");
    try {
      await assert.rejects(
        buildRuntime({ root: REPOSITORY_ROOT, outputRoot: join(outputRoot, "runtime") }),
        new RegExp(`Forbidden runtime path was staged: assets/${segment}/`, "u"),
      );
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  }
});

test("package runtime projection rejects forbidden filename tokens without substring false positives", { timeout: 120_000 }, async (t) => {
  for (const [index, name] of [
    "implementation-plan.md",
    "api.spec.txt",
    "release_evidence.json",
    "temporary-evidence.txt",
  ].entries()) {
    const sourcePath = join(SOURCE_ROOT, "assets", name);
    const outputRoot = await createCanonicalTemporaryDirectory({
      prefix: `gpt-codex-hwp-runtime-forbidden-filename-${index}-`,
    });
    t.after(async () => rm(outputRoot, { recursive: true, force: true }));
    await writeFile(sourcePath, "must not ship\n", { encoding: "utf8", flag: "wx" });
    try {
      await assert.rejects(
        buildRuntime({ root: REPOSITORY_ROOT, outputRoot: join(outputRoot, "runtime") }),
        new RegExp(`Forbidden runtime path was staged: assets/${name.replaceAll(".", "\\.")}$`, "u"),
      );
    } finally {
      await rm(sourcePath, { force: true });
    }
  }

  const binaryNearMiss = "planet.png";
  const binarySourcePath = join(SOURCE_ROOT, "assets", binaryNearMiss);
  await writeFile(binarySourcePath, "allowed filename near miss\n", {
    encoding: "utf8",
    flag: "wx",
  });
  const binaryOutputRoot = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-runtime-allowed-binary-filename-",
  });
  t.after(async () => rm(binaryOutputRoot, { recursive: true, force: true }));
  try {
    await assert.rejects(
      buildRuntime({ root: REPOSITORY_ROOT, outputRoot: join(binaryOutputRoot, "runtime") }),
      (error: Error) => {
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
    await writeFile(join(SOURCE_ROOT, "assets", name), "allowed near miss\n", {
      encoding: "utf8",
      flag: "wx",
    });
  }
  const outputRoot = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-runtime-allowed-filenames-",
  });
  t.after(async () => rm(outputRoot, { recursive: true, force: true }));
  const output = join(outputRoot, "runtime");
  try {
    await assert.doesNotReject(buildRuntime({ root: REPOSITORY_ROOT, outputRoot: output }));
    for (const name of allowed) {
      assert.equal(await readFile(join(output, "assets", name), "utf8"), "allowed near miss\n");
    }
  } finally {
    await Promise.all(allowed.map((name) => rm(join(SOURCE_ROOT, "assets", name), { force: true })));
  }
});

test("package runtime fixtures canonicalize an injected aliased temp parent", async (t) => {
  const alias = await temporaryDirectoryAlias(t, "package-runtime-parent-");
  if (alias === undefined) return;
  const root = await createCanonicalTemporaryDirectory({
    parent: alias.path,
    prefix: "package-runtime-fixture-",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  assert.equal(dirname(root), alias.canonicalParent);
  const output = join(root, "runtime");
  await assert.doesNotReject(buildRuntime({ root: REPOSITORY_ROOT, outputRoot: output }));
});

test("owned projection cleanup removes a failed stage and permits retry", { timeout: 120_000 }, async (t) => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-runtime-retry-",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const output = join(root, "owned-output");
  const swapId = "injected-promotion-failure";
  const stage = join(root, `.${basename(output)}.stage-${swapId}`);
  const backup = join(root, `.${basename(output)}.backup-${swapId}`);
  let rejectedPromotion = false;

  await assert.rejects(
    buildRuntime({
      root: REPOSITORY_ROOT,
      outputRoot: output,
      swapId,
      fileSystem: {
        rename: async (source: string, destination: string) => {
          if (!rejectedPromotion && source === stage && destination === output) {
            rejectedPromotion = true;
            throw Object.assign(new Error("injected projection promotion failure"), { code: "EIO" });
          }
          await rename(source, destination);
        },
      },
    }),
    /injected projection promotion failure/iu,
  );
  assert.equal(rejectedPromotion, true);
  for (const path of [output, stage, backup]) {
    await assert.rejects(lstat(path), { code: "ENOENT" });
  }

  await assert.doesNotReject(buildRuntime({
    root: REPOSITORY_ROOT,
    outputRoot: output,
    swapId: "successful-retry",
  }));
  assert.equal((await lstat(join(output, "dist", "mcp.js"))).isFile(), true);
});

test("pre-existing unowned projection evidence is never removed", async (t) => {
  const root = await createCanonicalTemporaryDirectory({
    prefix: "gpt-codex-hwp-runtime-unowned-",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const output = join(root, "user-output");
  const swapId = "unowned-evidence";
  const stage = join(root, `.${basename(output)}.stage-${swapId}`);
  const backup = join(root, `.${basename(output)}.backup-${swapId}`);

  await mkdir(stage);
  await writeFile(join(stage, "keep.txt"), "unowned stage evidence\n");
  await assert.rejects(
    buildRuntime({ root: REPOSITORY_ROOT, outputRoot: output, swapId }),
    /Runtime staging path already exists/u,
  );
  assert.equal(await readFile(join(stage, "keep.txt"), "utf8"), "unowned stage evidence\n");

  await rm(stage, { recursive: true });
  await mkdir(output);
  await writeFile(join(output, "keep.txt"), "current runtime\n");
  await mkdir(backup);
  await writeFile(join(backup, "keep.txt"), "unowned backup evidence\n");
  await assert.rejects(
    buildRuntime({ root: REPOSITORY_ROOT, outputRoot: output, swapId }),
    /Runtime backup path already exists/u,
  );
  assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "current runtime\n");
  assert.equal(await readFile(join(backup, "keep.txt"), "utf8"), "unowned backup evidence\n");
});

async function temporaryDirectoryAlias(
  t: test.TestContext,
  prefix: string,
): Promise<{ canonicalParent: string; path: string } | undefined> {
  const base = await createCanonicalTemporaryDirectory({ prefix });
  const canonicalParent = join(base, "canonical");
  const path = join(base, "alias");
  await mkdir(canonicalParent);
  try {
    await symlink(canonicalParent, path, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code)) {
      t.skip(`directory aliases are unavailable (${(error as NodeJS.ErrnoException).code})`);
      return undefined;
    }
    throw error;
  }
  t.after(async () => rm(base, { recursive: true, force: true }));
  return { canonicalParent: await realpath(canonicalParent), path };
}
