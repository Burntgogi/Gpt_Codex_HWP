import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename as nativeRename,
  rm as nativeRm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadProjectMetadata, pluginVersion } from "./project-metadata.mjs";
import { verifyKordocCoreRuntime } from "./kordoc-core-runtime.mjs";
import { assertCompactBudgets, assertCompactLockfile } from "../packages/gpt-codex-hwp/release-scripts/compact-policy.mjs";
import { assertPublicRuntimePrivacy } from "../packages/gpt-codex-hwp/release-scripts/public-runtime-privacy.mjs";

const PRODUCT_DESCRIPTION =
  "Read and preview Korean HWP files, and create, edit, validate, and preview HWPX documents in Codex.";
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
const ROOT_DOCUMENTS = Object.freeze([
  "README.md",
  "README.en.md",
  "RELEASE_NOTES.md",
  "RELEASE_NOTES.en.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
]);
const PYTHON_RUNTIME_FILES = Object.freeze(["hwpxlib.py", "insert_image.py", "verify.py"]);
const SKILL_ICONS = Object.freeze(["gpt-codex-hwp-icon-64.png", "gpt-codex-hwp-icon.png"]);
const FORBIDDEN_SEGMENTS = new Set([
  ".superpowers",
  "__pycache__",
  "artifacts",
  "fixtures",
  "node_modules",
  "release-scripts",
  "src",
  "tests",
  "tmp",
]);
const FORBIDDEN_EXTENSIONS = new Set([
  ".docx", ".hml", ".hwp", ".hwpx", ".map", ".pdf", ".pyc",
  ".p12", ".pem", ".pfx",
]);
const SWAP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export async function buildRuntime({ root, outputRoot, swapId = randomUUID(), fileSystem = {} }) {
  const projectRoot = resolveRequiredPath(root, "root");
  const output = resolveRequiredPath(outputRoot, "outputRoot");
  const rename = fileSystem.rename ?? nativeRename;
  const removeOwnedPath = fileSystem.rm ?? nativeRm;
  if (typeof rename !== "function") throw runtimeBuildError("fileSystem.rename must be a function");
  if (typeof removeOwnedPath !== "function") throw runtimeBuildError("fileSystem.rm must be a function");
  if (!SWAP_ID_PATTERN.test(swapId)) throw runtimeBuildError("swapId is invalid");

  const outputParent = dirname(output);
  const outputName = basename(output);
  if (output === outputParent || outputName === "." || outputName === "..") {
    throw runtimeBuildError("outputRoot must name a child directory");
  }
  await mkdir(outputParent, { recursive: true });

  const stage = join(outputParent, `.${outputName}.stage-${swapId}`);
  const backup = join(outputParent, `.${outputName}.backup-${swapId}`);
  await assertPathAbsent(stage, "Runtime staging path already exists");
  await assertPathAbsent(backup, "Runtime backup path already exists");
  const outputState = await directoryState(output, "Runtime output");

  let ownsStage = false;
  let ownsBackup = false;
  let preserveStageEvidence = false;
  try {
    await mkdir(stage, { recursive: false });
    ownsStage = true;
    const files = await stageRuntime({ projectRoot, stage });

    if (outputState === "directory") {
      await rename(output, backup);
      ownsBackup = true;
    }
    try {
      await rename(stage, output);
      ownsStage = false;
    } catch (promotionError) {
      if (ownsBackup) {
        try {
          await rename(backup, output);
          ownsBackup = false;
        } catch (rollbackError) {
          preserveStageEvidence = true;
          throw runtimeRollbackError("promotion failed and the prior runtime could not be restored", [
            promotionError,
            rollbackError,
          ]);
        }
      }
      throw promotionError;
    }

    if (ownsBackup) {
      try {
        await removeOwnedPath(backup, { recursive: true, force: false });
        ownsBackup = false;
      } catch (backupCleanupError) {
        throw runtimeBackupCleanupError(backupCleanupError);
      }
    }
    return Object.freeze({ root: projectRoot, outputRoot: output, files: Object.freeze(files) });
  } finally {
    if (ownsStage && !preserveStageEvidence) {
      await removeOwnedPath(stage, { recursive: true, force: true });
    }
  }
}

