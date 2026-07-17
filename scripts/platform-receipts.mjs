import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { REQUIRED_RELEASE_STAGES, runReleaseVerification } from "./release-verify.mjs";
import {
  noReplaceGitArguments,
  releaseSubprocessEnvironment,
} from "./release-subprocess-environment.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const TOOLCHAIN_VERSION_PATTERNS = Object.freeze({
  node: /^v22\.22\.2$/u,
  npm: /^10\.9\.7$/u,
  python: /^3\.12\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u,
});
const RUNTIME_ROOT = "plugins/gpt-codex-hwp";
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RUNTIME_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_FILES = 4_096;
const MAX_TRACKED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_FILES = 100_000;

const RECEIPT_KEYS = Object.freeze([
  "arch",
  "commit",
  "fixtureSha256",
  "hwpxRoundTrip",
  "platform",
  "runtimeSha256",
  "schemaVersion",
  "skippedRequiredGates",
  "sourceUnchanged",
  "stages",
  "toolCount",
  "toolchains",
  "tree",
  "version",
]);
const EXPECTATION_KEYS = Object.freeze([
  "arch",
  "commit",
  "platform",
  "runtimeSha256",
  "tree",
  "version",
]);
const RELEASE_RECEIPT_KEYS = Object.freeze([
  "arch",
  "commit",
  "fixtureSha256",
  "node",
  "npm",
  "platform",
  "python",
  "schemaVersion",
  "stages",
  "status",
  "toolCount",
  "tree",
]);
const TOOLCHAIN_KEYS = Object.freeze(["node", "npm", "python"]);
const STAGE_KEYS = Object.freeze(["elapsedMs", "name", "status"]);

export const DEFAULT_PLATFORM_RECEIPT_PATH = "release-receipts/platform-receipt.json";
export const DEFAULT_PLATFORM_CHECKSUM_PATH = "release-receipts/platform-receipt.sha256";
export const PINNED_HWP_FIXTURE_SHA256 =
  "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd";
export const REQUIRED_PLATFORM_STAGES = REQUIRED_RELEASE_STAGES;

export function validatePlatformReceipt(receipt, expected) {
  assertExactObject(receipt, RECEIPT_KEYS, "PLATFORM_RECEIPT_SHAPE_INVALID");
  assertExactObject(expected, EXPECTATION_KEYS, "PLATFORM_RECEIPT_EXPECTATION_INVALID");

  if (receipt.schemaVersion !== 1) {
    throw receiptError("PLATFORM_RECEIPT_SHAPE_INVALID");
  }
  assertIdentity(expected, "PLATFORM_RECEIPT_EXPECTATION_INVALID");
  assertIdentity(receipt, "PLATFORM_RECEIPT_IDENTITY_MISMATCH");
  for (const key of EXPECTATION_KEYS) {
    if (receipt[key] !== expected[key]) {
      throw receiptError("PLATFORM_RECEIPT_IDENTITY_MISMATCH");
    }
  }

  assertExactObject(receipt.toolchains, TOOLCHAIN_KEYS, "PLATFORM_RECEIPT_SHAPE_INVALID");
  for (const key of TOOLCHAIN_KEYS) {
    if (
      typeof receipt.toolchains[key] !== "string"
      || !TOOLCHAIN_VERSION_PATTERNS[key].test(receipt.toolchains[key])
    ) {
      throw receiptError("PLATFORM_RECEIPT_EVIDENCE_INVALID");
    }
  }

  const stages = validateStages(
    receipt.stages,
    "PLATFORM_RECEIPT_GATE_INVALID",
    "PLATFORM_RECEIPT_SHAPE_INVALID",
  );
  if (receipt.skippedRequiredGates !== 0) {
    throw receiptError("PLATFORM_RECEIPT_GATE_INVALID");
  }

  if (
    receipt.toolCount !== 9
    || receipt.fixtureSha256 !== PINNED_HWP_FIXTURE_SHA256
    || receipt.sourceUnchanged !== true
    || receipt.hwpxRoundTrip !== true
  ) {
    throw receiptError("PLATFORM_RECEIPT_EVIDENCE_INVALID");
  }

  return Object.freeze({
    schemaVersion: 1,
    commit: receipt.commit,
    tree: receipt.tree,
    version: receipt.version,
    platform: receipt.platform,
    arch: receipt.arch,
    toolchains: Object.freeze({
      node: receipt.toolchains.node,
      npm: receipt.toolchains.npm,
      python: receipt.toolchains.python,
    }),
    stages: Object.freeze(stages),
    toolCount: 9,
    fixtureSha256: PINNED_HWP_FIXTURE_SHA256,
    sourceUnchanged: true,
    hwpxRoundTrip: true,
    runtimeSha256: receipt.runtimeSha256,
    skippedRequiredGates: 0,
  });
}

