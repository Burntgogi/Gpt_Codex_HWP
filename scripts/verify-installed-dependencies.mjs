import { lstat, realpath, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INSTALLED_EXCLUDED_PACKAGES = Object.freeze([
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-web",
  "@hyzyla/pdfium",
  "pdfjs-dist",
  "boolean",
]);

const EXCLUDED_MATCHERS = INSTALLED_EXCLUDED_PACKAGES.map((name) => name.split("/"));

export function isInstalledExcludedPackagePath(input) {
  if (typeof input !== "string") return false;
  const segments = input
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== "node_modules") continue;
    if (EXCLUDED_MATCHERS.some((matcher) => matcher.every(
      (segment, offset) => segments[index + offset + 1] === segment,
    ))) return true;
  }
  return false;
}

export async function assertInstalledDependencyTree({ packageRoot, label }) {
  const root = resolveRequiredPath(packageRoot, "packageRoot");
  const treeLabel = requiredLabel(label);
  const nodeModules = join(root, "node_modules");
  const nodeModulesInfo = await requiredEntry(nodeModules, `${treeLabel} node_modules`);
  if (nodeModulesInfo.isSymbolicLink() || !nodeModulesInfo.isDirectory()) {
    throw dependencyContractError(`${treeLabel} node_modules must be a non-link directory`);
  }

  const vendor = join(root, "vendor", "kordoc-core");
  const vendorInfo = await requiredEntry(vendor, `${treeLabel} vendored Kordoc core`);
  if (vendorInfo.isSymbolicLink() || !vendorInfo.isDirectory()) {
    throw dependencyContractError(`${treeLabel} vendored Kordoc core must be a non-link directory`);
  }
  const canonicalNodeModules = await realpath(nodeModules);
  const canonicalVendor = await realpath(vendor);
  let sawKordocLink = false;
  let fileCount = 0;
  let linkCount = 0;
  let bytes = 0;

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (isInstalledExcludedPackagePath(path)) {
        throw dependencyContractError(`${treeLabel} contains excluded package path: ${path}`);
      }
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        linkCount += 1;
        const canonicalTarget = await realpath(absolute);
        if (path === "node_modules/kordoc") {
          if (!samePath(canonicalTarget, canonicalVendor)) {
            throw dependencyContractError(`${treeLabel} Kordoc link target is not the vendored compact core`);
          }
          sawKordocLink = true;
          continue;
        }
        if (path.startsWith("node_modules/.bin/")) {
          const targetPath = relative(canonicalNodeModules, canonicalTarget);
          if (isAbsolute(targetPath) || targetPath === ".." || targetPath.startsWith(`..${sep}`)) {
            throw dependencyContractError(`${treeLabel} executable link escapes node_modules: ${path}`);
          }
          const normalizedTarget = `node_modules/${targetPath.split(sep).join("/")}`;
          if (isInstalledExcludedPackagePath(normalizedTarget)) {
            throw dependencyContractError(`${treeLabel} executable link targets an excluded package: ${path}`);
          }
          const targetInfo = await lstat(canonicalTarget);
          if (!targetInfo.isFile()) {
            throw dependencyContractError(`${treeLabel} executable link target must be a file: ${path}`);
          }
          continue;
        }
        throw dependencyContractError(`${treeLabel} contains an unexpected dependency link: ${path}`);
      }
      if (metadata.isDirectory()) await visit(absolute);
      else if (metadata.isFile()) {
        fileCount += 1;
        bytes += metadata.size;
      } else throw dependencyContractError(`${treeLabel} contains a non-regular dependency entry: ${path}`);
    }
  }

  await visit(nodeModules);
  if (!sawKordocLink) {
    throw dependencyContractError(`${treeLabel} node_modules/kordoc must link to the vendored compact core`);
  }
  return Object.freeze({ label: treeLabel, fileCount, linkCount, bytes });
}

export async function verifyInstalledDependencies({ root, sourceOnly = false }) {
  const projectRoot = resolveRequiredPath(root, "root");
  if (typeof sourceOnly !== "boolean") {
    throw dependencyContractError("sourceOnly must be a boolean");
  }
  const source = await assertInstalledDependencyTree({
    packageRoot: join(projectRoot, "packages", "gpt-codex-hwp"),
    label: "source",
  });
  if (sourceOnly) return Object.freeze({ source });
  const runtime = await assertInstalledDependencyTree({
    packageRoot: join(projectRoot, "plugins", "gpt-codex-hwp"),
    label: "runtime",
  });
  return Object.freeze({ source, runtime });
}

async function requiredEntry(path, label) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw dependencyContractError(`${label} is missing`);
    throw error;
  }
}

function resolveRequiredPath(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw dependencyContractError(`${field} must be a non-empty path`);
  }
  return resolve(value);
}

function requiredLabel(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw dependencyContractError("label must be a non-empty string");
  }
  return value.trim();
}

function samePath(left, right) {
  if (process.platform !== "win32") return left === right;
  return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
}

function dependencyContractError(detail) {
  const error = new Error(`INSTALLED_DEPENDENCY_CONTRACT_FAILED: ${detail}`);
  error.code = "INSTALLED_DEPENDENCY_CONTRACT_FAILED";
  return error;
}

function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || ![undefined, "--source-only"].includes(mode)) {
    throw dependencyContractError("Usage: node scripts/verify-installed-dependencies.mjs [--source-only]");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.stdout.write(`${JSON.stringify(await verifyInstalledDependencies({
    root,
    sourceOnly: mode === "--source-only",
  }), null, 2)}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