export async function compareRuntime({ expectedRoot, actualRoot }) {
  const expected = await fileRecords(resolveRequiredPath(expectedRoot, "expectedRoot"));
  const actual = await fileRecords(resolveRequiredPath(actualRoot, "actualRoot"), {
    ignoredTopLevel: new Set(["node_modules"]),
  });
  const expectedByPath = new Map(expected.map((record) => [record.path, record.sha256]));
  const actualByPath = new Map(actual.map((record) => [record.path, record.sha256]));
  const paths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort(comparePaths);
  for (const path of paths) {
    const expectedHash = expectedByPath.get(path) ?? "<missing>";
    const actualHash = actualByPath.get(path) ?? "<missing>";
    if (expectedHash !== actualHash) throw runtimeDrift(path, expectedHash, actualHash);
  }
  return Object.freeze({ files: expected.length });
}

async function stageRuntime({ projectRoot, stage }) {
  const sourceRoot = join(projectRoot, "packages", "gpt-codex-hwp");
  const metadata = await loadProjectMetadata(projectRoot);
  const rootPackage = await readJson(join(projectRoot, "package.json"), "package.json");
  const sourcePackage = await readJson(
    join(sourceRoot, "package.json"),
    "packages/gpt-codex-hwp/package.json",
  );
  const sourceLock = await readJson(
    join(sourceRoot, "package-lock.json"),
    "packages/gpt-codex-hwp/package-lock.json",
  );

  await compileFreshTypeScript(sourceRoot, join(stage, "dist"));
  await copyTree(join(sourceRoot, "assets"), join(stage, "assets"), "assets");
  for (const name of PYTHON_RUNTIME_FILES) {
    const relativePath = `scripts/hwpx-safe-edit/${name}`;
    await copyRegularFile(join(sourceRoot, ...relativePath.split("/")), join(stage, ...relativePath.split("/")), relativePath);
  }
  await copyTree(
    join(sourceRoot, "skills", metadata.productId),
    join(stage, "skills", metadata.productId),
    `skills/${metadata.productId}`,
  );
  for (const name of SKILL_ICONS) {
    const relativePath = `skills/${metadata.productId}/assets/${name}`;
    await copyRegularFile(
      join(sourceRoot, "assets", name),
      join(stage, ...relativePath.split("/")),
      relativePath,
    );
  }
  await copyTree(
    join(sourceRoot, "vendor", "kordoc-core"),
    join(stage, "vendor", "kordoc-core"),
    "vendor/kordoc-core",
  );
  for (const name of ROOT_DOCUMENTS) {
    await copyRegularFile(join(projectRoot, name), join(stage, name), name);
  }

  await writeJsonExclusive(join(stage, ".codex-plugin", "plugin.json"), renderPluginManifest(metadata, rootPackage.license));
  await writeJsonExclusive(join(stage, ".mcp.json"), renderMcpConfiguration(metadata));
  const runtimePackage = renderRuntimePackage(metadata, rootPackage.license, sourcePackage);
  await writeJsonExclusive(join(stage, "package.json"), runtimePackage);
  await writeJsonExclusive(join(stage, "package-lock.json"), renderRuntimeLock(metadata, rootPackage.license, sourceLock));

  const files = await assertRuntimeContract(stage, metadata, runtimePackage);
  await verifyKordocCoreRuntime(join(stage, "vendor", "kordoc-core"));
  await assertPublicRuntimePrivacy(stage);
  return files;
}

async function compileFreshTypeScript(sourceRoot, outputRoot) {
  await assertPathAbsent(outputRoot, "Fresh TypeScript output path already exists");
  const compiler = join(sourceRoot, "node_modules", "typescript", "bin", "tsc");
  const compilerInfo = await lstat(compiler);
  if (compilerInfo.isSymbolicLink() || !compilerInfo.isFile()) {
    throw runtimeBuildError("TypeScript compiler must be a regular file");
  }
  await runCommand(process.execPath, [
    compiler,
    "-p",
    join(sourceRoot, "tsconfig.json"),
    "--outDir",
    outputRoot,
    "--declaration",
    "false",
    "--sourceMap",
    "false",
    "--inlineSourceMap",
    "false",
  ], sourceRoot);
  const records = await fileRecords(outputRoot);
  if (records.length === 0 || records.some(({ path }) => extname(path).toLowerCase() !== ".js")) {
    throw runtimeBuildError("Fresh TypeScript output must contain only JavaScript files");
  }
}

