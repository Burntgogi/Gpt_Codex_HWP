import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_GIT_LIST_BYTES = 16 * 1024 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_EXTENSIONS = new Set([
  "", ".cjs", ".cts", ".css", ".csv", ".html", ".js", ".json", ".md",
  ".map", ".mjs", ".mts", ".ps1", ".py", ".svg", ".ts", ".txt", ".xml", ".yaml", ".yml",
]);
const BINARY_EXTENSIONS = new Set([
  ".bmp", ".gif", ".hwp", ".ico", ".jpeg", ".jpg", ".otf", ".png", ".tif",
  ".tiff", ".ttf", ".webp", ".woff", ".woff2", ".zip", ".gz", ".tgz",
]);
const PLACEHOLDER_USERS = new Set([
  "example", "placeholder", "sample", "user", "username", "your-user", "your_username",
]);
const SAFE_SOURCE_FIXTURE_VALUE_HASHES = new Set([
  "c47dd0aa48728b8bf81f1b3dfb61171c3b18a551fc41c41a314b72486eaf9a73",
  "b66c6b70e304d65127b6c0dd30df241535a3556186bd295c6362a4f46da0d43e",
  "0c9fbc892e3831e50109728b2d3b547b8626cd11f1621eeaadb6443f6a51c31e",
]);
const OWNER_EMAIL = "224273819+Burntgogi@users.noreply.github.com";

export const PUBLIC_BINARY_ALLOWLIST = Object.freeze([
  binaryRecord("gpt-codex-hwp-banner.png", 1_659_083, "2a17366c5d9d164c5b7c837fad1e13182f9414ff1363bf1a0e5ab9ec88bfabfd"),
  binaryRecord("gpt-codex-hwp-icon.png", 331_169, "2928286646749c5d7272c3d25c981231bb31d6a4d6c2cb9cdc03d29e14898892"),
  binaryRecord("gpt-codex-hwp-icon-128.png", 29_837, "e13ec563c49723aa5b78a755e9097bff28173b4c4214ca3c9e9dd886d0311812"),
  binaryRecord("gpt-codex-hwp-icon-64.png", 9_053, "f3642b4ef5f6985ff3fa96f454d86f50ed745923ba31a51a1f73e92ddbbcd166"),
  binaryRecord("re-01-hangul-only-hancom.hwp", 8_704, "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd"),
]);

export const PUBLIC_CONTENT_LIMITS = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  maxAggregateBytes: MAX_AGGREGATE_BYTES,
  maxEntries: MAX_ENTRIES,
});

const REMEDIATIONS = Object.freeze({
  "absolute source map path": "Remove absolute sources or omit the source map.",
  "aggregate byte budget": "Reduce the scanned public input set.",
  "binary not allowlisted": "Remove the binary or approve its exact size and SHA-256.",
  "cloud credential": "Revoke the credential and remove it from every public object.",
  "credential filename": "Remove the credential file and publish only a safe example template.",
  "file byte budget": "Reduce or remove the oversized public file.",
  "literal credential": "Use an environment reference or a clearly redacted placeholder.",
  "non-regular file": "Replace the entry with a regular public file.",
  "personal home path": "Replace the personal path with a platform-neutral placeholder.",
  "private key": "Revoke the key and remove it from every public object.",
  "provider credential": "Revoke the credential and remove it from every public object.",
  "source map": "Remove the source map from the public runtime.",
  "symbolic link": "Replace the link with an explicitly tracked regular file.",
  "unsupported text encoding": "Publish UTF-8 text or an exactly allowlisted binary.",
});

export function assertPublicContentBuffer(input, options = {}) {
  const bytes = asBuffer(input);
  const label = requiredLabel(options.label);
  const findings = classifyPublicContent(bytes, {
    label,
    binaryAllowlist: options.binaryAllowlist ?? PUBLIC_BINARY_ALLOWLIST,
    scope: options.scope,
  });
  if (findings.length > 0) throw publicScanError(findings);
  return Object.freeze({ bytes: bytes.length, findings: Object.freeze([]) });
}

