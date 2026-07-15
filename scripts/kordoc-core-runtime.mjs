import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

export const KORDOC_SOURCE = Object.freeze({
  name: "kordoc",
  version: "3.18.1",
  resolved: "https://registry.npmjs.org/kordoc/-/kordoc-3.18.1.tgz",
  integrity: "sha512-/SrgNK9RKnz1wdlhOvBeJi6+pNSO+vZeBHMxKd8TvfIkuinQBpwbE+W76TGNsMC7bxx2NJhNQAJPqCyD5ltiGA==",
});

const TOP_LEVEL = ["dist", "LICENSE", "package.json", "PROVENANCE.json", "README.md"];
const GENERATOR_VERSION = 2;
export const KORDOC_LIMITS = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  entries: 512,
});
const PACKAGE_FIELDS = [
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
];

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageSubset(source) {
  return Object.fromEntries(
    PACKAGE_FIELDS.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]),
  );
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Expected a regular file: ${path}`);
  }
}

function parseTarOctal(bytes, label) {
  const text = Buffer.from(bytes).toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Invalid tar ${label}.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid tar ${label}.`);
  return value;
}

function tarString(header, offset, length) {
  return header.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/u, "");
}

function validateArchivePath(path) {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Invalid package-relative tar path: ${path}`);
  }
  return path;
}

function validateTarChecksum(header) {
  const expected = parseTarOctal(header.subarray(148, 156), "checksum");
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) throw new Error("Invalid tar header checksum.");
}

function validateLimits(limits) {
  for (const key of Object.keys(KORDOC_LIMITS)) {
    const value = limits?.[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > KORDOC_LIMITS[key]) {
      throw new Error(`Invalid Kordoc test limit: ${key}.`);
    }
  }
  return limits;
}

function parseAuthenticatedTarball(archiveBytes, limits = KORDOC_LIMITS) {
  validateLimits(limits);
  if (archiveBytes.length > limits.archiveBytes) {
    throw new Error("Kordoc archive exceeds the compressed size limit.");
  }
  let tar;
  try {
    tar = gunzipSync(archiveBytes, { maxOutputLength: limits.expandedBytes });
  } catch (error) {
    throw new Error(`Could not decompress authenticated Kordoc archive within the expanded size limit: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (tar.length > limits.expandedBytes) throw new Error("Kordoc archive exceeds the expanded size limit.");

  const entries = new Map();
  let offset = 0;
  let entryCount = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (offset + 512 > tar.length || !tar.subarray(offset, offset + 512).every((byte) => byte === 0)) {
        throw new Error("Kordoc archive must end with two zero tar terminator blocks.");
      }
      offset += 512;
      ended = true;
      break;
    }
    entryCount += 1;
    if (entryCount > limits.entries) throw new Error("Kordoc archive exceeds the tar entry limit.");
    validateTarChecksum(header);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = validateArchivePath(prefix ? `${prefix}/${name}` : name);
    const type = String.fromCharCode(header[156] || 0x30);
    if (type !== "0") throw new Error(`Tar entry must be a regular file: ${path} (type ${type}).`);
    const size = parseTarOctal(header.subarray(124, 136), "entry size");
    const paddedSize = Math.ceil(size / 512) * 512;
    if (size > limits.entryBytes || offset + paddedSize > tar.length) {
      throw new Error(`Tar entry exceeds its bounded size or archive extent: ${path}`);
    }
    if (entries.has(path)) throw new Error(`Duplicate tar entry: ${path}`);
    entries.set(path, Buffer.from(tar.subarray(offset, offset + size)));
    offset += paddedSize;
  }
  if (!ended) throw new Error("Kordoc archive has no valid tar terminator.");
  if (tar.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error("Kordoc archive has non-zero data after the tar terminator.");
  }
  return entries;
}

export function inspectKordocArchiveForTest(archiveBytes, limits = KORDOC_LIMITS) {
  return selectedArchiveFiles(parseAuthenticatedTarball(archiveBytes, validateLimits(limits)));
}

async function assertArchiveFileSize(path, maximumBytes = KORDOC_LIMITS.archiveBytes) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Expected a regular archive file: ${path}`);
  if (info.size > maximumBytes) throw new Error("Kordoc archive exceeds the compressed size limit.");
}

export async function assertArchiveFileSizeForTest(path, maximumBytes) {
  validateLimits({ ...KORDOC_LIMITS, archiveBytes: maximumBytes });
  await assertArchiveFileSize(path, maximumBytes);
}

function selectedArchiveFiles(entries) {
  const selected = new Map();
  for (const [path, bytes] of entries) {
    const allowed =
      path === "package/package.json" ||
      path === "package/LICENSE" ||
      path === "package/README.md" ||
      path.startsWith("package/dist/");
    if (!allowed) throw new Error(`Unexpected regular file in Kordoc archive: ${path}`);
    if (path.endsWith(".map")) continue;
    selected.set(path.slice("package/".length), bytes);
  }
  for (const required of ["package.json", "LICENSE", "README.md"]) {
    if (!selected.has(required)) throw new Error(`Kordoc archive is missing ${required}.`);
  }
  if (![...selected.keys()].some((path) => path.startsWith("dist/"))) {
    throw new Error("Kordoc archive contains no distributable runtime files.");
  }
  return selected;
}

async function assertTreeHasNoLinks(root) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) {
    throw new Error(`Symbolic links are forbidden: ${root}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Expected a directory: ${root}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const child = await lstat(path);
    if (child.isSymbolicLink()) {
      throw new Error(`Symbolic links are forbidden: ${path}`);
    }
    if (child.isDirectory()) {
      await assertTreeHasNoLinks(path);
    } else if (!child.isFile()) {
      throw new Error(`Unsupported filesystem entry: ${path}`);
    }
  }
}

