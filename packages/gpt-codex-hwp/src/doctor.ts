import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PROJECT_METADATA } from "./generated/project-metadata.js";
import { toolDefinitions } from "./tools/index.js";

export const DOCTOR_SCHEMA_VERSION = 1;

const EXPECTED_TOOL_NAMES = Object.freeze([
  "hwp_detect_format",
  "hwp_read",
  "hwp_generate_hwpx",
  "hwp_validate",
  "hwp_render_preview",
  "hwp_patch_document",
  "hwp_fill_form",
  "hwp_create_svg_asset",
  "hwp_insert_image",
]);
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const JSON_LIMIT_BYTES = 1024 * 1024;
const KORDOC_FILE_LIMIT_BYTES = 16 * 1024 * 1024;
const KORDOC_FILE_COUNT_LIMIT = 256;
const KORDOC_TOTAL_LIMIT_BYTES = 64 * 1024 * 1024;
const REMEDIATION = Object.freeze({
  node: "Install a supported Node.js release and retry the diagnostic.",
  npm: "Install npm for the active Node.js runtime and retry the diagnostic.",
  python: "Install a supported Python 3 runtime and retry the diagnostic.",
  metadata: "Reinstall the plugin from a verified release.",
  dependencies: "Reinstall production dependencies from the verified lockfile.",
  optional: "Install the optional capability only if that workflow is required.",
  fixture: "No repair is required unless pinned release-test evidence is needed.",
});

export interface BoundedCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwdCode: "RUNTIME_ROOT";
  readonly shell: false;
  readonly windowsHide: true;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface BoundedCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DoctorDependencies {
  readonly nodeVersion: string;
  readonly projectMetadata: { readonly productId: string; readonly version: string };
  readonly toolNames: readonly string[];
  readonly npmCommand: { readonly command: string; readonly argsPrefix: readonly string[] } | null;
  readonly pythonCommands: readonly {
    readonly command: string;
    readonly argsPrefix: readonly string[];
  }[];
  readJson(path: string): Promise<unknown>;
  readBytes(path: string): Promise<Uint8Array>;
  statRegular(path: string): Promise<{ readonly regular: boolean; readonly size: number }>;
  sameCanonicalPath(left: string, right: string): Promise<boolean>;
  runCommand(specification: BoundedCommandSpec): Promise<BoundedCommandResult>;
}

export interface DoctorCheck {
  readonly code: string;
  readonly ok: boolean;
  readonly required: boolean;
  readonly version?: string;
  readonly count?: number;
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly schemaVersion: number;
  readonly code: "DOCTOR_OK" | "DOCTOR_REQUIRED_CHECK_FAILED";
  readonly ok: boolean;
  readonly required: { readonly passed: number; readonly failed: number };
  readonly optional: { readonly available: number; readonly unavailable: number };
  readonly checks: readonly DoctorCheck[];
}

export async function runDoctor(
  providedDependencies?: DoctorDependencies,
): Promise<DoctorReport> {
  const dependencies = providedDependencies ?? await createDefaultDependencies();
  const checks: DoctorCheck[] = [];

  checks.push(nodeCheck(dependencies.nodeVersion));
  checks.push(await npmCheck(dependencies));
  checks.push(await pythonCheck(dependencies));
  checks.push(await projectMetadataCheck(dependencies));
  checks.push(await pluginManifestCheck(dependencies));
  checks.push(await mcpManifestCheck(dependencies));
  checks.push(await kordocProvenanceCheck(dependencies));
  checks.push(await kordocLinkCheck(dependencies));
  checks.push(await productionDependencyCheck(dependencies));
  checks.push(toolCountCheck(dependencies.toolNames));
  checks.push(await rhwpCheck(dependencies));
  checks.push(await pinnedFixtureCheck(dependencies));

  const requiredChecks = checks.filter((check) => check.required);
  const optionalChecks = checks.filter((check) => !check.required);
  const requiredFailed = requiredChecks.filter((check) => !check.ok).length;
  const optionalUnavailable = optionalChecks.filter((check) => !check.ok).length;
  const ok = requiredFailed === 0;
  return Object.freeze({
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    code: ok ? "DOCTOR_OK" : "DOCTOR_REQUIRED_CHECK_FAILED",
    ok,
    required: Object.freeze({
      passed: requiredChecks.length - requiredFailed,
      failed: requiredFailed,
    }),
    optional: Object.freeze({
      available: optionalChecks.length - optionalUnavailable,
      unavailable: optionalUnavailable,
    }),
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
  });
}