export function classifyPublicContent(input, options = {}) {
  const bytes = asBuffer(input);
  const label = requiredLabel(options.label);
  const scope = normalizeScope(options.scope);
  const extension = extname(label).toLowerCase();
  const filenameFinding = credentialFilenameCategory(label);
  const findings = [];
  if (filenameFinding !== undefined) findings.push(finding(filenameFinding, label));

  const binaryAllowlist = normalizeBinaryAllowlist(options.binaryAllowlist ?? PUBLIC_BINARY_ALLOWLIST);
  if (isAllowlistedBinary(bytes, binaryAllowlist)) return Object.freeze(findings);
  const looksBinary = BINARY_EXTENSIONS.has(extension) || bytes.includes(0);
  let text;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    return Object.freeze([...findings, finding(
      looksBinary ? "binary not allowlisted" : "unsupported text encoding",
      label,
    )]);
  }
  if (looksBinary || (!TEXT_EXTENSIONS.has(extension) && !isKnownTextFilename(label))) {
    return Object.freeze([...findings, finding("binary not allowlisted", label)]);
  }

  const normalized = text.normalize("NFKC");
  if (hasProviderCredential(normalized)) findings.push(finding("provider credential", label));
  if (hasCloudAccessKey(normalized)) findings.push(finding("cloud credential", label));
  if (hasPrivateKeyHeader(normalized)) findings.push(finding("private key", label));
  if (hasLiteralNpmCredential(normalized)) findings.push(finding("literal credential", label));
  if (hasLiteralCredentialAssignment(normalized, scope)) findings.push(finding("literal credential", label));
  if (hasConcreteHomePath(normalized)) findings.push(finding("personal home path", label));
  if (extension === ".map" && hasAbsoluteSourceMapPath(normalized)) {
    findings.push(finding("absolute source map path", label));
  }
  return Object.freeze(dedupeFindings(findings));
}

export function classifyPublicLabel(label) {
  const normalized = requiredLabel(label).normalize("NFKC");
  const findings = [];
  const filenameFinding = credentialFilenameCategory(normalized);
  if (filenameFinding !== undefined) findings.push(finding(filenameFinding, normalized));
  if (hasProviderCredential(normalized)) findings.push(finding("provider credential", normalized));
  if (hasCloudAccessKey(normalized)) findings.push(finding("cloud credential", normalized));
  if (hasConcreteHomePath(normalized)) findings.push(finding("personal home path", normalized));
  return Object.freeze(dedupeFindings(findings));
}

export async function scanPublicDirectory(root, options = {}) {
  const canonicalRoot = await canonicalDirectory(root);
  const limits = validateLimits(options);
  const binaryAllowlist = options.binaryAllowlist ?? PUBLIC_BINARY_ALLOWLIST;
  const state = { entries: 0, aggregateBytes: 0, findings: [] };
  await walkDirectory(canonicalRoot, canonicalRoot, state, limits, binaryAllowlist);
  if (state.findings.length > 0) throw publicScanError(state.findings);
  return Object.freeze({
    status: "passed",
    entries: state.entries,
    bytes: state.aggregateBytes,
    findings: Object.freeze([]),
  });
}

export async function scanTrackedPublicTree(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const limits = validateLimits(options);
  const result = await runBoundedProcess("git", ["-C", root, "ls-files", "-z"], {
    maxOutputBytes: MAX_GIT_LIST_BYTES,
  });
  if (result.code !== 0 || result.stderr.length !== 0 || result.stdout.at(-1) !== 0) {
    throw publicScanError([finding("non-regular file", "<tracked-tree>")]);
  }
  const names = result.stdout.subarray(0, -1).toString("utf8").split("\0");
  if (names.length === 0 || names.length > limits.maxEntries || new Set(names).size !== names.length) {
    throw publicScanError([finding("aggregate byte budget", "<tracked-tree>")]);
  }
  let aggregateBytes = 0;
  const findings = [];
  for (const name of names) {
    if (!safeRepositoryPath(name)) {
      findings.push(finding("non-regular file", name));
      continue;
    }
    const path = resolve(root, ...name.split("/"));
    if (!insideRoot(root, path)) {
      findings.push(finding("non-regular file", name));
      continue;
    }
    let record;
    try {
      record = await readRegularFileBounded(path, limits.maxFileBytes);
    } catch (error) {
      findings.push(finding(error?.code === "PUBLIC_FILE_TOO_LARGE"
        ? "file byte budget"
        : error?.code === "PUBLIC_SYMBOLIC_LINK" ? "symbolic link" : "non-regular file", name));
      continue;
    }
    aggregateBytes += record.bytes.length;
    if (aggregateBytes > limits.maxAggregateBytes) {
      findings.push(finding("aggregate byte budget", name));
      break;
    }
    findings.push(...classifyPublicContent(record.bytes, { label: name }));
  }
  if (findings.length > 0) throw publicScanError(findings);
  return Object.freeze({
    status: "passed",
    entries: names.length,
    bytes: aggregateBytes,
    findings: Object.freeze([]),
  });
}

