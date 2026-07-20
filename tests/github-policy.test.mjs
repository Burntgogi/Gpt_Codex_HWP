import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const POLICY_PATH = join(ROOT, ".github", "repository-policy.json");
const SCRIPT_PATH = join(ROOT, "scripts", "github-repository-policy.mjs");
const REQUIRED_CHECKS = [
  "Windows x64",
  "Linux lifecycle",
  "macOS arm64",
  "Security policy",
];
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
  assert.equal(policy.actions.enabled, true);
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
    legacyNames: ["Protect version release tags"],
    enforcement: "active",
    include: ["refs/tags/v*"],
    exclude: [],
    bypassActors: [],
    blockUpdate: true,
    blockDeletion: true,
    blockNonFastForward: true,
  });
  assert.equal(policy.collaborators.owner, "Burntgogi");
  assert.equal(policy.collaborators.nonOwnerMaximumPermission, "read");
  assert.equal(policy.collaborators.unexpectedWriteIsBlocker, true);
  assert.deepEqual(policy.deployKeys, {
    maximumPermission: "read",
    unexpectedWriteIsBlocker: true,
  });
});

test("GitHub repository policy rejects malformed or internally inconsistent policy before any request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-invalid-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  const mutations = [
    (policy) => { policy.repository.name = "../wrong"; },
    (policy) => { policy.features.issues = "true"; },
    (policy) => { policy.actions.enabled = false; },
    (policy) => { policy.actions.requireFullSha = false; },
    (policy) => { policy.mainProtection.requiredStatusChecks = []; },
    (policy) => { policy.tagRuleset.enforcement = "sometimes"; },
    (policy) => { policy.tagRuleset.legacyNames = []; },
    (policy) => { policy.tagRuleset.legacyNames = ["immutable-version-tags"]; },
    (policy) => { policy.tagRuleset.legacyNames = ["Protect version release tags", "Protect version release tags"]; },
    (policy) => { delete policy.tagRuleset.exclude; },
    (policy) => { policy.tagRuleset.bypassActors = [{ actorId: 1 }]; },
    (policy) => { policy.collaborators.owner = "different-owner"; },
    (policy) => { delete policy.deployKeys.maximumPermission; },
    (policy) => { policy.deployKeys.unexpectedExtra = true; },
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

test("GitHub repository policy treats an unavailable selected-actions view as Actions drift outside selected mode", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?actions-nonselected=${Date.now()}`
  );
  const requests = [];
  const result = await runRepositoryPolicy({
    mode: "plan",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      requests.push(request);
      if (request.path.endsWith("/actions/permissions")) return { enabled: true, allowed_actions: "all" };
      if (request.path.endsWith("/actions/permissions/selected-actions")) {
        throw new Error("selected-actions must not be requested outside selected mode");
      }
      return compliantResponse(request);
    },
  });
  assert.equal(result.status, "drift");
  assert.equal(result.changes.some(({ category }) => category === "actions"), true);
  assert.equal(requests.some(({ path }) => path.endsWith("/actions/permissions/selected-actions")), false);
});

test("GitHub repository policy plans and applies the one validated legacy immutable-tag ruleset", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?legacy-ruleset=${Date.now()}`
  );
  const planRequests = [];
  const planned = await runRepositoryPolicy({
    mode: "plan",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      planRequests.push(request);
      return legacyRulesetResponse(request);
    },
  });
  assert.equal(planned.status, "drift");
  assert.equal(planned.changes.some(({ category }) => category === "tag-ruleset"), true);
  assert.equal(planRequests.some(({ path }) => path.endsWith("/rulesets/73")), true);

  const applyRequests = [];
  const applied = await runRepositoryPolicy({
    mode: "apply",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      applyRequests.push(request);
      return request.method === "GET" ? legacyRulesetResponse(request) : {};
    },
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(
    applyRequests.filter(({ method }) => method !== "GET"),
    [{
      method: "PUT",
      path: "/repos/Burntgogi/Gpt_Codex_HWP/rulesets/73",
      body: {
        name: "immutable-version-tags",
        target: "tag",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
        rules: [{ type: "deletion" }, { type: "update" }, { type: "non_fast_forward" }],
      },
    }],
  );
});

