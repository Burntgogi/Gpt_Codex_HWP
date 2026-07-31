import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "ci.yml");
const COMPATIBILITY_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "compatibility.yml");
const DEPENDENCY_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "dependency-audit.yml");
const SECURITY_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "security.yml");
const RELEASE_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "release-verify.yml");
const NODE_MEMORY_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "node-memory-qualification.yml");
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
  assert.doesNotMatch(workflow, /^(?:defaults:|    defaults:)[^\r\n]*$/gmu);
  assert.match(
    workflow,
    /^concurrency:\r?\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/mu,
  );
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

test("protected check names occur exactly once across pull-request workflows and never in non-PR jobs", async () => {
  const workflowNames = (await readdir(WORKFLOWS_DIR)).filter((name) => /\.ya?ml$/u.test(name));
  const workflows = await Promise.all(workflowNames.map(async (name) => ({
    name,
    text: await readFile(join(WORKFLOWS_DIR, name), "utf8"),
  })));
  const protectedNames = ["Windows x64", "Linux lifecycle", "macOS arm64", "Security policy"];
  const pullRequestWorkflows = workflows.filter(({ text }) => /^  pull_request:/mu.test(text));
  const nonPullRequestWorkflows = workflows.filter(({ text }) => !/^  pull_request:/mu.test(text));
  const jobNames = (records) => records.flatMap(({ text }) => (
    [...text.matchAll(/^    name: (.+)$/gmu)].map((match) => match[1])
  ));
  const pullRequestNames = jobNames(pullRequestWorkflows);
  const nonPullRequestNames = jobNames(nonPullRequestWorkflows);

  for (const name of protectedNames) {
    assert.equal(
      pullRequestNames.filter((candidate) => candidate === name).length,
      1,
      `${name} must identify exactly one required PR job`,
    );
    assert.equal(
      nonPullRequestNames.includes(name),
      false,
      `${name} cannot be reused by compatibility or release jobs`,
    );
  }
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
  assert.equal(countMatches(workflow, /actions\/upload-artifact@/gu), 0);
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
  assert.match(linux, /^    timeout-minutes: 30$/mu);
  assert.match(
    linux,
    /process\.env\.EXPECTED_HEAD_SHA[^\n]+rev-parse[^\n]+HEAD/u,
    "Linux checked-out HEAD assertion",
  );
  assert.match(linux, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp(?:\s|$)/u);
  assert.match(linux, /npm --prefix packages\/gpt-codex-hwp run build(?:\s|$)/u);
  assert.match(
    linux,
    /^      - name: Run bounded lifecycle focused tests\r?\n        timeout-minutes: 20\r?\n        run: npm --prefix packages\/gpt-codex-hwp run test:focused -- tests\/document-process-registration\.test\.ts tests\/document-child-client\.test\.ts tests\/benchmark-policy\.test\.ts$/mu,
    "Linux runs only the bounded registration/document-child/benchmark lifecycle suite",
  );
  assert.doesNotMatch(linux, /actions\/(?:upload|download)-artifact|platform-receipts|release-receipts/iu);
  assert.doesNotMatch(linux, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp|HWP_BENCH_LARGE/iu);
  assert.doesNotMatch(linux, /(?:\bpid\b|local path|artifact)/iu);
});

test("Windows and macOS required jobs implement the bounded PR profile in exact order", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const jobs = [
    ["Windows x64", jobSection(workflow, "windows", "macos"), "win32", "x64", "test:pr"],
    ["macOS arm64", jobSection(workflow, "macos", "linux"), "darwin", "arm64", "test:pr:macos"],
  ];

  for (const [label, section, platform, arch, profile] of jobs) {
    assert.match(section, new RegExp(`process\\.platform[^\\n]+[\"']${platform}[\"']`, "u"), `${label} platform assertion`);
    assert.match(section, new RegExp(`process\\.arch[^\\n]+[\"']${arch}[\"']`, "u"), `${label} architecture assertion`);
    assert.match(section, /^    timeout-minutes: 60$/mu, `${label} bounded job timeout`);
    assertFastDesktopPrJobBoundary(section, {
      profile,
      nodeDiagnosticCommand: profile === "test:pr"
        ? "node scripts/windows-node-tests-diagnostic.mjs --profile=pr"
        : "node scripts/macos-node-tests-diagnostic.mjs --profile=pr-macos",
    });
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
    assert.doesNotMatch(section, /HWP_BENCH_LARGE|HWP_BENCH_REQUIRE_LARGE|HWP_BENCH_LARGE_EVIDENCE/u, `${label} has no large-evidence environment`);
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
    assert.match(section, /npm --prefix packages\/gpt-codex-hwp run build(?:\s|$)/u, `${label} source build`);
    assert.match(section, /npm run runtime:check(?:\s|$)/u, `${label} generated runtime check`);
    assert.match(section, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp --omit=dev(?:\s|$)/u, `${label} fresh runtime install`);
    assert.match(section, /npm run verify:runtime-smoke(?:\s|$)/u, `${label} bounded installed-runtime smoke`);
    assert.match(section, /npm --prefix packages\/gpt-codex-hwp run diagnose:hosted -- --(?:windows-supervisor|mac-worker)(?:\s|$)/u, `${label} hosted platform classifier`);
    assert.match(section, new RegExp(`npm --prefix packages/gpt-codex-hwp run ${escapeRegExp(profile)}(?:\\s|$)`, "u"), `${label} PR Node profile`);
    assert.match(section, /npm run test:python(?:\s|$)/u, `${label} Python suite`);
    assert.match(
      section,
      /benchmark:documents -- --sizes 10 --output \.superpowers\/benchmarks\/pr-10\.json/u,
      `${label} exact 10 MiB smoke`,
    );
    assert.equal(countMatches(section, /benchmark:documents -- --sizes 10(?:\s|$)/gu), 1, `${label} runs one 10 MiB benchmark`);
    assert.doesNotMatch(section, /--sizes[^\r\n]*(?:\b100\b|\b256\b|\b512\b)/u, `${label} excludes compatibility sizes`);
    assert.doesNotMatch(section, /platform-receipts\.mjs create|release:(?:artifacts|verify)|verify:release-artifacts|actions\/attest|id-token:\s*write/iu, `${label} excludes release ownership`);

    const orderedCommands = [
      "npm ci --ignore-scripts --prefix packages/gpt-codex-hwp",
      "npm --prefix packages/gpt-codex-hwp run build",
      "npm run runtime:check",
      "npm ci --ignore-scripts --prefix plugins/gpt-codex-hwp --omit=dev",
      "npm run verify:runtime-smoke",
      "npm --prefix packages/gpt-codex-hwp run diagnose:hosted",
      `npm --prefix packages/gpt-codex-hwp run ${profile}`,
      "npm run test:python",
      "benchmark:documents -- --sizes 10",
    ];
    let previous = -1;
    for (const command of orderedCommands) {
      const current = section.indexOf(command);
      assert.ok(current > previous, `${label} command order drifted at ${command}`);
      previous = current;
    }

    for (const command of [
      `npm --prefix packages/gpt-codex-hwp run ${profile}`,
      "npm run test:python",
      "benchmark:documents -- --sizes 10",
      "diagnose:hosted",
      "npm run verify:runtime-smoke",
    ]) {
      const position = section.indexOf(command);
      assert.ok(position >= 0, `${label} missing timed command ${command}`);
      const stepPrefix = section.slice(Math.max(0, section.lastIndexOf("      - name:", position)), position);
      assert.match(stepPrefix, /timeout-minutes: \d+\s*$/mu, `${label} must time-bound ${command}`);
    }
  }

  assert.doesNotMatch(workflow, /\b(?:cp|copy|Copy-Item|rsync)\b[^\n]*node_modules/iu);
  assert.doesNotMatch(workflow, /platform-receipts\.mjs create|--sizes[^\r\n]*(?:\b100\b|\b256\b|\b512\b)/u);
});

test("fast desktop PR policy rejects terminal-boundary, full-profile, and receipt regressions", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const windows = jobSection(workflow, "windows", "macos");
  const options = {
    profile: "test:pr",
    nodeDiagnosticCommand: "node scripts/windows-node-tests-diagnostic.mjs --profile=pr",
  };
  const cleanStep = "      - name: Reject generated repository changes\n        run: git diff --exit-code -- .\n";
  const benchmarkStep = "      - name: Run 10 MiB document smoke\n";
  const withoutClean = windows.replace(cleanStep, "");
  const reorderedClean = withoutClean.replace(benchmarkStep, `${cleanStep}${benchmarkStep}`);

  const mutations = [
    ["clean-tree removal", withoutClean, /exactly one terminal clean-tree check/u],
    ["clean-tree reordering", reorderedClean, /clean-tree check must follow the 10 MiB benchmark/u],
    ["default full Node run", appendRunStep(windows, "npm --prefix packages/gpt-codex-hwp run test"), /full Node profile is forbidden/u],
    ["explicit full profile", appendRunStep(windows, "node scripts/source-node-tests-isolated.mjs --profile=full"), /full Node profile is forbidden/u],
    ["duplicate PR profile", appendRunStep(windows, "npm --prefix packages/gpt-codex-hwp run test:pr"), /exactly one platform PR profile/u],
    ["wrong diagnostic profile", windows.replace(options.nodeDiagnosticCommand, "node scripts/windows-node-tests-diagnostic.mjs --profile=pr-macos"), /exactly one matching Node diagnostic/u],
    ["direct source diagnostic", appendRunStep(windows, "node scripts/source-node-tests-isolated.mjs --profile=pr"), /direct source diagnostic is forbidden/u],
    ["receipt create", appendRunStep(windows, "node scripts/platform-receipts.mjs create"), /platform receipts are forbidden/u],
    ["receipt verify", appendRunStep(windows, "node scripts/platform-receipts.mjs verify"), /platform receipts are forbidden/u],
    ["receipt checksum", appendRunStep(windows, "node scripts/platform-receipts.mjs checksum"), /platform receipts are forbidden/u],
    ["receipt upload path", appendRunStep(windows, "echo release-receipts/platform-receipt.json"), /platform receipts are forbidden/u],
    [
      "hosted classifier failure condition removal",
      windows.replace(
        "        if: ${{ !cancelled() }}\n        timeout-minutes: 10\n        run: npm --prefix packages/gpt-codex-hwp run diagnose:hosted -- --windows-supervisor",
        "        timeout-minutes: 10\n        run: npm --prefix packages/gpt-codex-hwp run diagnose:hosted -- --windows-supervisor",
      ),
      /hosted classifier must run after an earlier failure/u,
    ],
  ];

  for (const [label, mutation, expected] of mutations) {
    assert.throws(
      () => assertFastDesktopPrJobBoundary(mutation, options),
      expected,
      label,
    );
  }
});

