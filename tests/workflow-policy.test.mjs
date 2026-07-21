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
  const macos = jobSection(workflow, "macos", "linux");
  const linux = jobSection(workflow, "linux");
  assert.match(windows, /^    name: Windows x64$/mu);
  assert.match(windows, /^    runs-on: windows-2025$/mu);
  assert.match(windows, /^    permissions:\n      contents: read$/mu);
  assert.match(macos, /^    name: macOS arm64$/mu);
  assert.match(macos, /^    runs-on: macos-15$/mu);
  assert.match(macos, /^    permissions:\n      contents: read$/mu);
  assert.match(linux, /^    name: Linux lifecycle$/mu);
  assert.match(linux, /^    runs-on: ubuntu-24\.04$/mu);
  assert.match(linux, /^    permissions:\n      contents: read$/mu);
});

test("CI pins every action to its approved immutable revision", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*\S.*)?$/gmu)];

  assert.ok(uses.length > 0, "workflow must invoke pinned actions");
  for (const [, action, revision] of uses) {
    assert.match(revision, /^[0-9a-f]{40}$/u, `${action} is not pinned to a full commit SHA`);
    assert.equal(revision, ACTION_PINS[action], `${action} uses an unapproved revision`);
  }
  for (const [action, expectedCount] of [
    ["actions/checkout", 3],
    ["actions/setup-node", 3],
    ["actions/setup-python", 2],
    ["actions/upload-artifact", 2],
  ]) {
    assert.equal(
      uses.filter((match) => match[1] === action).length,
      expectedCount,
      `${action} job count drifted`,
    );
  }
  assert.equal(countMatches(workflow, /^\s+persist-credentials: false$/gmu), 3);
  assert.equal(countMatches(workflow, /^\s+fetch-depth: 0$/gmu), 3);
  assert.equal(countMatches(workflow, /^\s+node-version: "22\.22\.2"$/gmu), 3);
  assert.equal(countMatches(workflow, /^\s+package-manager-cache: false$/gmu), 3);
  assert.equal(countMatches(workflow, /^\s+python-version: "3\.12"$/gmu), 2);
  assert.doesNotMatch(workflow, /^\s+cache:/gmu);
});

test("Linux lifecycle CI is pinned, exact-head, source-only, and bounded", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const linux = jobSection(workflow, "linux");

  assert.match(linux, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/u);
  assert.match(linux, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u);
  assert.match(
    linux,
    /^      EXPECTED_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/mu,
    "Linux exact feature-head expectation",
  );
  assert.match(
    linux,
    /^          ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/mu,
    "Linux exact checkout ref",
  );
  assert.match(linux, /^          persist-credentials: false$/mu);
  assert.match(linux, /^          fetch-depth: 0$/mu);
  assert.match(linux, /^          node-version: "22\.22\.2"$/mu);
  assert.match(
    linux,
    /process\.env\.EXPECTED_HEAD_SHA[^\n]+rev-parse[^\n]+HEAD/u,
    "Linux checked-out HEAD assertion",
  );
  assert.match(linux, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp(?:\s|$)/u);
  assert.match(linux, /npm --prefix packages\/gpt-codex-hwp run build(?:\s|$)/u);
  assert.match(
    linux,
    /npm --prefix packages\/gpt-codex-hwp run test:focused -- tests\/document-process-registration\.test\.ts tests\/document-child-client\.test\.ts tests\/benchmark-policy\.test\.ts/u,
    "Linux runs only the bounded registration/document-child/benchmark lifecycle suite",
  );
  assert.doesNotMatch(linux, /actions\/(?:upload|download)-artifact|platform-receipts|release-receipts/iu);
  assert.doesNotMatch(linux, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp|HWP_BENCH_LARGE/iu);
  assert.doesNotMatch(linux, /(?:\bpid\b|local path|artifact)/iu);
});

