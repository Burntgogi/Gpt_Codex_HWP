import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { terminateProcessTree } from "./release-verify.mjs";

const TITLE = "Dependency advisory review";
const TARGETS = Object.freeze([
  Object.freeze({ directory: "packages/gpt-codex-hwp", omitDev: false }),
  Object.freeze({ directory: "plugins/gpt-codex-hwp", omitDev: true }),
]);
export const AUDIT_TIMEOUT_MS = 2 * 60 * 1_000;
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
export const MAX_ADVISORY_RECORDS = 128;
export const MAX_ISSUE_BODY_BYTES = 60 * 1024;
export const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const GITHUB_TIMEOUT_MS = 30_000;
const TERMINATION_TIMEOUT_MS = 5_000;

export async function runDependencyAuditIssue({ environment = process.env } = {}) {
  const [owner, repository] = requiredRepository(environment.GH_REPOSITORY);
  const token = requiredToken(environment.GH_TOKEN);
  const records = new Map();
  for (const target of TARGETS) {
    const lock = await readBoundedJson(join(target.directory, "package-lock.json"), MAX_LOCK_BYTES, "LOCKFILE");
    const report = await npmAudit(target, { environment });
    const vulnerabilities = report?.vulnerabilities;
    if (vulnerabilities === null || typeof vulnerabilities !== "object" || Array.isArray(vulnerabilities))
      throw auditError("AUDIT_RESULT_INVALID");
    for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
      const record = advisoryRecord(name, vulnerability, lock);
      records.set(`${record.package}\0${record.current}\0${record.patched}\0${record.link}`, record);
      if (records.size > MAX_ADVISORY_RECORDS) throw auditError("ADVISORY_RECORD_LIMIT");
    }
  }
  if (records.size === 0) return Object.freeze({ records: 0, issue: "unchanged" });

  const body = renderIssueBody([...records.values()]);
  const existing = await github(owner, repository, token, "/issues?state=open&per_page=100");
  if (!Array.isArray(existing)) throw auditError("GITHUB_RESPONSE_INVALID");
  const issue = existing.find((candidate) => candidate?.title === TITLE && !candidate?.pull_request);
  if (issue !== undefined) {
    if (!Number.isSafeInteger(issue?.number) || issue.number <= 0) throw auditError("GITHUB_RESPONSE_INVALID");
    await github(owner, repository, token, `/issues/${issue.number}`, { method: "PATCH", body: { body } });
    return Object.freeze({ records: records.size, issue: "updated" });
  }
  await github(owner, repository, token, "/issues", { method: "POST", body: { title: TITLE, body } });
  return Object.freeze({ records: records.size, issue: "created" });
}

export function auditChildEnvironment(source = process.env, platform = process.platform) {
  if (source === null || typeof source !== "object" || Array.isArray(source))
    throw auditError("AUDIT_ENVIRONMENT_INVALID");
  const child = {};
  const allowed = platform === "win32"
    ? ["Path", "PATH", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR", "TEMP", "TMP"]
    : ["PATH", "TMPDIR", "TEMP", "TMP"];
  for (const name of allowed) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0 && value.length <= 32_768 && !value.includes("\0"))
      child[name] = value;
  }
  return Object.freeze({
    ...child,
    npm_config_audit: "true",
    npm_config_cache: join(tmpdir(), "gpt-codex-hwp-dependency-audit-cache"),
    npm_config_fund: "false",
    npm_config_globalconfig: join(tmpdir(), "gpt-codex-hwp-disabled-global.npmrc"),
    npm_config_ignore_scripts: "true",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_update_notifier: "false",
    npm_config_userconfig: join(tmpdir(), "gpt-codex-hwp-disabled-user.npmrc"),
  });
}

export function advisoryRecord(name, vulnerability, lock) {
  const packageName = packageIdentity(name);
  if (vulnerability === null || typeof vulnerability !== "object" || Array.isArray(vulnerability))
    throw auditError("ADVISORY_RECORD_INVALID");
  const current = installedVersions(packageName, vulnerability.nodes, lock);
  const patched = patchedVersion(vulnerability);
  const rawLink = (Array.isArray(vulnerability.via) ? vulnerability.via : [])
    .find((value) => value && typeof value === "object" && typeof value.url === "string")?.url
    ?? `https://www.npmjs.com/package/${encodeURIComponent(packageName)}`;
  return Object.freeze({ package: packageName, current, patched, link: advisoryUrl(rawLink) });
}