test("fast desktop PR policy rejects an extra focused source test entry point", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const windows = jobSection(workflow, "windows", "macos");
  const mutation = appendRunStep(
    windows,
    "npm --prefix packages/gpt-codex-hwp run test:focused -- tests/tools.test.ts",
  );

  assert.throws(
    () => assertFastDesktopPrJobBoundary(mutation, {
      profile: "test:pr",
      nodeDiagnosticCommand: "node scripts/windows-node-tests-diagnostic.mjs --profile=pr",
    }),
    /unapproved source Node test command/u,
  );
});

test("fast desktop PR policy rejects a duplicate PR profile through npm run-script", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const windows = jobSection(workflow, "windows", "macos");
  const mutation = appendRunStep(
    windows,
    "npm --prefix packages/gpt-codex-hwp run-script test:pr",
  );

  assert.throws(
    () => assertFastDesktopPrJobBoundary(mutation, {
      profile: "test:pr",
      nodeDiagnosticCommand: "node scripts/windows-node-tests-diagnostic.mjs --profile=pr",
    }),
    /unapproved source Node test command/u,
  );
});

test("fast desktop PR policy rejects an equals-prefix focused source test entry point", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const windows = jobSection(workflow, "windows", "macos");
  const mutation = appendRunStep(
    windows,
    "npm --prefix=packages/gpt-codex-hwp run test:focused -- tests/tools.test.ts",
  );

  assert.throws(
    () => assertFastDesktopPrJobBoundary(mutation, {
      profile: "test:pr",
      nodeDiagnosticCommand: "node scripts/windows-node-tests-diagnostic.mjs --profile=pr",
    }),
    /unapproved source Node test command/u,
  );
});

test("fast desktop PR policy rejects an equals-prefix duplicate through npm run-script", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const windows = jobSection(workflow, "windows", "macos");
  const mutation = appendRunStep(
    windows,
    "npm --prefix=packages/gpt-codex-hwp run-script test:pr",
  );

  assert.throws(
    () => assertFastDesktopPrJobBoundary(mutation, {
      profile: "test:pr",
      nodeDiagnosticCommand: "node scripts/windows-node-tests-diagnostic.mjs --profile=pr",
    }),
    /unapproved source Node test command/u,
  );
});