export function buildPlatformReceipt(releaseReceipt, expected) {
  assertExactObject(releaseReceipt, RELEASE_RECEIPT_KEYS, "PLATFORM_RECEIPT_RELEASE_INVALID");
  if (
    releaseReceipt.schemaVersion !== 2
    || releaseReceipt.status !== "passed"
    || !SHA1_PATTERN.test(releaseReceipt.commit)
    || !SHA1_PATTERN.test(releaseReceipt.tree)
    || releaseReceipt.commit !== expected?.commit
    || releaseReceipt.tree !== expected?.tree
    || releaseReceipt.platform !== expected?.platform
    || releaseReceipt.arch !== expected?.arch
    || releaseReceipt.toolCount !== 9
    || releaseReceipt.fixtureSha256 !== PINNED_HWP_FIXTURE_SHA256
  ) {
    throw receiptError("PLATFORM_RECEIPT_RELEASE_INVALID");
  }
  for (const key of TOOLCHAIN_KEYS) {
    if (
      typeof releaseReceipt[key] !== "string"
      || !TOOLCHAIN_VERSION_PATTERNS[key].test(releaseReceipt[key])
    ) {
      throw receiptError("PLATFORM_RECEIPT_RELEASE_INVALID");
    }
  }
  const stages = validateStages(releaseReceipt.stages, "PLATFORM_RECEIPT_RELEASE_INVALID");
  return validatePlatformReceipt({
    schemaVersion: 1,
    commit: expected.commit,
    tree: expected.tree,
    version: expected.version,
    platform: expected.platform,
    arch: expected.arch,
    toolchains: {
      node: releaseReceipt.node,
      npm: releaseReceipt.npm,
      python: releaseReceipt.python,
    },
    stages,
    toolCount: 9,
    fixtureSha256: PINNED_HWP_FIXTURE_SHA256,
    sourceUnchanged: true,
    hwpxRoundTrip: true,
    runtimeSha256: expected.runtimeSha256,
    skippedRequiredGates: 0,
  }, expected);
}

export async function collectPlatformExpectation(options = {}) {
  const requestedRoot = requiredRoot(options.root ?? PROJECT_ROOT);
  const root = await realpath(requestedRoot).catch(() => undefined);
  if (root === undefined) throw receiptError("PLATFORM_RECEIPT_ROOT_INVALID");
  const expectedCommit = requiredCommit(options.expectedCommit);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!isSupportedPlatform(platform, arch)) {
    throw receiptError("PLATFORM_RECEIPT_PLATFORM_UNSUPPORTED");
  }

  await assertStandardGitSemantics(root);
  const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."]);
  if (status.length !== 0) throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
  await assertPlainTrackedIndex(root);
  const commit = singleGitIdentity(await runGit(root, ["rev-parse", "--verify", "HEAD"]));
  if (commit !== expectedCommit) throw receiptError("PLATFORM_RECEIPT_HEAD_MISMATCH");
  await assertExactHeadWorktree(root, commit);
  const tree = singleGitIdentity(await runGit(root, ["rev-parse", "--verify", `${commit}^{tree}`]));
  const version = await readRepositoryVersionAtCommit(root, commit);
  const runtimeSha256 = await hashTrackedRuntimeAtHead(root, commit);

  const after = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."]);
  if (after.length !== 0) throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
  await assertPlainTrackedIndex(root);
  const afterCommit = singleGitIdentity(await runGit(root, ["rev-parse", "--verify", "HEAD"]));
  if (afterCommit !== commit) throw receiptError("PLATFORM_RECEIPT_SOURCE_CHANGED");
  await assertExactHeadWorktree(root, afterCommit);
  return Object.freeze({ commit, tree, version, platform, arch, runtimeSha256 });
}

