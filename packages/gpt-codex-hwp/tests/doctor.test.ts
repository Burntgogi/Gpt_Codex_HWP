import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as doctorModule from "../src/doctor.js";

import {
  DOCTOR_SCHEMA_VERSION,
  doctorMain,
  redactDiagnosticText,
  runDoctor,
  type BoundedCommandSpec,
  type DoctorDependencies,
} from "../src/doctor.js";
import { DOCTOR_RUNNER_READY } from "../src/workers/doctor-command-runner.js";
import {
  superviseDocumentProcessTreeWithForcedTrackerForTest,
} from "../src/workers/document-child-client.js";
import { createCanonicalTemporaryDirectory } from "../../../scripts/canonical-temp.mjs";

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

test("doctor contract rejects an impossible shared Kordoc verifier result", async () => {
  const fixture = passingDependencies();
  fixture.dependencies.verifyKordocRuntime = async () => ({ fileCount: 513 });

  const report = await runDoctor(fixture.dependencies);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.code === "KORDOC_PROVENANCE_INVALID"));
});

test("doctor maps shared Kordoc verifier failures to a stable non-leaking code", async () => {
  const fixture = passingDependencies();
  fixture.dependencies.verifyKordocRuntime = async () => {
    throw new Error("private verifier path and provenance detail");
  };

  const report = await runDoctor(fixture.dependencies);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((check) => check.code === "KORDOC_PROVENANCE_INVALID"));
  assert.doesNotMatch(JSON.stringify(report), /private verifier path|provenance detail/u);
});

test("doctor registration probe rejects wrong missing duplicate extra and throwing registrations", async () => {
  const scenarios: Array<readonly string[] | Error> = [
    [...TOOL_NAMES.slice(0, -1), "hwp_wrong"],
    TOOL_NAMES.slice(0, -1),
    [...TOOL_NAMES, TOOL_NAMES[0]],
    [...TOOL_NAMES, "hwp_tenth"],
    new Error("private registry failure"),
  ];
  for (const scenario of scenarios) {
    const fixture = passingDependencies();
    let calls = 0;
    fixture.dependencies.probeRegisteredTools = async () => {
      calls += 1;
      if (scenario instanceof Error) throw scenario;
      return scenario;
    };
    const report = await runDoctor(fixture.dependencies);
    assert.equal(calls, 1);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.code === "MCP_TOOL_COUNT_INVALID"));
    assert.doesNotMatch(JSON.stringify(report), /private registry failure/u);
  }
});

test("doctor registration probe lists the actual private in-process MCP registry", async () => {
  assert.deepEqual(await doctorModule.probeRegisteredToolsInProcess(), TOOL_NAMES);
});

