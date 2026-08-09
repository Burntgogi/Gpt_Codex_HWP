import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadProjectMetadata,
  pluginVersion,
  renderGeneratedTypeScript,
  syncProjectMetadata,
} from "../scripts/project-metadata.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const GENERATED_PATH = join(
  "packages",
  "gpt-codex-hwp",
  "src",
  "generated",
  "project-metadata.ts",
);
const BASE_ROOT_PACKAGE = {
  name: "gpt-codex-hwp-repository",
  version: "0.2.0",
  license: "Apache-2.0",
  config: {
    productId: "gpt-codex-hwp",
    displayName: "Gpt_Codex_HWP",
    developerName: "Gpt_Codex_HWP contributors",
    marketplaceName: "gpt-codex-hwp-local",
    legacyUninstallSelector: "hwp-korean-docs@hwp-local",
    codexBuildId: "20260713023606",
  },
};

test("root metadata is validated, frozen, and synchronized", async () => {
  const metadata = await loadProjectMetadata(ROOT);

  assert.equal(metadata.productId, "gpt-codex-hwp");
  assert.equal(metadata.displayName, "Gpt_Codex_HWP");
  assert.equal(metadata.version, "0.2.5");
  assert.match(metadata.codexBuildId, /^[0-9]{14}$/u);
  assert.ok(metadata.codexBuildId > "20260809212902");
  assert.equal(pluginVersion(metadata), `0.2.5+codex.${metadata.codexBuildId}`);
  assert.equal(metadata.legacyUninstallSelector, "hwp-korean-docs@hwp-local");
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(
    renderGeneratedTypeScript(metadata),
    `export const PROJECT_METADATA = Object.freeze({\n` +
      `  productId: "gpt-codex-hwp",\n` +
      `  displayName: "Gpt_Codex_HWP",\n` +
      `  version: "0.2.5",\n` +
      `} as const);\n`,
  );
  await assert.doesNotReject(syncProjectMetadata({ root: ROOT, check: true }));
});

test("metadata loader rejects missing or empty values", async (t) => {
  const fixture = await createFixture(t);
  const fields = [
    "version",
    "productId",
    "displayName",
    "developerName",
    "marketplaceName",
    "legacyUninstallSelector",
    "codexBuildId",
  ];

  for (const field of fields) {
    for (const variant of ["empty", "missing"]) {
      const rootPackage = structuredClone(BASE_ROOT_PACKAGE);
      if (field === "version") {
        if (variant === "empty") rootPackage.version = "";
        else delete rootPackage.version;
      } else if (variant === "empty") rootPackage.config[field] = "";
      else delete rootPackage.config[field];
      await writeJson(join(fixture, "package.json"), rootPackage);
      await assert.rejects(
        loadProjectMetadata(fixture),
        (error) => error instanceof Error && error.message.includes(field),
        `expected ${variant} ${field} to be rejected`,
      );
    }
  }
});

test("metadata loader rejects invalid semantic versions, build IDs, and legacy selectors", async (t) => {
  const fixture = await createFixture(t);
  const cases = [
    ["version", "1.4", "version"],
    ["version", "0.2.0+ci.1", "version"],
    ["codexBuildId", "20260713", "codexBuildId"],
    ["legacyUninstallSelector", "gpt-codex-hwp@gpt-codex-hwp-local", "legacyUninstallSelector"],
  ];

  for (const [field, value, expectedMessage] of cases) {
    const rootPackage = structuredClone(BASE_ROOT_PACKAGE);
    if (field === "version") rootPackage.version = value;
    else rootPackage.config[field] = value;
    await writeJson(join(fixture, "package.json"), rootPackage);
    await assert.rejects(
      loadProjectMetadata(fixture),
      (error) => error instanceof Error && error.message.includes(expectedMessage),
    );
  }
});

test("metadata loader accepts release and prerelease versions without build metadata", async (t) => {
  const fixture = await createFixture(t);

  for (const version of ["0.2.0", "0.2.0-rc.1"]) {
    const rootPackage = structuredClone(BASE_ROOT_PACKAGE);
    rootPackage.version = version;
    await writeJson(join(fixture, "package.json"), rootPackage);
    const metadata = await loadProjectMetadata(fixture);
    assert.equal(metadata.version, version);
    assert.equal(pluginVersion(metadata), `${version}+codex.20260713023606`);
  }
});

