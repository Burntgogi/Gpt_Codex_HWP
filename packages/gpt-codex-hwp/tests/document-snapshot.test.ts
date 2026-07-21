import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { promisify } from "node:util";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);

import {
  WORKER_INPUT_MAX_BYTES,
  openDocumentSnapshot,
} from "../src/shared/document-snapshot.js";
import { applyWindowsOwnerOnlyAcl } from "../src/shared/windows-owner-only-acl.js";
import { MAX_DOCUMENT_BYTES } from "../src/shared/files.js";
import {
  copyToOwnedExactBytes,
  createBoundedCopyObserver,
  toOwnedExactBytes,
} from "../src/shared/owned-bytes.js";
import { MAX_WORKER_INPUT_BYTES } from "../src/workers/document-protocol.js";

test("owned bytes reuses an exact standalone ArrayBuffer without copying", () => {
  const input = new Uint8Array(new ArrayBuffer(4));
  input.set([1, 2, 3, 4]);
  const observed: number[] = [];

  const owned = toOwnedExactBytes(input, (copiedBytes) => {
    observed.push(copiedBytes);
  });

  assert.strictEqual(owned.bytes.buffer, input.buffer);
  assert.strictEqual(owned.transferable, input.buffer);
  assert.equal(owned.copiedBytes, 0);
  assert.deepEqual(observed, [0]);
  owned.bytes[1] = 9;
  assert.deepEqual([...new Uint8Array(owned.transferable)], [1, 9, 3, 4]);
});

test("owned bytes copies a pooled or offset Buffer exactly once", () => {
  const pool = Buffer.allocUnsafe(32);
  pool.fill(0);
  const input = pool.subarray(7, 12);
  input.set([5, 4, 3, 2, 1]);
  const observed: number[] = [];

  const owned = toOwnedExactBytes(input, (copiedBytes) => {
    observed.push(copiedBytes);
  });

  assert.notStrictEqual(owned.transferable, input.buffer);
  assert.equal(owned.transferable.byteLength, input.byteLength);
  assert.strictEqual(owned.bytes.buffer, owned.transferable);
  assert.equal(owned.bytes.byteOffset, 0);
  assert.equal(owned.bytes.byteLength, owned.transferable.byteLength);
  assert.equal(owned.copiedBytes, input.byteLength);
  assert.deepEqual(observed, [input.byteLength]);
  assert.deepEqual([...owned.bytes], [5, 4, 3, 2, 1]);

  input.fill(8);
  assert.deepEqual([...owned.bytes], [5, 4, 3, 2, 1]);
  owned.bytes[0] = 6;
  assert.deepEqual([...new Uint8Array(owned.transferable)], [6, 4, 3, 2, 1]);
});

test("owned bytes copies SharedArrayBuffer input into transferable ownership", () => {
  const shared = new SharedArrayBuffer(3);
  const input = new Uint8Array(shared);
  input.set([7, 8, 9]);
  const observed: number[] = [];

  const owned = toOwnedExactBytes(input, (copiedBytes) => {
    observed.push(copiedBytes);
  });

  assert.ok(owned.transferable instanceof ArrayBuffer);
  assert.notStrictEqual(owned.bytes.buffer, shared);
  assert.equal(owned.copiedBytes, 3);
  assert.deepEqual(observed, [3]);
  assert.deepEqual([...owned.bytes], [7, 8, 9]);
  input.fill(0);
  assert.deepEqual([...owned.bytes], [7, 8, 9]);
});

test("owned bytes accepts an exact ArrayBuffer directly", () => {
  const input = new ArrayBuffer(2);
  new Uint8Array(input).set([10, 11]);

  const owned = toOwnedExactBytes(input);

  assert.strictEqual(owned.transferable, input);
  assert.strictEqual(owned.bytes.buffer, input);
  assert.equal(owned.copiedBytes, 0);
});

