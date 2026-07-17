import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODES = new Set(["check", "plan", "apply"]);
const CREDENTIAL_FIELDS = new Set([
  "authorization", "cookie", "credential", "githubtoken", "password", "token",
  "accesstoken", "refreshtoken", "clientsecret", "apikey",
]);
const ALLOWED_METHODS = new Set(["GET", "PATCH", "PUT", "DELETE"]);
const COLLABORATOR_PAGE_SIZE = 100;
const MAX_COLLABORATOR_PAGES = 10;
const DEPLOY_KEY_PAGE_SIZE = 100;
const MAX_DEPLOY_KEY_PAGES = 10;
const MAX_RULESET_SUMMARIES = 100;
let evidenceSequence = 0;

export async function runRepositoryPolicy(options) {
  if (!isRecord(options) || !MODES.has(options.mode)) throw policyError("GITHUB_POLICY_USAGE");
  const policyPath = resolve(options.policyPath ?? join(ROOT, ".github", "repository-policy.json"));
  const policy = validatePolicy(JSON.parse(await readFile(policyPath, "utf8")));
  const token = requiredToken(options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
  const request = options.request ?? createGitHubRequest(token);
  if (typeof request !== "function") throw policyError("GITHUB_POLICY_REQUEST_INVALID");
  const base = `/repos/${policy.repository.owner}/${policy.repository.name}`;
  const rulesetSummaries = await request({ method: "GET", path: `${base}/rulesets` });

  const state = {
    repository: await request({ method: "GET", path: base }),
    actions: await request({ method: "GET", path: `${base}/actions/permissions` }),
    workflowPermissions: await request({ method: "GET", path: `${base}/actions/permissions/workflow` }),
    selectedActions: await request({ method: "GET", path: `${base}/actions/permissions/selected-actions` }),
    mainProtection: await request({ method: "GET", path: `${base}/branches/main/protection` }),
    rulesets: await listDetailedTagRulesets(
      request,
      base,
      rulesetSummaries,
      policy.tagRuleset,
    ),
    privateVulnerabilityReporting: await request({ method: "GET", path: `${base}/private-vulnerability-reporting` }),
    vulnerabilityAlerts: await request({ method: "GET", path: `${base}/vulnerability-alerts` }),
    automatedSecurityFixes: await request({ method: "GET", path: `${base}/automated-security-fixes` }),
    collaborators: await listDirectCollaborators(request, base),
    deployKeys: await listDeployKeys(request, base),
  };
  const unexpected = unexpectedWriteCollaborators(state.collaborators, policy.collaborators.owner);
  const unexpectedDeployKeys = state.deployKeys.filter(({ canWrite }) => canWrite);
  const drift = comparePolicy(policy, state);
  const evidence = buildPolicyEvidence(policy, state, drift, unexpected);
  if (options.evidenceDirectory !== undefined) await writeEvidence(options.evidenceDirectory, evidence);

  if (unexpected.length > 0) {
    return Object.freeze({
      status: "blocked",
      mode: options.mode,
      code: "UNEXPECTED_WRITE_COLLABORATOR",
      blockers: unexpected.map(({ identifier }) => ({ category: "collaborator", identifier })),
    });
  }
  if (unexpectedDeployKeys.length > 0) {
    return Object.freeze({
      status: "blocked",
      mode: options.mode,
      code: "UNEXPECTED_WRITE_DEPLOY_KEY",
      blockers: Object.freeze(unexpectedDeployKeys.map(({ identifier }) => Object.freeze({
        type: "deploy-key",
        identifier,
        permission: "write",
      }))),
    });
  }
  if (drift.length === 0) return Object.freeze({ status: "compliant", mode: options.mode, changes: [] });
  if (options.mode !== "apply") {
    return Object.freeze({ status: "drift", mode: options.mode, changes: drift.map(publicChange) });
  }

  const ownerOnly = drift.filter(({ category }) => category === "tag-ruleset");
  if (ownerOnly.length > 0) {
    return Object.freeze({
      status: "blocked",
      mode: "apply",
      code: "OWNER_ACTION_REQUIRED",
      blockers: ownerOnly.map(publicChange),
    });
  }

  await applyAllowedPolicy({ request, base, policy, drift });
  return Object.freeze({ status: "applied", mode: "apply", changes: drift.map(publicChange) });
}

export function redactPolicyOutput(value) {
  if (Array.isArray(value)) return value.map(redactPolicyOutput);
  if (typeof value === "string") return sensitiveString(value) ? "<redacted>" : value;
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    CREDENTIAL_FIELDS.has(key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase())
      ? "<redacted>"
      : redactPolicyOutput(item),
  ]));
}

