import { lstat, realpath, stat } from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import { resolveLocalPath } from "./paths.js";

const MAX_CONFIGURATION_BYTES = 16_384;
const MAX_ROOTS = 32;
const MAX_ROOT_CHARACTERS = 4_096;

interface CanonicalRoot {
  readonly path: string;
  readonly key: string;
  readonly label: string;
}

export interface AllowedRootsPolicy {
  readonly configured: boolean;
  readonly rootLabels: readonly string[];
  authorizeExistingPath(path: string): Promise<string>;
  authorizeFuturePath(path: string): Promise<string>;
}

export class AllowedRootsConfigurationError extends Error {
  readonly code = "INVALID_ALLOWED_ROOTS_CONFIGURATION";

  constructor(rootLabel?: string) {
    super(
      rootLabel === undefined
        ? "Allowed roots configuration is invalid."
        : `Allowed roots configuration is invalid at ${rootLabel}.`,
    );
    this.name = "AllowedRootsConfigurationError";
  }
}

export class AllowedRootsPathError extends Error {
  readonly code = "PATH_OUTSIDE_ALLOWED_ROOTS";

  constructor() {
    super("Path is outside configured allowed roots.");
    this.name = "AllowedRootsPathError";
  }
}

const unrestrictedPolicy = createUnrestrictedPolicy();
let activePolicy: AllowedRootsPolicy = unrestrictedPolicy;

export async function createAllowedRootsPolicy(
  config: string | undefined,
): Promise<AllowedRootsPolicy> {
  if (config === undefined) return unrestrictedPolicy;
  const configuredRoots = parseConfiguration(config);
  const roots: CanonicalRoot[] = [];
  const seen = new Set<string>();

  for (const [index, configuredRoot] of configuredRoots.entries()) {
    const label = `root[${index}]`;
    try {
      const lexicalRoot = resolveLocalPath(configuredRoot, label);
      await assertNoLinkedComponents(lexicalRoot, "configuration");
      const [canonicalPath, status] = await Promise.all([
        realpath(lexicalRoot),
        stat(lexicalRoot, { bigint: true }),
      ]);
      if (!status.isDirectory()) throw new Error("not-directory");
      if (comparisonKey(canonicalPath) !== comparisonKey(lexicalRoot)) {
        throw new Error("non-canonical-root");
      }
      const key = comparisonKey(canonicalPath);
      if (seen.has(key)) throw new Error("duplicate-root");
      seen.add(key);
      roots.push({ path: canonicalPath, key, label });
    } catch {
      throw new AllowedRootsConfigurationError(label);
    }
  }

  return Object.freeze({
    configured: true,
    rootLabels: Object.freeze(roots.map((root) => root.label)),
    authorizeExistingPath: (path: string) => authorizeExisting(roots, path),
    authorizeFuturePath: (path: string) => authorizeFuture(roots, path),
  });
}

export function setActiveAllowedRootsPolicy(policy: AllowedRootsPolicy): void {
  if (
    typeof policy !== "object" ||
    policy === null ||
    typeof policy.authorizeExistingPath !== "function" ||
    typeof policy.authorizeFuturePath !== "function"
  ) {
    throw new AllowedRootsConfigurationError();
  }
  activePolicy = policy;
}

export function resetActiveAllowedRootsPolicy(): void {
  activePolicy = unrestrictedPolicy;
}

export function authorizeExistingPath(path: string): Promise<string> {
  return activePolicy.authorizeExistingPath(path);
}

export function authorizeFuturePath(path: string): Promise<string> {
  return activePolicy.authorizeFuturePath(path);
}

function createUnrestrictedPolicy(): AllowedRootsPolicy {
  return Object.freeze({
    configured: false,
    rootLabels: Object.freeze([]),
    async authorizeExistingPath(path: string): Promise<string> {
      const resolved = resolveLocalPath(path);
      try {
        return await realpath(resolved);
      } catch {
        return resolved;
      }
    },
    async authorizeFuturePath(path: string): Promise<string> {
      return resolveLocalPath(path);
    },
  });
}

