import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProjectMetadata, pluginVersion } from "../../../scripts/project-metadata.mjs";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = dirname(TEST_ROOT);
const REPOSITORY_ROOT = dirname(dirname(SOURCE_ROOT));
const RUNTIME_ROOT = join(REPOSITORY_ROOT, "plugins", "gpt-codex-hwp");

test("production metadata derives the current release from the root record", async () => {
  const metadata = await loadProjectMetadata(REPOSITORY_ROOT);
  const [rootPackage, sourcePackage, sourceLock, pluginManifest, runtimePackage, runtimeLock] = await Promise.all([
    readJson(join(REPOSITORY_ROOT, "package.json")),
    readJson(join(SOURCE_ROOT, "package.json")),
    readJson(join(SOURCE_ROOT, "package-lock.json")),
    readJson(join(RUNTIME_ROOT, ".codex-plugin", "plugin.json")),
    readJson(join(RUNTIME_ROOT, "package.json")),
    readJson(join(RUNTIME_ROOT, "package-lock.json")),
  ]);

  assert.equal(rootPackage.version, metadata.version);
  assert.equal(sourcePackage.name, metadata.productId);
  assert.equal(sourcePackage.version, metadata.version);
  assert.equal(sourceLock.name, metadata.productId);
  assert.equal(sourceLock.version, metadata.version);
  assert.equal(sourceLock.packages[""]?.name, metadata.productId);
  assert.equal(sourceLock.packages[""]?.version, metadata.version);
  assert.equal(pluginManifest.name, metadata.productId);
  assert.equal(pluginManifest.version, pluginVersion(metadata));
  assert.equal(runtimePackage.name, metadata.productId);
  assert.equal(runtimePackage.version, metadata.version);
  assert.equal(runtimeLock.name, metadata.productId);
  assert.equal(runtimeLock.version, metadata.version);
  assert.equal(runtimeLock.packages[""]?.version, metadata.version);
});

test("the staged runtime documents HWP read-only and context-safe large reads", async () => {
  const executableAndSkill = await Promise.all([
    readFile(join(RUNTIME_ROOT, ".codex-plugin", "plugin.json"), "utf8"),
    readFile(join(RUNTIME_ROOT, "dist", "tools", "index.js"), "utf8"),
    readFile(join(RUNTIME_ROOT, "dist", "tools", "rhwp-backend.js"), "utf8"),
    readFile(join(RUNTIME_ROOT, "skills", "gpt-codex-hwp", "SKILL.md"), "utf8"),
  ]);
  for (const text of executableAndSkill) {
    assert.doesNotMatch(
      text,
      /hwp_export_hwp_experimental|Export HWP experimentally|experimental HWP export/iu,
    );
  }

  const skill = executableAndSkill.at(-1)!;
  const policy = [await readFile(join(RUNTIME_ROOT, "README.md"), "utf8"), skill].join("\n");
  for (const required of ["512 MiB", "64,000", "8 MiB", "markdown_output_path", "HWP_READ_ONLY"]) {
    assert.match(policy, new RegExp(escapeRegExp(required), "u"));
  }
  assert.match(skill, /gate for declaring macOS validated support/u);
  assert.doesNotMatch(skill, /release-approval gate/u);
});

test("macOS claims require a successful current-head platform receipt", async () => {
  const [koSource, enSource, skillSource, koRuntime, enRuntime, skillRuntime] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, "README.md"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "README.en.md"), "utf8"),
    readFile(join(SOURCE_ROOT, "skills", "gpt-codex-hwp", "SKILL.md"), "utf8"),
    readFile(join(RUNTIME_ROOT, "README.md"), "utf8"),
    readFile(join(RUNTIME_ROOT, "README.en.md"), "utf8"),
    readFile(join(RUNTIME_ROOT, "skills", "gpt-codex-hwp", "SKILL.md"), "utf8"),
  ]);

  for (const korean of [koSource, koRuntime]) {
    assert.match(korean, /주로 Windows x64에서 개발/u);
    assert.match(korean, /macOS Apple Silicon 플러그인 런타임 CI는 구성/u);
    assert.match(korean, /현재 HEAD에 대한 성공 영수증.*확인되기 전.*통과.*검증 완료.*표현하지/isu);
    assert.match(korean, /실제 macOS에서 Codex Desktop과 한컴오피스 한글을 사용하는 과정은 검증하지 않았/u);
    assert.match(korean, /macOS 완전 지원을 주장하지 않/u);
    assert.doesNotMatch(korean, /macOS(?: Apple Silicon)?(?:을|를|은|는)? 완전히 지원(?:합니다|함)/u);
    assertNoCompletedMacOsSupportClaim(korean);
  }
  for (const english of [enSource, enRuntime]) {
    assert.match(english, /developed primarily on Windows x64/u);
    assert.match(english, /macOS Apple Silicon plugin-runtime CI is configured/u);
    assert.match(english, /must not be described as passed or validated until a successful receipt for the current HEAD exists/u);
    assert.match(english, /Actual use with Codex Desktop and Hancom Office Hangul on macOS remains unverified/u);
    assert.match(english, /Full macOS support is not claimed/u);
    assert.doesNotMatch(english, /macOS(?: Apple Silicon)? is fully supported/iu);
    assert.doesNotMatch(english, /fully supports macOS/iu);
    assertNoCompletedMacOsSupportClaim(english);
  }
  for (const skill of [skillSource, skillRuntime]) {
    assert.match(skill, /developed primarily on Windows x64/u);
    assert.match(skill, /macOS Apple Silicon plugin-runtime CI is configured/u);
    assert.match(skill, /successful receipt for the current HEAD/u);
    assert.match(skill, /Codex Desktop and Hancom Office Hangul on macOS remains unverified/u);
    assert.match(skill, /gate for declaring macOS validated support/u);
  }
});

