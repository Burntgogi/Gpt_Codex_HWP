import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { join, parse as parsePath, resolve } from "node:path";
// Windows UNC roots (\\server\share) explicitly configured as allowed roots.
// Other network paths are rejected so a document cannot steer the agent into
// an SMB connection to an arbitrary host.
let permittedNetworkRootKeys = Object.freeze([]);
export function setPermittedNetworkRoots(roots) {
    permittedNetworkRootKeys = Object.freeze(roots.filter(isWindowsNetworkPath).map(networkRootKey));
}
export function isWindowsNetworkPath(path) {
    return /^\\\\(?![.?]\\)[^\\]/u.test(path.replaceAll("/", "\\"));
}
function networkRootKey(path) {
    const key = resolve(path).normalize("NFC").toLocaleLowerCase("en-US");
    return key.endsWith("\\") ? key : `${key}\\`;
}
export function resolveLocalPath(localPath, label = "path", options = {}) {
    if (typeof localPath !== "string" || localPath.trim().length === 0) {
        throw new Error(`${label} must not be empty.`);
    }
    if (process.platform === "win32") {
        assertSafeWindowsPath(localPath, label);
    }
    const resolved = canonicalizeKnownAliases(resolve(localPath));
    if (process.platform === "win32") {
        assertSafeWindowsPath(resolved, label);
        if (isWindowsNetworkPath(resolved) && options.allowNetwork !== true) {
            const key = networkRootKey(resolved);
            if (!permittedNetworkRootKeys.some((root) => key.startsWith(root))) {
                throw new UnsafeWindowsPathError(label, "network (UNC) paths are not accepted unless an allowed root permits them");
            }
        }
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
export function canonicalizeKnownAliases(path) {
    if (process.platform === "darwin")
        return canonicalizeMacosSystemAlias(path);
    if (process.platform === "win32")
        return expandWindowsShortNames(path);
    return path;
}
function canonicalizeMacosSystemAlias(path) {
    for (const alias of MACOS_SYSTEM_ALIASES) {
        if (path !== alias && !path.startsWith(`${alias}/`))
            continue;
        try {
            const status = lstatSync(alias);
            if (!status.isSymbolicLink() || status.uid !== 0)
                return path;
            if (readlinkSync(alias) !== `private${alias}`)
                return path;
            return `/private${path}`;
        }
        catch {
            return path;
        }
    }
    return path;
}
function expandWindowsShortNames(path) {
    const root = parsePath(path).root;
    const segments = path.slice(root.length).split(/[\\/]+/u).filter(Boolean);
    let last = -1;
    segments.forEach((segment, index) => { if (/~\d/u.test(segment))
        last = index; });
    if (last < 0)
        return path;
    let prefix = root;
    for (const segment of segments.slice(0, last + 1)) {
        prefix = join(prefix, segment);
        try {
            if (lstatSync(prefix).isSymbolicLink())
                return path;
        }
        catch {
            return path;
        }
    }
    try {
        const expanded = realpathSync.native(prefix);
        if (expanded.toLocaleLowerCase("en-US") === prefix.toLocaleLowerCase("en-US"))
            return path;
        return join(expanded, ...segments.slice(last + 1));
    }
    catch {
        return path;
    }
}
export class UnsafeWindowsPathError extends Error {
    code;
    constructor(label, reason) {
        super(`${label} uses unsafe Windows path syntax: ${reason}`);
        this.name = "UnsafeWindowsPathError";
        this.code = /output/iu.test(label)
            ? "UNSAFE_OUTPUT_PATH"
            : "UNSAFE_LOCAL_PATH";
    }
}
function assertSafeWindowsPath(path, label) {
    const withWindowsSeparators = path.replaceAll("/", "\\");
    if (/^\\\\[.?]\\/u.test(withWindowsSeparators)) {
        throw new UnsafeWindowsPathError(label, "device namespace paths are not accepted");
    }
    const root = parsePath(path).root;
    const remainder = path.slice(root.length);
    if (remainder.includes(":")) {
        throw new UnsafeWindowsPathError(label, "alternate data streams are not accepted");
    }
    const components = remainder.split(/[\\/]+/u).filter(Boolean);
    for (const component of components) {
        // "." and ".." are relative navigation; the resolved path is rechecked.
        if (component === "." || component === "..")
            continue;
        if (/[ .]$/u.test(component)) {
            throw new UnsafeWindowsPathError(label, "components must not end with a dot or space");
        }
        if (/[<>"|?*\u0000-\u001f]/u.test(component)) {
            throw new UnsafeWindowsPathError(label, "components contain invalid or control characters");
        }
        if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(?:\.|$)/iu.test(component)) {
            throw new UnsafeWindowsPathError(label, `reserved DOS device name ${component} is not accepted`);
        }
    }
}