export function renderIssueBody(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_ADVISORY_RECORDS)
    throw auditError("ADVISORY_RECORD_LIMIT");
  const ordered = [...records].sort((left, right) =>
    left.package.localeCompare(right.package, "en") || left.current.localeCompare(right.current, "en"));
  const body = [
    "| Package | Current | Patched | Link |",
    "| --- | --- | --- | --- |",
    ...ordered.map((record) => {
      if (record === null || typeof record !== "object" || Array.isArray(record))
        throw auditError("ADVISORY_RECORD_INVALID");
      return `| ${cell(packageIdentity(record.package))} | ${cell(versionField(record.current, "CURRENT"))} | ${cell(versionField(record.patched, "PATCHED"))} | ${cell(advisoryUrl(record.link))} |`;
    }),
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_ISSUE_BODY_BYTES) throw auditError("ISSUE_BODY_TOO_LARGE");
  return body;
}

async function npmAudit({ directory, omitDev }, dependencies = {}) {
  const invocation = npmInvocation();
  const executable = invocation.executable;
  const args = [...invocation.prefixArgs, "audit", "--json", "--prefix", directory];
  if (omitDev) args.push("--omit=dev");
  const result = await collectAudit(executable, args, dependencies);
  if (![0, 1].includes(result.code)) throw auditError("AUDIT_COMMAND_FAILED");
  try {
    const report = JSON.parse(result.stdout);
    if (report === null || typeof report !== "object" || Array.isArray(report)) throw new Error();
    return report;
  } catch {
    throw auditError("AUDIT_RESULT_INVALID");
  }
}

function npmInvocation() {
  if (process.platform !== "win32") return Object.freeze({ executable: "npm", prefixArgs: Object.freeze([]) });
  const npmCli = typeof process.env.npm_execpath === "string" && process.env.npm_execpath.endsWith("npm-cli.js")
    ? resolve(process.env.npm_execpath)
    : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return Object.freeze({ executable: process.execPath, prefixArgs: Object.freeze([npmCli]) });
}

export function collectAudit(executable, args, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const terminateTree = dependencies.terminateTree ?? terminateProcessTree;
  const environment = auditChildEnvironment(dependencies.environment ?? process.env);
  const timeoutMs = positiveInteger(dependencies.timeoutMs ?? AUDIT_TIMEOUT_MS, "AUDIT_TIMEOUT_INVALID");
  const terminationTimeoutMs = positiveInteger(
    dependencies.terminationTimeoutMs ?? TERMINATION_TIMEOUT_MS,
    "AUDIT_TIMEOUT_INVALID",
  );
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnProcess(executable, args, {
        detached: process.platform !== "win32",
        env: auditChildEnvironment(dependencies.environment ?? process.env),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      rejectPromise(auditError("AUDIT_COMMAND_FAILED"));
      return;
    }
    if (child === null || typeof child !== "object" || typeof child.once !== "function"
      || child.stdout === null || typeof child.stdout?.on !== "function") {
      rejectPromise(auditError("AUDIT_COMMAND_FAILED"));
      return;
    }

    const chunks = [];
    let length = 0;
    let settled = false;
    let stopping = false;
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const stop = async (code) => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timer);
      const termination = Promise.resolve(terminateTree(child, {
        spawnProcess: (command, commandArgs, options) => spawnProcess(command, commandArgs, { ...options, env: environment }),
      })).catch(() => false);
      await Promise.race([termination, delay(terminationTimeoutMs, false)]);
      try { child.stdout?.destroy?.(); } catch { /* redacted cleanup */ }
      try { child.stderr?.destroy?.(); } catch { /* redacted cleanup */ }
      try { child.kill?.("SIGKILL"); } catch { /* redacted cleanup */ }
      try { child.unref?.(); } catch { /* redacted cleanup */ }
      finish(undefined, auditError(code));
    };

    child.stdout.on("data", (chunk) => {
      if (settled || stopping) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_AUDIT_BYTES) {
        void stop("AUDIT_RESULT_TOO_LARGE");
        return;
      }
      chunks.push(bytes);
    });
    child.once("error", () => { void stop("AUDIT_COMMAND_FAILED"); });
    child.once("close", (code) => {
      if (stopping) return;
      finish({ code, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    const timer = setTimeout(() => { void stop("AUDIT_TIMEOUT"); }, timeoutMs);
  });
}

async function github(owner, repository, token, route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repository}${route}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw auditError("GITHUB_REQUEST_FAILED");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw auditError("GITHUB_REQUEST_FAILED");
  return response.status === 204 ? undefined : readBoundedResponseJson(response);
}

