import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "ci.yml");
const DEPENDENCY_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "dependency-audit.yml");
const SECURITY_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "security.yml");
const RELEASE_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "release-verify.yml");
const DEPENDABOT_PATH = join(ROOT, ".github", "dependabot.yml");
const ACTION_PINS = Object.freeze({
  "actions/checkout": "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
  "actions/setup-python": "ece7cb06caefa5fff74198d8649806c4678c61a1",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/attest": "a1948c3f048ba23858d222213b7c278aabede763",
});

test("CI uses safe pull-request triggers and stable platform check names", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");

  assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches: \[main\]$/mu);
  assert.doesNotMatch(workflow, /pull_request_target/u);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.doesNotMatch(workflow, /\bmatrix\s*:/u);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./u);
  assert.doesNotMatch(workflow, /^\s+(?:actions|checks|contents|deployments|discussions|id-token|issues|packages|pages|pull-requests|security-events|statuses):\s*write\s*$/gmu);

  const windows = jobSection(workflow, "windows", "macos");
  const macos = jobSection(workflow, "macos");
  assert.match(windows, /^    name: Windows x64$/mu);
  assert.match(windows, /^    runs-on: windows-2025$/mu);
  assert.match(windows, /^    permissions:\n      contents: read$/mu);
  assert.match(macos, /^    name: macOS arm64$/mu);
  assert.match(macos, /^    runs-on: macos-15$/mu);
  assert.match(macos, /^    permissions:\n      contents: read$/mu);
});

test("CI pins every action to its approved immutable revision", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*\S.*)?$/gmu)];

  assert.ok(uses.length > 0, "workflow must invoke pinned actions");
  for (const [, action, revision] of uses) {
    assert.match(revision, /^[0-9a-f]{40}$/u, `${action} is not pinned to a full commit SHA`);
    assert.equal(revision, ACTION_PINS[action], `${action} uses an unapproved revision`);
  }
  for (const action of ["actions/checkout", "actions/setup-node", "actions/setup-python"]) {
    assert.equal(uses.filter((match) => match[1] === action).length, 2, `${action} must run in both jobs`);
  }
  assert.equal(countMatches(workflow, /^\s+persist-credentials: false$/gmu), 2);
  assert.equal(countMatches(workflow, /^\s+fetch-depth: 0$/gmu), 2);
  assert.equal(countMatches(workflow, /^\s+node-version: "22\.22\.2"$/gmu), 2);
  assert.equal(countMatches(workflow, /^\s+python-version: "3\.12"$/gmu), 2);
  assert.doesNotMatch(workflow, /^\s+cache:/gmu);
});

test("both CI jobs require the exact platform and all document gates", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const jobs = [
    ["Windows x64", jobSection(workflow, "windows", "macos"), "win32", "x64"],
    ["macOS arm64", jobSection(workflow, "macos"), "darwin", "arm64"],
  ];

  for (const [label, section, platform, arch] of jobs) {
    assert.match(section, new RegExp(`process\\.platform[^\\n]+[\"']${platform}[\"']`, "u"), `${label} platform assertion`);
    assert.match(section, new RegExp(`process\\.arch[^\\n]+[\"']${arch}[\"']`, "u"), `${label} architecture assertion`);
    assert.match(section, /^      HWP_REQUIRE_RHWP: "1"$/mu, `${label} must fail when rhwp is unavailable`);
    assert.match(section, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp(?:\s|$)/u, `${label} fresh source install`);
    assert.match(section, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp --omit=dev(?:\s|$)/u, `${label} fresh runtime install`);
    assert.match(section, /npm test(?:\s|$)/u, `${label} Node tests`);
    assert.match(section, /npm run test:python(?:\s|$)/u, `${label} Python tests`);
    assert.match(section, /rhwp fixture integrity\|real external HWP/u, `${label} real-HWP gate`);
    assert.match(section, /hwp_generate_hwpx creates a valid, readable document and forced-reflow SVG preview/u, `${label} HWPX gate`);
    assert.match(section, /npm run verify:compact-runtime(?:\s|$)/u, `${label} nine-tool/runtime gate`);
    assert.match(section, /npm run runtime:check(?:\s|$)/u, `${label} runtime projection gate`);
    assert.match(section, /npm run security:scan-tree(?:\s|$)/u, `${label} public-tree security gate`);
    assert.match(section, /git diff --exit-code -- \./u, `${label} generated-diff gate`);
  }

  assert.doesNotMatch(workflow, /\b(?:cp|copy|Copy-Item|rsync)\b[^\n]*node_modules/iu);
});

