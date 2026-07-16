import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const KORDOC_SOURCE = Object.freeze({
  name: "kordoc",
  version: "3.18.1",
  resolved: "https://registry.npmjs.org/kordoc/-/kordoc-3.18.1.tgz",
  integrity: "sha512-/SrgNK9RKnz1wdlhOvBeJi6+pNSO+vZeBHMxKd8TvfIkuinQBpwbE+W76TGNsMC7bxx2NJhNQAJPqCyD5ltiGA==",
});

export const KORDOC_GENERATOR_VERSION = 2;
export const KORDOC_LIMITS = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  entries: 512,
});
export const KORDOC_PACKAGE_FIELDS = Object.freeze([
  "name",
  "version",
  "description",
  "type",
  "exports",
  "main",
  "module",
  "types",
  "files",
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "engines",
  "author",
  "license",
  "repository",
]);

const TOP_LEVEL = Object.freeze(["dist", "LICENSE", "package.json", "PROVENANCE.json", "README.md"]);
const PROVENANCE_FIELDS = Object.freeze(["schemaVersion", "generatorVersion", "source", "archive", "files"]);
const MAX_TOTAL_FILE_BYTES = KORDOC_LIMITS.expandedBytes;

export function kordocPackageSubset(source) {
  return Object.fromEntries(
    KORDOC_PACKAGE_FIELDS
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  );
}

export async function kordocFileRecords(vendorRoot, excluded = new Set()) {
  const boundary = await createBoundary(vendorRoot);
  return fileRecords(boundary, excluded);
}

export async function verifyKordocCoreRuntime(vendorRoot, expectedSource = KORDOC_SOURCE) {
  const boundary = await createBoundary(vendorRoot);
  const topLevel = await ownedDirectoryEntries(boundary, "", { entries: 0 });
  assertSame(topLevel, [...TOP_LEVEL].sort(comparePaths), "top-level entries");

  const packageJson = JSON.parse(new TextDecoder().decode(
    await readOwnedFile(boundary, "package.json", 1024 * 1024),
  ));
  assertSame(
    Object.keys(packageJson),
    KORDOC_PACKAGE_FIELDS.filter((field) => packageJson[field] !== undefined),
    "package fields",
  );
  if (packageJson.name !== expectedSource.name || packageJson.version !== expectedSource.version) {
    throw new Error("Vendored Kordoc identity is invalid.");
  }
  if (packageJson.license !== "MIT") throw new Error("Vendored Kordoc license must be MIT.");

  const provenance = JSON.parse(new TextDecoder().decode(
    await readOwnedFile(boundary, "PROVENANCE.json", 1024 * 1024),
  ));
  assertSame(Object.keys(provenance), PROVENANCE_FIELDS, "provenance fields");
  if (provenance.schemaVersion !== 2) throw new Error("Unsupported provenance schema.");
  if (provenance.generatorVersion !== KORDOC_GENERATOR_VERSION) {
    throw new Error("Unsupported provenance generator version.");
  }
  assertSame(provenance.source, expectedSource, "provenance source");
  assertSame(Object.keys(provenance.archive ?? {}), ["sha512"], "provenance archive fields");
  if (provenance.archive.sha512 !== expectedSource.integrity) {
    throw new Error("Kordoc archive provenance does not match the pinned integrity.");
  }
  if (!Array.isArray(provenance.files) || provenance.files.length > KORDOC_LIMITS.entries) {
    throw new Error("Kordoc provenance file records are invalid.");
  }
  const actual = await fileRecords(boundary, new Set(["PROVENANCE.json"]));
  if (actual.some((record) => record.path.endsWith(".map"))) {
    throw new Error("Vendored Kordoc source maps are forbidden.");
  }
  assertSame(actual, provenance.files, "provenance file records");
  return Object.freeze(structuredClone(provenance));
}

async function createBoundary(vendorRoot) {
  const lexicalRoot = resolve(vendorRoot);
  const metadata = await lstat(lexicalRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Vendored Kordoc root must be an owned directory.");
  }
  const canonicalRoot = await realpath(lexicalRoot);
  if (!samePath(lexicalRoot, canonicalRoot)) {
    throw new Error("Vendored Kordoc root must not be redirected.");
  }
  return Object.freeze({ lexicalRoot, canonicalRoot });
}

