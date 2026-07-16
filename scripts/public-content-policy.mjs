import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, extname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_GIT_LIST_BYTES = 16 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 20_000;
const MAX_TERMINATION_TIMEOUT_MS = 60_000;
const WINDOWS_RUNNER = fileURLToPath(new URL("./public-scan-command-runner.mjs", import.meta.url));
const WINDOWS_SUPERVISOR = fileURLToPath(new URL(
  "../packages/gpt-codex-hwp/src/workers/windows-job-supervisor.ps1",
  import.meta.url,
));
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
const OWNER_NAME = "Gpt_Codex_HWP contributors";

export const PUBLIC_BINARY_ALLOWLIST = Object.freeze([
  binaryRecord([
    "assets/gpt-codex-hwp-banner.png",
    "packages/gpt-codex-hwp/assets/gpt-codex-hwp-banner.png",
    "plugins/gpt-codex-hwp/assets/gpt-codex-hwp-banner.png",
  ], 1_659_083, "2a17366c5d9d164c5b7c837fad1e13182f9414ff1363bf1a0e5ab9ec88bfabfd"),
  binaryRecord([
    "assets/gpt-codex-hwp-icon.png",
    "packages/gpt-codex-hwp/assets/gpt-codex-hwp-icon.png",
    "plugins/gpt-codex-hwp/assets/gpt-codex-hwp-icon.png",
    "plugins/gpt-codex-hwp/skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon.png",
    "skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon.png",
  ], 331_169, "2928286646749c5d7272c3d25c981231bb31d6a4d6c2cb9cdc03d29e14898892"),
  binaryRecord([
    "assets/gpt-codex-hwp-icon-128.png",
    "packages/gpt-codex-hwp/assets/gpt-codex-hwp-icon-128.png",
    "plugins/gpt-codex-hwp/assets/gpt-codex-hwp-icon-128.png",
  ], 29_837, "e13ec563c49723aa5b78a755e9097bff28173b4c4214ca3c9e9dd886d0311812"),
  binaryRecord([
    "assets/gpt-codex-hwp-icon-64.png",
    "packages/gpt-codex-hwp/assets/gpt-codex-hwp-icon-64.png",
    "plugins/gpt-codex-hwp/assets/gpt-codex-hwp-icon-64.png",
    "plugins/gpt-codex-hwp/skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon-64.png",
    "skills/gpt-codex-hwp/assets/gpt-codex-hwp-icon-64.png",
  ], 9_053, "f3642b4ef5f6985ff3fa96f454d86f50ed745923ba31a51a1f73e92ddbbcd166"),
  binaryRecord([
    "packages/gpt-codex-hwp/tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp",
  ], 8_704, "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd"),
]);

export const PUBLIC_CONTENT_LIMITS = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  maxAggregateBytes: MAX_AGGREGATE_BYTES,
  maxEntries: MAX_ENTRIES,
});

