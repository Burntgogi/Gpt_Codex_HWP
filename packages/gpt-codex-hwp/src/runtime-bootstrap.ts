import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRODUCT = "gpt-codex-hwp";
const RECEIPT = "install-receipt.json";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_FILES = 10_000;
const MAX_MANIFEST_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_TOTAL_BYTES = 256 * 1024 * 1024;
const MAIN_ENTRIES = Object.freeze([
  "dist/doctor-main.js",
  "dist/mcp-main.js",
  "dist/oneshot-main.js",
] as const);

export type RuntimeMainEntry = typeof MAIN_ENTRIES[number];
export type RuntimeFailureCode =
  | "RUNTIME_NOT_INSTALLED"
  | "RUNTIME_RECEIPT_INVALID"
  | "RUNTIME_DEPENDENCIES_INVALID"
  | "RUNTIME_SOURCE_MISMATCH"
  | "RUNTIME_PLATFORM_MISMATCH"
  | "RUNTIME_PATH_INVALID";

export class RuntimeBootstrapError extends Error {
  constructor(readonly code: RuntimeFailureCode) {
    super(code);
    this.name = "RuntimeBootstrapError";
  }
}

export interface RuntimeReceipt {
  readonly schemaVersion: 1;
  readonly code: "RUNTIME_INSTALL_OK";
  readonly productId: string;
  readonly pluginVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeMajor: number;
  readonly nodeVersion: string;
  readonly manifestSha256: string;
  readonly packageLockSha256: string;
  readonly toolCount: 9;
  readonly doctorCode: "DOCTOR_OK";
  readonly dependencyCount: number;
  readonly createdAt: string;
}

export interface RuntimeBootstrapOptions {
  readonly codexHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly nodeVersion?: string;
}

export interface ManagedRuntimeIdentity {
  readonly pluginRoot: string;
  readonly codexHome: string;
  readonly productId: string;
  readonly pluginVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly manifestSha256: string;
  readonly packageLockSha256: string;
  readonly directDependencies: readonly string[];
  readonly manifestFiles: readonly RuntimeManifestFile[];
}

export interface RuntimeManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface RuntimeManifest {
  readonly productId: string;
  readonly files: readonly RuntimeManifestFile[];
}

export interface InstalledRuntime {
  readonly root: string;
  readonly mainUrl: string;
  readonly receipt: RuntimeReceipt;
}

export async function resolveManagedRuntime(
  importMetaUrl: string,
  options: RuntimeBootstrapOptions = {},
): Promise<ManagedRuntimeIdentity> {
  let entryPath: string;
  try {
    entryPath = fileURLToPath(importMetaUrl);
  } catch {
    throw failure("RUNTIME_PATH_INVALID");
  }
  const pluginRoot = resolve(dirname(entryPath), "..");
  await requireExactDirectory(pluginRoot);
  if (!samePath(dirname(entryPath), join(pluginRoot, "dist"))) {
    throw failure("RUNTIME_PATH_INVALID");
  }

  const productRoot = dirname(pluginRoot);
  const marketplaceRoot = dirname(productRoot);
  const cacheRoot = dirname(marketplaceRoot);
  const pluginsRoot = dirname(cacheRoot);
  const derivedCodexHome = dirname(pluginsRoot);
  if (basename(productRoot) !== PRODUCT || basename(cacheRoot) !== "cache"
    || basename(pluginsRoot) !== "plugins" || !safeName(basename(marketplaceRoot))) {
    throw failure("RUNTIME_PATH_INVALID");
  }
  const configuredCodexHome = options.codexHome ?? process.env.CODEX_HOME;
  const codexHome = configuredCodexHome === undefined
    ? derivedCodexHome
    : resolveAbsolute(configuredCodexHome);
  await requireExactDirectory(codexHome);
  if (!samePath(codexHome, derivedCodexHome)) throw failure("RUNTIME_PATH_INVALID");

  const plugin = await readManagedJson(pluginRoot, ".codex-plugin/plugin.json", MAX_JSON_BYTES);
  const pluginVersion = typeof plugin.version === "string" ? plugin.version : "";
  if (plugin.name !== PRODUCT || pluginVersion !== basename(pluginRoot)
    || !/^[0-9]+\.[0-9]+\.[0-9]+\+codex\.[A-Za-z0-9._-]{1,64}$/u.test(pluginVersion)) {
    throw failure("RUNTIME_PATH_INVALID");
  }

  const [runtimePackage, manifestRead, lockRead] = await Promise.all([
    readManagedJson(pluginRoot, "package.json", MAX_JSON_BYTES),
    readManagedBytes(pluginRoot, "runtime-manifest.json", MAX_MANIFEST_BYTES),
    readManagedBytes(pluginRoot, "package-lock.json", MAX_LOCK_BYTES),
  ]);
  const packageVersion = pluginVersion.split("+codex.")[0];
  const dependencies = plainRecord(runtimePackage.dependencies);
  if (runtimePackage.name !== PRODUCT || runtimePackage.version !== packageVersion
    || dependencies === undefined) {
    throw failure("RUNTIME_SOURCE_MISMATCH");
  }
  const directDependencies = Object.keys(dependencies).sort(asciiCompare);
  if (directDependencies.length < 1 || directDependencies.length > 64
    || directDependencies.some((name) => !safePackageName(name))) {
    throw failure("RUNTIME_SOURCE_MISMATCH");
  }
  const packageLockSha256 = sha256(lockRead.bytes);
  const manifest = parseManifest(manifestRead.bytes, pluginVersion, packageLockSha256);
  if (manifest.productId !== PRODUCT) throw failure("RUNTIME_SOURCE_MISMATCH");

  return Object.freeze({
    pluginRoot,
    codexHome,
    productId: PRODUCT,
    pluginVersion,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    nodeVersion: options.nodeVersion ?? process.versions.node,
    manifestSha256: sha256(manifestRead.bytes),
    packageLockSha256,
    directDependencies: Object.freeze(directDependencies),
    manifestFiles: manifest.files,
  });
}