test("workflow policy: security is the least-privilege stable Security policy gate", async () => {
  const workflow = await readFile(SECURITY_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches: \[main\]$/mu);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.doesNotMatch(workflow, /pull_request_target|\$\{\{\s*secrets\./u);
  const job = jobSection(workflow, "security");
  assert.match(job, /^    name: Security policy$/mu);
  assert.match(job, /^    permissions:\n      contents: read$/mu);
  assert.match(job, /^\s+fetch-depth: 0$/mu);
  assert.match(job, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp/u);
  assert.match(job, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp --omit=dev/u);
  assert.match(job, /npm run security:scan-tree/u);
  assert.match(job, /npm run security:scan-history/u);
  assert.doesNotMatch(job, /github-repository-policy|GH_TOKEN|github\.token/u,
    "required PR checks cannot depend on repository-admin credentials");
  assert.match(job, /npm audit --omit=dev/u);
  assert.match(job, /npm run runtime:check/u);
  assert.match(job, /npm run verify:release-artifacts/u);
  assert.match(job, /git diff --exit-code -- \./u);
  assertPinnedActions(workflow);
});

test("workflow policy: release verification uploads checksummed candidates and only attestation gets OIDC write", async () => {
  const workflow = await readFile(RELEASE_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.doesNotMatch(workflow, /pull_request_target|\$\{\{\s*secrets\./u);
  assert.doesNotMatch(workflow, /\b(?:git\s+push|gh\s+release|create-release|softprops\/action-gh-release|contents:\s*write)\b/iu);
  const build = jobSection(workflow, "build", "attest");
  const attest = jobSection(workflow, "attest");
  assert.match(build, /^    permissions:\n      contents: read$/mu);
  assert.match(build, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp/u);
  assert.match(build, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp --omit=dev/u);
  assert.match(build, /npm run release:artifacts/u);
  assert.match(build, /npm run verify:release-artifacts/u);
  assert.match(build, /SHA256SUMS/u);
  assert.match(build, /actions\/upload-artifact@/u);
  assert.match(attest, /^    permissions:\n      contents: read$/mu);
  assert.deepEqual(
    [...attest.matchAll(/^      ([a-z-]+): write$/gmu)].map((match) => match[1]),
    ["id-token", "attestations", "artifact-metadata"],
  );
  assert.match(attest, /actions\/download-artifact@/u);
  assert.equal(countMatches(attest, /actions\/attest@/gu), 3);
  assert.match(attest, /gpt-codex-hwp-0\.2\.0\.zip/u);
  assert.match(attest, /gpt-codex-hwp-0\.2\.0\.spdx\.json/u);
  assert.match(attest, /provenance\.json/u);
  assertPinnedActions(workflow);
});

test("dependency automation is immutable, scheduled, and issue-only", async () => {
  await assert.rejects(access(DEPENDABOT_PATH), { code: "ENOENT" });
  const workflow = await readFile(DEPENDENCY_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /^\s*schedule:/mu);
  assert.match(workflow, /^permissions:\n  contents: read\n  issues: write$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:contents|pull-requests|actions|checks|packages):\s*write$/mu);
  assert.doesNotMatch(workflow, /pull_request|auto-merge|automerge|git\s+(?:commit|push|checkout\s+-b)/iu);
  assert.equal(countMatches(workflow, /^\s+persist-credentials: false$/gmu), 1);

  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*\S.*)?$/gmu)];
  assert.deepEqual(uses.map((match) => match[1]), ["actions/checkout", "actions/setup-node"]);
  for (const [, action, revision] of uses) {
    assert.match(revision, /^[0-9a-f]{40}$/u);
    assert.equal(revision, ACTION_PINS[action]);
  }
});

function jobSection(workflow, job, nextJob) {
  const startMarker = `  ${job}:\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${job} job`);
  if (nextJob === undefined) return workflow.slice(start);
  const end = workflow.indexOf(`  ${nextJob}:\n`, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${nextJob} job`);
  return workflow.slice(start, end);
}

function countMatches(input, pattern) {
  return [...input.matchAll(pattern)].length;
}

function assertPinnedActions(workflow) {
  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*\S.*)?$/gmu)];
  assert.ok(uses.length > 0);
  for (const [, action, revision] of uses) {
    assert.match(revision, /^[0-9a-f]{40}$/u, `${action} is not pinned to a full SHA`);
    assert.equal(revision, ACTION_PINS[action], `${action} uses an unapproved revision`);
  }
  assert.equal(countMatches(workflow, /^\s+persist-credentials: false$/gmu), 1);
}
