import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const POLICY_PATH = join(ROOT, ".github", "repository-policy.json");
const SCRIPT_PATH = join(ROOT, "scripts", "github-repository-policy.mjs");
const REQUIRED_CHECKS = ["Windows x64", "macOS arm64", "Security policy"];
const ACTION_PATTERNS = [
  "actions/attest@a1948c3f048ba23858d222213b7c278aabede763",
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
];
const SENSITIVE_FIELD_ONE = ["to", "ken"].join("");
const SENSITIVE_FIELD_TWO = ["authori", "zation"].join("");
const SENSITIVE_FIELD_THREE = ["github_", "token"].join("");
const SENSITIVE_FIELD_FOUR = ["access_", "token"].join("");
const SENSITIVE_FIELD_FIVE = ["refresh_", "token"].join("");
const SENSITIVE_FIELD_SIX = ["client_", "secret"].join("");
const SENSITIVE_FIELD_SEVEN = ["api_", "key"].join("");
const PROVIDER_CREDENTIAL = ["gh", "p_", "example_", "secret_", "value"].join("");
const BEARER_CREDENTIAL = ["Bearer actual", "-secret"].join("");
const NESTED_CREDENTIAL = ["another", "-secret"].join("");
const TEST_CREDENTIAL = ["test", "-token"].join("");

test("GitHub repository policy declares protected main, immutable tags, and owner-only writes", async () => {
  const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  const rootPackage = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(rootPackage.scripts["github:policy:check"], "node scripts/github-repository-policy.mjs --check");
  assert.equal(rootPackage.scripts["github:policy:plan"], "node scripts/github-repository-policy.mjs --plan");
  assert.equal(rootPackage.scripts["github:policy:apply"], "node scripts/github-repository-policy.mjs --apply");
  assert.equal(policy.schemaVersion, 1);
  assert.deepEqual(policy.repository, { owner: "Burntgogi", name: "Gpt_Codex_HWP", defaultBranch: "main" });
  assert.deepEqual(policy.features, {
    issues: true,
    privateVulnerabilityReporting: true,
    vulnerabilityAlerts: true,
    secretScanning: "enabled",
    secretScanningPushProtection: "enabled",
    automatedDependabotSecurityUpdates: false,
  });
  assert.equal(policy.actions.defaultWorkflowPermissions, "read");
  assert.equal(policy.actions.canApprovePullRequestReviews, false);
  assert.equal(policy.actions.allowedActions, "selected");
  assert.equal(policy.actions.githubOwnedAllowed, true);
  assert.equal(policy.actions.verifiedCreatorAllowed, false);
  assert.equal(policy.actions.requireFullSha, true);
  assert.ok(policy.actions.patternsAllowed.length >= 6);
  for (const pattern of policy.actions.patternsAllowed) {
    assert.match(pattern, /^actions\/[a-z-]+@[0-9a-f]{40}$/u);
  }

  const main = policy.mainProtection;
  assert.equal(main.pullRequestOnly, true);
  assert.equal(main.requiredApprovingReviewCount, 0);
  assert.equal(main.dismissStaleReviews, true);
  assert.equal(main.enforceAdmins, true);
  assert.equal(main.requiredLinearHistory, true);
  assert.equal(main.requiredConversationResolution, true);
  assert.equal(main.allowForcePushes, false);
  assert.equal(main.allowDeletions, false);
  assert.deepEqual(main.requiredStatusChecks, REQUIRED_CHECKS);

  assert.deepEqual(policy.tagRuleset, {
    name: "immutable-version-tags",
    enforcement: "active",
    include: ["refs/tags/v*"],
    blockUpdate: true,
    blockDeletion: true,
    blockNonFastForward: true,
  });
  assert.equal(policy.collaborators.owner, "Burntgogi");
  assert.equal(policy.collaborators.nonOwnerMaximumPermission, "read");
  assert.equal(policy.collaborators.unexpectedWriteIsBlocker, true);
});