export async function doctorMain(
  args: readonly string[] = process.argv.slice(2),
  io: {
    stdout(value: string): void;
    stderr(value: string): void;
  } = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
  dependencies?: DoctorDependencies,
): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    io.stderr("DOCTOR_USAGE_INVALID: use --json or no arguments.\n");
    return 2;
  }
  const report = await runDoctor(dependencies);
  if (args[0] === "--json") io.stdout(`${JSON.stringify(report)}\n`);
  else io.stdout(renderHumanReport(report));
  return report.ok ? 0 : 1;
}

export function redactDiagnosticText(value: string): string {
  return value
    .slice(0, COMMAND_OUTPUT_LIMIT_BYTES)
    .replace(/[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\r\n"']+/gu, "<redacted-path>")
    .replace(/\/(?:Users|home)\/[^\s"']+/gu, "<redacted-path>")
    .replace(/\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*[^\s"']+/gu, "<redacted-value>")
    .replace(/\b(?:HOME|USERPROFILE|USERNAME|USER)\s*=\s*[^\r\n]+/giu, "<redacted-value>");
}

async function createDefaultDependencies(): Promise<DoctorDependencies> {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const npmCommand = await resolveNpmCommand();
  return {
    nodeVersion: process.version,
    projectMetadata: PROJECT_METADATA,
    toolNames: toolDefinitions.map((definition) => definition.name),
    npmCommand,
    pythonCommands: process.platform === "win32"
      ? [
        { command: "python", argsPrefix: [] },
        { command: "py", argsPrefix: ["-3"] },
      ]
      : [
        { command: "python3", argsPrefix: [] },
        { command: "python", argsPrefix: [] },
      ],
    readJson: async (path) => JSON.parse(
      new TextDecoder().decode(await readBoundedRuntimeFile(runtimeRoot, path, JSON_LIMIT_BYTES)),
    ),
    readBytes: async (path) => readBoundedRuntimeFile(runtimeRoot, path, KORDOC_FILE_LIMIT_BYTES),
    statRegular: async (path) => {
      try {
        const metadata = await lstat(resolveRuntimePath(runtimeRoot, path));
        return { regular: !metadata.isSymbolicLink() && metadata.isFile(), size: metadata.size };
      } catch {
        return { regular: false, size: 0 };
      }
    },
    sameCanonicalPath: async (left, right) => {
      try {
        const leftPath = await realpath(resolveRuntimePath(runtimeRoot, left));
        const rightPath = await realpath(resolveRuntimePath(runtimeRoot, right));
        return samePath(leftPath, rightPath);
      } catch {
        return false;
      }
    },
    runCommand: (specification) => executeBoundedCommand(specification, runtimeRoot),
  };
}

function nodeCheck(value: string): DoctorCheck {
  const version = cleanVersion(value);
  if (version !== undefined && Number(version.split(".")[0]) >= 22) {
    return check("NODE_RUNTIME_OK", true, true, { version });
  }
  return check("NODE_RUNTIME_UNSUPPORTED", false, true, { remediation: REMEDIATION.node });
}

async function npmCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  if (dependencies.npmCommand === null) {
    return check("NPM_UNAVAILABLE", false, true, { remediation: REMEDIATION.npm });
  }
  const result = await safeRun(dependencies, dependencies.npmCommand.command, [
    ...dependencies.npmCommand.argsPrefix,
    "--version",
  ]);
  const version = cleanVersion(`${result.stdout}\n${result.stderr}`);
  if (successful(result) && version !== undefined) return check("NPM_OK", true, true, { version });
  return check("NPM_UNAVAILABLE", false, true, { remediation: REMEDIATION.npm });
}

async function pythonCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  for (const candidate of dependencies.pythonCommands) {
    const result = await safeRun(dependencies, candidate.command, [
      ...candidate.argsPrefix,
      "--version",
    ]);
    const version = cleanVersion(`${result.stdout}\n${result.stderr}`);
    if (successful(result) && version !== undefined && isSupportedPython(version)) {
      return check("PYTHON_OK", true, false, { version });
    }
  }
  return check("PYTHON_UNAVAILABLE", false, false, { remediation: REMEDIATION.python });
}

async function projectMetadataCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  try {
    const runtimePackage = object(await dependencies.readJson("package.json"));
    const valid = runtimePackage.name === dependencies.projectMetadata.productId
      && runtimePackage.version === dependencies.projectMetadata.version
      && object(runtimePackage.dependencies).kordoc === "file:vendor/kordoc-core";
    return valid
      ? check("PROJECT_METADATA_OK", true, true)
      : check("PROJECT_METADATA_INVALID", false, true, { remediation: REMEDIATION.metadata });
  } catch {
    return check("PROJECT_METADATA_INVALID", false, true, { remediation: REMEDIATION.metadata });
  }
}

async function pluginManifestCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  try {
    const manifest = object(await dependencies.readJson(".codex-plugin/plugin.json"));
    const version = typeof manifest.version === "string" ? manifest.version : "";
    const valid = manifest.name === dependencies.projectMetadata.productId
      && version.startsWith(`${dependencies.projectMetadata.version}+codex.`)
      && manifest.mcpServers === "./.mcp.json";
    return valid
      ? check("PLUGIN_MANIFEST_OK", true, true)
      : check("PLUGIN_MANIFEST_INVALID", false, true, { remediation: REMEDIATION.metadata });
  } catch {
    return check("PLUGIN_MANIFEST_INVALID", false, true, { remediation: REMEDIATION.metadata });
  }
}

async function mcpManifestCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  try {
    const manifest = object(await dependencies.readJson(".mcp.json"));
    const servers = object(manifest.mcpServers);
    const keys = Object.keys(servers);
    const server = object(servers[dependencies.projectMetadata.productId]);
    const valid = keys.length === 1
      && keys[0] === dependencies.projectMetadata.productId
      && server.command === "node"
      && isExactStringArray(server.args, ["./dist/mcp.js"])
      && server.cwd === ".";
    return valid
      ? check("MCP_MANIFEST_OK", true, true, { count: keys.length })
      : check("MCP_MANIFEST_INVALID", false, true, { remediation: REMEDIATION.metadata });
  } catch {
    return check("MCP_MANIFEST_INVALID", false, true, { remediation: REMEDIATION.metadata });
  }
}

async function kordocProvenanceCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  try {
    const runtimePackage = object(await dependencies.readJson("package.json"));
    const kordocPackage = object(await dependencies.readJson("vendor/kordoc-core/package.json"));
    const provenance = object(await dependencies.readJson("vendor/kordoc-core/PROVENANCE.json"));
    const source = object(provenance.source);
    const files = Array.isArray(provenance.files) ? provenance.files : [];
    if (
      object(runtimePackage.dependencies).kordoc !== "file:vendor/kordoc-core"
      || kordocPackage.name !== "kordoc"
      || kordocPackage.license !== "MIT"
      || source.name !== "kordoc"
      || source.version !== kordocPackage.version
      || files.length === 0
      || files.length > KORDOC_FILE_COUNT_LIMIT
    ) throw new Error("invalid provenance");
    let declaredBytes = 0;
    for (const candidate of files) {
      const file = object(candidate);
      if (!safeRelativeFile(file.path) || !safeHash(file.sha256) || !safeSize(file.size)) {
        throw new Error("invalid provenance entry");
      }
      declaredBytes += Number(file.size);
      if (declaredBytes > KORDOC_TOTAL_LIMIT_BYTES) throw new Error("provenance budget exceeded");
    }
    for (const candidate of files) {
      const file = object(candidate);
      const bytes = await dependencies.readBytes(`vendor/kordoc-core/${file.path}`);
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) {
        throw new Error("provenance mismatch");
      }
    }
    return check("KORDOC_PROVENANCE_OK", true, true, { count: files.length });
  } catch {
    return check("KORDOC_PROVENANCE_INVALID", false, true, { remediation: REMEDIATION.metadata });
  }
}