function renderPluginManifest(metadata, license) {
  return {
    name: metadata.productId,
    version: pluginVersion(metadata),
    description: PRODUCT_DESCRIPTION,
    author: { name: metadata.developerName },
    license,
    keywords: ["hwp", "hwpx", "hancom", "hangul", "korean-documents"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: metadata.displayName,
      shortDescription: "Read HWP and safely create or edit HWPX.",
      longDescription:
        "Provides Codex tools for read-only HWP detection, reading, and preview, plus HWPX generation, preserve-format edits, form filling, visual assets, preview rendering, and structural validation.",
      developerName: metadata.developerName,
      category: "Productivity",
      capabilities: ["Write", "Interactive"],
      defaultPrompt: [
        "이 HWP 파일을 읽고 요약해줘.",
        "이 마크다운을 HWPX 문서로 만들어줘.",
        "이 HWPX 양식의 빈칸을 채워줘.",
      ],
      brandColor: "#2563EB",
      composerIcon: "./assets/gpt-codex-hwp-icon-64.png",
      logo: "./assets/gpt-codex-hwp-icon.png",
    },
  };
}

function renderMcpConfiguration(metadata) {
  return {
    mcpServers: {
      [metadata.productId]: {
        command: "node",
        args: ["./dist/mcp.js"],
        cwd: ".",
      },
    },
  };
}

function renderRuntimePackage(metadata, license, sourcePackage) {
  return {
    name: metadata.productId,
    version: metadata.version,
    type: "module",
    private: true,
    scripts: { start: "node dist/mcp.js" },
    dependencies: sourcePackage.dependencies,
    engines: sourcePackage.engines,
    optionalDependencies: sourcePackage.optionalDependencies,
    license,
  };
}

function renderRuntimeLock(metadata, license, sourceLock) {
  const lock = structuredClone(sourceLock);
  if (!lock.packages || typeof lock.packages[""] !== "object" || lock.packages[""] === null) {
    throw runtimeBuildError("Source package-lock.json has no root package record");
  }
  lock.name = metadata.productId;
  lock.version = metadata.version;
  lock.packages[""].name = metadata.productId;
  lock.packages[""].version = metadata.version;
  lock.packages[""].license = license;
  delete lock.packages[""].devDependencies;
  return lock;
}

async function assertRuntimeContract(runtimeRoot, metadata, runtimePackage) {
  const records = await fileRecords(runtimeRoot);
  let publicRuntimeBytes = 0;
  for (const record of records) {
    publicRuntimeBytes += record.size;
    const segments = record.path.split("/");
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
      throw runtimeBuildError(`Forbidden runtime path was staged: ${record.path}`);
    }
    if (segments.some((segment) => /^\.env(?:\.|$)/iu.test(segment))) {
      throw runtimeBuildError(`Environment file was staged: ${record.path}`);
    }
    if (FORBIDDEN_EXTENSIONS.has(extname(record.path).toLowerCase())) {
      throw runtimeBuildError(`Forbidden runtime extension was staged: ${record.path}`);
    }
  }
  assertCompactBudgets({ publicRuntimeBytes, nodeModulesBytes: 0, installedBytes: publicRuntimeBytes });

  if (runtimePackage.name !== metadata.productId || runtimePackage.version !== metadata.version) {
    throw runtimeBuildError("Runtime package identity does not match project metadata");
  }
  if (JSON.stringify(runtimePackage.scripts) !== JSON.stringify({ start: "node dist/mcp.js" })) {
    throw runtimeBuildError("Runtime package exposes an unexpected script");
  }
  if (Object.hasOwn(runtimePackage, "devDependencies")) {
    throw runtimeBuildError("Runtime package must not expose development dependencies");
  }

  const lock = await readJson(join(runtimeRoot, "package-lock.json"), "package-lock.json");
  assertCompactLockfile(lock);
  const skillRoot = join(runtimeRoot, "skills", metadata.productId);
  const skillAssets = await readdir(join(skillRoot, "assets"));
  skillAssets.sort(comparePaths);
  if (JSON.stringify(skillAssets) !== JSON.stringify([...SKILL_ICONS].sort(comparePaths))) {
    throw runtimeBuildError("Runtime skill must contain exactly two generated icon copies");
  }
  const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const tools = [...new Set([...skill.matchAll(/`(hwp_[a-z_]+)`/gu)].map((match) => match[1]))]
    .sort(comparePaths);
  if (JSON.stringify(tools) !== JSON.stringify(TOOL_NAMES)) {
    throw runtimeBuildError("Runtime skill does not document exactly the nine supported MCP tools");
  }
  return records;
}