test("CI diagnostics are bounded, profile-preserving, and scoped to their failed PR boundary", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const windows = jobSection(workflow, "windows", "macos");
  const macos = jobSection(workflow, "macos", "linux");
  const linux = jobSection(workflow, "linux");

  const contracts = [
    [windows, "windows_node", "windows_python", "node scripts/windows-node-tests-diagnostic.mjs --profile=pr"],
    [macos, "macos_node", "macos_python", "node scripts/macos-node-tests-diagnostic.mjs --profile=pr-macos"],
  ];
  for (const [section, nodeId, pythonId, nodeCommand] of contracts) {
    const steps = workflowStepSections(section);
    const nodeStep = steps.find((step) => step.includes(`id: ${nodeId}`));
    const pythonStep = steps.find((step) => step.includes(`id: ${pythonId}`));
    assert.ok(nodeStep, `missing ${nodeId} required step`);
    assert.ok(pythonStep, `missing ${pythonId} required step`);
    assert.doesNotMatch(nodeStep, /continue-on-error/u);
    assert.doesNotMatch(pythonStep, /continue-on-error/u);

    const nodeDiagnostic = steps.find((step) => step.includes(`run: ${nodeCommand}`));
    const pythonDiagnostic = steps.find((step) => step.includes("run: node scripts/python-tests-diagnostic.mjs"));
    assert.ok(nodeDiagnostic, `missing ${nodeId} diagnostic`);
    assert.ok(pythonDiagnostic, `missing ${pythonId} diagnostic`);
    assert.match(nodeDiagnostic, /^      - name: Diagnose /mu);
    assert.match(nodeDiagnostic, new RegExp(`^        if: \\$\\{\\{ failure\\(\\) && steps\\.${nodeId}\\.outcome == 'failure' \\}\\}$`, "mu"));
    assert.match(nodeDiagnostic, /^        continue-on-error: true$/mu);
    assert.match(nodeDiagnostic, /^        timeout-minutes: \d+$/mu);
    assert.match(pythonDiagnostic, /^      - name: Diagnose /mu);
    assert.match(pythonDiagnostic, new RegExp(`^        if: \\$\\{\\{ failure\\(\\) && steps\\.${pythonId}\\.outcome == 'failure' \\}\\}$`, "mu"));
    assert.match(pythonDiagnostic, /^        continue-on-error: true$/mu);
    assert.match(pythonDiagnostic, /^        timeout-minutes: \d+$/mu);

    const continuedSteps = steps.filter((step) => step.includes("continue-on-error: true"));
    assert.deepEqual(continuedSteps, [nodeDiagnostic, pythonDiagnostic]);
    const hostedClassifier = steps.find((step) => step.includes("run diagnose:hosted"));
    assert.ok(hostedClassifier, "missing hosted classifier");
    const nonCancelledSteps = steps.filter((step) => /if:\s*\$\{\{\s*!cancelled\(\)/u.test(step));
    assert.deepEqual(
      nonCancelledSteps,
      [hostedClassifier],
      "only the hosted classifier may run after an earlier failure",
    );
    assert.doesNotMatch(section, /if:\s*\$\{\{\s*always\(\)/u);
  }
  assert.doesNotMatch(windows, /macos-node-tests-diagnostic/iu);
  assert.doesNotMatch(macos, /windows-node-tests-diagnostic/iu);
  assert.doesNotMatch(linux, /continue-on-error|node-tests-diagnostic|python-tests-diagnostic/iu);
});

test("scheduled and manual compatibility owns the full platform verification boundary", async () => {
  const workflow = await readFile(COMPATIBILITY_WORKFLOW_PATH, "utf8");
  assertCompatibilityWorkflowPolicy(workflow);
});

test("compatibility workflow policy rejects trigger, gate, evidence, and stability regressions", async () => {
  const workflow = await readFile(COMPATIBILITY_WORKFLOW_PATH, "utf8");
  const mutations = [
    [
      "pull-request trigger",
      "  workflow_dispatch:\n",
      "  pull_request:\n  workflow_dispatch:\n",
    ],
    [
      "cross-event concurrency",
      "group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}",
      "group: ${{ github.workflow }}-${{ github.ref }}",
    ],
    [
      "manual cancellation",
      "cancel-in-progress: ${{ github.event_name == 'schedule' }}",
      "cancel-in-progress: true",
    ],
    ["default-enabled stability", "        default: false", "        default: true"],
    [
      "scheduled stability",
      "if: ${{ github.event_name == 'workflow_dispatch' && inputs.run_bp16_stability == true }}",
      "if: ${{ inputs.run_bp16_stability == true }}",
    ],
    [
      "nineteen stability jobs",
      "attempt: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]",
      "attempt: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]",
    ],
    ["fail-fast stability", "      fail-fast: false", "      fail-fast: true"],
    [
      "missing required evidence environment",
      "          HWP_BENCH_REQUIRE_LARGE: \"1\"\n",
      "",
    ],
    [
      "mismatched evidence path",
      "--output .superpowers/benchmarks/compatibility-supported-100.json",
      "--output .superpowers/benchmarks/other-100.json",
    ],
    ["hosted experimental size", "--sizes 100", "--sizes 100,256"],
    [
      "duplicate platform receipt",
      "run: node scripts/platform-receipts.mjs create",
      "run: node scripts/platform-receipts.mjs create && node scripts/platform-receipts.mjs create",
    ],
    [
      "public plugin install",
      "run: npm ci --ignore-scripts --prefix packages/gpt-codex-hwp",
      "run: npm ci --ignore-scripts --prefix packages/gpt-codex-hwp && npm ci --ignore-scripts --prefix plugins/gpt-codex-hwp --omit=dev",
    ],
    [
      "duplicate desktop full Node run",
      "run: node scripts/platform-receipts.mjs create",
      "run: npm test && node scripts/platform-receipts.mjs create",
    ],
    [
      "outcome bypass",
      "steps.large.outcome",
      "steps.large.conclusion",
    ],
    ["long artifact retention", "          retention-days: 3", "          retention-days: 30"],
    ["hidden evidence omission", "          include-hidden-files: true", "          include-hidden-files: false"],
    [
      "mutable upload action",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "actions/upload-artifact@v6",
    ],
  ];
  for (const [label, before, after] of mutations) {
    const mutated = workflow.replace(before, after);
    assert.notEqual(mutated, workflow, `${label} mutation did not match`);
    assert.throws(() => assertCompatibilityWorkflowPolicy(mutated), undefined, label);
  }
});

test("compatibility workflow policy rejects shell suffixes on receipts and final gates", async () => {
  const workflow = await readFile(COMPATIBILITY_WORKFLOW_PATH, "utf8");
  const desktopGate = "node scripts/compatibility-gate.mjs --require large=${{ steps.large.outcome }} --require receipt=${{ steps.receipt.outcome }}";
  const linuxGate = "node scripts/compatibility-gate.mjs --require node=${{ steps.node.outcome }} --require python=${{ steps.python.outcome }} --require large=${{ steps.large.outcome }}";
  const mutations = [
    ["receipt OR bypass", "node scripts/platform-receipts.mjs create", "node scripts/platform-receipts.mjs create || true"],
    ["receipt AND suffix", "node scripts/platform-receipts.mjs create", "node scripts/platform-receipts.mjs create && true"],
    ["receipt semicolon bypass", "node scripts/platform-receipts.mjs create", "node scripts/platform-receipts.mjs create; exit 0"],
    ["receipt extra token", "node scripts/platform-receipts.mjs create", "node scripts/platform-receipts.mjs create extra"],
    ["desktop gate OR bypass", desktopGate, `${desktopGate} || true`],
    ["desktop gate AND suffix", desktopGate, `${desktopGate} && true`],
    ["desktop gate semicolon bypass", desktopGate, `${desktopGate}; exit 0`],
    ["desktop gate extra token", desktopGate, `${desktopGate} extra`],
    ["Linux gate OR bypass", linuxGate, `${linuxGate} || true`],
    ["Linux gate AND suffix", linuxGate, `${linuxGate} && true`],
    ["Linux gate semicolon bypass", linuxGate, `${linuxGate}; exit 0`],
    ["Linux gate extra token", linuxGate, `${linuxGate} extra`],
  ];

  for (const [label, before, after] of mutations) {
    const mutated = workflow.replace(before, after);
    assert.notEqual(mutated, workflow, `${label} mutation did not match`);
    assert.throws(() => assertCompatibilityWorkflowPolicy(mutated), undefined, label);
  }
});

test("desktop compatibility rejects every unapproved full or focused source test entry point", async () => {
  const workflow = await readFile(COMPATIBILITY_WORKFLOW_PATH, "utf8");
  const testName = "benchmark policy bounds synthetic child-tree stress and verifies every identity gone";
  const jobs = [
    {
      label: "Windows",
      marker: "      - name: Enforce Windows compatibility outcomes\n",
      diagnostic: "windows-node-tests-diagnostic.mjs",
      wrongProfile: "pr",
    },
    {
      label: "macOS",
      marker: "      - name: Enforce macOS compatibility outcomes\n",
      diagnostic: "macos-node-tests-diagnostic.mjs",
      wrongProfile: "pr-macos",
    },
  ];
  const commonCommands = [
    "npm run test:source",
    "npm --prefix packages/gpt-codex-hwp run test",
    "npm --prefix packages/gpt-codex-hwp run-script test",
    "npm --prefix=packages/gpt-codex-hwp run test",
    "npm --prefix=packages/gpt-codex-hwp run-script test:focused -- tests/benchmark-policy.test.ts",
    "npm --prefix packages/gpt-codex-hwp run test:focused -- tests/benchmark-policy.test.ts",
    `npm --prefix packages/gpt-codex-hwp run test:focused -- --test-name-pattern='^${testName}$' tests/benchmark-policy.test.ts`,
    "node scripts/source-node-tests-isolated.mjs --profile=full",
    "bash -c 'npm run test:source'",
    "cmd /c \"npm --prefix=packages/gpt-codex-hwp run test\"",
  ];

  for (const job of jobs) {
    for (const command of [
      ...commonCommands,
      `node scripts/${job.diagnostic}`,
      `node scripts/${job.diagnostic} --profile=${job.wrongProfile}`,
    ]) {
      const injected = `      - name: Injected ${job.label} source-test mutation\n        run: ${command}\n${job.marker}`;
      const mutated = workflow.replace(job.marker, injected);
      assert.notEqual(mutated, workflow, `${job.label}: ${command}`);
      assert.throws(
        () => assertCompatibilityWorkflowPolicy(mutated),
        undefined,
        `${job.label}: ${command}`,
      );
    }
  }
});

test("Linux compatibility rejects alternate or duplicate test and 100 MiB entry points", async () => {
  const workflow = await readFile(COMPATIBILITY_WORKFLOW_PATH, "utf8");
  const marker = "      - name: Enforce Linux compatibility outcomes\n";
  const commands = [
    "npm run test:source",
    "npm --prefix packages/gpt-codex-hwp run test",
    "npm --prefix=packages/gpt-codex-hwp run-script test:focused -- tests/benchmark-policy.test.ts",
    "node scripts/source-node-tests-isolated.mjs --profile=full",
    "npm --prefix packages/gpt-codex-hwp test",
    "npm run test:python",
    "python -m unittest scripts.hwpx-safe-edit.test_hwpx_safe_edit",
    "node scripts/macos-node-tests-diagnostic.mjs",
    "node scripts/macos-node-tests-diagnostic.mjs --profile=pr-macos",
    "sh -c 'node scripts/source-node-tests-isolated.mjs --profile=full'",
    "npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 100 --output .superpowers/benchmarks/duplicate-100.json",
  ];
  for (const command of commands) {
    const injected = `      - name: Injected Linux compatibility mutation\n        run: ${command}\n${marker}`;
    const mutated = workflow.replace(marker, injected);
    assert.notEqual(mutated, workflow, command);
    assert.throws(() => assertCompatibilityWorkflowPolicy(mutated), undefined, command);
  }

  for (const [label, before, after] of [
    ["Node shell suffix", "npm --prefix packages/gpt-codex-hwp test", "npm --prefix packages/gpt-codex-hwp test || true"],
    ["Python shell suffix", "npm run test:python", "npm run test:python && true"],
    [
      "100 MiB shell suffix",
      "npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 100 --output .superpowers/benchmarks/compatibility-supported-100.json",
      "npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 100 --output .superpowers/benchmarks/compatibility-supported-100.json || true",
    ],
    [
      "Node diagnostic shell suffix",
      "node scripts/macos-node-tests-diagnostic.mjs --profile=full > \"${{ runner.temp }}/compatibility-diagnostics/node.txt\" 2>&1",
      "node scripts/macos-node-tests-diagnostic.mjs --profile=full > \"${{ runner.temp }}/compatibility-diagnostics/node.txt\" 2>&1 || true",
    ],
  ]) {
    const linuxStart = workflow.indexOf("  linux:\n");
    const macosStart = workflow.indexOf("  macos:\n", linuxStart);
    const linux = workflow.slice(linuxStart, macosStart);
    const mutatedLinux = linux.replace(before, after);
    assert.notEqual(mutatedLinux, linux, `${label} mutation did not match`);
    const mutated = `${workflow.slice(0, linuxStart)}${mutatedLinux}${workflow.slice(macosStart)}`;
    assert.throws(() => assertCompatibilityWorkflowPolicy(mutated), undefined, label);
  }
});

test("compatibility forbids inherited or custom shells outside the two bp16 steps", async () => {
  const workflow = await readFile(COMPATIBILITY_WORKFLOW_PATH, "utf8");
  const customShell = "bash -c \"source {0}; exit 0\"";
  const mutations = [
    [
      "workflow defaults",
      workflow.replace(
        "permissions: {}\n\nconcurrency:",
        `permissions: {}\n\ndefaults:\n  run:\n    shell: ${customShell}\n\nconcurrency:`,
      ),
    ],
    [
      "workflow inline defaults",
      workflow.replace(
        "permissions: {}\n\nconcurrency:",
        `permissions: {}\ndefaults: { run: { shell: ${customShell} } }\n\nconcurrency:`,
      ),
    ],
    ...["windows", "linux", "macos"].map((job) => [
      `${job} job defaults`,
      addCompatibilityJobDefaults(workflow, job, customShell),
    ]),
    [
      "windows inline job defaults",
      workflow.replace(
        "  windows:\n    name: Windows full compatibility",
        `  windows:\n    defaults: { run: { shell: ${customShell} } }\n    name: Windows full compatibility`,
      ),
    ],
    ...[
      "Generate and validate Windows 100 MiB evidence",
      "Create Windows full platform receipt",
      "Enforce Windows compatibility outcomes",
      "Run Linux full Node profile",
      "Run Linux Python tests",
      "Generate and validate Linux 100 MiB evidence",
      "Enforce Linux compatibility outcomes",
      "Generate and validate macOS 100 MiB evidence",
      "Create macOS full platform receipt",
      "Enforce macOS compatibility outcomes",
    ].map((stepName) => [
      `${stepName} custom shell`,
      addCompatibilityStepShell(workflow, stepName, customShell),
    ]),
  ];

  for (const [label, mutated] of mutations) {
    assert.notEqual(mutated, workflow, `${label} mutation did not match`);
    assert.throws(() => assertCompatibilityWorkflowPolicy(mutated), undefined, label);
  }
});

test("compatibility inspects only run commands and rejects alternate test runners", async () => {
  const workflow = await readFile(COMPATIBILITY_WORKFLOW_PATH, "utf8");
  const windowsFinal = "      - name: Enforce Windows compatibility outcomes\n";
  const benign = [
    "      - name: Explain npm run test:source ownership without executing it",
    "        env:",
    "          POLICY_NOTE: \"npx tsx --test is documentation only\"",
    "        # npm exec -- tsx --test is a non-executable policy note",
    "        run: echo compatibility-owner",
    windowsFinal.trimEnd(),
    "",
  ].join("\n");
  const benignMutation = workflow.replace(windowsFinal, benign);
  assert.notEqual(benignMutation, workflow, "benign step-name mutation did not match");
  assert.doesNotThrow(() => assertCompatibilityWorkflowPolicy(benignMutation));

  const commands = [
    "npm --prefix packages/gpt-codex-hwp exec -- tsx --test packages/gpt-codex-hwp/tests/tools.test.ts",
    "npx --yes tsx --test packages/gpt-codex-hwp/tests/tools.test.ts",
    "tsx --test packages/gpt-codex-hwp/tests/tools.test.ts",
    "node --test packages/gpt-codex-hwp/tests/tools.test.ts",
    "python -m unittest scripts.hwpx-safe-edit.test_hwpx_safe_edit",
    "python3 -m unittest scripts.hwpx-safe-edit.test_hwpx_safe_edit",
    "py -m unittest scripts.hwpx-safe-edit.test_hwpx_safe_edit",
    "npm run test:source",
    "npm --prefix=packages/gpt-codex-hwp run-script test:source",
  ];
  for (const [label, marker] of [
    ["Windows", windowsFinal],
    ["Linux", "      - name: Enforce Linux compatibility outcomes\n"],
  ]) {
    for (const command of commands) {
      const injected = `      - name: Injected ${label} alternate-runner mutation\n        run: ${command}\n${marker}`;
      const mutated = workflow.replace(marker, injected);
      assert.notEqual(mutated, workflow, `${label}: ${command}`);
      assert.throws(
        () => assertCompatibilityWorkflowPolicy(mutated),
        undefined,
        `${label}: ${command}`,
      );
    }
  }

  const stabilityMarker = "      - name: Distill bounded bp16 receipt\n";
  const stabilityMutation = workflow.replace(
    stabilityMarker,
    `      - name: Injected stability source-test mutation\n        run: npm run test:source\n${stabilityMarker}`,
  );
  assert.notEqual(stabilityMutation, workflow, "stability mutation did not match");
  assert.throws(() => assertCompatibilityWorkflowPolicy(stabilityMutation));

  const foldedMutation = workflow.replace(
    windowsFinal,
    "      - name: Injected folded alternate-runner mutation\n"
      + "        run: >\n"
      + "          npm --prefix packages/gpt-codex-hwp exec -- tsx --test packages/gpt-codex-hwp/tests/tools.test.ts\n"
      + windowsFinal,
  );
  assert.notEqual(foldedMutation, workflow, "folded mutation did not match");
  assert.throws(() => assertCompatibilityWorkflowPolicy(foldedMutation));

  for (const [label, step] of [
    [
      "spaced run key",
      "      - name: Injected spaced-run mutation\n        run : npm run test:source\n",
    ],
    [
      "flow-style step",
      "      - { name: Injected flow mutation, run: \"npm run test:source\" }\n",
    ],
  ]) {
    const mutated = workflow.replace(windowsFinal, `${step}${windowsFinal}`);
    assert.notEqual(mutated, workflow, `${label} mutation did not match`);
    assert.throws(() => assertCompatibilityWorkflowPolicy(mutated), undefined, label);
  }
});

test("workflow policy: security is the least-privilege stable Security policy gate", async () => {
  const workflow = await readFile(SECURITY_WORKFLOW_PATH, "utf8");
  assertSecurityWorkflowPolicy(workflow);
});

function assertSecurityWorkflowPolicy(workflow) {
  assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches: \[main\]$/mu);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.doesNotMatch(workflow, /^(?:defaults:|    defaults:)[^\r\n]*$/gmu);
  assert.match(
    workflow,
    /^concurrency:\r?\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\r?\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/mu,
  );
  assert.doesNotMatch(workflow, /pull_request_target|\$\{\{\s*secrets\./u);
  const job = jobSection(workflow, "security");
  assert.match(job, /^    name: Security policy$/mu);
  assert.match(job, /^    runs-on: ubuntu-24\.04$/mu);
  assert.match(job, /^    timeout-minutes: 30$/mu);
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
  assert.match(job, /^          persist-credentials: false$/mu);
  assert.match(job, /^\s+fetch-depth: 0$/mu);
  assert.equal(countMatches(job, /^\s+package-manager-cache: false$/gmu), 1,
    "Security must not enable setup-node's implicit npm cache without a root lockfile");
  assert.match(job, /process\.env\.EXPECTED_HEAD_SHA[^\n]+rev-parse[^\n]+HEAD/u);
  assert.match(job, /process\.env\.EXPECTED_SOURCE_REPOSITORY[^\n]+Burntgogi\/Gpt_Codex_HWP/u);
  assert.doesNotMatch(job, /^          repository: .*head\.repo/mu);
  const orderedCommands = [
    "npm run security:scan-tree",
    "npm run security:scan-history",
    "npm ci --ignore-scripts --prefix packages/gpt-codex-hwp",
    "npm run runtime:check",
    "npm audit --omit=dev --prefix packages/gpt-codex-hwp",
    "npm run test:policy",
    "git diff --exit-code -- .",
  ];
  let previous = -1;
  for (const command of orderedCommands) {
    assert.equal(countMatches(job, new RegExp(`^        run: ${escapeRegExp(command)}$`, "gmu")), 1, command);
    const current = job.indexOf(`run: ${command}`);
    assert.ok(current > previous, `${command} must preserve the Security gate order`);
    previous = current;
  }
  assert.doesNotMatch(job, /github-repository-policy|GH_TOKEN|github\.token/u,
    "required PR checks cannot depend on repository-admin credentials");
  assert.doesNotMatch(job, /npm ci[^\r\n]*--prefix plugins\/gpt-codex-hwp|npm audit[^\r\n]*--prefix plugins\/gpt-codex-hwp/u);
  assert.doesNotMatch(job, /release:artifacts|verify:release-artifacts|RELEASE_ARTIFACT_DIR|actions\/(?:upload-artifact|attest)|id-token:\s*write/u);
  assert.doesNotMatch(job, /git config --local|git remote set-url/u);
  assert.doesNotMatch(job, /^        (?:continue-on-error|if|shell):/mu);
  assert.equal(countMatches(job, /npm audit --omit=dev --prefix packages\/gpt-codex-hwp/gu), 1);
  assert.equal(countMatches(job, /npm run test:policy/gu), 1);
  assertPinnedActions(workflow);
}

test("Security policy rejects duplicated audit, release ownership, weaker cancellation, and policy-test drift", async () => {
  const workflow = await readFile(SECURITY_WORKFLOW_PATH, "utf8");
  const mutations = [
    ["push cancellation", workflow.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true")],
    ["policy replacement", workflow.replace("npm run test:policy", "npm test")],
    ["policy duplication", workflow.replace("npm run test:policy", "npm run test:policy && npm run test:policy")],
    ["runtime install", workflow.replace("npm run runtime:check", "npm ci --ignore-scripts --prefix plugins/gpt-codex-hwp --omit=dev\n      - run: npm run runtime:check")],
    ["runtime audit", workflow.replace("npm run runtime:check", "npm run runtime:check\n      - run: npm audit --omit=dev --prefix plugins/gpt-codex-hwp")],
    ["release ownership", workflow.replace("npm run test:policy", "npm run release:artifacts\n      - run: npm run test:policy")],
    ["write permission", workflow.replace("permissions: {}", "permissions:\n  issues: write")],
    ["default shell", workflow.replace("permissions: {}", "permissions: {}\ndefaults: { run: { shell: bash -c \"source {0}; exit 0\" } }")],
    ["continue on error", workflow.replace("        run: npm run runtime:check", "        continue-on-error: true\n        run: npm run runtime:check")],
    ["skipped policy", workflow.replace("        run: npm run test:policy", "        if: false\n        run: npm run test:policy")],
  ];
  for (const [label, mutation] of mutations) {
    assert.notEqual(mutation, workflow, label);
    assert.throws(() => assertSecurityWorkflowPolicy(mutation), undefined, label);
  }
});

test("workflow policy: release verification uploads checksummed candidates and only attestation gets OIDC write", async () => {
  const workflow = await readFile(RELEASE_WORKFLOW_PATH, "utf8");
  assertReleaseWorkflowPolicy(workflow);
});

test("automatic workflows exclude maintainer-only Node RSS qualification", async () => {
  await assert.rejects(access(NODE_MEMORY_WORKFLOW_PATH), { code: "ENOENT" });
  const releaseWorkflow = await readFile(RELEASE_WORKFLOW_PATH, "utf8");
  assert.doesNotMatch(releaseWorkflow, /memory:qualify|node-memory-gate|node-memory-qualification/iu);
});

function assertReleaseWorkflowPolicy(workflow) {
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.match(
    workflow,
    /^concurrency:\r?\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ inputs\.release_ref \}\}-\$\{\{ inputs\.expected_release_sha \}\}\r?\n  cancel-in-progress: false$/mu,
  );
  assert.doesNotMatch(workflow, /^(?:defaults:|    defaults:)[^\r\n]*$/gmu);
  assert.doesNotMatch(workflow, /pull_request_target|\$\{\{\s*secrets\./u);
  assert.doesNotMatch(workflow, /\b(?:git\s+push|gh\s+release|create-release|softprops\/action-gh-release|contents:\s*write)\b/iu);
  assert.doesNotMatch(workflow, /--sizes[^\r\n]*(?:\b256\b|\b512\b)|--validate-large[^\r\n]*(?:\b256\b|\b512\b)/u);
  const build = jobSection(workflow, "build", "attest");
  const attest = jobSection(workflow, "attest");
  assert.match(build, /^    runs-on: windows-2025$/mu,
    "release subjects must be built on the platform that passes the large-document gate");
  assert.match(build, /^    timeout-minutes: 240$/mu);
  assert.match(workflow, /^      release_ref:\n        description: .*\n        required: true\n        type: string$/mu);
  assert.match(workflow, /^      expected_release_sha:\n        description: .*\n        required: true\n        type: string$/mu);
  assert.match(workflow, /^      release_version:\n        description: .*\n        required: true\n        type: string$/mu);
  assert.match(build, /^      EXPECTED_RELEASE_SHA: \$\{\{ inputs\.expected_release_sha \}\}$/mu);
  assert.match(build, /^      RELEASE_VERSION: \$\{\{ inputs\.release_version \}\}$/mu);
  assert.match(build, /^          ref: \$\{\{ inputs\.release_ref \}\}$/mu);
  assert.doesNotMatch(workflow, /df6b20740c39b731f883bee73a75bd547eb1c1cf|v0\.2\.0/u);
  assert.match(build, /name: Assert exact immutable release tag/u);
  assert.match(build, /process\.env\.EXPECTED_RELEASE_SHA/u);
  assert.match(build, /^    permissions:\n      contents: read$/mu);
  assert.equal(countMatches(build, /^\s+package-manager-cache: false$/gmu), 1,
    "release verification must not enable setup-node's implicit npm cache without a root lockfile");
  assert.equal(
    countMatches(build, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp/gu),
    1,
    "release verification installs source dependencies exactly once",
  );
  assert.match(build, /npm ci --ignore-scripts --prefix plugins\/gpt-codex-hwp --omit=dev/u);
  assert.match(build, /npm install --global npm@10\.9\.7 --ignore-scripts\r?\n          if \(\(npm --version\) -ne "10\.9\.7"\) \{ exit 1 \}/u);
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
  const steps = workflowStepSections(build);
  assert.doesNotMatch(build, /memory:qualify|node-memory-gate|node-memory-qualification/iu);
  const large = requiredStep(steps, "id: large");
  assert.match(large, /^        timeout-minutes: 30$/mu);
  assert.match(large, /^          HWP_BENCH_LARGE: "1"$/mu);
  assert.doesNotMatch(large, /continue-on-error|^        if:|^        shell:/mu);
  assert.match(
    large,
    /benchmark:documents -- --sizes 100 --output \.superpowers\/benchmarks\/release-supported-100\.json\r?\n          if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}\r?\n          npm --prefix packages\/gpt-codex-hwp run benchmark:documents -- --validate-large \.superpowers\/benchmarks\/release-supported-100\.json/u,
  );
  const releaseDiagnosticCondition = "if: ${{ !cancelled() && steps.large.outcome == 'failure' }}";
  const probe = requiredStep(steps, "name: Diagnose failed release 10 MiB probe");
  const validator = requiredStep(steps, "name: Diagnose failed release supported evidence");
  const classifier = requiredStep(steps, "name: Classify failed Windows release platform boundary");
  for (const diagnostic of [probe, validator, classifier]) {
    assert.match(diagnostic, new RegExp(`^        ${escapeRegExp(releaseDiagnosticCondition)}$`, "mu"));
    assert.match(diagnostic, /^        continue-on-error: true$/mu);
    assert.doesNotMatch(diagnostic, /^        shell:/mu);
  }
  assert.match(probe, /--sizes 10 --output \.superpowers\/benchmarks\/release-diagnostic-10\.json/u);
  assert.match(validator, /--validate-large \.superpowers\/benchmarks\/release-supported-100\.json/u);
  assert.match(classifier, /diagnose:hosted -- --windows-supervisor/u);
  const diagnosticUpload = requiredStep(steps, "name: release-preflight-diagnostics-${{ inputs.release_version }}-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.match(diagnosticUpload, new RegExp(`^        ${escapeRegExp(releaseDiagnosticCondition)}$`, "mu"));
  assert.match(diagnosticUpload, /^          retention-days: 3$/mu);
  assert.match(diagnosticUpload, /^          include-hidden-files: true$/mu);
  assert.match(diagnosticUpload, /^          if-no-files-found: error$/mu);
  assert.match(diagnosticUpload, /\.superpowers\/benchmarks\/release-supported-100\.json/u);
  assert.match(diagnosticUpload, /\.superpowers\/benchmarks\/release-diagnostic-10\.json/u);
  assert.deepEqual(
    steps.filter((step) => step.includes("continue-on-error: true")),
    [probe, validator, classifier],
  );
  assert.deepEqual(
    steps.filter((step) => /^        if:/mu.test(step)),
    [probe, validator, classifier, diagnosticUpload],
  );
  assert.doesNotMatch(build, /^        shell:/mu);
  assert.match(build, /^          HWP_BENCH_REQUIRE_LARGE: "1"$/mu);
  assert.match(build, /^          HWP_BENCH_LARGE_EVIDENCE: "\.superpowers\/benchmarks\/release-supported-100\.json"$/mu);
  const fullGate = requiredStep(steps, "run: npm run release:verify");
  assert.doesNotMatch(fullGate, /^        (?:continue-on-error|if|shell):/mu);
  assert.match(build, /npm run release:artifacts/u);
  assert.match(build, /npm run verify:release-artifacts/u);
  assert.match(build, /release:artifacts -- --output "\$env:RELEASE_ARTIFACT_DIR"/u);
  assert.match(build, /verify:release-artifacts -- --artifacts "\$env:RELEASE_ARTIFACT_DIR"/u);
  assert.doesNotMatch(build, /--(?:output|artifacts) release-artifacts(?:\s|$)/u);
  assert.match(build, /SHA256SUMS/u);
  assert.match(build, /actions\/upload-artifact@/u);
  assert.match(build, /^          path: \$\{\{ runner\.temp \}\}\/gpt-codex-hwp-release-artifacts\/$/mu);
  const largeEvidence = build.indexOf("benchmark:documents -- --sizes 100 --output .superpowers/benchmarks/release-supported-100.json");
  const exactTag = build.indexOf("name: Assert exact immutable release tag");
  const sourceInstall = build.indexOf("name: Install source dependencies without lifecycle scripts");
  const diagnosticProbe = build.indexOf("benchmark:documents -- --sizes 10 --output .superpowers/benchmarks/release-diagnostic-10.json");
  const releaseGate = build.indexOf("npm run release:verify");
  const artifactBuild = build.indexOf("npm run release:artifacts");
  const artifactUpload = build.indexOf("name: gpt-codex-hwp-v${{ inputs.release_version }}-candidate");
  assert.equal(
    exactTag >= 0 && sourceInstall > exactTag && largeEvidence > sourceInstall
      && diagnosticProbe > largeEvidence && diagnosticProbe < releaseGate
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
  assert.match(attest, /gpt-codex-hwp-\$\{\{ inputs\.release_version \}\}\.zip/u);
  assert.match(attest, /gpt-codex-hwp-\$\{\{ inputs\.release_version \}\}\.spdx\.json/u);
  assert.match(attest, /provenance\.json/u);
  assertPinnedActions(workflow);
}

test("release policy rejects cancelled diagnostics, non-100 evidence, and preflight success bypasses", async () => {
  const workflow = await readFile(RELEASE_WORKFLOW_PATH, "utf8");
  const mutations = [
    ["cancel duplicate", workflow.replace("cancel-in-progress: false", "cancel-in-progress: true")],
    ["large continue", workflow.replace("        id: large", "        id: large\n        continue-on-error: true")],
    ["legacy sizes", workflow.replace("--sizes 100 --output .superpowers/benchmarks/release-supported-100.json", "--sizes 100,256,512 --output .superpowers/benchmarks/release-supported-100.json")],
    ["missing validation", workflow.replace(/^\s+npm --prefix packages\/gpt-codex-hwp run benchmark:documents -- --validate-large \.superpowers\/benchmarks\/release-supported-100\.json\r?$/mu, "")],
    ["wrong diagnostic condition", workflow.replace("!cancelled() && steps.large.outcome == 'failure'", "failure()")],
    ["gate before diagnostics", workflow.replace("      - name: Run the complete fail-closed release gate", "      - name: Run the complete fail-closed release gate\n        if: always()")],
    ["custom shell", workflow.replace("        id: large", "        id: large\n        shell: bash -c \"source {0}; exit 0\"")],
    ["duplicate source install", workflow.replace("      - name: Install runtime dependencies without lifecycle scripts", "      - run: npm ci --ignore-scripts --prefix packages/gpt-codex-hwp\n      - name: Install runtime dependencies without lifecycle scripts")],
  ];
  for (const [label, mutation] of mutations) {
    assert.notEqual(mutation, workflow, label);
    assert.throws(() => assertReleaseWorkflowPolicy(mutation), undefined, label);
  }
});

test("dependency automation is immutable, scheduled, and issue-only", async () => {
  await assert.rejects(access(DEPENDABOT_PATH), { code: "ENOENT" });
  const workflow = await readFile(DEPENDENCY_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /^on:\r?\n  schedule:\r?\n    - cron: "17 3 \* \* 1"\r?\n  workflow_dispatch:$/mu);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.match(
    workflow,
    /^concurrency:\r?\n  group: dependency-advisory-audit\r?\n  cancel-in-progress: false$/mu,
  );
  const job = jobSection(workflow, "audit");
  assert.match(job, /^    timeout-minutes: 10$/mu);
  assert.match(job, /^    permissions:\r?\n      contents: read\r?\n      issues: write$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:contents|pull-requests|actions|checks|packages):\s*write$/mu);
  assert.doesNotMatch(workflow, /pull_request|auto-merge|automerge|git\s+(?:commit|push|checkout\s+-b)/iu);
  assert.equal(countMatches(workflow, /^\s+persist-credentials: false$/gmu), 1);
  assert.equal(countMatches(workflow, /^      issues: write$/gmu), 1);
  const issueTokenName = ["GH", "TOKEN"].join("_");
  assert.equal(
    countMatches(workflow, new RegExp(`^          ${issueTokenName}: \\$\\{\\{github\\.token\\}\\}$`, "gmu")),
    1,
  );

  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*\S.*)?$/gmu)];
  assert.deepEqual(uses.map((match) => match[1]), ["actions/checkout", "actions/setup-node"]);
  for (const [, action, revision] of uses) {
    assert.match(revision, /^[0-9a-f]{40}$/u);
    assert.equal(revision, ACTION_PINS[action]);
  }
});

function assertCompatibilityWorkflowPolicy(workflow) {
  const triggerContract = [
    "name: Compatibility",
    "",
    "on:",
    "  schedule:",
    "    - cron: \"43 3 * * 2\"",
    "  workflow_dispatch:",
    "    inputs:",
    "      run_bp16_stability:",
    "        description: Run only after production process-cleanup semantics change",
    "        required: true",
    "        default: false",
    "        type: boolean",
    "",
    "permissions: {}",
  ].join("\n");
  assert.match(workflow, new RegExp(`^${escapeRegExp(triggerContract)}$`, "mu"));
  assert.doesNotMatch(workflow, /pull_request:|pull_request_target:|^  push:|workflow_call:|repository_dispatch:/mu);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|^\s+(?:actions|checks|contents|deployments|id-token|issues|packages|pull-requests|security-events|statuses):\s*write\s*$/gmu);
  assert.doesNotMatch(workflow, /^(?:defaults:|    defaults:)[^\r\n]*$/gmu,
    "compatibility forbids workflow-level and job-level run defaults");
  assert.match(
    workflow,
    /^concurrency:\r?\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\r?\n  cancel-in-progress: \$\{\{ github\.event_name == 'schedule' \}\}$/mu,
  );
  assert.doesNotMatch(workflow, /--sizes[^\r\n]*(?:\b256\b|\b512\b)|--validate-large[^\r\n]*(?:\b256\b|\b512\b)/u);
  assert.doesNotMatch(workflow, /npm ci[^\r\n]*--prefix plugins\/gpt-codex-hwp/iu);

  const windows = jobSection(workflow, "windows", "linux");
  const linux = jobSection(workflow, "linux", "macos");
  const macos = jobSection(workflow, "macos", "macos_bp16_stability");
  const stability = jobSection(workflow, "macos_bp16_stability");
  assertDesktopCompatibilityJob(windows, {
    label: "Windows full compatibility",
    runner: "windows-2025",
    platform: "win32",
    arch: "x64",
    nodeDiagnostic: "node scripts/windows-node-tests-diagnostic.mjs --profile=full",
    hostedDiagnostic: "npm --prefix packages/gpt-codex-hwp run diagnose:hosted -- --windows-supervisor",
    gate: "node scripts/compatibility-gate.mjs --require large=${{ steps.large.outcome }} --require receipt=${{ steps.receipt.outcome }}",
    artifactName: "compatibility-windows-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  assertLinuxCompatibilityJob(linux);
  assertDesktopCompatibilityJob(macos, {
    label: "macOS full compatibility",
    runner: "macos-15",
    platform: "darwin",
    arch: "arm64",
    nodeDiagnostic: "node scripts/macos-node-tests-diagnostic.mjs --profile=full",
    hostedDiagnostic: "npm --prefix packages/gpt-codex-hwp run diagnose:hosted -- --mac-worker",
    gate: "node scripts/compatibility-gate.mjs --require large=${{ steps.large.outcome }} --require receipt=${{ steps.receipt.outcome }}",
    artifactName: "compatibility-macos-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  assertMacBp16StabilityJob(stability);

  assert.deepEqual(
    normalizedLines(workflow).filter((line) => /^\s*shell:/u.test(line)),
    ["        shell: bash", "        shell: bash"],
    "only the bp16 run and distillation steps may select a shell",
  );

  assertPinnedActions(workflow, 4);
  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*\S.*)?$/gmu)];
  for (const [action, expectedCount] of [
    ["actions/checkout", 4],
    ["actions/setup-node", 4],
    ["actions/setup-python", 3],
    ["actions/upload-artifact", 4],
  ]) {
    assert.equal(uses.filter((match) => match[1] === action).length, expectedCount, `${action} compatibility count`);
  }
  assert.equal(countMatches(workflow, /^\s+fetch-depth: 0$/gmu), 4);
  assert.equal(countMatches(workflow, /^\s+node-version: "22\.22\.2"$/gmu), 4);
  assert.equal(countMatches(workflow, /^\s+package-manager-cache: false$/gmu), 4);
  assert.equal(countMatches(workflow, /^\s+python-version: "3\.12"$/gmu), 3);
  assert.equal(countMatches(workflow, /^\s+retention-days: 3$/gmu), 4);
  assert.equal(countMatches(workflow, /^\s+include-hidden-files: true$/gmu), 3);
}

function assertDesktopCompatibilityJob(section, options) {
  assert.match(section, new RegExp(`^    name: ${escapeRegExp(options.label)}$`, "mu"));
  assert.match(section, new RegExp(`^    runs-on: ${escapeRegExp(options.runner)}$`, "mu"));
  assert.match(section, /^    timeout-minutes: 180$/mu);
  assert.match(section, /^    permissions:\r?\n      contents: read$/mu);
  assertCompatibilityIdentityBoundary(section, options.platform, options.arch);
  assert.equal(countMatches(section, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp(?:\s|$)/gu), 1);
  assert.doesNotMatch(section, /npm (?:--prefix packages\/gpt-codex-hwp )?run build(?:\s|$)/u,
    `${options.label} relies on benchmark prebenchmark build and receipt-owned build`);
  assert.match(section, /git config --local user\.name "Gpt_Codex_HWP contributors"/u);
  assert.match(section, /git config --local user\.email "224273819\+Burntgogi@users\.noreply\.github\.com"/u);
  assert.match(section, /git remote set-url origin "https:\/\/github\.com\/Burntgogi\/Gpt_Codex_HWP\.git"/u);

  const steps = workflowStepSections(section);
  const large = requiredStep(steps, "id: large");
  const receipt = requiredStep(steps, "id: receipt");
  const receiptCommand = "node scripts/platform-receipts.mjs create";
  assertContinuedValidationStep(large);
  assertContinuedValidationStep(receipt);
  assertNoStepShell(large);
  assertNoStepShell(receipt);
  assert.equal(countMatches(large, /^          HWP_BENCH_LARGE: "1"$/gmu), 1);
  assert.doesNotMatch(large, /HWP_BENCH_REQUIRE_LARGE|HWP_BENCH_LARGE_EVIDENCE/u);
  assertExactSupported100Step(large);
  assertOnlySupported100Commands(section);
  assert.equal(countMatches(receipt, /^          HWP_BENCH_LARGE: "1"$/gmu), 1);
  assert.equal(countMatches(receipt, /^          HWP_BENCH_REQUIRE_LARGE: "1"$/gmu), 1);
  assert.equal(countMatches(receipt, /^          HWP_BENCH_LARGE_EVIDENCE: "\.superpowers\/benchmarks\/compatibility-supported-100\.json"$/gmu), 1);
  assertExactInlineRun(receipt, receiptCommand);
  assert.ok(section.indexOf("id: large") < section.indexOf("id: receipt"), `${options.label} evidence precedes receipt`);
  assert.deepEqual(
    workflowRunCommands(section).filter((command) => /platform-receipts\.mjs/u.test(command)),
    [receiptCommand],
    `${options.label} permits only the canonical receipt command`,
  );

  const nodeDiagnosticCommand = `${options.nodeDiagnostic} > "\${{ runner.temp }}/compatibility-diagnostics/node.txt" 2>&1`;
  const pythonDiagnosticCommand = "node scripts/python-tests-diagnostic.mjs > \"${{ runner.temp }}/compatibility-diagnostics/python.txt\" 2>&1";
  const hostedDiagnosticCommand = `${options.hostedDiagnostic} > "\${{ runner.temp }}/compatibility-diagnostics/platform.txt" 2>&1`;
  const nodeDiagnostic = requiredInlineRunStep(steps, nodeDiagnosticCommand);
  const pythonDiagnostic = requiredInlineRunStep(steps, pythonDiagnosticCommand);
  const hostedDiagnostic = requiredInlineRunStep(steps, hostedDiagnosticCommand);
  for (const diagnostic of [nodeDiagnostic, pythonDiagnostic, hostedDiagnostic]) {
    assertReceiptFailureDiagnostic(diagnostic);
    assert.match(diagnostic, /\$\{\{ runner\.temp \}\}\/compatibility-diagnostics\//u);
  }
  assert.deepEqual(
    workflowRunCommands(section).filter(isCompatibilityTestCommand),
    [nodeDiagnosticCommand, pythonDiagnosticCommand],
    `${options.label} permits only receipt-failure test diagnostics outside the receipt`,
  );

  const upload = requiredStep(steps, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.match(upload, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu);
  assert.match(upload, new RegExp(`^          name: ${escapeRegExp(options.artifactName)}$`, "mu"));
  assert.match(upload, /^          path: \|\r?\n            \.superpowers\/benchmarks\/compatibility-supported-100\.json\r?\n            release-receipts\/\r?\n            \$\{\{ runner\.temp \}\}\/compatibility-diagnostics\/$/mu);
  assert.match(upload, /^          if-no-files-found: error$/mu);
  assert.match(upload, /^          retention-days: 3$/mu);
  assert.match(upload, /^          include-hidden-files: true$/mu);
  assert.doesNotMatch(upload, /\*|node_modules|release-artifacts/u);

  const final = requiredInlineRunStep(steps, options.gate);
  assert.equal(steps.at(-1), final, `${options.label} compatibility gate must be final`);
  assertNoStepShell(final);
  assert.match(final, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu);
  assert.doesNotMatch(final, /continue-on-error/u);
  assert.match(final, /^        timeout-minutes: 5$/mu);
  const continued = steps.filter((step) => step.includes("continue-on-error: true"));
  assert.deepEqual(continued, [large, receipt, nodeDiagnostic, pythonDiagnostic, hostedDiagnostic]);
}

function assertLinuxCompatibilityJob(section) {
  assert.match(section, /^    name: Linux full compatibility$/mu);
  assert.match(section, /^    runs-on: ubuntu-24\.04$/mu);
  assert.match(section, /^    timeout-minutes: 180$/mu);
  assert.match(section, /^    permissions:\r?\n      contents: read$/mu);
  assertCompatibilityIdentityBoundary(section, "linux", "x64");
  assert.equal(countMatches(section, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp(?:\s|$)/gu), 1);
  assert.doesNotMatch(section, /npm (?:--prefix packages\/gpt-codex-hwp )?run build(?:\s|$)/u);
  assert.doesNotMatch(section, /platform-receipts|release-receipts|release:verify|release:artifacts|verify:release-artifacts/iu);

  const steps = workflowStepSections(section);
  const node = requiredStep(steps, "id: node");
  const python = requiredStep(steps, "id: python");
  const large = requiredStep(steps, "id: large");
  const nodeCommand = "npm --prefix packages/gpt-codex-hwp test";
  const pythonCommand = "npm run test:python";
  for (const validation of [node, python, large]) assertContinuedValidationStep(validation);
  for (const validation of [node, python, large]) assertNoStepShell(validation);
  assertExactInlineRun(node, nodeCommand);
  assertExactInlineRun(python, pythonCommand);
  assertExactSupported100Step(large);
  assertOnlySupported100Commands(section);
  assert.equal(countMatches(large, /^          HWP_BENCH_LARGE: "1"$/gmu), 1);

  const nodeDiagnosticCommand = "node scripts/macos-node-tests-diagnostic.mjs --profile=full > \"${{ runner.temp }}/compatibility-diagnostics/node.txt\" 2>&1";
  const pythonDiagnosticCommand = "node scripts/python-tests-diagnostic.mjs > \"${{ runner.temp }}/compatibility-diagnostics/python.txt\" 2>&1";
  const nodeDiagnostic = requiredInlineRunStep(steps, nodeDiagnosticCommand);
  const pythonDiagnostic = requiredInlineRunStep(steps, pythonDiagnosticCommand);
  assertIndividualFailureDiagnostic(nodeDiagnostic, "node");
  assertIndividualFailureDiagnostic(pythonDiagnostic, "python");
  assert.deepEqual(
    workflowRunCommands(section).filter(isCompatibilityTestCommand),
    [nodeCommand, pythonCommand, nodeDiagnosticCommand, pythonDiagnosticCommand],
    "Linux permits only its canonical full suites and failure diagnostics",
  );
  const summary = requiredStep(steps, "GITHUB_STEP_SUMMARY");
  assert.match(summary, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu);
  assert.match(summary, /^          NODE_OUTCOME: \$\{\{ steps\.node\.outcome \}\}$/mu);
  assert.match(summary, /^          PYTHON_OUTCOME: \$\{\{ steps\.python\.outcome \}\}$/mu);
  assert.match(summary, /^          LARGE_OUTCOME: \$\{\{ steps\.large\.outcome \}\}$/mu);

  const upload = requiredStep(steps, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.match(upload, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu);
  assert.match(upload, /^          name: compatibility-linux-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/mu);
  assert.match(upload, /^          path: \|\r?\n            \.superpowers\/benchmarks\/compatibility-supported-100\.json\r?\n            \$\{\{ runner\.temp \}\}\/compatibility-diagnostics\/$/mu);
  assert.match(upload, /^          if-no-files-found: error$/mu);
  assert.match(upload, /^          retention-days: 3$/mu);
  assert.match(upload, /^          include-hidden-files: true$/mu);
  assert.doesNotMatch(upload, /\*|node_modules|release-artifacts/u);

  const gate = requiredInlineRunStep(
    steps,
    "node scripts/compatibility-gate.mjs --require node=${{ steps.node.outcome }} --require python=${{ steps.python.outcome }} --require large=${{ steps.large.outcome }}",
  );
  assert.equal(steps.at(-1), gate, "Linux compatibility gate must be final");
  assertNoStepShell(gate);
  assert.match(gate, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu);
  assert.doesNotMatch(gate, /continue-on-error/u);
  const continued = steps.filter((step) => step.includes("continue-on-error: true"));
  assert.deepEqual(continued, [node, python, large, nodeDiagnostic, pythonDiagnostic]);
}

function assertMacBp16StabilityJob(section) {
  const testName = "benchmark policy bounds synthetic child-tree stress and verifies every identity gone";
  assert.match(section, /^    name: macOS bp16 stability \$\{\{ matrix\.attempt \}\} of 20$/mu);
  assert.match(section, /^    if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.run_bp16_stability == true \}\}$/mu);
  assert.match(section, /^    runs-on: macos-15$/mu);
  assert.match(section, /^    timeout-minutes: 25$/mu);
  assert.match(section, /^    permissions:\r?\n      contents: read$/mu);
  assert.match(section, /^      fail-fast: false$/mu);
  assert.match(section, /^        attempt: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20\]$/mu);
  assertCompatibilityIdentityBoundary(section, "darwin", "arm64");
  assert.equal(countMatches(section, /npm ci --ignore-scripts --prefix packages\/gpt-codex-hwp(?:\s|$)/gu), 1);
  assert.doesNotMatch(section, /npm (?:--prefix packages\/gpt-codex-hwp )?run build(?:\s|$)|platform-receipts|--sizes|--profile=full/u);
  assert.equal(countMatches(section, new RegExp(escapeRegExp(testName), "gu")), 1);
  assert.match(section, new RegExp(`--test-name-pattern='\\^${escapeRegExp(testName)}\\$'`, "u"));
  assert.equal(countMatches(section, /tests\/benchmark-policy\.test\.ts/gu), 1);

  const steps = workflowStepSections(section);
  const bp16 = requiredStep(steps, "id: bp16");
  assert.match(bp16, /^        timeout-minutes: 15$/mu);
  assert.match(bp16, /^        shell: bash$/mu);
  assert.match(bp16, /set -o pipefail/u);
  assert.match(bp16, /tee "\$\{\{ runner\.temp \}\}\/bp16-\$\{\{ matrix\.attempt \}\}\.tap"/u);
  assert.doesNotMatch(bp16, /continue-on-error/u);
  const distill = requiredStep(steps, "BP16_OUTCOME: ${{ steps.bp16.outcome }}");
  assert.match(distill, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu);
  assert.match(distill, /^        shell: bash$/mu);
  assert.match(distill, /BENCHMARK_PROCESS_TREE/u);
  assert.match(distill, /rm -f -- "\$raw"/u);
  assert.match(distill, /if \[\[ "\$BP16_OUTCOME" == "success" \]\]; then/u);
  const upload = requiredStep(steps, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.match(upload, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu);
  assert.match(upload, /^          name: compatibility-macos-bp16-\$\{\{ matrix\.attempt \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/mu);
  assert.match(upload, /^          path: \$\{\{ runner\.temp \}\}\/bp16-\$\{\{ matrix\.attempt \}\}\.txt$/mu);
  assert.match(upload, /^          if-no-files-found: error$/mu);
  assert.match(upload, /^          retention-days: 3$/mu);
  assert.doesNotMatch(upload, /\.tap|include-hidden-files|\*/u);
  const bp16Command = `npm --prefix packages/gpt-codex-hwp run test:focused -- --test-reporter=tap --test-name-pattern='^${testName}$' tests/benchmark-policy.test.ts 2>&1 | tee "\${{ runner.temp }}/bp16-\${{ matrix.attempt }}.tap"`;
  assert.deepEqual(
    workflowRunCommands(section).filter(isCompatibilityTestCommand),
    [bp16Command],
    "stability permits only the exact anchored bp16 source test",
  );
}

function assertCompatibilityIdentityBoundary(section, platform, arch) {
  assert.match(section, /^      EXPECTED_HEAD_SHA: \$\{\{ github\.sha \}\}$/mu);
  assert.match(section, /^      EXPECTED_SOURCE_REPOSITORY: \$\{\{ github\.repository \}\}$/mu);
  assert.match(section, /^      HWP_REQUIRE_RHWP: "1"$/mu);
  assert.match(section, /^          ref: \$\{\{ github\.sha \}\}$/mu);
  assert.match(section, /^          persist-credentials: false$/mu);
  assert.match(section, /^          fetch-depth: 0$/mu);
  assert.match(section, new RegExp(`process\\.platform[^\\n]+["']${platform}["']`, "u"));
  assert.match(section, new RegExp(`process\\.arch[^\\n]+["']${arch}["']`, "u"));
  assert.match(section, /process\.env\.EXPECTED_HEAD_SHA[^\n]+rev-parse[^\n]+HEAD/u);
  assert.match(section, /process\.env\.EXPECTED_SOURCE_REPOSITORY[^\n]+Burntgogi\/Gpt_Codex_HWP/u);
}

function assertExactSupported100Step(step) {
  const output = ".superpowers/benchmarks/compatibility-supported-100.json";
  const generate = `npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 100 --output ${output}`;
  const validate = `npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --validate-large ${output}`;
  assertExactBlockRun(step, [generate, validate]);
  assert.deepEqual(
    workflowRunCommands(step).filter(isDocumentBenchmarkCommand),
    [generate, validate],
    "100 MiB generation and validation must be exact and unique",
  );
}

function assertOnlySupported100Commands(section) {
  const output = ".superpowers/benchmarks/compatibility-supported-100.json";
  const generate = `npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 100 --output ${output}`;
  const validate = `npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --validate-large ${output}`;
  assert.deepEqual(
    workflowRunCommands(section).filter(isDocumentBenchmarkCommand),
    [generate, validate],
    "compatibility permits exactly one canonical 100 MiB generation and validation pair",
  );
}

function assertContinuedValidationStep(step) {
  assert.match(step, /^        if: \$\{\{ !cancelled\(\) \}\}$/mu);
  assert.match(step, /^        continue-on-error: true$/mu);
  assert.match(step, /^        timeout-minutes: \d+$/mu);
}

function assertNoStepShell(step) {
  assert.doesNotMatch(step, /^        shell:/mu, "critical compatibility steps cannot override their shell");
}

function assertReceiptFailureDiagnostic(step) {
  assert.match(step, /^        if: \$\{\{ !cancelled\(\) && steps\.receipt\.outcome == 'failure' \}\}$/mu);
  assert.match(step, /^        continue-on-error: true$/mu);
  assert.match(step, /^        timeout-minutes: \d+$/mu);
}

function assertIndividualFailureDiagnostic(step, id) {
  assert.match(step, new RegExp(`^        if: \\$\\{\\{ !cancelled\\(\\) && steps\\.${id}\\.outcome == 'failure' \\}\\}$`, "mu"));
  assert.match(step, /^        continue-on-error: true$/mu);
  assert.match(step, /^        timeout-minutes: \d+$/mu);
  assert.match(step, /\$\{\{ runner\.temp \}\}\/compatibility-diagnostics\//u);
}

function requiredStep(steps, marker) {
  const matches = steps.filter((step) => step.includes(marker));
  assert.equal(matches.length, 1, `expected exactly one workflow step containing ${marker}`);
  return matches[0];
}

function requiredInlineRunStep(steps, command) {
  const expectedLine = `        run: ${command}`;
  const matches = steps.filter((step) => normalizedLines(step).includes(expectedLine));
  assert.equal(matches.length, 1, `expected exactly one workflow step running ${command}`);
  assertExactInlineRun(matches[0], command);
  return matches[0];
}

function assertExactInlineRun(step, command) {
  const lines = normalizedLines(step);
  const runLines = lines.filter((line) => /^        run:/u.test(line));
  assert.deepEqual(runLines, [`        run: ${command}`], `run command must be exact: ${command}`);
  assert.equal(lines.at(-1), `        run: ${command}`, `run command must terminate its step: ${command}`);
}

function assertExactBlockRun(step, commands) {
  const lines = normalizedLines(step);
  const runIndexes = lines
    .map((line, index) => (/^        run:/u.test(line) ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(runIndexes.length, 1, "workflow step must contain exactly one run field");
  assert.deepEqual(
    lines.slice(runIndexes[0]),
    ["        run: |", ...commands.map((command) => `          ${command}`)],
    "run block must contain only the exact approved commands",
  );
}

function normalizedLines(input) {
  return input.replace(/\r\n/gu, "\n").trimEnd().split("\n");
}

function workflowRunCommands(section) {
  const stepHeaders = normalizedLines(section).filter((line) => /^      - /u.test(line));
  for (const header of stepHeaders) {
    assert.match(header, /^      - (?:name:|uses:)/u,
      "compatibility steps must use canonical name/run or uses syntax");
  }
  const steps = workflowStepSections(section);
  assert.equal(steps.length, stepHeaders.length, "every compatibility step must be parsed");
  return steps.flatMap(extractStepRunCommands);
}

function extractStepRunCommands(step) {
  const lines = normalizedLines(step);
  const runIndexes = lines
    .map((line, index) => (/^        run:/u.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (/^      - name:/u.test(lines[0])) {
    assert.equal(runIndexes.length, 1, "named compatibility steps require one canonical run field");
  } else {
    assert.equal(runIndexes.length, 0, "action compatibility steps cannot also define run");
    return [];
  }

  const runIndex = runIndexes[0];
  const runLine = lines[runIndex];
  const block = /^        run: ([|>])([+-])?$/u.exec(runLine);
  if (block === null) {
    assert.doesNotMatch(runLine, /^        run: [|>]/u,
      "run block indicators cannot carry unsupported syntax");
    const match = /^        run: (.+)$/u.exec(runLine);
    assert.notEqual(match, null, "run scalar must be nonempty or use an exact literal block");
    return [match[1]];
  }

  const commands = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (!/^          /u.test(line)) break;
    const command = line.slice(10).trim();
    if (command.length > 0 && !command.startsWith("#")) commands.push(command);
  }
  return block[1] === ">" && commands.length > 0 ? [commands.join(" ")] : commands;
}

function isCompatibilityTestCommand(command) {
  return isSourceNodeTestCommand(command)
    || /scripts\/python-tests-diagnostic\.mjs/u.test(command)
    || /\b(?:python(?:3(?:\.\d+)?)?(?:\.exe)?|py(?:\.exe)?)\b[^\r\n]*\s-m\s+(?:unittest|pytest)\b/u.test(command)
    || /(?:^|[\s"';&|])pytest(?:\.exe)?(?:\s|$)/u.test(command);
}

function isDocumentBenchmarkCommand(command) {
  return /(?:benchmark:documents|document-engine-benchmark\.mjs)/u.test(command);
}

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

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function workflowStepSections(job) {
  return job.split(/(?=^      - (?:name:|uses:))/gmu)
    .filter((section) => /^      - (?:name:|uses:)/u.test(section));
}

function assertFastDesktopPrJobBoundary(section, options) {
  const benchmarkCommand = "npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 10 --output .superpowers/benchmarks/pr-10.json";
  const cleanCommand = "git diff --exit-code -- .";
  assert.equal(
    countMatches(section, new RegExp(`^        run: ${escapeRegExp(benchmarkCommand)}$`, "gmu")),
    1,
    "exactly one 10 MiB benchmark is required",
  );
  assert.equal(
    countMatches(section, new RegExp(`^        run: ${escapeRegExp(cleanCommand)}$`, "gmu")),
    1,
    "exactly one terminal clean-tree check is required",
  );

  const benchmark = section.indexOf(`run: ${benchmarkCommand}`);
  const clean = section.indexOf(`run: ${cleanCommand}`);
  const firstDiagnostic = section.indexOf("      - name: Diagnose ");
  assert.ok(
    benchmark >= 0 && clean > benchmark,
    "clean-tree check must follow the 10 MiB benchmark",
  );
  assert.ok(
    firstDiagnostic >= 0 && clean < firstDiagnostic,
    "clean-tree check must precede diagnostics",
  );
  const steps = workflowStepSections(section);
  const hostedDiagnosticCommand = options.profile === "test:pr"
    ? "npm --prefix packages/gpt-codex-hwp run diagnose:hosted -- --windows-supervisor"
    : "npm --prefix packages/gpt-codex-hwp run diagnose:hosted -- --mac-worker";
  const hostedClassifier = steps.find((step) => step.includes(hostedDiagnosticCommand));
  assert.notEqual(hostedClassifier, undefined, "hosted classifier is required");
  assert.match(
    hostedClassifier,
    /^        if: \$\{\{ !cancelled\(\) \}\}$/mu,
    "hosted classifier must run after an earlier failure unless the job is cancelled",
  );
  assert.doesNotMatch(hostedClassifier, /continue-on-error/u);
  const benchmarkStep = steps.findIndex((step) => step.includes(`run: ${benchmarkCommand}`));
  const cleanStep = steps.findIndex((step) => step.includes(`run: ${cleanCommand}`));
  const diagnosticStep = steps.findIndex((step) => /^      - name: Diagnose /u.test(step));
  assert.equal(cleanStep, benchmarkStep + 1, "clean-tree check must immediately follow the benchmark");
  assert.equal(diagnosticStep, cleanStep + 1, "only diagnostics may follow the clean-tree boundary");
  assert.equal(
    steps.slice(cleanStep + 1).every((step) => /^      - name: Diagnose /u.test(step)),
    true,
    "only diagnostics may follow the clean-tree boundary",
  );

  const coreProfiles = [...section.matchAll(
    /^        run: npm --prefix packages\/gpt-codex-hwp run (test:pr(?::macos)?)$/gmu,
  )].map((match) => match[1]);
  assert.deepEqual(
    coreProfiles,
    [options.profile],
    "exactly one platform PR profile is required",
  );
  assert.doesNotMatch(
    section,
    /--profile=full|^        run: (?:npm test|npm run test(?::source)?|npm --prefix packages\/gpt-codex-hwp (?:test|run test))(?:\s|$)/mu,
    "full Node profile is forbidden in PR CI",
  );
  assert.doesNotMatch(
    section,
    /scripts\/source-node-tests-isolated\.mjs/u,
    "direct source diagnostic is forbidden in PR CI",
  );

  const nodeDiagnostics = section.split(/\r?\n/u)
    .filter((line) => /(?:windows|macos)-node-tests-diagnostic\.mjs/u.test(line))
    .map((line) => line.trim());
  assert.deepEqual(
    nodeDiagnostics,
    [`run: ${options.nodeDiagnosticCommand}`],
    "exactly one matching Node diagnostic with the PR profile is required",
  );

  const approvedSourceNodeTestCommands = new Set([
    `npm --prefix packages/gpt-codex-hwp run ${options.profile}`,
    options.nodeDiagnosticCommand,
    "npm run test:python",
  ]);
  const sourceNodeTestCommands = section.split(/\r?\n/u)
    .map((line) => line.trim().replace(/^run:\s*/u, ""))
    .filter(isSourceNodeTestCommand);
  for (const command of sourceNodeTestCommands) {
    assert.ok(
      approvedSourceNodeTestCommands.has(command),
      "unapproved source Node test command is forbidden in PR CI",
    );
  }
  assert.doesNotMatch(
    section,
    /platform-receipts\.mjs\s+(?:create|verify|checksum)|actions\/upload-artifact@|release-receipts\/|platform-receipt(?:\.|$)/iu,
    "platform receipts are forbidden in PR CI",
  );
}

function isSourceNodeTestCommand(command) {
  return isNpmTestCommand(command)
    || /scripts\/source-node-tests-isolated\.mjs|scripts\/(?:windows|macos)-node-tests-diagnostic\.mjs/u.test(command)
    || /\bnode(?:\.exe)?\b[^\r\n]*\s--test(?:\s|=|$)/u.test(command)
    || /\btsx(?:\.cmd)?\b[^\r\n]*\s--test(?:\s|=|$)/u.test(command)
    || /tests\/benchmark-policy\.test\.ts|benchmark policy bounds synthetic child-tree stress and verifies every identity gone/u.test(command);
}

function isNpmTestCommand(command) {
  const tokenSets = [
    (command.match(/"[^"]*"|'[^']*'|[^\s;&|]+/gu) ?? []).map(unquoteShellToken),
    command.replace(/["']/gu, " ").match(/[^\s;&|]+/gu) ?? [],
  ];
  for (const tokens of tokenSets) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== "npm" && tokens[index] !== "npm.cmd") continue;
      const npmCommand = nextNpmPositional(tokens, index + 1);
      if (npmCommand === undefined) continue;
      if (npmCommand.value === "test") return true;
      if (npmCommand.value !== "run" && npmCommand.value !== "run-script") continue;

      const script = nextNpmPositional(tokens, npmCommand.index + 1);
      if (script !== undefined && /^test(?::|$)/u.test(script.value)) return true;
    }
  }
  return false;
}

function unquoteShellToken(token) {
  const quote = token[0];
  return token.length >= 2 && (quote === "\"" || quote === "'") && token.at(-1) === quote
    ? token.slice(1, -1)
    : token;
}

function nextNpmPositional(tokens, start) {
  const optionsWithValues = new Set([
    "--cache",
    "--loglevel",
    "--otp",
    "--prefix",
    "--registry",
    "--scope",
    "--tag",
    "--userconfig",
    "--workspace",
    "-C",
    "-w",
  ]);
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) return { index, value: token };
    if (!token.includes("=") && optionsWithValues.has(token)) index += 1;
  }
  return undefined;
}

function appendRunStep(section, command) {
  const benchmarkStep = "      - name: Run 10 MiB document smoke\n";
  return section.replace(
    benchmarkStep,
    `      - name: Injected policy mutation\n        run: ${command}\n${benchmarkStep}`,
  );
}

function addCompatibilityJobDefaults(workflow, job, shell) {
  const marker = `  ${job}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${job} job for defaults mutation`);
  return `${workflow.slice(0, start + marker.length)}`
    + `    defaults:\n      run:\n        shell: ${shell}\n`
    + workflow.slice(start + marker.length);
}

function addCompatibilityStepShell(workflow, stepName, shell) {
  const marker = `      - name: ${stepName}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${stepName} step for shell mutation`);
  const next = workflow.indexOf("\n      - ", start + marker.length);
  const end = next === -1 ? workflow.length : next;
  const step = workflow.slice(start, end);
  const mutatedStep = step.replace(
    /^        run:/mu,
    `        shell: ${shell}\n        run:`,
  );
  assert.notEqual(mutatedStep, step, `${stepName} has no run field`);
  return `${workflow.slice(0, start)}${mutatedStep}${workflow.slice(end)}`;
}

function assertPinnedActions(workflow, expectedCheckoutCount = 1) {
  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#\s*\S.*)?$/gmu)];
  assert.ok(uses.length > 0);
  for (const [, action, revision] of uses) {
    assert.match(revision, /^[0-9a-f]{40}$/u, `${action} is not pinned to a full SHA`);
    assert.equal(revision, ACTION_PINS[action], `${action} uses an unapproved revision`);
  }
  assert.equal(
    countMatches(workflow, /^\s+persist-credentials: false$/gmu),
    expectedCheckoutCount,
  );
}