export async function createPlatformReceipt(options = {}) {
  const root = requiredRoot(options.root ?? PROJECT_ROOT);
  const expectedCommit = requiredCommit(options.expectedCommit);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runVerification = options.runVerification ?? runReleaseVerification;
  const collectExpectation = options.collectExpectation ?? collectPlatformExpectation;
  if (typeof runVerification !== "function" || typeof collectExpectation !== "function") {
    throw receiptError("PLATFORM_RECEIPT_OPTIONS_INVALID");
  }

  const before = await collectExpectation({ root, expectedCommit, platform, arch });
  const releaseReceipt = await runVerification({ root, platform, arch });
  const after = await collectExpectation({ root, expectedCommit, platform, arch });
  if (!sameExpectation(before, after)) throw receiptError("PLATFORM_RECEIPT_SOURCE_CHANGED");
  const receipt = buildPlatformReceipt(releaseReceipt, after);
  await writeExclusive(
    root,
    DEFAULT_PLATFORM_RECEIPT_PATH,
    Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
    "PLATFORM_RECEIPT_OUTPUT_EXISTS",
  );
  return receipt;
}

export async function verifyPlatformReceiptFile(options = {}) {
  const { validated } = await readAndValidateReceipt(options);
  return validated;
}

export async function writePlatformReceiptChecksum(options = {}) {
  const root = requiredRoot(options.root ?? PROJECT_ROOT);
  const { bytes } = await readAndValidateReceipt({ ...options, root });
  const checksum = `${createHash("sha256").update(bytes).digest("hex")}  platform-receipt.json\n`;
  await writeExclusive(
    root,
    DEFAULT_PLATFORM_CHECKSUM_PATH,
    Buffer.from(checksum, "ascii"),
    "PLATFORM_RECEIPT_CHECKSUM_EXISTS",
  );
  return checksum;
}

async function readAndValidateReceipt(options) {
  const root = requiredRoot(options.root ?? PROJECT_ROOT);
  const expectedCommit = requiredCommit(options.expectedCommit);
  const expected = await (options.collectExpectation ?? collectPlatformExpectation)({
    root,
    expectedCommit,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
  });
  const bytes = await readBoundedFile(
    join(root, ...DEFAULT_PLATFORM_RECEIPT_PATH.split("/")),
    MAX_RECEIPT_BYTES,
    "PLATFORM_RECEIPT_FILE_INVALID",
  );
  let receipt;
  try {
    receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw receiptError("PLATFORM_RECEIPT_FILE_INVALID");
  }
  return Object.freeze({ bytes, validated: validatePlatformReceipt(receipt, expected) });
}

function validateStages(value, code, shapeCode = code) {
  if (!Array.isArray(value) || value.length !== REQUIRED_PLATFORM_STAGES.length) {
    throw receiptError(code);
  }
  return value.map((stage, index) => {
    assertExactObject(stage, STAGE_KEYS, shapeCode);
    if (
      stage.name !== REQUIRED_PLATFORM_STAGES[index]
      || stage.status !== "passed"
      || !Number.isSafeInteger(stage.elapsedMs)
      || stage.elapsedMs < 0
    ) {
      throw receiptError(code);
    }
    return Object.freeze({ name: stage.name, status: stage.status, elapsedMs: stage.elapsedMs });
  });
}

async function readRepositoryVersionAtCommit(root, commit) {
  const bytes = await runGit(root, ["show", `${requiredCommit(commit)}:package.json`], {
    maxOutputBytes: MAX_PACKAGE_BYTES,
  });
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
  }
  if (
    manifest === null
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || typeof manifest.version !== "string"
    || !VERSION_PATTERN.test(manifest.version)
  ) {
    throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
  }
  return manifest.version;
}