test("doctor runtime access rejects linked file and directory ancestors without reading outside bytes", async (t) => {
  const createAccess = (doctorModule as unknown as {
    createDoctorRuntimeAccess?: (root: string) => Promise<{
      readJson(path: string): Promise<unknown>;
      readBytes(path: string, maximumBytes: number): Promise<Uint8Array>;
    }>;
  }).createDoctorRuntimeAccess;
  assert.equal(typeof createAccess, "function");
  if (createAccess === undefined) return;

  const temporaryRoot = await createCanonicalTemporaryDirectory({ prefix: "doctor-path-boundary-" });
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runtimeRoot = join(temporaryRoot, "runtime");
  const outsideRoot = join(temporaryRoot, "outside");
  await mkdir(runtimeRoot);
  await mkdir(outsideRoot);
  const outsideName = ["private", "-outside-value"].join("");
  await writeFile(join(outsideRoot, "record.json"), JSON.stringify({ value: outsideName }));
  const access = await createAccess(runtimeRoot);

  const linkedDirectory = join(runtimeRoot, "linked-directory");
  try {
    await symlink(outsideRoot, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error: unknown) {
    const code = errorCode(error);
    if (["EACCES", "ENOTSUP", "EPERM"].includes(code)) {
      t.skip(`directory-link capability is unavailable on ${process.platform}: ${code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(access.readJson("linked-directory/record.json"));

  await t.test("final file link", async (t) => {
    const linkedFile = join(runtimeRoot, "linked-file.json");
    try {
      await symlink(join(outsideRoot, "record.json"), linkedFile, "file");
    } catch (error: unknown) {
      const code = errorCode(error);
      if (["EACCES", "ENOTSUP", "EPERM"].includes(code)) {
        t.skip(`file-link capability is unavailable on ${process.platform}: ${code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(access.readBytes("linked-file.json", 1024));
  });

  const fixture = passingDependencies();
  fixture.dependencies.readJson = async (path) => path === ".codex-plugin/plugin.json"
    ? access.readJson("linked-directory/record.json")
    : fixture.readJson(path);
  const report = await runDoctor(fixture.dependencies);
  assert.ok(report.checks.some((check) => check.code === "PLUGIN_MANIFEST_INVALID"));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(outsideName, "u"));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(escapeRegExp(temporaryRoot), "u"));
});

test("doctor bounded command injects detached group termination and fails closed when it remains alive", async () => {
  const execute = (doctorModule as unknown as {
    executeBoundedCommand?: (
      specification: BoundedCommandSpec,
      runtimeRoot: string,
      dependencies: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  }).executeBoundedCommand;
  assert.equal(typeof execute, "function");
  if (execute === undefined) return;

  for (const treeGone of [true, false]) {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      stdout: PassThrough;
      stderr: PassThrough;
      kill(signal?: string): boolean;
      unref(): void;
    };
    child.pid = 4242;
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      throw new Error("direct child kill is forbidden");
    };
    let unrefCalls = 0;
    child.unref = () => { unrefCalls += 1; };
    const terminationCalls: number[] = [];
    const result = await execute(commandSpecification(20), process.cwd(), {
      platform: "linux",
      spawnProcess: (_command: string, _args: readonly string[], options: Record<string, unknown>) => {
        assert.equal(options.detached, true);
        return child;
      },
      terminateProcessTree: async (pid: number) => {
        terminationCalls.push(pid);
        return treeGone;
      },
    });
    assert.deepEqual(terminationCalls, [4242]);
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationFailed, !treeGone);
    assert.equal(result.code, null);
    assert.equal(unrefCalls, treeGone ? 0 : 1);
    assert.equal(child.stdout.destroyed, !treeGone);
    assert.equal(child.stderr.destroyed, !treeGone);
  }
});

test("doctor timeout still terminates the tree after root exit when close was not observed", async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdout: PassThrough;
    stderr: PassThrough;
    unref(): void;
  };
  child.pid = 4343;
  child.exitCode = 0;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => undefined;
  const terminationCalls: number[] = [];

  const result = await doctorModule.executeBoundedCommand(
    commandSpecification(20),
    process.cwd(),
    {
      platform: "linux",
      spawnProcess: () => child,
      terminateProcessTree: async (pid: number) => {
        terminationCalls.push(pid);
        return true;
      },
    },
  );

  assert.deepEqual(terminationCalls, [4343]);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationFailed, false);
  assert.equal(result.code, null);
});

test("Windows doctor gate sends no command before Job readiness and verifies cleanup on normal close", async () => {
  const child = fakeWindowsRunner(4444);
  const input: Buffer[] = [];
  child.stdin.on("data", (chunk: Buffer) => input.push(chunk));
  child.stdin.once("finish", () => setImmediate(() => child.emit("close", 0, null)));
  let resolveSupervisor!: (value: { terminate(): Promise<boolean> }) => void;
  const supervisorReady = new Promise<{ terminate(): Promise<boolean> }>((resolve) => {
    resolveSupervisor = resolve;
  });
  let terminationCalls = 0;
  const execution = doctorModule.executeBoundedCommand(commandSpecification(500), process.cwd(), {
    platform: "win32",
    runnerPath: "fixed-doctor-runner.js",
    spawnProcess: (() => child) as typeof import("node:child_process").spawn,
    superviseProcessTree: () => supervisorReady,
  });
  child.stdio[3].end(DOCTOR_RUNNER_READY);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(Buffer.concat(input).byteLength, 0);
  resolveSupervisor({
    terminate: async () => {
      terminationCalls += 1;
      return { gone: true, proof: "windows-job-empty" };
    },
  });

  const result = await execution;
  assert.ok(Buffer.concat(input).byteLength > 4);
  assert.equal(terminationCalls, 1);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationFailed, false);
});

