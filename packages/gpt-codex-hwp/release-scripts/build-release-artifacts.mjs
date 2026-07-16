import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

import { buildRuntime, compareRuntime } from "../../../scripts/project-runtime.mjs";

const executeFile = promisify(execFile);
const PRODUCT = "gpt-codex-hwp";
const RUNTIME_PREFIX = "plugins/gpt-codex-hwp/";
const BUILDER_NAME = "gpt-codex-hwp-release-artifacts";
const BUILDER_VERSION = "1";
const REQUIRED_GIT_NAME = "Gpt_Codex_HWP contributors";
const REQUIRED_GIT_EMAIL = "224273819+Burntgogi@users.noreply.github.com";
const TOOL_NAMES = Object.freeze([
  "hwp_create_svg_asset",
  "hwp_detect_format",
  "hwp_fill_form",
  "hwp_generate_hwpx",
  "hwp_insert_image",
  "hwp_patch_document",
  "hwp_read",
  "hwp_render_preview",
  "hwp_validate",
]);
const ALLOWED_EXTENSIONS = new Set([
  ".cjs", ".cts", ".js", ".json", ".md", ".png", ".ps1", ".py", ".ts", ".yaml",
]);
const ALLOWED_EXTENSIONLESS = new Set(["LICENSE", "NOTICE"]);
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_KORDOC_PROVENANCE_BYTES = 4 * 1024 * 1024;

