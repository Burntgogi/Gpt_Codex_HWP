import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildRuntime } from "../../../scripts/project-runtime.mjs";
import { createCanonicalTemporaryDirectory } from "../../../scripts/canonical-temp.mjs";
import { verifyKordocCoreRuntime } from "../../../scripts/kordoc-core-runtime.mjs";
import { releaseSubprocessEnvironment } from "../../../scripts/release-subprocess-environment.mjs";
import {
  assertCompactBudgets,
  assertCompactLockfile,
  isExcludedPackagePath,
  summarizeInstalledEntries,
} from "./compact-policy.mjs";
import { assertHwpFixtureByteLimit, resolveHwpFixture } from "./hwp-fixture.mjs";

const TOOL_NAMES = [
  "hwp_detect_format",
  "hwp_read",
  "hwp_generate_hwpx",
  "hwp_validate",
  "hwp_render_preview",
  "hwp_patch_document",
  "hwp_fill_form",
  "hwp_create_svg_asset",
  "hwp_insert_image",
];
const COMMAND_TIMEOUT_MS = 180_000;
const TOOL_SMOKE_TIMEOUT_MS = 120_000;
const HWP_COPY_CHUNK_BYTES = 1024 * 1024;
const PINNED_MARKDOWN_EVIDENCE = Object.freeze({
  characters: 100,
  bytes: 300,
  sha256: "34ba9b31ab7f208d922763be29c72ee7f68c0e3300285ff83eba3eb73dfe7a34",
  version: "5.x",
  pageCount: 1,
});
export { assertCompactBudgets, assertCompactLockfile, isExcludedPackagePath };

export function isAllowedKordocLink({
  linkPath,
  canonicalTarget,
  canonicalExpectedTarget,
  platform = process.platform,
}) {
  if (typeof linkPath !== "string"
    || typeof canonicalTarget !== "string"
    || typeof canonicalExpectedTarget !== "string") return false;
  return comparablePath(linkPath, platform) === comparablePath("node_modules/kordoc", platform)
    && comparablePath(canonicalTarget, platform) === comparablePath(canonicalExpectedTarget, platform);
}

function comparablePath(input, platform) {
  if (platform !== "win32") return input;
  return input.replaceAll("\\", "/").toLowerCase();
}

export function resolveNpmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  const npmExecPath = Object.hasOwn(options, "npmExecPath")
    ? options.npmExecPath
    : process.env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.length > 0) {
    return { command: nodeExecPath, args: [npmExecPath, ...args] };
  }
  const npmCliPath = platform === "win32"
    ? win32.join(win32.dirname(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js")
    : posix.resolve(posix.dirname(nodeExecPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return { command: nodeExecPath, args: [npmCliPath, ...args] };
}

export function expectedCompactBinLinks(lock, runtimeRoot) {
  const links = new Map();
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)
    || lock.packages === null || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    return links;
  }
  for (const [packagePath, record] of Object.entries(lock.packages)) {
    if (!safeLockPackagePath(packagePath)
      || record === null || typeof record !== "object" || Array.isArray(record)
      || record.bin === null || typeof record.bin !== "object" || Array.isArray(record.bin)) continue;
    const marker = packagePath.lastIndexOf("node_modules/");
    const nodeModulesPath = packagePath.slice(0, marker + "node_modules".length);
    const packageRoot = resolve(runtimeRoot, ...packagePath.split("/"));
    for (const [name, targetPath] of Object.entries(record.bin)) {
      if (!safeBinName(name) || !safeBinTarget(targetPath)) continue;
      const target = resolve(packageRoot, ...targetPath.split("/"));
      const suffix = relative(packageRoot, target);
      if (suffix === "" || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) continue;
      const linkPath = `${nodeModulesPath}/.bin/${name}`;
      const targets = links.get(linkPath) ?? [];
      targets.push(target);
      links.set(linkPath, targets);
    }
  }
  return links;
}

function safeLockPackagePath(value) {
  return typeof value === "string" && value.startsWith("node_modules/")
    && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function safeBinName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function safeBinTarget(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !value.includes("\\") && !value.startsWith("/")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export async function runCommand(command, args, cwd, options = {}) {
  const {
    allowFailure = false,
    timeoutMs = COMMAND_TIMEOUT_MS,
    environmentOverrides = {},
  } = options;
  let environment;
  try {
    environment = releaseSubprocessEnvironment(process.env, environmentOverrides);
  } catch {
    throw commandError(
      "COMMAND_ENVIRONMENT_INVALID",
      "subprocess environment overrides are invalid",
    );
  }
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateProcessTree(child).then(
        () => reject(commandError("COMMAND_TIMEOUT", "subprocess timed out")),
        () => reject(commandError(
          "COMMAND_TERMINATION_FAILED",
          "subprocess termination failed after timeout",
        )),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(commandError("COMMAND_START_FAILED", "subprocess could not start"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !allowFailure) {
        reject(commandError("COMMAND_FAILED", "subprocess exited unsuccessfully", {
          exitCode: code,
        }));
      } else {
        resolvePromise({ code, stdout, stderr });
      }
    });
  });
}

function commandError(code, summary, properties = {}) {
  const error = new Error(`${code}: ${summary}.`);
  error.code = code;
  Object.assign(error, properties);
  return error;
}

async function terminateProcessTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise((resolvePromise) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        env: releaseSubprocessEnvironment(),
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.once("error", resolvePromise);
      killer.once("close", resolvePromise);
    });
    return;
  }
  signalPosixProcessGroup(child, "SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  signalPosixProcessGroup(child, "SIGKILL");
}

function signalPosixProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    if (child.exitCode === null) {
      try {
        child.kill(signal);
      } catch {
        // The group-signaling error below remains the authoritative failure.
      }
    }
    throw error;
  }
}

function runNpm(args, cwd, options = {}) {
  const invocation = resolveNpmInvocation(args);
  return runCommand(invocation.command, invocation.args, cwd, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    ...options,
  });
}

export function parseNpmLsResult(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  if (stdout.trim().length === 0) {
    throw npmLsError("NPM_LS_INVALID", "npm ls returned empty JSON output");
  }
  let tree;
  try {
    tree = JSON.parse(stdout);
  } catch {
    throw npmLsError("NPM_LS_INVALID", "npm ls returned invalid JSON");
  }
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    throw npmLsError("NPM_LS_INVALID", "npm ls returned invalid JSON data");
  }
  if (Object.keys(tree).length === 0) {
    throw npmLsError("NPM_LS_INVALID", "npm ls returned an empty JSON object");
  }
  if (tree.problems !== undefined && !Array.isArray(tree.problems)) {
    throw npmLsError("NPM_LS_INVALID", "npm ls returned malformed dependency problems");
  }
  const problems = tree.problems ?? [];
  if (result.code !== 0) {
    throw npmLsError("NPM_LS_FAILED", "npm ls exited with nonzero status", {
      exitCode: Number.isSafeInteger(result.code) ? result.code : null,
    });
  }
  if (problems.length > 0) {
    throw npmLsError("NPM_LS_PROBLEMS", "npm ls reported dependency problems", {
      problemCount: problems.length,
    });
  }
  return { status: "passed", problems };
}

function npmLsError(code, summary, properties = {}) {
  const error = new Error(`${code}: ${summary}.`);
  error.code = code;
  Object.assign(error, properties);
  return error;
}

export function parseNpmAuditResult(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  let audit;
  try {
    audit = JSON.parse(stdout);
  } catch {
    throw npmAuditError("NPM_AUDIT_INVALID", "npm audit returned invalid JSON");
  }
  const vulnerabilities = audit?.metadata?.vulnerabilities;
  const total = vulnerabilities?.total;
  if (vulnerabilities === null
    || typeof vulnerabilities !== "object"
    || Array.isArray(vulnerabilities)
    || !Number.isSafeInteger(total)
    || total < 0) {
    throw npmAuditError("NPM_AUDIT_INVALID", "npm audit returned invalid vulnerability metadata");
  }
  if (result?.code !== 0 || total !== 0) {
    throw npmAuditError("NPM_AUDIT_FAILED", "npm audit reported a failed security gate", {
      exitCode: Number.isSafeInteger(result?.code) ? result.code : null,
      vulnerabilityTotal: total,
    });
  }
  return { ...vulnerabilities };
}

function npmAuditError(code, summary, properties = {}) {
  const error = new Error(`${code}: ${summary}.`);
  error.code = code;
  Object.assign(error, properties);
  return error;
}

export function assertMcpStderr(stderr) {
  if (typeof stderr === "string" && stderr.length === 0) return;
  const error = new Error("MCP_STDERR_NOT_EMPTY: MCP wrote diagnostic output to stderr.");
  error.code = "MCP_STDERR_NOT_EMPTY";
  error.stderrBytes = typeof stderr === "string"
    ? Buffer.byteLength(stderr)
    : null;
  throw error;
}

