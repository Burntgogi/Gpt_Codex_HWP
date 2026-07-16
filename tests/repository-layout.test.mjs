import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("security boundary documentation repository exclusions cover private and generated files", () => {
  const ignored = [
    ".env",
    ".env.local",
    "secrets/private.pem",
    "secrets/private.key",
    "secrets/signing.p12",
    "secrets/signing.pfx",
    "secrets/certificate.cer",
    "secrets/certificate.crt",
    "credentials.json",
    "config/local.json",
    ".worktrees/security-review/file.txt",
    "coverage/lcov.info",
    "build/output.bin",
    "release-receipts/receipt.json",
    "benchmark-output/result.json",
    "release-staging/archive.zip",
    "package/__pycache__/cache.pyc",
    ".pytest_cache/state",
    ".venv/pyvenv.cfg",
    "node_modules/package/index.js",
    "private-document.hwp",
    "private-document.hwpx",
  ];

  for (const path of ignored) {
    assert.equal(isIgnored(path), true, `${path} must be ignored`);
  }
  assert.equal(isIgnored(".env.example"), false, ".env.example must remain publishable");
  assert.equal(
    isIgnored("packages/gpt-codex-hwp/tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp"),
    false,
    "the pinned public fixture must remain publishable",
  );
});

test("security boundary documentation npm installs are hook-free and reproducible", async () => {
  const npmrc = await readFile(join(ROOT, ".npmrc"), "utf8");
  const settings = new Map(
    npmrc
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=", 2)),
  );

  assert.equal(settings.get("ignore-scripts"), "true");
  assert.equal(settings.get("audit"), "false");
  assert.equal(settings.get("package-lock"), "true");
  assert.equal(settings.get("save-exact"), "true");
  assert.equal(settings.get("engine-strict"), "true");
});

function isIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", path], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.ok([0, 1].includes(result.status), result.stderr || `git check-ignore failed for ${path}`);
  return result.status === 0;
}

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
