import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const diagnostic = await import("../scripts/macos-posix-controls.mjs").catch(() => ({}));

function controlTap(control) {
  const name = control === "real-detect"
    ? "benchmark policy records a real nonempty detect dispatch before its one defensive copy"
    : "benchmark policy verifies descendant termination after abnormal case exit";
  return `TAP version 13\n# Subtest: ${name}\nok 1 - ${name}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

test("macOS POSIX controls expose one bounded diagnostic runner", () => {
  assert.equal(typeof diagnostic.runMacPosixControls, "function");
});

test("macOS POSIX controls run the two fixed tests separately and emit only allowlisted success labels", async () => {
  const calls = [];
  let stdout = "";
  let exitCode;

  const passed = await diagnostic.runMacPosixControls({
    runControl: async (control) => {
      calls.push(control);
      return true;
    },
    stdout: { write: (value) => { stdout += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, true);
  assert.deepEqual(calls, [
    {
      name: "real-detect",
      pattern: "^benchmark policy records a real nonempty detect dispatch before its one defensive copy$",
    },
    {
      name: "abnormal-descendant",
      pattern: "^benchmark policy verifies descendant termination after abnormal case exit$",
    },
  ]);
  assert.equal(
    stdout,
    "MAC_POSIX_CONTROL name=real-detect status=passed\n"
      + "MAC_POSIX_CONTROL name=abnormal-descendant status=passed\n",
  );
  assert.equal(exitCode, 0);
});

test("macOS POSIX controls redact child failures, run both controls, and fail the diagnostic", async () => {
  const marker = "PRIVATE/path/document.hwpx AWS_SECRET_ACCESS_KEY=marker";
  const calls = [];
  let stdout = "";
  let exitCode;

  const passed = await diagnostic.runMacPosixControls({
    runControl: async (control) => {
      calls.push(control.name);
      if (control.name === "real-detect") throw new Error(marker);
      return false;
    },
    stdout: { write: (value) => { stdout += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, false);
  assert.deepEqual(calls, ["real-detect", "abnormal-descendant"]);
  assert.equal(
    stdout,
    "MAC_POSIX_CONTROL name=real-detect status=failed\n"
      + "MAC_POSIX_CONTROL name=abnormal-descendant status=failed\n",
  );
  assert.doesNotMatch(stdout, /PRIVATE|AWS_SECRET_ACCESS_KEY|\.hwpx|[\\/]/u);
  assert.equal(exitCode, 1);
});

test("macOS POSIX controls suppress child stdio and invoke only the fixed benchmark-policy tests", async () => {
  const spawns = [];
  let stdout = "";

  const passed = await diagnostic.runMacPosixControls({
    spawnProcess(command, args, options) {
      spawns.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(controlTap(spawns.length === 1 ? "real-detect" : "abnormal-descendant"));
        child.emit("close", 0, null);
      });
      return child;
    },
    stdout: { write: (value) => { stdout += value; } },
    setExitCode() {},
  });

  assert.equal(passed, true);
  assert.equal(spawns.length, 2);
  assert.deepEqual(
    spawns.map(({ command, args, options }) => ({
      command,
      args,
      cwd: options.cwd,
      stdio: options.stdio,
      detached: options.detached,
      shell: options.shell,
      windowsHide: options.windowsHide,
    })),
    [
      {
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "--test",
          "--test-concurrency=1",
          "--test-name-pattern=^benchmark policy records a real nonempty detect dispatch before its one defensive copy$",
          "tests/benchmark-policy.test.ts",
        ],
        cwd: resolve("packages/gpt-codex-hwp"),
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        shell: false,
        windowsHide: true,
      },
      {
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "--test",
          "--test-concurrency=1",
          "--test-name-pattern=^benchmark policy verifies descendant termination after abnormal case exit$",
          "tests/benchmark-policy.test.ts",
        ],
        cwd: resolve("packages/gpt-codex-hwp"),
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        shell: false,
        windowsHide: true,
      },
    ],
  );
  assert.equal(
    stdout,
    "MAC_POSIX_CONTROL name=real-detect status=passed\n"
      + "MAC_POSIX_CONTROL name=abnormal-descendant status=passed\n",
  );
});

test("macOS POSIX controls reject exit zero when no intended test execution receipt exists", async () => {
  let stdout = "";
  let exitCode;

  const passed = await diagnostic.runMacPosixControls({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    },
    stdout: { write: (value) => { stdout += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, false);
  assert.equal(
    stdout,
    "MAC_POSIX_CONTROL name=real-detect status=failed\n"
      + "MAC_POSIX_CONTROL name=abnormal-descendant status=failed\n",
  );
  assert.equal(exitCode, 1);
});

test("macOS POSIX controls terminate a timed-out process group, require close, and continue", {
  timeout: 1_000,
}, async () => {
  let spawnCount = 0;
  let terminateCount = 0;
  let stdout = "";
  let exitCode;

  const passed = await diagnostic.runMacPosixControls({
    controlTimeoutMs: 5,
    closeTimeoutMs: 25,
    spawnProcess() {
      spawnCount += 1;
      const child = new EventEmitter();
      child.pid = 10_000 + spawnCount;
      child.stdout = new PassThrough();
      if (spawnCount === 1) {
        child.naturalClose = setTimeout(() => {
          child.stdout.end(controlTap("real-detect"));
          child.emit("close", 0, null);
        }, 100);
      } else {
        queueMicrotask(() => {
          child.stdout.end(controlTap("abnormal-descendant"));
          child.emit("close", 0, null);
        });
      }
      return child;
    },
    async terminateTree(child) {
      terminateCount += 1;
      clearTimeout(child.naturalClose);
      child.stdout.end();
      child.emit("close", null, "SIGKILL");
      return true;
    },
    stdout: { write: (value) => { stdout += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, false);
  assert.equal(spawnCount, 2);
  assert.equal(terminateCount, 1);
  assert.equal(
    stdout,
    "MAC_POSIX_CONTROL name=real-detect status=failed\n"
      + "MAC_POSIX_CONTROL name=abnormal-descendant status=passed\n",
  );
  assert.equal(exitCode, 1);
});

test("macOS POSIX controls redact a stdout pipe error, clean the child, and continue", async () => {
  const marker = "PRIVATE/path/document.hwpx";
  let spawnCount = 0;
  let terminateCount = 0;
  let stdout = "";
  let exitCode;

  const passed = await diagnostic.runMacPosixControls({
    spawnProcess() {
      spawnCount += 1;
      const child = new EventEmitter();
      child.pid = 20_000 + spawnCount;
      child.stdout = new PassThrough();
      queueMicrotask(() => {
        if (spawnCount === 1) child.stdout.emit("error", new Error(marker));
        else {
          child.stdout.end(controlTap("abnormal-descendant"));
          child.emit("close", 0, null);
        }
      });
      return child;
    },
    terminateTree(child) {
      terminateCount += 1;
      child.stdout.end();
      child.emit("close", null, "SIGKILL");
      return true;
    },
    stdout: { write: (value) => { stdout += value; } },
    setExitCode: (value) => { exitCode = value; },
  });

  assert.equal(passed, false);
  assert.equal(spawnCount, 2);
  assert.equal(terminateCount, 1);
  assert.equal(
    stdout,
    "MAC_POSIX_CONTROL name=real-detect status=failed\n"
      + "MAC_POSIX_CONTROL name=abnormal-descendant status=passed\n",
  );
  assert.doesNotMatch(stdout, /PRIVATE|document\.hwpx|[\\/]/u);
  assert.equal(exitCode, 1);
});
