import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXCLUDED_PACKAGES,
  assertCompactLockfile,
} from "../packages/gpt-codex-hwp/release-scripts/compact-policy.mjs";
import {
  INSTALLED_EXCLUDED_PACKAGES,
  assertInstalledDependencyTree,
  isInstalledExcludedPackagePath,
  verifyInstalledDependencies,
} from "../scripts/verify-installed-dependencies.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SOURCE = join(ROOT, "packages", "gpt-codex-hwp");
const RUNTIME = join(ROOT, "plugins", "gpt-codex-hwp");
const LOCAL_KORDOC_SPECIFIER = "file:vendor/kordoc-core";
const LOCAL_KORDOC_RESOLUTION = "vendor/kordoc-core";
const EXPECTED_EXCLUDED_PACKAGES = Object.freeze([
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-web",
  "@hyzyla/pdfium",
  "pdfjs-dist",
  "boolean",
]);
const EXPECTED_DEPENDENCIES = Object.freeze({
  "@modelcontextprotocol/sdk": "1.29.0",
  "@xmldom/xmldom": "0.9.10",
  cfb: "1.2.2",
  jszip: "3.10.1",
  kordoc: LOCAL_KORDOC_SPECIFIER,
  sharp: "0.35.3",
  zod: "3.25.76",
});
const EXPECTED_OPTIONAL_DEPENDENCIES = Object.freeze({ "@rhwp/core": "0.7.17" });
const EXPECTED_DEV_DEPENDENCIES = Object.freeze({
  "@types/node": "22.20.1",
  tsx: "4.23.1",
  typescript: "5.9.3",
});
const EXPECTED_OVERRIDES = Object.freeze({
  "@hono/node-server": "2.0.11",
  "fast-uri": "3.1.4",
});
const EXPECTED_TOOL_NAMES = Object.freeze([
  "hwp_create_svg_asset",
  "hwp_detect_format",
  "hwp_fill_form",
  "hwp_generate_hwpx",
  "hwp_insert_image",
  "hwp_patch_document",
  "hwp_read",
  "hwp_render_preview",
  "hwp_validate",
]);

test("dependency contract pins exact direct source and runtime metadata", async () => {
  const rootPackage = await readJson(join(ROOT, "package.json"));
  const sourcePackage = await readJson(join(SOURCE, "package.json"));
  const runtimePackage = await readJson(join(RUNTIME, "package.json"));

  assert.deepEqual(sourcePackage.dependencies, EXPECTED_DEPENDENCIES);
  assert.deepEqual(sourcePackage.optionalDependencies, EXPECTED_OPTIONAL_DEPENDENCIES);
  assert.deepEqual(sourcePackage.devDependencies, EXPECTED_DEV_DEPENDENCIES);
  assert.deepEqual(sourcePackage.overrides, EXPECTED_OVERRIDES);
  assert.deepEqual(runtimePackage.dependencies, EXPECTED_DEPENDENCIES);
  assert.deepEqual(runtimePackage.optionalDependencies, EXPECTED_OPTIONAL_DEPENDENCIES);
  assert.deepEqual(runtimePackage.overrides, EXPECTED_OVERRIDES);
  assert.equal(Object.hasOwn(runtimePackage, "devDependencies"), false);
  assert.deepEqual(runtimePackage.scripts, {
    doctor: "node dist/doctor.js",
    start: "node dist/mcp.js",
  });
  assert.equal(rootPackage.scripts?.["verify:dependencies"], "node scripts/verify-installed-dependencies.mjs");
  assert.equal(
    rootPackage.scripts?.["verify:source-dependencies"],
    "node scripts/verify-installed-dependencies.mjs --source-only",
  );
  assert.equal(
    rootPackage.scripts?.["test:policy"],
    "node --test tests/workflow-policy.test.mjs tests/github-policy.test.mjs tests/dependency-contract.test.mjs",
  );
});

test("dependency contract resolves the patched Hono Node adapter in both locks", async () => {
  for (const [label, root] of [["source", SOURCE], ["runtime", RUNTIME]]) {
    const lock = await readJson(join(root, "package-lock.json"));
    const adapter = lock.packages?.["node_modules/@hono/node-server"];
    assert.equal(adapter?.version, "2.0.11", label);
    assert.equal(
      adapter?.resolved,
      "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz",
      label,
    );
  }
});