export async function readBoundedResponseJson(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw auditError("GITHUB_RESPONSE_INVALID");
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_GITHUB_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw auditError("GITHUB_RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw auditError("GITHUB_RESPONSE_INVALID");
  }
}

async function readBoundedJson(path, limit, prefix) {
  const bytes = await readFile(path);
  if (bytes.length > limit) throw auditError(`${prefix}_TOO_LARGE`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw auditError(`${prefix}_INVALID`);
  }
}

function installedVersions(name, nodes, lock) {
  if (!Array.isArray(nodes) || lock?.packages === null || typeof lock?.packages !== "object")
    throw auditError("ADVISORY_CURRENT_INVALID");
  const versions = new Set();
  for (const node of nodes) {
    if (typeof node !== "string" || node.length === 0 || node.length > 512 || /[\r\n]/u.test(node))
      throw auditError("ADVISORY_CURRENT_INVALID");
    const version = lock.packages[node]?.version;
    if (typeof version === "string") versions.add(versionField(version, "CURRENT"));
  }
  if (versions.size === 0) {
    for (const [path, value] of Object.entries(lock.packages)) {
      if ((path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) && typeof value?.version === "string")
        versions.add(versionField(value.version, "CURRENT"));
    }
  }
  if (versions.size === 0) throw auditError("ADVISORY_CURRENT_INVALID");
  return versionField([...versions].sort().join(", "), "CURRENT");
}

function patchedVersion(vulnerability) {
  if (typeof vulnerability.fixAvailable === "object" && vulnerability.fixAvailable?.version)
    return versionField(vulnerability.fixAvailable.version, "PATCHED");
  const thresholds = (Array.isArray(vulnerability.via) ? vulnerability.via : [])
    .flatMap((value) => value && typeof value === "object" && typeof value.range === "string"
      ? [...value.range.matchAll(/(?:^|\s)<(?![=])\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu)].map((match) => match[1])
      : []);
  if (thresholds.length > 0) return versionField(thresholds.sort().at(-1), "PATCHED");
  return versionField(vulnerability.fixAvailable === false ? "not available" : "owner review required", "PATCHED");
}

function packageIdentity(value) {
  if (typeof value !== "string" || value.length > 214
    || !/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value))
    throw auditError("ADVISORY_PACKAGE_INVALID");
  return value;
}

function versionField(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || /[\r\n|<>\[\]()`]/u.test(value)) throw auditError(`ADVISORY_${field}_INVALID`);
  return value;
}

function advisoryUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\r\n]/u.test(value))
    throw auditError("ADVISORY_LINK_INVALID");
  let url;
  try { url = new URL(value); } catch { throw auditError("ADVISORY_LINK_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !new Set(["github.com", "www.npmjs.com", "npmjs.com"]).has(url.hostname.toLowerCase()))
    throw auditError("ADVISORY_LINK_INVALID");
  return url.href.replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("|", "%7C");
}

function cell(value) {
  return value.replaceAll("&", "&amp;").replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function requiredRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value))
    throw auditError("GITHUB_REPOSITORY_INVALID");
  return value.split("/");
}

function requiredToken(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 512 || /[\r\n]/u.test(value))
    throw auditError("GITHUB_TOKEN_INVALID");
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw auditError(code);
  return value;
}

function auditError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runDependencyAuditIssue().catch(() => {
    process.stderr.write("dependency audit workflow failed\n");
    process.exitCode = 1;
  });
}
