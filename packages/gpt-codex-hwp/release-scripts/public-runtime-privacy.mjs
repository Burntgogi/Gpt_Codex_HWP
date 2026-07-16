import { open, lstat, readdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

import { assertPublicContentBuffer } from "../../../scripts/public-content-policy.mjs";

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
const TEXT_FILENAMES = new Set([".npmrc", "LICENSE", "NOTICE"]);
const TEXT_RUNTIME_PATHS = new Set(["dist/workers/windows-job-supervisor.ps1"]);

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
    if (
      !BINARY_EXTENSIONS.has(extension) &&
      !TEXT_EXTENSIONS.has(extension) &&
      !TEXT_FILENAMES.has(filename) &&
      !TEXT_RUNTIME_PATHS.has(relativePath)
    ) {
      fail("unsupported staged extension", relativePath);
    }
    const bytes = await readBounded(path, maxFileBytes, relativePath);
    try {
      assertPublicContentBuffer(bytes, { label: relativePath, scope: "runtime" });
    } catch (error) {
      const category = Array.isArray(error?.findings) && error.findings.length > 0
        ? error.findings[0].category
        : "policy failure";
      fail(category, relativePath);
    }
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
