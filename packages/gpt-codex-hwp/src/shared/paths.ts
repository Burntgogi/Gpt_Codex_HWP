import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { join, parse as parsePath, resolve } from "node:path";

export interface ResolveLocalPathOptions {
  /** Accept a Windows UNC path even without a permitting allowed root. */
  readonly allowNetwork?: boolean;
}

// Windows UNC roots (\\server\share) explicitly configured as allowed roots.
// Other network paths are rejected so a document cannot steer the agent into
// an SMB connection to an arbitrary host.
let permittedNetworkRootKeys: readonly string[] = Object.freeze([]);
// Shares reached through a drive letter the caller named (a mapped network
// drive). realpath reports them in UNC form, and re-authorizing that canonical
// spelling must not fail.
const derivedNetworkRootKeys = new Set<string>();
const MAX_DERIVED_NETWORK_ROOTS = 32;

export function setPermittedNetworkRoots(roots: readonly string[]): void {
  permittedNetworkRootKeys = Object.freeze(
    roots.filter(isWindowsNetworkPath).map(networkRootKey),
  );
}

export function isWindowsNetworkPath(path: string): boolean {
  return /^\\\\(?![.?]\\)[^\\]/u.test(path.replaceAll("/", "\\"));
}

/**
 * Records that a caller-named local drive path resolved to a UNC share, so the
 * canonical UNC spelling of that share passes later checks. Ignored unless the
 * local spelling is not a network path and the canonical one is.
 */
export function permitDerivedNetworkPath(localSpelling: string, canonical: string): void {
  if (process.platform !== "win32" || isWindowsNetworkPath(localSpelling)
    || !isWindowsNetworkPath(canonical)) return;
  if (derivedNetworkRootKeys.size >= MAX_DERIVED_NETWORK_ROOTS) return;
  derivedNetworkRootKeys.add(networkRootKey(parsePath(resolve(canonical)).root));
}

function networkRootKey(path: string): string {
  const key = resolve(path).normalize("NFC").toLocaleLowerCase("en-US");
  return key.endsWith("\\") ? key : `${key}\\`;
}

export function clearDerivedNetworkRoots(): void {
  derivedNetworkRootKeys.clear();
}

function assertNetworkPathPermitted(path: string, label: string): void {
  if (!isWindowsNetworkPath(path)) return;
  const key = networkRootKey(path);
  if (permittedNetworkRootKeys.some((root) => key.startsWith(root))) return;
  // A share reached through a mapped drive stays readable only: every output
  // path is resolved under an output label first, which never uses it.
  if (!/output/iu.test(label)) {
    for (const root of derivedNetworkRootKeys) if (key.startsWith(root)) return;
  }
  throw new UnsafeWindowsPathError(
    label,
    "network (UNC) paths are not accepted unless an allowed root permits them",
  );
}

export function resolveLocalPath(
  localPath: string,
  label = "path",
  options: ResolveLocalPathOptions = {},
): string {
  if (typeof localPath !== "string" || localPath.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  if (process.platform !== "win32") return canonicalizeKnownAliases(resolve(localPath));

  assertSafeWindowsPath(localPath, label);
  const lexical = resolve(localPath);
  assertSafeWindowsPath(lexical, label);
  // Decide on network paths before any filesystem access: expanding an 8.3
  // name below would otherwise contact the host named in the path.
  if (options.allowNetwork !== true) assertNetworkPathPermitted(lexical, label);
  const resolved = canonicalizeKnownAliases(lexical);
  if (resolved !== lexical) {
    assertSafeWindowsPath(resolved, label);
    permitDerivedNetworkPath(lexical, resolved);
    if (options.allowNetwork !== true) assertNetworkPathPermitted(resolved, label);
  }
  return resolved;
}

// macOS ships these root-owned aliases into /private. Paths through them are
// rewritten to the real location instead of being rejected as linked paths.
const MACOS_SYSTEM_ALIASES = Object.freeze(["/tmp", "/var", "/etc"]);

/**
 * Rewrites two benign spellings to their canonical form so later
 * realpath-equality checks do not reject them: Windows 8.3 short names (such
 * as a TEMP directory below an abbreviated profile name) when no component on
 * the way is a link or junction, and the macOS /tmp, /var, and /etc aliases.
 */
export function canonicalizeKnownAliases(path: string): string {
  if (process.platform === "darwin") return canonicalizeMacosSystemAlias(path);
  if (process.platform === "win32") return expandWindowsShortNames(path);
  return path;
}

function canonicalizeMacosSystemAlias(path: string): string {
  for (const alias of MACOS_SYSTEM_ALIASES) {
    if (path !== alias && !path.startsWith(`${alias}/`)) continue;
    try {
      const status = lstatSync(alias);
      if (!status.isSymbolicLink() || status.uid !== 0) return path;
      if (readlinkSync(alias) !== `private${alias}`) return path;
      return `/private${path}`;
    } catch {
      return path;
    }
  }
  return path;
}

function expandWindowsShortNames(path: string): string {
  const root = parsePath(path).root;
  const segments = path.slice(root.length).split(/[\\/]+/u).filter(Boolean);
  let last = -1;
  segments.forEach((segment, index) => { if (/~\d/u.test(segment)) last = index; });
  if (last < 0) return path;
  let prefix = root;
  for (const segment of segments.slice(0, last + 1)) {
    prefix = join(prefix, segment);
    try {
      if (lstatSync(prefix).isSymbolicLink()) return path;
    } catch {
      return path;
    }
  }
  try {
    const expanded = realpathSync.native(prefix);
    if (expanded.toLocaleLowerCase("en-US") === prefix.toLocaleLowerCase("en-US")) return path;
    return join(expanded, ...segments.slice(last + 1));
  } catch {
    return path;
  }
}

export class UnsafeWindowsPathError extends Error {
  readonly code: "UNSAFE_OUTPUT_PATH" | "UNSAFE_LOCAL_PATH";

  constructor(label: string, reason: string) {
    super(`${label} uses unsafe Windows path syntax: ${reason}`);
    this.name = "UnsafeWindowsPathError";
    this.code = /output/iu.test(label)
      ? "UNSAFE_OUTPUT_PATH"
      : "UNSAFE_LOCAL_PATH";
  }
}

function assertSafeWindowsPath(path: string, label: string): void {
  const withWindowsSeparators = path.replaceAll("/", "\\");
  if (/^\\\\[.?]\\/u.test(withWindowsSeparators)) {
    throw new UnsafeWindowsPathError(
      label,
      "device namespace paths are not accepted",
    );
  }

  const root = parsePath(path).root;
  const remainder = path.slice(root.length);
  if (remainder.includes(":")) {
    throw new UnsafeWindowsPathError(
      label,
      "alternate data streams are not accepted",
    );
  }

  const components = remainder.split(/[\\/]+/u).filter(Boolean);
  for (const component of components) {
    // "." and ".." are relative navigation; the resolved path is rechecked.
    if (component === "." || component === "..") continue;
    if (/[ .]$/u.test(component)) {
      throw new UnsafeWindowsPathError(
        label,
        "components must not end with a dot or space",
      );
    }
    if (/[<>"|?*\u0000-\u001f]/u.test(component)) {
      throw new UnsafeWindowsPathError(
        label,
        "components contain invalid or control characters",
      );
    }
    if (
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(?:\.|$)/iu.test(
        component,
      )
    ) {
      throw new UnsafeWindowsPathError(
        label,
        `reserved DOS device name ${component} is not accepted`,
      );
    }
  }
}
