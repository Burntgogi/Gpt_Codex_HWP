import assert from "node:assert/strict";
import { access, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createCanonicalTemporaryDirectory } from "../scripts/canonical-temp.mjs";

import {
  MAX_ADVISORY_RECORDS,
  MAX_GITHUB_RESPONSE_BYTES,
  advisoryRecord,
  auditChildEnvironment,
  readBoundedResponseJson,
  renderIssueBody,
} from "../scripts/dependency-audit-issue.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const OWNER = "Burntgogi";
const TOOLS = [
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

async function text(relativePath) {
  return readFile(join(ROOT, ...relativePath.split("/")), "utf8");
}

test("governance documentation defines reproducible contributor and architecture contracts", async () => {
  const [contributing, architecture, development, performance] = await Promise.all([
    text("CONTRIBUTING.md"),
    text("docs/ARCHITECTURE.md"),
    text("docs/DEVELOPMENT.md"),
    text("docs/PERFORMANCE.md"),
  ]);

  for (const command of [
    "npm run build",
    "npm test",
    "npm run test:python",
    "npm run release:artifacts",
    "npm run release:verify",
  ]) assert.match(contributing, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(contributing, /test-driven development|TDD/iu);
  assert.match(contributing, /security/iu);
  assert.match(contributing, /owner review/iu);
  assert.match(contributing, /generated runtime/iu);
  assert.match(contributing, /do not edit|never edit/iu);

  assert.match(architecture, /source tree/iu);
  assert.match(architecture, /generated runtime/iu);
  assert.match(architecture, /hybrid engine/iu);
  assert.match(architecture, /HWP.{0,40}read-only/isu);
  assert.match(architecture, /HWPX.{0,40}(write|output)/isu);
  for (const tool of TOOLS) assert.match(architecture, new RegExp("`" + tool + "`", "u"));
  assert.equal(new Set([...architecture.matchAll(/`(hwp_[a-z_]+)`/gu)].map((match) => match[1])).size, 9);
  for (const limit of ["512 MiB", "64 MiB", "8 MiB", "64,000", "1536 MiB"]) {
    assert.match(architecture, new RegExp(limit.replace(".", "\\."), "u"));
  }
  assert.match(architecture, /Kordoc/iu);
  assert.match(architecture, /rhwp/iu);

  assert.match(development, /Windows x64/iu);
  assert.match(development, /macOS.{0,80}(compatibility target|호환 대상)/isu);
  assert.match(development, /macOS.{0,100}(unverified|검증하지|미검증)/isu);
  assert.match(performance, /512 MiB.{0,100}(boundary|ceiling|상한)/isu);
});

test("governance docs distinguish descriptor namespaces and nominal sampling cadence", async () => {
  const [development, performance] = await Promise.all([
    text("docs/DEVELOPMENT.md"),
    text("docs/PERFORMANCE.md"),
  ]);
  assert.match(
    development,
    /ordinary document child.{0,300}fd 5.{0,120}parent-(?:created|owned) result spool.{0,160}fd 6.{0,120}child-to-parent control/isu,
  );
  assert.match(
    development,
    /outer benchmark case.{0,500}fd 5.{0,160}registration-writer.{0,240}parent.{0,120}reader.{0,240}fd 6.{0,160}ACK-reader.{0,240}parent.{0,120}writer/isu,
  );
  assert.match(
    development,
    /fd 7 is a pipe on every platform.{0,160}buffers one exact START frame.{0,160}remains open.{0,160}parent lifeline/isu,
  );
  assert.match(
    development,
    /(?:configured nominal|nominal configured) cadence.{0,120}20 ms.{0,160}25 ms.{0,160}100 ms/isu,
  );
  assert.match(
    performance,
    /(?:configured nominal|nominal configured) cadence.{0,120}20 ms.{0,160}25 ms.{0,160}100 ms/isu,
  );
});

test("governance documentation preserves project and upstream license boundaries", async () => {
  const [readmeKo, readmeEn, notices, contributing] = await Promise.all([
    text("README.md"),
    text("README.en.md"),
    text("THIRD_PARTY_NOTICES.md"),
    text("CONTRIBUTING.md"),
  ]);
  for (const document of [readmeKo, readmeEn, contributing]) {
    assert.match(document, /Apache-2\.0/u);
    assert.match(document, /THIRD_PARTY_NOTICES\.md/u);
  }
  assert.match(notices, /## Kordoc/u);
  assert.match(notices, /## rhwp/u);
  assert.match(notices, /remain subject to|각각의|respective/iu);
});

test("governance documentation records only released versions as released", async () => {
  const changelog = await text("CHANGELOG.md");
  assert.match(changelog, /^## \[Unreleased\]/mu);
  for (const version of ["0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4"]) {
    assert.match(changelog, new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu"));
  }
  const unreleased = changelog.slice(
    changelog.indexOf("## [Unreleased]"),
    changelog.indexOf("## [0.1.4]"),
  );
  assert.doesNotMatch(unreleased, /is released|has been released|published as|배포되었|배포 완료/iu);
});

test("governance documentation assigns owner review to every sensitive path", async () => {
  const codeowners = await text(".github/CODEOWNERS");
  const expected = [
    ".github/workflows/",
    "packages/gpt-codex-hwp/release-scripts/",
    "packages/gpt-codex-hwp/vendor/kordoc-core/",
    "scripts/kordoc-core-runtime.mjs",
    "scripts/kordoc-runtime-verifier.mjs",
    "scripts/public-content-policy.mjs",
    "scripts/scan-public-history.mjs",
    "scripts/project-runtime.mjs",
  ];
  for (const path of expected) {
    assert.match(codeowners, new RegExp(`^${path.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s+@${OWNER}$`, "mu"));
  }
});

test("governance documentation dependency audit is scheduled and issue-only", async () => {
  const workflow = await text(".github/workflows/dependency-audit.yml");
  assert.match(workflow, /^\s*schedule:/mu);
  assert.match(workflow, /^\s*contents:\s*read\s*$/mu);
  assert.match(workflow, /^\s*issues:\s*write\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*contents:\s*write\s*$/mu);
  assert.doesNotMatch(workflow, /pull_request|auto-merge|automerge|git\s+(commit|push|checkout\s+-b)|persist-credentials:\s*true/iu);
  assert.match(workflow, /persist-credentials:\s*false/iu);
  assert.match(workflow, /^\s*timeout-minutes:\s*10\s*$/mu);
  assert.match(workflow, /package.{0,80}current.{0,80}patched.{0,80}link/isu);
  assert.doesNotMatch(workflow, /\b(console\.log|Write-Output|echo)\b/u);
  for (const reference of [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)].map((match) => match[1])) {
    assert.match(reference, /^[a-f0-9]{40}$/u);
  }
  await assert.rejects(access(join(ROOT, ".github", "dependabot.yml")), { code: "ENOENT" });
});

test("governance documentation dependency audit bounds secrets, processes, and issue data", async () => {
  const implementation = await text("scripts/dependency-audit-issue.mjs");
  assert.match(implementation, /runBoundedProcess/u);
  assert.match(implementation, /createOwnedBoundary/u);
  assert.match(implementation, /readOwnedRegularFile/u);
  assert.doesNotMatch(implementation, /from "node:child_process"|function collectAudit/u);
  assert.match(implementation, /AUDIT_TIMEOUT_MS/u);
  assert.match(implementation, /MAX_ADVISORY_RECORDS/u);
  assert.match(implementation, /MAX_ISSUE_BODY_BYTES/u);
  assert.match(implementation, /MAX_GITHUB_RESPONSE_BYTES/u);
  assert.match(implementation, /GITHUB_RESPONSE_TOO_LARGE/u);
  assert.match(implementation, /ADVISORY_RECORD_LIMIT/u);
  assert.match(implementation, /ISSUE_BODY_TOO_LARGE/u);
  assert.doesNotMatch(implementation, /spawn\([^\n]+\{[^}]*env:\s*process\.env/su);
});

test("governance documentation dependency audit gives npm a credential-free minimum environment", async () => {
  const credentialName = (...parts) => parts.join("_");
  const fixtureValue = (...parts) => parts.join("-");
  const source = {
    PATH: process.env.PATH ?? "path",
    [credentialName("GH", "TOKEN")]: fixtureValue("secret", "gh"),
    [credentialName("GITHUB", "TOKEN")]: fixtureValue("secret", "github"),
    [credentialName("NPM", "TOKEN")]: fixtureValue("secret", "npm"),
    [credentialName("NODE", "AUTH", "TOKEN")]: fixtureValue("secret", "node"),
    [credentialName("AWS", "SECRET", "ACCESS", "KEY")]: fixtureValue("secret", "cloud"),
    NODE_OPTIONS: "--require=untrusted.js",
  };
  const environment = auditChildEnvironment(source, "linux");
  assert.equal(environment.PATH, source.PATH);
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS"])
    assert.equal(Object.hasOwn(environment, key), false, key);
  assert.match(environment.npm_config_userconfig, /gpt-codex-hwp-disabled-user\.npmrc$/u);
  assert.match(environment.npm_config_globalconfig, /gpt-codex-hwp-disabled-global\.npmrc$/u);
  assert.equal(environment.npm_config_ignore_scripts, "true");

  let childOptions;
  const module = await import("../scripts/dependency-audit-issue.mjs");
  await module.runNpmAudit({ directory: "plugins/gpt-codex-hwp", omitDev: true }, {
    environment: source,
    runProcess: async (_command, _args, options) => {
      childOptions = options;
      return {
        code: 0,
        signal: null,
        stdout: Buffer.from('{"vulnerabilities":{}}'),
        stderr: Buffer.alloc(0),
        overflow: false,
        timedOut: false,
        terminationFailed: false,
      };
    },
  });
  assert.equal(childOptions.env.GH_TOKEN, undefined);
  assert.equal(childOptions.env.NPM_TOKEN, undefined);
  assert.equal(childOptions.env.NODE_OPTIONS, undefined);
});

test("governance documentation dependency issue contains only bounded safe columns", async () => {
  const record = advisoryRecord("esbuild", {
    name: "esbuild",
    nodes: ["node_modules/esbuild"],
    fixAvailable: { name: "indirect-parent", version: "9.9.9" },
    severity: "low",
    via: [{ range: ">=0.27.3 <0.28.1", url: "https://github.com/advisories/GHSA-test" }],
  }, { packages: { "node_modules/esbuild": { version: "0.27.3" } } });
  assert.deepEqual(record, {
    package: "esbuild",
    current: "0.27.3",
    patched: "owner review required",
    link: "https://github.com/advisories/GHSA-test",
  });
  const body = renderIssueBody([{
    ...record,
    [["sec", "ret"].join("")]: ["must", "not", "appear"].join("-"),
    severity: "low",
  }]);
  assert.equal(body, [
    "| Package | Current | Patched | Link |",
    "| --- | --- | --- | --- |",
    "| esbuild | 0.27.3 | owner review required | https://github.com/advisories/GHSA-test |",
  ].join("\n"));
  assert.doesNotMatch(body, /secret|severity|low/u);
  assert.throws(
    () => advisoryRecord("esbuild", {
      name: "esbuild",
      nodes: ["node_modules/esbuild"],
      fixAvailable: false,
      via: [{ url: "https://example.com/advisory)| injected" }],
    }, { packages: { "node_modules/esbuild": { version: "0.27.3" } } }),
    { code: "ADVISORY_LINK_INVALID" },
  );
  assert.throws(() => advisoryRecord("esbuild", {
    name: "other-package",
    nodes: ["node_modules/esbuild"],
    fixAvailable: false,
    via: [],
  }, { packages: { "node_modules/esbuild": { version: "0.27.3" } } }), {
    code: "ADVISORY_NAME_INVALID",
  });
  assert.throws(() => advisoryRecord("esbuild", {
    name: "esbuild",
    nodes: ["node_modules/missing"],
    fixAvailable: false,
    via: [],
  }, { packages: { "node_modules/esbuild": { version: "0.27.3" } } }), {
    code: "ADVISORY_NODE_INVALID",
  });
  assert.throws(() => renderIssueBody(Array(MAX_ADVISORY_RECORDS + 1).fill(record)), {
    code: "ADVISORY_RECORD_LIMIT",
  });
  const large = Array.from({ length: MAX_ADVISORY_RECORDS }, (_, index) => ({
    package: `package-${index}-${"x".repeat(180)}`,
    current: "1".repeat(240),
    patched: "2".repeat(240),
    link: `https://www.npmjs.com/package/package-${index}`,
  }));
  assert.throws(() => renderIssueBody(large), { code: "ISSUE_BODY_TOO_LARGE" });
});

test("governance documentation dependency audit bounds GitHub response bodies", async () => {
  await assert.rejects(
    readBoundedResponseJson(new Response(Buffer.alloc(MAX_GITHUB_RESPONSE_BYTES + 1, 0x20))),
    { code: "GITHUB_RESPONSE_TOO_LARGE" },
  );
  assert.deepEqual(await readBoundedResponseJson(new Response('[{"number":1}]')), [{ number: 1 }]);
});

test("governance documentation dependency issue lifecycle is marker-owned and paginated", async () => {
  const module = await import("../scripts/dependency-audit-issue.mjs");
  assert.equal(typeof module.reconcileDependencyIssue, "function");
  assert.equal(typeof module.ISSUE_MARKER, "string");
  const record = {
    package: "esbuild",
    current: "0.27.3",
    patched: "owner review required",
    link: "https://github.com/advisories/GHSA-test",
  };
  const harmless = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    title: `Other ${index}`,
    body: "other",
    user: { login: "person", type: "User" },
  }));
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? "GET", body: options.body });
    if (/[?&]page=1(?:&|$)/u.test(String(url))) return jsonResponse(harmless);
    if (/[?&]page=2(?:&|$)/u.test(String(url))) return jsonResponse([]);
    return jsonResponse({ number: 201 }, 201);
  };
  const result = await module.reconcileDependencyIssue({
    owner: "owner",
    repository: "repository",
    ...githubAuthorization(),
    records: [record],
    fetchImpl,
  });
  assert.deepEqual(result, { records: 1, issue: "created" });
  assert.match(requests[0].url, /state=all.*per_page=100.*page=1/u);
  assert.match(requests[1].url, /page=2/u);
  const created = JSON.parse(requests.at(-1).body);
  assert.equal(created.title, module.ISSUE_TITLE);
  assert.match(created.body, new RegExp(`^${escapeRegExp(module.ISSUE_MARKER)}\\n\\n\\| Package`, "u"));
});

