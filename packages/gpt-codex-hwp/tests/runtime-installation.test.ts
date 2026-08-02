import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  RuntimeInstallError,
  installRuntime,
  type RuntimeCommandSpec,
} from "../src/install-runtime.js";
import {
  RuntimeBootstrapError,
  resolveDurableRoot,
  resolveManagedRuntime,
} from "../src/runtime-bootstrap.js";

const PRODUCT = "gpt-codex-hwp";
const MARKETPLACE = "gpt-codex-hwp-local";
const PLUGIN_VERSION = "0.2.3+codex.20260802005314";
const RUNTIME_KEY = `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`;
const TOOL_NAMES = [
  "hwp_create_svg_asset",
  "hwp_detect_format",
  "hwp_fill_form",
  "hwp_generate_hwpx",
  "hwp_insert_image",
  "hwp_patch_document",
  "hwp_read",
  "hwp_render_preview",
  "hwp_validate",
];

test("runtime installer publishes a verified runtime and reuses it without npm ci", async (t) => {
  const fixture = await createInstallerFixture(t);
  const commands: RuntimeCommandSpec[] = [];
  const runCommand = createNpmRunner(commands);

  const first = await installRuntime(fixture.installerUrl, {
    codexHome: fixture.codexHome,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
    randomId: sequence("1".repeat(32), "2".repeat(32), "3".repeat(32)),
    runCommand,
    secureDirectory: async () => true,
  });
  assert.equal(first.code, "RUNTIME_INSTALL_OK");
  assert.equal(first.toolCount, 9);
  assert.equal(first.dependencyCount, 1);
  assert.equal((await lstat(join(fixture.durableRoot, "node_modules", "zod", "package.json"))).isFile(), true);
  assert.deepEqual(commands[0].args.slice(-6), [
    "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--install-links=true",
  ]);
  assert.equal(commands[0].env.NODE_OPTIONS, undefined);

  commands.length = 0;
  const second = await installRuntime(fixture.installerUrl, {
    codexHome: fixture.codexHome,
    now: () => new Date("2026-08-02T00:01:00.000Z"),
    randomId: sequence("4".repeat(32)),
    runCommand,
    secureDirectory: async () => true,
  });
  assert.deepEqual(second, first);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].args.includes("ls"), true);
  assert.equal(commands[0].args.includes("ci"), false);
});

test("runtime installer keeps supported Node majors isolated in one Codex home", async (t) => {
  const fixture = await createInstallerFixture(t);
  const commands: RuntimeCommandSpec[] = [];
  const runCommand = createNpmRunner(commands);
  const node22Identity = await resolveManagedRuntime(fixture.installerUrl, {
    codexHome: fixture.codexHome,
    nodeVersion: "22.22.2",
  });
  const node24Identity = await resolveManagedRuntime(fixture.installerUrl, {
    codexHome: fixture.codexHome,
    nodeVersion: "24.4.0",
  });
  const node22Root = resolveDurableRoot(node22Identity);
  const node24Root = resolveDurableRoot(node24Identity);
  assert.equal(node22Root, join(
    fixture.codexHome, "plugin-runtime-data", PRODUCT, PLUGIN_VERSION,
    `${process.platform}-${process.arch}-node22`,
  ));
  assert.equal(node24Root, join(
    fixture.codexHome, "plugin-runtime-data", PRODUCT, PLUGIN_VERSION,
    `${process.platform}-${process.arch}-node24`,
  ));
  assert.notEqual(node22Root, node24Root);

  const versionRoot = join(fixture.codexHome, "plugin-runtime-data", PRODUCT, PLUGIN_VERSION);
  await mkdir(node24Root, { recursive: true });
  await writeFile(join(node24Root, "keep.txt"), "node24\n", "utf8");
  const legacySharedLock = join(versionRoot, `.${process.platform}-${process.arch}.install.lock`);
  const node24Lock = join(versionRoot, `.${process.platform}-${process.arch}-node24.install.lock`);
  const activeLock = `${JSON.stringify({
    schemaVersion: 1,
    nonce: "a".repeat(32),
    createdAt: "2026-08-03T00:00:00.000Z",
  })}\n`;
  await writeFile(legacySharedLock, activeLock, "utf8");
  await writeFile(node24Lock, activeLock, "utf8");
  const receipt = await installRuntime(fixture.installerUrl, {
    codexHome: fixture.codexHome,
    nodeVersion: "22.22.2",
    now: () => new Date("2026-08-03T00:00:00.000Z"),
    randomId: sequence("1".repeat(32), "2".repeat(32), "3".repeat(32)),
    runCommand,
    secureDirectory: async () => true,
  });
  assert.equal(receipt.nodeMajor, 22);
  assert.equal(await readFile(join(node24Root, "keep.txt"), "utf8"), "node24\n");
  assert.equal(await readFile(legacySharedLock, "utf8"), activeLock);
  assert.equal(await readFile(node24Lock, "utf8"), activeLock);
  assert.equal(commands.filter((command) => command.args.includes("ci")).length, 1);
});