const REMEDIATIONS = Object.freeze({
  "absolute source map path": "Remove absolute sources or omit the source map.",
  "aggregate byte budget": "Reduce the scanned public input set.",
  "aggregate entry budget": "Reduce the number of public files and directories.",
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
  if (isAllowlistedBinary(bytes, label, binaryAllowlist)) return Object.freeze(findings);
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
  if (hasMixedCredentialReference(normalized)) findings.push(finding("literal credential", label));
  if (hasLiteralCredentialAssignment(normalized, scope, label)) findings.push(finding("literal credential", label));
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
  const limits = validateLimits(options);
  const binaryAllowlist = options.binaryAllowlist ?? PUBLIC_BINARY_ALLOWLIST;
  let boundary;
  try { boundary = await createOwnedBoundary(root); }
  catch (error) { throw publicScanError([boundaryFinding(error)]); }
  let entries = 0;
  let aggregateBytes = 0;
  const findings = [];
  try {
    for await (const record of walkOwnedRegularFiles(boundary, {
      maxEntries: limits.maxEntries,
      maxFileBytes: limits.maxFileBytes,
    })) {
      entries = record.entries;
      aggregateBytes += record.bytes.length;
      if (aggregateBytes > limits.maxAggregateBytes) {
        findings.push(finding("aggregate byte budget", record.label));
        break;
      }
      findings.push(...classifyPublicContent(record.bytes, { label: record.label, binaryAllowlist }));
    }
  } catch (error) {
    findings.push(boundaryFinding(error));
  }
  if (findings.length > 0) throw publicScanError(findings);
  return Object.freeze({
    status: "passed",
    entries,
    bytes: aggregateBytes,
    findings: Object.freeze([]),
  });
}

export async function scanTrackedPublicTree(options = {}) {
  let boundary;
  try { boundary = await createOwnedBoundary(options.root ?? process.cwd()); }
  catch (error) { throw publicScanError([boundaryFinding(error)]); }
  const root = boundary.root;
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
      record = await readOwnedRegularFile(boundary, path, name, limits.maxFileBytes);
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
  return typeof email === "string" && email === OWNER_EMAIL;
}

export function isApprovedOwnerIdentity(name, email) {
  return name === OWNER_NAME && email === OWNER_EMAIL;
}

export async function createOwnedBoundary(root) {
  const resolvedRoot = resolve(root);
  try {
    await rejectJunctionAncestors(resolvedRoot);
    const before = await lstat(resolvedRoot);
    if (before.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK");
    if (!before.isDirectory()) throw codedError("PUBLIC_NON_REGULAR");
    const canonicalRoot = await realpath(resolvedRoot);
    if (!samePath(resolvedRoot, canonicalRoot)) throw codedError("PUBLIC_SYMBOLIC_LINK");
    const after = await lstat(resolvedRoot);
    if (!sameIdentity(before, after) || !after.isDirectory()) throw codedError("PUBLIC_FILE_CHANGED");
    return Object.freeze({ root: resolvedRoot, canonicalRoot, identity: identityOf(after) });
  } catch (error) {
    if (error?.code?.startsWith?.("PUBLIC_")) throw error;
    throw codedError("PUBLIC_NON_REGULAR");
  }
}

export async function assertBoundaryRootUnchanged(boundary) {
  validateBoundary(boundary);
  try {
    const before = await lstat(boundary.root);
    if (before.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK", "<root>");
    if (!before.isDirectory() || !sameIdentity(before, boundary.identity)) {
      throw codedError("PUBLIC_FILE_CHANGED", "<root>");
    }
    const canonicalRoot = await realpath(boundary.root);
    if (!samePath(canonicalRoot, boundary.canonicalRoot)) {
      throw codedError("PUBLIC_FILE_CHANGED", "<root>");
    }
    const after = await lstat(boundary.root);
    if (after.isSymbolicLink() || !after.isDirectory()
      || !sameIdentity(before, after) || !sameIdentity(after, boundary.identity)) {
      throw codedError("PUBLIC_FILE_CHANGED", "<root>");
    }
    return after;
  } catch (error) {
    if (error?.code?.startsWith?.("PUBLIC_")) throw error;
    throw codedError("PUBLIC_FILE_CHANGED", "<root>");
  }
}

export async function* walkOwnedRegularFiles(boundary, options = {}) {
  validateBoundary(boundary);
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) {
    throw codedError("PUBLIC_ENTRY_BUDGET");
  }
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
    throw codedError("PUBLIC_FILE_TOO_LARGE");
  }
  validateReadObserver(options.onContentRead);
  const state = { entries: 0 };
  await assertBoundaryRootUnchanged(boundary);
  try {
    yield* walkOwnedDirectory(boundary, boundary.root, state, maxEntries, maxFileBytes, options);
  } finally {
    await assertBoundaryRootUnchanged(boundary);
  }
}

async function* walkOwnedDirectory(boundary, current, state, maxEntries, maxFileBytes, options) {
  await assertBoundaryRootUnchanged(boundary);
  const before = await verifyOwnedDirectory(boundary, current);
  const directory = await opendir(current);
  try {
    await assertBoundaryRootUnchanged(boundary);
    const opened = await lstat(current);
    if (!sameIdentity(before, opened) || !opened.isDirectory()) throw codedError("PUBLIC_FILE_CHANGED");
    for await (const entry of directory) {
      await assertBoundaryRootUnchanged(boundary);
      try {
        state.entries += 1;
        const path = join(current, entry.name);
        const label = relative(boundary.root, path).replaceAll("\\", "/");
        if (state.entries > maxEntries) throw codedError("PUBLIC_ENTRY_BUDGET", label);
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK", label);
        if (metadata.isDirectory()) {
          yield* walkOwnedDirectory(boundary, path, state, maxEntries, maxFileBytes, options);
        } else if (metadata.isFile()) {
          const record = await readOwnedRegularFile(boundary, path, label, maxFileBytes, {
            onContentRead: options.onContentRead,
          });
          yield Object.freeze({ ...record, label, entries: state.entries });
        } else throw codedError("PUBLIC_NON_REGULAR", label);
      } finally {
        await assertBoundaryRootUnchanged(boundary);
      }
    }
  } finally {
    try { await directory.close(); } catch { /* for-await may already close it */ }
    await assertBoundaryRootUnchanged(boundary);
  }
  const after = await verifyOwnedDirectory(boundary, current);
  if (!sameIdentity(before, after)) throw codedError("PUBLIC_FILE_CHANGED");
}

export async function readOwnedRegularFile(boundary, path, label, maxBytes = MAX_FILE_BYTES, options = {}) {
  validateBoundary(boundary);
  requiredLabel(label);
  validateReadOptions(options);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_BYTES) {
    throw codedError("PUBLIC_FILE_TOO_LARGE", label);
  }
  const resolvedPath = resolve(path);
  if (!insideRoot(boundary.root, resolvedPath) || resolvedPath === boundary.root) {
    throw codedError("PUBLIC_NON_REGULAR", label);
  }
  await assertBoundaryRootUnchanged(boundary);
  await verifyOwnedAncestors(boundary, resolvedPath);
  const before = await lstat(resolvedPath);
  if (before.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK", label);
  if (!before.isFile()) throw codedError("PUBLIC_NON_REGULAR", label);
  if (before.size > maxBytes) throw codedError("PUBLIC_FILE_TOO_LARGE", label);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  await options.beforeOpen?.();
  const handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow);
  try {
    await options.afterOpen?.();
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(opened, before)) {
      throw codedError("PUBLIC_FILE_CHANGED", label);
    }
    await assertOpenedOwnedPathUnchanged(boundary, resolvedPath, opened, label);
    const chunks = [];
    let total = 0;
    while (true) {
      await assertOpenedOwnedPathUnchanged(boundary, resolvedPath, opened, label);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      options.onContentRead?.(bytesRead);
      total += bytesRead;
      if (total > maxBytes) throw codedError("PUBLIC_FILE_TOO_LARGE", label);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await assertBoundaryRootUnchanged(boundary);
    const [after, pathAfter, canonicalAfter] = await Promise.all([
      handle.stat(),
      lstat(resolvedPath),
      realpath(resolvedPath),
    ]);
    if (!sameIdentity(after, opened) || !sameIdentity(pathAfter, opened) || after.size !== total
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw codedError("PUBLIC_FILE_CHANGED", label);
    }
    if (!insideRoot(boundary.canonicalRoot, canonicalAfter)) throw codedError("PUBLIC_FILE_CHANGED", label);
    return Object.freeze({ bytes: Buffer.concat(chunks, total) });
  } finally {
    await handle.close();
  }
}

