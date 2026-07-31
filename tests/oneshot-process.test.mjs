import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runBoundedProcess } from "../scripts/public-content-policy.mjs";

const RUNTIME_ROOT = resolve("plugins/gpt-codex-hwp");
const ENTRY_ARGUMENTS = ["--max-semi-space-size=1", "./dist/oneshot.js"];
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

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
  await writePrivateRequest(fixture.requestPath, fixture.request);

  const result = await runFixture(fixture);
  assertProcessReceipt(result, 0, "ONESHOT_OK\n", "");
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
  assertProcessReceipt(collision, 2, "", "ONESHOT_INVOCATION_ERROR\n");
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
  assertProcessReceipt(result, 1, "ONESHOT_TOOL_ERROR\n", "");
  assert.equal(JSON.parse(await readFile(fixture.responsePath, "utf8")).isError, true);
});

test("compiled one-shot rejects malformed JSON without publishing a response", { timeout: 30_000 }, async (t) => {
  const fixture = await createFixture(t, "malformed", "{");
  await writeFile(fixture.requestPath, fixture.request, { flag: "wx", mode: 0o600 });

  const result = await runFixture(fixture);
  assertProcessReceipt(result, 2, "", "ONESHOT_INVOCATION_ERROR\n");
  await assert.rejects(lstat(fixture.responsePath), { code: "ENOENT" });
});

test("compiled one-shot handles SIGTERM through bounded graceful cancellation", {
  timeout: 60_000,
  skip: process.platform === "win32" ? "Windows SIGTERM forcibly terminates Node" : false,
}, async (t) => {
  const fixture = await createLargeGenerationFixture(t, "signal");
  const child = spawn(process.execPath, [
    ...ENTRY_ARGUMENTS,
    "--request",
    fixture.requestPath,
    "--response",
    fixture.responsePath,
  ], {
    cwd: RUNTIME_ROOT,
    env: runtimeEnvironment(fixture.root),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid);
  const pid = child.pid;
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const completed = collectChild(child);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  assert.equal(child.exitCode, null, "large generation must still be in flight");
  assert.equal(child.kill("SIGTERM"), true);

  const result = await Promise.race([
    completed,
    new Promise((_, rejectPromise) => setTimeout(
      () => rejectPromise(new Error("graceful one-shot cancellation exceeded its bound")),
      20_000,
    )),
  ]);
  assert.deepEqual(
    { code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr },
    { code: 2, signal: null, stdout: "", stderr: "ONESHOT_INVOCATION_ERROR\n" },
  );
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
  t.after(() => rm(root, { recursive: true, force: true }));
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
  await writePrivateRequest(fixture.requestPath, fixture.request);
  return fixture;
}

function runFixture(fixture, timeoutMs = 30_000) {
  return runBoundedProcess(process.execPath, [
    ...ENTRY_ARGUMENTS,
    "--request",
    fixture.requestPath,
    "--response",
    fixture.responsePath,
  ], {
    cwd: RUNTIME_ROOT,
    env: runtimeEnvironment(fixture.root),
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });
}

function runtimeEnvironment(root) {
  return {
    ...process.env,
    GPT_CODEX_HWP_ALLOWED_ROOTS: JSON.stringify([root]),
  };
}

function writePrivateRequest(path, request) {
  return writeFile(path, JSON.stringify(request), { flag: "wx", mode: 0o600 });
}

function assertProcessReceipt(result, code, stdout, stderr) {
  assert.deepEqual({
    code: result.code,
    signal: result.signal,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    overflow: result.overflow,
    timedOut: result.timedOut,
    terminationFailed: result.terminationFailed,
  }, {
    code,
    signal: null,
    stdout,
    stderr,
    overflow: false,
    timedOut: false,
    terminationFailed: false,
  });
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