export async function hashTrackedRuntimeAtHead(rootValue, commitValue = "HEAD") {
  const root = await realpath(requiredRoot(rootValue)).catch(() => undefined);
  if (root === undefined) throw receiptError("PLATFORM_RECEIPT_ROOT_INVALID");
  const commit = commitValue === "HEAD"
    ? singleGitIdentity(await runGit(root, ["rev-parse", "--verify", "HEAD"]))
    : requiredCommit(commitValue);
  const listing = await runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commit,
    "--",
    RUNTIME_ROOT,
  ]);
  if (listing.length === 0) throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
  const records = [];
  const seen = new Set();
  let offset = 0;
  while (offset < listing.length) {
    const end = listing.indexOf(0, offset);
    if (end < 0) throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    const record = listing.subarray(offset, end);
    offset = end + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^(100644|100755) blob ([a-f0-9]{40})$/u.exec(header);
    if (match === null) throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    let path;
    try { path = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(tab + 1)); }
    catch { throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID"); }
    if (!safeRuntimePath(path) || seen.has(path)) {
      throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    }
    seen.add(path);
    records.push(Object.freeze({ mode: match[1], objectId: match[2], path }));
    if (records.length > MAX_RUNTIME_FILES) throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
  }
  if (records.length === 0) throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");

  const input = Buffer.from(`${records.map((record) => record.objectId).join("\n")}\n`, "ascii");
  const batch = await runGit(root, ["cat-file", "--batch"], {
    input,
    maxOutputBytes: MAX_RUNTIME_TOTAL_BYTES + MAX_GIT_OUTPUT_BYTES,
  });
  const digest = createHash("sha256");
  let batchOffset = 0;
  let totalBytes = 0;
  for (const record of records) {
    const newline = batch.indexOf(0x0a, batchOffset);
    if (newline < 0) throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    const header = batch.subarray(batchOffset, newline).toString("ascii");
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(header);
    if (match === null || match[1] !== record.objectId) {
      throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    }
    const bytes = Number(match[2]);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RUNTIME_FILE_BYTES) {
      throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    }
    const contentStart = newline + 1;
    const contentEnd = contentStart + bytes;
    if (contentEnd >= batch.length || batch[contentEnd] !== 0x0a) {
      throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    }
    const content = batch.subarray(contentStart, contentEnd);
    batchOffset = contentEnd + 1;
    totalBytes += content.length;
    if (totalBytes > MAX_RUNTIME_TOTAL_BYTES) {
      throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
    }
    digest.update(record.mode, "ascii");
    digest.update("\0", "ascii");
    digest.update(record.path, "utf8");
    digest.update("\0", "ascii");
    digest.update(String(content.length), "ascii");
    digest.update("\0", "ascii");
    digest.update(createHash("sha256").update(content).digest("hex"), "ascii");
    digest.update("\n", "ascii");
  }
  if (batchOffset !== batch.length) throw receiptError("PLATFORM_RECEIPT_RUNTIME_INVALID");
  return digest.digest("hex");
}

async function assertPlainTrackedIndex(root) {
  await assertPlainTrackedFlags(root, "-v");
  await assertPlainTrackedFlags(root, "-f");
}

async function assertPlainTrackedFlags(root, flag) {
  const listing = await runGit(root, ["ls-files", flag, "-z", "--", "."]);
  if (listing.length === 0 || listing.at(-1) !== 0) {
    throw receiptError("PLATFORM_RECEIPT_INDEX_INVALID");
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(listing.subarray(0, -1)); }
  catch { throw receiptError("PLATFORM_RECEIPT_INDEX_INVALID"); }
  const records = text.split("\0");
  if (
    records.length === 0
    || records.length > MAX_TRACKED_FILES
    || new Set(records).size !== records.length
    || records.some((record) => !record.startsWith("H ") || !safeTrackedPath(record.slice(2)))
  ) {
    throw receiptError("PLATFORM_RECEIPT_INDEX_INVALID");
  }
}