function sensitiveString(value) {
  return /^Bearer\s+\S+$/iu.test(value)
    || /^(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+$/u.test(value);
}

async function listDirectCollaborators(request, base) {
  const collaborators = [];
  for (let page = 1; page <= MAX_COLLABORATOR_PAGES; page += 1) {
    const entries = await request({
      method: "GET",
      path: `${base}/collaborators?affiliation=direct&per_page=${COLLABORATOR_PAGE_SIZE}&page=${page}`,
    });
    if (!Array.isArray(entries) || entries.length > COLLABORATOR_PAGE_SIZE) {
      throw policyError("GITHUB_POLICY_RESPONSE_INVALID");
    }
    collaborators.push(...entries);
    if (entries.length < COLLABORATOR_PAGE_SIZE) return collaborators;
  }
  throw policyError("GITHUB_POLICY_RESPONSE_INVALID");
}

async function listDetailedTagRulesets(request, base, summaries, desired) {
  if (!Array.isArray(summaries) || summaries.length > MAX_RULESET_SUMMARIES) {
    throw policyError("GITHUB_POLICY_RESPONSE_INVALID");
  }
  const projected = [];
  for (const summary of summaries) {
    if (summary?.name !== desired.name || summary?.target !== "tag") continue;
    const summaryId = summary?.id;
    if (!Number.isSafeInteger(summaryId) || summaryId <= 0) {
      projected.push(Object.freeze({ summaryIdMatches: false }));
      continue;
    }
    const detail = await request({ method: "GET", path: `${base}/rulesets/${summaryId}` });
    projected.push(projectTagRulesetDetail(detail, summaryId));
  }
  return Object.freeze(projected);
}

function projectTagRulesetDetail(detail, summaryId) {
  if (!isRecord(detail)) return Object.freeze({ summaryIdMatches: false });
  const include = detail.conditions?.ref_name?.include;
  const exclude = detail.conditions?.ref_name?.exclude;
  const bypassPresent = Object.hasOwn(detail, "bypass_actors");
  const bypass = detail.bypass_actors;
  const rules = detail.rules;
  return Object.freeze({
    summaryIdMatches: Number.isSafeInteger(detail.id) && detail.id === summaryId,
    name: typeof detail.name === "string" ? detail.name : undefined,
    target: typeof detail.target === "string" ? detail.target : undefined,
    enforcement: typeof detail.enforcement === "string" ? detail.enforcement : undefined,
    include: stringArrayProjection(include),
    exclude: stringArrayProjection(exclude),
    bypassPresent,
    bypassCount: Array.isArray(bypass) ? bypass.length : undefined,
    ruleTypes: Array.isArray(rules) && rules.every((rule) => isRecord(rule)
      && typeof rule.type === "string")
      ? Object.freeze(rules.map(({ type }) => type))
      : undefined,
  });
}

function stringArrayProjection(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? Object.freeze([...value])
    : undefined;
}

async function listDeployKeys(request, base) {
  const keys = [];
  const identifiers = new Set();
  for (let page = 1; page <= MAX_DEPLOY_KEY_PAGES; page += 1) {
    const entries = await request({
      method: "GET",
      path: `${base}/keys?per_page=${DEPLOY_KEY_PAGE_SIZE}&page=${page}`,
    });
    if (!Array.isArray(entries) || entries.length > DEPLOY_KEY_PAGE_SIZE) {
      throw policyError("GITHUB_POLICY_RESPONSE_INVALID");
    }
    for (const entry of entries) {
      const projected = projectDeployKey(entry);
      if (identifiers.has(projected.identifier)) {
        throw policyError("GITHUB_POLICY_RESPONSE_INVALID");
      }
      identifiers.add(projected.identifier);
      keys.push(projected);
    }
    if (entries.length < DEPLOY_KEY_PAGE_SIZE) return Object.freeze(keys);
  }
  throw policyError("GITHUB_POLICY_RESPONSE_INVALID");
}

function projectDeployKey(entry) {
  if (!isRecord(entry) || !Number.isSafeInteger(entry.id) || entry.id <= 0
    || typeof entry.key !== "string" || !/^[^\u0000-\u001f\u007f]{1,16384}$/u.test(entry.key)
    || typeof entry.read_only !== "boolean") {
    throw policyError("GITHUB_POLICY_RESPONSE_INVALID");
  }
  return Object.freeze({
    identifier: deployKeyIdentifier(entry.key),
    readOnly: entry.read_only,
    canWrite: entry.read_only === false,
  });
}

function deployKeyIdentifier(publicKey) {
  return `sha256:${createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 12)}`;
}

function buildPolicyEvidence(policy, state, drift, unexpected) {
  return Object.freeze({
    schemaVersion: 2,
    repository: Object.freeze({
      defaultBranchMatches: state.repository?.default_branch === policy.repository.defaultBranch,
      issuesMatches: state.repository?.has_issues === policy.features.issues,
      secretScanningMatches: state.repository?.security_and_analysis?.secret_scanning?.status
        === policy.features.secretScanning,
      secretScanningPushProtectionMatches:
        state.repository?.security_and_analysis?.secret_scanning_push_protection?.status
          === policy.features.secretScanningPushProtection,
    }),
    actions: Object.freeze({
      enabled: state.actions?.enabled === true,
      matches: actionsMatch(state, policy.actions),
    }),
    mainProtection: Object.freeze({ matches: mainProtectionMatches(state.mainProtection, policy.mainProtection) }),
    tagRuleset: Object.freeze({ matches: tagRulesetMatches(state.rulesets, policy.tagRuleset) }),
    security: Object.freeze({
      privateVulnerabilityReportingMatches:
        state.privateVulnerabilityReporting?.enabled === policy.features.privateVulnerabilityReporting,
      vulnerabilityAlertsMatches: state.vulnerabilityAlerts?.enabled === policy.features.vulnerabilityAlerts,
      automatedSecurityFixesMatches:
        state.automatedSecurityFixes?.enabled === policy.features.automatedDependabotSecurityUpdates,
    }),
    collaborators: Object.freeze({
      total: state.collaborators.length,
      unexpectedWriteCount: unexpected.length,
      entries: Object.freeze(state.collaborators.map((entry) => Object.freeze({
        identifier: collaboratorIdentifier(entry?.login),
        owner: entry?.login === policy.collaborators.owner,
        role: collaboratorRole(entry),
        canWrite: collaboratorCanWrite(entry),
      }))),
    }),
    deployKeys: Object.freeze(state.deployKeys.map(({ identifier, readOnly, canWrite }) => Object.freeze({
      identifier,
      readOnly,
      canWrite,
    }))),
    drift: Object.freeze(drift.map(publicChange)),
  });
}

async function applyAllowedPolicy({ request, base, policy, drift }) {
  const categories = new Set(drift.map(({ category }) => category));
  if (categories.has("repository")) {
    await request({ method: "PATCH", path: base, body: {
      default_branch: policy.repository.defaultBranch,
      has_issues: policy.features.issues,
      security_and_analysis: {
        secret_scanning: { status: policy.features.secretScanning },
        secret_scanning_push_protection: { status: policy.features.secretScanningPushProtection },
      },
    } });
  }
  if (categories.has("actions")) {
    await request({ method: "PUT", path: `${base}/actions/permissions`, body: {
      enabled: policy.actions.enabled,
      allowed_actions: policy.actions.allowedActions,
    } });
    await request({ method: "PUT", path: `${base}/actions/permissions/workflow`, body: {
      default_workflow_permissions: policy.actions.defaultWorkflowPermissions,
      can_approve_pull_request_reviews: policy.actions.canApprovePullRequestReviews,
    } });
    await request({ method: "PUT", path: `${base}/actions/permissions/selected-actions`, body: {
      github_owned_allowed: policy.actions.githubOwnedAllowed,
      verified_allowed: policy.actions.verifiedCreatorAllowed,
      patterns_allowed: policy.actions.patternsAllowed,
    } });
  }
  if (categories.has("main-protection")) {
    await request({ method: "PUT", path: `${base}/branches/main/protection`, body: branchPayload(policy) });
  }
  if (categories.has("private-vulnerability-reporting")) {
    await request({ method: "PUT", path: `${base}/private-vulnerability-reporting` });
  }
  if (categories.has("vulnerability-alerts")) {
    await request({ method: "PUT", path: `${base}/vulnerability-alerts` });
  }
  if (categories.has("automated-security-fixes")) {
    await request({ method: "DELETE", path: `${base}/automated-security-fixes` });
  }
}

function comparePolicy(policy, state) {
  const drift = [];
  const repository = state.repository ?? {};
  if (repository.default_branch !== policy.repository.defaultBranch
    || repository.has_issues !== policy.features.issues
    || repository.security_and_analysis?.secret_scanning?.status !== policy.features.secretScanning
    || repository.security_and_analysis?.secret_scanning_push_protection?.status
      !== policy.features.secretScanningPushProtection) {
    drift.push(change("repository", "repository features or default branch differ"));
  }

  if (!actionsMatch(state, policy.actions)) {
    drift.push(change("actions", "Actions permissions or selected SHA pins differ"));
  }

  if (!mainProtectionMatches(state.mainProtection, policy.mainProtection)) {
    drift.push(change("main-protection", "main branch protection differs"));
  }
  if (!tagRulesetMatches(state.rulesets, policy.tagRuleset)) {
    drift.push(change("tag-ruleset", "immutable version-tag ruleset requires owner action"));
  }
  if (state.privateVulnerabilityReporting?.enabled !== policy.features.privateVulnerabilityReporting) {
    drift.push(change("private-vulnerability-reporting", "private vulnerability reporting differs"));
  }
  if (state.vulnerabilityAlerts?.enabled !== policy.features.vulnerabilityAlerts) {
    drift.push(change("vulnerability-alerts", "vulnerability alerts differ"));
  }
  if (state.automatedSecurityFixes?.enabled !== policy.features.automatedDependabotSecurityUpdates) {
    drift.push(change("automated-security-fixes", "automated Dependabot security-update PR policy differs"));
  }
  return drift;
}

function actionsMatch(state, desired) {
  const actions = state.actions ?? {};
  const workflow = state.workflowPermissions ?? actions;
  const selected = state.selectedActions ?? {};
  return actions.enabled === desired.enabled
    && actions.allowed_actions === desired.allowedActions
    && workflow.default_workflow_permissions === desired.defaultWorkflowPermissions
    && workflow.can_approve_pull_request_reviews === desired.canApprovePullRequestReviews
    && selected.github_owned_allowed === desired.githubOwnedAllowed
    && selected.verified_allowed === desired.verifiedCreatorAllowed
    && sameSet(selected.patterns_allowed, desired.patternsAllowed);
}

function mainProtectionMatches(actual, desired) {
  return actual?.enforce_admins?.enabled === desired.enforceAdmins
    && actual?.required_status_checks?.strict === true
    && sameSet(actual?.required_status_checks?.contexts, desired.requiredStatusChecks)
    && actual?.required_pull_request_reviews?.dismiss_stale_reviews === desired.dismissStaleReviews
    && actual?.required_pull_request_reviews?.required_approving_review_count === desired.requiredApprovingReviewCount
    && actual?.required_linear_history?.enabled === desired.requiredLinearHistory
    && actual?.required_conversation_resolution?.enabled === desired.requiredConversationResolution
    && actual?.allow_force_pushes?.enabled === desired.allowForcePushes
    && actual?.allow_deletions?.enabled === desired.allowDeletions;
}

function tagRulesetMatches(rulesets, desired) {
  if (!Array.isArray(rulesets)) return false;
  return rulesets.some((ruleset) => {
    const types = new Set(Array.isArray(ruleset?.ruleTypes) ? ruleset.ruleTypes : []);
    return ruleset?.summaryIdMatches === true
      && ruleset?.name === desired.name && ruleset?.target === "tag"
      && ruleset?.enforcement === desired.enforcement
      && sameSet(ruleset?.include, desired.include)
      && sameSet(ruleset?.exclude, desired.exclude)
      && ruleset?.bypassPresent === true
      && ruleset?.bypassCount === desired.bypassActors.length
      && (!desired.blockUpdate || types.has("update"))
      && (!desired.blockDeletion || types.has("deletion"))
      && (!desired.blockNonFastForward || types.has("non_fast_forward"));
  });
}

function branchPayload(policy) {
  const desired = policy.mainProtection;
  return {
    required_status_checks: { strict: true, contexts: desired.requiredStatusChecks },
    enforce_admins: desired.enforceAdmins,
    required_pull_request_reviews: {
      dismiss_stale_reviews: desired.dismissStaleReviews,
      require_code_owner_reviews: false,
      required_approving_review_count: desired.requiredApprovingReviewCount,
      require_last_push_approval: false,
    },
    restrictions: null,
    required_linear_history: desired.requiredLinearHistory,
    allow_force_pushes: desired.allowForcePushes,
    allow_deletions: desired.allowDeletions,
    block_creations: false,
    required_conversation_resolution: desired.requiredConversationResolution,
    lock_branch: false,
    allow_fork_syncing: true,
  };
}

function unexpectedWriteCollaborators(collaborators, owner) {
  if (!Array.isArray(collaborators)) throw policyError("GITHUB_POLICY_RESPONSE_INVALID");
  return collaborators.filter((entry) => entry?.login !== owner && collaboratorCanWrite(entry))
    .map((entry) => ({ identifier: collaboratorIdentifier(entry?.login) }))
    .sort(({ identifier: left }, { identifier: right }) => left.localeCompare(right));
}

function collaboratorCanWrite(entry) {
  return entry?.permissions?.push === true || entry?.permissions?.maintain === true
    || entry?.permissions?.admin === true || ["write", "maintain", "admin"].includes(entry?.role_name);
}

function collaboratorRole(entry) {
  const role = typeof entry?.role_name === "string" ? entry.role_name.toLowerCase() : "unknown";
  return ["read", "triage", "write", "maintain", "admin"].includes(role) ? role : "unknown";
}

function collaboratorIdentifier(login) {
  const normalized = typeof login === "string" && login !== "" ? login : "<unknown>";
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12)}`;
}

function createGitHubRequest(token) {
  return async ({ method, path, body }) => {
    assertAllowedRequest(method, path);
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
    });
    if (method === "GET" && (path.endsWith("/vulnerability-alerts")
      || path.endsWith("/automated-security-fixes"))) {
      if (response.status === 204) return { enabled: true };
      if (response.status === 404) return { enabled: false };
    }
    if (!response.ok) throw policyError(`GITHUB_POLICY_HTTP_${response.status}`);
    if (response.status === 204) return {};
    return response.json();
  };
}

function assertAllowedRequest(method, path) {
  if (!ALLOWED_METHODS.has(method)) throw policyError("GITHUB_POLICY_ENDPOINT_BLOCKED");
  const route = path.replace(/^\/repos\/[^/]+\/[^/]+/u, "");
  const get = new Set([
    "", "/actions/permissions", "/actions/permissions/workflow",
    "/actions/permissions/selected-actions", "/branches/main/protection", "/rulesets",
    "/private-vulnerability-reporting", "/vulnerability-alerts", "/automated-security-fixes",
  ]);
  const mutate = new Set([
    "PATCH ", "PUT /actions/permissions", "PUT /actions/permissions/workflow",
    "PUT /actions/permissions/selected-actions", "PUT /branches/main/protection",
    "PUT /private-vulnerability-reporting", "PUT /vulnerability-alerts",
    "DELETE /automated-security-fixes",
  ]);
  const collaboratorPage = /^\/collaborators\?affiliation=direct&per_page=100&page=(?:[1-9]|10)$/u.test(route);
  const deployKeyPage = /^\/keys\?per_page=100&page=(?:[1-9]|10)$/u.test(route);
  const rulesetDetail = /^\/rulesets\/[1-9][0-9]*$/u.test(route);
  if (method === "GET"
    ? get.has(route) || collaboratorPage || deployKeyPage || rulesetDetail
    : mutate.has(`${method} ${route}`)) return;
  throw policyError("GITHUB_POLICY_ENDPOINT_BLOCKED");
}

function validatePolicy(policy) {
  if (!isRecord(policy) || policy.schemaVersion !== 1 || !isRecord(policy.repository)
    || !isRecord(policy.features) || !isRecord(policy.actions) || !isRecord(policy.mainProtection)
    || !isRecord(policy.tagRuleset) || !isRecord(policy.collaborators)
    || !isRecord(policy.deployKeys)) {
    throw policyError("GITHUB_POLICY_INVALID");
  }
  const {
    repository,
    features,
    actions,
    mainProtection,
    tagRuleset,
    collaborators,
    deployKeys,
  } = policy;
  const slug = /^[A-Za-z0-9_.-]{1,100}$/u;
  const statuses = new Set(["enabled", "disabled"]);
  const patterns = actions.patternsAllowed;
  const checks = mainProtection.requiredStatusChecks;
  const valid = slug.test(repository.owner)
    && slug.test(repository.name)
    && repository.defaultBranch === "main"
    && booleanFields(features, [
      "issues", "privateVulnerabilityReporting", "vulnerabilityAlerts",
      "automatedDependabotSecurityUpdates",
    ])
    && statuses.has(features.secretScanning)
    && statuses.has(features.secretScanningPushProtection)
    && actions.enabled === true
    && ["read", "write"].includes(actions.defaultWorkflowPermissions)
    && typeof actions.canApprovePullRequestReviews === "boolean"
    && actions.allowedActions === "selected"
    && booleanFields(actions, ["githubOwnedAllowed", "verifiedCreatorAllowed"])
    && actions.requireFullSha === true
    && nonEmptyUniqueStrings(patterns, /^actions\/[a-z-]+@[0-9a-f]{40}$/u)
    && mainProtection.pullRequestOnly === true
    && Number.isInteger(mainProtection.requiredApprovingReviewCount)
    && mainProtection.requiredApprovingReviewCount >= 0
    && mainProtection.requiredApprovingReviewCount <= 6
    && booleanFields(mainProtection, [
      "dismissStaleReviews", "enforceAdmins", "requiredLinearHistory",
      "requiredConversationResolution", "allowForcePushes", "allowDeletions",
    ])
    && nonEmptyUniqueStrings(checks, /^[A-Za-z0-9 ._()+\/-]{1,100}$/u)
    && tagRuleset.name === "immutable-version-tags"
    && tagRuleset.enforcement === "active"
    && Array.isArray(tagRuleset.include)
    && tagRuleset.include.length === 1
    && tagRuleset.include[0] === "refs/tags/v*"
    && Array.isArray(tagRuleset.exclude)
    && tagRuleset.exclude.length === 0
    && Array.isArray(tagRuleset.bypassActors)
    && tagRuleset.bypassActors.length === 0
    && tagRuleset.blockUpdate === true
    && tagRuleset.blockDeletion === true
    && tagRuleset.blockNonFastForward === true
    && collaborators.owner === repository.owner
    && collaborators.nonOwnerMaximumPermission === "read"
    && collaborators.unexpectedWriteIsBlocker === true
    && exactKeys(deployKeys, ["maximumPermission", "unexpectedWriteIsBlocker"])
    && deployKeys.maximumPermission === "read"
    && deployKeys.unexpectedWriteIsBlocker === true;
  if (!valid) throw policyError("GITHUB_POLICY_INVALID");
  return policy;
}

function booleanFields(value, fields) {
  return fields.every((field) => typeof value[field] === "boolean");
}

function nonEmptyUniqueStrings(value, pattern) {
  return Array.isArray(value) && value.length > 0
    && new Set(value).size === value.length
    && value.every((entry) => typeof entry === "string" && pattern.test(entry));
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

async function writeEvidence(directory, value) {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(/\D/gu, "");
  evidenceSequence += 1;
  await writeFile(
    join(target, `repository-policy-${timestamp}-${process.pid}-${evidenceSequence}.json`),
    `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    },
  );
}

function sameSet(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function change(category, detail) { return Object.freeze({ category, detail }); }
function publicChange({ category, detail }) { return Object.freeze({ category, detail }); }
function requiredToken(value) {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\0]/u.test(value)) {
    throw policyError("GITHUB_POLICY_TOKEN_REQUIRED");
  }
  return value;
}
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function policyError(code) { const error = new Error(code); error.code = code; return error; }

async function runCli(argv) {
  if (argv.length !== 1 || !/^--(?:check|plan|apply)$/u.test(argv[0])) throw policyError("GITHUB_POLICY_USAGE");
  const mode = argv[0].slice(2);
  const result = await runRepositoryPolicy({
    mode,
    evidenceDirectory: join(ROOT, ".superpowers", "evidence", "github-policy"),
  });
  process.stdout.write(`${JSON.stringify(redactPolicyOutput(result))}\n`);
  if (result.status === "drift" || result.status === "blocked") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code?.startsWith?.("GITHUB_POLICY_") ? error.code : "GITHUB_POLICY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
