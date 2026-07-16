import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { encodeBoundedJsonFrame } from "../src/workers/bounded-frame.js";
import {
  DOCTOR_RUNNER_MAX_FRAME_BYTES,
  DOCTOR_RUNNER_READY,
  parseDoctorRunnerRequest,
  readDoctorRunnerRequest,
} from "../src/workers/doctor-command-runner.js";

const RUNNER = resolve("dist", "workers", "doctor-command-runner.js");

test("doctor gate runner accepts only exact bounded command and args fields", () => {
  assert.deepEqual(parseDoctorRunnerRequest({
    schemaVersion: 1,
    command: "node",
    args: ["--version"],
  }), {
    schemaVersion: 1,
    command: "node",
    args: ["--version"],
  });
  for (const value of [
    { schemaVersion: 1, command: "node", args: [], cwd: "outside" },
    { schemaVersion: 1, command: "node", args: [], environment: {} },
    { command: "node", schemaVersion: 1, args: [] },
    { schemaVersion: 2, command: "node", args: [] },
    { schemaVersion: 1, command: "", args: [] },
    { schemaVersion: 1, command: "node\0bad", args: [] },
    { schemaVersion: 1, command: "node", args: Array.from({ length: 65 }, () => "x") },
    { schemaVersion: 1, command: "node", args: ["x".repeat(4 * 1024 + 1)] },
  ]) assert.throws(() => parseDoctorRunnerRequest(value), /invalid doctor runner request/u);
});

test("doctor gate runner input rejects duplicate partial and timed-out control frames", async () => {
  const request = { schemaVersion: 1, command: "node", args: ["--version"] };
  const frame = encodeBoundedJsonFrame(request, DOCTOR_RUNNER_MAX_FRAME_BYTES);

  const duplicate = new PassThrough();
  const duplicateResult = readDoctorRunnerRequest(duplicate);
  duplicate.end(Buffer.concat([frame, frame]));
  await assert.rejects(duplicateResult, /duplicate frames/u);

  const partial = new PassThrough();
  const partialResult = readDoctorRunnerRequest(partial);
  partial.end(frame.subarray(0, frame.byteLength - 1));
  await assert.rejects(partialResult, /partial frame/u);

  const oversized = new PassThrough();
  const oversizedResult = readDoctorRunnerRequest(oversized);
  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(DOCTOR_RUNNER_MAX_FRAME_BYTES + 1);
  oversized.end(oversizedHeader);
  await assert.rejects(oversizedResult, /frame length/u);

  const idle = new PassThrough();
  await assert.rejects(readDoctorRunnerRequest(idle, 10), /timed out/u);
  idle.destroy();
});

test("compiled doctor gate runner emits bounded READY and never executes malformed or duplicate requests", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "doctor-runner-protocol-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  for (const [label, frames] of [
    ["extra cwd", [{
      schemaVersion: 1,
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'bad')", join(temporaryRoot, "cwd.txt")],
      cwd: temporaryRoot,
    }]],
    ["duplicate", [
      {
        schemaVersion: 1,
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'bad')", join(temporaryRoot, "duplicate.txt")],
      },
      {
        schemaVersion: 1,
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'bad')", join(temporaryRoot, "duplicate.txt")],
      },
    ]],
  ] as const) {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: resolve("."),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const control = child.stdio[3];
    assert.notEqual(control, null);
    let ready = "";
    control!.on("data", (chunk: Buffer) => { ready += chunk.toString("utf8"); });
    const exit = new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
    child.stdin!.end(Buffer.concat(frames.map((value) =>
      encodeBoundedJsonFrame(value, DOCTOR_RUNNER_MAX_FRAME_BYTES))));
    assert.equal(await exit, 127, label);
    assert.equal(ready, DOCTOR_RUNNER_READY, label);
  }
  await assert.rejects(access(join(temporaryRoot, "cwd.txt")), { code: "ENOENT" });
  await assert.rejects(access(join(temporaryRoot, "duplicate.txt")), { code: "ENOENT" });
});