test("owned bytes rejects invalid inputs and observers", () => {
  assert.throws(
    () => toOwnedExactBytes({ byteLength: 1 } as unknown as Uint8Array),
    { name: "TypeError", message: "input must be an ArrayBuffer or ArrayBuffer view." },
  );
  assert.throws(
    () => toOwnedExactBytes(new Uint8Array(1), 1 as unknown as (bytes: number) => void),
    { name: "TypeError", message: "copyObserver must be a function when provided." },
  );
});

test("owned bytes reports cumulative defensive copies through a bounded observer", () => {
  const observed: number[] = [];
  const copyObserver = createBoundedCopyObserver(
    5,
    (copiedBytes) => observed.push(copiedBytes),
  );
  const input = Buffer.allocUnsafe(8).subarray(2, 5);
  input.set([1, 2, 3]);

  const owned = copyToOwnedExactBytes(input, copyObserver);

  assert.equal(owned.copiedBytes, 3);
  assert.equal(owned.transferable.byteLength, 3);
  assert.deepEqual([...owned.bytes], [1, 2, 3]);
  assert.deepEqual(observed, [3]);
  assert.throws(() => copyObserver(3), RangeError);
  assert.throws(() => copyObserver(-1), RangeError);
  assert.deepEqual(observed, [3]);
});

test("document snapshot opens an exact worker buffer with frozen path-free metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-small-snapshot-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "private-name.hwpx");
  const bytes = Uint8Array.from([
    0x50, 0x4b, 0x03, 0x04, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74,
  ]);
  await writeFile(sourcePath, bytes);
  const allocations: number[] = [];
  const copies: number[] = [];

  const snapshot = await openDocumentSnapshot(sourcePath, {
    workerInputMaxBytes: bytes.byteLength,
    allocationObserver: (allocatedBytes) => allocations.push(allocatedBytes),
    copyObserver: (copiedBytes) => copies.push(copiedBytes),
  });
  t.after(async () => snapshot.cleanup());

  assert.equal(WORKER_INPUT_MAX_BYTES, MAX_WORKER_INPUT_BYTES);
  assert.equal(MAX_WORKER_INPUT_BYTES, 64 * 1024 * 1024);
  assert.equal(snapshot.transport, "worker");
  assert.deepEqual(allocations, [bytes.byteLength]);
  assert.deepEqual(copies, [0]);
  assert.deepEqual(snapshot.metadata, {
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
    shallowFormat: {
      candidate: "hwpx",
      container: "zip",
      exact: false,
    },
    protection: {
      status: "requires-engine-validation",
      candidateFormat: "hwpx",
      exact: false,
    },
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.metadata));
  assert.ok(Object.isFrozen(snapshot.metadata.shallowFormat));
  assert.ok(Object.isFrozen(snapshot.metadata.protection));
  const presented = JSON.stringify(snapshot.metadata);
  assert.doesNotMatch(presented, /private-name|hwp-small-snapshot|secret/iu);

  const transferable = snapshot.takeTransferable();
  assert.ok(transferable instanceof ArrayBuffer);
  assert.equal(transferable.byteLength, bytes.byteLength);
  assert.deepEqual([...new Uint8Array(transferable)], [...bytes]);
  assert.deepEqual([...await readFile(sourcePath)], [...bytes]);

  assert.throws(
    () => snapshot.takeTransferable(),
    (error: unknown) => {
      assert.equal(errorCode(error), "SNAPSHOT_TRANSFERRED");
      assert.equal(error instanceof Error ? error.message : "", "Document snapshot transport was already taken.");
      assert.doesNotMatch(JSON.stringify(errorDetails(error)), /private-name|secret|50,75/iu);
      return true;
    },
  );
  await snapshot.cleanup();
  await snapshot.cleanup();
});

test("document snapshot reports shallow HWP and unknown candidates without exact claims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-shallow-format-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cases = [
    {
      name: "candidate.hwp",
      bytes: Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      expected: { candidate: "hwp", container: "ole2", exact: false },
    },
    {
      name: "unknown.bin",
      bytes: Uint8Array.from([1, 2, 3, 4]),
      expected: { candidate: "unknown", container: "unknown", exact: false },
    },
  ] as const;

  for (const item of cases) {
    const path = join(root, item.name);
    await writeFile(path, item.bytes);
    const snapshot = await openDocumentSnapshot(path);
    assert.deepEqual(snapshot.metadata.shallowFormat, item.expected);
    assert.deepEqual(snapshot.metadata.protection, {
      status: "requires-engine-validation",
      candidateFormat: item.expected.candidate,
      exact: false,
    });
    await snapshot.cleanup();
  }
});

