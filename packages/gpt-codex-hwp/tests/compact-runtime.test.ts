import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  EXCLUDED_PACKAGES,
  assertCompactBudgets,
  isExcludedPackagePath,
  summarizeInstalledEntries,
} from "../release-scripts/compact-policy.mjs";
import {
  isAllowedKordocLink,
  parseNpmLsResult,
  resolveNpmInvocation,
  runCommand,
  verifyCompactRuntime,
} from "../release-scripts/verify-compact-runtime.mjs";
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(SOURCE_ROOT, "../..");
const COMPACT_TEMP_PREFIX = "gpt-codex-hwp-compact-";
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

test("obsolete public-source references are absent from split release suites", async () => {
  const splitSuites = [
    "kordoc-core-runtime.test.ts",
    "runtime-projection.test.ts",
    "public-runtime-privacy.test.ts",
    "release-metadata.test.ts",
  ];
  for (const suite of splitSuites) {
    await access(join(SOURCE_ROOT, "tests", suite));
  }

  const forbiddenLiterals = [
    ["build-", "distribution.mjs"].join(""),
    ["release", "<version>", "hwp-korean-docs"].join("/"),
    ["skills", "hwp-korean-docs"].join("/"),
    ["C:", "Work", "boring"].join("\\"),
    ["findAncestor", "Fixture"].join(""),
  ];
  const sourceFiles = await collectSourceFiles([
    join(REPOSITORY_ROOT, "scripts"),
    join(REPOSITORY_ROOT, "tests"),
    join(SOURCE_ROOT, "release-scripts"),
    join(SOURCE_ROOT, "scripts"),
    join(SOURCE_ROOT, "tests"),
  ]);

  for (const sourceFile of sourceFiles) {
    const content = await readFile(sourceFile, "utf8");
    for (const forbidden of forbiddenLiterals) {
      assert.equal(content.includes(forbidden), false, `${sourceFile} contains ${forbidden}`);
    }
  }

  const portableTestContracts = [
    {
      path: "mcp-smoke.test.ts",
      forbidden: [["process", ".cwd()"].join("")],
    },
    {
      path: "assets.test.ts",
      forbidden: [["resolve(\"scripts", "hwpx-safe-edit"].join("/")],
    },
    {
      path: "hwp-plugin.test.ts",
      forbidden: [
        ["resolve(\"", "tmp\")"].join(""),
        ["resolve(\"tests", "fixtures"].join("/"),
      ],
    },
    {
      path: "rhwp-backend.test.ts",
      forbidden: [["resolve(\"", "tmp\""].join("")],
    },
  ];
  for (const contract of portableTestContracts) {
    const content = await readFile(join(SOURCE_ROOT, "tests", contract.path), "utf8");
    for (const forbidden of contract.forbidden) {
      assert.equal(content.includes(forbidden), false, `${contract.path} contains ${forbidden}`);
    }
  }

  const sourcePackage = JSON.parse(await readFile(join(SOURCE_ROOT, "package.json"), "utf8"));
  const rootPackage = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"));
  assert.equal(sourcePackage.scripts["test:python"], "python -m unittest scripts.hwpx-safe-edit.test_hwpx_safe_edit");
  assert.equal(rootPackage.scripts["test:repository"], "node --test tests/*.test.mjs");
  assert.equal(rootPackage.scripts["test:source"], "npm --prefix packages/gpt-codex-hwp test");
  assert.equal(rootPackage.scripts.test, "npm run test:repository && npm run test:source");
  assert.equal(rootPackage.scripts["test:python"], "npm --prefix packages/gpt-codex-hwp run test:python");
});

test("compact runtime package exclusions handle scoped and ordinary paths", () => {
  assert.equal(Object.isFrozen(EXCLUDED_PACKAGES), true);
  const excludedPaths = [
    "node_modules/pdfjs-dist/package.json",
    "node_modules/a/node_modules/pdfjs-dist/package.json",
    "node_modules/a/node_modules/@huggingface/transformers/package.json",
    "C:\\runtime\\node_modules\\PDFJS-DIST\\package.json",
  ];
  for (const path of excludedPaths) {
    assert.equal(isExcludedPackagePath(path), true, `${path} must be excluded`);
  }

  const allowedLookalikes = [
    "node_modules/pdfjs-dist-extra/package.json",
    "node_modules/@huggingface/transformers-old/package.json",
    "node_modules/@huggingface-transformers/package.json",
    "not-node_modules/pdfjs-dist/package.json",
  ];
  for (const path of allowedLookalikes) {
    assert.equal(isExcludedPackagePath(path), false, `${path} must remain allowed`);
  }
});

