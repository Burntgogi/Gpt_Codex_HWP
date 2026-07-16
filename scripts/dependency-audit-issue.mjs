import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertBoundaryRootUnchanged,
  createOwnedBoundary,
  readOwnedRegularFile,
  runBoundedProcess,
} from "./public-content-policy.mjs";

export const ISSUE_TITLE = "Dependency advisory review";
export const ISSUE_MARKER = "<!-- gpt-codex-hwp:dependency-advisory:v1 -->";
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
const MAX_ISSUE_PAGES = 10;
const ISSUES_PER_PAGE = 100;
const GITHUB_TIMEOUT_MS = 30_000;

export async function runDependencyAuditIssue({
  environment = process.env,
  fetchImpl = fetch,
  root = process.cwd(),
  runProcess = runBoundedProcess,
} = {}) {
  const [owner, repository] = requiredRepository(environment.GH_REPOSITORY);
  const token = requiredToken(environment.GH_TOKEN);
  const boundary = await createOwnedBoundary(root).catch(() => { throw auditError("LOCKFILE_INVALID"); });
  const records = new Map();
  for (const target of TARGETS) {
    const lock = await readAuditLockFromBoundary(boundary, target);
    const report = await runNpmAudit(target, { environment, runProcess, cwd: boundary.root });
    const vulnerabilities = report?.vulnerabilities;
    if (vulnerabilities === null || typeof vulnerabilities !== "object" || Array.isArray(vulnerabilities))
      throw auditError("AUDIT_RESULT_INVALID");
    for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
      for (const item of advisoryRecords(name, vulnerability, lock)) {
        const { package: packageName, current, patched, link } = item.record;
        records.set(`${packageName}\0${current}\0${patched}\0${link}`, item.record);
        if (records.size > MAX_ADVISORY_RECORDS) throw auditError("ADVISORY_RECORD_LIMIT");
      }
    }
    await assertBoundaryRootUnchanged(boundary).catch(() => { throw auditError("LOCKFILE_CHANGED"); });
  }
  await assertBoundaryRootUnchanged(boundary).catch(() => { throw auditError("LOCKFILE_CHANGED"); });
  return reconcileDependencyIssue({
    owner,
    repository,
    token,
    records: [...records.values()],
    fetchImpl,
  });
}

export async function readAuditLock(root, target, { readOptions = {} } = {}) {
  const boundary = await createOwnedBoundary(root).catch(() => { throw auditError("LOCKFILE_INVALID"); });
  return readAuditLockFromBoundary(boundary, target, readOptions);
}

async function readAuditLockFromBoundary(boundary, target, readOptions = {}) {
  const directory = target?.directory;
  if (!TARGETS.some((candidate) => candidate.directory === directory)) throw auditError("LOCKFILE_INVALID");
  const label = `${directory}/package-lock.json`;
  let bytes;
  try {
    ({ bytes } = await readOwnedRegularFile(
      boundary,
      join(boundary.root, ...label.split("/")),
      label,
      MAX_LOCK_BYTES,
      readOptions,
    ));
  } catch (error) {
    if (error?.code === "PUBLIC_FILE_TOO_LARGE") throw auditError("LOCKFILE_TOO_LARGE");
    if (error?.code === "PUBLIC_FILE_CHANGED") throw auditError("LOCKFILE_CHANGED");
    throw auditError("LOCKFILE_INVALID");
  }
  try {
    const lock = JSON.parse(bytes.toString("utf8"));
    if (lock === null || typeof lock !== "object" || Array.isArray(lock)
      || lock.packages === null || typeof lock.packages !== "object" || Array.isArray(lock.packages)) throw new Error();
    return lock;
  } catch {
    throw auditError("LOCKFILE_INVALID");
  }
}