test("runtime installer rejects an active lock without touching an earlier version", async (t) => {
  const fixture = await createInstallerFixture(t);
  const versionRoot = join(fixture.codexHome, "plugin-runtime-data", PRODUCT, PLUGIN_VERSION);
  const oldRuntime = join(fixture.codexHome, "plugin-runtime-data", PRODUCT, "0.2.2+codex.20260731000000", `${process.platform}-${process.arch}`);
  await mkdir(oldRuntime, { recursive: true });
  await writeFile(join(oldRuntime, "keep.txt"), "keep\n", "utf8");
  await mkdir(versionRoot, { recursive: true });
  await writeFile(join(versionRoot, `.${RUNTIME_KEY}.install.lock`), `${JSON.stringify({
    schemaVersion: 1,
    nonce: "a".repeat(32),
    createdAt: "2026-08-02T00:00:00.000Z",
  })}\n`, "utf8");

  await assert.rejects(
    installRuntime(fixture.installerUrl, {
      codexHome: fixture.codexHome,
      now: () => new Date("2026-08-02T00:01:00.000Z"),
      randomId: sequence("5".repeat(32)),
      runCommand: createNpmRunner([]),
      secureDirectory: async () => true,
    }),
    (error: unknown) => error instanceof RuntimeInstallError
      && error.code === "RUNTIME_INSTALL_BUSY"
      && error.message === "RUNTIME_INSTALL_BUSY",
  );
  assert.equal(await readFile(join(oldRuntime, "keep.txt"), "utf8"), "keep\n");
});

test("runtime installer removes only its failed stage and emits no private command output", async (t) => {
  const fixture = await createInstallerFixture(t);
  const privateOutput = `${["C:", "Users", "private"].join("\\")} ${[
    "OPENAI", "API", "KEY",
  ].join("_")}=secret`;
  await assert.rejects(
    installRuntime(fixture.installerUrl, {
      codexHome: fixture.codexHome,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      randomId: sequence("6".repeat(32), "7".repeat(32)),
      runCommand: async () => ({
        code: null,
        stdout: Buffer.from(privateOutput),
        stderr: Buffer.from("secret"),
        timedOut: true,
      }),
      secureDirectory: async () => true,
    }),
    (error: unknown) => error instanceof RuntimeInstallError
      && error.code === "RUNTIME_INSTALL_FAILED"
      && error.message === "RUNTIME_INSTALL_FAILED",
  );
  const versionRoot = join(fixture.codexHome, "plugin-runtime-data", PRODUCT, PLUGIN_VERSION);
  const remaining = await readdir(versionRoot);
  assert.equal(remaining.some((name) => name.includes("stage")), false);
  assert.equal(remaining.some((name) => name.includes("Users") || name.includes("secret")), false);
});

test("runtime installer rejects an invalid final path without moving it", async (t) => {
  const fixture = await createInstallerFixture(t);
  await mkdir(join(fixture.durableRoot, ".."), { recursive: true });
  await writeFile(fixture.durableRoot, "keep-existing-path\n", "utf8");

  await assert.rejects(
    installRuntime(fixture.installerUrl, {
      codexHome: fixture.codexHome,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      randomId: sequence("8".repeat(32)),
      runCommand: createNpmRunner([]),
      secureDirectory: async () => true,
    }),
    (error: unknown) => error instanceof RuntimeBootstrapError
      && error.code === "RUNTIME_PATH_INVALID",
  );
  assert.equal(await readFile(fixture.durableRoot, "utf8"), "keep-existing-path\n");
});

