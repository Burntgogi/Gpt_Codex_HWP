import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  RuntimeBootstrapError,
  resolveInstalledRuntime,
} from "../src/runtime-bootstrap.js";
import { runDoctorBootstrap } from "../src/doctor.js";
import { runMcpBootstrap } from "../src/mcp.js";
import { runOneShotBootstrap } from "../src/oneshot.js";

const PRODUCT = "gpt-codex-hwp";
const MARKETPLACE = "gpt-codex-hwp-local";
const PLUGIN_VERSION = "0.2.3+codex.20260802005314";
const RUNTIME_KEY = `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`;

test("runtime bootstrap resolves the exact version and platform durable runtime", async (t) => {
  const fixture = await createRuntimeFixture(t);
  const runtime = await resolveInstalledRuntime(
    pathToFileURL(join(fixture.managedRoot, "dist", "oneshot.js")).href,
    "dist/oneshot-main.js",
    { codexHome: fixture.codexHome },
  );

  assert.equal(runtime.root, fixture.durableRoot);
  assert.equal(runtime.mainUrl, pathToFileURL(join(fixture.durableRoot, "dist", "oneshot-main.js")).href);
  assert.equal(runtime.receipt.pluginVersion, PLUGIN_VERSION);
});

test("runtime bootstrap reports a missing durable runtime without disclosing its path", async (t) => {
  const fixture = await createRuntimeFixture(t, { durable: false });
  await assert.rejects(
    resolveInstalledRuntime(
      pathToFileURL(join(fixture.managedRoot, "dist", "oneshot.js")).href,
      "dist/oneshot-main.js",
      { codexHome: fixture.codexHome },
    ),
    (error: unknown) => error instanceof RuntimeBootstrapError
      && error.code === "RUNTIME_NOT_INSTALLED"
      && error.message === "RUNTIME_NOT_INSTALLED",
  );
});

test("runtime bootstrap maps receipt source platform dependency and path failures to fixed codes", async (t) => {
  const cases: ReadonlyArray<Readonly<{
    code: string;
    mutate(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>): Promise<void>;
  }>> = [
    {
      code: "RUNTIME_RECEIPT_INVALID",
      mutate: async ({ receiptPath }) => writeFile(receiptPath, "not json", "utf8"),
    },
    {
      code: "RUNTIME_SOURCE_MISMATCH",
      mutate: async ({ receiptPath, receipt }) => writeFile(
        receiptPath,
        `${JSON.stringify({ ...receipt, manifestSha256: "0".repeat(64) })}\n`,
        "utf8",
      ),
    },
    {
      code: "RUNTIME_PLATFORM_MISMATCH",
      mutate: async ({ receiptPath, receipt }) => writeFile(
        receiptPath,
        `${JSON.stringify({ ...receipt, arch: receipt.arch === "x64" ? "arm64" : "x64" })}\n`,
        "utf8",
      ),
    },
    {
      code: "RUNTIME_DEPENDENCIES_INVALID",
      mutate: async ({ durableRoot }) => unlink(join(durableRoot, "node_modules", "zod", "package.json")),
    },
  ];

  for (const entry of cases) {
    const fixture = await createRuntimeFixture(t);
    await entry.mutate(fixture);
    await assert.rejects(
      resolveInstalledRuntime(
        pathToFileURL(join(fixture.managedRoot, "dist", "oneshot.js")).href,
        "dist/oneshot-main.js",
        { codexHome: fixture.codexHome },
      ),
      (error: unknown) => error instanceof RuntimeBootstrapError
        && error.code === entry.code
        && error.message === entry.code,
      entry.code,
    );
  }

  const fixture = await createRuntimeFixture(t);
  await assert.rejects(
    resolveInstalledRuntime(
      pathToFileURL(join(fixture.managedRoot, "dist", "oneshot.js")).href,
      "dist/oneshot-main.js",
      { codexHome: "relative-codex-home" },
    ),
    (error: unknown) => error instanceof RuntimeBootstrapError
      && error.code === "RUNTIME_PATH_INVALID",
  );
});