export async function runNpmAudit({ directory, omitDev }, dependencies = {}) {
  if (!TARGETS.some((candidate) => candidate.directory === directory && candidate.omitDev === omitDev))
    throw auditError("AUDIT_TARGET_INVALID");
  const invocation = npmInvocation();
  const args = [...invocation.prefixArgs, "audit", "--json", "--prefix", directory];
  if (omitDev) args.push("--omit=dev");
  const runProcess = dependencies.runProcess ?? runBoundedProcess;
  let result;
  try {
    result = await runProcess(invocation.executable, args, {
      cwd: dependencies.cwd,
      env: auditChildEnvironment(dependencies.environment ?? process.env),
      maxOutputBytes: MAX_AUDIT_BYTES,
      timeoutMs: AUDIT_TIMEOUT_MS,
    });
  } catch {
    throw auditError("AUDIT_COMMAND_FAILED");
  }
  assertAuditReceipt(result);
  if (result.terminationFailed) throw auditError("AUDIT_TERMINATION_FAILED");
  if (result.timedOut) throw auditError("AUDIT_TIMEOUT");
  if (result.overflow) throw auditError("AUDIT_RESULT_TOO_LARGE");
  if (![0, 1].includes(result.code) || result.stderr.length !== 0) throw auditError("AUDIT_COMMAND_FAILED");
  try {
    const report = JSON.parse(result.stdout.toString("utf8"));
    if (report === null || typeof report !== "object" || Array.isArray(report)) throw new Error();
    return report;
  } catch {
    throw auditError("AUDIT_RESULT_INVALID");
  }
}

function assertAuditReceipt(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)
    || !Number.isInteger(result.code) || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)
    || typeof result.overflow !== "boolean" || typeof result.timedOut !== "boolean"
    || typeof result.terminationFailed !== "boolean" || result.stdout.length > MAX_AUDIT_BYTES)
    throw auditError("AUDIT_COMMAND_FAILED");
}

function npmInvocation() {
  if (process.platform !== "win32") return Object.freeze({ executable: "npm", prefixArgs: Object.freeze([]) });
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return Object.freeze({ executable: process.execPath, prefixArgs: Object.freeze([npmCli]) });
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

export function advisoryRecords(name, vulnerability, lock) {
  const packageName = packageIdentity(name);
  if (vulnerability === null || typeof vulnerability !== "object" || Array.isArray(vulnerability))
    throw auditError("ADVISORY_RECORD_INVALID");
  if (vulnerability.name !== packageName) throw auditError("ADVISORY_NAME_INVALID");
  if (!Array.isArray(vulnerability.nodes) || vulnerability.nodes.length === 0
    || vulnerability.nodes.length > MAX_ADVISORY_RECORDS) throw auditError("ADVISORY_NODE_INVALID");
  if (lock?.packages === null || typeof lock?.packages !== "object" || Array.isArray(lock.packages))
    throw auditError("ADVISORY_NODE_INVALID");
  const patched = patchedVersion(packageName, vulnerability.fixAvailable);
  const rawLink = (Array.isArray(vulnerability.via) ? vulnerability.via : [])
    .find((value) => value && typeof value === "object" && typeof value.url === "string")?.url
    ?? `https://www.npmjs.com/package/${encodeURIComponent(packageName)}`;
  const link = advisoryUrl(rawLink);
  const seen = new Set();
  const validated = vulnerability.nodes.map((node) => {
    const exactNode = exactLockNode(packageName, node);
    if (seen.has(exactNode) || !Object.hasOwn(lock.packages, exactNode)) throw auditError("ADVISORY_NODE_INVALID");
    seen.add(exactNode);
    const entry = lock.packages[exactNode];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry.version !== "string")
      throw auditError("ADVISORY_NODE_INVALID");
    const record = Object.freeze({
      package: packageName,
      current: packageVersion(entry.version, "CURRENT"),
      patched,
      link,
    });
    return Object.freeze({ node: exactNode, record });
  });
  const displayed = new Map();
  for (const item of validated) {
    const { package: displayedPackage, current, patched: displayedPatched, link: displayedLink } = item.record;
    const key = `${displayedPackage}\0${current}\0${displayedPatched}\0${displayedLink}`;
    if (!displayed.has(key)) displayed.set(key, item);
  }
  return Object.freeze([...displayed.values()]);
}

export function advisoryRecord(name, vulnerability, lock) {
  const records = advisoryRecords(name, vulnerability, lock);
  if (records.length !== 1) throw auditError("ADVISORY_NODE_INVALID");
  return records[0].record;
}

function exactLockNode(name, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value.includes("\\") || value.startsWith("/") || /[\r\n\0]/u.test(value))
    throw auditError("ADVISORY_NODE_INVALID");
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw auditError("ADVISORY_NODE_INVALID");
  const suffix = `node_modules/${name}`;
  if (!value.startsWith("node_modules/") || (value !== suffix && !value.endsWith(`/${suffix}`)))
    throw auditError("ADVISORY_NODE_INVALID");
  return value;
}