test("dependency contract resolves patched production dependencies and projects an equivalent graph", async () => {
  const locks = new Map();
  for (const [label, root] of [["source", SOURCE], ["runtime", RUNTIME]]) {
    const lock = await readJson(join(root, "package-lock.json"));
    locks.set(label, lock);
    assert.equal(lock.packages?.["node_modules/sharp"]?.version, "0.35.3", label);
    assert.equal(lock.packages?.["node_modules/fast-uri"]?.version, "3.1.4", label);
  }

  assert.deepEqual(
    productionDependencyGraph(locks.get("runtime")),
    productionDependencyGraph(locks.get("source")),
  );
  assert.equal(
    Object.hasOwn(locks.get("source").packages["node_modules/@img/sharp-wasm32"], "cpu"),
    false,
  );
  assert.deepEqual(
    locks.get("runtime").packages["node_modules/@img/sharp-wasm32"].cpu,
    ["wasm32"],
  );
  for (const path of ["node_modules/@emnapi/runtime", "node_modules/tslib"]) {
    assert.equal(Object.hasOwn(locks.get("runtime").packages[path], "cpu"), false, path);
  }
});

test("public installation guidance has one npm-ci step and no normalizer", async () => {
  for (const path of [
    join(ROOT, "README.md"),
    join(ROOT, "README.en.md"),
    join(SOURCE, "skills", "gpt-codex-hwp", "SKILL.md"),
  ]) {
    const content = await readFile(path, "utf8");
    assert.doesNotMatch(content, /normalize-sharp-optional-tree|normaliz(?:e|ation).*Sharp/iu, path);
    assert.match(content, /npm ci --omit=dev --ignore-scripts/u, path);
  }
});

test("public guidance makes one-shot execution the default lifecycle", async () => {
  const skill = await readFile(join(SOURCE, "skills", "gpt-codex-hwp", "SKILL.md"), "utf8");
  assert.match(skill, /dist\/oneshot\.js/u);
  assert.match(skill, /--request/u);
  assert.match(skill, /--response/u);
  assert.match(skill, /two parent directories|두 단계 상위/iu);
  assert.match(skill, /exactly the keys\s+"schemaVersion",\s+"tool",\s+and\s+"arguments"/iu);
  assert.match(skill, /\{plugin_root\}\/examples\/oneshot-tool-schemas\.json/u);
  assert.match(skill, /\{"schemaVersion":1,"tool":"hwp_detect_format","arguments":\{"file_path":"C:\\\\Documents\\\\sample\.hwp"\}\}/u);
  assert.match(skill, /owner-only control directory/iu);
  assert.match(skill, /0700.*0600/iu);
  assert.match(skill, /current user plus SYSTEM/iu);
  assert.match(skill, /exact request, response, and empty directory/iu);

  const korean = await readFile(join(ROOT, "README.md"), "utf8");
  const english = await readFile(join(ROOT, "README.en.md"), "utf8");
  for (const content of [korean, english]) {
    assert.match(content, /dist\/oneshot\.js/u);
    assert.match(content, /examples\/mcp-manual\.json/u);
    assert.match(content, /\/mcp/u);
  }
  assert.match(korean, /상주.*Node|Node.*상주/u);
  assert.match(english, /persistent.*Node|Node.*persistent/iu);
});

test("dependency contract resolves Kordoc only through the vendored compact core", async () => {
  for (const [label, root] of [["source", SOURCE], ["runtime", RUNTIME]]) {
    const packageJson = await readJson(join(root, "package.json"));
    const lock = await readJson(join(root, "package-lock.json"));
    const rootRecord = lock.packages?.[""];
    const linkRecord = lock.packages?.["node_modules/kordoc"];
    const vendorRecord = lock.packages?.["vendor/kordoc-core"];

    assert.equal(packageJson.dependencies?.kordoc, LOCAL_KORDOC_SPECIFIER, label);
    assert.equal(rootRecord?.dependencies?.kordoc, LOCAL_KORDOC_SPECIFIER, label);
    assert.deepEqual(linkRecord, { resolved: LOCAL_KORDOC_RESOLUTION, link: true }, label);
    assert.equal(vendorRecord?.name, "kordoc", label);
    assert.equal(vendorRecord?.version, "3.18.1", label);
    assert.equal(vendorRecord?.license, "MIT", label);

    const registryReferences = Object.entries(lock.packages ?? {})
      .filter(([path, record]) => path !== "node_modules/kordoc"
        && path !== "vendor/kordoc-core"
        && (record?.name === "kordoc" || /(?:^|\/)kordoc(?:\/|$)/iu.test(path)));
    assert.deepEqual(registryReferences, [], `${label} lock contains another Kordoc package`);
  }
});

