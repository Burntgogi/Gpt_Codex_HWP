import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";
import test from "node:test";

import {
  resolveLocalPath,
  setPermittedNetworkRoots,
} from "../src/shared/paths.js";

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

test("resolveLocalPath preserves normal Windows drive, relative, NFC, and NFD spellings", {
  skip: process.platform !== "win32",
}, () => {
  const filename = "한글-경로-é";
  const inputs = [
    join(resolve("tmp", "windows-path-safety"), `${filename.normalize("NFC")}.hwpx`),
    join(resolve("tmp", "windows-path-safety"), `${filename.normalize("NFD")}.hwpx`),
    ".\\relative-output.hwpx",
    "./relative-output.hwpx",
    "..\\sibling\\source.hwp",
    `${resolve("tmp")}\\..\\tmp\\dotted.hwpx`,
  ];

  for (const input of inputs) {
    const resolved = resolveLocalPath(input, "file_path");
    assert.equal(resolved, resolve(input));
    assert.equal(resolved.normalize("NFC") === resolved, resolve(input).normalize("NFC") === resolve(input));
    assert.equal(resolved.normalize("NFD") === resolved, resolve(input).normalize("NFD") === resolve(input));
  }
});

test("resolveLocalPath rejects Windows UNC paths unless an allowed root permits them", {
  skip: process.platform !== "win32",
}, (t) => {
  t.after(() => setPermittedNetworkRoots([]));
  const isNetworkRejection = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error &&
    error.code === "UNSAFE_LOCAL_PATH" && String(error).includes("network (UNC)");
  for (const input of ["\\\\server\\share\\한글 문서.hwpx", "//server/share/a.hwp"]) {
    assert.throws(() => resolveLocalPath(input, "file_path"), isNetworkRejection, input);
  }
  assert.equal(
    resolveLocalPath("\\\\server\\share\\docs", "root[0]", { allowNetwork: true }),
    "\\\\server\\share\\docs",
  );

  setPermittedNetworkRoots(["\\\\Server\\Share\\Docs"]);
  const permitted = "\\\\server\\share\\docs\\한글 문서.hwpx";
  assert.equal(resolveLocalPath(permitted, "file_path"), resolve(permitted));
  for (const input of ["\\\\server\\share\\other\\a.hwp", "\\\\server\\share\\docs-evil\\a.hwp"]) {
    assert.throws(() => resolveLocalPath(input, "file_path"), isNetworkRejection, input);
  }
});

test("resolveLocalPath expands Windows 8.3 short names that contain no links", {
  skip: process.platform !== "win32",
}, (t) => {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const shortForm = `${parsePath(programFiles).root}PROGRA~1`;
  let expanded: string;
  try {
    expanded = realpathSync.native(shortForm);
  } catch {
    t.skip("8.3 short names are disabled on this volume");
    return;
  }
  assert.equal(
    resolveLocalPath(`${shortForm}\\gpt-codex-hwp\\out.hwpx`, "output_path"),
    join(expanded, "gpt-codex-hwp", "out.hwpx"),
  );
  const missing = `${parsePath(programFiles).root}NOSUCH~9\\out.hwpx`;
  assert.equal(resolveLocalPath(missing, "output_path"), resolve(missing));
});

test("resolveLocalPath maps the macOS /tmp and /var system aliases into /private", {
  skip: process.platform !== "darwin",
}, () => {
  assert.equal(resolveLocalPath("/tmp/gpt-codex-hwp/out.hwpx", "output_path"), "/private/tmp/gpt-codex-hwp/out.hwpx");
  assert.equal(resolveLocalPath("/var/folders/x/out.hwpx", "output_path"), "/private/var/folders/x/out.hwpx");
  assert.equal(resolveLocalPath("/tmpfiles/out.hwpx", "output_path"), "/tmpfiles/out.hwpx");
});
