import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODES = new Set(["check", "plan", "apply"]);
const CREDENTIAL_FIELD = /^(?:authorization|cookie|credential|github_token|password|token)$/iu;
const ALLOWED_METHODS = new Set(["GET", "PATCH", "PUT", "DELETE"]);
let evidenceSequence = 0;

export async function runRepositoryPolicy(options) {
  if (!isRecord(options) || !MODES.has(options.mode)) throw policyError("GITHUB_POLICY_USAGE");
  const policyPath = resolve(options.policyPath ?? join(ROOT, ".github", "repository-policy.json"));
  const policy = validatePolicy(JSON.parse(await readFile(policyPath, "utf8")));
  const token = requiredToken(options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
  const request = options.request ?? createGitHubRequest(token);
  if (typeof request !== "function") throw policyError("GITHUB_POLICY_REQUEST_INVALID");
  const base = `/repos/${policy.repository.owner}/${policy.repository.name}`;

  const state = {
    repository: await request({ method: "GET", path: base }),
    actions: await request({ method: "GET", path: `${base}/actions/permissions` }),
    workflowPermissions: await request({ method: "GET", path: `${base}/actions/permissions/workflow` }),
    selectedActions: await request({ method: "GET", path: `${base}/actions/permissions/selected-actions` }),
    mainProtection: await request({ method: "GET", path: `${base}/branches/main/protection` }),
    rulesets: await request({ method: "GET", path: `${base}/rulesets` }),
    privateVulnerabilityReporting: await request({ method: "GET", path: `${base}/private-vulnerability-reporting` }),
    vulnerabilityAlerts: await request({ method: "GET", path: `${base}/vulnerability-alerts` }),
    automatedSecurityFixes: await request({ method: "GET", path: `${base}/automated-security-fixes` }),
    collaborators: await request({ method: "GET", path: `${base}/collaborators?affiliation=direct&per_page=100` }),
  };
  const unexpected = unexpectedWriteCollaborators(state.collaborators, policy.collaborators.owner);
  const drift = comparePolicy(policy, state);
  const evidence = redactPolicyOutput({ schemaVersion: 1, repository: policy.repository, state, drift });
  if (options.evidenceDirectory !== undefined) await writeEvidence(options.evidenceDirectory, evidence);

  if (unexpected.length > 0) {
    return Object.freeze({
      status: "blocked",
      mode: options.mode,
      code: "UNEXPECTED_WRITE_COLLABORATOR",
      blockers: unexpected.map((login) => ({ category: "collaborator", login })),
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
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    CREDENTIAL_FIELD.test(key) ? "<redacted>" : redactPolicyOutput(item),
  ]));
}

async function applyAllowedPolicy({ request, base, policy, drift }) {
  const categories = new Set(drift.map(({ category }) => category));
  if (categories.has("repository")) {
    await request({ method: "PATCH", path: base, body: {
      has_issues: policy.features.issues,
      security_and_analysis: {
        secret_scanning: { status: policy.features.secretScanning },
        secret_scanning_push_protection: { status: policy.features.secretScanningPushProtection },
      },
    } });
  }
  if (categories.has("actions")) {
    await request({ method: "PUT", path: `${base}/actions/permissions`, body: {
      enabled: true,
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

  const actions = state.actions ?? {};
  const workflow = state.workflowPermissions ?? actions;
  const selected = state.selectedActions ?? {};
  if (actions.allowed_actions !== policy.actions.allowedActions
    || workflow.default_workflow_permissions !== policy.actions.defaultWorkflowPermissions
    || workflow.can_approve_pull_request_reviews !== policy.actions.canApprovePullRequestReviews
    || selected.github_owned_allowed !== policy.actions.githubOwnedAllowed
    || selected.verified_allowed !== policy.actions.verifiedCreatorAllowed
    || !sameSet(selected.patterns_allowed, policy.actions.patternsAllowed)) {
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
    const types = new Set(Array.isArray(ruleset?.rules) ? ruleset.rules.map(({ type }) => type) : []);
    return ruleset?.name === desired.name && ruleset?.target === "tag"
      && ruleset?.enforcement === desired.enforcement
      && sameSet(ruleset?.conditions?.ref_name?.include, desired.include)
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
  return collaborators.filter((entry) => entry?.login !== owner
    && (entry?.permissions?.push === true || entry?.permissions?.maintain === true
      || entry?.permissions?.admin === true || ["write", "maintain", "admin"].includes(entry?.role_name)))
    .map(({ login }) => typeof login === "string" ? login : "<unknown>")
    .sort();
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
    "/collaborators?affiliation=direct&per_page=100",
  ]);
  const mutate = new Set([
    "PATCH ", "PUT /actions/permissions", "PUT /actions/permissions/workflow",
    "PUT /actions/permissions/selected-actions", "PUT /branches/main/protection",
    "PUT /private-vulnerability-reporting", "PUT /vulnerability-alerts",
    "DELETE /automated-security-fixes",
  ]);
  if (method === "GET" ? get.has(route) : mutate.has(`${method} ${route}`)) return;
  throw policyError("GITHUB_POLICY_ENDPOINT_BLOCKED");
}

function validatePolicy(policy) {
  if (!isRecord(policy) || policy.schemaVersion !== 1 || !isRecord(policy.repository)
    || !isRecord(policy.features) || !isRecord(policy.actions) || !isRecord(policy.mainProtection)
    || !isRecord(policy.tagRuleset) || !isRecord(policy.collaborators)
    || !Array.isArray(policy.actions.patternsAllowed)
    || policy.actions.patternsAllowed.some((entry) => !/^actions\/[a-z-]+@[0-9a-f]{40}$/u.test(entry))
    || !Array.isArray(policy.mainProtection.requiredStatusChecks)) {
    throw policyError("GITHUB_POLICY_INVALID");
  }
  return policy;
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