async function measureTree(root, collectedEntries = undefined, pathRoot = root, options = {}) {
  let bytes = 0;
  let canonicalExpectedKordocTarget;
  const stagePrefix = typeof options.stagePrefix === "string" ? options.stagePrefix : "";
  const reportStage = (stage) => {
    if (stagePrefix.length === 0 || typeof options.onDiagnosticStage !== "function") return;
    try { options.onDiagnosticStage(`${stagePrefix}-${stage}`); } catch {}
  };
  async function expectedKordocTarget() {
    reportStage("link-expected");
    canonicalExpectedKordocTarget ??= await realpath(join(pathRoot, "vendor", "kordoc-core"));
    return canonicalExpectedKordocTarget;
  }
  async function visit(directory) {
    reportStage("read");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      reportStage("lstat");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const path = relative(pathRoot, absolute).split(sep).join("/");
        reportStage("link-target");
        const target = await realpath(absolute);
        const isKordocPath = comparablePath(path, process.platform)
          === comparablePath("node_modules/kordoc", process.platform);
        const expectedBinTargets = options.allowedBinLinks?.get(path) ?? [];
        if (!isKordocPath && expectedBinTargets.length === 0) {
          reportStage("link-path-rejected");
          throw new Error(`Installed runtime contains an unexpected symbolic link: ${absolute}`);
        }
        reportStage("link-expected");
        const expectedTargets = isKordocPath
          ? [await expectedKordocTarget()]
          : await canonicalExistingTargets(expectedBinTargets);
        if (!expectedTargets.some((expectedTarget) =>
          comparablePath(target, process.platform) === comparablePath(expectedTarget, process.platform))) {
          reportStage("link-target-rejected");
          throw new Error(`Installed runtime contains an unexpected symbolic link: ${absolute}`);
        }
        reportStage("link-allowed");
        collectedEntries?.linkPaths.push(path);
        continue;
      }
      if (info.isDirectory()) {
        reportStage("directory");
        await visit(absolute);
      }
      else if (info.isFile()) {
        reportStage("file");
        bytes += info.size;
        collectedEntries?.filePaths.push(relative(pathRoot, absolute).split(sep).join("/"));
      } else {
        reportStage("entry-rejected");
        throw new Error(`Unsupported installed entry: ${absolute}`);
      }
    }
  }
  await visit(root);
  return bytes;
}

function requireSuccess(name, result) {
  if (result === null
    || typeof result !== "object"
    || Array.isArray(result)
    || result.isError) {
    const error = new Error("TOOL_SMOKE_FAILED: tool smoke returned an error.");
    error.code = "TOOL_SMOKE_FAILED";
    throw error;
  }
  return result.structuredContent ?? {};
}

async function canonicalExistingTargets(targets) {
  const canonical = [];
  for (const target of targets) {
    try { canonical.push(await realpath(target)); } catch {}
  }
  return canonical;
}

export async function measureTreeForTest(root, options = {}) {
  return measureTree(root, options.collectedEntries, options.pathRoot ?? root, options);
}

export async function verifyReadOnlyHwpTools({
  sampleHwpPath,
  expectedSha256,
  detectFormat,
  readDocument,
  readSha256 = sha256File,
  expectedBytes = 8_704,
  expectedMarkdownEvidence = PINNED_MARKDOWN_EVIDENCE,
}) {
  const statuses = {};
  const detectEvidence = await invokeReadOnlyHwpTool({
    toolName: "hwp_detect_format",
    operation: detectFormat,
    sampleHwpPath,
    expectedSha256,
    readSha256,
  });
  assertDetectEvidence(detectEvidence, expectedBytes);
  statuses.hwp_detect_format = "passed";

  const readEvidence = await invokeReadOnlyHwpTool({
    toolName: "hwp_read",
    operation: readDocument,
    sampleHwpPath,
    expectedSha256,
    readSha256,
  });
  assertReadEvidence(readEvidence, expectedMarkdownEvidence);
  statuses.hwp_read = "passed";
  return statuses;
}

export async function verifyMcpReadOnlyHwpTools({
  client,
  sampleHwpPath,
  expectedSha256,
  expectedBytes,
  semanticMode,
  readSha256 = sha256File,
}) {
  if (semanticMode !== "tracked" && semanticMode !== "diagnostic") {
    throw semanticEvidenceError();
  }
  return await verifyReadOnlyHwpTools({
    sampleHwpPath,
    expectedSha256,
    expectedBytes,
    expectedMarkdownEvidence: semanticMode === "tracked"
      ? PINNED_MARKDOWN_EVIDENCE
      : null,
    detectFormat: (input) => callMcpTool(client, "hwp_detect_format", input),
    readDocument: (input) => callMcpTool(client, "hwp_read", input),
    readSha256,
  });
}