test("GitHub repository policy rejects malformed or internally inconsistent policy before any request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-invalid-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  const mutations = [
    (policy) => { policy.repository.name = "../wrong"; },
    (policy) => { policy.features.issues = "true"; },
    (policy) => { policy.actions.requireFullSha = false; },
    (policy) => { policy.mainProtection.requiredStatusChecks = []; },
    (policy) => { policy.tagRuleset.enforcement = "sometimes"; },
    (policy) => { policy.collaborators.owner = "different-owner"; },
  ];
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?invalid=${Date.now()}`
  );
  for (const [index, mutate] of mutations.entries()) {
    const policy = structuredClone(original);
    mutate(policy);
    const path = join(directory, `invalid-${index}.json`);
    await writeFile(path, JSON.stringify(policy), "utf8");
    let requests = 0;
    await assert.rejects(
      runRepositoryPolicy({
        mode: "check",
        policyPath: path,
        [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
        request: async () => { requests += 1; return {}; },
      }),
      { code: "GITHUB_POLICY_INVALID" },
    );
    assert.equal(requests, 0);
  }
});

test("GitHub repository policy tool plans safely, redacts credentials, and constrains apply endpoints", async () => {
  const module = await import(`${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?test=${Date.now()}`);
  assert.equal(typeof module.runRepositoryPolicy, "function");
  assert.equal(typeof module.redactPolicyOutput, "function");
  const redacted = module.redactPolicyOutput({
    [SENSITIVE_FIELD_ONE]: PROVIDER_CREDENTIAL,
    [SENSITIVE_FIELD_TWO]: BEARER_CREDENTIAL,
    nested: {
      [SENSITIVE_FIELD_THREE]: NESTED_CREDENTIAL,
      [SENSITIVE_FIELD_FOUR]: NESTED_CREDENTIAL,
      [SENSITIVE_FIELD_FIVE]: NESTED_CREDENTIAL,
      [SENSITIVE_FIELD_SIX]: NESTED_CREDENTIAL,
      [SENSITIVE_FIELD_SEVEN]: NESTED_CREDENTIAL,
      safe: "value",
      bearerValue: BEARER_CREDENTIAL,
      providerValue: PROVIDER_CREDENTIAL,
    },
  });
  assert.deepEqual(redacted, {
    [SENSITIVE_FIELD_ONE]: "<redacted>",
    [SENSITIVE_FIELD_TWO]: "<redacted>",
    nested: {
      [SENSITIVE_FIELD_THREE]: "<redacted>",
      [SENSITIVE_FIELD_FOUR]: "<redacted>",
      [SENSITIVE_FIELD_FIVE]: "<redacted>",
      [SENSITIVE_FIELD_SIX]: "<redacted>",
      [SENSITIVE_FIELD_SEVEN]: "<redacted>",
      safe: "value",
      bearerValue: "<redacted>",
      providerValue: "<redacted>",
    },
  });

  const source = await readFile(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(source, /\/releases|\/git\/refs|\/collaborators\/[^{'"`]|\/keys|\/hooks|\/secrets|\/contents\//u);
  assert.doesNotMatch(source, /git\s+(?:push|commit|tag)|gh\s+release/iu);

  const requests = [];
  const result = await module.runRepositoryPolicy({
    mode: "plan",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      requests.push(request);
      return compliantResponse(request);
    },
  });
  assert.equal(result.status, "compliant");
  assert.equal(result.mode, "plan");
  assert.equal(requests.every(({ method }) => method === "GET"), true, "--plan must be side-effect free");
  assert.equal(JSON.stringify(result).includes(TEST_CREDENTIAL), false);
});