async function copyTree(source, destination, relativePath) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw runtimeBuildError(`Runtime entries must be regular files or directories: ${relativePath}`);
  }
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const childRelative = `${relativePath}/${entry.name}`;
    const childSource = join(source, entry.name);
    const childDestination = join(destination, entry.name);
    const childMetadata = await lstat(childSource);
    if (childMetadata.isSymbolicLink()) {
      throw runtimeBuildError(`Runtime entries must be regular files: ${childRelative}`);
    }
    if (childMetadata.isDirectory()) await copyTree(childSource, childDestination, childRelative);
    else if (childMetadata.isFile()) await copyRegularFile(childSource, childDestination, childRelative);
    else throw runtimeBuildError(`Runtime entries must be regular files: ${childRelative}`);
  }
}

async function copyRegularFile(source, destination, relativePath) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw runtimeBuildError(`Runtime entries must be regular files: ${relativePath}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
}

async function fileRecords(root, options = {}) {
  const ignoredTopLevel = options.ignoredTopLevel ?? new Set();
  const records = [];
  async function visit(directory, depth) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      const path = relative(root, absolute).split(sep).join("/");
      if (depth === 0 && ignoredTopLevel.has(entry.name)) {
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw runtimeBuildError("Actual runtime node_modules must be a non-symbolic-link directory");
        }
        continue;
      }
      if (metadata.isSymbolicLink()) throw runtimeBuildError(`Runtime entries must not be links: ${path}`);
      if (metadata.isDirectory()) await visit(absolute, depth + 1);
      else if (metadata.isFile()) {
        const bytes = await readFile(absolute);
        records.push({ path, size: bytes.length, sha256: sha256(bytes) });
      } else throw runtimeBuildError(`Runtime entries must be regular files: ${path}`);
    }
  }
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw runtimeBuildError("Runtime root must be a regular directory");
  }
  await visit(root, 0);
  return records.sort((left, right) => comparePaths(left.path, right.path));
}

async function writeJsonExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw runtimeBuildError(`${label} is not valid readable JSON`, { cause: error });
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(runtimeBuildError(`TypeScript build failed (${code ?? signal ?? "unknown"}): ${stderr || stdout}`));
    });
  });
}

async function directoryState(path, label) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw runtimeBuildError(`${label} must be a regular directory`);
    }
    return "directory";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function assertPathAbsent(path, message) {
  if (await pathExists(path)) throw runtimeBuildError(message);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveRequiredPath(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw runtimeBuildError(`${name} must be a non-empty path`);
  }
  return resolve(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeDrift(path, expectedHash, actualHash) {
  const error = new Error(`RUNTIME_DRIFT: ${path} expected=${expectedHash} actual=${actualHash}`);
  error.code = "RUNTIME_DRIFT";
  return error;
}

function runtimeBackupCleanupError(cause) {
  const error = new Error(
    "RUNTIME_BACKUP_CLEANUP_FAILED: new runtime remains live; remaining backup evidence left untouched",
    { cause },
  );
  error.code = "RUNTIME_BACKUP_CLEANUP_FAILED";
  return error;
}

function runtimeRollbackError(detail, causes) {
  const error = new Error(`RUNTIME_ROLLBACK_FAILED: ${detail}; staged runtime and backup evidence preserved`, {
    cause: new AggregateError(causes),
  });
  error.code = "RUNTIME_ROLLBACK_FAILED";
  return error;
}

function runtimeBuildError(message, options = undefined) {
  const error = new Error(`RUNTIME_BUILD_FAILED: ${message}`, options);
  error.code = "RUNTIME_BUILD_FAILED";
  return error;
}

function comparePaths(left, right) {
  return left.localeCompare(right, "en");
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !["--check", "--write"].includes(mode)) {
    throw new Error("Usage: node scripts/project-runtime.mjs --check|--write");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputRoot = join(root, "plugins", "gpt-codex-hwp");
  if (mode === "--write") {
    const result = await buildRuntime({ root, outputRoot });
    process.stdout.write(`Runtime projection generated (${result.files.length} files).\n`);
    return;
  }

  const expectedRoot = join(dirname(outputRoot), `.gpt-codex-hwp.expected-${randomUUID()}`);
  let ownsExpectedRoot = false;
  try {
    await buildRuntime({ root, outputRoot: expectedRoot });
    ownsExpectedRoot = true;
    const result = await compareRuntime({ expectedRoot, actualRoot: outputRoot });
    process.stdout.write(`Runtime projection matches (${result.files} files).\n`);
  } finally {
    if (ownsExpectedRoot) await nativeRm(expectedRoot, { recursive: true, force: true });
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