test("both CI jobs bind full release receipts to the exact feature head and upload only receipts", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const jobs = [
    ["Windows x64", jobSection(workflow, "windows", "macos"), "win32", "x64"],
    ["macOS arm64", jobSection(workflow, "macos", "linux"), "darwin", "arm64"],
  ];

  for (const [label, section, platform, arch] of jobs) {
    assert.match(section, new RegExp(`process\\.platform[^\\n]+[\"']${platform}[\"']`, "u"), `${label} platform assertion`);
    assert.match(section, new RegExp(`process\\.arch[^\\n]+[\"']${arch}[\"']`, "u"), `${label} architecture assertion`);
    assert.match(
      section,
      /^      EXPECTED_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/mu,
      `${label} exact feature-head expectation`,
    );
    assert.match(
      section,
      /^      EXPECTED_SOURCE_REPOSITORY: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}$/mu,
      `${label} owner-only source expectation`,
    );
    assert.match(section, /^      HWP_REQUIRE_RHWP: "1"$/mu, `${label} must fail when rhwp is unavailable`);
    assert.match(section, /^      HWP_BENCH_LARGE: "1"$/mu, `${label} large benchmark opt-in`);
    assert.match(section, /^      HWP_BENCH_REQUIRE_LARGE: "1"$/mu, `${label} large evidence required`);
    assert.match(
      section,
      /^      HWP_BENCH_LARGE_EVIDENCE: "\.superpowers\/benchmarks\/release-large\.json"$/mu,
      `${label} fixed large-evidence path`,
    );
    assert.match(
      section,
      /^          ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/mu,
      `${label} exact checkout ref`,
    );
    assert.match(
      section,
      /process\.env\.EXPECTED_HEAD_SHA[^\n]+rev-parse[^\n]+HEAD/u,
      `${label} checked-out HEAD assertion`,
    );
    assert.match(
      section,
      /process\.env\.EXPECTED_SOURCE_REPOSITORY[^\n]+Burntgogi\/Gpt_Codex_HWP/u,
      `${label} rejects fork source provenance`,
    );
    assert.doesNotMatch(section, /^          repository: .*head\.repo/mu, `${label} cannot relabel a fork checkout`);
    assert.match(section, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp(?:\s|$)/u, `${label} fresh source install`);
    assert.match(section, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp --omit=dev(?:\s|$)/u, `${label} fresh runtime install`);
    assert.match(section, /git config --local user\.name "Gpt_Codex_HWP contributors"/u, `${label} neutral Git name`);
    assert.match(section, /git config --local user\.email "224273819\+Burntgogi@users\.noreply\.github\.com"/u, `${label} neutral Git email`);
    assert.match(
      section,
      /git remote set-url origin "https:\/\/github\.com\/Burntgogi\/Gpt_Codex_HWP\.git"/u,
      `${label} canonical release provenance remote`,
    );
    assert.match(
      section,
      /benchmark:documents -- --sizes 100,256,512 --output \.superpowers\/benchmarks\/release-large\.json/u,
      `${label} fresh 100/256/512 MiB evidence`,
    );
    assert.match(section, /platform-receipts\.mjs create(?:\s|$)/u, `${label} receipt creation`);
    assert.match(section, /platform-receipts\.mjs verify(?:\s|$)/u, `${label} independent receipt verification`);
    assert.match(section, /platform-receipts\.mjs checksum(?:\s|$)/u, `${label} receipt checksum`);
    assert.match(section, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u, `${label} pinned upload`);
    assert.match(section, /^          if-no-files-found: error$/mu, `${label} missing receipt fails`);
    assert.match(section, /^          retention-days: 7$/mu, `${label} bounded receipt retention`);
    assert.match(
      section,
      /^          path: \|\r?\n            release-receipts\/platform-receipt\.json\r?\n            release-receipts\/platform-receipt\.sha256$/mu,
      `${label} uploads only the receipt and checksum`,
    );
    assert.match(section, /git diff --exit-code -- \./u, `${label} generated-diff gate`);

    const exactHead = section.indexOf("Assert exact feature head");
    const largeEvidence = section.indexOf("benchmark:documents -- --sizes 100,256,512");
    const canonicalRemote = section.indexOf("git remote set-url origin");
    const create = section.indexOf("platform-receipts.mjs create");
    const verify = section.indexOf("platform-receipts.mjs verify");
    const checksum = section.indexOf("platform-receipts.mjs checksum");
    const upload = section.indexOf("actions/upload-artifact@");
    assert.equal(
      exactHead >= 0 && exactHead < canonicalRemote && canonicalRemote < largeEvidence && largeEvidence < create
        && create < verify && verify < checksum && checksum < upload,
      true,
      `${label} receipt evidence order`,
    );
  }

  assert.doesNotMatch(workflow, /\b(?:cp|copy|Copy-Item|rsync)\b[^\n]*node_modules/iu);
  assert.equal(countMatches(workflow, /platform-receipts\.mjs create/gu), 2);
  assert.equal(countMatches(workflow, /platform-receipts\.mjs verify/gu), 2);
  assert.equal(countMatches(workflow, /platform-receipts\.mjs checksum/gu), 2);
});