export async function buildReleaseArtifacts(options = {}) {
  if (!isRecord(options)) throw releaseError("RELEASE_ARTIFACTS_OPTIONS_INVALID");
  const root = resolveRequired(options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
  const output = resolveRequired(options.output);
  const outputPolicy = await validateOutputLocation(root, output);
  await assertAbsent(output, "RELEASE_ARTIFACTS_OUTPUT_EXISTS");
  const prepareRuntime = options.prepareRuntime ?? prepareProductionRuntime;
  if (typeof prepareRuntime !== "function") throw releaseError("RELEASE_ARTIFACTS_OPTIONS_INVALID");

  const source = await readSourceIdentity(root, options.sourceDateEpoch);
  const versions = options.versions ?? await toolVersions(root);
  validateVersions(versions);
  const sourcePackage = await readGitJson(
    root, source.commit, `packages/${PRODUCT}/package.json`, MAX_PACKAGE_JSON_BYTES,
  );
  const lock = await readGitJson(
    root, source.commit, `packages/${PRODUCT}/package-lock.json`, MAX_LOCK_BYTES,
  );
  const version = requiredVersion(sourcePackage.version);
  const runtimeAllowlist = await trackedRuntimeAllowlist(root, source.commit);
  if (runtimeAllowlist.length === 0) throw releaseError("RELEASE_ARTIFACTS_INPUT_MISSING");

  let ownsOutput = false;
  let outputIdentity;
  const outputHandles = [];
  const privateRoot = await mkdtemp(join(tmpdir(), `${PRODUCT}-release-stage-`));
  try {
    const stageRoot = join(privateRoot, "runtime");
    await prepareRuntime({ root, stageRoot });
    const runtimeEntries = await collectRuntimeEntries(stageRoot, runtimeAllowlist);
    for (const entry of runtimeEntries) {
      const committed = await readGitBlob(
        root, source.commit, `${RUNTIME_PREFIX}${entry.path}`, MAX_FILE_BYTES,
      );
      if (!committed.equals(entry.bytes)) throw releaseError("RELEASE_ARTIFACTS_RUNTIME_CONTENT");
    }
    const kordoc = await readKordocProvenance(stageRoot);
    const archiveEntries = runtimeEntries.map(({ path, bytes }) => ({ name: path, bytes }));
    const zipBytes = buildDeterministicZip(archiveEntries, source.epoch);
    const zipName = `${PRODUCT}-${version}.zip`;
    const sbomName = `${PRODUCT}-${version}.spdx.json`;
    const zipHash = sha256(zipBytes);
    const sbom = buildSpdx({ lock, sourcePackage, source, version });
    validateSpdx(sbom);
    const sbomBytes = jsonBytes(sbom);
    const sbomHash = sha256(sbomBytes);
    const provenance = {
      schemaVersion: 1,
      subject: { name: PRODUCT, version },
      repository: {
        url: source.repositoryUrl,
        commit: source.commit,
        tree: source.tree,
        clean: true,
      },
      reproducibleEpoch: source.epoch,
      epochSource: source.epochSource,
      builder: { name: BUILDER_NAME, version: BUILDER_VERSION },
      workflow: { name: "release:artifacts", stage: "release-artifacts" },
      toolchain: {
        node: versions.node,
        npm: versions.npm,
        zlib: versions.zlib,
        tool: versions.tool,
      },
      command: "npm run release:artifacts -- --output <new-empty-directory>",
      stages: ["source-validation", "runtime-projection", "archive", "sbom", "provenance", "checksums"],
      artifacts: {
        zip: { file: zipName, sha256: zipHash },
        sbom: { file: sbomName, sha256: sbomHash },
      },
      runtime: { fileCount: runtimeEntries.length, permissions: "0100644", pathPrefix: "" },
      toolContract: { count: TOOL_NAMES.length, names: [...TOOL_NAMES] },
      documentContract: { hwp: "read-only", outputFormat: "HWPX" },
      kordoc,
    };
    validateProvenance(provenance);
    const provenanceBytes = jsonBytes(provenance);
    const artifacts = new Map([
      [sbomName, sbomBytes],
      [zipName, zipBytes],
      ["provenance.json", provenanceBytes],
    ]);
    const checksums = [...artifacts]
      .sort(([left], [right]) => asciiCompare(left, right))
      .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
      .join("");

    await assertSourceUnchanged(root, source);
    await assertOutputParentUnchanged(outputPolicy);
    await mkdir(output, { recursive: false });
    ownsOutput = true;
    outputIdentity = await directoryIdentity(output);
    await assertOutputBoundary(outputPolicy, output, outputIdentity);
    const outputRecords = [...artifacts, ["SHA256SUMS", Buffer.from(checksums, "utf8")]];
    for (const [name] of outputRecords) {
      await assertOutputBoundary(outputPolicy, output, outputIdentity);
      const handle = await open(join(output, name), "wx+");
      const info = await handle.stat();
      outputHandles.push([name, handle, Object.freeze({ dev: info.dev, ino: info.ino })]);
      await assertOutputBoundary(outputPolicy, output, outputIdentity);
    }
    for (let index = 0; index < outputRecords.length; index += 1) {
      const [name, bytes] = outputRecords[index];
      const [reservedName, handle] = outputHandles[index];
      if (name !== reservedName) throw releaseError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
      await assertOutputBoundary(outputPolicy, output, outputIdentity);
      await handle.writeFile(bytes);
      await handle.sync();
      const reread = Buffer.alloc(bytes.length);
      const result = await handle.read(reread, 0, reread.length, 0);
      if (result.bytesRead !== bytes.length || !reread.equals(bytes)) {
        throw releaseError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
      }
      await assertOutputBoundary(outputPolicy, output, outputIdentity);
    }
    await assertOutputBoundary(outputPolicy, output, outputIdentity);
    const files = (await readdir(output)).sort(asciiCompare);
    await assertOutputBoundary(outputPolicy, output, outputIdentity);
    const expectedFiles = [...artifacts.keys(), "SHA256SUMS"].sort(asciiCompare);
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
      throw releaseError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
    }
    for (let index = 0; index < outputRecords.length; index += 1) {
      const [name, bytes] = outputRecords[index];
      const [, handle, identity] = outputHandles[index];
      const [handleInfo, entryInfo] = await Promise.all([handle.stat(), lstat(join(output, name))]);
      if (!handleInfo.isFile() || entryInfo.isSymbolicLink() || !entryInfo.isFile()
        || handleInfo.dev !== identity.dev || handleInfo.ino !== identity.ino
        || entryInfo.dev !== identity.dev || entryInfo.ino !== identity.ino
        || handleInfo.size !== bytes.length || entryInfo.size !== bytes.length) {
        throw releaseError("RELEASE_ARTIFACTS_OUTPUT_OWNERSHIP");
      }
    }
    await assertOutputBoundary(outputPolicy, output, outputIdentity);
    await closeOutputHandles(outputHandles);
    await assertOutputBoundary(outputPolicy, output, outputIdentity);
    return Object.freeze({
      status: "passed",
      schemaVersion: 1,
      commit: source.commit,
      tree: source.tree,
      reproducibleEpoch: source.epoch,
      files: Object.freeze(files),
      hashes: Object.freeze(Object.fromEntries(
        [...artifacts].map(([name, bytes]) => [name, sha256(bytes)]),
      )),
      runtimeFiles: runtimeEntries.length,
      productionPackages: sbom.packages.length,
    });
  } catch (error) {
    await closeOutputHandles(outputHandles);
    if (ownsOutput) await removeOwnedDirectory(output, outputIdentity, outputPolicy);
    throw normalizeReleaseError(error);
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
}

async function closeOutputHandles(records) {
  while (records.length > 0) {
    const [, handle] = records.pop();
    try { await handle.close(); } catch { /* The original failure remains authoritative. */ }
  }
}

async function prepareProductionRuntime({ root, stageRoot }) {
  await buildRuntime({ root, outputRoot: stageRoot });
  await compareRuntime({
    expectedRoot: stageRoot,
    actualRoot: join(root, "plugins", PRODUCT),
  });
}

export function buildDeterministicZip(entries, epoch) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_FILES) {
    throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
  }
  const normalizedEpoch = reproducibleEpoch(epoch);
  const prepared = entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string"
      || !(entry.bytes instanceof Uint8Array) || entry.bytes.length > MAX_FILE_BYTES) {
      throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
    }
    validateArchiveName(entry.name);
    return { name: entry.name, bytes: Buffer.from(entry.bytes) };
  }).sort((left, right) => asciiCompare(left.name, right.name));
  let totalBytes = 0;
  const exact = new Set();
  const folded = new Set();
  for (const entry of prepared) {
    totalBytes += entry.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
    if (exact.has(entry.name)) throw releaseError("RELEASE_ARTIFACTS_ENTRY_DUPLICATE");
    const lower = entry.name.toLowerCase();
    if (folded.has(lower)) throw releaseError("RELEASE_ARTIFACTS_ENTRY_CASE_COLLISION");
    exact.add(entry.name);
    folded.add(lower);
  }

  const { dosDate, dosTime } = dosTimestamp(normalizedEpoch);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of prepared) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.bytes, { level: 9 });
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralOffset = offset;
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBytes, end]);
}