test("GitHub repository policy treats unexpected write collaborators as a non-removing blocker", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?blocker=${Date.now()}`
  );
  const requests = [];
  const result = await runRepositoryPolicy({
    mode: "apply",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      requests.push(request);
      if (request.path.includes("/collaborators?")) {
        return [{ login: "unexpected", permissions: { push: true, admin: false } }];
      }
      return compliantResponse(request);
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "UNEXPECTED_WRITE_COLLABORATOR");
  assert.doesNotMatch(JSON.stringify(result), /unexpected/u);
  assert.equal(requests.every(({ method }) => method === "GET"), true);
  assert.equal(requests.some(({ path }) => /collaborators\/unexpected/u.test(path)), false);
});

test("GitHub repository policy paginates direct collaborators and blocks a writer after page one", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?pagination=${Date.now()}`
  );
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    login: `reader-${index}`,
    role_name: "read",
    permissions: { push: false, maintain: false, admin: false },
  }));
  const result = await runRepositoryPolicy({
    mode: "check",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      requests.push(request);
      if (request.path.includes("/collaborators?")) {
        return request.path.endsWith("&page=1")
          ? firstPage
          : [{ login: "late-writer", role_name: "write", permissions: { push: true } }];
      }
      return compliantResponse(request);
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "UNEXPECTED_WRITE_COLLABORATOR");
  assert.equal(requests.some(({ path }) => path.endsWith("&page=2")), true);
  assert.doesNotMatch(JSON.stringify(result), /late-writer/u);
});

test("GitHub repository policy fails closed when collaborator pagination never terminates", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?pagination-limit=${Date.now()}`
  );
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    login: `reader-${index}`,
    role_name: "read",
    permissions: { push: false, maintain: false, admin: false },
  }));
  await assert.rejects(
    runRepositoryPolicy({
      mode: "check",
      policyPath: POLICY_PATH,
      [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
      request: async (request) => request.path.includes("/collaborators?")
        ? fullPage
        : compliantResponse(request),
    }),
    { code: "GITHUB_POLICY_RESPONSE_INVALID" },
  );
});

test("GitHub repository policy apply mutates only repository, Actions, main, and declared security features", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?apply=${Date.now()}`
  );
  const requests = [];
  const result = await runRepositoryPolicy({
    mode: "apply",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      requests.push(request);
      if (request.method !== "GET") return {};
      const response = compliantResponse(request);
      if (request.path.endsWith("/actions/permissions/workflow")) {
        return { ...response, default_workflow_permissions: "write" };
      }
      if (request.path.endsWith("/actions/permissions")) return { ...response, allowed_actions: "all" };
      if (request.path.endsWith("/actions/permissions/selected-actions")) {
        return { ...response, github_owned_allowed: false };
      }
      if (request.path.endsWith("/branches/main/protection")) {
        return { ...response, enforce_admins: { enabled: false } };
      }
      if (request.path.endsWith("/private-vulnerability-reporting")) return { enabled: false };
      if (request.path.endsWith("/vulnerability-alerts")) return { enabled: false };
      if (request.path.endsWith("/automated-security-fixes")) return { enabled: true };
      if (/\/repos\/[^/]+\/[^/]+$/u.test(request.path)) {
        return { ...response, has_issues: false };
      }
      return response;
    },
  });
  assert.equal(result.status, "applied");
  const repositoryPatch = requests.find(({ method, path }) => method === "PATCH"
    && /\/repos\/[^/]+\/[^/]+$/u.test(path));
  assert.equal(repositoryPatch.body.default_branch, "main");
  assert.deepEqual(
    requests.filter(({ method }) => method !== "GET").map(({ method, path }) => `${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+/u, "")}`),
    [
      "PATCH ",
      "PUT /actions/permissions",
      "PUT /actions/permissions/workflow",
      "PUT /actions/permissions/selected-actions",
      "PUT /branches/main/protection",
      "PUT /private-vulnerability-reporting",
      "PUT /vulnerability-alerts",
      "DELETE /automated-security-fixes",
    ],
  );
});

