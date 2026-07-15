import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
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
  parseCliArguments,
  parseNpmLsResult,
  resolveNpmInvocation,
  runCommand,
  verifyReadOnlyHwpTools,
  verifyCompactRuntime,
} from "../release-scripts/verify-compact-runtime.mjs";
import { resolveHwpFixture } from "../release-scripts/hwp-fixture.mjs";
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
const PINNED_MARKDOWN = `${"가나다라마바사아자차카타파하".repeat(7)}가나`;

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
  const diagnosticPath = join(tmpdir(), `private-timeout-${randomUUID()}.hwp`);
  const secret = `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${randomUUID()}`;
  await assert.rejects(
    runCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); setInterval(() => {}, 1_000)",
        diagnosticPath,
        secret,
      ],
      SOURCE_ROOT,
      { timeoutMs: 100 },
    ),
    (error: Error & { code?: string }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.equal(error.code, "COMMAND_TIMEOUT");
      assert.equal(rendered.includes(diagnosticPath), false);
      assert.equal(rendered.includes(secret), false);
      return true;
    },
  );
});

test("installed runtime child failures do not expose arguments or output", async () => {
  const diagnosticPath = join(tmpdir(), `private-failure-${randomUUID()}.hwp`);
  const stdoutSecret = `${["OPENAI", "API", "KEY"].join("_")}=${randomUUID()}`;
  const stderrSecret = `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${randomUUID()}`;

  await assert.rejects(
    runCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write(process.argv[2]); process.stderr.write(process.argv[3]); process.exit(17)",
        diagnosticPath,
        stdoutSecret,
        stderrSecret,
      ],
      SOURCE_ROOT,
    ),
    (error: Error & { code?: string; exitCode?: number }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.equal(error.code, "COMMAND_FAILED");
      assert.equal(error.exitCode, 17);
      for (const sentinel of [diagnosticPath, stdoutSecret, stderrSecret]) {
        assert.equal(rendered.includes(sentinel), false);
      }
      return true;
    },
  );
});

test("installed runtime child start failures do not expose executable paths", async () => {
  const executableSentinel = join(
    tmpdir(),
    `private-missing-executable-${randomUUID()}.exe`,
  );

  await assert.rejects(
    runCommand(executableSentinel, [], SOURCE_ROOT),
    (error: Error & { code?: string }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.equal(error.code, "COMMAND_START_FAILED");
      assert.equal(rendered.includes(executableSentinel), false);
      return true;
    },
  );
});

test("installed runtime allowFailure preserves raw diagnostic streams", async () => {
  const stdout = `stdout-${randomUUID()}`;
  const stderr = `stderr-${randomUUID()}`;
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exit(23)",
      stdout,
      stderr,
    ],
    SOURCE_ROOT,
    { allowFailure: true },
  );

  assert.deepEqual(result, { code: 23, stdout, stderr });
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
    (error: Error & { code?: string }) => error.code === "COMMAND_TIMEOUT",
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

test("npm-ls failures redact raw streams and dependency problem details", () => {
  const privatePath = join(tmpdir(), `private-npm-ls-${randomUUID()}`);
  const secret = `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${randomUUID()}`;
  for (const operation of [
    () => parseNpmLsResult({
      code: 1,
      stdout: JSON.stringify({ name: "gpt-codex-hwp" }),
      stderr: `${privatePath}\n${secret}`,
    }),
    () => parseNpmLsResult({
      code: 0,
      stdout: JSON.stringify({
        name: "gpt-codex-hwp",
        problems: [`invalid dependency at ${privatePath}`, secret],
      }),
      stderr: "",
    }),
  ]) {
    assert.throws(operation, (error: Error & { code?: string }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.match(error.code ?? "", /^NPM_LS_/u);
      assert.equal(rendered.includes(privatePath), false);
      assert.equal(rendered.includes(secret), false);
      return true;
    });
  }
});