test("document snapshot rejects 512 MiB plus one from stat before allocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-snapshot-limit-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "oversized.hwpx");
  const handle = await open(sourcePath, "wx");
  try {
    await handle.truncate(MAX_DOCUMENT_BYTES + 1);
  } finally {
    await handle.close();
  }
  const allocations: number[] = [];
  let spoolCreations = 0;

  await assert.rejects(
    openDocumentSnapshot(sourcePath, {
      allocationObserver: (allocatedBytes) => allocations.push(allocatedBytes),
      testHooks: {
        spoolRoot: root,
        onSpoolCreated: () => {
          spoolCreations += 1;
        },
      },
    }),
    (error: unknown) => {
      assert.equal(errorCode(error), "FILE_SIZE_LIMIT");
      assert.doesNotMatch(error instanceof Error ? error.message : "", /oversized|hwp-snapshot-limit/iu);
      return true;
    },
  );
  assert.deepEqual(allocations, []);
  assert.equal(spoolCreations, 0);
});

test("document snapshot rejects a source identity replacement after its positional read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-snapshot-change-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "sensitive-source.hwpx");
  const movedPath = join(root, "moved.hwpx");
  const original = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  await writeFile(sourcePath, original);

  await assert.rejects(
    openDocumentSnapshot(sourcePath, {
      testHooks: {
        afterSourceRead: async () => {
          await rename(sourcePath, movedPath);
          await writeFile(sourcePath, Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]));
        },
      },
    }),
    (error: unknown) => {
      assert.equal(errorCode(error), "SOURCE_CHANGED");
      const diagnostic = error instanceof Error ? error.message : String(error);
      assert.equal(diagnostic, "Source document changed while its snapshot was opened.");
      assert.doesNotMatch(diagnostic, /sensitive-source|hwp-snapshot-change|50,75/iu);
      return true;
    },
  );
  assert.deepEqual([...await readFile(movedPath)], [...original]);
});

test("document snapshot rejects directories and redacts native path diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-snapshot-redaction-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    openDocumentSnapshot(root),
    (error: unknown) => {
      assert.equal(errorCode(error), "SNAPSHOT_OPEN_FAILED");
      const diagnostic = error instanceof Error ? error.message : String(error);
      assert.equal(diagnostic, "Could not open a safe document snapshot.");
      assert.doesNotMatch(diagnostic, /hwp-snapshot-redaction|AppData|Temp/iu);
      return true;
    },
  );
});

test("document snapshot rejects a FIFO without waiting for a writer", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-snapshot-fifo-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.fifo");
  await execFileAsync("mkfifo", [path], { timeout: 5_000, maxBuffer: 8_192 });
  const operation = openDocumentSnapshot(path);
  await assert.rejects(
    settleSnapshotWithoutBlocking(operation, path),
    (error: unknown) => errorCode(error) === "SNAPSHOT_OPEN_FAILED",
  );
});

