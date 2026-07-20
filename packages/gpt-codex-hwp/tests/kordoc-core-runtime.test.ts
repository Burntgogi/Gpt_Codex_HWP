import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  KORDOC_LIMITS,
  KORDOC_SOURCE,
  assertArchiveFileSizeForTest,
  buildKordocCoreRuntime,
  inspectKordocArchiveForTest,
  verifyKordocCoreRuntime,
} from "../../../scripts/kordoc-core-runtime.mjs";
import { assertCompactLockfile } from "../release-scripts/compact-policy.mjs";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(TEST_ROOT, "..");
const VENDOR_ROOT = join(SOURCE_ROOT, "vendor", "kordoc-core");

test("authenticated Kordoc archive generation is deterministic and source maps are excluded", async (t) => {
  t.diagnostic("KORDOC_KC01_STAGE_SETUP");
  const root = await mkdtemp(join(tmpdir(), "kordoc-core-generator-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  const tarballPath = join(root, "kordoc.tgz");
  const map = ["{\"sources\":[\"", "/Us", "ers/sample/source.ts", "\"]}\n"].join("");
  const tarball = createTestPackageArchive([
    ["package/package.json", JSON.stringify(testKordocPackage())],
    ["package/LICENSE", "MIT test license\n"],
    ["package/README.md", "# Test Kordoc\n"],
    ["package/dist/index.js", "export const ok = true;\n"],
    ["package/dist/index.js.map", map],
  ]);
  await writeFile(tarballPath, tarball);
  const expectedSource = testSource(tarball);

  t.diagnostic("KORDOC_KC01_STAGE_FIRST_BUILD");
  const generated = await buildKordocCoreRuntime({
    tarballPath,
    outputRoot: first,
    expectedSource,
    onDiagnosticStage: (stage) => {
      t.diagnostic(`KORDOC_KC01_BUILD_STAGE_${stage.toUpperCase().replaceAll("-", "_")}`);
    },
  });
  t.diagnostic("KORDOC_KC01_STAGE_SECOND_BUILD");
  await buildKordocCoreRuntime({ tarballPath, outputRoot: second, expectedSource });

  t.diagnostic("KORDOC_KC01_STAGE_GENERATED_ASSERTIONS");
  assert.equal(generated.schemaVersion, 2);
  assert.equal(generated.generatorVersion, 2);
  assert.equal(generated.archive.sha512, expectedSource.integrity);
  t.diagnostic("KORDOC_KC01_STAGE_PACKAGE_ASSERTIONS");
  const packageJson = JSON.parse(await readFile(join(first, "package.json"), "utf8"));
  assert.equal(packageJson.name, "kordoc");
  assert.equal(packageJson.version, "3.18.1");
  assert.equal(packageJson.optionalDependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts, undefined);
  assert.equal(packageJson.bin, undefined);
  t.diagnostic("KORDOC_KC01_STAGE_LAYOUT_ASSERTIONS");
  assert.deepEqual(
    (await readdir(first)).sort(),
    ["dist", "LICENSE", "package.json", "PROVENANCE.json", "README.md"].sort(),
  );
  assert.equal(await exists(join(first, "dist", "index.js.map")), false);
  assert.equal((await readFile(join(first, "PROVENANCE.json"), "utf8")).includes(map), false);
  t.diagnostic("KORDOC_KC01_STAGE_PROVENANCE_ASSERTIONS");
  assert.deepEqual(
    JSON.parse(await readFile(join(first, "PROVENANCE.json"), "utf8")),
    JSON.parse(await readFile(join(second, "PROVENANCE.json"), "utf8")),
  );
  t.diagnostic("KORDOC_KC01_STAGE_VERIFY_FIRST");
  await verifyKordocCoreRuntime(first, expectedSource);
  t.diagnostic("KORDOC_KC01_STAGE_VERIFY_SECOND");
  await verifyKordocCoreRuntime(second, expectedSource);
  t.diagnostic("KORDOC_KC01_STAGE_BODY_COMPLETE");
});

test("tampered Kordoc archive is rejected before output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kordoc-core-integrity-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const tarballPath = join(root, "kordoc.tgz");
  const original = createTestPackageArchive([
    ["package/package.json", JSON.stringify(testKordocPackage())],
    ["package/LICENSE", "MIT\n"],
    ["package/README.md", "# Kordoc\n"],
    ["package/dist/index.js", "export const original = true;\n"],
  ]);
  const expectedSource = testSource(original);
  const tampered = Uint8Array.from(original);
  tampered[tampered.length - 1] ^= 1;
  await writeFile(tarballPath, tampered);
  const outputRoot = join(root, "output");

  await assert.rejects(
    buildKordocCoreRuntime({ tarballPath, outputRoot, expectedSource }),
    /integrity/iu,
  );
  assert.equal(await exists(outputRoot), false);
});

test("authenticated Kordoc archive rejects non-regular tar entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kordoc-core-tar-type-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const tarballPath = join(root, "kordoc.tgz");
  const tarball = createTestPackageArchive([
    ["package/package.json", JSON.stringify(testKordocPackage())],
    ["package/LICENSE", "MIT\n"],
    ["package/README.md", "# Kordoc\n"],
    ["package/dist/index.js", "export {};\n"],
    ["package/dist/linked.js", "target", "2"],
  ]);
  await writeFile(tarballPath, tarball);

  await assert.rejects(
    buildKordocCoreRuntime({
      tarballPath,
      outputRoot: join(root, "output"),
      expectedSource: testSource(tarball),
    }),
    /tar entry.*regular|non-regular/iu,
  );
});