test("npm-audit and MCP-stderr failures expose only sanitized evidence", async () => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const parseNpmAuditResult = Reflect.get(module, "parseNpmAuditResult") as
    | undefined
    | ((result: { code: number | null; stdout: string; stderr: string }) => Record<string, number>);
  const assertMcpStderr = Reflect.get(module, "assertMcpStderr") as
    | undefined
    | ((stderr: string) => void);
  assert.equal(typeof parseNpmAuditResult, "function");
  assert.equal(typeof assertMcpStderr, "function");

  const privatePath = join(tmpdir(), `private-audit-${randomUUID()}`);
  const secret = `${["OPENAI", "API", "KEY"].join("_")}=${randomUUID()}`;
  for (const operation of [
    () => parseNpmAuditResult!({
      code: 1,
      stdout: JSON.stringify({
        error: `${privatePath}: ${secret}`,
        metadata: { vulnerabilities: { total: 1 } },
      }),
      stderr: `${privatePath}\n${secret}`,
    }),
    () => assertMcpStderr!(`${privatePath}\n${secret}`),
  ]) {
    assert.throws(operation, (error: Error & { code?: string }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.match(error.code ?? "", /^(?:NPM_AUDIT|MCP_STDERR)/u);
      assert.equal(rendered.includes(privatePath), false);
      assert.equal(rendered.includes(secret), false);
      return true;
    });
  }
});

test("compact runtime CLI accepts only release mode or one diagnostic sample", () => {
  assert.deepEqual(parseCliArguments([]), { mode: "release" });
  assert.deepEqual(parseCliArguments(["--sample", "diagnostic.hwp"]), {
    mode: "diagnostic",
    sampleHwpPath: "diagnostic.hwp",
  });
  for (const invalid of [
    ["--sample"],
    ["--sample", ""],
    ["--unknown"],
    ["--sample", "a.hwp", "--sample", "b.hwp"],
    ["a.hwp"],
  ]) {
    assert.throws(
      () => parseCliArguments(invalid),
      (error: Error & { code?: string }) =>
        error.code === "COMPACT_RUNTIME_CLI_INVALID",
    );
  }
});

test("tool-smoke arguments bind file size and semantic oracle mode", async () => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const parseToolSmokeArguments = Reflect.get(module, "parseToolSmokeArguments") as
    | undefined
    | ((args: string[]) => {
      runtimeRoot: string;
      workRoot: string;
      sampleHwpPath: string;
      expectedSha256: string;
      expectedBytes: number;
      semanticMode: "tracked" | "diagnostic";
    });
  assert.equal(typeof parseToolSmokeArguments, "function");
  const digest = "a".repeat(64);
  assert.deepEqual(parseToolSmokeArguments!([
    "runtime",
    "work",
    "owned.hwp",
    digest,
    "8704",
    "tracked",
  ]), {
    runtimeRoot: "runtime",
    workRoot: "work",
    sampleHwpPath: "owned.hwp",
    expectedSha256: digest,
    expectedBytes: 8_704,
    semanticMode: "tracked",
  });
  assert.deepEqual(parseToolSmokeArguments!([
    "runtime",
    "work",
    "owned.hwp",
    digest,
    "42",
    "diagnostic",
  ]).semanticMode, "diagnostic");
  for (const invalid of [
    ["runtime", "work", "owned.hwp", digest, "0", "tracked"],
    ["runtime", "work", "owned.hwp", digest, "8704", "other"],
    ["runtime", "work", "owned.hwp", "not-a-digest", "8704", "tracked"],
  ]) {
    assert.throws(
      () => parseToolSmokeArguments!(invalid),
      (error: Error & { code?: string }) =>
        error.code === "COMPACT_TOOL_SMOKE_ARGUMENTS_INVALID",
    );
  }
});

test("plain compact runtime CLI rejects ambient diagnostic override without leaking it", () => {
  const rawEnvironmentValue = join(
    tmpdir(),
    `private-cli-fixture-${randomUUID()}.hwp`,
  );
  const script = join(SOURCE_ROOT, "release-scripts", "verify-compact-runtime.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, HWP_TEST_FIXTURE: rawEnvironmentValue },
    timeout: 10_000,
    windowsHide: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HWP_FIXTURE_OVERRIDE_FORBIDDEN/u);
  assert.equal(result.stderr.includes(rawEnvironmentValue), false);
});