test("Windows doctor request stdin retains owner-lifetime error handling after its end callback", async () => {
  const child = fakeWindowsRunner(4494);
  const input = child.stdin;
  let listenersAfterCallback = -1;
  let laterErrorEmitted = false;
  input.end = ((
    _chunk: Uint8Array,
    callback?: (error?: Error | null) => void,
  ) => {
    callback?.();
    listenersAfterCallback = input.listenerCount("error");
    if (listenersAfterCallback > 0) {
      laterErrorEmitted = true;
      const error = Object.assign(new Error("late doctor pipe failure"), { code: "EPIPE" });
      input.emit("error", error);
    }
    setImmediate(() => child.emit("close", 0, null));
    return input;
  }) as typeof input.end;

  const execution = doctorModule.executeBoundedCommand(commandSpecification(500), process.cwd(), {
    platform: "win32",
    runnerPath: "fixed-doctor-runner.js",
    spawnProcess: (() => child) as typeof import("node:child_process").spawn,
    superviseProcessTree: async () => ({
      terminate: async () => ({ gone: true, proof: "windows-job-empty" }),
    }),
  });
  child.stdio[3].end(DOCTOR_RUNNER_READY);

  const result = await execution;
  assert.equal(result.code, 0);
  assert.equal(result.terminationFailed, false);
  assert.equal(listenersAfterCallback, 1);
  assert.equal(laterErrorEmitted, true);
  assert.equal(input.listenerCount("error"), 0);
});