async function assertExactHeadWorktree(root, commit) {
  const headRecords = parseHeadRecords(await runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    requiredCommit(commit),
  ]));
  const indexRecords = parseIndexRecords(await runGit(root, [
    "ls-files",
    "--stage",
    "-z",
    "--",
    ".",
  ]));
  if (headRecords.length !== indexRecords.size) {
    throw receiptError("PLATFORM_RECEIPT_INDEX_INVALID");
  }
  for (const record of headRecords) {
    const indexRecord = indexRecords.get(record.path);
    if (indexRecord?.mode !== record.mode || indexRecord?.objectId !== record.objectId) {
      throw receiptError("PLATFORM_RECEIPT_INDEX_INVALID");
    }
  }

  const input = Buffer.from(`${headRecords.map((record) => record.objectId).join("\n")}\n`, "ascii");
  const batch = await runGit(root, ["cat-file", "--batch"], {
    input,
    maxOutputBytes: MAX_TRACKED_TOTAL_BYTES + MAX_GIT_OUTPUT_BYTES,
  });
  let batchOffset = 0;
  let totalBytes = 0;
  for (const record of headRecords) {
    const newline = batch.indexOf(0x0a, batchOffset);
    if (newline < 0) throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
    const header = batch.subarray(batchOffset, newline).toString("ascii");
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(header);
    if (match === null || match[1] !== record.objectId) {
      throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
    }
    const bytes = Number(match[2]);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_TRACKED_FILE_BYTES) {
      throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
    }
    const contentStart = newline + 1;
    const contentEnd = contentStart + bytes;
    if (contentEnd >= batch.length || batch[contentEnd] !== 0x0a) {
      throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
    }
    batchOffset = contentEnd + 1;
    totalBytes += bytes;
    if (totalBytes > MAX_TRACKED_TOTAL_BYTES) {
      throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
    }
    const worktreeBytes = await readTrackedWorktreeFile(root, record.path, bytes, record.mode);
    if (!worktreeBytes.equals(batch.subarray(contentStart, contentEnd))) {
      throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
    }
  }
  if (batchOffset !== batch.length) throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
}

function parseHeadRecords(listing) {
  const records = parseNulRecords(listing, "PLATFORM_RECEIPT_REPOSITORY_INVALID");
  const parsed = [];
  const seen = new Set();
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
    const match = /^(100644|100755) blob ([a-f0-9]{40})$/u.exec(
      record.subarray(0, tab).toString("ascii"),
    );
    const path = decodeTrackedPath(
      record.subarray(tab + 1),
      "PLATFORM_RECEIPT_REPOSITORY_INVALID",
    );
    if (match === null || seen.has(path)) {
      throw receiptError("PLATFORM_RECEIPT_REPOSITORY_INVALID");
    }
    seen.add(path);
    parsed.push(Object.freeze({ mode: match[1], objectId: match[2], path }));
  }
  return parsed;
}

function parseIndexRecords(listing) {
  const records = parseNulRecords(listing, "PLATFORM_RECEIPT_INDEX_INVALID");
  const parsed = new Map();
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw receiptError("PLATFORM_RECEIPT_INDEX_INVALID");
    const match = /^(100644|100755) ([a-f0-9]{40}) 0$/u.exec(
      record.subarray(0, tab).toString("ascii"),
    );
    const path = decodeTrackedPath(record.subarray(tab + 1), "PLATFORM_RECEIPT_INDEX_INVALID");
    if (match === null || parsed.has(path)) {
      throw receiptError("PLATFORM_RECEIPT_INDEX_INVALID");
    }
    parsed.set(path, Object.freeze({ mode: match[1], objectId: match[2] }));
  }
  return parsed;
}