test("governance documentation dependency issue ignores lookalikes while owning exact lifecycle", async () => {
  const module = await import("../scripts/dependency-audit-issue.mjs");
  const record = {
    package: "esbuild",
    current: "0.27.3",
    patched: "owner review required",
    link: "https://github.com/advisories/GHSA-test",
  };
  const owned = (number, extra = {}) => ({
    number,
    title: module.ISSUE_TITLE,
    body: `${module.ISSUE_MARKER}\n\nold`,
    state: "closed",
    user: { login: "github-actions[bot]", type: "Bot" },
    ...extra,
  });

  for (const [records, expectedIssue, expectedPatch] of [
    [[record], "updated", { state: "open" }],
    [[], "closed", { state: "closed" }],
  ]) {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method ?? "GET", body: options.body });
      return (options.method ?? "GET") === "GET"
        ? jsonResponse([owned(7, { state: records.length > 0 ? "closed" : "open" })])
        : jsonResponse({ number: 7 });
    };
    const result = await module.reconcileDependencyIssue({
      owner: "owner", repository: "repository", ...githubAuthorization(), records, fetchImpl,
    });
    assert.equal(result.issue, expectedIssue);
    assert.deepEqual({ state: JSON.parse(requests.at(-1).body).state }, expectedPatch);
    if (records.length > 0) assert.match(JSON.parse(requests.at(-1).body).body, /\| esbuild \|/u);
  }

  const lookalikes = [
    owned(20, { user: { login: "attacker", type: "User" } }),
    owned(21, { user: { login: "github-actions[bot]", type: "User" } }),
    owned(22, { body: "marker missing" }),
    owned(23, { title: "Different title" }),
    owned(24, { pull_request: { url: "https://example.invalid/pull/24" } }),
  ];
  for (const [issues, records, expectedIssue, expectedMethod, expectedNumber] of [
    [lookalikes, [record], "created", "POST", undefined],
    [[...lookalikes, owned(7)], [record], "updated", "PATCH", 7],
    [[...lookalikes, owned(7, { state: "open" })], [], "closed", "PATCH", 7],
    [lookalikes, [], "unchanged", undefined, undefined],
  ]) {
    const requests = [];
    const result = await module.reconcileDependencyIssue({
      owner: "owner",
      repository: "repository",
      ...githubAuthorization(),
      records,
      fetchImpl: async (url, options = {}) => {
        requests.push({ url: String(url), method: options.method ?? "GET" });
        return (options.method ?? "GET") === "GET" ? jsonResponse(issues) : jsonResponse({ number: 7 });
      },
    });
    assert.equal(result.issue, expectedIssue);
    const mutation = requests.find((request) => request.method !== "GET");
    assert.equal(mutation?.method, expectedMethod);
    if (expectedNumber !== undefined) assert.match(mutation.url, new RegExp(`/issues/${expectedNumber}$`, "u"));
  }

  let mutations = 0;
  await assert.rejects(module.reconcileDependencyIssue({
    owner: "owner",
    repository: "repository",
    ...githubAuthorization(),
    records: [record],
    fetchImpl: async (_url, options = {}) => {
      if ((options.method ?? "GET") !== "GET") mutations += 1;
      return jsonResponse([...lookalikes, owned(7), owned(8)]);
    },
  }), { code: "ISSUE_OWNERSHIP_INVALID" });
  assert.equal(mutations, 0);
});