async function verifyOwnedDirectory(boundary, path) {
  await assertBoundaryRootUnchanged(boundary);
  await verifyOwnedAncestors(boundary, path);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK");
  if (!metadata.isDirectory()) throw codedError("PUBLIC_NON_REGULAR");
  const canonical = await realpath(path);
  if (!insideRoot(boundary.canonicalRoot, canonical)) throw codedError("PUBLIC_FILE_CHANGED");
  await assertBoundaryRootUnchanged(boundary);
  return metadata;
}

async function verifyOwnedAncestors(boundary, target) {
  await assertBoundaryRootUnchanged(boundary);
  const parentRelative = relative(boundary.root, resolve(target));
  if (parentRelative.startsWith("..") || resolve(target) === boundary.root) {
    await assertBoundaryRootUnchanged(boundary);
    return;
  }
  const parts = parentRelative.split(/[\\/]/u).slice(0, -1);
  let current = boundary.root;
  for (const part of parts) {
    await assertBoundaryRootUnchanged(boundary);
    current = join(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK");
    if (!metadata.isDirectory()) throw codedError("PUBLIC_NON_REGULAR");
    const canonical = await realpath(current);
    if (!insideRoot(boundary.canonicalRoot, canonical)) throw codedError("PUBLIC_FILE_CHANGED");
    await assertBoundaryRootUnchanged(boundary);
  }
  await assertBoundaryRootUnchanged(boundary);
}

async function assertOpenedOwnedPathUnchanged(boundary, path, opened, label) {
  await assertBoundaryRootUnchanged(boundary);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK", label);
  const canonical = await realpath(path);
  if (!metadata.isFile() || !sameIdentity(metadata, opened)
    || !insideRoot(boundary.canonicalRoot, canonical)) {
    throw codedError("PUBLIC_FILE_CHANGED", label);
  }
  await assertBoundaryRootUnchanged(boundary);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(after, opened)) {
    throw codedError("PUBLIC_FILE_CHANGED", label);
  }
}