test("read-only compact runtime HWP smokes verify the hash after every tool call", async () => {
  const expectedSha256 = "a".repeat(64);
  const calls: string[] = [];
  const statuses = await verifyReadOnlyHwpTools({
    sampleHwpPath: "diagnostic.hwp",
    expectedSha256,
    detectFormat: async () => {
      calls.push("detect");
      return pinnedDetectResult();
    },
    readDocument: async () => {
      calls.push("read");
      return pinnedReadResult();
    },
    readSha256: async () => {
      calls.push("hash");
      return expectedSha256;
    },
  });
  assert.deepEqual(calls, ["detect", "hash", "read", "hash"]);
  assert.deepEqual(statuses, {
    hwp_detect_format: "passed",
    hwp_read: "passed",
  });

  let readCalled = false;
  await assert.rejects(
    verifyReadOnlyHwpTools({
      sampleHwpPath: "diagnostic.hwp",
      expectedSha256,
      detectFormat: async () => pinnedDetectResult(),
      readDocument: async () => {
        readCalled = true;
        return pinnedReadResult();
      },
      readSha256: async () => "b".repeat(64),
    }),
    /changed after hwp_detect_format/iu,
  );
  assert.equal(readCalled, false);

  let failedResultHashes = 0;
  let failedResultReadCalled = false;
  await assert.rejects(
    verifyReadOnlyHwpTools({
      sampleHwpPath: "diagnostic.hwp",
      expectedSha256,
      detectFormat: async () => ({
        isError: true,
        structuredContent: { code: "DETECT_FAILED" },
      }),
      readDocument: async () => {
        failedResultReadCalled = true;
        return { isError: false, structuredContent: {} };
      },
      readSha256: async () => {
        failedResultHashes += 1;
        return "b".repeat(64);
      },
    }),
    /changed after hwp_detect_format/iu,
  );
  assert.equal(failedResultHashes, 1);
  assert.equal(failedResultReadCalled, false);

  let thrownMutationHashes = 0;
  await assert.rejects(
    verifyReadOnlyHwpTools({
      sampleHwpPath: "diagnostic.hwp",
      expectedSha256,
      detectFormat: async () => { throw new Error("detect operation threw"); },
      readDocument: async () => pinnedReadResult(),
      readSha256: async () => {
        thrownMutationHashes += 1;
        return "b".repeat(64);
      },
    }),
    /changed after hwp_detect_format/iu,
  );
  assert.equal(thrownMutationHashes, 1);

  const originalError = new Error("unchanged detect operation threw");
  let unchangedThrowHashes = 0;
  await assert.rejects(
    verifyReadOnlyHwpTools({
      sampleHwpPath: "diagnostic.hwp",
      expectedSha256,
      detectFormat: async () => { throw originalError; },
      readDocument: async () => pinnedReadResult(),
      readSha256: async () => {
        unchangedThrowHashes += 1;
        return expectedSha256;
      },
    }),
    (error) => error === originalError,
  );
  assert.equal(unchangedThrowHashes, 1);

  let readFailureHashCalls = 0;
  await assert.rejects(
    verifyReadOnlyHwpTools({
      sampleHwpPath: "diagnostic.hwp",
      expectedSha256,
      detectFormat: async () => pinnedDetectResult(),
      readDocument: async () => ({
        isError: true,
        structuredContent: { code: "READ_FAILED" },
      }),
      readSha256: async () => {
        readFailureHashCalls += 1;
        return readFailureHashCalls === 1 ? expectedSha256 : "b".repeat(64);
      },
    }),
    /changed after hwp_read/iu,
  );
  assert.equal(readFailureHashCalls, 2);
});

