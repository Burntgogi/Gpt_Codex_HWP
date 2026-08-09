import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProjectMetadata, pluginVersion } from "../scripts/project-metadata.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const IMMUTABLE_RELEASES = Object.freeze([
  "0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.2.0", "0.2.1", "0.2.2", "0.2.3", "0.2.4",
]);
const PREVIOUS_BUILD_ID = "20260809212902";
const EXPECTED_BUILD_ID = "20260809232847";

test("release identity derives every 0.2.5 release surface from root metadata", async () => {
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
  const mcpSource = await readText("packages/gpt-codex-hwp/src/mcp-main.ts");
  const skill = await readText("plugins/gpt-codex-hwp/skills/gpt-codex-hwp/SKILL.md");
  const artifactBuilder = await readText(
    "packages/gpt-codex-hwp/release-scripts/build-release-artifacts.mjs",
  );
  const releaseDocs = await Promise.all([
    "README.md", "README.en.md", "RELEASE_NOTES.md", "RELEASE_NOTES.en.md", "CHANGELOG.md",
  ].map(readText));
  const contributing = await readText("CONTRIBUTING.md");

  assert.equal(rootPackage.version, "0.2.5");
  assert.equal(metadata.version, rootPackage.version);
  assert.match(metadata.codexBuildId, /^[0-9]{14}$/u);
  assert.equal(metadata.codexBuildId, EXPECTED_BUILD_ID);
  assert.ok(BigInt(metadata.codexBuildId) > BigInt(PREVIOUS_BUILD_ID));
  assert.equal(expectedPluginVersion, `0.2.5+codex.${metadata.codexBuildId}`);
  assert.equal(sourcePackage.version, metadata.version);
  assert.equal(sourceLock.version, metadata.version);
  assert.equal(sourceLock.packages[""].version, metadata.version);
  assert.equal(runtimePackage.version, metadata.version);
  assert.equal(runtimeLock.version, metadata.version);
  assert.equal(runtimeLock.packages[""].version, metadata.version);
  assert.equal(plugin.version, `0.2.5+codex.${EXPECTED_BUILD_ID}`);
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
  for (const document of releaseDocs.slice(0, 4)) {
    assert.match(document, /v?0\.2\.5/u);
  }
  assert.match(releaseDocs[0], /## v0\.2\.5 릴리즈/u);
  assert.doesNotMatch(releaseDocs[0], /## v0\.2\.5 릴리즈 후보/u);
  assert.match(releaseDocs[1], /## v0\.2\.5 Release/u);
  assert.doesNotMatch(releaseDocs[1], /## v0\.2\.5 Release Candidate/u);
  assert.match(releaseDocs[2], /상태: 정식 릴리즈/u);
  assert.match(releaseDocs[3], /Status: final release/iu);
  assert.match(releaseDocs[4], /^## \[0\.2\.5\] - 2026-08-10$/mu);
  assert.match(releaseDocs[4], /^## \[0\.2\.4\] - 2026-08-09$/mu);
  assert.match(releaseDocs[4], /^## \[0\.2\.3\] - 2026-08-08$/mu);
  assert.match(releaseDocs[4], /^## \[0\.2\.2\] -/mu);
  assert.match(releaseDocs[0], /macOS[^\n]+실제 (?:Mac )?기기[^\n]+(?:미검증|아직 검증하지 않았)/u);
  assert.match(releaseDocs[1], /macOS[^\n]+physical Mac[^\n]+unverified/iu);

  const stableKo = markdownSection(releaseDocs[0], "## 안정 버전 v0.2.5 GitHub 설치", "## 설치 및 마이그레이션");
  const stableEn = markdownSection(releaseDocs[1], "## Stable v0.2.5 installation from GitHub", "## Installation and Migration");
  for (const stable of [stableKo, stableEn]) {
    assert.match(stable, /--ref v0\.2\.5/u);
    assert.match(stable, /0\.2\.5\+codex\.20260809232847/u);
    assert.match(stable, /dist\/oneshot\.js/u);
    assert.match(stable, /examples\/oneshot-tool-schemas\.json/u);
    assert.match(stable, /dist\/mcp\.js/u);
    assert.match(stable, /\/mcp/u);
    assert.match(stable, /node dist\/install-runtime\.js --json/u);
    assert.match(stable, /RUNTIME_INSTALL_OK/u);
    assert.match(stable, /RUNTIME_NOT_INSTALLED/u);
    assert.doesNotMatch(stable, /npm ci --omit=dev --ignore-scripts/u);
    assert.doesNotMatch(stable, /\.mcp\.json/u);
  }
  assert.doesNotMatch(releaseDocs[0], /## 로컬 v0\.2\.5 릴리즈 후보 검증/u);
  assert.doesNotMatch(releaseDocs[1], /## Local v0\.2\.5 release-candidate verification/u);
  assert.match(stableKo, /\/mcp[^\n]+기본[^\n]+등록되지 않/u);
  assert.match(stableEn, /\/mcp[^\n]+no default/iu);
  assert.match(stableKo, /새 작업만으로는 충분하지 않/u);
  assert.match(stableKo, /mcpServers[^\n]+없/u);
  assert.match(stableKo, /작업 하나[^\n]+성공[^\n]+생성 결과[^\n]+검증[^\n]+종료/u);
  assert.match(stableEn, /new task alone is not sufficient/iu);
  assert.match(stableEn, /no `mcpServers` property/iu);
  assert.match(stableEn, /one HWP\/HWPX operation[^\n]+succeed(?:s)?[^\n]+verif[^\n]+generated output[^\n]+exit/iu);

  for (const readme of releaseDocs.slice(0, 2)) {
    for (const command of [
      "codex plugin remove gpt-codex-hwp@gpt-codex-hwp-local --json",
      "codex plugin marketplace remove gpt-codex-hwp-local --json",
      "codex plugin marketplace add Burntgogi/Gpt_Codex_HWP --ref v0.2.2 --json",
      "$installed = codex plugin add gpt-codex-hwp@gpt-codex-hwp-local --json | ConvertFrom-Json",
    ]) assert.ok(readme.includes(command), `missing rollback command: ${command}`);
    assert.match(readme, /모든 Codex CLI와 Desktop 호스트를 완전히 종료|close every active Codex CLI and Desktop host completely/iu);
    assert.match(readme, /성공 후에만|Only after success/iu);
  }
  for (const required of [
    "git rev-parse 'v0.2.5^{commit}'",
    "release_ref=v0.2.5",
    "release_version=0.2.5",
    "gpt-codex-hwp-0.2.5.zip",
    "gpt-codex-hwp-0.2.5.spdx.json",
    "provenance.json",
    "SHA256SUMS",
  ]) assert.ok(contributing.includes(required), `missing release handoff contract: ${required}`);
  assert.match(contributing, /Never rebuild, repackage, or substitute local files/iu);

  const notesKoInstallation = markdownSection(releaseDocs[2], "## 설치와 업그레이드", "## 호환성과 알려진 제한");
  const notesEnInstallation = markdownSection(releaseDocs[3], "## Installation and upgrade", "## Compatibility and known limitations");
  for (const installation of [notesKoInstallation, notesEnInstallation]) {
    assert.match(installation, /node dist\/install-runtime\.js --json/u);
    assert.match(installation, /RUNTIME_INSTALL_OK/u);
    assert.match(installation, /RUNTIME_NOT_INSTALLED/u);
    assert.doesNotMatch(installation, /npm ci --omit=dev --ignore-scripts/u);
  }
  assert.match(notesKoInstallation, /문서 작업 하나[^\n]+성공[^\n]+생성 결과[^\n]+검증[^\n]+one-shot 프로세스와 그 하위 프로세스[^\n]+종료/u);
  assert.match(notesEnInstallation, /one document operation[^\n]+succeed(?:s)?[^\n]+verif[^\n]+generated output[^\n]+one-shot process and (?:its )?descendants[^\n]+exit/iu);

  assert.doesNotMatch(releaseDocs[2], /421|SVG\/PNG/u);
  assert.doesNotMatch(releaseDocs[3], /421|SVG\/PNG/u);
  assert.match(
    releaseDocs[2],
    /설치 런타임 one-shot[^\n]+HWPX[^\n]+검증[^\n]+감독[^\n]+하위 프로세스 0개/u,
  );
  assert.match(
    releaseDocs[3],
    /installed-runtime one-shot[^\n]+HWPX[^\n]+validated[^\n]+zero remaining supervised descendants/iu,
  );

  assert.match(releaseDocs[2], /상주 Gpt_Codex_HWP Node 프로세스는 0개/u);
  assert.match(releaseDocs[2], /고정 RSS[^\n]+설치 크기[^\n]+주장하지 않/u);
  assert.match(releaseDocs[3], /zero persistent Gpt_Codex_HWP Node processes/iu);
  assert.match(releaseDocs[3], /No fixed RSS percentage or installation-size reduction is claimed/iu);
  for (const notes of releaseDocs.slice(2, 4)) {
    assert.doesNotMatch(notes, /44\.\d+\s*MiB|0\.6%/u);
  }

  const unreleased = markdownSection(releaseDocs[4], "## [Unreleased]", "## [0.2.5]");
  assert.equal(unreleased.trim(), "## [Unreleased]");
  const currentRelease = markdownSection(releaseDocs[4], "## [0.2.5]", "## [0.2.4]");
  assert.match(currentRelease, /bounded per-file runner/u);
  assert.match(currentRelease, /User runtime and tool behavior are unchanged/u);
  const unpublishedCandidate = markdownSection(releaseDocs[4], "## [0.2.4]", "## [0.2.3]");
  assert.match(unpublishedCandidate, /unpublished candidate/u);
  assert.match(unpublishedCandidate, /no GitHub Release[\s\S]+distribution assets/iu);
});

function markdownSection(document, startHeading, endHeading) {
  const start = document.indexOf(startHeading);
  const end = document.indexOf(endHeading, start + startHeading.length);
  assert.ok(start >= 0, `missing section: ${startHeading}`);
  assert.ok(end > start, `missing section boundary: ${endHeading}`);
  return document.slice(start, end);
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return readFile(join(ROOT, ...relativePath.split("/")), "utf8");
}