async function collectRuntimeEntries(stageRoot, allowlist) {
  const rootInfo = await safeLstat(stageRoot, "RELEASE_ARTIFACTS_INPUT_MISSING");
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
  }
  const discovered = [];
  let total = 0;
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => asciiCompare(left.name, right.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const info = await lstat(absolute);
      const path = relative(stageRoot, absolute).split(sep).join("/");
      if (info.isSymbolicLink()) throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) {
        validateArchiveName(path);
        const remaining = MAX_TOTAL_BYTES - total;
        if (info.size > MAX_FILE_BYTES || info.size > remaining) {
          throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
        }
        const bytes = await readRegularFileBounded(absolute, Math.min(MAX_FILE_BYTES, remaining));
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES) throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
        discovered.push({ path, bytes });
      } else throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
    }
  }
  await visit(stageRoot);
  discovered.sort((left, right) => asciiCompare(left.path, right.path));
  if (JSON.stringify(discovered.map(({ path }) => path)) !== JSON.stringify(allowlist)) {
    throw releaseError("RELEASE_ARTIFACTS_RUNTIME_ALLOWLIST");
  }
  return discovered;
}

async function trackedRuntimeAllowlist(root, commit) {
  const output = await git(root, ["ls-tree", "-r", "-z", commit, "--", `plugins/${PRODUCT}`]);
  const records = output.split("\0").filter(Boolean).map((line) => {
    const match = /^(\d{6})\s+blob\s+[a-f0-9]+\t(.+)$/u.exec(line);
    if (!match || match[1] !== "100644" || !match[2].startsWith(RUNTIME_PREFIX)) {
      throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
    }
    const path = match[2].slice(RUNTIME_PREFIX.length);
    validateArchiveName(path);
    return path;
  }).sort(asciiCompare);
  const folded = new Set();
  for (const path of records) {
    const lower = path.toLowerCase();
    if (folded.has(lower)) throw releaseError("RELEASE_ARTIFACTS_ENTRY_CASE_COLLISION");
    folded.add(lower);
  }
  return records;
}

async function readSourceIdentity(root, requestedEpoch) {
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length !== 0) throw releaseError("RELEASE_ARTIFACTS_SOURCE_DIRTY");
  const commit = singleLine(await git(root, ["rev-parse", "HEAD"]), /^[a-f0-9]{40}$/u);
  const tree = singleLine(await git(root, ["rev-parse", `${commit}^{tree}`]), /^[a-f0-9]{40}$/u);
  const repositoryUrl = canonicalRepositoryUrl(singleLine(
    await git(root, ["config", "--get", "remote.origin.url"]),
    /^https:\/\/[^\s\0]+$/u,
  ));
  const configuredName = exactGitValue(await git(root, ["config", "--get", "user.name"]));
  const configuredEmail = exactGitValue(await git(root, ["config", "--get", "user.email"]));
  const identity = exactGitValue(await git(
    root, ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", commit],
  ), true).split("\0");
  if (configuredName !== REQUIRED_GIT_NAME || configuredEmail !== REQUIRED_GIT_EMAIL
    || JSON.stringify(identity) !== JSON.stringify([
      REQUIRED_GIT_NAME, REQUIRED_GIT_EMAIL, REQUIRED_GIT_NAME, REQUIRED_GIT_EMAIL,
    ])) {
    throw releaseError("RELEASE_ARTIFACTS_GIT_IDENTITY_MISSING");
  }
  const commitEpoch = Number(singleLine(
    await git(root, ["show", "-s", "--format=%ct", commit]), /^\d+$/u,
  ));
  const environmentEpoch = requestedEpoch ?? process.env.SOURCE_DATE_EPOCH;
  const epochSource = environmentEpoch === undefined ? "commit" : "environment";
  const epoch = reproducibleEpoch(environmentEpoch ?? commitEpoch);
  return { commit, tree, repositoryUrl, epoch, epochSource, commitEpoch };
}

