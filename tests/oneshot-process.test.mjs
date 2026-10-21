import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertOneShotProcessCleanup,
  prepareRestartSafeRuntime,
} from "../scripts/installed-runtime-smoke.mjs";
import { runBoundedProcess } from "../scripts/public-content-policy.mjs";

let runtimeRoot = resolve("plugins/gpt-codex-hwp");
let codexHome;
let cleanupRuntime;
const ENTRY_ARGUMENTS = ["--max-semi-space-size=1", "./dist/oneshot.js"];
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const HWP_FIXTURE = resolve(
  "packages/gpt-codex-hwp/tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp",
);

before(async () => {
  const prepared = await prepareRestartSafeRuntime();
  runtimeRoot = prepared.managedRoot;
  codexHome = prepared.codexHome;
  cleanupRuntime = prepared.cleanup;
});

after(async () => cleanupRuntime?.());

test("compiled one-shot generates one valid HWPX and never overwrites a response", { timeout: 60_000 }, async (t) => {
  const fixture = await createFixture(t, "success", {
    schemaVersion: 1,
    tool: "hwp_generate_hwpx",
    arguments: {
      markdown: "# One-shot report\n\nVerified compiled process output.",
      output_path: "OUTPUT_PATH",
      preset: "report",
      validate: true,
    },
  });
  fixture.request.arguments.output_path = fixture.outputPath;
  fixture.request.arguments.markdown += `\n${fixture.root}`;
  await writePrivateRequest(fixture.requestPath, fixture.request);

  const result = await runFixture(fixture);
  assertBoundedProcessStatus(result, 0);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.stdout.toString("utf8").includes(fixture.root), false);
  const responseBytes = await readFile(fixture.responsePath);
  const response = JSON.parse(responseBytes.toString("utf8"));
  assert.equal(response.isError, false);
  assert.equal(response.structuredContent.output_path, fixture.outputPath);
  assert.equal(response.structuredContent.validation.ok, true);
  assert.equal((await readFile(fixture.outputPath)).subarray(0, 4).equals(ZIP_SIGNATURE), true);

  const collisionOutputPath = join(fixture.root, "collision.hwpx");
  const collisionRequestPath = join(fixture.root, "collision-request.json");
  const collisionResponsePath = join(fixture.root, "collision-response.json");
  await writePrivateRequest(collisionRequestPath, {
    ...fixture.request,
    arguments: { ...fixture.request.arguments, output_path: collisionOutputPath },
  });
  await writeFile(collisionResponsePath, "sentinel", { flag: "wx", mode: 0o600 });
  const collision = await runFixture({
    ...fixture,
    requestPath: collisionRequestPath,
    responsePath: collisionResponsePath,
  });
  assertInvocationFailure(collision, "RESPONSE_PATH_REJECTED", fixture.root);
  assert.equal(await readFile(collisionResponsePath, "utf8"), "sentinel");
  await assert.rejects(lstat(collisionOutputPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(fixture.responsePath), responseBytes);
});

test("compiled one-shot publishes a missing-HWP tool error", { timeout: 30_000 }, async (t) => {
  const fixture = await createFixture(t, "tool-error", {
    schemaVersion: 1,
    tool: "hwp_detect_format",
    arguments: { file_path: "MISSING_PATH" },
  });
  fixture.request.arguments.file_path = join(fixture.root, "missing.hwp");
  await writePrivateRequest(fixture.requestPath, fixture.request);

  const result = await runFixture(fixture);
  assertBoundedProcessStatus(result, 1);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.stdout.toString("utf8").includes(fixture.root), false);
  assert.equal(JSON.parse(await readFile(fixture.responsePath, "utf8")).isError, true);
});

