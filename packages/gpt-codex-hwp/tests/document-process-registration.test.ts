import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  BENCHMARK_ACK_DESCRIPTOR,
  BENCHMARK_REGISTRATION_DESCRIPTOR,
  DOCUMENT_START_DESCRIPTOR,
  DOCUMENT_START_FRAME,
  MAX_REGISTRATION_CHANNEL_BYTES,
  MAX_REGISTRATION_FRAME_BYTES,
  MAX_REGISTERED_DOCUMENT_GROUPS,
  encodeAckFrame,
  encodeRegisterFrame,
  parseAckFrame,
  parseRegisterFrame,
  type AckFrame,
  type RegisterFrame,
} from "../src/workers/document-process-registration.js";

const FIXTURE_ENTRY = fileURLToPath(new URL(
  "./fixtures/workers/gated-payload-marker.mjs",
  import.meta.url,
));
const START_GATE = fileURLToPath(new URL(
  "../src/workers/document-child-start-gate.ts",
  import.meta.url,
));
const VALID_NONCE = "123e4567-e89b-42d3-a456-426614174000";
const VALID_REGISTER: RegisterFrame = {
  schemaVersion: 1,
  type: "register",
  nonce: VALID_NONCE,
  pid: 123,
  parentPid: 45,
};
const VALID_ACK: AckFrame = {
  schemaVersion: 1,
  type: "ack",
  nonce: VALID_NONCE,
  status: "accepted",
};

test("registration frames use the fixed descriptor protocol limits", () => {
  assert.equal(DOCUMENT_START_DESCRIPTOR, 7);
  assert.equal(BENCHMARK_REGISTRATION_DESCRIPTOR, 8);
  assert.equal(BENCHMARK_ACK_DESCRIPTOR, 9);
  assert.equal(MAX_REGISTRATION_FRAME_BYTES, 1_024);
  assert.equal(MAX_REGISTRATION_CHANNEL_BYTES, 16 * 1_024);
  assert.equal(MAX_REGISTERED_DOCUMENT_GROUPS, 16);
  assert.equal(DOCUMENT_START_FRAME, "GPT_CODEX_HWP_START_V1\n");
});

test("register frames round-trip one exact newline-terminated schema 1 frame", () => {
  const encoded = encodeRegisterFrame(VALID_REGISTER);
  assert.equal(encoded[encoded.byteLength - 1], 0x0a);
  assert.equal(new TextDecoder().decode(encoded).endsWith("\n\n"), false);
  assert.deepEqual(parseRegisterFrame(encoded), VALID_REGISTER);
  assert.deepEqual(parseRegisterFrame(rawFrame({
    parentPid: 45,
    pid: 123,
    nonce: VALID_NONCE,
    type: "register",
    schemaVersion: 1,
  })), VALID_REGISTER);
});