test("compact runtime budgets accept exact limits and reject one byte above", () => {
  assert.doesNotThrow(() => assertCompactBudgets({
    nodeModulesBytes: 64 * 1024 * 1024,
    installedBytes: 80 * 1024 * 1024,
    publicRuntimeBytes: 16 * 1024 * 1024,
  }));
  assert.throws(() => assertCompactBudgets({
    nodeModulesBytes: 64 * 1024 * 1024 + 1,
    installedBytes: 80 * 1024 * 1024,
    publicRuntimeBytes: 16 * 1024 * 1024,
  }), /node_modules budget/iu);
});

test("compact runtime anchors Kordoc links to the canonical local vendor target", () => {
  const expectedTarget = "C:\\runtime\\vendor\\kordoc-core";
  assert.equal(isAllowedKordocLink({
    linkPath: "node_modules/kordoc",
    canonicalTarget: "c:\\RUNTIME\\vendor\\kordoc-core",
    canonicalExpectedTarget: expectedTarget,
    platform: "win32",
  }), true);
  assert.equal(isAllowedKordocLink({
    linkPath: "node_modules/kordoc",
    canonicalTarget: "C:\\external\\runtime\\vendor\\kordoc-core",
    canonicalExpectedTarget: expectedTarget,
    platform: "win32",
  }), false);
  assert.equal(isAllowedKordocLink({
    linkPath: "node_modules/kordoc",
    canonicalTarget: "/Runtime/vendor/kordoc-core",
    canonicalExpectedTarget: "/runtime/vendor/kordoc-core",
    platform: "linux",
  }), false);
  assert.equal(isAllowedKordocLink({
    linkPath: "node_modules/kordoc",
    canonicalTarget: "/runtime/vendor\\kordoc-core",
    canonicalExpectedTarget: "/runtime/vendor/kordoc-core",
    platform: "linux",
  }), false);
});

test("compact runtime summarizes regular files, links, and exact exclusion evidence", () => {
  assert.deepEqual(summarizeInstalledEntries({
    filePaths: [
      "node_modules/pdfjs-dist/package.json",
      "node_modules/allowed/index.js",
    ],
    linkPaths: ["node_modules/boolean"],
  }), {
    installedFileCount: 2,
    installedLinkCount: 1,
    installedEntryCount: 3,
    excludedPaths: [
      "node_modules/pdfjs-dist/package.json",
      "node_modules/boolean",
    ],
    excludedPackages: {
      "@huggingface/transformers": false,
      "onnxruntime-node": false,
      "onnxruntime-web": false,
      "@hyzyla/pdfium": false,
      "pdfjs-dist": true,
      "boolean": true,
    },
  });
});

test("installed runtime npm invocation resolver is injectable without environment mutation", () => {
  assert.deepEqual(resolveNpmInvocation(["ci", "--omit=dev"], {
    npmExecPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
  }), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: [
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "ci",
      "--omit=dev",
    ],
  });
  assert.deepEqual(resolveNpmInvocation(["ls", "--json"], {
    npmExecPath: undefined,
    platform: "win32",
  }), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", "ls", "--json"],
  });
  assert.deepEqual(resolveNpmInvocation(["audit", "--json"], {
    npmExecPath: undefined,
    platform: "linux",
  }), {
    command: "npm",
    args: ["audit", "--json"],
  });
});

test("installed runtime child timeout terminates the subprocess", { timeout: 5_000 }, async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      SOURCE_ROOT,
      { timeoutMs: 100 },
    ),
    /timed out/iu,
  );
});

