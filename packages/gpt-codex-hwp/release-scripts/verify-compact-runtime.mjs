import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildRuntime } from "../../../scripts/project-runtime.mjs";
import { verifyKordocCoreRuntime } from "../../../scripts/kordoc-core-runtime.mjs";
import {
  assertCompactBudgets,
  assertCompactLockfile,
  isExcludedPackagePath,
  summarizeInstalledEntries,
} from "./compact-policy.mjs";

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
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] };
  }
  return { command: "npm", args: [...args] };
}

export async function runCommand(command, args, cwd, options = {}) {
  const { allowFailure = false, timeoutMs = COMMAND_TIMEOUT_MS } = options;
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutError = new Error(`Command timed out after ${timeoutMs} ms: ${command} ${args.join(" ")}`);
      void terminateProcessTree(child).then(
        () => reject(timeoutError),
        (terminationError) => reject(new Error(`${timeoutError.message}; process-tree termination failed.`, {
          cause: terminationError,
        })),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
      } else {
        resolvePromise({ code, stdout, stderr });
      }
    });
  });
}

async function terminateProcessTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise((resolvePromise) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
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
  if (stdout.trim().length === 0) throw new Error("npm ls returned empty JSON output.");
  let tree;
  try {
    tree = JSON.parse(stdout);
  } catch (error) {
    throw new Error("npm ls returned invalid JSON.", { cause: error });
  }
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    throw new Error("npm ls returned invalid JSON data.");
  }
  if (Object.keys(tree).length === 0) throw new Error("npm ls returned an empty JSON object.");
  if (tree.problems !== undefined && !Array.isArray(tree.problems)) {
    throw new Error("npm ls returned malformed dependency problems.");
  }
  const problems = tree.problems ?? [];
  if (result.code !== 0) {
    throw new Error(`npm ls exited with nonzero status ${result.code}: ${result.stderr || stdout}`);
  }
  if (problems.length > 0) {
    throw new Error(`npm ls reported dependency problems: ${problems.join(", ")}`);
  }
  return { status: "passed", problems };
}

async function measureTree(root, collectedEntries = undefined, pathRoot = root) {
  let bytes = 0;
  let canonicalExpectedKordocTarget;
  async function expectedKordocTarget() {
    canonicalExpectedKordocTarget ??= await realpath(join(pathRoot, "vendor", "kordoc-core"));
    return canonicalExpectedKordocTarget;
  }
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const path = relative(pathRoot, absolute).split(sep).join("/");
        const target = await realpath(absolute);
        const allowedLocalKordoc = isAllowedKordocLink({
          linkPath: path,
          canonicalTarget: target,
          canonicalExpectedTarget: await expectedKordocTarget(),
        });
        if (!allowedLocalKordoc) throw new Error(`Installed runtime contains an unexpected symbolic link: ${absolute}`);
        collectedEntries?.linkPaths.push(path);
        continue;
      }
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) {
        bytes += info.size;
        collectedEntries?.filePaths.push(relative(pathRoot, absolute).split(sep).join("/"));
      } else throw new Error(`Unsupported installed entry: ${absolute}`);
    }
  }
  await visit(root);
  return bytes;
}