function patchedVersion(name, fixAvailable) {
  if (fixAvailable !== null && typeof fixAvailable === "object" && !Array.isArray(fixAvailable)) {
    if (fixAvailable.name !== name) return "owner review required";
    return packageVersion(fixAvailable.version, "PATCHED");
  }
  return "owner review required";
}

export function renderIssueBody(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_ADVISORY_RECORDS)
    throw auditError("ADVISORY_RECORD_LIMIT");
  const ordered = [...records].sort((left, right) =>
    left.package.localeCompare(right.package, "en") || left.current.localeCompare(right.current, "en")
      || left.patched.localeCompare(right.patched, "en") || left.link.localeCompare(right.link, "en"));
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

export async function reconcileDependencyIssue({ owner, repository, token, records, fetchImpl = fetch }) {
  const safeOwner = repositoryIdentity(owner);
  const safeRepository = repositoryIdentity(repository);
  requiredToken(token);
  if (!Array.isArray(records) || records.length > MAX_ADVISORY_RECORDS) throw auditError("ADVISORY_RECORD_LIMIT");
  const candidate = await findOwnedIssue(safeOwner, safeRepository, token, fetchImpl);
  if (records.length === 0) {
    if (candidate === undefined) return Object.freeze({ records: 0, issue: "unchanged" });
    if (candidate.state === "closed") return Object.freeze({ records: 0, issue: "unchanged" });
    await github(safeOwner, safeRepository, token, `/issues/${candidate.number}`, {
      method: "PATCH", body: { state: "closed" }, fetchImpl,
    });
    return Object.freeze({ records: 0, issue: "closed" });
  }

  const body = `${ISSUE_MARKER}\n\n${renderIssueBody(records)}`;
  if (Buffer.byteLength(body, "utf8") > MAX_ISSUE_BODY_BYTES) throw auditError("ISSUE_BODY_TOO_LARGE");
  if (candidate === undefined) {
    await github(safeOwner, safeRepository, token, "/issues", {
      method: "POST", body: { title: ISSUE_TITLE, body }, fetchImpl,
    });
    return Object.freeze({ records: records.length, issue: "created" });
  }
  await github(safeOwner, safeRepository, token, `/issues/${candidate.number}`, {
    method: "PATCH", body: { state: "open", body }, fetchImpl,
  });
  return Object.freeze({ records: records.length, issue: "updated" });
}

async function findOwnedIssue(owner, repository, token, fetchImpl) {
  const candidates = [];
  for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
    const issues = await github(
      owner,
      repository,
      token,
      `/issues?state=all&per_page=${ISSUES_PER_PAGE}&page=${page}`,
      { fetchImpl },
    );
    if (!Array.isArray(issues) || issues.length > ISSUES_PER_PAGE) throw auditError("GITHUB_RESPONSE_INVALID");
    for (const issue of issues) {
      const owned = issue?.title === ISSUE_TITLE
        && hasExactIssueMarker(issue?.body)
        && issue?.pull_request === undefined
        && issue?.user?.login === "github-actions[bot]"
        && issue?.user?.type === "Bot";
      if (!owned) continue;
      if (!Number.isSafeInteger(issue?.number) || issue.number <= 0
        || !["open", "closed"].includes(issue?.state)) throw auditError("ISSUE_OWNERSHIP_INVALID");
      candidates.push(Object.freeze({ number: issue.number, state: issue.state }));
      if (candidates.length > 1) throw auditError("ISSUE_OWNERSHIP_INVALID");
    }
    if (issues.length < ISSUES_PER_PAGE) return candidates[0];
  }
  throw auditError("GITHUB_PAGINATION_LIMIT");
}

function hasExactIssueMarker(body) {
  return typeof body === "string" && (body === ISSUE_MARKER || body.startsWith(`${ISSUE_MARKER}\n\n`));
}

async function github(owner, repository, token, route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(`https://api.github.com/repos/${owner}/${repository}${route}`, {
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
  if (!response?.ok) throw auditError("GITHUB_REQUEST_FAILED");
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

function packageVersion(value, field) {
  const exact = versionField(value, field);
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(exact))
    throw auditError(`ADVISORY_${field}_INVALID`);
  return exact;
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

function repositoryIdentity(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(value)) throw auditError("GITHUB_REPOSITORY_INVALID");
  return value;
}

function requiredToken(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 512 || /[\r\n]/u.test(value))
    throw auditError("GITHUB_TOKEN_INVALID");
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
