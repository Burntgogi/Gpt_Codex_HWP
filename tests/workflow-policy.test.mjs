import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "ci.yml");
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
    assert.match(section, /npm ci --prefix packages\/gpt-codex-hwp(?:\s|$)/u, `${label} fresh source install`);
    assert.match(section, /npm ci --prefix plugins\/gpt-codex-hwp --omit=dev(?:\s|$)/u, `${label} fresh runtime install`);
    assert.match(section, /npm test(?:\s|$)/u, `${label} Node tests`);
    assert.match(section, /npm run test:python(?:\s|$)/u, `${label} Python tests`);
    assert.match(section, /rhwp fixture integrity\|real external HWP/u, `${label} real-HWP gate`);
    assert.match(section, /hwp_generate_hwpx creates a valid, readable document and forced-reflow SVG preview/u, `${label} HWPX gate`);
    assert.match(section, /npm run verify:compact-runtime(?:\s|$)/u, `${label} nine-tool/runtime gate`);
    assert.match(section, /npm run runtime:check(?:\s|$)/u, `${label} runtime projection gate`);
    assert.match(section, /git diff --exit-code -- \./u, `${label} generated-diff gate`);
  }

  assert.doesNotMatch(workflow, /\b(?:cp|copy|Copy-Item|rsync)\b[^\n]*node_modules/iu);
});

test("Dependabot updates both npm locks and pinned GitHub Actions weekly", async () => {
  const dependabot = await readFile(DEPENDABOT_PATH, "utf8");

  assert.match(dependabot, /^version: 2$/mu);
  assert.equal(countMatches(dependabot, /^  - package-ecosystem: "npm"$/gmu), 2);
  assert.equal(countMatches(dependabot, /^  - package-ecosystem: "github-actions"$/gmu), 1);
  for (const directory of ["/", "/packages/gpt-codex-hwp"]) {
    assert.match(dependabot, new RegExp(`^    directory: "${escapeRegex(directory)}"$`, "mu"));
  }
  assert.equal(countMatches(dependabot, /^      interval: "weekly"$/gmu), 3);
  assert.equal(countMatches(dependabot, /^    open-pull-requests-limit: 5$/gmu), 3);
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

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