async function rejectJunctionAncestors(path) {
  const root = parse(path).root;
  let current = root;
  const parts = relative(root, path).split(/[\\/]/u).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw codedError("PUBLIC_SYMBOLIC_LINK");
  }
}

function validateBoundary(boundary) {
  if (boundary === null || typeof boundary !== "object"
    || typeof boundary.root !== "string" || typeof boundary.canonicalRoot !== "string"
    || boundary.identity === null || typeof boundary.identity !== "object"
    || !(typeof boundary.identity.dev === "number" || typeof boundary.identity.dev === "bigint")
    || !(typeof boundary.identity.ino === "number" || typeof boundary.identity.ino === "bigint")) {
    throw codedError("PUBLIC_NON_REGULAR");
  }
}

function validateReadOptions(options) {
  if (options === null || typeof options !== "object") throw new TypeError("read options are invalid");
  for (const name of ["beforeOpen", "afterOpen", "onContentRead"]) {
    if (options[name] !== undefined && typeof options[name] !== "function") {
      throw new TypeError("read options are invalid");
    }
  }
}

function validateReadObserver(observer) {
  if (observer !== undefined && typeof observer !== "function") {
    throw new TypeError("walk options are invalid");
  }
}

function identityOf(metadata) {
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
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

function hasLiteralCredentialAssignment(text, scope, label) {
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
      if (isWorkflowIdTokenPermission({ text, match, key, value, scope, label })) continue;
      if (isGenericTestVariableDeclaration(text, match, key, value, quoted, scope)) continue;
      if (!isAllowedCredentialReference(value, scope)) return true;
    }
  }
  return false;
}