test("authenticated Kordoc archive size guard accepts its boundary and rejects plus one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kordoc-core-size-guard-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const exact = join(root, "exact.tgz");
  const over = join(root, "over.tgz");
  await writeFile(exact, Buffer.alloc(1024));
  await writeFile(over, Buffer.alloc(1025));

  await assert.doesNotReject(assertArchiveFileSizeForTest(exact, 1024));
  await assert.rejects(assertArchiveFileSizeForTest(over, 1024), /compressed size limit/iu);
  assert.deepEqual(KORDOC_LIMITS, {
    archiveBytes: 32 * 1024 * 1024,
    expandedBytes: 64 * 1024 * 1024,
    entryBytes: 16 * 1024 * 1024,
    entries: 512,
  });
});

test("authenticated Kordoc tar parser rejects checksum, paths, duplicates, types, and termination corruption", async (t) => {
  const normalEntries: TestTarEntry[] = [
    ["package/package.json", JSON.stringify(testKordocPackage())],
    ["package/LICENSE", "MIT\n"],
    ["package/README.md", "# Kordoc\n"],
    ["package/dist/index.js", "export {};\n"],
  ];

  await t.test("checksum corruption", () => {
    const raw = createRawTestPackageTar(normalEntries);
    raw[0] ^= 1;
    assert.throws(() => inspectKordocArchiveForTest(gzipSync(raw)), /checksum/iu);
  });
  await t.test("traversal", () => {
    const raw = createRawTestPackageTar([...normalEntries, ["package/dist/../escape.js", "bad"]]);
    assert.throws(() => inspectKordocArchiveForTest(gzipSync(raw)), /package-relative tar path/iu);
  });
  await t.test("duplicate path", () => {
    const raw = createRawTestPackageTar([...normalEntries, normalEntries[3]!]);
    assert.throws(() => inspectKordocArchiveForTest(gzipSync(raw)), /duplicate tar entry/iu);
  });
  for (const [name, type] of [["hardlink", "1"], ["character device", "3"], ["block device", "4"]] as const) {
    await t.test(name, () => {
      const raw = createRawTestPackageTar([...normalEntries, ["package/dist/unsafe", "", type]]);
      assert.throws(() => inspectKordocArchiveForTest(gzipSync(raw)), /regular file/iu);
    });
  }
  await t.test("single zero terminator", () => {
    const raw = createRawTestPackageTar(normalEntries).subarray(0, -512);
    assert.throws(() => inspectKordocArchiveForTest(gzipSync(raw)), /two zero|terminator/iu);
  });
  await t.test("truncated entry", () => {
    const raw = createRawTestPackageTar(normalEntries).subarray(0, 512 + 5);
    assert.throws(() => inspectKordocArchiveForTest(gzipSync(raw)), /extent|terminator|truncated/iu);
  });
  await t.test("non-zero trailing bytes", () => {
    const raw = Buffer.concat([createRawTestPackageTar(normalEntries), Buffer.from([1])]);
    assert.throws(() => inspectKordocArchiveForTest(gzipSync(raw)), /non-zero data/iu);
  });
});