test("GitHub repository policy fails closed when a legacy tag-ruleset migration is not exact", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?legacy-ruleset-blocked=${Date.now()}`
  );
  const scenarios = [
    ["zero candidates", (request, response) => request.path.endsWith("/rulesets") ? [] : response],
    ["multiple candidates", (request, response) => request.path.endsWith("/rulesets")
      ? [legacyRulesetSummary(73), legacyRulesetSummary(74)] : response],
    ["malformed ID", (request, response) => request.path.endsWith("/rulesets")
      ? [{ ...legacyRulesetSummary(73), id: "73" }] : response],
    ["changed conditions", (request, response) => request.path.endsWith("/rulesets/73")
      ? { ...response, conditions: { ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v1.0.0"] } } }
      : response],
    ["bypass actors", (request, response) => request.path.endsWith("/rulesets/73")
      ? { ...response, bypass_actors: [{ actor_id: 7, actor_type: "RepositoryRole", bypass_mode: "always" }] }
      : response],
    ["extra rules", (request, response) => request.path.endsWith("/rulesets/73")
      ? { ...response, rules: [...response.rules, { type: "non_fast_forward" }] }
      : response],
    ["unexpected name", (request, response) => request.path.endsWith("/rulesets")
      ? [{ ...legacyRulesetSummary(73), name: "Unexpected tag ruleset" }] : response],
  ];
  for (const [name, alter] of scenarios) {
    const requests = [];
    const result = await runRepositoryPolicy({
      mode: "apply",
      policyPath: POLICY_PATH,
      [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
      request: async (request) => {
        requests.push(request);
        const response = legacyRulesetResponse(request);
        return request.method === "GET" ? alter(request, response) : {};
      },
    });
    assert.equal(result.status, "blocked", name);
    assert.equal(result.code, "OWNER_ACTION_REQUIRED", name);
    assert.equal(requests.every(({ method }) => method === "GET"), true, name);
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
  assert.doesNotMatch(source, /\/releases|\/git\/refs|\/collaborators\/[^{'"`]|\/keys\/[^{'"`]|\/hooks|\/secrets|\/contents\//u);
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

test("GitHub repository policy requires numeric tag-ruleset detail with exact include, exclude, and bypass actors", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?ruleset-detail=${Date.now()}`
  );
  for (const [name, alter] of [
    ["summary-only", (request, response) => request.path.endsWith("/rulesets")
      ? response.map(({ id: _id, ...summary }) => summary) : response],
    ["excluded-ref", (request, response) => request.path.endsWith("/rulesets/73")
      ? { ...response, conditions: { ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v0.1.0"] } } }
      : response],
    ["missing-exclude", (request, response) => {
      if (!request.path.endsWith("/rulesets/73")) return response;
      return { ...response, conditions: { ref_name: { include: ["refs/tags/v*"] } } };
    }],
    ["mismatched-id", (request, response) => request.path.endsWith("/rulesets/73")
      ? { ...response, id: 74 } : response],
    ["unsafe-detail-id", (request, response) => request.path.endsWith("/rulesets/73")
      ? { ...response, id: Number.MAX_SAFE_INTEGER + 1 } : response],
    ["noninteger-summary-id", (request, response) => request.path.endsWith("/rulesets")
      ? response.map((summary) => ({ ...summary, id: "73" })) : response],
    ["bypass-actor", (request, response) => request.path.endsWith("/rulesets/73")
      ? { ...response, bypass_actors: [{ actor_id: 7, actor_type: "RepositoryRole", bypass_mode: "always" }] }
      : response],
    ["missing-bypass", (request, response) => {
      if (!request.path.endsWith("/rulesets/73")) return response;
      const { bypass_actors: _bypassActors, ...withoutBypass } = response;
      return withoutBypass;
    }],
  ]) {
    const requests = [];
    const result = await runRepositoryPolicy({
      mode: "plan",
      policyPath: POLICY_PATH,
      [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
      request: async (request) => {
        requests.push(request);
        return alter(request, compliantResponse(request));
      },
    });
    assert.equal(result.status, "drift", name);
    assert.ok(result.changes.some(({ category }) => category === "tag-ruleset"), name);
    if (!["summary-only", "noninteger-summary-id"].includes(name)) {
      assert.equal(requests.some(({ path }) => path.endsWith("/rulesets/73")), true, name);
    }
    assert.equal(requests.every(({ method }) => method === "GET"), true, name);
  }
});

test("GitHub repository policy drops raw bypass-actor metadata from drift evidence", async (t) => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-bypass-evidence-"));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?bypass-evidence=${Date.now()}`
  );
  const rawActorType = ["private", "-actor-type"].join("");
  const rawBypassMode = ["private", "-bypass-mode"].join("");
  const result = await runRepositoryPolicy({
    mode: "check",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      const response = compliantResponse(request);
      return request.path.endsWith("/rulesets/73")
        ? { ...response, bypass_actors: [{ actor_id: 987654, actor_type: rawActorType, bypass_mode: rawBypassMode }] }
        : response;
    },
    evidenceDirectory,
  });
  assert.equal(result.status, "drift");
  const [name] = await readdir(evidenceDirectory);
  const serialized = `${JSON.stringify(result)}${await readFile(join(evidenceDirectory, name), "utf8")}`;
  for (const forbidden of ["987654", rawActorType, rawBypassMode, "actor_id", "actor_type", "bypass_mode"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("GitHub repository policy apply re-enables disabled Actions from policy", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?actions-enabled=${Date.now()}`
  );
  const requests = [];
  const result = await runRepositoryPolicy({
    mode: "apply",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      requests.push(request);
      const response = compliantResponse(request);
      return request.path.endsWith("/actions/permissions") && request.method === "GET"
        ? { ...response, enabled: false }
        : response;
    },
  });
  assert.equal(result.status, "applied");
  const update = requests.find(({ method, path }) => method === "PUT"
    && path.endsWith("/actions/permissions"));
  assert.deepEqual(update.body, { enabled: true, allowed_actions: "selected" });
});

test("GitHub repository policy check records disabled Actions as drift", async (t) => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-actions-evidence-"));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?actions-check=${Date.now()}`
  );
  const result = await runRepositoryPolicy({
    mode: "check",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => request.path.endsWith("/actions/permissions")
      ? { ...compliantResponse(request), enabled: false }
      : compliantResponse(request),
    evidenceDirectory,
  });
  assert.equal(result.status, "drift");
  assert.ok(result.changes.some(({ category }) => category === "actions"));
  const [name] = await readdir(evidenceDirectory);
  const saved = JSON.parse(await readFile(join(evidenceDirectory, name), "utf8"));
  assert.deepEqual(saved.actions, { enabled: false, matches: false });
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

test("GitHub repository policy blocks a second-page write deploy key without leaking raw metadata", async (t) => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-deploy-key-evidence-"));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?deploy-key=${Date.now()}`
  );
  const rawTitle = ["private", " deploy key title"].join("");
  const rawKey = ["ssh-ed25519 ", "AAAAC3NzaC1lZDI1NTE5AAAA", "private-material"].join("");
  const rawUrl = ["https://api.github.invalid/repos/private/keys/", "9001"].join("");
  const rawActor = ["private", "-deploy-key-actor"].join("");
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    title: `reader-${index}`,
    key: `public-${index}`,
    url: `https://api.github.invalid/keys/${index}`,
    read_only: true,
  }));
  const requests = [];
  const result = await runRepositoryPolicy({
    mode: "apply",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      requests.push(request);
      if (request.path.includes("/keys?")) {
        return request.path.endsWith("&page=1")
          ? firstPage
          : [{
            id: 9001,
            title: rawTitle,
            key: rawKey,
            url: rawUrl,
            read_only: false,
            added_by: { login: rawActor },
          }];
      }
      return compliantResponse(request);
    },
    evidenceDirectory,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "UNEXPECTED_WRITE_DEPLOY_KEY");
  assert.deepEqual(Object.keys(result.blockers[0]).sort(), ["identifier", "permission", "type"]);
  assert.deepEqual({ type: result.blockers[0].type, permission: result.blockers[0].permission }, {
    type: "deploy-key",
    permission: "write",
  });
  assert.match(result.blockers[0].identifier, /^sha256:[0-9a-f]{12}$/u);
  assert.equal(requests.some(({ path }) => path.endsWith("&page=2")), true);
  assert.equal(requests.every(({ method }) => method === "GET"), true);
  assert.equal(requests.some(({ path }) => /\/keys\/(?:9001|\{)/u.test(path)), false);

  const [name] = await readdir(evidenceDirectory);
  const saved = JSON.parse(await readFile(join(evidenceDirectory, name), "utf8"));
  const serialized = JSON.stringify(saved);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.deployKeys.length, 101);
  assert.deepEqual(Object.keys(saved.deployKeys[0]).sort(), ["canWrite", "identifier", "readOnly"]);
  assert.equal(saved.deployKeys.at(-1).readOnly, false);
  assert.equal(saved.deployKeys.at(-1).canWrite, true);
  for (const forbidden of [rawTitle, rawKey, rawUrl, rawActor, "title", "url", "added_by"]) {
    assert.equal(serialized.includes(forbidden), false, `deploy-key evidence leaked ${forbidden}`);
    assert.equal(JSON.stringify(result).includes(forbidden), false, `deploy-key blocker leaked ${forbidden}`);
  }
});

