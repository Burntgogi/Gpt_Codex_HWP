import assert from "node:assert/strict";
import { access, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import test from "node:test";

import {
  assertSafeZipEntryName,
  prepareOutputPath,
  resolveLocalPath,
  resolveSourceAndOutputPaths,
} from "../src/shared/paths.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("resolveLocalPath rejects empty paths and resolves relative paths", () => {
  assert.throws(() => resolveLocalPath("", "source_path"), /source_path.*empty/i);
  assert.throws(() => resolveLocalPath("   ", "output_path"), /output_path.*empty/i);

  const resolved = resolveLocalPath("fixtures/document.hwpx", "source_path");
  assert.equal(resolved, resolve("fixtures/document.hwpx"));
  assert.equal(isAbsolute(resolved), true);
});

test("resolveLocalPath rejects ambiguous or device-backed Windows path syntax", {
  skip: process.platform !== "win32",
}, () => {
  const root = resolve("tmp", "windows-path-safety");
  const driveRoot = parsePath(root).root;
  const unsafePaths = [
    `${join(root, "source.hwpx")}:stream`,
    `\\\\?\\${join(root, "device.hwpx")}`,
    `\\\\.\\${driveRoot.slice(0, 2)}\\device.hwpx`,
    join(root, "CON.hwp"),
    join(root, "aux.txt"),
    join(root, "COM9"),
    join(root, "LPT1.preview.svg"),
    join(root, "CONIN$"),
    join(root, "trailing-dot.", "output.hwp"),
    join(root, "trailing-space ", "output.hwp"),
    join(root, "bad<name>.hwp"),
    join(root, "bad|name.hwp"),
    join(root, "control\u0001name.hwp"),
  ];

  for (const unsafePath of unsafePaths) {
    assert.throws(
      () => resolveLocalPath(unsafePath, "output_path"),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "UNSAFE_OUTPUT_PATH",
      unsafePath,
    );
  }
});

test("resolveLocalPath preserves normal Windows drive, UNC, NFC, and NFD spellings", {
  skip: process.platform !== "win32",
}, () => {
  const filename = "한글-경로-é";
  const inputs = [
    join(resolve("tmp", "windows-path-safety"), `${filename.normalize("NFC")}.hwpx`),
    join(resolve("tmp", "windows-path-safety"), `${filename.normalize("NFD")}.hwpx`),
    "\\\\server\\share\\한글 문서.hwpx",
  ];

  for (const input of inputs) {
    const resolved = resolveLocalPath(input, "file_path");
    assert.equal(resolved, resolve(input));
    assert.equal(resolved.normalize("NFC") === resolved, resolve(input).normalize("NFC") === resolve(input));
    assert.equal(resolved.normalize("NFD") === resolved, resolve(input).normalize("NFD") === resolve(input));
  }
});

test("assertSafeZipEntryName accepts package-relative entries", () => {
  assert.equal(
    assertSafeZipEntryName("Contents/section0.xml"),
    "Contents/section0.xml",
  );
  assert.equal(
    assertSafeZipEntryName("BinData\\image001.png"),
    "BinData/image001.png",
  );
});

test("assertSafeZipEntryName rejects empty, absolute, and traversal entries", () => {
  const unsafeNames = [
    "",
    "   ",
    "../secret.txt",
    "Contents/../secret.txt",
    "..\\secret.txt",
    "/absolute/path.xml",
    "C:/absolute/path.xml",
    "C:\\absolute\\path.xml",
    "\\\\server\\share\\file.xml",
    "Contents/\0section.xml",
  ];

  for (const name of unsafeNames) {
    assert.throws(() => assertSafeZipEntryName(name), /ZIP entry/i, name);
  }
});

test("source and output paths must be distinct", () => {
  const samePath = join(tmpdir(), "same-document.hwpx");
  assert.throws(
    () => resolveSourceAndOutputPaths(samePath, samePath),
    /source_path and output_path must be different/i,
  );

  if (process.platform === "win32") {
    assert.throws(
      () => resolveSourceAndOutputPaths(samePath, samePath.toUpperCase()),
      /source_path and output_path must be different/i,
    );
  }
});

test("prepareOutputPath creates only the output parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "hwp-paths-"));
  const sourcePath = join(root, "missing-source-parent", "source.hwpx");
  const outputPath = join(root, "created-output-parent", "nested", "result.hwpx");

  try {
    const resolved = await prepareOutputPath(sourcePath, outputPath);

    assert.deepEqual(resolved, {
      sourcePath: resolve(sourcePath),
      outputPath: resolve(outputPath),
    });
    assert.equal(await pathExists(dirname(resolved.sourcePath)), false);
    assert.equal(await pathExists(dirname(resolved.outputPath)), true);
    assert.equal(await pathExists(resolved.outputPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareOutputPath rejects a hard-link alias of the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "hwp-path-alias-"));
  const sourcePath = join(root, "source.hwpx");
  const outputPath = join(root, "output-alias.hwpx");

  try {
    await writeFile(sourcePath, "original document");
    await link(sourcePath, outputPath);

    await assert.rejects(
      prepareOutputPath(sourcePath, outputPath),
      /source_path and output_path must be different/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
