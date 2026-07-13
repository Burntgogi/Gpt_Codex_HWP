#!/usr/bin/env node

// src/detect.ts
import JSZip from "jszip";

// src/hwp5/cfb-lenient.ts
var CFB_MAGIC = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
var END_OF_CHAIN = 4294967294;
var FREE_SECT = 4294967295;
var MAX_CHAIN_LENGTH = 1e6;
var MAX_DIR_ENTRIES = 1e5;
var MAX_STREAM_SIZE = 100 * 1024 * 1024;
function parseLenientCfb(data) {
  if (data.length < 512) throw new Error("CFB \uD30C\uC77C\uC774 \uB108\uBB34 \uC9E7\uC2B5\uB2C8\uB2E4 (\uCD5C\uC18C 512\uBC14\uC774\uD2B8)");
  if (!data.subarray(0, 8).equals(CFB_MAGIC)) throw new Error("CFB \uB9E4\uC9C1 \uBC14\uC774\uD2B8 \uBD88\uC77C\uCE58");
  const sectorSizeShift = data.readUInt16LE(30);
  if (sectorSizeShift < 7 || sectorSizeShift > 16) throw new Error("\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uC139\uD130 \uD06C\uAE30 \uC2DC\uD504\uD2B8: " + sectorSizeShift);
  const sectorSize = 1 << sectorSizeShift;
  const miniSectorSizeShift = data.readUInt16LE(32);
  if (miniSectorSizeShift > 16) throw new Error("\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uBBF8\uB2C8 \uC139\uD130 \uD06C\uAE30 \uC2DC\uD504\uD2B8: " + miniSectorSizeShift);
  const miniSectorSize = 1 << miniSectorSizeShift;
  const fatSectorCount = data.readUInt32LE(44);
  if (fatSectorCount > 1e4) throw new Error("FAT \uC139\uD130 \uC218\uAC00 \uB108\uBB34 \uB9CE\uC2B5\uB2C8\uB2E4: " + fatSectorCount);
  const firstDirSector = data.readUInt32LE(48);
  const miniStreamCutoff = data.readUInt32LE(56);
  const firstMiniFatSector = data.readUInt32LE(60);
  const miniFatSectorCount = data.readUInt32LE(64);
  const firstDifatSector = data.readUInt32LE(68);
  const difatSectorCount = data.readUInt32LE(72);
  function sectorOffset(id) {
    return 512 + id * sectorSize;
  }
  function readSectorData(id) {
    const off = sectorOffset(id);
    if (off + sectorSize > data.length) return Buffer.alloc(0);
    return data.subarray(off, off + sectorSize);
  }
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < fatSectorCount; i++) {
    const sid = data.readUInt32LE(76 + i * 4);
    if (sid === FREE_SECT || sid === END_OF_CHAIN) break;
    fatSectors.push(sid);
  }
  let difatSector = firstDifatSector;
  const visitedDifat = /* @__PURE__ */ new Set();
  for (let d = 0; d < difatSectorCount && difatSector !== END_OF_CHAIN && difatSector !== FREE_SECT; d++) {
    if (visitedDifat.has(difatSector)) break;
    visitedDifat.add(difatSector);
    const buf = readSectorData(difatSector);
    const entriesPerSector = sectorSize / 4 - 1;
    for (let i = 0; i < entriesPerSector && fatSectors.length < fatSectorCount; i++) {
      const sid = buf.readUInt32LE(i * 4);
      if (sid === FREE_SECT || sid === END_OF_CHAIN) continue;
      fatSectors.push(sid);
    }
    difatSector = buf.readUInt32LE(entriesPerSector * 4);
  }
  const entriesPerFatSector = sectorSize / 4;
  const fatTable = new Uint32Array(fatSectors.length * entriesPerFatSector);
  for (let fi = 0; fi < fatSectors.length; fi++) {
    const buf = readSectorData(fatSectors[fi]);
    for (let i = 0; i < entriesPerFatSector; i++) {
      fatTable[fi * entriesPerFatSector + i] = i * 4 + 3 < buf.length ? buf.readUInt32LE(i * 4) : FREE_SECT;
    }
  }
  function readChain(startSector, maxBytes) {
    if (startSector === END_OF_CHAIN || startSector === FREE_SECT) return Buffer.alloc(0);
    if (maxBytes > MAX_STREAM_SIZE) throw new Error("\uC2A4\uD2B8\uB9BC\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4");
    const chunks = [];
    let current = startSector;
    let totalRead = 0;
    const visited = /* @__PURE__ */ new Set();
    while (current !== END_OF_CHAIN && current !== FREE_SECT && totalRead < maxBytes) {
      if (visited.has(current)) break;
      if (visited.size > MAX_CHAIN_LENGTH) break;
      visited.add(current);
      const buf = readSectorData(current);
      const remaining = maxBytes - totalRead;
      chunks.push(remaining < sectorSize ? buf.subarray(0, remaining) : buf);
      totalRead += Math.min(buf.length, remaining);
      current = current < fatTable.length ? fatTable[current] : END_OF_CHAIN;
    }
    return Buffer.concat(chunks);
  }
  let miniFatTable = null;
  function getMiniFatTable() {
    if (miniFatTable) return miniFatTable;
    if (miniFatSectorCount === 0 || firstMiniFatSector === END_OF_CHAIN) {
      miniFatTable = new Uint32Array(0);
      return miniFatTable;
    }
    const miniFatData = readChain(firstMiniFatSector, miniFatSectorCount * sectorSize);
    const entries = miniFatData.length / 4;
    miniFatTable = new Uint32Array(entries);
    for (let i = 0; i < entries; i++) {
      miniFatTable[i] = miniFatData.readUInt32LE(i * 4);
    }
    return miniFatTable;
  }
  const dirData = readChain(firstDirSector, MAX_DIR_ENTRIES * 128);
  const dirEntries = [];
  for (let offset = 0; offset + 128 <= dirData.length && dirEntries.length < MAX_DIR_ENTRIES; offset += 128) {
    const nameLen = dirData.readUInt16LE(offset + 64);
    if (nameLen <= 0 || nameLen > 64) {
      dirEntries.push({ name: "", type: 0, startSector: 0, size: 0 });
      continue;
    }
    const nameBytes = nameLen - 2;
    const name = nameBytes > 0 ? dirData.subarray(offset, offset + nameBytes).toString("utf16le") : "";
    const type = dirData[offset + 66];
    const startSector = dirData.readUInt32LE(offset + 116);
    const size = dirData.readUInt32LE(offset + 120);
    dirEntries.push({ name, type, startSector, size });
  }
  let miniStreamData = null;
  function getMiniStream() {
    if (miniStreamData) return miniStreamData;
    const root = dirEntries[0];
    if (!root || root.type !== 5) {
      miniStreamData = Buffer.alloc(0);
      return miniStreamData;
    }
    miniStreamData = readChain(root.startSector, root.size || MAX_STREAM_SIZE);
    return miniStreamData;
  }
  function readMiniStream(startSector, size) {
    const mft = getMiniFatTable();
    const ms = getMiniStream();
    if (mft.length === 0 || ms.length === 0) return Buffer.alloc(0);
    const chunks = [];
    let current = startSector;
    let totalRead = 0;
    const visited = /* @__PURE__ */ new Set();
    while (current !== END_OF_CHAIN && current !== FREE_SECT && totalRead < size) {
      if (visited.has(current)) break;
      if (visited.size > MAX_CHAIN_LENGTH) break;
      visited.add(current);
      const off = current * miniSectorSize;
      const remaining = size - totalRead;
      const chunkSize = Math.min(miniSectorSize, remaining);
      if (off + chunkSize <= ms.length) {
        chunks.push(ms.subarray(off, off + chunkSize));
      }
      totalRead += chunkSize;
      current = current < mft.length ? mft[current] : END_OF_CHAIN;
    }
    return Buffer.concat(chunks);
  }
  function readStreamData(entry) {
    if (entry.size === 0) return Buffer.alloc(0);
    if (entry.size < miniStreamCutoff) {
      const miniResult = readMiniStream(entry.startSector, entry.size);
      if (miniResult.length > 0) return miniResult;
    }
    return readChain(entry.startSector, entry.size);
  }
  function findEntryByPath(path) {
    const parts = path.replace(/^\//, "").split("/");
    if (parts.length === 1) {
      return dirEntries.find((e) => e.name === parts[0] && e.type === 2) ?? null;
    }
    const storageName = parts[0];
    const streamName = parts.slice(1).join("/");
    for (const e of dirEntries) {
      if (e.type === 2 && e.name === streamName) {
        return e;
      }
    }
    const lastPart = parts[parts.length - 1];
    return dirEntries.find((e) => e.type === 2 && e.name === lastPart) ?? null;
  }
  return {
    findStream(path) {
      const normalized = path.replace(/^\//, "");
      const entry = findEntryByPath(normalized);
      if (!entry || entry.type !== 2) return null;
      const stream = readStreamData(entry);
      return stream.length > 0 ? stream : null;
    },
    entries() {
      return dirEntries.filter((e) => e.type === 2);
    }
  };
}

// src/detect.ts
function magicBytes(buffer) {
  return new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
}
function isZipFile(buffer) {
  const b = magicBytes(buffer);
  return b[0] === 80 && b[1] === 75 && b[2] === 3 && b[3] === 4;
}
function isHwpxFile(buffer) {
  return isZipFile(buffer);
}
function isOldHwpFile(buffer) {
  const b = magicBytes(buffer);
  return b[0] === 208 && b[1] === 207 && b[2] === 17 && b[3] === 224;
}
var HWP3_PREFIX = new TextEncoder().encode("HWP Document File V3.00");
function isHwp3File(buffer) {
  if (buffer.byteLength < HWP3_PREFIX.length) return false;
  const head = new Uint8Array(buffer, 0, HWP3_PREFIX.length);
  for (let i = 0; i < HWP3_PREFIX.length; i++) {
    if (head[i] !== HWP3_PREFIX[i]) return false;
  }
  return true;
}
function isPdfFile(buffer) {
  const b = magicBytes(buffer);
  return b[0] === 37 && b[1] === 80 && b[2] === 68 && b[3] === 70;
}
function isHwpmlFile(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength));
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
  return head.trimStart().startsWith("<?xml") && head.includes("<HWPML");
}
function detectFormat(buffer) {
  if (buffer.byteLength < 4) return "unknown";
  if (isHwp3File(buffer)) return "hwp3";
  if (isZipFile(buffer)) return "hwpx";
  if (isOldHwpFile(buffer)) return "hwp";
  if (isPdfFile(buffer)) return "pdf";
  if (isHwpmlFile(buffer)) return "hwpml";
  return "unknown";
}
function detectOle2Format(buffer) {
  try {
    const cfb = parseLenientCfb(Buffer.from(buffer));
    const names = cfb.entries().map((e) => e.name);
    if (names.includes("Workbook") || names.includes("Book")) return "xls";
    if (names.includes("FileHeader")) return "hwp";
    if (names.some((n) => n === "DocInfo" || n.startsWith("Section"))) return "hwp";
    return "unknown";
  } catch {
    return "unknown";
  }
}
async function detectZipFormat(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    if (zip.file("xl/workbook.xml")) return "xlsx";
    if (zip.file("word/document.xml")) return "docx";
    if (zip.file("Contents/content.hpf") || zip.file("mimetype")) return "hwpx";
    const hasSection = Object.keys(zip.files).some((f) => f.startsWith("Contents/"));
    if (hasSection) return "hwpx";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export {
  parseLenientCfb,
  isZipFile,
  isHwpxFile,
  isOldHwpFile,
  isHwp3File,
  isPdfFile,
  isHwpmlFile,
  detectFormat,
  detectOle2Format,
  detectZipFormat
};
//# sourceMappingURL=chunk-MEPHGCPQ.js.map