test("register frames reject missing extra or invalid exact-shape fields", () => {
  const invalid = [
    { ...VALID_REGISTER, extra: true },
    without(VALID_REGISTER, "parentPid"),
    { ...VALID_REGISTER, schemaVersion: 2 },
    { ...VALID_REGISTER, type: "ack" },
    { ...VALID_REGISTER, nonce: VALID_NONCE.toUpperCase() },
    { ...VALID_REGISTER, nonce: "123e4567-e89b-02d3-a456-426614174000" },
    { ...VALID_REGISTER, nonce: "123e4567-e89b-42d3-7456-426614174000" },
    { ...VALID_REGISTER, nonce: "not-a-uuid" },
    { ...VALID_REGISTER, pid: 0 },
    { ...VALID_REGISTER, pid: -1 },
    { ...VALID_REGISTER, pid: 1.5 },
    { ...VALID_REGISTER, pid: Number.MAX_SAFE_INTEGER + 1 },
    { ...VALID_REGISTER, parentPid: 0 },
    { ...VALID_REGISTER, parentPid: -1 },
    { ...VALID_REGISTER, parentPid: 1.5 },
    { ...VALID_REGISTER, parentPid: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of invalid) {
    assert.throws(() => parseRegisterFrame(rawFrame(value)), /invalid register frame/u);
  }
});

test("ack frames round-trip accepted and rejected exact schema 1 frames", () => {
  for (const status of ["accepted", "rejected"] as const) {
    const frame: AckFrame = { ...VALID_ACK, status };
    assert.deepEqual(parseAckFrame(encodeAckFrame(frame)), frame);
  }
});

test("ack frames reject missing extra noncanonical and invalid fields", () => {
  const invalid = [
    { ...VALID_ACK, extra: true },
    without(VALID_ACK, "status"),
    { ...VALID_ACK, schemaVersion: 0 },
    { ...VALID_ACK, type: "register" },
    { ...VALID_ACK, status: "pending" },
    { ...VALID_ACK, nonce: VALID_NONCE.toUpperCase() },
    { ...VALID_ACK, nonce: "123e4567-e89b-12d3-a456-426614174000" },
  ];
  for (const value of invalid) {
    assert.throws(() => parseAckFrame(rawFrame(value)), /invalid ack frame/u);
  }
});

test("registration parsers reject oversized partial trailing and invalid UTF-8 frames", () => {
  const exact = encodeRegisterFrame(VALID_REGISTER);
  for (const value of [
    Buffer.alloc(MAX_REGISTRATION_FRAME_BYTES + 1, 0x61),
    exact.subarray(0, exact.byteLength - 1),
    Buffer.concat([exact, Buffer.from("x")]),
    Buffer.concat([exact, Buffer.from("\n")]),
    Buffer.from([0xff, 0x0a]),
  ]) {
    assert.throws(() => parseRegisterFrame(value), /invalid register frame/u);
  }
  assert.throws(
    () => encodeRegisterFrame({ ...VALID_REGISTER, nonce: "x".repeat(2_000) }),
    /invalid register frame/u,
  );
});

test("document child gate blocks payload until exact START and preserves entry arguments", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-start-gate-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const markerPath = join(temporaryRoot, "marker.json");
  const payloadArgument = `payload-${randomUUID()}`;
  const child = spawnGatedFixture(markerPath, payloadArgument);
  t.after(() => terminate(child));
  const writer = child.stdio[7];
  assert.notEqual(writer, null);

  await assertFileMissing(markerPath, 200);
  writer!.write(DOCUMENT_START_FRAME);
  await waitForFile(markerPath);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), [
    FIXTURE_ENTRY,
    markerPath,
    payloadArgument,
  ]);

  writer!.end();
  const result = await waitForClose(child);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("document child gate rejects EOF partial extended and incorrect START without payload evaluation", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "document-start-gate-invalid-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const cases = [
    ["eof", Buffer.alloc(0)],
    ["partial", Buffer.from(DOCUMENT_START_FRAME.slice(0, -1))],
    ["extended", Buffer.from(`${DOCUMENT_START_FRAME}x`)],
    ["incorrect", Buffer.from(DOCUMENT_START_FRAME.replace("V1", "V2"))],
  ] as const;

  for (const [label, bytes] of cases) {
    const markerPath = join(temporaryRoot, `${label}.json`);
    const child = spawnGatedFixture(markerPath, label);
    t.after(() => terminate(child));
    const writer = child.stdio[7];
    assert.notEqual(writer, null);
    writer!.end(bytes);
    const result = await waitForClose(child);
    await assert.rejects(access(markerPath), { code: "ENOENT" }, label);
    assert.notEqual(result.code, 0, label);
    assert.equal(result.stdout, "", label);
    assert.equal(result.stderr, "", label);
  }
});

function rawFrame(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function without(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function spawnGatedFixture(markerPath: string, payloadArgument: string): ChildProcess {
  // Windows Node 22 requires an ESM URL for an absolute --import specifier.
  const startGateSpecifier = process.platform === "win32"
    ? pathToFileURL(START_GATE).href
    : START_GATE;
  return spawn(process.execPath, [
    "--import",
    "tsx",
    "--import",
    startGateSpecifier,
    FIXTURE_ENTRY,
    markerPath,
    payloadArgument,
  ], {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "pipe"],
  });
}

async function assertFileMissing(path: string, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await assert.rejects(access(path), { code: "ENOENT" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("timed out waiting for gated payload marker");
}

async function waitForClose(child: ChildProcess): Promise<Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      terminate(child);
      rejectPromise(new Error("timed out waiting for gated fixture exit"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid!, "SIGKILL");
  } catch {
    // The detached child may already have exited between the state check and signal.
  }
}
