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
const MIGRATION_PATH = join(TEST_ROOT, "release-test-migration.json");
const SPLIT_SUITES = new Set([
  "kordoc-core-runtime.test.ts",
  "runtime-projection.test.ts",
  "public-runtime-privacy.test.ts",
  "release-metadata.test.ts",
]);

interface RetainedMigration {
  invariantId?: string;
  legacyOrdinal?: number;
  legacyTestName?: string;
  suite?: string;
  publicTestName?: string;
  scopeChange?: string;
}

interface RetiredMigration {
  invariantId?: string;
  legacyOrdinal?: number;
  legacyTestName?: string;
  reason?: string;
}

interface MigrationLedger {
  schemaVersion?: number;
  source?: {
    revision?: string;
    path?: string;
    gitBlob?: string;
    sizeBytes?: number;
    sha256?: string;
    testCount?: number;
  };
  retained?: RetainedMigration[];
  retired?: RetiredMigration[];
}

const PUBLIC_TOOL_NAMES = [
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

test("bilingual release documentation states the same release boundary", async () => {
  const metadata = await loadProjectMetadata(REPOSITORY_ROOT);
  const tag = `v${metadata.version}`;
  const [koReadme, enReadme, koNotes, enNotes] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, "README.md"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "README.en.md"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "RELEASE_NOTES.md"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "RELEASE_NOTES.en.md"), "utf8"),
  ]);

  assert.match(koReadme, /\[한국어 릴리즈 노트\]\(RELEASE_NOTES\.md\)/u);
  assert.match(enReadme, /\[English release notes\]\(RELEASE_NOTES\.en\.md\)/u);
  for (const document of [koReadme, enReadme, koNotes, enNotes]) {
    assert.match(document, new RegExp(escapeRegExp(tag), "u"));
    assert.match(document, /HWP_READ_ONLY|읽기 전용|read-only/iu);
    assert.match(document, /HWPX/u);
    assert.match(document, /Windows x64/u);
    assert.match(document, /macOS Apple Silicon/u);
  }
  const koreanFinal = /상태:\s*정식 릴리즈/u.test(koNotes);
  const englishFinal = /Status:\s*final release/iu.test(enNotes);
  const koreanCandidate = /상태:\s*.*후보/u.test(koNotes);
  const englishCandidate = /Status:\s*.*candidate/iu.test(enNotes);
  assert.equal(koreanFinal, englishFinal, "Korean and English notes must agree on final status");
  assert.equal(koreanCandidate, englishCandidate, "Korean and English notes must agree on candidate status");
  assert.equal(koreanFinal || koreanCandidate, true, "release notes must declare final or candidate status");
});

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
    assert.equal(readme.includes(replacement), false);
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

test("the staged runtime documents secure agent-assisted GitHub installation", async () => {
  const metadata = await loadProjectMetadata(REPOSITORY_ROOT);
  const readmes = await Promise.all([
    readFile(join(RUNTIME_ROOT, "README.md"), "utf8"),
    readFile(join(RUNTIME_ROOT, "README.en.md"), "utf8"),
  ]);
  const sections = [
    extractMarkdownSection(readmes[0], "## 에이전트를 통한 GitHub 설치"),
    extractMarkdownSection(readmes[1], "## Agent-assisted installation from GitHub"),
  ];
  for (const section of sections) assertSecureAgentInstallSection(section, metadata);

  const missingMarketplaceIdentity = sections[0].replace("marketplaceName", "marketplace identity");
  assert.throws(
    () => assertSecureAgentInstallSection(missingMarketplaceIdentity, metadata),
    /marketplaceName/u,
  );
});