test("document snapshot streams large input into an owner-only spool with an offset-zero fd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-snapshot-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "private-large.hwpx");
  const bytes = Uint8Array.from([
    0x50, 0x4b, 0x03, 0x04, 11, 22, 33, 44, 55, 66, 77, 88,
  ]);
  await writeFile(sourcePath, bytes);
  const allocations: number[] = [];
  const copies: number[] = [];
  let observedDirectory = "";
  let observedFile = "";

  const snapshot = await openDocumentSnapshot(sourcePath, {
    workerInputMaxBytes: 4,
    allocationObserver: (allocatedBytes) => allocations.push(allocatedBytes),
    copyObserver: (copiedBytes) => copies.push(copiedBytes),
    testHooks: {
      spoolRoot,
      onSpoolCreated: (spool) => {
        observedDirectory = spool.directoryPath;
        observedFile = spool.filePath;
      },
    },
  });
  t.after(async () => snapshot.cleanup());

  assert.equal(snapshot.transport, "spool");
  assert.deepEqual(allocations, [bytes.byteLength]);
  assert.deepEqual(copies, [0]);
  assert.deepEqual(snapshot.metadata, {
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
    shallowFormat: { candidate: "hwpx", container: "zip", exact: false },
    protection: { status: "requires-engine-validation", candidateFormat: "hwpx", exact: false },
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.metadata));
  assert.doesNotMatch(JSON.stringify(snapshot.metadata), /private-large|hwp-spool-snapshot|input\.bin/iu);

  const directoryStatus = await lstat(observedDirectory);
  const fileStatus = await lstat(observedFile);
  assert.ok(directoryStatus.isDirectory());
  assert.ok(fileStatus.isFile());
  if (process.platform !== "win32") {
    assert.equal(directoryStatus.mode & 0o077, 0);
    assert.equal(fileStatus.mode & 0o077, 0);
  }

  const transport = snapshot.takeSpoolHandle();
  assert.deepEqual(Object.keys(transport).sort(), ["fd", "sizeBytes"]);
  assert.ok(Object.isFrozen(transport));
  assert.equal(transport.sizeBytes, bytes.byteLength);
  const received = Buffer.alloc(bytes.byteLength);
  assert.equal(readSync(transport.fd, received, 0, received.byteLength, null), bytes.byteLength);
  assert.deepEqual([...received], [...bytes]);
  assert.throws(
    () => snapshot.takeSpoolHandle(),
    (error: unknown) => errorCode(error) === "SNAPSHOT_TRANSFERRED",
  );

  await snapshot.cleanup();
  await snapshot.cleanup();
  assert.deepEqual(await readdir(spoolRoot), []);
  assert.deepEqual([...await readFile(sourcePath)], [...bytes]);
});

test("document snapshot reports only fixed spool stages to a diagnostic test hook", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-stage-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]));
  const stages: string[] = [];
  const snapshot = await openDocumentSnapshot(sourcePath, {
    workerInputMaxBytes: 4,
    testHooks: {
      spoolRoot,
      onDiagnosticStage: (stage) => { stages.push(stage); },
    },
  });
  assert.deepEqual(stages, [
    "source-authorize", "source-open", "spool-directory-create",
    "spool-directory-acl",
    ...(process.platform === "win32"
      ? ["spool-directory-verify"]
      : []),
    "spool-file-create", "spool-file-acl",
    ...(process.platform === "win32"
      ? ["spool-file-verify"]
      : []),
    "spool-copy", "spool-sync", "spool-file-reacl",
    ...(process.platform === "win32"
      ? ["spool-file-reacl-verify"]
      : []),
    "spool-verify",
    "source-reauthorize", "source-verify",
  ]);
  await snapshot.cleanup();
});

test("document snapshot spool cleanup never deletes a replacement directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-replacement-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]));
  let spoolDirectory = "";
  let replacementSentinel = "";

  const snapshot = await openDocumentSnapshot(sourcePath, {
    workerInputMaxBytes: 4,
    testHooks: {
      spoolRoot,
      onSpoolCreated: (spool) => {
        spoolDirectory = spool.directoryPath;
      },
      beforeSpoolCleanup: async (spool) => {
        const displaced = `${spool.directoryPath}-displaced`;
        await rename(spool.directoryPath, displaced);
        await mkdir(spool.directoryPath);
        replacementSentinel = join(spool.directoryPath, "do-not-delete.txt");
        await writeFile(replacementSentinel, "replacement");
      },
    },
  });
  assert.equal(snapshot.transport, "spool");

  await assert.rejects(
    snapshot.cleanup(),
    (error: unknown) => {
      assert.equal(errorCode(error), "SNAPSHOT_CLEANUP_FAILED");
      const diagnostic = error instanceof Error ? error.message : String(error);
      assert.equal(diagnostic, "Could not safely clean up the private document spool.");
      assert.doesNotMatch(diagnostic, /hwp-spool-replacement|input\.bin|source\.hwpx/iu);
      return true;
    },
  );
  await assert.rejects(access(replacementSentinel));
  const preserved = [] as string[];
  for (const entry of await readdir(spoolRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(spoolRoot, entry.name, "do-not-delete.txt");
    try {
      await access(candidate);
      preserved.push(candidate);
    } catch {
      // This directory is not the quarantined replacement.
    }
  }
  assert.equal(preserved.length, 1);
  assert.equal(await readFile(preserved[0]!, "utf8"), "replacement");
  assert.ok(spoolDirectory.length > 0);
});