test("Windows doctor supervisor failure terminates the gated runner by its exact child handle", async () => {
  const child = fakeWindowsRunner(2_000_000_000) as ReturnType<typeof fakeWindowsRunner> & {
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  let exactHandleProbes = 0;
  let exactHandleKills = 0;
  child.kill = (signal: NodeJS.Signals | number = "SIGTERM") => {
    if (signal === 0) {
      exactHandleProbes += 1;
      return true;
    }
    exactHandleKills += 1;
    child.signalCode = signal as NodeJS.Signals;
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  const execution = doctorModule.executeBoundedCommand(commandSpecification(500), process.cwd(), {
    platform: "win32",
    runnerPath: "fixed-doctor-runner.js",
    spawnProcess: (() => child) as typeof import("node:child_process").spawn,
    superviseProcessTree: async () => {
      throw new Error("job authority unavailable");
    },
  });
  child.stdio[3].end(DOCTOR_RUNNER_READY);

  const result = await execution;
  assert.equal(exactHandleProbes, 1);
  assert.equal(exactHandleKills, 1);
  assert.equal(result.code, null);
  assert.equal(result.terminationFailed, false);
});

test("Windows doctor gate never dispatches through a forced cleanup-only tracker", {
  skip: process.platform !== "win32" ? "Windows process tracking is Windows-only" : false,
  timeout: 15_000,
}, async (t) => {
  const root = await createCanonicalTemporaryDirectory({ prefix: "doctor-tracker-gate-" });
  const markerPath = join(root, "dispatched.txt");
  t.after(() => rm(root, { recursive: true, force: true }));
  const supervisorFrames: string[] = [];
  const result = await doctorModule.executeBoundedCommand({
    ...commandSpecification(5_000),
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "dispatched")`],
  }, process.cwd(), {
    platform: "win32",
    superviseProcessTree: (child) => superviseDocumentProcessTreeWithForcedTrackerForTest(
      child,
      (frame) => supervisorFrames.push(frame),
    ),
  });

  assert.match(supervisorFrames[0] ?? "", /^GPT_CODEX_HWP_JOB READY [0-9]+ 2 [0-9]+$/u);
  await assert.rejects(access(markerPath), { code: "ENOENT" });
  assert.equal(result.code, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationFailed, false);
});

test("Windows doctor gate rejects abnormal READY without dispatch and still finalizes the supervisor", async () => {
  for (const [index, ready] of [
    "GPT_CODEX_HWP_DOCTOR_RUNNER WRONG\n",
    `${DOCTOR_RUNNER_READY}X`,
  ].entries()) {
    const child = fakeWindowsRunner(4545 + index);
    const input: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => input.push(chunk));
    let terminationCalls = 0;
    const execution = doctorModule.executeBoundedCommand(commandSpecification(500), process.cwd(), {
      platform: "win32",
      runnerPath: "fixed-doctor-runner.js",
      spawnProcess: (() => child) as typeof import("node:child_process").spawn,
      superviseProcessTree: async () => ({
        terminate: async () => {
          terminationCalls += 1;
          return index === 0
            ? { gone: true as const, proof: "windows-job-empty" as const }
            : { gone: false as const, proof: "unverified" as const, reason: "identity" as const };
        },
      }),
    });
    child.stdio[3].end(ready);

    const result = await execution;
    assert.equal(Buffer.concat(input).byteLength, 0);
    assert.equal(terminationCalls, 1);
    assert.equal(result.code, null);
    assert.equal(result.terminationFailed, index === 1);
  }
});

test("doctor bounded command removes a real descendant after timeout", { timeout: 10_000 }, async (t) => {
  const execute = (doctorModule as unknown as {
    executeBoundedCommand?: (
      specification: BoundedCommandSpec,
      runtimeRoot: string,
    ) => Promise<Record<string, unknown>>;
  }).executeBoundedCommand;
  assert.equal(typeof execute, "function");
  if (execute === undefined) return;

  const temporaryRoot = await createCanonicalTemporaryDirectory({ prefix: "doctor-process-tree-" });
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const fixturePath = join(temporaryRoot, "tree.mjs");
  await writeFile(fixturePath, [
    'import { spawn } from "node:child_process";',
    'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });',
    'process.stdout.write(String(descendant.pid) + "\\n");',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  const result = await execute({
    ...commandSpecification(750),
    command: process.execPath,
    args: [fixturePath],
  }, temporaryRoot);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationFailed, false);
  const descendantPid = Number.parseInt(String(result.stdout).trim(), 10);
  assert.equal(Number.isSafeInteger(descendantPid), true);
  await waitUntilProcessGone(descendantPid);
});

test("doctor timeout terminates a grandchild after its parent exits but inherited pipes remain open", { timeout: 10_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not retain this inherited anonymous-pipe close condition.");
    return;
  }
  const execute = doctorModule.executeBoundedCommand;
  const temporaryRoot = await createCanonicalTemporaryDirectory({ prefix: "doctor-orphaned-tree-" });
  const fixturePath = join(temporaryRoot, "orphaned-tree.mjs");
  const sentinelPath = join(temporaryRoot, "late-sentinel.txt");
  let descendantPid = 0;
  t.after(async () => {
    if (descendantPid > 0) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
      await waitUntilProcessGone(descendantPid).catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await writeFile(fixturePath, [
    'import { spawn } from "node:child_process";',
    'const descendantSource = [',
    '  `const { writeFileSync } = require("node:fs");`,',
    '  `process.on("SIGTERM", () => {});`,',
    '  `setTimeout(() => writeFileSync(process.argv[1], "late\\n"), 1500);`,',
    '  `setInterval(() => {}, 1000);`,',
    '].join("\\n");',
    'const descendant = spawn(process.execPath, ["-e", descendantSource, process.argv[2]], {',
    '  stdio: ["ignore", "inherit", "inherit"],',
    '});',
    'process.stdout.write(String(descendant.pid) + "\\n");',
  ].join("\n"));

  let diagnosticStage = "EXECUTE";
  try {
    const startedAt = Date.now();
    const result = await execute({
      ...commandSpecification(500),
      command: process.execPath,
      args: [fixturePath, sentinelPath],
    }, temporaryRoot);
    const elapsedMs = Date.now() - startedAt;
    descendantPid = Number.parseInt(String(result.stdout).trim(), 10);

    diagnosticStage = "TIMED_OUT";
    assert.equal(result.timedOut, true);
    diagnosticStage = "TERMINATION";
    assert.equal(result.terminationFailed, false);
    diagnosticStage = "ELAPSED";
    assert.ok(elapsedMs < 6_000, `bounded command took ${elapsedMs}ms`);
    diagnosticStage = "PID";
    assert.equal(Number.isSafeInteger(descendantPid), true);
    diagnosticStage = "WAIT_GONE";
    await waitUntilProcessGone(descendantPid);
    diagnosticStage = "SENTINEL";
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await assert.rejects(access(sentinelPath), { code: "ENOENT" });
  } catch {
    throw new Error(`DOCTOR_ORPHAN_${diagnosticStage}`);
  }
});

test("Windows doctor Job removes a grandchild after the command parent exits", { timeout: 15_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job verification is only available on Windows.");
    return;
  }
  const temporaryRoot = await createCanonicalTemporaryDirectory({ prefix: "doctor-windows-job-tree-" });
  const fixturePath = join(temporaryRoot, "windows-job-tree.mjs");
  const sentinelPath = join(temporaryRoot, "late-sentinel.txt");
  let descendantPid = 0;
  t.after(async () => {
    if (descendantPid > 0) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
      await waitUntilProcessGone(descendantPid).catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await writeFile(fixturePath, [
    'import { spawn } from "node:child_process";',
    'const descendantSource = [',
    '  `const { writeFileSync } = require("node:fs");`,',
    '  `setTimeout(() => writeFileSync(process.argv[1], "late\\n"), 2500);`,',
    '  `setInterval(() => {}, 1000);`,',
    '].join("\\n");',
    'const descendant = spawn(process.execPath, ["-e", descendantSource, process.argv[2]], { stdio: "ignore" });',
    'process.stdout.write(String(descendant.pid) + "\\n");',
  ].join("\n"));

  const result = await doctorModule.executeBoundedCommand({
    ...commandSpecification(5_000),
    command: process.execPath,
    args: [fixturePath, sentinelPath],
  }, temporaryRoot);
  descendantPid = Number.parseInt(String(result.stdout).trim(), 10);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationFailed, false);
  assert.equal(result.code, 0);
  assert.equal(Number.isSafeInteger(descendantPid), true);
  await waitUntilProcessGone(descendantPid);
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  await assert.rejects(access(sentinelPath), { code: "ENOENT" });
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
      npmCommand: { command: "node", argsPrefix: ["npm-cli.js"] },
      pythonCommands: [{ command: "python", argsPrefix: [] }],
      verifyKordocRuntime: async () => ({ fileCount: 40 }),
      probeRegisteredTools: async () => TOOL_NAMES,
      readJson,
      readBytes: async (path) => {
        reads.push(path);
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

function commandSpecification(timeoutMs: number): BoundedCommandSpec {
  return {
    command: "controlled-command",
    args: [],
    cwdCode: "RUNTIME_ROOT",
    shell: false,
    windowsHide: true,
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  };
}

function fakeWindowsRunner(pid: number): EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  stdio: [PassThrough, PassThrough, PassThrough, PassThrough];
  unref(): void;
} {
  const child = new EventEmitter() as ReturnType<typeof fakeWindowsRunner>;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
  child.unref = () => undefined;
  return child;
}

async function waitUntilProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (errorCode(error) === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.fail("descendant process remained alive after bounded doctor termination");
}

function errorCode(error: unknown): string {
  if (error === null || typeof error !== "object" || !("code" in error)) return "UNKNOWN";
  return String(error.code);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
