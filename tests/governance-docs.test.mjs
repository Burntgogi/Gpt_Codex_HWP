import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_ADVISORY_RECORDS,
  MAX_GITHUB_RESPONSE_BYTES,
  advisoryRecord,
  auditChildEnvironment,
  collectAudit,
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
  assert.match(workflow, /package.{0,80}current.{0,80}patched.{0,80}link/isu);
  assert.doesNotMatch(workflow, /\b(console\.log|Write-Output|echo)\b/u);
  for (const reference of [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)].map((match) => match[1])) {
    assert.match(reference, /^[a-f0-9]{40}$/u);
  }
  await assert.rejects(access(join(ROOT, ".github", "dependabot.yml")), { code: "ENOENT" });
});

test("governance documentation dependency audit bounds secrets, processes, and issue data", async () => {
  const implementation = await text("scripts/dependency-audit-issue.mjs");
  assert.match(implementation, /env:\s*auditChildEnvironment\(/u);
  assert.match(implementation, /terminateProcessTree/u);
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
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.unref = () => {};
  const pending = collectAudit("npm", ["audit"], {
    environment: source,
    spawnProcess: (_command, _args, options) => {
      childOptions = options;
      setImmediate(() => child.emit("close", 0));
      return child;
    },
    timeoutMs: 100,
  });
  await pending;
  assert.equal(childOptions.env.GH_TOKEN, undefined);
  assert.equal(childOptions.env.NPM_TOKEN, undefined);
  assert.equal(childOptions.env.NODE_OPTIONS, undefined);
});

test("governance documentation dependency audit times out through process-tree cleanup", async () => {
  const child = new EventEmitter();
  child.pid = 42;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  let unrefed = false;
  child.kill = () => { killed = true; return true; };
  child.unref = () => { unrefed = true; };
  let terminations = 0;
  await assert.rejects(
    collectAudit("npm", ["audit"], {
      environment: {
        PATH: process.env.PATH ?? "path",
        [["GH", "TOKEN"].join("_")]: ["must", "not", "leak"].join("-"),
      },
      spawnProcess: () => child,
      terminateTree: async () => { terminations += 1; return true; },
      timeoutMs: 5,
      terminationTimeoutMs: 10,
    }),
    { code: "AUDIT_TIMEOUT" },
  );
  assert.equal(terminations, 1);
  assert.equal(killed, true);
  assert.equal(unrefed, true);
});

test("governance documentation dependency issue contains only bounded safe columns", async () => {
  const record = advisoryRecord("esbuild", {
    nodes: ["node_modules/esbuild"],
    fixAvailable: true,
    severity: "low",
    via: [{ range: ">=0.27.3 <0.28.1", url: "https://github.com/advisories/GHSA-test" }],
  }, { packages: { "node_modules/esbuild": { version: "0.27.3" } } });
  assert.deepEqual(record, {
    package: "esbuild",
    current: "0.27.3",
    patched: "0.28.1",
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
    "| esbuild | 0.27.3 | 0.28.1 | https://github.com/advisories/GHSA-test |",
  ].join("\n"));
  assert.doesNotMatch(body, /secret|severity|low/u);
  assert.throws(
    () => advisoryRecord("esbuild", {
      nodes: ["node_modules/esbuild"],
      fixAvailable: false,
      via: [{ url: "https://example.com/advisory)| injected" }],
    }, { packages: { "node_modules/esbuild": { version: "0.27.3" } } }),
    { code: "ADVISORY_LINK_INVALID" },
  );
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

test("governance documentation keeps contributor-only material out of generated runtime", async () => {
  const projection = await text("scripts/project-runtime.mjs");
  for (const forbidden of ["CONTRIBUTING.md", "docs/ARCHITECTURE.md", "docs/DEVELOPMENT.md", "docs/PERFORMANCE.md"])
    assert.equal(projection.includes(forbidden), false, forbidden);
});
