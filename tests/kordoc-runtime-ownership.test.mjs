import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { buildKordocCoreRuntime, verifyKordocCoreRuntime } from "../scripts/kordoc-core-runtime.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("Kordoc output creation race never deletes an unowned sentinel", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-kordoc-ownership-"));
  const tarballPath = join(temporaryRoot, "kordoc.tgz");
  const outputRoot = join(temporaryRoot, "vendor-output");
  const sentinelPath = join(outputRoot, "unowned-sentinel.txt");
  const archive = syntheticKordocArchive();
  const expectedSource = Object.freeze({
    name: "kordoc",
    version: "3.18.1",
    resolved: "https://example.invalid/kordoc-3.18.1.tgz",
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  });
  await writeFile(tarballPath, archive);
  let barrierEntered = false;
  const createOutput = async (path) => {
    assert.equal(path, outputRoot);
    barrierEntered = true;
    await mkdir(path);
    await writeFile(sentinelPath, "unowned sentinel\n", "utf8");
    const error = new Error("injected exclusive-create collision");
    error.code = "EEXIST";
    throw error;
  };

  try {
    await assert.rejects(
      buildKordocCoreRuntime({
        tarballPath,
        outputRoot,
        expectedSource,
        fileSystem: { createOutput },
      }),
      (error) => error?.code === "EEXIST" && /exclusive-create collision/u.test(error.message),
    );
    assert.equal(barrierEntered, true);
    assert.equal(await readFile(sentinelPath, "utf8"), "unowned sentinel\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Kordoc builder remains compatible without a file-system hook", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-kordoc-default-"));
  const tarballPath = join(temporaryRoot, "kordoc.tgz");
  const outputRoot = join(temporaryRoot, "vendor-output");
  const archive = syntheticKordocArchive();
  const expectedSource = Object.freeze({
    name: "kordoc",
    version: "3.18.1",
    resolved: "https://example.invalid/kordoc-3.18.1.tgz",
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  });
  await writeFile(tarballPath, archive);
  let stage = "BUILD";
  const diagnosticStages = [];
  try {
    const built = await buildKordocCoreRuntime({
      tarballPath,
      outputRoot,
      expectedSource,
      onDiagnosticStage: (value) => {
        diagnosticStages.push(value);
        stage = value.toUpperCase().replaceAll("-", "_");
      },
    });
    stage = "VERIFY";
    const verified = await verifyKordocCoreRuntime(outputRoot, expectedSource);
    stage = "COMPARE";
    assert.deepEqual(verified, built);
    assert.equal(diagnosticStages.at(-1), "verify");
  } catch {
    throw new Error(`KORDOC_DEFAULT_${stage}`);
  } finally {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch {
      throw new Error("KORDOC_DEFAULT_CLEANUP");
    }
  }
});

test("Kordoc verifier bounds files and empty directories in one streamed entry budget", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-kordoc-entry-budget-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const vendor = join(temporaryRoot, "vendor");
  await cp(join(ROOT, "packages", "gpt-codex-hwp", "vendor", "kordoc-core"), vendor, {
    recursive: true,
  });
  const directoryRoot = join(vendor, "dist", "empty-directories");
  await mkdir(directoryRoot);
  for (let index = 0; index < 513; index += 1) {
    await mkdir(join(directoryRoot, `entry-${String(index).padStart(3, "0")}`));
  }
  await assert.rejects(
    verifyKordocCoreRuntime(vendor),
    /tree exceeds the entry limit/u,
  );
});

test("shared Kordoc verifier rejects every pinned provenance and tree-record deviation", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-kordoc-provenance-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const vendor = join(temporaryRoot, "vendor");
  await cp(join(ROOT, "packages", "gpt-codex-hwp", "vendor", "kordoc-core"), vendor, {
    recursive: true,
  });
  const provenancePath = join(vendor, "PROVENANCE.json");
  const original = JSON.parse(await readFile(provenancePath, "utf8"));
  const scenarios = [
    ["schema", (value) => { value.schemaVersion = 1; }],
    ["generator", (value) => { delete value.generatorVersion; }],
    ["resolved source", (value) => { value.source.resolved = "https://example.invalid/kordoc.tgz"; }],
    ["source integrity", (value) => { value.source.integrity = `sha512-${"A".repeat(88)}`; }],
    ["archive integrity", (value) => { value.archive.sha512 = `sha512-${"B".repeat(88)}`; }],
    ["archive extra field", (value) => { value.archive.unexpected = true; }],
    ["duplicate file record", (value) => { value.files.splice(1, 0, structuredClone(value.files[0])); }],
    ["reordered file records", (value) => { value.files.reverse(); }],
    ["missing file record", (value) => { value.files.pop(); }],
  ];
  for (const [label, mutate] of scenarios) {
    const changed = structuredClone(original);
    mutate(changed);
    await writeFile(provenancePath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
    await assert.rejects(
      verifyKordocCoreRuntime(vendor),
      undefined,
      `accepted ${label} deviation`,
    );
  }
  await writeFile(provenancePath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  await verifyKordocCoreRuntime(vendor);
});

function syntheticKordocArchive() {
  const packageJson = JSON.stringify({
    name: "kordoc",
    version: "3.18.1",
    description: "Synthetic ownership-race fixture",
    type: "module",
    main: "dist/index.js",
    module: "dist/index.js",
    types: "dist/index.d.ts",
    files: ["dist"],
    engines: { node: ">=22" },
    author: "Kordoc contributors",
    license: "MIT",
    repository: { url: "https://github.com/chrisryugj/kordoc.git" },
  });
  const entries = [
    tarEntry("package/package.json", `${packageJson}\n`),
    tarEntry("package/LICENSE", "MIT License\n"),
    tarEntry("package/README.md", "# Synthetic Kordoc\n"),
    tarEntry("package/dist/index.js", "export const synthetic = true;\n"),
    tarEntry("package/dist/index.d.ts", "export declare const synthetic: true;\n"),
  ];
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function tarEntry(name, content) {
  const bytes = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  writeTarString(header, name, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, bytes.length, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function writeTarString(buffer, value, offset, length) {
  const bytes = Buffer.from(value, "utf8");
  assert.ok(bytes.length <= length, `tar field too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, "0");
  assert.ok(text.length < length, `tar octal field too long: ${value}`);
  buffer.write(text, offset, text.length, "ascii");
  buffer[offset + length - 1] = 0;
}
