import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProjectMetadata, pluginVersion } from "../scripts/project-metadata.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const IMMUTABLE_RELEASES = Object.freeze(["0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4"]);
const LAST_BUILD_ID = "20260713023606";

test("release identity derives every changed candidate surface from 0.2.0 root metadata", async () => {
  const metadata = await loadProjectMetadata(ROOT);
  const expectedPluginVersion = pluginVersion(metadata);
  const rootPackage = await readJson("package.json");
  const sourcePackage = await readJson("packages/gpt-codex-hwp/package.json");
  const sourceLock = await readJson("packages/gpt-codex-hwp/package-lock.json");
  const runtimePackage = await readJson("plugins/gpt-codex-hwp/package.json");
  const runtimeLock = await readJson("plugins/gpt-codex-hwp/package-lock.json");
  const plugin = await readJson("plugins/gpt-codex-hwp/.codex-plugin/plugin.json");
  const generated = await readText("packages/gpt-codex-hwp/src/generated/project-metadata.ts");
  const runtimeGenerated = await readText("plugins/gpt-codex-hwp/dist/generated/project-metadata.js");
  const mcpSource = await readText("packages/gpt-codex-hwp/src/mcp.ts");
  const skill = await readText("plugins/gpt-codex-hwp/skills/gpt-codex-hwp/SKILL.md");
  const artifactBuilder = await readText(
    "packages/gpt-codex-hwp/release-scripts/build-release-artifacts.mjs",
  );
  const candidateDocs = await Promise.all([
    "README.md", "README.en.md", "RELEASE_NOTES.md", "RELEASE_NOTES.en.md", "CHANGELOG.md",
  ].map(readText));

  assert.equal(rootPackage.version, "0.2.0");
  assert.equal(metadata.version, rootPackage.version);
  assert.match(metadata.codexBuildId, /^[0-9]{14}$/u);
  assert.ok(metadata.codexBuildId > LAST_BUILD_ID);
  assert.equal(expectedPluginVersion, `0.2.0+codex.${metadata.codexBuildId}`);
  assert.equal(sourcePackage.version, metadata.version);
  assert.equal(sourceLock.version, metadata.version);
  assert.equal(sourceLock.packages[""].version, metadata.version);
  assert.equal(runtimePackage.version, metadata.version);
  assert.equal(runtimeLock.version, metadata.version);
  assert.equal(runtimeLock.packages[""].version, metadata.version);
  assert.equal(plugin.version, expectedPluginVersion);
  assert.match(generated, new RegExp(`version: ${JSON.stringify(metadata.version)}`));
  assert.match(runtimeGenerated, new RegExp(`version: ${JSON.stringify(metadata.version)}`));

  // MCP and skill identity are projected with the same runtime/plugin metadata.
  assert.match(mcpSource, /version:\s*PROJECT_METADATA\.version/u);
  assert.match(skill, /^name: gpt-codex-hwp$/mu);
  assert.equal(plugin.skills, "./skills/");

  // Archive filename, SPDX document name, and provenance subject all use the
  // source-package version synchronized from root metadata.
  assert.match(artifactBuilder, /const version = requiredVersion\(sourcePackage\.version\)/u);
  assert.match(artifactBuilder, /const zipName = `\$\{PRODUCT\}-\$\{version\}\.zip`/u);
  assert.match(artifactBuilder, /const sbomName = `\$\{PRODUCT\}-\$\{version\}\.spdx\.json`/u);
  assert.match(artifactBuilder, /subject: \{ name: PRODUCT, version \}/u);
  assert.match(artifactBuilder, /name: `\$\{PRODUCT\}-\$\{version\}`/u);

  for (const immutable of IMMUTABLE_RELEASES) {
    assert.notEqual(metadata.version, immutable, `changed bytes must not reuse v${immutable}`);
    assert.notEqual(expectedPluginVersion, immutable);
    assert.ok(!expectedPluginVersion.startsWith(`${immutable}+`));
  }
  for (const document of candidateDocs) {
    assert.match(document, /v?0\.2\.0/u);
  }
  assert.match(candidateDocs[0], /릴리즈 후보/u);
  assert.match(candidateDocs[1], /release candidate/iu);
  assert.match(candidateDocs[2], /상태: 릴리즈 후보/u);
  assert.match(candidateDocs[3], /Status: release candidate/iu);
  assert.match(candidateDocs[4], /0\.2\.0 release candidate/iu);
  assert.match(candidateDocs[0], /macOS[^\n]+실제 기기[^\n]+미검증/u);
  assert.match(candidateDocs[1], /macOS[^\n]+physical Mac[^\n]+unverified/iu);
});

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return readFile(join(ROOT, ...relativePath.split("/")), "utf8");
}