export function formatPublicFindings(findings) {
  if (!Array.isArray(findings)) throw new TypeError("findings must be an array");
  return findings.map((item) => {
    const category = safeDiagnosticField(item?.category, "policy violation");
    const label = safeLabel(item?.label ?? item?.objectId ?? "<unknown>");
    const object = ["blob", "commit", "tag", "tree", "ref"].includes(item?.objectType)
      && /^[a-f0-9]{40}$/u.test(item?.objectId ?? "")
      ? ` object=${item.objectType}:${item.objectId}`
      : "";
    const remediation = safeDiagnosticField(item?.remediation ?? remediationFor(category), "Remove the unsafe public content.");
    return `category=${category} label=${label}${object} remediation=${remediation}`;
  }).join("\n");
}

export function publicFinding(category, label, extra = {}) {
  return finding(category, label, extra);
}

export function publicScanFailure(findings, message = "Public content scan failed") {
  return publicScanError(findings, message);
}

export function isApprovedOwnerEmail(email) {
  return typeof email === "string" && email.normalize("NFKC").toLowerCase() === OWNER_EMAIL.toLowerCase();
}

async function walkDirectory(root, current, state, limits, binaryAllowlist) {
  const directory = await opendir(current);
  for await (const entry of directory) {
    state.entries += 1;
    const path = resolve(current, entry.name);
    const label = relative(root, path).replaceAll("\\", "/");
    if (state.entries > limits.maxEntries) {
      state.findings.push(finding("aggregate byte budget", label));
      return;
    }
    let metadata;
    try { metadata = await lstat(path); }
    catch { state.findings.push(finding("non-regular file", label)); continue; }
    if (metadata.isSymbolicLink()) {
      state.findings.push(finding("symbolic link", label));
    } else if (metadata.isDirectory()) {
      await walkDirectory(root, path, state, limits, binaryAllowlist);
    } else if (!metadata.isFile()) {
      state.findings.push(finding("non-regular file", label));
    } else if (metadata.size > limits.maxFileBytes) {
      state.findings.push(finding("file byte budget", label));
    } else {
      let record;
      try { record = await readRegularFileBounded(path, limits.maxFileBytes); }
      catch (error) {
        state.findings.push(finding(error?.code === "PUBLIC_FILE_TOO_LARGE"
          ? "file byte budget" : error?.code === "PUBLIC_SYMBOLIC_LINK"
            ? "symbolic link" : "non-regular file", label));
        continue;
      }
      state.aggregateBytes += record.bytes.length;
      if (state.aggregateBytes > limits.maxAggregateBytes) {
        state.findings.push(finding("aggregate byte budget", label));
        return;
      }
      state.findings.push(...classifyPublicContent(record.bytes, { label, binaryAllowlist }));
    }
  }
}

async function readRegularFileBounded(path, maxBytes) {
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK");
  if (!before.isFile()) throw codedError("PUBLIC_NON_REGULAR");
  if (before.size > maxBytes) throw codedError("PUBLIC_FILE_TOO_LARGE");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw codedError("PUBLIC_FILE_CHANGED");
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw codedError("PUBLIC_FILE_TOO_LARGE");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== total
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw codedError("PUBLIC_FILE_CHANGED");
    }
    return Object.freeze({ bytes: Buffer.concat(chunks, total) });
  } finally {
    await handle.close();
  }
}