test("read-only compact runtime HWP smokes reject missing semantic evidence", async () => {
  const expectedSha256 = "a".repeat(64);
  for (const structuredContent of [undefined, {}, { format: "hwpx" }]) {
    let readCalled = false;
    await assert.rejects(
      verifyReadOnlyHwpTools({
        sampleHwpPath: "owned-copy.hwp",
        expectedSha256,
        detectFormat: async () => ({ isError: false, structuredContent }),
        readDocument: async () => {
          readCalled = true;
          return pinnedReadResult();
        },
        readSha256: async () => expectedSha256,
      }),
      (error: Error & { code?: string }) =>
        error.code === "COMPACT_HWP_SEMANTIC_MISMATCH",
    );
    assert.equal(readCalled, false);
  }

  for (const structuredContent of [undefined, {}, { markdown: "" }]) {
    await assert.rejects(
      verifyReadOnlyHwpTools({
        sampleHwpPath: "owned-copy.hwp",
        expectedSha256,
        detectFormat: async () => pinnedDetectResult(),
        readDocument: async () => ({ isError: false, structuredContent }),
        readSha256: async () => expectedSha256,
      }),
      (error: Error & { code?: string }) =>
        error.code === "COMPACT_HWP_SEMANTIC_MISMATCH",
    );
  }
});

test("read-only compact runtime HWP smokes accept general diagnostic evidence", async () => {
  const expectedSha256 = "a".repeat(64);
  const statuses = await verifyReadOnlyHwpTools({
    sampleHwpPath: "owned-diagnostic-copy.hwp",
    expectedSha256,
    expectedBytes: 42,
    expectedMarkdownEvidence: null,
    detectFormat: async () => ({
      isError: false,
      structuredContent: {
        format: "hwp",
        details: { container_format: "ole2", file_size_bytes: 42 },
      },
    }),
    readDocument: async () => ({
      isError: false,
      structuredContent: {
        markdown: "진단용 문서",
        metadata: { fileType: "hwp", version: "5.2", pageCount: 2 },
        warnings: [{ code: "DIAGNOSTIC", message: "diagnostic warning" }],
      },
    }),
    readSha256: async () => expectedSha256,
  });
  assert.deepEqual(statuses, {
    hwp_detect_format: "passed",
    hwp_read: "passed",
  });
});

test("read-only compact runtime tool failures do not expose structured content", async () => {
  const expectedSha256 = "a".repeat(64);
  const diagnosticPath = join(tmpdir(), `private-tool-${randomUUID()}.hwp`);
  const secret = `${["OPENAI", "API", "KEY"].join("_")}=${randomUUID()}`;

  await assert.rejects(
    verifyReadOnlyHwpTools({
      sampleHwpPath: diagnosticPath,
      expectedSha256,
      detectFormat: async () => ({
        isError: true,
        structuredContent: { diagnosticPath, secret },
      }),
      readDocument: async () => pinnedReadResult(),
      readSha256: async () => expectedSha256,
    }),
    (error: Error & { code?: string }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.equal(error.code, "TOOL_SMOKE_FAILED");
      assert.equal(rendered.includes(diagnosticPath), false);
      assert.equal(rendered.includes(secret), false);
      return true;
    },
  );
});