async function fileRecords(boundary, excluded) {
  const records = [];
  const traversal = { entries: 0 };
  let totalBytes = 0;
  async function visit(relativeDirectory) {
    const names = await ownedDirectoryEntries(boundary, relativeDirectory, traversal);
    for (const name of names) {
      const path = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const entry = await ownedEntry(boundary, path);
      if (entry.metadata.isDirectory()) {
        await visit(path);
      } else if (entry.metadata.isFile()) {
        if (excluded.has(path)) continue;
        if (records.length >= KORDOC_LIMITS.entries) {
          throw new Error("Vendored Kordoc tree exceeds the entry limit.");
        }
        const bytes = await readOwnedFile(boundary, path, KORDOC_LIMITS.entryBytes);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_TOTAL_FILE_BYTES) {
          throw new Error("Vendored Kordoc tree exceeds the aggregate byte limit.");
        }
        records.push(Object.freeze({ path, size: bytes.byteLength, sha256: sha256(bytes) }));
      } else {
        throw new Error("Vendored Kordoc tree contains an unsupported entry.");
      }
    }
  }
  await visit("");
  return records.sort((left, right) => comparePaths(left.path, right.path));
}

async function ownedDirectoryEntries(boundary, relativeDirectory, traversal) {
  const directory = relativeDirectory === ""
    ? Object.freeze({
      absolute: boundary.lexicalRoot,
      canonical: boundary.canonicalRoot,
      metadata: await lstat(boundary.lexicalRoot),
    })
    : await ownedEntry(boundary, relativeDirectory);
  if (directory.metadata.isSymbolicLink() || !directory.metadata.isDirectory()) {
    throw new Error("Vendored Kordoc directory entry is unsafe.");
  }
  const before = directory.metadata;
  const names = [];
  const handle = await opendir(directory.absolute);
  for await (const entry of handle) {
    traversal.entries += 1;
    if (traversal.entries > KORDOC_LIMITS.entries) {
      throw new Error("Vendored Kordoc tree exceeds the entry limit.");
    }
    names.push(entry.name);
  }
  names.sort(comparePaths);
  const after = await lstat(directory.absolute);
  const canonicalAfter = await realpath(directory.absolute);
  if (!sameIdentity(before, after) || !samePath(directory.canonical, canonicalAfter)) {
    throw new Error("Vendored Kordoc directory changed during verification.");
  }
  return names;
}

async function ownedEntry(boundary, relativePath) {
  if (!safeRelativePath(relativePath)) throw new Error("Vendored Kordoc path is invalid.");
  const absolute = resolve(boundary.lexicalRoot, ...relativePath.split("/"));
  const suffix = relative(boundary.lexicalRoot, absolute);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new Error("Vendored Kordoc path escapes its root.");
  }
  let current = boundary.lexicalRoot;
  let metadata;
  let canonical = boundary.canonicalRoot;
  for (const [index, segment] of relativePath.split("/").entries()) {
    current = join(current, segment);
    metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error("Vendored Kordoc links are forbidden.");
    if (index < relativePath.split("/").length - 1 && !metadata.isDirectory()) {
      throw new Error("Vendored Kordoc ancestor is not a directory.");
    }
    canonical = await realpath(current);
    if (!isWithin(boundary.canonicalRoot, canonical) || !samePath(current, canonical)) {
      throw new Error("Vendored Kordoc entry is redirected.");
    }
  }
  return Object.freeze({ absolute, canonical, metadata });
}

async function readOwnedFile(boundary, relativePath, maximumBytes) {
  const entry = await ownedEntry(boundary, relativePath);
  if (!entry.metadata.isFile() || entry.metadata.size > maximumBytes) {
    throw new Error("Vendored Kordoc file is unsafe or too large.");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(entry.absolute, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximumBytes || !sameIdentity(entry.metadata, opened)) {
      throw new Error("Vendored Kordoc file changed before reading.");
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (bytes.byteLength !== opened.size || !sameIdentity(opened, final)
      || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs
      || final.ctimeMs !== opened.ctimeMs) {
      throw new Error("Vendored Kordoc file changed during reading.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isWithin(root, candidate) {
  if (samePath(root, candidate)) return true;
  const suffix = relative(root, candidate);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function samePath(left, right) {
  if (process.platform !== "win32") return left === right;
  return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSame(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Kordoc Core ${label} do not match.`);
  }
}

function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}