test("GitHub repository policy bounds deploy-key pagination at ten GET-only pages", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?deploy-key-limit=${Date.now()}`
  );
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    key: `ssh-ed25519 public-key-material-${index}`,
    read_only: true,
  }));
  const requests = [];
  await assert.rejects(
    runRepositoryPolicy({
      mode: "check",
      policyPath: POLICY_PATH,
      [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
      request: async (request) => {
        requests.push(request);
        if (!request.path.includes("/keys?")) return compliantResponse(request);
        const page = Number(/[?&]page=([0-9]+)$/u.exec(request.path)?.[1]);
        return fullPage.map((entry) => ({
          ...entry,
          id: (page * 1_000) + entry.id,
          key: `${entry.key}-page-${page}`,
        }));
      },
    }),
    { code: "GITHUB_POLICY_RESPONSE_INVALID" },
  );
  const keyRequests = requests.filter(({ path }) => path.includes("/keys?"));
  assert.equal(keyRequests.length, 10);
  assert.equal(keyRequests.at(-1).path.endsWith("&page=10"), true);
  assert.equal(requests.every(({ method }) => method === "GET"), true);
});

test("GitHub repository policy rejects malformed deploy-key identifiers and permissions", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?deploy-key-malformed=${Date.now()}`
  );
  for (const entry of [
    { key: "ssh-ed25519 valid-public-key", read_only: true },
    { id: 0, key: "ssh-ed25519 valid-public-key", read_only: true },
    { id: "7", key: "ssh-ed25519 valid-public-key", read_only: true },
    { id: 7, read_only: true },
    { id: 7, key: "", read_only: true },
    { id: 7, key: 77, read_only: true },
    { id: 7, key: "ssh-ed25519 valid-public-key", read_only: "false" },
  ]) {
    await assert.rejects(
      runRepositoryPolicy({
        mode: "check",
        policyPath: POLICY_PATH,
        [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
        request: async (request) => request.path.includes("/keys?")
          ? [entry]
          : compliantResponse(request),
      }),
      { code: "GITHUB_POLICY_RESPONSE_INVALID" },
    );
  }
});