async function callMcpTool(client, name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch {
    const error = new Error("MCP_TOOL_CALL_FAILED: MCP tool call failed.");
    error.code = "MCP_TOOL_CALL_FAILED";
    throw error;
  }
}

export async function copyVerifiedHwpFixture({
  sourcePath,
  targetRoot,
  expectedSha256,
  openFile = open,
  readSha256 = sha256File,
}) {
  const ownedPath = join(targetRoot, "verified-source-copy.hwp");
  let sourceHandle;
  let destinationHandle;
  let failure;
  try {
    sourceHandle = await openFile(sourcePath, "r");
    const before = await sourceHandle.stat();
    assertCopySourceStatus(before);
    destinationHandle = await openFile(ownedPath, "wx");

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(
      HWP_COPY_CHUNK_BYTES,
      Math.max(1, before.size),
    ));
    let position = 0;
    while (position < before.size) {
      assertHwpFixtureByteLimit(position);
      const requested = Math.min(buffer.byteLength, before.size - position);
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        requested,
        position,
      );
      if (!Number.isSafeInteger(bytesRead)
        || bytesRead <= 0
        || bytesRead > requested) {
        throw new Error("invalid source read");
      }
      hash.update(buffer.subarray(0, bytesRead));

      let written = 0;
      while (written < bytesRead) {
        const remaining = bytesRead - written;
        const { bytesWritten } = await destinationHandle.write(
          buffer,
          written,
          remaining,
          position + written,
        );
        if (!Number.isSafeInteger(bytesWritten)
          || bytesWritten <= 0
          || bytesWritten > remaining) {
          throw new Error("invalid destination write");
        }
        written += bytesWritten;
      }
      position += bytesRead;
      assertHwpFixtureByteLimit(position);
    }

    const after = await sourceHandle.stat();
    assertCopySourceStatus(after);
    if (!sameFileSnapshot(before, after) || position !== before.size) {
      throw new Error("source changed during copy");
    }
    if (hash.digest("hex") !== expectedSha256) {
      throw new Error("source digest mismatch");
    }
    await destinationHandle.sync();
  } catch {
    failure = hwpFixtureCopyError();
  }

  for (const handle of [destinationHandle, sourceHandle]) {
    if (handle === undefined) continue;
    try {
      await handle.close();
    } catch {
      failure ??= hwpFixtureCopyError();
    }
  }

  if (failure === undefined) {
    let ownedMatches = false;
    let sourceMatches = false;
    try {
      ownedMatches = await readSha256(ownedPath) === expectedSha256;
    } catch {
      // The generic copy error below is the public diagnostic.
    }
    try {
      sourceMatches = await readSha256(sourcePath) === expectedSha256;
    } catch {
      // The generic copy error below is the public diagnostic.
    }
    if (!ownedMatches || !sourceMatches) {
      failure = hwpFixtureCopyError();
    }
  }
  if (failure !== undefined) throw failure;
  return ownedPath;
}

function assertCopySourceStatus(status) {
  if (status === null
    || typeof status !== "object"
    || typeof status.isFile !== "function"
    || !status.isFile()) {
    throw new Error("copy source is not a regular file");
  }
  assertHwpFixtureByteLimit(status.size);
}

function sameFileSnapshot(before, after) {
  return after.dev === before.dev
    && after.ino === before.ino
    && after.size === before.size
    && after.mtimeMs === before.mtimeMs
    && after.ctimeMs === before.ctimeMs;
}

function hwpFixtureCopyError() {
  const error = new Error(
    "HWP_FIXTURE_COPY_FAILED: the verified HWP fixture could not be copied safely.",
  );
  error.code = "HWP_FIXTURE_COPY_FAILED";
  return error;
}

