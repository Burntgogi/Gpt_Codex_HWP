import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SOURCE = join(ROOT, "packages", "gpt-codex-hwp");

test("public repository contains source and a separate compact runtime projection", async () => {
  for (const path of [
    "src/mcp.ts",
    "tests/tools.test.ts",
    "scripts/hwpx-safe-edit/test_hwpx_safe_edit.py",
    "release-scripts/public-runtime-privacy.mjs",
    "vendor/kordoc-core/PROVENANCE.json",
    "skills/gpt-codex-hwp/SKILL.md",
  ]) await access(join(SOURCE, path));
  await access(join(ROOT, "plugins", "gpt-codex-hwp", "dist", "mcp.js"));
});

test("source package declares only approved direct dependencies", async () => {
  const sourcePackage = JSON.parse(await readFile(join(SOURCE, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(sourcePackage.dependencies).sort(), [
    "@modelcontextprotocol/sdk",
    "@xmldom/xmldom",
    "cfb",
    "jszip",
    "kordoc",
    "sharp",
    "zod",
  ]);
  assert.deepEqual(sourcePackage.optionalDependencies, { "@rhwp/core": "0.7.17" });
});

test("source lock contains no root-repository link from prefixed installs", async () => {
  const sourceLock = JSON.parse(await readFile(join(SOURCE, "package-lock.json"), "utf8"));
  const packageKeys = Object.keys(sourceLock.packages ?? {});

  assert.deepEqual(packageKeys.filter((path) => path === ".." || path.startsWith("../")), []);
  assert.doesNotMatch(JSON.stringify(sourceLock), /gpt-codex-hwp-repository|file:\.\.\/\.\./u);
  assert.equal(sourceLock.packages?.[""]?.dependencies?.kordoc, "file:vendor/kordoc-core");
  assert.equal(sourceLock.packages?.["node_modules/kordoc"]?.resolved, "vendor/kordoc-core");
});

test("public source contains no private planning or user-document paths", async () => {
  const files = await regularFiles(ROOT);
  const allowedFixture = "packages/gpt-codex-hwp/tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp";
  const forbidden = files
    .map((path) => relative(ROOT, path).replaceAll("\\", "/"))
    .filter((path) => path !== allowedFixture)
    .filter((path) => /(^|\/)(docs\/superpowers|artifacts|tmp|node_modules)(\/|$)|\.(?:hwp|hwpx)$/iu.test(path));
  assert.deepEqual(forbidden, []);
});

async function regularFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if ([".git", ".superpowers", "node_modules"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await regularFiles(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
