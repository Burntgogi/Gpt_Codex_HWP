import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const executeFile = promisify(execFile);
const PRODUCT = "gpt-codex-hwp";
const RUNTIME_PREFIX = "plugins/gpt-codex-hwp/";
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
const ALLOWED_EXTENSIONLESS = new Set([".npmrc", "LICENSE", "NOTICE"]);
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const REQUIRED_GIT_NAME = "Gpt_Codex_HWP contributors";
const REQUIRED_GIT_EMAIL = "224273819+Burntgogi@users.noreply.github.com";
const OUTPUT_LIMITS = Object.freeze({
  zip: MAX_TOTAL_BYTES,
  sbom: 16 * 1024 * 1024,
  provenance: 1024 * 1024,
  checksums: 4096,
});
const utf8Fatal = new TextDecoder("utf-8", { fatal: true });

export async function verifyReleaseArtifacts(options = {}) {
  if (!isRecord(options)) throw verificationError("RELEASE_ARTIFACTS_VERIFY_OPTIONS_INVALID");
  const root = resolveRequired(options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const artifacts = resolveRequired(options.artifacts);
  const artifactInfo = await safeLstat(artifacts, "RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
  if (artifactInfo.isSymbolicLink() || !artifactInfo.isDirectory()) {
    throw verificationError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
  }
  const source = await currentSourceIdentity(root);
  const sourcePackage = await readGitJson(
    root, source.commit, `packages/${PRODUCT}/package.json`, MAX_PACKAGE_JSON_BYTES,
  );
  const lock = await readGitJson(
    root, source.commit, `packages/${PRODUCT}/package-lock.json`, MAX_LOCK_BYTES,
  );
  const version = requiredVersion(sourcePackage.version);
  const zipName = `${PRODUCT}-${version}.zip`;
  const sbomName = `${PRODUCT}-${version}.spdx.json`;
  const expectedNames = [sbomName, zipName, "provenance.json", "SHA256SUMS"].sort(asciiCompare);
  const actualNames = (await readdir(artifacts)).sort(asciiCompare);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw verificationError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
  }
  const artifactBytes = new Map();
  let aggregateArtifactBytes = 0;
  for (const name of actualNames) {
    const path = join(artifacts, name);
    const info = await lstat(path);
    const limit = name === zipName ? OUTPUT_LIMITS.zip
      : name === sbomName ? OUTPUT_LIMITS.sbom
        : name === "provenance.json" ? OUTPUT_LIMITS.provenance : OUTPUT_LIMITS.checksums;
    if (info.isSymbolicLink() || !info.isFile() || info.size > limit
      ) {
      throw verificationError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
    }
    const bytes = await readRegularFileBounded(path, limit);
    aggregateArtifactBytes += bytes.length;
    if (aggregateArtifactBytes > Object.values(OUTPUT_LIMITS).reduce((sum, value) => sum + value, 0)) {
      throw verificationError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
    }
    artifactBytes.set(name, bytes);
  }

  const expectedChecksumNames = [sbomName, zipName, "provenance.json"].sort(asciiCompare);
  const checksumText = artifactBytes.get("SHA256SUMS").toString("utf8");
  const checksumLines = checksumText.split("\n");
  if (checksumLines.at(-1) !== "") throw verificationError("RELEASE_ARTIFACTS_CHECKSUM_INVALID");
  checksumLines.pop();
  if (checksumLines.length !== 3) throw verificationError("RELEASE_ARTIFACTS_CHECKSUM_INVALID");
  const checksumRecords = checksumLines.map((line) => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match) throw verificationError("RELEASE_ARTIFACTS_CHECKSUM_INVALID");
    return { hash: match[1], name: match[2] };
  });
  if (JSON.stringify(checksumRecords.map(({ name }) => name)) !== JSON.stringify(expectedChecksumNames)) {
    throw verificationError("RELEASE_ARTIFACTS_CHECKSUM_INVALID");
  }
  for (const { hash, name } of checksumRecords) {
    if (sha256(artifactBytes.get(name)) !== hash) {
      throw verificationError("RELEASE_ARTIFACTS_CHECKSUM_MISMATCH");
    }
  }

  const provenance = parseJson(artifactBytes.get("provenance.json"), "RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  verifyProvenance(provenance, {
    source, version, zipName, sbomName, artifactBytes, root,
    sourceDateEpoch: options.sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH,
  });
  const zipEntries = inspectReleaseZipForTest(artifactBytes.get(zipName));
  const allowlist = await trackedRuntimeAllowlist(root, source.commit);
  if (JSON.stringify(zipEntries.map(({ name }) => name)) !== JSON.stringify(allowlist)) {
    throw verificationError("RELEASE_ARTIFACTS_RUNTIME_ALLOWLIST");
  }
  if (zipEntries.some((entry) => entry.epoch !== provenance.reproducibleEpoch - (provenance.reproducibleEpoch % 2)
    || entry.mode !== 0o100644 || entry.compression !== "deflate")) {
    throw verificationError("RELEASE_ARTIFACTS_ZIP_METADATA");
  }
  let totalBytes = 0;
  for (const entry of zipEntries) {
    const expected = await readGitBlob(
      root, source.commit, `${RUNTIME_PREFIX}${entry.name}`, MAX_FILE_BYTES,
    );
    if (!expected.equals(entry.bytes)) throw verificationError("RELEASE_ARTIFACTS_RUNTIME_CONTENT");
    totalBytes += entry.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
  }

  const graph = productionGraph(lock);
  const spdx = parseJson(artifactBytes.get(sbomName), "RELEASE_ARTIFACTS_SPDX_INVALID");
  verifySpdx(spdx, { graph, source, version, epoch: provenance.reproducibleEpoch });
  verifyNineTools(zipEntries, provenance);
  verifyKordoc(zipEntries, provenance);
  await assertSourceUnchanged(root, source);

  return Object.freeze({
    schemaVersion: 1,
    status: "passed",
    commit: source.commit,
    tree: source.tree,
    reproducibleEpoch: provenance.reproducibleEpoch,
    runtimeFiles: zipEntries.length,
    productionPackages: graph.length,
    toolCount: TOOL_NAMES.length,
    hashes: Object.freeze(Object.fromEntries(checksumRecords.map(({ name, hash }) => [name, hash]))),
  });
}

