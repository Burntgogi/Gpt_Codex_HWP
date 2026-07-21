import { basename, extname } from "node:path";

import {
  assertPublicContentBuffer,
  createOwnedBoundary,
  walkOwnedRegularFiles,
} from "../../../scripts/public-content-policy.mjs";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_ENTRIES = 20_000;
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".cts", ".js", ".json", ".md", ".mjs", ".mts", ".py", ".ts",
  ".txt", ".yaml", ".yml",
]);
const BINARY_EXTENSIONS = new Set([
  ".bmp", ".dll", ".gif", ".ico", ".jpeg", ".jpg", ".otf", ".png", ".tif", ".tiff",
  ".ttf", ".webp", ".woff", ".woff2",
]);
const TEXT_FILENAMES = new Set([".npmrc", "LICENSE", "NOTICE"]);
const TEXT_RUNTIME_PATHS = new Set(["dist/workers/windows-job-supervisor.ps1"]);

export async function assertPublicRuntimePrivacy(runtimeRoot, limits = {}) {
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const maxRuntimeBytes = limits.maxRuntimeBytes ?? MAX_RUNTIME_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_RUNTIME_ENTRIES;
  assertLimit(maxFileBytes, MAX_FILE_BYTES, "file byte budget");
  assertLimit(maxRuntimeBytes, MAX_RUNTIME_BYTES, "aggregate byte budget");
  assertLimit(maxEntries, MAX_RUNTIME_ENTRIES, "aggregate entry budget");
  let boundary;
  try { boundary = await createOwnedBoundary(runtimeRoot); }
  catch (error) { fail(boundaryCategory(error), "<runtime>"); }
  let aggregateBytes = 0;
  let records;
  try { records = walkOwnedRegularFiles(boundary, { maxEntries, maxFileBytes }); }
  catch (error) { fail(boundaryCategory(error), "<runtime>"); }
  try {
    for await (const record of records) {
    const relativePath = record.label;
    const extension = extname(relativePath).toLowerCase();
    const filename = basename(relativePath);
    aggregateBytes += record.bytes.length;
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
    try {
      assertPublicContentBuffer(record.bytes, { label: relativePath, scope: "runtime" });
    } catch (error) {
      const category = Array.isArray(error?.findings) && error.findings.length > 0
        ? error.findings[0].category
        : "policy failure";
      fail(category, relativePath);
    }
    }
  } catch (error) {
    if (String(error?.message ?? "").startsWith("Runtime privacy violation")) throw error;
    fail(boundaryCategory(error), error?.publicLabel ?? "<runtime>");
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

function boundaryCategory(error) {
  return error?.code === "PUBLIC_FILE_TOO_LARGE" ? "file byte budget"
    : error?.code === "PUBLIC_ENTRY_BUDGET" ? "aggregate entry budget"
      : error?.code === "PUBLIC_SYMBOLIC_LINK" ? "symbolic link" : "non-regular file";
}

function fail(category, relativePath) {
  throw new Error(`Runtime privacy violation (${category}): ${relativePath}`);
}