test("governance documentation dependency issue pagination has a hard all-state ceiling", async () => {
  const module = await import("../scripts/dependency-audit-issue.mjs");
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    title: `Other ${index}`,
    body: "other",
    state: "open",
    user: { login: "person", type: "User" },
  }));
  let pages = 0;
  await assert.rejects(module.reconcileDependencyIssue({
    owner: "owner",
    repository: "repository",
    ...githubAuthorization(),
    records: [],
    fetchImpl: async () => { pages += 1; return jsonResponse(fullPage); },
  }), { code: "GITHUB_PAGINATION_LIMIT" });
  assert.equal(pages, 10);
});

test("governance documentation advisory records bind every exact scoped lock node", async () => {
  const module = await import("../scripts/dependency-audit-issue.mjs");
  assert.equal(typeof module.advisoryRecords, "function");
  const name = "@scope/pkg";
  const nodes = ["node_modules/@scope/pkg", "node_modules/parent/node_modules/@scope/pkg"];
  const lock = { packages: {
    [nodes[0]]: { version: "1.0.0" },
    [nodes[1]]: { version: "1.5.0" },
  } };
  const items = module.advisoryRecords(name, {
    name,
    nodes,
    fixAvailable: { name, version: "2.0.0" },
    via: ["transitive", { range: "<99.0.0", url: "https://github.com/advisories/GHSA-test" }],
  }, lock);
  assert.deepEqual(items.map((item) => item.record.current), ["1.0.0", "1.5.0"]);
  assert.deepEqual(items.map((item) => item.record.patched), ["2.0.0", "2.0.0"]);
  assert.deepEqual(items.map((item) => item.node), nodes);
  const sameVersionLock = { packages: {
    [nodes[0]]: { version: "1.0.0" },
    [nodes[1]]: { version: "1.0.0" },
  } };
  const deduplicated = module.advisoryRecords(name, {
    name, nodes, fixAvailable: { name, version: "2.0.0" }, via: [],
  }, sameVersionLock);
  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0].record.current, "1.0.0");
  for (const badNode of [
    "node_modules/other",
    "../node_modules/@scope/pkg",
    "vendor/node_modules/@scope/pkg",
    "node_modules/@scope/pkg/extra",
  ])
    assert.throws(() => module.advisoryRecords(name, {
      name, nodes: [badNode], fixAvailable: false, via: [],
    }, lock), { code: "ADVISORY_NODE_INVALID" });
  assert.throws(() => module.advisoryRecords(name, {
    name, nodes: [nodes[0], "node_modules/missing/node_modules/@scope/pkg"], fixAvailable: false, via: [],
  }, lock), { code: "ADVISORY_NODE_INVALID" });
  assert.throws(() => module.advisoryRecords(name, {
    name, nodes: [nodes[0], nodes[0]], fixAvailable: false, via: [],
  }, lock), { code: "ADVISORY_NODE_INVALID" });
  assert.throws(() => module.advisoryRecords(name, {
    name, nodes: [nodes[0]], fixAvailable: { name, version: "latest" }, via: [],
  }, lock), { code: "ADVISORY_PATCHED_INVALID" });
  assert.throws(() => module.advisoryRecords(name, {
    name, nodes: [nodes[0]], fixAvailable: false, via: [],
  }, { packages: { [nodes[0]]: { version: "workspace:*" } } }), {
    code: "ADVISORY_CURRENT_INVALID",
  });
});