test("POSIX descendant timeout kills a SIGTERM-resistant process group", { timeout: 5_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group signaling is not available on Windows.");
    return;
  }

  const sentinel = join(tmpdir(), `compact-timeout-sentinel-${randomUUID()}`);
  t.after(async () => rm(sentinel, { force: true }));
  const descendantSource = `
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    setTimeout(() => writeFileSync(process.argv[1], "survived"), 700);
    setTimeout(() => process.exit(0), 800);
  `;
  const leaderSource = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}, process.argv[1]], {
      stdio: "ignore",
    });
    descendant.unref();
    setInterval(() => {}, 1_000);
  `;

  await assert.rejects(
    runCommand(process.execPath, ["-e", leaderSource, sentinel], SOURCE_ROOT, { timeoutMs: 250 }),
    /timed out/iu,
  );
  await delay(700);
  await assert.rejects(access(sentinel), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("npm-ls parser fails closed for invalid results", () => {
  assert.deepEqual(parseNpmLsResult({
    code: 0,
    stdout: '{"name":"gpt-codex-hwp","version":"0.1.4"}',
    stderr: "",
  }), { status: "passed", problems: [] });
  assert.throws(() => parseNpmLsResult({
    code: 1,
    stdout: '{"name":"gpt-codex-hwp"}',
    stderr: "invalid tree",
  }), /npm ls.*nonzero|invalid tree/iu);
  assert.throws(() => parseNpmLsResult({
    code: 0,
    stdout: '{"name":"gpt-codex-hwp","problems":["invalid: dependency"]}',
    stderr: "",
  }), /dependency problems|invalid: dependency/iu);
  assert.throws(() => parseNpmLsResult({ code: 0, stdout: "{", stderr: "" }), /JSON/iu);
  assert.throws(() => parseNpmLsResult({ code: 0, stdout: "  ", stderr: "" }), /empty/iu);
  assert.throws(() => parseNpmLsResult({ code: 0, stdout: "{}", stderr: "" }), /empty/iu);
});

test("missing sample cleanup creates no compact temp residue", { timeout: 10_000 }, async () => {
  const before = await compactTemporaryDirectories();

  const missingSample = join(tmpdir(), `missing-hwp-${randomUUID()}.hwp`);
  await assert.rejects(
    verifyCompactRuntime({ sourceRoot: SOURCE_ROOT, sampleHwpPath: missingSample }),
    /ENOENT|no such file/iu,
  );
  assert.deepEqual(await compactTemporaryDirectories(), before);
});

test("installed runtime gate is serialized in normal npm test", async () => {
  const packageJson = JSON.parse(await readFile(join(SOURCE_ROOT, "package.json"), "utf8"));
  assert.match(packageJson.scripts.test, /--test-concurrency=1/u);
  assert.doesNotMatch(packageJson.scripts.test, /verify:compact-runtime/u);
});

test("installed runtime skill metadata omits the HML claim", async () => {
  const skill = await readFile(join(SOURCE_ROOT, "skills", "gpt-codex-hwp", "SKILL.md"), "utf8");
  const frontmatter = skill.split("---", 3)[1] ?? "";
  assert.doesNotMatch(frontmatter, /\.hml\b/iu);
});

test("installed runtime verifies provenance, npm ls, and all nine tools", { timeout: 300_000 }, async (t) => {
  const configuredFixture = process.env.HWP_TEST_FIXTURE?.trim();
  if (!configuredFixture) {
    t.skip("Optional real-HWP compact-runtime smoke skipped: set HWP_TEST_FIXTURE to an explicit diagnostic fixture.");
    return;
  }
  const sampleHwpPath = resolve(configuredFixture);
  if (!npmIsAvailable()) {
    t.skip("npm is unavailable.");
    return;
  }

  const sampleBefore = createHash("sha256").update(await readFile(sampleHwpPath)).digest("hex");
  const report = await verifyCompactRuntime({ sourceRoot: SOURCE_ROOT, sampleHwpPath });
  assert.equal(report.serverVersion, "0.1.4");
  assert.deepEqual(report.toolNames, TOOL_NAMES);
  assert.deepEqual(Object.keys(report.toolSmokes), TOOL_NAMES);
  assert.ok(Object.values(report.toolSmokes).every((status) => status === "passed"));
  assert.equal(report.audit.total, 0);
  assert.equal(report.stderrBytes, 0);
  assert.equal(report.provenance.status, "passed");
  assert.equal(report.npmLs.status, "passed");
  assert.equal(report.sourceSha256, sampleBefore);
  assert.equal(
    createHash("sha256").update(await readFile(sampleHwpPath)).digest("hex"),
    sampleBefore,
  );
  assert.equal(report.cleanup, true);
});

async function compactTemporaryDirectories(): Promise<string[]> {
  return (await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(COMPACT_TEMP_PREFIX))
    .map((entry) => entry.name)
    .sort();
}

async function collectSourceFiles(roots: string[]): Promise<string[]> {
  const output: string[] = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        output.push(...await collectSourceFiles([path]));
      } else if (entry.isFile() && /\.(?:js|mjs|py|ts)$/iu.test(entry.name)) {
        output.push(path);
      }
    }
  }
  return output.sort();
}

function npmIsAvailable(): boolean {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", "--version"]
    : ["--version"];
  const result = spawnSync(command, args, {
    stdio: "ignore",
    timeout: 10_000,
    windowsHide: true,
  });
  return result.error === undefined && result.status === 0;
}
