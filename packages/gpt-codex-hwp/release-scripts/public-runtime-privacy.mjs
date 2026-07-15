import { open, lstat, readdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".cts", ".js", ".json", ".md", ".mjs", ".mts", ".py", ".ts",
  ".txt", ".yaml", ".yml",
]);
const BINARY_EXTENSIONS = new Set([
  ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".otf", ".png", ".tif", ".tiff",
  ".ttf", ".webp", ".woff", ".woff2",
]);
const TEXT_FILENAMES = new Set(["LICENSE", "NOTICE"]);
const PLACEHOLDER_USERS = new Set(["example", "user", "username", "your-user", "your_username"]);

export async function assertPublicRuntimePrivacy(runtimeRoot, limits = {}) {
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const maxRuntimeBytes = limits.maxRuntimeBytes ?? MAX_RUNTIME_BYTES;
  assertLimit(maxFileBytes, MAX_FILE_BYTES, "file byte budget");
  assertLimit(maxRuntimeBytes, MAX_RUNTIME_BYTES, "aggregate byte budget");
  const files = await regularFiles(runtimeRoot, runtimeRoot);
  let aggregateBytes = 0;
  for (const path of files) {
    const relativePath = relative(runtimeRoot, path).replaceAll("\\", "/");
    const extension = extname(path).toLowerCase();
    const filename = basename(path);
    const metadata = await lstat(path);
    aggregateBytes += metadata.size;
    if (metadata.size > maxFileBytes) fail("file byte budget", relativePath);
    if (aggregateBytes > maxRuntimeBytes) fail("aggregate byte budget", relativePath);
    if (extension === ".map") fail("source map", relativePath);
    if (BINARY_EXTENSIONS.has(extension)) continue;
    if (!TEXT_EXTENSIONS.has(extension) && !TEXT_FILENAMES.has(filename)) {
      fail("unsupported staged extension", relativePath);
    }
    const text = (await readBounded(path, maxFileBytes, relativePath)).toString("utf8");
    if (hasConcreteHomePath(text)) fail("personal home path", relativePath);
    if (hasPrivateKeyHeader(text)) {
      fail("private key", relativePath);
    }
    if (hasLiteralCredentialAssignment(text)) fail("literal credential", relativePath);
  }
}

async function regularFiles(root, runtimeRoot) {
  const result = [];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    const relativePath = relative(runtimeRoot, path).replaceAll("\\", "/");
    const kind = classifyRuntimeEntryForTest(metadata);
    if (kind === "symbolic-link") fail("symbolic link", relativePath);
    if (kind === "directory") result.push(...await regularFiles(path, runtimeRoot));
    else if (kind === "file") result.push(path);
    else fail("non-regular file", relativePath);
  }
  return result;
}

async function readBounded(path, limit, relativePath) {
  const handle = await open(path, "r");
  try {
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) fail("file byte budget", relativePath);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function hasConcreteHomePath(text) {
  for (const match of text.matchAll(/[A-Za-z]:[\\/]+users[\\/]+([^\\/\s"']+)/giu)) {
    if (!isPlaceholderUser(match[1])) return true;
  }

  const exemptRanges = [
    ...matchRanges(text, /https?:\/\/[^\s"'`<>]+/giu),
    ...matchRanges(
      text,
      /\b(?:app|router|server)\s*\.\s*(?:get|post|put|patch|delete|use|all)\s*\(\s*(?:"[^"\r\n]*"|'[^'\r\n]*')/giu,
    ),
  ];
  for (const match of text.matchAll(/\/+(?:users|home)\/+([^/\s"']+)/giu)) {
    if (isPlaceholderUser(match[1])) continue;
    if (exemptRanges.some(([start, end]) => match.index >= start && match.index < end)) continue;
    return true;
  }
  return false;
}

function isPlaceholderUser(user) {
  const normalized = user.toLowerCase();
  return PLACEHOLDER_USERS.has(normalized) || /^[<{$%]/u.test(normalized);
}

function matchRanges(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

function hasLiteralCredentialAssignment(text) {
  const assignment = /(?:^|[\s,{;])["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n]+))/gmu;
  for (const match of text.matchAll(assignment)) {
    if (!isCredentialKey(match[1])) continue;
    const value = match[2] ?? match[3] ?? match[4];
    if (isAllowedCredentialReference(value)) continue;
    return true;
  }
  return hasLiteralEnvironmentAssignment(text);
}

function hasLiteralEnvironmentAssignment(text) {
  const assignments = [
    /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n]+))/gu,
    /\bprocess\.env\s*\[\s*["']([^"']+)["']\s*\]\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n]+))/gu,
    /\bos\.environ\s*\[\s*["']([^"']+)["']\s*\]\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n]+))/gu,
    /\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;\r\n]+))/giu,
  ];
  for (const assignment of assignments) {
    for (const match of text.matchAll(assignment)) {
      if (!isCredentialKey(match[1])) continue;
      const value = match[2] ?? match[3] ?? match[4];
      if (!isAllowedCredentialReference(value)) return true;
    }
  }
  return false;
}

function isAllowedCredentialReference(value) {
  return /^(?:<[^>]+>|\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|\$env:[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|\{env:[A-Z_][A-Z0-9_]*\}|REDACTED|YOUR[_-]|PLACEHOLDER|EXAMPLE|process\.env\.|Deno\.env\.|os\.environ)/iu.test(value);
}

function isCredentialKey(key) {
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  return ["apikey", "privatekey", "secretaccesskey", "token", "secret", "password"]
    .some((suffix) => normalized.endsWith(suffix));
}

function hasPrivateKeyHeader(text) {
  return /-{4,5}\s*BEGIN\s+(?:(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE KEY|PGP\s+PRIVATE KEY BLOCK|SSH2\s+ENCRYPTED PRIVATE KEY)\s*-{4,5}/iu.test(text);
}

function assertLimit(value, maximum, category) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(category, "<runtime>");
  }
}

export function classifyRuntimeEntryForTest(metadata) {
  if (metadata.isSymbolicLink()) return "symbolic-link";
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  return "non-regular";
}

function fail(category, relativePath) {
  throw new Error(`Runtime privacy violation (${category}): ${relativePath}`);
}