test("CI runs bounded platform diagnostics only after the matching release gate fails", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const macosDiagnostic = await readFile(
    join(ROOT, "scripts", "macos-node-tests-diagnostic.mjs"),
    "utf8",
  );
  const windowsDiagnostic = await readFile(
    join(ROOT, "scripts", "windows-node-tests-diagnostic.mjs"),
    "utf8",
  );
  const pythonDiagnostic = await readFile(
    join(ROOT, "scripts", "python-tests-diagnostic.mjs"),
    "utf8",
  );
  const windows = jobSection(workflow, "windows", "macos");
  const macos = jobSection(workflow, "macos", "linux");
  const linux = jobSection(workflow, "linux");
  const macosControlCommand = "node scripts/macos-posix-controls.mjs";
  const windowsDiagnosticCommand = "node scripts/windows-node-tests-diagnostic.mjs";
  const macosDiagnosticCommand = "node scripts/macos-node-tests-diagnostic.mjs";
  const pythonDiagnosticCommand = "node scripts/python-tests-diagnostic.mjs";

  assert.match(
    macosDiagnostic,
    /export async function runMacNodeTestsDiagnostic/u,
  );
  assert.match(
    windowsDiagnostic,
    /export async function runWindowsNodeTestsDiagnostic/u,
  );
  assert.match(
    pythonDiagnostic,
    /export async function runHostedPythonTestsDiagnostic/u,
  );
  assert.match(
    macos,
    /^      - name: Run safe macOS POSIX controls\r?\n        run: node scripts\/macos-posix-controls\.mjs$/mu,
  );
  assert.match(
    windows,
    /^      - name: Run full release gate and create platform receipt\r?\n        id: windows_release_gate\r?\n        run: node scripts\/platform-receipts\.mjs create\r?\n      - name: Diagnose failed Windows Node release gate\r?\n        if: \$\{\{ failure\(\) && steps\.windows_release_gate\.outcome == 'failure' \}\}\r?\n        continue-on-error: true\r?\n        timeout-minutes: 30\r?\n        run: node scripts\/windows-node-tests-diagnostic\.mjs$/mu,
  );
  assert.match(
    macos,
    /^      - name: Run full release gate and create platform receipt\r?\n        id: macos_release_gate\r?\n        run: node scripts\/platform-receipts\.mjs create\r?\n      - name: Diagnose failed macOS Node release gate\r?\n        if: \$\{\{ failure\(\) && steps\.macos_release_gate\.outcome == 'failure' \}\}\r?\n        continue-on-error: true\r?\n        timeout-minutes: 30\r?\n        run: node scripts\/macos-node-tests-diagnostic\.mjs\r?\n      - name: Diagnose failed macOS Python release gate\r?\n        if: \$\{\{ failure\(\) && steps\.macos_release_gate\.outcome == 'failure' \}\}\r?\n        continue-on-error: true\r?\n        timeout-minutes: 15\r?\n        run: node scripts\/python-tests-diagnostic\.mjs$/mu,
  );
  assert.equal(countMatches(workflow, /node scripts\/macos-posix-controls\.mjs/gu), 1);
  assert.equal(countMatches(workflow, /node scripts\/windows-node-tests-diagnostic\.mjs/gu), 1);
  assert.equal(countMatches(workflow, /node scripts\/macos-node-tests-diagnostic\.mjs/gu), 1);
  assert.equal(countMatches(workflow, /node scripts\/python-tests-diagnostic\.mjs/gu), 1);
  assert.doesNotMatch(windows, /macos-posix-controls/iu);
  assert.doesNotMatch(linux, /macos-posix-controls/iu);
  assert.doesNotMatch(windows, /macos-node-tests-diagnostic/iu);
  assert.doesNotMatch(windows, /python-tests-diagnostic/iu);
  assert.doesNotMatch(macos, /windows-node-tests-diagnostic/iu);
  assert.doesNotMatch(`${windows}\n${macos}`, /if:\s*\$\{\{\s*always\(\)/u);

  const largeEvidence = macos.indexOf("benchmark:documents -- --sizes 100,256,512");
  const macosControl = macos.indexOf(macosControlCommand);
  const macosReleaseGate = macos.indexOf("node scripts/platform-receipts.mjs create");
  const macosForensicDiagnostic = macos.indexOf(macosDiagnosticCommand);
  const pythonForensicDiagnostic = macos.indexOf(pythonDiagnosticCommand);
  const macosReceiptVerification = macos.indexOf("node scripts/platform-receipts.mjs verify");
  assert.equal(
    largeEvidence >= 0 && largeEvidence < macosControl && macosControl < macosReleaseGate
      && macosReleaseGate < macosForensicDiagnostic
      && macosForensicDiagnostic < pythonForensicDiagnostic
      && pythonForensicDiagnostic < macosReceiptVerification,
    true,
    "macOS controls precede the release gate and forensic diagnostics follow its failure boundary",
  );

  const windowsReleaseGate = windows.indexOf("node scripts/platform-receipts.mjs create");
  const windowsForensicDiagnostic = windows.indexOf(windowsDiagnosticCommand);
  const windowsReceiptVerification = windows.indexOf("node scripts/platform-receipts.mjs verify");
  assert.equal(
    windowsReleaseGate >= 0 && windowsReleaseGate < windowsForensicDiagnostic
      && windowsForensicDiagnostic < windowsReceiptVerification,
    true,
    "Windows forensic diagnostics follow the release-gate failure boundary",
  );
});

test("workflow policy: security is the least-privilege stable Security policy gate", async () => {
  const workflow = await readFile(SECURITY_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches: \[main\]$/mu);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.doesNotMatch(workflow, /pull_request_target|\$\{\{\s*secrets\./u);
  const job = jobSection(workflow, "security");
  assert.match(job, /^    name: Security policy$/mu);
  assert.match(job, /^    permissions:\n      contents: read$/mu);
  assert.match(
    job,
    /^      EXPECTED_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/mu,
  );
  assert.match(
    job,
    /^      EXPECTED_SOURCE_REPOSITORY: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}$/mu,
  );
  assert.match(
    job,
    /^          ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/mu,
  );
  assert.match(job, /^\s+fetch-depth: 0$/mu);
  assert.equal(countMatches(job, /^\s+package-manager-cache: false$/gmu), 1,
    "Security must not enable setup-node's implicit npm cache without a root lockfile");
  assert.match(job, /process\.env\.EXPECTED_HEAD_SHA[^\n]+rev-parse[^\n]+HEAD/u);
  assert.match(job, /process\.env\.EXPECTED_SOURCE_REPOSITORY[^\n]+Burntgogi\/Gpt_Codex_HWP/u);
  assert.doesNotMatch(job, /^          repository: .*head\.repo/mu);
  assert.match(job, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp/u);
  assert.match(job, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp --omit=dev/u);
  assert.match(job, /npm run security:scan-tree/u);
  assert.match(job, /npm run security:scan-history/u);
  assert.doesNotMatch(job, /github-repository-policy|GH_TOKEN|github\.token/u,
    "required PR checks cannot depend on repository-admin credentials");
  assert.match(job, /npm audit --omit=dev/u);
  assert.match(job, /npm run runtime:check/u);
  assert.match(job, /npm run verify:release-artifacts/u);
  assert.match(job, /git config --local user\.name "Gpt_Codex_HWP contributors"/u);
  assert.match(job, /git config --local user\.email "224273819\+Burntgogi@users\.noreply\.github\.com"/u);
  assert.match(job, /git remote set-url origin "https:\/\/github\.com\/Burntgogi\/Gpt_Codex_HWP\.git"/u);
  assert.doesNotMatch(job, /^      RELEASE_ARTIFACT_DIR:/mu,
    "runner context is unavailable in job-level env");
  assert.equal(
    countMatches(job, /^        env:\r?\n          RELEASE_ARTIFACT_DIR: \$\{\{ runner\.temp \}\}\/gpt-codex-hwp-release-artifacts$/gmu),
    2,
    "each security artifact step scopes runner.temp at step level",
  );
  assert.match(job, /release:artifacts -- --output "\$RELEASE_ARTIFACT_DIR"/u);
  assert.match(job, /verify:release-artifacts -- --artifacts "\$RELEASE_ARTIFACT_DIR"/u);
  assert.doesNotMatch(job, /--(?:output|artifacts) release-artifacts(?:\s|$)/u);
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
  assert.equal(countMatches(build, /^\s+package-manager-cache: false$/gmu), 1,
    "release verification must not enable setup-node's implicit npm cache without a root lockfile");
  assert.match(build, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp/u);
  assert.match(build, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp --omit=dev/u);
  assert.match(build, /git config --local user\.name "Gpt_Codex_HWP contributors"/u);
  assert.match(build, /git config --local user\.email "224273819\+Burntgogi@users\.noreply\.github\.com"/u);
  assert.match(build, /git remote set-url origin "https:\/\/github\.com\/Burntgogi\/Gpt_Codex_HWP\.git"/u);
  assert.doesNotMatch(build, /^      RELEASE_ARTIFACT_DIR:/mu,
    "runner context is unavailable in job-level env");
  assert.equal(
    countMatches(build, /^        env:\r?\n          RELEASE_ARTIFACT_DIR: \$\{\{ runner\.temp \}\}\/gpt-codex-hwp-release-artifacts$/gmu),
    3,
    "each release artifact command scopes runner.temp at step level",
  );
  assert.match(build, /^          HWP_BENCH_LARGE: "1"$/mu);
  assert.match(build, /benchmark:documents -- --sizes 100,256,512 --output \.superpowers\/benchmarks\/release-large\.json/u);
  assert.match(build, /^          HWP_BENCH_REQUIRE_LARGE: "1"$/mu);
  assert.match(build, /^          HWP_BENCH_LARGE_EVIDENCE: "\.superpowers\/benchmarks\/release-large\.json"$/mu);
  assert.match(build, /npm run release:verify/u);
  assert.match(build, /npm run release:artifacts/u);
  assert.match(build, /npm run verify:release-artifacts/u);
  assert.match(build, /release:artifacts -- --output "\$RELEASE_ARTIFACT_DIR"/u);
  assert.match(build, /verify:release-artifacts -- --artifacts "\$RELEASE_ARTIFACT_DIR"/u);
  assert.doesNotMatch(build, /--(?:output|artifacts) release-artifacts(?:\s|$)/u);
  assert.match(build, /SHA256SUMS/u);
  assert.match(build, /actions\/upload-artifact@/u);
  assert.match(build, /^          path: \$\{\{ runner\.temp \}\}\/gpt-codex-hwp-release-artifacts\/$/mu);
  const largeEvidence = build.indexOf("benchmark:documents -- --sizes 100,256,512");
  const releaseGate = build.indexOf("npm run release:verify");
  const artifactBuild = build.indexOf("npm run release:artifacts");
  const artifactUpload = build.indexOf("actions/upload-artifact@");
  assert.equal(
    largeEvidence >= 0 && largeEvidence < releaseGate
      && releaseGate < artifactBuild && artifactBuild < artifactUpload,
    true,
    "large evidence and the full release gate must pass before building or uploading attested subjects",
  );
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
