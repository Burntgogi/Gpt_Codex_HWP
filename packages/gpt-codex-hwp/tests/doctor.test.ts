import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCTOR_SCHEMA_VERSION,
  doctorMain,
  redactDiagnosticText,
  runDoctor,
  type BoundedCommandSpec,
  type DoctorDependencies,
} from "../src/doctor.js";

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
] as const;

test("doctor contract reports safe required and optional capability results", async () => {
  const { dependencies, commands, reads } = passingDependencies();
  const report = await runDoctor(dependencies);

  assert.equal(report.schemaVersion, DOCTOR_SCHEMA_VERSION);
  assert.equal(report.code, "DOCTOR_OK");
  assert.equal(report.ok, true);
  assert.equal(report.required.failed, 0);
  assert.equal(report.optional.unavailable, 0);
  assert.equal(report.checks.find((check) => check.code === "MCP_TOOL_COUNT_OK")?.count, 9);
  assert.equal(report.checks.find((check) => check.code === "NODE_RUNTIME_OK")?.version, "22.20.1");

  assert.deepEqual(commands.map(({ command, args }) => [command, args]), [
    ["node", ["npm-cli.js", "--version"]],
    ["python", ["--version"]],
    ["node", ["npm-cli.js", "ls", "--omit=dev", "--json", "--depth=0"]],
  ]);
  for (const command of commands) {
    assert.equal(command.shell, false);
    assert.equal(command.windowsHide, true);
    assert.ok(command.timeoutMs > 0 && command.timeoutMs <= 10_000);
    assert.ok(command.maxOutputBytes > 0 && command.maxOutputBytes <= 64 * 1024);
    assert.equal(command.cwdCode, "RUNTIME_ROOT");
  }
  assert.deepEqual([...new Set(reads)].sort(), [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "node_modules/@rhwp/core/package.json",
    "package.json",
    "tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp",
    "tests/fixtures/rhwp/provenance.json",
    "vendor/kordoc-core/PROVENANCE.json",
    "vendor/kordoc-core/dist/index.js",
    "vendor/kordoc-core/package.json",
  ].sort());
  assert.equal(reads.some((path) => /(?:^|\/)(?:user|document|form)(?:\/|$)/iu.test(path)), false);
});

test("doctor contract treats a missing Python runtime as an optional capability", async () => {
  const fixture = passingDependencies();
  fixture.dependencies.runCommand = async (specification) => specification.command === "python"
    ? {
      code: null,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: "",
      stderr: "unavailable",
    }
    : fixture.runCommand(specification);

  const report = await runDoctor(fixture.dependencies);
  assert.equal(report.ok, true);
  assert.equal(report.code, "DOCTOR_OK");
  assert.equal(report.required.failed, 0);
  assert.equal(report.optional.unavailable, 1);
  assert.ok(report.checks.some((check) => check.code === "PYTHON_UNAVAILABLE" && !check.required));
});

test("doctor contract treats Python older than 3.10 as optional unavailable", async () => {
  const fixture = passingDependencies();
  fixture.dependencies.runCommand = async (specification) => specification.command === "python"
    ? {
      code: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: "Python 3.9.19",
      stderr: "",
    }
    : fixture.runCommand(specification);

  const report = await runDoctor(fixture.dependencies);
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.code === "PYTHON_UNAVAILABLE" && !check.required));
});

test("doctor contract keeps optional capabilities separate from required failures", async () => {
  const fixture = passingDependencies();
  fixture.dependencies.readJson = async (path) => {
    if (["node_modules/@rhwp/core/package.json", "tests/fixtures/rhwp/provenance.json"].includes(path)) {
      throw Object.assign(new Error("missing optional capability"), { code: "ENOENT" });
    }
    return fixture.readJson(path);
  };

  const report = await runDoctor(fixture.dependencies);
  assert.equal(report.ok, true);
  assert.equal(report.code, "DOCTOR_OK");
  assert.equal(report.required.failed, 0);
  assert.equal(report.optional.unavailable, 2);
  assert.ok(report.checks.some((check) => check.code === "RHWP_UNAVAILABLE" && !check.required));
  assert.ok(report.checks.some((check) => check.code === "PINNED_HWP_FIXTURE_UNAVAILABLE" && !check.required));
});

