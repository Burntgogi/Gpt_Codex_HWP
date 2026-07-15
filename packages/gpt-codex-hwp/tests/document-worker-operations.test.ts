import assert from "node:assert/strict";
import { once } from "node:events";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  createDocumentChildClient,
  isIntegrityVerifiedResultSpool,
} from "../src/workers/document-child-client.js";
import type { IntegrityVerifiedResultSpool } from "../src/workers/document-execution-policy.js";
import {
  createDocumentWorkerClient,
} from "../src/workers/document-worker-client.js";
import type {
  DocumentEngineOperation,
  DocumentResultPayload,
  LogicalDocumentRequest,
} from "../src/workers/document-protocol.js";
import type {
  SpoolDocumentSnapshot,
  WorkerDocumentSnapshot,
} from "../src/shared/document-snapshot.js";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_ROOT, "..");
const WORKER_ENTRY = join(PACKAGE_ROOT, "dist", "workers", "document-worker.js");
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "workers", "document-child.js");
const FIXTURE_CHILD = join(TEST_ROOT, "fixtures", "workers", "engine-test-child.mjs");
const HWP_FIXTURE = join(
  TEST_ROOT,
  "fixtures",
  "rhwp",
  "re-01-hangul-only-hancom.hwp",
);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlDkAAAAASUVORK5CYII=",
  "base64",
);

test("document worker operations use only bytes for HWPX generation, parse, render, patch, fill, validation, and image placement", { timeout: 60_000 }, async () => {
  const client = createBuiltWorkerClient();
  const markdown = [
    "# Worker synthetic",
    "",
    "Approval anchor: (인)",
    "",
    "| 항목 | 값 |",
    "| --- | --- |",
    "| 성명 | |",
  ].join("\n");

  const generated = await client.run(request("generateHwpx", {
    input: { markdown },
  }), undefined);
  assert.ok(generated.bytes.byteLength > 0);

  const detected = await client.run(
    request("detect"),
    workerSnapshot(generated.bytes.slice(0)),
  );
  assert.deepEqual(detected, { format: "hwpx" });

  const parsed = await client.run(
    request("parse"),
    workerSnapshot(generated.bytes.slice(0)),
  );
  assert.equal(parsed.fileType, "hwpx");
  assert.match(parsed.markdown, /Worker synthetic/u);

  const rendered = await client.run(
    request("render", { options: { reflow: true } }),
    workerSnapshot(generated.bytes.slice(0)),
  );
  assert.match(rendered.svg, /^\s*<svg\b/iu);

  const edited = parsed.markdown.replace("Worker synthetic", "Worker updated");
  assert.notEqual(edited, parsed.markdown);
  const patched = await client.run(
    request("patchHwpx", { input: { markdown: edited } }),
    workerSnapshot(generated.bytes.slice(0)),
  );
  const patchedRead = await client.run(
    request("parse"),
    workerSnapshot(patched.bytes.slice(0)),
  );
  assert.match(patchedRead.markdown, /Worker updated/u);

  const filled = await client.run(
    request("fillHwpx", { input: { fields: { "성명": "홍길동" } } }),
    workerSnapshot(generated.bytes.slice(0)),
  );
  const filledRead = await client.run(
    request("parse"),
    workerSnapshot(filled.bytes.slice(0)),
  );
  assert.match(filledRead.markdown, /홍길동/u);

  const checked = await client.run(
    request("validateHwpx"),
    workerSnapshot(generated.bytes.slice(0)),
  );
  assert.equal(checked.ok, true);
  assert.equal(checked.issues.length, 0);

  const imageBuffer = exactArrayBuffer(ONE_PIXEL_PNG);
  const inserted = await client.run(
    request("insertImage", {
      input: { anchorText: "(인)" },
      options: { mode: "seal-anchor", sizeMm: 8, anchorOccurrence: 0 },
    }),
    workerSnapshot(generated.bytes.slice(0)),
    { imageInput: { transport: "buffer", buffer: imageBuffer } },
  );
  const insertedCheck = await client.run(
    request("validateHwpx"),
    workerSnapshot(inserted.bytes.slice(0)),
  );
  assert.equal(insertedCheck.ok, true);

  await assert.rejects(
    client.run(
      request("insertImage", {
        input: { anchorText: "(인)" },
        options: { mode: "after-paragraph" },
      }),
      workerSnapshot(generated.bytes.slice(0)),
      {
        imageInput: {
          transport: "buffer",
          buffer: exactArrayBuffer(ONE_PIXEL_PNG),
        },
      },
    ),
    hasEngineCode("ENGINE_PROTOCOL_ERROR"),
    "after-paragraph must fail closed before Kordoc placement dispatch",
  );
});