async function fileRecords(root, excluded = new Set()) {
  const records = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`Symbolic links are forbidden: ${absolute}`);
      }
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && !excluded.has(path)) {
        const bytes = await readFile(absolute);
        records.push({ path, size: bytes.length, sha256: sha256(bytes) });
      } else if (!entry.isFile()) {
        throw new Error(`Unsupported filesystem entry: ${absolute}`);
      }
    }
  }
  await visit(root);
  return records.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function validatedInputs(tarballPath, expectedSource) {
  await assertArchiveFileSize(tarballPath);
  const archiveBytes = await readFile(tarballPath);
  const archiveIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
  if (archiveIntegrity !== expectedSource.integrity) {
    throw new Error("Kordoc archive integrity does not match the pinned source.");
  }
  const files = selectedArchiveFiles(parseAuthenticatedTarball(archiveBytes));
  const sourcePackage = JSON.parse(files.get("package.json").toString("utf8"));
  if (sourcePackage.name !== expectedSource.name || sourcePackage.version !== expectedSource.version) {
    throw new Error("Archived Kordoc package identity does not match the pinned source.");
  }
  if (sourcePackage.license !== "MIT") throw new Error("Kordoc license must remain MIT.");
  if (sourcePackage.repository?.url !== "https://github.com/chrisryugj/kordoc.git") {
    throw new Error("Kordoc repository does not match the audited source.");
  }
  return { archiveIntegrity, files, sourcePackage };
}

export async function buildKordocCoreRuntime({
  tarballPath,
  outputRoot,
  expectedSource = KORDOC_SOURCE,
  fileSystem = {},
}) {
  const tarball = resolve(tarballPath);
  const output = resolve(outputRoot);
  const createOutput = fileSystem.createOutput ?? createOutputDirectory;
  if (typeof createOutput !== "function") {
    throw new Error("Kordoc fileSystem.createOutput must be a function.");
  }
  try {
    await lstat(output);
    throw new Error(`Output already exists: ${output}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const { archiveIntegrity, files, sourcePackage } = await validatedInputs(tarball, expectedSource);

  let ownsOutput = false;
  try {
    await mkdir(dirname(output), { recursive: true });
    await createOutput(output);
    ownsOutput = true;
    for (const [path, bytes] of files) {
      if (path === "package.json") continue;
      const destination = join(output, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }
    await writeFile(join(output, "package.json"), json(packageSubset(sourcePackage)), { flag: "wx" });
    const provenance = {
      schemaVersion: 2,
      generatorVersion: GENERATOR_VERSION,
      source: expectedSource,
      archive: { sha512: archiveIntegrity },
      files: await fileRecords(output),
    };
    await writeFile(join(output, "PROVENANCE.json"), json(provenance), { flag: "wx" });
    await verifyKordocCoreRuntime(output, expectedSource);
    return provenance;
  } catch (error) {
    if (ownsOutput) await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function createOutputDirectory(path) {
  await mkdir(path, { recursive: false });
}

export async function verifyKordocCoreRuntime(vendorRoot, expectedSource = KORDOC_SOURCE) {
  const root = resolve(vendorRoot);
  await assertTreeHasNoLinks(root);
  const topLevel = (await readdir(root)).sort((a, b) => a.localeCompare(b, "en"));
  assertSame(topLevel, [...TOP_LEVEL].sort((a, b) => a.localeCompare(b, "en")), "top-level entries");

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assertSame(Object.keys(packageJson), PACKAGE_FIELDS.filter((field) => packageJson[field] !== undefined), "package fields");
  if (packageJson.name !== KORDOC_SOURCE.name || packageJson.version !== KORDOC_SOURCE.version) {
    throw new Error("Vendored Kordoc identity is invalid.");
  }
  if (packageJson.license !== "MIT") throw new Error("Vendored Kordoc license must be MIT.");

  const provenance = JSON.parse(await readFile(join(root, "PROVENANCE.json"), "utf8"));
  if (provenance.schemaVersion !== 2) throw new Error("Unsupported provenance schema.");
  if (provenance.generatorVersion !== GENERATOR_VERSION) throw new Error("Unsupported provenance generator version.");
  assertSame(provenance.source, expectedSource, "provenance source");
  if (provenance.archive?.sha512 !== expectedSource.integrity) {
    throw new Error("Kordoc archive provenance does not match the pinned integrity.");
  }
  const actual = await fileRecords(root, new Set(["PROVENANCE.json"]));
  if (actual.some((record) => record.path.endsWith(".map"))) {
    throw new Error("Vendored Kordoc source maps are forbidden.");
  }
  assertSame(actual, provenance.files, "provenance file records");
  return provenance;
}

function assertSame(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Kordoc Core ${label} do not match.`);
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "build" && args.length === 2) {
    const result = await buildKordocCoreRuntime({
      tarballPath: args[0],
      outputRoot: args[1],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "verify" && args.length === 1) {
    const result = await verifyKordocCoreRuntime(args[0]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(
    "Usage: kordoc-core-runtime.mjs build <kordoc.tgz> <output-dir> | verify <vendor-dir>",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
