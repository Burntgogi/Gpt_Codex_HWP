import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildRuntime, compareRuntime } from "../scripts/project-runtime.mjs";
import { verifyKordocCoreRuntime } from "../scripts/kordoc-core-runtime.mjs";

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
const GENERATED_FILES = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "package-lock.json",
  "package.json",
];
const SKILL_ICON_FILES = [
  "skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon-64.png",
  "skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon.png",
];
const FORBIDDEN_SEGMENTS = new Set([
  "node_modules", "src", "tests", "fixtures", "release-scripts", ".superpowers", "artifacts", "tmp",
]);
const FORBIDDEN_EXTENSIONS = new Set([".hwp", ".hwpx", ".map", ".pem", ".p12", ".pfx"]);

let temporaryRoot;
let expectedRoot;
let actualRoot;

before(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-projection-test-"));
  expectedRoot = join(temporaryRoot, "expected");
  actualRoot = join(temporaryRoot, "actual");
  await buildRuntime({ root: ROOT, outputRoot: expectedRoot });
  await buildRuntime({ root: ROOT, outputRoot: actualRoot });
});

after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("runtime projection contains the exact sorted allowlist and no special entries", async () => {
  const actual = await regularEntries(actualRoot);
  const expected = [
    ...GENERATED_FILES,
    ...ROOT_DOCUMENTS,
    ...await prefixedFiles(join(SOURCE, "assets"), "assets"),
    ...await prefixedFiles(join(actualRoot, "dist"), "dist"),
    ...PYTHON_RUNTIME_FILES.map((name) => `scripts/hwpx-safe-edit/${name}`),
    ...await prefixedFiles(join(SOURCE, "skills", "gpt-codex-hwp"), "skills/gpt-codex-hwp"),
    ...SKILL_ICON_FILES,
    ...await prefixedFiles(join(SOURCE, "vendor", "kordoc-core"), "vendor/kordoc-core"),
  ].sort(comparePaths);

  assert.deepEqual(actual.map(({ path }) => path), expected);
  assert.ok(actual.every(({ kind }) => kind === "file"));
  for (const { path } of actual) {
    const segments = path.split("/");
    assert.equal(segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)), false, path);
    assert.equal(FORBIDDEN_EXTENSIONS.has(extname(path).toLowerCase()), false, path);
  }
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
    const target = join(copy, "linked-license");
    try {
      await symlink(join(copy, "LICENSE"), target, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        linkTest.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(verifyKordocCoreRuntime(copy), /Symbolic links are forbidden/u);
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