test("document worker operations read and render the pinned HWP but reject every HWP mutation before mutation dispatch", { timeout: 60_000 }, async () => {
  const client = createBuiltWorkerClient();
  const hwp = await readFile(HWP_FIXTURE);

  assert.deepEqual(
    await client.run(request("detect"), workerSnapshot(exactArrayBuffer(hwp))),
    { format: "hwp" },
  );
  const parsed = await client.run(
    request("parse"),
    workerSnapshot(exactArrayBuffer(hwp)),
  );
  assert.equal(parsed.fileType, "hwp");
  assert.equal(Buffer.byteLength(parsed.markdown, "utf8"), 300);

  const rendered = await client.run(
    request("render"),
    workerSnapshot(exactArrayBuffer(hwp)),
  );
  assert.match(rendered.svg, /^\s*<svg\b/iu);

  for (const operation of [
    request("patchHwpx", { input: { markdown: parsed.markdown } }),
    request("fillHwpx", { input: { fields: { name: "value" } } }),
    request("validateHwpx"),
  ] as const) {
    await assert.rejects(
      client.run(operation as never, workerSnapshot(exactArrayBuffer(hwp))),
      hasEngineCode("ENGINE_PROTOCOL_ERROR"),
      operation.operation,
    );
  }

  await assert.rejects(
    client.run(
      request("insertImage", { input: { anchorText: "anchor" } }),
      workerSnapshot(exactArrayBuffer(hwp)),
      {
        imageInput: {
          transport: "buffer",
          buffer: exactArrayBuffer(ONE_PIXEL_PNG),
        },
      },
    ),
    hasEngineCode("ENGINE_PROTOCOL_ERROR"),
  );
});

test("document worker operations child route uses inherited handles and the one-shot decoder returns validated exact results", { timeout: 60_000 }, async () => {
  const child = createBuiltChildClient();
  const generatedResult = await child.run(
    request("generateHwpx", { input: { markdown: "# Child generated\n" } }),
    undefined,
  );

  const { decodeDocumentResultSpool } = await import(
    "../src/workers/document-compute-backend.js"
  );
  const generated = isIntegrityVerifiedResultSpool(generatedResult)
    ? await decodeDocumentResultSpool(
        generatedResult as IntegrityVerifiedResultSpool<"generateHwpx">,
      )
    : generatedResult;
  assert.ok(generated.bytes.byteLength > 0);

  const owned = spoolSnapshot(new Uint8Array(generated.bytes));
  const parsed = await child.run(request("parse"), owned.snapshot);
  const parsedPayload = isIntegrityVerifiedResultSpool(parsed)
    ? await decodeDocumentResultSpool(parsed as IntegrityVerifiedResultSpool<"parse">)
    : parsed;
  assert.equal(parsedPayload.fileType, "hwpx");
  assert.match(parsedPayload.markdown, /Child generated/u);
  owned.cleanup();
});

test("document worker operations spool decoder rejects hash-valid but semantically invalid parse and render spools and always cleans", { timeout: 30_000 }, async () => {
  const { decodeDocumentResultSpool } = await import(
    "../src/workers/document-compute-backend.js"
  );

  for (const operation of ["parse", "render"] as const) {
    const owned = spoolSnapshot(Buffer.from("K".repeat(1024)));
    const client = createFixtureChildClient("spool-result", "1024");
    const result = await client.run(request(operation), owned.snapshot);
    assert.equal(isIntegrityVerifiedResultSpool(result), true);
    await assert.rejects(
      decodeDocumentResultSpool(result as IntegrityVerifiedResultSpool<typeof operation>),
      hasEngineCode("ENGINE_PROTOCOL_ERROR"),
    );
    assert.throws(() => result.takeHandle(), hasEngineCode("ENGINE_PROTOCOL_ERROR"));
    owned.cleanup();
  }
});