async function assertSourceUnchanged(root, expected) {
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const head = singleLine(await git(root, ["rev-parse", "HEAD"]), /^[a-f0-9]{40}$/u);
  const tree = singleLine(await git(root, ["rev-parse", `${head}^{tree}`]), /^[a-f0-9]{40}$/u);
  if (status.length !== 0 || head !== expected.commit || tree !== expected.tree) {
    throw releaseError("RELEASE_ARTIFACTS_SOURCE_CHANGED");
  }
}

function buildSpdx({ lock, sourcePackage, source, version }) {
  const graph = productionGraph(lock);
  const identifiers = new Map(graph.map((node) => [node.key, packageSpdxId(node)]));
  const packages = graph.map((node) => {
    const record = {
      SPDXID: identifiers.get(node.key),
      name: node.name,
      versionInfo: node.version,
      downloadLocation: downloadLocation(node.record),
      filesAnalyzed: false,
      licenseConcluded: declaredLicense(node.record, node.key === "" ? sourcePackage.license : undefined),
      licenseDeclared: declaredLicense(node.record, node.key === "" ? sourcePackage.license : undefined),
      copyrightText: "NOASSERTION",
    };
    const checksum = integrityChecksum(node.record.integrity);
    if (typeof node.record.resolved === "string"
      && node.record.resolved.startsWith("https://registry.npmjs.org/") && checksum === undefined) {
      throw releaseError("RELEASE_ARTIFACTS_SPDX_INVALID");
    }
    if (checksum !== undefined) record.checksums = [checksum];
    return record;
  }).sort((left, right) => asciiCompare(left.name, right.name) || asciiCompare(left.SPDXID, right.SPDXID));
  const relationships = [{
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: identifiers.get(""),
  }];
  for (const node of graph) {
    for (const dependencyKey of node.dependencies) {
      relationships.push({
        spdxElementId: identifiers.get(node.key),
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: identifiers.get(dependencyKey),
      });
    }
  }
  relationships.sort((left, right) => asciiCompare(
    `${left.spdxElementId}\0${left.relationshipType}\0${left.relatedSpdxElement}`,
    `${right.spdxElementId}\0${right.relationshipType}\0${right.relatedSpdxElement}`,
  ));
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${PRODUCT}-${version}`,
    documentNamespace: `${source.repositoryUrl.replace(/\.git$/u, "")}/spdx/${source.commit}`,
    creationInfo: {
      created: new Date(source.epoch * 1000).toISOString(),
      creators: [
        `Tool: ${BUILDER_NAME}-${BUILDER_VERSION}`,
        "Organization: Gpt_Codex_HWP contributors",
      ],
    },
    packages,
    relationships,
  };
}

function productionGraph(lock) {
  if (!isRecord(lock) || lock.lockfileVersion !== 3 || !isRecord(lock.packages)
    || !isRecord(lock.packages[""])) {
    throw releaseError("RELEASE_ARTIFACTS_LOCK_INVALID");
  }
  const packages = lock.packages;
  const seen = new Set();
  const queue = [{ key: "", requestedName: packages[""].name ?? PRODUCT }];
  const nodes = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next.key)) continue;
    seen.add(next.key);
    const linkRecord = packages[next.key];
    if (!isRecord(linkRecord)) throw releaseError("RELEASE_ARTIFACTS_LOCK_INVALID");
    const targetKey = linkRecord.link === true ? linkRecord.resolved : undefined;
    const record = targetKey === undefined ? linkRecord : packages[targetKey];
    if (!isRecord(record)) throw releaseError("RELEASE_ARTIFACTS_LOCK_INVALID");
    const dependencies = [];
    const requiredPeers = Object.fromEntries(Object.entries(record.peerDependencies ?? {})
      .filter(([name]) => record.peerDependenciesMeta?.[name]?.optional !== true));
    const declared = {
      ...(record.dependencies ?? {}),
      ...(record.optionalDependencies ?? {}),
      ...requiredPeers,
    };
    if (!isRecord(declared)) throw releaseError("RELEASE_ARTIFACTS_LOCK_INVALID");
    for (const dependencyName of Object.keys(declared).sort(asciiCompare)) {
      const dependencyKey = resolveLockDependency(packages, next.key, dependencyName);
      dependencies.push(dependencyKey);
      queue.push({ key: dependencyKey, requestedName: dependencyName });
    }
    const name = next.key === "" ? (record.name ?? PRODUCT) : (record.name ?? next.requestedName);
    const version = requiredVersion(record.version);
    nodes.push({ key: next.key, name, version, record, dependencies });
  }
  return nodes.sort((left, right) => asciiCompare(left.key, right.key));
}

function resolveLockDependency(packages, fromKey, dependencyName) {
  let current = fromKey;
  while (true) {
    const candidate = current ? `${current}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    if (isRecord(packages[candidate])) return candidate;
    if (current === "") break;
    const marker = current.lastIndexOf("/node_modules/");
    current = marker < 0 ? "" : current.slice(0, marker);
  }
  throw releaseError("RELEASE_ARTIFACTS_LOCK_INVALID");
}