async function kordocLinkCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  const valid = await dependencies.sameCanonicalPath(
    "node_modules/kordoc",
    "vendor/kordoc-core",
  );
  return valid
    ? check("KORDOC_LINK_OK", true, true)
    : check("KORDOC_LINK_INVALID", false, true, { remediation: REMEDIATION.dependencies });
}

async function productionDependencyCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  if (dependencies.npmCommand === null) {
    return check("PRODUCTION_DEPENDENCIES_INVALID", false, true, {
      remediation: REMEDIATION.dependencies,
    });
  }
  const result = await safeRun(dependencies, dependencies.npmCommand.command, [
    ...dependencies.npmCommand.argsPrefix,
    "ls",
    "--omit=dev",
    "--json",
    "--depth=0",
  ]);
  try {
    const parsed = object(JSON.parse(redactDiagnosticText(result.stdout)));
    if (!successful(result)
      || parsed.name !== dependencies.projectMetadata.productId
      || parsed.version !== dependencies.projectMetadata.version) {
      throw new Error("invalid dependency tree");
    }
    return check("PRODUCTION_DEPENDENCIES_OK", true, true, {
      count: Object.keys(object(parsed.dependencies)).length,
    });
  } catch {
    return check("PRODUCTION_DEPENDENCIES_INVALID", false, true, {
      remediation: REMEDIATION.dependencies,
    });
  }
}