test("compact runtime tools receive an owned verified HWP copy", async (t) => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const copyVerifiedHwpFixture = Reflect.get(module, "copyVerifiedHwpFixture") as
    | undefined
    | ((options: {
      sourcePath: string;
      targetRoot: string;
      expectedSha256: string;
    }) => Promise<string>);
  assert.equal(typeof copyVerifiedHwpFixture, "function");

  const root = await mkdtemp(join(tmpdir(), "compact-owned-copy-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "public-source.hwp");
  const ownedRoot = join(root, "owned");
  const sourceBytes = Buffer.from("verified public HWP fixture bytes", "utf8");
  const expectedSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  await writeFile(sourcePath, sourceBytes);
  await mkdir(ownedRoot);

  const ownedPath = await copyVerifiedHwpFixture!({
    sourcePath,
    targetRoot: ownedRoot,
    expectedSha256,
  });

  assert.notEqual(ownedPath, sourcePath);
  assert.equal(dirname(ownedPath), ownedRoot);
  assert.match(ownedPath, /\.hwp$/iu);
  assert.equal(
    createHash("sha256").update(await readFile(ownedPath)).digest("hex"),
    expectedSha256,
  );
  await writeFile(ownedPath, "mutated owned copy");
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
});

test("owned HWP copy uses one bounded source handle and fsyncs exact bytes", async () => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const copyVerifiedHwpFixture = Reflect.get(module, "copyVerifiedHwpFixture") as
    | undefined
    | ((options: Record<string, unknown>) => Promise<string>);
  assert.equal(typeof copyVerifiedHwpFixture, "function");

  const sourcePath = join(tmpdir(), `private-source-${randomUUID()}.hwp`);
  const targetRoot = join(tmpdir(), `owned-target-${randomUUID()}`);
  const sourceBytes = Buffer.alloc(1024 * 1024 + 17, 0x5a);
  const copiedBytes = Buffer.alloc(sourceBytes.byteLength);
  const expectedSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const stableStatus = {
    dev: 7,
    ino: 11,
    size: sourceBytes.byteLength,
    mtimeMs: 101,
    ctimeMs: 202,
    isFile: () => true,
  };
  const openCalls: Array<[string, string]> = [];
  const readLengths: number[] = [];
  let sourceStatCalls = 0;
  let sourceCloseCalls = 0;
  let destinationCloseCalls = 0;
  let syncCalls = 0;
  const postHashPaths: string[] = [];

  const sourceHandle = {
    stat: async () => {
      sourceStatCalls += 1;
      return { ...stableStatus };
    },
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      readLengths.push(length);
      const bytesRead = Math.min(length, sourceBytes.byteLength - position);
      sourceBytes.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    },
    close: async () => { sourceCloseCalls += 1; },
  };
  const destinationHandle = {
    write: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesWritten = Math.min(length, 131_071);
      buffer.copy(copiedBytes, position, offset, offset + bytesWritten);
      return { bytesWritten, buffer };
    },
    sync: async () => { syncCalls += 1; },
    close: async () => { destinationCloseCalls += 1; },
  };

  const ownedPath = await copyVerifiedHwpFixture!({
    sourcePath,
    targetRoot,
    expectedSha256,
    openFile: async (path: string, flags: string) => {
      openCalls.push([path, flags]);
      return flags === "r" ? sourceHandle : destinationHandle;
    },
    readSha256: async (path: string) => {
      postHashPaths.push(path);
      return expectedSha256;
    },
  });

  assert.equal(ownedPath, join(targetRoot, "verified-source-copy.hwp"));
  assert.deepEqual(openCalls, [
    [sourcePath, "r"],
    [ownedPath, "wx"],
  ]);
  assert.equal(sourceStatCalls, 2);
  assert.ok(readLengths.length >= 2);
  assert.ok(readLengths.every((length) => length > 0 && length <= 1024 * 1024));
  assert.deepEqual(copiedBytes, sourceBytes);
  assert.equal(syncCalls, 1);
  assert.equal(sourceCloseCalls, 1);
  assert.equal(destinationCloseCalls, 1);
  assert.deepEqual(postHashPaths, [ownedPath, sourcePath]);
});

test("owned HWP copy rejects changed sources and sanitizes filesystem failures", async () => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const copyVerifiedHwpFixture = Reflect.get(module, "copyVerifiedHwpFixture") as
    | undefined
    | ((options: Record<string, unknown>) => Promise<string>);
  assert.equal(typeof copyVerifiedHwpFixture, "function");

  const sourcePath = join(tmpdir(), `private-copy-${randomUUID()}.hwp`);
  const targetRoot = join(tmpdir(), `owned-copy-${randomUUID()}`);
  const secret = `${["OPENAI", "API", "KEY"].join("_")}=${randomUUID()}`;
  await assert.rejects(
    copyVerifiedHwpFixture!({
      sourcePath,
      targetRoot,
      expectedSha256: "a".repeat(64),
      openFile: async () => {
        throw new Error(`${sourcePath}: ${secret}`);
      },
      readSha256: async () => "a".repeat(64),
    }),
    (error: Error & { code?: string }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.equal(error.code, "HWP_FIXTURE_COPY_FAILED");
      assert.equal(rendered.includes(sourcePath), false);
      assert.equal(rendered.includes(secret), false);
      return true;
    },
  );
});