test("document snapshot removes a completed spool when the source changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-source-change-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "source.hwpx");
  const movedPath = join(root, "original.hwpx");
  await writeFile(sourcePath, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]));
  const observedPaths: string[] = [];

  await assert.rejects(
    openDocumentSnapshot(sourcePath, {
      workerInputMaxBytes: 4,
      testHooks: {
        spoolRoot,
        onSpoolCreated: (spool) => observedPaths.push(spool.directoryPath, spool.filePath),
        afterSourceRead: async () => {
          await rename(sourcePath, movedPath);
          await writeFile(sourcePath, Uint8Array.from([9, 9, 9, 9, 9]));
        },
      },
    }),
    (error: unknown) => {
      assert.equal(errorCode(error), "SOURCE_CHANGED");
      const diagnostic = error instanceof Error ? error.message : String(error);
      for (const path of observedPaths) assert.ok(!diagnostic.includes(path));
      assert.doesNotMatch(diagnostic, /source\.hwpx|input\.bin|50,75/iu);
      return true;
    },
  );
  assert.deepEqual(await readdir(spoolRoot), []);
});

test("document snapshot validates spool hooks without exposing runtime paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-options-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Uint8Array.from([1]));

  for (const options of [
    { workerInputMaxBytes: WORKER_INPUT_MAX_BYTES + 1 },
    { testHooks: 1 },
    { testHooks: { spoolRoot: "" } },
    { testHooks: { onSpoolCreated: 1 } },
    { testHooks: { beforeSpoolCleanup: 1 } },
    { testHooks: { afterSpoolFileUnlink: 1 } },
  ]) {
    await assert.rejects(
      openDocumentSnapshot(sourcePath, options as never),
      (error: unknown) => {
        assert.equal(errorCode(error), "SNAPSHOT_OPTIONS_INVALID");
        const diagnostic = error instanceof Error ? error.message : String(error);
        assert.equal(diagnostic, "Document snapshot options are invalid.");
        assert.ok(!diagnostic.includes(sourcePath));
        return true;
      },
    );
  }
});

test("document snapshot large-input allocation stays within one MiB", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-buffer-bound-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "source.hwpx");
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0x41);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  await writeFile(sourcePath, bytes);
  const allocations: number[] = [];

  const snapshot = await openDocumentSnapshot(sourcePath, {
    workerInputMaxBytes: 4,
    allocationObserver: (allocatedBytes) => allocations.push(allocatedBytes),
    testHooks: { spoolRoot },
  });
  assert.equal(snapshot.transport, "spool");
  assert.deepEqual(allocations, [1024 * 1024]);
  assert.equal(snapshot.metadata.sha256, sha256(bytes));
  await snapshot.cleanup();
  assert.deepEqual(await readdir(spoolRoot), []);
});

test("document snapshot cleans an owned spool when its creation observer fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-construction-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]));
  const observed: string[] = [];

  await assert.rejects(
    openDocumentSnapshot(sourcePath, {
      workerInputMaxBytes: 4,
      testHooks: {
        spoolRoot,
        onSpoolCreated: (spool) => {
          observed.push(spool.directoryPath, spool.filePath);
          throw new Error(`observer rejected ${spool.filePath} 50,75`);
        },
      },
    }),
    (error: unknown) => {
      assert.equal(errorCode(error), "SNAPSHOT_OPEN_FAILED");
      const diagnostic = error instanceof Error ? error.message : String(error);
      for (const path of observed) assert.ok(!diagnostic.includes(path));
      assert.doesNotMatch(diagnostic, /input\.bin|50,75|source\.hwpx/iu);
      return true;
    },
  );
  assert.deepEqual(await readdir(spoolRoot), []);
});