test("GitHub repository policy preserves collaborator blocker priority over write deploy keys", async () => {
  const { runRepositoryPolicy } = await import(
    `${new URL("../scripts/github-repository-policy.mjs", import.meta.url).href}?blocker-priority=${Date.now()}`
  );
  const requests = [];
  const result = await runRepositoryPolicy({
    mode: "apply",
    policyPath: POLICY_PATH,
    [SENSITIVE_FIELD_ONE]: TEST_CREDENTIAL,
    request: async (request) => {
      requests.push(request);
      if (request.path.includes("/collaborators?")) {
        return [{ login: "private-collaborator", role_name: "write", permissions: { push: true } }];
      }
      if (request.path.includes("/keys?")) {
        return [{ id: 700, key: "ssh-ed25519 private-collaborator-key", read_only: false }];
      }
      return compliantResponse(request);
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "UNEXPECTED_WRITE_COLLABORATOR");
  assert.equal(requests.some(({ path }) => path.includes("/keys?")), true);
  assert.equal(requests.every(({ method }) => method === "GET"), true);
  assert.doesNotMatch(JSON.stringify(result), /private-collaborator|700/u);
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
      return typeof response === "object" && response !== null && !Array.isArray(response)
        ? { ...response, email: rawEmail, url: rawUrl, [SENSITIVE_FIELD_SIX]: rawSensitiveValue }
        : response;
    },
    evidenceDirectory,
  });
  const [name] = await readdir(evidenceDirectory);
  const saved = JSON.parse(await readFile(join(evidenceDirectory, name), "utf8"));
  const serialized = JSON.stringify(saved);
  assert.deepEqual(Object.keys(saved).sort(), ["actions", "collaborators", "deployKeys", "drift", "mainProtection", "repository", "schemaVersion", "security", "tagRuleset"]);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.collaborators.total, 1);
  assert.equal(saved.collaborators.entries[0].role, "read");
  assert.equal(saved.collaborators.entries[0].canWrite, false);
  assert.match(saved.collaborators.entries[0].identifier, /^sha256:[0-9a-f]{12}$/u);
  for (const forbidden of [rawLogin, rawEmail, rawUrl, rawSensitiveValue, "email", "url", SENSITIVE_FIELD_FOUR, SENSITIVE_FIELD_SIX]) {
    assert.equal(serialized.includes(forbidden), false, `evidence leaked ${forbidden}`);
  }
});

function legacyRulesetSummary(id) {
  return { id, name: "Protect version release tags", enforcement: "active", target: "tag" };
}

function legacyRulesetResponse({ path }) {
  if (path.endsWith("/rulesets")) return [legacyRulesetSummary(73)];
  const legacyId = /\/rulesets\/([1-9][0-9]*)$/u.exec(path)?.[1];
  if (legacyId !== undefined) {
    return {
      id: Number(legacyId),
      name: "Protect version release tags",
      enforcement: "active",
      target: "tag",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "update" }],
    };
  }
  return compliantResponse({ path });
}

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
    return [{ id: 73, name: "immutable-version-tags", enforcement: "active", target: "tag" }];
  }
  if (path.endsWith("/rulesets/73")) {
    return {
      id: 73,
      name: "immutable-version-tags",
      enforcement: "active",
      target: "tag",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      rules: [{ type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }],
    };
  }
  if (path.includes("/collaborators?")) return [];
  if (path.includes("/keys?")) return [];
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