test("document worker operations isolate requests contain no source path or Node IPC fields", () => {
  const requests = [
    request("detect"),
    request("parse", { options: { pages: "1" } }),
    request("render", { options: { reflow: true, highlights: ["term"] } }),
    request("generateHwpx", { input: { markdown: "# path-free" } }),
    request("patchHwpx", { input: { markdown: "edited" } }),
    request("fillHwpx", { input: { fields: { key: "value" } } }),
    request("validateHwpx", { options: { maxIssues: 5 } }),
    request("insertImage", { input: { anchorText: "anchor" } }),
  ];
  for (const value of requests) {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /(?:file|source|spool)[_-]?path|\bipc\b/iu);
  }
});

function createBuiltWorkerClient() {
  return createDocumentWorkerClient({
    workerFactory: (options) => new Worker(pathToFileURL(WORKER_ENTRY), options),
  });
}

function createBuiltChildClient() {
  return createChildClient(CHILD_ENTRY, []);
}

function createFixtureChildClient(...args: string[]) {
  return createChildClient(FIXTURE_CHILD, args);
}

function createChildClient(childEntry: string, childArguments: string[]) {
  return createDocumentChildClient({
    childEntry,
    childArguments,
    jobSupervisorFactory: async (child) => ({
      terminate: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        child.kill();
        await Promise.race([
          once(child, "exit"),
          new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
        ]);
        return child.exitCode !== null || child.signalCode !== null;
      },
    }),
  });
}

function request<Operation extends DocumentEngineOperation>(
  operation: Operation,
  overrides: {
    input?: Record<string, unknown>;
    options?: Record<string, unknown>;
  } = {},
): Extract<LogicalDocumentRequest, { operation: Operation }> {
  return {
    protocolVersion: 1,
    requestId: `operations-${operation}-${Math.random().toString(36).slice(2)}`,
    operation,
    input: overrides.input ?? {},
    options: overrides.options ?? {},
  } as Extract<LogicalDocumentRequest, { operation: Operation }>;
}

function workerSnapshot(buffer: ArrayBuffer): WorkerDocumentSnapshot {
  let taken = false;
  let cleaned = false;
  return {
    transport: "worker",
    metadata: Object.freeze({
      sizeBytes: buffer.byteLength,
      sha256: "0".repeat(64),
      candidateFormat: "unknown",
      protection: "unknown",
    }),
    takeTransferable(): ArrayBuffer {
      if (taken || cleaned) throw new Error("snapshot already consumed");
      taken = true;
      return buffer;
    },
    async cleanup(): Promise<void> {
      cleaned = true;
    },
  };
}

function spoolSnapshot(bytes: Uint8Array): {
  snapshot: SpoolDocumentSnapshot;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "gpt-codex-hwp-operation-"));
  const path = join(root, "input.bin");
  writeFileSync(path, bytes);
  const fd = openSync(path, "r");
  let taken = false;
  let cleaned = false;
  return {
    snapshot: {
      transport: "spool",
      metadata: Object.freeze({
        sizeBytes: bytes.byteLength,
        sha256: "0".repeat(64),
        candidateFormat: "unknown",
        protection: "unknown",
      }),
      takeSpoolHandle(): Readonly<{ fd: number; sizeBytes: number }> {
        if (taken || cleaned) throw new Error("snapshot already consumed");
        taken = true;
        return Object.freeze({ fd, sizeBytes: bytes.byteLength });
      },
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        closeSync(fd);
        rmSync(root, { recursive: true, force: true });
      },
    },
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  return exact.buffer;
}

function hasEngineCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}