test("dependency contract independently pins every heavyweight exclusion", async () => {
  assert.deepEqual(EXCLUDED_PACKAGES, EXPECTED_EXCLUDED_PACKAGES);
  assert.deepEqual(INSTALLED_EXCLUDED_PACKAGES, EXPECTED_EXCLUDED_PACKAGES);
  for (const packageName of EXPECTED_EXCLUDED_PACKAGES) {
    assert.equal(isInstalledExcludedPackagePath(`node_modules/${packageName}/package.json`), true, packageName);
    assert.equal(
      isInstalledExcludedPackagePath(`node_modules/transitive/node_modules/${packageName}/package.json`),
      true,
      packageName,
    );
  }
});

test("dependency contract excludes heavyweight packages from both locks", async () => {
  for (const [label, root] of [["source", SOURCE], ["runtime", RUNTIME]]) {
    const lock = await readJson(join(root, "package-lock.json"));
    assert.deepEqual(assertCompactLockfile(lock), [], label);
    const excludedPaths = Object.keys(lock.packages ?? {}).filter(isInstalledExcludedPackagePath);
    assert.deepEqual(excludedPaths, [], label);
  }
});

test("dependency contract keeps exactly nine public runtime tools", async () => {
  const toolRoot = join(RUNTIME, "dist", "tools");
  const names = new Set();
  for (const entry of await readdir(toolRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = await readFile(join(toolRoot, entry.name), "utf8");
    for (const match of source.matchAll(/(?:export\s+)?const\s+HWP_[A-Z0-9_]+_TOOL_NAME\s*=\s*"(hwp_[a-z0-9_]+)"/gu)) {
      names.add(match[1]);
    }
  }
  assert.deepEqual([...names].sort(comparePaths), [...EXPECTED_TOOL_NAMES]);
});

test("installed dependency verifier accepts only the canonical Kordoc link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-dependency-contract-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const nodeModules = join(root, "node_modules");
  const vendor = join(root, "vendor", "kordoc-core");
  await mkdir(nodeModules, { recursive: true });
  await mkdir(vendor, { recursive: true });
  await writeFile(join(vendor, "package.json"), "{}\n");
  try {
    await symlink(vendor, join(nodeModules, "kordoc"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code ?? "")) {
      t.skip(`directory-link capability is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.doesNotReject(assertInstalledDependencyTree({ packageRoot: root, label: "fixture" }));

  await mkdir(join(nodeModules, "onnxruntime-node"));
  await assert.rejects(
    assertInstalledDependencyTree({ packageRoot: root, label: "fixture" }),
    /excluded package path.*node_modules\/onnxruntime-node/iu,
  );
  await rm(join(nodeModules, "onnxruntime-node"), { recursive: true });

  await unlink(join(nodeModules, "kordoc"));
  const wrongTarget = join(root, "wrong-kordoc");
  await mkdir(wrongTarget);
  await symlink(wrongTarget, join(nodeModules, "kordoc"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    assertInstalledDependencyTree({ packageRoot: root, label: "fixture" }),
    /Kordoc link target is not the vendored compact core/iu,
  );
});

test("source-only dependency verification needs no installed runtime and rejects bad source trees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-source-dependencies-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "packages", "gpt-codex-hwp");
  const nodeModules = join(source, "node_modules");
  const vendor = join(source, "vendor", "kordoc-core");
  await mkdir(nodeModules, { recursive: true });
  await mkdir(vendor, { recursive: true });
  await writeFile(join(vendor, "package.json"), "{}\n");
  try {
    await symlink(vendor, join(nodeModules, "kordoc"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code ?? "")) {
      t.skip(`directory-link capability is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const sourceOnly = await verifyInstalledDependencies({ root, sourceOnly: true });
  assert.deepEqual(Object.keys(sourceOnly), ["source"]);
  assert.equal(sourceOnly.source.label, "source");
  await assert.rejects(
    verifyInstalledDependencies({ root }),
    /runtime node_modules is missing/iu,
  );

  await mkdir(join(nodeModules, "boolean"));
  await assert.rejects(
    verifyInstalledDependencies({ root, sourceOnly: true }),
    /source contains excluded package path.*node_modules\/boolean/iu,
  );
  await rm(join(nodeModules, "boolean"), { recursive: true });
  await rm(nodeModules, { recursive: true });
  await assert.rejects(
    verifyInstalledDependencies({ root, sourceOnly: true }),
    /source node_modules is missing/iu,
  );
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}

function productionDependencyGraph(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, record]) => path !== "" && record?.dev !== true)
    .map(([path, record]) => ({
      name: packageNameFromLockPath(path),
      version: record?.version ?? null,
      integrity: record?.integrity ?? null,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function packageNameFromLockPath(path) {
  const segments = path.split("/");
  const packageStart = segments.lastIndexOf("node_modules") + 1;
  if (segments[packageStart]?.startsWith("@")) return `${segments[packageStart]}/${segments[packageStart + 1]}`;
  return segments[packageStart] ?? path;
}
