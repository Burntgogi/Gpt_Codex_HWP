import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import JSZip from "jszip";
import { markdownToHwpx } from "kordoc";

import {
  MAX_DOCUMENT_BYTES,
  readFileBounded,
} from "../src/shared/files.js";
import { inspectExactHwpxProtection } from "../src/shared/protection.js";
import {
  assertClassicZipEntryBudget,
  loadBoundedHwpxZip,
} from "../src/shared/zip-preflight.js";

type XmlEncoding = "utf8" | "utf16le" | "utf16be";

test("the default document ceiling remains 512 MiB", () => {
  assert.equal(MAX_DOCUMENT_BYTES, 512 * 1024 * 1024);
});

function encodeXml(xml: string, encoding: XmlEncoding): Uint8Array {
  if (encoding === "utf8") {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, "utf8")]);
  }
  const littleEndian = Buffer.from(xml, "utf16le");
  if (encoding === "utf16le") {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]);
  }
  const bigEndian = Buffer.from(littleEndian);
  for (let index = 0; index < bigEndian.length; index += 2) {
    [bigEndian[index], bigEndian[index + 1]] = [bigEndian[index + 1]!, bigEndian[index]!];
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]);
}

async function hwpxWithProtectionManifest(manifest: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await markdownToHwpx("보호 정책 검사"));
  zip.file("META-INF/manifest.xml", manifest);
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

test("bounded file reads reject growth beyond the caller's byte limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-bounded-read-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "large.bin");
  await writeFile(path, Buffer.alloc(9, 1));

  await assert.rejects(
    readFileBounded(path, "test input", 8),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "FILE_SIZE_LIMIT");
      return true;
    },
  );
  await access(path);
});

test("exact HWPX inspection accepts a normal package and rejects an extreme compression ratio", async () => {
  const normal = new Uint8Array(await markdownToHwpx("정상 문서"));
  assert.equal(await inspectExactHwpxProtection(normal), undefined);

  const zip = new JSZip();
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  zip.file("Contents/content.hpf", "A".repeat(8 * 1024 * 1024));
  const bomb = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const issue = await inspectExactHwpxProtection(bomb);
  assert.equal(issue?.code, "INVALID_HWPX_PROTECTION_METADATA");
  assert.match(issue?.error ?? "", /compression ratio/iu);
});

for (const encoding of ["utf8", "utf16le", "utf16be"] as const) {
  test(`exact HWPX inspection rejects ${encoding} distribution protection metadata`, async () => {
    const declaration = encoding === "utf8" ? "UTF-8" : "UTF-16";
    const manifest = encodeXml(
      `<?xml version="1.0" encoding="${declaration}"?><manifest><distribution/></manifest>`,
      encoding,
    );
    const issue = await inspectExactHwpxProtection(
      await hwpxWithProtectionManifest(manifest),
    );
    assert.equal(issue?.code, "DRM_PROTECTED");
  });
}

test("exact HWPX inspection fails closed for malformed and unsupported protection XML", async () => {
  const malformed = await inspectExactHwpxProtection(
    await hwpxWithProtectionManifest(
      encodeXml("<?xml version=\"1.0\"?><manifest><distribution>", "utf8"),
    ),
  );
  assert.equal(malformed?.code, "INVALID_HWPX_PROTECTION_METADATA");

  const utf32 = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x00, 0x00]),
    Buffer.from("<manifest/>", "utf16le"),
  ]);
  const unsupported = await inspectExactHwpxProtection(
    await hwpxWithProtectionManifest(utf32),
  );
  assert.equal(unsupported?.code, "INVALID_HWPX_PROTECTION_METADATA");
});

test("exact HWPX inspection rejects case-equivalent duplicate protection manifests", async () => {
  const zip = await JSZip.loadAsync(await markdownToHwpx("중복 매니페스트"));
  zip.file("meta-inf/MANIFEST.XML", "<manifest/>");
  zip.file("META-INF/manifest.xml", "<manifest><encryption-data/></manifest>");
  const issue = await inspectExactHwpxProtection(
    await zip.generateAsync({ type: "uint8array" }),
  );

  assert.equal(issue?.code, "INVALID_HWPX_PROTECTION_METADATA");
  assert.match(issue?.error ?? "", /multiple|duplicate|ambiguous/iu);
});

test("classic ZIP preflight enforces entry, disk, ZIP64, and directory bounds", () => {
  assert.equal(assertClassicZipEntryBudget(zipWithEocdCount(1)), 1);
  assert.equal(assertClassicZipEntryBudget(zipWithEocdCount(10_000)), 10_000);
  assert.throws(
    () => assertClassicZipEntryBudget(zipWithEocdCount(10_001)),
    /entry count/iu,
  );
  assert.throws(
    () => assertClassicZipEntryBudget(zipWithEocdCount(0xffff)),
    /ZIP64/iu,
  );
  assert.throws(
    () => assertClassicZipEntryBudget(zipWithEocdCount(1, { disk: 1 })),
    /multi-disk/iu,
  );
  assert.throws(
    () =>
      assertClassicZipEntryBudget(
        zipWithEocdCount(1, { centralOffset: 1, centralSize: 1 }),
      ),
    /central directory/iu,
  );
});

test("bounded ZIP loading rejects excessive counts before invoking JSZip", async () => {
  let loadCalls = 0;
  await assert.rejects(
    loadBoundedHwpxZip(zipWithEocdCount(10_001), async (bytes) => {
      loadCalls += 1;
      return await JSZip.loadAsync(bytes);
    }),
    /entry count/iu,
  );
  assert.equal(loadCalls, 0);
});

test("bounded ZIP loading rejects an EOCD count that understates the central directory", async () => {
  const zip = new JSZip();
  zip.file("one.txt", "one");
  zip.file("two.txt", "two");
  const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0);
  bytes.writeUInt16LE(1, eocd + 8);
  bytes.writeUInt16LE(1, eocd + 10);

  let loadCalls = 0;
  await assert.rejects(
    loadBoundedHwpxZip(bytes, async (input) => {
      loadCalls += 1;
      return await JSZip.loadAsync(input);
    }),
    /entry count|central directory/iu,
  );
  assert.equal(loadCalls, 0);
});

test("protection inspection uses the bounded ZIP loader seam", async () => {
  let loadCalls = 0;
  const normal = new Uint8Array(await markdownToHwpx("정상 문서"));
  const issue = await inspectExactHwpxProtection(normal, async (bytes) => {
    loadCalls += 1;
    return await JSZip.loadAsync(bytes);
  });
  assert.equal(issue, undefined);
  assert.equal(loadCalls, 1);
});

function zipWithEocdCount(
  count: number,
  options: { disk?: number; centralOffset?: number; centralSize?: number } = {},
): Uint8Array {
  const centralDirectory = Buffer.alloc(count * 46);
  for (let index = 0; index < count; index += 1) {
    centralDirectory.writeUInt32LE(0x02014b50, index * 46);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.disk ?? 0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(options.centralSize ?? centralDirectory.length, 12);
  eocd.writeUInt32LE(options.centralOffset ?? 0, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([centralDirectory, eocd]);
}