async function readKordocProvenance(stageRoot) {
  const path = join(stageRoot, "vendor", "kordoc-core", "PROVENANCE.json");
  const bytes = await readRequired(path, MAX_KORDOC_PROVENANCE_BYTES);
  let record;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { throw releaseError("RELEASE_ARTIFACTS_KORDOC_INVALID"); }
  if (!isRecord(record) || record.schemaVersion !== 2 || !isRecord(record.source)
    || record.source.name !== "kordoc" || typeof record.source.version !== "string"
    || typeof record.source.integrity !== "string" || !Array.isArray(record.files)
    || canonicalPublicUrl(record.source.resolved) !== record.source.resolved
    || new URL(record.source.resolved).pathname !== `/kordoc/-/kordoc-${record.source.version}.tgz`) {
    throw releaseError("RELEASE_ARTIFACTS_KORDOC_INVALID");
  }
  return {
    source: {
      name: record.source.name,
      version: record.source.version,
      resolved: record.source.resolved,
      integrity: record.source.integrity,
    },
    recordSha256: sha256(bytes),
    fileCount: record.files.length,
  };
}

function validateArchiveName(name) {
  const segments = name.split("/");
  const base = basename(name);
  const extension = extname(base).toLowerCase();
  if (name.length === 0 || Buffer.byteLength(name) > 1024 || name.includes("\\")
    || name.startsWith("/") || /^[A-Za-z]:/u.test(name)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || segments.some((segment) => !/^[A-Za-z0-9._@+-]+$/u.test(segment))
    || (!ALLOWED_EXTENSIONS.has(extension) && !ALLOWED_EXTENSIONLESS.has(base))) {
    throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
  }
}

