const MIB = 1024 * 1024;

export const EXCLUDED_PACKAGES = Object.freeze([
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-web",
  "@hyzyla/pdfium",
  "pdfjs-dist",
  "boolean",
]);

const EXCLUDED_PACKAGE_MATCHERS = EXCLUDED_PACKAGES.map((name) => ({
  name,
  segments: name.split("/"),
}));

export function isExcludedPackagePath(input) {
  return matchExcludedPackage(input) !== undefined;
}

export function summarizeInstalledEntries({ filePaths, linkPaths }) {
  const excludedPackages = Object.fromEntries(EXCLUDED_PACKAGES.map((name) => [name, false]));
  const excludedPaths = [];
  for (const path of [...filePaths, ...linkPaths]) {
    const packageName = matchExcludedPackage(path);
    if (packageName === undefined) continue;
    excludedPaths.push(path);
    excludedPackages[packageName] = true;
  }
  return {
    installedFileCount: filePaths.length,
    installedLinkCount: linkPaths.length,
    installedEntryCount: filePaths.length + linkPaths.length,
    excludedPaths,
    excludedPackages,
  };
}

function matchExcludedPackage(input) {
  if (typeof input !== "string") return undefined;
  const segments = input
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== "node_modules") continue;
    for (const matcher of EXCLUDED_PACKAGE_MATCHERS) {
      if (matcher.segments.every((segment, offset) => segments[index + offset + 1] === segment)) {
        return matcher.name;
      }
    }
  }
  return undefined;
}

export function assertCompactBudgets({ nodeModulesBytes, installedBytes, publicRuntimeBytes }) {
  if (nodeModulesBytes > 64 * MIB) throw new Error(`node_modules budget exceeded: ${nodeModulesBytes}`);
  if (installedBytes > 80 * MIB) throw new Error(`installed runtime budget exceeded: ${installedBytes}`);
  if (publicRuntimeBytes > 16 * MIB) throw new Error(`public runtime budget exceeded: ${publicRuntimeBytes}`);
}

export function assertCompactLockfile(lock) {
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    throw new Error("Compact lockfile must contain a packages object.");
  }
  const excludedPaths = Object.keys(lock.packages).filter(isExcludedPackagePath);
  if (excludedPaths.length > 0) {
    throw new Error(`Excluded dependencies in compact lockfile: ${excludedPaths.join(", ")}`);
  }
  return excludedPaths;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