export function resolveDurableRoot(identity: ManagedRuntimeIdentity): string {
  return join(
    identity.codexHome,
    "plugin-runtime-data",
    identity.productId,
    identity.pluginVersion,
    runtimePlatformKey(identity),
  );
}

export function runtimePlatformKey(identity: ManagedRuntimeIdentity): string {
  return `${identity.platform}-${identity.arch}-node${major(identity.nodeVersion)}`;
}

export async function readVerifiedManagedRuntimeFile(
  identity: ManagedRuntimeIdentity,
  record: RuntimeManifestFile,
): Promise<Uint8Array> {
  if (!identity.manifestFiles.some((entry) => entry.path === record.path
    && entry.size === record.size && entry.sha256 === record.sha256)) {
    throw failure("RUNTIME_SOURCE_MISMATCH");
  }
  let bytes: Uint8Array;
  try { ({ bytes } = await readOwnedBytes(identity.pluginRoot, record.path, MAX_MANIFEST_FILE_BYTES)); }
  catch (error) {
    if (error instanceof RuntimeBootstrapError) throw error;
    throw failure("RUNTIME_SOURCE_MISMATCH");
  }
  if (bytes.byteLength !== record.size || sha256(bytes) !== record.sha256) {
    throw failure("RUNTIME_SOURCE_MISMATCH");
  }
  return bytes;
}

export async function resolveInstalledRuntime(
  importMetaUrl: string,
  mainEntry: RuntimeMainEntry,
  options: RuntimeBootstrapOptions = {},
): Promise<InstalledRuntime> {
  if (!MAIN_ENTRIES.includes(mainEntry)) throw failure("RUNTIME_PATH_INVALID");
  const identity = await resolveManagedRuntime(importMetaUrl, options);
  const root = resolveDurableRoot(identity);
  try {
    await requireExactDirectory(root);
  } catch (error) {
    if (isMissing(error)) throw failure("RUNTIME_NOT_INSTALLED");
    if (error instanceof RuntimeBootstrapError) throw error;
    throw failure("RUNTIME_PATH_INVALID");
  }

  let receipt: RuntimeReceipt;
  try {
    const value = await readOwnedJson(root, RECEIPT, MAX_JSON_BYTES);
    receipt = validateReceipt(value);
  } catch (error) {
    if (error instanceof RuntimeBootstrapError && error.code === "RUNTIME_PATH_INVALID") throw error;
    throw failure("RUNTIME_RECEIPT_INVALID");
  }
  if (receipt.productId !== identity.productId
    || receipt.pluginVersion !== identity.pluginVersion
    || receipt.manifestSha256 !== identity.manifestSha256
    || receipt.packageLockSha256 !== identity.packageLockSha256) {
    throw failure("RUNTIME_SOURCE_MISMATCH");
  }
  const nodeMajor = major(identity.nodeVersion);
  if (receipt.platform !== identity.platform || receipt.arch !== identity.arch
    || receipt.nodeMajor !== nodeMajor) {
    throw failure("RUNTIME_PLATFORM_MISMATCH");
  }
  if (receipt.dependencyCount !== identity.directDependencies.length) {
    throw failure("RUNTIME_RECEIPT_INVALID");
  }
  try {
    await requireOwnedRegularFile(root, mainEntry);
    for (const dependency of identity.directDependencies) {
      if (dependency === "kordoc") await requireKordocDependency(root);
      else await requireOwnedRegularFile(root, packageJsonPath(dependency));
    }
  } catch {
    throw failure("RUNTIME_DEPENDENCIES_INVALID");
  }
  return Object.freeze({
    root,
    mainUrl: pathToFileURL(join(root, ...mainEntry.split("/"))).href,
    receipt,
  });
}