function validateSpdx(value) {
  if (!isRecord(value) || value.spdxVersion !== "SPDX-2.3" || value.dataLicense !== "CC0-1.0"
    || value.SPDXID !== "SPDXRef-DOCUMENT" || !Array.isArray(value.packages)
    || value.packages.length === 0 || !Array.isArray(value.relationships)) {
    throw releaseError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
  const ids = new Set(value.packages.map((record) => record.SPDXID));
  if (ids.size !== value.packages.length || [...ids].some((id) => !/^SPDXRef-[A-Za-z0-9.-]+$/u.test(id))) {
    throw releaseError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
  for (const record of value.packages) {
    if (record.filesAnalyzed !== false || typeof record.name !== "string"
      || typeof record.versionInfo !== "string"
      || !validLicense(record.licenseDeclared) || record.licenseDeclared !== record.licenseConcluded) {
      throw releaseError("RELEASE_ARTIFACTS_SPDX_INVALID");
    }
  }
  for (const relationship of value.relationships) {
    if (!isRecord(relationship) || !["DESCRIBES", "DEPENDS_ON"].includes(relationship.relationshipType)
      || (relationship.spdxElementId !== "SPDXRef-DOCUMENT" && !ids.has(relationship.spdxElementId))
      || !ids.has(relationship.relatedSpdxElement)) {
      throw releaseError("RELEASE_ARTIFACTS_SPDX_INVALID");
    }
  }
}

function validateProvenance(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.repository.clean !== true
    || !/^[a-f0-9]{40}$/u.test(value.repository.commit)
    || !/^[a-f0-9]{40}$/u.test(value.repository.tree)
    || !["commit", "environment"].includes(value.epochSource)
    || value.toolContract.count !== 9
    || JSON.stringify(value.toolContract.names) !== JSON.stringify(TOOL_NAMES)
    || value.documentContract.hwp !== "read-only" || value.documentContract.outputFormat !== "HWPX"
    || Object.hasOwn(value.artifacts, "provenance")) {
    throw releaseError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  }
  const serialized = JSON.stringify(value);
  if (/hostname|username|workspace|documentData|rawError/iu.test(serialized)) {
    throw releaseError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  }
  requireExactKeys(value, [
    "artifacts", "builder", "command", "documentContract", "epochSource", "kordoc",
    "repository", "reproducibleEpoch", "runtime", "schemaVersion", "stages", "subject",
    "toolContract", "toolchain", "workflow",
  ]);
  requireExactKeys(value.runtime, ["fileCount", "pathPrefix", "permissions"]);
  requireExactKeys(value.documentContract, ["hwp", "outputFormat"]);
  requireExactKeys(value.toolContract, ["count", "names"]);
  requireExactKeys(value.artifacts, ["sbom", "zip"]);
  requireExactKeys(value.artifacts.zip, ["file", "sha256"]);
  requireExactKeys(value.artifacts.sbom, ["file", "sha256"]);
}

function requireExactKeys(value, keys) {
  if (!isRecord(value)
    || JSON.stringify(Object.keys(value).sort(asciiCompare)) !== JSON.stringify([...keys].sort(asciiCompare))) {
    throw releaseError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  }
}

async function toolVersions(root) {
  let npm;
  try { npm = (await executeFile("npm", ["--version"], { cwd: root, encoding: "utf8" })).stdout.trim(); }
  catch { throw releaseError("RELEASE_ARTIFACTS_TOOLCHAIN_INVALID"); }
  return { node: process.version, npm, zlib: process.versions.zlib, tool: BUILDER_VERSION };
}

function validateVersions(value) {
  if (!isRecord(value) || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.node)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.npm)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.zlib)
    || !/^\d+(?:\.\d+){0,2}$/u.test(value.tool)) {
    throw releaseError("RELEASE_ARTIFACTS_TOOLCHAIN_INVALID");
  }
}