test("governance documentation audit uses shared bounded process receipts authoritatively", async () => {
  const module = await import("../scripts/dependency-audit-issue.mjs");
  assert.equal(typeof module.runNpmAudit, "function");
  const base = {
    code: 0,
    signal: null,
    stdout: Buffer.from('{"vulnerabilities":{}}'),
    stderr: Buffer.alloc(0),
    overflow: false,
    timedOut: false,
    terminationFailed: false,
  };
  for (const [override, code] of [
    [{ terminationFailed: true }, "AUDIT_TERMINATION_FAILED"],
    [{ timedOut: true, code: -1 }, "AUDIT_TIMEOUT"],
    [{ overflow: true, code: -1 }, "AUDIT_RESULT_TOO_LARGE"],
  ]) await assert.rejects(module.runNpmAudit(
    { directory: "plugins/gpt-codex-hwp", omitDev: true },
    { environment: { PATH: process.env.PATH ?? "path" }, runProcess: async () => ({ ...base, ...override }) },
  ), { code });
});

test("governance documentation lock read is bounded and rejects an open-time swap", async (t) => {
  const module = await import("../scripts/dependency-audit-issue.mjs");
  assert.equal(typeof module.readAuditLock, "function");
  const root = await createCanonicalTemporaryDirectory({ prefix: "governance-lock-" });
  t.after(async () => rm(root, { recursive: true, force: true }));
  const directory = join(root, "packages", "gpt-codex-hwp");
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, "package-lock.json");
  const replacement = join(directory, "replacement.json");
  await writeFile(lockPath, '{"packages":{}}');
  await writeFile(replacement, '{"packages":{"changed":{}}}');
  await assert.rejects(module.readAuditLock(root, { directory: "packages/gpt-codex-hwp" }, {
    readOptions: { beforeOpen: async () => rename(replacement, lockPath) },
  }), { code: "LOCKFILE_CHANGED" });
  await writeFile(lockPath, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(module.readAuditLock(root, { directory: "packages/gpt-codex-hwp" }), {
    code: "LOCKFILE_TOO_LARGE",
  });
});