test("public bootstraps fail closed without loading the heavy runtime", async (t) => {
  const fixture = await createRuntimeFixture(t, { durable: false });
  const entry = pathToFileURL(join(fixture.managedRoot, "dist", "oneshot.js")).href;
  let stdout = "";
  let stderr = "";
  const io = {
    stdout(value: string) { stdout += value; },
    stderr(value: string) { stderr += value; },
  };

  const oneShotCode = await runOneShotBootstrap(entry, ["--response", join(fixture.codexHome, "absent.json")], {
    codexHome: fixture.codexHome,
  }, io);
  assert.equal(oneShotCode, 2);
  assert.equal(stdout, "");
  assert.equal(stderr, "RUNTIME_NOT_INSTALLED\n");

  stdout = "";
  stderr = "";
  const doctorCode = await runDoctorBootstrap(entry.replace("oneshot.js", "doctor.js"), ["--json"], {
    codexHome: fixture.codexHome,
  }, io);
  assert.equal(doctorCode, 1);
  const doctor = JSON.parse(stdout);
  assert.equal(doctor.code, "DOCTOR_REQUIRED_CHECK_FAILED");
  assert.equal(doctor.checks[0].code, "RUNTIME_NOT_INSTALLED");
  assert.equal(stderr, "");

  stdout = "";
  stderr = "";
  const mcpCode = await runMcpBootstrap(entry.replace("oneshot.js", "mcp.js"), {
    codexHome: fixture.codexHome,
  }, io);
  assert.equal(mcpCode, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "RUNTIME_NOT_INSTALLED\n");
});

test("MCP bootstrap preserves only the stable allowed-roots configuration code", async (t) => {
  const fixture = await createRuntimeFixture(t);
  let stderr = "";
  const code = await runMcpBootstrap(
    pathToFileURL(join(fixture.managedRoot, "dist", "mcp.js")).href,
    { codexHome: fixture.codexHome },
    { stdout() {}, stderr(value) { stderr += value; } },
  );
  assert.equal(code, 1);
  assert.equal(stderr, "INVALID_ALLOWED_ROOTS_CONFIGURATION\n");
});

async function createRuntimeFixture(
  t: { after(fn: () => Promise<void>): void },
  options: Readonly<{ durable?: boolean }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-bootstrap-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex-home");
  const managedRoot = join(
    codexHome,
    "plugins",
    "cache",
    MARKETPLACE,
    PRODUCT,
    PLUGIN_VERSION,
  );
  await mkdir(join(managedRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(managedRoot, "dist"), { recursive: true });
  const lockBytes = Buffer.from("{\"lockfileVersion\":3}\n", "utf8");
  const packageBytes = Buffer.from(`${JSON.stringify({
    name: PRODUCT,
    version: "0.2.3",
    type: "module",
    dependencies: { zod: "3.25.76" },
  })}\n`, "utf8");
  await writeFile(join(managedRoot, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: PRODUCT,
    version: PLUGIN_VERSION,
    skills: "./skills/",
  })}\n`, "utf8");
  await writeFile(join(managedRoot, "package.json"), packageBytes);
  await writeFile(join(managedRoot, "package-lock.json"), lockBytes);
  await writeFile(join(managedRoot, "dist", "oneshot.js"), "export {};\n", "utf8");
  const manifest = {
    schemaVersion: 1,
    productId: PRODUCT,
    pluginVersion: PLUGIN_VERSION,
    packageLockSha256: sha256(lockBytes),
    mainEntries: ["dist/doctor-main.js", "dist/mcp-main.js", "dist/oneshot-main.js"],
    files: [
      { path: "package-lock.json", size: lockBytes.byteLength, sha256: sha256(lockBytes) },
      { path: "package.json", size: packageBytes.byteLength, sha256: sha256(packageBytes) },
    ],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  await writeFile(join(managedRoot, "runtime-manifest.json"), manifestBytes);

  const durableRoot = join(
    codexHome,
    "plugin-runtime-data",
    PRODUCT,
    PLUGIN_VERSION,
    RUNTIME_KEY,
  );
  const receiptPath = join(durableRoot, "install-receipt.json");
  const receipt = {
    schemaVersion: 1,
    code: "RUNTIME_INSTALL_OK",
    productId: PRODUCT,
    pluginVersion: PLUGIN_VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    nodeVersion: process.versions.node,
    manifestSha256: sha256(manifestBytes),
    packageLockSha256: sha256(lockBytes),
    toolCount: 9,
    doctorCode: "DOCTOR_OK",
    dependencyCount: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
  } as const;
  if (options.durable !== false) {
    await mkdir(join(durableRoot, "dist"), { recursive: true });
    await mkdir(join(durableRoot, "node_modules", "zod"), { recursive: true });
    await writeFile(join(durableRoot, "dist", "oneshot-main.js"), "export const runOneShotEntry = async () => 0;\n", "utf8");
    await writeFile(
      join(durableRoot, "dist", "mcp-main.js"),
      "export async function runMcpServer(){const error=new Error('private');error.code='INVALID_ALLOWED_ROOTS_CONFIGURATION';throw error;}\n",
      "utf8",
    );
    await writeFile(join(durableRoot, "node_modules", "zod", "package.json"), "{}\n", "utf8");
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
  }
  return { codexHome, durableRoot, managedRoot, receipt, receiptPath };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