test("GitHub repository policy writes distinct redacted evidence for rapid repeated checks", async (t) => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-policy-evidence-"));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?evidence=${Date.now()}`
  );
  const request = async (value) => compliantResponse(value);
  await runRepositoryPolicy({ mode: "check", policyPath: POLICY_PATH, [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL, request, evidenceDirectory });
  await runRepositoryPolicy({ mode: "check", policyPath: POLICY_PATH, [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL, request, evidenceDirectory });
  const evidence = await readdir(evidenceDirectory);
  assert.equal(evidence.length, 2);
  for (const name of evidence) {
    assert.match(name, /^repository-policy-[0-9]{17}-[0-9]+-[0-9]+\.json$/u);
  }
});

test("GitHub repository policy evidence is a strict safe DTO, never a raw API projection", async (t) => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-policy-safe-evidence-"));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?safe-evidence=${Date.now()}`
  );
  const rawLogin = ["private", "-login"].join("");
  const rawEmail = ["person", "@example.invalid"].join("");
  const rawUrl = ["https://api.github.invalid/users/", rawLogin].join("");
  const rawSensitiveValue = ["gh", "p_", "must_not_escape"].join("");
  await runRepositoryPolicy({
    mode: "check",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      const response = compliantResponse(request);
      if (request.path.includes("/collaborators?")) {
        return [{
          login: rawLogin,
          email: rawEmail,
          url: rawUrl,
          [SENSITIVE_FIELD_FOUR]: rawSensitiveValue,
          role_name: "read",
          permissions: { pull: true, push: false, maintain: false, admin: false },
        }];
      }
      return typeof response === "object" && response !== null
        ? { ...response, email: rawEmail, url: rawUrl, [SENSITIVE_FIELD_SIX]: rawSensitiveValue }
        : response;
    },
    evidenceDirectory,
  });
  const [name] = await readdir(evidenceDirectory);
  const saved = JSON.parse(await readFile(join(evidenceDirectory, name), "utf8"));
  const serialized = JSON.stringify(saved);
  assert.deepEqual(Object.keys(saved).sort(), ["actions", "collaborators", "drift", "mainProtection", "repository", "schemaVersion", "security", "tagRuleset"]);
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.collaborators.total, 1);
  assert.equal(saved.collaborators.entries[0].role, "read");
  assert.equal(saved.collaborators.entries[0].canWrite, false);
  assert.match(saved.collaborators.entries[0].identifier, /^sha256:[0-9a-f]{12}$/u);
  for (const forbidden of [rawLogin, rawEmail, rawUrl, rawSensitiveValue, "email", "url", SENSITIVE_FIELD_FOUR, SENSITIVE_FIELD_SIX]) {
    assert.equal(serialized.includes(forbidden), false, `evidence leaked ${forbidden}`);
  }
});

function compliantResponse({ path }) {
  if (path.endsWith("/actions/permissions/workflow")) {
    return { default_workflow_permissions: "read", can_approve_pull_request_reviews: false };
  }
  if (path.endsWith("/actions/permissions")) {
    return { enabled: true, allowed_actions: "selected" };
  }
  if (path.endsWith("/actions/permissions/selected-actions")) {
    return { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ACTION_PATTERNS };
  }
  if (path.endsWith("/branches/main/protection")) {
    return {
      enforce_admins: { enabled: true },
      required_status_checks: { strict: true, contexts: REQUIRED_CHECKS },
      required_pull_request_reviews: { dismiss_stale_reviews: true, required_approving_review_count: 0 },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    };
  }
  if (path.endsWith("/rulesets")) {
    return [{ name: "immutable-version-tags", enforcement: "active", target: "tag", conditions: { ref_name: { include: ["refs/tags/v*"] } }, rules: [{ type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }] }];
  }
  if (path.includes("/collaborators?")) return [];
  if (path.endsWith("/private-vulnerability-reporting")) return { enabled: true };
  if (path.endsWith("/vulnerability-alerts")) return { enabled: true };
  if (path.endsWith("/automated-security-fixes")) return { enabled: false };
  return {
    has_issues: true,
    default_branch: "main",
    security_and_analysis: {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    },
  };
}