async function canonicalDirectory(root) {
  const resolved = resolve(root);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) throw publicScanError([
    finding(info.isSymbolicLink() ? "symbolic link" : "non-regular file", "<root>"),
  ]);
  return await realpath(resolved);
}

function validateLimits(options) {
  const values = {
    maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
    maxAggregateBytes: options.maxAggregateBytes ?? MAX_AGGREGATE_BYTES,
    maxEntries: options.maxEntries ?? MAX_ENTRIES,
  };
  for (const [name, maximum] of [
    ["maxFileBytes", MAX_FILE_BYTES],
    ["maxAggregateBytes", MAX_AGGREGATE_BYTES],
    ["maxEntries", MAX_ENTRIES],
  ]) {
    if (!Number.isSafeInteger(values[name]) || values[name] < 1 || values[name] > maximum) {
      throw publicScanError([finding("aggregate byte budget", `<${name}>`)]);
    }
  }
  return Object.freeze(values);
}

function hasProviderCredential(text) {
  return /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/iu.test(text)
    || /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/iu.test(text)
    || /\bgithub_pat_[A-Za-z0-9_]{40,}\b/iu.test(text)
    || /\bAIza[A-Za-z0-9_-]{30,}\b/u.test(text)
    || /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/iu.test(text)
    || /\bsk_live_[A-Za-z0-9]{20,}\b/iu.test(text);
}

function hasCloudAccessKey(text) {
  return /\b(?:AKIA|ASIA|A3T[A-Z0-9]|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/iu.test(text);
}

function hasPrivateKeyHeader(text) {
  return /-{4,5}\s*BEGIN\s+(?:(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE KEY|PGP\s+PRIVATE KEY BLOCK|SSH2\s+ENCRYPTED PRIVATE KEY)\s*-{4,5}/iu.test(text);
}

function hasLiteralNpmCredential(text) {
  const assignment = /^\s*(?:\/\/[^\s=]+\/:)?(?:_authToken|_auth|username|_password|password)\s*=\s*(.*?)\s*$/gimu;
  for (const match of text.matchAll(assignment)) {
    const value = match[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2").trim();
    if (value !== "" && !isAllowedCredentialReference(value, "runtime")) return true;
  }
  return false;
}

function hasLiteralCredentialAssignment(text, scope) {
  const patterns = [
    {
      pattern: /(?:^|[\s,{;])["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n]+))/gmu,
      keyGroups: [1], valueGroups: [2, 3, 4],
    },
    {
      pattern: /\bprocess\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\s*\[\s*["']([^"']+)["']\s*\])\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n]+))/gmu,
      keyGroups: [1, 2], valueGroups: [3, 4, 5],
    },
    {
      pattern: /(?:\bos\.environ\s*\[\s*["']([^"']+)["']\s*\]|\$env:([A-Za-z_][A-Za-z0-9_]*))\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n]+))/gimu,
      keyGroups: [1, 2], valueGroups: [3, 4, 5],
    },
  ];
  const notificationRanges = matchRanges(
    text,
    /\{\s*method\s*:\s*["']notifications\/progress["']\s*,\s*params\s*:\s*\{[\s\S]{0,1024}?\}\s*,?\s*\}/gu,
  );
  const sourceMetaRanges = scope === "source"
    ? matchRanges(text, /_meta\s*:\s*\{[\s\S]{0,1024}?\}/gu)
    : [];
  for (const { pattern, keyGroups, valueGroups } of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = keyGroups.map((index) => match[index]).find((value) => value !== undefined);
      if (!isCredentialKey(key)) continue;
      const value = valueGroups.map((index) => match[index]).find((candidate) => candidate !== undefined) ?? "";
      const quoted = valueGroups.slice(0, 2).some((index) => match[index] !== undefined);
      if (isProtocolProgressReference({ match, key, value, scope, notificationRanges, sourceMetaRanges })) {
        continue;
      }
      if (isGenericTestVariableDeclaration(text, match, key, value, quoted, scope)) continue;
      if (!isAllowedCredentialReference(value, scope)) return true;
    }
  }
  return false;
}