function packageSpdxId(node) {
  const safeName = node.name.replace(/[^A-Za-z0-9.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "package";
  return `SPDXRef-Package-${safeName}-${sha256(Buffer.from(node.key || "root")).slice(0, 16)}`;
}

function declaredLicense(record, fallback) {
  const value = typeof record.license === "string" ? record.license : fallback;
  if (value === undefined) return "NOASSERTION";
  if (!validLicense(value)) throw releaseError("RELEASE_ARTIFACTS_SPDX_INVALID");
  return value;
}

function validLicense(value) {
  if (value === "NOASSERTION") return true;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  const tokens = value.match(/\(|\)|AND|OR|WITH|[A-Za-z0-9.+-]+/gu);
  if (tokens === null || tokens.join(" ").replaceAll("( ", "(").replaceAll(" )", ")")
    !== value.replace(/\s+/gu, " ").trim()) return false;
  let index = 0;
  const primary = () => {
    if (tokens[index] === "(") {
      index += 1;
      if (!expression() || tokens[index] !== ")") return false;
      index += 1;
      return true;
    }
    const token = tokens[index];
    if (!isKnownLicenseId(token)) return false;
    index += 1;
    if (tokens[index] === "WITH") {
      index += 1;
      if (!/^[A-Za-z0-9.-]+-exception$/u.test(tokens[index] ?? "")) return false;
      index += 1;
    }
    return true;
  };
  const conjunction = () => {
    if (!primary()) return false;
    while (tokens[index] === "AND") { index += 1; if (!primary()) return false; }
    return true;
  };
  const expression = () => {
    if (!conjunction()) return false;
    while (tokens[index] === "OR") { index += 1; if (!conjunction()) return false; }
    return true;
  };
  return expression() && index === tokens.length;
}

const KNOWN_LICENSE_IDS = new Set([
  "0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "GPL-3.0-or-later",
  "ISC", "LGPL-3.0-or-later", "MIT", "Python-2.0", "Zlib",
]);

function isKnownLicenseId(value) {
  return typeof value === "string"
    && (KNOWN_LICENSE_IDS.has(value) || /^LicenseRef-[A-Za-z0-9.-]+$/u.test(value));
}

function downloadLocation(record) {
  if (typeof record.resolved === "string" && /^https:\/\/[^\s]+$/u.test(record.resolved)) return record.resolved;
  return "NOASSERTION";
}

function integrityChecksum(integrity) {
  if (typeof integrity !== "string") return undefined;
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
  if (!match) throw releaseError("RELEASE_ARTIFACTS_SPDX_INVALID");
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64 || digest.toString("base64") !== match[1]) {
    throw releaseError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
  return { algorithm: "SHA512", checksumValue: digest.toString("hex") };
}

function reproducibleEpoch(value) {
  const epoch = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(epoch) || epoch < 315_532_800 || epoch > 4_354_819_199) {
    throw releaseError("RELEASE_ARTIFACTS_EPOCH_INVALID");
  }
  return epoch;
}

function dosTimestamp(epoch) {
  const date = new Date(epoch * 1000);
  return {
    dosTime: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    dosDate: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

async function readGitJson(root, commit, path, maximumBytes) {
  const object = `${commit}:${path}`;
  let size;
  try {
    size = Number(singleLine(await git(root, ["cat-file", "-s", object]), /^\d+$/u));
  } catch {
    throw releaseError("RELEASE_ARTIFACTS_INPUT_MISSING");
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
    throw releaseError("RELEASE_ARTIFACTS_INPUT_INVALID");
  }
  let serialized;
  try {
    serialized = await git(root, ["show", object], maximumBytes + 1);
  } catch {
    throw releaseError("RELEASE_ARTIFACTS_INPUT_MISSING");
  }
  if (Buffer.byteLength(serialized) !== size) throw releaseError("RELEASE_ARTIFACTS_INPUT_INVALID");
  try { return JSON.parse(serialized); }
  catch { throw releaseError("RELEASE_ARTIFACTS_INPUT_INVALID"); }
}

async function readGitBlob(root, commit, path, maximumBytes) {
  const object = `${commit}:${path}`;
  const size = Number(singleLine(await git(root, ["cat-file", "-s", object]), /^\d+$/u));
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
    throw releaseError("RELEASE_ARTIFACTS_INPUT_INVALID");
  }
  let result;
  try {
    result = await executeFile("git", ["show", object], {
      cwd: root, encoding: "buffer", maxBuffer: maximumBytes + 1,
    });
  } catch { throw releaseError("RELEASE_ARTIFACTS_INPUT_MISSING"); }
  const bytes = Buffer.from(result.stdout);
  if (bytes.length !== size) throw releaseError("RELEASE_ARTIFACTS_INPUT_INVALID");
  return bytes;
}

async function readRequired(path, maximumBytes = MAX_FILE_BYTES) {
  try { return await readRegularFileBounded(path, maximumBytes); }
  catch (error) {
    if (error?.code === "ENOENT") throw releaseError("RELEASE_ARTIFACTS_INPUT_MISSING");
    if (error?.code?.startsWith?.("RELEASE_")) throw error;
    throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
  }
}

async function readRegularFileBounded(path, maximumBytes) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 0 || before.size > maximumBytes) {
      throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const extra = await handle.read(probe, 0, 1, before.size);
    const after = await handle.stat();
    if (extra.bytesRead !== 0 || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size) throw releaseError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
    return bytes;
  } finally { await handle.close(); }
}

async function safeLstat(path, code) {
  try { return await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") throw releaseError(code); throw error; }
}

async function assertAbsent(path, code) {
  try { await lstat(path); throw releaseError(code); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function git(root, args, maxBuffer = 16 * 1024 * 1024) {
  try {
    const result = await executeFile("git", args, { cwd: root, encoding: "utf8", maxBuffer });
    return result.stdout;
  } catch { throw releaseError("RELEASE_ARTIFACTS_GIT_INVALID"); }
}

async function validateOutputLocation(root, output) {
  const parent = dirname(output);
  const parentInfo = await safeLstat(parent, "RELEASE_ARTIFACTS_OUTPUT_PARENT_INVALID");
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw releaseError("RELEASE_ARTIFACTS_OUTPUT_PARENT_INVALID");
  }
  const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(parent)]);
  if (comparablePath(resolve(parent)) !== comparablePath(canonicalParent)
    || isSameOrDescendant(canonicalParent, canonicalRoot)) {
    throw releaseError("RELEASE_ARTIFACTS_OUTPUT_INSIDE_SOURCE");
  }
  return Object.freeze({
    parent,
    parentIdentity: Object.freeze({ dev: parentInfo.dev, ino: parentInfo.ino, canonical: canonicalParent }),
    canonicalRoot,
  });
}