export async function resolveNpmCommand(): Promise<Readonly<{
  command: string;
  argsPrefix: readonly string[];
}> | null> {
  const executableDirectory = dirname(process.execPath);
  const candidates = process.platform === "win32"
    ? [join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js")]
    : [
      resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      resolve(executableDirectory, "..", "share", "node_modules", "npm", "bin", "npm-cli.js"),
      "/usr/share/nodejs/npm/bin/npm-cli.js",
    ];
  for (const candidate of candidates) {
    try {
      const status = await lstat(candidate);
      if (!status.isSymbolicLink() && status.isFile()) {
        return Object.freeze({ command: process.execPath, argsPrefix: Object.freeze([candidate]) });
      }
    } catch {
      // Fixed installation layouts only.
    }
  }
  return null;
}

async function requireKordocDependency(root: string): Promise<void> {
  const vendor = join(root, "vendor", "kordoc-core");
  const dependency = join(root, "node_modules", "kordoc");
  const [vendorStatus, dependencyStatus] = await Promise.all([lstat(vendor), lstat(dependency)]);
  if (!vendorStatus.isDirectory() || vendorStatus.isSymbolicLink()
    || (!dependencyStatus.isDirectory() && !dependencyStatus.isSymbolicLink())) {
    throw new Error("invalid kordoc dependency");
  }
  const [canonicalRoot, canonicalVendor, canonicalDependency] = await Promise.all([
    realpath(root),
    realpath(vendor),
    realpath(dependency),
  ]);
  const validDependency = dependencyStatus.isSymbolicLink()
    ? samePath(canonicalVendor, canonicalDependency)
    : dependencyStatus.isDirectory() && samePath(dependency, canonicalDependency);
  if (!inside(canonicalRoot, canonicalVendor) || !inside(canonicalRoot, canonicalDependency)
    || !validDependency) {
    throw new Error("invalid kordoc dependency");
  }
  const packageStatus = await lstat(join(dependency, "package.json"));
  if (!packageStatus.isFile() || packageStatus.isSymbolicLink()) throw new Error("invalid kordoc dependency");
}

function validateReceipt(value: unknown): RuntimeReceipt {
  const receipt = plainRecord(value);
  const expectedKeys = [
    "arch", "code", "createdAt", "dependencyCount", "doctorCode", "manifestSha256",
    "nodeMajor", "nodeVersion", "packageLockSha256", "platform", "pluginVersion",
    "productId", "schemaVersion", "toolCount",
  ];
  if (receipt === undefined
    || Object.keys(receipt).sort(asciiCompare).join(",") !== expectedKeys.join(",")
    || receipt.schemaVersion !== 1 || receipt.code !== "RUNTIME_INSTALL_OK"
    || typeof receipt.productId !== "string" || typeof receipt.pluginVersion !== "string"
    || typeof receipt.platform !== "string" || typeof receipt.arch !== "string"
    || !Number.isSafeInteger(receipt.nodeMajor) || typeof receipt.nodeVersion !== "string"
    || !hash(receipt.manifestSha256) || !hash(receipt.packageLockSha256)
    || receipt.toolCount !== 9 || receipt.doctorCode !== "DOCTOR_OK"
    || !Number.isSafeInteger(receipt.dependencyCount) || Number(receipt.dependencyCount) < 1
    || Number.isNaN(Date.parse(String(receipt.createdAt)))) {
    throw new Error("invalid receipt");
  }
  return receipt as unknown as RuntimeReceipt;
}

function parseManifest(bytes: Uint8Array, pluginVersion: string, lockHash: string): RuntimeManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw failure("RUNTIME_SOURCE_MISMATCH"); }
  const manifest = plainRecord(parsed);
  if (manifest === undefined
    || Object.keys(manifest).sort(asciiCompare).join(",") !== "files,mainEntries,packageLockSha256,pluginVersion,productId,schemaVersion"
    || manifest.schemaVersion !== 1 || manifest.productId !== PRODUCT
    || manifest.pluginVersion !== pluginVersion || manifest.packageLockSha256 !== lockHash
    || JSON.stringify(manifest.mainEntries) !== JSON.stringify(MAIN_ENTRIES)
    || !Array.isArray(manifest.files) || manifest.files.length < 1
    || manifest.files.length > MAX_MANIFEST_FILES) {
    throw failure("RUNTIME_SOURCE_MISMATCH");
  }
  let total = 0;
  let previous = "";
  const folded = new Set<string>();
  const files: RuntimeManifestFile[] = [];
  for (const value of manifest.files) {
    const record = plainRecord(value);
    if (record === undefined || Object.keys(record).sort(asciiCompare).join(",") !== "path,sha256,size"
      || typeof record.path !== "string" || !durablePath(record.path)
      || !Number.isSafeInteger(record.size) || Number(record.size) < 0
      || Number(record.size) > MAX_MANIFEST_FILE_BYTES || !hash(record.sha256)
      || (previous !== "" && asciiCompare(previous, record.path) >= 0)) {
      throw failure("RUNTIME_SOURCE_MISMATCH");
    }
    const key = record.path.toLowerCase();
    if (folded.has(key)) throw failure("RUNTIME_SOURCE_MISMATCH");
    folded.add(key);
    previous = record.path;
    total += Number(record.size);
    if (total > MAX_MANIFEST_TOTAL_BYTES) throw failure("RUNTIME_SOURCE_MISMATCH");
    files.push(Object.freeze({
      path: record.path,
      size: Number(record.size),
      sha256: record.sha256,
    }));
  }
  return Object.freeze({ productId: String(manifest.productId), files: Object.freeze(files) });
}

