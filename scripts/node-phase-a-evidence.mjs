import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const LOGICAL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/u;
const RELATIVE_PATH_PATTERN = /^files\/[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?\.(?:json|md|txt|log)$/u;
const ALLOWED_EXTENSIONS = new Set([".json", ".md", ".txt", ".log"]);
const ENTRY_KEYS = Object.freeze([
  "bytes",
  "logicalName",
  "relativePath",
  "schemaVersion",
  "sha256",
]);
const PRIVATE_KEY_PATTERN = /^(?:sourcePath|absolutePath|allowedRoot|cwd|env|environment|hostname|hostName|pid|processId|userName|username|.*(?:api.?key|access.?key|secret|token|credential|password).*)$/iu;
const PRIVATE_VALUE_PATTERN = /^(?:[a-z]:[\\/]|\\\\|\/)|[\\/](?:Users|home)[\\/]/iu;

function evidenceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function assertPrivacySafeValue(value, key = "manifest", depth = 0) {
  if (depth > 12) throw evidenceError("EVIDENCE_MANIFEST_UNSAFE");
  if (PRIVATE_KEY_PATTERN.test(key)) throw evidenceError("EVIDENCE_MANIFEST_UNSAFE");
  if (typeof value === "string") {
    if (PRIVATE_VALUE_PATTERN.test(value) || value.includes("..\\") || value.includes("../")) {
      throw evidenceError("EVIDENCE_MANIFEST_UNSAFE");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw evidenceError("EVIDENCE_MANIFEST_UNSAFE");
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertPrivacySafeValue(entry, key, depth + 1);
    return;
  }
  if (!isPlainObject(value)) throw evidenceError("EVIDENCE_MANIFEST_UNSAFE");
  for (const [childKey, childValue] of Object.entries(value)) {
    assertPrivacySafeValue(childValue, childKey, depth + 1);
  }
}

export function assertPrivacySafeManifest(manifest) {
  assertPrivacySafeValue(manifest);
  return manifest;
}

function safeLogicalFilename(logicalName, sourcePath) {
  if (typeof logicalName !== "string" || !LOGICAL_NAME_PATTERN.test(logicalName)) {
    throw evidenceError("EVIDENCE_LOGICAL_NAME_INVALID");
  }
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw evidenceError("EVIDENCE_SOURCE_INVALID");
  }
  const extension = extname(sourcePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw evidenceError("EVIDENCE_SOURCE_EXTENSION_INVALID");
  return `${logicalName}${extension}`;
}

function validateFreezeSpec(spec) {
  if (!hasExactKeys(spec, ["entries", "metadata"]) || !isPlainObject(spec.metadata)
    || spec.metadata.schemaVersion !== 1 || !Array.isArray(spec.entries)
    || spec.entries.length === 0 || spec.entries.length > 128) {
    throw evidenceError("EVIDENCE_SPEC_INVALID");
  }
  if (!REVISION_PATTERN.test(spec.metadata.controlRevision)
    || !REVISION_PATTERN.test(spec.metadata.candidateRevision)) {
    throw evidenceError("EVIDENCE_SPEC_INVALID");
  }
  assertPrivacySafeManifest(spec.metadata);
  const names = new Set();
  for (const item of spec.entries) {
    if (!hasExactKeys(item, ["expectedSha256", "logicalName", "schemaVersion", "sourcePath"])
      || item.schemaVersion !== 1 || typeof item.sourcePath !== "string"
      || !SHA256_PATTERN.test(item.expectedSha256)) {
      throw evidenceError("EVIDENCE_SPEC_INVALID");
    }
    safeLogicalFilename(item.logicalName, item.sourcePath);
    if (names.has(item.logicalName)) throw evidenceError("EVIDENCE_SPEC_DUPLICATE");
    names.add(item.logicalName);
  }
  return spec;
}

function validateManifest(manifest) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 1
    || !REVISION_PATTERN.test(manifest.controlRevision)
    || !REVISION_PATTERN.test(manifest.candidateRevision)
    || !Array.isArray(manifest.entries) || manifest.entries.length === 0
    || manifest.entries.length > 128) {
    throw evidenceError("EVIDENCE_MANIFEST_INVALID");
  }
  assertPrivacySafeManifest(manifest);
  const names = new Set();
  const paths = new Set();
  for (const entry of manifest.entries) {
    if (!hasExactKeys(entry, ENTRY_KEYS) || entry.schemaVersion !== 1
      || !LOGICAL_NAME_PATTERN.test(entry.logicalName)
      || !RELATIVE_PATH_PATTERN.test(entry.relativePath)
      || !entry.relativePath.startsWith(`files/${entry.logicalName}.`)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !SHA256_PATTERN.test(entry.sha256)) {
      throw evidenceError("EVIDENCE_MANIFEST_INVALID");
    }
    if (names.has(entry.logicalName) || paths.has(entry.relativePath)) {
      throw evidenceError("EVIDENCE_MANIFEST_INVALID");
    }
    names.add(entry.logicalName);
    paths.add(entry.relativePath);
  }
  return manifest;
}

