import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  KORDOC_GENERATOR_VERSION,
  KORDOC_LIMITS,
  KORDOC_SOURCE,
  kordocFileRecords,
  kordocPackageSubset,
  verifyKordocCoreRuntime,
} from "./kordoc-runtime-verifier.mjs";

export { KORDOC_LIMITS, KORDOC_SOURCE, verifyKordocCoreRuntime };

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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
  onDiagnosticStage = () => {},
}) {
  const reportStage = (stage) => {
    try { onDiagnosticStage(stage); } catch {}
  };
  const tarball = resolve(tarballPath);
  const output = resolve(outputRoot);
  const createOutput = fileSystem.createOutput ?? createOutputDirectory;
  if (typeof createOutput !== "function") {
    throw new Error("Kordoc fileSystem.createOutput must be a function.");
  }
  reportStage("output-check");
  try {
    await lstat(output);
    throw new Error(`Output already exists: ${output}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  reportStage("input-validate");
  const { archiveIntegrity, files, sourcePackage } = await validatedInputs(tarball, expectedSource);

  let ownsOutput = false;
  try {
    reportStage("parent-create");
    await mkdir(dirname(output), { recursive: true });
    reportStage("output-create");
    await createOutput(output);
    ownsOutput = true;
    reportStage("file-write");
    for (const [path, bytes] of files) {
      if (path === "package.json") continue;
      const destination = join(output, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }
    reportStage("package-write");
    await writeFile(join(output, "package.json"), json(kordocPackageSubset(sourcePackage)), { flag: "wx" });
    reportStage("file-records");
    const fileRecords = await kordocFileRecords(output);
    const provenance = {
      schemaVersion: 2,
      generatorVersion: KORDOC_GENERATOR_VERSION,
      source: expectedSource,
      archive: { sha512: archiveIntegrity },
      files: fileRecords,
    };
    reportStage("provenance-write");
    await writeFile(join(output, "PROVENANCE.json"), json(provenance), { flag: "wx" });
    reportStage("verify");
    await verifyKordocCoreRuntime(output, expectedSource);
    return provenance;
  } catch (error) {
    if (ownsOutput) {
      try {
        await rm(output, { recursive: true, force: true });
      } catch (cleanupError) {
        reportStage("cleanup");
        throw cleanupError;
      }
    }
    throw error;
  }
}

async function createOutputDirectory(path) {
  await mkdir(path, { recursive: false });
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