function isWorkflowIdTokenPermission({ text, match, key, value, scope, label }) {
  if (scope !== "source" || key !== "id-token" || !["write", "none"].includes(value)) return false;
  if (typeof label !== "string" || !/^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/u.test(label)) return false;
  const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
  const lineEnd = text.indexOf("\n", match.index);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
  return /^id-token:\s*(?:write|none)(?:\s+#.*)?$/u.test(line);
}

function isCredentialKey(key) {
  if (typeof key !== "string") return false;
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  return ["apikey", "accesstoken", "authtoken", "clientsecret", "privatekey",
    "secretaccesskey", "token", "secret", "password"].some((suffix) => normalized.endsWith(suffix));
}

function isAllowedCredentialReference(value, scope) {
  const normalized = String(value).trim();
  const exactReference = /^(?:<[^>]+>|\$\{\{\s*(?:github\.token|secrets\.GITHUB_TOKEN)\s*\}\}|\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|\$env:[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|\{env:[A-Z_][A-Z0-9_]*\}|REDACTED|YOUR[_-][A-Z0-9_-]*|PLACEHOLDER|EXAMPLE|process\.env(?:\.[A-Z_][A-Z0-9_]*|\[["'][A-Z_][A-Z0-9_]*["']\])|Deno\.env\.get\(["'][A-Z_][A-Z0-9_]*["']\)|os\.environ\[["'][A-Z_][A-Z0-9_]*["']\])$/iu;
  if (normalized === "" || exactReference.test(normalized)) {
    return true;
  }
  if (scope === "source") {
    const fixtureReference = normalized.replace(/\\[nrt]["']?$/u, "");
    if (fixtureReference !== normalized && exactReference.test(fixtureReference)) return true;
  }
  return scope === "source" && /^(?:secret|must-not-propagate|PRIVATE_[A-Z0-9_]*_VALUE|0{8}-0{4}-0{4}-0{4}-0{12})$/u.test(normalized);
}

function hasMixedCredentialReference(text) {
  const reference = /(?:\$\{\{\s*(?:github\.token|secrets\.GITHUB_TOKEN)\s*\}\}|\$\{[A-Z_][A-Z0-9_]*\}|\$env:[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|\{env:[A-Z_][A-Z0-9_]*\}|process\.env(?:\.[A-Z_][A-Z0-9_]*|\[["'][A-Z_][A-Z0-9_]*["']\])|Deno\.env\.get\(["'][A-Z_][A-Z0-9_]*["']\)|os\.environ\[["'][A-Z_][A-Z0-9_]*["']\])/giu;
  for (const match of text.matchAll(reference)) {
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const prefix = text.slice(lineStart, match.index);
    const assignment = /["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*[:=]\s*["'`]?\s*$/u.exec(prefix);
    if (assignment === null || !isCredentialKey(assignment[1])) continue;
    const suffix = text.slice(match.index + match[0].length).match(/^[ \t]*([^\r\n,;}\])])/u)?.[1];
    if (suffix !== undefined && /^(?:\||&|\?|\+|-|\*|\/|`|[A-Za-z0-9_$])/u.test(suffix)) return true;
  }
  return false;
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

function isAllowlistedBinary(bytes, label, allowlist) {
  const digest = sha256(bytes);
  const normalizedLabel = label.replaceAll("\\", "/");
  return allowlist.some((record) => record.size === bytes.length && record.sha256 === digest
    && record.paths.includes(normalizedLabel));
}

function normalizeBinaryAllowlist(value) {
  if (!Array.isArray(value)) throw new TypeError("binaryAllowlist must be an array");
  for (const record of value) {
    if (!Number.isSafeInteger(record?.size) || record.size < 0
      || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)
      || !Array.isArray(record.paths) || record.paths.length === 0
      || record.paths.some((path) => !safeRepositoryPath(path))
      || new Set(record.paths).size !== record.paths.length) {
      throw new TypeError("binaryAllowlist record is invalid");
    }
  }
  return value;
}

function binaryRecord(paths, size, sha256Value) {
  return Object.freeze({ paths: Object.freeze([...paths]), size, sha256: sha256Value });
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
  if (process.platform === "win32") {
    return normalizedPath.toLowerCase() === normalizedRoot.toLowerCase()
      || normalizedPath.toLowerCase().startsWith(`${normalizedRoot}${sep}`.toLowerCase());
  }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundaryFinding(error) {
  const category = error?.code === "PUBLIC_FILE_TOO_LARGE" ? "file byte budget"
    : error?.code === "PUBLIC_ENTRY_BUDGET" ? "aggregate entry budget"
      : error?.code === "PUBLIC_SYMBOLIC_LINK" ? "symbolic link" : "non-regular file";
  return finding(category, error?.publicLabel ?? "<boundary>");
}

function codedError(code, publicLabel) {
  const error = new Error(code);
  error.code = code;
  if (publicLabel !== undefined) error.publicLabel = safeLabel(publicLabel);
  return error;
}

export async function runBoundedProcess(tool, args, options = {}) {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_LIST_BYTES;
  const terminationTimeoutMs = options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
  const startProcess = options.startProcess ?? startBoundedProcess;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError("bounded process options are invalid");
  }
  if (!Number.isSafeInteger(terminationTimeoutMs) || terminationTimeoutMs < 1
    || terminationTimeoutMs > MAX_TERMINATION_TIMEOUT_MS || typeof startProcess !== "function") {
    throw new TypeError("bounded process options are invalid");
  }
  let lifecycle;
  try { lifecycle = await startProcess(tool, args, options); }
  catch (error) {
    return failedProcessReceipt({ timedOut: error?.code === "PUBLIC_PROCESS_TIMEOUT" });
  }
  return await collectBoundedProcess(lifecycle.child, {
    deadline: lifecycle.deadline,
    exit: lifecycle.exit,
    maxOutputBytes,
    terminate: lifecycle.terminate,
    terminationTimeoutMs,
  });
}

export async function startBoundedProcess(tool, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  if (typeof tool !== "string" || tool.length < 1 || tool.length > 4096
    || !Array.isArray(args) || args.some((value) => typeof value !== "string" || value.length > 4096)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new TypeError("bounded process options are invalid");
  }
  const input = options.input === undefined ? Buffer.alloc(0) : asBuffer(options.input);
  const deadline = Date.now() + timeoutMs;
  let child;
  let exit;
  let supervisor;
  let startupHelper;
  try {
    if (process.platform === "win32") {
      child = spawn(process.execPath, [WINDOWS_RUNNER], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      exit = observeProcessExit(child);
      const control = child.stdio[3];
      if (control === null || typeof control.on !== "function") throw codedError("PUBLIC_PROCESS_START");
      const startup = await withinDeadline(Promise.all([
        readExactControlLine(control, "GPT_CODEX_HWP_SCAN_RUNNER_READY", 128),
        createWindowsProcessSupervisor(child, (helper) => { startupHelper = helper; }),
      ]), deadline);
      supervisor = startup[1];
      child.stdin.end(encodeWindowsRunnerInput(tool, args, input));
    } else {
      child = spawn(tool, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      exit = observeProcessExit(child);
      if (options.input !== undefined) child.stdin.end(input);
    }
  } catch {
    await abortStartup(child, supervisor, startupHelper);
    const error = codedError(Date.now() >= deadline ? "PUBLIC_PROCESS_TIMEOUT" : "PUBLIC_PROCESS_START");
    throw error;
  }
  let activeTermination;
  const terminate = () => {
    activeTermination ??= (async () => {
      const gone = process.platform === "win32"
        ? await supervisor.terminate()
        : await terminatePosixProcessGroup(child);
      destroyProcessPipes(child);
      return gone;
    })();
    return activeTermination;
  };
  return Object.freeze({
    child,
    deadline,
    exit,
    terminate,
  });
}

async function collectBoundedProcess(child, {
  deadline,
  exit,
  maxOutputBytes,
  terminate,
  terminationTimeoutMs,
}) {
  return await new Promise((resolvePromise) => {
    const stdout = [];
    const stderr = [];
    let total = 0;
    let overflow = false;
    let timedOut = false;
    let terminal = false;
    let stopping = false;
    const remaining = Math.max(1, deadline - Date.now());
    let timer;
    const finish = async (code, signal) => {
      if (terminal || stopping) return;
      terminal = true;
      clearTimeout(timer);
      const treeGone = await boundedTermination(terminate, terminationTimeoutMs);
      destroyProcessPipes(child);
      resolvePromise(Object.freeze({
        code: overflow || timedOut || !treeGone ? -1 : code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        overflow,
        timedOut,
        terminationFailed: !treeGone,
      }));
    };
    const stop = async (reason) => {
      if (stopping || terminal) return;
      stopping = true;
      if (reason === "overflow") overflow = true;
      if (reason === "timeout") timedOut = true;
      const treeGone = await boundedTermination(terminate, terminationTimeoutMs);
      destroyProcessPipes(child);
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      resolvePromise(Object.freeze({
        ...failedProcessReceipt({ overflow, timedOut }),
        terminationFailed: !treeGone,
      }));
    };
    const collect = (target) => (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxOutputBytes) void stop("overflow");
      else target.push(bytes);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    exit.then(({ code, signal, error }) => {
      if (error) void stop("error");
      else void finish(code, signal);
    });
    timer = setTimeout(() => { void stop("timeout"); }, remaining);
  });
}

async function boundedTermination(terminate, timeoutMs) {
  if (typeof terminate !== "function") return false;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => terminate()).then((value) => value === true, () => false),
      new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observeProcessExit(child) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(Object.freeze(value));
    };
    child.once("error", () => finish({ code: null, signal: null, error: true }));
    child.once("close", (code, signal) => finish({ code, signal, error: false }));
  });
}

function failedProcessReceipt({ overflow = false, timedOut = false } = {}) {
  return Object.freeze({
    code: -1,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    overflow,
    timedOut,
    terminationFailed: false,
  });
}

function encodeWindowsRunnerInput(tool, args, input) {
  const frame = Buffer.from(JSON.stringify({ tool, args }), "utf8");
  if (frame.length > 64 * 1024 || input.length > 32 * 1024 * 1024) {
    throw codedError("PUBLIC_PROCESS_START");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(frame.length);
  return Buffer.concat([header, frame, input]);
}

async function createWindowsProcessSupervisor(child, observeHelper) {
  if (!Number.isInteger(child?.pid)) throw codedError("PUBLIC_PROCESS_START");
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || !/^[A-Za-z]:[\\/]/u.test(systemRoot)) {
    throw codedError("PUBLIC_PROCESS_START");
  }
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const helper = spawn(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS_SUPERVISOR, "-TargetPid", String(child.pid), "-ForceTracker",
  ], {
    env: minimalWindowsHelperEnvironment(process.env),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  observeHelper?.(helper);
  const lines = new BoundedLineReader(helper.stdout, 256);
  let stderrBytes = 0;
  helper.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
  const ready = await lines.next(10_000);
  if (!new RegExp(`^GPT_CODEX_HWP_JOB READY ${child.pid} [12] [0-9]+$`, "u").test(ready)
    || stderrBytes !== 0) {
    throw codedError("PUBLIC_PROCESS_START");
  }
  let active;
  return Object.freeze({
    terminate() {
      active ??= (async () => {
        try {
          helper.stdin.end("TERMINATE\n");
          let line = await lines.next(5_000);
          if (/^GPT_CODEX_HWP_JOB TRACKER [0-9]+ [0-9]+$/u.test(line)) line = await lines.next(5_000);
          if (!/^GPT_CODEX_HWP_JOB GONE 0 [12]$/u.test(line) || stderrBytes !== 0) return false;
          return await waitForClose(helper, 5_000) === 0;
        } catch { return false; }
      })();
      return active;
    },
    cancel() {
      destroyProcessPipes(helper);
      try { helper.kill("SIGKILL"); } catch { /* gated child remains separately owned */ }
    },
  });
}

function minimalWindowsHelperEnvironment(source) {
  const result = {};
  for (const key of ["SystemRoot", "WINDIR", "LANG", "LC_ALL", "TEMP", "TMP"]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}

class BoundedLineReader {
  #buffer = Buffer.alloc(0);
  #lines = [];
  #waiters = [];
  #failed;
  constructor(stream, maxBytes) {
    this.maxBytes = maxBytes;
    stream.on("data", (chunk) => this.#push(Buffer.from(chunk)));
    stream.on("end", () => this.#fail());
    stream.on("error", () => this.#fail());
    stream.on("close", () => this.#fail());
  }
  next(timeoutMs) {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift());
    if (this.#failed) return Promise.reject(codedError("PUBLIC_PROCESS_START"));
    return new Promise((resolvePromise, reject) => {
      const waiter = { resolve: resolvePromise, reject };
      this.#waiters.push(waiter);
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((item) => item !== waiter);
        reject(codedError("PUBLIC_PROCESS_START"));
      }, timeoutMs);
    });
  }
  #push(chunk) {
    if (this.#failed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > this.maxBytes) return this.#fail();
    let newline;
    while ((newline = this.#buffer.indexOf(0x0a)) >= 0) {
      const raw = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1).toString("ascii") : raw.toString("ascii");
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(line);
      else { clearTimeout(waiter.timer); waiter.resolve(line); }
    }
  }
  #fail() {
    if (this.#failed) return;
    this.#failed = true;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(codedError("PUBLIC_PROCESS_START"));
    }
  }
}

async function readExactControlLine(stream, expected, maxBytes) {
  const reader = new BoundedLineReader(stream, maxBytes);
  const line = await reader.next(10_000);
  if (line !== expected) throw codedError("PUBLIC_PROCESS_START");
}

async function withinDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw codedError("PUBLIC_PROCESS_TIMEOUT");
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(codedError("PUBLIC_PROCESS_TIMEOUT")), remaining); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function terminatePosixProcessGroup(child, dependencies = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return false;
  const groupPid = -child.pid;
  const killProcess = dependencies.killProcess ?? process.kill;
  const liveness = dependencies.liveness ?? ((pid) => posixProcessGroupAlive(pid, killProcess));
  const delay = dependencies.delay ?? ((milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const pollAttempts = dependencies.pollAttempts ?? 5;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 50;
  if (typeof killProcess !== "function" || typeof liveness !== "function" || typeof delay !== "function"
    || !Number.isSafeInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 20
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 1_000) return false;
  try {
    if (sendPosixGroupSignal(groupPid, "SIGTERM", killProcess) === "gone") return true;
    if (await pollPosixGroupGone(groupPid, liveness, delay, pollAttempts, pollIntervalMs)) return true;
    if (sendPosixGroupSignal(groupPid, "SIGKILL", killProcess) === "gone") return true;
    return await pollPosixGroupGone(groupPid, liveness, delay, pollAttempts, pollIntervalMs);
  } catch {
    return false;
  }
}

function sendPosixGroupSignal(groupPid, signal, killProcess) {
  try {
    killProcess(groupPid, signal);
    return "sent";
  } catch (error) {
    return error?.code === "ESRCH" ? "gone" : "failed";
  }
}

function posixProcessGroupAlive(groupPid, killProcess) {
  try {
    killProcess(groupPid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function pollPosixGroupGone(groupPid, liveness, delay, attempts, intervalMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let alive = true;
    try { alive = await liveness(groupPid); } catch { alive = true; }
    if (alive === false) return true;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  return false;
}

async function abortStartup(child, supervisor, startupHelper) {
  try { supervisor?.cancel(); } catch { /* startup already failed */ }
  if (supervisor === undefined && startupHelper !== undefined) {
    destroyProcessPipes(startupHelper);
    try { startupHelper.kill("SIGKILL"); } catch { /* startup helper may already be gone */ }
  }
  if (child !== undefined) {
    destroyProcessPipes(child);
    try { child.kill("SIGKILL"); } catch { /* gated runner may already be gone */ }
  }
}

function destroyProcessPipes(child) {
  for (const stream of [child?.stdin, child?.stdout, child?.stderr, ...(child?.stdio ?? []).slice(3)]) {
    try { stream?.destroy?.(); } catch { /* cleanup is best effort after bounded termination */ }
  }
  try { child?.unref?.(); } catch { /* cleanup is best effort */ }
}

async function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(code);
    };
    child.once("close", finish);
    const timer = setTimeout(() => finish(null), timeoutMs);
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