function toolCountCheck(names: readonly string[]): DoctorCheck {
  const valid = names.length === EXPECTED_TOOL_NAMES.length
    && names.every((name, index) => name === EXPECTED_TOOL_NAMES[index]);
  return valid
    ? check("MCP_TOOL_COUNT_OK", true, true, { count: names.length })
    : check("MCP_TOOL_COUNT_INVALID", false, true, { count: names.length, remediation: REMEDIATION.metadata });
}

async function rhwpCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  try {
    const runtimePackage = object(await dependencies.readJson("package.json"));
    const expectedVersion = object(runtimePackage.optionalDependencies)["@rhwp/core"];
    const rhwpPackage = object(await dependencies.readJson("node_modules/@rhwp/core/package.json"));
    const version = cleanVersion(String(rhwpPackage.version ?? ""));
    if (rhwpPackage.name !== "@rhwp/core" || version === undefined || version !== expectedVersion) {
      throw new Error("invalid optional package");
    }
    return check("RHWP_AVAILABLE", true, false, { version });
  } catch {
    return check("RHWP_UNAVAILABLE", false, false, { remediation: REMEDIATION.optional });
  }
}

async function pinnedFixtureCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  try {
    const provenance = object(await dependencies.readJson("tests/fixtures/rhwp/provenance.json"));
    const fixture = await dependencies.statRegular(
      "tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp",
    );
    const bytes = await dependencies.readBytes(
      "tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp",
    );
    if (!fixture.regular || !safeSize(provenance.bytes) || !safeHash(provenance.sha256)
      || fixture.size !== provenance.bytes || bytes.byteLength !== provenance.bytes
      || sha256(bytes) !== provenance.sha256) throw new Error("fixture unavailable");
    return check("PINNED_HWP_FIXTURE_AVAILABLE", true, false, { count: 1 });
  } catch {
    return check("PINNED_HWP_FIXTURE_UNAVAILABLE", false, false, {
      remediation: REMEDIATION.fixture,
    });
  }
}

async function safeRun(
  dependencies: DoctorDependencies,
  command: string,
  args: readonly string[],
): Promise<BoundedCommandResult> {
  try {
    const result = await dependencies.runCommand({
      command,
      args: Object.freeze([...args]),
      cwdCode: "RUNTIME_ROOT",
      shell: false,
      windowsHide: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    });
    return Object.freeze({
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdout: redactDiagnosticText(result.stdout),
      stderr: redactDiagnosticText(result.stderr),
    });
  } catch {
    return Object.freeze({
      code: null,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: "",
      stderr: "",
    });
  }
}