function requireSuccess(name, result) {
  if (result?.isError) throw new Error(`${name} smoke failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent ?? {};
}

async function verifyMcp(runtimeRoot) {
  const serverPath = join(runtimeRoot, "dist", "mcp.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: runtimeRoot,
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
    return { version, tools, stderrBytes: Buffer.byteLength(stderr) };
  } finally {
    await client.close();
    await transport.close();
    if (stderr.length > 0) throw new Error(`MCP wrote to stderr: ${stderr}`);
  }
}

async function verifyTools(runtimeRoot, workRoot, sampleHwpPath) {
  const toolRoot = join(runtimeRoot, "dist", "tools");
  const detect = await import(pathToFileURL(join(toolRoot, "detect.js")).href);
  const read = await import(pathToFileURL(join(toolRoot, "read.js")).href);
  const write = await import(pathToFileURL(join(toolRoot, "write.js")).href);
  const preview = await import(pathToFileURL(join(toolRoot, "preview.js")).href);
  const patch = await import(pathToFileURL(join(toolRoot, "patch.js")).href);
  const assets = await import(pathToFileURL(join(toolRoot, "assets.js")).href);
  const statuses = {};

  requireSuccess("hwp_detect_format", await detect.handleHwpDetectFormat({ file_path: sampleHwpPath }));
  statuses.hwp_detect_format = "passed";
  requireSuccess("hwp_read", await read.handleHwpRead({ file_path: sampleHwpPath }));
  statuses.hwp_read = "passed";

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

export async function verifyCompactRuntime({ sourceRoot, sampleHwpPath }) {
  const source = resolve(sourceRoot);
  const sample = resolve(sampleHwpPath);
  const sampleBefore = createHash("sha256").update(await readFile(sample)).digest("hex");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-compact-"));
  let report;
  try {
    const runtimeRoot = join(temporaryRoot, "runtime");
    await buildRuntime({ root: source, outputRoot: runtimeRoot });
    const provenanceRecord = await verifyKordocCoreRuntime(join(runtimeRoot, "vendor", "kordoc-core"));
    const provenance = {
      status: "passed",
      archiveSha512: provenanceRecord.archive.sha512,
      fileCount: provenanceRecord.files.length,
    };
    const publicRuntimeBytes = await measureTree(runtimeRoot);
    const lock = JSON.parse(await readFile(join(runtimeRoot, "package-lock.json"), "utf8"));
    assertCompactLockfile(lock);
    await runNpm(["ci", "--omit=dev", "--ignore-scripts"], runtimeRoot);
    const npmLsRun = await runNpm(
      ["ls", "--omit=dev", "--all", "--json"],
      runtimeRoot,
      { allowFailure: true },
    );
    const npmLs = parseNpmLsResult(npmLsRun);
    const auditRun = await runNpm(
      ["audit", "--omit=dev", "--json"],
      runtimeRoot,
      { allowFailure: true },
    );
    const audit = JSON.parse(auditRun.stdout);
    if (auditRun.code !== 0 || audit.metadata?.vulnerabilities?.total !== 0) {
      throw new Error(`npm audit reported vulnerabilities: ${auditRun.stdout}`);
    }
    const installedEntries = { filePaths: [], linkPaths: [] };
    const nodeModulesBytes = await measureTree(join(runtimeRoot, "node_modules"), installedEntries, runtimeRoot);
    const installedBytes = await measureTree(runtimeRoot);
    const installedSummary = summarizeInstalledEntries(installedEntries);
    if (installedSummary.excludedPaths.length > 0) {
      throw new Error(`Excluded dependencies installed: ${installedSummary.excludedPaths.join(", ")}`);
    }
    assertCompactBudgets({ nodeModulesBytes, installedBytes, publicRuntimeBytes });
    const mcp = await verifyMcp(runtimeRoot);
    const smokeRun = await runCommand(process.execPath, [
      fileURLToPath(import.meta.url),
      "--tool-smoke",
      runtimeRoot,
      temporaryRoot,
      sample,
    ], source, { timeoutMs: TOOL_SMOKE_TIMEOUT_MS });
    const tools = JSON.parse(smokeRun.stdout);
    const sampleAfter = createHash("sha256").update(await readFile(sample)).digest("hex");
    if (sampleAfter !== sampleBefore) throw new Error("The HWP sample changed during verification.");
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
      audit: audit.metadata.vulnerabilities,
      serverVersion: mcp.version,
      toolNames: mcp.tools,
      toolSmokes: tools,
      sourceSha256: sampleBefore,
      stderrBytes: mcp.stderrBytes,
      cleanup: false,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  report.cleanup = true;
  return report;
}

async function main() {
  if (process.argv[2] === "--tool-smoke") {
    const [, , , runtimeRoot, workRoot, sampleHwpPath] = process.argv;
    if (!runtimeRoot || !workRoot || !sampleHwpPath) throw new Error("Incomplete tool-smoke arguments.");
    process.stdout.write(`${JSON.stringify(await verifyTools(runtimeRoot, workRoot, sampleHwpPath))}\n`);
    return;
  }
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const configuredFixture = process.env.HWP_TEST_FIXTURE?.trim();
  if (!configuredFixture) {
    process.stdout.write(`${JSON.stringify({
      check: "real-hwp-compact-runtime",
      status: "skipped",
      reason: "Set HWP_TEST_FIXTURE to an explicit diagnostic HWP fixture path.",
    }, null, 2)}\n`);
    return;
  }
  const sampleHwpPath = resolve(configuredFixture);
  process.stdout.write(`${JSON.stringify(await verifyCompactRuntime({ sourceRoot, sampleHwpPath }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
