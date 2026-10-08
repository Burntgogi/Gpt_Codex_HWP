import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";
import test from "node:test";

import {
  permitDerivedNetworkPath,
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

test("resolveLocalPath rejects an unpermitted UNC path before touching the filesystem", {
  skip: process.platform !== "win32",
}, async (t) => {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const { syncBuiltinESMExports } = createRequire(import.meta.url)("node:module") as typeof import("node:module");
  const touched: string[] = [];
  const originalLstat = fs.lstatSync;
  const originalRealpath = fs.realpathSync.native;
  fs.lstatSync = ((path: string, ...rest: unknown[]) => {
    touched.push(String(path));
    return (originalLstat as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.lstatSync;
  fs.realpathSync.native = ((path: string, ...rest: unknown[]) => {
    touched.push(String(path));
    return (originalRealpath as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.realpathSync.native;
  syncBuiltinESMExports();
  t.after(() => {
    fs.lstatSync = originalLstat;
    fs.realpathSync.native = originalRealpath;
    syncBuiltinESMExports();
  });

  assert.throws(
    () => resolveLocalPath("\\\\attacker.invalid\\share\\A~1\\x.hwpx", "file_path"),
    (error: unknown) => String(error).includes("network (UNC)"),
  );
  assert.deepEqual(touched.filter((path) => path.toLowerCase().includes("attacker.invalid")), []);
});

test("a mapped drive's canonical UNC share is accepted only after its drive spelling resolved to it", {
  skip: process.platform !== "win32",
}, () => {
  const share = "\\\\nas-mapped-test\\team";
  assert.throws(() => resolveLocalPath(`${share}\\docs\\a.hwpx`, "file_path"), /network \(UNC\)/u);
  permitDerivedNetworkPath(`${share}\\docs\\a.hwpx`, `${share}\\docs\\a.hwpx`);
  assert.throws(() => resolveLocalPath(`${share}\\docs\\a.hwpx`, "file_path"), /network \(UNC\)/u,
    "a UNC spelling cannot grant itself access");
  permitDerivedNetworkPath("Z:\\docs\\a.hwpx", `${share}\\docs\\a.hwpx`);
  assert.equal(resolveLocalPath(`${share}\\other\\b.hwpx`, "file_path"), `${share}\\other\\b.hwpx`);
  for (const label of ["output_path", "output_dir", "output_svg_path"]) {
    assert.throws(() => resolveLocalPath(`${share}\\out.hwpx`, label), /network \(UNC\)/u,
      `a share reached through a mapped drive is not writable (${label})`);
  }
  assert.throws(() => resolveLocalPath("\\\\nas-mapped-test\\other-share\\c.hwpx", "file_path"), /network \(UNC\)/u);
});

test("the unrestricted policy re-authorizes a mapped drive's UNC realpath", {
  skip: process.platform !== "win32",
}, async (t) => {
  const require = createRequire(import.meta.url);
  const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  const { syncBuiltinESMExports } = require("node:module") as typeof import("node:module");
  const { authorizeExistingPath, resetActiveAllowedRootsPolicy } = await import("../src/shared/allowed-roots.js");
  resetActiveAllowedRootsPolicy();
  const mapped = "Q:\\mapped-wire-test\\a.hwpx";
  const canonical = "\\\\nas-wire-test\\team\\mapped-wire-test\\a.hwpx";
  const originalRealpath = fsPromises.realpath;
  // Answer both spellings here so the test never resolves the made-up host.
  fsPromises.realpath = (async (path: string) => {
    const lowered = String(path).toLowerCase();
    if (lowered === mapped.toLowerCase() || lowered === canonical.toLowerCase()) return canonical;
    return originalRealpath(path);
  }) as typeof fsPromises.realpath;
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.realpath = originalRealpath;
    syncBuiltinESMExports();
  });

  assert.throws(() => resolveLocalPath(canonical, "file_path"), /network \(UNC\)/u,
    "before the drive spelling resolves, the share is not permitted");
  assert.equal(await authorizeExistingPath(mapped), canonical);
  assert.equal(await authorizeExistingPath(canonical), canonical,
    "the snapshot's re-authorization of the canonical spelling succeeds");
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