function executeBoundedCommand(
  specification: BoundedCommandSpec,
  runtimeRoot: string,
): Promise<BoundedCommandResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const child = spawn(specification.command, [...specification.args], {
      cwd: runtimeRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, specification.timeoutMs);
    timer.unref();
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer | string): Buffer<ArrayBufferLike> => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = specification.maxOutputBytes - stdout.byteLength - stderr.byteLength;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (incoming.byteLength > remaining) truncated = true;
      return Buffer.concat([current, incoming.subarray(0, Math.max(0, remaining))]);
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const finish = (result: BoundedCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    child.once("error", () => finish({
      code: null,
      signal: null,
      timedOut,
      truncated,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
    }));
    child.once("close", (code, signal) => finish({
      code,
      signal,
      timedOut,
      truncated,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
    }));
  });
}

async function resolveNpmCommand(): Promise<{
  readonly command: string;
  readonly argsPrefix: readonly string[];
} | null> {
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
      const metadata = await lstat(candidate);
      if (!metadata.isSymbolicLink() && metadata.isFile()) {
        return Object.freeze({ command: process.execPath, argsPrefix: Object.freeze([candidate]) });
      }
    } catch {
      // Try the next fixed installation layout.
    }
  }
  return null;
}

async function readBoundedRuntimeFile(
  runtimeRoot: string,
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const absolute = resolveRuntimePath(runtimeRoot, path);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error("unsafe diagnostic file");
  }
  const handle = await open(absolute, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximumBytes || !sameFileIdentity(metadata, opened)) {
      throw new Error("diagnostic file changed");
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (bytes.byteLength !== opened.size || bytes.byteLength > maximumBytes
      || !sameFileIdentity(opened, final) || final.size !== opened.size
      || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
      throw new Error("diagnostic file changed");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function resolveRuntimePath(runtimeRoot: string, path: string): string {
  if (!safeRelativeFile(path)) throw new Error("unsafe diagnostic path");
  const absolute = resolve(runtimeRoot, ...path.split("/"));
  const fromRoot = relative(runtimeRoot, absolute);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error("diagnostic path escapes runtime");
  }
  return absolute;
}

function renderHumanReport(report: DoctorReport): string {
  const lines = [
    `${report.code} (schema ${report.schemaVersion})`,
    `required: ${report.required.passed} passed, ${report.required.failed} failed`,
    `optional: ${report.optional.available} available, ${report.optional.unavailable} unavailable`,
  ];
  for (const item of report.checks) {
    const details = [
      item.version === undefined ? "" : ` version=${item.version}`,
      item.count === undefined ? "" : ` count=${item.count}`,
    ].join("");
    lines.push(`${item.ok ? "PASS" : item.required ? "FAIL" : "OPTIONAL"} ${item.code}${details}`);
    if (item.remediation !== undefined) lines.push(`  ${item.remediation}`);
  }
  return `${lines.join("\n")}\n`;
}

function check(
  code: string,
  ok: boolean,
  required: boolean,
  extra: Pick<DoctorCheck, "version" | "count" | "remediation"> = {},
): DoctorCheck {
  return Object.freeze({ code, ok, required, ...extra });
}

function successful(result: BoundedCommandResult): boolean {
  return result.code === 0 && !result.timedOut && !result.truncated;
}

function cleanVersion(value: string): string | undefined {
  const match = value.match(/(?:^|\s|v)(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\s|$)/u);
  return match?.[1];
}

function isSupportedPython(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major === 3 && minor !== undefined && minor >= 10;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function safeRelativeFile(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.includes("\\")
    && !value.startsWith("/")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= KORDOC_FILE_LIMIT_BYTES;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function samePath(left: string, right: string): boolean {
  if (process.platform !== "win32") return left === right;
  return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
}

function sameFileIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  doctorMain().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write("DOCTOR_INTERNAL_ERROR: reinstall the plugin from a verified release.\n");
    process.exitCode = 1;
  });
}