export function inspectReleaseZipForTest(input) {
  if (!(input instanceof Uint8Array)) throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.readUInt32LE(bytes.length - 22) !== 0x06054b50) {
    throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
  }
  const endOffset = bytes.length - 22;
  if (bytes.readUInt16LE(endOffset + 4) !== 0 || bytes.readUInt16LE(endOffset + 6) !== 0
    || bytes.readUInt16LE(endOffset + 20) !== 0) {
    throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
  }
  const count = bytes.readUInt16LE(endOffset + 8);
  if (count === 0 || count !== bytes.readUInt16LE(endOffset + 10) || count > MAX_FILES) {
    throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
  }
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
  let cursor = centralOffset;
  const centralEntries = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
    }
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const version = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const dosTime = bytes.readUInt16LE(cursor + 12);
    const dosDate = bytes.readUInt16LE(cursor + 14);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34);
    const internalAttributes = bytes.readUInt16LE(cursor + 36);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > endOffset || madeBy !== ((3 << 8) | 20) || version !== 20 || flags !== 0x0800
      || method !== 8 || extraLength !== 0 || commentLength !== 0 || disk !== 0
      || internalAttributes !== 0 || externalAttributes !== ((0o100644 * 0x10000) >>> 0)
      || size > MAX_FILE_BYTES) {
      throw verificationError("RELEASE_ARTIFACTS_ZIP_METADATA");
    }
    let name;
    try { name = utf8Fatal.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
    catch { throw verificationError("RELEASE_ARTIFACTS_ENTRY_UNSAFE"); }
    validateArchiveName(name);
    centralEntries.push({ name, crc, compressedSize, size, localOffset, dosTime, dosDate });
    cursor = end;
  }
  if (cursor !== endOffset) throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
  const names = centralEntries.map(({ name }) => name);
  if (JSON.stringify(names) !== JSON.stringify([...names].sort(asciiCompare))) {
    throw verificationError("RELEASE_ARTIFACTS_ZIP_ORDER");
  }
  const exact = new Set();
  const folded = new Set();
  let expectedLocalOffset = 0;
  let totalBytes = 0;
  const result = [];
  for (const entry of centralEntries) {
    if (exact.has(entry.name)) throw verificationError("RELEASE_ARTIFACTS_ENTRY_DUPLICATE");
    const lower = entry.name.toLowerCase();
    if (folded.has(lower)) throw verificationError("RELEASE_ARTIFACTS_ENTRY_CASE_COLLISION");
    exact.add(entry.name);
    folded.add(lower);
    if (entry.localOffset !== expectedLocalOffset || entry.localOffset + 30 > centralOffset
      || bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
    }
    const local = entry.localOffset;
    const nameLength = bytes.readUInt16LE(local + 26);
    const extraLength = bytes.readUInt16LE(local + 28);
    if (bytes.readUInt16LE(local + 4) !== 20 || bytes.readUInt16LE(local + 6) !== 0x0800
      || bytes.readUInt16LE(local + 8) !== 8
      || bytes.readUInt16LE(local + 10) !== entry.dosTime
      || bytes.readUInt16LE(local + 12) !== entry.dosDate
      || bytes.readUInt32LE(local + 14) !== entry.crc
      || bytes.readUInt32LE(local + 18) !== entry.compressedSize
      || bytes.readUInt32LE(local + 22) !== entry.size || extraLength !== 0) {
      throw verificationError("RELEASE_ARTIFACTS_ZIP_METADATA");
    }
    const localNameBytes = bytes.subarray(local + 30, local + 30 + nameLength);
    let localName;
    try { localName = utf8Fatal.decode(localNameBytes); }
    catch { throw verificationError("RELEASE_ARTIFACTS_ENTRY_UNSAFE"); }
    const centralNameBytes = Buffer.from(entry.name, "utf8");
    if (localName !== entry.name || !localNameBytes.equals(centralNameBytes)) {
      throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
    }
    const dataOffset = local + 30 + nameLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > centralOffset || entry.size > MAX_TOTAL_BYTES - totalBytes) {
      throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
    }
    let expanded;
    try {
      expanded = inflateRawSync(bytes.subarray(dataOffset, dataEnd), {
        maxOutputLength: Math.max(1, entry.size),
      });
    }
    catch { throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID"); }
    if (expanded.length !== entry.size || crc32(expanded) !== entry.crc) {
      throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
    }
    const canonicalCompressed = deflateRawSync(expanded, { level: 9 });
    if (!canonicalCompressed.equals(bytes.subarray(dataOffset, dataEnd))) {
      throw verificationError("RELEASE_ARTIFACTS_ZIP_METADATA");
    }
    totalBytes += expanded.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
    result.push(Object.freeze({
      name: entry.name,
      bytes: Buffer.from(expanded),
      mode: 0o100644,
      epoch: epochFromDos(entry.dosDate, entry.dosTime),
      compression: "deflate",
    }));
    expectedLocalOffset = dataEnd;
  }
  if (expectedLocalOffset !== centralOffset) throw verificationError("RELEASE_ARTIFACTS_ZIP_INVALID");
  return Object.freeze(result);
}