test("owned HWP copy post-hashes the source even when destination verification fails", async (t) => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const copyVerifiedHwpFixture = Reflect.get(module, "copyVerifiedHwpFixture") as
    | undefined
    | ((options: Record<string, unknown>) => Promise<string>);
  assert.equal(typeof copyVerifiedHwpFixture, "function");

  const root = await mkdtemp(join(tmpdir(), "compact-copy-posthash-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const targetRoot = join(root, "owned");
  const sourcePath = join(root, "source.hwp");
  const sourceBytes = Buffer.from("source post-hash evidence", "utf8");
  const expectedSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  await mkdir(targetRoot);
  await writeFile(sourcePath, sourceBytes);
  const ownedPath = join(targetRoot, "verified-source-copy.hwp");
  const postHashPaths: string[] = [];

  await assert.rejects(
    copyVerifiedHwpFixture!({
      sourcePath,
      targetRoot,
      expectedSha256,
      readSha256: async (path: string) => {
        postHashPaths.push(path);
        return path === sourcePath ? expectedSha256 : "b".repeat(64);
      },
    }),
    (error: Error & { code?: string }) =>
      error.code === "HWP_FIXTURE_COPY_FAILED",
  );
  assert.deepEqual(postHashPaths, [ownedPath, sourcePath]);
});

test("MCP read-only smoke calls the advertised routes and rejects empty routing", async () => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const verifyMcpReadOnlyHwpTools = Reflect.get(module, "verifyMcpReadOnlyHwpTools") as
    | undefined
    | ((options: Record<string, unknown>) => Promise<Record<string, string>>);
  assert.equal(typeof verifyMcpReadOnlyHwpTools, "function");

  const expectedSha256 = "a".repeat(64);
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const statuses = await verifyMcpReadOnlyHwpTools!({
    client: {
      callTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
        calls.push(request);
        return request.name === "hwp_detect_format"
          ? pinnedDetectResult()
          : pinnedReadResult();
      },
    },
    sampleHwpPath: "owned-copy.hwp",
    expectedSha256,
    expectedBytes: 8_704,
    semanticMode: "tracked",
    readSha256: async () => expectedSha256,
  });
  assert.deepEqual(statuses, {
    hwp_detect_format: "passed",
    hwp_read: "passed",
  });
  assert.deepEqual(calls, [
    { name: "hwp_detect_format", arguments: { file_path: "owned-copy.hwp" } },
    { name: "hwp_read", arguments: { file_path: "owned-copy.hwp" } },
  ]);

  for (const emptyRoute of ["hwp_detect_format", "hwp_read"] as const) {
    await assert.rejects(
      verifyMcpReadOnlyHwpTools!({
        client: {
          callTool: async (request: { name: string }) => {
            if (request.name === emptyRoute) {
              return { isError: false, structuredContent: {} };
            }
            return request.name === "hwp_detect_format"
              ? pinnedDetectResult()
              : pinnedReadResult();
          },
        },
        sampleHwpPath: "owned-copy.hwp",
        expectedSha256,
        expectedBytes: 8_704,
        semanticMode: "tracked",
        readSha256: async () => expectedSha256,
      }),
      (error: Error & { code?: string }) =>
        error.code === "COMPACT_HWP_SEMANTIC_MISMATCH",
    );
  }

  await assert.rejects(
    verifyMcpReadOnlyHwpTools!({
      client: { callTool: async () => undefined },
      sampleHwpPath: "owned-copy.hwp",
      expectedSha256,
      expectedBytes: 8_704,
      semanticMode: "tracked",
      readSha256: async () => expectedSha256,
    }),
    (error: Error & { code?: string }) => error.code === "TOOL_SMOKE_FAILED",
  );

  const privatePath = join(tmpdir(), `private-mcp-call-${randomUUID()}.hwp`);
  const secret = `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${randomUUID()}`;
  await assert.rejects(
    verifyMcpReadOnlyHwpTools!({
      client: {
        callTool: async () => { throw new Error(`${privatePath}: ${secret}`); },
      },
      sampleHwpPath: privatePath,
      expectedSha256,
      expectedBytes: 8_704,
      semanticMode: "tracked",
      readSha256: async () => expectedSha256,
    }),
    (error: Error & { code?: string }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.equal(error.code, "MCP_TOOL_CALL_FAILED");
      assert.equal(rendered.includes(privatePath), false);
      assert.equal(rendered.includes(secret), false);
      return true;
    },
  );
});