test("metadata synchronization updates declared targets and preserves historical text", async (t) => {
  const fixture = await createSyncFixture(t);

  await syncProjectMetadata({ root: fixture, check: false });

  const sourcePackage = await readJson(join(fixture, "packages", "gpt-codex-hwp", "package.json"));
  assert.equal(sourcePackage.name, "gpt-codex-hwp");
  assert.equal(sourcePackage.version, "0.2.0");
  assert.equal(sourcePackage.license, "Apache-2.0");

  const sourceLock = await readJson(join(fixture, "packages", "gpt-codex-hwp", "package-lock.json"));
  assert.equal(sourceLock.name, "gpt-codex-hwp");
  assert.equal(sourceLock.version, "0.2.0");
  assert.equal(sourceLock.packages[""].name, "gpt-codex-hwp");
  assert.equal(sourceLock.packages[""].version, "0.2.0");
  assert.equal(sourceLock.packages[""].license, "Apache-2.0");

  const skill = await readFile(
    join(fixture, "packages", "gpt-codex-hwp", "skills", "gpt-codex-hwp", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\nname: gpt-codex-hwp\n/u);
  assert.match(skill, /\n# Gpt_Codex_HWP\n/u);
  assert.match(skill, /Historical selector: hwp-korean-docs@hwp-local/u);

  const agent = await readFile(
    join(fixture, "packages", "gpt-codex-hwp", "skills", "gpt-codex-hwp", "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(agent, /^interface:\n  display_name: "Gpt_Codex_HWP"\n/u);
  assert.match(agent, /\$gpt-codex-hwp/u);

  const rootPackageBefore = await readFile(join(fixture, "package.json"), "utf8");
  await assert.doesNotReject(syncProjectMetadata({ root: fixture, check: true }));
  assert.equal(await readFile(join(fixture, "package.json"), "utf8"), rootPackageBefore);
});

test("check mode reports METADATA_DRIFT without rewriting the generated file", async (t) => {
  const fixture = await createSyncFixture(t);
  await syncProjectMetadata({ root: fixture, check: false });
  const generated = join(fixture, GENERATED_PATH);
  const drifted = `${await readFile(generated, "utf8")}// deliberate drift\n`;
  await writeFile(generated, drifted, "utf8");

  await assert.rejects(
    syncProjectMetadata({ root: fixture, check: true }),
    (error) => {
      assert.equal(error?.code, "METADATA_DRIFT");
      assert.equal(error?.message, `METADATA_DRIFT: ${GENERATED_PATH.replaceAll("\\", "/")}`);
      return true;
    },
  );
  assert.equal(await readFile(generated, "utf8"), drifted);
});

async function createFixture(t) {
  const fixture = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-metadata-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeJson(join(fixture, "package.json"), BASE_ROOT_PACKAGE);
  return fixture;
}

async function createSyncFixture(t) {
  const fixture = await createFixture(t);
  const sourceRoot = join(fixture, "packages", "gpt-codex-hwp");
  const skillRoot = join(sourceRoot, "skills", "gpt-codex-hwp");
  await mkdir(join(sourceRoot, "src", "generated"), { recursive: true });
  await mkdir(join(skillRoot, "agents"), { recursive: true });
  await writeJson(join(sourceRoot, "package.json"), {
    name: "old-name",
    version: "9.9.9",
    license: "old-license",
    dependencies: { kordoc: "file:vendor/kordoc-core" },
  });
  await writeJson(join(sourceRoot, "package-lock.json"), {
    name: "old-name",
    version: "9.9.9",
    lockfileVersion: 3,
    packages: {
      "": { name: "old-name", version: "9.9.9", license: "old-license" },
      "node_modules/kordoc": { resolved: "vendor/kordoc-core" },
    },
  });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: old-name\ndescription: Fixture.\n---\n\n# Old Name\n\nHistorical selector: hwp-korean-docs@hwp-local\n`,
    "utf8",
  );
  await writeFile(
    join(skillRoot, "agents", "openai.yaml"),
    `interface:\n  display_name: "Old Name"\n  short_description: "Fixture"\n  default_prompt: "Use $old-name for the fixture."\n`,
    "utf8",
  );
  return fixture;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