test("release migration ledger accounts for every pinned legacy invariant", async () => {
  const ledger = JSON.parse(await readFile(MIGRATION_PATH, "utf8")) as MigrationLedger;
  validateMigrationLedger(ledger);

  const duplicate = structuredClone(ledger);
  duplicate.retained![1]!.invariantId = duplicate.retained![0]!.invariantId;
  assert.throws(() => validateMigrationLedger(duplicate), /duplicate invariant ID/iu);

  const missing = structuredClone(ledger);
  delete missing.retained![0]!.invariantId;
  assert.throws(() => validateMigrationLedger(missing), /non-empty invariantId/iu);

  const suiteTests = new Map<string, Set<string>>();
  for (const suite of SPLIT_SUITES) {
    const source = await readFile(join(TEST_ROOT, suite), "utf8");
    suiteTests.set(suite, new Set(
      [...source.matchAll(/^test\("([^"]+)"/gmu)].map((match) => match[1]!),
    ));
  }
  for (const record of ledger.retained!) {
    assert.equal(
      suiteTests.get(record.suite!)?.has(record.publicTestName!),
      true,
      `${record.invariantId} maps to missing test ${record.suite} :: ${record.publicTestName}`,
    );
  }
});

function validateMigrationLedger(ledger: MigrationLedger): void {
  assert.equal(ledger.schemaVersion, 1);
  assert.deepEqual(ledger.source, {
    revision: "b153a5d28cd4888d4e6701e5aad763d248088812",
    path: "plugins/hwp-korean-docs/tests/release-distribution.test.ts",
    gitBlob: "67505285ba62755ecbc36664854860aa9b803206",
    sizeBytes: 53_252,
    sha256: "a8ee2a216f6d292189c6147f7e099a568e7c6966f3c7599cb28de4e3dcd94758",
    testCount: 31,
  });
  assert.equal(Array.isArray(ledger.retained), true);
  assert.equal(Array.isArray(ledger.retired), true);
  assert.equal(ledger.retained!.length, 28);
  assert.equal(ledger.retired!.length, 3);

  const records = [...ledger.retained!, ...ledger.retired!];
  assert.equal(records.length, ledger.source!.testCount);
  const invariantIds = new Set<string>();
  const ordinals = new Set<number>();
  const legacyNames = new Set<string>();
  for (const record of records) {
    assert.equal(
      typeof record.invariantId === "string" && record.invariantId.trim() !== "",
      true,
      "every record requires a non-empty invariantId",
    );
    assert.equal(invariantIds.has(record.invariantId!), false, `duplicate invariant ID: ${record.invariantId}`);
    invariantIds.add(record.invariantId!);
    assert.equal(Number.isInteger(record.legacyOrdinal), true, `${record.invariantId} requires legacyOrdinal`);
    assert.equal(ordinals.has(record.legacyOrdinal!), false, `duplicate legacy ordinal: ${record.legacyOrdinal}`);
    ordinals.add(record.legacyOrdinal!);
    assert.equal(
      typeof record.legacyTestName === "string" && record.legacyTestName.trim() !== "",
      true,
      `${record.invariantId} requires legacyTestName`,
    );
    assert.equal(legacyNames.has(record.legacyTestName!), false, `duplicate legacy test: ${record.legacyTestName}`);
    legacyNames.add(record.legacyTestName!);
  }
  assert.deepEqual([...ordinals].sort((left, right) => left - right), Array.from({ length: 31 }, (_, index) => index + 1));

  const mappedNames = new Set<string>();
  for (const record of ledger.retained!) {
    assert.equal(SPLIT_SUITES.has(record.suite ?? ""), true, `${record.invariantId} has unknown suite`);
    assert.equal(
      typeof record.publicTestName === "string" && record.publicTestName.trim() !== "",
      true,
      `${record.invariantId} requires publicTestName`,
    );
    const mappingKey = `${record.suite}\u0000${record.publicTestName}`;
    assert.equal(mappedNames.has(mappingKey), false, `duplicate public test mapping: ${record.publicTestName}`);
    mappedNames.add(mappingKey);
  }
  for (const record of ledger.retired!) {
    assert.equal(
      typeof record.reason === "string" && record.reason.trim() !== "",
      true,
      `${record.invariantId} requires a retirement reason`,
    );
  }
  for (const ordinal of [17, 18, 25, 26]) {
    const record = ledger.retained!.find((candidate) => candidate.legacyOrdinal === ordinal);
    assert.equal(
      typeof record?.scopeChange === "string" && record.scopeChange.trim() !== "",
      true,
      `legacy invariant ${ordinal} requires an explicit scope change`,
    );
  }
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const normalized = markdown.replace(/\r\n?/gu, "\n");
  const start = normalized.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const end = normalized.indexOf("\n## ", start + heading.length);
  assert.notEqual(end, -1, `section has no closing heading: ${heading}`);
  return normalized.slice(start, end);
}

function assertSecureAgentInstallSection(
  section: string,
  metadata: Awaited<ReturnType<typeof loadProjectMetadata>>,
): void {
  const referencedTags = [...section.matchAll(/--ref\s+(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu)]
    .map((match) => match[1]!);
  assert.equal(referencedTags.length, 1, "the marketplace source must pin exactly one version tag");
  const recommendedTag = referencedTags[0]!;
  const requiredText = [
    "Burntgogi/Gpt_Codex_HWP",
    `--ref ${recommendedTag}`,
    "--json",
    "marketplaceName",
    "pluginId",
    "version",
    "installedPath",
    "GetFullPath",
    "ConvertFrom-Json",
    metadata.marketplaceName,
    `plugins/cache/${metadata.marketplaceName}/${metadata.productId}/<version>`,
    ".codex-plugin/plugin.json",
    "package.json",
    "package-lock.json",
    "dist/mcp.js",
    "npm ci --omit=dev --ignore-scripts",
    "npm audit --omit=dev",
    "64 MiB",
  ];
  for (const text of requiredText) {
    assert.match(section, new RegExp(escapeRegExp(text), "u"), `agent-install section must contain ${text}`);
  }

  assert.equal(section.match(/--json/gu)?.length, 2, "both Codex CLI calls must request JSON");
  assert.match(
    section,
    new RegExp(`marketplaceName.*${escapeRegExp(metadata.marketplaceName)}`, "iu"),
    "marketplaceName must match the expected marketplace",
  );
  assert.match(
    section,
    new RegExp(`pluginId` + "`?" + `(?:가|\\s+equal to)\\s+` + "`" + escapeRegExp(`${metadata.productId}@${metadata.marketplaceName}`) + "`", "iu"),
    "pluginId must equal the fully qualified plugin selector",
  );
  assert.match(section, /version.*비어 있지|non-empty\s+`version`/iu, "version must be non-empty");
  assert.match(section, /절대 경로|absolute path/iu, "installedPath must be absolute");
  assert.match(section, /실제 디렉터리|existing directory/iu, "installedPath must be an existing directory");
  assert.match(
    section,
    new RegExp(
      `경로 끝이.*plugins/${escapeRegExp(`cache/${metadata.marketplaceName}/${metadata.productId}/<version>`)}` +
      `|ends with the exact cache identity.*plugins/${escapeRegExp(`cache/${metadata.marketplaceName}/${metadata.productId}/<version>`)}`,
      "iu",
    ),
    "installedPath must end with the exact cache identity",
  );
  assert.match(
    section,
    /JSON 문자열을 명령으로 평가.*않|Never evaluate a JSON string as a command/iu,
    "JSON must not be evaluated as a command",
  );
  assert.match(
    section,
    /예상 밖의 경로에서 npm을 실행하지|run npm from an unexpected path/iu,
    "npm must not run from an unexpected path",
  );
  assert.match(section, /재시작하거나 새 작업|Restart Codex or open a new task/iu);
  assert.match(section, /정확히 9개|exactly these nine/iu);
  assert.match(
    section,
    /기존에 작동하는 플러그인을 제거하지|do not remove an older working plugin/iu,
    "a working plugin must remain installed on failure",
  );
  assert.match(
    section,
    /토큰.*환경 변수.*사용자 문서 내용.*보고하지|Do not report tokens, environment variables, or user document contents/isu,
    "secret and user-document reporting must be forbidden",
  );
  assert.doesNotMatch(section, /Burntgogi\/Gpt_Codex_HWP\s+--ref\s+main/iu);
  assert.match(
    section,
    new RegExp(`${escapeRegExp(recommendedTag)}.*(?:현재 권장 릴리즈|current recommended release)`, "isu"),
    "the pinned tag must be the current recommended release",
  );
  assert.match(section, /v0\.1\.0.*(?:과거 릴리스|historical releases)/isu);
  assert.match(
    section,
    new RegExp(`(?:새 설치|new installations).*${escapeRegExp(recommendedTag)}.*(?:태그를 사용|pin)`, "isu"),
    "new installations must pin the recommended tag",
  );

  const documentedTools = [...new Set(section.match(/\bhwp_[a-z0-9_]+\b/gu) ?? [])].sort();
  assert.deepEqual(documentedTools, PUBLIC_TOOL_NAMES, "agent-install section must name exactly nine public tools");
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