test("classic HWP preview smoke uses the actual isolated runtime route", async (t) => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const verifyClassicHwpPreview = Reflect.get(module, "verifyClassicHwpPreview") as
    | undefined
    | ((options: {
      sampleHwpPath: string;
      expectedSha256: string;
      outputSvgPath: string;
      renderPreview: (input: { file_path: string; output_svg_path: string }) => Promise<unknown>;
      readSha256: (path: string) => Promise<string>;
    }) => Promise<Record<string, unknown>>);
  assert.equal(typeof verifyClassicHwpPreview, "function");

  const root = await mkdtemp(join(tmpdir(), "compact-rhwp-preview-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sampleHwpPath = join(root, "owned-copy.hwp");
  const outputSvgPath = join(root, "classic-preview.svg");
  const sampleBytes = Buffer.from("classic HWP bytes", "utf8");
  const expectedSha256 = createHash("sha256").update(sampleBytes).digest("hex");
  const calls: string[] = [];
  await writeFile(sampleHwpPath, sampleBytes);

  const evidence = await verifyClassicHwpPreview!({
    sampleHwpPath,
    expectedSha256,
    outputSvgPath,
    renderPreview: async (...args) => {
      assert.equal(args.length, 1);
      const [input] = args;
      calls.push("preview");
      assert.equal(input.file_path, sampleHwpPath);
      assert.equal(input.output_svg_path, outputSvgPath);
      await writeFile(outputSvgPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      return {
        isError: false,
        structuredContent: { backend: "rhwp", page_count: 1 },
      };
    },
    readSha256: async (path) => {
      calls.push("hash");
      return createHash("sha256").update(await readFile(path)).digest("hex");
    },
  });

  assert.equal(evidence.backend, "rhwp");
  assert.deepEqual(calls, ["preview", "hash"]);
  assert.match(await readFile(outputSvgPath, "utf8"), /^\s*<svg\b/iu);
});

test("classic HWP preview smoke rejects non-rhwp or non-SVG evidence", async (t) => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const verifyClassicHwpPreview = Reflect.get(module, "verifyClassicHwpPreview") as
    | undefined
    | ((options: Record<string, unknown>) => Promise<Record<string, unknown>>);
  assert.equal(typeof verifyClassicHwpPreview, "function");

  const root = await mkdtemp(join(tmpdir(), "compact-rhwp-reject-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sampleHwpPath = join(root, "owned-copy.hwp");
  const outputSvgPath = join(root, "classic-preview.svg");
  const expectedSha256 = createHash("sha256").update("unchanged").digest("hex");
  await writeFile(sampleHwpPath, "unchanged");

  for (const scenario of [
    { backend: "kordoc", output: "<svg/>" },
    { backend: "rhwp", output: "not an SVG" },
  ]) {
    await assert.rejects(
      verifyClassicHwpPreview!({
        sampleHwpPath,
        expectedSha256,
        outputSvgPath,
        renderPreview: async () => {
          await writeFile(outputSvgPath, scenario.output);
          return {
            isError: false,
            structuredContent: { backend: scenario.backend },
          };
        },
        readSha256: async () => expectedSha256,
      }),
      (error: Error & { code?: string }) =>
        error.code === "COMPACT_HWP_RHWP_PREVIEW_MISMATCH",
    );
  }
});

test("compact integrity hashing rejects a fixture above 512 MiB without exposing its path", async (t) => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const sha256File = Reflect.get(module, "sha256File") as
    | undefined
    | ((path: string) => Promise<string>);
  assert.equal(typeof sha256File, "function");

  const root = await mkdtemp(join(tmpdir(), "compact-hash-limit-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const oversizedPath = join(root, `private-${randomUUID()}.hwp`);
  await writeFile(oversizedPath, "x");
  await truncate(oversizedPath, 512 * 1024 * 1024 + 1);

  await assert.rejects(
    sha256File!(oversizedPath),
    (error: Error & { code?: string }) => {
      const rendered = `${error.message}\n${error.stack ?? ""}`;
      assert.equal(error.code, "HWP_INTEGRITY_CHECK_FAILED");
      assert.equal(rendered.includes(oversizedPath), false);
      return true;
    },
  );
});

test("compact cleanup verifies owned and source HWP bytes even after a failed smoke", async () => {
  const module = await import("../release-scripts/verify-compact-runtime.mjs");
  const finalizeFixtureWorkspace = Reflect.get(module, "finalizeFixtureWorkspace") as
    | undefined
    | ((options: {
      ownedSample: string;
      sourcePath: string;
      expectedSha256: string;
      temporaryRoot: string;
      readSha256: (path: string) => Promise<string>;
      removeTree: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
    }) => Promise<void>);
  assert.equal(typeof finalizeFixtureWorkspace, "function");

  const calls: string[] = [];
  const expectedSha256 = "a".repeat(64);
  await assert.rejects(
    finalizeFixtureWorkspace!({
      ownedSample: "owned-copy.hwp",
      sourcePath: "public-source.hwp",
      expectedSha256,
      temporaryRoot: "owned-root",
      readSha256: async (path) => {
        calls.push(`hash:${path}`);
        return path === "owned-copy.hwp" ? "b".repeat(64) : expectedSha256;
      },
      removeTree: async (path, options) => {
        calls.push(`remove:${path}:${options.recursive}:${options.force}`);
      },
    }),
    /changed after compact-runtime verification/iu,
  );
  assert.deepEqual(calls, [
    "hash:owned-copy.hwp",
    "hash:public-source.hwp",
    "remove:owned-root:true:true",
  ]);
});

test("missing sample cleanup creates no compact temp residue", { timeout: 10_000 }, async () => {
  const before = await compactTemporaryDirectories();

  const missingSample = join(tmpdir(), `missing-hwp-${randomUUID()}.hwp`);
  await assert.rejects(
    verifyCompactRuntime({ sourceRoot: REPOSITORY_ROOT, sampleHwpPath: missingSample }),
    (error: Error & { code?: string }) => error.code === "HWP_FIXTURE_NOT_FOUND",
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

test("installed runtime verifies provenance, npm ls, and all nine tools", { timeout: 900_000 }, async (t) => {
  const fixture = await resolveHwpFixture({ requireTracked: true });
  if (!npmIsAvailable()) {
    t.skip("npm is unavailable.");
    return;
  }

  const sampleBefore = createHash("sha256").update(await readFile(fixture.path)).digest("hex");
  const report = await verifyCompactRuntime({ sourceRoot: REPOSITORY_ROOT });
  assert.equal(report.serverVersion, "0.1.4");
  assert.deepEqual(report.toolNames, TOOL_NAMES);
  assert.deepEqual(Object.keys(report.toolSmokes), TOOL_NAMES);
  assert.ok(Object.values(report.toolSmokes).every((status) => status === "passed"));
  assert.deepEqual(report.mcpReadOnlySmokes, {
    hwp_detect_format: "passed",
    hwp_read: "passed",
  });
  assert.equal(report.audit.total, 0);
  assert.equal(report.stderrBytes, 0);
  assert.equal(report.provenance.status, "passed");
  assert.equal(report.npmLs.status, "passed");
  assert.equal(report.sourceSha256, sampleBefore);
  assert.equal(
    createHash("sha256").update(await readFile(fixture.path)).digest("hex"),
    sampleBefore,
  );
  assert.equal(report.cleanup, true);
});

function pinnedDetectResult() {
  return {
    isError: false,
    structuredContent: {
      format: "hwp",
      details: {
        file_path: "owned-copy.hwp",
        container_format: "ole2",
        file_size_bytes: 8_704,
      },
    },
  };
}

function pinnedReadResult() {
  return {
    isError: false,
    structuredContent: {
      markdown: PINNED_MARKDOWN,
      metadata: { fileType: "hwp", version: "5.x", pageCount: 1 },
      warnings: [],
      assets: [],
    },
  };
}

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