async function assertOutputParentUnchanged(policy) {
  const current = await safeLstat(policy.parent, "RELEASE_ARTIFACTS_OUTPUT_PARENT_INVALID");
  if (current.isSymbolicLink() || !current.isDirectory()
    || current.dev !== policy.parentIdentity.dev || current.ino !== policy.parentIdentity.ino
    || comparablePath(await realpath(policy.parent)) !== comparablePath(policy.parentIdentity.canonical)
    || isSameOrDescendant(policy.parentIdentity.canonical, policy.canonicalRoot)) {
    throw releaseError("RELEASE_ARTIFACTS_OUTPUT_OWNERSHIP");
  }
}

async function assertOutputBoundary(policy, output, identity) {
  await assertOutputParentUnchanged(policy);
  const current = await directoryIdentity(output);
  if (current.dev !== identity.dev || current.ino !== identity.ino
    || comparablePath(current.canonical) !== comparablePath(identity.canonical)) {
    throw releaseError("RELEASE_ARTIFACTS_OUTPUT_OWNERSHIP");
  }
}

async function directoryIdentity(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw releaseError("RELEASE_ARTIFACTS_OUTPUT_OWNERSHIP");
  }
  return Object.freeze({ dev: info.dev, ino: info.ino, canonical: await realpath(path) });
}

async function removeOwnedDirectory(path, identity, policy) {
  if (!isRecord(identity)) return;
  try { await assertOutputParentUnchanged(policy); } catch { return; }
  let current;
  try { current = await lstat(path); } catch { return; }
  if (current.isSymbolicLink() || !current.isDirectory()
    || current.dev !== identity.dev || current.ino !== identity.ino
    || comparablePath(await realpath(path)) !== comparablePath(identity.canonical)) {
    return;
  }
  await rm(path, { recursive: true, force: true });
}

function canonicalRepositoryUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw releaseError("RELEASE_ARTIFACTS_GIT_INVALID"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "" || url.hostname !== "github.com"
    || url.pathname !== "/Burntgogi/Gpt_Codex_HWP.git" || url.href !== value) {
    throw releaseError("RELEASE_ARTIFACTS_GIT_INVALID");
  }
  return url.href;
}

function canonicalPublicUrl(value) {
  if (typeof value !== "string") throw releaseError("RELEASE_ARTIFACTS_KORDOC_INVALID");
  let url;
  try { url = new URL(value); } catch { throw releaseError("RELEASE_ARTIFACTS_KORDOC_INVALID"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "" || url.href !== value
    || url.hostname !== "registry.npmjs.org"
    || !/^\/kordoc\/-\/kordoc-[0-9A-Za-z.+-]+\.tgz$/u.test(url.pathname)) {
    throw releaseError("RELEASE_ARTIFACTS_KORDOC_INVALID");
  }
  return url.href;
}

function exactGitValue(value, allowNull = false) {
  const raw = String(value).replace(/\r?\n$/u, "");
  const controls = allowNull
    ? /[\r\n\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  if (controls.test(raw)) {
    throw releaseError("RELEASE_ARTIFACTS_GIT_IDENTITY_MISSING");
  }
  return raw;
}

function comparablePath(value) {
  const normalized = resolve(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendant(candidate, root) {
  const child = comparablePath(candidate);
  const parent = comparablePath(root);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function singleLine(value, pattern) {
  const lines = String(value).trim().split(/\r?\n/u);
  if (lines.length !== 1 || !pattern.test(lines[0])) throw releaseError("RELEASE_ARTIFACTS_GIT_INVALID");
  return lines[0];
}

function requiredVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw releaseError("RELEASE_ARTIFACTS_INPUT_INVALID");
  }
  return value;
}

function resolveRequired(value) {
  if (typeof value !== "string" || value.trim().length === 0 || /[\r\n\0]/u.test(value)) {
    throw releaseError("RELEASE_ARTIFACTS_OPTIONS_INVALID");
  }
  return resolve(value);
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function asciiCompare(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function releaseError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function normalizeReleaseError(error) {
  if (error?.code?.startsWith?.("RELEASE_ARTIFACTS_")) return error;
  return releaseError("RELEASE_ARTIFACTS_BUILD_FAILED", error);
}

async function runCli(argv) {
  const args = [...argv];
  if (args.length !== 2 || args[0] !== "--output") {
    throw releaseError("RELEASE_ARTIFACTS_USAGE");
  }
  const receipt = await buildReleaseArtifacts({ output: args[1] });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code?.startsWith?.("RELEASE_ARTIFACTS_") ? error.code : "RELEASE_ARTIFACTS_BUILD_FAILED"}\n`);
    process.exitCode = 1;
  });
}