test("equivalent completed macOS support claims are rejected", () => {
  assert.doesNotThrow(() => assertNoCompletedMacOsSupportClaim(
    "Full macOS support is not claimed. macOS 완전 지원을 주장하지 않습니다.",
  ));
  for (const claim of [
    "macOS support is complete.",
    "Complete macOS support is available.",
    "macOS is production-ready.",
    "macOS는 지원 완료된 플랫폼입니다.",
    "macOS Apple Silicon은 검증 완료되었습니다.",
    "macOS를 완전히 지원합니다.",
  ]) {
    assert.throws(
      () => assertNoCompletedMacOsSupportClaim(claim),
      /completed macOS support claim/u,
      claim,
    );
  }
});

test("the staged runtime preserves the historical plugin removal selector", async () => {
  const metadata = await loadProjectMetadata(REPOSITORY_ROOT);
  const readmes = await Promise.all([
    readFile(join(RUNTIME_ROOT, "README.md"), "utf8"),
    readFile(join(RUNTIME_ROOT, "README.en.md"), "utf8"),
  ]);
  const command = `codex plugin remove ${metadata.legacyUninstallSelector}`;
  const replacement = `codex plugin remove ${metadata.productId}@${metadata.marketplaceName}`;
  for (const readme of readmes) {
    assert.equal(readme.split(command).length - 1, 1, "historical selector must remain exact and singular");
    assert.equal(readme.split(replacement).length - 1, 1, "the current selector must appear once in rollback guidance");
  }
});

test("the staged runtime retains the Pixelify Sans production-input notice", async () => {
  const thirdPartyNotices = await readFile(join(RUNTIME_ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(thirdPartyNotices, /^## Pixelify Sans$/mu);
  assert.match(thirdPartyNotices, /39df74aba80df8157546034b878e8be1eb565ced/u);
  assert.match(thirdPartyNotices, /OFL-1\.1/u);
  assert.match(
    thirdPartyNotices,
    /production-only typography input for rasterizing the title into `assets\/gpt-codex-hwp-banner\.png`/u,
  );
});

test("the staged runtime retains the agent branding metadata", async () => {
  const agent = await readFile(
    join(RUNTIME_ROOT, "skills", "gpt-codex-hwp", "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(agent, /^\s*icon_small: "\.\/assets\/gpt-codex-hwp-icon-64\.png"$/mu);
  assert.match(agent, /^\s*icon_large: "\.\/assets\/gpt-codex-hwp-icon\.png"$/mu);
  assert.match(agent, /^\s*brand_color: "#6574D9"$/mu);
});

function assertNoCompletedMacOsSupportClaim(document: string): void {
  const claims = document
    .replaceAll("Full macOS support is not claimed.", "")
    .replaceAll("full macOS support is not claimed.", "")
    .replaceAll("macOS 완전 지원을 주장하지 않습니다.", "");
  const forbiddenClaims = [
    /macOS(?: Apple Silicon)? support (?:is|has been) (?:complete|completed|validated|production[- ]ready)/iu,
    /(?:complete|completed|validated|production[- ]ready) macOS(?: Apple Silicon)? support/iu,
    /macOS(?: Apple Silicon)? (?:is|has been) (?:fully supported|completely supported|validated|production[- ]ready)/iu,
    /fully supports macOS/iu,
    /macOS(?: Apple Silicon)?(?:은|는|을|를)?\s*(?:지원|검증)(?:이|을|은|는)?\s*완료(?:된|되었|됐|되었습니다|됐습니다)?/u,
    /macOS(?: Apple Silicon)?(?:은|는|을|를)?\s*완전히\s*지원/u,
    /macOS(?: Apple Silicon)?\s*완전\s*지원(?:을|이)?\s*(?:제공|보장|완료)/u,
  ];
  for (const forbiddenClaim of forbiddenClaims) {
    assert.doesNotMatch(claims, forbiddenClaim, "completed macOS support claim is forbidden");
  }
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