export async function finalizeFixtureWorkspace({
  ownedSample,
  sourcePath,
  expectedSha256,
  temporaryRoot,
  readSha256 = sha256File,
  removeTree = rm,
}) {
  try {
    if (ownedSample !== undefined) {
      await assertSampleHash(
        ownedSample,
        expectedSha256,
        "compact-runtime verification",
        readSha256,
      );
    }
  } finally {
    try {
      await assertSampleHash(
        sourcePath,
        expectedSha256,
        "compact-runtime verification",
        readSha256,
      );
    } finally {
      await removeTree(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export async function verifyClassicHwpPreview({
  sampleHwpPath,
  expectedSha256,
  outputSvgPath,
  renderPreview,
  readSha256 = sha256File,
}) {
  const evidence = await invokeReadOnlyHwpTool({
    toolName: "classic_hwp_render_preview",
    operation: ({ file_path }) => renderPreview({
      file_path,
      output_svg_path: outputSvgPath,
    }),
    sampleHwpPath,
    expectedSha256,
    readSha256,
  });
  if (evidence?.backend !== "rhwp") throw rhwpPreviewEvidenceError();
  let svg;
  try {
    svg = await readFile(outputSvgPath, "utf8");
  } catch {
    throw rhwpPreviewEvidenceError();
  }
  if (!/^\s*<svg\b/iu.test(svg)) throw rhwpPreviewEvidenceError();
  return evidence;
}

async function invokeReadOnlyHwpTool({
  toolName,
  operation,
  sampleHwpPath,
  expectedSha256,
  readSha256,
}) {
  let result;
  try {
    result = await operation({ file_path: sampleHwpPath });
  } finally {
    await assertSampleHash(
      sampleHwpPath,
      expectedSha256,
      toolName,
      readSha256,
    );
  }
  return requireSuccess(toolName, result);
}

function assertDetectEvidence(evidence, expectedBytes) {
  const details = evidence?.details;
  if (evidence?.format !== "hwp"
    || details === null
    || typeof details !== "object"
    || details.container_format !== "ole2"
    || details.file_size_bytes !== expectedBytes) {
    throw semanticEvidenceError();
  }
}

function assertReadEvidence(evidence, expectedMarkdownEvidence) {
  const markdown = evidence?.markdown;
  const metadata = evidence?.metadata;
  const warnings = evidence?.warnings;
  if (typeof markdown !== "string"
    || markdown.length === 0
    || metadata === null
    || typeof metadata !== "object"
    || metadata.fileType !== "hwp"
    || typeof metadata.version !== "string"
    || metadata.version.length === 0
    || !Number.isSafeInteger(metadata.pageCount)
    || metadata.pageCount <= 0
    || !Array.isArray(warnings)
    || (expectedMarkdownEvidence !== null
      && (markdown.length !== expectedMarkdownEvidence.characters
        || Buffer.byteLength(markdown, "utf8") !== expectedMarkdownEvidence.bytes
        || createHash("sha256").update(markdown, "utf8").digest("hex")
          !== expectedMarkdownEvidence.sha256
        || metadata.version !== expectedMarkdownEvidence.version
        || metadata.pageCount !== expectedMarkdownEvidence.pageCount
        || warnings.length !== 0))) {
    throw semanticEvidenceError();
  }
}

function semanticEvidenceError() {
  const error = new Error(
    "COMPACT_HWP_SEMANTIC_MISMATCH: real-HWP smoke evidence did not match the pinned oracle.",
  );
  error.code = "COMPACT_HWP_SEMANTIC_MISMATCH";
  return error;
}

function rhwpPreviewEvidenceError() {
  const error = new Error(
    "COMPACT_HWP_RHWP_PREVIEW_MISMATCH: classic HWP preview did not use rhwp with SVG evidence.",
  );
  error.code = "COMPACT_HWP_RHWP_PREVIEW_MISMATCH";
  return error;
}

async function verifyMcp(runtimeRoot, {
  sampleHwpPath,
  expectedSha256,
  expectedBytes,
  semanticMode,
}) {
  const serverPath = join(runtimeRoot, "dist", "mcp.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: runtimeRoot,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "compact-runtime-gate", version: "0.1.0" });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport);
    const version = client.getServerVersion()?.version;
    const expectedVersion = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8")).version;
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    if (version !== expectedVersion) throw new Error(`Unexpected MCP version: ${version}`);
    if (JSON.stringify(tools) !== JSON.stringify(TOOL_NAMES)) throw new Error(`Unexpected MCP tools: ${tools.join(", ")}`);
    const readOnlyToolSmokes = await verifyMcpReadOnlyHwpTools({
      client,
      sampleHwpPath,
      expectedSha256,
      expectedBytes,
      semanticMode,
    });
    return {
      version,
      tools,
      readOnlyToolSmokes,
      stderrBytes: Buffer.byteLength(stderr),
    };
  } finally {
    await client.close();
    await transport.close();
    assertMcpStderr(stderr);
  }
}

async function verifyTools(
  runtimeRoot,
  workRoot,
  sampleHwpPath,
  expectedSha256,
  expectedBytes,
  semanticMode,
) {
  const toolRoot = join(runtimeRoot, "dist", "tools");
  const detect = await import(pathToFileURL(join(toolRoot, "detect.js")).href);
  const read = await import(pathToFileURL(join(toolRoot, "read.js")).href);
  const write = await import(pathToFileURL(join(toolRoot, "write.js")).href);
  const preview = await import(pathToFileURL(join(toolRoot, "preview.js")).href);
  const patch = await import(pathToFileURL(join(toolRoot, "patch.js")).href);
  const assets = await import(pathToFileURL(join(toolRoot, "assets.js")).href);
  const statuses = {};

  Object.assign(statuses, await verifyReadOnlyHwpTools({
    sampleHwpPath,
    expectedSha256,
    detectFormat: detect.handleHwpDetectFormat,
    readDocument: read.handleHwpRead,
    expectedBytes,
    expectedMarkdownEvidence: semanticMode === "tracked"
      ? PINNED_MARKDOWN_EVIDENCE
      : null,
  }));

  await verifyClassicHwpPreview({
    sampleHwpPath,
    expectedSha256,
    outputSvgPath: join(workRoot, "classic-hwp-preview.svg"),
    renderPreview: preview.handleHwpRenderPreview,
  });

  const generated = join(workRoot, "generated.hwpx");
  requireSuccess("hwp_generate_hwpx", await write.handleHwpGenerateHwpx({
    markdown: "# Compact Runtime\n\n본문 앵커\n\n| 성명 | ( ) |\n| --- | --- |",
    output_path: generated,
  }));
  statuses.hwp_generate_hwpx = "passed";
  const validation = requireSuccess("hwp_validate", await write.handleHwpValidate({ file_path: generated }));
  if (Array.isArray(validation.issues) && validation.issues.length !== 0) throw new Error("Generated HWPX has validation issues.");
  statuses.hwp_validate = "passed";
  requireSuccess("hwp_render_preview", await preview.handleHwpRenderPreview({
    file_path: generated,
    output_svg_path: join(workRoot, "preview.svg"),
    reflow: true,
  }));
  statuses.hwp_render_preview = "passed";

  const parsed = requireSuccess("generated hwp_read", await read.handleHwpRead({ file_path: generated }));
  requireSuccess("hwp_patch_document", await patch.handleHwpPatchDocument({
    file_path: generated,
    edited_markdown: String(parsed.markdown).replace("본문 앵커", "수정된 본문 앵커"),
    output_path: join(workRoot, "patched.hwpx"),
  }));
  statuses.hwp_patch_document = "passed";
  requireSuccess("hwp_fill_form", await patch.handleHwpFillForm({
    file_path: generated,
    fields: { 성명: "홍길동" },
    output_path: join(workRoot, "filled.hwpx"),
  }));
  statuses.hwp_fill_form = "passed";

  const svgPath = join(workRoot, "asset.svg");
  const pngPath = join(workRoot, "asset.png");
  requireSuccess("hwp_create_svg_asset", await assets.handleHwpCreateSvgAsset({
    prompt_or_spec: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#6574d9"/></svg>',
    output_svg_path: svgPath,
    output_png_path: pngPath,
  }));
  statuses.hwp_create_svg_asset = "passed";
  requireSuccess("hwp_insert_image", await assets.handleHwpInsertImage({
    file_path: generated,
    image_path: pngPath,
    output_path: join(workRoot, "with-image.hwpx"),
    anchor_text: "본문 앵커",
    mode: "after-paragraph",
  }));
  statuses.hwp_insert_image = "passed";
  return statuses;
}

export async function createCompactRuntimeTemp(parent) {
  return createCanonicalTemporaryDirectory({
    parent,
    prefix: "gpt-codex-hwp-compact-",
  });
}

export async function verifyCompactRuntime({
  sourceRoot,
  sampleHwpPath,
  temporaryParent,
  onDiagnosticStage = () => {},
}) {
  const source = resolve(sourceRoot);
  onDiagnosticStage("fixture");
  const fixture = sampleHwpPath === undefined
    ? await resolveHwpFixture({ requireTracked: true })
    : await resolveHwpFixture({ overridePath: sampleHwpPath });
  const sample = fixture.path;
  onDiagnosticStage("source-hash");
  const sampleBefore = await sha256File(sample);
  if (sampleBefore !== fixture.sha256) {
    throw new Error("The HWP sample changed before verification.");
  }
  onDiagnosticStage("temporary-root");
  const temporaryRoot = await createCompactRuntimeTemp(temporaryParent);
  let report;
  let ownedSample;
  try {
    ownedSample = join(temporaryRoot, "verified-source-copy.hwp");
    onDiagnosticStage("fixture-copy");
    await copyVerifiedHwpFixture({
      sourcePath: sample,
      targetRoot: temporaryRoot,
      expectedSha256: fixture.sha256,
    });
    const runtimeRoot = join(temporaryRoot, "runtime");
    onDiagnosticStage("runtime-build");
    await buildRuntime({
      root: source,
      outputRoot: runtimeRoot,
      subprocessEnvironment: releaseSubprocessEnvironment(),
    });
    onDiagnosticStage("provenance");
    const provenanceRecord = await verifyKordocCoreRuntime(join(runtimeRoot, "vendor", "kordoc-core"));
    const provenance = {
      status: "passed",
      archiveSha512: provenanceRecord.archive.sha512,
      fileCount: provenanceRecord.files.length,
    };
    onDiagnosticStage("public-runtime-measure");
    const publicRuntimeBytes = await measureTree(runtimeRoot);
    onDiagnosticStage("lockfile");
    const lock = JSON.parse(await readFile(join(runtimeRoot, "package-lock.json"), "utf8"));
    assertCompactLockfile(lock);
    const allowedBinLinks = expectedCompactBinLinks(lock, runtimeRoot);
    onDiagnosticStage("npm-ci");
    await runNpm(["ci", "--omit=dev", "--ignore-scripts"], runtimeRoot);
    onDiagnosticStage("npm-ls");
    const npmLsRun = await runNpm(
      ["ls", "--omit=dev", "--all", "--json"],
      runtimeRoot,
      { allowFailure: true },
    );
    const npmLs = parseNpmLsResult(npmLsRun);
    onDiagnosticStage("npm-audit");
    const auditRun = await runNpm(
      ["audit", "--omit=dev", "--json"],
      runtimeRoot,
      { allowFailure: true },
    );
    const audit = parseNpmAuditResult(auditRun);
    const installedEntries = { filePaths: [], linkPaths: [] };
    onDiagnosticStage("node-modules-measure");
    const nodeModulesBytes = await measureTree(
      join(runtimeRoot, "node_modules"),
      installedEntries,
      runtimeRoot,
      { allowedBinLinks, onDiagnosticStage, stagePrefix: "node-modules" },
    );
    onDiagnosticStage("installed-tree-measure");
    const installedBytes = await measureTree(
      runtimeRoot,
      undefined,
      runtimeRoot,
      { allowedBinLinks, onDiagnosticStage, stagePrefix: "installed-tree" },
    );
    onDiagnosticStage("installed-summary");
    const installedSummary = summarizeInstalledEntries(installedEntries);
    if (installedSummary.excludedPaths.length > 0) {
      throw new Error(`Excluded dependencies installed: ${installedSummary.excludedPaths.join(", ")}`);
    }
    onDiagnosticStage("budgets");
    assertCompactBudgets({ nodeModulesBytes, installedBytes, publicRuntimeBytes });
    const semanticMode = fixture.provenance?.tracked === false
      ? "diagnostic"
      : "tracked";
    onDiagnosticStage("mcp");
    const mcp = await verifyMcp(runtimeRoot, {
      sampleHwpPath: ownedSample,
      expectedSha256: fixture.sha256,
      expectedBytes: fixture.bytes,
      semanticMode,
    });
    onDiagnosticStage("tool-smoke");
    const smokeRun = await runCommand(process.execPath, [
      fileURLToPath(import.meta.url),
      "--tool-smoke",
      runtimeRoot,
      temporaryRoot,
      ownedSample,
      fixture.sha256,
      String(fixture.bytes),
      semanticMode,
    ], source, { timeoutMs: TOOL_SMOKE_TIMEOUT_MS });
    const tools = JSON.parse(smokeRun.stdout);
    onDiagnosticStage("source-verify");
    await assertSampleHash(
      ownedSample,
      fixture.sha256,
      "tool verification",
      sha256File,
    );
    await assertSampleHash(
      sample,
      fixture.sha256,
      "tool verification",
      sha256File,
    );
    report = {
      publicRuntimeBytes,
      nodeModulesBytes,
      installedBytes,
      installedFileCount: installedSummary.installedFileCount,
      installedLinkCount: installedSummary.installedLinkCount,
      installedEntryCount: installedSummary.installedEntryCount,
      excludedPackages: installedSummary.excludedPackages,
      excludedPackagePaths: installedSummary.excludedPaths,
      provenance,
      npmLs,
      audit,
      serverVersion: mcp.version,
      toolNames: mcp.tools,
      mcpReadOnlySmokes: mcp.readOnlyToolSmokes,
      toolSmokes: tools,
      sourceSha256: sampleBefore,
      stderrBytes: mcp.stderrBytes,
      cleanup: false,
    };
  } finally {
    try {
      await finalizeFixtureWorkspace({
        ownedSample,
        sourcePath: sample,
        expectedSha256: fixture.sha256,
        temporaryRoot,
      });
    } catch (error) {
      onDiagnosticStage("cleanup");
      throw error;
    }
  }
  report.cleanup = true;
  onDiagnosticStage("passed");
  return report;
}

async function main() {
  if (process.argv[2] === "--tool-smoke") {
    const {
      runtimeRoot,
      workRoot,
      sampleHwpPath,
      expectedSha256,
      expectedBytes,
      semanticMode,
    } = parseToolSmokeArguments(process.argv.slice(3));
    process.stdout.write(`${JSON.stringify(await verifyTools(
      runtimeRoot,
      workRoot,
      sampleHwpPath,
      expectedSha256,
      expectedBytes,
      semanticMode,
    ))}\n`);
    return;
  }
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const cli = parseCliArguments(process.argv.slice(2));
  const options = cli.mode === "release"
    ? { sourceRoot }
    : { sourceRoot, sampleHwpPath: cli.sampleHwpPath };
  process.stdout.write(`${JSON.stringify(await verifyCompactRuntime(options), null, 2)}\n`);
}

export function parseToolSmokeArguments(args) {
  const [
    runtimeRoot,
    workRoot,
    sampleHwpPath,
    expectedSha256,
    serializedExpectedBytes,
    semanticMode,
  ] = args;
  const expectedBytes = Number(serializedExpectedBytes);
  if (args.length !== 6
    || typeof runtimeRoot !== "string"
    || runtimeRoot.length === 0
    || typeof workRoot !== "string"
    || workRoot.length === 0
    || typeof sampleHwpPath !== "string"
    || sampleHwpPath.length === 0
    || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")
    || !Number.isSafeInteger(expectedBytes)
    || expectedBytes <= 0
    || expectedBytes > 512 * 1024 * 1024
    || (semanticMode !== "tracked" && semanticMode !== "diagnostic")) {
    const error = new Error(
      "COMPACT_TOOL_SMOKE_ARGUMENTS_INVALID: tool-smoke arguments are invalid.",
    );
    error.code = "COMPACT_TOOL_SMOKE_ARGUMENTS_INVALID";
    throw error;
  }
  return {
    runtimeRoot,
    workRoot,
    sampleHwpPath,
    expectedSha256,
    expectedBytes,
    semanticMode,
  };
}

export function parseCliArguments(args) {
  if (args.length === 0) return { mode: "release" };
  if (args.length === 2
    && args[0] === "--sample"
    && typeof args[1] === "string"
    && args[1].trim().length > 0) {
    return { mode: "diagnostic", sampleHwpPath: args[1] };
  }
  const error = new Error(
    "COMPACT_RUNTIME_CLI_INVALID: use no arguments for release verification or --sample <path> for diagnostics.",
  );
  error.code = "COMPACT_RUNTIME_CLI_INVALID";
  throw error;
}

async function assertSampleHash(path, expectedSha256, toolName, readSha256) {
  if (await readSha256(path) !== expectedSha256) {
    throw new Error(`The HWP sample changed after ${toolName}.`);
  }
}

export async function sha256File(path) {
  let handle;
  let digest;
  let failure;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not a regular file");
    assertHwpFixtureByteLimit(before.size);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(
      1024 * 1024,
      Math.max(1, before.size),
    ));
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.byteLength, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error("unexpected end of file");
      position += bytesRead;
      assertHwpFixtureByteLimit(position);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    assertHwpFixtureByteLimit(after.size);
    if (position !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) {
      throw new Error("file changed while hashing");
    }
    digest = hash.digest("hex");
  } catch {
    failure = hwpIntegrityCheckError();
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      failure ??= hwpIntegrityCheckError();
    }
  }
  if (failure !== undefined) throw failure;
  return digest;
}

function hwpIntegrityCheckError() {
  const error = new Error("HWP_INTEGRITY_CHECK_FAILED: HWP bytes could not be hashed.");
  error.code = "HWP_INTEGRITY_CHECK_FAILED";
  return error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