test("doctor contract maps hostile probe output to stable codes without leaking it", async () => {
  const fixture = passingDependencies();
  const fragments = ["AWS_SECRET", "_ACCESS_KEY=", "leaked-value"];
  const privateWindowsPath = ["C:", "\\", "Users", "\\", "private-person", "\\", "Documents", "\\", "private.hwp"].join("");
  const privatePosixPath = ["/", "Users", "/", "private-person"].join("");
  fixture.dependencies.runCommand = async (specification) => {
    if (specification.args.includes("ls")) {
      return {
        code: 1,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout: privateWindowsPath,
        stderr: fragments.join("") + " private-person form-value",
      };
    }
    return fixture.runCommand(specification);
  };

  const report = await runDoctor(fixture.dependencies);
  const serialized = JSON.stringify(report);
  assert.equal(report.ok, false);
  assert.equal(report.code, "DOCTOR_REQUIRED_CHECK_FAILED");
  assert.ok(report.checks.some((check) => check.code === "PRODUCTION_DEPENDENCIES_INVALID"));
  for (const forbidden of [
    "private-person",
    "private.hwp",
    "form-value",
    fragments.join(""),
    ["C:", "\\", "Users"].join(""),
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const redacted = redactDiagnosticText(
    `${privateWindowsPath}\n${fragments.join("")}\nHOME=${privatePosixPath}`,
  );
  assert.doesNotMatch(redacted, /private-person|private\.hwp|leaked-value/u);
});

test("doctor contract rejects Kordoc provenance above the aggregate read budget", async () => {
  const fixture = passingDependencies();
  fixture.dependencies.readJson = async (path) => {
    if (path !== "vendor/kordoc-core/PROVENANCE.json") return fixture.readJson(path);
    return {
      schemaVersion: 2,
      source: { name: "kordoc", version: "3.18.1" },
      files: Array.from({ length: 5 }, (_, index) => ({
        path: `dist/chunk-${index}.js`,
        size: 16 * 1024 * 1024,
        sha256: "a".repeat(64),
      })),
    };
  };

  const report = await runDoctor(fixture.dependencies);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.code === "KORDOC_PROVENANCE_INVALID"));
  assert.equal(fixture.reads.some((path) => path.startsWith("vendor/kordoc-core/dist/chunk-")), false);
});

test("doctor contract rejects unsupported arguments and emits JSON only in json mode", async () => {
  const fixture = passingDependencies();
  const stdout: string[] = [];
  const stderr: string[] = [];
  assert.equal(await doctorMain(["--json"], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  }, fixture.dependencies), 0);
  assert.equal(stderr.length, 0);
  const parsed = JSON.parse(stdout.join(""));
  assert.equal(parsed.schemaVersion, DOCTOR_SCHEMA_VERSION);
  assert.equal(parsed.ok, true);

  stdout.length = 0;
  assert.equal(await doctorMain(["--repair"], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  }, fixture.dependencies), 2);
  assert.equal(stdout.length, 0);
  assert.deepEqual(stderr, ["DOCTOR_USAGE_INVALID: use --json or no arguments.\n"]);
});

function passingDependencies(): {
  dependencies: DoctorDependencies;
  commands: BoundedCommandSpec[];
  reads: string[];
  readJson: DoctorDependencies["readJson"];
  runCommand: DoctorDependencies["runCommand"];
} {
  const commands: BoundedCommandSpec[] = [];
  const reads: string[] = [];
  const json = new Map<string, unknown>([
    ["package.json", {
      name: "gpt-codex-hwp",
      version: "0.1.4",
      dependencies: { kordoc: "file:vendor/kordoc-core" },
      optionalDependencies: { "@rhwp/core": "0.7.17" },
    }],
    [".codex-plugin/plugin.json", {
      name: "gpt-codex-hwp",
      version: "0.1.4+codex.20260713023606",
      mcpServers: "./.mcp.json",
    }],
    [".mcp.json", {
      mcpServers: {
        "gpt-codex-hwp": { command: "node", args: ["./dist/mcp.js"], cwd: "." },
      },
    }],
    ["vendor/kordoc-core/package.json", { name: "kordoc", version: "3.18.1", license: "MIT" }],
    ["vendor/kordoc-core/PROVENANCE.json", {
      schemaVersion: 2,
      source: { name: "kordoc", version: "3.18.1" },
      files: [{ path: "dist/index.js", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }],
    }],
    ["node_modules/@rhwp/core/package.json", { name: "@rhwp/core", version: "0.7.17" }],
    ["tests/fixtures/rhwp/provenance.json", {
      bytes: 7,
      sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
    }],
  ]);
  const readJson: DoctorDependencies["readJson"] = async (path) => {
    reads.push(path);
    if (!json.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return structuredClone(json.get(path));
  };
  const runCommand: DoctorDependencies["runCommand"] = async (specification) => {
    commands.push(structuredClone(specification));
    if (specification.args.includes("ls")) {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout: JSON.stringify({ name: "gpt-codex-hwp", version: "0.1.4", dependencies: {} }),
        stderr: "",
      };
    }
    if (specification.command === "python") {
      return { code: 0, signal: null, timedOut: false, truncated: false, stdout: "Python 3.13.5", stderr: "" };
    }
    return { code: 0, signal: null, timedOut: false, truncated: false, stdout: "10.9.7", stderr: "" };
  };
  return {
    commands,
    reads,
    readJson,
    runCommand,
    dependencies: {
      nodeVersion: "v22.20.1",
      projectMetadata: { productId: "gpt-codex-hwp", version: "0.1.4" },
      toolNames: TOOL_NAMES,
      npmCommand: { command: "node", argsPrefix: ["npm-cli.js"] },
      pythonCommands: [{ command: "python", argsPrefix: [] }],
      readJson,
      readBytes: async (path) => {
        reads.push(path);
        if (path === "vendor/kordoc-core/dist/index.js") return Buffer.from("abc");
        if (path === "tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp") return Buffer.from("fixture");
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      statRegular: async (path) => path === "tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp"
        ? { regular: true, size: 7 }
        : { regular: false, size: 0 },
      sameCanonicalPath: async (left, right) => left === "node_modules/kordoc" && right === "vendor/kordoc-core",
      runCommand,
    },
  };
}