function parseNulRecords(listing, code) {
  if (listing.length === 0 || listing.at(-1) !== 0) throw receiptError(code);
  const records = [];
  let offset = 0;
  while (offset < listing.length) {
    const end = listing.indexOf(0, offset);
    if (end <= offset) throw receiptError(code);
    records.push(listing.subarray(offset, end));
    if (records.length > MAX_TRACKED_FILES) throw receiptError(code);
    offset = end + 1;
  }
  return records;
}

function decodeTrackedPath(bytes, code) {
  let path;
  try { path = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw receiptError(code); }
  if (!safeTrackedPath(path)) throw receiptError(code);
  return path;
}

async function readTrackedWorktreeFile(root, path, expectedBytes, expectedMode) {
  const pathParts = path.split("/");
  const absolutePath = resolve(root, ...pathParts);
  if (!insideRoot(root, absolutePath)) throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
  let handle;
  try {
    const ancestorsBefore = await trackedAncestorStates(root, pathParts);
    const pathBefore = await lstat(absolutePath);
    const resolvedBefore = await realpath(absolutePath);
    if (
      !pathBefore.isFile()
      || pathBefore.size !== expectedBytes
      || !worktreeModeMatches(pathBefore.mode, expectedMode)
      || !insideRoot(root, resolvedBefore)
    ) {
      throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
    }
    handle = await open(absolutePath, "r");
    const before = await handle.stat();
    if (
      !sameFileState(pathBefore, before)
      || !await sameTrackedAncestorStates(root, pathParts, ancestorsBefore)
    ) {
      throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
    }
    const buffer = Buffer.alloc(expectedBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const pathAfter = await lstat(absolutePath);
    const resolvedAfter = await realpath(absolutePath);
    if (
      bytesRead !== expectedBytes
      || !sameFileState(before, after)
      || !sameFileState(after, pathAfter)
      || !sameResolvedPath(resolvedBefore, resolvedAfter)
      || !insideRoot(root, resolvedAfter)
      || !await sameTrackedAncestorStates(root, pathParts, ancestorsBefore)
    ) {
      throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
    }
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error?.code === "PLATFORM_RECEIPT_SOURCE_DIRTY") throw error;
    throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function trackedAncestorStates(root, pathParts) {
  const states = [];
  let ancestorPath = root;
  for (let index = 0; index < pathParts.length; index += 1) {
    const state = await lstat(ancestorPath);
    const resolvedPath = await realpath(ancestorPath);
    if (
      !state.isDirectory()
      || state.isSymbolicLink()
      || !sameResolvedPath(ancestorPath, resolvedPath)
      || !insideRoot(root, resolvedPath)
    ) {
      throw receiptError("PLATFORM_RECEIPT_SOURCE_DIRTY");
    }
    states.push(state);
    ancestorPath = resolve(ancestorPath, pathParts[index]);
  }
  return states;
}

async function sameTrackedAncestorStates(root, pathParts, expectedStates) {
  const actualStates = await trackedAncestorStates(root, pathParts);
  return actualStates.length === expectedStates.length
    && actualStates.every((state, index) => sameDirectoryIdentity(state, expectedStates[index]));
}

function sameDirectoryIdentity(left, right) {
  return left.isDirectory()
    && right.isDirectory()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameFileState(left, right) {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function worktreeModeMatches(mode, expectedMode) {
  return process.platform === "win32"
    || ((mode & 0o111) !== 0) === (expectedMode === "100755");
}

async function assertStandardGitSemantics(root) {
  const shallow = await runGit(root, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.toString("ascii") !== "false\n") {
    throw receiptError("PLATFORM_RECEIPT_REPOSITORY_SEMANTICS_INVALID");
  }
  const replacements = await runGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace",
  ]);
  if (replacements.length !== 0) {
    throw receiptError("PLATFORM_RECEIPT_REPOSITORY_SEMANTICS_INVALID");
  }
  const graftResult = await runGit(root, ["rev-parse", "--git-path", "info/grafts"]);
  let graftPath;
  try { graftPath = new TextDecoder("utf-8", { fatal: true }).decode(graftResult).trim(); }
  catch { throw receiptError("PLATFORM_RECEIPT_REPOSITORY_SEMANTICS_INVALID"); }
  if (graftPath.length === 0 || graftPath.length > 4_096 || /[\r\n\0]/u.test(graftPath)) {
    throw receiptError("PLATFORM_RECEIPT_REPOSITORY_SEMANTICS_INVALID");
  }
  try {
    await lstat(resolve(root, graftPath));
    throw receiptError("PLATFORM_RECEIPT_REPOSITORY_SEMANTICS_INVALID");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readBoundedFile(path, maximumBytes, code) {
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > maximumBytes) {
      throw receiptError(code);
    }
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino
      || after.dev !== before.dev
    ) {
      throw receiptError(code);
    }
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error?.code === code) throw error;
    throw receiptError(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function runGit(root, args, options = {}) {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
  const input = options.input;
  if (
    !Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 1
    || maxOutputBytes > MAX_RUNTIME_TOTAL_BYTES + MAX_GIT_OUTPUT_BYTES
    || (input !== undefined && !Buffer.isBuffer(input))
  ) {
    throw receiptError("PLATFORM_RECEIPT_GIT_INVALID");
  }
  return await new Promise((resolvePromise, reject) => {
    const child = execFile("git", noReplaceGitArguments(args), {
      cwd: root,
      encoding: "buffer",
      env: releaseSubprocessEnvironment(),
      maxBuffer: maxOutputBytes,
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (
        error !== null
        || !Buffer.isBuffer(stdout)
        || !Buffer.isBuffer(stderr)
        || stderr.length !== 0
      ) {
        reject(receiptError("PLATFORM_RECEIPT_GIT_INVALID"));
        return;
      }
      resolvePromise(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function writeExclusive(root, relativePath, bytes, existsCode) {
  try {
    const canonicalRoot = await realpath(root);
    const outputRoot = resolve(canonicalRoot, "release-receipts");
    const outputPath = resolve(canonicalRoot, ...relativePath.split("/"));
    if (!insideRoot(outputRoot, outputPath) || dirname(outputPath) !== outputRoot) {
      throw receiptError("PLATFORM_RECEIPT_OUTPUT_INVALID");
    }
    try {
      await mkdir(outputRoot, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const outputRootIdentity = await assertReceiptOutputDirectory(canonicalRoot, outputRoot);
    await assertReceiptOutputDirectory(canonicalRoot, outputRoot, outputRootIdentity);
    const handle = await open(outputPath, "wx", 0o600);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw receiptError("PLATFORM_RECEIPT_OUTPUT_INVALID");
      await assertReceiptOutputDirectory(canonicalRoot, outputRoot, outputRootIdentity);
      try {
        await handle.writeFile(bytes);
      } finally {
        await assertReceiptOutputDirectory(canonicalRoot, outputRoot, outputRootIdentity);
      }
      const written = await handle.stat();
      const pathAfter = await lstat(outputPath);
      if (
        written.size !== bytes.length
        || pathAfter.size !== bytes.length
        || !sameRegularFileIdentity(opened, written)
        || !sameRegularFileIdentity(written, pathAfter)
      ) {
        throw receiptError("PLATFORM_RECEIPT_OUTPUT_INVALID");
      }
      await assertReceiptOutputDirectory(canonicalRoot, outputRoot, outputRootIdentity);
    }
    finally { await handle.close(); }
    await assertReceiptOutputDirectory(canonicalRoot, outputRoot, outputRootIdentity);
  } catch (error) {
    if (error?.code === "EEXIST") throw receiptError(existsCode);
    if (error?.code === existsCode) throw error;
    throw receiptError("PLATFORM_RECEIPT_OUTPUT_INVALID");
  }
}

async function assertReceiptOutputDirectory(canonicalRoot, outputRoot, expectedIdentity) {
  const before = await lstat(outputRoot);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw receiptError("PLATFORM_RECEIPT_OUTPUT_INVALID");
  }
  const resolved = await realpath(outputRoot);
  const after = await lstat(outputRoot);
  if (
    !sameOutputDirectoryIdentity(before, after)
    || (expectedIdentity !== undefined
      && !sameOutputDirectoryIdentity(expectedIdentity, after))
    || !sameResolvedPath(outputRoot, resolved)
    || !insideRoot(canonicalRoot, resolved)
  ) {
    throw receiptError("PLATFORM_RECEIPT_OUTPUT_INVALID");
  }
  return before;
}

function sameOutputDirectoryIdentity(left, right) {
  return left.isDirectory()
    && right.isDirectory()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs;
}

function sameRegularFileIdentity(left, right) {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs;
}

function singleGitIdentity(bytes) {
  const value = bytes.toString("ascii").trim();
  if (!SHA1_PATTERN.test(value)) throw receiptError("PLATFORM_RECEIPT_GIT_INVALID");
  return value;
}

function safeRuntimePath(path) {
  return path.startsWith(`${RUNTIME_ROOT}/`)
    && path.length <= 4_096
    && !path.includes("\\")
    && !path.includes("\0")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function safeTrackedPath(path) {
  return typeof path === "string"
    && path.length > 0
    && path.length <= 4_096
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && !path.startsWith("/")
    && !/^[A-Za-z]:/u.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function insideRoot(root, path) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (process.platform === "win32") {
    const lowerRoot = normalizedRoot.toLowerCase();
    const lowerPath = normalizedPath.toLowerCase();
    return lowerPath === lowerRoot || lowerPath.startsWith(`${lowerRoot}${sep.toLowerCase()}`);
  }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function sameResolvedPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameExpectation(left, right) {
  return EXPECTATION_KEYS.every((key) => left[key] === right[key]);
}

function assertIdentity(value, code) {
  if (
    !SHA1_PATTERN.test(value.commit)
    || !SHA1_PATTERN.test(value.tree)
    || !VERSION_PATTERN.test(value.version)
    || !SHA256_PATTERN.test(value.runtimeSha256)
    || !isSupportedPlatform(value.platform, value.arch)
  ) {
    throw receiptError(code);
  }
}

function isSupportedPlatform(platform, arch) {
  return (platform === "win32" && arch === "x64")
    || (platform === "darwin" && arch === "arm64");
}

function assertExactObject(value, expectedKeys, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw receiptError(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw receiptError(code);
  }
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length) throw receiptError(code);
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (actualKeys[index] !== expectedKeys[index]) throw receiptError(code);
  }
}

function requiredRoot(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw receiptError("PLATFORM_RECEIPT_ROOT_INVALID");
  }
  return resolve(value);
}

function requiredCommit(value) {
  if (typeof value !== "string" || !SHA1_PATTERN.test(value)) {
    throw receiptError("PLATFORM_RECEIPT_EXPECTED_HEAD_INVALID");
  }
  return value;
}

function receiptError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function runPlatformReceiptCli(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const root = options.root ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  if (!Array.isArray(args) || args.length !== 1) {
    stderr.write("PLATFORM_RECEIPT_USAGE\n");
    setExitCode(1);
    return undefined;
  }
  const common = { root, expectedCommit: env.EXPECTED_HEAD_SHA };
  try {
    let result;
    if (args[0] === "create") {
      result = await createPlatformReceipt(common);
      stdout.write("PLATFORM_RECEIPT_CREATED\n");
    } else if (args[0] === "verify") {
      result = await verifyPlatformReceiptFile(common);
      stdout.write("PLATFORM_RECEIPT_VERIFIED\n");
    } else if (args[0] === "checksum") {
      result = await writePlatformReceiptChecksum(common);
      stdout.write("PLATFORM_RECEIPT_CHECKSUM_CREATED\n");
    } else {
      throw receiptError("PLATFORM_RECEIPT_USAGE");
    }
    setExitCode(0);
    return result;
  } catch (error) {
    const code = typeof error?.code === "string" && /^PLATFORM_RECEIPT_[A-Z_]+$/u.test(error.code)
      ? error.code
      : "PLATFORM_RECEIPT_FAILED";
    stderr.write(`${code}\n`);
    setExitCode(1);
    return undefined;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runPlatformReceiptCli();
}