test("document snapshot implementation avoids concatenation and hidden full-buffer slices", async () => {
  const source = await readFile(
    new URL("../src/shared/document-snapshot.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /Buffer\.concat/gu);
  assert.doesNotMatch(source, /Uint8Array\.from\(snapshot\.bytes\)/gu);
  assert.doesNotMatch(source, /(?:buffer|transferable)\.slice\(/gu);
  assert.doesNotMatch(source, /rm\([^)]*recursive\s*:\s*true/gu);
});

test("document snapshot verifies the source after worker transfer with bounded memory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-snapshot-post-verify-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "private-source.hwpx");
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0x41);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  await writeFile(sourcePath, bytes);
  const allocations: number[] = [];
  const snapshot = await openDocumentSnapshot(sourcePath, {
    allocationObserver: (value) => allocations.push(value),
  });
  assert.equal(snapshot.transport, "worker");
  snapshot.takeTransferable();
  assert.ok(Object.keys(snapshot).includes("verifySourceUnchanged"));
  assert.doesNotMatch(JSON.stringify(Object.keys(snapshot)), /private-source|hwp-snapshot-post-verify/iu);

  await snapshot.verifySourceUnchanged();
  assert.deepEqual(allocations, [bytes.byteLength, 1024 * 1024]);
  await writeFile(sourcePath, Buffer.alloc(bytes.byteLength, 0x42));
  await assert.rejects(
    snapshot.verifySourceUnchanged(),
    (error: unknown) => {
      assert.equal(errorCode(error), "SOURCE_CHANGED");
      const diagnostic = error instanceof Error ? error.message : String(error);
      assert.equal(diagnostic, "Source document changed after its snapshot was opened.");
      assert.doesNotMatch(diagnostic, /private-source|hwp-snapshot-post-verify|41,41/iu);
      return true;
    },
  );
  await snapshot.cleanup();
});

test("document snapshot verifies the source after a spool handle is taken", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-post-verify-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]));
  const snapshot = await openDocumentSnapshot(sourcePath, {
    workerInputMaxBytes: 4,
    testHooks: { spoolRoot },
  });
  assert.equal(snapshot.transport, "spool");
  snapshot.takeSpoolHandle();
  await snapshot.verifySourceUnchanged();
  await snapshot.cleanup();
});

test("document snapshot cleanup retries an owned quarantine after file unlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-cleanup-retry-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]));
  let failures = 0;
  let originalDirectory = "";
  const snapshot = await openDocumentSnapshot(sourcePath, {
    workerInputMaxBytes: 4,
    testHooks: {
      spoolRoot,
      onSpoolCreated: (spool) => {
        originalDirectory = spool.directoryPath;
      },
      afterSpoolFileUnlink: async (spool) => {
        failures += 1;
        assert.notEqual(spool.directoryPath, originalDirectory);
        await assert.rejects(access(originalDirectory));
        throw new Error("first rmdir attempt fails");
      },
    },
  });

  await assert.rejects(snapshot.cleanup(), (error: unknown) => errorCode(error) === "SNAPSHOT_CLEANUP_FAILED");
  assert.equal(failures, 1);
  await snapshot.cleanup();
  assert.deepEqual(await readdir(spoolRoot), []);
});

test("document snapshot creates a protected Windows spool ACL", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-spool-acl-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const spoolRoot = join(root, "spools");
  await mkdir(spoolRoot);
  const sourcePath = join(root, "source.hwpx");
  await writeFile(sourcePath, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]));
  let directoryPath = "";
  let filePath = "";
  const snapshot = await openDocumentSnapshot(sourcePath, {
    workerInputMaxBytes: 4,
    testHooks: {
      spoolRoot,
      onSpoolCreated: (spool) => {
        directoryPath = spool.directoryPath;
        filePath = spool.filePath;
      },
    },
  });

  for (const path of [directoryPath, filePath]) {
    const acl = await readWindowsAcl(path);
    assert.equal(acl.protected, true);
    const allows = acl.rules.filter((rule) => rule.type === "Allow");
    assert.ok(allows.some((rule) => rule.sid === acl.currentSid && hasFullControl(rule.rights)));
    assert.ok(allows.every((rule) => rule.sid === acl.currentSid || rule.sid === "S-1-5-18"));
  }
  await snapshot.cleanup();
});