function isCredentialKey(key) {
  if (typeof key !== "string") return false;
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  return ["apikey", "accesstoken", "authtoken", "clientsecret", "privatekey",
    "secretaccesskey", "token", "secret", "password"].some((suffix) => normalized.endsWith(suffix));
}

function isAllowedCredentialReference(value, scope) {
  const normalized = String(value).trim();
  if (normalized === "" || /^(?:<[^>]+>|\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|\$env:[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|\{env:[A-Z_][A-Z0-9_]*\}|REDACTED|YOUR[_-]|PLACEHOLDER|EXAMPLE|process\.env\.|Deno\.env\.|os\.environ)/iu.test(normalized)) {
    return true;
  }
  return scope === "source" && /^(?:secret|must-not-propagate|PRIVATE_[A-Z0-9_]*_VALUE|0{8}-0{4}-0{4}-0{4}-0{12})$/u.test(normalized);
}

function isProtocolProgressReference({ match, key, value, scope, notificationRanges, sourceMetaRanges }) {
  if (key !== "progressToken") return false;
  const inRange = (ranges) => ranges.some(([start, end]) => match.index >= start && match.index < end);
  if (scope === "source" && inRange(sourceMetaRanges)) return true;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) && inRange(notificationRanges);
}

function isGenericTestVariableDeclaration(text, match, key, value, quoted, scope) {
  if (scope !== "source") return false;
  const normalizedKey = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  if (/(?:apikey|privatekey|clientsecret|secretaccesskey|accesstoken|authtoken)$/u.test(normalizedKey)
    || /(?:aws|azure|cloud|github|gitlab|google|openai|stripe)/u.test(normalizedKey)) return false;
  const prefix = text.slice(Math.max(0, match.index - 16), match.index + 1);
  if (!/\b(?:const|let|var)\s*$/u.test(prefix)) return false;
  if (!quoted) return (/^`[^\r\n]*\$\{/u.test(value)
    || /^(?:\$\{|[A-Za-z_$][A-Za-z0-9_$]*(?:\([^\r\n]*\))?)/u.test(value));
  return SAFE_SOURCE_FIXTURE_VALUE_HASHES.has(sha256(Buffer.from(value, "utf8")));
}

function hasConcreteHomePath(text) {
  for (const match of text.matchAll(/[A-Za-z]:[\\/]+users[\\/]+([^\\/\s"'`()\[\]{}<>]+)/giu)) {
    if (!isPlaceholderUser(match[1])) return true;
  }
  const exemptRanges = [
    ...matchRanges(text, /https?:\/\/[^\s"'`<>]+/giu),
    ...matchRanges(text, /\b(?:app|router|server)\s*\.\s*(?:get|post|put|patch|delete|use|all)\s*\(\s*(?:"[^"\r\n]*"|'[^'\r\n]*')/giu),
  ];
  for (const match of text.matchAll(/\/+((?:users|home))\/+([^/\s"'`()\[\]{}<>]+)/giu)) {
    if (isPlaceholderUser(match[2])) continue;
    if (exemptRanges.some(([start, end]) => match.index >= start && match.index < end)) continue;
    return true;
  }
  return false;
}

function isPlaceholderUser(user) {
  const normalized = user.toLowerCase();
  return PLACEHOLDER_USERS.has(normalized) || /^[<{$%]/u.test(normalized);
}

function hasAbsoluteSourceMapPath(text) {
  let sourceMap;
  try { sourceMap = JSON.parse(text); } catch { return true; }
  if (!Array.isArray(sourceMap?.sources)) return false;
  return sourceMap.sources.some((source) => typeof source === "string"
    && (/^[A-Za-z]:[\\/]/u.test(source) || /^\/(?:Users|home)\//iu.test(source)));
}

function credentialFilenameCategory(label) {
  const normalized = label.normalize("NFKC").replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  if (name === ".env.example") return undefined;
  if (name === ".env" || name.startsWith(".env.")
    || /^(?:credentials?|secrets?)(?:\.[a-z0-9_-]+)?$/u.test(name)
    || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|service-account)(?:\.[a-z0-9_-]+)?$/u.test(name)) {
    return "credential filename";
  }
  return undefined;
}

function isAllowlistedBinary(bytes, allowlist) {
  const digest = sha256(bytes);
  return allowlist.some((record) => record.size === bytes.length && record.sha256 === digest);
}

function normalizeBinaryAllowlist(value) {
  if (!Array.isArray(value)) throw new TypeError("binaryAllowlist must be an array");
  for (const record of value) {
    if (!Number.isSafeInteger(record?.size) || record.size < 0
      || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
      throw new TypeError("binaryAllowlist record is invalid");
    }
  }
  return value;
}

function binaryRecord(name, size, sha256Value) {
  return Object.freeze({ name, size, sha256: sha256Value });
}

function isKnownTextFilename(label) {
  return [".gitignore", ".npmrc", "LICENSE", "NOTICE"].includes(basename(label));
}

function finding(category, label, extra = {}) {
  return Object.freeze({
    category,
    label: safeLabel(label),
    remediation: remediationFor(category),
    ...extra,
  });
}

function remediationFor(category) {
  return REMEDIATIONS[category] ?? "Remove the unsafe public content and rescan.";
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = `${item.category}\0${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicScanError(findings, message = "Public content scan failed") {
  const error = new Error(`${message}: ${findings.length} finding(s)`);
  error.code = "PUBLIC_CONTENT_SCAN_FAILED";
  error.findings = Object.freeze([...findings]);
  return error;
}

function safeLabel(value) {
  const raw = String(value).normalize("NFKC").replaceAll("\\", "/")
    .replace(/[\u0000-\u001f\u007f]/gu, "?");
  if (raw.length === 0) return "<unknown>";
  if (raw.length > 240 || hasProviderCredential(raw) || hasCloudAccessKey(raw)
    || hasPrivateKeyHeader(raw) || hasLiteralCredentialAssignment(raw)
    || hasConcreteHomePath(raw)) {
    return `redacted:${sha256(Buffer.from(raw, "utf8")).slice(0, 12)}`;
  }
  return raw;
}

function safeDiagnosticField(value, fallback) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
    || /[\r\n\u0000-\u001f\u007f]/u.test(value)) return fallback;
  return value;
}

function requiredLabel(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new TypeError("label is invalid");
  }
  return value;
}

function normalizeScope(value) {
  if (value === undefined) return "source";
  if (value !== "source" && value !== "runtime") throw new TypeError("scope is invalid");
  return value;
}

function asBuffer(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("content must be bytes");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function matchRanges(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

function safeRepositoryPath(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 4096
    && !name.includes("\0") && !name.includes("\\") && !name.startsWith("/")
    && !/^[A-Za-z]:/u.test(name)
    && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function insideRoot(root, path) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot
    || normalizedPath.toLowerCase().startsWith(`${normalizedRoot}${sep}`.toLowerCase());
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function runBoundedProcess(tool, args, options = {}) {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_LIST_BYTES;
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(tool, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let total = 0;
    let overflow = false;
    const collect = (target) => (chunk) => {
      total += chunk.length;
      if (total > maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise(Object.freeze({
      code: overflow ? -1 : code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      overflow,
    })));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function runTreeCli() {
  try {
    const result = await scanTrackedPublicTree({ root: process.cwd() });
    process.stdout.write(`PUBLIC_TREE_SCAN_OK entries=${result.entries} bytes=${result.bytes}\n`);
  } catch (error) {
    const findings = Array.isArray(error?.findings) ? error.findings : [finding("non-regular file", "<scanner>")];
    process.stderr.write(`${formatPublicFindings(findings)}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  if (process.argv.slice(2).some((argument) => argument !== "--tree")) {
    process.stderr.write("PUBLIC_TREE_SCAN_USAGE\n");
    process.exitCode = 1;
  } else {
    await runTreeCli();
  }
}