test("runtime installer rejects manifest files reached through a linked source ancestor", async (t) => {
  const fixture = await createInstallerFixture(t);
  const source = join(fixture.managedRoot, "vendor", "kordoc-core");
  const outside = join(fixture.codexHome, "outside-kordoc");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "package.json"), jsonBytes({ name: "kordoc", version: "0.0.0" }));
  await rm(source, { recursive: true });
  try {
    await symlink(outside, source, process.platform === "win32" ? "junction" : "dir");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error
      && ["EACCES", "ENOTSUP", "EPERM"].includes(String(error.code))) {
      t.skip(`directory-link capability is unavailable: ${String(error.code)}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    installRuntime(fixture.installerUrl, {
      codexHome: fixture.codexHome,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      randomId: sequence("9".repeat(32), "a".repeat(32), "b".repeat(32)),
      runCommand: createNpmRunner([]),
      secureDirectory: async () => true,
    }),
    (error: unknown) => error instanceof RuntimeBootstrapError
      && error.code === "RUNTIME_PATH_INVALID",
  );
});

test("runtime installer quarantines a stale lock and preserves an invalid final", async (t) => {
  const fixture = await createInstallerFixture(t);
  const versionRoot = join(fixture.durableRoot, "..");
  await mkdir(fixture.durableRoot, { recursive: true });
  await writeFile(join(fixture.durableRoot, "keep.txt"), "preserve\n", "utf8");
  const lockName = `.${RUNTIME_KEY}.install.lock`;
  await writeFile(join(versionRoot, lockName), `${JSON.stringify({
    schemaVersion: 1,
    nonce: "c".repeat(32),
    createdAt: "2026-08-01T23:00:00.000Z",
  })}\n`, "utf8");

  const receipt = await installRuntime(fixture.installerUrl, {
    codexHome: fixture.codexHome,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
    randomId: sequence("d".repeat(32), "e".repeat(32), "f".repeat(32), "0".repeat(32)),
    runCommand: createNpmRunner([]),
    secureDirectory: async () => true,
  });

  assert.equal(receipt.code, "RUNTIME_INSTALL_OK");
  const entries = await readdir(versionRoot);
  const stale = entries.find((name) => name.startsWith(`${lockName}.stale-`));
  const invalid = entries.find((name) => name.includes(".invalid-"));
  assert.ok(stale);
  assert.ok(invalid);
  assert.equal(await readFile(join(versionRoot, invalid, "keep.txt"), "utf8"), "preserve\n");
});

test("runtime installer rejects source hash drift", async (t) => {
  const fixture = await createInstallerFixture(t);
  await writeFile(join(fixture.managedRoot, "vendor", "kordoc-core", "package.json"), "tampered\n", "utf8");

  await assert.rejects(
    installRuntime(fixture.installerUrl, {
      codexHome: fixture.codexHome,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      randomId: sequence("1".repeat(32), "2".repeat(32), "3".repeat(32)),
      runCommand: createNpmRunner([]),
      secureDirectory: async () => true,
    }),
    (error: unknown) => error instanceof RuntimeBootstrapError
      && error.code === "RUNTIME_SOURCE_MISMATCH",
  );
});

test("runtime installer rejects doctor failure and tool-count drift", async (t) => {
  for (const doctor of [
    { exitCode: 1, report: doctorReport(9, false) },
    { exitCode: 0, report: doctorReport(8, true) },
  ]) {
    const fixture = await createInstallerFixture(t, doctor);
    await assert.rejects(
      installRuntime(fixture.installerUrl, {
        codexHome: fixture.codexHome,
        now: () => new Date("2026-08-02T00:00:00.000Z"),
        randomId: sequence("4".repeat(32), "5".repeat(32), "6".repeat(32)),
        runCommand: createNpmRunner([]),
        secureDirectory: async () => true,
      }),
      (error: unknown) => error instanceof RuntimeInstallError
        && error.code === "RUNTIME_INSTALL_FAILED",
    );
  }
});

async function createInstallerFixture(
  t: { after(fn: () => Promise<void>): void },
  doctor = { exitCode: 0, report: doctorReport(9, true) },
) {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-installer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex-home");
  const managedRoot = join(codexHome, "plugins", "cache", MARKETPLACE, PRODUCT, PLUGIN_VERSION);
  const files = new Map<string, Buffer>([
    [".codex-plugin/plugin.json", jsonBytes({ name: PRODUCT, version: PLUGIN_VERSION, skills: "./skills/" })],
    [".npmrc", Buffer.from("ignore-scripts=true\n", "utf8")],
    ["dist/install-runtime.js", Buffer.from("export {};\n", "utf8")],
    ["dist/oneshot-main.js", Buffer.from("export async function runOneShotEntry(){ return 0; }\n", "utf8")],
    ["dist/mcp-main.js", Buffer.from("export async function runMcpServer(){}\n", "utf8")],
    ["dist/doctor-main.js", Buffer.from(`export async function doctorMain(_args, io) { io.stdout(JSON.stringify(${JSON.stringify(doctor.report)}) + "\\n"); return ${doctor.exitCode}; }\n`, "utf8")],
    ["examples/mcp-manual.json", jsonBytes({ mcpServers: {} })],
    ["examples/oneshot-tool-schemas.json", jsonBytes({
      schemaVersion: 1,
      requestSchema: {},
      tools: Object.fromEntries(TOOL_NAMES.map((name) => [name, { type: "object" }])),
    })],
    ["scripts/kordoc-runtime-verifier.mjs", Buffer.from("export async function verifyKordocCoreRuntime(){ return { files: [{}] }; } export async function kordocFileRecords(){ return [{}]; }\n", "utf8")],
    ["vendor/kordoc-core/package.json", jsonBytes({ name: "kordoc", version: "0.0.0" })],
  ]);
  const packageBytes = jsonBytes({
    name: PRODUCT,
    version: "0.2.3",
    type: "module",
    dependencies: { zod: "3.25.76" },
  });
  const lockBytes = jsonBytes({ name: PRODUCT, version: "0.2.3", lockfileVersion: 3, packages: {} });
  files.set("package.json", packageBytes);
  files.set("package-lock.json", lockBytes);
  for (const [path, bytes] of files) {
    const destination = join(managedRoot, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, bytes);
  }
  const manifest = {
    schemaVersion: 1,
    productId: PRODUCT,
    pluginVersion: PLUGIN_VERSION,
    packageLockSha256: sha256(lockBytes),
    mainEntries: ["dist/doctor-main.js", "dist/mcp-main.js", "dist/oneshot-main.js"],
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256(bytes) }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
  await writeFile(join(managedRoot, "runtime-manifest.json"), jsonBytes(manifest));
  return {
    codexHome,
    managedRoot,
    durableRoot: join(codexHome, "plugin-runtime-data", PRODUCT, PLUGIN_VERSION, RUNTIME_KEY),
    installerUrl: pathToFileURL(join(managedRoot, "dist", "install-runtime.js")).href,
  };
}

function createNpmRunner(commands: RuntimeCommandSpec[]) {
  return async (spec: RuntimeCommandSpec) => {
    commands.push(spec);
    if (spec.args.includes("ci")) {
      await mkdir(join(spec.cwd, "node_modules", "zod"), { recursive: true });
      await writeFile(join(spec.cwd, "node_modules", "zod", "package.json"), jsonBytes({ name: "zod", version: "3.25.76" }));
    }
    return {
      code: 0,
      stdout: spec.args.includes("ls")
        ? jsonBytes({ name: PRODUCT, version: "0.2.3", dependencies: { zod: { version: "3.25.76" } } })
        : Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
    };
  };
}

function doctorReport(toolCount: number, ok: boolean) {
  return {
    schemaVersion: 1,
    code: ok ? "DOCTOR_OK" : "DOCTOR_REQUIRED_CHECK_FAILED",
    ok,
    required: { passed: ok ? 1 : 0, failed: ok ? 0 : 1 },
    optional: { available: 0, unavailable: 0 },
    checks: [{ code: "MCP_TOOL_COUNT_OK", ok: true, required: true, count: toolCount }],
  };
}

function sequence(...values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