test("compiled one-shot reads a real HWP and proves every cleanup tree", { timeout: 60_000 }, async (t) => {
  const fixture = await createFixture(t, "hwp-read-cleanup", {
    schemaVersion: 1,
    tool: "hwp_read",
    arguments: { file_path: "INPUT_PATH" },
  });
  const inputPath = join(fixture.root, "input.hwp");
  await copyFile(HWP_FIXTURE, inputPath);
  fixture.request.arguments.file_path = inputPath;
  await writePrivateRequest(fixture.requestPath, fixture.request);

  const result = await runFixture(fixture, 60_000, {
    GPT_CODEX_HWP_ONESHOT_CLEANUP_EVIDENCE: "stdout",
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 0);
  const cleanup = assertOneShotProcessCleanup(result);
  assert.equal(cleanup.remainingDescendantCount, 0);
  const response = JSON.parse(await readFile(fixture.responsePath, "utf8"));
  assert.equal(response.isError, false);
  assert.equal(/\p{Script=Hangul}/u.test(response.structuredContent.markdown), true);
});

test("compiled one-shot rejects malformed JSON without publishing a response", { timeout: 30_000 }, async (t) => {
  const fixture = await createFixture(t, "malformed", "{");
  await writeFile(fixture.requestPath, fixture.request, { flag: "wx", mode: 0o600 });

  const result = await runFixture(fixture);
  assertInvocationFailure(result, "REQUEST_INVALID", fixture.root);
  await assert.rejects(lstat(fixture.responsePath), { code: "ENOENT" });
});

test("compiled one-shot handles SIGTERM through bounded graceful cancellation", {
  timeout: 60_000,
  skip: process.platform === "win32" ? "Windows SIGTERM forcibly terminates Node" : false,
}, async (t) => {
  const fixture = await createLargeGenerationFixture(t, "signal");
  const observerPath = join(fixture.root, "signal-ready.mjs");
  await writeFile(observerPath, `
const observer = setInterval(() => {
  if (process.listenerCount("SIGTERM") === 0) return;
  clearInterval(observer);
  process.send?.("signal-handler-ready");
  process.channel?.unref();
}, 10);
observer.unref();
`, { flag: "wx", mode: 0o600 });
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(observerPath).href,
    ...ENTRY_ARGUMENTS,
    "--request",
    fixture.requestPath,
    "--response",
    fixture.responsePath,
  ], {
    cwd: runtimeRoot,
    env: runtimeEnvironment(fixture.root),
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  assert.ok(child.pid);
  const pid = child.pid;
  const completed = collectChild(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await completed;
    assertProcessAbsent(pid);
  });
  await Promise.race([
    once(child, "message", { signal: t.signal }).then(([message]) => {
      assert.equal(message === "signal-handler-ready", true);
    }),
    completed.then(() => { throw new Error("one-shot exited before cancellation readiness"); }),
  ]);
  assert.equal(child.exitCode, null);
  assert.equal(child.kill("SIGTERM"), true);

  let completionTimer;
  let result;
  try {
    result = await Promise.race([
      completed,
      new Promise((_, rejectPromise) => {
        completionTimer = setTimeout(
          () => rejectPromise(new Error("graceful one-shot cancellation exceeded its bound")),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(completionTimer);
  }
  assert.equal(result.code, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.length, 0);
  assertInvocationReason(result.stderr, "CANCELLED");
  assert.equal(result.stderr.includes(fixture.root), false);
  await assert.rejects(lstat(fixture.responsePath), { code: "ENOENT" });
  await assert.rejects(lstat(fixture.outputPath), { code: "ENOENT" });
  assertProcessAbsent(pid);
});

test("bounded process termination removes an in-flight one-shot tree", { timeout: 60_000 }, async (t) => {
  const fixture = await createLargeGenerationFixture(t, "bounded-timeout");
  const result = await runFixture(fixture, 250);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationFailed, false);
  await assert.rejects(lstat(fixture.responsePath), { code: "ENOENT" });
});

async function createFixture(t, name, request) {
  const root = await mkdtemp(join(tmpdir(), `gpt-codex-hwp-oneshot-process-${name}-`));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return {
    root,
    request,
    requestPath: join(root, "request.json"),
    responsePath: join(root, "response.json"),
    outputPath: join(root, "output.hwpx"),
  };
}

async function createLargeGenerationFixture(t, name) {
  const fixture = await createFixture(t, name, {
    schemaVersion: 1,
    tool: "hwp_generate_hwpx",
    arguments: {
      markdown: `# In-flight generation\n\n${"x".repeat(4_900_000)}`,
      output_path: "OUTPUT_PATH",
      preset: "report",
      validate: true,
    },
  });
  fixture.request.arguments.output_path = fixture.outputPath;
  fixture.request.arguments.markdown += `\n${fixture.root}`;
  await writePrivateRequest(fixture.requestPath, fixture.request);
  return fixture;
}

function runFixture(fixture, timeoutMs = 30_000, environment = {}) {
  return runBoundedProcess(process.execPath, [
    ...ENTRY_ARGUMENTS,
    "--request",
    fixture.requestPath,
    "--response",
    fixture.responsePath,
  ], {
    cwd: runtimeRoot,
    env: { ...runtimeEnvironment(fixture.root), ...environment },
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });
}

function runtimeEnvironment(root) {
  return {
    ...process.env,
    CODEX_HOME: codexHome,
    GPT_CODEX_HWP_ALLOWED_ROOTS: JSON.stringify([root]),
  };
}

function writePrivateRequest(path, request) {
  return writeFile(path, JSON.stringify(request), { flag: "wx", mode: 0o600 });
}

function assertBoundedProcessStatus(result, code) {
  assert.equal(result.code, code);
  assert.equal(result.signal, null);
  assert.equal(result.overflow, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationFailed, false);
}

function assertInvocationReason(stderr, reason) {
  assert.equal(new RegExp(`(?:^|\\s)reason=${reason}(?:\\s|$)`, "u")
    .test(stderr.toString("utf8")), true);
}

function assertInvocationFailure(result, reason, privateRoot) {
  assertBoundedProcessStatus(result, 2);
  assert.equal(result.stdout.length, 0);
  assertInvocationReason(result.stderr, reason);
  assert.equal(result.stderr.toString("utf8").includes(privateRoot), false);
}

function collectChild(child) {
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function assertProcessAbsent(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error?.code === "ESRCH",
  );
}
