import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import JSZip from "jszip";

const MAX_REQUESTED_BYTES = 512 * 1024 * 1024;
const MAX_PADDING_ENTRY_BYTES = 128 * 1024 * 1024;
const INITIAL_OVERHEAD_ALLOWANCE = 64 * 1024;
const ZERO_BLOCK = Buffer.alloc(1024 * 1024);
const MAX_SIZING_ATTEMPTS = 4;

const CONTENT_HPF = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="3.0">',
  '<opf:manifest><opf:item id="header" href="header.xml" media-type="application/xml"/>',
  '<opf:item id="section0" href="section0.xml" media-type="application/xml"/></opf:manifest>',
  '<opf:spine><opf:itemref idref="section0"/></opf:spine>',
  '</opf:package>',
].join("");

const HEADER_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4" secCnt="1">',
  '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>',
  '<hh:refList><hh:fontfaces itemCnt="0"/><hh:borderFills itemCnt="0"/>',
  '<hh:charProperties itemCnt="0"/><hh:tabProperties itemCnt="0"/>',
  '<hh:numberings itemCnt="0"/><hh:bullets itemCnt="0"/>',
  '<hh:paraProperties itemCnt="0"/><hh:styles itemCnt="0"/></hh:refList>',
  '</hh:head>',
].join("");

const SECTION_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ',
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">',
  '<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">',
  '<hp:t>Bounded document benchmark</hp:t></hp:run></hp:p></hs:sec>',
].join("");

export function validateRequestedBytes(requestedBytes) {
  if (!Number.isSafeInteger(requestedBytes)
    || requestedBytes < INITIAL_OVERHEAD_ALLOWANCE
    || requestedBytes > MAX_REQUESTED_BYTES) {
    throw benchmarkSizeError();
  }
  return requestedBytes;
}

export function paddingEntryPlan(padBytes) {
  if (!Number.isSafeInteger(padBytes) || padBytes <= 0
    || padBytes > MAX_REQUESTED_BYTES) {
    throw benchmarkSizeError();
  }
  const entries = [];
  let remaining = padBytes;
  let index = 0;
  while (remaining > 0) {
    const bytes = Math.min(remaining, MAX_PADDING_ENTRY_BYTES);
    entries.push(Object.freeze({
      name: index === 0 ? "benchmark/pad.bin" : `benchmark/pad-${index}.bin`,
      bytes,
    }));
    remaining -= bytes;
    index += 1;
  }
  return Object.freeze(entries);
}

export async function generatePaddedHwpx({ outputPath, requestedBytes }) {
  validateRequestedBytes(requestedBytes);
  if (typeof outputPath !== "string" || outputPath.trim().length === 0) {
    throw benchmarkGenerationError();
  }

  let padBytes = requestedBytes - INITIAL_OVERHEAD_ALLOWANCE;
  for (let attempt = 0; attempt < MAX_SIZING_ATTEMPTS; attempt += 1) {
    try {
      await writeArchive(outputPath, padBytes);
      const actualBytes = (await stat(outputPath)).size;
      if (actualBytes > requestedBytes) {
        padBytes -= actualBytes - requestedBytes;
      } else {
        const gap = requestedBytes - actualBytes;
        if (gap <= 4096) {
          return Object.freeze({
            requestedBytes,
            actualBytes,
            padBytes,
            sha256: await sha256File(outputPath),
          });
        }
        padBytes += gap;
      }
    } catch (error) {
      await removeOwnedOutput(outputPath);
      if (error?.code === "EEXIST") throw benchmarkGenerationError();
      throw benchmarkGenerationError();
    }
    await removeOwnedOutput(outputPath);
    if (!Number.isSafeInteger(padBytes) || padBytes < 0) {
      throw benchmarkGenerationError();
    }
  }
  throw benchmarkGenerationError();
}

async function writeArchive(outputPath, padBytes) {
  const zip = new JSZip();
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles></container>',
  );
  zip.file("version.xml", '<?xml version="1.0"?><HCFVersion major="1" minor="4" micro="0" buildNumber="0"/>');
  zip.file("Contents/content.hpf", CONTENT_HPF);
  zip.file("Contents/header.xml", HEADER_XML);
  zip.file("Contents/section0.xml", SECTION_XML);
  for (const entry of paddingEntryPlan(padBytes)) {
    zip.file(entry.name, zeroStream(entry.bytes), {
      binary: true,
      compression: "STORE",
    });
  }
  const archive = zip.generateNodeStream({
    type: "nodebuffer",
    streamFiles: true,
    compression: "STORE",
    platform: "UNIX",
  });
  await pipeline(archive, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
}

function zeroStream(byteLength) {
  async function* blocks() {
    let remaining = byteLength;
    while (remaining > 0) {
      const length = Math.min(ZERO_BLOCK.byteLength, remaining);
      yield length === ZERO_BLOCK.byteLength ? ZERO_BLOCK : ZERO_BLOCK.subarray(0, length);
      remaining -= length;
    }
  }
  return Readable.from(blocks());
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function removeOwnedOutput(path) {
  try {
    const handle = await open(path, "r");
    const status = await handle.stat();
    await handle.close();
    if (!status.isFile()) throw benchmarkGenerationError();
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function benchmarkSizeError() {
  return Object.assign(new Error("BENCHMARK_SIZE_INVALID"), {
    code: "BENCHMARK_SIZE_INVALID",
  });
}

function benchmarkGenerationError() {
  return Object.assign(new Error("BENCHMARK_GENERATION_FAILED"), {
    code: "BENCHMARK_GENERATION_FAILED",
  });
}

async function main() {
  const [serializedBytes, outputPath] = process.argv.slice(2);
  if (process.argv.length !== 4) throw benchmarkSizeError();
  const result = await generatePaddedHwpx({
    outputPath,
    requestedBytes: Number(serializedBytes),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "BENCHMARK_GENERATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