test("governance lock fixtures canonicalize an injected aliased temp parent", async (t) => {
  const module = await import("../scripts/dependency-audit-issue.mjs");
  const alias = await temporaryDirectoryAlias(t, "governance-canonical-parent-");
  if (alias === undefined) return;
  const root = await createCanonicalTemporaryDirectory({
    parent: alias.path,
    prefix: "governance-lock-",
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  assert.equal(dirname(root), alias.canonicalParent);
  const directory = join(root, "packages", "gpt-codex-hwp");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package-lock.json"), '{"packages":{}}');
  assert.deepEqual(
    await module.readAuditLock(root, { directory: "packages/gpt-codex-hwp" }),
    { packages: {} },
  );
});

test("governance documentation keeps contributor-only material out of generated runtime", async () => {
  const projection = await text("scripts/project-runtime.mjs");
  for (const forbidden of ["CONTRIBUTING.md", "docs/ARCHITECTURE.md", "docs/DEVELOPMENT.md", "docs/PERFORMANCE.md"])
    assert.equal(projection.includes(forbidden), false, forbidden);
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function githubAuthorization() {
  return { [["to", "ken"].join("")]: ["test", "authorization", "fixture"].join("-") };
}

async function temporaryDirectoryAlias(t, prefix) {
  const base = await createCanonicalTemporaryDirectory({ prefix });
  const canonicalParent = join(base, "canonical");
  const path = join(base, "alias");
  await mkdir(canonicalParent);
  try {
    await symlink(canonicalParent, path, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) {
      t.skip(`directory aliases are unavailable (${error.code})`);
      return undefined;
    }
    throw error;
  }
  t.after(async () => rm(base, { recursive: true, force: true }));
  return { canonicalParent: await realpath(canonicalParent), path };
}