function verifyProvenance(value, {
  source, version, zipName, sbomName, artifactBytes, root, sourceDateEpoch,
}) {
  const expectedEpochSource = sourceDateEpoch === undefined ? "commit" : "environment";
  const expectedEpoch = expectedEpochSource === "commit"
    ? source.commitEpoch : parseExpectedEpoch(sourceDateEpoch);
  if (!isRecord(value) || value.schemaVersion !== 1 || value.subject?.name !== PRODUCT
    || value.subject?.version !== version || value.repository?.url !== source.repositoryUrl
    || value.repository?.commit !== source.commit || value.repository?.tree !== source.tree
    || value.repository?.clean !== true || !validEpoch(value.reproducibleEpoch)
    || value.epochSource !== expectedEpochSource
    || value.reproducibleEpoch !== expectedEpoch
    || value.builder?.name !== "gpt-codex-hwp-release-artifacts" || value.builder?.version !== "1"
    || value.workflow?.name !== "release:artifacts" || value.workflow?.stage !== "release-artifacts"
    || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.toolchain?.node)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.toolchain?.npm)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.toolchain?.zlib)
    || value.toolchain?.zlib !== process.versions.zlib
    || value.toolchain?.tool !== "1"
    || value.command !== "npm run release:artifacts -- --output <new-empty-directory>"
    || JSON.stringify(value.stages) !== JSON.stringify([
      "source-validation", "runtime-projection", "archive", "sbom", "provenance", "checksums",
    ]) || value.artifacts?.zip?.file !== zipName || value.artifacts?.sbom?.file !== sbomName
    || value.artifacts.zip.sha256 !== sha256(artifactBytes.get(zipName))
    || value.artifacts.sbom.sha256 !== sha256(artifactBytes.get(sbomName))
    || Object.hasOwn(value.artifacts, "provenance") || value.runtime?.permissions !== "0100644"
    || value.runtime?.pathPrefix !== "" || value.toolContract?.count !== 9
    || JSON.stringify(value.toolContract.names) !== JSON.stringify(TOOL_NAMES)
    || value.documentContract?.hwp !== "read-only" || value.documentContract?.outputFormat !== "HWPX") {
    throw verificationError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  }
  requireExactKeys(value, [
    "artifacts", "builder", "command", "documentContract", "kordoc", "repository",
    "epochSource", "reproducibleEpoch", "runtime", "schemaVersion", "stages", "subject", "toolContract",
    "toolchain", "workflow",
  ]);
  requireExactKeys(value.subject, ["name", "version"]);
  requireExactKeys(value.repository, ["clean", "commit", "tree", "url"]);
  requireExactKeys(value.builder, ["name", "version"]);
  requireExactKeys(value.workflow, ["name", "stage"]);
  requireExactKeys(value.toolchain, ["node", "npm", "tool", "zlib"]);
  requireExactKeys(value.artifacts, ["sbom", "zip"]);
  requireExactKeys(value.artifacts.zip, ["file", "sha256"]);
  requireExactKeys(value.artifacts.sbom, ["file", "sha256"]);
  requireExactKeys(value.runtime, ["fileCount", "pathPrefix", "permissions"]);
  requireExactKeys(value.toolContract, ["count", "names"]);
  requireExactKeys(value.documentContract, ["hwp", "outputFormat"]);
  requireExactKeys(value.kordoc, ["fileCount", "recordSha256", "source"]);
  requireExactKeys(value.kordoc.source, ["integrity", "name", "resolved", "version"]);
  validatePublicUrl(value.repository.url, "repository");
  validatePublicUrl(value.kordoc.source.resolved, "kordoc");
  if (new URL(value.kordoc.source.resolved).pathname
    !== `/kordoc/-/kordoc-${value.kordoc.source.version}.tgz`) {
    throw verificationError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  }
  const forbiddenKeys = new Set([
    "hostname", "username", "workspace", "environment", "environmentValues",
    "document", "documentData", "rawError", "provenanceSha256",
  ]);
  walkKeys(value, (key) => {
    if (forbiddenKeys.has(key)) throw verificationError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  });
  walkStrings(value, (text) => {
    const normalized = text.replaceAll("\\", "/").toLowerCase();
    if (normalized.includes(root.replaceAll("\\", "/").toLowerCase())
      || /(?:^|\s)[A-Za-z]:\/[A-Za-z0-9._/-]+/u.test(text.replaceAll("\\", "/"))
      || /\/(?:users|home|tmp)\/[A-Za-z0-9._-]+\//iu.test(text)) {
      throw verificationError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
    }
  });
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value >= 315_532_800 && value <= 4_354_819_199;
}