test("Windows owner-only ACL replacement removes a pre-existing explicit third-party ACE", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-acl-replace-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await execFileAsync("icacls.exe", [
    root,
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-32-545:(OI)(CI)F",
    "/q",
  ], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });

  assert.equal(await applyWindowsOwnerOnlyAcl(root, "directory"), "OK");
  const acl = await readWindowsAcl(root);
  assert.equal(acl.protected, true);
  assert.equal(acl.rules.length, 2);
  assert.deepEqual(
    new Set(acl.rules.map((rule) => rule.sid)),
    new Set([acl.currentSid, "S-1-5-18"]),
  );
  assert.ok(acl.rules.every((rule) => rule.type === "Allow" && hasFullControl(rule.rights)));
});

test("document snapshot Windows ACL verification avoids hosted-incompatible cmdlets", async () => {
  const source = await readFile(
    new URL("../src/shared/windows-owner-only-acl.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /Where-Object|ForEach-Object|ConvertTo-Json/u);
  assert.match(source, /foreach\(\$rule in \$rules/u);
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
    ? value.code
    : undefined;
}

function errorDetails(value: unknown): Record<string, unknown> {
  return value instanceof Error
    ? { name: value.name, message: value.message, code: errorCode(value) }
    : { value: String(value) };
}

interface WindowsAclReceipt {
  protected: boolean;
  currentSid: string;
  rules: Array<{ sid: string; type: string; rights: number }>;
}

async function readWindowsAcl(path: string): Promise<WindowsAclReceipt> {
  const script = [
    "$item=if([System.IO.Directory]::Exists($env:GPT_CODEX_HWP_TEST_ACL_PATH)){[System.IO.DirectoryInfo]::new($env:GPT_CODEX_HWP_TEST_ACL_PATH)}else{[System.IO.FileInfo]::new($env:GPT_CODEX_HWP_TEST_ACL_PATH)}",
    "$acl=$item.GetAccessControl()",
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "[Console]::Out.WriteLine(('protected={0}' -f $acl.AreAccessRulesProtected))",
    "[Console]::Out.WriteLine(('currentSid={0}' -f $sid))",
    "foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){[Console]::Out.WriteLine(('rule={0}|{1}|{2}' -f $rule.IdentityReference.Value,$rule.AccessControlType,[int64]$rule.FileSystemRights))}",
  ].join(";");
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, GPT_CODEX_HWP_TEST_ACL_PATH: path },
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  const lines = result.stdout.trim().split(/\r?\n/u);
  const protectedValue = lines.shift();
  const currentSidValue = lines.shift();
  if (protectedValue !== "protected=True" || !currentSidValue?.startsWith("currentSid=")) {
    throw new Error("invalid ACL receipt");
  }
  const rules = lines.map((line) => {
    const match = /^rule=(S-\d+(?:-\d+)+)\|(Allow|Deny)\|(-?[0-9]+)$/u.exec(line);
    if (match === null) throw new Error("invalid ACL rule receipt");
    return { sid: match[1], type: match[2], rights: Number(match[3]) };
  });
  return {
    protected: true,
    currentSid: currentSidValue.slice("currentSid=".length),
    rules,
  };
}

function hasFullControl(rights: number): boolean {
  return (rights & 0x1f01ff) === 0x1f01ff;
}

async function settleSnapshotWithoutBlocking<T>(
  operation: Promise<T>,
  fifoPath: string,
): Promise<T> {
  let timedOut = false;
  const timer = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error("FIFO snapshot open blocked"));
    }, 750).unref();
  });
  try {
    return await Promise.race([operation, timer]);
  } finally {
    if (timedOut) {
      const writer = await open(fifoPath, "w");
      await writer.close();
      await operation.catch(() => undefined);
    }
  }
}