test("authenticated Kordoc tar parser enforces exact configurable resource boundaries", () => {
  const entries: TestTarEntry[] = [
    ["package/package.json", JSON.stringify(testKordocPackage())],
    ["package/LICENSE", "MIT\n"],
    ["package/README.md", "R"],
    ["package/dist/index.js", "X"],
  ];
  const raw = createRawTestPackageTar(entries);
  const archive = gzipSync(raw);
  const largestEntry = Math.max(...entries.map(([, contents]) => Buffer.byteLength(contents)));
  const exact = {
    archiveBytes: archive.length,
    expandedBytes: raw.length,
    entryBytes: largestEntry,
    entries: entries.length,
  };
  assert.doesNotThrow(() => inspectKordocArchiveForTest(archive, exact));
  assert.throws(
    () => inspectKordocArchiveForTest(archive, { ...exact, expandedBytes: raw.length - 1 }),
    /expanded size limit/iu,
  );
  assert.throws(
    () => inspectKordocArchiveForTest(archive, { ...exact, entryBytes: largestEntry - 1 }),
    /entry.*size/iu,
  );
  assert.throws(
    () => inspectKordocArchiveForTest(archive, { ...exact, entries: entries.length - 1 }),
    /entry limit/iu,
  );
});

test("committed Kordoc verifier rejects a provenance-blessed source map", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kordoc-core-map-verifier-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const vendor = join(root, "vendor");
  await cp(VENDOR_ROOT, vendor, { recursive: true });
  const mapPath = join(vendor, "dist", "injected.js.map");
  const mapBytes = Buffer.from(["{\"sources\":[\"", "/Us", "ers/sample/source.ts", "\"]}\n"].join(""));
  await writeFile(mapPath, mapBytes);
  const provenancePath = join(vendor, "PROVENANCE.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  provenance.files.push({
    path: "dist/injected.js.map",
    size: mapBytes.length,
    sha256: createHash("sha256").update(mapBytes).digest("hex"),
  });
  provenance.files.sort((left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path, "en"));
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  await assert.rejects(verifyKordocCoreRuntime(vendor), /source map|\.map/iu);
});

test("the compact dependency graph excludes unused Kordoc format engines", async () => {
  const packageJson = JSON.parse(await readFile(join(SOURCE_ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(SOURCE_ROOT, "package-lock.json"), "utf8"));
  assert.equal(packageJson.dependencies.kordoc, "file:vendor/kordoc-core");
  assert.ok(lock.packages["vendor/kordoc-core"]);
  assert.doesNotThrow(() => assertCompactLockfile(lock));
  const excluded = [
    "node_modules/@huggingface/transformers",
    "node_modules/onnxruntime-node",
    "node_modules/onnxruntime-web",
    "node_modules/@hyzyla/pdfium",
    "node_modules/pdfjs-dist",
    "node_modules/boolean",
  ];
  for (const path of excluded) assert.equal(lock.packages[path], undefined, `${path} must be absent`);
});

test("nested excluded package records make compact lock validation fail closed", () => {
  assert.doesNotThrow(() => assertCompactLockfile({
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/pdfjs-dist-extra": {} },
  }));
  assert.throws(() => assertCompactLockfile({
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/a/node_modules/pdfjs-dist": {} },
  }), /pdfjs-dist/iu);
  assert.throws(() => assertCompactLockfile({ lockfileVersion: 3 }), /packages/iu);
  assert.throws(() => assertCompactLockfile({ packages: [] }), /packages/iu);
});

test("the committed Kordoc Core runtime matches its provenance", async () => {
  await verifyKordocCoreRuntime(VENDOR_ROOT);
});

type TestTarEntry = readonly [path: string, contents: string, type?: string];

function testKordocPackage(): Record<string, unknown> {
  return {
    name: "kordoc",
    version: "3.18.1",
    description: "test package",
    type: "module",
    exports: { ".": "./dist/index.js" },
    main: "./dist/index.js",
    module: "./dist/index.js",
    types: "./dist/index.d.ts",
    files: ["dist"],
    dependencies: {},
    engines: { node: ">=18" },
    author: "test",
    license: "MIT",
    repository: { type: "git", url: "https://github.com/chrisryugj/kordoc.git" },
  };
}

function testSource(tarball: Uint8Array): {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
} {
  return {
    ...KORDOC_SOURCE,
    resolved: "https://registry.example.invalid/kordoc-3.18.1.tgz",
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  };
}

function createTestPackageArchive(entries: readonly TestTarEntry[]): Uint8Array {
  return gzipSync(createRawTestPackageTar(entries), { mtime: 0 });
}

function createRawTestPackageTar(entries: readonly TestTarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const [path, contents, type = "0"] of entries) {
    const data = Buffer.from(contents, "utf8");
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    writeTarOctal(header, 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, data.length, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    writeTarOctal(header, header.reduce((sum, byte) => sum + byte, 0), 148, 8);
    chunks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  buffer.write(encoded, offset, length, "ascii");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