function parseExpectedEpoch(value) {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!validEpoch(parsed)) throw verificationError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  return parsed;
}

function verifySpdx(value, { graph, source, version, epoch }) {
  if (!isRecord(value) || value.spdxVersion !== "SPDX-2.3" || value.dataLicense !== "CC0-1.0"
    || value.SPDXID !== "SPDXRef-DOCUMENT" || value.name !== `${PRODUCT}-${version}`
    || value.documentNamespace !== `${source.repositoryUrl.replace(/\.git$/u, "")}/spdx/${source.commit}`
    || value.creationInfo?.created !== new Date(epoch * 1000).toISOString()
    || JSON.stringify(value.creationInfo?.creators) !== JSON.stringify([
      "Tool: gpt-codex-hwp-release-artifacts-1",
      "Organization: Gpt_Codex_HWP contributors",
    ]) || !Array.isArray(value.packages) || !Array.isArray(value.relationships)) {
    throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
  requireExactSpdxKeys(value, [
    "SPDXID", "creationInfo", "dataLicense", "documentNamespace", "name",
    "packages", "relationships", "spdxVersion",
  ]);
  requireExactSpdxKeys(value.creationInfo, ["created", "creators"]);
  const ids = new Set();
  const actualSignatures = [];
  for (const record of value.packages) {
    if (!isRecord(record) || !/^SPDXRef-[A-Za-z0-9.-]+$/u.test(record.SPDXID)
      || ids.has(record.SPDXID) || record.filesAnalyzed !== false
      || record.copyrightText !== "NOASSERTION" || record.licenseDeclared !== record.licenseConcluded
      || !validLicense(record.licenseDeclared) || !validDownload(record.downloadLocation)
      || !validChecksums(record.checksums)) {
      throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
    }
    const expectedKeys = record.checksums === undefined
      ? ["SPDXID", "copyrightText", "downloadLocation", "filesAnalyzed", "licenseConcluded", "licenseDeclared", "name", "versionInfo"]
      : ["SPDXID", "checksums", "copyrightText", "downloadLocation", "filesAnalyzed", "licenseConcluded", "licenseDeclared", "name", "versionInfo"];
    requireExactSpdxKeys(record, expectedKeys);
    ids.add(record.SPDXID);
    const signature = packageSignature(record);
    actualSignatures.push(signature);
  }
  const expectedRecords = graph.map((node) => expectedPackage(node))
    .sort((left, right) => asciiCompare(left.name, right.name)
      || asciiCompare(left.SPDXID, right.SPDXID));
  const expectedSignatures = expectedRecords.map(packageSignature);
  if (JSON.stringify(actualSignatures) !== JSON.stringify(expectedSignatures)) {
    throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
  const actualRelationships = [];
  for (const relationship of value.relationships) {
    if (!isRecord(relationship) || !["DESCRIBES", "DEPENDS_ON"].includes(relationship.relationshipType)
      || !ids.has(relationship.relatedSpdxElement)
      || (relationship.spdxElementId !== "SPDXRef-DOCUMENT" && !ids.has(relationship.spdxElementId))) {
      throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
    }
    requireExactSpdxKeys(relationship, ["relatedSpdxElement", "relationshipType", "spdxElementId"]);
    actualRelationships.push(`${relationship.spdxElementId}\0${relationship.relationshipType}\0${relationship.relatedSpdxElement}`);
  }
  const nodeIds = new Map(graph.map((node) => [node.key, packageSpdxId(node)]));
  const expectedRelationships = [`SPDXRef-DOCUMENT\0DESCRIBES\0${nodeIds.get("")}`];
  for (const node of graph) {
    for (const dependency of node.dependencies) {
      expectedRelationships.push(`${nodeIds.get(node.key)}\0DEPENDS_ON\0${nodeIds.get(dependency)}`);
    }
  }
  actualRelationships.sort(asciiCompare);
  expectedRelationships.sort(asciiCompare);
  if (JSON.stringify(actualRelationships) !== JSON.stringify(expectedRelationships)) {
    throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
}

function verifyNineTools(entries, provenance) {
  const toolEntries = entries.filter(({ name }) => name.startsWith("dist/tools/") && name.endsWith(".js"));
  const toolsSource = toolEntries.map(({ bytes }) => bytes.toString("utf8")).join("\n");
  const runtimeJavaScript = entries.filter(({ name }) => name.endsWith(".js"))
    .map(({ bytes }) => bytes.toString("utf8")).join("\n");
  const declarations = new Map([...toolsSource.matchAll(
    /export const ([A-Z0-9_]+_TOOL_NAME) = "(hwp_[a-z0-9_]+)";/gu,
  )].map((match) => [match[1], match[2]]));
  const index = toolEntries.find(({ name }) => name === "dist/tools/index.js")?.bytes.toString("utf8");
  if (index === undefined) throw verificationError("RELEASE_ARTIFACTS_TOOL_CONTRACT");
  const definitionMatch = /export const toolDefinitions = Object\.freeze\(\[([\s\S]*?)\n\]\);/u.exec(index);
  if (definitionMatch === null) throw verificationError("RELEASE_ARTIFACTS_TOOL_CONTRACT");
  const objectPattern = /\{\s*name:\s*([A-Z0-9_]+_TOOL_NAME),\s*register:\s*([A-Za-z_$][A-Za-z0-9_$]*),\s*\}/gu;
  const objects = [...definitionMatch[1].matchAll(objectPattern)];
  let consumed = 0;
  for (const object of objects) {
    if (!/^[\s,]*$/u.test(definitionMatch[1].slice(consumed, object.index))) {
      throw verificationError("RELEASE_ARTIFACTS_TOOL_CONTRACT");
    }
    consumed = object.index + object[0].length;
  }
  if (!/^[\s,]*$/u.test(definitionMatch[1].slice(consumed))) {
    throw verificationError("RELEASE_ARTIFACTS_TOOL_CONTRACT");
  }
  const registered = objects.map((match) => declarations.get(match[1]))
    .filter((value) => value !== undefined).sort(asciiCompare);
  const registrationCalls = [...runtimeJavaScript.matchAll(
    /\bserver\.registerTool\(\s*([A-Z0-9_]+_TOOL_NAME)\s*,/gu,
  )].map((match) => declarations.get(match[1]))
    .filter((value) => value !== undefined).sort(asciiCompare);
  const allRegistrationCalls = [...runtimeJavaScript.matchAll(/\.registerTool\s*\(/gu)].length;
  const outsideDefinitions = toolsSource.replace(definitionMatch[0], "");
  if (JSON.stringify([...new Set(registered)]) !== JSON.stringify(TOOL_NAMES)
    || registered.length !== TOOL_NAMES.length || declarations.size !== TOOL_NAMES.length
    || JSON.stringify(registrationCalls) !== JSON.stringify(TOOL_NAMES)
    || allRegistrationCalls !== TOOL_NAMES.length
    || [...toolsSource.matchAll(/\bhwp_[a-z0-9_]+\b/gu)].some((match) => !TOOL_NAMES.includes(match[0]))
    || /\bname:\s*(?:[A-Z0-9_]+_TOOL_NAME|["']hwp_[a-z0-9_]+["'])/u.test(outsideDefinitions)) {
    throw verificationError("RELEASE_ARTIFACTS_TOOL_CONTRACT");
  }
  const mcp = entryJson(entries, ".mcp.json", "RELEASE_ARTIFACTS_TOOL_CONTRACT");
  if (!isRecord(mcp.mcpServers) || Object.keys(mcp.mcpServers).length !== 1
    || !isRecord(mcp.mcpServers[PRODUCT])) {
    throw verificationError("RELEASE_ARTIFACTS_TOOL_CONTRACT");
  }
  if (provenance.toolContract.count !== TOOL_NAMES.length) {
    throw verificationError("RELEASE_ARTIFACTS_TOOL_CONTRACT");
  }
}

function verifyKordoc(entries, provenance) {
  const recordEntry = entries.find(({ name }) => name === "vendor/kordoc-core/PROVENANCE.json");
  if (recordEntry === undefined) throw verificationError("RELEASE_ARTIFACTS_KORDOC_INVALID");
  const record = parseJson(recordEntry.bytes, "RELEASE_ARTIFACTS_KORDOC_INVALID");
  if (!isRecord(record) || record.schemaVersion !== 2 || record.generatorVersion !== 2
    || record.source?.name !== "kordoc" || record.source?.version !== provenance.kordoc?.source?.version
    || record.source?.integrity !== provenance.kordoc?.source?.integrity
    || record.source?.resolved !== provenance.kordoc?.source?.resolved
    || provenance.kordoc?.recordSha256 !== sha256(recordEntry.bytes)
    || !Array.isArray(record.files) || record.files.length !== provenance.kordoc?.fileCount) {
    throw verificationError("RELEASE_ARTIFACTS_KORDOC_INVALID");
  }
  const vendorByName = new Map(entries
    .filter(({ name }) => name.startsWith("vendor/kordoc-core/") && name !== "vendor/kordoc-core/PROVENANCE.json")
    .map((entry) => [entry.name.slice("vendor/kordoc-core/".length), entry]));
  const provenancePaths = new Set();
  for (const file of record.files) {
    if (!isRecord(file) || typeof file.path !== "string" || !Number.isSafeInteger(file.size)
      || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw verificationError("RELEASE_ARTIFACTS_KORDOC_INVALID");
    }
    if (provenancePaths.has(file.path)) throw verificationError("RELEASE_ARTIFACTS_KORDOC_INVALID");
    provenancePaths.add(file.path);
    const entry = vendorByName.get(file.path);
    if (entry === undefined || entry.bytes.length !== file.size || sha256(entry.bytes) !== file.sha256) {
      throw verificationError("RELEASE_ARTIFACTS_KORDOC_INVALID");
    }
  }
  if (vendorByName.size !== provenancePaths.size
    || [...vendorByName.keys()].some((path) => !provenancePaths.has(path))) {
    throw verificationError("RELEASE_ARTIFACTS_KORDOC_INVALID");
  }
}

async function currentSourceIdentity(root) {
  if ((await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).length !== 0) {
    throw verificationError("RELEASE_ARTIFACTS_SOURCE_DIRTY");
  }
  const commit = singleLine(await git(root, ["rev-parse", "HEAD"]), /^[a-f0-9]{40}$/u);
  const tree = singleLine(await git(root, ["rev-parse", `${commit}^{tree}`]), /^[a-f0-9]{40}$/u);
  const repositoryUrl = canonicalRepositoryUrl(singleLine(
    await git(root, ["config", "--get", "remote.origin.url"]), /^https:\/\/\S+$/u,
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
    throw verificationError("RELEASE_ARTIFACTS_GIT_IDENTITY_MISSING");
  }
  const commitEpoch = Number(singleLine(await git(root, ["show", "-s", "--format=%ct", commit]), /^\d+$/u));
  return { commit, tree, repositoryUrl, commitEpoch };
}

async function assertSourceUnchanged(root, expected) {
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const commit = singleLine(await git(root, ["rev-parse", "HEAD"]), /^[a-f0-9]{40}$/u);
  const tree = singleLine(await git(root, ["rev-parse", `${commit}^{tree}`]), /^[a-f0-9]{40}$/u);
  if (status.length !== 0 || commit !== expected.commit || tree !== expected.tree) {
    throw verificationError("RELEASE_ARTIFACTS_SOURCE_CHANGED");
  }
}

async function trackedRuntimeAllowlist(root, commit) {
  const output = await git(root, ["ls-tree", "-r", "-z", commit, "--", `plugins/${PRODUCT}`]);
  const paths = output.split("\0").filter(Boolean).map((line) => {
    const match = /^(\d{6})\s+blob\s+[a-f0-9]+\t(.+)$/u.exec(line);
    if (!match || match[1] !== "100644" || !match[2].startsWith(RUNTIME_PREFIX)) {
      throw verificationError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
    }
    const path = match[2].slice(RUNTIME_PREFIX.length);
    validateArchiveName(path);
    return path;
  }).sort(asciiCompare);
  if (paths.length === 0) throw verificationError("RELEASE_ARTIFACTS_RUNTIME_ALLOWLIST");
  return paths;
}

function productionGraph(lock) {
  if (!isRecord(lock) || lock.lockfileVersion !== 3 || !isRecord(lock.packages) || !isRecord(lock.packages[""])) {
    throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
  const packages = lock.packages;
  const queue = [{ key: "", requestedName: packages[""].name ?? PRODUCT }];
  const seen = new Set();
  const nodes = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next.key)) continue;
    seen.add(next.key);
    const link = packages[next.key];
    if (!isRecord(link)) throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
    const record = link.link === true ? packages[link.resolved] : link;
    if (!isRecord(record)) throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
    const requiredPeers = Object.fromEntries(Object.entries(record.peerDependencies ?? {})
      .filter(([name]) => record.peerDependenciesMeta?.[name]?.optional !== true));
    const declared = {
      ...(record.dependencies ?? {}),
      ...(record.optionalDependencies ?? {}),
      ...requiredPeers,
    };
    if (!isRecord(declared)) throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
    const dependencies = Object.keys(declared).sort(asciiCompare).map((name) => {
      const key = resolveDependency(packages, next.key, name);
      queue.push({ key, requestedName: name });
      return key;
    });
    nodes.push({
      key: next.key,
      name: next.key === "" ? (record.name ?? PRODUCT) : (record.name ?? next.requestedName),
      version: requiredVersion(record.version),
      record,
      dependencies,
    });
  }
  return nodes.sort((left, right) => asciiCompare(left.key, right.key));
}

function resolveDependency(packages, fromKey, name) {
  let current = fromKey;
  while (true) {
    const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
    if (isRecord(packages[candidate])) return candidate;
    if (current === "") break;
    const marker = current.lastIndexOf("/node_modules/");
    current = marker < 0 ? "" : current.slice(0, marker);
  }
  throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
}

function expectedPackage(node) {
  const record = {
    SPDXID: packageSpdxId(node),
    name: node.name,
    versionInfo: node.version,
    downloadLocation: typeof node.record.resolved === "string" && /^https:\/\/\S+$/u.test(node.record.resolved)
      ? node.record.resolved : "NOASSERTION",
    licenseDeclared: declaredLicense(node.record),
  };
  const checksum = integrityChecksum(node.record.integrity);
  if (typeof node.record.resolved === "string"
    && node.record.resolved.startsWith("https://registry.npmjs.org/") && checksum === undefined) {
    throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
  if (checksum !== undefined) record.checksums = [checksum];
  return record;
}

function packageSignature(record) {
  return JSON.stringify([
    record.name,
    record.SPDXID,
    record.versionInfo,
    record.downloadLocation,
    record.licenseDeclared,
    record.checksums ?? null,
  ]);
}

function validChecksums(value) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length === 1 && value[0]?.algorithm === "SHA512"
    && /^[a-f0-9]{128}$/u.test(value[0]?.checksumValue);
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
    if (!isKnownLicenseId(tokens[index])) return false;
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

function declaredLicense(record) {
  if (record.license === undefined) return "NOASSERTION";
  if (!validLicense(record.license)) throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  return record.license;
}

function integrityChecksum(integrity) {
  if (typeof integrity !== "string") return undefined;
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
  if (!match) throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  const digest = Buffer.from(match[1], "base64");
  if (digest.length !== 64) throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  return { algorithm: "SHA512", checksumValue: digest.toString("hex") };
}

function packageSpdxId(node) {
  const safeName = node.name.replace(/[^A-Za-z0-9.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "package";
  return `SPDXRef-Package-${safeName}-${sha256(Buffer.from(node.key || "root")).slice(0, 16)}`;
}

function validDownload(value) {
  return value === "NOASSERTION" || (typeof value === "string" && /^https:\/\/\S+$/u.test(value));
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
    throw verificationError("RELEASE_ARTIFACTS_ENTRY_UNSAFE");
  }
}

function entryJson(entries, name, code) {
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw verificationError(code);
  return parseJson(entry.bytes, code);
}

function parseJson(bytes, code) {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw verificationError(code); }
}

function walkKeys(value, visitor) {
  if (Array.isArray(value)) { for (const child of value) walkKeys(child, visitor); return; }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) { visitor(key); walkKeys(child, visitor); }
}

function walkStrings(value, visitor) {
  if (typeof value === "string") { visitor(value); return; }
  if (Array.isArray(value)) { for (const child of value) walkStrings(child, visitor); return; }
  if (isRecord(value)) for (const child of Object.values(value)) walkStrings(child, visitor);
}

function requireExactKeys(value, keys) {
  if (!isRecord(value)
    || JSON.stringify(Object.keys(value).sort(asciiCompare)) !== JSON.stringify([...keys].sort(asciiCompare))) {
    throw verificationError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  }
}

function requireExactSpdxKeys(value, keys) {
  if (!isRecord(value)
    || JSON.stringify(Object.keys(value).sort(asciiCompare)) !== JSON.stringify([...keys].sort(asciiCompare))) {
    throw verificationError("RELEASE_ARTIFACTS_SPDX_INVALID");
  }
}

function validatePublicUrl(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw verificationError("RELEASE_ARTIFACTS_PROVENANCE_INVALID"); }
  const repository = kind === "repository" && url.hostname === "github.com"
    && url.pathname === "/Burntgogi/Gpt_Codex_HWP.git";
  const kordoc = kind === "kordoc" && url.hostname === "registry.npmjs.org"
    && /^\/kordoc\/-\/kordoc-[0-9A-Za-z.+-]+\.tgz$/u.test(url.pathname);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "" || url.href !== value
    || (!repository && !kordoc)) {
    throw verificationError("RELEASE_ARTIFACTS_PROVENANCE_INVALID");
  }
}

function epochFromDos(date, time) {
  const year = 1980 + ((date >>> 9) & 0x7f);
  const month = (date >>> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >>> 11) & 0x1f;
  const minute = (time >>> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw verificationError("RELEASE_ARTIFACTS_ZIP_METADATA");
  }
  const epoch = Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
  const roundTrip = new Date(epoch * 1000);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() + 1 !== month
    || roundTrip.getUTCDate() !== day || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute || roundTrip.getUTCSeconds() !== second) {
    throw verificationError("RELEASE_ARTIFACTS_ZIP_METADATA");
  }
  return epoch;
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
  return parseJson(
    await readGitBlob(root, commit, path, maximumBytes),
    "RELEASE_ARTIFACTS_INPUT_INVALID",
  );
}

async function readGitBlob(root, commit, path, maximumBytes) {
  const object = `${commit}:${path}`;
  let size;
  try { size = Number(singleLine(await git(root, ["cat-file", "-s", object]), /^\d+$/u)); }
  catch { throw verificationError("RELEASE_ARTIFACTS_INPUT_MISSING"); }
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
    throw verificationError("RELEASE_ARTIFACTS_INPUT_INVALID");
  }
  let output;
  try { output = await gitBuffer(root, ["show", object], maximumBytes + 1); }
  catch { throw verificationError("RELEASE_ARTIFACTS_INPUT_MISSING"); }
  if (output.length !== size) throw verificationError("RELEASE_ARTIFACTS_INPUT_INVALID");
  return output;
}

async function readRegularFileBounded(path, maximumBytes) {
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch { throw verificationError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT"); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 0 || before.size > maximumBytes) {
      throw verificationError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw verificationError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, before.size);
    const after = await handle.stat();
    if (extra.bytesRead !== 0 || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size) throw verificationError("RELEASE_ARTIFACTS_OUTPUT_CONTRACT");
    return bytes;
  } finally { await handle.close(); }
}

async function safeLstat(path, code) {
  try { return await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") throw verificationError(code); throw error; }
}

async function git(root, args) {
  try {
    const result = await executeFile("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return result.stdout;
  } catch { throw verificationError("RELEASE_ARTIFACTS_GIT_INVALID"); }
}

async function gitBuffer(root, args, maxBuffer) {
  try {
    const result = await executeFile("git", args, { cwd: root, encoding: "buffer", maxBuffer });
    return Buffer.from(result.stdout);
  } catch { throw verificationError("RELEASE_ARTIFACTS_GIT_INVALID"); }
}

function canonicalRepositoryUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw verificationError("RELEASE_ARTIFACTS_GIT_INVALID"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "" || url.hostname !== "github.com"
    || url.pathname !== "/Burntgogi/Gpt_Codex_HWP.git" || url.href !== value) {
    throw verificationError("RELEASE_ARTIFACTS_GIT_INVALID");
  }
  return url.href;
}

function exactGitValue(value, allowNull = false) {
  const raw = String(value).replace(/\r?\n$/u, "");
  const controls = allowNull
    ? /[\r\n\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  if (controls.test(raw)) throw verificationError("RELEASE_ARTIFACTS_GIT_IDENTITY_MISSING");
  return raw;
}

function singleLine(value, pattern) {
  const lines = String(value).trim().split(/\r?\n/u);
  if (lines.length !== 1 || !pattern.test(lines[0])) throw verificationError("RELEASE_ARTIFACTS_GIT_INVALID");
  return lines[0];
}

function requiredVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw verificationError("RELEASE_ARTIFACTS_INPUT_INVALID");
  }
  return value;
}

function resolveRequired(value) {
  if (typeof value !== "string" || value.trim().length === 0 || /[\r\n\0]/u.test(value)) {
    throw verificationError("RELEASE_ARTIFACTS_VERIFY_OPTIONS_INVALID");
  }
  return resolve(value);
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function asciiCompare(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function verificationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function runCli(argv) {
  let artifacts;
  let root;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || (flag !== "--artifacts" && flag !== "--root")) {
      throw verificationError("RELEASE_ARTIFACTS_VERIFY_USAGE");
    }
    if (flag === "--artifacts" && artifacts === undefined) artifacts = value;
    else if (flag === "--root" && root === undefined) root = value;
    else throw verificationError("RELEASE_ARTIFACTS_VERIFY_USAGE");
  }
  if (artifacts === undefined) throw verificationError("RELEASE_ARTIFACTS_VERIFY_USAGE");
  const receipt = await verifyReleaseArtifacts({ artifacts, ...(root === undefined ? {} : { root }) });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code?.startsWith?.("RELEASE_ARTIFACTS_") ? error.code : "RELEASE_ARTIFACTS_VERIFY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
