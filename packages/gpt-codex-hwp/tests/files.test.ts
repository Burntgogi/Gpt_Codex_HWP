import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  MAX_DOCUMENT_BYTES,
  readFileBounded,
} from "../src/shared/files.js";

test("bounded file read uses one exact allocation and preserves source bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-bounded-exact-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.bin");
  const expected = Buffer.from([1, 2, 3, 4, 5]);
  await writeFile(path, expected);
  const allocations: number[] = [];

  const actual = await readFileBounded(path, "test input", MAX_DOCUMENT_BYTES, {
    allocationObserver: (allocatedBytes) => allocations.push(allocatedBytes),
  });

  assert.ok(Buffer.isBuffer(actual));
  assert.equal(actual.byteOffset, 0);
  assert.equal(actual.buffer.byteLength, actual.byteLength);
  assert.deepEqual(allocations, [expected.byteLength]);
  assert.deepEqual([...actual], [...expected]);
  assert.deepEqual([...await readFile(path)], [...expected]);
});

test("bounded file read supports an empty exact buffer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-bounded-empty-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "empty.bin");
  await writeFile(path, new Uint8Array());
  const allocations: number[] = [];

  const actual = await readFileBounded(path, "empty input", 0, {
    allocationObserver: (allocatedBytes) => allocations.push(allocatedBytes),
  });

  assert.equal(actual.byteLength, 0);
  assert.equal(actual.buffer.byteLength, 0);
  assert.deepEqual(allocations, [0]);
});

test("bounded file read rejects 512 MiB plus one from stat before allocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-bounded-limit-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "oversized-private.bin");
  const handle = await open(path, "wx");
  try {
    await handle.truncate(MAX_DOCUMENT_BYTES + 1);
  } finally {
    await handle.close();
  }
  const allocations: number[] = [];

  await assert.rejects(
    readFileBounded(path, "source document", MAX_DOCUMENT_BYTES, {
      allocationObserver: (allocatedBytes) => allocations.push(allocatedBytes),
    }),
    (error: unknown) => {
      assert.equal(errorCode(error), "FILE_SIZE_LIMIT");
      assert.equal(
        error instanceof Error ? error.message : "",
        `source document exceeds the ${MAX_DOCUMENT_BYTES}-byte safety limit.`,
      );
      assert.doesNotMatch(error instanceof Error ? error.message : "", /oversized-private|hwp-bounded-limit/iu);
      return true;
    },
  );
  assert.deepEqual(allocations, []);
});

test("bounded file read accepts only regular files and redacts the path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-bounded-regular-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    readFileBounded(root, "source document"),
    (error: unknown) => {
      assert.equal(errorCode(error), "INVALID_FILE_TYPE");
      const diagnostic = error instanceof Error ? error.message : String(error);
      assert.equal(diagnostic, "source document must be a regular file.");
      assert.doesNotMatch(diagnostic, /hwp-bounded-regular|AppData|Temp/iu);
      return true;
    },
  );
});

for (const scenario of ["grow", "shrink", "replace", "delete"] as const) {
  test(`bounded file read rejects source ${scenario} after its positional read`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `hwp-bounded-${scenario}-`));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const path = join(root, "sensitive-source.bin");
    const moved = join(root, "moved.bin");
    const expected = Buffer.from("private document bytes", "utf8");
    await writeFile(path, expected);

    await assert.rejects(
      readFileBounded(path, "source document", MAX_DOCUMENT_BYTES, {
        testHooks: {
          afterSourceRead: async () => {
            if (scenario === "grow") await appendFile(path, Buffer.from([1]));
            if (scenario === "shrink") await truncate(path, expected.byteLength - 1);
            if (scenario === "replace") {
              await rename(path, moved);
              await writeFile(path, Buffer.alloc(expected.byteLength, 9));
            }
            if (scenario === "delete") await unlink(path);
          },
        },
      }),
      (error: unknown) => {
        assert.equal(errorCode(error), "SOURCE_CHANGED");
        const diagnostic = error instanceof Error ? error.message : String(error);
        assert.equal(diagnostic, "source document changed while it was read.");
        assert.doesNotMatch(diagnostic, /sensitive-source|private document bytes|hwp-bounded-/iu);
        return true;
      },
    );
  });
}

test("bounded file read redacts missing native paths and invalid option errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-bounded-errors-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const missing = join(root, "personal-secret-name.hwpx");

  await assert.rejects(
    readFileBounded(missing, "source document"),
    (error: unknown) => {
      assert.equal(errorCode(error), "ENOENT");
      const diagnostic = error instanceof Error ? error.message : String(error);
      assert.equal(diagnostic, "Could not read source document safely.");
      assert.ok(!diagnostic.includes(missing));
      return true;
    },
  );

  const path = join(root, "source.bin");
  await writeFile(path, Buffer.from([1]));
  await assert.rejects(
    readFileBounded(path, "source document", MAX_DOCUMENT_BYTES, {
      allocationObserver: 1 as never,
    }),
    (error: unknown) => {
      assert.equal(errorCode(error), "INVALID_READ_OPTIONS");
      assert.equal(error instanceof Error ? error.message : "", "Bounded file read options are invalid.");
      return true;
    },
  );
});

test("bounded file read source has no chunk list, concatenation, or full-copy slice", async () => {
  const source = await readFile(
    new URL("../src/shared/files.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /Buffer\.concat/gu);
  assert.doesNotMatch(source, /chunks\s*:/gu);
  assert.doesNotMatch(source, /const\s+chunks\b/gu);
  assert.doesNotMatch(source, /(?:buffer|bytes)\.slice\(/gu);
  assert.match(source, /O_NONBLOCK/gu);
});

test("bounded file read rejects a FIFO without waiting for a writer", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-bounded-fifo-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.fifo");
  await execFileAsync("mkfifo", [path], { timeout: 5_000, maxBuffer: 8_192 });
  const result = readFileBounded(path, "source document");
  await assert.rejects(
    settleWithoutBlocking(result, path),
    (error: unknown) => errorCode(error) === "INVALID_FILE_TYPE",
  );
});

function errorCode(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
    ? value.code
    : undefined;
}

async function settleWithoutBlocking<T>(operation: Promise<T>, fifoPath: string): Promise<T> {
  let timedOut = false;
  const timer = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error("FIFO read blocked"));
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