function parseConfiguration(config: string): string[] {
  if (
    typeof config !== "string" ||
    Buffer.byteLength(config, "utf8") > MAX_CONFIGURATION_BYTES
  ) {
    throw new AllowedRootsConfigurationError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new AllowedRootsConfigurationError();
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ROOTS) {
    throw new AllowedRootsConfigurationError();
  }

  const roots: string[] = [];
  const rawSeen = new Set<string>();
  for (const [index, value] of parsed.entries()) {
    const label = `root[${index}]`;
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_ROOT_CHARACTERS ||
      value.trim() !== value ||
      !isAbsolute(value)
    ) {
      throw new AllowedRootsConfigurationError(label);
    }
    const key = comparisonKey(resolve(value));
    if (rawSeen.has(key)) throw new AllowedRootsConfigurationError(label);
    rawSeen.add(key);
    roots.push(value);
  }
  return roots;
}

async function authorizeExisting(
  roots: readonly CanonicalRoot[],
  candidate: string,
): Promise<string> {
  try {
    const lexicalPath = resolveLocalPath(candidate);
    await assertNoLinkedComponents(lexicalPath, "path");
    const canonicalPath = await realpath(lexicalPath);
    if (!isWithinAnyRoot(roots, canonicalPath)) throw new Error("outside");
    return canonicalPath;
  } catch {
    throw new AllowedRootsPathError();
  }
}

async function authorizeFuture(
  roots: readonly CanonicalRoot[],
  candidate: string,
): Promise<string> {
  try {
    const lexicalPath = resolveLocalPath(candidate);
    const existingAncestor = await nearestExistingAncestor(lexicalPath);
    await assertNoLinkedComponents(existingAncestor, "path");
    const [canonicalAncestor, ancestorStatus] = await Promise.all([
      realpath(existingAncestor),
      stat(existingAncestor),
    ]);
    if (!ancestorStatus.isDirectory() && existingAncestor !== lexicalPath) {
      throw new Error("parent-not-directory");
    }

    let canonicalPath: string;
    if (existingAncestor === lexicalPath) {
      const finalStatus = await lstat(lexicalPath);
      if (finalStatus.isSymbolicLink()) throw new Error("linked-final");
      canonicalPath = canonicalAncestor;
    } else {
      const suffix = relative(existingAncestor, lexicalPath);
      if (suffix === "" || suffix.startsWith(`..${sep}`) || suffix === "..") {
        throw new Error("invalid-relative-path");
      }
      canonicalPath = resolve(canonicalAncestor, suffix);
    }

    if (!isWithinAnyRoot(roots, canonicalPath)) throw new Error("outside");
    return canonicalPath;
  } catch {
    throw new AllowedRootsPathError();
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = parsePath(current).dir;
      if (parent === current || parent.length === 0) throw error;
      current = parent;
    }
  }
}

async function assertNoLinkedComponents(
  path: string,
  _context: "configuration" | "path",
): Promise<void> {
  for (const component of absolutePathComponents(path)) {
    try {
      const status = await lstat(component);
      if (status.isSymbolicLink()) throw new Error("linked-component");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  }
}

function absolutePathComponents(path: string): string[] {
  const root = parsePath(path).root;
  const components = [root];
  let current = root;
  for (const segment of path.slice(root.length).split(/[\\/]+/u)) {
    if (segment.length === 0) continue;
    current = join(current, segment);
    components.push(current);
  }
  return components;
}

function isWithinAnyRoot(
  roots: readonly CanonicalRoot[],
  candidate: string,
): boolean {
  const candidateKey = comparisonKey(candidate);
  return roots.some((root) => {
    if (candidateKey === root.key) return true;
    const suffix = relative(root.path, candidate);
    return suffix !== "" && suffix !== ".." &&
      !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  });
}

function comparisonKey(path: string): string {
  const normalized = resolve(path).normalize("NFC");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}