async function assertRegularFile(path) {
  const status = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") throw evidenceError("EVIDENCE_FILE_MISSING");
    throw error;
  });
  if (!status.isFile() || status.isSymbolicLink()) throw evidenceError("EVIDENCE_FILE_INVALID");
  return status;
}

export async function freezeEvidenceBundle({ spec, outputRoot }) {
  validateFreezeSpec(spec);
  if (typeof outputRoot !== "string" || outputRoot.length === 0) {
    throw evidenceError("EVIDENCE_OUTPUT_INVALID");
  }
  const finalRoot = resolve(outputRoot);
  const parent = dirname(finalRoot);
  const stage = `${finalRoot}.stage-${randomUUID()}`;
  const lockPath = `${finalRoot}.freeze.lock`;
  await mkdir(parent, { recursive: true });
  const lock = await open(lockPath, "wx").catch((error) => {
    if (error?.code === "EEXIST") throw evidenceError("EVIDENCE_OUTPUT_LOCKED");
    throw error;
  });
  try {
    const existing = await lstat(finalRoot).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) throw evidenceError("EVIDENCE_OUTPUT_EXISTS");
    await mkdir(join(stage, "files"), { recursive: true });
    const entries = [];
    for (const item of spec.entries) {
      await assertRegularFile(item.sourcePath);
      const bytes = await readFile(item.sourcePath);
      const actualHash = sha256(bytes);
      if (actualHash !== item.expectedSha256) throw evidenceError("EVIDENCE_HASH_MISMATCH");
      const filename = safeLogicalFilename(item.logicalName, item.sourcePath);
      const relativePath = `files/${filename}`;
      await writeFile(join(stage, "files", filename), bytes, { flag: "wx" });
      entries.push(Object.freeze({
        logicalName: item.logicalName,
        relativePath,
        bytes: bytes.length,
        sha256: actualHash,
        schemaVersion: item.schemaVersion,
      }));
    }
    const manifest = Object.freeze({
      ...spec.metadata,
      entries: Object.freeze(entries),
    });
    validateManifest(manifest);
    await writeFile(
      join(stage, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(stage, finalRoot);
    return manifest;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function verifyEvidenceBundle({ bundleRoot }) {
  if (typeof bundleRoot !== "string" || bundleRoot.length === 0) {
    throw evidenceError("EVIDENCE_BUNDLE_INVALID");
  }
  const root = resolve(bundleRoot);
  await assertRegularFile(join(root, "manifest.json"));
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  } catch (error) {
    if (error?.code?.startsWith?.("EVIDENCE_")) throw error;
    throw evidenceError("EVIDENCE_MANIFEST_INVALID");
  }
  validateManifest(manifest);
  const expectedFilenames = new Set(manifest.entries.map(({ relativePath }) => relativePath.slice(6)));
  const actualFilenames = await readdir(join(root, "files")).catch(() => {
    throw evidenceError("EVIDENCE_FILE_MISSING");
  });
  if (actualFilenames.length !== expectedFilenames.size
    || actualFilenames.some((name) => !expectedFilenames.has(name))) {
    throw evidenceError("EVIDENCE_FILE_SET_MISMATCH");
  }
  for (const entry of manifest.entries) {
    const path = join(root, ...entry.relativePath.split("/"));
    const status = await assertRegularFile(path);
    if (status.size !== entry.bytes) throw evidenceError("EVIDENCE_HASH_MISMATCH");
    const bytes = await readFile(path);
    if (sha256(bytes) !== entry.sha256) throw evidenceError("EVIDENCE_HASH_MISMATCH");
  }
  return Object.freeze({
    ...manifest,
    entries: Object.freeze(manifest.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

function parseCli(arguments_) {
  const [command, ...rest] = arguments_;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!/^--[a-z-]+$/u.test(key ?? "") || typeof value !== "string" || values.has(key)) {
      throw evidenceError("EVIDENCE_USAGE_INVALID");
    }
    values.set(key, value);
  }
  if (command === "freeze" && values.size === 2 && values.has("--spec") && values.has("--output")) {
    return { command, spec: values.get("--spec"), output: values.get("--output") };
  }
  if (command === "verify" && values.size === 1 && values.has("--bundle")) {
    return { command, bundle: values.get("--bundle") };
  }
  throw evidenceError("EVIDENCE_USAGE_INVALID");
}

export async function runEvidenceCli(arguments_, io = process) {
  const request = parseCli(arguments_);
  if (request.command === "freeze") {
    const spec = JSON.parse(await readFile(request.spec, "utf8"));
    const manifest = await freezeEvidenceBundle({ spec, outputRoot: request.output });
    io.stdout.write(`EVIDENCE_BUNDLE_OK entries=${manifest.entries.length}\n`);
    return 0;
  }
  const manifest = await verifyEvidenceBundle({ bundleRoot: request.bundle });
  io.stdout.write(`EVIDENCE_BUNDLE_OK entries=${manifest.entries.length}\n`);
  return 0;
}

async function main() {
  try {
    process.exitCode = await runEvidenceCli(process.argv.slice(2));
  } catch (error) {
    const code = typeof error?.code === "string" && error.code.startsWith("EVIDENCE_")
      ? error.code
      : "EVIDENCE_INTERNAL_ERROR";
    process.stderr.write(`EVIDENCE_BUNDLE_FAILED code=${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