async function readManagedJson(root: string, path: string, maximumBytes: number): Promise<Record<string, unknown>> {
  const { bytes } = await readManagedBytes(root, path, maximumBytes);
  try {
    const value = plainRecord(JSON.parse(new TextDecoder().decode(bytes)));
    if (value === undefined) throw new Error("not an object");
    return value;
  } catch {
    throw failure("RUNTIME_SOURCE_MISMATCH");
  }
}

async function readManagedBytes(root: string, path: string, maximumBytes: number) {
  try { return await readOwnedBytes(root, path, maximumBytes); }
  catch (error) {
    if (error instanceof RuntimeBootstrapError) throw error;
    throw failure("RUNTIME_PATH_INVALID");
  }
}

async function readOwnedJson(root: string, path: string, maximumBytes: number): Promise<unknown> {
  const { bytes } = await readOwnedBytes(root, path, maximumBytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readOwnedBytes(root: string, path: string, maximumBytes: number) {
  const absolute = await requireOwnedRegularFile(root, path);
  const before = await lstat(absolute);
  if (before.size < 1 || before.size > maximumBytes) throw new Error("invalid file size");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size) {
      throw new Error("file identity changed");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== before.size || !sameIdentity(opened, after)
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("file changed while reading");
    }
    return Object.freeze({ bytes });
  } finally {
    await handle.close();
  }
}

async function requireOwnedRegularFile(root: string, path: string): Promise<string> {
  if (!safeRelative(path)) throw failure("RUNTIME_PATH_INVALID");
  const canonicalRoot = await realpath(root);
  let current = root;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const status = await lstat(current);
    if (status.isSymbolicLink()) throw failure("RUNTIME_PATH_INVALID");
    const final = index === segments.length - 1;
    if (final ? !status.isFile() : !status.isDirectory()) throw new Error("invalid runtime entry");
    const canonical = await realpath(current);
    if (!inside(canonicalRoot, canonical) || !samePath(current, canonical)) {
      throw failure("RUNTIME_PATH_INVALID");
    }
  }
  return current;
}

async function requireExactDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw failure("RUNTIME_PATH_INVALID");
  if (!samePath(resolve(path), await realpath(path))) throw failure("RUNTIME_PATH_INVALID");
}

function resolveAbsolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw failure("RUNTIME_PATH_INVALID");
  return resolve(path);
}

function packageJsonPath(name: string): string {
  return `node_modules/${name}/package.json`;
}

function safePackageName(value: string): boolean {
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(value) && value.length <= 214;
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/u.test(value) && value !== "." && value !== "..";
}

function safeRelative(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function durablePath(path: string): boolean {
  if (!safeRelative(path) || path === "runtime-manifest.json" || path.startsWith("node_modules/")) return false;
  return new Set([
    ".codex-plugin/plugin.json", ".npmrc", "examples/mcp-manual.json",
    "examples/oneshot-tool-schemas.json", "package-lock.json", "package.json",
  ]).has(path) || ["dist/", "scripts/", "vendor/"].some((prefix) => path.startsWith(prefix));
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value as Record<string, unknown>
    : undefined;
}

function major(version: string): number {
  const value = Number(version.split(".")[0]);
  if (!Number.isSafeInteger(value) || value < 22) throw failure("RUNTIME_PLATFORM_MISMATCH");
  return value;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  if (samePath(root, candidate)) return true;
  const suffix = relative(root, candidate);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function sameIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(code: RuntimeFailureCode): RuntimeBootstrapError {
  return new RuntimeBootstrapError(code);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
