"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { newObj[key] = obj[key]; } } } newObj.default = obj; return newObj; } } function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; } function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; } var _class; var _class2; var _class3; var _class4; var _class5;





















var _chunkR2H34FY5cjs = require('./chunk-R2H34FY5.cjs');


var _chunkDCZVOIEOcjs = require('./chunk-DCZVOIEO.cjs');


var _chunkGS7T56RPcjs = require('./chunk-GS7T56RP.cjs');

// src/index.ts
var _promises = require('fs/promises');

// src/detect.ts
var _jszip = require('jszip'); var _jszip2 = _interopRequireDefault(_jszip);

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
      return _nullishCoalesce(dirEntries.find((e) => e.name === parts[0] && e.type === 2), () => ( null));
    }
    const storageName = parts[0];
    const streamName = parts.slice(1).join("/");
    for (const e of dirEntries) {
      if (e.type === 2 && e.name === streamName) {
        return e;
      }
    }
    const lastPart = parts[parts.length - 1];
    return _nullishCoalesce(dirEntries.find((e) => e.type === 2 && e.name === lastPart), () => ( null));
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
  } catch (e3) {
    return "unknown";
  }
}
async function detectZipFormat(buffer) {
  try {
    const zip = await _jszip2.default.loadAsync(buffer);
    if (zip.file("xl/workbook.xml")) return "xlsx";
    if (zip.file("word/document.xml")) return "docx";
    if (zip.file("Contents/content.hpf") || zip.file("mimetype")) return "hwpx";
    const hasSection = Object.keys(zip.files).some((f) => f.startsWith("Contents/"));
    if (hasSection) return "hwpx";
    return "unknown";
  } catch (e4) {
    return "unknown";
  }
}

// src/hwpx/parser.ts


// src/hwpx/com-fallback.ts
var _child_process = require('child_process');
var _os = require('os');
function isComFallbackAvailable() {
  return _os.platform.call(void 0, ) === "win32";
}
function isEncryptedHwpx(manifestXml) {
  return manifestXml.includes("encryption-data");
}
function extractTextViaCom(filePath) {
  if (!isComFallbackAvailable()) {
    throw new Error("COM fallback\uC740 Windows\uC5D0\uC11C\uB9CC \uC0AC\uC6A9 \uAC00\uB2A5\uD569\uB2C8\uB2E4");
  }
  const escaped = filePath.replace(/'/g, "''");
  const ps1 = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$src = '${escaped}'
$tmpDir = Join-Path $env:TEMP ('hwp-com-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $tmpDir -Force)
$tmpFile = Join-Path $tmpDir (Split-Path $src -Leaf)
Copy-Item -LiteralPath $src -Destination $tmpFile -Force

try {
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $hwp.RegisterModule('FilePathCheckerModule', 'FilePathCheckerModuleExample') | Out-Null
  $hwp.Open($tmpFile, '', '') | Out-Null
  $pc = $hwp.PageCount
  $result = @{ pageCount = $pc; pages = @() }
  for ($p = 1; $p -le $pc; $p++) {
    $t = $hwp.GetPageText($p, 0)
    $result.pages += @($t)
  }
  $hwp.Clear(1) | Out-Null
  try { $hwp.Quit() | Out-Null } catch { }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) | Out-Null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  $result | ConvertTo-Json -Depth 3 -Compress
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  # \uC784\uC2DC \uD30C\uC77C \uC815\uB9AC + \uC880\uBE44 Hwp.exe \uBC29\uC9C0\uC6A9 garbage collect
  try { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`;
  const stdout = _child_process.execFileSync.call(void 0, "powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    ps1
  ], {
    encoding: "utf-8",
    timeout: 12e4,
    // 2분 타임아웃
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024
    // 50MB
  });
  const trimmed = stdout.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) throw new Error(`COM \uCD9C\uB825\uC5D0 JSON\uC774 \uC5C6\uC2B5\uB2C8\uB2E4: ${trimmed.slice(0, 200)}`);
  const json = JSON.parse(trimmed.slice(jsonStart));
  if (json.error) {
    throw new Error(`COM \uD14D\uC2A4\uD2B8 \uCD94\uCD9C \uC2E4\uD328: ${json.error}`);
  }
  const warnings = [];
  const pages = Array.isArray(json.pages) ? json.pages : [];
  const pageCount = _nullishCoalesce(json.pageCount, () => ( pages.length));
  if (pages.length === 0) {
    warnings.push({ message: "COM\uC73C\uB85C \uD14D\uC2A4\uD2B8\uB97C \uCD94\uCD9C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4", code: "COM_EMPTY" });
  }
  return { pages, pageCount, warnings };
}
function comResultToParseResult(pages, pageCount, warnings) {
  const blocks = [];
  const lines = [];
  for (let i = 0; i < pages.length; i++) {
    const text = (_nullishCoalesce(pages[i], () => ( ""))).trim();
    if (!text) continue;
    const paragraphs = text.split(/\n/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      blocks.push({ type: "paragraph", text: trimmed, pageNumber: i + 1 });
      lines.push(trimmed);
    }
  }
  const markdown = lines.join("\n\n");
  const metadata = { pageCount };
  warnings.push({
    message: "DRM \uBB38\uC11C: \uD55C\uCEF4 COM API\uB85C \uD14D\uC2A4\uD2B8 \uCD94\uCD9C (\uC11C\uC2DD/\uD45C \uC815\uBCF4 \uC81C\uD55C\uC801)",
    code: "DRM_COM_FALLBACK"
  });
  return {
    markdown,
    blocks,
    metadata,
    warnings: warnings.length > 0 ? warnings : void 0
  };
}

// src/hwpx/parser-shared.ts
var _xmldom = require('@xmldom/xmldom');
var MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024;
var MAX_ZIP_ENTRIES = 500;
function clampSpan(val, max) {
  return Math.max(1, Math.min(val, max));
}
var MAX_XML_DEPTH = 200;
function createSectionShared() {
  return { numState: /* @__PURE__ */ new Map(), pageText: { headers: [], footers: [] }, track: { deleteDepth: 0, warned: false } };
}
function createXmlParser(warnings) {
  return new (0, _xmldom.DOMParser)({
    onError(level, msg2) {
      if (level === "fatalError") throw new (0, _chunkR2H34FY5cjs.KordocError)(`XML \uD30C\uC2F1 \uC2E4\uD328: ${msg2}`);
      _optionalChain([warnings, 'optionalAccess', _3 => _3.push, 'call', _4 => _4({ code: "MALFORMED_XML", message: `XML ${level === "warn" ? "\uACBD\uACE0" : "\uC624\uB958"}: ${msg2}` })]);
    }
  });
}
function applyPageText(blocks, shared) {
  const { headers, footers } = shared.pageText;
  if (headers.length > 0) {
    blocks.unshift(...headers.map((t) => ({ type: "paragraph", text: t, pageNumber: 1 })));
  }
  if (footers.length > 0) {
    blocks.push(...footers.map((t) => ({ type: "paragraph", text: t })));
  }
}
function findChildByLocalName(parent, name) {
  const children = parent.childNodes;
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    if (ch.nodeType !== 1) continue;
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "");
    if (tag === name) return ch;
  }
  return null;
}
function extractTextFromNode(node) {
  let result = "";
  const children = node.childNodes;
  if (!children) return result;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType === 3) result += child.textContent || "";
    else if (child.nodeType === 1) result += extractTextFromNode(child);
  }
  return result.trim();
}

// src/hwpx/styles.ts
async function extractHwpxStyles(zip, decompressed) {
  const result = {
    charProperties: /* @__PURE__ */ new Map(),
    styles: /* @__PURE__ */ new Map(),
    numberings: /* @__PURE__ */ new Map(),
    bullets: /* @__PURE__ */ new Map(),
    paraHeadings: /* @__PURE__ */ new Map()
  };
  const headerPaths = ["Contents/header.xml", "header.xml", "Contents/head.xml", "head.xml"];
  for (const hp of headerPaths) {
    const hpLower = hp.toLowerCase();
    const file = zip.file(hp) || Object.values(zip.files).find((f) => f.name.toLowerCase() === hpLower) || null;
    if (!file) continue;
    try {
      const xml = await file.async("text");
      if (decompressed) {
        decompressed.total += xml.length * 2;
        if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP \uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC (ZIP bomb \uC758\uC2EC)");
      }
      const parser = createXmlParser();
      const doc = parser.parseFromString(_chunkR2H34FY5cjs.stripDtd.call(void 0, xml), "text/xml");
      if (!doc.documentElement) continue;
      parseCharProperties(doc, result.charProperties);
      parseStyleElements(doc, result.styles);
      const domDoc = doc;
      parseNumberings(domDoc, result.numberings);
      parseBullets(domDoc, result.bullets);
      parseParaHeadings(domDoc, result.paraHeadings);
      break;
    } catch (e5) {
      continue;
    }
  }
  return result;
}
function parseCharProperties(doc, map) {
  const tagNames = ["hh:charPr", "charPr", "hp:charPr"];
  for (const tagName of tagNames) {
    const elements3 = doc.getElementsByTagName(tagName);
    for (let i = 0; i < elements3.length; i++) {
      const el = elements3[i];
      const id = el.getAttribute("id") || el.getAttribute("IDRef") || "";
      if (!id) continue;
      const prop = {};
      const height = el.getAttribute("height");
      if (height) {
        const parsedHeight = parseInt(height, 10);
        if (!isNaN(parsedHeight) && parsedHeight > 0) {
          prop.fontSize = parsedHeight / 100;
        }
      }
      const bold = el.getAttribute("bold");
      if (bold === "true" || bold === "1") prop.bold = true;
      const italic = el.getAttribute("italic");
      if (italic === "true" || italic === "1") prop.italic = true;
      const fontFaces = el.getElementsByTagName("*");
      for (let j = 0; j < fontFaces.length; j++) {
        const ff = fontFaces[j];
        const localTag = (ff.tagName || "").replace(/^[^:]+:/, "");
        if (localTag === "fontface" || localTag === "fontRef") {
          const face = ff.getAttribute("face") || ff.getAttribute("FontFace");
          if (face) {
            prop.fontName = face;
            break;
          }
        }
      }
      map.set(id, prop);
    }
  }
}
function parseStyleElements(doc, map) {
  const tagNames = ["hh:style", "style", "hp:style"];
  for (const tagName of tagNames) {
    const elements3 = doc.getElementsByTagName(tagName);
    for (let i = 0; i < elements3.length; i++) {
      const el = elements3[i];
      const id = el.getAttribute("id") || el.getAttribute("IDRef") || String(i);
      const name = el.getAttribute("name") || el.getAttribute("engName") || "";
      const charPrId = el.getAttribute("charPrIDRef") || void 0;
      const paraPrId = el.getAttribute("paraPrIDRef") || void 0;
      map.set(id, { name, charPrId, paraPrId });
    }
  }
}
function parseNumberings(doc, map) {
  const tagNames = ["hh:numbering", "numbering"];
  for (const tagName of tagNames) {
    const elements3 = doc.getElementsByTagName(tagName);
    for (let i = 0; i < elements3.length; i++) {
      const el = elements3[i];
      const id = el.getAttribute("id") || "";
      if (!id) continue;
      const def = { heads: /* @__PURE__ */ new Map() };
      const children = el.childNodes;
      for (let j = 0; j < children.length; j++) {
        const ch = children[j];
        if (ch.nodeType !== 1) continue;
        const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "");
        if (tag !== "paraHead") continue;
        const level = parseInt(ch.getAttribute("level") || "", 10);
        if (isNaN(level) || level < 1 || level > 10) continue;
        const start = parseInt(ch.getAttribute("start") || "1", 10);
        def.heads.set(level, {
          numFormat: ch.getAttribute("numFormat") || "DIGIT",
          text: ch.textContent || "",
          start: isNaN(start) ? 1 : start
        });
      }
      if (def.heads.size > 0) map.set(id, def);
    }
    if (map.size > 0) break;
  }
}
function parseBullets(doc, map) {
  const tagNames = ["hh:bullet", "bullet"];
  for (const tagName of tagNames) {
    const elements3 = doc.getElementsByTagName(tagName);
    for (let i = 0; i < elements3.length; i++) {
      const el = elements3[i];
      const id = el.getAttribute("id") || "";
      const char = el.getAttribute("char") || "";
      if (id && char) map.set(id, char);
    }
    if (map.size > 0) break;
  }
}
function parseParaHeadings(doc, map) {
  const tagNames = ["hh:paraPr", "paraPr"];
  for (const tagName of tagNames) {
    const elements3 = doc.getElementsByTagName(tagName);
    for (let i = 0; i < elements3.length; i++) {
      const el = elements3[i];
      const id = el.getAttribute("id") || "";
      if (!id) continue;
      const heading = findChildByLocalName(el, "heading");
      if (!heading) continue;
      const type = heading.getAttribute("type") || "NONE";
      if (type !== "NUMBER" && type !== "BULLET" && type !== "OUTLINE") continue;
      const level = parseInt(heading.getAttribute("level") || "0", 10);
      map.set(id, {
        type,
        idRef: heading.getAttribute("idRef") || "0",
        level: isNaN(level) ? 0 : Math.max(0, Math.min(level, 9))
      });
    }
    if (map.size > 0) break;
  }
}
function detectHwpxHeadings(blocks, styleMap) {
  if (blocks.some((b) => b.type === "heading")) return;
  let baseFontSize = 0;
  const sizeFreq = /* @__PURE__ */ new Map();
  for (const b of blocks) {
    if (_optionalChain([b, 'access', _5 => _5.style, 'optionalAccess', _6 => _6.fontSize])) {
      sizeFreq.set(b.style.fontSize, (sizeFreq.get(b.style.fontSize) || 0) + 1);
    }
  }
  let maxCount = 0;
  for (const [size, count] of sizeFreq) {
    if (count > maxCount) {
      maxCount = count;
      baseFontSize = size;
    }
  }
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text) continue;
    const text = block.text.trim();
    if (text.length === 0 || text.length > 200 || /^\d+$/.test(text)) continue;
    let level = 0;
    if (baseFontSize > 0 && _optionalChain([block, 'access', _7 => _7.style, 'optionalAccess', _8 => _8.fontSize])) {
      const ratio = block.style.fontSize / baseFontSize;
      if (ratio >= _chunkR2H34FY5cjs.HEADING_RATIO_H1) level = 1;
      else if (ratio >= _chunkR2H34FY5cjs.HEADING_RATIO_H2) level = 2;
      else if (ratio >= _chunkR2H34FY5cjs.HEADING_RATIO_H3) level = 3;
    }
    const compactText = text.replace(/\s+/g, "");
    if (/^제\d+[조장절편]/.test(compactText) && text.length <= 50) {
      if (level === 0) level = 3;
    }
    if (level > 0) {
      block.type = "heading";
      block.level = level;
    }
  }
}

// src/hwpx/equation.ts
var CONVERT_MAP = {
  TIMES: "\\times",
  times: "\\times",
  LEFT: "\\left",
  RIGHT: "\\right",
  under: "\\underline",
  SMALLSUM: "\\sum",
  sum: "\\sum",
  SMALLPROD: "\\prod",
  prod: "\\prod",
  SMALLINTER: "\\cap",
  CUP: "\\cup",
  OPLUS: "\\oplus",
  OMINUS: "\\ominus",
  OTIMES: "\\otimes",
  ODIV: "\\oslash",
  ODOT: "\\odot",
  LOR: "\\lor",
  LAND: "\\land",
  SUBSET: "\\subset",
  SUPERSET: "\\supset",
  SUBSETEQ: "\\subseteq",
  SUPSETEQ: "\\supseteq",
  IN: "\\in",
  OWNS: "\\owns",
  NOTIN: "\\notin",
  LEQ: "\\leq",
  GEQ: "\\geq",
  "<<": "\\ll",
  ">>": "\\gg",
  "<<<": "\\lll",
  ">>>": "\\ggg",
  PREC: "\\prec",
  SUCC: "\\succ",
  UPLUS: "\\uplus",
  "\xB1": "\\pm",
  "+-": "\\pm",
  "-+": "\\mp",
  "\xF7": "\\div",
  cdot: "\\cdot",
  CIRC: "\\circ",
  BULLET: "\\bullet",
  DEG: " ^\\circ",
  AST: "\\ast",
  STAR: "\\bigstar",
  BIGCIRC: "\\bigcirc",
  EMPTYSET: "\\emptyset",
  THEREFORE: "\\therefore",
  BECAUSE: "\\because",
  EXIST: "\\exists",
  "!=": "\\neq",
  SMCOPROD: "\\coprod",
  coprod: "\\coprod",
  SQCAP: "\\sqcap",
  SQCUP: "\\sqcup",
  SQSUBSET: "\\sqsubset",
  SQSUBSETEQ: "\\sqsubseteq",
  BIGSQCUP: "\\bigsqcup",
  BIGOPLUS: "\\bigoplus",
  BIGOTIMES: "\\bigotimes",
  BIGODOT: "\\bigodot",
  BIGUPLUS: "\\biguplus",
  inter: "\\bigcap",
  union: "\\bigcup",
  BIGOMINUS: "{\\Large\\ominus}",
  BIGODIV: "{\\Large\\oslash}",
  UNDEROVER: "",
  SIM: "\\sim",
  APPROX: "\\approx",
  SIMEQ: "\\simeq",
  CONG: "\\cong",
  "==": "\\equiv",
  DIAMOND: "\\diamond",
  FORALL: "\\forall",
  prime: "'",
  Partial: "\\partial",
  INF: "\\infty",
  PROPTO: "\\propto",
  lim: "\\lim",
  Lim: "\\lim",
  larrow: "\\leftarrow",
  "->": "\\rightarrow",
  uparrow: "\\uparrow",
  downarrow: "\\downarrow",
  LARROW: "\\Leftarrow",
  RARROW: "\\Rightarrow",
  UPARROW: "\\Uparrow",
  DOWNARROW: "\\Downarrow",
  udarrow: "\\updownarrow",
  "<->": "\\leftrightarrow",
  UDARROW: "\\Updownarrow",
  LRARROW: "\\Leftrightarrow",
  NWARROW: "\\nwarrow",
  SEARROW: "\\searrow",
  NEARROW: "\\nearrow",
  SWARROW: "\\swarrow",
  HOOKLEFT: "\\hookleftarrow",
  HOOKRIGHT: "\\hookrightarrow",
  PVER: "\\|",
  MAPSTO: "\\mapsto",
  CDOTS: "\\cdots",
  LDOTS: "\\ldots",
  VDOTS: "\\vdots",
  DDOTS: "\\ddots",
  DAGGER: "\\dagger",
  DDAGGER: "\\ddagger",
  DOTEQ: "\\doteq",
  image: "\\fallingdotseq",
  REIMAGE: "\\risingdotseq",
  ASYMP: "\\asymp",
  ISO: "\\Bumpeq",
  DSUM: "\\dotplus",
  XOR: "\\veebar",
  TRIANGLE: "\\triangle",
  NABLA: "\\nabla",
  ANGLE: "\\angle",
  MSANGLE: "\\measuredangle",
  SANGLE: "\\sphericalangle",
  VDASH: "\\vdash",
  DASHV: "\\dashv",
  BOT: "\\bot",
  TOP: "\\top",
  MODELS: "\\models",
  LAPLACE: "\\mathcal{L}",
  CENTIGRADE: "^{\\circ}C",
  FAHRENHEIT: "^{\\circ}F",
  LSLANT: "\\diagup",
  RSLANT: "\\diagdown",
  sqrt: "\\sqrt",
  int: "\\int",
  dint: "\\iint",
  tint: "\\iiint",
  oint: "\\oint",
  alpha: "\\alpha",
  beta: "\\beta",
  gamma: "\\gamma",
  delta: "\\delta",
  epsilon: "\\epsilon",
  zeta: "\\zeta",
  eta: "\\eta",
  theta: "\\theta",
  iota: "\\iota",
  kappa: "\\kappa",
  lambda: "\\lambda",
  mu: "\\mu",
  nu: "\\nu",
  xi: "\\xi",
  omicron: "\\omicron",
  pi: "\\pi",
  rho: "\\rho",
  sigma: "\\sigma",
  tau: "\\tau",
  upsilon: "\\upsilon",
  phi: "\\phi",
  chi: "\\chi",
  psi: "\\psi",
  omega: "\\omega",
  ALPHA: "A",
  BETA: "B",
  GAMMA: "\\Gamma",
  DELTA: "\\Delta",
  EPSILON: "E",
  ZETA: "Z",
  ETA: "H",
  THETA: "\\Theta",
  IOTA: "I",
  KAPPA: "K",
  LAMBDA: "\\Lambda",
  MU: "M",
  NU: "N",
  XI: "\\Xi",
  OMICRON: "O",
  PI: "\\Pi",
  RHO: "P",
  SIGMA: "\\Sigma",
  TAU: "T",
  UPSILON: "\\Upsilon",
  PHI: "\\Phi",
  CHI: "X",
  PSI: "\\Psi",
  OMEGA: "\\Omega",
  "\u2308": "\\lceil",
  "\u2309": "\\rceil",
  "\u230A": "\\lfloor",
  "\u230B": "\\rfloor",
  "\u2225": "\\|",
  "\u2290": "\\sqsupset",
  "\u2292": "\\sqsupseteq",
  odint: "\\mathop \u222F",
  otint: "\\mathop \u2230",
  BIGSQCAP: "\\mathop \u2A05",
  ATT: "\\mathop \u203B",
  HUND: "\\mathop \u2030",
  THOU: "\\mathop \u2031",
  IDENTICAL: "\\mathop \u2237",
  RTANGLE: "\\mathop \u22BE",
  BASE: "\\mathop \u2302",
  BENZENE: "\\mathop \u232C"
};
var MIDDLE_CONVERT_MAP = {
  matrix: "HULKMATRIX",
  pmatrix: "HULKPMATRIX",
  bmatrix: "HULKBMATRIX",
  dmatrix: "HULKDMATRIX",
  eqalign: "HULKEQALIGN",
  cases: "HULKCASE",
  vec: "HULKVEC",
  dyad: "HULKDYAD",
  acute: "HULKACUTE",
  grave: "HULKGRAVE",
  dot: "HULKDOT",
  ddot: "HULKDDOT",
  bar: "HULKBAR",
  hat: "HULKHAT",
  check: "HULKCHECK",
  arch: "HULKARCH",
  tilde: "HULKTILDE",
  BOX: "HULKBOX",
  OVERBRACE: "HULKOVERBRACE",
  UNDERBRACE: "HULKUNDERBRACE"
};
var BAR_CONVERT_MAP = {
  HULKVEC: "\\overrightarrow",
  HULKDYAD: "\\overleftrightarrow",
  HULKACUTE: "\\acute",
  HULKGRAVE: "\\grave",
  HULKDOT: "\\dot",
  HULKDDOT: "\\ddot",
  HULKBAR: "\\overline",
  HULKHAT: "\\widehat",
  HULKCHECK: "\\check",
  HULKARCH: "\\overset{\\frown}",
  HULKTILDE: "\\widetilde",
  HULKBOX: "\\boxed"
};
var MATRIX_CONVERT_MAP = {
  HULKMATRIX: { begin: "\\begin{matrix}", end: "\\end{matrix}", removeOutterBrackets: true },
  HULKPMATRIX: { begin: "\\begin{pmatrix}", end: "\\end{pmatrix}", removeOutterBrackets: true },
  HULKBMATRIX: { begin: "\\begin{bmatrix}", end: "\\end{bmatrix}", removeOutterBrackets: true },
  HULKDMATRIX: { begin: "\\begin{vmatrix}", end: "\\end{vmatrix}", removeOutterBrackets: true },
  HULKCASE: { begin: "\\begin{cases}", end: "\\end{cases}", removeOutterBrackets: true },
  HULKEQALIGN: { begin: "\\eqalign{", end: "}", removeOutterBrackets: false }
};
var BRACE_CONVERT_MAP = {
  HULKOVERBRACE: "\\overbrace",
  HULKUNDERBRACE: "\\underbrace"
};
function findBrackets(eqString, startIdx, direction) {
  if (direction === 1) {
    const startCur = eqString.indexOf("{", startIdx);
    if (startCur === -1) throw new Error("cannot find bracket");
    let bracketCount = 1;
    for (let i = startCur + 1; i < eqString.length; i++) {
      const ch = eqString[i];
      if (ch === "{") bracketCount += 1;
      else if (ch === "}") bracketCount -= 1;
      if (bracketCount === 0) return [startCur, i + 1];
    }
    throw new Error("cannot find bracket");
  }
  const reversed = Array.from(eqString).reverse();
  for (let i = 0; i < reversed.length; i++) {
    if (reversed[i] === "{") reversed[i] = "}";
    else if (reversed[i] === "}") reversed[i] = "{";
  }
  const flipped = reversed.join("");
  const newStartIdx = flipped.length - (startIdx + 1);
  const [s, e] = findBrackets(flipped, newStartIdx, 1);
  return [flipped.length - e, flipped.length - s];
}
function findEnclosingBrackets(eqString, startIdx) {
  let depth = 0;
  for (let idx = startIdx - 1; idx >= 0; idx--) {
    const ch = eqString[idx];
    if (ch === "}") {
      depth += 1;
    } else if (ch === "{") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      try {
        const [start, end] = findBrackets(eqString, idx, 1);
        if (start === idx && end > startIdx) return [start, end];
      } catch (e6) {
        return null;
      }
      return null;
    }
  }
  return null;
}
function maskLiteralSpans(eqString) {
  return eqString.replace(/"[^"]*"/g, (m) => "\uFFFF".repeat(m.length)).replace(/\\text\{[^}]*\}/g, (m) => "\uFFFF".repeat(m.length));
}
function findKeywordToken(eqString, word, from = 0) {
  const masked = maskLiteralSpans(eqString);
  for (let i = masked.indexOf(word, from); i !== -1; i = masked.indexOf(word, i + 1)) {
    const okL = i === 0 || /\s/.test(masked[i - 1]);
    const okR = i + word.length === masked.length || /\s/.test(masked[i + word.length]);
    if (okL && okR) return i;
  }
  return -1;
}
function replaceFrac(eqString) {
  const hmlFrac = "over";
  while (true) {
    const cursor = findKeywordToken(eqString, hmlFrac);
    if (cursor === -1) break;
    try {
      let end = cursor;
      while (end > 0 && /\s/.test(eqString[end - 1])) end--;
      let numStart, numEnd, wrapped;
      if (end > 0 && eqString[end - 1] === "}") {
        [numStart, numEnd] = findBrackets(eqString, end - 1, 0);
        wrapped = eqString.slice(numStart, numEnd);
      } else {
        numEnd = end;
        numStart = end;
        while (numStart > 0 && !/\s/.test(eqString[numStart - 1])) numStart--;
        if (numStart === numEnd) throw new Error("empty numerator");
        wrapped = "{" + eqString.slice(numStart, numEnd) + "}";
      }
      const beforeFrac = eqString.slice(0, numStart);
      const afterFrac = eqString.slice(cursor + hmlFrac.length);
      eqString = beforeFrac + "\\frac" + wrapped + afterFrac;
    } catch (e7) {
      return eqString;
    }
  }
  return eqString;
}
function replaceRootOf(eqString) {
  while (true) {
    const rootCursor = findKeywordToken(eqString, "root");
    if (rootCursor === -1) break;
    try {
      const elem1 = findBrackets(eqString, rootCursor, 1);
      const ofCursor = findKeywordToken(eqString, "of", elem1[1]);
      if (ofCursor === -1) return eqString;
      const elem2 = findBrackets(eqString, ofCursor, 1);
      const e1 = eqString.slice(elem1[0] + 1, elem1[1] - 1);
      const e2 = eqString.slice(elem2[0] + 1, elem2[1] - 1);
      eqString = eqString.slice(0, rootCursor) + "\\sqrt[" + e1 + "]{" + e2 + "}" + eqString.slice(elem2[1] + 1);
    } catch (e8) {
      return eqString;
    }
  }
  return eqString;
}
function replaceAllMatrix(eqString) {
  const replaceElements = (bracketStr) => {
    let inner = bracketStr.slice(1, -1);
    inner = inner.replace(/#/g, " \\\\ ");
    inner = inner.replace(/&amp;/g, "&");
    return inner;
  };
  const replaceMatrix = (input, matStr, matElem) => {
    while (true) {
      const cursor = input.indexOf(matStr);
      if (cursor === -1) break;
      try {
        const [eStart, eEnd] = findBrackets(input, cursor, 1);
        const elem = replaceElements(input.slice(eStart, eEnd));
        let beforeMat;
        let afterMat;
        const outer = matElem.removeOutterBrackets ? findEnclosingBrackets(input, cursor) : null;
        if (outer && outer[1] >= eEnd) {
          const [bStart, bEnd] = outer;
          beforeMat = input.slice(0, bStart);
          afterMat = input.slice(bEnd);
        } else {
          beforeMat = input.slice(0, cursor);
          afterMat = input.slice(eEnd);
        }
        input = beforeMat + matElem.begin + elem + matElem.end + afterMat;
      } catch (e9) {
        return input;
      }
    }
    return input;
  };
  for (const [matKey, matElem] of Object.entries(MATRIX_CONVERT_MAP)) {
    eqString = replaceMatrix(eqString, matKey, matElem);
  }
  return eqString;
}
function replaceAllBar(eqString) {
  const replaceBar = (input, barStr, barElem) => {
    while (true) {
      const cursor = input.indexOf(barStr);
      if (cursor === -1) break;
      try {
        const [eStart, eEnd] = findBrackets(input, cursor, 1);
        const elem = input.slice(eStart, eEnd);
        const outer = findEnclosingBrackets(input, cursor);
        const [replaceStart, replaceEnd] = outer && outer[1] >= eEnd ? outer : [cursor, eEnd];
        const beforeBar = input.slice(0, replaceStart);
        const afterBar = input.slice(replaceEnd);
        input = beforeBar + barElem + elem + afterBar;
      } catch (e10) {
        return input;
      }
    }
    return input;
  };
  for (const [barKey, barElem] of Object.entries(BAR_CONVERT_MAP)) {
    eqString = replaceBar(eqString, barKey, barElem);
  }
  return eqString;
}
function replaceAllBrace(eqString) {
  const replaceBrace = (input, braceStr, braceElem) => {
    while (true) {
      const cursor = input.indexOf(braceStr);
      if (cursor === -1) break;
      try {
        const [eStart1, eEnd1] = findBrackets(input, cursor, 1);
        const [eStart2, eEnd2] = findBrackets(input, eEnd1, 1);
        const elem1 = input.slice(eStart1, eEnd1);
        const elem2 = input.slice(eStart2, eEnd2);
        const beforeBrace = input.slice(0, cursor);
        const afterBrace = input.slice(eEnd2);
        input = beforeBrace + braceElem + elem1 + "^" + elem2 + afterBrace;
      } catch (e11) {
        return input;
      }
    }
    return input;
  };
  for (const [braceKey, braceElem] of Object.entries(BRACE_CONVERT_MAP)) {
    eqString = replaceBrace(eqString, braceKey, braceElem);
  }
  return eqString;
}
function replaceBracket(strList) {
  for (let i = 0; i < strList.length; i++) {
    if (strList[i] === "{" && i > 0 && strList[i - 1] === "\\left") strList[i] = "\\{";
    if (strList[i] === "}" && i > 0 && strList[i - 1] === "\\right") strList[i] = "\\}";
  }
  return strList;
}
function hmlToLatex(hmlEqStr) {
  if (!hmlEqStr) return "";
  let s = hmlEqStr.replace(/`/g, " ");
  s = s.replace(/\{/g, " { ").replace(/\}/g, " } ").replace(/&/g, " & ");
  let tokens = s.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t in CONVERT_MAP) tokens[i] = CONVERT_MAP[t];
    else if (t in MIDDLE_CONVERT_MAP) tokens[i] = MIDDLE_CONVERT_MAP[t];
    else {
      const quoted = /^"(.+)"$/.exec(t);
      if (quoted) tokens[i] = `\\text{${quoted[1]}}`;
    }
  }
  tokens = tokens.filter((tok) => tok.length !== 0);
  tokens = replaceBracket(tokens);
  let out = tokens.join(" ");
  out = replaceFrac(out);
  out = replaceRootOf(out);
  out = replaceAllMatrix(out);
  out = replaceAllBar(out);
  out = replaceAllBrace(out);
  return out;
}

// src/hwpx/para-heading.ts
var HANGUL_SYLLABLE_SEQ = "\uAC00\uB098\uB2E4\uB77C\uB9C8\uBC14\uC0AC\uC544\uC790\uCC28\uCE74\uD0C0\uD30C\uD558";
var HANGUL_JAMO_SEQ = "\u3131\u3134\u3137\u3139\u3141\u3142\u3145\u3147\u3148\u314A\u314B\u314C\u314D\u314E";
function toRoman(n) {
  if (n <= 0 || n >= 4e3) return String(n);
  const table = [
    [1e3, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
  ];
  let out = "";
  for (const [v, s] of table) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}
function formatHeadNumber(n, numFormat) {
  if (n <= 0) n = 1;
  switch (numFormat) {
    case "DIGIT":
      return String(n);
    case "CIRCLED_DIGIT":
      return n <= 20 ? String.fromCodePoint(9312 + n - 1) : `(${n})`;
    case "HANGUL_SYLLABLE":
      return HANGUL_SYLLABLE_SEQ[(n - 1) % HANGUL_SYLLABLE_SEQ.length];
    case "CIRCLED_HANGUL_SYLLABLE":
      return n <= 14 ? String.fromCodePoint(12910 + n - 1) : HANGUL_SYLLABLE_SEQ[(n - 1) % 14];
    case "HANGUL_JAMO":
      return HANGUL_JAMO_SEQ[(n - 1) % HANGUL_JAMO_SEQ.length];
    case "CIRCLED_HANGUL_JAMO":
      return n <= 14 ? String.fromCodePoint(12896 + n - 1) : HANGUL_JAMO_SEQ[(n - 1) % 14];
    case "LATIN_CAPITAL":
      return String.fromCharCode(65 + (n - 1) % 26);
    case "LATIN_SMALL":
      return String.fromCharCode(97 + (n - 1) % 26);
    case "CIRCLED_LATIN_CAPITAL":
      return n <= 26 ? String.fromCodePoint(9398 + n - 1) : String.fromCharCode(65 + (n - 1) % 26);
    case "CIRCLED_LATIN_SMALL":
      return n <= 26 ? String.fromCodePoint(9424 + n - 1) : String.fromCharCode(97 + (n - 1) % 26);
    case "ROMAN_CAPITAL":
      return toRoman(n);
    case "ROMAN_SMALL":
      return toRoman(n).toLowerCase();
    default:
      return String(n);
  }
}
function resolveParaHeading(paraEl, ctx) {
  const sm = ctx.styleMap;
  if (!sm) return null;
  const prId = paraEl.getAttribute("paraPrIDRef");
  if (!prId) return null;
  const ref = sm.paraHeadings.get(prId);
  if (!ref) return null;
  if (ref.type === "BULLET") {
    const char = sm.bullets.get(ref.idRef);
    return char ? { prefix: char } : null;
  }
  const numId = ref.type === "OUTLINE" ? ctx.outlineNumId || "1" : ref.idRef;
  const level = Math.min(ref.level + 1, 10);
  const headingLevel = ref.type === "OUTLINE" ? Math.min(ref.level + 1, 6) : void 0;
  const numDef = sm.numberings.get(numId);
  if (!numDef) return headingLevel ? { headingLevel } : null;
  let counters = ctx.shared.numState.get(numId);
  if (!counters) {
    counters = new Array(11).fill(0);
    ctx.shared.numState.set(numId, counters);
  }
  const head = numDef.heads.get(level);
  counters[level] = counters[level] === 0 ? _nullishCoalesce(_optionalChain([head, 'optionalAccess', _9 => _9.start]), () => ( 1)) : counters[level] + 1;
  for (let l = level + 1; l <= 10; l++) counters[l] = 0;
  const fmtText = head ? head.text.trim() : `^${level}.`;
  const prefix = fmtText.replace(/\^(10|[1-9])/g, (_, d) => {
    const lv = parseInt(d, 10);
    const refHead = numDef.heads.get(lv);
    const n = counters[lv] || _optionalChain([refHead, 'optionalAccess', _10 => _10.start]) || 1;
    return formatHeadNumber(n, _optionalChain([refHead, 'optionalAccess', _11 => _11.numFormat]) || "DIGIT");
  });
  return { prefix: prefix || void 0, headingLevel };
}

// src/hwpx/table-build.ts
function buildTableWithCellMeta(state) {
  const table = _chunkR2H34FY5cjs.buildTable.call(void 0, state.rows);
  if (state.caption) table.caption = state.caption;
  const anchors = [];
  {
    const covered = /* @__PURE__ */ new Set();
    for (let r = 0; r < table.rows; r++) {
      for (let c = 0; c < table.cols; c++) {
        if (covered.has(`${r},${c}`)) continue;
        const cell = _optionalChain([table, 'access', _12 => _12.cells, 'access', _13 => _13[r], 'optionalAccess', _14 => _14[c]]);
        if (!cell) continue;
        for (let dr = 0; dr < cell.rowSpan; dr++) {
          for (let dc = 0; dc < cell.colSpan; dc++) {
            if (dr === 0 && dc === 0) continue;
            if (r + dr < table.rows && c + dc < table.cols) covered.add(`${r + dr},${c + dc}`);
          }
        }
        anchors.push(cell);
        c += cell.colSpan - 1;
      }
    }
  }
  const srcCount = state.rows.reduce((s, r) => s + r.length, 0);
  const ordinalReliable = anchors.length === srcCount;
  const claimed = /* @__PURE__ */ new Set();
  let flatIdx = -1;
  for (const row of state.rows) {
    for (const src of row) {
      flatIdx++;
      const needsBlocks = src.hasStructure && src.blocks && src.blocks.length > 0;
      if (!needsBlocks && !src.isHeader) continue;
      let target;
      const trimmed = src.text.trim();
      if (src.rowAddr !== void 0 && src.colAddr !== void 0) {
        const cand = _optionalChain([table, 'access', _15 => _15.cells, 'access', _16 => _16[src.rowAddr], 'optionalAccess', _17 => _17[src.colAddr]]);
        if (cand && cand.text === trimmed && !claimed.has(cand)) target = cand;
      }
      if (!target) {
        outer: for (const irRow of table.cells) {
          for (const cand of irRow) {
            if (!claimed.has(cand) && cand.text === trimmed && cand.colSpan === src.colSpan && cand.rowSpan === src.rowSpan) {
              target = cand;
              break outer;
            }
          }
        }
      }
      if (!target && ordinalReliable) {
        const cand = anchors[flatIdx];
        if (cand && !claimed.has(cand)) target = cand;
      }
      if (!target) continue;
      claimed.add(target);
      if (needsBlocks) target.blocks = src.blocks;
      if (src.isHeader) target.isHeader = true;
    }
  }
  return table;
}
function completeTable(newTable, tableStack, blocks, ctx) {
  const parentTable = tableStack.length > 0 ? tableStack.pop() : null;
  if (newTable.rows.length === 0) {
    if (newTable.caption) blocks.push({ type: "paragraph", text: newTable.caption, pageNumber: ctx.sectionNum });
    return parentTable;
  }
  const ir = buildTableWithCellMeta(newTable);
  const block = { type: "table", table: ir, pageNumber: ctx.sectionNum };
  if (_optionalChain([parentTable, 'optionalAccess', _18 => _18.cell])) {
    const cell = parentTable.cell;
    (cell.blocks ??= []).push(block);
    cell.hasStructure = true;
    let flat = _chunkR2H34FY5cjs.convertTableToText.call(void 0, newTable.rows);
    if (newTable.caption) flat = newTable.caption + (flat ? "\n" + flat : "");
    if (flat) cell.text += (cell.text ? "\n" : "") + flat;
  } else {
    blocks.push(block);
  }
  return parentTable;
}

// src/hwpx/section-walker.ts
function parseSectionXml(xml, styleMap, warnings, sectionNum, shared) {
  const parser = createXmlParser(warnings);
  const doc = parser.parseFromString(_chunkR2H34FY5cjs.stripDtd.call(void 0, xml), "text/xml");
  if (!doc.documentElement) return [];
  const ctx = { styleMap, warnings, sectionNum, shared: _nullishCoalesce(shared, () => ( createSectionShared())) };
  ctx.shared.track.deleteDepth = 0;
  for (const tagName of ["hp:secPr", "secPr"]) {
    const els = doc.getElementsByTagName(tagName);
    if (els.length > 0) {
      const v = els[0].getAttribute("outlineShapeIDRef");
      if (v) ctx.outlineNumId = v;
      break;
    }
  }
  const blocks = [];
  walkSection(doc.documentElement, blocks, null, [], ctx);
  return blocks;
}
function extractImageRef(el) {
  const children = el.childNodes;
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType !== 1) continue;
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "");
    if (tag === "imgRect" || tag === "img" || tag === "imgClip") {
      const ref = child.getAttribute("binaryItemIDRef") || child.getAttribute("href") || "";
      if (ref) return ref;
    }
    const nested = extractImageRef(child);
    if (nested) return nested;
  }
  const directRef = el.getAttribute("binaryItemIDRef") || "";
  if (directRef) return directRef;
  return null;
}
function walkSection(node, blocks, tableCtx, tableStack, ctx, depth = 0) {
  if (depth > MAX_XML_DEPTH) return;
  const children = node.childNodes;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType !== 1) continue;
    const tag = el.tagName || el.localName || "";
    const localTag = tag.replace(/^[^:]+:/, "");
    switch (localTag) {
      case "tbl": {
        if (tableCtx) tableStack.push(tableCtx);
        const newTable = { rows: [], currentRow: [], cell: null };
        walkSection(el, blocks, newTable, tableStack, ctx, depth + 1);
        tableCtx = completeTable(newTable, tableStack, blocks, ctx);
        break;
      }
      // 표/도표 캡션 — IRTable.caption으로 보존 (v3.0, 기존 무음 드롭 수정)
      case "caption":
        if (tableCtx) {
          const capText = collectSubListText(el, ctx);
          if (capText) tableCtx.caption = (tableCtx.caption ? tableCtx.caption + "\n" : "") + capText;
        }
        break;
      case "tr":
        if (tableCtx) {
          tableCtx.currentRow = [];
          walkSection(el, blocks, tableCtx, tableStack, ctx, depth + 1);
          if (tableCtx.currentRow.length > 0) tableCtx.rows.push(tableCtx.currentRow);
          tableCtx.currentRow = [];
        }
        break;
      case "tc":
        if (tableCtx) {
          tableCtx.cell = { text: "", colSpan: 1, rowSpan: 1 };
          if (el.getAttribute("header") === "1" || el.getAttribute("header") === "true") tableCtx.cell.isHeader = true;
          walkSection(el, blocks, tableCtx, tableStack, ctx, depth + 1);
          if (tableCtx.cell) {
            tableCtx.currentRow.push(tableCtx.cell);
            tableCtx.cell = null;
          }
        }
        break;
      case "cellAddr":
        if (_optionalChain([tableCtx, 'optionalAccess', _19 => _19.cell])) {
          const ca = parseInt(el.getAttribute("colAddr") || "", 10);
          const ra = parseInt(el.getAttribute("rowAddr") || "", 10);
          if (!isNaN(ca)) tableCtx.cell.colAddr = ca;
          if (!isNaN(ra)) tableCtx.cell.rowAddr = ra;
        }
        break;
      case "cellSpan":
        if (_optionalChain([tableCtx, 'optionalAccess', _20 => _20.cell])) {
          const rawCs = parseInt(el.getAttribute("colSpan") || "1", 10);
          const cs = isNaN(rawCs) ? 1 : rawCs;
          const rawRs = parseInt(el.getAttribute("rowSpan") || "1", 10);
          const rs = isNaN(rawRs) ? 1 : rawRs;
          tableCtx.cell.colSpan = clampSpan(cs, _chunkR2H34FY5cjs.MAX_COLS);
          tableCtx.cell.rowSpan = clampSpan(rs, _chunkR2H34FY5cjs.MAX_ROWS);
        }
        break;
      case "p": {
        const { text: rawText, href, footnote, style } = extractParagraphInfo(el, ctx.styleMap, ctx);
        let text = rawText;
        let headingLevel;
        if (text) {
          const ph = resolveParaHeading(el, ctx);
          if (_optionalChain([ph, 'optionalAccess', _21 => _21.prefix])) text = ph.prefix + " " + text;
          headingLevel = _optionalChain([ph, 'optionalAccess', _22 => _22.headingLevel]);
        }
        if (text) {
          if (_optionalChain([tableCtx, 'optionalAccess', _23 => _23.cell])) {
            const cell = tableCtx.cell;
            if (footnote) text += ` (\uC8FC: ${footnote})`;
            cell.text += (cell.text ? "\n" : "") + text;
            (cell.blocks ??= []).push({ type: "paragraph", text, pageNumber: ctx.sectionNum });
          } else if (!tableCtx) {
            const block = { type: headingLevel ? "heading" : "paragraph", text, pageNumber: ctx.sectionNum };
            if (headingLevel) block.level = headingLevel;
            if (style) block.style = style;
            if (href) block.href = href;
            if (footnote) block.footnoteText = footnote;
            blocks.push(block);
          } else {
            blocks.push({ type: "paragraph", text, pageNumber: ctx.sectionNum });
          }
        }
        tableCtx = walkParagraphChildren(el, blocks, tableCtx, tableStack, ctx, depth + 1);
        break;
      }
      // 이미지/그림/글상자 — 이미지·텍스트·캡션 병행 추출
      case "pic":
      case "shape":
      case "drawingObject": {
        if (_optionalChain([tableCtx, 'optionalAccess', _24 => _24.cell])) {
          const sink = [];
          handleShape(el, sink, ctx);
          mergeBlocksIntoCell(tableCtx.cell, sink);
        } else {
          handleShape(el, blocks, ctx);
        }
        break;
      }
      // 메모 — 본문 혼입 차단 (v3.0)
      case "memogroup":
      case "memo": {
        if (ctx.warnings && extractTextFromNode(el)) {
          ctx.warnings.push({ page: ctx.sectionNum, message: "\uBA54\uBAA8 \uD14D\uC2A4\uD2B8 \uBCF8\uBB38 \uC81C\uC678: memogroup", code: "HIDDEN_TEXT_FILTERED" });
        }
        break;
      }
      default:
        walkSection(el, blocks, tableCtx, tableStack, ctx, depth + 1);
        break;
    }
  }
}
function handleShape(el, sink, ctx) {
  const imgRef = extractImageRef(el);
  const drawTextChild = findDescendant(el, "drawText");
  if (imgRef) {
    const block = { type: "image", text: imgRef, pageNumber: ctx.sectionNum };
    const alt = userShapeComment(el);
    if (alt) block.footnoteText = alt;
    sink.push(block);
  }
  if (drawTextChild) {
    extractDrawTextBlocks(drawTextChild, sink, ctx);
  }
  const capEl = findChildByLocalName(el, "caption");
  if (capEl) {
    const capText = collectSubListText(capEl, ctx);
    if (capText) sink.push({ type: "paragraph", text: capText, pageNumber: ctx.sectionNum });
  }
  if (!imgRef && !drawTextChild && ctx.warnings && ctx.sectionNum) {
    const localTag = (el.tagName || el.localName || "").replace(/^[^:]+:/, "");
    ctx.warnings.push({ page: ctx.sectionNum, message: `\uC2A4\uD0B5\uB41C \uC694\uC18C: ${localTag}`, code: "SKIPPED_IMAGE" });
  }
}
function userShapeComment(el) {
  const commentEl = findChildByLocalName(el, "shapeComment");
  if (!commentEl) return void 0;
  const text = extractTextFromNode(commentEl);
  if (!text) return void 0;
  if (/^그림입니다/.test(text)) return void 0;
  if (/^(?:모서리가 둥근 |둥근 )?[^\n]{1,20}입니다\.?$/.test(text)) return void 0;
  return text;
}
function mergeBlocksIntoCell(cell, sink) {
  for (const b of sink) {
    if ((b.type === "paragraph" || b.type === "heading") && b.text) {
      cell.text += (cell.text ? "\n" : "") + b.text;
      (cell.blocks ??= []).push(b);
    } else if (b.type === "image" || b.type === "table") {
      if (b.type === "image" && b.text) {
        cell.text += (cell.text ? "\n" : "") + `![image](${b.text})`;
      }
      ;
      (cell.blocks ??= []).push(b);
      cell.hasStructure = true;
    }
  }
}
function collectSubListText(el, ctx, depth = 0) {
  if (depth > 10) return "";
  const parts = [];
  const children = el.childNodes;
  if (!children) return "";
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    if (ch.nodeType !== 1) continue;
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "");
    if (tag === "p" || tag === "para") {
      const t = extractParagraphInfo(ch, ctx.styleMap, ctx).text;
      if (t) parts.push(t);
    } else if (tag === "tbl") {
      continue;
    } else {
      const t = collectSubListText(ch, ctx, depth + 1);
      if (t) parts.push(t);
    }
  }
  return parts.join("\n").trim();
}
function walkParagraphChildren(node, blocks, tableCtx, tableStack, ctx, depth = 0) {
  if (depth > MAX_XML_DEPTH) return tableCtx;
  const children = node.childNodes;
  if (!children) return tableCtx;
  const walkChildren = (parent, d) => {
    if (d > MAX_XML_DEPTH) return;
    const kids2 = parent.childNodes;
    if (!kids2) return;
    for (let i = 0; i < kids2.length; i++) {
      const el = kids2[i];
      if (el.nodeType !== 1) continue;
      const tag = el.tagName || el.localName || "";
      const localTag = tag.replace(/^[^:]+:/, "");
      if (localTag === "tbl") {
        if (tableCtx) tableStack.push(tableCtx);
        const newTable = { rows: [], currentRow: [], cell: null };
        walkSection(el, blocks, newTable, tableStack, ctx, d + 1);
        tableCtx = completeTable(newTable, tableStack, blocks, ctx);
      } else if (localTag === "pic" || localTag === "shape" || localTag === "drawingObject") {
        if (_optionalChain([tableCtx, 'optionalAccess', _25 => _25.cell])) {
          const sink = [];
          handleShape(el, sink, ctx);
          mergeBlocksIntoCell(tableCtx.cell, sink);
        } else {
          handleShape(el, blocks, ctx);
        }
      } else if (localTag === "drawText") {
        if (_optionalChain([tableCtx, 'optionalAccess', _26 => _26.cell])) {
          const sink = [];
          extractDrawTextBlocks(el, sink, ctx);
          mergeBlocksIntoCell(tableCtx.cell, sink);
        } else {
          extractDrawTextBlocks(el, blocks, ctx);
        }
      } else if (localTag === "r" || localTag === "run" || localTag === "ctrl" || localTag === "rect" || localTag === "ellipse" || localTag === "polygon" || localTag === "line" || localTag === "arc" || localTag === "curve" || localTag === "connectLine" || localTag === "container") {
        walkChildren(el, d + 1);
      }
    }
  };
  walkChildren(node, depth);
  return tableCtx;
}
function findDescendant(node, targetTag, depth = 0) {
  if (depth > 5) return null;
  const children = node.childNodes;
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType !== 1) continue;
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "");
    if (tag === targetTag) return child;
    const found = findDescendant(child, targetTag, depth + 1);
    if (found) return found;
  }
  return null;
}
function extractDrawTextBlocks(drawTextNode, blocks, ctx) {
  const children = drawTextNode.childNodes;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.nodeType !== 1) continue;
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "");
    if (tag === "subList" || tag === "p" || tag === "para") {
      if (tag === "subList") {
        extractDrawTextBlocks(child, blocks, ctx);
      } else {
        const info = extractParagraphInfo(child, ctx.styleMap, ctx);
        let text = info.text.trim();
        if (text) {
          const ph = resolveParaHeading(child, ctx);
          if (_optionalChain([ph, 'optionalAccess', _27 => _27.prefix])) text = ph.prefix + " " + text;
          const block = { type: "paragraph", text, style: _nullishCoalesce(info.style, () => ( void 0)), pageNumber: ctx.sectionNum };
          if (info.href) block.href = info.href;
          if (info.footnote) block.footnoteText = info.footnote;
          blocks.push(block);
        }
        walkParagraphChildren(child, blocks, null, [], ctx);
      }
    }
  }
}
function extractHyperlinkHref(fieldBegin) {
  if ((fieldBegin.getAttribute("type") || "").toUpperCase() !== "HYPERLINK") return void 0;
  const params = findChildByLocalName(fieldBegin, "parameters");
  if (!params) return void 0;
  const children = params.childNodes;
  if (!children) return void 0;
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    if (ch.nodeType !== 1) continue;
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "");
    if (tag !== "stringParam" || ch.getAttribute("name") !== "Path") continue;
    let url = (ch.textContent || "").trim();
    if (!url) continue;
    url = url.replace(/^https?:\/\/(?=https?:\/\/)/i, "");
    const safe = _chunkR2H34FY5cjs.sanitizeHref.call(void 0, url);
    if (safe) return safe;
  }
  return void 0;
}
function isInDeletedRange(ctx) {
  return (_nullishCoalesce(_optionalChain([ctx, 'optionalAccess', _28 => _28.shared, 'access', _29 => _29.track, 'access', _30 => _30.deleteDepth]), () => ( 0))) > 0;
}
function extractParagraphInfo(para, styleMap, ctx) {
  let text = "";
  let href;
  let footnote;
  let charPrId;
  const handleCtrl = (ctrlEl) => {
    const kids2 = ctrlEl.childNodes;
    if (!kids2) return;
    for (let j = 0; j < kids2.length; j++) {
      const k = kids2[j];
      if (k.nodeType !== 1) continue;
      const ktag = (k.tagName || k.localName || "").replace(/^[^:]+:/, "");
      switch (ktag) {
        // 머리말/꼬리말 — 문서당 1회 수집, 본문 앞/뒤 배치
        case "header":
        case "footer": {
          if (!ctx) break;
          const t = collectSubListText(k, ctx);
          if (t) {
            const bucket = ktag === "header" ? ctx.shared.pageText.headers : ctx.shared.pageText.footers;
            if (!bucket.includes(t)) bucket.push(t);
          }
          break;
        }
        // 각주/미주 — 해당 문단의 footnote로 인라인 보존
        case "footNote":
        case "endNote": {
          const noteText = extractTextFromNode(k);
          if (noteText) footnote = (footnote ? footnote + "; " : "") + noteText;
          break;
        }
        // 하이퍼링크 — fieldBegin type=HYPERLINK의 Path 파라미터
        case "fieldBegin": {
          const url = extractHyperlinkHref(k);
          if (url && !href) href = url;
          break;
        }
        case "fieldEnd":
          break;
        // 변경추적 — 삭제 구간(deleteBegin~End)의 텍스트는 출력 제외 (최종본 상태 재현)
        case "deleteBegin":
          if (ctx) ctx.shared.track.deleteDepth++;
          break;
        case "deleteEnd":
          if (ctx && ctx.shared.track.deleteDepth > 0) ctx.shared.track.deleteDepth--;
          break;
        case "insertBegin":
        case "insertEnd":
          break;
        // 삽입분은 최종본에 포함
        // 숨은 설명 — 본문 혼입 차단
        case "hiddenComment": {
          if (_optionalChain([ctx, 'optionalAccess', _31 => _31.warnings]) && extractTextFromNode(k)) {
            ctx.warnings.push({ page: ctx.sectionNum, message: "\uC228\uC740 \uC124\uBA85 \uD14D\uC2A4\uD2B8 \uC81C\uC678: hiddenComment", code: "HIDDEN_TEXT_FILTERED" });
          }
          break;
        }
        // 콘텐츠 없는 제어 요소 — 스킵
        case "bookmark":
        case "pageNum":
        case "pageNumCtrl":
        case "pageHiding":
        case "newNum":
        case "autoNum":
        case "indexmark":
        case "colPr":
          break;
        // 미지원 요소 — 텍스트를 가졌으면 무음 손실 대신 경고
        default: {
          if (_optionalChain([ctx, 'optionalAccess', _32 => _32.warnings]) && extractTextFromNode(k)) {
            ctx.warnings.push({ page: ctx.sectionNum, message: `\uBBF8\uC9C0\uC6D0 \uC81C\uC5B4 \uC694\uC18C\uC758 \uD14D\uC2A4\uD2B8 \uC190\uC2E4: ${ktag}`, code: "UNSUPPORTED_ELEMENT" });
          }
        }
      }
    }
  };
  const walk = (node) => {
    const children = node.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 3) {
        const t = child.textContent || "";
        if (isInDeletedRange(ctx)) {
          if (t && ctx && !ctx.shared.track.warned) {
            ctx.shared.track.warned = true;
            _optionalChain([ctx, 'access', _33 => _33.warnings, 'optionalAccess', _34 => _34.push, 'call', _35 => _35({ page: ctx.sectionNum, message: "\uBCC0\uACBD\uCD94\uC801 \uC0AD\uC81C \uD14D\uC2A4\uD2B8 \uCD9C\uB825 \uC81C\uC678", code: "HIDDEN_TEXT_FILTERED" })]);
          }
        } else {
          text += t;
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "");
      switch (tag) {
        case "t":
          walk(child);
          break;
        // 자식 순회 (tab 등 하위 요소 처리)
        case "tab": {
          const leader = child.getAttribute("leader");
          if (leader && leader !== "0") {
            text += "";
          } else {
            text += "	";
          }
          break;
        }
        case "br":
          if ((child.getAttribute("type") || "line") === "line") text += "\n";
          break;
        case "lineBreak":
          text += "\n";
          break;
        // 강제 줄바꿈 — ref 추출기·소스맵 스캐너와 동일 모델
        case "fwSpace":
        case "hwSpace":
          text += " ";
          break;
        case "tbl":
          break;
        // 테이블은 walkSection에서 처리
        // 하이퍼링크
        case "hyperlink": {
          const url = child.getAttribute("url") || child.getAttribute("href") || "";
          if (url) {
            const safe = _chunkR2H34FY5cjs.sanitizeHref.call(void 0, url);
            if (safe) href = safe;
          }
          walk(child);
          break;
        }
        // 각주/미주
        case "footNote":
        case "endNote":
        case "fn":
        case "en": {
          const noteText = extractTextFromNode(child);
          if (noteText) footnote = (footnote ? footnote + "; " : "") + noteText;
          break;
        }
        // 제어 요소 — 선별 순회 (머리말/꼬리말/각주/하이퍼링크/변경추적, v3.0)
        case "ctrl":
          handleCtrl(child);
          break;
        // run 직계 fieldBegin (비표준 경로) — 하이퍼링크 URL만 추출
        case "fieldBegin": {
          const url = extractHyperlinkHref(child);
          if (url && !href) href = url;
          break;
        }
        // run 직계 변경추적 마커 (비표준 경로)
        case "deleteBegin":
          if (ctx) ctx.shared.track.deleteDepth++;
          break;
        case "deleteEnd":
          if (ctx && ctx.shared.track.deleteDepth > 0) ctx.shared.track.deleteDepth--;
          break;
        case "insertBegin":
        case "insertEnd":
          break;
        case "fieldEnd":
        case "parameters":
        case "stringParam":
        case "integerParam":
        case "boolParam":
        case "floatParam":
        case "secPr":
        // 섹션 속성 (페이지 설정 등)
        case "colPr":
        // 다단 속성
        case "linesegarray":
        case "lineseg":
        // 레이아웃 정보
        // 도형/이미지 요소 — 대체텍스트("사각형입니다." 등) 누출 방지 (walkParagraphChildren에서 처리)
        case "pic":
        case "shape":
        case "drawingObject":
        case "shapeComment":
        case "drawText":
          break;
        // 수식: <hp:equation> 내부의 <hp:script> 에 HULK-style equation
        // 스크립트가 담겨 있음. hml-equation-parser 로 LaTeX 변환 후 `$...$`
        // 로 래핑. 실패/빈 스크립트면 무시 (대체 텍스트 누출 방지).
        case "equation": {
          const script = findChildByLocalName(child, "script");
          const raw = script ? extractTextFromNode(script) : "";
          if (raw.trim()) {
            try {
              const latex = hmlToLatex(raw).trim();
              if (latex) text += " $" + latex + "$ ";
            } catch (e12) {
            }
          }
          break;
        }
        // run 요소에서 charPrIDRef 추출
        case "r": {
          const runCharPr = child.getAttribute("charPrIDRef");
          if (runCharPr && !charPrId) charPrId = runCharPr;
          walk(child);
          break;
        }
        default:
          walk(child);
          break;
      }
    }
  };
  walk(para);
  const leaderIdx = text.indexOf("");
  if (leaderIdx >= 0) text = text.substring(0, leaderIdx);
  let cleanText = text.replace(/[ \t]+/g, " ").trim();
  if (/^그림입니다\.?\s*원본\s*그림의\s*(이름|크기)/.test(cleanText)) cleanText = "";
  cleanText = cleanText.replace(/그림입니다\.?\s*원본\s*그림의\s*(이름|크기)[^\n]*(\n[^\n]*원본\s*그림의\s*(이름|크기)[^\n]*)*/g, "").trim();
  cleanText = cleanText.replace(/(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|선|직선|곡선|화살표|오각형|육각형|팔각형|별|십자|구름|마름모|도넛|평행사변형|사다리꼴|개체|그리기\s?개체|묶음\s?개체|글상자|표|그림|OLE\s?개체)\s?입니다\.?/g, "").trim();
  let style;
  if (styleMap && charPrId) {
    const charProp = styleMap.charProperties.get(charPrId);
    if (charProp) {
      style = {};
      if (charProp.fontSize) style.fontSize = charProp.fontSize;
      if (charProp.bold) style.bold = true;
      if (charProp.italic) style.italic = true;
      if (charProp.fontName) style.fontName = charProp.fontName;
      if (!style.fontSize && !style.bold && !style.italic) style = void 0;
    }
  }
  return { text: cleanText, href, footnote, style };
}

// src/hwpx/images.ts
function imageExtToMime(ext) {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "wmf":
      return "image/wmf";
    case "emf":
      return "image/emf";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
function mimeToExt(mime) {
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("bmp")) return "bmp";
  if (mime.includes("tiff")) return "tif";
  if (mime.includes("wmf")) return "wmf";
  if (mime.includes("emf")) return "emf";
  if (mime.includes("svg")) return "svg";
  return "bin";
}
function collectImageBlocks(blocks, out, ownerCell, depth = 0) {
  if (depth > MAX_XML_DEPTH) return;
  for (const block of blocks) {
    if (block.type === "image") {
      out.push({ block, ownerCell });
    } else if (block.type === "table" && block.table) {
      for (const row of block.table.cells) {
        for (const cell of row) {
          if (_optionalChain([cell, 'access', _36 => _36.blocks, 'optionalAccess', _37 => _37.length])) collectImageBlocks(cell.blocks, out, cell, depth + 1);
        }
      }
    }
  }
}
async function extractImagesFromZip(zip, blocks, decompressed, warnings) {
  const images = [];
  let imageIndex = 0;
  const imageBlocks = [];
  collectImageBlocks(blocks, imageBlocks);
  const resolved = /* @__PURE__ */ new Map();
  for (const { block, ownerCell } of imageBlocks) {
    if (block.type !== "image" || !block.text) continue;
    const ref = block.text;
    let img = resolved.get(ref);
    if (img === void 0) {
      img = null;
      const candidates = [
        `BinData/${ref}`,
        `Contents/BinData/${ref}`,
        ref
        // 절대 경로일 수도 있음
      ];
      let resolvedPath = null;
      if (!ref.includes(".")) {
        const prefixes = [`BinData/${ref}`, `Contents/BinData/${ref}`];
        for (const prefix of prefixes) {
          const match = zip.file(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-zA-Z0-9]+$`));
          if (match.length > 0) {
            resolvedPath = match[0].name;
            break;
          }
        }
      }
      const allCandidates = resolvedPath ? [resolvedPath, ...candidates] : candidates;
      for (const path of allCandidates) {
        if (_chunkR2H34FY5cjs.isPathTraversal.call(void 0, path)) continue;
        const file = zip.file(path);
        if (!file) continue;
        try {
          const data = await file.async("uint8array");
          decompressed.total += data.length;
          if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP \uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC (ZIP bomb \uC758\uC2EC)");
          const ext = path.includes(".") ? path.split(".").pop() || "png" : "png";
          const mimeType = imageExtToMime(ext);
          imageIndex++;
          const filename = `image_${String(imageIndex).padStart(3, "0")}.${mimeToExt(mimeType)}`;
          img = { filename, data, mimeType };
          images.push(img);
          break;
        } catch (err) {
          if (err instanceof _chunkR2H34FY5cjs.KordocError) throw err;
        }
      }
      if (!img) _optionalChain([warnings, 'optionalAccess', _38 => _38.push, 'call', _39 => _39({ page: block.pageNumber, message: `\uC774\uBBF8\uC9C0 \uD30C\uC77C \uC5C6\uC74C: ${ref}`, code: "SKIPPED_IMAGE" })]);
      resolved.set(ref, img);
    }
    if (!img) {
      block.type = "paragraph";
      block.text = `[\uC774\uBBF8\uC9C0: ${ref}]`;
      if (ownerCell) ownerCell.text = ownerCell.text.replace(`![image](${ref})`, `[\uC774\uBBF8\uC9C0: ${ref}]`);
      continue;
    }
    block.text = img.filename;
    block.imageData = { data: img.data, mimeType: img.mimeType, filename: ref };
    if (ownerCell) ownerCell.text = ownerCell.text.replace(`![image](${ref})`, `![image](${img.filename})`);
  }
  return images;
}

// src/hwpx/metadata.ts


// src/hwpx/zip-sections.ts
var _zlib = require('zlib');
function extractFromBrokenZip(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let pos = 0;
  const blocks = [];
  const warnings = [
    { code: "BROKEN_ZIP_RECOVERY", message: "\uC190\uC0C1\uB41C ZIP \uAD6C\uC870 \u2014 Local File Header \uAE30\uBC18 \uBCF5\uAD6C \uBAA8\uB4DC" }
  ];
  let totalDecompressed = 0;
  let entryCount = 0;
  let sectionNum = 0;
  const shared = createSectionShared();
  while (pos < data.length - 30) {
    if (data[pos] !== 80 || data[pos + 1] !== 75 || data[pos + 2] !== 3 || data[pos + 3] !== 4) {
      pos++;
      while (pos < data.length - 30) {
        if (data[pos] === 80 && data[pos + 1] === 75 && data[pos + 2] === 3 && data[pos + 3] === 4) break;
        pos++;
      }
      continue;
    }
    if (++entryCount > MAX_ZIP_ENTRIES) break;
    const method = view.getUint16(pos + 8, true);
    const compSize = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    if (nameLen > 1024 || extraLen > 65535) {
      pos += 30 + nameLen + extraLen;
      continue;
    }
    const fileStart = pos + 30 + nameLen + extraLen;
    if (fileStart + compSize > data.length) break;
    if (compSize === 0 && method !== 0) {
      pos = fileStart;
      continue;
    }
    const nameBytes = data.slice(pos + 30, pos + 30 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    if (_chunkR2H34FY5cjs.isPathTraversal.call(void 0, name)) {
      pos = fileStart + compSize;
      continue;
    }
    const fileData = data.slice(fileStart, fileStart + compSize);
    pos = fileStart + compSize;
    if (!name.toLowerCase().includes("section") || !name.endsWith(".xml")) continue;
    try {
      let content;
      if (method === 0) {
        content = new TextDecoder().decode(fileData);
      } else if (method === 8) {
        const decompressed = _zlib.inflateRawSync.call(void 0, Buffer.from(fileData), { maxOutputLength: MAX_DECOMPRESS_SIZE });
        content = new TextDecoder().decode(decompressed);
      } else {
        continue;
      }
      totalDecompressed += content.length * 2;
      if (totalDecompressed > MAX_DECOMPRESS_SIZE) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC");
      sectionNum++;
      blocks.push(...parseSectionXml(content, void 0, warnings, sectionNum, shared));
    } catch (e13) {
      continue;
    }
  }
  if (blocks.length === 0) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uC190\uC0C1\uB41C HWPX\uC5D0\uC11C \uC139\uC158 \uB370\uC774\uD130\uB97C \uBCF5\uAD6C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  applyPageText(blocks, shared);
  const markdown = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, blocks);
  return { markdown, blocks, warnings: warnings.length > 0 ? warnings : void 0 };
}
async function resolveSectionPaths(zip) {
  const manifestPaths = ["Contents/content.hpf", "content.hpf"];
  for (const mp of manifestPaths) {
    const mpLower = mp.toLowerCase();
    const file = zip.file(mp) || Object.values(zip.files).find((f) => f.name.toLowerCase() === mpLower) || null;
    if (!file) continue;
    const xml = await file.async("text");
    const paths = parseSectionPathsFromManifest(xml);
    if (paths.length > 0) return paths;
  }
  const sectionFiles = zip.file(/[Ss]ection\d+\.xml$/);
  return sectionFiles.map((f) => f.name).sort(_chunkR2H34FY5cjs.compareSectionPaths);
}
function parseSectionPathsFromManifest(xml) {
  const parser = createXmlParser();
  const doc = parser.parseFromString(_chunkR2H34FY5cjs.stripDtd.call(void 0, xml), "text/xml");
  const items = doc.getElementsByTagName("opf:item");
  const spine = doc.getElementsByTagName("opf:itemref");
  const idToHref = /* @__PURE__ */ new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = item.getAttribute("id") || "";
    const href = _chunkR2H34FY5cjs.normalizeSectionHref.call(void 0, item.getAttribute("href") || "");
    if (id && href) idToHref.set(id, href);
  }
  if (spine.length > 0) {
    const ordered = [];
    for (let i = 0; i < spine.length; i++) {
      const href = idToHref.get(spine[i].getAttribute("idref") || "");
      if (href) ordered.push(href);
    }
    if (ordered.length > 0) return ordered;
  }
  return Array.from(idToHref.values()).sort(_chunkR2H34FY5cjs.compareSectionPaths);
}

// src/hwpx/metadata.ts
async function extractHwpxMetadata(zip, metadata, decompressed) {
  try {
    const metaPaths = ["meta.xml", "META-INF/meta.xml", "docProps/core.xml"];
    for (const mp of metaPaths) {
      const file = zip.file(mp) || Object.values(zip.files).find((f) => f.name.toLowerCase() === mp.toLowerCase()) || null;
      if (!file) continue;
      const xml = await file.async("text");
      if (decompressed) {
        decompressed.total += xml.length * 2;
        if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP \uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC (ZIP bomb \uC758\uC2EC)");
      }
      parseDublinCoreMetadata(xml, metadata);
      if (metadata.title || metadata.author) return;
    }
  } catch (e14) {
  }
}
function parseDublinCoreMetadata(xml, metadata) {
  const parser = createXmlParser();
  const doc = parser.parseFromString(_chunkR2H34FY5cjs.stripDtd.call(void 0, xml), "text/xml");
  if (!doc.documentElement) return;
  const getText = (tagNames) => {
    for (const tag of tagNames) {
      const els = doc.getElementsByTagName(tag);
      if (els.length > 0) {
        const text = _optionalChain([els, 'access', _40 => _40[0], 'access', _41 => _41.textContent, 'optionalAccess', _42 => _42.trim, 'call', _43 => _43()]);
        if (text) return text;
      }
    }
    return void 0;
  };
  metadata.title = metadata.title || getText(["dc:title", "title"]);
  metadata.author = metadata.author || getText(["dc:creator", "creator", "cp:lastModifiedBy"]);
  metadata.description = metadata.description || getText(["dc:description", "description", "dc:subject", "subject"]);
  metadata.createdAt = metadata.createdAt || getText(["dcterms:created", "meta:creation-date"]);
  metadata.modifiedAt = metadata.modifiedAt || getText(["dcterms:modified", "meta:date"]);
  const keywords = getText(["dc:keyword", "cp:keywords", "meta:keyword"]);
  if (keywords && !metadata.keywords) {
    metadata.keywords = keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean);
  }
}

// src/hwpx/parser.ts
async function parseHwpxDocument(buffer, options) {
  _chunkR2H34FY5cjs.precheckZipSize.call(void 0, buffer, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES);
  let zip;
  try {
    zip = await _jszip2.default.loadAsync(buffer);
  } catch (e15) {
    return extractFromBrokenZip(buffer);
  }
  const actualEntryCount = Object.keys(zip.files).length;
  if (actualEntryCount > MAX_ZIP_ENTRIES) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP \uC5D4\uD2B8\uB9AC \uC218 \uCD08\uACFC (ZIP bomb \uC758\uC2EC)");
  }
  const manifestFile = zip.file("META-INF/manifest.xml");
  if (manifestFile) {
    const manifestXml = await manifestFile.async("text");
    if (isEncryptedHwpx(manifestXml)) {
      if (isComFallbackAvailable() && _optionalChain([options, 'optionalAccess', _44 => _44.filePath])) {
        const { pages, pageCount, warnings: warnings2 } = extractTextViaCom(options.filePath);
        if (pages.some((p) => p && p.trim().length > 0)) {
          return comResultToParseResult(pages, pageCount, warnings2);
        }
      }
      throw new (0, _chunkR2H34FY5cjs.KordocError)("DRM \uC554\uD638\uD654\uB41C HWPX \uD30C\uC77C\uC785\uB2C8\uB2E4. Windows + \uD55C\uCEF4 \uC624\uD53C\uC2A4 \uC124\uCE58 \uC2DC \uC790\uB3D9 \uCD94\uCD9C\uB429\uB2C8\uB2E4.");
    }
  }
  const decompressed = { total: 0 };
  const metadata = {};
  await extractHwpxMetadata(zip, metadata, decompressed);
  const styleMap = await extractHwpxStyles(zip, decompressed);
  const warnings = [];
  const sectionPaths = await resolveSectionPaths(zip);
  if (sectionPaths.length === 0) throw new (0, _chunkR2H34FY5cjs.KordocError)("HWPX\uC5D0\uC11C \uC139\uC158 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  metadata.pageCount = sectionPaths.length;
  const pageFilter = _optionalChain([options, 'optionalAccess', _45 => _45.pages]) ? _chunkDCZVOIEOcjs.parsePageRange.call(void 0, options.pages, sectionPaths.length) : null;
  const totalTarget = pageFilter ? pageFilter.size : sectionPaths.length;
  const blocks = [];
  const shared = createSectionShared();
  let parsedSections = 0;
  for (let si = 0; si < sectionPaths.length; si++) {
    if (pageFilter && !pageFilter.has(si + 1)) continue;
    const file = zip.file(sectionPaths[si]);
    if (!file) continue;
    try {
      const xml = await file.async("text");
      decompressed.total += xml.length * 2;
      if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP \uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC (ZIP bomb \uC758\uC2EC)");
      blocks.push(...parseSectionXml(xml, styleMap, warnings, si + 1, shared));
      parsedSections++;
      _optionalChain([options, 'optionalAccess', _46 => _46.onProgress, 'optionalCall', _47 => _47(parsedSections, totalTarget)]);
    } catch (secErr) {
      if (secErr instanceof _chunkR2H34FY5cjs.KordocError) throw secErr;
      warnings.push({ page: si + 1, message: `\uC139\uC158 ${si + 1} \uD30C\uC2F1 \uC2E4\uD328: ${secErr instanceof Error ? secErr.message : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`, code: "PARTIAL_PARSE" });
    }
  }
  applyPageText(blocks, shared);
  const images = await extractImagesFromZip(zip, blocks, decompressed, warnings);
  detectHwpxHeadings(blocks, styleMap);
  const outline = blocks.filter((b) => b.type === "heading" && b.level && b.text).map((b) => ({ level: b.level, text: b.text, pageNumber: b.pageNumber }));
  const markdown = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, blocks);
  return { markdown, blocks, metadata, outline: outline.length > 0 ? outline : void 0, warnings: warnings.length > 0 ? warnings : void 0, images: images.length > 0 ? images : void 0 };
}

// src/hwp5/record.ts

var TAG_PARA_HEADER = 66;
var TAG_PARA_TEXT = 67;
var TAG_CHAR_SHAPE = 68;
var TAG_CTRL_HEADER = 71;
var TAG_LIST_HEADER = 72;
var TAG_TABLE = 77;
var TAG_SHAPE_COMPONENT = 76;
var TAG_SHAPE_COMPONENT_PICTURE = 85;
var TAG_SHAPE_COMPONENT_CONTAINER = 86;
var TAG_EQEDIT = 88;
var TAG_BIN_DATA = 18;
var TAG_DOC_CHAR_SHAPE = 21;
var TAG_NUMBERING = 23;
var TAG_BULLET = 24;
var TAG_DOC_PARA_SHAPE = 25;
var TAG_DOC_STYLE = 26;
var CHAR_LINE = 0;
var CHAR_SECTION_BREAK = 10;
var CHAR_PARA = 13;
var CHAR_TAB = 9;
var CHAR_HYPHEN = 30;
var CHAR_NBSP = 31;
var CHAR_FIXED_NBSP = 24;
var CHAR_FIXED_WIDTH = 25;
var FLAG_COMPRESSED = 1 << 0;
var FLAG_ENCRYPTED = 1 << 1;
var FLAG_DISTRIBUTION = 1 << 2;
var FLAG_DRM = 1 << 4;
var MAX_RECORDS = 5e5;
function readRecords(data) {
  const records = [];
  let offset = 0;
  while (offset + 4 <= data.length && records.length < MAX_RECORDS) {
    const header = data.readUInt32LE(offset);
    offset += 4;
    const tagId = header & 1023;
    const level = header >> 10 & 1023;
    let size = header >> 20 & 4095;
    if (size === 4095) {
      if (offset + 4 > data.length) break;
      size = data.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + size > data.length) break;
    records.push({ tagId, level, size, data: data.subarray(offset, offset + size) });
    offset += size;
  }
  return records;
}
var MAX_DECOMPRESS_SIZE2 = 100 * 1024 * 1024;
function decompressStream(data) {
  const opts = { maxOutputLength: MAX_DECOMPRESS_SIZE2 };
  if (data.length >= 2 && data[0] === 120) {
    try {
      return _zlib.inflateSync.call(void 0, data, opts);
    } catch (e16) {
    }
  }
  return _zlib.inflateRawSync.call(void 0, data, opts);
}
function parseFileHeader(data) {
  if (data.length < 40) throw new (0, _chunkR2H34FY5cjs.KordocError)("FileHeader\uAC00 \uB108\uBB34 \uC9E7\uC2B5\uB2C8\uB2E4 (\uCD5C\uC18C 40\uBC14\uC774\uD2B8)");
  const sig = data.subarray(0, 32).toString("utf8").replace(/\0+$/, "");
  return {
    signature: sig,
    versionMajor: data[35],
    flags: data.readUInt32LE(36)
  };
}
function readHwpString(data, offset) {
  if (offset + 2 > data.length) return { value: "", next: data.length };
  const len = data.readUInt16LE(offset);
  const start = offset + 2;
  const end = start + len * 2;
  if (len === 0 || end > data.length) return { value: "", next: start };
  return { value: data.subarray(start, end).toString("utf16le"), next: end };
}
function parseDocInfo(records) {
  const charShapes = [];
  const paraShapes = [];
  const styles = [];
  const binData = [];
  const numberings = [];
  const bullets = [];
  for (const rec of records) {
    if (rec.tagId === TAG_DOC_PARA_SHAPE && rec.data.length >= 4) {
      const attr1 = rec.data.readUInt32LE(0);
      const headType = attr1 >>> 23 & 3;
      const paraLevel = attr1 >>> 25 & 7;
      const numberingId = rec.data.length >= 32 ? rec.data.readUInt16LE(30) : 0;
      paraShapes.push({ headType, paraLevel, numberingId });
    }
    if (rec.tagId === TAG_BIN_DATA && rec.data.length >= 2) {
      const attr = rec.data.readUInt16LE(0);
      const typeBits = attr & 15;
      if (typeBits === 0) {
        binData.push({ kind: "link", storageId: 0, extension: "" });
      } else {
        const storageId = rec.data.length >= 4 ? rec.data.readUInt16LE(2) : 0;
        const { value: extension } = readHwpString(rec.data, 4);
        binData.push({ kind: typeBits === 2 ? "storage" : "embed", storageId, extension });
      }
    }
    if (rec.tagId === TAG_NUMBERING && rec.data.length >= 14) {
      const levelFormats = [];
      const numberFormats = [];
      const startNumbers = [1, 1, 1, 1, 1, 1, 1];
      let offset = 0;
      for (let level = 0; level < 7; level++) {
        if (offset + 12 > rec.data.length) {
          levelFormats.push("");
          numberFormats.push(0);
          continue;
        }
        const attr = rec.data.readUInt32LE(offset);
        numberFormats.push(attr >>> 5 & 15);
        offset += 12;
        const { value, next } = readHwpString(rec.data, offset);
        levelFormats.push(value);
        offset = next;
      }
      let baseStart = 1;
      if (offset + 2 <= rec.data.length) {
        baseStart = rec.data.readUInt16LE(offset) || 1;
        offset += 2;
      }
      for (let level = 0; level < 7; level++) {
        if (offset + 4 <= rec.data.length) {
          startNumbers[level] = rec.data.readUInt32LE(offset) || 1;
          offset += 4;
        } else {
          startNumbers[level] = baseStart;
        }
      }
      numberings.push({ levelFormats, numberFormats, startNumbers });
    }
    if (rec.tagId === TAG_BULLET && rec.data.length >= 14) {
      const code = rec.data.readUInt16LE(12);
      bullets.push({ char: code > 0 ? String.fromCharCode(code) : "\u2022" });
    }
    if (rec.tagId === TAG_DOC_CHAR_SHAPE && rec.data.length >= 18) {
      if (rec.data.length >= 50) {
        const fontSize = rec.data.readUInt32LE(42);
        const attrFlags = rec.data.readUInt32LE(46);
        charShapes.push({ fontSize, attrFlags });
      } else {
        charShapes.push({ fontSize: 0, attrFlags: 0 });
      }
    }
    if (rec.tagId === TAG_DOC_STYLE && rec.data.length >= 8) {
      try {
        let offset = 0;
        const nameLen = rec.data.readUInt16LE(offset);
        offset += 2;
        const nameBytes = nameLen * 2;
        const name = nameBytes > 0 && offset + nameBytes <= rec.data.length ? rec.data.subarray(offset, offset + nameBytes).toString("utf16le") : "";
        offset += nameBytes;
        let nameKo = "";
        if (offset + 2 <= rec.data.length) {
          const nameKoLen = rec.data.readUInt16LE(offset);
          offset += 2;
          const nameKoBytes = nameKoLen * 2;
          if (nameKoBytes > 0 && offset + nameKoBytes <= rec.data.length) {
            nameKo = rec.data.subarray(offset, offset + nameKoBytes).toString("utf16le");
          }
          offset += nameKoBytes;
        }
        const type = offset < rec.data.length ? rec.data.readUInt8(offset) : 0;
        offset += 1;
        offset += 1;
        offset += 2;
        const paraShapeId = offset + 2 <= rec.data.length ? rec.data.readUInt16LE(offset) : 0;
        offset += 2;
        const charShapeId = offset + 2 <= rec.data.length ? rec.data.readUInt16LE(offset) : 0;
        styles.push({ name, nameKo, charShapeId, paraShapeId, type });
      } catch (e17) {
      }
    }
  }
  return { charShapes, paraShapes, styles, binData, numberings, bullets };
}
function createParaTextState() {
  return { text: "", ctrlIdx: 0, fieldStack: [], fieldRanges: [] };
}
function isExtendedOnlyCtrlChar(ch) {
  return ch >= 1 && ch <= 3 || ch >= 11 && ch <= 12 || ch >= 14 && ch <= 18 || ch >= 21 && ch <= 23;
}
function appendParaText(state, data, resolveControl) {
  let result = "";
  let i = 0;
  const base = state.text.length;
  const resolveAt = (byteOffset, extended) => {
    const ctrlId = data.readUInt32LE(byteOffset);
    const idx = extended ? state.ctrlIdx : -1;
    const replacement = _optionalChain([resolveControl, 'optionalCall', _48 => _48(idx, ctrlId)]);
    if (replacement) result += replacement;
    if (extended) state.ctrlIdx++;
  };
  while (i + 1 < data.length) {
    const ch = data.readUInt16LE(i);
    i += 2;
    switch (ch) {
      // ── char 타입 (2바이트만, 확장 데이터 없음) ──
      case CHAR_LINE:
        result += "\n";
        break;
      case CHAR_SECTION_BREAK: {
        if (i + 16 <= data.length && data.readUInt16LE(i) === 11) {
          resolveAt(i + 2, true);
          i += 16;
          break;
        }
        result += "\n";
        break;
      }
      case CHAR_PARA:
        break;
      // 문단 끝
      case CHAR_HYPHEN:
        result += "-";
        break;
      case CHAR_NBSP:
        result += " ";
        break;
      case CHAR_FIXED_NBSP:
        result += "\xA0";
        break;
      // 진짜 NBSP
      case CHAR_FIXED_WIDTH:
        result += " ";
        break;
      // 고정폭 공백
      // ── inline 타입 (2바이트 + 14바이트 확장) ──
      case CHAR_TAB:
        result += "	";
        if (i + 14 <= data.length) i += 14;
        break;
      default:
        if (ch >= 1 && ch <= 31) {
          const isExtended = isExtendedOnlyCtrlChar(ch);
          const isInline = ch >= 4 && ch <= 9 || ch >= 19 && ch <= 20;
          if ((isExtended || isInline) && i + 14 <= data.length) {
            if (ch === 3) {
              state.fieldStack.push({ start: base + result.length, ctrlIdx: state.ctrlIdx });
            } else if (ch === 4) {
              const open = state.fieldStack.pop();
              if (open) {
                state.fieldRanges.push({ start: open.start, end: base + result.length, ctrlIdx: open.ctrlIdx });
              }
            }
            resolveAt(i, isExtended);
            i += 14;
          }
        } else if (ch >= 32) {
          if (ch >= 55296 && ch <= 56319 && i + 1 < data.length) {
            const lo = data.readUInt16LE(i);
            if (lo >= 56320 && lo <= 57343) {
              i += 2;
              const codePoint = (ch - 55296 << 10) + (lo - 56320) + 65536;
              result += String.fromCodePoint(codePoint);
              break;
            }
          }
          result += String.fromCharCode(ch);
        }
        break;
    }
  }
  state.text += result;
}
function extractEquationText(data) {
  if (data.length < 6) return null;
  const scriptLength = data.readUInt16LE(4);
  const scriptStart = 6;
  const scriptEnd = scriptStart + scriptLength * 2;
  if (scriptLength <= 0 || scriptEnd > data.length) return null;
  const equation = data.subarray(scriptStart, scriptEnd).toString("utf16le").replace(/\0+/g, "").trim();
  return equation || null;
}

// src/hwp5/numbering.ts
var NumberingState = (_class = class {constructor() { _class.prototype.__init.call(this);_class.prototype.__init2.call(this);_class.prototype.__init3.call(this); }
  __init() {this.currentId = 0}
  __init2() {this.counters = [0, 0, 0, 0, 0, 0, 0]}
  __init3() {this.history = /* @__PURE__ */ new Map()}
  /** 번호 문단 처리: 카운터 갱신 후 수준별 카운터 스냅샷 반환 */
  advance(numberingId, level) {
    const lv = Math.min(Math.max(level, 0), 6);
    if (this.currentId !== numberingId) {
      if (this.currentId !== 0) this.history.set(this.currentId, [...this.counters]);
      const saved = this.history.get(numberingId);
      if (saved) {
        this.counters = [...saved];
      } else {
        const prev = this.counters;
        this.counters = [0, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < lv; i++) this.counters[i] = prev[i];
      }
      this.currentId = numberingId;
    }
    this.counters[lv]++;
    for (let i = lv + 1; i < 7; i++) this.counters[i] = 0;
    return [...this.counters];
  }
}, _class);
function headFormatToNumFmt(code) {
  switch (code) {
    case 1:
      return "circled";
    case 2:
      return "romanUpper";
    case 3:
      return "romanLower";
    case 4:
      return "latinUpper";
    case 5:
      return "latinLower";
    case 8:
      return "ganada";
    case 9:
      return "circledGanada";
    case 10:
      return "jamo";
    case 11:
      return "circledJamo";
    case 12:
      return "hangulNum";
    case 13:
      return "hanjaNum";
    default:
      return "digit";
  }
}
function shapeFormatToNumFmt(code) {
  switch (code) {
    case 1:
      return "circled";
    case 2:
      return "romanUpper";
    case 3:
      return "romanLower";
    case 4:
      return "latinUpper";
    case 5:
      return "latinLower";
    case 6:
      return "ganada";
    case 7:
      return "hangulNum";
    case 8:
      return "hanjaNum";
    default:
      return "digit";
  }
}
var CIRCLED_DIGITS = "\u2460\u2461\u2462\u2463\u2464\u2465\u2466\u2467\u2468\u2469\u246A\u246B\u246C\u246D\u246E\u246F\u2470\u2471\u2472\u2473";
var GANADA = "\uAC00\uB098\uB2E4\uB77C\uB9C8\uBC14\uC0AC\uC544\uC790\uCC28\uCE74\uD0C0\uD30C\uD558";
var CIRCLED_GANADA = "\u326E\u326F\u3270\u3271\u3272\u3273\u3274\u3275\u3276\u3277\u3278\u3279\u327A\u327B";
var JAMO = "\u3131\u3134\u3137\u3139\u3141\u3142\u3145\u3147\u3148\u314A\u314B\u314C\u314D\u314E";
var CIRCLED_JAMO = "\u3260\u3261\u3262\u3263\u3264\u3265\u3266\u3267\u3268\u3269\u326A\u326B\u326C\u326D";
function fromTable(n, table) {
  return n >= 1 && n <= table.length ? table[n - 1] : String(n);
}
function formatRoman(n, upper) {
  if (n <= 0 || n > 3999) return String(n);
  const values = [1e3, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const symbols = upper ? ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"] : ["m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i"];
  let result = "";
  let num4 = n;
  for (let i = 0; i < values.length; i++) {
    while (num4 >= values[i]) {
      result += symbols[i];
      num4 -= values[i];
    }
  }
  return result;
}
function formatLatin(n, upper) {
  if (n <= 0) return "";
  let result = "";
  let num4 = n;
  while (num4 > 0) {
    num4--;
    result = String.fromCharCode((upper ? 65 : 97) + num4 % 26) + result;
    num4 = Math.floor(num4 / 26);
  }
  return result;
}
function formatEastAsianNumber(n, digits, units, zero) {
  if (n === 0) return zero;
  if (n < 0 || n > 99999) return String(n);
  let result = "";
  let num4 = n;
  let unit = 0;
  while (num4 > 0) {
    const d = num4 % 10;
    if (d > 0) {
      const digitStr = d === 1 && unit > 0 ? "" : digits[d];
      result = digitStr + units[unit] + result;
    }
    num4 = Math.floor(num4 / 10);
    unit++;
  }
  return result;
}
var HANGUL_DIGITS = ["", "\uC77C", "\uC774", "\uC0BC", "\uC0AC", "\uC624", "\uC721", "\uCE60", "\uD314", "\uAD6C"];
var HANGUL_UNITS = ["", "\uC2ED", "\uBC31", "\uCC9C", "\uB9CC"];
var HANJA_DIGITS = ["", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D", "\u4E03", "\u516B", "\u4E5D"];
var HANJA_UNITS = ["", "\u5341", "\u767E", "\u5343", "\u842C"];
function formatNumber(n, fmt) {
  switch (fmt) {
    case "circled":
      return fromTable(n, CIRCLED_DIGITS);
    case "romanUpper":
      return formatRoman(n, true);
    case "romanLower":
      return formatRoman(n, false);
    case "latinUpper":
      return formatLatin(n, true) || String(n);
    case "latinLower":
      return formatLatin(n, false) || String(n);
    case "ganada":
      return fromTable(n, GANADA);
    case "circledGanada":
      return fromTable(n, CIRCLED_GANADA);
    case "jamo":
      return fromTable(n, JAMO);
    case "circledJamo":
      return fromTable(n, CIRCLED_JAMO);
    case "hangulNum":
      return formatEastAsianNumber(n, HANGUL_DIGITS, HANGUL_UNITS, "\uC601");
    case "hanjaNum":
      return formatEastAsianNumber(n, HANJA_DIGITS, HANJA_UNITS, "\u96F6");
    default:
      return String(n);
  }
}
function expandNumberingFormat(formatStr, counters, numbering) {
  let result = "";
  let i = 0;
  while (i < formatStr.length) {
    const ch = formatStr[i];
    if (ch === "^" && i + 1 < formatStr.length && formatStr[i + 1] >= "1" && formatStr[i + 1] <= "7") {
      const levelRef = formatStr.charCodeAt(i + 1) - 48;
      const idx = levelRef - 1;
      const counterVal = _nullishCoalesce(counters[idx], () => ( 0));
      const start = _nullishCoalesce(numbering.startNumbers[idx], () => ( 1));
      const num4 = counterVal > 0 ? start - 1 + counterVal : start;
      result += formatNumber(num4, headFormatToNumFmt(_nullishCoalesce(numbering.numberFormats[idx], () => ( 0))));
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

// src/hwp5/images.ts
function detectImageMime(data) {
  if (data.length < 4) return null;
  if (data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data[0] === 71 && data[1] === 73 && data[2] === 70) return "image/gif";
  if (data[0] === 66 && data[1] === 77) return "image/bmp";
  if (data[0] === 215 && data[1] === 205 && data[2] === 198 && data[3] === 154) return "image/wmf";
  if (data[0] === 1 && data[1] === 0 && data[2] === 0 && data[3] === 0) return "image/emf";
  return null;
}
function normalizeBinPayload(data) {
  if (detectImageMime(data)) return data;
  try {
    const inflated = decompressStream(data);
    if (inflated.length > 0) return inflated;
  } catch (e18) {
  }
  return data;
}
var BIN_ENTRY_RE = /(?:^|\/)BIN([0-9A-Fa-f]{4,8})(?:\.[^./\\]*)?$/;
function collectImageBlocks2(blocks, out) {
  for (const b of blocks) {
    if (b.type === "image") out.push(b);
    if (b.table) {
      for (const row of b.table.cells) {
        for (const cell of row) {
          if (cell.blocks) collectImageBlocks2(cell.blocks, out);
        }
      }
    }
    if (b.children) collectImageBlocks2(b.children, out);
  }
}
function forEachTableCell(blocks, fn) {
  for (const b of blocks) {
    if (b.table) {
      for (const row of b.table.cells) {
        for (const cell of row) {
          fn(cell);
          if (cell.blocks) forEachTableCell(cell.blocks, fn);
        }
      }
    }
    if (b.children) forEachTableCell(b.children, fn);
  }
}
var CELL_IMAGE_SENTINEL_RE = /!\[image\]\(hwp5bin:(\d+)\)/g;
function resolveCellImageSentinels(blocks, renamed) {
  forEachTableCell(blocks, (cell) => {
    if (!cell.text.includes("hwp5bin:")) return;
    cell.text = cell.text.replace(CELL_IMAGE_SENTINEL_RE, (_m, idStr) => {
      const filename = renamed.get(Number(idStr));
      return filename ? `![image](${filename})` : "[\uC774\uBBF8\uC9C0]";
    });
  });
}
function resolveImageBlocks(binDataMap, blocks, warnings) {
  const imageBlocks = [];
  collectImageBlocks2(blocks, imageBlocks);
  if (imageBlocks.length === 0) return [];
  const images = [];
  const renamed = /* @__PURE__ */ new Map();
  const resolved = /* @__PURE__ */ new Map();
  let imageIndex = 0;
  for (const block of imageBlocks) {
    if (!block.text) continue;
    const storageId = parseInt(block.text, 10);
    if (isNaN(storageId)) continue;
    let img = resolved.get(storageId);
    if (img === void 0) {
      const bin = binDataMap.get(storageId);
      if (!bin) {
        warnings.push({ page: block.pageNumber, message: `BinData ${storageId} \uC5C6\uC74C`, code: "SKIPPED_IMAGE" });
        resolved.set(storageId, null);
      } else {
        const mime = detectImageMime(bin.data);
        if (!mime) {
          warnings.push({ page: block.pageNumber, message: `BinData ${storageId}: \uC54C \uC218 \uC5C6\uB294 \uC774\uBBF8\uC9C0 \uD615\uC2DD`, code: "SKIPPED_IMAGE" });
          resolved.set(storageId, null);
        } else {
          imageIndex++;
          const ext = mime.includes("jpeg") ? "jpg" : mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("bmp") ? "bmp" : "bin";
          img = { filename: `image_${String(imageIndex).padStart(3, "0")}.${ext}`, data: new Uint8Array(bin.data), mime };
          resolved.set(storageId, img);
          images.push({ filename: img.filename, data: img.data, mimeType: img.mime });
          renamed.set(storageId, img.filename);
        }
      }
      img = resolved.get(storageId);
    }
    if (!img) {
      const bin = binDataMap.get(storageId);
      block.type = "paragraph";
      block.text = bin ? `[\uC774\uBBF8\uC9C0: ${bin.name}]` : `[\uC774\uBBF8\uC9C0: BinData ${storageId}]`;
      continue;
    }
    block.text = img.filename;
    block.imageData = { data: img.data, mimeType: img.mime, filename: binDataMap.get(storageId).name };
  }
  resolveCellImageSentinels(blocks, renamed);
  return images;
}
function extractHwp5Images(fileIndex, blocks, warnings) {
  const binDataMap = /* @__PURE__ */ new Map();
  if (fileIndex) {
    for (const entry of fileIndex) {
      if (!_optionalChain([entry, 'optionalAccess', _49 => _49.name]) || !entry.content) continue;
      const match = entry.name.match(BIN_ENTRY_RE);
      if (!match) continue;
      const idx = parseInt(match[1], 16);
      const data = normalizeBinPayload(Buffer.from(entry.content));
      binDataMap.set(idx, { data, name: entry.name });
    }
  }
  if (binDataMap.size === 0) {
    resolveCellImageSentinels(blocks, /* @__PURE__ */ new Map());
    return [];
  }
  return resolveImageBlocks(binDataMap, blocks, warnings);
}
function extractHwp5ImagesLenient(lcfb, blocks, warnings) {
  const binDataMap = /* @__PURE__ */ new Map();
  const binRe = /^BIN([0-9A-Fa-f]{4,8})(?:\.|$)/;
  for (const e of lcfb.entries()) {
    const match = e.name.match(binRe);
    if (!match) continue;
    const idx = parseInt(match[1], 16);
    const raw = lcfb.findStream(e.name);
    if (!raw) continue;
    binDataMap.set(idx, { data: normalizeBinPayload(raw), name: e.name });
  }
  if (binDataMap.size === 0) {
    resolveCellImageSentinels(blocks, /* @__PURE__ */ new Map());
    return [];
  }
  return resolveImageBlocks(binDataMap, blocks, warnings);
}

// src/image/transcode.ts

var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ c >>> 8;
  }
  return (c ^ 4294967295) >>> 0;
}
var BI_RGB = 0;
var MAX_DIM = 32767;
var MAX_PIXELS = 36e6;
function bmpToPng(bmp) {
  if (bmp.length < 54) return null;
  if (bmp[0] !== 66 || bmp[1] !== 77) return null;
  const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const dataOffset = dv.getUint32(10, true);
  const headerSize = dv.getUint32(14, true);
  if (headerSize < 40) return null;
  const width = dv.getInt32(18, true);
  const rawHeight = dv.getInt32(22, true);
  const bitCount = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);
  if (compression !== BI_RGB) return null;
  if (bitCount !== 24 && bitCount !== 32) return null;
  if (width <= 0 || rawHeight === 0) return null;
  if (width > MAX_DIM || Math.abs(rawHeight) > MAX_DIM) return null;
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  if (width * height > MAX_PIXELS) return null;
  const bytesPerPixel = bitCount >> 3;
  const rowStride = width * bytesPerPixel + 3 & ~3;
  if (dataOffset + rowStride * height > bmp.length) return null;
  const rgba = new Uint8Array(width * height * 4);
  let anyAlpha = 0;
  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    let src = dataOffset + srcRow * rowStride;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      rgba[dst] = bmp[src + 2];
      rgba[dst + 1] = bmp[src + 1];
      rgba[dst + 2] = bmp[src];
      const a = bitCount === 32 ? bmp[src + 3] : 255;
      rgba[dst + 3] = a;
      anyAlpha |= a;
      src += bytesPerPixel;
      dst += 4;
    }
  }
  if (bitCount === 32 && anyAlpha === 0) {
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  }
  return encodePng(width, height, rgba);
}
var PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
function chunk(type, data) {
  const body = new Uint8Array(4 + data.length);
  body[0] = type.charCodeAt(0);
  body[1] = type.charCodeAt(1);
  body[2] = type.charCodeAt(2);
  body[3] = type.charCodeAt(3);
  body.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  out.set(body, 4);
  dv.setUint32(8 + data.length, crc32(body), false);
  return out;
}
function encodePng(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  const idat = _zlib.deflateSync.call(void 0, raw);
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", idat);
  const iendChunk = chunk("IEND", new Uint8Array(0));
  const out = new Uint8Array(PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let o = 0;
  out.set(PNG_SIGNATURE, o);
  o += PNG_SIGNATURE.length;
  out.set(ihdrChunk, o);
  o += ihdrChunk.length;
  out.set(idatChunk, o);
  o += idatChunk.length;
  out.set(iendChunk, o);
  return out;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function inlineImagesIntoMarkdown(markdown, images, opts) {
  const compress = _optionalChain([opts, 'optionalAccess', _50 => _50.compress]) !== false;
  let out = markdown;
  for (const img of images) {
    let bytes = img.data;
    let mime = img.mimeType;
    if (compress && mime === "image/bmp") {
      const png = bmpToPng(img.data);
      if (png) {
        bytes = png;
        mime = "image/png";
      }
    }
    const base64 = Buffer.from(bytes).toString("base64");
    const dataUri = `data:${mime};base64,${base64}`;
    const name = escapeRegExp(img.filename);
    const mdRe = new RegExp(`!\\[image\\]\\((?:images/)?${name}\\)`, "g");
    out = out.replace(mdRe, () => `![image](${dataUri})`);
    const imgTagRe = new RegExp(`(<img\\b[^>]*\\bsrc=")(?:images/)?${name}(")`, "g");
    out = out.replace(imgTagRe, (_m, pre, post) => `${pre}${dataUri}${post}`);
  }
  return out;
}

// src/hwp5/aes.ts
var S_BOX = new Uint8Array([
  99,
  124,
  119,
  123,
  242,
  107,
  111,
  197,
  48,
  1,
  103,
  43,
  254,
  215,
  171,
  118,
  202,
  130,
  201,
  125,
  250,
  89,
  71,
  240,
  173,
  212,
  162,
  175,
  156,
  164,
  114,
  192,
  183,
  253,
  147,
  38,
  54,
  63,
  247,
  204,
  52,
  165,
  229,
  241,
  113,
  216,
  49,
  21,
  4,
  199,
  35,
  195,
  24,
  150,
  5,
  154,
  7,
  18,
  128,
  226,
  235,
  39,
  178,
  117,
  9,
  131,
  44,
  26,
  27,
  110,
  90,
  160,
  82,
  59,
  214,
  179,
  41,
  227,
  47,
  132,
  83,
  209,
  0,
  237,
  32,
  252,
  177,
  91,
  106,
  203,
  190,
  57,
  74,
  76,
  88,
  207,
  208,
  239,
  170,
  251,
  67,
  77,
  51,
  133,
  69,
  249,
  2,
  127,
  80,
  60,
  159,
  168,
  81,
  163,
  64,
  143,
  146,
  157,
  56,
  245,
  188,
  182,
  218,
  33,
  16,
  255,
  243,
  210,
  205,
  12,
  19,
  236,
  95,
  151,
  68,
  23,
  196,
  167,
  126,
  61,
  100,
  93,
  25,
  115,
  96,
  129,
  79,
  220,
  34,
  42,
  144,
  136,
  70,
  238,
  184,
  20,
  222,
  94,
  11,
  219,
  224,
  50,
  58,
  10,
  73,
  6,
  36,
  92,
  194,
  211,
  172,
  98,
  145,
  149,
  228,
  121,
  231,
  200,
  55,
  109,
  141,
  213,
  78,
  169,
  108,
  86,
  244,
  234,
  101,
  122,
  174,
  8,
  186,
  120,
  37,
  46,
  28,
  166,
  180,
  198,
  232,
  221,
  116,
  31,
  75,
  189,
  139,
  138,
  112,
  62,
  181,
  102,
  72,
  3,
  246,
  14,
  97,
  53,
  87,
  185,
  134,
  193,
  29,
  158,
  225,
  248,
  152,
  17,
  105,
  217,
  142,
  148,
  155,
  30,
  135,
  233,
  206,
  85,
  40,
  223,
  140,
  161,
  137,
  13,
  191,
  230,
  66,
  104,
  65,
  153,
  45,
  15,
  176,
  84,
  187,
  22
]);
var INV_S_BOX = new Uint8Array([
  82,
  9,
  106,
  213,
  48,
  54,
  165,
  56,
  191,
  64,
  163,
  158,
  129,
  243,
  215,
  251,
  124,
  227,
  57,
  130,
  155,
  47,
  255,
  135,
  52,
  142,
  67,
  68,
  196,
  222,
  233,
  203,
  84,
  123,
  148,
  50,
  166,
  194,
  35,
  61,
  238,
  76,
  149,
  11,
  66,
  250,
  195,
  78,
  8,
  46,
  161,
  102,
  40,
  217,
  36,
  178,
  118,
  91,
  162,
  73,
  109,
  139,
  209,
  37,
  114,
  248,
  246,
  100,
  134,
  104,
  152,
  22,
  212,
  164,
  92,
  204,
  93,
  101,
  182,
  146,
  108,
  112,
  72,
  80,
  253,
  237,
  185,
  218,
  94,
  21,
  70,
  87,
  167,
  141,
  157,
  132,
  144,
  216,
  171,
  0,
  140,
  188,
  211,
  10,
  247,
  228,
  88,
  5,
  184,
  179,
  69,
  6,
  208,
  44,
  30,
  143,
  202,
  63,
  15,
  2,
  193,
  175,
  189,
  3,
  1,
  19,
  138,
  107,
  58,
  145,
  17,
  65,
  79,
  103,
  220,
  234,
  151,
  242,
  207,
  206,
  240,
  180,
  230,
  115,
  150,
  172,
  116,
  34,
  231,
  173,
  53,
  133,
  226,
  249,
  55,
  232,
  28,
  117,
  223,
  110,
  71,
  241,
  26,
  113,
  29,
  41,
  197,
  137,
  111,
  183,
  98,
  14,
  170,
  24,
  190,
  27,
  252,
  86,
  62,
  75,
  198,
  210,
  121,
  32,
  154,
  219,
  192,
  254,
  120,
  205,
  90,
  244,
  31,
  221,
  168,
  51,
  136,
  7,
  199,
  49,
  177,
  18,
  16,
  89,
  39,
  128,
  236,
  95,
  96,
  81,
  127,
  169,
  25,
  181,
  74,
  13,
  45,
  229,
  122,
  159,
  147,
  201,
  156,
  239,
  160,
  224,
  59,
  77,
  174,
  42,
  245,
  176,
  200,
  235,
  187,
  60,
  131,
  83,
  153,
  97,
  23,
  43,
  4,
  126,
  186,
  119,
  214,
  38,
  225,
  105,
  20,
  99,
  85,
  33,
  12,
  125
]);
var RCON = new Uint8Array([1, 2, 4, 8, 16, 32, 64, 128, 27, 54]);
function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 128;
    a = a << 1 & 255;
    if (hi) a ^= 27;
    b >>= 1;
  }
  return p;
}
function expandKey(key) {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) {
    w[i] = key[4 * i] << 24 | key[4 * i + 1] << 16 | key[4 * i + 2] << 8 | key[4 * i + 3];
  }
  for (let i = 4; i < 44; i++) {
    let temp = w[i - 1];
    if (i % 4 === 0) {
      temp = (temp << 8 | temp >>> 24) >>> 0;
      temp = S_BOX[temp >>> 24 & 255] << 24 | S_BOX[temp >>> 16 & 255] << 16 | S_BOX[temp >>> 8 & 255] << 8 | S_BOX[temp & 255];
      temp = (temp ^ RCON[i / 4 - 1] << 24) >>> 0;
    }
    w[i] = (w[i - 4] ^ temp) >>> 0;
  }
  return w;
}
function decryptBlock(block, roundKeys) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = block[i];
  addRoundKey(s, roundKeys, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s);
    invSubBytes(s);
    addRoundKey(s, roundKeys, round);
    invMixColumns(s);
  }
  invShiftRows(s);
  invSubBytes(s);
  addRoundKey(s, roundKeys, 0);
  return s;
}
function addRoundKey(s, w, round) {
  const base = round * 4;
  for (let c = 0; c < 4; c++) {
    const k = w[base + c];
    s[c * 4] ^= k >>> 24 & 255;
    s[c * 4 + 1] ^= k >>> 16 & 255;
    s[c * 4 + 2] ^= k >>> 8 & 255;
    s[c * 4 + 3] ^= k & 255;
  }
}
function invSubBytes(s) {
  for (let i = 0; i < 16; i++) s[i] = INV_S_BOX[s[i]];
}
function invShiftRows(s) {
  let t = s[13];
  s[13] = s[9];
  s[9] = s[5];
  s[5] = s[1];
  s[1] = t;
  t = s[2];
  s[2] = s[10];
  s[10] = t;
  t = s[6];
  s[6] = s[14];
  s[14] = t;
  t = s[3];
  s[3] = s[7];
  s[7] = s[11];
  s[11] = s[15];
  s[15] = t;
}
function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}
function aes128EcbDecrypt(data, key) {
  if (key.length !== 16) throw new Error("AES-128 \uD0A4\uB294 16\uBC14\uC774\uD2B8\uC5EC\uC57C \uD569\uB2C8\uB2E4");
  if (data.length % 16 !== 0) throw new Error("AES ECB \uC785\uB825\uC740 16\uBC14\uC774\uD2B8\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4");
  const roundKeys = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.subarray(offset, offset + 16);
    const decrypted = decryptBlock(block, roundKeys);
    out.set(decrypted, offset);
  }
  return out;
}

// src/hwp5/crypto.ts
var MsvcLcg = class {
  
  constructor(seed) {
    this.seed = seed >>> 0;
  }
  /** 0 ~ 0x7FFF 범위 난수 반환 (MSVC rand() 호환) */
  rand() {
    this.seed = Math.imul(this.seed, 214013) + 2531011 >>> 0;
    return this.seed >>> 16 & 32767;
  }
};
function decryptDistributePayload(payload) {
  if (payload.length < 256) throw new Error("\uBC30\uD3EC\uC6A9 payload\uAC00 256\uBC14\uC774\uD2B8 \uBBF8\uB9CC\uC785\uB2C8\uB2E4");
  const seed = (payload[0] | payload[1] << 8 | payload[2] << 16 | payload[3] << 24) >>> 0;
  const lcg = new MsvcLcg(seed);
  const result = new Uint8Array(payload.subarray(0, 256));
  let i = 0;
  let n = 0;
  let key = 0;
  while (i < 256) {
    if (n === 0) {
      key = lcg.rand() & 255;
      n = (lcg.rand() & 15) + 1;
    }
    if (i >= 4) {
      result[i] ^= key;
    }
    i++;
    n--;
  }
  return result;
}
function extractAesKey(decryptedPayload) {
  const offset = 4 + (decryptedPayload[0] & 15);
  if (offset + 16 > decryptedPayload.length) {
    throw new Error("AES \uD0A4 \uCD94\uCD9C \uC2E4\uD328: \uC624\uD504\uC14B\uC774 payload \uBC94\uC704\uB97C \uCD08\uACFC\uD569\uB2C8\uB2E4");
  }
  return decryptedPayload.slice(offset, offset + 16);
}
function parseRecordHeader(data, offset) {
  if (offset + 4 > data.length) throw new Error("\uB808\uCF54\uB4DC \uD5E4\uB354 \uD30C\uC2F1 \uC2E4\uD328: \uB370\uC774\uD130 \uBD80\uC871");
  const header = (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24) >>> 0;
  const tagId = header & 1023;
  let size = header >>> 20 & 4095;
  let headerSize = 4;
  if (size === 4095) {
    if (offset + 8 > data.length) throw new Error("\uD655\uC7A5 \uB808\uCF54\uB4DC \uD06C\uAE30 \uD30C\uC2F1 \uC2E4\uD328: \uB370\uC774\uD130 \uBD80\uC871");
    size = (data[offset + 4] | data[offset + 5] << 8 | data[offset + 6] << 16 | data[offset + 7] << 24) >>> 0;
    headerSize = 8;
  }
  return { tagId, size, headerSize };
}
var TAG_DISTRIBUTE_DOC_DATA = 16 + 12;
function decryptViewText(viewTextRaw, compressed) {
  const data = new Uint8Array(viewTextRaw);
  const rec = parseRecordHeader(data, 0);
  if (rec.tagId !== TAG_DISTRIBUTE_DOC_DATA) {
    throw new Error(`\uBC30\uD3EC\uC6A9 \uBB38\uC11C\uC758 \uCCAB \uB808\uCF54\uB4DC\uAC00 DISTRIBUTE_DOC_DATA(${TAG_DISTRIBUTE_DOC_DATA})\uAC00 \uC544\uB2D9\uB2C8\uB2E4 (\uC2E4\uC81C: ${rec.tagId})`);
  }
  const payloadStart = rec.headerSize;
  const payloadEnd = payloadStart + rec.size;
  if (payloadEnd > data.length || rec.size < 256) {
    throw new Error("\uBC30\uD3EC\uC6A9 payload\uAC00 \uC720\uD6A8\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
  }
  const payload = data.subarray(payloadStart, payloadStart + 256);
  const decryptedPayload = decryptDistributePayload(payload);
  const aesKey = extractAesKey(decryptedPayload);
  const encryptedStart = payloadEnd;
  const encryptedData = data.subarray(encryptedStart);
  if (encryptedData.length === 0) {
    throw new Error("\uBC30\uD3EC\uC6A9 \uBB38\uC11C\uC5D0 \uC554\uD638\uD654\uB41C \uBCF8\uBB38 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4");
  }
  const alignedLen = encryptedData.length - encryptedData.length % 16;
  if (alignedLen === 0) {
    throw new Error("\uC554\uD638\uD654\uB41C \uB370\uC774\uD130\uAC00 \uB108\uBB34 \uC9E7\uC2B5\uB2C8\uB2E4 (16\uBC14\uC774\uD2B8 \uBBF8\uB9CC)");
  }
  const alignedData = encryptedData.subarray(0, alignedLen);
  const decrypted = aes128EcbDecrypt(alignedData, aesKey);
  if (compressed) {
    try {
      return decompressStream(Buffer.from(decrypted));
    } catch (e19) {
      return Buffer.from(decrypted);
    }
  }
  return Buffer.from(decrypted);
}

// src/hwp5/equation.ts
var WORD_COMMANDS = /* @__PURE__ */ new Map([
  ["alpha", "\\alpha"],
  ["beta", "\\beta"],
  ["gamma", "\\gamma"],
  ["delta", "\\delta"],
  ["epsilon", "\\epsilon"],
  ["theta", "\\theta"],
  ["lambda", "\\lambda"],
  ["mu", "\\mu"],
  ["pi", "\\pi"],
  ["sigma", "\\sigma"],
  ["tau", "\\tau"],
  ["phi", "\\phi"],
  ["omega", "\\omega"],
  ["sin", "\\sin"],
  ["cos", "\\cos"],
  ["tan", "\\tan"],
  ["sec", "\\sec"],
  ["csc", "\\csc"],
  ["cot", "\\cot"],
  ["log", "\\log"],
  ["ln", "\\ln"],
  ["lim", "\\lim"],
  ["inf", "\\infty"],
  ["sum", "\\sum"],
  ["smallsum", "\\sum"],
  ["prod", "\\prod"],
  ["int", "\\int"],
  ["oint", "\\oint"],
  ["rightarrow", "\\rightarrow"],
  ["leftarrow", "\\leftarrow"],
  ["partial", "\\partial"],
  ["nabla", "\\nabla"],
  ["angle", "\\angle"],
  ["triangle", "\\triangle"],
  ["vec", "\\vec"],
  ["bar", "\\overline"],
  ["dot", "\\dot"],
  ["hat", "\\hat"],
  ["left", "\\left"],
  ["right", "\\right"]
]);
var SYMBOL_WORDS = /* @__PURE__ */ new Map([
  ["times", "\\times"],
  ["divide", "\\div"],
  ["div", "\\div"],
  ["le", "\\leq"],
  ["ge", "\\geq"],
  ["geq", "\\geq"],
  ["deg", "^\\circ"],
  ["rarrow", "\\rightarrow"],
  ["larrow", "\\leftarrow"],
  ["lrarrow", "\\leftrightarrow"],
  ["in", "\\in"],
  ["notin", "\\notin"],
  ["emptyset", "\\emptyset"],
  ["subset", "\\subset"],
  ["nsubset", "\\nsubseteq"],
  ["cup", "\\cup"],
  ["cap", "\\cap"],
  ["smallinter", "\\cap"],
  ["sim", "\\sim"],
  ["circ", "\\circ"],
  ["bot", "\\perp"],
  ["dyad", "\\overleftrightarrow"],
  ["arch", "\\overset{\\frown}"]
]);
function hwpEquationToLatex(equation) {
  return convertEquation(equation.replace(/\0/g, "").trim(), 0);
}
function convertEquation(equation, depth) {
  if (!equation || depth > 12) return equation;
  let result = equation.replace(/\s+/g, " ").replace(/`+/g, "\\,").replace(/~+/g, "\\,").trim();
  result = convertMatrixLike(result);
  result = convertRoots(result, depth);
  result = convertOver(result, depth);
  result = convertSqrt(result, depth);
  result = convertScripts(result);
  result = convertOperators(result);
  result = removeFontDirectives(result);
  result = convertWords(result);
  result = cleanupLatexSpacing(result);
  return result;
}
function convertMatrixLike(input) {
  return input.replace(
    /\bmatrix\s*\{([^{}]*)\}/gi,
    (_match, body) => `\\begin{matrix} ${body.split("#").map((part) => part.trim()).join(" & ")} \\end{matrix}`
  ).replace(
    /\bcases\s*\{([^{}]*)\}/gi,
    (_match, body) => `\\begin{cases} ${body.split("#").map((part) => part.trim()).join(" \\\\ ")} \\end{cases}`
  );
}
function convertRoots(input, depth) {
  return input.replace(/(?<!\\)\broot\s+({[^{}]*}|\S+)\s+of\s+({[^{}]*}|\S+)/gi, (_match, degree, radicand) => {
    return `\\sqrt[${convertEquation(unwrapGroup(degree), depth + 1)}]{${convertEquation(unwrapGroup(radicand), depth + 1)}}`;
  });
}
function convertSqrt(input, depth) {
  return input.replace(/(?<!\\)\bsqrt\s*({[^{}]*}|\S+)/gi, (_match, radicand) => {
    return `\\sqrt{${convertEquation(unwrapGroup(radicand), depth + 1)}}`;
  });
}
function convertOver(input, depth) {
  let result = input;
  for (let guard = 0; guard < 50; guard++) {
    const over = findTopLevelWord(result, "over");
    if (over < 0) break;
    const left = readLeftAtom(result, over);
    const right = readRightAtom(result, over + "over".length);
    if (!left || !right) break;
    const numerator = convertEquation(unwrapGroup(left.atom), depth + 1);
    const denominator = convertEquation(unwrapGroup(right.atom), depth + 1);
    result = result.slice(0, left.start) + `\\frac{${numerator}}{${denominator}}` + result.slice(right.end);
  }
  return result;
}
function convertScripts(input) {
  return input.replace(/\s*\^\s*/g, "^").replace(/\s*_\s*/g, "_").replace(/\^(?!\{)([^\s{}_^]+)/g, "^{$1}").replace(/_(?!\{)([^\s{}_^]+)/g, "_{$1}");
}
function convertOperators(input) {
  return input.replace(/\+-/g, "\\pm").replace(/-\+/g, "\\mp").replace(/\/\//g, "\\parallel").replace(/△/g, "\\triangle ").replace(/□/g, "\\square ").replace(/‧/g, "\\cdot ").replace(/!=/g, "\\neq").replace(/<=/g, "\\leq").replace(/>=/g, "\\geq").replace(/==/g, "\\equiv");
}
function removeFontDirectives(input) {
  return input.replace(/(?<!\\)\b(?:rm|it)\b\s*/gi, "");
}
function convertWords(input) {
  return input.replace(/(?<![\\A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)(?![A-Za-z0-9])/g, (word) => {
    const exact = SYMBOL_WORDS.get(word);
    if (exact) return exact;
    const lower = word.toLowerCase();
    return _nullishCoalesce(_nullishCoalesce(SYMBOL_WORDS.get(lower), () => ( WORD_COMMANDS.get(lower))), () => ( word));
  });
}
function cleanupLatexSpacing(input) {
  return input.replace(/\\left\s*\{/g, "\\left\\{").replace(/\\right\s*\}/g, "\\right\\}").replace(/\\left\s*([\[\]\(\)\|])/g, "\\left$1").replace(/\\right\s*([\[\]\(\)\|])/g, "\\right$1").replace(/\s*\\,\s*/g, "\\,").replace(/\s+/g, " ").replace(/\{\s+/g, "{").replace(/\s+\}/g, "}").trim();
}
function findTopLevelWord(input, word) {
  let curly = 0;
  let paren = 0;
  for (let i = 0; i <= input.length - word.length; i++) {
    const ch = input[i];
    if (ch === "{") curly++;
    else if (ch === "}") curly = Math.max(0, curly - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    if (curly !== 0 || paren !== 0) continue;
    if (input.slice(i, i + word.length).toLowerCase() !== word) continue;
    if (isWordChar(input[i - 1]) || isWordChar(input[i + word.length])) continue;
    return i;
  }
  return -1;
}
function readLeftAtom(input, end) {
  let pos = end - 1;
  while (pos >= 0 && /\s/.test(input[pos])) pos--;
  if (pos < 0) return null;
  if (input[pos] === "}") {
    const start2 = findMatchingLeft(input, pos, "{", "}");
    if (start2 >= 0) return { start: start2, atom: input.slice(start2, pos + 1) };
  }
  if (input[pos] === ")") {
    const start2 = findMatchingLeft(input, pos, "(", ")");
    if (start2 >= 0) return { start: start2, atom: input.slice(start2, pos + 1) };
  }
  let start = pos;
  while (start >= 0 && !/\s/.test(input[start]) && !/[+\-=<>]/.test(input[start])) start--;
  return { start: start + 1, atom: input.slice(start + 1, pos + 1) };
}
function readRightAtom(input, start) {
  let pos = start;
  while (pos < input.length && /\s/.test(input[pos])) pos++;
  if (pos >= input.length) return null;
  if (input[pos] === "{") {
    const end2 = findMatchingRight(input, pos, "{", "}");
    if (end2 >= 0) return { end: end2 + 1, atom: input.slice(pos, end2 + 1) };
  }
  if (input[pos] === "(") {
    const end2 = findMatchingRight(input, pos, "(", ")");
    if (end2 >= 0) return { end: end2 + 1, atom: input.slice(pos, end2 + 1) };
  }
  let end = pos;
  while (end < input.length && !/\s/.test(input[end]) && !/[+\-=<>]/.test(input[end])) end++;
  return { end, atom: input.slice(pos, end) };
}
function findMatchingLeft(input, closeIndex, open, close) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    if (input[i] === close) depth++;
    else if (input[i] === open) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function findMatchingRight(input, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < input.length; i++) {
    if (input[i] === open) depth++;
    else if (input[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function unwrapGroup(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed.slice(1, -1);
  return trimmed;
}
function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

// src/hwp5/parser.ts
var _module = require('module');
var require2 = _module.createRequire.call(void 0, _chunkGS7T56RPcjs.importMetaUrl);
var CFB = require2("cfb");
var MAX_SECTIONS = 100;
var MAX_TOTAL_DECOMPRESS = 100 * 1024 * 1024;
var MAX_NEST_DEPTH = 8;
function cid(s) {
  return (s.charCodeAt(0) << 24 | s.charCodeAt(1) << 16 | s.charCodeAt(2) << 8 | s.charCodeAt(3)) >>> 0;
}
var CTRL_TBL = cid("tbl ");
var CTRL_GSO = cid("gso ");
var CTRL_EQED = cid("eqed");
var CTRL_HEAD = cid("head");
var CTRL_FOOT = cid("foot");
var CTRL_FN = cid("fn  ");
var CTRL_EN = cid("en  ");
var CTRL_ATNO = cid("atno");
var CTRL_NWNO = cid("nwno");
var CTRL_PGNP = cid("pgnp");
var CTRL_PGHD = cid("pghd");
var CTRL_IDXM = cid("idxm");
var CTRL_BOKM = cid("bokm");
var CTRL_TCPS = cid("tcps");
var CTRL_TDUT = cid("tdut");
var CTRL_TCMT = cid("tcmt");
var CTRL_SECD = cid("secd");
var CTRL_COLD = cid("cold");
var CTRL_FORM = cid("form");
var CTRL_OLE = cid("ole ");
var FIELD_HLK = cid("%hlk");
var FIELD_CLK = cid("%clk");
var KNOWN_CTRL_IDS = /* @__PURE__ */ new Set([
  CTRL_TBL,
  CTRL_GSO,
  CTRL_EQED,
  CTRL_HEAD,
  CTRL_FOOT,
  CTRL_FN,
  CTRL_EN,
  CTRL_ATNO,
  CTRL_NWNO,
  CTRL_PGNP,
  CTRL_PGHD,
  CTRL_IDXM,
  CTRL_BOKM,
  CTRL_TCPS,
  CTRL_TDUT,
  CTRL_TCMT,
  CTRL_SECD,
  CTRL_COLD,
  CTRL_FORM,
  CTRL_OLE
]);
function isFieldCtrlId(id) {
  return id >>> 24 === 37;
}
function swap32(id) {
  return ((id & 255) << 24 | (id >>> 8 & 255) << 16 | (id >>> 16 & 255) << 8 | id >>> 24 & 255) >>> 0;
}
function normalizeCtrlId(raw) {
  if (KNOWN_CTRL_IDS.has(raw) || isFieldCtrlId(raw)) return raw;
  const sw = swap32(raw);
  if (KNOWN_CTRL_IDS.has(sw) || isFieldCtrlId(sw)) return sw;
  return raw;
}
function parseHwp5Document(buffer, options) {
  let cfb = null;
  let lenientCfb = null;
  const warnings = [];
  try {
    cfb = CFB.parse(buffer);
  } catch (e20) {
    try {
      lenientCfb = parseLenientCfb(buffer);
      warnings.push({ message: "\uC190\uC0C1\uB41C CFB \uCEE8\uD14C\uC774\uB108 \u2014 lenient \uBAA8\uB4DC\uB85C \uBCF5\uAD6C", code: "LENIENT_CFB_RECOVERY" });
    } catch (e21) {
      throw new (0, _chunkR2H34FY5cjs.KordocError)("CFB \uCEE8\uD14C\uC774\uB108 \uD30C\uC2F1 \uC2E4\uD328 (strict \uBC0F lenient \uBAA8\uB450)");
    }
  }
  const findStream = (path) => {
    if (cfb) {
      const entry = CFB.find(cfb, path);
      return _optionalChain([entry, 'optionalAccess', _51 => _51.content]) ? Buffer.from(entry.content) : null;
    }
    return lenientCfb.findStream(path);
  };
  const headerData = findStream("/FileHeader");
  if (!headerData) throw new (0, _chunkR2H34FY5cjs.KordocError)("FileHeader \uC2A4\uD2B8\uB9BC \uC5C6\uC74C");
  const header = parseFileHeader(headerData);
  if (header.signature !== "HWP Document File") throw new (0, _chunkR2H34FY5cjs.KordocError)("HWP \uC2DC\uADF8\uB2C8\uCC98 \uBD88\uC77C\uCE58");
  if (header.flags & FLAG_ENCRYPTED) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uC554\uD638\uD654\uB41C HWP\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
  if (header.flags & FLAG_DRM) throw new (0, _chunkR2H34FY5cjs.KordocError)("DRM \uBCF4\uD638\uB41C HWP\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
  const compressed = (header.flags & FLAG_COMPRESSED) !== 0;
  const distribution = (header.flags & FLAG_DISTRIBUTION) !== 0;
  const metadata = {
    version: `${header.versionMajor}.x`
  };
  if (cfb) extractHwp5Metadata(cfb, metadata);
  const docInfo = cfb ? parseDocInfoStream(cfb, compressed) : parseDocInfoFromStream(findStream("/DocInfo"), compressed);
  const sections = distribution ? cfb ? findViewTextSections(cfb, compressed) : findViewTextSectionsLenient(lenientCfb, compressed) : cfb ? findSections(cfb) : findSectionsLenient(lenientCfb, compressed);
  if (sections.length === 0) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uC139\uC158 \uC2A4\uD2B8\uB9BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  metadata.pageCount = sections.length;
  const pageFilter = _optionalChain([options, 'optionalAccess', _52 => _52.pages]) ? _chunkDCZVOIEOcjs.parsePageRange.call(void 0, options.pages, sections.length) : null;
  const totalTarget = pageFilter ? pageFilter.size : sections.length;
  const bodyBlocks = [];
  const doc = createHwp5DocState();
  let totalDecompressed = 0;
  let parsedSections = 0;
  for (let si = 0; si < sections.length; si++) {
    if (pageFilter && !pageFilter.has(si + 1)) continue;
    try {
      const sectionData = sections[si];
      const data = !distribution && compressed ? decompressStream(Buffer.from(sectionData)) : Buffer.from(sectionData);
      totalDecompressed += data.length;
      if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uCD1D \uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC (decompression bomb \uC758\uC2EC)");
      const records = readRecords(data);
      const sectionBlocks = parseSection(records, docInfo, warnings, si + 1, doc);
      bodyBlocks.push(...sectionBlocks);
      parsedSections++;
      _optionalChain([options, 'optionalAccess', _53 => _53.onProgress, 'optionalCall', _54 => _54(parsedSections, totalTarget)]);
    } catch (secErr) {
      if (secErr instanceof _chunkR2H34FY5cjs.KordocError) throw secErr;
      warnings.push({ page: si + 1, message: `\uC139\uC158 ${si + 1} \uD30C\uC2F1 \uC2E4\uD328: ${secErr instanceof Error ? secErr.message : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`, code: "PARTIAL_PARSE" });
    }
  }
  const blocks = [...doc.headerBlocks, ...bodyBlocks, ...doc.footerBlocks];
  const images = cfb ? extractHwp5Images(cfb.FileIndex, blocks, warnings) : extractHwp5ImagesLenient(lenientCfb, blocks, warnings);
  let flatBlocks = _chunkR2H34FY5cjs.flattenLayoutTables.call(void 0, blocks);
  if (_optionalChain([options, 'optionalAccess', _55 => _55.dedupeRunningHeaders])) {
    const deduped = _chunkR2H34FY5cjs.dedupeRunningHeaders.call(void 0, flatBlocks);
    const removed = flatBlocks.length - deduped.length;
    if (removed > 0) warnings.push({ message: `\uBC18\uBCF5 \uB7EC\uB2DD \uD5E4\uB354 ${removed}\uAC1C \uC81C\uAC70`, code: "HIDDEN_TEXT_FILTERED" });
    flatBlocks = deduped;
  }
  if (docInfo) {
    detectHwp5Headings(flatBlocks, docInfo);
  }
  const outline = flatBlocks.filter((b) => b.type === "heading" && b.level && b.text).map((b) => ({ level: b.level, text: b.text, pageNumber: b.pageNumber }));
  let markdown = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, flatBlocks);
  if (_optionalChain([options, 'optionalAccess', _56 => _56.inlineImages]) && images.length > 0) {
    try {
      markdown = inlineImagesIntoMarkdown(markdown, images, { compress: true });
    } catch (inlineErr) {
      warnings.push({ message: `\uC774\uBBF8\uC9C0 \uC778\uB77C\uC778 \uC2E4\uD328 \u2014 \uC6D0\uBCF8 \uD30C\uC77C \uCC38\uC870\uB85C \uD3F4\uBC31: ${inlineErr instanceof Error ? inlineErr.message : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`, code: "SKIPPED_IMAGE" });
    }
  }
  return { markdown, blocks: flatBlocks, metadata, outline: outline.length > 0 ? outline : void 0, warnings: warnings.length > 0 ? warnings : void 0, images: images.length > 0 ? images : void 0 };
}
function parseDocInfoStream(cfb, compressed) {
  try {
    const entry = CFB.find(cfb, "/DocInfo");
    if (!_optionalChain([entry, 'optionalAccess', _57 => _57.content])) return null;
    const data = compressed ? decompressStream(Buffer.from(entry.content)) : Buffer.from(entry.content);
    const records = readRecords(data);
    return parseDocInfo(records);
  } catch (e22) {
    return null;
  }
}
function parseDocInfoFromStream(raw, compressed) {
  if (!raw) return null;
  try {
    const data = compressed ? decompressStream(raw) : raw;
    return parseDocInfo(readRecords(data));
  } catch (e23) {
    return null;
  }
}
function detectHwp5Headings(blocks, docInfo) {
  let baseFontSize = 0;
  const sizeFreq = /* @__PURE__ */ new Map();
  for (const b of blocks) {
    if (_optionalChain([b, 'access', _58 => _58.style, 'optionalAccess', _59 => _59.fontSize]) && b.text) {
      sizeFreq.set(b.style.fontSize, (sizeFreq.get(b.style.fontSize) || 0) + b.text.length);
    }
  }
  let maxWeight = 0;
  for (const [size, weight] of sizeFreq) {
    if (weight > maxWeight) {
      maxWeight = weight;
      baseFontSize = size;
    }
  }
  if (baseFontSize === 0) {
    for (const style of docInfo.styles) {
      const name = (style.nameKo || style.name).toLowerCase();
      if (name.includes("\uBC14\uD0D5") || name.includes("\uBCF8\uBB38") || name === "normal" || name === "body") {
        const cs = docInfo.charShapes[style.charShapeId];
        if (_optionalChain([cs, 'optionalAccess', _60 => _60.fontSize]) > 0) {
          baseFontSize = cs.fontSize / 10;
          break;
        }
      }
    }
  }
  if (baseFontSize <= 0) return;
  for (const block of blocks) {
    if (block.type === "heading") continue;
    if (block.type !== "paragraph" || !block.text) continue;
    const text = block.text.trim();
    if (text.length === 0 || text.length > 200) continue;
    if (/^\d+$/.test(text)) continue;
    let level = 0;
    if (_optionalChain([block, 'access', _61 => _61.style, 'optionalAccess', _62 => _62.fontSize]) && baseFontSize > 0) {
      const ratio = block.style.fontSize / baseFontSize;
      if (ratio >= _chunkR2H34FY5cjs.HEADING_RATIO_H1) level = 1;
      else if (ratio >= _chunkR2H34FY5cjs.HEADING_RATIO_H2) level = 2;
      else if (ratio >= _chunkR2H34FY5cjs.HEADING_RATIO_H3) level = 3;
    }
    if (/^제\d+[장절편]\s/.test(text) && text.length <= 50) {
      if (level === 0) level = 2;
    } else if (/^제\d+(조의?\d*)\s*[\(（]/.test(text) && text.length <= 80) {
      if (level === 0) level = 3;
    }
    if (level > 0) {
      block.type = "heading";
      block.level = level;
    }
  }
}
function extractHwp5Metadata(cfb, metadata) {
  try {
    const summaryEntry = CFB.find(cfb, "/HwpSummaryInformation") || CFB.find(cfb, "/SummaryInformation");
    if (!_optionalChain([summaryEntry, 'optionalAccess', _63 => _63.content])) return;
    const data = Buffer.from(summaryEntry.content);
    if (data.length < 48) return;
    const numSets = data.readUInt32LE(24);
    if (numSets === 0) return;
    const setOffset = data.readUInt32LE(44);
    if (setOffset >= data.length - 8) return;
    const numProps = data.readUInt32LE(setOffset + 4);
    if (numProps === 0 || numProps > 100) return;
    for (let i = 0; i < numProps; i++) {
      const entryOffset = setOffset + 8 + i * 8;
      if (entryOffset + 8 > data.length) break;
      const propId = data.readUInt32LE(entryOffset);
      const propOffset = setOffset + data.readUInt32LE(entryOffset + 4);
      if (propOffset + 8 > data.length) continue;
      if (propId !== 2 && propId !== 4 && propId !== 6) continue;
      const propType = data.readUInt32LE(propOffset);
      if (propType !== 30) continue;
      const strLen = data.readUInt32LE(propOffset + 4);
      if (strLen === 0 || strLen > 1e4 || propOffset + 8 + strLen > data.length) continue;
      const str = data.subarray(propOffset + 8, propOffset + 8 + strLen).toString("utf8").replace(/\0+$/, "").trim();
      if (!str) continue;
      if (propId === 2) metadata.title = str;
      else if (propId === 4) metadata.author = str;
      else if (propId === 6) metadata.description = str;
    }
  } catch (e24) {
  }
}
function findViewTextSections(cfb, compressed) {
  const sections = [];
  for (let i = 0; i < MAX_SECTIONS; i++) {
    const entry = CFB.find(cfb, `/ViewText/Section${i}`);
    if (!_optionalChain([entry, 'optionalAccess', _64 => _64.content])) break;
    try {
      const decrypted = decryptViewText(Buffer.from(entry.content), compressed);
      sections.push({ idx: i, content: decrypted });
    } catch (e25) {
      break;
    }
  }
  return sections.sort((a, b) => a.idx - b.idx).map((s) => s.content);
}
function findSections(cfb) {
  const sections = [];
  for (let i = 0; i < MAX_SECTIONS; i++) {
    const entry = CFB.find(cfb, `/BodyText/Section${i}`);
    if (!_optionalChain([entry, 'optionalAccess', _65 => _65.content])) break;
    sections.push({ idx: i, content: Buffer.from(entry.content) });
  }
  if (sections.length === 0 && cfb.FileIndex) {
    for (const entry of cfb.FileIndex) {
      if (sections.length >= MAX_SECTIONS) break;
      if (_optionalChain([entry, 'access', _66 => _66.name, 'optionalAccess', _67 => _67.startsWith, 'call', _68 => _68("Section")]) && entry.content) {
        const idx = parseInt(entry.name.replace("Section", ""), 10) || 0;
        sections.push({ idx, content: Buffer.from(entry.content) });
      }
    }
  }
  return sections.sort((a, b) => a.idx - b.idx).map((s) => s.content);
}
function findSectionsLenient(lcfb, compressed) {
  const sections = [];
  let totalDecompressed = 0;
  for (let i = 0; i < MAX_SECTIONS; i++) {
    const raw = _nullishCoalesce(lcfb.findStream(`/BodyText/Section${i}`), () => ( lcfb.findStream(`Section${i}`)));
    if (!raw) break;
    const content = compressed ? decompressStream(raw) : raw;
    totalDecompressed += content.length;
    if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uCD1D \uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC (decompression bomb \uC758\uC2EC)");
    sections.push({ idx: i, content });
  }
  if (sections.length === 0) {
    for (const e of lcfb.entries()) {
      if (sections.length >= MAX_SECTIONS) break;
      if (e.name.startsWith("Section")) {
        const idx = parseInt(e.name.replace("Section", ""), 10) || 0;
        const raw = lcfb.findStream(e.name);
        if (raw) {
          const content = compressed ? decompressStream(raw) : raw;
          totalDecompressed += content.length;
          if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uCD1D \uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC (decompression bomb \uC758\uC2EC)");
          sections.push({ idx, content });
        }
      }
    }
  }
  return sections.sort((a, b) => a.idx - b.idx).map((s) => s.content);
}
function findViewTextSectionsLenient(lcfb, compressed) {
  const sections = [];
  let totalDecompressed = 0;
  for (let i = 0; i < MAX_SECTIONS; i++) {
    const raw = _nullishCoalesce(lcfb.findStream(`/ViewText/Section${i}`), () => ( lcfb.findStream(`Section${i}`)));
    if (!raw) break;
    try {
      const content = decryptViewText(raw, compressed);
      totalDecompressed += content.length;
      if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uCD1D \uC555\uCD95 \uD574\uC81C \uD06C\uAE30 \uCD08\uACFC (decompression bomb \uC758\uC2EC)");
      sections.push({ idx: i, content });
    } catch (e26) {
      break;
    }
  }
  return sections.sort((a, b) => a.idx - b.idx).map((s) => s.content);
}
function formatEquationForMarkdown(equation) {
  const normalized = hwpEquationToLatex(equation);
  if (!normalized) return "";
  return `$${normalized.replace(/\$/g, "\\$")}$`;
}
function extractEquationFromSlice(records, start, end) {
  for (let i = start; i < end; i++) {
    if (records[i].tagId !== TAG_EQEDIT) continue;
    const equation = extractEquationText(records[i].data);
    return equation ? formatEquationForMarkdown(equation) : null;
  }
  return null;
}
function createHwp5DocState() {
  return {
    numbering: new NumberingState(),
    outlineNumberingId: 0,
    autoCounters: /* @__PURE__ */ new Map(),
    headerTexts: /* @__PURE__ */ new Set(),
    headerBlocks: [],
    footerBlocks: []
  };
}
function parseSection(records, docInfo, warnings, sectionNum, doc) {
  const ctx = { docInfo, warnings, sectionNum, doc: _nullishCoalesce(doc, () => ( createHwp5DocState())), depth: 0 };
  return parseParagraphList(records, 0, records.length, ctx);
}
function parseParagraphList(records, start, end, ctx) {
  const blocks = [];
  let i = start;
  while (i < end) {
    if (records[i].tagId === TAG_PARA_HEADER) {
      const baseLevel = records[i].level;
      let j = i + 1;
      while (j < end && records[j].level > baseLevel) j++;
      blocks.push(...parseParagraph(records, i, j, ctx));
      i = j;
    } else {
      i++;
    }
  }
  return blocks;
}
function parseParagraph(records, start, end, ctx) {
  const header = records[start];
  const baseLevel = header.level;
  const paraShapeId = header.data.length >= 10 ? header.data.readUInt16LE(8) : -1;
  const textRecords = [];
  const charShapeIds = [];
  const ctrls = [];
  let i = start + 1;
  while (i < end) {
    const rec = records[i];
    if (rec.tagId === TAG_CTRL_HEADER && rec.level === baseLevel + 1 && rec.data.length >= 4) {
      const childStart = i + 1;
      let j = childStart;
      while (j < end && records[j].level > baseLevel + 1) j++;
      const idRaw = rec.data.readUInt32LE(0);
      ctrls.push({ id: normalizeCtrlId(idRaw), idRaw, data: rec.data, childStart, childEnd: j });
      i = j;
      continue;
    }
    if (rec.tagId === TAG_PARA_TEXT && rec.level === baseLevel + 1) {
      textRecords.push(rec.data);
    } else if (rec.tagId === TAG_CHAR_SHAPE && rec.level === baseLevel + 1 && rec.data.length >= 8) {
      for (let offset = 0; offset + 7 < rec.data.length; offset += 8) {
        charShapeIds.push(rec.data.readUInt32LE(offset + 4));
      }
    }
    i++;
  }
  for (const ctrl of ctrls) {
    applyCtrlEffect(ctrl, records, ctx);
  }
  const state = createParaTextState();
  const resolver = (idx, id) => {
    let ctrl = idx >= 0 && idx < ctrls.length ? ctrls[idx] : void 0;
    if (!ctrl || ctrl.idRaw !== id && ctrl.id !== id) {
      ctrl = ctrls.find((c) => !c.resolved && (c.idRaw === id || c.id === id));
    }
    if (!ctrl) return null;
    ctrl.resolved = true;
    return _nullishCoalesce(ctrl.inlineText, () => ( null));
  };
  for (const data of textRecords) {
    appendParaText(state, data, resolver);
  }
  let text = state.text;
  if (state.fieldRanges.length > 0) {
    const ranges = [...state.fieldRanges].sort((a, b) => b.start - a.start);
    const applied = [];
    for (const r of ranges) {
      const ctrl = ctrls[r.ctrlIdx];
      if (!_optionalChain([ctrl, 'optionalAccess', _69 => _69.href]) || r.end <= r.start) continue;
      if (applied.some(([s, e]) => r.start < e && r.end > s)) continue;
      const href = _chunkR2H34FY5cjs.sanitizeHref.call(void 0, ctrl.href);
      if (!href) continue;
      const anchor = text.slice(r.start, r.end);
      if (!anchor.trim()) continue;
      text = text.slice(0, r.start) + `[${anchor}](${href})` + text.slice(r.end);
      applied.push([r.start, r.end]);
    }
  }
  const trimmed = text.replace(/\$\$/g, "$ $").trim();
  let headingLevel = 0;
  let headMarker = null;
  const ps = ctx.docInfo && paraShapeId >= 0 && paraShapeId < ctx.docInfo.paraShapes.length ? ctx.docInfo.paraShapes[paraShapeId] : null;
  if (ps && ps.headType > 0) {
    if (ps.headType === 1) {
      headingLevel = Math.min(ps.paraLevel + 1, 6);
    }
    if (ps.headType === 1 || ps.headType === 2) {
      const nid = ps.numberingId || (ps.headType === 1 ? ctx.doc.outlineNumberingId : 0);
      const numbering = nid >= 1 ? _optionalChain([ctx, 'access', _70 => _70.docInfo, 'optionalAccess', _71 => _71.numberings, 'access', _72 => _72[nid - 1]]) : void 0;
      if (numbering) {
        const counters = ctx.doc.numbering.advance(nid, ps.paraLevel);
        const fmt = numbering.levelFormats[Math.min(ps.paraLevel, 6)];
        if (fmt) {
          const headText = expandNumberingFormat(fmt, counters, numbering);
          if (headText) headMarker = headText;
        }
      }
    } else if (ps.headType === 3) {
      const bullet = ps.numberingId >= 1 ? _optionalChain([ctx, 'access', _73 => _73.docInfo, 'optionalAccess', _74 => _74.bullets, 'access', _75 => _75[ps.numberingId - 1]]) : void 0;
      if (bullet && bullet.char !== "\uFFFF") headMarker = bullet.char;
    }
  }
  const blocks = [];
  const footnotes = ctrls.filter((c) => c.footnote).map((c) => c.footnote);
  if (trimmed) {
    const block = {
      type: headingLevel > 0 ? "heading" : "paragraph",
      text: headMarker ? `${headMarker} ${trimmed}` : trimmed,
      pageNumber: ctx.sectionNum
    };
    if (headingLevel > 0) block.level = headingLevel;
    if (ctx.docInfo && charShapeIds.length > 0) {
      const style = resolveCharStyle(charShapeIds, ctx.docInfo);
      if (style) block.style = style;
    }
    if (footnotes.length > 0) block.footnoteText = footnotes.join("; ");
    blocks.push(block);
  } else if (footnotes.length > 0) {
    blocks.push({ type: "paragraph", text: `(\uC8FC: ${footnotes.join("; ")})`, pageNumber: ctx.sectionNum });
  }
  for (const ctrl of ctrls) {
    if (ctrl.afterBlocks) blocks.push(...ctrl.afterBlocks);
  }
  return blocks;
}
function applyCtrlEffect(ctrl, records, ctx) {
  switch (ctrl.id) {
    case CTRL_TBL: {
      const table = parseTableControl(ctrl, records, ctx);
      if (table) ctrl.afterBlocks = [{ type: "table", table, pageNumber: ctx.sectionNum }];
      return;
    }
    case CTRL_GSO: {
      const blocks = parseGsoControl(ctrl, records, ctx);
      if (blocks.length > 0) ctrl.afterBlocks = blocks;
      return;
    }
    case CTRL_EQED: {
      const eq = extractEquationFromSlice(records, ctrl.childStart, ctrl.childEnd);
      if (eq) ctrl.inlineText = eq;
      return;
    }
    case CTRL_FN:
    case CTRL_EN: {
      applyNoteEffect(ctrl, records, ctx, ctrl.id === CTRL_FN ? 1 : 2);
      return;
    }
    case CTRL_HEAD:
    case CTRL_FOOT: {
      applyHeaderFooterEffect(ctrl, records, ctx, ctrl.id === CTRL_HEAD);
      return;
    }
    case CTRL_ATNO: {
      if (ctrl.data.length >= 8) {
        const attr = ctrl.data.readUInt32LE(4);
        const type = attr & 15;
        const format = attr >>> 4 & 255;
        const num4 = _nullishCoalesce(ctx.doc.autoCounters.get(type), () => ( 1));
        ctx.doc.autoCounters.set(type, num4 + 1);
        const prefix = ctrl.data.length >= 14 ? wcharAt(ctrl.data, 12) : "";
        const suffix = ctrl.data.length >= 16 ? wcharAt(ctrl.data, 14) : "";
        ctrl.inlineText = `${prefix}${formatNumber(num4, shapeFormatToNumFmt(format))}${suffix}`;
      }
      return;
    }
    case CTRL_NWNO: {
      if (ctrl.data.length >= 10) {
        const attr = ctrl.data.readUInt32LE(4);
        const type = attr & 15;
        const num4 = ctrl.data.readUInt16LE(8);
        if (num4 > 0) ctx.doc.autoCounters.set(type, num4);
      }
      return;
    }
    case CTRL_SECD: {
      if (ctrl.data.length >= 20) {
        ctx.doc.outlineNumberingId = ctrl.data.readUInt16LE(18);
      }
      return;
    }
    case CTRL_OLE: {
      ctx.warnings.push({ page: ctx.sectionNum, message: "\uC2A4\uD0B5\uB41C OLE \uAC1C\uCCB4", code: "SKIPPED_OLE" });
      return;
    }
    // 숨은 설명/단 정의/쪽번호 위치/감추기/찾아보기/책갈피/글자겹침/덧말 — 본문 텍스트 없음 또는 의도적 스킵
    case CTRL_TCMT:
    case CTRL_COLD:
    case CTRL_PGNP:
    case CTRL_PGHD:
    case CTRL_IDXM:
    case CTRL_BOKM:
    case CTRL_TCPS:
    case CTRL_TDUT:
    case CTRL_FORM:
      return;
    default: {
      if (isFieldCtrlId(ctrl.id)) {
        applyFieldEffect(ctrl);
        return;
      }
      const blocks = parseListHeaderParagraphs(ctrl, records, ctx);
      if (blocks.length > 0) ctrl.afterBlocks = blocks;
    }
  }
}
function wcharAt(data, offset) {
  const code = data.readUInt16LE(offset);
  return code > 0 ? String.fromCharCode(code) : "";
}
function parseListHeaderParagraphs(ctrl, records, ctx) {
  if (ctx.depth >= MAX_NEST_DEPTH) return [];
  for (let i = ctrl.childStart; i < ctrl.childEnd; i++) {
    if (records[i].tagId === TAG_LIST_HEADER) {
      return parseParagraphList(records, i + 1, ctrl.childEnd, { ...ctx, depth: ctx.depth + 1 });
    }
  }
  return [];
}
function blocksPlainText(blocks, sep) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "image") continue;
    if (b.type === "table") continue;
    if (b.text) {
      let t = b.text;
      if (b.footnoteText) t += ` (\uC8FC: ${b.footnoteText})`;
      parts.push(t);
    }
  }
  return parts.join(sep).trim();
}
function applyNoteEffect(ctrl, records, ctx, autoType) {
  const num4 = _nullishCoalesce(ctx.doc.autoCounters.get(autoType), () => ( 1));
  let before = "";
  let after = "";
  let shape = 0;
  if (ctrl.data.length >= 12) {
    before = wcharAt(ctrl.data, 8);
    after = wcharAt(ctrl.data, 10);
  }
  if (ctrl.data.length >= 16) {
    shape = ctrl.data.readUInt32LE(12) & 255;
  }
  const formatted = formatNumber(num4, shapeFormatToNumFmt(shape));
  const marker = before || after ? `${before}${formatted}${after}` : `${formatted})`;
  const content = blocksPlainText(parseListHeaderParagraphs(ctrl, records, ctx), " ");
  if ((_nullishCoalesce(ctx.doc.autoCounters.get(autoType), () => ( 1))) <= num4) {
    ctx.doc.autoCounters.set(autoType, num4 + 1);
  }
  ctrl.inlineText = marker;
  if (content) ctrl.footnote = content.startsWith(marker) ? content : `${marker} ${content}`;
}
function applyHeaderFooterEffect(ctrl, records, ctx, isHeader) {
  const text = blocksPlainText(parseListHeaderParagraphs(ctrl, records, ctx), "\n");
  if (!text) return;
  const key = (isHeader ? "h:" : "f:") + text;
  if (ctx.doc.headerTexts.has(key)) return;
  ctx.doc.headerTexts.add(key);
  const block = { type: "paragraph", text, pageNumber: ctx.sectionNum };
  if (isHeader) ctx.doc.headerBlocks.push(block);
  else ctx.doc.footerBlocks.push(block);
}
function applyFieldEffect(ctrl) {
  if (ctrl.id === FIELD_HLK) {
    const command = parseFieldCommand(ctrl.data);
    if (command) {
      const url = hyperlinkUrlFromCommand(command);
      if (url) ctrl.href = url;
    }
  }
}
function parseFieldCommand(data) {
  if (data.length < 11) return null;
  const cmdLen = data.readUInt16LE(9);
  if (cmdLen === 0) return null;
  const start = 11;
  const end = start + cmdLen * 2;
  if (end > data.length) return null;
  return data.subarray(start, end).toString("utf16le").replace(/\0+$/, "");
}
function hyperlinkUrlFromCommand(command) {
  let url = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && i + 1 < command.length) {
      url += command[i + 1];
      i++;
      continue;
    }
    if (c === ";") break;
    url += c;
  }
  url = url.trim();
  return url.length > 0 && url.length < 2e3 ? url : null;
}
function parseTableControl(ctrl, records, ctx) {
  if (ctx.depth >= MAX_NEST_DEPTH) return null;
  const { childStart, childEnd } = ctrl;
  let rows = 0;
  let cols = 0;
  let tableIdx = -1;
  for (let i2 = childStart; i2 < childEnd; i2++) {
    if (records[i2].tagId === TAG_TABLE && records[i2].data.length >= 8) {
      rows = Math.min(records[i2].data.readUInt16LE(4), _chunkR2H34FY5cjs.MAX_ROWS);
      cols = Math.min(records[i2].data.readUInt16LE(6), _chunkR2H34FY5cjs.MAX_COLS);
      tableIdx = i2;
      break;
    }
  }
  if (tableIdx < 0 || rows === 0 || cols === 0) return null;
  let caption;
  for (let i2 = childStart; i2 < tableIdx; i2++) {
    if (records[i2].tagId === TAG_LIST_HEADER) {
      const capBlocks = parseParagraphList(records, i2 + 1, tableIdx, { ...ctx, depth: ctx.depth + 1 });
      const capText = blocksPlainText(capBlocks, " ");
      if (capText) caption = capText;
      break;
    }
  }
  const cells = [];
  let i = tableIdx + 1;
  while (i < childEnd) {
    const rec = records[i];
    if (rec.tagId === TAG_LIST_HEADER) {
      const cellLevel = rec.level;
      let j = i + 1;
      while (j < childEnd) {
        const r = records[j];
        if (r.level < cellLevel) break;
        if (r.level === cellLevel && (r.tagId === TAG_LIST_HEADER || r.tagId === TAG_TABLE)) break;
        j++;
      }
      cells.push(parseCell(records, i, j, ctx));
      i = j;
      continue;
    }
    i++;
  }
  if (cells.length === 0) return null;
  const hasAddr = cells.some((c) => c.colAddr !== void 0 && c.rowAddr !== void 0);
  if (hasAddr) {
    const cellRows2 = arrangeCells(rows, cols, cells);
    const irCells = cellRows2.map((row) => row.map((c) => {
      const ir = { text: c.text.trim(), colSpan: c.colSpan, rowSpan: c.rowSpan };
      if (_optionalChain([c, 'access', _76 => _76.blocks, 'optionalAccess', _77 => _77.length])) ir.blocks = c.blocks;
      if (c.isHeader) ir.isHeader = true;
      return ir;
    }));
    const table2 = { rows, cols, cells: irCells, hasHeader: rows > 1 };
    if (caption) table2.caption = caption;
    return table2;
  }
  const cellRows = arrangeCells(rows, cols, cells);
  const table = _chunkR2H34FY5cjs.buildTable.call(void 0, cellRows);
  if (caption && table.rows > 0) table.caption = caption;
  return table.rows > 0 ? table : null;
}
function parseCell(records, lhIdx, end, ctx) {
  const rec = records[lhIdx];
  let colSpan = 1;
  let rowSpan = 1;
  let colAddr;
  let rowAddr;
  let isHeader = false;
  if (rec.data.length >= 16) {
    isHeader = (rec.data.readUInt16LE(6) & 4) !== 0;
    colAddr = rec.data.readUInt16LE(8);
    rowAddr = rec.data.readUInt16LE(10);
    const cs = rec.data.readUInt16LE(12);
    const rs = rec.data.readUInt16LE(14);
    if (cs > 0) colSpan = Math.min(cs, _chunkR2H34FY5cjs.MAX_COLS);
    if (rs > 0) rowSpan = Math.min(rs, _chunkR2H34FY5cjs.MAX_ROWS);
  }
  const blocks = ctx.depth < MAX_NEST_DEPTH ? parseParagraphList(records, lhIdx + 1, end, { ...ctx, depth: ctx.depth + 1 }) : [];
  const parts = [];
  let hasStructure = false;
  for (const b of blocks) {
    if (b.type === "image" && b.text) {
      parts.push(`![image](hwp5bin:${b.text})`);
      hasStructure = true;
    } else if (b.type === "table" && b.table) {
      const flat = _chunkR2H34FY5cjs.convertTableToText.call(void 0, b.table.cells);
      if (flat) parts.push(flat);
      hasStructure = true;
    } else if (b.text) {
      let t = b.text;
      if (b.footnoteText) {
        t += ` (\uC8FC: ${b.footnoteText})`;
        hasStructure = true;
      }
      parts.push(t);
    }
  }
  const cell = { text: parts.join("\n"), colSpan, rowSpan, colAddr, rowAddr };
  if (hasStructure && blocks.length > 0) cell.blocks = blocks;
  if (isHeader) cell.isHeader = true;
  return cell;
}
function arrangeCells(rows, cols, cells) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
  const hasAddr = cells.some((c) => c.colAddr !== void 0 && c.rowAddr !== void 0);
  if (hasAddr) {
    for (const cell of cells) {
      const r = _nullishCoalesce(cell.rowAddr, () => ( 0));
      const c = _nullishCoalesce(cell.colAddr, () => ( 0));
      if (r >= rows || c >= cols) continue;
      grid[r][c] = cell;
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (r + dr < rows && c + dc < cols)
            grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 };
        }
      }
    }
  } else {
    let cellIdx = 0;
    for (let r = 0; r < rows && cellIdx < cells.length; r++) {
      for (let c = 0; c < cols && cellIdx < cells.length; c++) {
        if (grid[r][c] !== null) continue;
        const cell = cells[cellIdx++];
        grid[r][c] = cell;
        for (let dr = 0; dr < cell.rowSpan; dr++) {
          for (let dc = 0; dc < cell.colSpan; dc++) {
            if (dr === 0 && dc === 0) continue;
            if (r + dr < rows && c + dc < cols)
              grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 };
          }
        }
      }
    }
  }
  return grid.map((row) => row.map((c) => c || { text: "", colSpan: 1, rowSpan: 1 }));
}
function parseGsoControl(ctrl, records, ctx) {
  if (ctx.depth >= MAX_NEST_DEPTH) return [];
  const { childStart, childEnd } = ctrl;
  const blocks = [];
  let scIdx = -1;
  for (let i = childStart; i < childEnd; i++) {
    const t = records[i].tagId;
    if (t === TAG_SHAPE_COMPONENT || t === TAG_SHAPE_COMPONENT_CONTAINER) {
      scIdx = i;
      break;
    }
  }
  if (scIdx > childStart) {
    for (let i = childStart; i < scIdx; i++) {
      if (records[i].tagId === TAG_LIST_HEADER) {
        blocks.push(...parseParagraphList(records, i + 1, scIdx, { ...ctx, depth: ctx.depth + 1 }));
        break;
      }
    }
  }
  const scanStart = scIdx >= 0 ? scIdx + 1 : childStart;
  let textListIdx = -1;
  for (let i = scanStart; i < childEnd; i++) {
    if (records[i].tagId === TAG_LIST_HEADER) {
      textListIdx = i;
      break;
    }
  }
  const picEnd = textListIdx >= 0 ? textListIdx : childEnd;
  for (let i = scanStart; i < picEnd; i++) {
    if (records[i].tagId === TAG_SHAPE_COMPONENT_PICTURE) {
      const img = pictureToImageBlock(records[i].data, ctx);
      if (img) blocks.push(img);
    }
  }
  if (textListIdx >= 0) {
    blocks.push(...parseParagraphList(records, textListIdx + 1, childEnd, { ...ctx, depth: ctx.depth + 1 }));
  }
  return blocks;
}
function pictureToImageBlock(data, ctx) {
  if (data.length < 73) return null;
  const binDataId = data.readUInt16LE(71);
  if (binDataId === 0) return null;
  const item = _optionalChain([ctx, 'access', _78 => _78.docInfo, 'optionalAccess', _79 => _79.binData, 'access', _80 => _80[binDataId - 1]]);
  if (_optionalChain([item, 'optionalAccess', _81 => _81.kind]) === "link") {
    ctx.warnings.push({ page: ctx.sectionNum, message: `\uC678\uBD80 \uC5F0\uACB0 \uC774\uBBF8\uC9C0 (binDataId ${binDataId})`, code: "SKIPPED_IMAGE" });
    return null;
  }
  const storageId = item && item.storageId > 0 ? item.storageId : binDataId;
  return { type: "image", text: String(storageId), pageNumber: ctx.sectionNum };
}
function resolveCharStyle(charShapeIds, docInfo) {
  if (charShapeIds.length === 0 || docInfo.charShapes.length === 0) return void 0;
  const freq = /* @__PURE__ */ new Map();
  let maxCount = 0, dominantId = charShapeIds[0];
  for (const id of charShapeIds) {
    const count = (freq.get(id) || 0) + 1;
    freq.set(id, count);
    if (count > maxCount) {
      maxCount = count;
      dominantId = id;
    }
  }
  const cs = docInfo.charShapes[dominantId];
  if (!cs) return void 0;
  const style = {};
  if (cs.fontSize > 0) style.fontSize = cs.fontSize / 10;
  if (cs.attrFlags & 1) style.italic = true;
  if (cs.attrFlags & 2) style.bold = true;
  return style.fontSize || style.bold || style.italic ? style : void 0;
}

// src/hwp3/parser.ts


// src/hwp3/johab-symbols.ts
var JOHAB_SYMBOLS = Object.freeze([
  33857,
  12288,
  33858,
  12593,
  33859,
  12594,
  33860,
  12595,
  33861,
  12596,
  33862,
  12597,
  33863,
  12598,
  33864,
  12599,
  33865,
  12601,
  33866,
  12602,
  33867,
  12603,
  33868,
  12604,
  33869,
  12605,
  33870,
  12606,
  33871,
  12607,
  33872,
  12608,
  33873,
  12609,
  33875,
  12610,
  33876,
  12612,
  33877,
  12613,
  33878,
  12614,
  33879,
  12615,
  33880,
  12616,
  33881,
  12618,
  33882,
  12619,
  33883,
  12620,
  33884,
  12621,
  33885,
  12622,
  33889,
  12623,
  33921,
  12624,
  33953,
  12625,
  33985,
  12626,
  34017,
  12627,
  34113,
  12628,
  34145,
  12629,
  34177,
  12630,
  34209,
  12631,
  34241,
  12632,
  34273,
  12633,
  34369,
  12634,
  34401,
  12635,
  34433,
  12636,
  34465,
  12637,
  34497,
  12638,
  34529,
  12639,
  34625,
  12640,
  34657,
  12641,
  34689,
  12642,
  34721,
  12643,
  34881,
  12593,
  35905,
  12594,
  36929,
  12596,
  37953,
  12599,
  38977,
  12600,
  40001,
  12601,
  41025,
  12609,
  42049,
  12610,
  43073,
  12611,
  44097,
  12613,
  45121,
  12614,
  46145,
  12615,
  47169,
  12616,
  48193,
  12617,
  49217,
  12618,
  50241,
  12619,
  51265,
  12620,
  52289,
  12621,
  53313,
  12622,
  55601,
  12288,
  55602,
  12289,
  55603,
  12290,
  55604,
  183,
  55605,
  8229,
  55606,
  8230,
  55607,
  168,
  55608,
  12291,
  55609,
  173,
  55610,
  8213,
  55611,
  8741,
  55612,
  65340,
  55613,
  8764,
  55614,
  8216,
  55615,
  8217,
  55616,
  8220,
  55617,
  8221,
  55618,
  12308,
  55619,
  12309,
  55620,
  12296,
  55621,
  12297,
  55622,
  12298,
  55623,
  12299,
  55624,
  12300,
  55625,
  12301,
  55626,
  12302,
  55627,
  12303,
  55628,
  12304,
  55629,
  12305,
  55630,
  177,
  55631,
  215,
  55632,
  247,
  55633,
  8800,
  55634,
  8804,
  55635,
  8805,
  55636,
  8734,
  55637,
  8756,
  55638,
  176,
  55639,
  8242,
  55640,
  8243,
  55641,
  8451,
  55642,
  8491,
  55643,
  65504,
  55644,
  65505,
  55645,
  65509,
  55646,
  9794,
  55647,
  9792,
  55648,
  8736,
  55649,
  8869,
  55650,
  8978,
  55651,
  8706,
  55652,
  8711,
  55653,
  8801,
  55654,
  8786,
  55655,
  167,
  55656,
  8251,
  55657,
  9734,
  55658,
  9733,
  55659,
  9675,
  55660,
  9679,
  55661,
  9678,
  55662,
  9671,
  55663,
  9670,
  55664,
  9633,
  55665,
  9632,
  55666,
  9651,
  55667,
  9650,
  55668,
  9661,
  55669,
  9660,
  55670,
  8594,
  55671,
  8592,
  55672,
  8593,
  55673,
  8595,
  55674,
  8596,
  55675,
  12307,
  55676,
  8810,
  55677,
  8811,
  55678,
  8730,
  55697,
  8765,
  55698,
  8733,
  55699,
  8757,
  55700,
  8747,
  55701,
  8748,
  55702,
  8712,
  55703,
  8715,
  55704,
  8838,
  55705,
  8839,
  55706,
  8834,
  55707,
  8835,
  55708,
  8746,
  55709,
  8745,
  55710,
  8743,
  55711,
  8744,
  55712,
  65506,
  55713,
  8658,
  55714,
  8660,
  55715,
  8704,
  55716,
  8707,
  55717,
  180,
  55718,
  65374,
  55719,
  711,
  55720,
  728,
  55721,
  733,
  55722,
  730,
  55723,
  729,
  55724,
  184,
  55725,
  731,
  55726,
  161,
  55727,
  191,
  55728,
  720,
  55729,
  8750,
  55730,
  8721,
  55731,
  8719,
  55732,
  164,
  55733,
  8457,
  55734,
  8240,
  55735,
  9665,
  55736,
  9664,
  55737,
  9655,
  55738,
  9654,
  55739,
  9828,
  55740,
  9824,
  55741,
  9825,
  55742,
  9829,
  55743,
  9831,
  55744,
  9827,
  55745,
  8857,
  55746,
  9672,
  55747,
  9635,
  55748,
  9680,
  55749,
  9681,
  55750,
  9618,
  55751,
  9636,
  55752,
  9637,
  55753,
  9640,
  55754,
  9639,
  55755,
  9638,
  55756,
  9641,
  55757,
  9832,
  55758,
  9743,
  55759,
  9742,
  55760,
  9756,
  55761,
  9758,
  55762,
  182,
  55763,
  8224,
  55764,
  8225,
  55765,
  8597,
  55766,
  8599,
  55767,
  8601,
  55768,
  8598,
  55769,
  8600,
  55770,
  9837,
  55771,
  9833,
  55772,
  9834,
  55773,
  9836,
  55774,
  12927,
  55775,
  12828,
  55776,
  8470,
  55777,
  13255,
  55778,
  8482,
  55779,
  13250,
  55780,
  13272,
  55781,
  8481,
  55782,
  8364,
  55783,
  174,
  55857,
  65281,
  55858,
  65282,
  55859,
  65283,
  55860,
  65284,
  55861,
  65285,
  55862,
  65286,
  55863,
  65287,
  55864,
  65288,
  55865,
  65289,
  55866,
  65290,
  55867,
  65291,
  55868,
  65292,
  55869,
  65293,
  55870,
  65294,
  55871,
  65295,
  55872,
  65296,
  55873,
  65297,
  55874,
  65298,
  55875,
  65299,
  55876,
  65300,
  55877,
  65301,
  55878,
  65302,
  55879,
  65303,
  55880,
  65304,
  55881,
  65305,
  55882,
  65306,
  55883,
  65307,
  55884,
  65308,
  55885,
  65309,
  55886,
  65310,
  55887,
  65311,
  55888,
  65312,
  55889,
  65313,
  55890,
  65314,
  55891,
  65315,
  55892,
  65316,
  55893,
  65317,
  55894,
  65318,
  55895,
  65319,
  55896,
  65320,
  55897,
  65321,
  55898,
  65322,
  55899,
  65323,
  55900,
  65324,
  55901,
  65325,
  55902,
  65326,
  55903,
  65327,
  55904,
  65328,
  55905,
  65329,
  55906,
  65330,
  55907,
  65331,
  55908,
  65332,
  55909,
  65333,
  55910,
  65334,
  55911,
  65335,
  55912,
  65336,
  55913,
  65337,
  55914,
  65338,
  55915,
  65339,
  55916,
  65510,
  55917,
  65341,
  55918,
  65342,
  55919,
  65343,
  55920,
  65344,
  55921,
  65345,
  55922,
  65346,
  55923,
  65347,
  55924,
  65348,
  55925,
  65349,
  55926,
  65350,
  55927,
  65351,
  55928,
  65352,
  55929,
  65353,
  55930,
  65354,
  55931,
  65355,
  55932,
  65356,
  55933,
  65357,
  55934,
  65358,
  55953,
  65359,
  55954,
  65360,
  55955,
  65361,
  55956,
  65362,
  55957,
  65363,
  55958,
  65364,
  55959,
  65365,
  55960,
  65366,
  55961,
  65367,
  55962,
  65368,
  55963,
  65369,
  55964,
  65370,
  55965,
  65371,
  55966,
  65372,
  55967,
  65373,
  55968,
  65507,
  56020,
  12644,
  56021,
  12645,
  56022,
  12646,
  56023,
  12647,
  56024,
  12648,
  56025,
  12649,
  56026,
  12650,
  56027,
  12651,
  56028,
  12652,
  56029,
  12653,
  56030,
  12654,
  56031,
  12655,
  56032,
  12656,
  56033,
  12657,
  56034,
  12658,
  56035,
  12659,
  56036,
  12660,
  56037,
  12661,
  56038,
  12662,
  56039,
  12663,
  56040,
  12664,
  56041,
  12665,
  56042,
  12666,
  56043,
  12667,
  56044,
  12668,
  56045,
  12669,
  56046,
  12670,
  56047,
  12671,
  56048,
  12672,
  56049,
  12673,
  56050,
  12674,
  56051,
  12675,
  56052,
  12676,
  56053,
  12677,
  56054,
  12678,
  56055,
  12679,
  56056,
  12680,
  56057,
  12681,
  56058,
  12682,
  56059,
  12683,
  56060,
  12684,
  56061,
  12685,
  56062,
  12686,
  56113,
  8560,
  56114,
  8561,
  56115,
  8562,
  56116,
  8563,
  56117,
  8564,
  56118,
  8565,
  56119,
  8566,
  56120,
  8567,
  56121,
  8568,
  56122,
  8569,
  56128,
  8544,
  56129,
  8545,
  56130,
  8546,
  56131,
  8547,
  56132,
  8548,
  56133,
  8549,
  56134,
  8550,
  56135,
  8551,
  56136,
  8552,
  56137,
  8553,
  56145,
  913,
  56146,
  914,
  56147,
  915,
  56148,
  916,
  56149,
  917,
  56150,
  918,
  56151,
  919,
  56152,
  920,
  56153,
  921,
  56154,
  922,
  56155,
  923,
  56156,
  924,
  56157,
  925,
  56158,
  926,
  56159,
  927,
  56160,
  928,
  56161,
  929,
  56162,
  931,
  56163,
  932,
  56164,
  933,
  56165,
  934,
  56166,
  935,
  56167,
  936,
  56168,
  937,
  56177,
  945,
  56178,
  946,
  56179,
  947,
  56180,
  948,
  56181,
  949,
  56182,
  950,
  56183,
  951,
  56184,
  952,
  56185,
  953,
  56186,
  954,
  56187,
  955,
  56188,
  956,
  56189,
  957,
  56190,
  958,
  56209,
  959,
  56210,
  960,
  56211,
  961,
  56212,
  963,
  56213,
  964,
  56214,
  965,
  56215,
  966,
  56216,
  967,
  56217,
  968,
  56218,
  969,
  56225,
  9472,
  56226,
  9474,
  56227,
  9484,
  56228,
  9488,
  56229,
  9496,
  56230,
  9492,
  56231,
  9500,
  56232,
  9516,
  56233,
  9508,
  56234,
  9524,
  56235,
  9532,
  56236,
  9473,
  56237,
  9475,
  56238,
  9487,
  56239,
  9491,
  56240,
  9499,
  56241,
  9495,
  56242,
  9507,
  56243,
  9523,
  56244,
  9515,
  56245,
  9531,
  56246,
  9547,
  56247,
  9504,
  56248,
  9519,
  56249,
  9512,
  56250,
  9527,
  56251,
  9535,
  56252,
  9501,
  56253,
  9520,
  56254,
  9509,
  56255,
  9528,
  56256,
  9538,
  56257,
  9490,
  56258,
  9489,
  56259,
  9498,
  56260,
  9497,
  56261,
  9494,
  56262,
  9493,
  56263,
  9486,
  56264,
  9485,
  56265,
  9502,
  56266,
  9503,
  56267,
  9505,
  56268,
  9506,
  56269,
  9510,
  56270,
  9511,
  56271,
  9513,
  56272,
  9514,
  56273,
  9517,
  56274,
  9518,
  56275,
  9521,
  56276,
  9522,
  56277,
  9525,
  56278,
  9526,
  56279,
  9529,
  56280,
  9530,
  56281,
  9533,
  56282,
  9534,
  56283,
  9536,
  56284,
  9537,
  56285,
  9539,
  56286,
  9540,
  56287,
  9541,
  56288,
  9542,
  56289,
  9543,
  56290,
  9544,
  56291,
  9545,
  56292,
  9546,
  56369,
  13205,
  56370,
  13206,
  56371,
  13207,
  56372,
  8467,
  56373,
  13208,
  56374,
  13252,
  56375,
  13219,
  56376,
  13220,
  56377,
  13221,
  56378,
  13222,
  56379,
  13209,
  56380,
  13210,
  56381,
  13211,
  56382,
  13212,
  56383,
  13213,
  56384,
  13214,
  56385,
  13215,
  56386,
  13216,
  56387,
  13217,
  56388,
  13218,
  56389,
  13258,
  56390,
  13197,
  56391,
  13198,
  56392,
  13199,
  56393,
  13263,
  56394,
  13192,
  56395,
  13193,
  56396,
  13256,
  56397,
  13223,
  56398,
  13224,
  56399,
  13232,
  56400,
  13233,
  56401,
  13234,
  56402,
  13235,
  56403,
  13236,
  56404,
  13237,
  56405,
  13238,
  56406,
  13239,
  56407,
  13240,
  56408,
  13241,
  56409,
  13184,
  56410,
  13185,
  56411,
  13186,
  56412,
  13187,
  56413,
  13188,
  56414,
  13242,
  56415,
  13243,
  56416,
  13244,
  56417,
  13245,
  56418,
  13246,
  56419,
  13247,
  56420,
  13200,
  56421,
  13201,
  56422,
  13202,
  56423,
  13203,
  56424,
  13204,
  56425,
  8486,
  56426,
  13248,
  56427,
  13249,
  56428,
  13194,
  56429,
  13195,
  56430,
  13196,
  56431,
  13270,
  56432,
  13253,
  56433,
  13229,
  56434,
  13230,
  56435,
  13231,
  56436,
  13275,
  56437,
  13225,
  56438,
  13226,
  56439,
  13227,
  56440,
  13228,
  56441,
  13277,
  56442,
  13264,
  56443,
  13267,
  56444,
  13251,
  56445,
  13257,
  56446,
  13276,
  56465,
  13254,
  56481,
  198,
  56482,
  208,
  56483,
  170,
  56484,
  294,
  56486,
  306,
  56488,
  319,
  56489,
  321,
  56490,
  216,
  56491,
  338,
  56492,
  186,
  56493,
  222,
  56494,
  358,
  56495,
  330,
  56497,
  12896,
  56498,
  12897,
  56499,
  12898,
  56500,
  12899,
  56501,
  12900,
  56502,
  12901,
  56503,
  12902,
  56504,
  12903,
  56505,
  12904,
  56506,
  12905,
  56507,
  12906,
  56508,
  12907,
  56509,
  12908,
  56510,
  12909,
  56511,
  12910,
  56512,
  12911,
  56513,
  12912,
  56514,
  12913,
  56515,
  12914,
  56516,
  12915,
  56517,
  12916,
  56518,
  12917,
  56519,
  12918,
  56520,
  12919,
  56521,
  12920,
  56522,
  12921,
  56523,
  12922,
  56524,
  12923,
  56525,
  9424,
  56526,
  9425,
  56527,
  9426,
  56528,
  9427,
  56529,
  9428,
  56530,
  9429,
  56531,
  9430,
  56532,
  9431,
  56533,
  9432,
  56534,
  9433,
  56535,
  9434,
  56536,
  9435,
  56537,
  9436,
  56538,
  9437,
  56539,
  9438,
  56540,
  9439,
  56541,
  9440,
  56542,
  9441,
  56543,
  9442,
  56544,
  9443,
  56545,
  9444,
  56546,
  9445,
  56547,
  9446,
  56548,
  9447,
  56549,
  9448,
  56550,
  9449,
  56551,
  9312,
  56552,
  9313,
  56553,
  9314,
  56554,
  9315,
  56555,
  9316,
  56556,
  9317,
  56557,
  9318,
  56558,
  9319,
  56559,
  9320,
  56560,
  9321,
  56561,
  9322,
  56562,
  9323,
  56563,
  9324,
  56564,
  9325,
  56565,
  9326,
  56566,
  189,
  56567,
  8531,
  56568,
  8532,
  56569,
  188,
  56570,
  190,
  56571,
  8539,
  56572,
  8540,
  56573,
  8541,
  56574,
  8542,
  56625,
  230,
  56626,
  273,
  56627,
  240,
  56628,
  295,
  56629,
  305,
  56630,
  307,
  56631,
  312,
  56632,
  320,
  56633,
  322,
  56634,
  248,
  56635,
  339,
  56636,
  223,
  56637,
  254,
  56638,
  359,
  56639,
  331,
  56640,
  329,
  56641,
  12800,
  56642,
  12801,
  56643,
  12802,
  56644,
  12803,
  56645,
  12804,
  56646,
  12805,
  56647,
  12806,
  56648,
  12807,
  56649,
  12808,
  56650,
  12809,
  56651,
  12810,
  56652,
  12811,
  56653,
  12812,
  56654,
  12813,
  56655,
  12814,
  56656,
  12815,
  56657,
  12816,
  56658,
  12817,
  56659,
  12818,
  56660,
  12819,
  56661,
  12820,
  56662,
  12821,
  56663,
  12822,
  56664,
  12823,
  56665,
  12824,
  56666,
  12825,
  56667,
  12826,
  56668,
  12827,
  56669,
  9372,
  56670,
  9373,
  56671,
  9374,
  56672,
  9375,
  56673,
  9376,
  56674,
  9377,
  56675,
  9378,
  56676,
  9379,
  56677,
  9380,
  56678,
  9381,
  56679,
  9382,
  56680,
  9383,
  56681,
  9384,
  56682,
  9385,
  56683,
  9386,
  56684,
  9387,
  56685,
  9388,
  56686,
  9389,
  56687,
  9390,
  56688,
  9391,
  56689,
  9392,
  56690,
  9393,
  56691,
  9394,
  56692,
  9395,
  56693,
  9396,
  56694,
  9397,
  56695,
  9332,
  56696,
  9333,
  56697,
  9334,
  56698,
  9335,
  56699,
  9336,
  56700,
  9337,
  56701,
  9338,
  56702,
  9339,
  56721,
  9340,
  56722,
  9341,
  56723,
  9342,
  56724,
  9343,
  56725,
  9344,
  56726,
  9345,
  56727,
  9346,
  56728,
  185,
  56729,
  178,
  56730,
  179,
  56731,
  8308,
  56732,
  8319,
  56733,
  8321,
  56734,
  8322,
  56735,
  8323,
  56736,
  8324,
  56737,
  12353,
  56738,
  12354,
  56739,
  12355,
  56740,
  12356,
  56741,
  12357,
  56742,
  12358,
  56743,
  12359,
  56744,
  12360,
  56745,
  12361,
  56746,
  12362,
  56747,
  12363,
  56748,
  12364,
  56749,
  12365,
  56750,
  12366,
  56751,
  12367,
  56752,
  12368,
  56753,
  12369,
  56754,
  12370,
  56755,
  12371,
  56756,
  12372,
  56757,
  12373,
  56758,
  12374,
  56759,
  12375,
  56760,
  12376,
  56761,
  12377,
  56762,
  12378,
  56763,
  12379,
  56764,
  12380,
  56765,
  12381,
  56766,
  12382,
  56767,
  12383,
  56768,
  12384,
  56769,
  12385,
  56770,
  12386,
  56771,
  12387,
  56772,
  12388,
  56773,
  12389,
  56774,
  12390,
  56775,
  12391,
  56776,
  12392,
  56777,
  12393,
  56778,
  12394,
  56779,
  12395,
  56780,
  12396,
  56781,
  12397,
  56782,
  12398,
  56783,
  12399,
  56784,
  12400,
  56785,
  12401,
  56786,
  12402,
  56787,
  12403,
  56788,
  12404,
  56789,
  12405,
  56790,
  12406,
  56791,
  12407,
  56792,
  12408,
  56793,
  12409,
  56794,
  12410,
  56795,
  12411,
  56796,
  12412,
  56797,
  12413,
  56798,
  12414,
  56799,
  12415,
  56800,
  12416,
  56801,
  12417,
  56802,
  12418,
  56803,
  12419,
  56804,
  12420,
  56805,
  12421,
  56806,
  12422,
  56807,
  12423,
  56808,
  12424,
  56809,
  12425,
  56810,
  12426,
  56811,
  12427,
  56812,
  12428,
  56813,
  12429,
  56814,
  12430,
  56815,
  12431,
  56816,
  12432,
  56817,
  12433,
  56818,
  12434,
  56819,
  12435,
  56881,
  12449,
  56882,
  12450,
  56883,
  12451,
  56884,
  12452,
  56885,
  12453,
  56886,
  12454,
  56887,
  12455,
  56888,
  12456,
  56889,
  12457,
  56890,
  12458,
  56891,
  12459,
  56892,
  12460,
  56893,
  12461,
  56894,
  12462,
  56895,
  12463,
  56896,
  12464,
  56897,
  12465,
  56898,
  12466,
  56899,
  12467,
  56900,
  12468,
  56901,
  12469,
  56902,
  12470,
  56903,
  12471,
  56904,
  12472,
  56905,
  12473,
  56906,
  12474,
  56907,
  12475,
  56908,
  12476,
  56909,
  12477,
  56910,
  12478,
  56911,
  12479,
  56912,
  12480,
  56913,
  12481,
  56914,
  12482,
  56915,
  12483,
  56916,
  12484,
  56917,
  12485,
  56918,
  12486,
  56919,
  12487,
  56920,
  12488,
  56921,
  12489,
  56922,
  12490,
  56923,
  12491,
  56924,
  12492,
  56925,
  12493,
  56926,
  12494,
  56927,
  12495,
  56928,
  12496,
  56929,
  12497,
  56930,
  12498,
  56931,
  12499,
  56932,
  12500,
  56933,
  12501,
  56934,
  12502,
  56935,
  12503,
  56936,
  12504,
  56937,
  12505,
  56938,
  12506,
  56939,
  12507,
  56940,
  12508,
  56941,
  12509,
  56942,
  12510,
  56943,
  12511,
  56944,
  12512,
  56945,
  12513,
  56946,
  12514,
  56947,
  12515,
  56948,
  12516,
  56949,
  12517,
  56950,
  12518,
  56951,
  12519,
  56952,
  12520,
  56953,
  12521,
  56954,
  12522,
  56955,
  12523,
  56956,
  12524,
  56957,
  12525,
  56958,
  12526,
  56977,
  12527,
  56978,
  12528,
  56979,
  12529,
  56980,
  12530,
  56981,
  12531,
  56982,
  12532,
  56983,
  12533,
  56984,
  12534,
  56993,
  1040,
  56994,
  1041,
  56995,
  1042,
  56996,
  1043,
  56997,
  1044,
  56998,
  1045,
  56999,
  1025,
  57e3,
  1046,
  57001,
  1047,
  57002,
  1048,
  57003,
  1049,
  57004,
  1050,
  57005,
  1051,
  57006,
  1052,
  57007,
  1053,
  57008,
  1054,
  57009,
  1055,
  57010,
  1056,
  57011,
  1057,
  57012,
  1058,
  57013,
  1059,
  57014,
  1060,
  57015,
  1061,
  57016,
  1062,
  57017,
  1063,
  57018,
  1064,
  57019,
  1065,
  57020,
  1066,
  57021,
  1067,
  57022,
  1068,
  57023,
  1069,
  57024,
  1070,
  57025,
  1071,
  57041,
  1072,
  57042,
  1073,
  57043,
  1074,
  57044,
  1075,
  57045,
  1076,
  57046,
  1077,
  57047,
  1105,
  57048,
  1078,
  57049,
  1079,
  57050,
  1080,
  57051,
  1081,
  57052,
  1082,
  57053,
  1083,
  57054,
  1084,
  57055,
  1085,
  57056,
  1086,
  57057,
  1087,
  57058,
  1088,
  57059,
  1089,
  57060,
  1090,
  57061,
  1091,
  57062,
  1092,
  57063,
  1093,
  57064,
  1094,
  57065,
  1095,
  57066,
  1096,
  57067,
  1097,
  57068,
  1098,
  57069,
  1099,
  57070,
  1100,
  57071,
  1101,
  57072,
  1102,
  57073,
  1103,
  57393,
  20285,
  57394,
  20339,
  57395,
  20551,
  57396,
  20729,
  57397,
  21152,
  57398,
  21487,
  57399,
  21621,
  57400,
  21733,
  57401,
  22025,
  57402,
  23233,
  57403,
  23478,
  57404,
  26247,
  57405,
  26550,
  57406,
  26551,
  57407,
  26607,
  57408,
  27468,
  57409,
  29634,
  57410,
  30146,
  57411,
  31292,
  57412,
  33499,
  57413,
  33540,
  57414,
  34903,
  57415,
  34952,
  57416,
  35382,
  57417,
  36040,
  57418,
  36303,
  57419,
  36603,
  57420,
  36838,
  57421,
  39381,
  57422,
  21051,
  57423,
  21364,
  57424,
  21508,
  57425,
  24682,
  57426,
  24932,
  57427,
  27580,
  57428,
  29647,
  57429,
  33050,
  57430,
  35258,
  57431,
  35282,
  57432,
  38307,
  57433,
  20355,
  57434,
  21002,
  57435,
  22718,
  57436,
  22904,
  57437,
  23014,
  57438,
  24178,
  57439,
  24185,
  57440,
  25031,
  57441,
  25536,
  57442,
  26438,
  57443,
  26604,
  57444,
  26751,
  57445,
  28567,
  57446,
  30286,
  57447,
  30475,
  57448,
  30965,
  57449,
  31240,
  57450,
  31487,
  57451,
  31777,
  57452,
  32925,
  57453,
  33390,
  57454,
  33393,
  57455,
  35563,
  57456,
  38291,
  57457,
  20075,
  57458,
  21917,
  57459,
  26359,
  57460,
  28212,
  57461,
  30883,
  57462,
  31469,
  57463,
  33883,
  57464,
  35088,
  57465,
  34638,
  57466,
  38824,
  57467,
  21208,
  57468,
  22350,
  57469,
  22570,
  57470,
  23884,
  57489,
  24863,
  57490,
  25022,
  57491,
  25121,
  57492,
  25954,
  57493,
  26577,
  57494,
  27204,
  57495,
  28187,
  57496,
  29976,
  57497,
  30131,
  57498,
  30435,
  57499,
  30640,
  57500,
  32058,
  57501,
  37039,
  57502,
  37969,
  57503,
  37970,
  57504,
  40853,
  57505,
  21283,
  57506,
  23724,
  57507,
  30002,
  57508,
  32987,
  57509,
  37440,
  57510,
  38296,
  57511,
  21083,
  57512,
  22536,
  57513,
  23004,
  57514,
  23713,
  57515,
  23831,
  57516,
  24247,
  57517,
  24378,
  57518,
  24394,
  57519,
  24951,
  57520,
  27743,
  57521,
  30074,
  57522,
  30086,
  57523,
  31968,
  57524,
  32115,
  57525,
  32177,
  57526,
  32652,
  57527,
  33108,
  57528,
  33313,
  57529,
  34193,
  57530,
  35137,
  57531,
  35611,
  57532,
  37628,
  57533,
  38477,
  57534,
  40007,
  57535,
  20171,
  57536,
  20215,
  57537,
  20491,
  57538,
  20977,
  57539,
  22607,
  57540,
  24887,
  57541,
  24894,
  57542,
  24936,
  57543,
  25913,
  57544,
  27114,
  57545,
  28433,
  57546,
  30117,
  57547,
  30342,
  57548,
  30422,
  57549,
  31623,
  57550,
  33445,
  57551,
  33995,
  57552,
  63744,
  57553,
  37799,
  57554,
  38283,
  57555,
  21888,
  57556,
  23458,
  57557,
  22353,
  57558,
  63745,
  57559,
  31923,
  57560,
  32697,
  57561,
  37301,
  57562,
  20520,
  57563,
  21435,
  57564,
  23621,
  57565,
  24040,
  57566,
  25298,
  57567,
  25454,
  57568,
  25818,
  57569,
  25831,
  57570,
  28192,
  57571,
  28844,
  57572,
  31067,
  57573,
  36317,
  57574,
  36382,
  57575,
  63746,
  57576,
  36989,
  57577,
  37445,
  57578,
  37624,
  57579,
  20094,
  57580,
  20214,
  57581,
  20581,
  57582,
  24062,
  57583,
  24314,
  57584,
  24838,
  57585,
  26967,
  57586,
  33137,
  57587,
  34388,
  57588,
  36423,
  57589,
  37749,
  57590,
  39467,
  57591,
  20062,
  57592,
  20625,
  57593,
  26480,
  57594,
  26688,
  57595,
  20745,
  57596,
  21133,
  57597,
  21138,
  57598,
  27298,
  57649,
  30652,
  57650,
  37392,
  57651,
  40660,
  57652,
  21163,
  57653,
  24623,
  57654,
  36850,
  57655,
  20552,
  57656,
  25001,
  57657,
  25581,
  57658,
  25802,
  57659,
  26684,
  57660,
  27268,
  57661,
  28608,
  57662,
  33160,
  57663,
  35233,
  57664,
  38548,
  57665,
  22533,
  57666,
  29309,
  57667,
  29356,
  57668,
  29956,
  57669,
  32121,
  57670,
  32365,
  57671,
  32937,
  57672,
  35211,
  57673,
  35700,
  57674,
  36963,
  57675,
  40273,
  57676,
  25225,
  57677,
  27770,
  57678,
  28500,
  57679,
  32080,
  57680,
  32570,
  57681,
  35363,
  57682,
  20860,
  57683,
  24906,
  57684,
  31645,
  57685,
  35609,
  57686,
  37463,
  57687,
  37772,
  57688,
  20140,
  57689,
  20435,
  57690,
  20510,
  57691,
  20670,
  57692,
  20742,
  57693,
  21185,
  57694,
  21197,
  57695,
  21375,
  57696,
  22384,
  57697,
  22659,
  57698,
  24218,
  57699,
  24465,
  57700,
  24950,
  57701,
  25004,
  57702,
  25806,
  57703,
  25964,
  57704,
  26223,
  57705,
  26299,
  57706,
  26356,
  57707,
  26775,
  57708,
  28039,
  57709,
  28805,
  57710,
  28913,
  57711,
  29855,
  57712,
  29861,
  57713,
  29898,
  57714,
  30169,
  57715,
  30828,
  57716,
  30956,
  57717,
  31455,
  57718,
  31478,
  57719,
  32069,
  57720,
  32147,
  57721,
  32789,
  57722,
  32831,
  57723,
  33051,
  57724,
  33686,
  57725,
  35686,
  57726,
  36629,
  57745,
  36885,
  57746,
  37857,
  57747,
  38915,
  57748,
  38968,
  57749,
  39514,
  57750,
  39912,
  57751,
  20418,
  57752,
  21843,
  57753,
  22586,
  57754,
  22865,
  57755,
  23395,
  57756,
  23622,
  57757,
  24760,
  57758,
  25106,
  57759,
  26690,
  57760,
  26800,
  57761,
  26856,
  57762,
  28330,
  57763,
  30028,
  57764,
  30328,
  57765,
  30926,
  57766,
  31293,
  57767,
  31995,
  57768,
  32363,
  57769,
  32380,
  57770,
  35336,
  57771,
  35489,
  57772,
  35903,
  57773,
  38542,
  57774,
  40388,
  57775,
  21476,
  57776,
  21481,
  57777,
  21578,
  57778,
  21617,
  57779,
  22266,
  57780,
  22993,
  57781,
  23396,
  57782,
  23611,
  57783,
  24235,
  57784,
  25335,
  57785,
  25911,
  57786,
  25925,
  57787,
  25970,
  57788,
  26272,
  57789,
  26543,
  57790,
  27073,
  57791,
  27837,
  57792,
  30204,
  57793,
  30352,
  57794,
  30590,
  57795,
  31295,
  57796,
  32660,
  57797,
  32771,
  57798,
  32929,
  57799,
  33167,
  57800,
  33510,
  57801,
  33533,
  57802,
  33776,
  57803,
  34241,
  57804,
  34865,
  57805,
  34996,
  57806,
  35493,
  57807,
  63747,
  57808,
  36764,
  57809,
  37678,
  57810,
  38599,
  57811,
  39015,
  57812,
  39640,
  57813,
  40723,
  57814,
  21741,
  57815,
  26011,
  57816,
  26354,
  57817,
  26767,
  57818,
  31296,
  57819,
  35895,
  57820,
  40288,
  57821,
  22256,
  57822,
  22372,
  57823,
  23825,
  57824,
  26118,
  57825,
  26801,
  57826,
  26829,
  57827,
  28414,
  57828,
  29736,
  57829,
  34974,
  57830,
  39908,
  57831,
  27752,
  57832,
  63748,
  57833,
  39592,
  57834,
  20379,
  57835,
  20844,
  57836,
  20849,
  57837,
  21151,
  57838,
  23380,
  57839,
  24037,
  57840,
  24656,
  57841,
  24685,
  57842,
  25329,
  57843,
  25511,
  57844,
  25915,
  57845,
  29657,
  57846,
  31354,
  57847,
  34467,
  57848,
  36002,
  57849,
  38799,
  57850,
  20018,
  57851,
  23521,
  57852,
  25096,
  57853,
  26524,
  57854,
  29916,
  57905,
  31185,
  57906,
  33747,
  57907,
  35463,
  57908,
  35506,
  57909,
  36328,
  57910,
  36942,
  57911,
  37707,
  57912,
  38982,
  57913,
  24275,
  57914,
  27112,
  57915,
  34303,
  57916,
  37101,
  57917,
  63749,
  57918,
  20896,
  57919,
  23448,
  57920,
  23532,
  57921,
  24931,
  57922,
  26874,
  57923,
  27454,
  57924,
  28748,
  57925,
  29743,
  57926,
  29912,
  57927,
  31649,
  57928,
  32592,
  57929,
  33733,
  57930,
  35264,
  57931,
  36011,
  57932,
  38364,
  57933,
  39208,
  57934,
  21038,
  57935,
  24669,
  57936,
  25324,
  57937,
  36866,
  57938,
  20362,
  57939,
  20809,
  57940,
  21281,
  57941,
  22745,
  57942,
  24291,
  57943,
  26336,
  57944,
  27960,
  57945,
  28826,
  57946,
  29378,
  57947,
  29654,
  57948,
  31568,
  57949,
  33009,
  57950,
  37979,
  57951,
  21350,
  57952,
  25499,
  57953,
  32619,
  57954,
  20054,
  57955,
  20608,
  57956,
  22602,
  57957,
  22750,
  57958,
  24618,
  57959,
  24871,
  57960,
  25296,
  57961,
  27088,
  57962,
  39745,
  57963,
  23439,
  57964,
  32024,
  57965,
  32945,
  57966,
  36703,
  57967,
  20132,
  57968,
  20689,
  57969,
  21676,
  57970,
  21932,
  57971,
  23308,
  57972,
  23968,
  57973,
  24039,
  57974,
  25898,
  57975,
  25934,
  57976,
  26657,
  57977,
  27211,
  57978,
  29409,
  57979,
  30350,
  57980,
  30703,
  57981,
  32094,
  57982,
  32761,
  58001,
  33184,
  58002,
  34126,
  58003,
  34527,
  58004,
  36611,
  58005,
  36686,
  58006,
  37066,
  58007,
  39171,
  58008,
  39509,
  58009,
  39851,
  58010,
  19992,
  58011,
  20037,
  58012,
  20061,
  58013,
  20167,
  58014,
  20465,
  58015,
  20855,
  58016,
  21246,
  58017,
  21312,
  58018,
  21475,
  58019,
  21477,
  58020,
  21646,
  58021,
  22036,
  58022,
  22389,
  58023,
  22434,
  58024,
  23495,
  58025,
  23943,
  58026,
  24272,
  58027,
  25084,
  58028,
  25304,
  58029,
  25937,
  58030,
  26552,
  58031,
  26601,
  58032,
  27083,
  58033,
  27472,
  58034,
  27590,
  58035,
  27628,
  58036,
  27714,
  58037,
  28317,
  58038,
  28792,
  58039,
  29399,
  58040,
  29590,
  58041,
  29699,
  58042,
  30655,
  58043,
  30697,
  58044,
  31350,
  58045,
  32127,
  58046,
  32777,
  58047,
  33276,
  58048,
  33285,
  58049,
  33290,
  58050,
  33503,
  58051,
  34914,
  58052,
  35635,
  58053,
  36092,
  58054,
  36544,
  58055,
  36881,
  58056,
  37041,
  58057,
  37476,
  58058,
  37558,
  58059,
  39378,
  58060,
  39493,
  58061,
  40169,
  58062,
  40407,
  58063,
  40860,
  58064,
  22283,
  58065,
  23616,
  58066,
  33738,
  58067,
  38816,
  58068,
  38827,
  58069,
  40628,
  58070,
  21531,
  58071,
  31384,
  58072,
  32676,
  58073,
  35033,
  58074,
  36557,
  58075,
  37089,
  58076,
  22528,
  58077,
  23624,
  58078,
  25496,
  58079,
  31391,
  58080,
  23470,
  58081,
  24339,
  58082,
  31353,
  58083,
  31406,
  58084,
  33422,
  58085,
  36524,
  58086,
  20518,
  58087,
  21048,
  58088,
  21240,
  58089,
  21367,
  58090,
  22280,
  58091,
  25331,
  58092,
  25458,
  58093,
  27402,
  58094,
  28099,
  58095,
  30519,
  58096,
  21413,
  58097,
  29527,
  58098,
  34152,
  58099,
  36470,
  58100,
  38357,
  58101,
  26426,
  58102,
  27331,
  58103,
  28528,
  58104,
  35437,
  58105,
  36556,
  58106,
  39243,
  58107,
  63750,
  58108,
  26231,
  58109,
  27512,
  58110,
  36020,
  58161,
  39740,
  58162,
  63751,
  58163,
  21483,
  58164,
  22317,
  58165,
  22862,
  58166,
  25542,
  58167,
  27131,
  58168,
  29674,
  58169,
  30789,
  58170,
  31418,
  58171,
  31429,
  58172,
  31998,
  58173,
  33909,
  58174,
  35215,
  58175,
  36211,
  58176,
  36917,
  58177,
  38312,
  58178,
  21243,
  58179,
  22343,
  58180,
  30023,
  58181,
  31584,
  58182,
  33740,
  58183,
  37406,
  58184,
  63752,
  58185,
  27224,
  58186,
  20811,
  58187,
  21067,
  58188,
  21127,
  58189,
  25119,
  58190,
  26840,
  58191,
  26997,
  58192,
  38553,
  58193,
  20677,
  58194,
  21156,
  58195,
  21220,
  58196,
  25027,
  58197,
  26020,
  58198,
  26681,
  58199,
  27135,
  58200,
  29822,
  58201,
  31563,
  58202,
  33465,
  58203,
  33771,
  58204,
  35250,
  58205,
  35641,
  58206,
  36817,
  58207,
  39241,
  58208,
  63753,
  58209,
  20170,
  58210,
  22935,
  58211,
  25810,
  58212,
  26129,
  58213,
  27278,
  58214,
  29748,
  58215,
  31105,
  58216,
  31165,
  58217,
  33449,
  58218,
  34942,
  58219,
  34943,
  58220,
  35167,
  58221,
  63754,
  58222,
  37670,
  58223,
  20235,
  58224,
  21450,
  58225,
  24613,
  58226,
  25201,
  58227,
  27762,
  58228,
  32026,
  58229,
  32102,
  58230,
  20120,
  58231,
  20834,
  58232,
  30684,
  58233,
  32943,
  58234,
  20225,
  58235,
  20238,
  58236,
  20854,
  58237,
  20864,
  58238,
  21980,
  58257,
  22120,
  58258,
  22331,
  58259,
  22522,
  58260,
  22524,
  58261,
  22804,
  58262,
  22855,
  58263,
  22931,
  58264,
  23492,
  58265,
  23696,
  58266,
  23822,
  58267,
  24049,
  58268,
  24190,
  58269,
  24524,
  58270,
  25216,
  58271,
  26071,
  58272,
  26083,
  58273,
  26398,
  58274,
  26399,
  58275,
  26462,
  58276,
  26827,
  58277,
  26820,
  58278,
  27231,
  58279,
  27450,
  58280,
  27683,
  58281,
  27773,
  58282,
  27778,
  58283,
  28103,
  58284,
  29592,
  58285,
  29734,
  58286,
  29738,
  58287,
  29826,
  58288,
  29859,
  58289,
  30072,
  58290,
  30079,
  58291,
  30849,
  58292,
  30959,
  58293,
  31041,
  58294,
  31047,
  58295,
  31048,
  58296,
  31098,
  58297,
  31637,
  58298,
  32e3,
  58299,
  32186,
  58300,
  32648,
  58301,
  32774,
  58302,
  32813,
  58303,
  32908,
  58304,
  35352,
  58305,
  35663,
  58306,
  35912,
  58307,
  36215,
  58308,
  37665,
  58309,
  37668,
  58310,
  39138,
  58311,
  39249,
  58312,
  39438,
  58313,
  39439,
  58314,
  39525,
  58315,
  40594,
  58316,
  32202,
  58317,
  20342,
  58318,
  21513,
  58319,
  25326,
  58320,
  26708,
  58321,
  37329,
  58322,
  21931,
  58323,
  20794,
  58324,
  63755,
  58325,
  63756,
  58326,
  23068,
  58327,
  25062,
  58328,
  63757,
  58329,
  25295,
  58330,
  25343,
  58331,
  63758,
  58332,
  63759,
  58333,
  63760,
  58334,
  63761,
  58335,
  63762,
  58336,
  63763,
  58337,
  37027,
  58338,
  63764,
  58339,
  63765,
  58340,
  63766,
  58341,
  63767,
  58342,
  63768,
  58343,
  35582,
  58344,
  63769,
  58345,
  63770,
  58346,
  63771,
  58347,
  63772,
  58348,
  26262,
  58349,
  63773,
  58350,
  29014,
  58351,
  63774,
  58352,
  63775,
  58353,
  38627,
  58354,
  63776,
  58355,
  25423,
  58356,
  25466,
  58357,
  21335,
  58358,
  63777,
  58359,
  26511,
  58360,
  26976,
  58361,
  28275,
  58362,
  63778,
  58363,
  30007,
  58364,
  63779,
  58365,
  63780,
  58366,
  63781,
  58417,
  32013,
  58418,
  63782,
  58419,
  63783,
  58420,
  34930,
  58421,
  22218,
  58422,
  23064,
  58423,
  63784,
  58424,
  63785,
  58425,
  63786,
  58426,
  63787,
  58427,
  63788,
  58428,
  20035,
  58429,
  63789,
  58430,
  20839,
  58431,
  22856,
  58432,
  26608,
  58433,
  32784,
  58434,
  63790,
  58435,
  22899,
  58436,
  24180,
  58437,
  25754,
  58438,
  31178,
  58439,
  24565,
  58440,
  24684,
  58441,
  25288,
  58442,
  25467,
  58443,
  23527,
  58444,
  23511,
  58445,
  21162,
  58446,
  63791,
  58447,
  22900,
  58448,
  24361,
  58449,
  24594,
  58450,
  63792,
  58451,
  63793,
  58452,
  63794,
  58453,
  29785,
  58454,
  63795,
  58455,
  63796,
  58456,
  63797,
  58457,
  63798,
  58458,
  63799,
  58459,
  63800,
  58460,
  39377,
  58461,
  63801,
  58462,
  63802,
  58463,
  63803,
  58464,
  63804,
  58465,
  63805,
  58466,
  63806,
  58467,
  63807,
  58468,
  63808,
  58469,
  63809,
  58470,
  63810,
  58471,
  63811,
  58472,
  28611,
  58473,
  63812,
  58474,
  63813,
  58475,
  33215,
  58476,
  36786,
  58477,
  24817,
  58478,
  63814,
  58479,
  63815,
  58480,
  33126,
  58481,
  63816,
  58482,
  63817,
  58483,
  23615,
  58484,
  63818,
  58485,
  63819,
  58486,
  63820,
  58487,
  63821,
  58488,
  63822,
  58489,
  63823,
  58490,
  63824,
  58491,
  63825,
  58492,
  23273,
  58493,
  35365,
  58494,
  26491,
  58513,
  32016,
  58514,
  63826,
  58515,
  63827,
  58516,
  63828,
  58517,
  63829,
  58518,
  63830,
  58519,
  63831,
  58520,
  33021,
  58521,
  63832,
  58522,
  63833,
  58523,
  23612,
  58524,
  27877,
  58525,
  21311,
  58526,
  28346,
  58527,
  22810,
  58528,
  33590,
  58529,
  20025,
  58530,
  20150,
  58531,
  20294,
  58532,
  21934,
  58533,
  22296,
  58534,
  22727,
  58535,
  24406,
  58536,
  26039,
  58537,
  26086,
  58538,
  27264,
  58539,
  27573,
  58540,
  28237,
  58541,
  30701,
  58542,
  31471,
  58543,
  31774,
  58544,
  32222,
  58545,
  34507,
  58546,
  34962,
  58547,
  37170,
  58548,
  37723,
  58549,
  25787,
  58550,
  28606,
  58551,
  29562,
  58552,
  30136,
  58553,
  36948,
  58554,
  21846,
  58555,
  22349,
  58556,
  25018,
  58557,
  25812,
  58558,
  26311,
  58559,
  28129,
  58560,
  28251,
  58561,
  28525,
  58562,
  28601,
  58563,
  30192,
  58564,
  32835,
  58565,
  33213,
  58566,
  34113,
  58567,
  35203,
  58568,
  35527,
  58569,
  35674,
  58570,
  37663,
  58571,
  27795,
  58572,
  30035,
  58573,
  31572,
  58574,
  36367,
  58575,
  36957,
  58576,
  21776,
  58577,
  22530,
  58578,
  22616,
  58579,
  24162,
  58580,
  25095,
  58581,
  25758,
  58582,
  26848,
  58583,
  30070,
  58584,
  31958,
  58585,
  34739,
  58586,
  40680,
  58587,
  20195,
  58588,
  22408,
  58589,
  22382,
  58590,
  22823,
  58591,
  23565,
  58592,
  23729,
  58593,
  24118,
  58594,
  24453,
  58595,
  25140,
  58596,
  25825,
  58597,
  29619,
  58598,
  33274,
  58599,
  34955,
  58600,
  36024,
  58601,
  38538,
  58602,
  40667,
  58603,
  23429,
  58604,
  24503,
  58605,
  24755,
  58606,
  20498,
  58607,
  20992,
  58608,
  21040,
  58609,
  22294,
  58610,
  22581,
  58611,
  22615,
  58612,
  23566,
  58613,
  23648,
  58614,
  23798,
  58615,
  23947,
  58616,
  24230,
  58617,
  24466,
  58618,
  24764,
  58619,
  25361,
  58620,
  25481,
  58621,
  25623,
  58622,
  26691,
  58673,
  26873,
  58674,
  27330,
  58675,
  28120,
  58676,
  28193,
  58677,
  28372,
  58678,
  28644,
  58679,
  29182,
  58680,
  30428,
  58681,
  30585,
  58682,
  31153,
  58683,
  31291,
  58684,
  33796,
  58685,
  35241,
  58686,
  36077,
  58687,
  36339,
  58688,
  36424,
  58689,
  36867,
  58690,
  36884,
  58691,
  36947,
  58692,
  37117,
  58693,
  37709,
  58694,
  38518,
  58695,
  38876,
  58696,
  27602,
  58697,
  28678,
  58698,
  29272,
  58699,
  29346,
  58700,
  29544,
  58701,
  30563,
  58702,
  31167,
  58703,
  31716,
  58704,
  32411,
  58705,
  35712,
  58706,
  22697,
  58707,
  24775,
  58708,
  25958,
  58709,
  26109,
  58710,
  26302,
  58711,
  27788,
  58712,
  28958,
  58713,
  29129,
  58714,
  35930,
  58715,
  38931,
  58716,
  20077,
  58717,
  31361,
  58718,
  20189,
  58719,
  20908,
  58720,
  20941,
  58721,
  21205,
  58722,
  21516,
  58723,
  24999,
  58724,
  26481,
  58725,
  26704,
  58726,
  26847,
  58727,
  27934,
  58728,
  28540,
  58729,
  30140,
  58730,
  30643,
  58731,
  31461,
  58732,
  33012,
  58733,
  33891,
  58734,
  37509,
  58735,
  20828,
  58736,
  26007,
  58737,
  26460,
  58738,
  26515,
  58739,
  30168,
  58740,
  31431,
  58741,
  33651,
  58742,
  63834,
  58743,
  35910,
  58744,
  36887,
  58745,
  38957,
  58746,
  23663,
  58747,
  33216,
  58748,
  33434,
  58749,
  36929,
  58750,
  36975,
  58769,
  37389,
  58770,
  24471,
  58771,
  23965,
  58772,
  27225,
  58773,
  29128,
  58774,
  30331,
  58775,
  31561,
  58776,
  34276,
  58777,
  35588,
  58778,
  37159,
  58779,
  39472,
  58780,
  21895,
  58781,
  25078,
  58782,
  63835,
  58783,
  30313,
  58784,
  32645,
  58785,
  34367,
  58786,
  34746,
  58787,
  35064,
  58788,
  37007,
  58789,
  63836,
  58790,
  27931,
  58791,
  28889,
  58792,
  29662,
  58793,
  32097,
  58794,
  33853,
  58795,
  63837,
  58796,
  37226,
  58797,
  39409,
  58798,
  63838,
  58799,
  20098,
  58800,
  21365,
  58801,
  27396,
  58802,
  27410,
  58803,
  28734,
  58804,
  29211,
  58805,
  34349,
  58806,
  40478,
  58807,
  21068,
  58808,
  36771,
  58809,
  23888,
  58810,
  25829,
  58811,
  25900,
  58812,
  27414,
  58813,
  28651,
  58814,
  31811,
  58815,
  32412,
  58816,
  34253,
  58817,
  35172,
  58818,
  35261,
  58819,
  25289,
  58820,
  33240,
  58821,
  34847,
  58822,
  24266,
  58823,
  26391,
  58824,
  28010,
  58825,
  29436,
  58826,
  29701,
  58827,
  29807,
  58828,
  34690,
  58829,
  37086,
  58830,
  20358,
  58831,
  23821,
  58832,
  24480,
  58833,
  33802,
  58834,
  20919,
  58835,
  25504,
  58836,
  30053,
  58837,
  20142,
  58838,
  20486,
  58839,
  20841,
  58840,
  20937,
  58841,
  26753,
  58842,
  27153,
  58843,
  31918,
  58844,
  31921,
  58845,
  31975,
  58846,
  33391,
  58847,
  35538,
  58848,
  36635,
  58849,
  37327,
  58850,
  20406,
  58851,
  20791,
  58852,
  21237,
  58853,
  21570,
  58854,
  24300,
  58855,
  24942,
  58856,
  25150,
  58857,
  26053,
  58858,
  27354,
  58859,
  28670,
  58860,
  31018,
  58861,
  34268,
  58862,
  34851,
  58863,
  38317,
  58864,
  39522,
  58865,
  39530,
  58866,
  40599,
  58867,
  40654,
  58868,
  21147,
  58869,
  26310,
  58870,
  27511,
  58871,
  28701,
  58872,
  31019,
  58873,
  36706,
  58874,
  38722,
  58875,
  24976,
  58876,
  25088,
  58877,
  25891,
  58878,
  28451,
  58929,
  29001,
  58930,
  29833,
  58931,
  32244,
  58932,
  32879,
  58933,
  34030,
  58934,
  36646,
  58935,
  36899,
  58936,
  37706,
  58937,
  20925,
  58938,
  21015,
  58939,
  21155,
  58940,
  27916,
  58941,
  28872,
  58942,
  35010,
  58943,
  24265,
  58944,
  25986,
  58945,
  27566,
  58946,
  28610,
  58947,
  31806,
  58948,
  29557,
  58949,
  20196,
  58950,
  20278,
  58951,
  22265,
  58952,
  63839,
  58953,
  23738,
  58954,
  23994,
  58955,
  24604,
  58956,
  29618,
  58957,
  31533,
  58958,
  32666,
  58959,
  32718,
  58960,
  32838,
  58961,
  36894,
  58962,
  37428,
  58963,
  38646,
  58964,
  38728,
  58965,
  38936,
  58966,
  40801,
  58967,
  20363,
  58968,
  28583,
  58969,
  31150,
  58970,
  37300,
  58971,
  38583,
  58972,
  21214,
  58973,
  63840,
  58974,
  25736,
  58975,
  25796,
  58976,
  27347,
  58977,
  28510,
  58978,
  28696,
  58979,
  29200,
  58980,
  30439,
  58981,
  32769,
  58982,
  34310,
  58983,
  34396,
  58984,
  36335,
  58985,
  36613,
  58986,
  38706,
  58987,
  39791,
  58988,
  40442,
  58989,
  40565,
  58990,
  30860,
  58991,
  31103,
  58992,
  32160,
  58993,
  33737,
  58994,
  37636,
  58995,
  40575,
  58996,
  40595,
  58997,
  35542,
  58998,
  22751,
  58999,
  24324,
  59e3,
  26407,
  59001,
  28711,
  59002,
  29903,
  59003,
  31840,
  59004,
  32894,
  59005,
  20769,
  59006,
  28712,
  59025,
  29282,
  59026,
  30922,
  59027,
  36034,
  59028,
  36058,
  59029,
  36084,
  59030,
  38647,
  59031,
  20102,
  59032,
  20698,
  59033,
  23534,
  59034,
  24278,
  59035,
  26009,
  59036,
  29134,
  59037,
  30274,
  59038,
  30637,
  59039,
  32842,
  59040,
  34044,
  59041,
  36988,
  59042,
  39719,
  59043,
  40845,
  59044,
  22744,
  59045,
  23105,
  59046,
  23650,
  59047,
  27155,
  59048,
  28122,
  59049,
  28431,
  59050,
  30267,
  59051,
  32047,
  59052,
  32311,
  59053,
  34078,
  59054,
  35128,
  59055,
  37860,
  59056,
  38475,
  59057,
  21129,
  59058,
  26066,
  59059,
  26611,
  59060,
  27060,
  59061,
  27969,
  59062,
  28316,
  59063,
  28687,
  59064,
  29705,
  59065,
  29792,
  59066,
  30041,
  59067,
  30244,
  59068,
  30827,
  59069,
  35628,
  59070,
  39006,
  59071,
  20845,
  59072,
  25134,
  59073,
  38520,
  59074,
  20374,
  59075,
  20523,
  59076,
  23833,
  59077,
  28138,
  59078,
  32184,
  59079,
  36650,
  59080,
  24459,
  59081,
  24900,
  59082,
  26647,
  59083,
  63841,
  59084,
  38534,
  59085,
  21202,
  59086,
  32907,
  59087,
  20956,
  59088,
  20940,
  59089,
  26974,
  59090,
  31260,
  59091,
  32190,
  59092,
  33777,
  59093,
  38517,
  59094,
  20442,
  59095,
  21033,
  59096,
  21400,
  59097,
  21519,
  59098,
  21774,
  59099,
  23653,
  59100,
  24743,
  59101,
  26446,
  59102,
  26792,
  59103,
  28012,
  59104,
  29313,
  59105,
  29432,
  59106,
  29702,
  59107,
  29827,
  59108,
  63842,
  59109,
  30178,
  59110,
  31852,
  59111,
  32633,
  59112,
  32696,
  59113,
  33673,
  59114,
  35023,
  59115,
  35041,
  59116,
  37324,
  59117,
  37328,
  59118,
  38626,
  59119,
  39881,
  59120,
  21533,
  59121,
  28542,
  59122,
  29136,
  59123,
  29848,
  59124,
  34298,
  59125,
  36522,
  59126,
  38563,
  59127,
  40023,
  59128,
  40607,
  59129,
  26519,
  59130,
  28107,
  59131,
  29747,
  59132,
  33256,
  59133,
  38678,
  59134,
  30764,
  59185,
  31435,
  59186,
  31520,
  59187,
  31890,
  59188,
  25705,
  59189,
  29802,
  59190,
  30194,
  59191,
  30908,
  59192,
  30952,
  59193,
  39340,
  59194,
  39764,
  59195,
  40635,
  59196,
  23518,
  59197,
  24149,
  59198,
  28448,
  59199,
  33180,
  59200,
  33707,
  59201,
  37e3,
  59202,
  19975,
  59203,
  21325,
  59204,
  23081,
  59205,
  24018,
  59206,
  24398,
  59207,
  24930,
  59208,
  25405,
  59209,
  26217,
  59210,
  26364,
  59211,
  28415,
  59212,
  28459,
  59213,
  28771,
  59214,
  30622,
  59215,
  33836,
  59216,
  34067,
  59217,
  34875,
  59218,
  36627,
  59219,
  39237,
  59220,
  39995,
  59221,
  21788,
  59222,
  25273,
  59223,
  26411,
  59224,
  27819,
  59225,
  33545,
  59226,
  35178,
  59227,
  38778,
  59228,
  20129,
  59229,
  22916,
  59230,
  24536,
  59231,
  24537,
  59232,
  26395,
  59233,
  32178,
  59234,
  32596,
  59235,
  33426,
  59236,
  33579,
  59237,
  33725,
  59238,
  36638,
  59239,
  37017,
  59240,
  22475,
  59241,
  22969,
  59242,
  23186,
  59243,
  23504,
  59244,
  26151,
  59245,
  26522,
  59246,
  26757,
  59247,
  27599,
  59248,
  29028,
  59249,
  32629,
  59250,
  36023,
  59251,
  36067,
  59252,
  36993,
  59253,
  39749,
  59254,
  33032,
  59255,
  35978,
  59256,
  38476,
  59257,
  39488,
  59258,
  40613,
  59259,
  23391,
  59260,
  27667,
  59261,
  29467,
  59262,
  30450,
  59281,
  30431,
  59282,
  33804,
  59283,
  20906,
  59284,
  35219,
  59285,
  20813,
  59286,
  20885,
  59287,
  21193,
  59288,
  26825,
  59289,
  27796,
  59290,
  30468,
  59291,
  30496,
  59292,
  32191,
  59293,
  32236,
  59294,
  38754,
  59295,
  40629,
  59296,
  28357,
  59297,
  34065,
  59298,
  20901,
  59299,
  21517,
  59300,
  21629,
  59301,
  26126,
  59302,
  26269,
  59303,
  26919,
  59304,
  28319,
  59305,
  30399,
  59306,
  30609,
  59307,
  33559,
  59308,
  33986,
  59309,
  34719,
  59310,
  37225,
  59311,
  37528,
  59312,
  40180,
  59313,
  34946,
  59314,
  20398,
  59315,
  20882,
  59316,
  21215,
  59317,
  22982,
  59318,
  24125,
  59319,
  24917,
  59320,
  25720,
  59321,
  25721,
  59322,
  26286,
  59323,
  26576,
  59324,
  27169,
  59325,
  27597,
  59326,
  27611,
  59327,
  29279,
  59328,
  29281,
  59329,
  29761,
  59330,
  30520,
  59331,
  30683,
  59332,
  32791,
  59333,
  33468,
  59334,
  33541,
  59335,
  35584,
  59336,
  35624,
  59337,
  35980,
  59338,
  26408,
  59339,
  27792,
  59340,
  29287,
  59341,
  30446,
  59342,
  30566,
  59343,
  31302,
  59344,
  40361,
  59345,
  27519,
  59346,
  27794,
  59347,
  22818,
  59348,
  26406,
  59349,
  33945,
  59350,
  21359,
  59351,
  22675,
  59352,
  22937,
  59353,
  24287,
  59354,
  25551,
  59355,
  26164,
  59356,
  26483,
  59357,
  28218,
  59358,
  29483,
  59359,
  31447,
  59360,
  33495,
  59361,
  37672,
  59362,
  21209,
  59363,
  24043,
  59364,
  25006,
  59365,
  25035,
  59366,
  25098,
  59367,
  25287,
  59368,
  25771,
  59369,
  26080,
  59370,
  26969,
  59371,
  27494,
  59372,
  27595,
  59373,
  28961,
  59374,
  29687,
  59375,
  30045,
  59376,
  32326,
  59377,
  33310,
  59378,
  33538,
  59379,
  34154,
  59380,
  35491,
  59381,
  36031,
  59382,
  38695,
  59383,
  40289,
  59384,
  22696,
  59385,
  40664,
  59386,
  20497,
  59387,
  21006,
  59388,
  21563,
  59389,
  21839,
  59390,
  25991,
  59441,
  27766,
  59442,
  32010,
  59443,
  32011,
  59444,
  32862,
  59445,
  34442,
  59446,
  38272,
  59447,
  38639,
  59448,
  21247,
  59449,
  27797,
  59450,
  29289,
  59451,
  21619,
  59452,
  23194,
  59453,
  23614,
  59454,
  23883,
  59455,
  24396,
  59456,
  24494,
  59457,
  26410,
  59458,
  26806,
  59459,
  26979,
  59460,
  28220,
  59461,
  28228,
  59462,
  30473,
  59463,
  31859,
  59464,
  32654,
  59465,
  34183,
  59466,
  35598,
  59467,
  36855,
  59468,
  38753,
  59469,
  40692,
  59470,
  23735,
  59471,
  24758,
  59472,
  24845,
  59473,
  25003,
  59474,
  25935,
  59475,
  26107,
  59476,
  26108,
  59477,
  27665,
  59478,
  27887,
  59479,
  29599,
  59480,
  29641,
  59481,
  32225,
  59482,
  38292,
  59483,
  23494,
  59484,
  34588,
  59485,
  35600,
  59486,
  21085,
  59487,
  21338,
  59488,
  25293,
  59489,
  25615,
  59490,
  25778,
  59491,
  26420,
  59492,
  27192,
  59493,
  27850,
  59494,
  29632,
  59495,
  29854,
  59496,
  31636,
  59497,
  31893,
  59498,
  32283,
  59499,
  33162,
  59500,
  33334,
  59501,
  34180,
  59502,
  36843,
  59503,
  38649,
  59504,
  39361,
  59505,
  20276,
  59506,
  21322,
  59507,
  21453,
  59508,
  21467,
  59509,
  25292,
  59510,
  25644,
  59511,
  25856,
  59512,
  26001,
  59513,
  27075,
  59514,
  27886,
  59515,
  28504,
  59516,
  29677,
  59517,
  30036,
  59518,
  30242,
  59537,
  30436,
  59538,
  30460,
  59539,
  30928,
  59540,
  30971,
  59541,
  31020,
  59542,
  32070,
  59543,
  33324,
  59544,
  34784,
  59545,
  36820,
  59546,
  38930,
  59547,
  39151,
  59548,
  21187,
  59549,
  25300,
  59550,
  25765,
  59551,
  28196,
  59552,
  28497,
  59553,
  30332,
  59554,
  36299,
  59555,
  37297,
  59556,
  37474,
  59557,
  39662,
  59558,
  39747,
  59559,
  20515,
  59560,
  20621,
  59561,
  22346,
  59562,
  22952,
  59563,
  23592,
  59564,
  24135,
  59565,
  24439,
  59566,
  25151,
  59567,
  25918,
  59568,
  26041,
  59569,
  26049,
  59570,
  26121,
  59571,
  26507,
  59572,
  27036,
  59573,
  28354,
  59574,
  30917,
  59575,
  32033,
  59576,
  32938,
  59577,
  33152,
  59578,
  33323,
  59579,
  33459,
  59580,
  33953,
  59581,
  34444,
  59582,
  35370,
  59583,
  35607,
  59584,
  37030,
  59585,
  38450,
  59586,
  40848,
  59587,
  20493,
  59588,
  20467,
  59589,
  63843,
  59590,
  22521,
  59591,
  24472,
  59592,
  25308,
  59593,
  25490,
  59594,
  26479,
  59595,
  28227,
  59596,
  28953,
  59597,
  30403,
  59598,
  32972,
  59599,
  32986,
  59600,
  35060,
  59601,
  35061,
  59602,
  35097,
  59603,
  36064,
  59604,
  36649,
  59605,
  37197,
  59606,
  38506,
  59607,
  20271,
  59608,
  20336,
  59609,
  24091,
  59610,
  26575,
  59611,
  26658,
  59612,
  30333,
  59613,
  30334,
  59614,
  39748,
  59615,
  24161,
  59616,
  27146,
  59617,
  29033,
  59618,
  29140,
  59619,
  30058,
  59620,
  63844,
  59621,
  32321,
  59622,
  34115,
  59623,
  34281,
  59624,
  39132,
  59625,
  20240,
  59626,
  31567,
  59627,
  32624,
  59628,
  38309,
  59629,
  20961,
  59630,
  24070,
  59631,
  26805,
  59632,
  27710,
  59633,
  27726,
  59634,
  27867,
  59635,
  29359,
  59636,
  31684,
  59637,
  33539,
  59638,
  27861,
  59639,
  29754,
  59640,
  20731,
  59641,
  21128,
  59642,
  22721,
  59643,
  25816,
  59644,
  27287,
  59645,
  29863,
  59646,
  30294,
  59697,
  30887,
  59698,
  34327,
  59699,
  38370,
  59700,
  38713,
  59701,
  63845,
  59702,
  21342,
  59703,
  24321,
  59704,
  35722,
  59705,
  36776,
  59706,
  36783,
  59707,
  37002,
  59708,
  21029,
  59709,
  30629,
  59710,
  40009,
  59711,
  40712,
  59712,
  19993,
  59713,
  20482,
  59714,
  20853,
  59715,
  23643,
  59716,
  24183,
  59717,
  26142,
  59718,
  26170,
  59719,
  26564,
  59720,
  26821,
  59721,
  28851,
  59722,
  29953,
  59723,
  30149,
  59724,
  31177,
  59725,
  31453,
  59726,
  36647,
  59727,
  39200,
  59728,
  39432,
  59729,
  20445,
  59730,
  22561,
  59731,
  22577,
  59732,
  23542,
  59733,
  26222,
  59734,
  27493,
  59735,
  27921,
  59736,
  28282,
  59737,
  28541,
  59738,
  29668,
  59739,
  29995,
  59740,
  33769,
  59741,
  35036,
  59742,
  35091,
  59743,
  35676,
  59744,
  36628,
  59745,
  20239,
  59746,
  20693,
  59747,
  21264,
  59748,
  21340,
  59749,
  23443,
  59750,
  24489,
  59751,
  26381,
  59752,
  31119,
  59753,
  33145,
  59754,
  33583,
  59755,
  34068,
  59756,
  35079,
  59757,
  35206,
  59758,
  36665,
  59759,
  36667,
  59760,
  39333,
  59761,
  39954,
  59762,
  26412,
  59763,
  20086,
  59764,
  20472,
  59765,
  22857,
  59766,
  23553,
  59767,
  23791,
  59768,
  23792,
  59769,
  25447,
  59770,
  26834,
  59771,
  28925,
  59772,
  29090,
  59773,
  29739,
  59774,
  32299,
  59793,
  34028,
  59794,
  34562,
  59795,
  36898,
  59796,
  37586,
  59797,
  40179,
  59798,
  19981,
  59799,
  20184,
  59800,
  20463,
  59801,
  20613,
  59802,
  21078,
  59803,
  21103,
  59804,
  21542,
  59805,
  21648,
  59806,
  22496,
  59807,
  22827,
  59808,
  23142,
  59809,
  23386,
  59810,
  23413,
  59811,
  23500,
  59812,
  24220,
  59813,
  63846,
  59814,
  25206,
  59815,
  25975,
  59816,
  26023,
  59817,
  28014,
  59818,
  28325,
  59819,
  29238,
  59820,
  31526,
  59821,
  31807,
  59822,
  32566,
  59823,
  33104,
  59824,
  33105,
  59825,
  33178,
  59826,
  33344,
  59827,
  33433,
  59828,
  33705,
  59829,
  35331,
  59830,
  36e3,
  59831,
  36070,
  59832,
  36091,
  59833,
  36212,
  59834,
  36282,
  59835,
  37096,
  59836,
  37340,
  59837,
  38428,
  59838,
  38468,
  59839,
  39385,
  59840,
  40167,
  59841,
  21271,
  59842,
  20998,
  59843,
  21545,
  59844,
  22132,
  59845,
  22707,
  59846,
  22868,
  59847,
  22894,
  59848,
  24575,
  59849,
  24996,
  59850,
  25198,
  59851,
  26128,
  59852,
  27774,
  59853,
  28954,
  59854,
  30406,
  59855,
  31881,
  59856,
  31966,
  59857,
  32027,
  59858,
  33452,
  59859,
  36033,
  59860,
  38640,
  59861,
  63847,
  59862,
  20315,
  59863,
  24343,
  59864,
  24447,
  59865,
  25282,
  59866,
  23849,
  59867,
  26379,
  59868,
  26842,
  59869,
  30844,
  59870,
  32323,
  59871,
  40300,
  59872,
  19989,
  59873,
  20633,
  59874,
  21269,
  59875,
  21290,
  59876,
  21329,
  59877,
  22915,
  59878,
  23138,
  59879,
  24199,
  59880,
  24754,
  59881,
  24970,
  59882,
  25161,
  59883,
  25209,
  59884,
  26e3,
  59885,
  26503,
  59886,
  27047,
  59887,
  27604,
  59888,
  27606,
  59889,
  27607,
  59890,
  27608,
  59891,
  27832,
  59892,
  63848,
  59893,
  29749,
  59894,
  30202,
  59895,
  30738,
  59896,
  30865,
  59897,
  31189,
  59898,
  31192,
  59899,
  31875,
  59900,
  32203,
  59901,
  32737,
  59902,
  32933,
  59953,
  33086,
  59954,
  33218,
  59955,
  33778,
  59956,
  34586,
  59957,
  35048,
  59958,
  35513,
  59959,
  35692,
  59960,
  36027,
  59961,
  37145,
  59962,
  38750,
  59963,
  39131,
  59964,
  40763,
  59965,
  22188,
  59966,
  23338,
  59967,
  24428,
  59968,
  25996,
  59969,
  27315,
  59970,
  27567,
  59971,
  27996,
  59972,
  28657,
  59973,
  28693,
  59974,
  29277,
  59975,
  29613,
  59976,
  36007,
  59977,
  36051,
  59978,
  38971,
  59979,
  24977,
  59980,
  27703,
  59981,
  32856,
  59982,
  39425,
  59983,
  20045,
  59984,
  20107,
  59985,
  20123,
  59986,
  20181,
  59987,
  20282,
  59988,
  20284,
  59989,
  20351,
  59990,
  20447,
  59991,
  20735,
  59992,
  21490,
  59993,
  21496,
  59994,
  21766,
  59995,
  21987,
  59996,
  22235,
  59997,
  22763,
  59998,
  22882,
  59999,
  23057,
  6e4,
  23531,
  60001,
  23546,
  60002,
  23556,
  60003,
  24051,
  60004,
  24107,
  60005,
  24473,
  60006,
  24605,
  60007,
  25448,
  60008,
  26012,
  60009,
  26031,
  60010,
  26614,
  60011,
  26619,
  60012,
  26797,
  60013,
  27515,
  60014,
  27801,
  60015,
  27863,
  60016,
  28195,
  60017,
  28681,
  60018,
  29509,
  60019,
  30722,
  60020,
  31038,
  60021,
  31040,
  60022,
  31072,
  60023,
  31169,
  60024,
  31721,
  60025,
  32023,
  60026,
  32114,
  60027,
  32902,
  60028,
  33293,
  60029,
  33678,
  60030,
  34001,
  60049,
  34503,
  60050,
  35039,
  60051,
  35408,
  60052,
  35422,
  60053,
  35613,
  60054,
  36060,
  60055,
  36198,
  60056,
  36781,
  60057,
  37034,
  60058,
  39164,
  60059,
  39391,
  60060,
  40605,
  60061,
  21066,
  60062,
  63849,
  60063,
  26388,
  60064,
  63850,
  60065,
  20632,
  60066,
  21034,
  60067,
  23665,
  60068,
  25955,
  60069,
  27733,
  60070,
  29642,
  60071,
  29987,
  60072,
  30109,
  60073,
  31639,
  60074,
  33948,
  60075,
  37240,
  60076,
  38704,
  60077,
  20087,
  60078,
  25746,
  60079,
  27578,
  60080,
  29022,
  60081,
  34217,
  60082,
  19977,
  60083,
  63851,
  60084,
  26441,
  60085,
  26862,
  60086,
  28183,
  60087,
  33439,
  60088,
  34072,
  60089,
  34923,
  60090,
  25591,
  60091,
  28545,
  60092,
  37394,
  60093,
  39087,
  60094,
  19978,
  60095,
  20663,
  60096,
  20687,
  60097,
  20767,
  60098,
  21830,
  60099,
  21930,
  60100,
  22039,
  60101,
  23360,
  60102,
  23577,
  60103,
  23776,
  60104,
  24120,
  60105,
  24202,
  60106,
  24224,
  60107,
  24258,
  60108,
  24819,
  60109,
  26705,
  60110,
  27233,
  60111,
  28248,
  60112,
  29245,
  60113,
  29248,
  60114,
  29376,
  60115,
  30456,
  60116,
  31077,
  60117,
  31665,
  60118,
  32724,
  60119,
  35059,
  60120,
  35316,
  60121,
  35443,
  60122,
  35937,
  60123,
  36062,
  60124,
  38684,
  60125,
  22622,
  60126,
  29885,
  60127,
  36093,
  60128,
  21959,
  60129,
  63852,
  60130,
  31329,
  60131,
  32034,
  60132,
  33394,
  60133,
  29298,
  60134,
  29983,
  60135,
  29989,
  60136,
  63853,
  60137,
  31513,
  60138,
  22661,
  60139,
  22779,
  60140,
  23996,
  60141,
  24207,
  60142,
  24246,
  60143,
  24464,
  60144,
  24661,
  60145,
  25234,
  60146,
  25471,
  60147,
  25933,
  60148,
  26257,
  60149,
  26329,
  60150,
  26360,
  60151,
  26646,
  60152,
  26866,
  60153,
  29312,
  60154,
  29790,
  60155,
  31598,
  60156,
  32110,
  60157,
  32214,
  60158,
  32626,
  60209,
  32997,
  60210,
  33298,
  60211,
  34223,
  60212,
  35199,
  60213,
  35475,
  60214,
  36893,
  60215,
  37604,
  60216,
  40653,
  60217,
  40736,
  60218,
  22805,
  60219,
  22893,
  60220,
  24109,
  60221,
  24796,
  60222,
  26132,
  60223,
  26227,
  60224,
  26512,
  60225,
  27728,
  60226,
  28101,
  60227,
  28511,
  60228,
  30707,
  60229,
  30889,
  60230,
  33990,
  60231,
  37323,
  60232,
  37675,
  60233,
  20185,
  60234,
  20682,
  60235,
  20808,
  60236,
  21892,
  60237,
  23307,
  60238,
  23459,
  60239,
  25159,
  60240,
  25982,
  60241,
  26059,
  60242,
  28210,
  60243,
  29053,
  60244,
  29697,
  60245,
  29764,
  60246,
  29831,
  60247,
  29887,
  60248,
  30316,
  60249,
  31146,
  60250,
  32218,
  60251,
  32341,
  60252,
  32680,
  60253,
  33146,
  60254,
  33203,
  60255,
  33337,
  60256,
  34330,
  60257,
  34796,
  60258,
  35445,
  60259,
  36323,
  60260,
  36984,
  60261,
  37521,
  60262,
  37925,
  60263,
  39245,
  60264,
  39854,
  60265,
  21352,
  60266,
  23633,
  60267,
  26964,
  60268,
  27844,
  60269,
  27945,
  60270,
  28203,
  60271,
  33292,
  60272,
  34203,
  60273,
  35131,
  60274,
  35373,
  60275,
  35498,
  60276,
  38634,
  60277,
  40807,
  60278,
  21089,
  60279,
  26297,
  60280,
  27570,
  60281,
  32406,
  60282,
  34814,
  60283,
  36109,
  60284,
  38275,
  60285,
  38493,
  60286,
  25885,
  60305,
  28041,
  60306,
  29166,
  60307,
  63854,
  60308,
  22478,
  60309,
  22995,
  60310,
  23468,
  60311,
  24615,
  60312,
  24826,
  60313,
  25104,
  60314,
  26143,
  60315,
  26207,
  60316,
  29481,
  60317,
  29689,
  60318,
  30427,
  60319,
  30465,
  60320,
  31596,
  60321,
  32854,
  60322,
  32882,
  60323,
  33125,
  60324,
  35488,
  60325,
  37266,
  60326,
  19990,
  60327,
  21218,
  60328,
  27506,
  60329,
  27927,
  60330,
  31237,
  60331,
  31545,
  60332,
  32048,
  60333,
  63855,
  60334,
  36016,
  60335,
  21484,
  60336,
  22063,
  60337,
  22609,
  60338,
  23477,
  60339,
  23567,
  60340,
  23569,
  60341,
  24034,
  60342,
  25152,
  60343,
  25475,
  60344,
  25620,
  60345,
  26157,
  60346,
  26803,
  60347,
  27836,
  60348,
  28040,
  60349,
  28335,
  60350,
  28703,
  60351,
  28836,
  60352,
  29138,
  60353,
  29990,
  60354,
  30095,
  60355,
  30094,
  60356,
  30233,
  60357,
  31505,
  60358,
  31712,
  60359,
  31787,
  60360,
  32032,
  60361,
  32057,
  60362,
  34092,
  60363,
  34157,
  60364,
  34311,
  60365,
  35380,
  60366,
  36877,
  60367,
  36961,
  60368,
  37045,
  60369,
  37559,
  60370,
  38902,
  60371,
  39479,
  60372,
  20439,
  60373,
  23660,
  60374,
  26463,
  60375,
  28049,
  60376,
  31903,
  60377,
  32396,
  60378,
  35606,
  60379,
  36118,
  60380,
  36895,
  60381,
  23403,
  60382,
  24061,
  60383,
  25613,
  60384,
  33984,
  60385,
  36956,
  60386,
  39137,
  60387,
  29575,
  60388,
  23435,
  60389,
  24730,
  60390,
  26494,
  60391,
  28126,
  60392,
  35359,
  60393,
  35494,
  60394,
  36865,
  60395,
  38924,
  60396,
  21047,
  60397,
  63856,
  60398,
  28753,
  60399,
  30862,
  60400,
  37782,
  60401,
  34928,
  60402,
  37335,
  60403,
  20462,
  60404,
  21463,
  60405,
  22013,
  60406,
  22234,
  60407,
  22402,
  60408,
  22781,
  60409,
  23234,
  60410,
  23432,
  60411,
  23723,
  60412,
  23744,
  60413,
  24101,
  60414,
  24833,
  60465,
  25101,
  60466,
  25163,
  60467,
  25480,
  60468,
  25628,
  60469,
  25910,
  60470,
  25976,
  60471,
  27193,
  60472,
  27530,
  60473,
  27700,
  60474,
  27929,
  60475,
  28465,
  60476,
  29159,
  60477,
  29417,
  60478,
  29560,
  60479,
  29703,
  60480,
  29874,
  60481,
  30246,
  60482,
  30561,
  60483,
  31168,
  60484,
  31319,
  60485,
  31466,
  60486,
  31929,
  60487,
  32143,
  60488,
  32172,
  60489,
  32353,
  60490,
  32670,
  60491,
  33065,
  60492,
  33585,
  60493,
  33936,
  60494,
  34010,
  60495,
  34282,
  60496,
  34966,
  60497,
  35504,
  60498,
  35728,
  60499,
  36664,
  60500,
  36930,
  60501,
  36995,
  60502,
  37228,
  60503,
  37526,
  60504,
  37561,
  60505,
  38539,
  60506,
  38567,
  60507,
  38568,
  60508,
  38614,
  60509,
  38656,
  60510,
  38920,
  60511,
  39318,
  60512,
  39635,
  60513,
  39706,
  60514,
  21460,
  60515,
  22654,
  60516,
  22809,
  60517,
  23408,
  60518,
  23487,
  60519,
  28113,
  60520,
  28506,
  60521,
  29087,
  60522,
  29729,
  60523,
  29881,
  60524,
  32901,
  60525,
  33789,
  60526,
  24033,
  60527,
  24455,
  60528,
  24490,
  60529,
  24642,
  60530,
  26092,
  60531,
  26642,
  60532,
  26991,
  60533,
  27219,
  60534,
  27529,
  60535,
  27957,
  60536,
  28147,
  60537,
  29667,
  60538,
  30462,
  60539,
  30636,
  60540,
  31565,
  60541,
  32020,
  60542,
  33059,
  60561,
  33308,
  60562,
  33600,
  60563,
  34036,
  60564,
  34147,
  60565,
  35426,
  60566,
  35524,
  60567,
  37255,
  60568,
  37662,
  60569,
  38918,
  60570,
  39348,
  60571,
  25100,
  60572,
  34899,
  60573,
  36848,
  60574,
  37477,
  60575,
  23815,
  60576,
  23847,
  60577,
  23913,
  60578,
  29791,
  60579,
  33181,
  60580,
  34664,
  60581,
  28629,
  60582,
  25342,
  60583,
  32722,
  60584,
  35126,
  60585,
  35186,
  60586,
  19998,
  60587,
  20056,
  60588,
  20711,
  60589,
  21213,
  60590,
  21319,
  60591,
  25215,
  60592,
  26119,
  60593,
  32361,
  60594,
  34821,
  60595,
  38494,
  60596,
  20365,
  60597,
  21273,
  60598,
  22070,
  60599,
  22987,
  60600,
  23204,
  60601,
  23608,
  60602,
  23630,
  60603,
  23629,
  60604,
  24066,
  60605,
  24337,
  60606,
  24643,
  60607,
  26045,
  60608,
  26159,
  60609,
  26178,
  60610,
  26558,
  60611,
  26612,
  60612,
  29468,
  60613,
  30690,
  60614,
  31034,
  60615,
  32709,
  60616,
  33940,
  60617,
  33997,
  60618,
  35222,
  60619,
  35430,
  60620,
  35433,
  60621,
  35553,
  60622,
  35925,
  60623,
  35962,
  60624,
  22516,
  60625,
  23508,
  60626,
  24335,
  60627,
  24687,
  60628,
  25325,
  60629,
  26893,
  60630,
  27542,
  60631,
  28252,
  60632,
  29060,
  60633,
  31698,
  60634,
  34645,
  60635,
  35672,
  60636,
  36606,
  60637,
  39135,
  60638,
  39166,
  60639,
  20280,
  60640,
  20353,
  60641,
  20449,
  60642,
  21627,
  60643,
  23072,
  60644,
  23480,
  60645,
  24892,
  60646,
  26032,
  60647,
  26216,
  60648,
  29180,
  60649,
  30003,
  60650,
  31070,
  60651,
  32051,
  60652,
  33102,
  60653,
  33251,
  60654,
  33688,
  60655,
  34218,
  60656,
  34254,
  60657,
  34563,
  60658,
  35338,
  60659,
  36523,
  60660,
  36763,
  60661,
  63857,
  60662,
  36805,
  60663,
  22833,
  60664,
  23460,
  60665,
  23526,
  60666,
  24713,
  60667,
  23529,
  60668,
  23563,
  60669,
  24515,
  60670,
  27777,
  60721,
  63858,
  60722,
  28145,
  60723,
  28683,
  60724,
  29978,
  60725,
  33455,
  60726,
  35574,
  60727,
  20160,
  60728,
  21313,
  60729,
  63859,
  60730,
  38617,
  60731,
  27663,
  60732,
  20126,
  60733,
  20420,
  60734,
  20818,
  60735,
  21854,
  60736,
  23077,
  60737,
  23784,
  60738,
  25105,
  60739,
  29273,
  60740,
  33469,
  60741,
  33706,
  60742,
  34558,
  60743,
  34905,
  60744,
  35357,
  60745,
  38463,
  60746,
  38597,
  60747,
  39187,
  60748,
  40201,
  60749,
  40285,
  60750,
  22538,
  60751,
  23731,
  60752,
  23997,
  60753,
  24132,
  60754,
  24801,
  60755,
  24853,
  60756,
  25569,
  60757,
  27138,
  60758,
  28197,
  60759,
  37122,
  60760,
  37716,
  60761,
  38990,
  60762,
  39952,
  60763,
  40823,
  60764,
  23433,
  60765,
  23736,
  60766,
  25353,
  60767,
  26191,
  60768,
  26696,
  60769,
  30524,
  60770,
  38593,
  60771,
  38797,
  60772,
  38996,
  60773,
  39839,
  60774,
  26017,
  60775,
  35585,
  60776,
  36555,
  60777,
  38332,
  60778,
  21813,
  60779,
  23721,
  60780,
  24022,
  60781,
  24245,
  60782,
  26263,
  60783,
  30284,
  60784,
  33780,
  60785,
  38343,
  60786,
  22739,
  60787,
  25276,
  60788,
  29390,
  60789,
  40232,
  60790,
  20208,
  60791,
  22830,
  60792,
  24591,
  60793,
  26171,
  60794,
  27523,
  60795,
  31207,
  60796,
  40230,
  60797,
  21395,
  60798,
  21696,
  60817,
  22467,
  60818,
  23830,
  60819,
  24859,
  60820,
  26326,
  60821,
  28079,
  60822,
  30861,
  60823,
  33406,
  60824,
  38552,
  60825,
  38724,
  60826,
  21380,
  60827,
  25212,
  60828,
  25494,
  60829,
  28082,
  60830,
  32266,
  60831,
  33099,
  60832,
  38989,
  60833,
  27387,
  60834,
  32588,
  60835,
  40367,
  60836,
  40474,
  60837,
  20063,
  60838,
  20539,
  60839,
  20918,
  60840,
  22812,
  60841,
  24825,
  60842,
  25590,
  60843,
  26928,
  60844,
  29242,
  60845,
  32822,
  60846,
  63860,
  60847,
  37326,
  60848,
  24369,
  60849,
  63861,
  60850,
  63862,
  60851,
  32004,
  60852,
  33509,
  60853,
  33903,
  60854,
  33979,
  60855,
  34277,
  60856,
  36493,
  60857,
  63863,
  60858,
  20335,
  60859,
  63864,
  60860,
  63865,
  60861,
  22756,
  60862,
  23363,
  60863,
  24665,
  60864,
  25562,
  60865,
  25880,
  60866,
  25965,
  60867,
  26264,
  60868,
  63866,
  60869,
  26954,
  60870,
  27171,
  60871,
  27915,
  60872,
  28673,
  60873,
  29036,
  60874,
  30162,
  60875,
  30221,
  60876,
  31155,
  60877,
  31344,
  60878,
  63867,
  60879,
  32650,
  60880,
  63868,
  60881,
  35140,
  60882,
  63869,
  60883,
  35731,
  60884,
  37312,
  60885,
  38525,
  60886,
  63870,
  60887,
  39178,
  60888,
  22276,
  60889,
  24481,
  60890,
  26044,
  60891,
  28417,
  60892,
  30208,
  60893,
  31142,
  60894,
  35486,
  60895,
  39341,
  60896,
  39770,
  60897,
  40812,
  60898,
  20740,
  60899,
  25014,
  60900,
  25233,
  60901,
  27277,
  60902,
  33222,
  60903,
  20547,
  60904,
  22576,
  60905,
  24422,
  60906,
  28937,
  60907,
  35328,
  60908,
  35578,
  60909,
  23420,
  60910,
  34326,
  60911,
  20474,
  60912,
  20796,
  60913,
  22196,
  60914,
  22852,
  60915,
  25513,
  60916,
  28153,
  60917,
  23978,
  60918,
  26989,
  60919,
  20870,
  60920,
  20104,
  60921,
  20313,
  60922,
  63871,
  60923,
  63872,
  60924,
  63873,
  60925,
  22914,
  60926,
  63874,
  60977,
  63875,
  60978,
  27487,
  60979,
  27741,
  60980,
  63876,
  60981,
  29877,
  60982,
  30998,
  60983,
  63877,
  60984,
  33287,
  60985,
  33349,
  60986,
  33593,
  60987,
  36671,
  60988,
  36701,
  60989,
  63878,
  60990,
  39192,
  60991,
  63879,
  60992,
  63880,
  60993,
  63881,
  60994,
  20134,
  60995,
  63882,
  60996,
  22495,
  60997,
  24441,
  60998,
  26131,
  60999,
  63883,
  61e3,
  63884,
  61001,
  30123,
  61002,
  32377,
  61003,
  35695,
  61004,
  63885,
  61005,
  36870,
  61006,
  39515,
  61007,
  22181,
  61008,
  22567,
  61009,
  23032,
  61010,
  23071,
  61011,
  23476,
  61012,
  63886,
  61013,
  24310,
  61014,
  63887,
  61015,
  63888,
  61016,
  25424,
  61017,
  25403,
  61018,
  63889,
  61019,
  26941,
  61020,
  27783,
  61021,
  27839,
  61022,
  28046,
  61023,
  28051,
  61024,
  28149,
  61025,
  28436,
  61026,
  63890,
  61027,
  28895,
  61028,
  28982,
  61029,
  29017,
  61030,
  63891,
  61031,
  29123,
  61032,
  29141,
  61033,
  63892,
  61034,
  30799,
  61035,
  30831,
  61036,
  63893,
  61037,
  31605,
  61038,
  32227,
  61039,
  63894,
  61040,
  32303,
  61041,
  63895,
  61042,
  34893,
  61043,
  36575,
  61044,
  63896,
  61045,
  63897,
  61046,
  63898,
  61047,
  37467,
  61048,
  63899,
  61049,
  40182,
  61050,
  63900,
  61051,
  63901,
  61052,
  63902,
  61053,
  24709,
  61054,
  28037,
  61073,
  63903,
  61074,
  29105,
  61075,
  63904,
  61076,
  63905,
  61077,
  38321,
  61078,
  21421,
  61079,
  63906,
  61080,
  63907,
  61081,
  63908,
  61082,
  26579,
  61083,
  63909,
  61084,
  28814,
  61085,
  28976,
  61086,
  29744,
  61087,
  33398,
  61088,
  33490,
  61089,
  63910,
  61090,
  38331,
  61091,
  39653,
  61092,
  40573,
  61093,
  26308,
  61094,
  63911,
  61095,
  29121,
  61096,
  33865,
  61097,
  63912,
  61098,
  63913,
  61099,
  22603,
  61100,
  63914,
  61101,
  63915,
  61102,
  23992,
  61103,
  24433,
  61104,
  63916,
  61105,
  26144,
  61106,
  26254,
  61107,
  27001,
  61108,
  27054,
  61109,
  27704,
  61110,
  27891,
  61111,
  28214,
  61112,
  28481,
  61113,
  28634,
  61114,
  28699,
  61115,
  28719,
  61116,
  29008,
  61117,
  29151,
  61118,
  29552,
  61119,
  63917,
  61120,
  29787,
  61121,
  63918,
  61122,
  29908,
  61123,
  30408,
  61124,
  31310,
  61125,
  32403,
  61126,
  63919,
  61127,
  63920,
  61128,
  33521,
  61129,
  35424,
  61130,
  36814,
  61131,
  63921,
  61132,
  37704,
  61133,
  63922,
  61134,
  38681,
  61135,
  63923,
  61136,
  63924,
  61137,
  20034,
  61138,
  20522,
  61139,
  63925,
  61140,
  21e3,
  61141,
  21473,
  61142,
  26355,
  61143,
  27757,
  61144,
  28618,
  61145,
  29450,
  61146,
  30591,
  61147,
  31330,
  61148,
  33454,
  61149,
  34269,
  61150,
  34306,
  61151,
  63926,
  61152,
  35028,
  61153,
  35427,
  61154,
  35709,
  61155,
  35947,
  61156,
  63927,
  61157,
  37555,
  61158,
  63928,
  61159,
  38675,
  61160,
  38928,
  61161,
  20116,
  61162,
  20237,
  61163,
  20425,
  61164,
  20658,
  61165,
  21320,
  61166,
  21566,
  61167,
  21555,
  61168,
  21978,
  61169,
  22626,
  61170,
  22714,
  61171,
  22887,
  61172,
  23067,
  61173,
  23524,
  61174,
  24735,
  61175,
  63929,
  61176,
  25034,
  61177,
  25942,
  61178,
  26111,
  61179,
  26212,
  61180,
  26791,
  61181,
  27738,
  61182,
  28595,
  61233,
  28879,
  61234,
  29100,
  61235,
  29522,
  61236,
  31613,
  61237,
  34568,
  61238,
  35492,
  61239,
  39986,
  61240,
  40711,
  61241,
  23627,
  61242,
  27779,
  61243,
  29508,
  61244,
  29577,
  61245,
  37434,
  61246,
  28331,
  61247,
  29797,
  61248,
  30239,
  61249,
  31337,
  61250,
  32277,
  61251,
  34314,
  61252,
  20800,
  61253,
  22725,
  61254,
  25793,
  61255,
  29934,
  61256,
  29973,
  61257,
  30320,
  61258,
  32705,
  61259,
  37013,
  61260,
  38605,
  61261,
  39252,
  61262,
  28198,
  61263,
  29926,
  61264,
  31401,
  61265,
  31402,
  61266,
  33253,
  61267,
  34521,
  61268,
  34680,
  61269,
  35355,
  61270,
  23113,
  61271,
  23436,
  61272,
  23451,
  61273,
  26785,
  61274,
  26880,
  61275,
  28003,
  61276,
  29609,
  61277,
  29715,
  61278,
  29740,
  61279,
  30871,
  61280,
  32233,
  61281,
  32747,
  61282,
  33048,
  61283,
  33109,
  61284,
  33694,
  61285,
  35916,
  61286,
  38446,
  61287,
  38929,
  61288,
  26352,
  61289,
  24448,
  61290,
  26106,
  61291,
  26505,
  61292,
  27754,
  61293,
  29579,
  61294,
  20525,
  61295,
  23043,
  61296,
  27498,
  61297,
  30702,
  61298,
  22806,
  61299,
  23916,
  61300,
  24013,
  61301,
  29477,
  61302,
  30031,
  61303,
  63930,
  61304,
  63931,
  61305,
  20709,
  61306,
  20985,
  61307,
  22575,
  61308,
  22829,
  61309,
  22934,
  61310,
  23002,
  61329,
  23525,
  61330,
  63932,
  61331,
  63933,
  61332,
  23970,
  61333,
  25303,
  61334,
  25622,
  61335,
  25747,
  61336,
  25854,
  61337,
  63934,
  61338,
  26332,
  61339,
  63935,
  61340,
  27208,
  61341,
  63936,
  61342,
  29183,
  61343,
  29796,
  61344,
  63937,
  61345,
  31368,
  61346,
  31407,
  61347,
  32327,
  61348,
  32350,
  61349,
  32768,
  61350,
  33136,
  61351,
  63938,
  61352,
  34799,
  61353,
  35201,
  61354,
  35616,
  61355,
  36953,
  61356,
  63939,
  61357,
  36992,
  61358,
  39250,
  61359,
  24958,
  61360,
  27442,
  61361,
  28020,
  61362,
  32287,
  61363,
  35109,
  61364,
  36785,
  61365,
  20433,
  61366,
  20653,
  61367,
  20887,
  61368,
  21191,
  61369,
  22471,
  61370,
  22665,
  61371,
  23481,
  61372,
  24248,
  61373,
  24898,
  61374,
  27029,
  61375,
  28044,
  61376,
  28263,
  61377,
  28342,
  61378,
  29076,
  61379,
  29794,
  61380,
  29992,
  61381,
  29996,
  61382,
  32883,
  61383,
  33592,
  61384,
  33993,
  61385,
  36362,
  61386,
  37780,
  61387,
  37854,
  61388,
  63940,
  61389,
  20110,
  61390,
  20305,
  61391,
  20598,
  61392,
  20778,
  61393,
  21448,
  61394,
  21451,
  61395,
  21491,
  61396,
  23431,
  61397,
  23507,
  61398,
  23588,
  61399,
  24858,
  61400,
  24962,
  61401,
  26100,
  61402,
  29275,
  61403,
  29591,
  61404,
  29760,
  61405,
  30402,
  61406,
  31056,
  61407,
  31121,
  61408,
  31161,
  61409,
  32006,
  61410,
  32701,
  61411,
  33419,
  61412,
  34261,
  61413,
  34398,
  61414,
  36802,
  61415,
  36935,
  61416,
  37109,
  61417,
  37354,
  61418,
  38533,
  61419,
  38632,
  61420,
  38633,
  61421,
  21206,
  61422,
  24423,
  61423,
  26093,
  61424,
  26161,
  61425,
  26671,
  61426,
  29020,
  61427,
  31286,
  61428,
  37057,
  61429,
  38922,
  61430,
  20113,
  61431,
  63941,
  61432,
  27218,
  61433,
  27550,
  61434,
  28560,
  61435,
  29065,
  61436,
  32792,
  61437,
  33464,
  61438,
  34131,
  61489,
  36939,
  61490,
  38549,
  61491,
  38642,
  61492,
  38907,
  61493,
  34074,
  61494,
  39729,
  61495,
  20112,
  61496,
  29066,
  61497,
  38596,
  61498,
  20803,
  61499,
  21407,
  61500,
  21729,
  61501,
  22291,
  61502,
  22290,
  61503,
  22435,
  61504,
  23195,
  61505,
  23236,
  61506,
  23491,
  61507,
  24616,
  61508,
  24895,
  61509,
  25588,
  61510,
  27781,
  61511,
  27961,
  61512,
  28274,
  61513,
  28304,
  61514,
  29232,
  61515,
  29503,
  61516,
  29783,
  61517,
  33489,
  61518,
  34945,
  61519,
  36677,
  61520,
  36960,
  61521,
  63942,
  61522,
  38498,
  61523,
  39e3,
  61524,
  40219,
  61525,
  26376,
  61526,
  36234,
  61527,
  37470,
  61528,
  20301,
  61529,
  20553,
  61530,
  20702,
  61531,
  21361,
  61532,
  22285,
  61533,
  22996,
  61534,
  23041,
  61535,
  23561,
  61536,
  24944,
  61537,
  26256,
  61538,
  28205,
  61539,
  29234,
  61540,
  29771,
  61541,
  32239,
  61542,
  32963,
  61543,
  33806,
  61544,
  33894,
  61545,
  34111,
  61546,
  34655,
  61547,
  34907,
  61548,
  35096,
  61549,
  35586,
  61550,
  36949,
  61551,
  38859,
  61552,
  39759,
  61553,
  20083,
  61554,
  20369,
  61555,
  20754,
  61556,
  20842,
  61557,
  63943,
  61558,
  21807,
  61559,
  21929,
  61560,
  23418,
  61561,
  23461,
  61562,
  24188,
  61563,
  24189,
  61564,
  24254,
  61565,
  24736,
  61566,
  24799,
  61585,
  24840,
  61586,
  24841,
  61587,
  25540,
  61588,
  25912,
  61589,
  26377,
  61590,
  63944,
  61591,
  26580,
  61592,
  26586,
  61593,
  63945,
  61594,
  26977,
  61595,
  26978,
  61596,
  27833,
  61597,
  27943,
  61598,
  63946,
  61599,
  28216,
  61600,
  63947,
  61601,
  28641,
  61602,
  29494,
  61603,
  29495,
  61604,
  63948,
  61605,
  29788,
  61606,
  30001,
  61607,
  63949,
  61608,
  30290,
  61609,
  63950,
  61610,
  63951,
  61611,
  32173,
  61612,
  33278,
  61613,
  33848,
  61614,
  35029,
  61615,
  35480,
  61616,
  35547,
  61617,
  35565,
  61618,
  36400,
  61619,
  36418,
  61620,
  36938,
  61621,
  36926,
  61622,
  36986,
  61623,
  37193,
  61624,
  37321,
  61625,
  37742,
  61626,
  63952,
  61627,
  63953,
  61628,
  22537,
  61629,
  63954,
  61630,
  27603,
  61631,
  32905,
  61632,
  32946,
  61633,
  63955,
  61634,
  63956,
  61635,
  20801,
  61636,
  22891,
  61637,
  23609,
  61638,
  63957,
  61639,
  63958,
  61640,
  28516,
  61641,
  29607,
  61642,
  32996,
  61643,
  36103,
  61644,
  63959,
  61645,
  37399,
  61646,
  38287,
  61647,
  63960,
  61648,
  63961,
  61649,
  63962,
  61650,
  63963,
  61651,
  32895,
  61652,
  25102,
  61653,
  28700,
  61654,
  32104,
  61655,
  34701,
  61656,
  63964,
  61657,
  22432,
  61658,
  24681,
  61659,
  24903,
  61660,
  27575,
  61661,
  35518,
  61662,
  37504,
  61663,
  38577,
  61664,
  20057,
  61665,
  21535,
  61666,
  28139,
  61667,
  34093,
  61668,
  38512,
  61669,
  38899,
  61670,
  39150,
  61671,
  25558,
  61672,
  27875,
  61673,
  37009,
  61674,
  20957,
  61675,
  25033,
  61676,
  33210,
  61677,
  40441,
  61678,
  20381,
  61679,
  20506,
  61680,
  20736,
  61681,
  23452,
  61682,
  24847,
  61683,
  25087,
  61684,
  25836,
  61685,
  26885,
  61686,
  27589,
  61687,
  30097,
  61688,
  30691,
  61689,
  32681,
  61690,
  33380,
  61691,
  34191,
  61692,
  34811,
  61693,
  34915,
  61694,
  35516,
  61745,
  35696,
  61746,
  37291,
  61747,
  20108,
  61748,
  20197,
  61749,
  20234,
  61750,
  63965,
  61751,
  63966,
  61752,
  22839,
  61753,
  23016,
  61754,
  63967,
  61755,
  24050,
  61756,
  24347,
  61757,
  24411,
  61758,
  24609,
  61759,
  63968,
  61760,
  63969,
  61761,
  63970,
  61762,
  63971,
  61763,
  29246,
  61764,
  29669,
  61765,
  63972,
  61766,
  30064,
  61767,
  30157,
  61768,
  63973,
  61769,
  31227,
  61770,
  63974,
  61771,
  32780,
  61772,
  32819,
  61773,
  32900,
  61774,
  33505,
  61775,
  33617,
  61776,
  63975,
  61777,
  63976,
  61778,
  36029,
  61779,
  36019,
  61780,
  36999,
  61781,
  63977,
  61782,
  63978,
  61783,
  39156,
  61784,
  39180,
  61785,
  63979,
  61786,
  63980,
  61787,
  28727,
  61788,
  30410,
  61789,
  32714,
  61790,
  32716,
  61791,
  32764,
  61792,
  35610,
  61793,
  20154,
  61794,
  20161,
  61795,
  20995,
  61796,
  21360,
  61797,
  63981,
  61798,
  21693,
  61799,
  22240,
  61800,
  23035,
  61801,
  23493,
  61802,
  24341,
  61803,
  24525,
  61804,
  28270,
  61805,
  63982,
  61806,
  63983,
  61807,
  32106,
  61808,
  33589,
  61809,
  63984,
  61810,
  34451,
  61811,
  35469,
  61812,
  63985,
  61813,
  38765,
  61814,
  38775,
  61815,
  63986,
  61816,
  63987,
  61817,
  19968,
  61818,
  20314,
  61819,
  20350,
  61820,
  22777,
  61821,
  26085,
  61822,
  28322,
  61841,
  36920,
  61842,
  37808,
  61843,
  39353,
  61844,
  20219,
  61845,
  22764,
  61846,
  22922,
  61847,
  23001,
  61848,
  24641,
  61849,
  63988,
  61850,
  63989,
  61851,
  31252,
  61852,
  63990,
  61853,
  33615,
  61854,
  36035,
  61855,
  20837,
  61856,
  21316,
  61857,
  63991,
  61858,
  63992,
  61859,
  63993,
  61860,
  20173,
  61861,
  21097,
  61862,
  23381,
  61863,
  33471,
  61864,
  20180,
  61865,
  21050,
  61866,
  21672,
  61867,
  22985,
  61868,
  23039,
  61869,
  23376,
  61870,
  23383,
  61871,
  23388,
  61872,
  24675,
  61873,
  24904,
  61874,
  28363,
  61875,
  28825,
  61876,
  29038,
  61877,
  29574,
  61878,
  29943,
  61879,
  30133,
  61880,
  30913,
  61881,
  32043,
  61882,
  32773,
  61883,
  33258,
  61884,
  33576,
  61885,
  34071,
  61886,
  34249,
  61887,
  35566,
  61888,
  36039,
  61889,
  38604,
  61890,
  20316,
  61891,
  21242,
  61892,
  22204,
  61893,
  26027,
  61894,
  26152,
  61895,
  28796,
  61896,
  28856,
  61897,
  29237,
  61898,
  32189,
  61899,
  33421,
  61900,
  37196,
  61901,
  38592,
  61902,
  40306,
  61903,
  23409,
  61904,
  26855,
  61905,
  27544,
  61906,
  28538,
  61907,
  30430,
  61908,
  23697,
  61909,
  26283,
  61910,
  28507,
  61911,
  31668,
  61912,
  31786,
  61913,
  34870,
  61914,
  38620,
  61915,
  19976,
  61916,
  20183,
  61917,
  21280,
  61918,
  22580,
  61919,
  22715,
  61920,
  22767,
  61921,
  22892,
  61922,
  23559,
  61923,
  24115,
  61924,
  24196,
  61925,
  24373,
  61926,
  25484,
  61927,
  26290,
  61928,
  26454,
  61929,
  27167,
  61930,
  27299,
  61931,
  27404,
  61932,
  28479,
  61933,
  29254,
  61934,
  63994,
  61935,
  29520,
  61936,
  29835,
  61937,
  31456,
  61938,
  31911,
  61939,
  33144,
  61940,
  33247,
  61941,
  33255,
  61942,
  33674,
  61943,
  33900,
  61944,
  34083,
  61945,
  34196,
  61946,
  34255,
  61947,
  35037,
  61948,
  36115,
  61949,
  37292,
  61950,
  38263,
  62001,
  38556,
  62002,
  20877,
  62003,
  21705,
  62004,
  22312,
  62005,
  23472,
  62006,
  25165,
  62007,
  26448,
  62008,
  26685,
  62009,
  26771,
  62010,
  28221,
  62011,
  28371,
  62012,
  28797,
  62013,
  32289,
  62014,
  35009,
  62015,
  36001,
  62016,
  36617,
  62017,
  40779,
  62018,
  40782,
  62019,
  29229,
  62020,
  31631,
  62021,
  35533,
  62022,
  37658,
  62023,
  20295,
  62024,
  20302,
  62025,
  20786,
  62026,
  21632,
  62027,
  22992,
  62028,
  24213,
  62029,
  25269,
  62030,
  26485,
  62031,
  26990,
  62032,
  27159,
  62033,
  27822,
  62034,
  28186,
  62035,
  29401,
  62036,
  29482,
  62037,
  30141,
  62038,
  31672,
  62039,
  32053,
  62040,
  33511,
  62041,
  33785,
  62042,
  33879,
  62043,
  34295,
  62044,
  35419,
  62045,
  36015,
  62046,
  36487,
  62047,
  36889,
  62048,
  37048,
  62049,
  38606,
  62050,
  40799,
  62051,
  21219,
  62052,
  21514,
  62053,
  23265,
  62054,
  23490,
  62055,
  25688,
  62056,
  25973,
  62057,
  28404,
  62058,
  29380,
  62059,
  63995,
  62060,
  30340,
  62061,
  31309,
  62062,
  31515,
  62063,
  31821,
  62064,
  32318,
  62065,
  32735,
  62066,
  33659,
  62067,
  35627,
  62068,
  36042,
  62069,
  36196,
  62070,
  36321,
  62071,
  36447,
  62072,
  36842,
  62073,
  36857,
  62074,
  36969,
  62075,
  37841,
  62076,
  20291,
  62077,
  20346,
  62078,
  20659,
  62097,
  20840,
  62098,
  20856,
  62099,
  21069,
  62100,
  21098,
  62101,
  22625,
  62102,
  22652,
  62103,
  22880,
  62104,
  23560,
  62105,
  23637,
  62106,
  24283,
  62107,
  24731,
  62108,
  25136,
  62109,
  26643,
  62110,
  27583,
  62111,
  27656,
  62112,
  28593,
  62113,
  29006,
  62114,
  29728,
  62115,
  3e4,
  62116,
  30008,
  62117,
  30033,
  62118,
  30322,
  62119,
  31564,
  62120,
  31627,
  62121,
  31661,
  62122,
  31686,
  62123,
  32399,
  62124,
  35438,
  62125,
  36670,
  62126,
  36681,
  62127,
  37439,
  62128,
  37523,
  62129,
  37666,
  62130,
  37931,
  62131,
  38651,
  62132,
  39002,
  62133,
  39019,
  62134,
  39198,
  62135,
  20999,
  62136,
  25130,
  62137,
  25240,
  62138,
  27993,
  62139,
  30308,
  62140,
  31434,
  62141,
  31680,
  62142,
  32118,
  62143,
  21344,
  62144,
  23742,
  62145,
  24215,
  62146,
  28472,
  62147,
  28857,
  62148,
  31896,
  62149,
  38673,
  62150,
  39822,
  62151,
  40670,
  62152,
  25509,
  62153,
  25722,
  62154,
  34678,
  62155,
  19969,
  62156,
  20117,
  62157,
  20141,
  62158,
  20572,
  62159,
  20597,
  62160,
  21576,
  62161,
  22979,
  62162,
  23450,
  62163,
  24128,
  62164,
  24237,
  62165,
  24311,
  62166,
  24449,
  62167,
  24773,
  62168,
  25402,
  62169,
  25919,
  62170,
  25972,
  62171,
  26060,
  62172,
  26230,
  62173,
  26232,
  62174,
  26622,
  62175,
  26984,
  62176,
  27273,
  62177,
  27491,
  62178,
  27712,
  62179,
  28096,
  62180,
  28136,
  62181,
  28191,
  62182,
  28254,
  62183,
  28702,
  62184,
  28833,
  62185,
  29582,
  62186,
  29693,
  62187,
  30010,
  62188,
  30555,
  62189,
  30855,
  62190,
  31118,
  62191,
  31243,
  62192,
  31357,
  62193,
  31934,
  62194,
  32142,
  62195,
  33351,
  62196,
  35330,
  62197,
  35562,
  62198,
  35998,
  62199,
  37165,
  62200,
  37194,
  62201,
  37336,
  62202,
  37478,
  62203,
  37580,
  62204,
  37664,
  62205,
  38662,
  62206,
  38742,
  62257,
  38748,
  62258,
  38914,
  62259,
  40718,
  62260,
  21046,
  62261,
  21137,
  62262,
  21884,
  62263,
  22564,
  62264,
  24093,
  62265,
  24351,
  62266,
  24716,
  62267,
  25552,
  62268,
  26799,
  62269,
  28639,
  62270,
  31085,
  62271,
  31532,
  62272,
  33229,
  62273,
  34234,
  62274,
  35069,
  62275,
  35576,
  62276,
  36420,
  62277,
  37261,
  62278,
  38500,
  62279,
  38555,
  62280,
  38717,
  62281,
  38988,
  62282,
  40778,
  62283,
  20430,
  62284,
  20806,
  62285,
  20939,
  62286,
  21161,
  62287,
  22066,
  62288,
  24340,
  62289,
  24427,
  62290,
  25514,
  62291,
  25805,
  62292,
  26089,
  62293,
  26177,
  62294,
  26362,
  62295,
  26361,
  62296,
  26397,
  62297,
  26781,
  62298,
  26839,
  62299,
  27133,
  62300,
  28437,
  62301,
  28526,
  62302,
  29031,
  62303,
  29157,
  62304,
  29226,
  62305,
  29866,
  62306,
  30522,
  62307,
  31062,
  62308,
  31066,
  62309,
  31199,
  62310,
  31264,
  62311,
  31381,
  62312,
  31895,
  62313,
  31967,
  62314,
  32068,
  62315,
  32368,
  62316,
  32903,
  62317,
  34299,
  62318,
  34468,
  62319,
  35412,
  62320,
  35519,
  62321,
  36249,
  62322,
  36481,
  62323,
  36896,
  62324,
  36973,
  62325,
  37347,
  62326,
  38459,
  62327,
  38613,
  62328,
  40165,
  62329,
  26063,
  62330,
  31751,
  62331,
  36275,
  62332,
  37827,
  62333,
  23384,
  62334,
  23562,
  62353,
  21330,
  62354,
  25305,
  62355,
  29469,
  62356,
  20519,
  62357,
  23447,
  62358,
  24478,
  62359,
  24752,
  62360,
  24939,
  62361,
  26837,
  62362,
  28121,
  62363,
  29742,
  62364,
  31278,
  62365,
  32066,
  62366,
  32156,
  62367,
  32305,
  62368,
  33131,
  62369,
  36394,
  62370,
  36405,
  62371,
  37758,
  62372,
  37912,
  62373,
  20304,
  62374,
  22352,
  62375,
  24038,
  62376,
  24231,
  62377,
  25387,
  62378,
  32618,
  62379,
  20027,
  62380,
  20303,
  62381,
  20367,
  62382,
  20570,
  62383,
  23005,
  62384,
  32964,
  62385,
  21610,
  62386,
  21608,
  62387,
  22014,
  62388,
  22863,
  62389,
  23449,
  62390,
  24030,
  62391,
  24282,
  62392,
  26205,
  62393,
  26417,
  62394,
  26609,
  62395,
  26666,
  62396,
  27880,
  62397,
  27954,
  62398,
  28234,
  62399,
  28557,
  62400,
  28855,
  62401,
  29664,
  62402,
  30087,
  62403,
  31820,
  62404,
  32002,
  62405,
  32044,
  62406,
  32162,
  62407,
  33311,
  62408,
  34523,
  62409,
  35387,
  62410,
  35461,
  62411,
  36208,
  62412,
  36490,
  62413,
  36659,
  62414,
  36913,
  62415,
  37198,
  62416,
  37202,
  62417,
  37956,
  62418,
  39376,
  62419,
  31481,
  62420,
  31909,
  62421,
  20426,
  62422,
  20737,
  62423,
  20934,
  62424,
  22472,
  62425,
  23535,
  62426,
  23803,
  62427,
  26201,
  62428,
  27197,
  62429,
  27994,
  62430,
  28310,
  62431,
  28652,
  62432,
  28940,
  62433,
  30063,
  62434,
  31459,
  62435,
  34850,
  62436,
  36897,
  62437,
  36981,
  62438,
  38603,
  62439,
  39423,
  62440,
  33537,
  62441,
  20013,
  62442,
  20210,
  62443,
  34886,
  62444,
  37325,
  62445,
  21373,
  62446,
  27355,
  62447,
  26987,
  62448,
  27713,
  62449,
  33914,
  62450,
  22686,
  62451,
  24974,
  62452,
  26366,
  62453,
  25327,
  62454,
  28893,
  62455,
  29969,
  62456,
  30151,
  62457,
  32338,
  62458,
  33976,
  62459,
  35657,
  62460,
  36104,
  62461,
  20043,
  62462,
  21482,
  62513,
  21675,
  62514,
  22320,
  62515,
  22336,
  62516,
  24535,
  62517,
  25345,
  62518,
  25351,
  62519,
  25711,
  62520,
  25903,
  62521,
  26088,
  62522,
  26234,
  62523,
  26525,
  62524,
  26547,
  62525,
  27490,
  62526,
  27744,
  62527,
  27802,
  62528,
  28460,
  62529,
  30693,
  62530,
  30757,
  62531,
  31049,
  62532,
  31063,
  62533,
  32025,
  62534,
  32930,
  62535,
  33026,
  62536,
  33267,
  62537,
  33437,
  62538,
  33463,
  62539,
  34584,
  62540,
  35468,
  62541,
  63996,
  62542,
  36100,
  62543,
  36286,
  62544,
  36978,
  62545,
  30452,
  62546,
  31257,
  62547,
  31287,
  62548,
  32340,
  62549,
  32887,
  62550,
  21767,
  62551,
  21972,
  62552,
  22645,
  62553,
  25391,
  62554,
  25634,
  62555,
  26185,
  62556,
  26187,
  62557,
  26733,
  62558,
  27035,
  62559,
  27524,
  62560,
  27941,
  62561,
  28337,
  62562,
  29645,
  62563,
  29800,
  62564,
  29857,
  62565,
  30043,
  62566,
  30137,
  62567,
  30433,
  62568,
  30494,
  62569,
  30603,
  62570,
  31206,
  62571,
  32265,
  62572,
  32285,
  62573,
  33275,
  62574,
  34095,
  62575,
  34967,
  62576,
  35386,
  62577,
  36049,
  62578,
  36587,
  62579,
  36784,
  62580,
  36914,
  62581,
  37805,
  62582,
  38499,
  62583,
  38515,
  62584,
  38663,
  62585,
  20356,
  62586,
  21489,
  62587,
  23018,
  62588,
  23241,
  62589,
  24089,
  62590,
  26702,
  62609,
  29894,
  62610,
  30142,
  62611,
  31209,
  62612,
  31378,
  62613,
  33187,
  62614,
  34541,
  62615,
  36074,
  62616,
  36300,
  62617,
  36845,
  62618,
  26015,
  62619,
  26389,
  62620,
  63997,
  62621,
  22519,
  62622,
  28503,
  62623,
  32221,
  62624,
  36655,
  62625,
  37878,
  62626,
  38598,
  62627,
  24501,
  62628,
  25074,
  62629,
  28548,
  62630,
  19988,
  62631,
  20376,
  62632,
  20511,
  62633,
  21449,
  62634,
  21983,
  62635,
  23919,
  62636,
  24046,
  62637,
  27425,
  62638,
  27492,
  62639,
  30923,
  62640,
  31642,
  62641,
  63998,
  62642,
  36425,
  62643,
  36554,
  62644,
  36974,
  62645,
  25417,
  62646,
  25662,
  62647,
  30528,
  62648,
  31364,
  62649,
  37679,
  62650,
  38015,
  62651,
  40810,
  62652,
  25776,
  62653,
  28591,
  62654,
  29158,
  62655,
  29864,
  62656,
  29914,
  62657,
  31428,
  62658,
  31762,
  62659,
  32386,
  62660,
  31922,
  62661,
  32408,
  62662,
  35738,
  62663,
  36106,
  62664,
  38013,
  62665,
  39184,
  62666,
  39244,
  62667,
  21049,
  62668,
  23519,
  62669,
  25830,
  62670,
  26413,
  62671,
  32046,
  62672,
  20717,
  62673,
  21443,
  62674,
  22649,
  62675,
  24920,
  62676,
  24921,
  62677,
  25082,
  62678,
  26028,
  62679,
  31449,
  62680,
  35730,
  62681,
  35734,
  62682,
  20489,
  62683,
  20513,
  62684,
  21109,
  62685,
  21809,
  62686,
  23100,
  62687,
  24288,
  62688,
  24432,
  62689,
  24884,
  62690,
  25950,
  62691,
  26124,
  62692,
  26166,
  62693,
  26274,
  62694,
  27085,
  62695,
  28356,
  62696,
  28466,
  62697,
  29462,
  62698,
  30241,
  62699,
  31379,
  62700,
  33081,
  62701,
  33369,
  62702,
  33750,
  62703,
  33980,
  62704,
  20661,
  62705,
  22512,
  62706,
  23488,
  62707,
  23528,
  62708,
  24425,
  62709,
  25505,
  62710,
  30758,
  62711,
  32181,
  62712,
  33756,
  62713,
  34081,
  62714,
  37319,
  62715,
  37365,
  62716,
  20874,
  62717,
  26613,
  62718,
  31574,
  62769,
  36012,
  62770,
  20932,
  62771,
  22971,
  62772,
  24765,
  62773,
  34389,
  62774,
  20508,
  62775,
  63999,
  62776,
  21076,
  62777,
  23610,
  62778,
  24957,
  62779,
  25114,
  62780,
  25299,
  62781,
  25842,
  62782,
  26021,
  62783,
  28364,
  62784,
  30240,
  62785,
  33034,
  62786,
  36448,
  62787,
  38495,
  62788,
  38587,
  62789,
  20191,
  62790,
  21315,
  62791,
  21912,
  62792,
  22825,
  62793,
  24029,
  62794,
  25797,
  62795,
  27849,
  62796,
  28154,
  62797,
  29588,
  62798,
  31359,
  62799,
  33307,
  62800,
  34214,
  62801,
  36068,
  62802,
  36368,
  62803,
  36983,
  62804,
  37351,
  62805,
  38369,
  62806,
  38433,
  62807,
  38854,
  62808,
  20984,
  62809,
  21746,
  62810,
  21894,
  62811,
  24505,
  62812,
  25764,
  62813,
  28552,
  62814,
  32180,
  62815,
  36639,
  62816,
  36685,
  62817,
  37941,
  62818,
  20681,
  62819,
  23574,
  62820,
  27838,
  62821,
  28155,
  62822,
  29979,
  62823,
  30651,
  62824,
  31805,
  62825,
  31844,
  62826,
  35449,
  62827,
  35522,
  62828,
  22558,
  62829,
  22974,
  62830,
  24086,
  62831,
  25463,
  62832,
  29266,
  62833,
  30090,
  62834,
  30571,
  62835,
  35548,
  62836,
  36028,
  62837,
  36626,
  62838,
  24307,
  62839,
  26228,
  62840,
  28152,
  62841,
  32893,
  62842,
  33729,
  62843,
  35531,
  62844,
  38737,
  62845,
  39894,
  62846,
  64e3,
  62865,
  21059,
  62866,
  26367,
  62867,
  28053,
  62868,
  28399,
  62869,
  32224,
  62870,
  35558,
  62871,
  36910,
  62872,
  36958,
  62873,
  39636,
  62874,
  21021,
  62875,
  21119,
  62876,
  21736,
  62877,
  24980,
  62878,
  25220,
  62879,
  25307,
  62880,
  26786,
  62881,
  26898,
  62882,
  26970,
  62883,
  27189,
  62884,
  28818,
  62885,
  28966,
  62886,
  30813,
  62887,
  30977,
  62888,
  30990,
  62889,
  31186,
  62890,
  31245,
  62891,
  32918,
  62892,
  33400,
  62893,
  33493,
  62894,
  33609,
  62895,
  34121,
  62896,
  35970,
  62897,
  36229,
  62898,
  37218,
  62899,
  37259,
  62900,
  37294,
  62901,
  20419,
  62902,
  22225,
  62903,
  29165,
  62904,
  30679,
  62905,
  34560,
  62906,
  35320,
  62907,
  23544,
  62908,
  24534,
  62909,
  26449,
  62910,
  37032,
  62911,
  21474,
  62912,
  22618,
  62913,
  23541,
  62914,
  24740,
  62915,
  24961,
  62916,
  25696,
  62917,
  32317,
  62918,
  32880,
  62919,
  34085,
  62920,
  37507,
  62921,
  25774,
  62922,
  20652,
  62923,
  23828,
  62924,
  26368,
  62925,
  22684,
  62926,
  25277,
  62927,
  25512,
  62928,
  26894,
  62929,
  27e3,
  62930,
  27166,
  62931,
  28267,
  62932,
  30394,
  62933,
  31179,
  62934,
  33467,
  62935,
  33833,
  62936,
  35535,
  62937,
  36264,
  62938,
  36861,
  62939,
  37138,
  62940,
  37195,
  62941,
  37276,
  62942,
  37648,
  62943,
  37656,
  62944,
  37786,
  62945,
  38619,
  62946,
  39478,
  62947,
  39949,
  62948,
  19985,
  62949,
  30044,
  62950,
  31069,
  62951,
  31482,
  62952,
  31569,
  62953,
  31689,
  62954,
  32302,
  62955,
  33988,
  62956,
  36441,
  62957,
  36468,
  62958,
  36600,
  62959,
  36880,
  62960,
  26149,
  62961,
  26943,
  62962,
  29763,
  62963,
  20986,
  62964,
  26414,
  62965,
  40668,
  62966,
  20805,
  62967,
  24544,
  62968,
  27798,
  62969,
  34802,
  62970,
  34909,
  62971,
  34935,
  62972,
  24756,
  62973,
  33205,
  62974,
  33795,
  63025,
  36101,
  63026,
  21462,
  63027,
  21561,
  63028,
  22068,
  63029,
  23094,
  63030,
  23601,
  63031,
  28810,
  63032,
  32736,
  63033,
  32858,
  63034,
  33030,
  63035,
  33261,
  63036,
  36259,
  63037,
  37257,
  63038,
  39519,
  63039,
  40434,
  63040,
  20596,
  63041,
  20164,
  63042,
  21408,
  63043,
  24827,
  63044,
  28204,
  63045,
  23652,
  63046,
  20360,
  63047,
  20516,
  63048,
  21988,
  63049,
  23769,
  63050,
  24159,
  63051,
  24677,
  63052,
  26772,
  63053,
  27835,
  63054,
  28100,
  63055,
  29118,
  63056,
  30164,
  63057,
  30196,
  63058,
  30305,
  63059,
  31258,
  63060,
  31305,
  63061,
  32199,
  63062,
  32251,
  63063,
  32622,
  63064,
  33268,
  63065,
  34473,
  63066,
  36636,
  63067,
  38601,
  63068,
  39347,
  63069,
  40786,
  63070,
  21063,
  63071,
  21189,
  63072,
  39149,
  63073,
  35242,
  63074,
  19971,
  63075,
  26578,
  63076,
  28422,
  63077,
  20405,
  63078,
  23522,
  63079,
  26517,
  63080,
  27784,
  63081,
  28024,
  63082,
  29723,
  63083,
  30759,
  63084,
  37341,
  63085,
  37756,
  63086,
  34756,
  63087,
  31204,
  63088,
  31281,
  63089,
  24555,
  63090,
  20182,
  63091,
  21668,
  63092,
  21822,
  63093,
  22702,
  63094,
  22949,
  63095,
  24816,
  63096,
  25171,
  63097,
  25302,
  63098,
  26422,
  63099,
  26965,
  63100,
  33333,
  63101,
  38464,
  63102,
  39345,
  63121,
  39389,
  63122,
  20524,
  63123,
  21331,
  63124,
  21828,
  63125,
  22396,
  63126,
  64001,
  63127,
  25176,
  63128,
  64002,
  63129,
  25826,
  63130,
  26219,
  63131,
  26589,
  63132,
  28609,
  63133,
  28655,
  63134,
  29730,
  63135,
  29752,
  63136,
  35351,
  63137,
  37944,
  63138,
  21585,
  63139,
  22022,
  63140,
  22374,
  63141,
  24392,
  63142,
  24986,
  63143,
  27470,
  63144,
  28760,
  63145,
  28845,
  63146,
  32187,
  63147,
  35477,
  63148,
  22890,
  63149,
  33067,
  63150,
  25506,
  63151,
  30472,
  63152,
  32829,
  63153,
  36010,
  63154,
  22612,
  63155,
  25645,
  63156,
  27067,
  63157,
  23445,
  63158,
  24081,
  63159,
  28271,
  63160,
  64003,
  63161,
  34153,
  63162,
  20812,
  63163,
  21488,
  63164,
  22826,
  63165,
  24608,
  63166,
  24907,
  63167,
  27526,
  63168,
  27760,
  63169,
  27888,
  63170,
  31518,
  63171,
  32974,
  63172,
  33492,
  63173,
  36294,
  63174,
  37040,
  63175,
  39089,
  63176,
  64004,
  63177,
  25799,
  63178,
  28580,
  63179,
  25745,
  63180,
  25860,
  63181,
  20814,
  63182,
  21520,
  63183,
  22303,
  63184,
  35342,
  63185,
  24927,
  63186,
  26742,
  63187,
  64005,
  63188,
  30171,
  63189,
  31570,
  63190,
  32113,
  63191,
  36890,
  63192,
  22534,
  63193,
  27084,
  63194,
  33151,
  63195,
  35114,
  63196,
  36864,
  63197,
  38969,
  63198,
  20600,
  63199,
  22871,
  63200,
  22956,
  63201,
  25237,
  63202,
  36879,
  63203,
  39722,
  63204,
  24925,
  63205,
  29305,
  63206,
  38358,
  63207,
  22369,
  63208,
  23110,
  63209,
  24052,
  63210,
  25226,
  63211,
  25773,
  63212,
  25850,
  63213,
  26487,
  63214,
  27874,
  63215,
  27966,
  63216,
  29228,
  63217,
  29750,
  63218,
  30772,
  63219,
  32631,
  63220,
  33453,
  63221,
  36315,
  63222,
  38935,
  63223,
  21028,
  63224,
  22338,
  63225,
  26495,
  63226,
  29256,
  63227,
  29923,
  63228,
  36009,
  63229,
  36774,
  63230,
  37393,
  63281,
  38442,
  63282,
  20843,
  63283,
  21485,
  63284,
  25420,
  63285,
  20329,
  63286,
  21764,
  63287,
  24726,
  63288,
  25943,
  63289,
  27803,
  63290,
  28031,
  63291,
  29260,
  63292,
  29437,
  63293,
  31255,
  63294,
  35207,
  63295,
  35997,
  63296,
  24429,
  63297,
  28558,
  63298,
  28921,
  63299,
  33192,
  63300,
  24846,
  63301,
  20415,
  63302,
  20559,
  63303,
  25153,
  63304,
  29255,
  63305,
  31687,
  63306,
  32232,
  63307,
  32745,
  63308,
  36941,
  63309,
  38829,
  63310,
  39449,
  63311,
  36022,
  63312,
  22378,
  63313,
  24179,
  63314,
  26544,
  63315,
  33805,
  63316,
  35413,
  63317,
  21536,
  63318,
  23318,
  63319,
  24163,
  63320,
  24290,
  63321,
  24330,
  63322,
  25987,
  63323,
  32954,
  63324,
  34109,
  63325,
  38281,
  63326,
  38491,
  63327,
  20296,
  63328,
  21253,
  63329,
  21261,
  63330,
  21263,
  63331,
  21638,
  63332,
  21754,
  63333,
  22275,
  63334,
  24067,
  63335,
  24598,
  63336,
  25243,
  63337,
  25265,
  63338,
  25429,
  63339,
  64006,
  63340,
  27873,
  63341,
  28006,
  63342,
  30129,
  63343,
  30770,
  63344,
  32990,
  63345,
  33071,
  63346,
  33502,
  63347,
  33889,
  63348,
  33970,
  63349,
  34957,
  63350,
  35090,
  63351,
  36875,
  63352,
  37610,
  63353,
  39165,
  63354,
  39825,
  63355,
  24133,
  63356,
  26292,
  63357,
  26333,
  63358,
  28689,
  63377,
  29190,
  63378,
  64007,
  63379,
  20469,
  63380,
  21117,
  63381,
  24426,
  63382,
  24915,
  63383,
  26451,
  63384,
  27161,
  63385,
  28418,
  63386,
  29922,
  63387,
  31080,
  63388,
  34920,
  63389,
  35961,
  63390,
  39111,
  63391,
  39108,
  63392,
  39491,
  63393,
  21697,
  63394,
  31263,
  63395,
  26963,
  63396,
  35575,
  63397,
  35914,
  63398,
  39080,
  63399,
  39342,
  63400,
  24444,
  63401,
  25259,
  63402,
  30130,
  63403,
  30382,
  63404,
  34987,
  63405,
  36991,
  63406,
  38466,
  63407,
  21305,
  63408,
  24380,
  63409,
  24517,
  63410,
  27852,
  63411,
  29644,
  63412,
  30050,
  63413,
  30091,
  63414,
  31558,
  63415,
  33534,
  63416,
  39325,
  63417,
  20047,
  63418,
  36924,
  63419,
  19979,
  63420,
  20309,
  63421,
  21414,
  63422,
  22799,
  63423,
  24264,
  63424,
  26160,
  63425,
  27827,
  63426,
  29781,
  63427,
  33655,
  63428,
  34662,
  63429,
  36032,
  63430,
  36944,
  63431,
  38686,
  63432,
  39957,
  63433,
  22737,
  63434,
  23416,
  63435,
  34384,
  63436,
  35604,
  63437,
  40372,
  63438,
  23506,
  63439,
  24680,
  63440,
  24717,
  63441,
  26097,
  63442,
  27735,
  63443,
  28450,
  63444,
  28579,
  63445,
  28698,
  63446,
  32597,
  63447,
  32752,
  63448,
  38289,
  63449,
  38290,
  63450,
  38480,
  63451,
  38867,
  63452,
  21106,
  63453,
  36676,
  63454,
  20989,
  63455,
  21547,
  63456,
  21688,
  63457,
  21859,
  63458,
  21898,
  63459,
  27323,
  63460,
  28085,
  63461,
  32216,
  63462,
  33382,
  63463,
  37532,
  63464,
  38519,
  63465,
  40569,
  63466,
  21512,
  63467,
  21704,
  63468,
  30418,
  63469,
  34532,
  63470,
  38308,
  63471,
  38356,
  63472,
  38492,
  63473,
  20130,
  63474,
  20233,
  63475,
  23022,
  63476,
  23270,
  63477,
  24055,
  63478,
  24658,
  63479,
  25239,
  63480,
  26477,
  63481,
  26689,
  63482,
  27782,
  63483,
  28207,
  63484,
  32568,
  63485,
  32923,
  63486,
  33322,
  63537,
  64008,
  63538,
  64009,
  63539,
  38917,
  63540,
  20133,
  63541,
  20565,
  63542,
  21683,
  63543,
  22419,
  63544,
  22874,
  63545,
  23401,
  63546,
  23475,
  63547,
  25032,
  63548,
  26999,
  63549,
  28023,
  63550,
  28707,
  63551,
  34809,
  63552,
  35299,
  63553,
  35442,
  63554,
  35559,
  63555,
  36994,
  63556,
  39405,
  63557,
  39608,
  63558,
  21182,
  63559,
  26680,
  63560,
  20502,
  63561,
  24184,
  63562,
  26447,
  63563,
  33607,
  63564,
  34892,
  63565,
  20139,
  63566,
  21521,
  63567,
  22190,
  63568,
  29670,
  63569,
  37141,
  63570,
  38911,
  63571,
  39177,
  63572,
  39255,
  63573,
  39321,
  63574,
  22099,
  63575,
  22687,
  63576,
  34395,
  63577,
  35377,
  63578,
  25010,
  63579,
  27382,
  63580,
  29563,
  63581,
  36562,
  63582,
  27463,
  63583,
  38570,
  63584,
  39511,
  63585,
  22869,
  63586,
  29184,
  63587,
  36203,
  63588,
  38761,
  63589,
  20436,
  63590,
  23796,
  63591,
  24358,
  63592,
  25080,
  63593,
  26203,
  63594,
  27883,
  63595,
  28843,
  63596,
  29572,
  63597,
  29625,
  63598,
  29694,
  63599,
  30505,
  63600,
  30541,
  63601,
  32067,
  63602,
  32098,
  63603,
  32291,
  63604,
  33335,
  63605,
  34898,
  63606,
  64010,
  63607,
  36066,
  63608,
  37449,
  63609,
  39023,
  63610,
  23377,
  63611,
  31348,
  63612,
  34880,
  63613,
  38913,
  63614,
  23244,
  63633,
  20448,
  63634,
  21332,
  63635,
  22846,
  63636,
  23805,
  63637,
  25406,
  63638,
  28025,
  63639,
  29433,
  63640,
  33029,
  63641,
  33031,
  63642,
  33698,
  63643,
  37583,
  63644,
  38960,
  63645,
  20136,
  63646,
  20804,
  63647,
  21009,
  63648,
  22411,
  63649,
  24418,
  63650,
  27842,
  63651,
  28366,
  63652,
  28677,
  63653,
  28752,
  63654,
  28847,
  63655,
  29074,
  63656,
  29673,
  63657,
  29801,
  63658,
  33610,
  63659,
  34722,
  63660,
  34913,
  63661,
  36872,
  63662,
  37026,
  63663,
  37795,
  63664,
  39336,
  63665,
  20846,
  63666,
  24407,
  63667,
  24800,
  63668,
  24935,
  63669,
  26291,
  63670,
  34137,
  63671,
  36426,
  63672,
  37295,
  63673,
  38795,
  63674,
  20046,
  63675,
  20114,
  63676,
  21628,
  63677,
  22741,
  63678,
  22778,
  63679,
  22909,
  63680,
  23733,
  63681,
  24359,
  63682,
  25142,
  63683,
  25160,
  63684,
  26122,
  63685,
  26215,
  63686,
  27627,
  63687,
  28009,
  63688,
  28111,
  63689,
  28246,
  63690,
  28408,
  63691,
  28564,
  63692,
  28640,
  63693,
  28649,
  63694,
  28765,
  63695,
  29392,
  63696,
  29733,
  63697,
  29786,
  63698,
  29920,
  63699,
  30355,
  63700,
  31068,
  63701,
  31946,
  63702,
  32286,
  63703,
  32993,
  63704,
  33446,
  63705,
  33899,
  63706,
  33983,
  63707,
  34382,
  63708,
  34399,
  63709,
  34676,
  63710,
  35703,
  63711,
  35946,
  63712,
  37804,
  63713,
  38912,
  63714,
  39013,
  63715,
  24785,
  63716,
  25110,
  63717,
  37239,
  63718,
  23130,
  63719,
  26127,
  63720,
  28151,
  63721,
  28222,
  63722,
  29759,
  63723,
  39746,
  63724,
  24573,
  63725,
  24794,
  63726,
  31503,
  63727,
  21700,
  63728,
  24344,
  63729,
  27742,
  63730,
  27859,
  63731,
  27946,
  63732,
  28888,
  63733,
  32005,
  63734,
  34425,
  63735,
  35340,
  63736,
  40251,
  63737,
  21270,
  63738,
  21644,
  63739,
  23301,
  63740,
  27194,
  63741,
  28779,
  63742,
  30069,
  63793,
  31117,
  63794,
  31166,
  63795,
  33457,
  63796,
  33775,
  63797,
  35441,
  63798,
  35649,
  63799,
  36008,
  63800,
  38772,
  63801,
  64011,
  63802,
  25844,
  63803,
  25899,
  63804,
  30906,
  63805,
  30907,
  63806,
  31339,
  63807,
  20024,
  63808,
  21914,
  63809,
  22864,
  63810,
  23462,
  63811,
  24187,
  63812,
  24739,
  63813,
  25563,
  63814,
  27489,
  63815,
  26213,
  63816,
  26707,
  63817,
  28185,
  63818,
  29029,
  63819,
  29872,
  63820,
  32008,
  63821,
  36996,
  63822,
  39529,
  63823,
  39973,
  63824,
  27963,
  63825,
  28369,
  63826,
  29502,
  63827,
  35905,
  63828,
  38346,
  63829,
  20976,
  63830,
  24140,
  63831,
  24488,
  63832,
  24653,
  63833,
  24822,
  63834,
  24880,
  63835,
  24908,
  63836,
  26179,
  63837,
  26180,
  63838,
  27045,
  63839,
  27841,
  63840,
  28255,
  63841,
  28361,
  63842,
  28514,
  63843,
  29004,
  63844,
  29852,
  63845,
  30343,
  63846,
  31681,
  63847,
  31783,
  63848,
  33618,
  63849,
  34647,
  63850,
  36945,
  63851,
  38541,
  63852,
  40643,
  63853,
  21295,
  63854,
  22238,
  63855,
  24315,
  63856,
  24458,
  63857,
  24674,
  63858,
  24724,
  63859,
  25079,
  63860,
  26214,
  63861,
  26371,
  63862,
  27292,
  63863,
  28142,
  63864,
  28590,
  63865,
  28784,
  63866,
  29546,
  63867,
  32362,
  63868,
  33214,
  63869,
  33588,
  63870,
  34516,
  63889,
  35496,
  63890,
  36036,
  63891,
  21123,
  63892,
  29554,
  63893,
  23446,
  63894,
  27243,
  63895,
  37892,
  63896,
  21742,
  63897,
  22150,
  63898,
  23389,
  63899,
  25928,
  63900,
  25989,
  63901,
  26313,
  63902,
  26783,
  63903,
  28045,
  63904,
  28102,
  63905,
  29243,
  63906,
  32948,
  63907,
  37237,
  63908,
  39501,
  63909,
  20399,
  63910,
  20505,
  63911,
  21402,
  63912,
  21518,
  63913,
  21564,
  63914,
  21897,
  63915,
  21957,
  63916,
  24127,
  63917,
  24460,
  63918,
  26429,
  63919,
  29030,
  63920,
  29661,
  63921,
  36869,
  63922,
  21211,
  63923,
  21235,
  63924,
  22628,
  63925,
  22734,
  63926,
  28932,
  63927,
  29071,
  63928,
  29179,
  63929,
  34224,
  63930,
  35347,
  63931,
  26248,
  63932,
  34216,
  63933,
  21927,
  63934,
  26244,
  63935,
  29002,
  63936,
  33841,
  63937,
  21321,
  63938,
  21913,
  63939,
  27585,
  63940,
  24409,
  63941,
  24509,
  63942,
  25582,
  63943,
  26249,
  63944,
  28999,
  63945,
  35569,
  63946,
  36637,
  63947,
  40638,
  63948,
  20241,
  63949,
  25658,
  63950,
  28875,
  63951,
  30054,
  63952,
  34407,
  63953,
  24676,
  63954,
  35662,
  63955,
  40440,
  63956,
  20807,
  63957,
  20982,
  63958,
  21256,
  63959,
  27958,
  63960,
  33016,
  63961,
  40657,
  63962,
  26133,
  63963,
  27427,
  63964,
  28824,
  63965,
  30165,
  63966,
  21507,
  63967,
  23673,
  63968,
  32007,
  63969,
  35350,
  63970,
  27424,
  63971,
  27453,
  63972,
  27462,
  63973,
  21560,
  63974,
  24688,
  63975,
  27965,
  63976,
  32725,
  63977,
  33288,
  63978,
  20694,
  63979,
  20958,
  63980,
  21916,
  63981,
  22123,
  63982,
  22221,
  63983,
  23020,
  63984,
  23305,
  63985,
  24076,
  63986,
  24985,
  63987,
  24984,
  63988,
  25137,
  63989,
  26206,
  63990,
  26342,
  63991,
  29081,
  63992,
  29113,
  63993,
  29114,
  63994,
  29351,
  63995,
  31143,
  63996,
  31232,
  63997,
  32690,
  63998,
  35440
]);

// src/hwp3/johab.ts
var CHO_MAP = Object.freeze([
  -1,
  -1,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1
]);
var JUNG_MAP = Object.freeze([
  -1,
  -1,
  -1,
  0,
  1,
  2,
  3,
  4,
  -1,
  -1,
  5,
  6,
  7,
  8,
  9,
  10,
  -1,
  -1,
  11,
  12,
  13,
  14,
  15,
  16,
  -1,
  -1,
  17,
  18,
  19,
  20,
  -1,
  -1
]);
var JONG_MAP = Object.freeze([
  -1,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  -1,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  -1,
  -1
]);
function lookupSymbol(ch) {
  let lo = 0;
  let hi = JOHAB_SYMBOLS.length / 2 - 1;
  while (lo <= hi) {
    const mid = lo + hi >>> 1;
    const k = JOHAB_SYMBOLS[mid * 2];
    if (k === ch) return JOHAB_SYMBOLS[mid * 2 + 1];
    if (k < ch) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}
var JOHAB_UNMAPPED = -1;
function decodeJohab(ch) {
  if (ch < 128) return ch;
  if (ch >= 32768) {
    const choIdx = ch >> 10 & 31;
    const jungIdx = ch >> 5 & 31;
    const jongIdx = ch & 31;
    const cho = CHO_MAP[choIdx];
    const jung = JUNG_MAP[jungIdx];
    let jong = JONG_MAP[jongIdx];
    if (cho !== -1 && jung !== -1) {
      if (jong === -1) jong = 0;
      return 44032 + cho * 588 + jung * 28 + jong;
    }
    const hit = lookupSymbol(ch);
    if (hit !== null) return hit;
  }
  return JOHAB_UNMAPPED;
}
function decodeHcharString(bytes) {
  let out = "";
  let i = 0;
  while (i + 1 < bytes.length) {
    const ch = bytes[i] | bytes[i + 1] << 8;
    if (ch === 0) break;
    const cp = decodeJohab(ch);
    if (cp !== JOHAB_UNMAPPED) out += String.fromCodePoint(cp);
    i += 2;
  }
  return out;
}

// src/hwp3/reader.ts
var InsufficientDataError = class extends Error {
  constructor(requested, available) {
    super(`HWP3: insufficient data (need ${requested}, have ${available})`);
    this.requested = requested;
    this.available = available;
    this.name = "InsufficientDataError";
  }
};
var Reader = class {
  constructor(buf, start = 0) {
    this.buf = buf;
    this.pos = start;
  }
  
  position() {
    return this.pos;
  }
  remaining() {
    return this.buf.length - this.pos;
  }
  eof() {
    return this.pos >= this.buf.length;
  }
  skip(n) {
    this.ensure(n);
    this.pos += n;
  }
  ensure(n) {
    if (this.pos + n > this.buf.length) {
      throw new InsufficientDataError(n, this.buf.length - this.pos);
    }
  }
  readU8() {
    this.ensure(1);
    const v = this.buf[this.pos];
    this.pos += 1;
    return v;
  }
  readU16() {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  readU32() {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  readBytes(n) {
    this.ensure(n);
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
  /** 남은 모든 바이트를 새 Buffer 로 반환 (커서를 끝으로 이동). */
  readToEnd() {
    const slice = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return slice;
  }
};

// src/hwp3/records.ts
var SIGNATURE_PREFIX = Buffer.from("HWP Document File V3.00", "ascii");
var SIGNATURE_LEN = 30;
var DOC_INFO_SIZE = 128;
var DOC_SUMMARY_SIZE = 9 * 112;
function readHeader(reader) {
  const sig = reader.readBytes(SIGNATURE_LEN);
  if (!sig.subarray(0, SIGNATURE_PREFIX.length).equals(SIGNATURE_PREFIX)) {
    throw new Error("HWP3: invalid file signature");
  }
  const docInfoStart = reader.position();
  reader.skip(96);
  const encrypted = reader.readU16();
  reader.skip(124 - 98);
  const compressed = reader.readU8();
  reader.skip(1);
  const infoBlockLength = reader.readU16();
  if (reader.position() !== docInfoStart + DOC_INFO_SIZE) {
    throw new Error(
      `HWP3: DocInfo size mismatch (got ${reader.position() - docInfoStart}, expected ${DOC_INFO_SIZE})`
    );
  }
  const summaryStart = reader.position();
  const title = decodeHcharString(reader.readBytes(112));
  const subject = decodeHcharString(reader.readBytes(112));
  const author = decodeHcharString(reader.readBytes(112));
  const date = decodeHcharString(reader.readBytes(112));
  reader.skip(5 * 112);
  if (reader.position() !== summaryStart + DOC_SUMMARY_SIZE) {
    throw new Error("HWP3: DocSummary size mismatch");
  }
  return { compressed, encrypted, infoBlockLength, title, subject, author, date };
}

// src/hwp3/parser.ts
var PARA_SHAPE_SIZE = 187;
var LINE_INFO_SIZE = 14;
var INLINE_CHAR_SHAPE_SIZE = 31;
var SIMPLE_CTRL = /* @__PURE__ */ new Map([
  [9, { extraBytes: 0, extraHchar: 0, emit: "	" }],
  [7, { extraBytes: 6, extraHchar: 3, emit: "\uFFFC" }],
  [8, { extraBytes: 6, extraHchar: 3, emit: "\uFFFC" }],
  [18, { extraBytes: 6, extraHchar: 3, emit: " " }],
  // AutoNumber → 공백 (HWP5 패턴)
  [19, { extraBytes: 6, extraHchar: 3, emit: "\uFFFC" }],
  [20, { extraBytes: 6, extraHchar: 3, emit: "\uFFFC" }],
  [21, { extraBytes: 6, extraHchar: 3, emit: "\uFFFC" }],
  [22, { extraBytes: 22, extraHchar: 11, emit: "\uFFFC" }],
  [23, { extraBytes: 8, extraHchar: 4, emit: "\uFFFC" }],
  [24, { extraBytes: 4, extraHchar: 2, emit: "-" }],
  [25, { extraBytes: 4, extraHchar: 2, emit: "-" }],
  [26, { extraBytes: 244, extraHchar: 122, emit: "\uFFFC" }],
  [28, { extraBytes: 62, extraHchar: 31, emit: "\uFFFC" }],
  [30, { extraBytes: 2, extraHchar: 1, emit: "\xA0" }],
  [31, { extraBytes: 2, extraHchar: 1, emit: " " }]
]);
function parseHwp3Document(buffer, _options) {
  const headReader = new Reader(Buffer.from(buffer));
  const header = readHeader(headReader);
  if (header.encrypted !== 0) {
    const e = new Error("HWP3 \uBCF8\uBB38\uC774 \uC554\uD638\uB85C \uBCF4\uD638\uB418\uC5B4 \uC788\uC5B4 \uCD94\uCD9C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    e.code = "ENCRYPTED";
    throw e;
  }
  headReader.skip(header.infoBlockLength);
  const tail = headReader.readToEnd();
  let body;
  const warnings = [];
  if (header.compressed !== 0) {
    try {
      body = _zlib.inflateRawSync.call(void 0, tail);
    } catch (err) {
      const msg2 = err instanceof Error ? err.message : String(err);
      throw new Error(`HWP3 \uC555\uCD95 \uD574\uC81C \uC2E4\uD328: ${msg2}`);
    }
  } else {
    body = tail;
  }
  const bodyReader = new Reader(body);
  const ctx = { paragraphs: [], warnings };
  try {
    skipFontFacesAndStyles(bodyReader);
    parseParagraphList2(bodyReader, ctx);
  } catch (err) {
    warnings.push({
      code: "PARTIAL_PARSE",
      message: `HWP3 paragraph stream \uB3C4\uC911 \uD30C\uC2F1 \uC911\uB2E8: ${err instanceof Error ? err.message : String(err)}`
    });
  }
  const text = ctx.paragraphs.filter((p) => p.length > 0).join("\n\n");
  const blocks = ctx.paragraphs.map((p) => ({ type: "paragraph", text: p }));
  const metadata = {
    title: header.title || void 0,
    author: header.author || void 0,
    description: header.subject || void 0,
    createdAt: header.date || void 0,
    version: "3.0"
  };
  return {
    markdown: text,
    blocks,
    metadata,
    warnings: warnings.length ? warnings : void 0
  };
}
function skipFontFacesAndStyles(reader) {
  const STYLE_RECORD_SIZE = 20 + 31 + 187;
  for (let lang = 0; lang < 7; lang++) {
    const n = reader.readU16();
    reader.skip(n * 40);
  }
  const nStyles = reader.readU16();
  reader.skip(nStyles * STYLE_RECORD_SIZE);
}
function parseParagraphList2(reader, ctx) {
  for (; ; ) {
    if (reader.eof()) return;
    const followPrev = reader.readU8();
    const charCount = reader.readU16();
    if (charCount === 0) {
      reader.skip(40);
      return;
    }
    const lineCount = reader.readU16();
    if (charCount > 6e4 || lineCount > 4096) {
      ctx.warnings.push({
        code: "PARTIAL_PARSE",
        message: `HWP3 \uBE44\uC815\uC0C1 paragraph \uD5E4\uB354 (char_count=${charCount}, line_count=${lineCount}) \u2192 \uC774\uD6C4 stream \uD3EC\uAE30`
      });
      return;
    }
    const includeCharShape = reader.readU8();
    reader.skip(1);
    reader.skip(4);
    reader.skip(1);
    reader.skip(31);
    if (followPrev === 0) reader.skip(PARA_SHAPE_SIZE);
    reader.skip(lineCount * LINE_INFO_SIZE);
    if (includeCharShape !== 0) {
      for (let i = 0; i < charCount; i++) {
        const flag = reader.readU8();
        if (flag !== 1) reader.skip(INLINE_CHAR_SHAPE_SIZE);
      }
    }
    try {
      const text = parseCharStream(reader, charCount, ctx);
      ctx.paragraphs.push(text);
    } catch (err) {
      ctx.warnings.push({
        code: "PARTIAL_PARSE",
        message: `HWP3 paragraph #${ctx.paragraphs.length} char stream \uD30C\uC2F1 \uC2E4\uD328: ${err instanceof Error ? err.message : String(err)}`
      });
      return;
    }
  }
}
function parseCharStream(reader, charCount, ctx) {
  let out = "";
  let i = 0;
  while (i < charCount) {
    const ch = reader.readU16();
    i += 1;
    if (ch === 13) {
      out += "\n";
      continue;
    }
    if (ch === 0) {
      continue;
    }
    if (ch >= 32) {
      const cp = decodeJohab(ch);
      if (cp !== JOHAB_UNMAPPED) out += String.fromCodePoint(cp);
      continue;
    }
    const simple = SIMPLE_CTRL.get(ch);
    if (simple) {
      reader.skip(simple.extraBytes);
      i += simple.extraHchar;
      if (simple.emit) out += simple.emit;
      continue;
    }
    const headerVal1 = reader.readU32();
    reader.readU16();
    i += 3;
    switch (ch) {
      case 10:
        out += parseTableLike(reader, ctx);
        break;
      case 11:
        parsePicture(reader, ctx);
        break;
      case 12:
        reader.skip(84);
        break;
      case 14:
        reader.skip(84);
        break;
      case 15: {
        reader.skip(8);
        parseParagraphList2(reader, ctx);
        break;
      }
      case 16: {
        reader.skip(10);
        parseParagraphList2(reader, ctx);
        break;
      }
      case 17: {
        reader.skip(14);
        parseParagraphList2(reader, ctx);
        break;
      }
      case 29:
        if (headerVal1 < 1e6) reader.skip(headerVal1);
        break;
      default:
        if (!ctx.warnings.some((w) => w.code === "UNSUPPORTED_ELEMENT")) {
          ctx.warnings.push({
            code: "UNSUPPORTED_ELEMENT",
            message: `HWP3 \uBD80\uBD84 \uCC98\uB9AC \uC81C\uC5B4 \uBB38\uC790 ch=${ch} (\uC774\uD6C4 \uB3D9\uC77C \uCF54\uB4DC \uACBD\uACE0 \uC0DD\uB7B5)`
          });
        }
        break;
    }
  }
  return out.trim();
}
function parseTableLike(reader, ctx) {
  const info = reader.readBytes(84);
  const cellCount = info.readUInt16LE(80) || 1;
  if (cellCount > 256) {
    ctx.warnings.push({
      code: "PARTIAL_PARSE",
      message: `HWP3 \uD45C cell_count=${cellCount} \uBE44\uC815\uC0C1 \u2014 \uD45C \uBCF8\uBB38 \uCD94\uCD9C \uD3EC\uAE30`
    });
    throw new Error(`HWP3 \uBE44\uC815\uC0C1 cell_count=${cellCount}`);
  }
  reader.skip(27 * cellCount);
  for (let i = 0; i < cellCount; i++) {
    parseParagraphList2(reader, ctx);
  }
  parseParagraphList2(reader, ctx);
  return "";
}
function parsePicture(reader, _ctx) {
  const info = reader.readBytes(348);
  const nExt = info.readUInt32LE(0);
  if (nExt > 0 && nExt < 100 * 1024 * 1024) reader.skip(nExt);
}

// src/hwp5/sentinel.ts
var SENTINEL_PATTERNS = [
  /상위\s*버전의\s*배포용\s*문서/,
  /최신\s*버전의\s*한글.*뷰어/,
  /문서를\s*읽으려면/
];
function isDistributionSentinel(markdown) {
  if (!markdown) return false;
  const hit = SENTINEL_PATTERNS.some((p) => p.test(markdown));
  if (!hit) return false;
  const stripped = markdown.split(/\r?\n/).filter((line) => !SENTINEL_PATTERNS.some((p) => p.test(line))).join("").replace(/\s+/g, "");
  return stripped.length < 120;
}

// src/xlsx/parser.ts


var MAX_SHEETS = 100;
var MAX_DECOMPRESS_SIZE3 = 100 * 1024 * 1024;
var MAX_ROWS2 = 1e4;
var MAX_COLS2 = 200;
function cleanNumericValue(raw) {
  if (!/^-?\d+\.\d+$/.test(raw)) return raw;
  const num4 = parseFloat(raw);
  if (!isFinite(num4)) return raw;
  const cleaned = parseFloat(num4.toPrecision(15)).toString();
  return cleaned;
}
function parseCellRef(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}
function parseMergeRef(ref) {
  const parts = ref.split(":");
  if (parts.length !== 2) return null;
  const start = parseCellRef(parts[0]);
  const end = parseCellRef(parts[1]);
  if (!start || !end) return null;
  return { startCol: start.col, startRow: start.row, endCol: end.col, endRow: end.row };
}
function getElements(parent, tagName) {
  const nodes = parent.getElementsByTagName(tagName);
  const result = [];
  for (let i = 0; i < nodes.length; i++) result.push(nodes[i]);
  if (result.length > 0) return result;
  const nsNodes = _optionalChain([parent, 'access', _82 => _82.getElementsByTagNameNS, 'optionalCall', _83 => _83("*", tagName)]);
  if (nsNodes) for (let i = 0; i < nsNodes.length; i++) result.push(nsNodes[i]);
  return result;
}
function getTextContent(el) {
  return _nullishCoalesce(_optionalChain([el, 'access', _84 => _84.textContent, 'optionalAccess', _85 => _85.trim, 'call', _86 => _86()]), () => ( ""));
}
function parseXml(text) {
  return new (0, _xmldom.DOMParser)().parseFromString(_chunkR2H34FY5cjs.stripDtd.call(void 0, text), "text/xml");
}
function parseSharedStrings(xml) {
  const doc = parseXml(xml);
  const strings = [];
  const siList = getElements(doc.documentElement, "si");
  for (const si of siList) {
    const tElements = getElements(si, "t");
    strings.push(tElements.map((t) => _nullishCoalesce(t.textContent, () => ( ""))).join(""));
  }
  return strings;
}
function parseWorkbook(xml) {
  const doc = parseXml(xml);
  const sheets = [];
  const sheetElements = getElements(doc.documentElement, "sheet");
  for (const el of sheetElements) {
    sheets.push({
      name: _nullishCoalesce(el.getAttribute("name"), () => ( `Sheet${sheets.length + 1}`)),
      sheetId: _nullishCoalesce(el.getAttribute("sheetId"), () => ( "")),
      rId: _nullishCoalesce(el.getAttribute("r:id"), () => ( ""))
    });
  }
  return sheets;
}
function parseRels(xml) {
  const doc = parseXml(xml);
  const map = /* @__PURE__ */ new Map();
  const rels = getElements(doc.documentElement, "Relationship");
  for (const rel of rels) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) map.set(id, target);
  }
  return map;
}
function parseWorksheet(xml, sharedStrings) {
  const doc = parseXml(xml);
  const grid = [];
  let maxRow = 0;
  let maxCol = 0;
  const rows = getElements(doc.documentElement, "row");
  for (const rowEl of rows) {
    const rowNum = parseInt(_nullishCoalesce(rowEl.getAttribute("r"), () => ( "0")), 10) - 1;
    if (rowNum < 0 || rowNum >= MAX_ROWS2) continue;
    const cells = getElements(rowEl, "c");
    for (const cellEl of cells) {
      const ref = cellEl.getAttribute("r");
      if (!ref) continue;
      const pos = parseCellRef(ref);
      if (!pos || pos.col >= MAX_COLS2) continue;
      const type = cellEl.getAttribute("t");
      const vElements = getElements(cellEl, "v");
      const fElements = getElements(cellEl, "f");
      let value = "";
      if (vElements.length > 0) {
        const raw = getTextContent(vElements[0]);
        if (type === "s") {
          const idx = parseInt(raw, 10);
          value = _nullishCoalesce(sharedStrings[idx], () => ( ""));
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else {
          value = cleanNumericValue(raw);
        }
      } else if (type === "inlineStr") {
        const isEl = getElements(cellEl, "is");
        if (isEl.length > 0) {
          const tElements = getElements(isEl[0], "t");
          value = tElements.map((t) => _nullishCoalesce(t.textContent, () => ( ""))).join("");
        }
      }
      if (!value && fElements.length > 0) {
        value = `=${getTextContent(fElements[0])}`;
      }
      while (grid.length <= pos.row) grid.push([]);
      while (grid[pos.row].length <= pos.col) grid[pos.row].push("");
      grid[pos.row][pos.col] = value;
      if (pos.row > maxRow) maxRow = pos.row;
      if (pos.col > maxCol) maxCol = pos.col;
    }
  }
  const merges = [];
  const mergeCellElements = getElements(doc.documentElement, "mergeCell");
  for (const el of mergeCellElements) {
    const ref = el.getAttribute("ref");
    if (!ref) continue;
    const m = parseMergeRef(ref);
    if (m) merges.push(m);
  }
  return { grid, merges, maxRow, maxCol };
}
function sheetToBlocks(sheetName, grid, merges, maxRow, maxCol, sheetIndex) {
  const blocks = [];
  if (sheetName) {
    blocks.push({
      type: "heading",
      text: sheetName,
      level: 2,
      pageNumber: sheetIndex + 1
    });
  }
  if (maxRow < 0 || maxCol < 0 || grid.length === 0) return blocks;
  const mergeMap = /* @__PURE__ */ new Map();
  const mergeSkip = /* @__PURE__ */ new Set();
  for (const m of merges) {
    const colSpan = m.endCol - m.startCol + 1;
    const rowSpan = m.endRow - m.startRow + 1;
    mergeMap.set(`${m.startRow},${m.startCol}`, { colSpan, rowSpan });
    for (let r = m.startRow; r <= m.endRow; r++) {
      for (let c = m.startCol; c <= m.endCol; c++) {
        if (r !== m.startRow || c !== m.startCol) {
          mergeSkip.add(`${r},${c}`);
        }
      }
    }
  }
  let firstRow = -1;
  let lastRow = -1;
  for (let r = 0; r <= maxRow; r++) {
    const row = grid[r];
    if (row && row.some((cell) => cell !== "")) {
      if (firstRow === -1) firstRow = r;
      lastRow = r;
    }
  }
  if (firstRow === -1) return blocks;
  const cellRows = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const row = [];
    for (let c = 0; c <= maxCol; c++) {
      const key = `${r},${c}`;
      if (mergeSkip.has(key)) continue;
      const text = _nullishCoalesce((grid[r] && grid[r][c]), () => ( ""));
      const merge = mergeMap.get(key);
      row.push({
        text,
        colSpan: _nullishCoalesce(_optionalChain([merge, 'optionalAccess', _87 => _87.colSpan]), () => ( 1)),
        rowSpan: _nullishCoalesce(_optionalChain([merge, 'optionalAccess', _88 => _88.rowSpan]), () => ( 1))
      });
    }
    cellRows.push(row);
  }
  if (cellRows.length > 0) {
    const table = _chunkR2H34FY5cjs.buildTable.call(void 0, cellRows);
    if (table.rows > 0) {
      blocks.push({ type: "table", table, pageNumber: sheetIndex + 1 });
    }
  }
  return blocks;
}
async function parseXlsxDocument(buffer, options) {
  _chunkR2H34FY5cjs.precheckZipSize.call(void 0, buffer, MAX_DECOMPRESS_SIZE3);
  const zip = await _jszip2.default.loadAsync(buffer);
  const warnings = [];
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 XLSX \uD30C\uC77C: xl/workbook.xml\uC774 \uC5C6\uC2B5\uB2C8\uB2E4");
  }
  let sharedStrings = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    sharedStrings = parseSharedStrings(await ssFile.async("text"));
  }
  const sheets = parseWorkbook(await workbookFile.async("text"));
  if (sheets.length === 0) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("XLSX \uD30C\uC77C\uC5D0 \uC2DC\uD2B8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4");
  }
  let relsMap = /* @__PURE__ */ new Map();
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (relsFile) {
    relsMap = parseRels(await relsFile.async("text"));
  }
  let pageFilter = null;
  if (_optionalChain([options, 'optionalAccess', _89 => _89.pages])) {
    const { parsePageRange: parsePageRange2 } = await Promise.resolve().then(() => _interopRequireWildcard(require("./page-range-P7SDW6LR.cjs")));
    pageFilter = parsePageRange2(options.pages, sheets.length);
  }
  const blocks = [];
  const processedSheets = Math.min(sheets.length, MAX_SHEETS);
  for (let i = 0; i < processedSheets; i++) {
    if (pageFilter && !pageFilter.has(i + 1)) continue;
    const sheet = sheets[i];
    _optionalChain([options, 'optionalAccess', _90 => _90.onProgress, 'optionalCall', _91 => _91(i + 1, processedSheets)]);
    let sheetPath = relsMap.get(sheet.rId);
    if (sheetPath) {
      if (!sheetPath.startsWith("xl/") && !sheetPath.startsWith("/")) {
        sheetPath = `xl/${sheetPath}`;
      } else if (sheetPath.startsWith("/")) {
        sheetPath = sheetPath.slice(1);
      }
    } else {
      sheetPath = `xl/worksheets/sheet${i + 1}.xml`;
    }
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) {
      warnings.push({
        page: i + 1,
        message: `\uC2DC\uD2B8 "${sheet.name}" \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${sheetPath}`,
        code: "PARTIAL_PARSE"
      });
      continue;
    }
    try {
      const sheetXml = await sheetFile.async("text");
      const { grid, merges, maxRow, maxCol } = parseWorksheet(sheetXml, sharedStrings);
      const sheetBlocks = sheetToBlocks(sheet.name, grid, merges, maxRow, maxCol, i);
      blocks.push(...sheetBlocks);
    } catch (err) {
      warnings.push({
        page: i + 1,
        message: `\uC2DC\uD2B8 "${sheet.name}" \uD30C\uC2F1 \uC2E4\uD328: ${err instanceof Error ? err.message : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`,
        code: "PARTIAL_PARSE"
      });
    }
  }
  const metadata = {
    pageCount: processedSheets
  };
  const coreFile = zip.file("docProps/core.xml");
  if (coreFile) {
    try {
      const coreXml = await coreFile.async("text");
      const doc = parseXml(coreXml);
      const getFirst = (tag) => {
        const els = doc.getElementsByTagName(tag);
        return els.length > 0 ? (_nullishCoalesce(els[0].textContent, () => ( ""))).trim() : void 0;
      };
      metadata.title = getFirst("dc:title") || getFirst("dcterms:title");
      metadata.author = getFirst("dc:creator");
      metadata.description = getFirst("dc:description");
      const created = getFirst("dcterms:created");
      if (created) metadata.createdAt = created;
      const modified = getFirst("dcterms:modified");
      if (modified) metadata.modifiedAt = modified;
    } catch (e27) {
    }
  }
  const markdown = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, blocks);
  return { markdown, blocks, metadata, warnings: warnings.length > 0 ? warnings : void 0 };
}

// src/xls/record.ts
var OP_BOF = 2057;
var OP_EOF = 10;
var OP_CONTINUE = 60;
var OP_BOUNDSHEET8 = 133;
var OP_SST = 252;
var OP_CODEPAGE = 66;
var OP_FILEPASS = 47;
var OP_NUMBER = 515;
var OP_RK = 638;
var OP_MULRK = 189;
var OP_LABELSST = 253;
var OP_LABEL = 516;
var OP_FORMULA = 6;
var OP_STRING = 519;
var OP_BOOLERR = 517;
var OP_BLANK = 513;
var OP_MULBLANK = 190;
var OP_MERGECELLS = 229;
var DT_GLOBALS = 5;
var DT_WORKSHEET = 16;
var MAX_RECORDS2 = 1e6;
function readRecords2(stream) {
  const out = [];
  let offset = 0;
  while (offset + 4 <= stream.length && out.length < MAX_RECORDS2) {
    const recOffset = offset;
    const opcode = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > stream.length) {
      const data2 = stream.subarray(offset, stream.length);
      out.push({ opcode, data: data2, offset: recOffset });
      break;
    }
    const data = stream.subarray(offset, offset + length);
    out.push({ opcode, data, offset: recOffset });
    offset += length;
  }
  return out;
}
function combineWithContinue(records, startIndex) {
  const first = records[startIndex];
  const chunks = [first.data];
  const segments = [first.data.length];
  let i = startIndex + 1;
  let total = first.data.length;
  while (i < records.length && records[i].opcode === OP_CONTINUE) {
    chunks.push(records[i].data);
    total += records[i].data.length;
    segments.push(total);
    i++;
  }
  return {
    combined: Buffer.concat(chunks),
    segments,
    nextIndex: i
  };
}
function decodeBof(data) {
  if (data.length < 4) return null;
  return {
    vers: data.readUInt16LE(0),
    dt: data.readUInt16LE(2)
  };
}
function decodeRk(rk) {
  const fDiv100 = (rk & 1) !== 0;
  const fInt = (rk & 2) !== 0;
  const val30 = rk >> 2;
  let num4;
  if (fInt) {
    num4 = val30;
  } else {
    const high32 = (rk & 4294967292) >>> 0;
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(high32, 4);
    num4 = buf.readDoubleLE(0);
  }
  return fDiv100 ? num4 / 100 : num4;
}
function decodeMulRk(data) {
  if (data.length < 6) return null;
  const row = data.readUInt16LE(0);
  const colFirst = data.readUInt16LE(2);
  const colLast = data.readUInt16LE(data.length - 2);
  const count = colLast - colFirst + 1;
  if (count <= 0) return { row, cells: [] };
  const cells = [];
  let off = 4;
  for (let i = 0; i < count && off + 6 <= data.length - 2; i++) {
    const ixfe = data.readUInt16LE(off);
    const rk = data.readUInt32LE(off + 2);
    cells.push({ col: colFirst + i, ixfe, value: decodeRk(rk) });
    off += 6;
  }
  return { row, cells };
}
function readCellHeader(data) {
  if (data.length < 6) return null;
  return {
    row: data.readUInt16LE(0),
    col: data.readUInt16LE(2),
    ixfe: data.readUInt16LE(4)
  };
}

// src/xls/encoding.ts
function decodeUtf16Le(buf) {
  return buf.toString("utf16le");
}

// src/xls/sst.ts
function parseString(buf, offset, segments) {
  if (offset + 3 > buf.length) return null;
  const cch = buf.readUInt16LE(offset);
  let flags = buf.readUInt8(offset + 2);
  let off = offset + 3;
  let highByte = (flags & 1) !== 0;
  const extSt = (flags & 4) !== 0;
  const richSt = (flags & 8) !== 0;
  let cRun = 0;
  let cbExtRst = 0;
  if (richSt) {
    if (off + 2 > buf.length) return null;
    cRun = buf.readUInt16LE(off);
    off += 2;
  }
  if (extSt) {
    if (off + 4 > buf.length) return null;
    cbExtRst = buf.readUInt32LE(off);
    off += 4;
  }
  const charBytes = [];
  let charsRead = 0;
  while (charsRead < cch) {
    const nextBoundary = _nullishCoalesce(segments.find((s) => s > off), () => ( buf.length));
    const remainChars = cch - charsRead;
    const bytesPerChar = highByte ? 2 : 1;
    const bytesAvail = nextBoundary - off;
    const charsInThisRun = Math.min(remainChars, Math.floor(bytesAvail / bytesPerChar));
    const bytesToRead = charsInThisRun * bytesPerChar;
    if (bytesToRead > 0) {
      const slice = buf.subarray(off, off + bytesToRead);
      charBytes.push(highByte ? slice : padToUtf16(slice));
      off += bytesToRead;
      charsRead += charsInThisRun;
    }
    if (charsRead < cch) {
      if (off >= buf.length) return null;
      flags = buf.readUInt8(off);
      highByte = (flags & 1) !== 0;
      off += 1;
    }
  }
  const text = decodeUtf16Le(Buffer.concat(charBytes));
  if (richSt) off += 4 * cRun;
  if (extSt) off += cbExtRst;
  if (off > buf.length) off = buf.length;
  return { text, consumed: off - offset };
}
function padToUtf16(compressed) {
  const out = Buffer.alloc(compressed.length * 2);
  for (let i = 0; i < compressed.length; i++) {
    out[i * 2] = compressed[i];
    out[i * 2 + 1] = 0;
  }
  return out;
}
function decodeSST(records) {
  const sstIndex = records.findIndex((r) => r.opcode === OP_SST);
  if (sstIndex < 0) return [];
  const { combined, segments } = combineWithContinue(records, sstIndex);
  if (combined.length < 8) return [];
  const cstUnique = combined.readUInt32LE(4);
  const strings = [];
  let off = 8;
  for (let i = 0; i < cstUnique && off < combined.length; i++) {
    const r = parseString(combined, off, segments);
    if (!r) break;
    strings.push(r.text);
    off += r.consumed;
  }
  return strings;
}

// src/xls/cell.ts
function errorCodeToText(code) {
  switch (code) {
    case 0:
      return "#NULL!";
    case 7:
      return "#DIV/0!";
    case 15:
      return "#VALUE!";
    case 23:
      return "#REF!";
    case 29:
      return "#NAME?";
    case 36:
      return "#NUM!";
    case 42:
      return "#N/A";
    default:
      return `#ERR${code}`;
  }
}
function decodeLabelString(data) {
  if (data.length < 9) return "";
  const cch = data.readUInt16LE(6);
  const flags = data.readUInt8(8);
  const highByte = (flags & 1) !== 0;
  const start = 9;
  if (highByte) {
    const end = Math.min(start + cch * 2, data.length);
    return decodeUtf16Le(data.subarray(start, end));
  } else {
    const end = Math.min(start + cch, data.length);
    const slice = data.subarray(start, end);
    const padded = Buffer.alloc(slice.length * 2);
    for (let i = 0; i < slice.length; i++) padded[i * 2] = slice[i];
    return decodeUtf16Le(padded);
  }
}
function decodeFormulaResult(val) {
  if (val.length < 8) return { kind: "value", value: null };
  const tail = val.readUInt16LE(6);
  if (tail === 65535) {
    const code = val.readUInt8(0);
    if (code === 0) return { kind: "stringRef" };
    if (code === 1) return { kind: "value", value: val.readUInt8(2) === 1 };
    if (code === 2) return { kind: "value", value: errorCodeToText(val.readUInt8(2)) };
    return { kind: "value", value: null };
  }
  return { kind: "value", value: val.readDoubleLE(0) };
}
function decodeFormulaStringRecord(data) {
  if (data.length < 3) return "";
  const cch = data.readUInt16LE(0);
  const flags = data.readUInt8(2);
  const highByte = (flags & 1) !== 0;
  const start = 3;
  if (highByte) {
    const end = Math.min(start + cch * 2, data.length);
    return decodeUtf16Le(data.subarray(start, end));
  } else {
    const end = Math.min(start + cch, data.length);
    const slice = data.subarray(start, end);
    const padded = Buffer.alloc(slice.length * 2);
    for (let i = 0; i < slice.length; i++) padded[i * 2] = slice[i];
    return decodeUtf16Le(padded);
  }
}
function extractSheetCells(records, bofIndex, sst) {
  const cells = [];
  const merges = [];
  const bofOffset = records[bofIndex].offset;
  let i = bofIndex + 1;
  while (i < records.length) {
    const rec = records[i];
    if (rec.opcode === OP_EOF) {
      i++;
      break;
    }
    if (rec.opcode === OP_BOF) {
      break;
    }
    switch (rec.opcode) {
      case OP_NUMBER: {
        const h = readCellHeader(rec.data);
        if (h && rec.data.length >= 14) {
          cells.push({ row: h.row, col: h.col, value: rec.data.readDoubleLE(6) });
        }
        break;
      }
      case OP_RK: {
        const h = readCellHeader(rec.data);
        if (h && rec.data.length >= 10) {
          cells.push({ row: h.row, col: h.col, value: decodeRk(rec.data.readInt32LE(6)) });
        }
        break;
      }
      case OP_MULRK: {
        const m = decodeMulRk(rec.data);
        if (m) {
          for (const c of m.cells) {
            cells.push({ row: m.row, col: c.col, value: c.value });
          }
        }
        break;
      }
      case OP_LABELSST: {
        const h = readCellHeader(rec.data);
        if (h && rec.data.length >= 10) {
          const isst = rec.data.readUInt32LE(6);
          cells.push({ row: h.row, col: h.col, value: _nullishCoalesce(sst[isst], () => ( "")) });
        }
        break;
      }
      case OP_LABEL: {
        const h = readCellHeader(rec.data);
        if (h) {
          cells.push({ row: h.row, col: h.col, value: decodeLabelString(rec.data) });
        }
        break;
      }
      case OP_FORMULA: {
        const h = readCellHeader(rec.data);
        if (h && rec.data.length >= 14) {
          const result = decodeFormulaResult(rec.data.subarray(6, 14));
          if (result.kind === "stringRef") {
            const next = records[i + 1];
            if (next && next.opcode === OP_STRING) {
              cells.push({
                row: h.row,
                col: h.col,
                value: decodeFormulaStringRecord(next.data)
              });
              i++;
            } else {
              cells.push({ row: h.row, col: h.col, value: "" });
            }
          } else {
            cells.push({ row: h.row, col: h.col, value: result.value });
          }
        }
        break;
      }
      case OP_BOOLERR: {
        const h = readCellHeader(rec.data);
        if (h && rec.data.length >= 8) {
          const v = rec.data.readUInt8(6);
          const isErr = rec.data.readUInt8(7) === 1;
          if (isErr) {
            cells.push({ row: h.row, col: h.col, value: errorCodeToText(v) });
          } else {
            cells.push({ row: h.row, col: h.col, value: v === 1 });
          }
        }
        break;
      }
      case OP_BLANK:
      case OP_MULBLANK: {
        break;
      }
      case OP_MERGECELLS: {
        if (rec.data.length >= 2) {
          const cmcs = rec.data.readUInt16LE(0);
          let off = 2;
          for (let k = 0; k < cmcs && off + 8 <= rec.data.length; k++) {
            const r1 = rec.data.readUInt16LE(off);
            const r2 = rec.data.readUInt16LE(off + 2);
            const c1 = rec.data.readUInt16LE(off + 4);
            const c2 = rec.data.readUInt16LE(off + 6);
            merges.push({ r1, c1, r2, c2 });
            off += 8;
          }
        }
        break;
      }
      default:
        break;
    }
    i++;
  }
  return {
    sheet: { bofOffset, cells, merges },
    endIndex: i
  };
}

// src/xls/parser.ts
var MAX_SHEETS2 = 100;
var MAX_ROWS3 = 1e5;
var MAX_COLS3 = 1e3;
function decodeBoundSheet(data) {
  if (data.length < 8) return null;
  const lbPlyPos = data.readUInt32LE(0);
  const dt = data.readUInt8(5);
  const cch = data.readUInt8(6);
  const flags = data.readUInt8(7);
  const highByte = (flags & 1) !== 0;
  const start = 8;
  let name;
  if (highByte) {
    const end = Math.min(start + cch * 2, data.length);
    name = decodeUtf16Le(data.subarray(start, end));
  } else {
    const end = Math.min(start + cch, data.length);
    const slice = data.subarray(start, end);
    const padded = Buffer.alloc(slice.length * 2);
    for (let i = 0; i < slice.length; i++) padded[i * 2] = slice[i];
    name = decodeUtf16Le(padded);
  }
  return { name, lbPlyPos, dt };
}
function processGlobals(records) {
  const sheets = [];
  let codePage = 1200;
  let encrypted = false;
  const firstBof = records[0];
  if (!firstBof || firstBof.opcode !== OP_BOF) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("XLS: \uCCAB \uB808\uCF54\uB4DC\uAC00 BOF\uAC00 \uC544\uB2D8");
  }
  const bof = decodeBof(firstBof.data);
  if (!bof || bof.dt !== DT_GLOBALS) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("XLS: Globals \uC11C\uBE0C\uC2A4\uD2B8\uB9BC BOF \uB204\uB77D");
  }
  let i = 1;
  while (i < records.length) {
    const r = records[i];
    if (r.opcode === OP_EOF) {
      i++;
      break;
    }
    if (r.opcode === OP_BOUNDSHEET8) {
      const bs = decodeBoundSheet(r.data);
      if (bs) sheets.push(bs);
    } else if (r.opcode === OP_CODEPAGE && r.data.length >= 2) {
      codePage = r.data.readUInt16LE(0);
    } else if (r.opcode === OP_FILEPASS) {
      encrypted = true;
    }
    i++;
  }
  const globalsRecords = records.slice(0, i);
  const sst = decodeSST(globalsRecords);
  return { sheets, sst, codePage, encrypted, endIndex: i };
}
function findSheetBofIndex(records, lbPlyPos) {
  const exact = records.findIndex(
    (r) => r.opcode === OP_BOF && r.offset === lbPlyPos
  );
  if (exact >= 0) return exact;
  const bofIndices = records.map((r, idx) => r.opcode === OP_BOF ? idx : -1).filter((idx) => idx >= 0);
  if (bofIndices.length === 0) return -1;
  return bofIndices.length > 1 ? bofIndices[1] : -1;
}
function cellValueToText(v) {
  if (v === null || v === void 0) return "";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toString();
    const cleaned = parseFloat(v.toPrecision(15)).toString();
    return cleaned;
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v;
}
function sheetToBlocks2(sheetName, sheet, sheetIndex) {
  const blocks = [];
  if (sheetName) {
    blocks.push({
      type: "heading",
      text: sheetName,
      level: 2,
      pageNumber: sheetIndex + 1
    });
  }
  if (sheet.cells.length === 0) return blocks;
  let maxRow = -1;
  let maxCol = -1;
  for (const c of sheet.cells) {
    if (c.row > maxRow) maxRow = c.row;
    if (c.col > maxCol) maxCol = c.col;
  }
  for (const m of sheet.merges) {
    if (m.r2 > maxRow) maxRow = m.r2;
    if (m.c2 > maxCol) maxCol = m.c2;
  }
  if (maxRow < 0 || maxCol < 0) return blocks;
  if (maxRow >= MAX_ROWS3 || maxCol >= MAX_COLS3) {
    maxRow = Math.min(maxRow, MAX_ROWS3 - 1);
    maxCol = Math.min(maxCol, MAX_COLS3 - 1);
  }
  const grid = Array.from(
    { length: maxRow + 1 },
    () => Array(maxCol + 1).fill("")
  );
  for (const c of sheet.cells) {
    if (c.row > maxRow || c.col > maxCol) continue;
    grid[c.row][c.col] = cellValueToText(c.value);
  }
  const mergeMap = /* @__PURE__ */ new Map();
  const mergeSkip = /* @__PURE__ */ new Set();
  for (const m of sheet.merges) {
    const r1 = Math.min(m.r1, maxRow);
    const c1 = Math.min(m.c1, maxCol);
    const r2 = Math.min(m.r2, maxRow);
    const c2 = Math.min(m.c2, maxCol);
    mergeMap.set(`${r1},${c1}`, { colSpan: c2 - c1 + 1, rowSpan: r2 - r1 + 1 });
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r !== r1 || c !== c1) mergeSkip.add(`${r},${c}`);
      }
    }
  }
  let firstRow = -1;
  let lastRow = -1;
  for (let r = 0; r <= maxRow; r++) {
    if (grid[r].some((v) => v !== "")) {
      if (firstRow === -1) firstRow = r;
      lastRow = r;
    }
  }
  if (firstRow === -1) return blocks;
  const cellRows = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const row = [];
    for (let c = 0; c <= maxCol; c++) {
      const key = `${r},${c}`;
      if (mergeSkip.has(key)) continue;
      const merge = mergeMap.get(key);
      row.push({
        text: grid[r][c],
        colSpan: _nullishCoalesce(_optionalChain([merge, 'optionalAccess', _92 => _92.colSpan]), () => ( 1)),
        rowSpan: _nullishCoalesce(_optionalChain([merge, 'optionalAccess', _93 => _93.rowSpan]), () => ( 1))
      });
    }
    cellRows.push(row);
  }
  if (cellRows.length > 0) {
    const table = _chunkR2H34FY5cjs.buildTable.call(void 0, cellRows);
    if (table.rows > 0) {
      blocks.push({ type: "table", table, pageNumber: sheetIndex + 1 });
    }
  }
  return blocks;
}
async function parseXlsDocument(buffer, options) {
  const buf = Buffer.from(buffer);
  let cfb;
  try {
    cfb = parseLenientCfb(buf);
  } catch (e) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)(
      `XLS: OLE2 \uC2DC\uADF8\uB2C8\uCC98 \uAC80\uC99D \uC2E4\uD328 \u2014 ${e instanceof Error ? e.message : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`
    );
  }
  const wb = _nullishCoalesce(cfb.findStream("/Workbook"), () => ( cfb.findStream("/Book")));
  if (!wb) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("XLS: Workbook \uC2A4\uD2B8\uB9BC\uC774 \uC5C6\uC74C (BIFF5 \uB610\uB294 \uBE44\uD45C\uC900 \uD30C\uC77C)");
  }
  const records = readRecords2(wb);
  if (records.length === 0) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("XLS: \uC2DC\uADF8\uB2C8\uCC98 \uB808\uCF54\uB4DC\uAC00 \uC5C6\uC74C (Workbook \uC2A4\uD2B8\uB9BC \uC190\uC0C1)");
  }
  const firstBof = decodeBof(records[0].data);
  if (firstBof && firstBof.vers !== 1536) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)(
      `XLS: BIFF8(0x0600)\uB9CC \uC9C0\uC6D0 \u2014 \uBCF8 \uD30C\uC77C\uC740 0x${firstBof.vers.toString(16)}`
    );
  }
  const globals = processGlobals(records);
  const warnings = [];
  if (globals.encrypted) {
    return {
      markdown: "",
      blocks: [],
      metadata: { pageCount: globals.sheets.length },
      warnings: [
        {
          message: "XLS \uD30C\uC77C\uC774 \uC554\uD638\uD654\uB418\uC5B4 \uC788\uC5B4 \uD30C\uC2F1\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4",
          code: "PARTIAL_PARSE"
        }
      ]
    };
  }
  const totalSheets = Math.min(globals.sheets.length, MAX_SHEETS2);
  let pageFilter = null;
  if (_optionalChain([options, 'optionalAccess', _94 => _94.pages])) {
    const { parsePageRange: parsePageRange2 } = await Promise.resolve().then(() => _interopRequireWildcard(require("./page-range-P7SDW6LR.cjs")));
    pageFilter = parsePageRange2(options.pages, totalSheets);
  }
  const allBlocks = [];
  for (let i = 0; i < totalSheets; i++) {
    if (pageFilter && !pageFilter.has(i + 1)) continue;
    const meta = globals.sheets[i];
    if (meta.dt !== 0) continue;
    _optionalChain([options, 'optionalAccess', _95 => _95.onProgress, 'optionalCall', _96 => _96(i + 1, totalSheets)]);
    const bofIdx = findSheetBofIndex(records, meta.lbPlyPos);
    if (bofIdx < 0) {
      warnings.push({
        page: i + 1,
        message: `\uC2DC\uD2B8 "${meta.name}" BOF\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C (lbPlyPos=${meta.lbPlyPos})`,
        code: "PARTIAL_PARSE"
      });
      continue;
    }
    const sheetBof = decodeBof(records[bofIdx].data);
    if (sheetBof && sheetBof.dt !== DT_WORKSHEET) {
      continue;
    }
    try {
      const { sheet } = extractSheetCells(records, bofIdx, globals.sst);
      const blocks = sheetToBlocks2(meta.name, sheet, i);
      allBlocks.push(...blocks);
    } catch (e) {
      warnings.push({
        page: i + 1,
        message: `\uC2DC\uD2B8 "${meta.name}" \uD30C\uC2F1 \uC2E4\uD328: ${e instanceof Error ? e.message : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`,
        code: "PARTIAL_PARSE"
      });
    }
  }
  const metadata = {
    pageCount: totalSheets
  };
  return {
    markdown: _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, allBlocks),
    blocks: allBlocks,
    metadata,
    warnings: warnings.length > 0 ? warnings : void 0
  };
}

// src/docx/parser.ts



// src/docx/equation.ts
function lname(el) {
  return el.localName || _optionalChain([el, 'access', _97 => _97.tagName, 'optionalAccess', _98 => _98.replace, 'call', _99 => _99(/^[^:]+:/, "")]) || "";
}
function kids(parent, name) {
  const out = [];
  const nodes = parent.childNodes;
  if (!nodes) return out;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType !== 1) continue;
    const el = n;
    if (lname(el) === name) out.push(el);
  }
  return out;
}
function firstKid(parent, name) {
  const list = kids(parent, name);
  return _nullishCoalesce(list[0], () => ( null));
}
function eachChild(parent) {
  const out = [];
  const nodes = parent.childNodes;
  if (!nodes) return out;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === 1) out.push(nodes[i]);
  }
  return out;
}
function runToLatex(r) {
  let out = "";
  for (const t of kids(r, "t")) out += _nullishCoalesce(t.textContent, () => ( ""));
  return out;
}
var FUNC_NAMES = /* @__PURE__ */ new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "sinh",
  "cosh",
  "tanh",
  "coth",
  "arcsin",
  "arccos",
  "arctan",
  "log",
  "ln",
  "lg",
  "exp",
  "det",
  "dim",
  "gcd",
  "inf",
  "sup",
  "lim",
  "max",
  "min",
  "Pr",
  "arg"
]);
var ACCENT_MAP = {
  "\u0302": "\\hat",
  // U+0302 COMBINING CIRCUMFLEX
  "\u0303": "\\tilde",
  // U+0303
  "\u0304": "\\bar",
  // U+0304
  "\u0307": "\\dot",
  // U+0307
  "\u0308": "\\ddot",
  // U+0308
  "\u0301": "\\acute",
  // U+0301
  "\u0300": "\\grave",
  // U+0300
  "\u0306": "\\breve",
  // U+0306
  "\u030C": "\\check",
  // U+030C
  "\u20D7": "\\vec",
  // U+20D7 COMBINING RIGHT ARROW ABOVE
  "\u2192": "\\vec"
};
var NARY_MAP = {
  "\u2211": "\\sum",
  "\u220F": "\\prod",
  "\u2210": "\\coprod",
  "\u222B": "\\int",
  "\u222C": "\\iint",
  "\u222D": "\\iiint",
  "\u222E": "\\oint",
  "\u222F": "\\oiint",
  "\u2230": "\\oiiint",
  "\u22C3": "\\bigcup",
  "\u22C2": "\\bigcap",
  "\u2A01": "\\bigoplus",
  "\u2A02": "\\bigotimes",
  "\u2A00": "\\bigodot"
};
function mapDelim(ch, isLeft) {
  const l = {
    "(": "(",
    "[": "[",
    "{": "\\{",
    "\u27E8": "\\langle",
    "|": "|",
    "\u2016": "\\|",
    "\u230A": "\\lfloor",
    "\u2308": "\\lceil",
    "": "."
  };
  const r = {
    ")": ")",
    "]": "]",
    "}": "\\}",
    "\u27E9": "\\rangle",
    "|": "|",
    "\u2016": "\\|",
    "\u230B": "\\rfloor",
    "\u2309": "\\rceil",
    "": "."
  };
  const map = isLeft ? l : r;
  return _nullishCoalesce(map[ch], () => ( ch));
}
function grp(body) {
  const s = body.trim();
  if (s.length === 0) return "{}";
  if (s.startsWith("{") && s.endsWith("}")) return s;
  return "{" + s + "}";
}
function childrenToLatex(parent) {
  let out = "";
  for (const ch of eachChild(parent)) {
    out += nodeToLatex(ch);
  }
  return out;
}
function nodeToLatex(el) {
  const tag = lname(el);
  switch (tag) {
    case "r":
      return runToLatex(el);
    case "e":
    // generic container (인자로 쓰임) — 자식 연결
    case "num":
    case "den":
    case "sub":
    case "sup":
    case "deg":
    case "lim":
    case "fName":
      return childrenToLatex(el);
    // 분수
    case "f": {
      const n = firstKid(el, "num");
      const d = firstKid(el, "den");
      const num4 = n ? childrenToLatex(n) : "";
      const den = d ? childrenToLatex(d) : "";
      return "\\frac" + grp(num4) + grp(den);
    }
    // 첨자
    case "sSup": {
      const e = firstKid(el, "e");
      const sup = firstKid(el, "sup");
      return grp(e ? childrenToLatex(e) : "") + "^" + grp(sup ? childrenToLatex(sup) : "");
    }
    case "sSub": {
      const e = firstKid(el, "e");
      const sub = firstKid(el, "sub");
      return grp(e ? childrenToLatex(e) : "") + "_" + grp(sub ? childrenToLatex(sub) : "");
    }
    case "sSubSup": {
      const e = firstKid(el, "e");
      const sub = firstKid(el, "sub");
      const sup = firstKid(el, "sup");
      return grp(e ? childrenToLatex(e) : "") + "_" + grp(sub ? childrenToLatex(sub) : "") + "^" + grp(sup ? childrenToLatex(sup) : "");
    }
    case "sPre": {
      const sub = firstKid(el, "sub");
      const sup = firstKid(el, "sup");
      const e = firstKid(el, "e");
      const preSub = sub ? grp(childrenToLatex(sub)) : "{}";
      const preSup = sup ? grp(childrenToLatex(sup)) : "{}";
      const body = e ? childrenToLatex(e) : "";
      return "{}_" + preSub + "^" + preSup + grp(body);
    }
    // 근호
    case "rad": {
      const deg = firstKid(el, "deg");
      const e = firstKid(el, "e");
      const body = e ? childrenToLatex(e) : "";
      const radPr = firstKid(el, "radPr");
      let hide = false;
      if (radPr) {
        const degHide = firstKid(radPr, "degHide");
        if (degHide) {
          const val = _nullishCoalesce(degHide.getAttribute("m:val"), () => ( degHide.getAttribute("val")));
          hide = val === "1" || val === "on" || val === "true";
        }
      }
      const degStr = !hide && deg ? childrenToLatex(deg).trim() : "";
      return degStr ? "\\sqrt[" + degStr + "]" + grp(body) : "\\sqrt" + grp(body);
    }
    // n-ary 연산자 (sum, prod, int, …)
    case "nary": {
      const naryPr = firstKid(el, "naryPr");
      let op = "\\int";
      let subHide = false;
      let supHide = false;
      let limLoc = "";
      if (naryPr) {
        const chr = firstKid(naryPr, "chr");
        if (chr) {
          const v = _nullishCoalesce(_nullishCoalesce(chr.getAttribute("m:val"), () => ( chr.getAttribute("val"))), () => ( ""));
          if (v && NARY_MAP[v]) op = NARY_MAP[v];
          else if (v) op = v;
        } else {
          op = "\\int";
        }
        const sh = firstKid(naryPr, "subHide");
        const ph = firstKid(naryPr, "supHide");
        if (sh) subHide = (_nullishCoalesce(sh.getAttribute("m:val"), () => ( sh.getAttribute("val")))) !== "0";
        if (ph) supHide = (_nullishCoalesce(ph.getAttribute("m:val"), () => ( ph.getAttribute("val")))) !== "0";
        const ll = firstKid(naryPr, "limLoc");
        if (ll) limLoc = _nullishCoalesce(_nullishCoalesce(ll.getAttribute("m:val"), () => ( ll.getAttribute("val"))), () => ( ""));
      }
      const sub = firstKid(el, "sub");
      const sup = firstKid(el, "sup");
      const e = firstKid(el, "e");
      const subStr = !subHide && sub ? childrenToLatex(sub) : "";
      const supStr = !supHide && sup ? childrenToLatex(sup) : "";
      const body = e ? childrenToLatex(e) : "";
      let head = op;
      if (limLoc === "undOvr") {
        if (subStr) head += "_" + grp(subStr);
        if (supStr) head += "^" + grp(supStr);
      } else {
        if (subStr) head += "_" + grp(subStr);
        if (supStr) head += "^" + grp(supStr);
      }
      return head + " " + body;
    }
    // 괄호 (delimiter)
    case "d": {
      const dPr = firstKid(el, "dPr");
      let beg = "(";
      let end = ")";
      let sep = ",";
      if (dPr) {
        const begChr = firstKid(dPr, "begChr");
        const endChr = firstKid(dPr, "endChr");
        const sepChr = firstKid(dPr, "sepChr");
        if (begChr) beg = _nullishCoalesce(_nullishCoalesce(begChr.getAttribute("m:val"), () => ( begChr.getAttribute("val"))), () => ( beg));
        if (endChr) end = _nullishCoalesce(_nullishCoalesce(endChr.getAttribute("m:val"), () => ( endChr.getAttribute("val"))), () => ( end));
        if (sepChr) sep = _nullishCoalesce(_nullishCoalesce(sepChr.getAttribute("m:val"), () => ( sepChr.getAttribute("val"))), () => ( sep));
      }
      const items = kids(el, "e").map(childrenToLatex);
      const body = items.join(sep);
      return "\\left" + mapDelim(beg, true) + body + "\\right" + mapDelim(end, false);
    }
    // 행렬
    case "m": {
      const rows = [];
      for (const mr of kids(el, "mr")) {
        const cells = kids(mr, "e").map(childrenToLatex);
        rows.push(cells.join(" & "));
      }
      return "\\begin{matrix}" + rows.join(" \\\\ ") + "\\end{matrix}";
    }
    // 상자/박스 (acc 와 유사하지만 bar 가 아닌 box)
    case "box":
      return childrenToLatex(el);
    // 함수 적용 (sin, cos, log …)
    case "func": {
      const fn = firstKid(el, "fName");
      const e = firstKid(el, "e");
      const fnStr = fn ? childrenToLatex(fn).trim() : "";
      const body = e ? childrenToLatex(e) : "";
      const fnLatex = FUNC_NAMES.has(fnStr) ? "\\" + fnStr : fnStr;
      return fnLatex + grp(body);
    }
    // 악센트 (hat/bar/vec/…)
    case "acc": {
      const accPr = firstKid(el, "accPr");
      let chr = "";
      if (accPr) {
        const chrEl = firstKid(accPr, "chr");
        if (chrEl) chr = _nullishCoalesce(_nullishCoalesce(chrEl.getAttribute("m:val"), () => ( chrEl.getAttribute("val"))), () => ( ""));
      }
      if (!chr) chr = "\u0302";
      const e = firstKid(el, "e");
      const body = e ? childrenToLatex(e) : "";
      const cmd = _nullishCoalesce(ACCENT_MAP[chr], () => ( "\\hat"));
      return cmd + grp(body);
    }
    // bar (위/아래 줄)
    case "bar": {
      const barPr = firstKid(el, "barPr");
      let pos = "top";
      if (barPr) {
        const posEl = firstKid(barPr, "pos");
        if (posEl) pos = _nullishCoalesce(_nullishCoalesce(posEl.getAttribute("m:val"), () => ( posEl.getAttribute("val"))), () => ( pos));
      }
      const e = firstKid(el, "e");
      const body = e ? childrenToLatex(e) : "";
      return (pos === "bot" ? "\\underline" : "\\overline") + grp(body);
    }
    // lim 위/아래
    case "limLow": {
      const e = firstKid(el, "e");
      const lim = firstKid(el, "lim");
      const base = e ? childrenToLatex(e).trim() : "";
      const below = lim ? childrenToLatex(lim) : "";
      if (FUNC_NAMES.has(base)) return "\\" + base + "_" + grp(below);
      return base + "_" + grp(below);
    }
    case "limUpp": {
      const e = firstKid(el, "e");
      const lim = firstKid(el, "lim");
      const base = e ? childrenToLatex(e).trim() : "";
      const above = lim ? childrenToLatex(lim) : "";
      if (FUNC_NAMES.has(base)) return "\\" + base + "^" + grp(above);
      return base + "^" + grp(above);
    }
    // group character (over/underset 비슷)
    case "groupChr":
      return childrenToLatex(_nullishCoalesce(firstKid(el, "e"), () => ( el)));
    // box/borderBox/phantom/eqArr/… 는 자식 본문만 유지
    case "borderBox":
    case "phant":
    case "eqArr":
      return childrenToLatex(el);
    // 최상위 컨테이너
    case "oMath":
    case "oMathPara":
      return childrenToLatex(el);
    // 메타 — 속성만 들어있으므로 출력 제외
    case "rPr":
    case "fPr":
    case "sSubPr":
    case "sSupPr":
    case "sSubSupPr":
    case "radPr":
    case "naryPr":
    case "dPr":
    case "accPr":
    case "barPr":
    case "funcPr":
    case "mPr":
    case "ctrlPr":
      return "";
    default:
      return childrenToLatex(el);
  }
}
function isOmmlRoot(el) {
  const t = lname(el);
  return t === "oMath" || t === "oMathPara";
}
function ommlElementToLatex(el) {
  if (!isOmmlRoot(el)) return "";
  const raw = childrenToLatex(el);
  return raw.replace(/\s+/g, " ").trim();
}
function isDisplayMath(el) {
  return lname(el) === "oMathPara";
}

// src/docx/parser.ts
var MAX_DECOMPRESS_SIZE4 = 100 * 1024 * 1024;
function matchesLocal(el, localName2) {
  return el.localName === localName2 || (_nullishCoalesce(_optionalChain([el, 'access', _100 => _100.tagName, 'optionalAccess', _101 => _101.endsWith, 'call', _102 => _102(`:${localName2}`)]), () => ( false)));
}
function effectiveChildElements(parent) {
  const result = [];
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.nodeType !== 1) continue;
    const el = node;
    if (matchesLocal(el, "sdt")) {
      for (let j = 0; j < el.childNodes.length; j++) {
        const c = el.childNodes[j];
        if (c.nodeType === 1 && matchesLocal(c, "sdtContent")) {
          result.push(...effectiveChildElements(c));
        }
      }
    } else {
      result.push(el);
    }
  }
  return result;
}
function getChildElements(parent, localName2) {
  return effectiveChildElements(parent).filter((el) => matchesLocal(el, localName2));
}
function findElements(parent, localName2) {
  const result = [];
  const walk = (node) => {
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 1) {
        const el = child;
        if (el.localName === localName2 || _optionalChain([el, 'access', _103 => _103.tagName, 'optionalAccess', _104 => _104.endsWith, 'call', _105 => _105(`:${localName2}`)])) {
          result.push(el);
        }
        walk(el);
      }
    }
  };
  walk(parent);
  return result;
}
function getAttr(el, localName2) {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (attr.localName === localName2 || attr.name === localName2) return attr.value;
  }
  return null;
}
function parseXml2(text) {
  return new (0, _xmldom.DOMParser)().parseFromString(_chunkR2H34FY5cjs.stripDtd.call(void 0, text), "text/xml");
}
function parseStyles(xml) {
  const doc = parseXml2(xml);
  const styles = /* @__PURE__ */ new Map();
  const styleElements = findElements(doc, "style");
  for (const el of styleElements) {
    const styleId = getAttr(el, "styleId");
    if (!styleId) continue;
    const nameEls = getChildElements(el, "name");
    const name = nameEls.length > 0 ? _nullishCoalesce(getAttr(nameEls[0], "val"), () => ( "")) : "";
    const basedOnEls = getChildElements(el, "basedOn");
    const basedOn = basedOnEls.length > 0 ? _nullishCoalesce(getAttr(basedOnEls[0], "val"), () => ( void 0)) : void 0;
    const pPrEls = getChildElements(el, "pPr");
    let outlineLevel;
    if (pPrEls.length > 0) {
      const outlineEls = getChildElements(pPrEls[0], "outlineLvl");
      if (outlineEls.length > 0) {
        const val = getAttr(outlineEls[0], "val");
        if (val !== null) outlineLevel = parseInt(val, 10);
      }
    }
    if (outlineLevel === void 0) {
      const headingMatch = name.match(/^(?:heading|Heading)\s*(\d+)$/i);
      if (headingMatch) outlineLevel = parseInt(headingMatch[1], 10) - 1;
    }
    styles.set(styleId, { name, basedOn, outlineLevel });
  }
  return styles;
}
function parseNumbering(xml) {
  const doc = parseXml2(xml);
  const abstractNums = /* @__PURE__ */ new Map();
  const abstractElements = findElements(doc, "abstractNum");
  for (const el of abstractElements) {
    const abstractNumId = getAttr(el, "abstractNumId");
    if (!abstractNumId) continue;
    const levels = /* @__PURE__ */ new Map();
    const lvlElements = getChildElements(el, "lvl");
    for (const lvl of lvlElements) {
      const ilvl = parseInt(_nullishCoalesce(getAttr(lvl, "ilvl"), () => ( "0")), 10);
      const numFmtEls = getChildElements(lvl, "numFmt");
      const numFmt = numFmtEls.length > 0 ? _nullishCoalesce(getAttr(numFmtEls[0], "val"), () => ( "bullet")) : "bullet";
      levels.set(ilvl, { numFmt, level: ilvl });
    }
    abstractNums.set(abstractNumId, levels);
  }
  const nums = /* @__PURE__ */ new Map();
  const numElements = findElements(doc, "num");
  for (const el of numElements) {
    const numId = getAttr(el, "numId");
    if (!numId) continue;
    const abstractRefs = getChildElements(el, "abstractNumId");
    if (abstractRefs.length > 0) {
      const ref = getAttr(abstractRefs[0], "val");
      if (ref && abstractNums.has(ref)) {
        nums.set(numId, abstractNums.get(ref));
      }
    }
  }
  return nums;
}
function parseRels2(xml) {
  const doc = parseXml2(xml);
  const map = /* @__PURE__ */ new Map();
  const rels = findElements(doc, "Relationship");
  for (const rel of rels) {
    const id = getAttr(rel, "Id");
    const target = getAttr(rel, "Target");
    if (id && target) map.set(id, target);
  }
  return map;
}
function parseFootnotes(xml) {
  const doc = parseXml2(xml);
  const notes = /* @__PURE__ */ new Map();
  const fnElements = findElements(doc, "footnote");
  for (const fn of fnElements) {
    const id = getAttr(fn, "id");
    if (!id || id === "0" || id === "-1") continue;
    const texts = [];
    const pElements = findElements(fn, "p");
    for (const p of pElements) {
      const runs = findElements(p, "r");
      for (const r of runs) {
        const tElements = getChildElements(r, "t");
        for (const t of tElements) texts.push(_nullishCoalesce(t.textContent, () => ( "")));
      }
    }
    notes.set(id, texts.join("").trim());
  }
  return notes;
}
function collectOmmlRoots(p) {
  const out = [];
  const walk = (node) => {
    const children = node.childNodes;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType !== 1) continue;
      const el = child;
      const tag = el.localName || _optionalChain([el, 'access', _106 => _106.tagName, 'optionalAccess', _107 => _107.replace, 'call', _108 => _108(/^[^:]+:/, "")]) || "";
      if (tag === "oMath" || tag === "oMathPara") {
        out.push(el);
      } else if (tag === "txbxContent" || tag === "Fallback") {
      } else {
        walk(el);
      }
    }
  };
  walk(p);
  return out;
}
function extractRun(r) {
  const tElements = getChildElements(r, "t");
  const text = tElements.map((t) => _nullishCoalesce(t.textContent, () => ( ""))).join("");
  let bold = false;
  let italic = false;
  const rPrEls = getChildElements(r, "rPr");
  if (rPrEls.length > 0) {
    bold = getChildElements(rPrEls[0], "b").length > 0;
    italic = getChildElements(rPrEls[0], "i").length > 0;
  }
  return { text, bold, italic };
}
function parseParagraph2(p, styles, numbering, footnotes, rels) {
  const pPrEls = getChildElements(p, "pPr");
  let styleId = "";
  let numId = "";
  let ilvl = 0;
  if (pPrEls.length > 0) {
    const pStyleEls = getChildElements(pPrEls[0], "pStyle");
    if (pStyleEls.length > 0) styleId = _nullishCoalesce(getAttr(pStyleEls[0], "val"), () => ( ""));
    const numPrEls = getChildElements(pPrEls[0], "numPr");
    if (numPrEls.length > 0) {
      const numIdEls = getChildElements(numPrEls[0], "numId");
      const ilvlEls = getChildElements(numPrEls[0], "ilvl");
      numId = numIdEls.length > 0 ? _nullishCoalesce(getAttr(numIdEls[0], "val"), () => ( "")) : "";
      ilvl = ilvlEls.length > 0 ? parseInt(_nullishCoalesce(getAttr(ilvlEls[0], "val"), () => ( "0")), 10) : 0;
    }
  }
  const parts = [];
  let hasBold = false;
  let hasItalic = false;
  let href;
  let footnoteText;
  const hyperlinks = getChildElements(p, "hyperlink");
  const hyperlinkTexts = /* @__PURE__ */ new Set();
  for (const hl of hyperlinks) {
    const rId = getAttr(hl, "id");
    const hlText = [];
    const runs2 = findElements(hl, "r");
    for (const r of runs2) {
      const result = extractRun(r);
      hlText.push(result.text);
    }
    const text2 = hlText.join("");
    if (text2) {
      hyperlinkTexts.add(text2);
      if (rId && rels.has(rId)) {
        href = rels.get(rId);
        parts.push(text2);
      } else {
        parts.push(text2);
      }
    }
  }
  const runs = getChildElements(p, "r");
  for (const r of runs) {
    if (r.parentNode && r.parentNode.localName === "hyperlink") continue;
    const result = extractRun(r);
    if (result.bold) hasBold = true;
    if (result.italic) hasItalic = true;
    const fnRefEls = getChildElements(r, "footnoteReference");
    if (fnRefEls.length > 0) {
      const fnId = getAttr(fnRefEls[0], "id");
      if (fnId && footnotes.has(fnId)) {
        footnoteText = footnotes.get(fnId);
      }
    }
    if (result.text) parts.push(result.text);
  }
  for (const om of collectOmmlRoots(p)) {
    const latex = ommlElementToLatex(om);
    if (!latex) continue;
    if (isDisplayMath(om)) parts.push(" $$" + latex + "$$ ");
    else parts.push(" $" + latex + "$ ");
  }
  const text = parts.join("").replace(/[ \t]{2,}/g, " ").trim();
  if (!text) return null;
  const style = styles.get(styleId);
  if (_optionalChain([style, 'optionalAccess', _109 => _109.outlineLevel]) !== void 0 && style.outlineLevel >= 0 && style.outlineLevel <= 5) {
    return {
      type: "heading",
      text,
      level: style.outlineLevel + 1
    };
  }
  if (numId && numId !== "0") {
    const numDef = numbering.get(numId);
    const levelInfo = _optionalChain([numDef, 'optionalAccess', _110 => _110.get, 'call', _111 => _111(ilvl)]);
    const listType = _optionalChain([levelInfo, 'optionalAccess', _112 => _112.numFmt]) === "bullet" ? "unordered" : "ordered";
    return { type: "list", text, listType };
  }
  const block = { type: "paragraph", text };
  if (hasBold || hasItalic) {
    block.style = { bold: hasBold || void 0, italic: hasItalic || void 0 };
  }
  if (href) block.href = href;
  if (footnoteText) block.footnoteText = footnoteText;
  return block;
}
function collectTextboxParagraphs(node, inTxbx = false, out = [], depth = 0) {
  if (depth > 40) return out;
  for (const el of effectiveChildElements(node)) {
    if (matchesLocal(el, "Fallback")) continue;
    const nowIn = inTxbx || matchesLocal(el, "txbxContent");
    if (nowIn && matchesLocal(el, "p")) out.push(el);
    collectTextboxParagraphs(el, nowIn, out, depth + 1);
  }
  return out;
}
function parseTable(tbl, styles, numbering, footnotes, rels) {
  const trElements = getChildElements(tbl, "tr");
  if (trElements.length === 0) return null;
  const rawRows = [];
  for (const tr of trElements) {
    const row = [];
    let col = 0;
    const trPrEls = getChildElements(tr, "trPr");
    if (trPrEls.length > 0) {
      const gridBeforeEls = getChildElements(trPrEls[0], "gridBefore");
      if (gridBeforeEls.length > 0) {
        col = Math.max(0, parseInt(_nullishCoalesce(getAttr(gridBeforeEls[0], "val"), () => ( "0")), 10) || 0);
      }
    }
    for (const tc of getChildElements(tr, "tc")) {
      let colSpan = 1;
      let vMerge = null;
      const tcPrEls = getChildElements(tc, "tcPr");
      if (tcPrEls.length > 0) {
        const gridSpanEls = getChildElements(tcPrEls[0], "gridSpan");
        if (gridSpanEls.length > 0) {
          colSpan = parseInt(_nullishCoalesce(getAttr(gridSpanEls[0], "val"), () => ( "1")), 10) || 1;
        }
        const vMergeEls = getChildElements(tcPrEls[0], "vMerge");
        if (vMergeEls.length > 0) {
          vMerge = getAttr(vMergeEls[0], "val") === "restart" ? "restart" : "continue";
        }
      }
      const text = collectCellText(tc, styles, numbering, footnotes, rels, 0).join("\n");
      row.push({ col, colSpan, vMerge, text });
      col += colSpan;
    }
    rawRows.push(row);
  }
  for (let r = 0; r < rawRows.length; r++) {
    for (const cell of rawRows[r]) {
      if (cell.vMerge !== "continue" || !cell.text) continue;
      let start;
      for (let pr = r - 1; pr >= 0 && !start; pr--) {
        start = rawRows[pr].find((pc) => pc.col === cell.col && pc.vMerge !== "continue");
      }
      if (start) {
        start.text = start.text ? `${start.text}
${cell.text}` : cell.text;
        cell.text = "";
      } else {
        cell.vMerge = null;
      }
    }
  }
  const cellRows = rawRows.map(
    (row, r) => row.filter((cell) => cell.vMerge !== "continue").map((cell) => {
      let rowSpan = 1;
      if (cell.vMerge === "restart") {
        for (let nr = r + 1; nr < rawRows.length; nr++) {
          if (!rawRows[nr].some((nc) => nc.col === cell.col && nc.vMerge === "continue")) break;
          rowSpan++;
        }
      }
      return { text: cell.text, colSpan: cell.colSpan, rowSpan, colAddr: cell.col, rowAddr: r };
    })
  );
  const table = _chunkR2H34FY5cjs.buildTable.call(void 0, cellRows);
  if (table.rows === 0 || table.cols === 0) return null;
  return { type: "table", table };
}
function collectCellText(tc, styles, numbering, footnotes, rels, depth) {
  const parts = [];
  if (depth > 20) return parts;
  for (const el of effectiveChildElements(tc)) {
    if (matchesLocal(el, "p")) {
      const block = parseParagraph2(el, styles, numbering, footnotes, rels);
      if (_optionalChain([block, 'optionalAccess', _113 => _113.text])) parts.push(block.text);
      for (const tp of collectTextboxParagraphs(el)) {
        const tb = parseParagraph2(tp, styles, numbering, footnotes, rels);
        if (_optionalChain([tb, 'optionalAccess', _114 => _114.text])) parts.push(tb.text);
      }
    } else if (matchesLocal(el, "tbl")) {
      for (const tr of getChildElements(el, "tr")) {
        for (const nestedTc of getChildElements(tr, "tc")) {
          parts.push(...collectCellText(nestedTc, styles, numbering, footnotes, rels, depth + 1));
        }
      }
    }
  }
  return parts;
}
async function extractImages(zip, rels, doc, warnings) {
  const blocks = [];
  const images = [];
  const drawingElements = findElements(doc.documentElement, "drawing");
  let imgIdx = 0;
  for (const drawing of drawingElements) {
    const blips = findElements(drawing, "blip");
    for (const blip of blips) {
      const embedId = getAttr(blip, "embed");
      if (!embedId) continue;
      const target = rels.get(embedId);
      if (!target) continue;
      const imgPath = target.startsWith("/") ? target.slice(1) : target.startsWith("word/") ? target : `word/${target}`;
      const imgFile = zip.file(imgPath);
      if (!imgFile) continue;
      try {
        const data = await imgFile.async("uint8array");
        imgIdx++;
        const ext = _nullishCoalesce(_optionalChain([imgPath, 'access', _115 => _115.split, 'call', _116 => _116("."), 'access', _117 => _117.pop, 'call', _118 => _118(), 'optionalAccess', _119 => _119.toLowerCase, 'call', _120 => _120()]), () => ( "png"));
        const mimeMap = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          bmp: "image/bmp",
          wmf: "image/wmf",
          emf: "image/emf"
        };
        const filename = `image_${String(imgIdx).padStart(3, "0")}.${ext}`;
        images.push({ filename, data, mimeType: _nullishCoalesce(mimeMap[ext], () => ( "image/png")) });
        blocks.push({ type: "image", text: filename });
      } catch (err) {
        warnings.push({
          code: "SKIPPED_IMAGE",
          message: `DOCX \uC774\uBBF8\uC9C0 \uCD94\uCD9C \uC2E4\uD328 (${imgPath}): ${err instanceof Error ? err.message : String(err)}`
        });
      }
    }
  }
  return { blocks, images };
}
async function parseDocxDocument(buffer, options) {
  _chunkR2H34FY5cjs.precheckZipSize.call(void 0, buffer, MAX_DECOMPRESS_SIZE4);
  const zip = await _jszip2.default.loadAsync(buffer);
  const warnings = [];
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 DOCX \uD30C\uC77C: word/document.xml\uC774 \uC5C6\uC2B5\uB2C8\uB2E4");
  }
  let rels = /* @__PURE__ */ new Map();
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (relsFile) {
    rels = parseRels2(await relsFile.async("text"));
  }
  let styles = /* @__PURE__ */ new Map();
  const stylesFile = zip.file("word/styles.xml");
  if (stylesFile) {
    try {
      styles = parseStyles(await stylesFile.async("text"));
    } catch (err) {
      warnings.push({
        code: "PARTIAL_PARSE",
        message: `DOCX \uC2A4\uD0C0\uC77C(styles.xml) \uD30C\uC2F1 \uC2E4\uD328 \u2014 \uAE30\uBCF8 \uC2A4\uD0C0\uC77C\uB85C \uACC4\uC18D: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  let numbering = /* @__PURE__ */ new Map();
  const numFile = zip.file("word/numbering.xml");
  if (numFile) {
    try {
      numbering = parseNumbering(await numFile.async("text"));
    } catch (err) {
      warnings.push({
        code: "PARTIAL_PARSE",
        message: `DOCX \uBC88\uD638\uB9E4\uAE30\uAE30(numbering.xml) \uD30C\uC2F1 \uC2E4\uD328 \u2014 \uBAA9\uB85D \uBC88\uD638 \uC0DD\uB7B5: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  let footnotes = /* @__PURE__ */ new Map();
  const fnFile = zip.file("word/footnotes.xml");
  if (fnFile) {
    try {
      footnotes = parseFootnotes(await fnFile.async("text"));
    } catch (err) {
      warnings.push({
        code: "PARTIAL_PARSE",
        message: `DOCX \uAC01\uC8FC(footnotes.xml) \uD30C\uC2F1 \uC2E4\uD328 \u2014 \uAC01\uC8FC \uC0DD\uB7B5: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  const docXml = await docFile.async("text");
  const doc = parseXml2(docXml);
  const body = findElements(doc, "body");
  if (body.length === 0) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("DOCX \uBCF8\uBB38(w:body)\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  }
  const blocks = [];
  const bodyEl = body[0];
  const topLevel = effectiveChildElements(bodyEl);
  for (const el of topLevel) {
    const localName2 = _nullishCoalesce(el.localName, () => ( _optionalChain([el, 'access', _121 => _121.tagName, 'optionalAccess', _122 => _122.split, 'call', _123 => _123(":"), 'access', _124 => _124.pop, 'call', _125 => _125()])));
    if (localName2 === "p") {
      const block = parseParagraph2(el, styles, numbering, footnotes, rels);
      if (block) blocks.push(block);
      for (const tp of collectTextboxParagraphs(el)) {
        const tb = parseParagraph2(tp, styles, numbering, footnotes, rels);
        if (tb) blocks.push(tb);
      }
    } else if (localName2 === "tbl") {
      const block = parseTable(el, styles, numbering, footnotes, rels);
      if (block) blocks.push(block);
    }
  }
  const { blocks: imgBlocks, images } = await extractImages(zip, rels, doc, warnings);
  const metadata = {};
  const coreFile = zip.file("docProps/core.xml");
  if (coreFile) {
    try {
      const coreXml = await coreFile.async("text");
      const coreDoc = parseXml2(coreXml);
      const getFirst = (tag) => {
        const els = coreDoc.getElementsByTagName(tag);
        return els.length > 0 ? (_nullishCoalesce(els[0].textContent, () => ( ""))).trim() : void 0;
      };
      metadata.title = getFirst("dc:title") || getFirst("dcterms:title");
      metadata.author = getFirst("dc:creator");
      metadata.description = getFirst("dc:description");
      const created = getFirst("dcterms:created");
      if (created) metadata.createdAt = created;
      const modified = getFirst("dcterms:modified");
      if (modified) metadata.modifiedAt = modified;
    } catch (err) {
      warnings.push({
        code: "PARTIAL_PARSE",
        message: `DOCX \uBA54\uD0C0\uB370\uC774\uD130(core.xml) \uD30C\uC2F1 \uC2E4\uD328: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  const outline = blocks.filter((b) => b.type === "heading").map((b) => ({ level: _nullishCoalesce(b.level, () => ( 2)), text: _nullishCoalesce(b.text, () => ( "")) }));
  const markdown = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, blocks);
  return {
    markdown,
    blocks,
    metadata,
    outline: outline.length > 0 ? outline : void 0,
    warnings: warnings.length > 0 ? warnings : void 0,
    images: images.length > 0 ? images : void 0
  };
}

// src/hwpml/parser.ts

var MAX_XML_DEPTH2 = 200;
var MAX_TABLE_ROWS = 5e3;
var MAX_TABLE_COLS = 500;
var MAX_HWPML_BYTES = 50 * 1024 * 1024;
function parseHwpmlDocument(buffer, options) {
  if (buffer.byteLength > MAX_HWPML_BYTES) {
    throw new Error(`HWPML \uD30C\uC77C \uD06C\uAE30 \uCD08\uACFC (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB > 50MB)`);
  }
  const text = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
  const normalized = text.replace(/&nbsp;/g, "&#160;");
  const xml = _chunkR2H34FY5cjs.stripDtd.call(void 0, normalized);
  const warnings = [];
  const parser = new (0, _xmldom.DOMParser)({
    onError: (_level, msg2) => {
      warnings.push({ message: `HWPML XML \uD30C\uC2F1 \uACBD\uACE0: ${msg2}`, code: "MALFORMED_XML" });
    }
  });
  const doc = parser.parseFromString(xml, "text/xml");
  if (!doc.documentElement) {
    return { markdown: "", blocks: [], warnings };
  }
  const root = doc.documentElement;
  const metadata = {};
  const docSummary = findChild(root, "DOCSUMMARY");
  if (docSummary) {
    const title = findChild(docSummary, "TITLE");
    const author = findChild(docSummary, "AUTHOR");
    const date = findChild(docSummary, "DATE");
    if (title) metadata.title = textContent(title).trim();
    if (author) metadata.author = textContent(author).trim();
    if (date) metadata.createdAt = textContent(date).trim() || void 0;
  }
  const paraShapeMap = buildParaShapeMap(root);
  const body = findChild(root, "BODY");
  if (!body) {
    return { markdown: "", blocks: [], metadata, warnings };
  }
  const blocks = [];
  const pageFilter = _optionalChain([options, 'optionalAccess', _126 => _126.pages]) ? _chunkDCZVOIEOcjs.parsePageRange.call(void 0, options.pages, countSections(body)) : null;
  let sectionIdx = 0;
  const children = body.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType !== 1) continue;
    if (localName(el) !== "SECTION") continue;
    sectionIdx++;
    if (pageFilter && !pageFilter.has(sectionIdx)) continue;
    parseSection2(el, blocks, paraShapeMap, sectionIdx, warnings);
  }
  const outline = blocks.filter((b) => b.type === "heading" && b.text).map((b) => ({ level: _nullishCoalesce(b.level, () => ( 1)), text: b.text, pageNumber: b.pageNumber }));
  const markdown = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, blocks);
  return {
    markdown,
    blocks,
    metadata: Object.keys(metadata).length > 0 ? metadata : void 0,
    outline: outline.length > 0 ? outline : void 0,
    warnings: warnings.length > 0 ? warnings : void 0
  };
}
function buildParaShapeMap(root) {
  const map = /* @__PURE__ */ new Map();
  const head = findChild(root, "HEAD");
  if (!head) return map;
  const mappingTable = findChild(head, "MAPPINGTABLE");
  if (!mappingTable) return map;
  const paraShapeList = findChild(mappingTable, "PARASHAPELIST");
  if (!paraShapeList) return map;
  const children = paraShapeList.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType !== 1 || localName(el) !== "PARASHAPE") continue;
    const id = _nullishCoalesce(el.getAttribute("Id"), () => ( ""));
    const headingType = _nullishCoalesce(el.getAttribute("HeadingType"), () => ( "None"));
    const level = parseInt(_nullishCoalesce(el.getAttribute("Level"), () => ( "0")), 10);
    let headingLevel = null;
    if (headingType === "Outline") {
      const safeLevel = isNaN(level) ? 0 : Math.max(0, level);
      headingLevel = Math.min(safeLevel + 1, 6);
    }
    map.set(id, { headingLevel });
  }
  return map;
}
function parseSection2(section, blocks, paraShapeMap, sectionNum, warnings) {
  walkContent(section, blocks, paraShapeMap, sectionNum, warnings, false);
}
function walkContent(node, blocks, paraShapeMap, sectionNum, warnings, inHeaderFooter, depth = 0) {
  if (depth > MAX_XML_DEPTH2) return;
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType !== 1) continue;
    const tag = localName(el);
    if (tag === "HEADER" || tag === "FOOTER") {
      continue;
    }
    if (tag === "P") {
      if (!inHeaderFooter) {
        parseParagraph3(el, blocks, paraShapeMap, sectionNum);
        walkTablesInP(el, blocks, paraShapeMap, sectionNum, warnings);
      }
      continue;
    }
    if (tag === "TABLE") {
      if (!inHeaderFooter) {
        parseTable2(el, blocks, paraShapeMap, sectionNum, warnings);
      }
      continue;
    }
    if (tag === "PARALIST" || tag === "SECTION" || tag === "COLDEF") {
      walkContent(el, blocks, paraShapeMap, sectionNum, warnings, inHeaderFooter, depth + 1);
      continue;
    }
    walkContent(el, blocks, paraShapeMap, sectionNum, warnings, inHeaderFooter, depth + 1);
  }
}
function walkTablesInP(node, blocks, paraShapeMap, sectionNum, warnings, depth = 0) {
  if (depth > MAX_XML_DEPTH2) return;
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType !== 1) continue;
    const tag = localName(el);
    if (tag === "TABLE") {
      parseTable2(el, blocks, paraShapeMap, sectionNum, warnings);
      continue;
    }
    if (tag === "FOOTNOTE" || tag === "ENDNOTE" || tag === "HEADER" || tag === "FOOTER") continue;
    walkTablesInP(el, blocks, paraShapeMap, sectionNum, warnings, depth + 1);
  }
}
function parseParagraph3(el, blocks, paraShapeMap, sectionNum) {
  const paraShapeId = _nullishCoalesce(el.getAttribute("ParaShape"), () => ( ""));
  const shapeInfo = paraShapeMap.get(paraShapeId);
  const text = extractParagraphText(el);
  if (!text) return;
  if (_optionalChain([shapeInfo, 'optionalAccess', _127 => _127.headingLevel]) != null) {
    blocks.push({ type: "heading", text, level: shapeInfo.headingLevel, pageNumber: sectionNum });
  } else {
    blocks.push({ type: "paragraph", text, pageNumber: sectionNum });
  }
}
function extractParagraphText(p) {
  const parts = [];
  collectCharText(p, parts);
  return parts.join("").trim();
}
function collectCharText(node, parts, depth = 0) {
  if (depth > MAX_XML_DEPTH2) return;
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType !== 1) continue;
    const tag = localName(el);
    if (tag === "CHAR") {
      const t = textContent(el);
      if (t) parts.push(t);
    } else if (tag === "TABLE" || tag === "PICTURE" || tag === "SHAPEOBJECT") {
    } else if (tag === "AUTONUM") {
    } else {
      collectCharText(el, parts, depth + 1);
    }
  }
}
function parseTable2(el, blocks, paraShapeMap, sectionNum, warnings) {
  const cells = [];
  const rowCount = parseInt(_nullishCoalesce(el.getAttribute("RowCount"), () => ( "0")), 10);
  const colCount = parseInt(_nullishCoalesce(el.getAttribute("ColCount"), () => ( "0")), 10);
  if (isNaN(rowCount) || isNaN(colCount) || rowCount === 0 || colCount === 0) return;
  if (rowCount > MAX_TABLE_ROWS || colCount > MAX_TABLE_COLS) {
    warnings.push({ message: `\uD14C\uC774\uBE14 \uD06C\uAE30 \uCD08\uACFC (${rowCount}x${colCount}) \u2014 \uC2A4\uD0B5`, code: "TRUNCATED_TABLE" });
    return;
  }
  const children = el.childNodes;
  for (let i = 0; i < children.length; i++) {
    const rowEl = children[i];
    if (rowEl.nodeType !== 1 || localName(rowEl) !== "ROW") continue;
    const rowCells = rowEl.childNodes;
    for (let j = 0; j < rowCells.length; j++) {
      const cellEl = rowCells[j];
      if (cellEl.nodeType !== 1 || localName(cellEl) !== "CELL") continue;
      const colAddr = parseInt(_nullishCoalesce(cellEl.getAttribute("ColAddr"), () => ( "0")), 10);
      const rowAddr = parseInt(_nullishCoalesce(cellEl.getAttribute("RowAddr"), () => ( "0")), 10);
      const colSpan = Math.min(Math.max(1, parseInt(_nullishCoalesce(cellEl.getAttribute("ColSpan"), () => ( "1")), 10) || 1), MAX_TABLE_COLS);
      const rowSpan = Math.min(Math.max(1, parseInt(_nullishCoalesce(cellEl.getAttribute("RowSpan"), () => ( "1")), 10) || 1), MAX_TABLE_ROWS);
      const cellText = extractCellText(cellEl);
      cells.push({ text: cellText, colSpan, rowSpan, colAddr, rowAddr });
    }
  }
  if (cells.length === 0) return;
  const grid = Array.from({ length: rowCount }, () => Array(colCount).fill(null));
  for (const cell of cells) {
    const r = _nullishCoalesce(cell.rowAddr, () => ( 0));
    const c = _nullishCoalesce(cell.colAddr, () => ( 0));
    if (isNaN(r) || isNaN(c) || r >= rowCount || c >= colCount) continue;
    grid[r][c] = cell;
    for (let dr = 0; dr < cell.rowSpan; dr++) {
      for (let dc = 0; dc < cell.colSpan; dc++) {
        if (dr === 0 && dc === 0) continue;
        if (r + dr < rowCount && c + dc < colCount) {
          grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 };
        }
      }
    }
  }
  const cellRows = grid.map(
    (row) => row.map((cell) => _nullishCoalesce(cell, () => ( { text: "", colSpan: 1, rowSpan: 1 })))
  );
  const table = _chunkR2H34FY5cjs.buildTable.call(void 0, cellRows);
  const caption = extractShapeCaption(el);
  if (caption.text && caption.before) {
    blocks.push({ type: "paragraph", text: caption.text, pageNumber: sectionNum });
  }
  blocks.push({ type: "table", table, pageNumber: sectionNum });
  if (caption.text && !caption.before) {
    blocks.push({ type: "paragraph", text: caption.text, pageNumber: sectionNum });
  }
}
function extractShapeCaption(tableEl) {
  const shape = findChild(tableEl, "SHAPEOBJECT");
  const caption = shape && findChild(shape, "CAPTION");
  if (!caption) return { text: "", before: false };
  const parts = [];
  collectCellText2(caption, parts, 0);
  const side = _nullishCoalesce(caption.getAttribute("Side"), () => ( ""));
  return { text: parts.filter(Boolean).join("\n").trim(), before: side === "Top" || side === "Left" };
}
function extractCellText(cellEl) {
  const textParts = [];
  collectCellText2(cellEl, textParts, 0);
  return textParts.filter(Boolean).join("\n").trim();
}
function collectCellText2(node, parts, depth) {
  if (depth > 20) return;
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType !== 1) continue;
    const tag = localName(el);
    if (tag === "P") {
      const t = extractParagraphText(el);
      if (t) parts.push(t);
      collectNestedTableText(el, parts, depth + 1);
    } else if (tag === "TABLE") {
      collectCellText2(el, parts, depth + 1);
    } else {
      collectCellText2(el, parts, depth + 1);
    }
  }
}
function collectNestedTableText(node, parts, depth) {
  if (depth > 20) return;
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType !== 1) continue;
    const tag = localName(el);
    if (tag === "TABLE") {
      collectCellText2(el, parts, depth + 1);
      continue;
    }
    if (tag === "FOOTNOTE" || tag === "ENDNOTE" || tag === "HEADER" || tag === "FOOTER") continue;
    collectNestedTableText(el, parts, depth + 1);
  }
}
function localName(el) {
  return (el.tagName || el.localName || "").replace(/^[^:]+:/, "");
}
function findChild(parent, tag) {
  const children = parent.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType === 1 && localName(el) === tag) return el;
  }
  return null;
}
function textContent(el) {
  const children = el.childNodes;
  const parts = [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.nodeType === 3) {
      parts.push(node.nodeValue || "");
    } else if (node.nodeType === 1) {
      parts.push(textContent(node));
    }
  }
  return parts.join("");
}
function countSections(body) {
  let count = 0;
  const children = body.childNodes;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (el.nodeType === 1 && localName(el) === "SECTION") count++;
  }
  return count;
}

// src/form/match.ts
function parseYMD(v) {
  let y, m, day;
  const parts = v.split(/[^0-9]+/).filter(Boolean);
  if (parts.length === 3) {
    const [yp, mp, dp] = parts;
    const yn = +yp;
    y = yp.length >= 3 ? yp : String(yn <= 29 ? 2e3 + yn : 1900 + yn);
    m = mp.padStart(2, "0");
    day = dp.padStart(2, "0");
  } else {
    const d = v.replace(/\D/g, "");
    if (d.length >= 8) {
      y = d.slice(0, 4);
      m = d.slice(4, 6);
      day = d.slice(6, 8);
    } else if (d.length === 6) {
      const yy = +d.slice(0, 2);
      y = String(yy <= 29 ? 2e3 + yy : 1900 + yy);
      m = d.slice(2, 4);
      day = d.slice(4, 6);
    } else return null;
  }
  if (+m < 1 || +m > 12 || +day < 1 || +day > 31) return null;
  return { y, yy: y.slice(2), m, d: day };
}
function fmtDate(v, style) {
  const p = parseYMD(v);
  if (!p) return v;
  return (style || "yyyy-mm-dd").replace(/yyyy/gi, p.y).replace(/yy/gi, p.yy).replace(/mm/gi, p.m).replace(/dd/gi, p.d).replace(/(?<![a-z])m(?![a-z])/gi, String(+p.m)).replace(/(?<![a-z])d(?![a-z])/gi, String(+p.d));
}
function maskDigits(v, pattern) {
  const ds = v.replace(/\D/g, "");
  const need = (_nullishCoalesce(pattern.match(/#/g), () => ( []))).length;
  if (need === 0 || ds.length !== need) return v;
  let i = 0;
  return pattern.replace(/#/g, () => ds[i++]);
}
function fmtPhone(v, style) {
  const d = v.replace(/\D/g, "");
  if (d.length < 9) return v;
  const areaLen = d.startsWith("02") ? 2 : 3;
  const a = d.slice(0, areaLen), b = d.slice(areaLen, -4), c = d.slice(-4);
  switch (style) {
    case "digits":
      return d;
    case "dot":
      return `${a}.${b}.${c}`;
    case "space":
      return `${a} ${b} ${c}`;
    case "intl":
      return `+82-${d.slice(1, areaLen)}-${b}-${c}`;
    case "intl-paren":
      return `82)${d.slice(1, areaLen)}-${b}-${c}`;
    default:
      return `${a}-${b}-${c}`;
  }
}
function fmtRRN(v, style) {
  const d = v.replace(/\D/g, "");
  if (d.length !== 13) return v;
  switch (style) {
    case "digits":
      return d;
    case "front":
      return d.slice(0, 6);
    case "masked":
      return `${d.slice(0, 6)}-${d[6]}******`;
    default:
      return `${d.slice(0, 6)}-${d.slice(6)}`;
  }
}
function formatFillValue(value, format) {
  if (!format) return value;
  const ci = format.indexOf(":");
  const kind = ci >= 0 ? format.slice(0, ci) : format;
  const style = ci >= 0 ? format.slice(ci + 1) : "";
  if (kind === "date") return fmtDate(value, style);
  if (kind === "phone") return fmtPhone(value, style);
  if (kind === "rrn") return fmtRRN(value, style);
  if (kind === "mask") return maskDigits(value, style);
  if (kind === "digits") {
    const only = value.replace(/\D/g, "");
    return only || value;
  }
  if (kind === "upper") return value.toUpperCase();
  if (kind === "lower") return value.toLowerCase();
  if (kind === "nospace") return value.replace(/\s+/g, "");
  if (format.includes("#")) return maskDigits(value, format);
  if (/(yyyy|yy|mm|dd)/.test(format)) return fmtDate(value, format);
  return value;
}
var ValueCursor = (_class2 = class {
  constructor(values) {;_class2.prototype.__init4.call(this);
    this.values = values;
  }
  __init4() {this.nextIdx = /* @__PURE__ */ new Map()}
  keys() {
    return this.values.keys();
  }
  has(key) {
    return this.values.has(key);
  }
  isArray(key) {
    return Array.isArray(this.values.get(key));
  }
  /** 남은 값이 있으면 true (스칼라는 항상 true) */
  available(key) {
    const v = this.values.get(key);
    if (v === void 0) return false;
    return typeof v === "string" || (_nullishCoalesce(this.nextIdx.get(key), () => ( 0))) < v.length;
  }
  /** 현재 값 미리보기 (소진 없음) */
  peek(key) {
    const v = this.values.get(key);
    if (v === void 0) return void 0;
    if (typeof v === "string") return v;
    const i = _nullishCoalesce(this.nextIdx.get(key), () => ( 0));
    return i < v.length ? v[i] : void 0;
  }
  /** 값 소비 — 배열이면 커서 전진, 소진 시 undefined */
  consume(key) {
    const v = this.values.get(key);
    if (v === void 0) return void 0;
    if (typeof v === "string") return v;
    const i = _nullishCoalesce(this.nextIdx.get(key), () => ( 0));
    if (i >= v.length) return void 0;
    this.nextIdx.set(key, i + 1);
    return v[i];
  }
}, _class2);
function normalizeLabel(label) {
  return label.trim().replace(/[:：\s()（）·]/g, "");
}
function findMatchingKey(cellLabel, values) {
  if (values.has(cellLabel)) return cellLabel;
  let bestKey;
  let bestLen = 0;
  for (const key of values.keys()) {
    if (cellLabel.startsWith(key)) {
      if (key.length >= cellLabel.length * 0.6 && key.length > bestLen) {
        bestLen = key.length;
        bestKey = key;
      }
    } else if (key.startsWith(cellLabel)) {
      if (cellLabel.length >= key.length * 0.6 && cellLabel.length > bestLen) {
        bestLen = cellLabel.length;
        bestKey = key;
      }
    }
  }
  return bestKey;
}
function isKeywordLabel(text) {
  const trimmed = text.trim().replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰*※]+$/g, "").trim();
  if (!trimmed || trimmed.length > 15) return false;
  for (const kw of LABEL_KEYWORDS) {
    if (trimmed.includes(kw)) return true;
  }
  return false;
}
function fillInCellPatterns(cellText, values, matchedLabels, blockedLabels) {
  let text = cellText;
  const matches = [];
  text = text.replace(
    /([가-힣A-Za-z]+)\(\s{1,}\)([가-힣A-Za-z]*)/g,
    (match, prefix, suffix) => {
      const label = prefix + suffix;
      const normalizedLabel = normalizeLabel(label);
      if (_optionalChain([blockedLabels, 'optionalAccess', _128 => _128.has, 'call', _129 => _129(normalizedLabel)])) return match;
      const matchKey = values.available(normalizedLabel) ? normalizedLabel : values.available(normalizeLabel(prefix)) ? normalizeLabel(prefix) : void 0;
      if (matchKey === void 0) return match;
      const newValue = values.consume(matchKey);
      matchedLabels.add(matchKey);
      matches.push({ key: matchKey, label, value: newValue });
      return `${prefix}(${newValue})${suffix}`;
    }
  );
  text = text.replace(
    /□([가-힣A-Za-z]+)/g,
    (match, keyword) => {
      const normalizedKw = normalizeLabel(keyword);
      const matchKey = values.available(normalizedKw) ? normalizedKw : void 0;
      if (matchKey === void 0) return match;
      const val = values.peek(matchKey);
      const isTruthy = ["\u2611", "\u2713", "\u2714", "v", "V", "true", "1", "yes", "o", "O"].includes(val.trim()) || val.trim() === "";
      if (!isTruthy) return match;
      values.consume(matchKey);
      matchedLabels.add(matchKey);
      matches.push({ key: matchKey, label: `\u25A1${keyword}`, value: "\u2611" });
      return `\u2611${keyword}`;
    }
  );
  text = text.replace(
    /\(([가-힣A-Za-z]+)[:：]\s{1,}\)/g,
    (match, keyword) => {
      const normalizedKw = normalizeLabel(keyword);
      const matchKey = values.available(normalizedKw) ? normalizedKw : void 0;
      if (matchKey === void 0) return match;
      const newValue = values.consume(matchKey);
      matchedLabels.add(matchKey);
      matches.push({ key: matchKey, label: keyword, value: newValue });
      return `(${keyword}\uFF1A${newValue})`;
    }
  );
  return matches.length > 0 ? { text, matches } : null;
}
var INLINE_LABEL_RE = /([가-힣A-Za-z]{2,10})\s*[:：]/g;
function scanInlineSegments(text) {
  const labels = [];
  INLINE_LABEL_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_LABEL_RE.exec(text)) !== null) {
    if (text[INLINE_LABEL_RE.lastIndex] === "/") continue;
    labels.push({ label: m[1], start: m.index, end: INLINE_LABEL_RE.lastIndex });
  }
  const segments = [];
  for (let i = 0; i < labels.length; i++) {
    const cur = labels[i];
    let vs = cur.end;
    while (vs < text.length && (text[vs] === " " || text[vs] === "	")) vs++;
    let ve = i + 1 < labels.length ? labels[i + 1].start : text.length;
    if (ve < vs) ve = vs;
    const sep = text.slice(vs, ve).search(/[\n,;]/);
    if (sep !== -1) ve = vs + sep;
    if (ve - vs > 100) ve = vs + 100;
    while (ve > vs && /\s/.test(text[ve - 1])) ve--;
    segments.push({
      label: cur.label,
      labelStart: cur.start,
      valueStart: vs,
      valueEnd: ve,
      value: text.slice(vs, ve)
    });
  }
  return segments;
}
function padInsertion(text, pos, value) {
  const lead = pos > 0 && !/\s/.test(text[pos - 1]) ? " " : "";
  const trail = pos < text.length && !/\s/.test(text[pos]) ? " " : "";
  return lead + value + trail;
}
function normalizeValues(values) {
  const map = /* @__PURE__ */ new Map();
  for (const [label, raw] of Object.entries(values)) {
    const { value, format } = typeof raw === "object" && !Array.isArray(raw) ? raw : { value: raw, format: void 0 };
    map.set(normalizeLabel(label), Array.isArray(value) ? value.map((v) => formatFillValue(v, format)) : formatFillValue(value, format));
  }
  return map;
}
async function fillWithUniqueGuard(values, run) {
  const first = await run(values);
  const counts = /* @__PURE__ */ new Map();
  for (const f of first.filled) {
    if (f.key) counts.set(f.key, (_nullishCoalesce(counts.get(f.key), () => ( 0))) + 1);
  }
  const isArrayValue = (normKey) => {
    for (const [label, raw] of Object.entries(values)) {
      if (normalizeLabel(label) !== normKey) continue;
      return Array.isArray(typeof raw === "object" && !Array.isArray(raw) ? raw.value : raw);
    }
    return false;
  };
  const dup = new Set([...counts].filter(([k, n]) => n >= 2 && !isArrayValue(k)).map(([k]) => k));
  if (dup.size === 0) return { ...first, rejected: [] };
  const blockedLabels = /* @__PURE__ */ new Set();
  for (const f of first.filled) {
    if (f.key && dup.has(f.key)) blockedLabels.add(normalizeLabel(f.label));
  }
  const filtered = Object.fromEntries(Object.entries(values).filter(([label]) => !dup.has(normalizeLabel(label))));
  const second = await run(filtered, blockedLabels);
  const rejected = Object.keys(values).filter((label) => dup.has(normalizeLabel(label)));
  return { ...second, rejected };
}
function resolveUnmatched(normalizedValues, matchedLabels, originalValues) {
  return [...normalizedValues.keys()].filter((k) => !matchedLabels.has(k)).map((k) => {
    for (const orig of Object.keys(originalValues)) {
      if (normalizeLabel(orig) === k) return orig;
    }
    return k;
  });
}

// src/form/recognize.ts
var LABEL_KEYWORDS = /* @__PURE__ */ new Set([
  "\uC131\uBA85",
  "\uC774\uB984",
  "\uC8FC\uC18C",
  "\uC804\uD654",
  "\uC804\uD654\uBC88\uD638",
  "\uD734\uB300\uD3F0",
  "\uD578\uB4DC\uD3F0",
  "\uC5F0\uB77D\uCC98",
  "\uC0DD\uB144\uC6D4\uC77C",
  "\uC8FC\uBBFC\uB4F1\uB85D\uBC88\uD638",
  "\uC18C\uC18D",
  "\uC9C1\uC704",
  "\uC9C1\uAE09",
  "\uBD80\uC11C",
  "\uC774\uBA54\uC77C",
  "\uD329\uC2A4",
  "\uD559\uAD50",
  "\uD559\uB144",
  "\uBC18",
  "\uBC88\uD638",
  "\uC2E0\uCCAD\uC778",
  "\uB300\uD45C\uC790",
  "\uB2F4\uB2F9\uC790",
  "\uC791\uC131\uC790",
  "\uD655\uC778\uC790",
  "\uC2B9\uC778\uC790",
  "\uC77C\uC2DC",
  "\uB0A0\uC9DC",
  "\uAE30\uAC04",
  "\uC7A5\uC18C",
  "\uBAA9\uC801",
  "\uC0AC\uC720",
  "\uBE44\uACE0",
  "\uAE08\uC561",
  "\uC218\uB7C9",
  "\uB2E8\uAC00",
  "\uD569\uACC4",
  "\uACC4",
  "\uC18C\uACC4",
  "\uB4F1\uB85D\uAE30\uC900\uC9C0",
  "\uBCF8\uC801",
  "\uC704\uC784\uC778",
  "\uCCAD\uAD6C\uC0AC\uC720",
  "\uC18C\uBA85\uC790\uB8CC"
]);
var ENGLISH_LABEL_WORDS = /* @__PURE__ */ new Set([
  "name",
  "date",
  "address",
  "tel",
  "phone",
  "mobile",
  "fax",
  "email",
  "e-mail",
  "dept",
  "department",
  "division",
  "title",
  "position",
  "grade",
  "rank",
  "birth",
  "nationality",
  "sex",
  "gender",
  "signature",
  "sign",
  "seal",
  "remarks",
  "note",
  "period",
  "place",
  "purpose",
  "reason",
  "amount",
  "total",
  "sum",
  "qty",
  "quantity",
  "unit",
  "no",
  "id",
  "passport"
]);
var ENGLISH_STOPWORDS = /* @__PURE__ */ new Set(["of", "the", "and", "or", "in"]);
var NUMERIC_VALUE_RE = /^제?\d+(?:[.,]\d+)*[십백천만억조]*(?:원|명|건|개|회|부|매|장|점|호|번|년|월|일|시|분|초|개월|주년|차례|퍼센트)?$/;
var SENTENCE_ENDING_RE = /(?:입니다|합니다|습니다|하세요|십시오|시오|바랍니다|바람|할 것|할것|하며|하고|한다|된다|됨|음|임)$/;
function isLabelCell(text) {
  const trimmed = text.trim().replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰*※]+$/g, "").trim();
  if (!trimmed || trimmed.length > 30) return false;
  for (const kw of LABEL_KEYWORDS) {
    if (trimmed.includes(kw)) return true;
  }
  const compact = trimmed.replace(/\s/g, "");
  if (/^[가-힣0-9()（）·:：\-]+$/.test(compact) && compact.length >= 2 && compact.length <= 12 && (_nullishCoalesce(compact.match(/[가-힣]/g), () => ( []))).length >= 2 && (compact.length <= 8 || trimmed.split(/\s+/).length <= 2) && !NUMERIC_VALUE_RE.test(compact) && !SENTENCE_ENDING_RE.test(trimmed) && !/^[(（]주[)）]|^주식회사/.test(compact)) {
    return true;
  }
  if (/^[가-힣A-Za-z\s]+[:：]$/.test(trimmed)) return true;
  if (/^[A-Za-z][A-Za-z\s./&-]*$/.test(trimmed) && trimmed.length <= 20) {
    const words = trimmed.toLowerCase().split(/[\s/&]+/).filter((w) => w && !ENGLISH_STOPWORDS.has(w));
    if (words.length >= 1 && words.length <= 3 && words.every((w) => ENGLISH_LABEL_WORDS.has(w.replace(/\.$/, "")))) {
      return true;
    }
  }
  return false;
}
function extractFormFields(blocks) {
  const fields = [];
  let totalTables = 0;
  let formTables = 0;
  for (const block of blocks) {
    if (block.type !== "table" || !block.table) continue;
    totalTables++;
    const tableFields = extractFromTable(block.table);
    if (tableFields.length > 0) {
      formTables++;
      fields.push(...tableFields);
    }
  }
  for (const block of blocks) {
    if (block.type === "paragraph" && block.text) {
      const inlineFields = extractInlineFields(block.text);
      fields.push(...inlineFields);
    }
  }
  const confidence = totalTables > 0 ? formTables / totalTables : fields.length > 0 ? 0.3 : 0;
  return { fields, confidence: Math.min(confidence, 1) };
}
function extractFromTable(table) {
  const fields = [];
  if (table.cols >= 2) {
    for (let r = 0; r < table.rows; r++) {
      for (let c = 0; c < table.cols - 1; c++) {
        const labelCell = _optionalChain([table, 'access', _130 => _130.cells, 'access', _131 => _131[r], 'optionalAccess', _132 => _132[c]]);
        const valueCell = _optionalChain([table, 'access', _133 => _133.cells, 'access', _134 => _134[r], 'optionalAccess', _135 => _135[c + 1]]);
        if (!labelCell || !valueCell) continue;
        if (isLabelCell(labelCell.text)) {
          fields.push({
            label: labelCell.text.trim().replace(/[:：]\s*$/, ""),
            value: valueCell.text.trim(),
            row: r,
            col: c
          });
        }
      }
    }
  }
  if (fields.length === 0 && table.rows >= 2 && table.cols >= 2) {
    const headerRow = table.cells[0];
    const allLabels = headerRow.every((cell) => {
      const t = cell.text.trim();
      return t.length > 0 && t.length <= 20;
    });
    if (allLabels) {
      for (let r = 1; r < table.rows; r++) {
        for (let c = 0; c < table.cols; c++) {
          const label = _nullishCoalesce(_optionalChain([headerRow, 'access', _136 => _136[c], 'optionalAccess', _137 => _137.text, 'access', _138 => _138.trim, 'call', _139 => _139()]), () => ( ""));
          const value = _nullishCoalesce(_optionalChain([table, 'access', _140 => _140.cells, 'access', _141 => _141[r], 'optionalAccess', _142 => _142[c], 'optionalAccess', _143 => _143.text, 'access', _144 => _144.trim, 'call', _145 => _145()]), () => ( ""));
          if (label && value) {
            fields.push({ label, value, row: r, col: c });
          }
        }
      }
    }
  }
  return fields;
}
function extractInlineFields(text) {
  const fields = [];
  for (const seg of scanInlineSegments(text)) {
    if (seg.value) {
      fields.push({ label: seg.label, value: seg.value, row: -1, col: -1 });
    }
  }
  return fields;
}
var LABEL_TYPE_RULES = [
  [/주민등록번호|외국인등록번호/, "idnum"],
  [/생년월일|일시|날짜|일자|기간|연월일|년월일|신청일|작성일|발급일|접수일/, "date"],
  [/전화|연락처|휴대폰|핸드폰|팩스/, "phone"],
  [/이메일|전자우편|email/i, "email"],
  [/금액|단가|수량|합계|소계|예산|비용|인원|급여|연봉/, "amount"]
];
function inferFieldType(label, value) {
  if (/[□☑✓✔]/.test(value) || /[□☑✓✔]/.test(label)) return "checkbox";
  const v = value.trim();
  if (v) {
    if (/^\d{6}[-\s]?[1-4]\d{6}$/.test(v)) return "idnum";
    if (/^\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?\s*\.?$/.test(v)) return "date";
    if (/^0\d{1,2}[-.)\s]?\d{3,4}[-.\s]?\d{4}$/.test(v)) return "phone";
    if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(v)) return "email";
    if (/^[\d,.\s]+(?:원|명|건|개|회|부|매|%)$/.test(v) && /\d/.test(v)) return "amount";
    if (/^\d{1,3}(?:,\d{3})+$/.test(v)) return "amount";
  }
  const norm = label.replace(/\s/g, "");
  for (const [re, type] of LABEL_TYPE_RULES) {
    if (re.test(norm)) return type;
  }
  return "text";
}
function isRequiredLabel(label) {
  return /[*※★]|\(\s*필수\s*\)|（\s*필수\s*）/.test(label);
}
function isEmptyValue(value) {
  const v = value.trim();
  if (!v) return true;
  return /^[\s_()（）\-—–~.·,]*$/.test(v);
}
function extractFormSchema(blocks) {
  const { fields, confidence } = extractFormFields(blocks);
  const schemaFields = fields.map((f) => ({
    ...f,
    type: inferFieldType(f.label, f.value),
    required: isRequiredLabel(f.label) || void 0,
    empty: isEmptyValue(f.value)
  }));
  const seen = new Set(schemaFields.map((f) => normalizeLabel(f.label)));
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text) continue;
    for (const seg of scanInlineSegments(block.text)) {
      if (seg.value) continue;
      const key = normalizeLabel(seg.label);
      if (seen.has(key)) continue;
      seen.add(key);
      schemaFields.push({
        label: seg.label,
        value: "",
        row: -1,
        col: -1,
        type: inferFieldType(seg.label, ""),
        required: isRequiredLabel(seg.label) || void 0,
        empty: true
      });
    }
  }
  return { confidence, fields: schemaFields };
}

// src/form/filler.ts
function fillFormFields(blocks, values, blockedLabels) {
  const cloned = structuredClone(blocks);
  const filled = [];
  const matchedLabels = /* @__PURE__ */ new Set();
  const normalizedValues = normalizeValues(values);
  const cursor = new ValueCursor(normalizedValues);
  const allTables = collectIRTables(cloned, 0);
  const patternFilledCells = /* @__PURE__ */ new Set();
  for (const table of allTables) {
    for (let r = 0; r < table.rows; r++) {
      for (let c = 0; c < table.cols; c++) {
        const cell = _optionalChain([table, 'access', _146 => _146.cells, 'access', _147 => _147[r], 'optionalAccess', _148 => _148[c]]);
        if (!cell) continue;
        const result = fillInCellPatterns(cell.text, cursor, matchedLabels, blockedLabels);
        if (result) {
          cell.text = result.text;
          patternFilledCells.add(cell);
          for (const m of result.matches) {
            filled.push({ label: m.label, value: m.value, row: r, col: c, key: m.key });
          }
        }
      }
    }
  }
  for (const table of allTables) {
    fillTable(table, cursor, filled, matchedLabels, patternFilledCells, blockedLabels);
  }
  for (const block of cloned) {
    if (block.type !== "paragraph" || !block.text) continue;
    const newText = fillInlineFields(block.text, cursor, filled, matchedLabels, blockedLabels);
    if (newText !== block.text) block.text = newText;
  }
  const unmatched = resolveUnmatched(normalizedValues, matchedLabels, values);
  return { blocks: cloned, filled, unmatched };
}
function collectIRTables(blocks, depth) {
  if (depth > 16) return [];
  const out = [];
  for (const block of blocks) {
    if (block.type !== "table" || !block.table) continue;
    out.push(block.table);
    for (const row of block.table.cells) {
      for (const cell of row) {
        if (_optionalChain([cell, 'optionalAccess', _149 => _149.blocks, 'optionalAccess', _150 => _150.length])) out.push(...collectIRTables(cell.blocks, depth + 1));
      }
    }
  }
  return out;
}
function coveredPositions(table) {
  const covered = /* @__PURE__ */ new Set();
  for (let r = 0; r < table.rows; r++) {
    for (let c = 0; c < table.cols; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = _optionalChain([table, 'access', _151 => _151.cells, 'access', _152 => _152[r], 'optionalAccess', _153 => _153[c]]);
      if (!cell) continue;
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (r + dr < table.rows && c + dc < table.cols) covered.add(`${r + dr},${c + dc}`);
        }
      }
      c += cell.colSpan - 1;
    }
  }
  return covered;
}
function fillTable(table, values, filled, matchedLabels, patternFilledCells, blockedLabels) {
  if (table.cols < 2) return;
  const covered = coveredPositions(table);
  for (let r = 0; r < table.rows; r++) {
    for (let c = 0; c < table.cols; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const labelCell = table.cells[r][c];
      if (!labelCell) continue;
      if (!isLabelCell(labelCell.text)) continue;
      let vc = c + labelCell.colSpan;
      while (vc < table.cols && covered.has(`${r},${vc}`)) vc++;
      if (vc >= table.cols) continue;
      const valueCell = table.cells[r][vc];
      if (!valueCell) continue;
      if (isKeywordLabel(valueCell.text)) continue;
      const normalizedCellLabel = normalizeLabel(labelCell.text);
      if (!normalizedCellLabel) continue;
      if (_optionalChain([blockedLabels, 'optionalAccess', _154 => _154.has, 'call', _155 => _155(normalizedCellLabel)])) continue;
      const matchKey = findMatchingKey(normalizedCellLabel, values);
      if (matchKey === void 0) continue;
      const newValue = values.consume(matchKey);
      if (newValue === void 0) continue;
      if (_optionalChain([patternFilledCells, 'optionalAccess', _156 => _156.has, 'call', _157 => _157(valueCell)])) {
        valueCell.text = newValue + " " + valueCell.text;
      } else {
        valueCell.text = newValue;
      }
      matchedLabels.add(matchKey);
      filled.push({
        label: labelCell.text.trim().replace(/[:：]\s*$/, ""),
        value: newValue,
        row: r,
        col: c,
        key: matchKey
      });
    }
  }
  if (table.rows >= 2 && table.cols >= 2) {
    const headerRow = table.cells[0];
    const allLabels = headerRow.every((cell) => {
      const t = cell.text.trim();
      return t.length > 0 && t.length <= 20 && isLabelCell(t);
    });
    if (!allLabels) return;
    for (let r = 1; r < table.rows; r++) {
      for (let c = 0; c < table.cols; c++) {
        if (covered.has(`${r},${c}`)) continue;
        const headerCell = headerRow[c];
        const valueCell = _optionalChain([table, 'access', _158 => _158.cells, 'access', _159 => _159[r], 'optionalAccess', _160 => _160[c]]);
        if (!headerCell || !valueCell) continue;
        const headerLabel = normalizeLabel(headerCell.text);
        if (_optionalChain([blockedLabels, 'optionalAccess', _161 => _161.has, 'call', _162 => _162(headerLabel)])) continue;
        const matchKey = findMatchingKey(headerLabel, values);
        if (matchKey === void 0) continue;
        if (!values.isArray(matchKey) && matchedLabels.has(matchKey)) continue;
        const newValue = values.consume(matchKey);
        if (newValue === void 0) continue;
        valueCell.text = newValue;
        matchedLabels.add(matchKey);
        filled.push({
          label: headerCell.text.trim(),
          value: newValue,
          row: r,
          col: c,
          key: matchKey
        });
      }
    }
  }
}
function fillInlineFields(text, values, filled, matchedLabels, blockedLabels) {
  const segments = scanInlineSegments(text);
  if (segments.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const seg of segments) {
    const nlabel = normalizeLabel(seg.label);
    if (_optionalChain([blockedLabels, 'optionalAccess', _163 => _163.has, 'call', _164 => _164(nlabel)])) continue;
    const matchKey = findMatchingKey(nlabel, values);
    if (matchKey === void 0) continue;
    const newValue = values.consume(matchKey);
    if (newValue === void 0) continue;
    matchedLabels.add(matchKey);
    filled.push({ label: seg.label.trim(), value: newValue, row: -1, col: -1, key: matchKey });
    out += text.slice(pos, seg.valueStart);
    out += seg.valueStart === seg.valueEnd ? padInsertion(text, seg.valueStart, newValue) : newValue;
    pos = seg.valueEnd;
  }
  out += text.slice(pos);
  return out;
}

// src/form/filler-hwpx.ts


// src/roundtrip/source-map.ts
function escapeXmlText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function decodeXmlEntities(text) {
  return text.replace(/&(lt|gt|amp|quot|apos|#x?[0-9a-fA-F]+);/g, (m, ent) => {
    switch (ent) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    try {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!isNaN(code) && code >= 0 && code <= 1114111) return String.fromCodePoint(code);
    } catch (e28) {
    }
    return m;
  });
}
function tContentToText(raw) {
  return decodeXmlEntities(
    raw.replace(/<\/?(?:[A-Za-z0-9_]+:)?(?:tab|fwSpace|hwSpace|br|lineBreak)(?:\s[^>]*)?\/?>/g, " ").replace(/<[^>]*>/g, "")
  );
}
var TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!(?:"[^"]*"|'[^']*'|[^>"'])*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
var T_BARRIER = /* @__PURE__ */ new Set([
  "tbl",
  "ctrl",
  "caption",
  "pic",
  "shape",
  "drawingObject",
  "drawText",
  "shapeComment",
  "memogroup",
  "memo",
  "hiddenComment",
  "equation",
  "parameters",
  "subList",
  "p"
]);
var PARA_CONTAINER = /* @__PURE__ */ new Set([
  "tc",
  "ctrl",
  "caption",
  "drawText",
  "pic",
  "shape",
  "drawingObject",
  "memogroup",
  "memo",
  "hiddenComment",
  "footNote",
  "endNote",
  "fn",
  "en"
  // 각주/미주 — 파서는 호스트 블록 footnoteText로만 흡수
]);
var TABLE_BARRIER = /* @__PURE__ */ new Set([
  "tbl",
  "ctrl",
  "caption",
  "memogroup",
  "memo",
  "hiddenComment"
]);
function localOf(qname) {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}
function prefixOf(qname) {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(0, i) : "";
}
function scanSectionXml(xml, sectionIndex) {
  const stack = [];
  const bodyParagraphs = [];
  const tables = [];
  const headerTexts = [];
  const footerTexts = [];
  const excludedParagraphs = [];
  const orphanTables = [];
  const paraStack = [];
  const tableStack = [];
  const rowStack = [];
  const trStartStack = [];
  const cellStack = [];
  let pendingT = null;
  const ctrlSubStack = [];
  const classifyPara = () => {
    let sawDrawText = false;
    for (let i = stack.length - 1; i >= 0; i--) {
      const l = stack[i].local;
      if (l === "tc") return { kind: "cell", inTextbox: sawDrawText };
      if (l === "drawText") {
        sawDrawText = true;
        continue;
      }
      if (PARA_CONTAINER.has(l)) return { kind: "excluded", inTextbox: sawDrawText };
    }
    return sawDrawText ? { kind: "draw", inTextbox: true } : { kind: "body", inTextbox: false };
  };
  const owningPara = () => {
    if (paraStack.length === 0) return null;
    for (let i = stack.length - 1; i >= 0; i--) {
      const l = stack[i].local;
      if (l === "p") return paraStack[paraStack.length - 1];
      if (T_BARRIER.has(l)) return null;
    }
    return null;
  };
  const isTableTopLevel = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (TABLE_BARRIER.has(stack[i].local)) return false;
    }
    return true;
  };
  const currentCtrlSub = () => ctrlSubStack.length > 0 ? ctrlSubStack[ctrlSubStack.length - 1] : null;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(xml)) !== null) {
    const [full, closeName, openName, , selfClose] = m;
    if (closeName === void 0 && openName === void 0) continue;
    if (closeName !== void 0) {
      const local2 = localOf(closeName);
      if (local2 === "t" && pendingT) {
        const { para, contentStart: contentStart2 } = pendingT;
        para.tRanges.push({ contentStart: contentStart2, contentEnd: m.index });
        para.text += tContentToText(xml.slice(contentStart2, m.index));
        pendingT = null;
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].local === local2) {
          stack.length = i;
          break;
        }
      }
      if (local2 === "p") {
        const para = paraStack.pop();
        if (para && para.kind === "excluded") {
          const sub = currentCtrlSub();
          if (sub && para.text.trim()) sub.texts.push(para.text);
        }
      } else if (local2 === "tc") {
        const cell = cellStack.pop();
        const row = rowStack[rowStack.length - 1];
        if (cell && row) row.push(cell);
      } else if (local2 === "tr") {
        const row = rowStack[rowStack.length - 1];
        const table = tableStack[tableStack.length - 1];
        if (row && table && row.length > 0) {
          table.rows.push(row);
          const trStart = trStartStack[trStartStack.length - 1];
          if (trStart >= 0) table.rowRanges.push({ start: trStart, end: m.index + full.length });
        }
        if (rowStack.length > 0) rowStack[rowStack.length - 1] = [];
        if (trStartStack.length > 0) trStartStack[trStartStack.length - 1] = -1;
      } else if (local2 === "tbl") {
        const table = tableStack.pop();
        rowStack.pop();
        trStartStack.pop();
        if (table) {
          finalizeTable(table);
          if (!table.topLevel) {
            const cell = cellStack[cellStack.length - 1];
            if (cell) cell.tables.push(table);
            else orphanTables.push(table);
          }
        }
      } else if (local2 === "header" || local2 === "footer") {
        const sub = ctrlSubStack[ctrlSubStack.length - 1];
        if (sub) {
          ctrlSubStack.pop();
          const joined = sub.texts.join("\n").trim();
          if (joined) (sub.kind === "header" ? headerTexts : footerTexts).push(joined);
        }
      }
      continue;
    }
    const qname = openName;
    const local = localOf(qname);
    const attrsRaw = m[3] || "";
    const isSelfClose = selfClose === "/";
    const contentStart = m.index + full.length;
    if (isSelfClose) {
      if (local === "t") {
        const para = owningPara();
        if (para) para.tRanges.push({ contentStart: m.index, contentEnd: m.index + full.length, selfClosing: true, prefix: prefixOf(qname) });
      } else if (local === "tab" || local === "fwSpace" || local === "hwSpace" || local === "br" || local === "lineBreak") {
        if (!pendingT) {
          const para = owningPara();
          if (para) para.text += " ";
        }
      } else if (local === "run" || local === "r") {
        const para = owningPara();
        if (para && !para.selfCloseRun) para.selfCloseRun = { start: m.index, end: m.index + full.length };
      } else if (local === "cellAddr") {
        const cell = cellStack[cellStack.length - 1];
        if (cell && insideCurrentTable(stack, tableStack)) {
          const ca = parseInt(getAttr2(attrsRaw, "colAddr") || "", 10);
          const ra = parseInt(getAttr2(attrsRaw, "rowAddr") || "", 10);
          if (!isNaN(ca)) cell.colAddr = ca;
          if (!isNaN(ra)) cell.rowAddr = ra;
          cell.addrTagRange = { start: m.index, end: m.index + full.length };
        }
      } else if (local === "cellSpan") {
        const cell = cellStack[cellStack.length - 1];
        if (cell && insideCurrentTable(stack, tableStack)) {
          const cs = parseInt(getAttr2(attrsRaw, "colSpan") || "1", 10);
          const rs = parseInt(getAttr2(attrsRaw, "rowSpan") || "1", 10);
          cell.colSpan = isNaN(cs) || cs < 1 ? 1 : cs;
          cell.rowSpan = isNaN(rs) || rs < 1 ? 1 : rs;
        }
      }
      continue;
    }
    if (local === "t") {
      const para = owningPara();
      if (para) pendingT = { para, contentStart };
      stack.push({ local, qname, contentStart });
      continue;
    }
    stack.push({ local, qname, contentStart });
    if (local === "p") {
      const para = {
        sectionIndex,
        kind: "excluded",
        // 분류는 push 직후 스택 기준 (자기 자신 제외)
        start: m.index,
        tRanges: [],
        text: ""
      };
      stack.pop();
      const cls = classifyPara();
      para.kind = cls.kind;
      if (cls.inTextbox) para.inTextbox = true;
      stack.push({ local, qname, contentStart });
      paraStack.push(para);
      if (para.kind === "body" || para.kind === "draw") bodyParagraphs.push(para);
      else if (para.kind === "cell") {
        const cell = cellStack[cellStack.length - 1];
        if (cell) cell.paragraphs.push(para);
      } else if (para.kind === "excluded") {
        excludedParagraphs.push(para);
      }
    } else if (local === "run" || local === "r") {
      const para = owningPara();
      if (para && para.runPrefix === void 0) para.runPrefix = prefixOf(qname);
    } else if (local === "tbl") {
      const table = {
        sectionIndex,
        start: m.index,
        topLevel: false,
        rows: [],
        rowRanges: [],
        cellByAnchor: /* @__PURE__ */ new Map()
      };
      stack.pop();
      table.topLevel = isTableTopLevel();
      stack.push({ local, qname, contentStart });
      tableStack.push(table);
      rowStack.push([]);
      trStartStack.push(-1);
      if (table.topLevel) tables.push(table);
    } else if (local === "tr") {
      if (rowStack.length > 0) rowStack[rowStack.length - 1] = [];
      if (trStartStack.length > 0) trStartStack[trStartStack.length - 1] = m.index;
    } else if (local === "tc") {
      cellStack.push({ colSpan: 1, rowSpan: 1, paragraphs: [], tables: [] });
    } else if (local === "cellAddr" || local === "cellSpan") {
      const cell = cellStack[cellStack.length - 1];
      if (cell && insideCurrentTable(stack, tableStack)) {
        if (local === "cellAddr") {
          const ca = parseInt(getAttr2(attrsRaw, "colAddr") || "", 10);
          const ra = parseInt(getAttr2(attrsRaw, "rowAddr") || "", 10);
          if (!isNaN(ca)) cell.colAddr = ca;
          if (!isNaN(ra)) cell.rowAddr = ra;
          cell.addrTagRange = { start: m.index, end: contentStart };
        } else {
          const cs = parseInt(getAttr2(attrsRaw, "colSpan") || "1", 10);
          const rs = parseInt(getAttr2(attrsRaw, "rowSpan") || "1", 10);
          cell.colSpan = isNaN(cs) || cs < 1 ? 1 : cs;
          cell.rowSpan = isNaN(rs) || rs < 1 ? 1 : rs;
        }
      }
    } else if (local === "header" || local === "footer") {
      if (stack.some((f) => f.local === "ctrl")) {
        ctrlSubStack.push({ kind: local, texts: [] });
      }
    } else if (local === "tab" || local === "fwSpace" || local === "hwSpace" || local === "br" || local === "lineBreak") {
      const para = owningPara();
      if (para) para.text += " ";
    }
  }
  for (const para of bodyParagraphs) fillRunInsertPos(para, xml);
  for (const para of excludedParagraphs) fillRunInsertPos(para, xml);
  const fillTableInsertPos = (table, depth = 0) => {
    if (depth > 16) return;
    for (const row of table.rows) {
      for (const cell of row) {
        for (const para of cell.paragraphs) fillRunInsertPos(para, xml);
        for (const nested of cell.tables) fillTableInsertPos(nested, depth + 1);
      }
    }
  };
  for (const table of tables) fillTableInsertPos(table);
  for (const table of orphanTables) fillTableInsertPos(table);
  return { sectionIndex, xml, bodyParagraphs, tables, headerTexts, footerTexts, excludedParagraphs, orphanTables };
}
function getAttr2(attrsRaw, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = attrsRaw.match(re);
  return m ? _nullishCoalesce(m[1], () => ( m[2])) : void 0;
}
function insideCurrentTable(stack, tableStack) {
  if (tableStack.length === 0) return false;
  for (let i = stack.length - 1; i >= 0; i--) {
    const l = stack[i].local;
    if (l === "tc") return true;
    if (l === "tbl") return false;
  }
  return false;
}
function fillRunInsertPos(para, xml) {
  if (para.tRanges.length > 0) return;
  const pEnd = findElementEnd(xml, para.start);
  if (pEnd < 0) return;
  const slice = xml.slice(para.start, pEnd);
  const runOpen = slice.match(/<((?:[A-Za-z0-9_]+:)?run)(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*?)?(\/?)>/);
  if (!runOpen || runOpen.index === void 0) return;
  if (runOpen[2] === "/") return;
  const qname = runOpen[1];
  const closeIdx = slice.indexOf(`</${qname}>`, runOpen.index);
  if (closeIdx < 0) return;
  para.runInsertPos = para.start + closeIdx;
  para.runPrefix = prefixOf(qname);
}
function findElementEnd(xml, start) {
  const open = xml.slice(start).match(/^<([^\s/>!?]+)/);
  if (!open) return -1;
  const qname = open[1];
  const re = new RegExp(`<${qname}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*?(/?)>|</${qname}\\s*>`, "g");
  re.lastIndex = start;
  let depth = 0;
  let mm;
  while ((mm = re.exec(xml)) !== null) {
    if (mm[0].startsWith("</")) {
      depth--;
      if (depth === 0) return mm.index + mm[0].length;
    } else if (mm[1] !== "/") {
      depth++;
    }
  }
  return -1;
}
function finalizeTable(table) {
  const hasAddr = table.rows.some((row) => row.some((c) => c.colAddr !== void 0 && c.rowAddr !== void 0));
  if (hasAddr) {
    for (const row of table.rows) {
      for (const cell of row) {
        if (cell.rowAddr !== void 0 && cell.colAddr !== void 0) {
          table.cellByAnchor.set(`${cell.rowAddr},${cell.colAddr}`, cell);
        }
      }
    }
    return;
  }
  const numRows = table.rows.length;
  const occupied = Array.from({ length: numRows }, () => []);
  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0;
    for (const cell of table.rows[rowIdx]) {
      while (occupied[rowIdx][colIdx]) colIdx++;
      cell.rowAddr = rowIdx;
      cell.colAddr = colIdx;
      table.cellByAnchor.set(`${rowIdx},${colIdx}`, cell);
      for (let r = rowIdx; r < Math.min(rowIdx + cell.rowSpan, numRows); r++) {
        for (let c = colIdx; c < colIdx + cell.colSpan; c++) {
          occupied[r][c] = true;
        }
      }
      colIdx += cell.colSpan;
    }
  }
}
function buildParagraphSplices(para, newText, xml) {
  if (newText && xml) {
    const orig = paraTText(para, xml);
    if (orig && orig.trim() !== "") {
      const lead = orig.match(/^\s*/)[0];
      const trail = orig.match(/\s*$/)[0];
      if ((lead || trail) && newText.trim() !== "") {
        newText = lead + newText.replace(/^\s+|\s+$/g, "") + trail;
      }
    }
  }
  const escaped = escapeXmlText(newText);
  if (para.tRanges.length > 0) {
    const splices = [];
    const first = para.tRanges[0];
    if (first.selfClosing) {
      const prefix = first.prefix ? first.prefix + ":" : "";
      splices.push({ start: first.contentStart, end: first.contentEnd, replacement: `<${prefix}t>${escaped}</${prefix}t>` });
    } else {
      splices.push({ start: first.contentStart, end: first.contentEnd, replacement: escaped });
    }
    for (let i = 1; i < para.tRanges.length; i++) {
      const r = para.tRanges[i];
      if (!r.selfClosing && r.contentStart < r.contentEnd) {
        splices.push({ start: r.contentStart, end: r.contentEnd, replacement: "" });
      }
    }
    return splices;
  }
  if (para.runInsertPos !== void 0) {
    if (!newText) return [];
    const prefix = para.runPrefix ? para.runPrefix + ":" : "";
    return [{ start: para.runInsertPos, end: para.runInsertPos, replacement: `<${prefix}t>${escaped}</${prefix}t>` }];
  }
  if (para.selfCloseRun && xml) {
    if (!newText) return [];
    const { start, end } = para.selfCloseRun;
    const tag = xml.slice(start, end);
    const qm = tag.match(/^<([^\s/>]+)/);
    if (!qm || !tag.endsWith("/>")) return null;
    const qname = qm[1];
    const colon = qname.indexOf(":");
    const prefix = colon >= 0 ? qname.slice(0, colon) + ":" : "";
    const opened = tag.slice(0, tag.length - 2).trimEnd() + ">";
    return [{ start, end, replacement: `${opened}<${prefix}t>${escaped}</${prefix}t></${qname}>` }];
  }
  return newText ? null : [];
}
function paraTText(para, xml) {
  let text = "";
  for (const t of para.tRanges) {
    if (t.selfClosing) continue;
    const raw = xml.slice(t.contentStart, t.contentEnd);
    if (/[<&]/.test(raw)) return null;
    text += raw;
  }
  return text;
}
function paraTextPureT(para, xml) {
  let len = 0;
  for (const t of para.tRanges) {
    if (t.selfClosing) continue;
    len += tContentToText(xml.slice(t.contentStart, t.contentEnd)).length;
  }
  return len === para.text.length;
}
function buildRangeSplices(para, xml, start, end, replacement) {
  if (start < 0 || end < start) return null;
  const segs = [];
  let offset = 0;
  for (const t of para.tRanges) {
    if (t.selfClosing) continue;
    const raw = xml.slice(t.contentStart, t.contentEnd);
    if (/[<&]/.test(raw)) return null;
    segs.push({ contentStart: t.contentStart, from: offset, to: offset + raw.length });
    offset += raw.length;
  }
  if (segs.length === 0 || end > offset) return null;
  const escaped = escapeXmlText(replacement);
  if (start === end) {
    for (const seg of segs) {
      if (start >= seg.from && start <= seg.to) {
        const at = seg.contentStart + (start - seg.from);
        return [{ start: at, end: at, replacement: escaped }];
      }
    }
    return null;
  }
  const splices = [];
  let placed = false;
  for (const seg of segs) {
    if (seg.to <= start || seg.from >= end) continue;
    const localStart = Math.max(seg.from, start) - seg.from;
    const localEnd = Math.min(seg.to, end) - seg.from;
    splices.push({
      start: seg.contentStart + localStart,
      end: seg.contentStart + localEnd,
      replacement: placed ? "" : escaped
    });
    placed = true;
  }
  return placed ? splices : null;
}
function allLinesegRemovalSplices(xml) {
  const segRe = /<(\w+:)?linesegarray\b[^>]*?(?:\/>|>[\s\S]*?<\/\1linesegarray>)/g;
  const splices = [];
  let m;
  while ((m = segRe.exec(xml)) !== null) {
    splices.push({ start: m.index, end: m.index + m[0].length, replacement: "" });
  }
  return splices;
}
function applySplices(xml, splices) {
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error("\uC18C\uC2A4\uB9F5 splice \uBC94\uC704 \uACB9\uCE68 \u2014 \uB0B4\uBD80 \uC624\uB958");
    }
  }
  let result = xml;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    result = result.slice(0, s.start) + s.replacement + result.slice(s.end);
  }
  return result;
}

// src/roundtrip/zip-patch.ts

var EOCD_SIG = 101010256;
var CD_SIG = 33639248;
var LOCAL_SIG = 67324752;
var ZIP64_EOCD_LOC_SIG = 117853008;
function copyBytes(buf, start, end) {
  return new Uint8Array(buf.subarray(start, end));
}
function parseCentralDirectory(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const minEocd = Math.max(0, buf.length - 22 - 65535);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === EOCD_SIG && i + 22 + view.getUint16(i + 20, true) === buf.length) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    for (let i = buf.length - 22; i >= minEocd; i--) {
      if (view.getUint32(i, true) !== EOCD_SIG) continue;
      if (i + 22 + view.getUint16(i + 20, true) > buf.length) continue;
      const cand = view.getUint32(i + 16, true);
      if (cand < buf.length - 4 && view.getUint32(cand, true) === CD_SIG) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP EOCD\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset === 4294967295 || totalEntries === 65535) throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP64\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
  if (eocdOffset >= 20 && view.getUint32(eocdOffset - 20, true) === ZIP64_EOCD_LOC_SIG) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP64\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
  }
  const decoder = new TextDecoder("utf-8");
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(pos, true) !== CD_SIG) throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP Central Directory \uC190\uC0C1");
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    if (compSize === 4294967295 || uncompSize === 4294967295 || localOffset === 4294967295) {
      throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP64\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
    }
    const name = decoder.decode(buf.subarray(pos + 46, pos + 46 + nameLen));
    const cdEnd = pos + 46 + nameLen + extraLen + commentLen;
    entries.push({ cdStart: pos, cdEnd, name, flags, method, crc, compSize, uncompSize, localOffset });
    pos = cdEnd;
  }
  return { entries, cdOffset, cdSize, eocdOffset };
}
var CRC_TABLE2 = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc322(data) {
  let crc = 4294967295;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE2[(crc ^ data[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
function patchZipEntries(original, replacements, additions) {
  const { entries, cdOffset, eocdOffset } = parseCentralDirectory(original);
  const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
  for (const name of replacements.keys()) {
    if (!entries.some((e) => e.name === name)) throw new (0, _chunkR2H34FY5cjs.KordocError)(`ZIP\uC5D0 \uC5C6\uB294 \uC5D4\uD2B8\uB9AC: ${name}`);
  }
  if (additions) {
    for (const name of additions.keys()) {
      if (entries.some((e) => e.name === name)) throw new (0, _chunkR2H34FY5cjs.KordocError)(`ZIP\uC5D0 \uC774\uBBF8 \uC788\uB294 \uC5D4\uD2B8\uB9AC: ${name}`);
    }
  }
  const byLocal = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  const segments = [];
  const newLocalOffset = /* @__PURE__ */ new Map();
  const newMeta = /* @__PURE__ */ new Map();
  let offset = 0;
  for (let i = 0; i < byLocal.length; i++) {
    const e = byLocal[i];
    const segEnd = i + 1 < byLocal.length ? byLocal[i + 1].localOffset : cdOffset;
    newLocalOffset.set(e, offset);
    const newData = replacements.get(e.name);
    if (newData === void 0) {
      const seg = original.subarray(e.localOffset, segEnd);
      segments.push(seg);
      offset += seg.length;
      continue;
    }
    if (view.getUint32(e.localOffset, true) !== LOCAL_SIG) throw new (0, _chunkR2H34FY5cjs.KordocError)("ZIP \uB85C\uCEEC \uD5E4\uB354 \uC2DC\uADF8\uB2C8\uCC98 \uBD88\uC77C\uCE58");
    const nameLen = view.getUint16(e.localOffset + 26, true);
    const extraLen = view.getUint16(e.localOffset + 28, true);
    const headerLen = 30 + nameLen + extraLen;
    const header = copyBytes(original, e.localOffset, e.localOffset + headerLen);
    const hview = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const method = e.method;
    const compData = method === 0 ? newData : new Uint8Array(_zlib.deflateRawSync.call(void 0, newData));
    const crc = crc322(newData);
    const flags = e.flags & ~8;
    hview.setUint16(6, flags, true);
    hview.setUint32(14, crc, true);
    hview.setUint32(18, compData.length, true);
    hview.setUint32(22, newData.length, true);
    segments.push(header, compData);
    offset += headerLen + compData.length;
    newMeta.set(e, { crc, compSize: compData.length, uncompSize: newData.length, flags });
  }
  const added = [];
  if (additions) {
    const encoder = new TextEncoder();
    for (const [name, data] of additions) {
      const nameBytes = encoder.encode(name);
      const deflated = new Uint8Array(_zlib.deflateRawSync.call(void 0, data));
      const method = deflated.length < data.length ? 8 : 0;
      const compData = method === 8 ? deflated : data;
      const crc = crc322(data);
      const header = new Uint8Array(30 + nameBytes.length);
      const hv = new DataView(header.buffer);
      hv.setUint32(0, LOCAL_SIG, true);
      hv.setUint16(4, 20, true);
      hv.setUint16(6, 2048, true);
      hv.setUint16(8, method, true);
      hv.setUint16(10, 0, true);
      hv.setUint16(12, 33, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, compData.length, true);
      hv.setUint32(22, data.length, true);
      hv.setUint16(26, nameBytes.length, true);
      hv.setUint16(28, 0, true);
      header.set(nameBytes, 30);
      added.push({ nameBytes, crc, compSize: compData.length, uncompSize: data.length, method, localOffset: offset });
      segments.push(header, compData);
      offset += header.length + compData.length;
    }
  }
  const newCdOffset = offset;
  for (const e of entries) {
    const cd = copyBytes(original, e.cdStart, e.cdEnd);
    const cview = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    cview.setUint32(42, newLocalOffset.get(e), true);
    const meta = newMeta.get(e);
    if (meta) {
      cview.setUint16(8, meta.flags, true);
      cview.setUint32(16, meta.crc, true);
      cview.setUint32(20, meta.compSize, true);
      cview.setUint32(24, meta.uncompSize, true);
    }
    segments.push(cd);
    offset += cd.length;
  }
  for (const a of added) {
    const cd = new Uint8Array(46 + a.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, CD_SIG, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 2048, true);
    cv.setUint16(10, a.method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 33, true);
    cv.setUint32(16, a.crc, true);
    cv.setUint32(20, a.compSize, true);
    cv.setUint32(24, a.uncompSize, true);
    cv.setUint16(28, a.nameBytes.length, true);
    cv.setUint32(42, a.localOffset, true);
    cd.set(a.nameBytes, 46);
    segments.push(cd);
    offset += cd.length;
  }
  const newCdSize = offset - newCdOffset;
  const eocd = copyBytes(original, eocdOffset);
  const eview = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  if (added.length > 0) {
    eview.setUint16(8, view.getUint16(eocdOffset + 8, true) + added.length, true);
    eview.setUint16(10, view.getUint16(eocdOffset + 10, true) + added.length, true);
  }
  eview.setUint32(12, newCdSize, true);
  eview.setUint32(16, newCdOffset, true);
  segments.push(eocd);
  offset += eocd.length;
  const result = new Uint8Array(offset);
  let pos = 0;
  for (const seg of segments) {
    result.set(seg, pos);
    pos += seg.length;
  }
  return result;
}

// src/form/filler-hwpx.ts
async function fillHwpx(hwpxBuffer, values, blockedLabels) {
  const u8 = new Uint8Array(hwpxBuffer);
  const zip = await _jszip2.default.loadAsync(hwpxBuffer);
  const sectionPaths = Object.keys(zip.files).filter((name) => /[Ss]ection\d+\.xml$/i.test(name)).sort();
  if (sectionPaths.length === 0) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("HWPX\uC5D0\uC11C \uC139\uC158 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  }
  const normalizedValues = normalizeValues(values);
  const cursor = new ValueCursor(normalizedValues);
  const matchedLabels = /* @__PURE__ */ new Set();
  const filled = [];
  const failedKeys = /* @__PURE__ */ new Set();
  const succeededKeys = /* @__PURE__ */ new Set();
  const replacements = /* @__PURE__ */ new Map();
  const encoder = new TextEncoder();
  for (let si = 0; si < sectionPaths.length; si++) {
    const xml = await zip.file(sectionPaths[si]).async("text");
    const scan = scanSectionXml(xml, si);
    const ledger = /* @__PURE__ */ new Map();
    const led = (p) => {
      let l = ledger.get(p);
      if (!l) ledger.set(p, l = { ranges: [], filledIdx: [], matchKeys: [] });
      return l;
    };
    const matchText = (p) => _nullishCoalesce(paraTText(p, xml), () => ( p.text));
    const cellLabelText = (cell) => cell.paragraphs.filter((p) => !p.inTextbox).map((p) => matchText(p)).join("");
    const allTables = [];
    const collectTables = (tables, depth) => {
      if (depth > 16) return;
      for (const t of tables) {
        allTables.push(t);
        for (const row of t.rows) {
          for (const cell of row) collectTables(cell.tables, depth + 1);
        }
      }
    };
    collectTables(scan.tables, 0);
    collectTables(scan.orphanTables, 0);
    const patternApplied = /* @__PURE__ */ new Set();
    for (const table of allTables) {
      for (const row of table.rows) {
        for (const cell of row) {
          for (const para of cell.paragraphs) {
            const text = matchText(para);
            const result = fillInCellPatterns(text, cursor, matchedLabels, blockedLabels);
            if (!result) continue;
            const l = led(para);
            if (l.fullText !== void 0) continue;
            const newT = result.text;
            let s = 0;
            while (s < text.length && s < newT.length && text[s] === newT[s]) s++;
            let eo = text.length;
            let en = newT.length;
            while (eo > s && en > s && text[eo - 1] === newT[en - 1]) {
              eo--;
              en--;
            }
            l.ranges.push({ start: s, end: eo, replacement: newT.slice(s, en) });
            patternApplied.add(cell);
            for (const m of result.matches) {
              l.filledIdx.push(filled.length);
              l.matchKeys.push(m.key);
              filled.push({ label: m.label, value: m.value, row: -1, col: -1, key: m.key });
            }
          }
        }
      }
    }
    for (const table of allTables) {
      for (let rowIdx = 0; rowIdx < table.rows.length; rowIdx++) {
        const cells = table.rows[rowIdx];
        for (let colIdx = 0; colIdx < cells.length - 1; colIdx++) {
          const labelText = cellLabelText(cells[colIdx]);
          if (!isLabelCell(labelText)) continue;
          const valueCell = cells[colIdx + 1];
          if (isKeywordLabel(cellLabelText(valueCell))) continue;
          const normalizedCellLabel = normalizeLabel(labelText);
          if (!normalizedCellLabel) continue;
          if (_optionalChain([blockedLabels, 'optionalAccess', _165 => _165.has, 'call', _166 => _166(normalizedCellLabel)])) continue;
          const matchKey = findMatchingKey(normalizedCellLabel, cursor);
          if (matchKey === void 0) continue;
          if (patternApplied.has(valueCell)) {
            const target = _nullishCoalesce(valueCell.paragraphs.find((p) => p.tRanges.length > 0), () => ( valueCell.paragraphs[0]));
            if (!target) continue;
            const l = led(target);
            if (l.fullText !== void 0) continue;
            const newValue = cursor.consume(matchKey);
            if (newValue === void 0) continue;
            l.ranges.push({ start: 0, end: 0, replacement: newValue + " " });
            l.filledIdx.push(filled.length);
            l.matchKeys.push(matchKey);
            matchedLabels.add(matchKey);
            filled.push({
              label: labelText.trim().replace(/[:：]\s*$/, ""),
              value: newValue,
              row: rowIdx,
              col: colIdx,
              key: matchKey
            });
          } else {
            const paras = valueCell.paragraphs;
            if (paras.length === 0) continue;
            const newValue = cursor.consume(matchKey);
            if (newValue === void 0) continue;
            const l0 = led(paras[0]);
            l0.fullText = newValue;
            l0.ranges = [];
            l0.filledIdx.push(filled.length);
            l0.matchKeys.push(matchKey);
            for (let k = 1; k < paras.length; k++) {
              const lk = led(paras[k]);
              lk.fullText = "";
              lk.ranges = [];
            }
            matchedLabels.add(matchKey);
            filled.push({
              label: labelText.trim().replace(/[:：]\s*$/, ""),
              value: newValue,
              row: rowIdx,
              col: colIdx,
              key: matchKey
            });
          }
        }
      }
      if (table.rows.length >= 2) {
        const headerCells = table.rows[0];
        const allLabels = headerCells.length > 0 && headerCells.every((cell) => {
          const t = cellLabelText(cell).trim();
          return t.length > 0 && t.length <= 20 && isLabelCell(t);
        });
        if (allLabels) {
          for (let rowIdx = 1; rowIdx < table.rows.length; rowIdx++) {
            const dataCells = table.rows[rowIdx];
            for (let colIdx = 0; colIdx < Math.min(headerCells.length, dataCells.length); colIdx++) {
              const headerLabel = normalizeLabel(cellLabelText(headerCells[colIdx]));
              if (_optionalChain([blockedLabels, 'optionalAccess', _167 => _167.has, 'call', _168 => _168(headerLabel)])) continue;
              const matchKey = findMatchingKey(headerLabel, cursor);
              if (matchKey === void 0) continue;
              if (!cursor.isArray(matchKey) && matchedLabels.has(matchKey)) continue;
              const newValue = cursor.consume(matchKey);
              if (newValue === void 0) continue;
              const paras = dataCells[colIdx].paragraphs;
              if (paras.length === 0) continue;
              const l0 = led(paras[0]);
              l0.fullText = newValue;
              l0.ranges = [];
              l0.filledIdx.push(filled.length);
              l0.matchKeys.push(matchKey);
              for (let k = 1; k < paras.length; k++) {
                const lk = led(paras[k]);
                lk.fullText = "";
                lk.ranges = [];
              }
              matchedLabels.add(matchKey);
              filled.push({
                label: cellLabelText(headerCells[colIdx]).trim(),
                value: newValue,
                row: rowIdx,
                col: colIdx,
                key: matchKey
              });
            }
          }
        }
      }
    }
    for (const para of [...scan.bodyParagraphs, ...scan.excludedParagraphs]) {
      const existing = ledger.get(para);
      if (_optionalChain([existing, 'optionalAccess', _169 => _169.fullText]) !== void 0) continue;
      const text = matchText(para);
      for (const seg of scanInlineSegments(text)) {
        const nlabel = normalizeLabel(seg.label);
        if (_optionalChain([blockedLabels, 'optionalAccess', _170 => _170.has, 'call', _171 => _171(nlabel)])) continue;
        const matchKey = findMatchingKey(nlabel, cursor);
        if (matchKey === void 0) continue;
        const newValue = cursor.consume(matchKey);
        if (newValue === void 0) continue;
        const replacement = seg.valueStart === seg.valueEnd ? padInsertion(text, seg.valueStart, newValue) : newValue;
        const l = led(para);
        l.ranges.push({ start: seg.valueStart, end: seg.valueEnd, replacement });
        matchedLabels.add(matchKey);
        l.filledIdx.push(filled.length);
        l.matchKeys.push(matchKey);
        filled.push({ label: seg.label.trim(), value: newValue, row: -1, col: -1, key: matchKey });
      }
    }
    const splices = [];
    for (const [para, l] of ledger) {
      let paraSplices = null;
      if (l.fullText !== void 0) {
        paraSplices = buildParagraphSplices(para, l.fullText, xml);
      } else if (l.ranges.length > 0) {
        const sorted = [...l.ranges].sort((a, b) => a.start - b.start || a.end - b.end);
        const merged = [];
        for (const r of sorted) {
          const prev = merged[merged.length - 1];
          if (prev && r.start < prev.end) continue;
          merged.push(r);
        }
        if (paraTText(para, xml) !== null) {
          const precise = [];
          let ok = true;
          for (const r of merged) {
            const sp = buildRangeSplices(para, xml, r.start, r.end, r.replacement);
            if (!sp) {
              ok = false;
              break;
            }
            precise.push(...sp);
          }
          paraSplices = ok ? precise : null;
        } else if (paraTextPureT(para, xml)) {
          let text = para.text;
          for (let k = merged.length - 1; k >= 0; k--) {
            const r = merged[k];
            text = text.slice(0, r.start) + r.replacement + text.slice(r.end);
          }
          paraSplices = buildParagraphSplices(para, text, xml);
        } else {
          paraSplices = null;
        }
      }
      if (paraSplices === null) {
        for (const idx of l.filledIdx) filled[idx] = null;
        for (const k of l.matchKeys) failedKeys.add(k);
        continue;
      }
      for (const k of l.matchKeys) succeededKeys.add(k);
      splices.push(...paraSplices);
    }
    if (splices.length > 0) {
      splices.push(...allLinesegRemovalSplices(xml));
      replacements.set(sectionPaths[si], encoder.encode(applySplices(xml, splices)));
    }
  }
  for (const k of failedKeys) {
    if (!succeededKeys.has(k)) matchedLabels.delete(k);
  }
  const cleanFilled = filled.filter((f) => f !== null);
  const unmatched = resolveUnmatched(normalizedValues, matchedLabels, values);
  const out = replacements.size > 0 ? patchZipEntries(u8, replacements) : new Uint8Array(u8);
  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    filled: cleanFilled,
    unmatched
  };
}

// src/hwpx/generator.ts


// src/hwpx/text-metrics.ts
var ASCII_W = [
  300,
  320,
  320,
  610,
  610,
  830,
  724,
  320,
  320,
  320,
  550,
  550,
  320,
  550,
  320,
  550,
  // 0x20-0x2F
  550,
  550,
  550,
  550,
  550,
  550,
  550,
  550,
  550,
  550,
  320,
  320,
  550,
  550,
  550,
  550,
  // 0x30-0x3F
  830,
  706,
  605,
  685,
  719,
  627,
  617,
  683,
  734,
  305,
  315,
  660,
  605,
  839,
  734,
  732,
  // 0x40-0x4F
  603,
  705,
  660,
  627,
  664,
  731,
  706,
  910,
  705,
  705,
  626,
  320,
  550,
  320,
  550,
  550,
  // 0x50-0x5F
  320,
  569,
  597,
  552,
  597,
  536,
  356,
  562,
  635,
  287,
  288,
  582,
  287,
  907,
  635,
  588,
  // 0x60-0x6F
  597,
  579,
  478,
  496,
  356,
  635,
  563,
  720,
  542,
  543,
  486,
  320,
  320,
  320,
  550,
  0
  // 0x70-0x7E(+DEL)
];
var SYM_W = {
  160: 300,
  163: 568,
  165: 707,
  167: 498,
  171: 440,
  172: 564,
  176: 291,
  177: 798,
  182: 606,
  183: 320,
  187: 440,
  215: 617,
  247: 678,
  8211: 625,
  8212: 875,
  8213: 875,
  8216: 320,
  8217: 320,
  8220: 480,
  8221: 480,
  8224: 558,
  8225: 438,
  8229: 640,
  8230: 960,
  8240: 988,
  8242: 335,
  8243: 474,
  8251: 770,
  8364: 656,
  9756: 1012,
  9758: 1012
};
function charWidthEm1000(cp) {
  if (cp >= 32 && cp <= 126) return ASCII_W[cp - 32];
  const sym = SYM_W[cp];
  if (sym !== void 0) return sym;
  if (cp >= 44032 && cp <= 55203) return 970;
  if (cp >= 4352 && cp <= 4607) return 970;
  if (cp >= 12593 && cp <= 12686) return 970;
  if (cp >= 19968 && cp <= 40959 || cp >= 63744 && cp <= 64255) return 1e3;
  if (cp >= 12296 && cp <= 12305 || cp >= 12308 && cp <= 12315) return 500;
  if (cp === 12288) return 970;
  if (cp >= 8592 && cp <= 8959) return 970;
  if (cp >= 9312 && cp <= 9471) return 970;
  if (cp >= 9632 && cp <= 9983) return 970;
  if (cp >= 12800 && cp <= 13311) return 970;
  if (cp >= 65281 && cp <= 65376) return 970;
  return cp >= 11904 ? 970 : 550;
}
var SPACE_EM_FIXED = 500;
var SPACE_EM_FONT = 300;
function measureTextWidth(text, height, ratioPct, opts) {
  const spaceEm = _nullishCoalesce(_optionalChain([opts, 'optionalAccess', _172 => _172.spaceEm]), () => ( SPACE_EM_FIXED));
  const spacing = _nullishCoalesce(_optionalChain([opts, 'optionalAccess', _173 => _173.spacingPct]), () => ( 0));
  let em = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const w = cp === 32 ? spaceEm : charWidthEm1000(cp);
    em += w * (1 + spacing / 100);
  }
  return em / 1e3 * height * (ratioPct / 100);
}
var FORBID_START = /* @__PURE__ */ new Set([..."!%),.:;?]}\xA2\xB0\u2032\u2033\u2103\u3009\u300B\u300D\u300F\u3011\u3015!%),.:;?]}\u20A9~\u2026\xB7\u3001\u3002\u3003"]);
var FORBID_END = /* @__PURE__ */ new Set([..."$([{\xA3\xA5\u3008\u300A\u300C\u300E\u3010\u3014$([{\u20A9"]);
function simulateWrap(text, firstWidth, contWidth, height, ratioPct, mode = "keep", opts) {
  const EPS = 0.5;
  const spaceEm = _nullishCoalesce(_optionalChain([opts, 'optionalAccess', _174 => _174.spaceEm]), () => ( SPACE_EM_FIXED));
  const spacing = _nullishCoalesce(_optionalChain([opts, 'optionalAccess', _175 => _175.spacingPct]), () => ( 0));
  const k = height * ratioPct / 100 / 1e3;
  const cwCp = (cp) => (cp === 32 ? spaceEm : charWidthEm1000(cp)) * (1 + spacing / 100) * k;
  const charW2 = (ch) => cwCp(ch.codePointAt(0));
  const rangeW = (from, to) => {
    let w = 0;
    for (const ch of text.slice(from, to)) w += charW2(ch);
    return w;
  };
  const units = _nullishCoalesce(text.match(mode === "keep" ? / +|[^ ]+/g : / +|[^ ]/g), () => ( []));
  const starts = [0];
  let lineW = 0;
  let avail = firstWidth;
  let pos = 0;
  const lineStart = () => starts[starts.length - 1];
  const breakBefore = (unitPos, w) => {
    let bp = unitPos;
    const u = text[unitPos];
    if (u !== void 0 && FORBID_START.has(u) && bp - 1 > lineStart() && text[bp - 1] !== " ") bp--;
    while (bp - 1 > lineStart() && FORBID_END.has(text[bp - 1])) bp--;
    if (bp <= lineStart()) bp = unitPos;
    starts.push(bp);
    avail = contWidth;
    lineW = rangeW(bp, unitPos) + w;
  };
  for (const u of units) {
    if (u[0] === " ") {
      lineW += charW2(" ") * u.length;
      pos += u.length;
      continue;
    }
    const w = rangeW(pos, pos + u.length);
    if (lineW + w <= avail + EPS) {
      lineW += w;
      pos += u.length;
      continue;
    }
    if (lineW === 0 || w > contWidth + EPS) {
      let sub = 0;
      for (const ch of u) {
        const c = charW2(ch);
        if (lineW + c > avail + EPS && lineW > 0) breakBefore(pos + sub, 0);
        lineW += c;
        sub += ch.length;
      }
      pos += u.length;
      continue;
    }
    breakBefore(pos, w);
    pos += u.length;
  }
  return { lines: starts.length, starts, lastLineWidth: lineW };
}
function simulateWrapKeepWord(text, firstWidth, contWidth, height, ratioPct, opts) {
  return simulateWrap(text, firstWidth, contWidth, height, ratioPct, "keep", opts);
}
function fitRatioForFewerLines(text, firstWidth, contWidth, height, baseRatio, minRatio, opts) {
  const base = simulateWrap(text, firstWidth, contWidth, height, baseRatio, "keep", opts);
  if (base.lines < 2) return null;
  for (let r = baseRatio - 1; r >= minRatio; r--) {
    const sim = simulateWrap(text, firstWidth, contWidth, height, r, "keep", opts);
    if (sim.lines < base.lines) return r;
  }
  return null;
}

// src/hwpx/gongmun.ts
var OFFICIAL_MARGINS = { top: 20, bottom: 10, left: 20, right: 20 };
var PRESET_DEFAULTS = {
  official: { bodyPt: 15, lineSpacing: 160, numbering: "standard" },
  report: { bodyPt: 15, lineSpacing: 160, numbering: "report" },
  plan: { bodyPt: 15, lineSpacing: 160, numbering: "standard" },
  notice: { bodyPt: 15, lineSpacing: 160, numbering: "standard" },
  minutes: { bodyPt: 14, lineSpacing: 130, numbering: "standard" }
};
var PRESET_ALIAS = {
  official: "official",
  \uAE30\uC548\uBB38: "official",
  \uC2DC\uD589\uBB38: "official",
  \uACF5\uBB38: "official",
  \uACF5\uBB38\uC11C: "official",
  report: "report",
  \uBCF4\uACE0\uC11C: "report",
  plan: "plan",
  \uACC4\uD68D\uC11C: "plan",
  \uACC4\uD68D: "plan",
  notice: "notice",
  \uD1B5\uC9C0: "notice",
  \uC54C\uB9BC: "notice",
  \uC548\uB0B4: "notice",
  minutes: "minutes",
  \uD68C\uC758\uB85D: "minutes"
};
function normalizeGongmunPreset(preset) {
  if (!preset) return "official";
  return _nullishCoalesce(PRESET_ALIAS[preset.trim()], () => ( "official"));
}
function resolveGongmun(opts) {
  const preset = normalizeGongmunPreset(opts.preset);
  const d = PRESET_DEFAULTS[preset];
  const bodyPt = _nullishCoalesce(opts.bodyPt, () => ( d.bodyPt));
  const autoFitMinRatio = opts.autoFit === false ? null : typeof opts.autoFit === "object" ? Math.min(Math.max(_nullishCoalesce(opts.autoFit.minRatio, () => ( 90)), 50), 99) : 90;
  return {
    preset,
    bodyFont: _nullishCoalesce(opts.bodyFont, () => ( "myeongjo")),
    bodyHeight: Math.round(bodyPt * 100),
    lineSpacing: _nullishCoalesce(opts.lineSpacing, () => ( d.lineSpacing)),
    numbering: _nullishCoalesce(opts.numbering, () => ( d.numbering)),
    margins: _nullishCoalesce(opts.margins, () => ( OFFICIAL_MARGINS)),
    centerTitle: _nullishCoalesce(opts.centerTitle, () => ( true)),
    autoFitMinRatio
  };
}
var HANGUL_INITIALS = [0, 2, 3, 5, 6, 7, 9, 11, 12, 14, 15, 16, 17, 18];
var HANGUL_MEDIALS = [0, 4, 8, 13, 18, 20];
function hangulOrdinal(n) {
  const cols = HANGUL_INITIALS.length;
  const vowel = HANGUL_MEDIALS[Math.min(Math.floor(n / cols), HANGUL_MEDIALS.length - 1)];
  const init = HANGUL_INITIALS[n % cols];
  return String.fromCodePoint(44032 + init * 588 + vowel * 28);
}
function circledNumber(n) {
  return String.fromCodePoint(9312 + n % 20);
}
function circledHangul(n) {
  return String.fromCodePoint(12910 + n % 14);
}
var REPORT_BULLETS = ["\u25A1", "\u25CB", "-", "\u318D"];
function standardMarker(depth, n) {
  switch (depth) {
    case 0:
      return `${n + 1}.`;
    case 1:
      return `${hangulOrdinal(n)}.`;
    case 2:
      return `${n + 1})`;
    case 3:
      return `${hangulOrdinal(n)})`;
    case 4:
      return `(${n + 1})`;
    case 5:
      return `(${hangulOrdinal(n)})`;
    case 6:
      return circledNumber(n);
    case 7:
      return circledHangul(n);
    default:
      return circledHangul(n);
  }
}
function reportMarker(depth) {
  return REPORT_BULLETS[Math.min(depth, REPORT_BULLETS.length - 1)];
}
function markerWidth(marker, bodyHeight) {
  let em = SPACE_EM_FIXED;
  for (const c of marker) em += charWidthEm1000(c.codePointAt(0));
  return Math.round(em / 1e3 * bodyHeight);
}
function levelIndent(depth, bodyHeight, numbering) {
  const marker = numbering === "report" ? reportMarker(depth) : standardMarker(depth, 0);
  return { left: Math.round(depth * bodyHeight), indent: -markerWidth(marker, bodyHeight) };
}
function computeSuppression(depths) {
  const counts = /* @__PURE__ */ new Map();
  const keys = [];
  const path = [];
  for (const depth of depths) {
    path.length = depth + 1;
    path[depth] = (_nullishCoalesce(path[depth], () => ( 0))) + 1;
    const parentKey = path.slice(0, depth).join(".") + "|" + depth;
    keys.push(parentKey);
    counts.set(parentKey, (_nullishCoalesce(counts.get(parentKey), () => ( 0))) + 1);
  }
  return keys.map((k) => (_nullishCoalesce(counts.get(k), () => ( 0))) <= 1);
}
var GongmunNumberer = (_class3 = class {
  constructor(numbering) {;_class3.prototype.__init5.call(this);
    this.numbering = numbering;
  }
  __init5() {this.counts = []}
  /** depth 항목 하나에 대한 마커. suppress=true면 빈 문자열(부호 없음) */
  next(depth, suppress) {
    this.counts.length = depth + 1;
    const n = _nullishCoalesce(this.counts[depth], () => ( 0));
    this.counts[depth] = n + 1;
    if (suppress) return "";
    return this.numbering === "report" ? reportMarker(depth) : standardMarker(depth, n);
  }
  reset() {
    this.counts = [];
  }
}, _class3);
function mmToHwpunit(mm) {
  return Math.round(mm * 7200 / 25.4);
}

// src/hwpx/gen-ids.ts
var NS_SECTION = "http://www.hancom.co.kr/hwpml/2011/section";
var NS_PARA = "http://www.hancom.co.kr/hwpml/2011/paragraph";
var NS_HEAD = "http://www.hancom.co.kr/hwpml/2011/head";
var NS_CORE = "http://www.hancom.co.kr/hwpml/2011/core";
var NS_OPF = "http://www.idpf.org/2007/opf/";
var NS_HPF = "http://www.hancom.co.kr/schema/2011/hpf";
var NS_OCF = "urn:oasis:names:tc:opendocument:xmlns:container";
var CHAR_NORMAL = 0;
var CHAR_BOLD = 1;
var CHAR_ITALIC = 2;
var CHAR_BOLD_ITALIC = 3;
var CHAR_CODE = 4;
var CHAR_H1 = 5;
var CHAR_H2 = 6;
var CHAR_H3 = 7;
var CHAR_H4 = 8;
var CHAR_TABLE_HEADER = 9;
var CHAR_QUOTE = 10;
var PARA_NORMAL = 0;
var PARA_H1 = 1;
var PARA_H2 = 2;
var PARA_H3 = 3;
var PARA_H4 = 4;
var PARA_CODE = 5;
var PARA_QUOTE = 6;
var PARA_LIST = 7;
var DEFAULT_TEXT_COLOR = "#000000";
function resolveTheme(theme) {
  return {
    h1: _nullishCoalesce(_optionalChain([theme, 'optionalAccess', _176 => _176.headingColors, 'optionalAccess', _177 => _177[1]]), () => ( DEFAULT_TEXT_COLOR)),
    h2: _nullishCoalesce(_optionalChain([theme, 'optionalAccess', _178 => _178.headingColors, 'optionalAccess', _179 => _179[2]]), () => ( DEFAULT_TEXT_COLOR)),
    h3: _nullishCoalesce(_optionalChain([theme, 'optionalAccess', _180 => _180.headingColors, 'optionalAccess', _181 => _181[3]]), () => ( DEFAULT_TEXT_COLOR)),
    h4: _nullishCoalesce(_nullishCoalesce(_optionalChain([theme, 'optionalAccess', _182 => _182.headingColors, 'optionalAccess', _183 => _183[4]]), () => ( _optionalChain([theme, 'optionalAccess', _184 => _184.headingColors, 'optionalAccess', _185 => _185[3]]))), () => ( DEFAULT_TEXT_COLOR)),
    body: _nullishCoalesce(_optionalChain([theme, 'optionalAccess', _186 => _186.bodyColor]), () => ( DEFAULT_TEXT_COLOR)),
    quote: _nullishCoalesce(_optionalChain([theme, 'optionalAccess', _187 => _187.quoteColor]), () => ( DEFAULT_TEXT_COLOR)),
    /** quoteColor가 명시되었는지 — blockquote charPr 분기에 사용 (baseline 호환) */
    hasQuoteOption: _optionalChain([theme, 'optionalAccess', _188 => _188.quoteColor]) !== void 0,
    tableHeader: _nullishCoalesce(_nullishCoalesce(_optionalChain([theme, 'optionalAccess', _189 => _189.tableHeaderColor]), () => ( _optionalChain([theme, 'optionalAccess', _190 => _190.bodyColor]))), () => ( DEFAULT_TEXT_COLOR)),
    tableHeaderBold: !!_optionalChain([theme, 'optionalAccess', _191 => _191.tableHeaderBold])
  };
}
function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function headingParaPrId(level) {
  if (level === 1) return PARA_H1;
  if (level === 2) return PARA_H2;
  if (level === 3) return PARA_H3;
  return PARA_H4;
}
function headingCharPrId(level) {
  if (level === 1) return CHAR_H1;
  if (level === 2) return CHAR_H2;
  if (level === 3) return CHAR_H3;
  return CHAR_H4;
}
function charPr(id, height, bold, italic, fontId = 0, textColor = DEFAULT_TEXT_COLOR, ratioPct = 100) {
  const boldAttr = bold ? ` bold="1"` : "";
  const italicAttr = italic ? ` italic="1"` : "";
  const effFont = bold ? 2 : fontId;
  return `      <hh:charPr id="${id}" height="${height}" textColor="${textColor}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"${boldAttr}${italicAttr}>
        <hh:fontRef hangul="${effFont}" latin="${effFont}" hanja="${effFont}" japanese="${effFont}" other="${effFont}" symbol="${effFont}" user="${effFont}"/>
        <hh:ratio hangul="${ratioPct}" latin="${ratioPct}" hanja="${ratioPct}" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>`;
}
function paraPr(id, opts = {}) {
  const { align = "JUSTIFY", spaceBefore = 0, spaceAfter = 0, lineSpacing = 160, indent = 0, left = 0, keepWord = false, outlineLevel } = opts;
  const breakNonLatin = keepWord ? "KEEP_WORD" : "BREAK_WORD";
  const snapGrid = keepWord ? "0" : "1";
  const heading = outlineLevel !== void 0 ? `<hh:heading type="OUTLINE" idRef="0" level="${outlineLevel}"/>` : `<hh:heading type="NONE" idRef="0" level="0"/>`;
  return `      <hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="${snapGrid}" suppressLineNumbers="0" checked="0" textDir="AUTO">
        <hh:align horizontal="${align}" vertical="BASELINE"/>
        ${heading}
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="${breakNonLatin}" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        <hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${spaceBefore}" unit="HWPUNIT"/><hc:next value="${spaceAfter}" unit="HWPUNIT"/></hh:margin>
        <hh:lineSpacing type="PERCENT" value="${lineSpacing}"/>
        <hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>`;
}
var GONGMUN_LIST_BASE = 8;
var GONGMUN_LIST_LEVELS = 8;
var GONGMUN_CENTER = GONGMUN_LIST_BASE + GONGMUN_LIST_LEVELS;
var CHAR_VARIANT_BASE = 11;
var GONGMUN_BODY_RATIO = 95;

// src/hwpx/md-runs.ts
function buildPrvText(blocks) {
  const lines = [];
  let bytes = 0;
  for (const b of blocks) {
    let text = b.text || (b.rows ? b.rows.map((r) => r.join(" ")).join("\n") : "");
    if (b.type === "code_block" && (b.lang || "").toLowerCase() === "chart") text = "[\uCC28\uD2B8]";
    else if (b.type === "html_table") text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(text);
    bytes += text.length * 3;
    if (bytes > 1024) break;
  }
  return lines.join("\n").slice(0, 1024);
}
function findMathDelim(s, from) {
  let i = s.indexOf("$$", from);
  while (i > 0) {
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) break;
    i = s.indexOf("$$", i + 1);
  }
  return i;
}
function parseMarkdownToBlocks(md2) {
  const lines = md2.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const mathOpen = /^\s*\$\$/.exec(line);
    if (mathOpen) {
      const afterOpen = line.slice(mathOpen[0].length);
      const closeSame = findMathDelim(afterOpen, 0);
      if (closeSame >= 0) {
        const inner = afterOpen.slice(0, closeSame).trim();
        const trailing2 = afterOpen.slice(closeSame + 2).trim();
        if (inner) blocks.push({ type: "equation", text: inner });
        if (trailing2) blocks.push({ type: "paragraph", text: trailing2 });
        i++;
        continue;
      }
      const mathLines = [];
      if (afterOpen.trim()) mathLines.push(afterOpen);
      let closed = false;
      let trailing = "";
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim() || /^\s*(`{3,}|~{3,})/.test(l)) break;
        const end = findMathDelim(l, 0);
        if (end >= 0) {
          const before = l.slice(0, end);
          if (before.trim()) mathLines.push(before);
          trailing = l.slice(end + 2).trim();
          closed = true;
          j++;
          break;
        }
        mathLines.push(l);
      }
      if (closed) {
        const text = mathLines.join("\n").trim();
        if (text) blocks.push({ type: "equation", text });
        if (trailing) blocks.push({ type: "paragraph", text: trailing });
        i = j;
        continue;
      }
    }
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2].trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].replace(/^ {0,3}/, "").startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: "code_block", text: codeLines.join("\n"), lang });
      continue;
    }
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ type: "heading", text: headingMatch[2].trim(), level: headingMatch[1].length });
      i++;
      continue;
    }
    if (/^<table[\s>]/i.test(line.trimStart())) {
      const htmlLines = [];
      let depth = 0;
      while (i < lines.length) {
        const l = lines[i];
        htmlLines.push(l);
        depth += (_nullishCoalesce(l.match(/<table[\s>]/gi), () => ( []))).length;
        depth -= (_nullishCoalesce(l.match(/<\/table>/gi), () => ( []))).length;
        i++;
        if (depth <= 0) break;
      }
      blocks.push({ type: "html_table", text: htmlLines.join("\n") });
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      const tableRows = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const row = lines[i];
        if (/^[\s|:\-]+$/.test(row)) {
          i++;
          continue;
        }
        const cells = row.split("|").slice(1, -1).map((c) => c.trim());
        if (cells.length > 0) tableRows.push(cells);
        i++;
      }
      if (tableRows.length > 0) blocks.push({ type: "table", rows: tableRows });
      continue;
    }
    if (line.trimStart().startsWith("> ")) {
      const quoteLines = [];
      while (i < lines.length && (lines[i].trimStart().startsWith("> ") || lines[i].trimStart().startsWith(">"))) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      for (const ql of quoteLines) {
        blocks.push({ type: "blockquote", text: ql.trim() || "" });
      }
      continue;
    }
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)]) (.+)$/);
    if (listMatch) {
      const indent = Math.floor(listMatch[1].length / 2);
      const ordered = /\d/.test(listMatch[2]);
      blocks.push({ type: "list_item", text: listMatch[3].trim(), ordered, indent, marker: listMatch[2] });
      i++;
      continue;
    }
    blocks.push({ type: "paragraph", text: line.trim() });
    i++;
  }
  return blocks;
}
function parseInlineMarkdown(text) {
  const literals = [];
  text = text.replace(/\x00/g, "").replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c) => {
    literals.push(c);
    return `\0${literals.length - 1}\0`;
  });
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, t, u) => t || u);
  text = text.replace(/~~([^~]+)~~/g, "$1");
  const spans = [];
  const regex = /(`[^`]+`|\*{3}[^*]+\*{3}|\*{2}[^*]+\*{2}|\*[^*]+\*|_{2}[^_]+_{2}|_[^_]+_)/g;
  let lastIdx = 0;
  for (const match of text.matchAll(regex)) {
    const idx = match.index;
    if (idx > lastIdx) {
      spans.push({ text: text.slice(lastIdx, idx), bold: false, italic: false, code: false });
    }
    const raw = match[0];
    if (raw.startsWith("`")) {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: false, code: true });
    } else if (raw.startsWith("***") || raw.startsWith("___")) {
      spans.push({ text: raw.slice(3, -3), bold: true, italic: true, code: false });
    } else if (raw.startsWith("**") || raw.startsWith("__")) {
      spans.push({ text: raw.slice(2, -2), bold: true, italic: false, code: false });
    } else {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: true, code: false });
    }
    lastIdx = idx + raw.length;
  }
  if (lastIdx < text.length) {
    spans.push({ text: text.slice(lastIdx), bold: false, italic: false, code: false });
  }
  if (spans.length === 0) {
    spans.push({ text, bold: false, italic: false, code: false });
  }
  for (const span of spans) {
    if (!span.text.includes("\0")) continue;
    span.text = span.text.replace(/\x00(\d+)\x00/g, (_, i) => {
      const c = _nullishCoalesce(literals[+i], () => ( ""));
      return span.code ? "\\" + c : c;
    });
  }
  return spans;
}
function spanToCharPrId(span) {
  if (span.code) return CHAR_CODE;
  if (span.bold && span.italic) return CHAR_BOLD_ITALIC;
  if (span.bold) return CHAR_BOLD;
  if (span.italic) return CHAR_ITALIC;
  return CHAR_NORMAL;
}
function generateRuns(text, defaultCharPr = CHAR_NORMAL, mapCharId) {
  const spans = parseInlineMarkdown(text);
  return spans.map((span) => {
    let charId = span.code || span.bold || span.italic ? spanToCharPrId(span) : defaultCharPr;
    if (mapCharId) charId = mapCharId(charId);
    return `<hp:run charPrIDRef="${charId}"><hp:t>${escapeXml(span.text)}</hp:t></hp:run>`;
  }).join("");
}
function generateParagraph(text, paraPrId = PARA_NORMAL, charPrId = CHAR_NORMAL, mapCharId) {
  if (paraPrId === PARA_CODE) {
    return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_CODE}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`;
  }
  const runs = generateRuns(text, charPrId, mapCharId);
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0">${runs}</hp:p>`;
}

// src/hwpx/gen-header.ts
function generateContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ocf:container xmlns:ocf="${NS_OCF}" xmlns:hpf="${NS_HPF}">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
  </ocf:rootfiles>
</ocf:container>`;
}
function generateManifest(chartParts = []) {
  const chartItems = chartParts.map((p, i) => `
    <opf:item id="chart${i + 1}" href="${p.name}" media-type="application/xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:opf="${NS_OPF}" xmlns:hpf="${NS_HPF}" xmlns:hh="${NS_HEAD}">
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>${chartItems}
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="no"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`;
}
function buildCharProperties(theme, gongmun, ratioVariants = [], extraCharPrXmls = []) {
  let body = 1e3, code = 900, h1 = 1800, h2 = 1400, h3 = 1200, h4 = 1100;
  if (gongmun) {
    body = gongmun.bodyHeight;
    code = Math.max(body - 200, 900);
    h1 = gongmun.preset === "report" || gongmun.preset === "plan" ? 2e3 : 1700;
    h2 = 1600;
    h3 = body;
    h4 = Math.max(body - 100, 1300);
  }
  const bodyRatio = gongmun ? GONGMUN_BODY_RATIO : 100;
  const rows = [
    charPr(0, body, false, false, 0, theme.body, bodyRatio),
    charPr(1, body, true, false, 0, theme.body, bodyRatio),
    charPr(2, body, false, true, 0, theme.body, bodyRatio),
    charPr(3, body, true, true, 0, theme.body, bodyRatio),
    charPr(4, code, false, false, 1),
    charPr(5, h1, true, false, 1, theme.h1),
    charPr(6, h2, true, false, 1, theme.h2),
    charPr(7, h3, true, false, 1, theme.h3),
    charPr(8, h4, true, false, 1, theme.h4),
    charPr(CHAR_TABLE_HEADER, body, theme.tableHeaderBold, false, 0, theme.tableHeader),
    charPr(CHAR_QUOTE, body, false, true, 0, theme.quote)
  ];
  for (const r of ratioVariants) {
    rows.push(
      charPr(rows.length, body, false, false, 0, theme.body, r),
      charPr(rows.length + 1, body, true, false, 0, theme.body, r),
      charPr(rows.length + 2, body, false, true, 0, theme.body, r),
      charPr(rows.length + 3, body, true, true, 0, theme.body, r)
    );
  }
  rows.push(...extraCharPrXmls);
  return `<hh:charProperties itemCnt="${rows.length}">
${rows.join("\n")}
    </hh:charProperties>`;
}
function buildParaProperties(gongmun) {
  if (!gongmun) {
    const base2 = [
      paraPr(0),
      paraPr(1, { align: "LEFT", spaceBefore: 800, spaceAfter: 200, lineSpacing: 180, outlineLevel: 0 }),
      paraPr(2, { align: "LEFT", spaceBefore: 600, spaceAfter: 150, lineSpacing: 170, outlineLevel: 1 }),
      paraPr(3, { align: "LEFT", spaceBefore: 400, spaceAfter: 100, lineSpacing: 160, outlineLevel: 2 }),
      paraPr(4, { align: "LEFT", spaceBefore: 300, spaceAfter: 100, lineSpacing: 160, outlineLevel: 3 }),
      paraPr(5, { align: "LEFT", lineSpacing: 130, indent: 400 }),
      paraPr(6, { align: "LEFT", lineSpacing: 150, indent: 600 }),
      paraPr(7, { align: "LEFT", lineSpacing: 160, indent: 600 })
    ];
    return `<hh:paraProperties itemCnt="${base2.length}">
${base2.join("\n")}
    </hh:paraProperties>`;
  }
  const ls = gongmun.lineSpacing;
  const titleAlign = gongmun.centerTitle ? "CENTER" : "LEFT";
  const base = [
    paraPr(0, { lineSpacing: ls, keepWord: true }),
    paraPr(1, { align: titleAlign, spaceBefore: 400, spaceAfter: 400, lineSpacing: ls, keepWord: true, outlineLevel: 0 }),
    paraPr(2, { align: "LEFT", spaceBefore: 600, spaceAfter: 150, lineSpacing: ls, keepWord: true, outlineLevel: 1 }),
    paraPr(3, { align: "LEFT", spaceBefore: 400, spaceAfter: 100, lineSpacing: ls, keepWord: true, outlineLevel: 2 }),
    paraPr(4, { align: "LEFT", spaceBefore: 300, spaceAfter: 100, lineSpacing: ls, keepWord: true, outlineLevel: 3 }),
    paraPr(5, { align: "LEFT", lineSpacing: 130, indent: 400, keepWord: true }),
    paraPr(6, { align: "LEFT", lineSpacing: ls, indent: 600, keepWord: true }),
    paraPr(7, { align: "LEFT", lineSpacing: ls, indent: 600, keepWord: true })
  ];
  for (let d = 0; d < GONGMUN_LIST_LEVELS; d++) {
    const { left, indent } = levelIndent(d, gongmun.bodyHeight, gongmun.numbering);
    const sectionGap = gongmun.numbering === "report" && d === 0 ? Math.round(gongmun.bodyHeight * 0.5) : 0;
    base.push(paraPr(GONGMUN_LIST_BASE + d, { align: "JUSTIFY", lineSpacing: ls, left, indent, spaceBefore: sectionGap, keepWord: true }));
  }
  base.push(paraPr(GONGMUN_CENTER, { align: "CENTER", lineSpacing: ls, keepWord: true }));
  return `<hh:paraProperties itemCnt="${base.length}">
${base.join("\n")}
    </hh:paraProperties>`;
}
function buildNumberings() {
  const heads = Array.from(
    { length: 7 },
    (_, i) => `        <hh:paraHead start="1" level="${i + 1}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"/>`
  ).join("\n");
  return `<hh:numberings itemCnt="1">
      <hh:numbering id="1" start="0">
${heads}
      </hh:numbering>
    </hh:numberings>`;
}
function generateHeaderXml(theme, gongmun, ratioVariants = [], remap = null) {
  const bodyFace = _optionalChain([gongmun, 'optionalAccess', _192 => _192.bodyFont]) === "gothic" ? "\uB9D1\uC740 \uACE0\uB515" : "\uD568\uCD08\uB86C\uBC14\uD0D5";
  const charPropsXml = buildCharProperties(theme, gongmun, ratioVariants, _nullishCoalesce(_optionalChain([remap, 'optionalAccess', _193 => _193.charPrXmls]), () => ( [])));
  const paraPropsXml = buildParaProperties(gongmun);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hh:head xmlns:hh="${NS_HEAD}" xmlns:hp="${NS_PARA}" xmlns:hc="${NS_CORE}" version="1.4" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="7">
      <hh:fontface lang="HANGUL" fontCnt="3">
        <hh:font id="0" face="${bodyFace}" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
        <hh:font id="1" face="\uD568\uCD08\uB86C\uB3CB\uC6C0" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
        <hh:font id="2" face="HY\uACAC\uACE0\uB515" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="LATIN" fontCnt="3">
        <hh:font id="0" face="Times New Roman" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_OLDSTYLE" weight="5" proportion="4" contrast="2" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="4"/>
        </hh:font>
        <hh:font id="1" face="Consolas" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_MODERN" weight="5" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
        <hh:font id="2" face="Arial Black" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="HANJA" fontCnt="1">
        <hh:font id="0" face="\uD568\uCD08\uB86C\uBC14\uD0D5" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="JAPANESE" fontCnt="1">
        <hh:font id="0" face="\uAD74\uB9BC" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="OTHER" fontCnt="1">
        <hh:font id="0" face="\uAD74\uB9BC" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="SYMBOL" fontCnt="1">
        <hh:font id="0" face="Symbol" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="USER" fontCnt="1">
        <hh:font id="0" face="\uAD74\uB9BC" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
    </hh:fontfaces>
    <hh:borderFills itemCnt="${2 + (_nullishCoalesce(_optionalChain([remap, 'optionalAccess', _194 => _194.borderFillXmls, 'access', _195 => _195.length]), () => ( 0)))}">
      <hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:topBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>
      </hh:borderFill>
      <hh:borderFill id="2" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>
      </hh:borderFill>${remap && remap.borderFillXmls.length ? "\n" + remap.borderFillXmls.join("\n") : ""}
    </hh:borderFills>
    ${charPropsXml}
    <hh:tabProperties itemCnt="0"/>
    ${buildNumberings()}
    <hh:bullets itemCnt="0"/>
    ${paraPropsXml}
    <hh:styles itemCnt="1">
      <hh:style id="0" type="PARA" name="\uBC14\uD0D5\uAE00" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langIDRef="1042" lockForm="0"/>
    </hh:styles>
  </hh:refList>
  <hh:compatibleDocument targetProgram="HWP2018"><hh:layoutCompatibility/></hh:compatibleDocument>
</hh:head>`;
}

// src/hwpx/chart-gen.ts
var XML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
var xmlEscape = (s) => s.replace(/[&<>]/g, (c) => XML_ESC[c]);
var CHART_TYPES = {
  0: { el: "barChart", dir: "col", grp: "clustered" },
  1: { el: "barChart", dir: "col", grp: "stacked", overlap: 100 },
  2: { el: "lineChart", grp: "standard", marker: true },
  3: { el: "barChart", dir: "bar", grp: "clustered" },
  4: { el: "barChart", dir: "bar", grp: "stacked", overlap: 100 },
  5: { el: "scatterChart", scatter: true },
  6: { el: "pieChart", pie: true },
  7: { el: "pieChart", pie: true, explode: true },
  8: { el: "doughnutChart", pie: true, hole: 50 },
  9: { el: "areaChart", grp: "standard" },
  10: { el: "areaChart", grp: "stacked" },
  11: { el: "radarChart", radar: true },
  12: { el: "bar3DChart", dir: "col", grp: "clustered" },
  13: { el: "bar3DChart", dir: "col", grp: "stacked", overlap: 100 },
  14: { el: "bar3DChart", dir: "bar", grp: "clustered" },
  15: { el: "bar3DChart", dir: "bar", grp: "stacked", overlap: 100 },
  16: { el: "pie3DChart", pie: true },
  17: { el: "pie3DChart", pie: true, explode: true },
  18: { el: "area3DChart", grp: "standard" },
  19: { el: "area3DChart", grp: "stacked" }
};
var CHART_ALIAS = {
  column: 0,
  col: 0,
  \uC138\uB85C\uB9C9\uB300: 0,
  \uB9C9\uB300: 0,
  column_stacked: 1,
  \uC138\uB85C\uB9C9\uB300_\uB204\uC801: 1,
  line: 2,
  \uC120: 2,
  \uAEBE\uC740\uC120: 2,
  bar: 3,
  \uAC00\uB85C\uB9C9\uB300: 3,
  bar_stacked: 4,
  scatter: 5,
  \uBD84\uC0B0: 5,
  pie: 6,
  \uC6D0: 6,
  \uD30C\uC774: 6,
  pie_explode: 7,
  doughnut: 8,
  donut: 8,
  \uB3C4\uB11B: 8,
  area: 9,
  \uC601\uC5ED: 9,
  area_stacked: 10,
  radar: 11,
  \uBC29\uC0AC\uD615: 11,
  bar3d: 12,
  column3d: 12,
  pie3d: 16
};
function chartSpec(t) {
  if (!t) return CHART_TYPES[0];
  const key = _nullishCoalesce(CHART_ALIAS[t.toLowerCase()], () => ( Number(t)));
  return _nullishCoalesce(CHART_TYPES[key], () => ( CHART_TYPES[0]));
}
var HU_PER_MM = 7200 / 25.4;
var RESERVED_KEYS = /* @__PURE__ */ new Set(["type", "cat", "size", "colors", "point_colors", "title"]);
function parseChartFence(text) {
  let type;
  let cat = null;
  let widthMm = 32250 / HU_PER_MM;
  let heightMm = 18750 / HU_PER_MM;
  let colors = null;
  let pointColors = null;
  const series = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.search(/[:：]/);
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const keyLower = key.toLowerCase();
    if (keyLower === "type") {
      type = value;
    } else if (keyLower === "cat") {
      cat = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (keyLower === "size") {
      const m = value.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
      if (m) {
        const clamp = (n) => Math.min(500, Math.max(10, n));
        widthMm = clamp(Number(m[1]));
        heightMm = clamp(Number(m[2]));
      }
    } else if (keyLower === "colors") {
      colors = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (keyLower === "point_colors") {
      pointColors = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (keyLower === "title") {
    } else if (!RESERVED_KEYS.has(keyLower)) {
      const segs = value.replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1").split(",").map((s) => s.trim()).filter(Boolean);
      if (segs.length === 0) continue;
      const nums = segs.map(Number);
      if (nums.every((n) => Number.isFinite(n))) {
        series.push({ name: key, values: nums });
      } else {
        return null;
      }
    }
  }
  if (series.length === 0) return null;
  const spec = chartSpec(type);
  let finalSeries = spec.pie ? [series[0]] : series;
  finalSeries = finalSeries.map((s) => ({ ...s }));
  const ptLen = Math.max(_nullishCoalesce(_optionalChain([cat, 'optionalAccess', _196 => _196.length]), () => ( 0)), ...finalSeries.map((s) => s.values.length));
  const catFinal = Array.from({ length: ptLen }, (_, i) => _nullishCoalesce(_optionalChain([cat, 'optionalAccess', _197 => _197[i]]), () => ( `\uD56D\uBAA9 ${i + 1}`)));
  if (!spec.scatter) {
    finalSeries = finalSeries.map((s) => ({ ...s, values: catFinal.map((_, i) => _nullishCoalesce(s.values[i], () => ( 0))) }));
  }
  if (spec.pie) {
    const slice = _nullishCoalesce(colors, () => ( pointColors));
    if (slice) finalSeries[0].pointColors = slice;
  } else {
    if (colors) finalSeries.forEach((s, i) => {
      s.color = colors[i % colors.length];
    });
    if (pointColors && finalSeries[0]) finalSeries[0].pointColors = pointColors;
  }
  return {
    spec,
    cat: catFinal,
    series: finalSeries,
    widthHu: Math.round(widthMm * HU_PER_MM),
    heightHu: Math.round(heightMm * HU_PER_MM)
  };
}
var colLetter = (i) => String.fromCharCode(66 + i);
function strCachePts(vals) {
  return `<c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`).join("");
}
function numCachePts(vals) {
  return `<c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>` + vals.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join("");
}
function chartColorFill(color) {
  if (color == null) return null;
  const c = color.trim();
  if (/^accent[1-6]$/i.test(c)) return `<a:solidFill><a:schemeClr val="${c.toLowerCase()}"/></a:solidFill>`;
  const hex = c.replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
  return null;
}
function serSpPr(color, stroke) {
  const f = chartColorFill(color);
  if (!f) return "<c:spPr/>";
  return stroke ? `<c:spPr><a:ln w="28575" cap="flat" cmpd="sng" algn="ctr">${f}<a:prstDash val="solid"/><a:round/></a:ln></c:spPr>` : `<c:spPr>${f}</c:spPr>`;
}
function dPtXml(pointColors, pie) {
  if (!_optionalChain([pointColors, 'optionalAccess', _198 => _198.length])) return "";
  return pointColors.map((col, i) => {
    const f = chartColorFill(col);
    if (!f) return "";
    const mid = pie ? '<c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:explosion val="0"/>' : '<c:bubble3D val="0"/>';
    return `<c:dPt><c:idx val="${i}"/>${mid}<c:spPr>${f}</c:spPr></c:dPt>`;
  }).join("");
}
function stdSer(idx, name, cat, values, explode, color, pointColors, stroke, pie) {
  const cl = colLetter(idx);
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx><c:strRef><c:f>Sheet1!$${cl}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>${serSpPr(color, stroke)}<c:invertIfNegative val="0"/>` + (explode ? `<c:explosion val="25"/>` : "") + dPtXml(pointColors, pie) + `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${cat.length + 1}</c:f><c:strCache>${strCachePts(cat)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$${cl}$2:$${cl}$${values.length + 1}</c:f><c:numCache>${numCachePts(values)}</c:numCache></c:numRef></c:val></c:ser>`;
}
function scatterSer(idx, name, xvals, yvals) {
  const cl = colLetter(idx);
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx><c:strRef><c:f>Sheet1!$${cl}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:ln w="28575"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="7"/></c:marker><c:xVal><c:numRef><c:f>Sheet1!$A$2:$A$${xvals.length + 1}</c:f><c:numCache>${numCachePts(xvals)}</c:numCache></c:numRef></c:xVal><c:yVal><c:numRef><c:f>Sheet1!$${cl}$2:$${cl}$${yvals.length + 1}</c:f><c:numCache>${numCachePts(yvals)}</c:numCache></c:numRef></c:yVal></c:ser>`;
}
function catAxXml(id, pos, cross) {
  return `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${pos}"/><c:crossAx val="${cross}"/><c:delete val="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
}
function valAxXml(id, pos, cross) {
  return `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${pos}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="${cross}"/><c:delete val="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
}
function buildChartSpaceXml(fence) {
  const { spec, cat, series } = fence;
  const NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"';
  const ax1 = "111111111";
  const ax2 = "222222222";
  let plot;
  if (spec.scatter) {
    const n = Math.max(0, ...series.map((s) => s.values.length));
    const xs = Array.from({ length: n }, (_, i) => {
      const c = cat[i];
      const v = Number(c);
      return c !== void 0 && c !== "" && Number.isFinite(v) ? v : i + 1;
    });
    const sers = series.map((s, i) => scatterSer(i, s.name, xs, s.values)).join("");
    plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}<c:axId val="${ax1}"/><c:axId val="${ax2}"/></c:scatterChart>` + valAxXml(ax1, "b", ax2) + valAxXml(ax2, "l", ax1);
  } else if (spec.pie) {
    const s0 = series[0];
    plot = `<c:${spec.el}><c:varyColors val="1"/>${stdSer(0, s0.name, cat, s0.values, !!spec.explode, s0.color, s0.pointColors, false, true)}<c:firstSliceAng val="0"/>` + (spec.hole != null ? `<c:holeSize val="${spec.hole}"/>` : "") + `</c:${spec.el}>`;
  } else {
    const stroke = spec.el === "lineChart" || spec.el === "radarChart" || !!spec.radar;
    const sers = series.map((s, i) => stdSer(i, s.name, cat, s.values, false, s.color, s.pointColors, stroke, false)).join("");
    const horiz = spec.dir === "bar";
    let inner = "";
    if (spec.dir) inner += `<c:barDir val="${spec.dir}"/>`;
    if (spec.grp) inner += `<c:grouping val="${spec.grp}"/>`;
    if (spec.radar) inner += `<c:radarStyle val="standard"/>`;
    inner += `<c:varyColors val="0"/>${sers}`;
    if (spec.marker) inner += `<c:marker val="1"/>`;
    if (spec.el.startsWith("bar")) inner += `<c:gapWidth val="150"/><c:overlap val="${_nullishCoalesce(spec.overlap, () => ( 0))}"/>`;
    inner += `<c:axId val="${ax1}"/><c:axId val="${ax2}"/>`;
    plot = `<c:${spec.el}>${inner}</c:${spec.el}>` + catAxXml(ax1, horiz ? "l" : "b", ax2) + valAxXml(ax2, horiz ? "b" : "l", ax1);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><c:chartSpace ${NS}><c:date1904 val="0"/><c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}
function buildChartElementXml(partName, widthHu, heightHu, id) {
  return `<hp:chart id="${id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" chartIDRef="${partName}"><hp:sz width="${widthHu}" widthRelTo="ABSOLUTE" height="${heightHu}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="709" right="709" top="709" bottom="709"/></hp:chart>`;
}

// src/hwpx/gen-gongmun-fit.ts
function plainRenderText(text) {
  return parseInlineMarkdown(text).map((s) => s.text).join("");
}
function computeGongmunFitPlan(blocks, gongmun, gongmunList) {
  const minRatio = gongmun.autoFitMinRatio;
  if (minRatio === null || minRatio >= GONGMUN_BODY_RATIO) return null;
  const pageW = 59528 - mmToHwpunit(gongmun.margins.left) - mmToHwpunit(gongmun.margins.right);
  const ratioByBlock = /* @__PURE__ */ new Map();
  const variants = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    let text;
    let firstW;
    let contW;
    if (block.type === "list_item" && gongmunList.has(i)) {
      const { marker, depth } = gongmunList.get(i);
      const content = plainRenderText(block.text || "");
      text = marker ? `${marker} ${content}` : content;
      const { left, indent } = levelIndent(depth, gongmun.bodyHeight, gongmun.numbering);
      firstW = pageW - left - Math.max(indent, 0);
      contW = pageW - left - Math.max(-indent, 0);
    } else if (block.type === "paragraph") {
      const raw = (block.text || "").trim();
      if (/^<center>[\s\S]*<\/center>$/i.test(raw)) continue;
      text = plainRenderText(raw);
      firstW = contW = pageW;
    } else {
      continue;
    }
    if (!text) continue;
    const r = fitRatioForFewerLines(text, firstW, contW, gongmun.bodyHeight, GONGMUN_BODY_RATIO, minRatio);
    if (r === null) continue;
    ratioByBlock.set(i, r);
    if (!variants.includes(r)) variants.push(r);
  }
  return ratioByBlock.size > 0 ? { ratioByBlock, variants } : null;
}
function variantMapper(fit, blockIdx) {
  const r = fit.ratioByBlock.get(blockIdx);
  if (r === void 0) return void 0;
  const vi = fit.variants.indexOf(r);
  return (id) => id >= 0 && id <= 3 ? CHAR_VARIANT_BASE + vi * 4 + id : id;
}
function precomputeGongmunList(blocks, gongmun) {
  const result = /* @__PURE__ */ new Map();
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type !== "list_item") {
      i++;
      continue;
    }
    const passThrough = (b) => b.type === "table" || b.type === "html_table" || b.type === "equation" || b.type === "code_block" && (b.lang || "").toLowerCase() === "chart" && parseChartFence(b.text || "") !== null;
    const run = [];
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.type === "list_item") {
        run.push(i);
        i++;
        continue;
      }
      if (passThrough(b)) {
        let j = i + 1;
        while (j < blocks.length && passThrough(blocks[j])) j++;
        if (j < blocks.length && blocks[j].type === "list_item") {
          i = j;
          continue;
        }
      }
      break;
    }
    const depths = run.map((bi) => Math.min(Math.max(blocks[bi].indent || 0, 0), GONGMUN_LIST_LEVELS - 1));
    const suppress = gongmun.numbering === "standard" ? computeSuppression(depths) : depths.map(() => false);
    const numberer = new GongmunNumberer(gongmun.numbering);
    run.forEach((bi, k) => {
      const marker = numberer.next(depths[k], suppress[k]);
      result.set(bi, { marker, depth: depths[k] });
    });
  }
  return result;
}

// src/diff/text-diff.ts
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}
function normalizedSimilarity(a, b) {
  return similarity(normalize(a), normalize(b));
}
function normalize(s) {
  return s.replace(/\s+/g, " ").trim();
}
var MAX_LEVENSHTEIN_LEN = 1e4;
function levenshtein(a, b) {
  if (a.length + b.length > MAX_LEVENSHTEIN_LEN) {
    const sampleLen = Math.min(500, a.length, b.length);
    let diffs = 0;
    for (let i = 0; i < sampleLen; i++) if (a[i] !== b[i]) diffs++;
    const sampleRate = sampleLen > 0 ? diffs / sampleLen : 1;
    return Math.abs(a.length - b.length) + Math.round(Math.min(a.length, b.length) * sampleRate);
  }
  if (a.length > b.length) [a, b] = [b, a];
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let curr = new Array(m + 1);
  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      if (a[i - 1] === b[j - 1]) {
        curr[i] = prev[i - 1];
      } else {
        curr[i] = 1 + Math.min(prev[i - 1], prev[i], curr[i - 1]);
      }
    }
    ;
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

// src/roundtrip/markdown-units.ts
function splitMarkdownUnits(md2) {
  const lines = md2.split("\n");
  const units = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith("<table>")) {
      const collected2 = [];
      let depth = 0;
      while (i < lines.length) {
        const l = lines[i];
        collected2.push(l);
        depth += (l.match(/<table>/g) || []).length;
        depth -= (l.match(/<\/table>/g) || []).length;
        i++;
        if (depth <= 0) break;
      }
      units.push({ kind: "html-table", raw: collected2.join("\n"), lines: collected2 });
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      const collected2 = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        collected2.push(lines[i]);
        i++;
      }
      units.push({ kind: "gfm-table", raw: collected2.join("\n"), lines: collected2 });
      continue;
    }
    if (/^-{3,}\s*$/.test(line.trim())) {
      units.push({ kind: "separator", raw: line.trim(), lines: [line.trim()] });
      i++;
      continue;
    }
    if (/^!\[image\]\([^)]*\)\s*$/.test(line.trim())) {
      units.push({ kind: "image", raw: line.trim(), lines: [line.trim()] });
      i++;
      continue;
    }
    const collected = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trimStart().startsWith("|") && !lines[i].trim().startsWith("<table>")) {
      collected.push(lines[i].trim());
      i++;
    }
    units.push({ kind: "text", raw: collected.join("\n"), lines: collected });
  }
  return units;
}
function alignUnits(a, b) {
  const m = a.length, n = b.length;
  if (m * n > 4e6) {
    const result2 = [];
    let pre = 0;
    while (pre < m && pre < n && a[pre] === b[pre]) {
      result2.push([pre, pre]);
      pre++;
    }
    let suf = 0;
    while (suf < m - pre && suf < n - pre && a[m - 1 - suf] === b[n - 1 - suf]) suf++;
    const aMid = m - pre - suf, bMid = n - pre - suf;
    if (aMid === bMid) {
      for (let i2 = 0; i2 < aMid; i2++) result2.push([pre + i2, pre + i2]);
    } else {
      for (let i2 = 0; i2 < aMid; i2++) result2.push([pre + i2, null]);
      for (let j2 = 0; j2 < bMid; j2++) result2.push([null, pre + j2]);
    }
    for (let s = suf - 1; s >= 0; s--) result2.push([m - 1 - s, n - 1 - s]);
    return result2;
  }
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i2 = 1; i2 <= m; i2++) {
    for (let j2 = 1; j2 <= n; j2++) {
      dp[i2][j2] = a[i2 - 1] === b[j2 - 1] ? dp[i2 - 1][j2 - 1] + 1 : Math.max(dp[i2 - 1][j2], dp[i2][j2 - 1]);
    }
  }
  const matches = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && dp[i][j] === dp[i - 1][j - 1] + 1) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  matches.reverse();
  const result = [];
  let ai = 0, bi = 0;
  const flushGap = (aEnd, bEnd) => {
    if (aEnd - ai === bEnd - bi) {
      while (ai < aEnd) result.push([ai++, bi++]);
      return;
    }
    while (ai < aEnd && bi < bEnd) {
      const sim = normalizedSimilarity(a[ai], b[bi]);
      if (sim >= 0.4) {
        if (aEnd - ai > bEnd - bi && bestSimInRange(a, ai + 1, ai + (aEnd - ai) - (bEnd - bi), b[bi]) > sim) {
          result.push([ai++, null]);
        } else if (bEnd - bi > aEnd - ai && bestSimInRange(b, bi + 1, bi + (bEnd - bi) - (aEnd - ai), a[ai]) > sim) {
          result.push([null, bi++]);
        } else {
          result.push([ai++, bi++]);
        }
      } else if (aEnd - ai >= bEnd - bi) result.push([ai++, null]);
      else result.push([null, bi++]);
    }
    while (ai < aEnd) result.push([ai++, null]);
    while (bi < bEnd) result.push([null, bi++]);
  };
  for (const [pi, pj] of matches) {
    flushGap(pi, pj);
    result.push([ai++, bi++]);
  }
  flushGap(m, n);
  return result;
}
function bestSimInRange(arr, from, to, target) {
  let best = 0;
  for (let k = from; k <= to && k < arr.length; k++) {
    const s = normalizedSimilarity(arr[k], target);
    if (s > best) best = s;
  }
  return best;
}
function escapeGfm(text) {
  return text.replace(/([~*])/g, "\\$1");
}
var HWP_SHAPE_ALT_TEXT_RE = /(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|이등변 삼각형|직각 삼각형|선|직선|곡선|화살표|굵은 화살표|이중 화살표|오각형|육각형|팔각형|별|[4-8]점별|십자|십자형|구름|구름형|마름모|도넛|평행사변형|사다리꼴|부채꼴|호|반원|물결|번개|하트|빗금|블록 화살표|수식|표|그림|개체|그리기\s?개체|묶음\s?개체|글상자|수식\s?개체|OLE\s?개체)\s?입니다\.?/g;
function sanitizeText(text) {
  let result = _chunkR2H34FY5cjs.mapPuaText.call(void 0, text).replace(/[\u{F0000}-\u{FFFFD}]/gu, "").replace(HWP_SHAPE_ALT_TEXT_RE, "").replace(/  +/g, " ").trim();
  if (result.length <= 30 && result.includes(" ")) {
    const tokens = result.split(" ");
    const koreanSingleCharCount = tokens.filter((t) => t.length === 1 && /[가-힯ㄱ-ㆎ]/.test(t)).length;
    if (tokens.length >= 3 && koreanSingleCharCount / tokens.length >= 0.7) {
      result = tokens.join("");
    }
  }
  return result;
}
function normForMatch(text) {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}
function unescapeGfm(text) {
  return text.replace(/\\([~*])/g, "$1");
}
function summarize(text) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 77) + "..." : t;
}
function replicateGfmTable(table) {
  const { cells, rows: numRows, cols: numCols } = table;
  if (numRows === 0 || numCols === 0) return null;
  if (numRows === 1 && numCols === 1) return null;
  if (numCols === 1) return null;
  const display = Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_2, c) => ({ text: "", gridR: r, gridC: c })));
  const skip = /* @__PURE__ */ new Set();
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue;
      const cell = _optionalChain([cells, 'access', _199 => _199[r], 'optionalAccess', _200 => _200[c]]);
      if (!cell) continue;
      display[r][c] = {
        text: escapeGfm(sanitizeText(cell.text)).replace(/\|/g, "\\|").replace(/\n/g, "<br>"),
        gridR: r,
        gridC: c
      };
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (r + dr < numRows && c + dc < numCols) skip.add(`${r + dr},${c + dc}`);
        }
      }
      c += cell.colSpan - 1;
    }
  }
  const uniqueRows = [];
  let pendingLabelRow = null;
  for (let r = 0; r < display.length; r++) {
    const row = display[r];
    if (row.every((cell) => cell.text === "")) continue;
    const nonEmptyCols = row.filter((cell) => cell.text !== "");
    const hasSkipInRow = row.some((_, c) => skip.has(`${r},${c}`));
    if (!hasSkipInRow && nonEmptyCols.length === 1 && row[0].text !== "" && row.slice(1).every((c) => c.text === "")) {
      if (pendingLabelRow) uniqueRows.push(pendingLabelRow);
      pendingLabelRow = row;
      continue;
    }
    if (pendingLabelRow) {
      if (row[0].text === "") row[0] = pendingLabelRow[0];
      else uniqueRows.push(pendingLabelRow);
      pendingLabelRow = null;
    }
    uniqueRows.push(row);
  }
  if (pendingLabelRow) uniqueRows.push(pendingLabelRow);
  return uniqueRows.length > 0 ? uniqueRows : null;
}
function parseGfmTable(lines) {
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (cells.length === 0) continue;
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}
function unescapeGfmCell(text) {
  return text.replace(/<br\s*\/?>/gi, "\n").replace(/\\\|/g, "|").replace(/\\([~*])/g, "$1");
}
function replicateCellInnerHtml(cell) {
  if (_optionalChain([cell, 'access', _201 => _201.blocks, 'optionalAccess', _202 => _202.length])) {
    return cell.blocks.map((b) => {
      if (b.type === "table" && b.table) {
        const cap = b.table.caption ? sanitizeText(b.table.caption) : "";
        return (cap ? cap + "<br>" : "") + replicateTableToHtml(b.table);
      }
      if (b.type === "image" && b.text) return `<img src="${b.text}" alt="image">`;
      const t = sanitizeText(_nullishCoalesce(b.text, () => ( "")));
      return t ? t.replace(/\n/g, "<br>") : "";
    }).filter(Boolean).join("<br>");
  }
  return sanitizeText(cell.text).replace(/\n/g, "<br>");
}
function replicateTableToHtml(table) {
  const rows = replicateHtmlTable(table);
  const lines = ["<table>"];
  for (let r = 0; r < rows.length; r++) {
    const tag = rows[r].tag;
    const rowHtml = rows[r].cells.map((cell) => {
      const attrs = [];
      if (cell.colSpan > 1) attrs.push(`colspan="${cell.colSpan}"`);
      if (cell.rowSpan > 1) attrs.push(`rowspan="${cell.rowSpan}"`);
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";
      return `<${tag}${attrStr}>${cell.inner}</${tag}>`;
    });
    if (rowHtml.length) lines.push(`<tr>${rowHtml.join("")}</tr>`);
  }
  lines.push("</table>");
  return lines.join("\n");
}
function replicateHtmlTable(table) {
  const { cells, rows: numRows, cols: numCols } = table;
  const skip = /* @__PURE__ */ new Set();
  const result = [];
  for (let r = 0; r < numRows; r++) {
    const tag = r === 0 ? "th" : "td";
    const rowCells = [];
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue;
      const cell = _optionalChain([cells, 'access', _203 => _203[r], 'optionalAccess', _204 => _204[c]]);
      if (!cell) continue;
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (r + dr < numRows && c + dc < numCols) skip.add(`${r + dr},${c + dc}`);
        }
      }
      rowCells.push({
        inner: replicateCellInnerHtml(cell),
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
        gridR: r,
        gridC: c
      });
    }
    if (rowCells.length) result.push({ tag, cells: rowCells });
  }
  return result;
}
function parseHtmlTable(raw) {
  const re = /<(\/?)(table|tr|td|th)((?:"[^"]*"|'[^']*'|[^>"'])*?)>/gi;
  let depth = 0;
  let currentRow = null;
  let cellStart = -1;
  let cellInfo = null;
  const rows = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    const isClose = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";
    if (tag === "table") {
      depth += isClose ? -1 : 1;
      if (depth < 0) return null;
      continue;
    }
    if (depth !== 1) continue;
    if (tag === "tr") {
      if (!isClose) currentRow = [];
      else if (currentRow) {
        rows.push({ tag: rows.length === 0 ? "th" : "td", cells: currentRow });
        currentRow = null;
      }
    } else {
      if (!isClose) {
        const cs = parseInt(_optionalChain([attrs, 'access', _205 => _205.match, 'call', _206 => _206(/colspan\s*=\s*"(\d+)"/i), 'optionalAccess', _207 => _207[1]]) || "1", 10);
        const rs = parseInt(_optionalChain([attrs, 'access', _208 => _208.match, 'call', _209 => _209(/rowspan\s*=\s*"(\d+)"/i), 'optionalAccess', _210 => _210[1]]) || "1", 10);
        cellStart = m.index + m[0].length;
        cellInfo = { colSpan: isNaN(cs) ? 1 : cs, rowSpan: isNaN(rs) ? 1 : rs };
      } else if (cellStart >= 0 && cellInfo && currentRow) {
        currentRow.push({ inner: raw.slice(cellStart, m.index), colSpan: cellInfo.colSpan, rowSpan: cellInfo.rowSpan });
        cellStart = -1;
        cellInfo = null;
      }
    }
  }
  if (depth !== 0) return null;
  return rows;
}
var AUTONUM_PREFIX_RE = /^(?:[0-9０-９a-zA-Z가-힣]{1,6}[.)\]:]|[([][0-9０-９a-zA-Z가-힣]{1,6}[)\]][.:]?|[ⅰ-ⅹⅠ-Ⅹ①-⑮][.)\]:]?)$/u;
function htmlCellInnerToLines(inner) {
  let hadNonText = false;
  let work = inner;
  if (/<table[\s>]/i.test(work)) {
    hadNonText = true;
    work = removeNestedTables(work);
  }
  if (/<img\s/i.test(work)) {
    hadNonText = true;
    work = work.replace(/<img\s(?:"[^"]*"|'[^']*'|[^>"'])*?>/gi, "");
  }
  const lines = work.split(/<br\s*\/?>/gi).map((s) => s.trim()).filter((s) => s.length > 0);
  return { lines, hadNonText };
}
function extractTopLevelTables(html) {
  const result = [];
  let depth = 0;
  let start = -1;
  const re = /<(\/?)table(?:[\s>]|>)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== "/") {
      if (depth === 0) start = m.index;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start >= 0) {
        result.push(html.slice(start, m.index + m[0].length));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return result;
}
function removeNestedTables(html) {
  let result = "";
  let depth = 0;
  const re = /<(\/?)table(?:[\s>]|>)/gi;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== "/") {
      if (depth === 0) result += html.slice(last, m.index);
      depth++;
    } else {
      depth--;
      if (depth === 0) last = m.index + m[0].length;
      if (depth < 0) depth = 0;
    }
  }
  if (depth === 0) result += html.slice(last);
  return result;
}

// src/hwpx/gen-profile.ts
function normalizeAnchor(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 24);
}
function takeProfile(remap, rows, cols, anchor, seq) {
  if (!remap) return null;
  for (const t of remap.tables) {
    if (t.used) continue;
    if (t.rows !== rows || t.cols !== cols) continue;
    if (t.anchor && anchor) {
      if (t.anchor !== anchor) continue;
    } else if (t.index !== seq) {
      continue;
    }
    t.used = true;
    return t;
  }
  return null;
}
function parseHu(s) {
  if (s == null) return void 0;
  const n = parseInt(String(s).trim(), 10);
  return Number.isFinite(n) ? n : void 0;
}
function edgeXml(tag, d) {
  return d ? `<hh:${tag} type="${d.type}" width="${d.width}" color="${d.color}"/>` : `<hh:${tag} type="NONE" width="0.1 mm" color="#000000"/>`;
}
function borderFillDefToXml(id, def) {
  const fill = _optionalChain([def, 'access', _211 => _211.fill, 'optionalAccess', _212 => _212.faceColor]) ? `<hh:fillBrush><hh:winBrush faceColor="${def.fill.faceColor}" hatchColor="#000000" alpha="0"/></hh:fillBrush>` : "";
  return `      <hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        ${edgeXml("leftBorder", def.leftBorder)}
        ${edgeXml("rightBorder", def.rightBorder)}
        ${edgeXml("topBorder", def.topBorder)}
        ${edgeXml("bottomBorder", def.bottomBorder)}${fill ? `
        ${fill}` : ""}
      </hh:borderFill>`;
}
var PROFILE_FONT_MAX = 2;
function profileCharPrXml(id, def) {
  const height = _nullishCoalesce(parseHu(def.height_hwpunit), () => ( 1e3));
  const color = _nullishCoalesce(def.textColor, () => ( "#000000"));
  const rawFont = def.fontRef_hangul != null ? parseInt(def.fontRef_hangul, 10) || 0 : 0;
  const font = rawFont >= 0 && rawFont <= PROFILE_FONT_MAX ? rawFont : 0;
  const boldAttr = def.bold ? ` bold="1"` : "";
  const italicAttr = def.italic ? ` italic="1"` : "";
  const underline = def.underline ? `
        <hh:underline type="BOTTOM" shape="SOLID" color="${color}"/>` : "";
  return `      <hh:charPr id="${id}" height="${height}" textColor="${color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"${boldAttr}${italicAttr}>
        <hh:fontRef hangul="${font}" latin="${font}" hanja="${font}" japanese="${font}" other="${font}" symbol="${font}" user="${font}"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>${underline}
      </hh:charPr>`;
}
function buildProfileRemap(profile, charPrBase, borderFillBase = 3) {
  const remap = { borderFillXmls: [], charPrXmls: [], tables: [] };
  let bfNext = borderFillBase;
  let charNext = charPrBase;
  for (const t of profile.tables) {
    const localBf = {};
    for (const [key, def] of Object.entries(_nullishCoalesce(t.used_border_fills, () => ( {})))) {
      const gid = bfNext++;
      remap.borderFillXmls.push(borderFillDefToXml(gid, def));
      localBf[key] = gid;
    }
    const localChar = {};
    for (const [key, def] of Object.entries(_nullishCoalesce(t.used_char_prs, () => ( {})))) {
      const gid = charNext++;
      remap.charPrXmls.push(profileCharPrXml(gid, def));
      localChar[key] = gid;
    }
    let colWidths;
    if (t.col_widths_hwpunit && t.col_widths_hwpunit.length === t.cols) {
      const parsed = t.col_widths_hwpunit.map(parseHu);
      if (parsed.every((n) => n != null)) colWidths = parsed;
    }
    const tr = {
      index: t.table_index,
      rows: t.rows,
      cols: t.cols,
      // 재정규화 — 추출기는 정규화해 담지만 손편집된 프로필 JSON도 같은 키 공간으로
      anchor: t.anchor_text ? normalizeAnchor(t.anchor_text) : void 0,
      width: parseHu(t.width_hwpunit),
      colWidths,
      cellBf: /* @__PURE__ */ new Map(),
      cellChar: /* @__PURE__ */ new Map(),
      cellH: /* @__PURE__ */ new Map()
    };
    for (const cell of t.cells) {
      const k = `${cell.row},${cell.col}`;
      if (cell.borderFillIDRef != null && cell.borderFillIDRef in localBf) {
        tr.cellBf.set(k, localBf[cell.borderFillIDRef]);
      }
      if (cell.charPrIDRef != null && cell.charPrIDRef in localChar) {
        tr.cellChar.set(k, localChar[cell.charPrIDRef]);
      }
      const h = parseHu(cell.height_hwpunit);
      if (h != null) tr.cellH.set(k, h);
    }
    remap.tables.push(tr);
  }
  return remap;
}
function profileCharPrBase(ratioVariantCount) {
  return CHAR_VARIANT_BASE + ratioVariantCount * 4;
}

// src/hwpx/gen-table.ts
var TABLE_ID_BASE = 1e3;
var tableIdCounter = TABLE_ID_BASE;
function nextTableId() {
  return ++tableIdCounter;
}
function anchorOfMarkdownCell(cell) {
  return normalizeAnchor(cell.replace(/!\[[^\]]*\]\([^)]*\)/g, ""));
}
function anchorOfHtmlCell(inner) {
  const noNested = inner.replace(/<table[\s\S]*?<\/table>/gi, "");
  const { lines } = htmlCellInnerToLines(noNested);
  return normalizeAnchor(lines.join(""));
}
function resolveColWidths(tp, colCnt, fallbackTotal) {
  if (_optionalChain([tp, 'optionalAccess', _213 => _213.colWidths]) && tp.colWidths.length === colCnt) return tp.colWidths;
  const w = _optionalChain([tp, 'optionalAccess', _214 => _214.width]) ? Math.floor(tp.width / colCnt) : Math.floor(fallbackTotal / colCnt);
  return Array(colCnt).fill(w);
}
function generateTable(rows, theme, remap = null, seq = 0) {
  const rowCnt = rows.length;
  const colCnt = Math.max(...rows.map((r) => r.length), 1);
  const cellH = 1500;
  const tblId = nextTableId();
  const prof = takeProfile(remap, rowCnt, colCnt, anchorOfMarkdownCell(_nullishCoalesce(_optionalChain([rows, 'access', _215 => _215[0], 'optionalAccess', _216 => _216[0]]), () => ( ""))), seq);
  const colW = resolveColWidths(prof, colCnt, 44e3);
  const tblW = colW.reduce((a, b) => a + b, 0);
  const tblH = cellH * rowCnt;
  const useHeaderStyle = theme.tableHeader !== theme.body || theme.tableHeaderBold;
  const trElements = rows.map((row, rowIdx) => {
    const cells = row.length < colCnt ? [...row, ...Array(colCnt - row.length).fill("")] : row;
    const isHeaderRow = rowIdx === 0;
    const headerCharPr = isHeaderRow && useHeaderStyle ? CHAR_TABLE_HEADER : CHAR_NORMAL;
    const tdElements = cells.map((cell, colIdx) => {
      const k = `${rowIdx},${colIdx}`;
      const bf = _nullishCoalesce(_optionalChain([prof, 'optionalAccess', _217 => _217.cellBf, 'access', _218 => _218.get, 'call', _219 => _219(k)]), () => ( 2));
      const ch = _nullishCoalesce(_optionalChain([prof, 'optionalAccess', _220 => _220.cellChar, 'access', _221 => _221.get, 'call', _222 => _222(k)]), () => ( headerCharPr));
      const h = _nullishCoalesce(_optionalChain([prof, 'optionalAccess', _223 => _223.cellH, 'access', _224 => _224.get, 'call', _225 => _225(k)]), () => ( cellH));
      const runs = generateRuns(cell, ch);
      const p = `<hp:p paraPrIDRef="0" styleIDRef="0">${runs}</hp:p>`;
      return `<hp:tc name="" header="${isHeaderRow ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${bf}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${p}</hp:subList><hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${colW[colIdx]}" height="${h}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`;
    }).join("");
    return `<hp:tr>${tdElements}</hp:tr>`;
  }).join("");
  const tblInner = `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${tblH}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>` + trElements;
  const tbl = `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="2" noShading="0">${tblInner}</hp:tbl>`;
  return `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`;
}
function layoutHtmlRows(rows) {
  const occupied = /* @__PURE__ */ new Set();
  const placed = [];
  let colCnt = 0;
  for (let r = 0; r < rows.length; r++) {
    let c = 0;
    for (const cell of rows[r].cells) {
      while (occupied.has(`${r},${c}`)) c++;
      const colSpan = Math.max(1, cell.colSpan);
      const rowSpan = Math.max(1, cell.rowSpan);
      placed.push({ r, c, colSpan, rowSpan, inner: cell.inner, isHeader: rows[r].tag === "th" });
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) occupied.add(`${r + dr},${c + dc}`);
      }
      c += colSpan;
      colCnt = Math.max(colCnt, c);
    }
  }
  return { placed, rowCnt: rows.length, colCnt };
}
function unescapeHtml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function generateHtmlTableXml(rawHtml, theme, totalWidth = 44e3, remap = null, seq = 0) {
  const rows = parseHtmlTable(rawHtml);
  if (!rows || rows.length === 0) return null;
  const { placed, rowCnt, colCnt } = layoutHtmlRows(rows);
  if (rowCnt === 0 || colCnt === 0) return null;
  const cellH = 1500;
  const tblId = nextTableId();
  const first = _nullishCoalesce(placed.find((p) => p.r === 0 && p.c === 0), () => ( placed[0]));
  const prof = takeProfile(remap, rowCnt, colCnt, first ? anchorOfHtmlCell(first.inner) : "", seq);
  const colW = resolveColWidths(prof, colCnt, totalWidth);
  const tblW = colW.reduce((a, b) => a + b, 0);
  const useHeaderStyle = theme.tableHeader !== theme.body || theme.tableHeaderBold;
  const spanW = (c, colSpan) => colW.slice(c, c + colSpan).reduce((a, b) => a + b, 0);
  const tcXmls = placed.map((cell) => {
    const k = `${cell.r},${cell.c}`;
    const bf = _nullishCoalesce(_optionalChain([prof, 'optionalAccess', _226 => _226.cellBf, 'access', _227 => _227.get, 'call', _228 => _228(k)]), () => ( 2));
    const headerCharPr = cell.isHeader && useHeaderStyle ? CHAR_TABLE_HEADER : CHAR_NORMAL;
    const ch = _nullishCoalesce(_optionalChain([prof, 'optionalAccess', _229 => _229.cellChar, 'access', _230 => _230.get, 'call', _231 => _231(k)]), () => ( headerCharPr));
    const { lines } = htmlCellInnerToLines(cell.inner);
    const paras = lines.map(
      (line) => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${ch}"><hp:t>${escapeXml(unescapeHtml(line))}</hp:t></hp:run></hp:p>`
    );
    const cellW = spanW(cell.c, cell.colSpan);
    let nestedH = 0;
    for (const nested of extractTopLevelTables(cell.inner)) {
      const nestedXml = generateHtmlTableXml(nested, theme, Math.max(cellW - 1020, 4e3));
      if (nestedXml) {
        paras.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${nestedXml}</hp:run></hp:p>`);
        nestedH += (_nullishCoalesce(nested.match(/<tr[\s>]/gi), () => ( []))).length * cellH + 300;
      }
    }
    if (paras.length === 0) {
      paras.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${ch}"><hp:t></hp:t></hp:run></hp:p>`);
    }
    const contentH = Math.max(cellH * cell.rowSpan, Math.max(lines.length, 1) * 800 + nestedH);
    const cellHeight = Math.max(_nullishCoalesce(_optionalChain([prof, 'optionalAccess', _232 => _232.cellH, 'access', _233 => _233.get, 'call', _234 => _234(k)]), () => ( 0)), contentH);
    return `<hp:tc name="" header="${cell.isHeader ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${bf}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras.join("")}</hp:subList><hp:cellAddr colAddr="${cell.c}" rowAddr="${cell.r}"/><hp:cellSpan colSpan="${cell.colSpan}" rowSpan="${cell.rowSpan}"/><hp:cellSz width="${cellW}" height="${cellHeight}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`;
  });
  const trXmls = [];
  for (let r = 0; r < rowCnt; r++) {
    const rowTcs = tcXmls.filter((_, i) => placed[i].r === r);
    trXmls.push(`<hp:tr>${rowTcs.join("")}</hp:tr>`);
  }
  return `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="2" noShading="0"><hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${cellH * rowCnt}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>` + trXmls.join("") + `</hp:tbl>`;
}

// src/hwpx/equation-generate.ts
var MAX_EQUATION_SOURCE = 1e4;
var MAX_GROUP_DEPTH = 64;
var COMMAND_MAP = {
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  xi: "xi",
  pi: "pi",
  rho: "rho",
  sigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
  Gamma: "GAMMA",
  Delta: "DELTA",
  Theta: "THETA",
  Lambda: "LAMBDA",
  Xi: "XI",
  Pi: "PI",
  Sigma: "SIGMA",
  Upsilon: "UPSILON",
  Phi: "PHI",
  Psi: "PSI",
  Omega: "OMEGA",
  le: "LEQ",
  leq: "LEQ",
  ge: "GEQ",
  geq: "GEQ",
  ne: "!=",
  neq: "!=",
  pm: "+-",
  mp: "-+",
  times: "TIMES",
  cdot: "cdot",
  ast: "AST",
  circ: "CIRC",
  bullet: "BULLET",
  in: "IN",
  notin: "NOTIN",
  subset: "SUBSET",
  subseteq: "SUBSETEQ",
  supset: "SUPERSET",
  supseteq: "SUPSETEQ",
  cup: "CUP",
  cap: "SMALLINTER",
  emptyset: "EMPTYSET",
  forall: "FORALL",
  exists: "EXIST",
  infinity: "INF",
  infty: "INF",
  partial: "Partial",
  nabla: "NABLA",
  int: "int",
  iint: "dint",
  iiint: "tint",
  oint: "oint",
  sum: "sum",
  prod: "prod",
  lim: "lim",
  to: "->",
  rightarrow: "->",
  leftarrow: "larrow",
  leftrightarrow: "<->",
  Rightarrow: "RARROW",
  Leftarrow: "LARROW",
  Leftrightarrow: "LRARROW",
  cdots: "CDOTS",
  ldots: "LDOTS",
  vdots: "VDOTS",
  ddots: "DDOTS"
};
var ACCENT_COMMANDS = {
  bar: "bar",
  overline: "bar",
  vec: "vec",
  overrightarrow: "vec",
  hat: "hat",
  widehat: "hat",
  tilde: "tilde",
  widetilde: "tilde",
  dot: "dot",
  ddot: "ddot",
  underline: "under"
};
var RESERVED_WORDS = new Set(
  [...Object.keys(CONVERT_MAP), ...Object.keys(MIDDLE_CONVERT_MAP), "over", "root", "of"].filter((w) => /^[A-Za-z]+$/.test(w))
);
function skipSpaces(input, idx) {
  while (idx < input.length && /\s/.test(input[idx])) idx++;
  return idx;
}
function normalizeEqEdit(input) {
  return input.replace(/\s+/g, " ").trim();
}
function stripMathDelimiters(input) {
  let s = input.trim();
  if (s.startsWith("$$") && s.endsWith("$$")) s = s.slice(2, -2).trim();
  if (s.startsWith("\\[") && s.endsWith("\\]")) s = s.slice(2, -2).trim();
  return s;
}
function readBalanced(input, idx, open, close) {
  let depth = 1;
  let cursor = idx + 1;
  while (cursor < input.length) {
    const ch = input[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth === 0) {
      return { value: input.slice(idx + 1, cursor), next: cursor + 1 };
    }
    cursor++;
  }
  return { value: input.slice(idx + 1), next: input.length };
}
function readGroupOrToken(input, idx, depth) {
  const start = skipSpaces(input, idx);
  if (depth > MAX_GROUP_DEPTH) return { value: input.slice(start), next: input.length };
  if (input[start] === "{") {
    const group = readBalanced(input, start, "{", "}");
    return { value: convertLatexFragment(group.value, depth + 1), next: group.next };
  }
  if (input[start] === "\\") {
    const cmd = readCommand(input, start, depth + 1);
    return { value: cmd.value, next: cmd.next };
  }
  return { value: _nullishCoalesce(input[start], () => ( "")), next: Math.min(start + 1, input.length) };
}
function readCommandName(input, idx) {
  if (input[idx + 1] === "\\") return { value: "\\", next: idx + 2 };
  const match = /^[A-Za-z]+/.exec(input.slice(idx + 1));
  if (match) return { value: match[0], next: idx + 1 + match[0].length };
  return { value: _nullishCoalesce(input[idx + 1], () => ( "")), next: Math.min(idx + 2, input.length) };
}
function readCommand(input, idx, depth) {
  const name = readCommandName(input, idx);
  const command = name.value;
  if (command === "\\") return { value: "#", next: name.next };
  if (command === "frac") {
    const num4 = readGroupOrToken(input, name.next, depth);
    const den = readGroupOrToken(input, num4.next, depth);
    return { value: `{${num4.value}} over {${den.value}}`, next: den.next };
  }
  if (command === "sqrt") {
    let cursor = skipSpaces(input, name.next);
    let root = null;
    if (input[cursor] === "[") {
      const opt = readBalanced(input, cursor, "[", "]");
      root = { value: convertLatexFragment(opt.value, depth + 1), next: opt.next };
      cursor = opt.next;
    }
    const body = readGroupOrToken(input, cursor, depth);
    if (root) return { value: `root {${root.value}} of {${body.value}}`, next: body.next };
    return { value: `sqrt{${body.value}}`, next: body.next };
  }
  if (command === "begin") {
    const env = readGroupOrToken(input, name.next, depth);
    const endTag = `\\end{${env.value}}`;
    const endIdx = input.indexOf(endTag, env.next);
    if (endIdx === -1) return { value: env.value, next: env.next };
    const body = convertLatexFragment(input.slice(env.next, endIdx), depth + 1);
    if (env.value === "matrix" || env.value === "pmatrix" || env.value === "bmatrix") {
      return { value: `{${env.value}{${body}}}`, next: endIdx + endTag.length };
    }
    return { value: body, next: endIdx + endTag.length };
  }
  if (command === "left" || command === "right") {
    const kw = command === "left" ? "LEFT" : "RIGHT";
    const cursor = skipSpaces(input, name.next);
    let delimiter = _nullishCoalesce(input[cursor], () => ( ""));
    let next = delimiter ? cursor + 1 : cursor;
    if (delimiter === "\\") {
      const escaped = readCommandName(input, cursor);
      delimiter = escaped.value === "\\" ? "\\" : _nullishCoalesce(COMMAND_MAP[escaped.value], () => ( escaped.value));
      next = escaped.next;
    }
    return { value: delimiter ? `${kw} ${delimiter}` : kw, next };
  }
  if (command in ACCENT_COMMANDS) {
    const body = readGroupOrToken(input, name.next, depth);
    return { value: `${ACCENT_COMMANDS[command]}{${body.value}}`, next: body.next };
  }
  if (command === ",") return { value: "`", next: name.next };
  if (command === ";" || command === ":") return { value: "~", next: name.next };
  if (command === "!") return { value: "", next: name.next };
  if (command === "mathrm" || command === "text") {
    const start = skipSpaces(input, name.next);
    if (input[start] === "{") {
      const group = readBalanced(input, start, "{", "}");
      return { value: `"${group.value}"`, next: group.next };
    }
    const tok = readGroupOrToken(input, start, depth);
    return { value: `"${tok.value}"`, next: tok.next };
  }
  return { value: _nullishCoalesce(COMMAND_MAP[command], () => ( command)), next: name.next };
}
function convertLatexFragment(input, depth) {
  if (depth > MAX_GROUP_DEPTH) return normalizeEqEdit(input);
  let out = "";
  let idx = 0;
  while (idx < input.length) {
    const ch = input[idx];
    if (ch === "\\") {
      const cmd = readCommand(input, idx, depth + 1);
      out += ` ${cmd.value} `;
      idx = cmd.next;
      continue;
    }
    if (ch === "{") {
      const group = readBalanced(input, idx, "{", "}");
      out += `{${convertLatexFragment(group.value, depth + 1)}}`;
      idx = group.next;
      continue;
    }
    if (ch === "_" || ch === "^") {
      const script = readGroupOrToken(input, idx + 1, depth);
      out += ` ${ch}{${script.value}}`;
      idx = script.next;
      continue;
    }
    if (ch === "&") {
      out += " & ";
      idx++;
      continue;
    }
    out += ch;
    idx++;
  }
  return normalizeEqEdit(out);
}
function quoteReservedKeywords(latex) {
  return latex.replace(/([_^])\s*\{\s*([A-Za-z]+)\s*\}/g, (match, op, word) => RESERVED_WORDS.has(word) ? `${op}{"${word}"}` : match);
}
function latexLikeToEqEdit(input) {
  const src = stripMathDelimiters(input);
  if (src.length > MAX_EQUATION_SOURCE) return normalizeEqEdit(src);
  return convertLatexFragment(quoteReservedKeywords(src), 0);
}
function estimateEquationMetrics(script) {
  const cleaned = script.replace(/[{}\\^_]/g, "").replace(/\s+/g, " ").trim();
  const width = Math.min(Math.max(cleaned.length, 5) * 700 + 2e3, 4e4);
  const rowCount = Math.max(1, (_nullishCoalesce(script.match(/#/g), () => ( []))).length + 1);
  if (/\bmatrix\b|#/.test(script)) {
    if (rowCount >= 4) return { width, height: 5500, baseline: 55 };
    if (rowCount === 3) return { width, height: 4500, baseline: 60 };
    return { width, height: 3260, baseline: 63 };
  }
  if (/\bover\b|\broot\b|\bsqrt\b/.test(script)) return { width, height: 3010, baseline: 69 };
  return { width, height: 1450, baseline: 71 };
}
function generateEquationXml(script, zOrder = 0) {
  const { width, height, baseline } = estimateEquationMetrics(script);
  const eqId = 2000000001 + zOrder;
  return `<hp:equation id="${eqId}" zOrder="${zOrder}" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="${baseline}" textColor="#000000" baseUnit="1200" lineMode="CHAR" font="HYhwpEQ"><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="56" right="56" top="0" bottom="0"/><hp:shapeComment>\uC218\uC2DD\uC785\uB2C8\uB2E4.</hp:shapeComment><hp:script>${escapeXml(script)}</hp:script></hp:equation>`;
}
function generateEquationParagraph(input, zOrder = 0) {
  const script = latexLikeToEqEdit(input);
  return `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${generateEquationXml(script, zOrder)}</hp:run></hp:p>`;
}

// src/hwpx/gen-section.ts
function generateSecPr(gongmun) {
  const m = gongmun ? {
    top: mmToHwpunit(gongmun.margins.top),
    bottom: mmToHwpunit(gongmun.margins.bottom),
    left: mmToHwpunit(gongmun.margins.left),
    right: mmToHwpunit(gongmun.margins.right),
    header: 0,
    footer: 0
  } : { top: 8504, bottom: 4252, left: 5670, right: 4252, header: 2835, footer: 2835 };
  return `<hp:secPr textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY"><hp:margin header="${m.header}" footer="${m.footer}" gutter="0" left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr></hp:secPr>`;
}
function blocksToSectionXml(blocks, theme, gongmun, gongmunList = gongmun ? precomputeGongmunList(blocks, gongmun) : null, fit = null, chartParts = null, remap = null) {
  const paraXmls = [];
  let isFirst = true;
  let tableSeq = 0;
  const orderedCounters = {};
  let prevWasOrdered = false;
  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx];
    let xml = "";
    if (block.type !== "list_item" || !block.ordered) {
      if (prevWasOrdered) {
        for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k];
      }
      prevWasOrdered = false;
    }
    switch (block.type) {
      case "heading": {
        const pId = headingParaPrId(block.level || 1);
        const cId = headingCharPrId(block.level || 1);
        xml = generateParagraph(block.text || "", pId, cId);
        break;
      }
      case "paragraph": {
        const ctr = gongmun && /^<center>([\s\S]*)<\/center>$/i.exec((block.text || "").trim());
        if (ctr) {
          xml = generateParagraph(ctr[1].trim(), GONGMUN_CENTER);
        } else {
          xml = generateParagraph(block.text || "", PARA_NORMAL, CHAR_NORMAL, fit ? variantMapper(fit, blockIdx) : void 0);
        }
        break;
      }
      case "code_block": {
        if (chartParts !== null && (block.lang || "").toLowerCase() === "chart") {
          const fence = parseChartFence(block.text || "");
          if (fence) {
            const partName = `Chart/chart${chartParts.length + 1}.xml`;
            chartParts.push({ name: partName, xml: buildChartSpaceXml(fence) });
            const chartEl = buildChartElementXml(partName, fence.widthHu, fence.heightHu, 91e5 + blockIdx);
            if (isFirst) {
              const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`;
              paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`);
              isFirst = false;
            }
            xml = `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_NORMAL}">${chartEl}</hp:run></hp:p>`;
            break;
          }
        }
        const codeLines = (block.text || "").split("\n");
        xml = codeLines.map((line) => generateParagraph(line || " ", PARA_CODE)).join("\n  ");
        break;
      }
      case "equation": {
        if (isFirst) {
          const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`;
          paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`);
          isFirst = false;
        }
        xml = generateEquationParagraph(block.text || "", blockIdx);
        break;
      }
      case "blockquote":
        xml = generateParagraph(
          block.text || "",
          PARA_QUOTE,
          theme.hasQuoteOption ? CHAR_QUOTE : CHAR_NORMAL
        );
        break;
      case "list_item": {
        if (gongmun && gongmunList) {
          const info = gongmunList.get(blockIdx);
          const depth = _nullishCoalesce(_optionalChain([info, 'optionalAccess', _235 => _235.depth]), () => ( 0));
          const marker2 = _nullishCoalesce(_optionalChain([info, 'optionalAccess', _236 => _236.marker]), () => ( ""));
          const content = block.text || "";
          const text = marker2 ? `${marker2} ${content}` : content;
          const listCharPr = gongmun.numbering === "report" && depth === 0 ? CHAR_BOLD : CHAR_NORMAL;
          xml = generateParagraph(text, GONGMUN_LIST_BASE + depth, listCharPr, fit ? variantMapper(fit, blockIdx) : void 0);
          break;
        }
        const indent = block.indent || 0;
        let marker;
        if (block.marker) {
          marker = `${block.marker} `;
          prevWasOrdered = !!block.ordered;
        } else if (block.ordered) {
          orderedCounters[indent] = (orderedCounters[indent] || 0) + 1;
          for (const k of Object.keys(orderedCounters)) {
            if (+k > indent) delete orderedCounters[+k];
          }
          marker = `${orderedCounters[indent]}. `;
          prevWasOrdered = true;
        } else {
          marker = "\xB7 ";
          if (prevWasOrdered) {
            for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k];
          }
          prevWasOrdered = false;
        }
        const indentPrefix = "  ".repeat(indent);
        xml = generateParagraph(indentPrefix + marker + (block.text || ""), PARA_LIST);
        break;
      }
      case "hr":
        xml = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500</hp:t></hp:run></hp:p>`;
        break;
      case "table":
        if (block.rows) {
          if (isFirst) {
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`;
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`);
            isFirst = false;
          }
          xml = generateTable(block.rows, theme, remap, tableSeq++);
        }
        break;
      case "html_table": {
        const tbl = generateHtmlTableXml(block.text || "", theme, 44e3, remap, tableSeq++);
        if (tbl) {
          if (isFirst) {
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run>`;
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`);
            isFirst = false;
          }
          xml = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`;
        } else {
          const plain = (block.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          xml = plain ? generateParagraph(plain) : "";
        }
        break;
      }
    }
    if (!xml) continue;
    if (isFirst && block.type !== "table") {
      xml = xml.replace(
        /<hp:run charPrIDRef="(\d+)">/,
        `<hp:run charPrIDRef="$1">${generateSecPr(gongmun)}`
      );
      isFirst = false;
    }
    paraXmls.push(xml);
  }
  if (paraXmls.length === 0) {
    paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${generateSecPr(gongmun)}<hp:t></hp:t></hp:run></hp:p>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="${NS_SECTION}" xmlns:hp="${NS_PARA}">
  ${paraXmls.join("\n  ")}
</hs:sec>`;
}

// src/hwpx/generator.ts
async function markdownToHwpx(markdown, options) {
  const theme = resolveTheme(_optionalChain([options, 'optionalAccess', _237 => _237.theme]));
  const gongmun = _optionalChain([options, 'optionalAccess', _238 => _238.gongmun]) ? resolveGongmun(options.gongmun) : null;
  const blocks = parseMarkdownToBlocks(markdown);
  const gongmunList = gongmun ? precomputeGongmunList(blocks, gongmun) : null;
  const fit = gongmun && gongmunList ? computeGongmunFitPlan(blocks, gongmun, gongmunList) : null;
  const remap = _optionalChain([options, 'optionalAccess', _239 => _239.profile]) ? buildProfileRemap(options.profile, profileCharPrBase(_nullishCoalesce(_optionalChain([fit, 'optionalAccess', _240 => _240.variants, 'optionalAccess', _241 => _241.length]), () => ( 0)))) : null;
  const chartParts = [];
  const sectionXml = blocksToSectionXml(blocks, theme, gongmun, gongmunList, fit, chartParts, remap);
  if (remap && remap.tables.length > 0) {
    const unused = remap.tables.filter((t) => !t.used).length;
    if (unused === remap.tables.length) {
      console.warn(`[kordoc] format profile: \uD504\uB85C\uD544 \uD45C ${unused}\uAC1C\uAC00 \uBB38\uC11C \uD45C\uC640 \uB9E4\uCE6D\uB418\uC9C0 \uC54A\uC544 \uBBF8\uC801\uC6A9 (\uD589\xB7\uC5F4/\uCCAB \uC140 \uD14D\uC2A4\uD2B8 \uBD88\uC77C\uCE58)`);
    }
  }
  const zip = new (0, _jszip2.default)();
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", generateContainerXml());
  zip.file("Contents/content.hpf", generateManifest(chartParts));
  zip.file("Contents/header.xml", generateHeaderXml(theme, gongmun, _nullishCoalesce(_optionalChain([fit, 'optionalAccess', _242 => _242.variants]), () => ( [])), remap));
  zip.file("Contents/section0.xml", sectionXml);
  for (const part of chartParts) zip.file(part.name, part.xml);
  zip.file("Preview/PrvText.txt", buildPrvText(blocks));
  return await zip.generateAsync({ type: "arraybuffer" });
}

// src/diff/compare.ts
var SIMILARITY_THRESHOLD = 0.4;
async function compare(bufferA, bufferB, options) {
  const [resultA, resultB] = await Promise.all([
    parse(bufferA, options),
    parse(bufferB, options)
  ]);
  if (!resultA.success) throw new Error(`\uBB38\uC11CA \uD30C\uC2F1 \uC2E4\uD328: ${resultA.error}`);
  if (!resultB.success) throw new Error(`\uBB38\uC11CB \uD30C\uC2F1 \uC2E4\uD328: ${resultB.error}`);
  return diffBlocks(resultA.blocks, resultB.blocks);
}
function diffBlocks(blocksA, blocksB) {
  const aligned = alignBlocks(blocksA, blocksB);
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const diffs = [];
  for (const [a, b] of aligned) {
    if (a && b) {
      const sim = blockSimilarity(a, b);
      if (sim >= 0.99) {
        diffs.push({ type: "unchanged", before: a, after: b, similarity: 1 });
        stats.unchanged++;
      } else {
        const diff = { type: "modified", before: a, after: b, similarity: sim };
        if (a.type === "table" && b.type === "table" && a.table && b.table) {
          diff.cellDiffs = diffTableCells(a.table, b.table);
        }
        diffs.push(diff);
        stats.modified++;
      }
    } else if (a) {
      diffs.push({ type: "removed", before: a });
      stats.removed++;
    } else if (b) {
      diffs.push({ type: "added", after: b });
      stats.added++;
    }
  }
  return { stats, diffs };
}
function alignBlocks(a, b) {
  const m = a.length, n = b.length;
  if (m * n > 1e7) return fallbackAlign(a, b);
  const simCache = /* @__PURE__ */ new Map();
  const getSim = (i2, j2) => {
    const key = `${i2},${j2}`;
    let v = simCache.get(key);
    if (v === void 0) {
      v = blockSimilarity(a[i2], b[j2]);
      simCache.set(key, v);
    }
    return v;
  };
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i2 = 1; i2 <= m; i2++) {
    for (let j2 = 1; j2 <= n; j2++) {
      if (getSim(i2 - 1, j2 - 1) >= SIMILARITY_THRESHOLD) {
        dp[i2][j2] = dp[i2 - 1][j2 - 1] + 1;
      } else {
        dp[i2][j2] = Math.max(dp[i2 - 1][j2], dp[i2][j2 - 1]);
      }
    }
  }
  const pairs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (getSim(i - 1, j - 1) >= SIMILARITY_THRESHOLD && dp[i][j] === dp[i - 1][j - 1] + 1) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();
  const result = [];
  let ai = 0, bi = 0;
  for (const [pi, pj] of pairs) {
    while (ai < pi) result.push([a[ai++], null]);
    while (bi < pj) result.push([null, b[bi++]]);
    result.push([a[ai++], b[bi++]]);
  }
  while (ai < m) result.push([a[ai++], null]);
  while (bi < n) result.push([null, b[bi++]]);
  return result;
}
function fallbackAlign(a, b) {
  const result = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    result.push([a[i] || null, b[i] || null]);
  }
  return result;
}
function blockSimilarity(a, b) {
  if (a.type !== b.type) return 0;
  if (a.text !== void 0 && b.text !== void 0) {
    return normalizedSimilarity(a.text || "", b.text || "");
  }
  if (a.type === "table" && a.table && b.table) {
    return tableSimilarity(a.table, b.table);
  }
  if (a.type === b.type) return 1;
  return 0;
}
function tableSimilarity(a, b) {
  const dimSim = 1 - Math.abs(a.rows * a.cols - b.rows * b.cols) / Math.max(a.rows * a.cols, b.rows * b.cols, 1);
  const textsA = a.cells.flat().map((c) => c.text).join(" ");
  const textsB = b.cells.flat().map((c) => c.text).join(" ");
  const contentSim = normalizedSimilarity(textsA, textsB);
  return dimSim * 0.3 + contentSim * 0.7;
}
function diffTableCells(a, b) {
  const maxRows = Math.max(a.rows, b.rows);
  const maxCols = Math.max(a.cols, b.cols);
  const result = [];
  for (let r = 0; r < maxRows; r++) {
    const row = [];
    for (let c = 0; c < maxCols; c++) {
      const cellA = r < a.rows && c < a.cols ? a.cells[r][c].text : void 0;
      const cellB = r < b.rows && c < b.cols ? b.cells[r][c].text : void 0;
      let type;
      if (cellA === void 0) type = "added";
      else if (cellB === void 0) type = "removed";
      else if (cellA === cellB) type = "unchanged";
      else type = "modified";
      row.push({ type, before: cellA, after: cellB });
    }
    result.push(row);
  }
  return result;
}

// src/form/seal.ts


// src/render/head-styles.ts
var DEFAULT_PARA_GEOM = {
  lineSpacingType: "PERCENT",
  lineSpacingValue: 160,
  marginLeft: 0,
  marginRight: 0,
  marginIntent: 0,
  spaceBefore: 0,
  spaceAfter: 0
};
var DEFAULT_CHAR = { height: 1e3, bold: false, italic: false, underline: false, ratio: 100, spacing: 0 };
var FONT_ALIASES = {
  "\uD568\uCD08\uB86C\uBC14\uD0D5": "'HCR Batang','\uD568\uCD08\uB86C\uBC14\uD0D5','\uD55C\uCEF4\uBC14\uD0D5'",
  "\uD55C\uCEF4\uBC14\uD0D5": "'HCR Batang','\uD568\uCD08\uB86C\uBC14\uD0D5','\uD55C\uCEF4\uBC14\uD0D5'",
  "\uD568\uCD08\uB86C\uB3CB\uC6C0": "'HCR Dotum','\uD568\uCD08\uB86C\uB3CB\uC6C0','\uD55C\uCEF4\uB3CB\uC6C0'",
  "\uD55C\uCEF4\uB3CB\uC6C0": "'HCR Dotum','\uD568\uCD08\uB86C\uB3CB\uC6C0','\uD55C\uCEF4\uB3CB\uC6C0'",
  "\uB9D1\uC740 \uACE0\uB515": "'Malgun Gothic','\uB9D1\uC740 \uACE0\uB515'",
  "\uB9D1\uC740\uACE0\uB515": "'Malgun Gothic','\uB9D1\uC740 \uACE0\uB515'",
  "\uAD74\uB9BC": "'Gulim','\uAD74\uB9BC'",
  "\uAD74\uB9BC\uCCB4": "'GulimChe','\uAD74\uB9BC\uCCB4','Gulim'",
  "\uB3CB\uC6C0": "'Dotum','\uB3CB\uC6C0'",
  "\uB3CB\uC6C0\uCCB4": "'DotumChe','\uB3CB\uC6C0\uCCB4','Dotum'",
  "\uBC14\uD0D5": "'Batang','\uBC14\uD0D5'",
  "\uBC14\uD0D5\uCCB4": "'BatangChe','\uBC14\uD0D5\uCCB4','Batang'",
  "\uAD81\uC11C": "'Gungsuh','\uAD81\uC11C'",
  "\uAD81\uC11C\uCCB4": "'GungsuhChe','\uAD81\uC11C\uCCB4','Gungsuh'",
  "\uB098\uB214\uACE0\uB515": "'NanumGothic','\uB098\uB214\uACE0\uB515'",
  "\uB098\uB214\uBA85\uC870": "'NanumMyeongjo','\uB098\uB214\uBA85\uC870'",
  "\uB9D1\uC740 \uACE0\uB515 Semilight": "'Malgun Gothic Semilight','\uB9D1\uC740 \uACE0\uB515'"
};
function isSerifFace(face) {
  return /바탕|명조|Batang|Myeong|Mincho|궁서|Gungsuh|Serif|신명|순명|Song|송/i.test(face);
}
function cssQuote(name) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `'${name.replace(/['"\\]/g, "")}'`;
}
function hwpFaceToCssStack(face) {
  const trimmed = (_nullishCoalesce(face, () => ( ""))).trim();
  if (!trimmed) return "";
  const generic = isSerifFace(trimmed) ? "'HCR Batang','Batang','Noto Serif KR',serif" : "'Malgun Gothic','HCR Dotum','Noto Sans KR',sans-serif";
  const head = _nullishCoalesce(FONT_ALIASES[trimmed], () => ( cssQuote(trimmed)));
  return `${head},${generic}`;
}
function collectHangulFonts(root) {
  const map = /* @__PURE__ */ new Map();
  const findFaces = (el, depth) => {
    if (depth > 24) return null;
    for (const ch of Array.from(el.childNodes)) {
      if (ch.nodeType !== 1) continue;
      const e = ch;
      if ((e.tagName || "").replace(/^[^:]+:/, "") === "fontfaces") return e;
      const f = findFaces(e, depth + 1);
      if (f) return f;
    }
    return null;
  };
  const faces = findFaces(root, 0);
  if (!faces) return map;
  let group = null;
  let firstGroup = null;
  for (const ch of Array.from(faces.childNodes)) {
    if (ch.nodeType !== 1) continue;
    const e = ch;
    if ((e.tagName || "").replace(/^[^:]+:/, "") !== "fontface") continue;
    if (!firstGroup) firstGroup = e;
    if ((_nullishCoalesce(e.getAttribute("lang"), () => ( ""))).toUpperCase() === "HANGUL") {
      group = e;
      break;
    }
  }
  group = _nullishCoalesce(group, () => ( firstGroup));
  if (!group) return map;
  for (const ch of Array.from(group.childNodes)) {
    if (ch.nodeType !== 1) continue;
    const e = ch;
    if ((e.tagName || "").replace(/^[^:]+:/, "") !== "font") continue;
    const id = e.getAttribute("id");
    const face = e.getAttribute("face");
    if (id != null && face) map.set(id, face);
  }
  return map;
}
function borderWidthPt(v) {
  const n = parseFloat(_nullishCoalesce(v, () => ( "")));
  if (!Number.isFinite(n)) return 0.34;
  return n * 2.834645;
}
function parseEdge(el) {
  if (!el) return void 0;
  const type = _nullishCoalesce(el.getAttribute("type"), () => ( "NONE"));
  if (type === "NONE") return void 0;
  return { type, widthPt: borderWidthPt(el.getAttribute("width")), color: _nullishCoalesce(el.getAttribute("color"), () => ( "#000000")) };
}
function findDeep(el, name, depth = 0) {
  if (depth > 32) return null;
  const children = el.childNodes;
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    const ch = children[i];
    if (ch.nodeType !== 1) continue;
    const e = ch;
    if ((e.tagName || "").replace(/^[^:]+:/, "") === name) return e;
    const found = findDeep(e, name, depth + 1);
    if (found) return found;
  }
  return null;
}
function parseParaGeom(el) {
  const g = { ...DEFAULT_PARA_GEOM };
  const ls = findDeep(el, "lineSpacing");
  if (ls) {
    g.lineSpacingType = _nullishCoalesce(ls.getAttribute("type"), () => ( "PERCENT"));
    g.lineSpacingValue = Number(ls.getAttribute("value")) || 160;
  }
  const margin = findDeep(el, "margin");
  if (margin) {
    const v = (n) => {
      const c = findDeep(margin, n);
      return c ? Number(c.getAttribute("value")) || 0 : 0;
    };
    g.marginLeft = v("left");
    g.marginRight = v("right");
    g.marginIntent = v("intent");
    g.spaceBefore = v("prev");
    g.spaceAfter = v("next");
  }
  return g;
}
function parseRenderStyles(headXml) {
  const styles = { charPr: /* @__PURE__ */ new Map(), paraAlign: /* @__PURE__ */ new Map(), paraGeom: /* @__PURE__ */ new Map(), borderFill: /* @__PURE__ */ new Map() };
  const doc = createXmlParser().parseFromString(headXml, "text/xml");
  const root = doc.documentElement;
  if (!root) return styles;
  const hangulFonts = collectHangulFonts(root);
  const walk = (el) => {
    const tag = (el.tagName || "").replace(/^[^:]+:/, "");
    if (tag === "charPr") {
      const id = el.getAttribute("id");
      if (id != null) {
        const ratioEl = findChildByLocalName(el, "ratio");
        const spacingEl = findChildByLocalName(el, "spacing");
        const underlineEl = findChildByLocalName(el, "underline");
        const textColor = el.getAttribute("textColor");
        const fontRef = findChildByLocalName(el, "fontRef");
        const fontId = _nullishCoalesce(_optionalChain([fontRef, 'optionalAccess', _243 => _243.getAttribute, 'call', _244 => _244("hangul")]), () => ( _optionalChain([fontRef, 'optionalAccess', _245 => _245.getAttribute, 'call', _246 => _246("latin")])));
        const face = fontId != null ? hangulFonts.get(fontId) : void 0;
        styles.charPr.set(id, {
          height: Number(el.getAttribute("height")) || 1e3,
          bold: findChildByLocalName(el, "bold") != null,
          italic: findChildByLocalName(el, "italic") != null,
          underline: underlineEl != null && (_nullishCoalesce(underlineEl.getAttribute("type"), () => ( "NONE"))) !== "NONE",
          color: textColor && textColor !== "#000000" && textColor.toLowerCase() !== "none" ? textColor : void 0,
          ratio: Number(_optionalChain([ratioEl, 'optionalAccess', _247 => _247.getAttribute, 'call', _248 => _248("hangul")])) || 100,
          spacing: Number(_optionalChain([spacingEl, 'optionalAccess', _249 => _249.getAttribute, 'call', _250 => _250("hangul")])) || 0,
          fontFamily: face ? hwpFaceToCssStack(face) : void 0
        });
      }
    } else if (tag === "paraPr") {
      const id = el.getAttribute("id");
      if (id != null) {
        const align = findChildByLocalName(el, "align");
        styles.paraAlign.set(id, _optionalChain([align, 'optionalAccess', _251 => _251.getAttribute, 'call', _252 => _252("horizontal")]) || "JUSTIFY");
        styles.paraGeom.set(id, parseParaGeom(el));
      }
    } else if (tag === "borderFill") {
      const id = el.getAttribute("id");
      if (id != null) {
        const bf = {
          left: parseEdge(findChildByLocalName(el, "leftBorder")),
          right: parseEdge(findChildByLocalName(el, "rightBorder")),
          top: parseEdge(findChildByLocalName(el, "topBorder")),
          bottom: parseEdge(findChildByLocalName(el, "bottomBorder"))
        };
        const fillBrush = findChildByLocalName(el, "fillBrush");
        const winBrush = fillBrush ? findChildByLocalName(fillBrush, "winBrush") : null;
        const face = _optionalChain([winBrush, 'optionalAccess', _253 => _253.getAttribute, 'call', _254 => _254("faceColor")]);
        if (face && face.toLowerCase() !== "none") bf.fill = face;
        styles.borderFill.set(id, bf);
      }
    }
    const children = el.childNodes;
    for (let i = 0; i < children.length; i++) {
      const ch = children[i];
      if (ch.nodeType === 1) walk(ch);
    }
  };
  walk(root);
  return styles;
}

// src/form/seal.ts
var HU_PER_MM2 = 7200 / 25.4;
var mm2hu = (mm) => Math.round(mm * HU_PER_MM2);
var MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  bmp: "image/bmp",
  gif: "image/gif"
};
function imageMagicMatches(buf, ext) {
  switch (ext) {
    case "png":
      return buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
    case "jpg":
    case "jpeg":
      return buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255;
    case "bmp":
      return buf.length >= 2 && buf[0] === 66 && buf[1] === 77;
    case "gif":
      return buf.length >= 6 && buf[0] === 71 && buf[1] === 73 && buf[2] === 70;
    default:
      return false;
  }
}
function glyphEm(code) {
  if (code < 32) return 0;
  if (code <= 126) return 0.5;
  if (code >= 65377 && code <= 65500) return 0.5;
  return 1;
}
function measureMm(text, emMm) {
  let w = 0;
  for (const ch of text) w += glyphEm(_nullishCoalesce(ch.codePointAt(0), () => ( 0))) * emMm;
  return w;
}
function collectSites(scan) {
  const sites = [];
  for (const p of scan.bodyParagraphs) sites.push({ para: p });
  const walkTables = (tables, depth, outer) => {
    if (depth > 16) return;
    for (const t of tables) {
      for (const row of t.rows) {
        for (const cell of row) {
          for (const p of cell.paragraphs) sites.push({ para: p, cell, table: t, nested: depth > 0, outer: outer.length ? outer : void 0 });
          walkTables(cell.tables, depth + 1, [...outer, { cell, table: t }]);
        }
      }
    }
  };
  walkTables(scan.tables, 0, []);
  walkTables(scan.orphanTables, 0, []);
  sites.sort((a, b) => a.para.start - b.para.start);
  return sites;
}
function attrOf(openTag, name) {
  const m = openTag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return _optionalChain([m, 'optionalAccess', _255 => _255[1]]);
}
function paraOpenTag(xml, para) {
  const end = xml.indexOf(">", para.start);
  return end === -1 ? "" : xml.slice(para.start, end + 1);
}
function anchorRunInfo(xml, para, anchor) {
  let tr = para.tRanges.find((r) => !r.selfClosing && xml.slice(r.contentStart, r.contentEnd).includes(anchor));
  if (!tr) {
    const head = anchor[0];
    tr = _nullishCoalesce(para.tRanges.find((r) => !r.selfClosing && xml.slice(r.contentStart, r.contentEnd).includes(head)), () => ( para.tRanges[para.tRanges.length - 1]));
  }
  if (!tr) return null;
  const before = xml.slice(Math.max(0, para.start), tr.contentStart);
  const runOpen = [...before.matchAll(/<([A-Za-z0-9]+):run\b[^>]*>/g)].pop();
  const prefix = _nullishCoalesce(_nullishCoalesce(_optionalChain([runOpen, 'optionalAccess', _256 => _256[1]]), () => ( tr.prefix)), () => ( "hp"));
  const charPr2 = runOpen && attrOf(runOpen[0], "charPrIDRef") || "0";
  const close = xml.indexOf(`</${prefix}:run>`, tr.contentEnd);
  if (close === -1) return null;
  return { charPr: charPr2, prefix, insertAt: close + `</${prefix}:run>`.length };
}
function cellAddrWindow(xml, cell) {
  if (!cell.addrTagRange) return null;
  return xml.slice(cell.addrTagRange.end, cell.addrTagRange.end + 400);
}
function cellSzWidthHu(xml, cell) {
  const win = cellAddrWindow(xml, cell);
  if (win) {
    const m = win.match(/<[A-Za-z0-9]+:cellSz\b[^>]*\bwidth="(\d+)"/);
    if (m) return Number(m[1]);
  }
  const firstPara = cell.paragraphs[0];
  if (!firstPara) return null;
  const upto = xml.slice(0, firstPara.start);
  const szMatch = [...upto.matchAll(/<[A-Za-z0-9]+:cellSz\b[^>]*\bwidth="(\d+)"[^>]*>/g)].pop();
  return szMatch ? Number(szMatch[1]) : null;
}
function cellContentWidthMm(xml, cell) {
  const width = cellSzWidthHu(xml, cell);
  if (width === null) return null;
  let content = width;
  const win = cellAddrWindow(xml, cell);
  const mg = _optionalChain([win, 'optionalAccess', _257 => _257.match, 'call', _258 => _258(/<[A-Za-z0-9]+:cellMargin\b[^>]*>/)]);
  if (mg) {
    content -= Number(_nullishCoalesce(attrOf(mg[0], "left"), () => ( 0))) + Number(_nullishCoalesce(attrOf(mg[0], "right"), () => ( 0)));
  }
  return content > 0 ? content / HU_PER_MM2 : null;
}
function cellLeftOffsetMm(xml, table, cell) {
  if (cell.colAddr === void 0) return 0;
  const colW = /* @__PURE__ */ new Map();
  for (const row of table.rows) {
    for (const c of row) {
      if (c.colAddr === void 0 || colW.has(c.colAddr)) continue;
      if (c.colSpan > 1) continue;
      const w = cellSzWidthHu(xml, c);
      if (w) colW.set(c.colAddr, w);
    }
  }
  let sum = 0;
  for (let col = 0; col < cell.colAddr; col++) sum += _nullishCoalesce(colW.get(col), () => ( 0));
  return sum / HU_PER_MM2;
}
function bodyColumnWidthMm(xml) {
  const page = xml.match(/<[A-Za-z0-9]+:pagePr\b[^>]*\bwidth="(\d+)"[^>]*>/);
  const margin = xml.match(/<[A-Za-z0-9]+:margin\b[^>]*\bleft="(\d+)"[^>]*\bright="(\d+)"[^>]*>/);
  if (!page) return 150;
  const w = Number(page[1]) - (margin ? Number(margin[1]) + Number(margin[2]) : 0);
  return w > 0 ? w / HU_PER_MM2 : 150;
}
function buildFloatPicXml(itemId, sizeHu, posXHu, posYHu, ids) {
  const w = sizeHu;
  const h = sizeHu;
  return `<hp:pic xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" id="${ids.id}" zOrder="0" numberingType="PICTURE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${ids.instid}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect><hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${w}" dimheight="${h}"/><hc:img binaryItemIDRef="${itemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/><hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="${posYHu}" horzOffset="${posXHu}"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>kordoc seal</hp:shapeComment></hp:pic>`;
}
async function placeSealHwpx(hwpxBuffer, ops) {
  if (ops.length === 0) throw new (0, _chunkR2H34FY5cjs.KordocError)("place_seal: \uBC30\uCE58\uD560 \uB3C4\uC7A5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4");
  const u8 = new Uint8Array(hwpxBuffer);
  const zip = await _jszip2.default.loadAsync(hwpxBuffer);
  const sectionPaths = Object.keys(zip.files).filter((name) => /[Ss]ection\d+\.xml$/i.test(name)).sort((a, b) => Number(_nullishCoalesce(_optionalChain([a, 'access', _259 => _259.match, 'call', _260 => _260(/(\d+)\.xml$/i), 'optionalAccess', _261 => _261[1]]), () => ( 0))) - Number(_nullishCoalesce(_optionalChain([b, 'access', _262 => _262.match, 'call', _263 => _263(/(\d+)\.xml$/i), 'optionalAccess', _264 => _264[1]]), () => ( 0))));
  if (sectionPaths.length === 0) throw new (0, _chunkR2H34FY5cjs.KordocError)("HWPX\uC5D0\uC11C \uC139\uC158 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  const manifestPath = Object.keys(zip.files).find((name) => /\.hpf$/i.test(name));
  const headerPath = Object.keys(zip.files).find((name) => /(^|\/)header\.xml$/i.test(name));
  const styles = headerPath ? parseRenderStyles(await zip.file(headerPath).async("text")) : null;
  const sectionXmls = [];
  const scans = [];
  for (let si = 0; si < sectionPaths.length; si++) {
    const xml = await zip.file(sectionPaths[si]).async("text");
    sectionXmls.push(xml);
    scans.push(scanSectionXml(xml, si));
  }
  const sitesBySection = scans.map(collectSites);
  const usedIds = /* @__PURE__ */ new Set();
  let manifestXml = "";
  if (manifestPath) {
    manifestXml = await zip.file(manifestPath).async("text");
    for (const m of manifestXml.matchAll(/<opf:item\b[^>]*\bid="([^"]+)"/g)) usedIds.add(m[1]);
  }
  const usedImageNums = /* @__PURE__ */ new Set();
  for (const name of Object.keys(zip.files)) {
    const m = name.match(/^BinData\/(?:image|img)(\d+)\./i);
    if (m) usedImageNums.add(Number(m[1]));
  }
  const nextImageNum = () => {
    let n = 1;
    while (usedImageNums.has(n) || usedIds.has(`image${n}`)) n++;
    usedImageNums.add(n);
    return n;
  };
  let maxId = 1e6;
  for (const xml of sectionXmls) {
    for (const m of xml.matchAll(/\b(?:id|instid)="(\d+)"/g)) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > maxId) maxId = v;
    }
  }
  const splicesBySection = sectionPaths.map(() => []);
  const additions = /* @__PURE__ */ new Map();
  const manifestItems = [];
  const placed = [];
  for (const op of ops) {
    if (!op.anchor) throw new (0, _chunkR2H34FY5cjs.KordocError)("place_seal: anchor \uBB38\uAD6C\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4");
    if (!op.image || op.image.length === 0) throw new (0, _chunkR2H34FY5cjs.KordocError)("place_seal: \uB3C4\uC7A5 \uC774\uBBF8\uC9C0\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4");
    const ext = (_nullishCoalesce(op.ext, () => ( "png"))).toLowerCase();
    if (!MIME[ext]) throw new (0, _chunkR2H34FY5cjs.KordocError)(`place_seal: \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uC774\uBBF8\uC9C0 \uD655\uC7A5\uC790 .${ext} (png/jpg/bmp/gif)`);
    if (!imageMagicMatches(op.image, ext)) throw new (0, _chunkR2H34FY5cjs.KordocError)(`place_seal: \uC774\uBBF8\uC9C0 \uB0B4\uC6A9\uC774 .${ext} \uD615\uC2DD\uC774 \uC544\uB2D9\uB2C8\uB2E4 (\uB9E4\uC9C1\uBC14\uC774\uD2B8 \uBD88\uC77C\uCE58)`);
    const wantOcc = _nullishCoalesce(op.occurrence, () => ( 0));
    let found = null;
    let total = 0;
    for (let si2 = 0; si2 < scans.length && !found; si2++) {
      for (const site2 of sitesBySection[si2]) {
        let from = 0;
        for (; ; ) {
          const idx = site2.para.text.indexOf(op.anchor, from);
          if (idx === -1) break;
          if (total === wantOcc) {
            found = { si: si2, site: site2, idxInText: idx };
            break;
          }
          total++;
          from = idx + op.anchor.length;
        }
        if (found) break;
      }
    }
    if (!found) {
      total = 0;
      for (let si2 = 0; si2 < scans.length; si2++) {
        for (const site2 of sitesBySection[si2]) {
          let from = 0;
          for (; ; ) {
            const idx = site2.para.text.indexOf(op.anchor, from);
            if (idx === -1) break;
            total++;
            from = idx + op.anchor.length;
          }
        }
      }
      throw new (0, _chunkR2H34FY5cjs.KordocError)(
        `place_seal: \uC575\uCEE4 "${op.anchor}" ${wantOcc}\uBC88\uC9F8 \uB4F1\uC7A5\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (\uBCF8\uBB38 \uB0B4 ${total}\uD68C \uB4F1\uC7A5 \u2014 occurrence 0..${Math.max(0, total - 1)})`
      );
    }
    const { si, site, idxInText } = found;
    const xml = sectionXmls[si];
    const run = anchorRunInfo(xml, site.para, op.anchor);
    if (!run) {
      throw new (0, _chunkR2H34FY5cjs.KordocError)(`place_seal: \uC575\uCEE4 "${op.anchor}" \uBB38\uB2E8\uC5D0\uC11C run\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4`);
    }
    const charPrHeight = _nullishCoalesce(_optionalChain([styles, 'optionalAccess', _265 => _265.charPr, 'access', _266 => _266.get, 'call', _267 => _267(run.charPr), 'optionalAccess', _268 => _268.height]), () => ( 1e3));
    const fontPt = charPrHeight / 100;
    const emMm = fontPt * 25.4 / 72;
    const lineHMm = emMm;
    const startXMm = measureMm(site.para.text.slice(0, idxInText), emMm);
    const anchorWMm = measureMm(op.anchor, emMm);
    const sizeMm = op.sizeMm != null && Number.isFinite(op.sizeMm) && op.sizeMm > 0 ? op.sizeMm : Math.max(7, Math.min(18, lineHMm * 1.6));
    const availMm = _nullishCoalesce((site.cell ? cellContentWidthMm(xml, site.cell) : null), () => ( bodyColumnWidthMm(xml)));
    const paraPrId = _nullishCoalesce(attrOf(paraOpenTag(xml, site.para), "paraPrIDRef"), () => ( "0"));
    const align = _optionalChain([styles, 'optionalAccess', _269 => _269.paraAlign, 'access', _270 => _270.get, 'call', _271 => _271(paraPrId)]);
    let alignShiftMm = 0;
    if (align === "CENTER" || align === "RIGHT") {
      const paraWMm = measureMm(site.para.text, emMm);
      alignShiftMm = align === "CENTER" ? (availMm - paraWMm) / 2 : availMm - paraWMm;
      if (!Number.isFinite(alignShiftMm) || alignShiftMm < 0) alignShiftMm = 0;
    }
    let mode = _nullishCoalesce(op.mode, () => ( "auto"));
    if (mode === "auto") {
      mode = availMm - (alignShiftMm + startXMm + anchorWMm) >= sizeMm + 2 ? "right" : "overlap";
    }
    const cellShiftMm = site.cell && site.table ? cellLeftOffsetMm(xml, site.table, site.cell) + (_nullishCoalesce(site.outer, () => ( []))).reduce((s, o) => s + cellLeftOffsetMm(xml, o.table, o.cell), 0) : 0;
    const posXMm = (mode === "right" ? startXMm + anchorWMm + 2 : startXMm + anchorWMm / 2 - sizeMm / 2) + alignShiftMm + cellShiftMm + (_nullishCoalesce(op.dxMm, () => ( 0)));
    const posYMm = -(sizeMm - lineHMm) / 2 + (_nullishCoalesce(op.dyMm, () => ( 0)));
    const n = nextImageNum();
    const entry = `BinData/image${n}.${ext}`;
    const itemId = `image${n}`;
    usedIds.add(itemId);
    additions.set(entry, op.image);
    manifestItems.push(`<opf:item id="${itemId}" href="${entry}" media-type="${MIME[ext]}" isEmbeded="1"/>`);
    const pic = buildFloatPicXml(itemId, mm2hu(sizeMm), mm2hu(posXMm), mm2hu(posYMm), {
      id: ++maxId,
      instid: ++maxId
    });
    splicesBySection[si].push({
      start: run.insertAt,
      end: run.insertAt,
      replacement: `<${run.prefix}:run charPrIDRef="${run.charPr}">${pic}</${run.prefix}:run>`
    });
    const warnings = [];
    const paraSeg = xml.slice(site.para.start, run.insertAt);
    if (/<[A-Za-z0-9]+:tab\b/.test(paraSeg)) warnings.push("\uD0ED\uC774 \uB4E0 \uBB38\uB2E8 \u2014 \uB3C4\uC7A5 \uAC00\uB85C \uC704\uCE58\uAC00 \uADFC\uC0AC\uAC12\uC785\uB2C8\uB2E4 (dx \uB85C \uBCF4\uC815)");
    if (/<[A-Za-z0-9]+:(lineBreak|br)\b/.test(paraSeg)) warnings.push("\uC904\uBC14\uAFC8\uC774 \uB4E0 \uBB38\uB2E8 \u2014 \uC575\uCEE4\uAC00 2\uBC88\uC9F8 \uC904 \uC774\uD558\uBA74 \uC138\uB85C \uC704\uCE58\uAC00 \uC5B4\uAE0B\uB0A0 \uC218 \uC788\uC2B5\uB2C8\uB2E4 (dy \uB85C \uBCF4\uC815)");
    if (site.nested) warnings.push("\uC911\uCCA9\uD45C(\uD45C \uC548 \uD45C) \uC140 \uC575\uCEE4 \u2014 \uBC14\uAE65 \uC140 \uC624\uD504\uC14B\uC744 \uCCB4\uC778\uC73C\uB85C \uAC00\uC0B0\uD558\uB098 \uC140 \uC5EC\uBC31\xB7\uC815\uB82C\uC740 \uADFC\uC0AC\uC785\uB2C8\uB2E4 (\uD544\uC694 \uC2DC dx \uB85C \uBCF4\uC815)");
    if (site.para.inTextbox) warnings.push("\uAE00\uC0C1\uC790 \uC575\uCEE4 \u2014 \uAE00\uC0C1\uC790 \uAE30\uD558\uB97C \uBC18\uC601\uD558\uC9C0 \uC54A\uC544 \uC815\uB82C \uBCF4\uC815\uC774 \uADFC\uC0AC\uC785\uB2C8\uB2E4 (dx/dy \uB85C \uBCF4\uC815)");
    placed.push({
      anchor: op.anchor,
      occurrence: wantOcc,
      sectionIndex: si,
      mode,
      posXMm: Math.round(posXMm * 100) / 100,
      posYMm: Math.round(posYMm * 100) / 100,
      sizeMm: Math.round(sizeMm * 100) / 100,
      entry,
      ...warnings.length > 0 ? { warnings } : {}
    });
  }
  const encoder = new TextEncoder();
  const replacements = /* @__PURE__ */ new Map();
  for (let si = 0; si < sectionPaths.length; si++) {
    if (splicesBySection[si].length === 0) continue;
    replacements.set(sectionPaths[si], encoder.encode(applySplices(sectionXmls[si], splicesBySection[si])));
  }
  if (manifestPath && manifestItems.length > 0) {
    const patched = manifestXml.includes("</opf:manifest>") ? manifestXml.replace("</opf:manifest>", `${manifestItems.join("")}</opf:manifest>`) : manifestXml;
    if (patched !== manifestXml) replacements.set(manifestPath, encoder.encode(patched));
  }
  const out = patchZipEntries(u8, replacements, additions);
  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    placed
  };
}

// src/hwpx/extract-profile.ts

function elemsByLocal(root, name) {
  const all = root.getElementsByTagName("*");
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const tag = (el.tagName || el.localName || "").replace(/^[^:]+:/, "");
    if (tag === name) out.push(el);
  }
  return out;
}
function borderDefOf(el) {
  if (!el) return void 0;
  const type = el.getAttribute("type") || "NONE";
  const width = el.getAttribute("width") || "0.1 mm";
  const color = el.getAttribute("color") || "#000000";
  return { type, width, color };
}
function parseBorderFills(headerDoc) {
  const map = /* @__PURE__ */ new Map();
  for (const bf of elemsByLocal(headerDoc, "borderFill")) {
    const id = bf.getAttribute("id");
    if (!id) continue;
    const def = {
      leftBorder: borderDefOf(findChildByLocalName(bf, "leftBorder")),
      rightBorder: borderDefOf(findChildByLocalName(bf, "rightBorder")),
      topBorder: borderDefOf(findChildByLocalName(bf, "topBorder")),
      bottomBorder: borderDefOf(findChildByLocalName(bf, "bottomBorder"))
    };
    const fillBrush = findChildByLocalName(bf, "fillBrush");
    const winBrush = fillBrush ? findChildByLocalName(fillBrush, "winBrush") : null;
    const face = _optionalChain([winBrush, 'optionalAccess', _272 => _272.getAttribute, 'call', _273 => _273("faceColor")]);
    if (face && face !== "none") def.fill = { faceColor: face };
    map.set(id, def);
  }
  return map;
}
function parseCharPrs(headerDoc) {
  const map = /* @__PURE__ */ new Map();
  for (const cp of elemsByLocal(headerDoc, "charPr")) {
    const id = cp.getAttribute("id");
    if (!id) continue;
    const def = {};
    const h = cp.getAttribute("height");
    if (h) def.height_hwpunit = h;
    const color = cp.getAttribute("textColor");
    if (color) def.textColor = color;
    if (cp.getAttribute("bold") === "1") def.bold = true;
    if (cp.getAttribute("italic") === "1") def.italic = true;
    if (findChildByLocalName(cp, "underline")) def.underline = true;
    const fontRef = findChildByLocalName(cp, "fontRef");
    const hangul = _optionalChain([fontRef, 'optionalAccess', _274 => _274.getAttribute, 'call', _275 => _275("hangul")]);
    if (hangul) def.fontRef_hangul = hangul;
    map.set(id, def);
  }
  return map;
}
function isTopLevelTable(tbl) {
  let p = tbl.parentNode;
  while (p) {
    const tag = (p.tagName || p.localName || "").replace(/^[^:]+:/, "");
    if (tag === "tbl") return false;
    p = p.parentNode;
  }
  return true;
}
function num(s) {
  if (s == null) return void 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : void 0;
}
function parseTable3(tbl, tableIndex, borderFills, charPrs) {
  const rows = _nullishCoalesce(num(tbl.getAttribute("rowCnt")), () => ( 0));
  const cols = _nullishCoalesce(num(tbl.getAttribute("colCnt")), () => ( 0));
  const sz = findChildByLocalName(tbl, "sz");
  const width = _optionalChain([sz, 'optionalAccess', _276 => _276.getAttribute, 'call', _277 => _277("width")]) || void 0;
  const cells = [];
  const usedBf = /* @__PURE__ */ new Set();
  const usedCp = /* @__PURE__ */ new Set();
  const colWidths = new Array(cols).fill(void 0);
  let anchorText = "";
  for (const tc of elemsByLocal(tbl, "tc")) {
    if (nearestTable(tc) !== tbl) continue;
    const addr = findChildByLocalName(tc, "cellAddr");
    const span = findChildByLocalName(tc, "cellSpan");
    const csz = findChildByLocalName(tc, "cellSz");
    const row = _nullishCoalesce(num(_optionalChain([addr, 'optionalAccess', _278 => _278.getAttribute, 'call', _279 => _279("rowAddr")])), () => ( 0));
    const col = _nullishCoalesce(num(_optionalChain([addr, 'optionalAccess', _280 => _280.getAttribute, 'call', _281 => _281("colAddr")])), () => ( 0));
    if (row === 0 && col === 0 && !anchorText) anchorText = directCellText(tc);
    const colSpan = _nullishCoalesce(num(_optionalChain([span, 'optionalAccess', _282 => _282.getAttribute, 'call', _283 => _283("colSpan")])), () => ( 1));
    const rowSpan = _nullishCoalesce(num(_optionalChain([span, 'optionalAccess', _284 => _284.getAttribute, 'call', _285 => _285("rowSpan")])), () => ( 1));
    const bfId = tc.getAttribute("borderFillIDRef") || void 0;
    const cpId = firstRunCharPr(tc);
    const cell = { row, col, rowSpan, colSpan };
    const w = _optionalChain([csz, 'optionalAccess', _286 => _286.getAttribute, 'call', _287 => _287("width")]);
    const hh = _optionalChain([csz, 'optionalAccess', _288 => _288.getAttribute, 'call', _289 => _289("height")]);
    if (w) cell.width_hwpunit = w;
    if (hh) cell.height_hwpunit = hh;
    if (bfId) {
      cell.borderFillIDRef = bfId;
      usedBf.add(bfId);
    }
    if (cpId) {
      cell.charPrIDRef = cpId;
      usedCp.add(cpId);
    }
    cells.push(cell);
    if (row === 0 && colSpan === 1 && col < cols && w) colWidths[col] = w;
  }
  const table = {
    table_index: tableIndex,
    rows,
    cols,
    cells,
    used_border_fills: pick(borderFills, usedBf)
  };
  const anchor = normalizeAnchor(anchorText);
  if (anchor) table.anchor_text = anchor;
  if (width) table.width_hwpunit = width;
  if (colWidths.every((w) => w != null)) table.col_widths_hwpunit = colWidths;
  const cp = pick(charPrs, usedCp);
  if (Object.keys(cp).length) table.used_char_prs = cp;
  return table;
}
function nearestTable(tc) {
  let p = tc.parentNode;
  while (p) {
    const tag = (p.tagName || p.localName || "").replace(/^[^:]+:/, "");
    if (tag === "tbl") return p;
    p = p.parentNode;
  }
  return null;
}
function firstRunCharPr(tc) {
  for (const run of elemsByLocal(tc, "run")) {
    if (nearestCell(run) !== tc) continue;
    const id = run.getAttribute("charPrIDRef");
    if (id) return id;
  }
  return void 0;
}
function nearestCell(el) {
  let p = el.parentNode;
  while (p) {
    const tag = (p.tagName || p.localName || "").replace(/^[^:]+:/, "");
    if (tag === "tc") return p;
    p = p.parentNode;
  }
  return null;
}
function directCellText(tc) {
  let out = "";
  for (const t of elemsByLocal(tc, "t")) {
    if (nearestCell(t) !== tc) continue;
    out += _nullishCoalesce(t.textContent, () => ( ""));
    if (out.length >= 64) break;
  }
  return out;
}
function pick(map, keys) {
  const out = {};
  for (const k of keys) {
    const v = map.get(k);
    if (v !== void 0) out[k] = v;
  }
  return out;
}
async function hwpxToProfile(input) {
  const buf = input instanceof ArrayBuffer ? input : _chunkR2H34FY5cjs.toArrayBuffer.call(void 0, input);
  const zip = await _jszip2.default.loadAsync(buf);
  const parser = createXmlParser();
  const headerFile = _nullishCoalesce(zip.file("Contents/header.xml"), () => ( _optionalChain([zip, 'access', _290 => _290.file, 'call', _291 => _291(/[Hh]eader\.xml$/), 'optionalAccess', _292 => _292[0]])));
  let headerXml = "<root/>";
  if (headerFile) headerXml = await headerFile.async("text");
  const headerDoc = parser.parseFromString(headerXml, "text/xml");
  const borderFills = parseBorderFills(headerDoc);
  const charPrs = parseCharPrs(headerDoc);
  const sectionFiles = zip.file(/[Ss]ection\d+\.xml$/).sort((a, b) => (_nullishCoalesce(num(_nullishCoalesce(_optionalChain([a, 'access', _293 => _293.name, 'access', _294 => _294.match, 'call', _295 => _295(/(\d+)\.xml$/), 'optionalAccess', _296 => _296[1]]), () => ( null))), () => ( 0))) - (_nullishCoalesce(num(_nullishCoalesce(_optionalChain([b, 'access', _297 => _297.name, 'access', _298 => _298.match, 'call', _299 => _299(/(\d+)\.xml$/), 'optionalAccess', _300 => _300[1]]), () => ( null))), () => ( 0))));
  const tables = [];
  let tableIndex = 0;
  for (const f of sectionFiles) {
    const doc = parser.parseFromString(await f.async("text"), "text/xml");
    for (const tbl of elemsByLocal(doc, "tbl")) {
      if (!isTopLevelTable(tbl)) continue;
      tables.push(parseTable3(tbl, tableIndex++, borderFills, charPrs));
    }
  }
  return { schema_version: "0.2.0", tables };
}

// src/roundtrip/patcher.ts


// src/roundtrip/table-rows.ts
var ROW_OBJECT_RE = /<(?:[A-Za-z0-9_]+:)?(?:tbl|pic|equation|ole|container|shape|drawingObject|drawText|video|chart|fieldBegin|fieldEnd|ctrl)\b/;
var TAG_AT_RE = /<[A-Za-z0-9_:]+(?:"[^"]*"|'[^']*'|[^>"'])*>/y;
function patchTableRows(input) {
  const { table, scanTable, ctx, skip, origKeys, editedKeys } = input;
  const xml = _optionalChain([ctx, 'access', _301 => _301.scans, 'access', _302 => _302[scanTable.sectionIndex], 'optionalAccess', _303 => _303.xml]);
  if (!xml) return skip("\uC139\uC158 XML \uB9E4\uD551 \uC2E4\uD328");
  const numRows = table.rows;
  if (origKeys.length !== numRows) return skip("\uD45C \uD589 \uC88C\uD45C \uBD88\uC77C\uCE58 \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  if (scanTable.rows.length !== numRows || scanTable.rowRanges.length !== numRows) {
    return skip("\uD45C \uD589 \uAD6C\uC870 \uC88C\uD45C \uBD88\uC77C\uCE58 (\uBE48 \uD589/\uBCD1\uD569 \uC18C\uC2E4) \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  }
  for (let r = 0; r < numRows; r++) {
    if (scanTable.rows[r].some((c) => c.rowAddr !== r)) {
      return skip("\uD589 \uC8FC\uC18C \uBE44\uC5F0\uC18D \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
    }
  }
  const allCells = scanTable.rows.flat();
  const explicitAddr = (c) => !!c.addrTagRange && /\browAddr\s*=\s*"/.test(xml.slice(c.addrTagRange.start, c.addrTagRange.end));
  const explicitCount = allCells.filter(explicitAddr).length;
  if (explicitCount !== 0 && explicitCount !== allCells.length) {
    return skip("\uC140 \uC8FC\uC18C(cellAddr) \uD45C\uAE30 \uD63C\uC7AC \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  }
  const hasExplicitAddr = explicitCount > 0;
  const pairs = alignUnits(origKeys, editedKeys);
  const seq = [];
  let lastOrig = -1;
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) {
      seq.push({ kind: "keep", oi, ei });
      lastOrig = oi;
    } else if (oi !== null) {
      seq.push({ kind: "del", oi });
      lastOrig = oi;
    } else if (ei !== null) seq.push({ kind: "ins", ei, insertAt: lastOrig + 1 });
  }
  const dels = seq.filter((e) => e.kind === "del");
  const inss = seq.filter((e) => e.kind === "ins");
  const keeps = seq.filter((e) => e.kind === "keep");
  if (dels.length === 0 && inss.length === 0) {
    return skip("\uD45C \uD589 \uC815\uB82C \uC2E4\uD328 \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  }
  if (keeps.length + inss.length === 0) return skip("\uBAA8\uB4E0 \uD589 \uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0");
  if (keeps.length === 0) return skip("\uD589 \uC804\uBA74 \uAD50\uCCB4 \u2014 \uC11C\uC2DD \uAE30\uC900 \uD589\uC774 \uC5C6\uC5B4 \uBBF8\uC9C0\uC6D0");
  const spans = allCells.filter((c) => (_nullishCoalesce(c.rowSpan, () => ( 1))) > 1);
  for (const d of dels) {
    if (spans.some((s) => s.rowAddr <= d.oi && s.rowAddr + s.rowSpan > d.oi)) {
      return skip(`\uD45C ${d.oi + 1}\uD589 \uC0AD\uC81C\uAC00 \uC138\uB85C \uBCD1\uD569\uACFC \uACB9\uCE68 \u2014 \uBBF8\uC9C0\uC6D0`);
    }
  }
  for (const ins of inss) {
    const p = ins.insertAt;
    if (spans.some((s) => s.rowAddr < p && s.rowAddr + s.rowSpan > p)) {
      return skip("\uD589 \uC0BD\uC785 \uC704\uCE58\uAC00 \uC138\uB85C \uBCD1\uD569 \uB0B4\uBD80 \u2014 \uBBF8\uC9C0\uC6D0");
    }
  }
  for (const d of dels) {
    const rr = scanTable.rowRanges[d.oi];
    if (ROW_OBJECT_RE.test(xml.slice(rr.start, rr.end))) {
      return skip(`\uD45C ${d.oi + 1}\uD589\uC5D0 \uAC1C\uCCB4(\uC911\uCCA9\uD45C/\uC774\uBBF8\uC9C0/\uD544\uB4DC) \uD3EC\uD568 \u2014 \uD589 \uC0AD\uC81C \uBBF8\uC9C0\uC6D0`);
    }
  }
  const keptSet = new Set(keeps.map((k) => k.oi));
  const insertPlans = [];
  for (const ins of inss) {
    const p = ins.insertAt;
    const kept = [...keptSet].sort((a, b) => a - b);
    let template = -1;
    for (const k of kept) {
      if (k < p) template = k;
    }
    if (template <= 0 && p >= 1) {
      const following = kept.find((k) => k >= 1);
      if (following !== void 0) template = following;
    }
    if (template < 0) template = kept[0];
    const cells = input.editedCells(ins.ei);
    if (!cells) return skip("\uC0BD\uC785 \uD589\uC5D0 \uC774\uBBF8\uC9C0/\uC911\uCCA9\uD45C \uD3EC\uD568 \u2014 \uD589 \uCD94\uAC00 \uBBF8\uC9C0\uC6D0");
    for (const cell of cells) {
      const unstable = cell.lines.find((l) => sanitizeText(l) !== l);
      if (unstable !== void 0) return skip("\uC0BD\uC785 \uD589\uC5D0 \uACF5\uBC31 \uC815\uADDC\uD654 \uBD88\uC548\uC815 \uD14D\uC2A4\uD2B8 \u2014 \uBBF8\uC9C0\uC6D0");
    }
    const tmplCells = scanTable.rows[template];
    const rr = scanTable.rowRanges[template];
    if (ROW_OBJECT_RE.test(xml.slice(rr.start, rr.end))) {
      return skip("\uC11C\uC2DD \uAE30\uC900 \uD589\uC5D0 \uAC1C\uCCB4(\uC911\uCCA9\uD45C/\uC774\uBBF8\uC9C0/\uD544\uB4DC) \uD3EC\uD568 \u2014 \uD589 \uCD94\uAC00 \uBBF8\uC9C0\uC6D0");
    }
    if (tmplCells.some((c) => c.rowSpan > 1)) return skip("\uC11C\uC2DD \uAE30\uC900 \uD589\uC5D0 \uC138\uB85C \uBCD1\uD569 \u2014 \uD589 \uCD94\uAC00 \uBBF8\uC9C0\uC6D0");
    const tmplWidth = tmplCells.reduce((s, c) => s + c.colSpan, 0);
    if (tmplWidth !== table.cols) return skip("\uC11C\uC2DD \uAE30\uC900 \uD589\uC774 \uACA9\uC790 \uC804\uCCB4\uB97C \uB36E\uC9C0 \uC54A\uC74C \u2014 \uD589 \uCD94\uAC00 \uBBF8\uC9C0\uC6D0");
    if (cells.length !== tmplCells.length) {
      return skip(`\uC0BD\uC785 \uD589 \uC140 \uC218(${cells.length}) \u2260 \uAE30\uC900 \uD589 \uC140 \uC218(${tmplCells.length}) \u2014 \uBBF8\uC9C0\uC6D0`);
    }
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].rowSpan !== 1 || cells[i].colSpan !== tmplCells[i].colSpan) {
        return skip("\uC0BD\uC785 \uD589 \uBCD1\uD569 \uAD6C\uC870\uAC00 \uAE30\uC900 \uD589\uACFC \uB2E4\uB984 \u2014 \uBBF8\uC9C0\uC6D0");
      }
    }
    insertPlans.push({ entry: ins, template, cells });
  }
  const net = inss.length - dels.length;
  TAG_AT_RE.lastIndex = scanTable.start;
  const tblOpen = TAG_AT_RE.exec(xml);
  if (!tblOpen || tblOpen.index !== scanTable.start) return skip("\uD45C \uC5EC\uB294 \uD0DC\uADF8 \uD574\uC11D \uC2E4\uD328");
  const rowCntM = tblOpen[0].match(/\browCnt\s*=\s*"(\d+)"/);
  if (!rowCntM || rowCntM.index === void 0) return skip("\uD45C rowCnt \uC18D\uC131 \uC5C6\uC74C \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  if (parseInt(rowCntM[1], 10) !== numRows) return skip("rowCnt\uC640 \uC2E4\uC81C \uD589 \uC218 \uBD88\uC77C\uCE58 \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  const finalIndex = /* @__PURE__ */ new Map();
  {
    let fi = 0;
    for (const e of seq) {
      if (e.kind !== "del") finalIndex.set(e, fi++);
    }
  }
  const splices = [];
  let applied = 0;
  for (const d of dels) {
    const rr = scanTable.rowRanges[d.oi];
    splices.push({ start: rr.start, end: rr.end, replacement: "" });
    applied++;
  }
  const fragmentsByAnchor = /* @__PURE__ */ new Map();
  let heightDelta = 0;
  for (const plan of insertPlans) {
    const finalRow = finalIndex.get(plan.entry);
    const fragment = buildRowFragment(xml, scanTable, plan.template, plan.cells, finalRow, hasExplicitAddr, ctx);
    if (fragment === null) return skip("\uD589 \uBCF5\uC81C \uC2E4\uD328 (\uC140 \uBB38\uB2E8 \uAD6C\uC870 \uBBF8\uC9C0\uC6D0)");
    const p = plan.entry.insertAt;
    const anchor = p === 0 ? scanTable.rowRanges[0].start : scanTable.rowRanges[p - 1].end;
    let list = fragmentsByAnchor.get(anchor);
    if (!list) fragmentsByAnchor.set(anchor, list = []);
    list.push(fragment);
    heightDelta += rowHeightOf(fragment);
    applied++;
  }
  for (const [anchor, fragments] of fragmentsByAnchor) {
    splices.push({ start: anchor, end: anchor, replacement: fragments.join("") });
  }
  for (const d of dels) {
    const rr = scanTable.rowRanges[d.oi];
    heightDelta -= rowHeightOf(xml.slice(rr.start, rr.end));
  }
  if (hasExplicitAddr) {
    for (const k of keeps) {
      const fi = finalIndex.get(k);
      if (fi === k.oi) continue;
      for (const cell of scanTable.rows[k.oi]) {
        const sp = rowAddrRewrite(xml, cell, fi);
        if (sp) splices.push(sp);
      }
    }
  }
  {
    const valStart = scanTable.start + rowCntM.index + rowCntM[0].indexOf('"') + 1;
    splices.push({ start: valStart, end: valStart + rowCntM[1].length, replacement: String(numRows + net) });
  }
  if (heightDelta !== 0) {
    const sp = tableSzHeightSplice(xml, scanTable, tblOpen[0].length, heightDelta);
    if (sp) splices.push(sp);
  }
  ctx.sectionSplices[scanTable.sectionIndex].push(...splices);
  for (const k of keeps) {
    if (origKeys[k.oi] !== editedKeys[k.ei]) applied += input.patchMatched(k.oi, k.ei);
  }
  return applied;
}
var FRAG_OPEN = "<hp:tbl>";
var FRAG_CLOSE = "</hp:tbl>";
function buildRowFragment(xml, scanTable, template, cells, finalRow, hasExplicitAddr, ctx) {
  const rr = scanTable.rowRanges[template];
  const wrapped = FRAG_OPEN + xml.slice(rr.start, rr.end) + FRAG_CLOSE;
  const scan = scanSectionXml(wrapped, 0);
  const row = _optionalChain([scan, 'access', _304 => _304.tables, 'access', _305 => _305[0], 'optionalAccess', _306 => _306.rows, 'access', _307 => _307[0]]);
  if (!row || row.length !== cells.length) return null;
  const splices = allLinesegRemovalSplices(wrapped);
  for (let i = 0; i < cells.length; i++) {
    const paras = row[i].paragraphs;
    let lines = cells[i].lines;
    if (lines.length > 0 && paras.length === 0) return null;
    if (lines.length > paras.length) {
      lines = [...lines.slice(0, paras.length - 1), lines.slice(paras.length - 1).join(" ")];
      ctx.skipped.push({ reason: "\uC0BD\uC785 \uD589 \uC140\uC758 \uC904 \uC218\uAC00 \uBB38\uB2E8 \uC218 \uCD08\uACFC \u2014 \uB9C8\uC9C0\uB9C9 \uBB38\uB2E8\uC5D0 \uBCD1\uD569 \uC801\uC6A9", after: summarize(cells[i].lines.join(" ")), partial: true });
    }
    for (let p = 0; p < paras.length; p++) {
      const sp = buildParagraphSplices(paras[p], _nullishCoalesce(lines[p], () => ( "")), wrapped);
      if (sp === null) return null;
      splices.push(...sp);
    }
    if (hasExplicitAddr) {
      const sp = rowAddrRewrite(wrapped, row[i], finalRow);
      if (sp) splices.push(sp);
    }
  }
  const patched = applySplices(wrapped, splices);
  return patched.slice(FRAG_OPEN.length, patched.length - FRAG_CLOSE.length);
}
function rowAddrRewrite(xml, cell, newRow) {
  if (!cell.addrTagRange) return null;
  const tag = xml.slice(cell.addrTagRange.start, cell.addrTagRange.end);
  const m = tag.match(/\browAddr\s*=\s*"(\d+)"/);
  if (!m || m.index === void 0) return null;
  if (parseInt(m[1], 10) === newRow) return null;
  const valStart = cell.addrTagRange.start + m.index + m[0].indexOf('"') + 1;
  return { start: valStart, end: valStart + m[1].length, replacement: String(newRow) };
}
function rowHeightOf(fragment) {
  let max = 0;
  for (const m of fragment.matchAll(/<(?:[A-Za-z0-9_]+:)?cellSz\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g)) {
    const h = m[0].match(/\bheight\s*=\s*"(\d+)"/);
    if (h) max = Math.max(max, parseInt(h[1], 10));
  }
  return max;
}
function tableSzHeightSplice(xml, scanTable, tblOpenLen, delta) {
  const from = scanTable.start + tblOpenLen;
  const to = _nullishCoalesce(_optionalChain([scanTable, 'access', _308 => _308.rowRanges, 'access', _309 => _309[0], 'optionalAccess', _310 => _310.start]), () => ( from));
  const slice = xml.slice(from, to);
  const szM = slice.match(/<(?:[A-Za-z0-9_]+:)?sz\b(?:"[^"]*"|'[^']*'|[^>"'])*>/);
  if (!szM || szM.index === void 0) return null;
  const hM = szM[0].match(/\bheight\s*=\s*"(\d+)"/);
  if (!hM || hM.index === void 0) return null;
  const oldH = parseInt(hM[1], 10);
  const newH = Math.max(0, oldH + delta);
  const valStart = from + szM.index + hM.index + hM[0].indexOf('"') + 1;
  return { start: valStart, end: valStart + hM[1].length, replacement: String(newH) };
}

// src/roundtrip/table-patch.ts
function patchGfmTable(table, scanTable, orig, edited, ctx, skip) {
  const replica = replicateGfmTable(table);
  if (!replica) return skip("\uD45C \uB80C\uB354 \uACBD\uB85C \uC2DD\uBCC4 \uC2E4\uD328");
  const origRows = parseGfmTable(orig.lines);
  const editedRows = parseGfmTable(edited.lines);
  if (replica.length !== origRows.length || replica.some((row, r) => row.length !== origRows[r].length || row.some((c, j) => c.text !== origRows[r][j]))) {
    return skip("\uD45C \uC88C\uD45C \uC7AC\uD604 \uBD88\uC77C\uCE58 \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
  }
  if (editedRows.length !== origRows.length) {
    return patchGfmTableRows(table, scanTable, origRows, editedRows, replica, ctx, skip);
  }
  let applied = 0;
  for (let r = 0; r < origRows.length; r++) {
    applied += patchGfmRowPair(table, scanTable, origRows, editedRows, replica, r, r, ctx, skip);
  }
  return applied;
}
function patchGfmRowPair(table, scanTable, origRows, editedRows, replica, r, er, ctx, skip) {
  if (editedRows[er].length !== origRows[r].length) {
    skip(`\uD45C ${r + 1}\uD589 \uC5F4 \uC218 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0`);
    return 0;
  }
  let applied = 0;
  for (let c = 0; c < origRows[r].length; c++) {
    if (origRows[r][c] === editedRows[er][c]) continue;
    const { gridR, gridC } = replica[r][c];
    const origTokens = extractCellTokens(origRows[r][c]);
    const editedTokens = extractCellTokens(editedRows[er][c]);
    if (origTokens !== editedTokens) {
      skip("\uC140 \uB0B4 \uC774\uBBF8\uC9C0 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
      continue;
    }
    const newLines = unescapeGfmCell(stripCellTokens(editedRows[er][c])).split("\n").map((s) => s.trim()).filter(Boolean);
    const origLines = unescapeGfmCell(stripCellTokens(origRows[r][c])).split("\n").map((s) => s.trim()).filter(Boolean);
    const n = applyCellEdit(table, scanTable, gridR, gridC, newLines, ctx, origRows[r][c], editedRows[er][c], origLines.length);
    if (n > 0 && origTokens) {
      ctx.skipped.push({
        reason: "\uC140 \uB0B4 \uC774\uBBF8\uC9C0\xB7\uD14D\uC2A4\uD2B8 \uD63C\uC7AC \u2014 \uD14D\uC2A4\uD2B8\uB9CC \uC801\uC6A9 (\uC774\uBBF8\uC9C0 \uC778\uC811 \uBC30\uCE58\uB294 <br> \uBD84\uB9AC\uB85C \uC7AC\uD604\uB428)",
        before: summarize(origRows[r][c]),
        after: summarize(editedRows[er][c]),
        partial: true
      });
    }
    applied += n;
  }
  return applied;
}
function patchGfmTableRows(table, scanTable, origRows, editedRows, replica, ctx, skip) {
  if (replica.length !== table.rows || replica.some((row, r) => row.some((c) => c.gridR !== r))) {
    return skip("\uD45C \uB80C\uB354 \uD589\uACFC \uACA9\uC790 \uD589 \uBD88\uC77C\uCE58 (\uBE48 \uD589/\uBCD1\uD569) \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  }
  if (table.cells.some((row) => row.some((c) => c && (c.colSpan > 1 || c.rowSpan > 1)))) {
    return skip("\uBCD1\uD569 \uC140 \uD45C \u2014 GFM \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  }
  if (!gfmRenderStable(editedRows, table.cols)) {
    return skip("\uD589 \uBCC0\uACBD \uACB0\uACFC\uAC00 \uD45C \uB80C\uB354\uC5D0\uC11C \uBCC0\uD615\uB428 (\uBE48 \uD589/\uCCAB \uC5F4 \uC804\uD30C/\uC5F4 \uC218 \uBD88\uC77C\uCE58) \u2014 \uBBF8\uC9C0\uC6D0");
  }
  const key = (row) => row.join("\0");
  return patchTableRows({
    table,
    scanTable,
    ctx,
    skip,
    origKeys: origRows.map(key),
    editedKeys: editedRows.map(key),
    editedCells: (ei) => {
      const cells = [];
      for (const cellMd of editedRows[ei]) {
        if (extractCellTokens(cellMd)) return null;
        const lines = unescapeGfmCell(cellMd).split("\n").map((s) => s.trim()).filter(Boolean);
        cells.push({ lines, colSpan: 1, rowSpan: 1 });
      }
      return cells;
    },
    patchMatched: (oi, ei) => patchGfmRowPair(table, scanTable, origRows, editedRows, replica, oi, ei, ctx, skip)
  });
}
function gfmRenderStable(editedRows, cols) {
  const sim = {
    rows: editedRows.length,
    cols,
    hasHeader: editedRows.length > 1,
    cells: editedRows.map((row) => {
      const padded = row.length < cols ? [...row, ...Array(cols - row.length).fill("")] : row;
      return padded.map((md2) => ({ text: unescapeGfmCell(md2), colSpan: 1, rowSpan: 1 }));
    })
  };
  const replica = replicateGfmTable(sim);
  if (!replica || replica.length !== editedRows.length) return false;
  return replica.every((row, r) => row.length === editedRows[r].length && row.every((c, j) => c.text === editedRows[r][j]));
}
function patchHtmlTable(table, scanTable, orig, edited, ctx, skip) {
  return patchHtmlTableRaw(table, scanTable, orig.raw, edited.raw, ctx, skip, 0);
}
function patchHtmlTableRaw(table, scanTable, origRaw, editedRaw, ctx, skip, depth) {
  if (depth > 8) return skip("\uC911\uCCA9\uD45C \uAE4A\uC774 \uCD08\uACFC");
  if (replicateTableToHtml(table) !== origRaw) return skip("\uD45C \uC88C\uD45C \uC7AC\uD604 \uBD88\uC77C\uCE58 \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
  const replica = replicateHtmlTable(table);
  const origRows = parseHtmlTable(origRaw);
  if (!origRows || origRows.length !== replica.length || origRows.some((r, i) => r.cells.length !== replica[i].cells.length || r.cells.some((c, j) => c.inner !== replica[i].cells[j].inner))) {
    return skip("\uC140 \uACBD\uACC4 \uBAA8\uD638 (\uB9AC\uD130\uB7F4 \uD0DC\uADF8 \uC758\uC2EC) \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
  }
  const editedRows = parseHtmlTable(editedRaw);
  if (!editedRows) return skip("\uD3B8\uC9D1\uB41C HTML \uD45C \uD30C\uC2F1 \uC2E4\uD328");
  if (editedRows.length !== replica.length) {
    return patchHtmlTableRows(table, scanTable, replica, editedRows, ctx, skip, depth);
  }
  let applied = 0;
  for (let r = 0; r < replica.length; r++) {
    applied += patchHtmlRowPair(table, scanTable, replica, editedRows, r, r, ctx, skip, depth);
  }
  return applied;
}
function patchHtmlRowPair(table, scanTable, replica, editedRows, r, er, ctx, skip, depth) {
  if (editedRows[er].cells.length !== replica[r].cells.length) {
    skip(`\uD45C ${r + 1}\uD589 \uC140 \uC218 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0`);
    return 0;
  }
  let applied = 0;
  for (let c = 0; c < replica[r].cells.length; c++) {
    const oc = replica[r].cells[c];
    const ec = editedRows[er].cells[c];
    if (oc.colSpan !== ec.colSpan || oc.rowSpan !== ec.rowSpan) {
      skip(`\uC140 \uBCD1\uD569(colspan/rowspan) \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0`);
      continue;
    }
    if (oc.inner === ec.inner) continue;
    const origContent = htmlCellInnerToLines(oc.inner);
    const editedContent = htmlCellInnerToLines(ec.inner);
    if (origContent.hadNonText || editedContent.hadNonText) {
      if (extractImgTags(oc.inner) !== extractImgTags(ec.inner)) {
        skip("\uC140 \uB0B4 \uC774\uBBF8\uC9C0 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
        continue;
      }
      const origTables = extractTopLevelTables(oc.inner);
      const editedTables = extractTopLevelTables(ec.inner);
      if (origTables.length !== editedTables.length) {
        skip("\uC140 \uB0B4 \uC911\uCCA9\uD45C \uCD94\uAC00/\uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0");
        continue;
      }
      if (origTables.join("\n") !== editedTables.join("\n")) {
        applied += patchNestedTables(table, scanTable, oc, origTables, editedTables, ctx, skip, depth);
      }
    }
    if (origContent.lines.join("\n") !== editedContent.lines.join("\n")) {
      const newLines = editedContent.lines.map((l) => unescapeGfm(l));
      applied += applyCellEdit(table, scanTable, oc.gridR, oc.gridC, newLines, ctx, oc.inner, ec.inner, origContent.lines.length);
    }
  }
  return applied;
}
function patchHtmlTableRows(table, scanTable, replica, editedRows, ctx, skip, depth) {
  if (replica.length !== table.rows || replica.some((row, r) => row.cells.some((c) => c.gridR !== r))) {
    return skip("\uD45C \uB80C\uB354 \uD589\uACFC \uACA9\uC790 \uD589 \uBD88\uC77C\uCE58 (\uBCD1\uD569 \uC18C\uC2E4 \uD589) \u2014 \uD589 \uCD94\uAC00/\uC0AD\uC81C \uBBF8\uC9C0\uC6D0");
  }
  const key = (row) => row.cells.map((c) => `${c.colSpan}x${c.rowSpan}:${c.inner}`).join("\0");
  return patchTableRows({
    table,
    scanTable,
    ctx,
    skip,
    origKeys: replica.map(key),
    editedKeys: editedRows.map(key),
    editedCells: (ei) => {
      const cells = [];
      for (const cell of editedRows[ei].cells) {
        const content = htmlCellInnerToLines(cell.inner);
        if (content.hadNonText) return null;
        cells.push({ lines: content.lines.map((l) => unescapeGfm(l)), colSpan: cell.colSpan, rowSpan: cell.rowSpan });
      }
      return cells;
    },
    patchMatched: (oi, ei) => patchHtmlRowPair(table, scanTable, replica, editedRows, oi, ei, ctx, skip, depth)
  });
}
function patchNestedTables(table, scanTable, oc, origTables, editedTables, ctx, skip, depth) {
  const irCell = _optionalChain([table, 'access', _311 => _311.cells, 'access', _312 => _312[oc.gridR], 'optionalAccess', _313 => _313[oc.gridC]]);
  const scanCell = scanTable.cellByAnchor.get(`${oc.gridR},${oc.gridC}`);
  const nestedIRs = (_nullishCoalesce(_optionalChain([irCell, 'optionalAccess', _314 => _314.blocks]), () => ( []))).filter((b) => b.type === "table" && b.table).map((b) => b.table);
  if (!scanCell || nestedIRs.length !== origTables.length || scanCell.tables.length !== origTables.length) {
    return skip("\uC911\uCCA9\uD45C \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328");
  }
  let applied = 0;
  for (let k = 0; k < origTables.length; k++) {
    if (origTables[k] === editedTables[k]) continue;
    applied += patchHtmlTableRaw(nestedIRs[k], scanCell.tables[k], origTables[k], editedTables[k], ctx, skip, depth + 1);
  }
  return applied;
}
function extractImgTags(inner) {
  return (inner.match(/<img\s(?:"[^"]*"|'[^']*'|[^>"'])*?>/gi) || []).join(" ");
}
var CELL_TOKEN_RE = /!\[image\]\([^)]*\)|\[이미지: [^\]]*\]/g;
function extractCellTokens(text) {
  return (text.match(CELL_TOKEN_RE) || []).join(" ");
}
function stripCellTokens(text) {
  return text.replace(CELL_TOKEN_RE, "");
}
function patchTextChunkTable(table, scanTable, orig, edited, ctx, skip) {
  if (table.rows === 1 && table.cols === 1) {
    const content = sanitizeText(table.cells[0][0].text);
    const replicaLines = content.split(/\n/).map((line) => {
      const t = line.trim();
      if (!t) return "";
      if (/^\d+\.\s/.test(t)) return `**${escapeGfm(t)}**`;
      return escapeGfm(t);
    }).filter(Boolean);
    if (replicaLines.join("\n") !== orig.lines.join("\n")) return skip("\uD45C \uC88C\uD45C \uC7AC\uD604 \uBD88\uC77C\uCE58 \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
    if (extractCellTokens(orig.raw) !== extractCellTokens(edited.raw)) return skip("\uC140 \uB0B4 \uC774\uBBF8\uC9C0 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
    const newLines = edited.lines.map((l) => {
      const m = l.match(/^\*\*([\s\S]*)\*\*$/);
      const unwrap = m && /^\d+\.\s/.test(unescapeGfm(m[1]));
      return stripCellTokens(unescapeGfm(unwrap ? m[1] : l)).trim();
    }).filter(Boolean);
    return applyCellEdit(table, scanTable, 0, 0, newLines, ctx, orig.raw, edited.raw, orig.lines.length);
  }
  if (table.cols === 1 && table.rows >= 2) {
    const replica = [];
    for (let r = 0; r < table.rows; r++) {
      const line = escapeGfm(sanitizeText(table.cells[r][0].text)).replace(/\n/g, " ");
      if (line) replica.push({ line, gridR: r });
    }
    if (replica.map((x) => x.line).join("\n") !== orig.lines.join("\n")) return skip("\uD45C \uC88C\uD45C \uC7AC\uD604 \uBD88\uC77C\uCE58 \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
    if (edited.lines.length !== replica.length) return skip("\uD45C \uD589 \uCD94\uAC00/\uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0 (\uD45C \uAD6C\uC870 \uBCC0\uACBD)");
    let applied = 0;
    for (let i = 0; i < replica.length; i++) {
      if (replica[i].line === edited.lines[i]) continue;
      if (extractCellTokens(replica[i].line) !== extractCellTokens(edited.lines[i])) {
        skip("\uC140 \uB0B4 \uC774\uBBF8\uC9C0 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
        continue;
      }
      const newLines = [stripCellTokens(unescapeGfm(edited.lines[i])).trim()].filter(Boolean);
      applied += applyCellEdit(table, scanTable, replica[i].gridR, 0, newLines, ctx, replica[i].line, edited.lines[i], 1);
    }
    return applied;
  }
  return skip("\uD45C \uB80C\uB354 \uACBD\uB85C \uC2DD\uBCC4 \uC2E4\uD328");
}
function applyCellEdit(table, scanTable, gridR, gridC, newLines, ctx, before, after, origLineCount) {
  const skip = (reason) => {
    ctx.skipped.push({ reason, before: summarize(before), after: summarize(after) });
    return 0;
  };
  const cell = scanTable.cellByAnchor.get(`${gridR},${gridC}`);
  if (!cell) return skip("\uC140 \uC88C\uD45C \uB9E4\uD551 \uC2E4\uD328 (\uBCD1\uD569 \uC601\uC5ED\uC758 \uBE48 \uCE78\uC774\uAC70\uB098 \uC88C\uD45C \uBD88\uC77C\uCE58)");
  const irCell = _optionalChain([table, 'access', _315 => _315.cells, 'access', _316 => _316[gridR], 'optionalAccess', _317 => _317[gridC]]);
  const scanJoined = cell.paragraphs.map((p) => p.text).filter((t) => normForMatch(t)).join("\n");
  if (irCell && normForMatch(scanJoined) !== normForMatch(stripCellTokens(irCell.text))) {
    if (normForMatch(irCell.text) !== "" || normForMatch(scanJoined) !== "") {
      const flatBlocks = (_nullishCoalesce(irCell.blocks, () => ( []))).filter((b) => b.type === "paragraph" || b.type === "heading");
      const flatJoined = flatBlocks.map((b) => _nullishCoalesce(b.text, () => ( ""))).join("\n");
      if (normForMatch(scanJoined) !== normForMatch(flatJoined)) {
        return skip("\uC140 \uCF58\uD150\uCE20 \uAD6C\uC870 \uBCF5\uC7A1 (\uC911\uCCA9\uD45C/\uAE00\uC0C1\uC790) \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
      }
    }
  }
  const nonEmpty = cell.paragraphs.filter((p) => normForMatch(p.text) !== "");
  if (origLineCount !== void 0 && nonEmpty.length > 0 && origLineCount !== nonEmpty.length) {
    return skip("\uC140 \uC904 \uACBD\uACC4 \uB9E4\uD551 \uBAA8\uD638 (\uB9AC\uD130\uB7F4 <br>/\uBB38\uB2E8 \uB0B4 \uC904\uBC14\uAFC8) \u2014 \uBBF8\uC9C0\uC6D0");
  }
  const splices = [];
  let sectionIndex = -1;
  const unstable = newLines.find((l) => sanitizeText(l) !== l);
  if (unstable !== void 0) return skip("\uACF5\uBC31 \uC815\uADDC\uD654 \uBD88\uC548\uC815 \uD14D\uC2A4\uD2B8 \u2014 \uD328\uCE58 \uC2DC \uC6D0\uBB38 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0");
  if (nonEmpty.length === 0) {
    if (newLines.length === 0) return 0;
    const target = cell.paragraphs[0];
    if (!target) return skip("\uBE48 \uC140\uC5D0 \uBB38\uB2E8\uC774 \uC5C6\uC5B4 \uD14D\uC2A4\uD2B8 \uC0BD\uC785 \uBD88\uAC00");
    const sp = buildParagraphSplices(target, newLines.join(" "), _optionalChain([ctx, 'access', _318 => _318.scans, 'access', _319 => _319[target.sectionIndex], 'optionalAccess', _320 => _320.xml]));
    if (sp === null) return skip("\uC140 \uBB38\uB2E8\uC5D0 \uD14D\uC2A4\uD2B8 \uB178\uB4DC\uB97C \uB9CC\uB4E4 \uC218 \uC5C6\uC74C");
    splices.push(...sp);
    sectionIndex = target.sectionIndex;
    if (newLines.length > 1) {
      ctx.skipped.push({ reason: "\uC140 \uB0B4 \uC904 \uCD94\uAC00\uB294 \uBB38\uB2E8 \uC0DD\uC131 \uBBF8\uC9C0\uC6D0 \u2014 \uD55C \uBB38\uB2E8\uC73C\uB85C \uBCD1\uD569 \uC801\uC6A9", after: summarize(after), partial: true });
    }
  } else {
    const assigned = [];
    for (let i = 0; i < nonEmpty.length; i++) {
      if (i < newLines.length) {
        assigned.push(i === nonEmpty.length - 1 && newLines.length > nonEmpty.length ? newLines.slice(i).join(" ") : newLines[i]);
      } else {
        assigned.push("");
      }
    }
    if (newLines.length > nonEmpty.length) {
      ctx.skipped.push({ reason: "\uC140 \uB0B4 \uC904 \uCD94\uAC00\uB294 \uBB38\uB2E8 \uC0DD\uC131 \uBBF8\uC9C0\uC6D0 \u2014 \uB9C8\uC9C0\uB9C9 \uBB38\uB2E8\uC5D0 \uBCD1\uD569 \uC801\uC6A9", after: summarize(after), partial: true });
    } else if (newLines.length < nonEmpty.length && nonEmpty.length > 1) {
      ctx.skipped.push({ reason: "\uC140 \uB0B4 \uC904 \uC0AD\uC81C\uB294 \uBB38\uB2E8 \uC81C\uAC70 \uBBF8\uC9C0\uC6D0 \u2014 \uBE48 \uBB38\uB2E8 \uC794\uC874(\uBDF0\uC5B4\uC5D0 \uBE48 \uC904 \uD45C\uC2DC \uAC00\uB2A5)", before: summarize(before), after: summarize(after), partial: true });
    }
    for (let i = 0; i < nonEmpty.length; i++) {
      if (assigned[i] === nonEmpty[i].text || normForMatch(assigned[i]) === normForMatch(nonEmpty[i].text)) continue;
      const sp = buildParagraphSplices(nonEmpty[i], assigned[i], _optionalChain([ctx, 'access', _321 => _321.scans, 'access', _322 => _322[nonEmpty[i].sectionIndex], 'optionalAccess', _323 => _323.xml]));
      if (sp === null) return skip("\uC140 \uBB38\uB2E8\uC5D0 \uD14D\uC2A4\uD2B8 \uB178\uB4DC\uB97C \uB9CC\uB4E4 \uC218 \uC5C6\uC74C");
      splices.push(...sp);
      sectionIndex = nonEmpty[i].sectionIndex;
    }
  }
  if (splices.length === 0) return 0;
  ctx.sectionSplices[sectionIndex].push(...splices);
  return 1;
}

// src/roundtrip/table-insert.ts
var TABLE_USABLE_WIDTH = 44e3;
var TABLE_ROW_HEIGHT = 1500;
function collectMaxNumericId(xmls) {
  let max = -1;
  for (const xml of xmls) {
    for (const m of xml.matchAll(/\bid(?:Ref)?="(\d{1,10})"/g)) {
      const v = parseInt(m[1], 10);
      if (!isNaN(v) && v > max) max = v;
    }
  }
  return max;
}
function cellBorderFillXml(id) {
  return `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="0" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/><hh:diagonal type="NONE" width="0.1 mm" color="#000000"/><hh:fillInfo/></hh:borderFill>`;
}
function injectCellBorderFill(headerXml, newId) {
  const openM = headerXml.match(/<hh:borderFills\b([^>]*)>/);
  if (!openM || openM.index === void 0) return null;
  const closeIdx = headerXml.indexOf("</hh:borderFills>");
  if (closeIdx < 0) return null;
  const splices = [];
  const itemCntM = openM[1].match(/\bitemCnt="(\d+)"/);
  if (itemCntM && itemCntM.index !== void 0) {
    const cnt = parseInt(itemCntM[1], 10);
    const attrStart = openM.index + "<hh:borderFills".length + itemCntM.index;
    const valStart = attrStart + itemCntM[0].indexOf('"') + 1;
    const valEnd = valStart + String(cnt).length;
    splices.push({ start: valStart, end: valEnd, replacement: String(cnt + 1) });
  }
  splices.push({ start: closeIdx, end: closeIdx, replacement: cellBorderFillXml(newId) });
  return { borderFillId: newId, headerSplices: splices };
}
function cellPlainText(raw) {
  let t = unescapeGfmCell(raw);
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  return t.replace(/\s*\n\s*/g, " ").trim();
}
function buildTableParagraphXml(rows, opts) {
  const { borderFillId, outerParaPrId, cellParaPrId, cellCharPrId, tableId } = opts;
  const rowCnt = rows.length;
  const colCnt = Math.max(...rows.map((r) => r.length), 1);
  const cellW = Math.floor(TABLE_USABLE_WIDTH / colCnt);
  const cellH = TABLE_ROW_HEIGHT;
  const tblW = cellW * colCnt;
  const tblH = cellH * rowCnt;
  const trElements = rows.map((row, rowIdx) => {
    const cells = row.length < colCnt ? [...row, ...Array(colCnt - row.length).fill("")] : row;
    const isHeaderRow = rowIdx === 0;
    const tdElements = cells.map((cell, colIdx) => {
      const text = escapeXmlText(cellPlainText(cell));
      const cellP = `<hp:p paraPrIDRef="${cellParaPrId}" styleIDRef="0"><hp:run charPrIDRef="${cellCharPrId}"><hp:t>${text}</hp:t></hp:run></hp:p>`;
      return `<hp:tc name="" header="${isHeaderRow ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${borderFillId}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${cellP}</hp:subList><hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cellW}" height="${cellH}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`;
    }).join("");
    return `<hp:tr>${tdElements}</hp:tr>`;
  }).join("");
  const tblInner = `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${tblH}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>` + trElements;
  const tbl = `<hp:tbl id="${tableId}" zOrder="0" numberingType="TABLE" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="${borderFillId}" noShading="0">${tblInner}</hp:tbl>`;
  return `<hp:p paraPrIDRef="${outerParaPrId}" styleIDRef="0"><hp:run charPrIDRef="${cellCharPrId}">${tbl}</hp:run></hp:p>`;
}

// src/roundtrip/hwpx-entries.ts
async function resolveSectionEntryNames(zip) {
  for (const mp of ["Contents/content.hpf", "content.hpf"]) {
    const f = zip.file(mp);
    if (!f) continue;
    const xml = await f.async("text");
    const paths = sectionPathsFromManifest(xml).filter((p) => zip.file(p) !== null);
    if (paths.length > 0) return paths;
  }
  return Object.keys(zip.files).filter((n) => /[Ss]ection\d+\.xml$/.test(n)).sort(_chunkR2H34FY5cjs.compareSectionPaths);
}
function sectionPathsFromManifest(xml) {
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
    return m ? _nullishCoalesce(m[1], () => ( m[2])) : "";
  };
  const idToHref = /* @__PURE__ */ new Map();
  for (const m of xml.matchAll(/<opf:item(\s(?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g)) {
    const id = attr(m[1], "id");
    const href = _chunkR2H34FY5cjs.normalizeSectionHref.call(void 0, attr(m[1], "href"));
    if (id && href) idToHref.set(id, href);
  }
  const ordered = [];
  for (const m of xml.matchAll(/<opf:itemref(\s(?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g)) {
    const href = idToHref.get(attr(m[1], "idref"));
    if (href) ordered.push(href);
  }
  if (ordered.length > 0) return ordered;
  return Array.from(idToHref.values()).sort(_chunkR2H34FY5cjs.compareSectionPaths);
}

// src/roundtrip/patcher.ts
async function patchHwpx(original, editedMarkdown, options) {
  const skipped = [];
  let applied = 0;
  let origBlocks;
  try {
    const parsed = await parseHwpxDocument(u8ToArrayBuffer(original));
    origBlocks = parsed.blocks;
  } catch (err) {
    return { success: false, applied: 0, skipped, error: `\uC6D0\uBCF8 HWPX \uD30C\uC2F1 \uC2E4\uD328: ${err instanceof Error ? err.message : String(err)}` };
  }
  let zip;
  try {
    zip = await _jszip2.default.loadAsync(original);
  } catch (e29) {
    return { success: false, applied: 0, skipped, error: "ZIP \uB85C\uB4DC \uC2E4\uD328" };
  }
  const sectionPaths = await resolveSectionEntryNames(zip);
  if (sectionPaths.length === 0) {
    return { success: false, applied: 0, skipped, error: "HWPX \uC139\uC158 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4" };
  }
  const scans = [];
  for (let i = 0; i < sectionPaths.length; i++) {
    const xml = await zip.file(sectionPaths[i]).async("text");
    scans.push(scanSectionXml(xml, i));
  }
  let tableInsert;
  const headerEntryName = await resolveHeaderEntryName(zip);
  if (headerEntryName) {
    const headerXml = await zip.file(headerEntryName).async("text");
    const maxId = collectMaxNumericId([...scans.map((s) => s.xml), headerXml]);
    tableInsert = { headerEntryName, headerXml, headerSplices: [], borderFillId: null, nextId: maxId + 1 };
  }
  const origUnits = buildOrigUnits(origBlocks);
  const editedUnits = splitMarkdownUnits(editedMarkdown);
  const pairs = alignUnits(origUnits.map((u) => u.raw), editedUnits.map((u) => u.raw));
  const paraMap = resolveParagraphMappings(origBlocks, scans);
  const scanTables = scans.flatMap((s) => s.tables.filter((t) => t.rows.length > 0));
  const obTableOrdinals = buildTableOrdinals(origBlocks);
  const sectionSplices = scans.map(() => []);
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) {
      const orig = origUnits[oi];
      const edited = editedUnits[ei];
      if (orig.raw === edited.raw) continue;
      applied += handleModifiedUnit(orig, edited, {
        origBlocks,
        paraMap,
        scans,
        scanTables,
        obTableOrdinals,
        sectionSplices,
        skipped,
        tableInsert
      });
    } else if (oi !== null) {
      skipped.push({ reason: "\uBE14\uB85D \uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0 (v1) \u2014 \uC6D0\uBCF8 \uC720\uC9C0", before: summarize(origUnits[oi].raw) });
    } else if (ei !== null) {
      skipped.push({ reason: "\uBE14\uB85D \uCD94\uAC00\uB294 \uBBF8\uC9C0\uC6D0 (v1)", after: summarize(editedUnits[ei].raw) });
    }
  }
  const replacements = /* @__PURE__ */ new Map();
  const encoder = new TextEncoder();
  try {
    for (let i = 0; i < scans.length; i++) {
      if (sectionSplices[i].length === 0) continue;
      const claimed = sectionSplices[i].filter((s) => s.end > s.start);
      sectionSplices[i].push(...allLinesegRemovalSplices(scans[i].xml).filter((ls) => !claimed.some((c) => ls.start >= c.start && ls.end <= c.end)));
      const newXml = applySplices(scans[i].xml, sectionSplices[i]);
      replacements.set(sectionPaths[i], encoder.encode(newXml));
    }
    if (tableInsert && tableInsert.headerSplices.length > 0) {
      const newHeader = applySplices(tableInsert.headerXml, tableInsert.headerSplices);
      replacements.set(tableInsert.headerEntryName, encoder.encode(newHeader));
    }
  } catch (err) {
    return { success: false, applied: 0, skipped, error: `\uC18C\uC2A4\uB9F5 splice \uC2E4\uD328: ${err instanceof Error ? err.message : String(err)}` };
  }
  let data;
  if (replacements.size === 0) {
    data = new Uint8Array(original);
  } else {
    try {
      data = patchZipEntries(original, replacements);
    } catch (err) {
      return { success: false, applied: 0, skipped, error: `ZIP \uC7AC\uC870\uB9BD \uC2E4\uD328: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  let verification;
  if (_optionalChain([options, 'optionalAccess', _324 => _324.verify]) !== false) {
    try {
      const reparsed = await parseHwpxDocument(u8ToArrayBuffer(data));
      verification = diffUnitLists(splitMarkdownUnits(reparsed.markdown), editedUnits);
    } catch (err) {
      return { success: false, applied, skipped, error: `\uD328\uCE58\uBCF8 \uC7AC\uD30C\uC2F1 \uC2E4\uD328 \u2014 \uD328\uCE58 \uC911\uB2E8: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { success: true, data, applied, skipped, verification };
}
function buildOrigUnits(blocks) {
  const units = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    let consume = 1;
    let chunk2;
    if (block.type === "paragraph" && block.text && /^\[별표\s*\d+/.test(sanitizeText(block.text))) {
      const next = blocks[i + 1];
      if (_optionalChain([next, 'optionalAccess', _325 => _325.type]) === "paragraph" && next.text && /관련\)?$/.test(next.text)) consume = 2;
      chunk2 = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, blocks.slice(i, i + consume));
    } else {
      chunk2 = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, [block]);
    }
    if (chunk2) {
      const subUnits = splitMarkdownUnits(chunk2);
      const isFragment = consume === 2 || (block.type === "paragraph" || block.type === "heading") && subUnits.length > 1;
      for (let s = 0; s < subUnits.length; s++) {
        const u = { ...subUnits[s], blockIdx: i, fragment: isFragment || void 0 };
        if (block.type === "table" && _optionalChain([block, 'access', _326 => _326.table, 'optionalAccess', _327 => _327.caption]) && s === 0 && subUnits.length > 1 && u.kind === "text" && u.raw.startsWith("**")) {
          u.role = "caption";
        }
        units.push(u);
      }
    }
    i += consume - 1;
  }
  return units;
}
function buildTableOrdinals(blocks) {
  const map = /* @__PURE__ */ new Map();
  let ordinal = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === "table" && blocks[i].table) map.set(i, ordinal++);
  }
  return map;
}
function resolveParagraphMappings(blocks, scans) {
  const buckets = /* @__PURE__ */ new Map();
  for (const scan of scans) {
    for (const para of scan.bodyParagraphs) {
      const key = normForMatch(para.text);
      if (!key) continue;
      let list = buckets.get(key);
      if (!list) buckets.set(key, list = []);
      list.push(para);
    }
  }
  const headerNorms = new Set(scans.flatMap((s) => s.headerTexts.map(normForMatch)).filter(Boolean));
  const footerNorms = new Set(scans.flatMap((s) => s.footerTexts.map(normForMatch)).filter(Boolean));
  const pageText = /* @__PURE__ */ new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "paragraph" && b.type !== "heading" || !b.text || !headerNorms.has(normForMatch(b.text))) break;
    pageText.add(i);
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type !== "paragraph" && b.type !== "heading" || !b.text || !footerNorms.has(normForMatch(b.text))) break;
    pageText.add(i);
  }
  const counters = /* @__PURE__ */ new Map();
  const result = /* @__PURE__ */ new Map();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "paragraph" && b.type !== "heading" || !b.text) continue;
    if (pageText.has(i)) {
      result.set(i, {});
      continue;
    }
    let key = normForMatch(b.text);
    let prefixStripped = false;
    if (!buckets.has(key)) {
      const sp = b.text.indexOf(" ");
      if (sp > 0) {
        const alt = normForMatch(b.text.slice(sp + 1));
        if (alt && buckets.has(alt)) {
          key = alt;
          prefixStripped = true;
        }
      }
    }
    const list = buckets.get(key);
    if (!list) {
      result.set(i, {});
      continue;
    }
    const occ = _nullishCoalesce(counters.get(key), () => ( 0));
    counters.set(key, occ + 1);
    result.set(i, occ < list.length ? { para: list[occ], prefixStripped } : {});
  }
  return result;
}
function handleModifiedUnit(orig, edited, ctx) {
  const block = ctx.origBlocks[orig.blockIdx];
  const skip = (reason) => {
    ctx.skipped.push({ reason, before: summarize(orig.raw), after: summarize(edited.raw) });
    return 0;
  };
  if (orig.role === "caption") return skip("\uD45C \uCEA1\uC158 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 (v1)");
  if (orig.kind === "separator" || orig.kind === "image") return skip("\uC774\uBBF8\uC9C0/\uAD6C\uBD84\uC120 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
  if (!block) return skip("\uBE14\uB85D \uB9E4\uD551 \uC2E4\uD328");
  if (orig.fragment) return skip("\uBB38\uB2E8 \uBD84\uC808(\uAC15\uC81C \uC904\uBC14\uAFC8/\uBCD1\uD569 \uC720\uB2DB) \u2014 \uBD80\uBD84 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 (v1)");
  if (block.type === "table" && block.table) {
    if (orig.kind !== edited.kind) return skip("\uD45C \u2194 \uBE44\uD45C \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0 (\uD45C \uAD6C\uC870 \uBCC0\uACBD)");
    if (ctx.obTableOrdinals.size !== ctx.scanTables.length) return skip("\uD45C \uAC1C\uC218 \uBD88\uC77C\uCE58 \u2014 \uC18C\uC2A4\uB9F5 \uC2E0\uB8B0 \uBD88\uAC00");
    const ordinal = ctx.obTableOrdinals.get(orig.blockIdx);
    const scanTable = ordinal !== void 0 ? ctx.scanTables[ordinal] : void 0;
    if (!scanTable) return skip("\uD45C \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328");
    if (orig.kind === "gfm-table") return patchGfmTable(block.table, scanTable, orig, edited, ctx, skip);
    if (orig.kind === "html-table") return patchHtmlTable(block.table, scanTable, orig, edited, ctx, skip);
    return patchTextChunkTable(block.table, scanTable, orig, edited, ctx, skip);
  }
  if ((block.type === "paragraph" || block.type === "heading") && orig.kind === "text") {
    if (edited.kind === "text") return patchParagraphUnit(block, orig, edited, ctx, skip);
    if (edited.kind === "gfm-table") return convertParagraphToTable(block, orig, edited, ctx, skip);
    if (edited.kind === "html-table") return skip("\uBB38\uB2E8\u2192\uBCD1\uD569\uD45C(HTML) \uBCC0\uD658\uC740 \uBBF8\uC9C0\uC6D0 \u2014 GFM \uD45C(| \uD5E4\uB354 | \u2026 |)\uB85C \uC791\uC131\uD558\uC138\uC694");
  }
  return skip("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uBE14\uB85D \uC720\uD615 \uBCC0\uACBD");
}
function extractParaPrIdRef(xml, start) {
  const gt = xml.indexOf(">", start);
  if (gt < 0) return null;
  const m = xml.slice(start, gt + 1).match(/paraPrIDRef="(\d+)"/);
  return m ? parseInt(m[1], 10) : null;
}
function convertParagraphToTable(block, orig, edited, ctx, skip) {
  const ti = ctx.tableInsert;
  if (!ti) return skip("\uBB38\uB2E8\u2192\uD45C \uBCC0\uD658 \uBD88\uAC00 \u2014 header \uC5D4\uD2B8\uB9AC(borderFills) \uD574\uC11D \uC2E4\uD328");
  const mapping = ctx.paraMap.get(orig.blockIdx);
  if (!_optionalChain([mapping, 'optionalAccess', _328 => _328.para])) return skip("\uBB38\uB2E8 \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328 (\uBA38\uB9AC\uB9D0/\uAE00\uC0C1\uC790/\uCEA1\uC158 \uC601\uC5ED) \u2014 \uD45C \uBCC0\uD658 \uBD88\uAC00");
  const para = mapping.para;
  if (para.kind !== "body") return skip("\uBCF8\uBB38 \uC678 \uC601\uC5ED(\uD45C \uC140/\uAE00\uC0C1\uC790) \uBB38\uB2E8\uC758 \uD45C \uBCC0\uD658\uC740 \uBBF8\uC9C0\uC6D0");
  const scan = ctx.scans[para.sectionIndex];
  if (!scan) return skip("\uC139\uC158 \uB9E4\uD551 \uC2E4\uD328");
  const pEnd = findElementEnd(scan.xml, para.start);
  if (pEnd < 0) return skip("\uBB38\uB2E8 \uB05D \uC704\uCE58 \uD0D0\uC0C9 \uC2E4\uD328");
  const rows = parseGfmTable(edited.lines);
  if (rows.length === 0 || rows.every((r) => r.length === 0)) return skip("\uD45C \uB0B4\uC6A9\uC774 \uBE44\uC5B4 \uC788\uC74C");
  if (ti.borderFillId === null) {
    const inj = injectCellBorderFill(ti.headerXml, ti.nextId++);
    if (!inj) return skip("header <hh:borderFills> \uAD6C\uC870\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC5B4 \uD45C \uD14C\uB450\uB9AC \uC0DD\uC131 \uBD88\uAC00");
    ti.borderFillId = inj.borderFillId;
    ti.headerSplices.push(...inj.headerSplices);
  }
  const outerParaPrId = _nullishCoalesce(extractParaPrIdRef(scan.xml, para.start), () => ( 0));
  const tableXml = buildTableParagraphXml(rows, {
    borderFillId: ti.borderFillId,
    outerParaPrId,
    cellParaPrId: 0,
    cellCharPrId: 0,
    tableId: ti.nextId++
  });
  ctx.sectionSplices[para.sectionIndex].push({ start: para.start, end: pEnd, replacement: tableXml });
  return 1;
}
function patchParagraphUnit(block, orig, edited, ctx, skip) {
  const mapping = ctx.paraMap.get(orig.blockIdx);
  if (!_optionalChain([mapping, 'optionalAccess', _329 => _329.para])) return skip("\uBB38\uB2E8 \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328 (\uBA38\uB9AC\uB9D0/\uAE00\uC0C1\uC790/\uCEA1\uC158 \uC601\uC5ED\uC774\uAC70\uB098 \uD14D\uC2A4\uD2B8 \uBD88\uC77C\uCE58)");
  if (block.text && block.text.includes("\n")) {
    return skip("\uBB38\uB2E8 \uB0B4 \uAC15\uC81C \uC904\uBC14\uAFC8 \uD3EC\uD568 \u2014 \uC218\uC815 \uC2DC \uC904\uBC14\uAFC8 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0 (v1)");
  }
  const origPlain = textUnitToPlain(orig.raw, block);
  let newPlain = textUnitToPlain(edited.raw, block);
  if (block.footnoteText) {
    const noteMatch = newPlain.match(/\s*\(주: ([\s\S]*)\)$/);
    if (noteMatch) {
      newPlain = newPlain.slice(0, noteMatch.index).trimEnd();
      if (normForMatch(noteMatch[1]) !== normForMatch(block.footnoteText)) {
        ctx.skipped.push({ reason: "\uAC01\uC8FC \uD14D\uC2A4\uD2B8 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 \u2014 \uBCF8\uBB38\uB9CC \uC801\uC6A9", before: block.footnoteText, after: noteMatch[1] });
      }
    } else {
      ctx.skipped.push({ reason: "\uAC01\uC8FC \uD45C\uAE30 \uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0 \u2014 \uAC01\uC8FC \uC720\uC9C0, \uBCF8\uBB38\uB9CC \uC801\uC6A9", before: `(\uC8FC: ${block.footnoteText})` });
    }
  }
  if (mapping.prefixStripped) {
    const origPrefix = block.text.split(" ", 1)[0];
    const sp = newPlain.indexOf(" ");
    const newFirst = sp > 0 ? newPlain.slice(0, sp) : newPlain;
    if (newFirst === origPrefix || AUTONUM_PREFIX_RE.test(newFirst)) {
      newPlain = sp > 0 ? newPlain.slice(sp + 1) : "";
    } else {
      ctx.skipped.push({ reason: "\uC790\uB3D9\uBC88\uD638 \uC811\uB450 \uC2DD\uBCC4 \uC2E4\uD328 \u2014 \uBC88\uD638 \uD3EC\uD568 \uD14D\uC2A4\uD2B8\uB85C \uC801\uC6A9 (\uBDF0\uC5B4\uC5D0\uC11C \uC911\uBCF5 \uD45C\uC2DC \uAC00\uB2A5)", after: summarize(newPlain) });
    }
  }
  if (newPlain === origPlain) return skip("\uD14D\uC2A4\uD2B8 \uC678 \uBCC0\uACBD(\uD5E4\uB529 \uB808\uBCA8/\uC11C\uC2DD)\uB9CC \uAC10\uC9C0 \u2014 \uC2A4\uD0C0\uC77C \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
  if (sanitizeText(newPlain) !== newPlain) {
    return skip("\uACF5\uBC31 \uC815\uADDC\uD654 \uBD88\uC548\uC815 \uD14D\uC2A4\uD2B8 \u2014 \uD328\uCE58 \uC2DC \uC6D0\uBB38 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0");
  }
  const splices = buildParagraphSplices(mapping.para, newPlain, _optionalChain([ctx, 'access', _330 => _330.scans, 'access', _331 => _331[mapping.para.sectionIndex], 'optionalAccess', _332 => _332.xml]));
  if (splices === null) return skip("\uBB38\uB2E8\uC5D0 \uD14D\uC2A4\uD2B8 \uB178\uB4DC\uB97C \uB9CC\uB4E4 \uC218 \uC5C6\uC74C");
  ctx.sectionSplices[mapping.para.sectionIndex].push(...splices);
  return 1;
}
function textUnitToPlain(raw, block) {
  let text = raw.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  if (block.type === "heading" || block.text && /^\[별표\s*\d+/.test(sanitizeText(block.text))) {
    text = text.replace(/^#{1,6}\s+/, "");
  }
  if (block.href) {
    const linkMatch = text.match(/^\[([\s\S]*)\]\([^)]*\)$/);
    if (linkMatch) text = linkMatch[1];
  }
  if (/^\*[^*][\s\S]*\*$/.test(text) && block.text && /^\([^)]*조[^)]*관련\)$/.test(sanitizeText(block.text))) {
    text = text.slice(1, -1);
  }
  return unescapeGfm(text);
}
function diffUnitLists(a, b) {
  const pairs = alignUnits(a.map((u) => u.raw), b.map((u) => u.raw));
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const diffs = [];
  for (const [ai, bi] of pairs) {
    if (ai !== null && bi !== null) {
      if (a[ai].raw === b[bi].raw) {
        stats.unchanged++;
        continue;
      }
      stats.modified++;
      diffs.push({ type: "modified", before: unitToBlock(a[ai]), after: unitToBlock(b[bi]), similarity: normalizedSimilarity(a[ai].raw, b[bi].raw) });
    } else if (ai !== null) {
      stats.removed++;
      diffs.push({ type: "removed", before: unitToBlock(a[ai]) });
    } else if (bi !== null) {
      stats.added++;
      diffs.push({ type: "added", after: unitToBlock(b[bi]) });
    }
  }
  return { stats, diffs };
}
function unitToBlock(u) {
  return { type: "paragraph", text: u.raw };
}
function u8ToArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
async function resolveHeaderEntryName(zip) {
  for (const p of ["Contents/header.xml", "header.xml"]) {
    if (zip.file(p)) return p;
  }
  for (const mp of ["Contents/content.hpf", "content.hpf"]) {
    const f = zip.file(mp);
    if (!f) continue;
    const xml = await f.async("text");
    const m = xml.match(/<opf:item\b[^>]*\bid="header"[^>]*\bhref="([^"]+)"/i) || xml.match(/<opf:item\b[^>]*\bhref="([^"]*header[^"]*\.xml)"/i);
    if (m) {
      let href = m[1];
      if (!href.startsWith("/") && !href.startsWith("Contents/")) href = "Contents/" + href;
      if (zip.file(href)) return href;
    }
  }
  const found = Object.keys(zip.files).find((n) => /header\.xml$/i.test(n));
  return _nullishCoalesce(found, () => ( null));
}

// src/roundtrip/hwp5-patch.ts



// src/roundtrip/ole-surgeon.ts
var SECTOR = 512;
var MINI_SECTOR = 64;
var MINI_CUTOFF = 4096;
var FREESECT = 4294967295;
var ENDOFCHAIN = 4294967294;
var FATSECT = 4294967293;
var OleSurgeonError = class extends Error {
};
function replaceOleStream(file, path, newData) {
  const surgeon = new Surgeon(file);
  surgeon.replace(path, newData);
  return surgeon.finish();
}
var Surgeon = (_class4 = class {
  
  __init6() {this.fat = []}
  /** FAT 배열을 구성하는 섹터 번호들 (DIFAT 순서) */
  __init7() {this.fatSectors = []}
  __init8() {this.miniFat = []}
  __init9() {this.miniFatSectors = []}
  __init10() {this.dirSectors = []}
  __init11() {this.entries = []}
  constructor(file) {;_class4.prototype.__init6.call(this);_class4.prototype.__init7.call(this);_class4.prototype.__init8.call(this);_class4.prototype.__init9.call(this);_class4.prototype.__init10.call(this);_class4.prototype.__init11.call(this);
    if (file.length < SECTOR || file.readUInt32LE(0) !== 3759263696) {
      throw new OleSurgeonError("OLE \uC2DC\uADF8\uB2C8\uCC98\uAC00 \uC544\uB2D9\uB2C8\uB2E4");
    }
    if (file.readUInt16LE(26) !== 3 || file.readUInt16LE(30) !== 9) {
      throw new OleSurgeonError("CFB v3(512B \uC139\uD130)\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4");
    }
    const padded = Math.ceil((file.length - SECTOR) / SECTOR) * SECTOR + SECTOR;
    this.buf = Buffer.alloc(padded);
    file.copy(this.buf);
    this.loadFat();
    this.loadMiniFat();
    this.loadDirectory();
  }
  // ── 로드 ──
  loadFat() {
    const difat = [];
    for (let i = 0; i < 109; i++) difat.push(this.buf.readUInt32LE(76 + i * 4));
    let difatSector = this.buf.readUInt32LE(68);
    let guard = 0;
    while (difatSector !== ENDOFCHAIN && difatSector !== FREESECT && guard++ < 1e6) {
      const off = this.sectorOffset(difatSector);
      for (let i = 0; i < 127; i++) difat.push(this.buf.readUInt32LE(off + i * 4));
      difatSector = this.buf.readUInt32LE(off + 127 * 4);
    }
    this.fatSectors = difat.filter((s) => s !== FREESECT);
    for (const s of this.fatSectors) {
      const off = this.sectorOffset(s);
      for (let i = 0; i < 128; i++) this.fat.push(this.buf.readUInt32LE(off + i * 4));
    }
  }
  loadMiniFat() {
    const start = this.buf.readUInt32LE(60);
    this.miniFatSectors = start === ENDOFCHAIN || start === FREESECT ? [] : this.chain(start);
    for (const s of this.miniFatSectors) {
      const off = this.sectorOffset(s);
      for (let i = 0; i < 128; i++) this.miniFat.push(this.buf.readUInt32LE(off + i * 4));
    }
  }
  loadDirectory() {
    this.dirSectors = this.chain(this.buf.readUInt32LE(48));
    for (let si = 0; si < this.dirSectors.length; si++) {
      const off = this.sectorOffset(this.dirSectors[si]);
      for (let i = 0; i < 4; i++) {
        const e = off + i * 128;
        const nameLen = this.buf.readUInt16LE(e + 64);
        const name = nameLen >= 2 ? this.buf.subarray(e, e + nameLen - 2).toString("utf16le") : "";
        this.entries.push({
          index: si * 4 + i,
          name,
          type: this.buf[e + 66],
          left: this.buf.readInt32LE(e + 68),
          right: this.buf.readInt32LE(e + 72),
          child: this.buf.readInt32LE(e + 76),
          start: this.buf.readUInt32LE(e + 116),
          size: this.buf.readUInt32LE(e + 120)
        });
      }
    }
  }
  // ── 헬퍼 ──
  sectorOffset(n) {
    const off = SECTOR + n * SECTOR;
    if (n >= 4294967290 || off + SECTOR > this.buf.length) throw new OleSurgeonError(`\uC139\uD130 \uBC94\uC704 \uCD08\uACFC: ${n}`);
    return off;
  }
  chain(start) {
    const out = [];
    let s = start;
    while (s !== ENDOFCHAIN) {
      if (s === FREESECT || s >= this.fat.length || out.length > this.fat.length) {
        throw new OleSurgeonError("FAT \uCCB4\uC778 \uC190\uC0C1");
      }
      out.push(s);
      s = this.fat[s];
    }
    return out;
  }
  miniChain(start) {
    const out = [];
    let s = start;
    while (s !== ENDOFCHAIN) {
      if (s === FREESECT || s >= this.miniFat.length || out.length > this.miniFat.length) {
        throw new OleSurgeonError("miniFAT \uCCB4\uC778 \uC190\uC0C1");
      }
      out.push(s);
      s = this.miniFat[s];
    }
    return out;
  }
  /** 디렉토리 트리에서 경로 해석 (형제 = L/R 이진 트리, 자식 = child) */
  findEntry(path) {
    const parts = path.replace(/^\//, "").split("/");
    let scope = _nullishCoalesce(_optionalChain([this, 'access', _333 => _333.entries, 'access', _334 => _334[0], 'optionalAccess', _335 => _335.child]), () => ( -1));
    let current;
    for (const part of parts) {
      const search = (idx) => {
        if (idx < 0 || idx >= this.entries.length) return void 0;
        const e = this.entries[idx];
        return _nullishCoalesce(_nullishCoalesce(search(e.left), () => ( (e.name === part ? e : void 0))), () => ( search(e.right)));
      };
      current = search(scope);
      if (!current) throw new OleSurgeonError(`\uC2A4\uD2B8\uB9BC \uC5C6\uC74C: ${path}`);
      scope = current.child;
    }
    if (!current || current.type !== 2) throw new OleSurgeonError(`\uC2A4\uD2B8\uB9BC\uC774 \uC544\uB2D8: ${path}`);
    return current;
  }
  rootEntry() {
    return this.entries[0];
  }
  // ── 할당 ──
  /**
   * FAT에서 빈 섹터 n개 확보 (부족하면 파일 끝에 추가) — 섹터 번호 목록 반환.
   * 확보 즉시 ENDOFCHAIN으로 마킹해 같은 수술 내 중복 할당을 방지한다 (체인 링크는
   * 호출자가 덮어씀).
   */
  allocSectors(n) {
    const out = [];
    for (let i = 0; i < this.fat.length && out.length < n; i++) {
      if (this.fat[i] !== FREESECT) continue;
      if (SECTOR + (i + 1) * SECTOR > this.buf.length) continue;
      this.fat[i] = ENDOFCHAIN;
      out.push(i);
    }
    while (out.length < n) {
      this.ensureFatCapacity((this.buf.length - SECTOR) / SECTOR + 2);
      const idx = (this.buf.length - SECTOR) / SECTOR;
      this.buf = Buffer.concat([this.buf, Buffer.alloc(SECTOR)]);
      this.fat[idx] = ENDOFCHAIN;
      out.push(idx);
    }
    return out;
  }
  /** FAT 배열이 sectorCount개 엔트리를 담도록 확장 (FAT 섹터 추가 + DIFAT 갱신) */
  ensureFatCapacity(sectorCount) {
    while (this.fat.length < sectorCount) {
      const idx = (this.buf.length - SECTOR) / SECTOR;
      this.buf = Buffer.concat([this.buf, Buffer.alloc(SECTOR)]);
      for (let i = 0; i < 128; i++) this.fat.push(FREESECT);
      this.fat[idx] = FATSECT;
      this.fatSectors.push(idx);
      const slot = this.fatSectors.length - 1;
      if (slot >= 109) throw new OleSurgeonError("DIFAT \uCCB4\uC778 \uD655\uC7A5\uC740 \uBBF8\uC9C0\uC6D0 (7MB \uCD08\uACFC \uCEE8\uD14C\uC774\uB108 \uC131\uC7A5)");
      this.buf.writeUInt32LE(idx, 76 + slot * 4);
      this.buf.writeUInt32LE(this.fatSectors.length, 44);
    }
  }
  /** miniFAT에서 빈 미니섹터 n개 확보 (mini stream 용량/miniFAT 확장 포함) */
  allocMiniSectors(n) {
    const root = this.rootEntry();
    const rootChain = root.start === ENDOFCHAIN || root.size === 0 ? [] : this.chain(root.start);
    let capacity = rootChain.length * (SECTOR / MINI_SECTOR);
    const out = [];
    for (let i = 0; i < Math.min(this.miniFat.length, capacity) && out.length < n; i++) {
      if (this.miniFat[i] === FREESECT) {
        this.miniFat[i] = ENDOFCHAIN;
        out.push(i);
      }
    }
    let nextIdx = capacity;
    while (out.length < n) {
      if (nextIdx >= this.miniFat.length) {
        const [s] = this.allocSectors(1);
        if (this.miniFatSectors.length > 0) this.fat[this.miniFatSectors[this.miniFatSectors.length - 1]] = s;
        else this.buf.writeUInt32LE(s, 60);
        this.miniFatSectors.push(s);
        this.buf.writeUInt32LE(this.miniFatSectors.length, 64);
        for (let i = 0; i < 128; i++) this.miniFat.push(FREESECT);
      }
      if (nextIdx >= capacity) {
        const [s] = this.allocSectors(1);
        if (rootChain.length > 0) this.fat[rootChain[rootChain.length - 1]] = s;
        else {
          root.start = s;
        }
        rootChain.push(s);
        capacity = rootChain.length * (SECTOR / MINI_SECTOR);
        root.size = Math.max(root.size, rootChain.length * SECTOR);
        this.writeDirEntry(root);
      }
      this.miniFat[nextIdx] = ENDOFCHAIN;
      out.push(nextIdx);
      nextIdx++;
    }
    return out;
  }
  // ── 기록 ──
  writeDirEntry(e) {
    const sector = this.dirSectors[Math.floor(e.index / 4)];
    const off = this.sectorOffset(sector) + e.index % 4 * 128;
    this.buf.writeUInt32LE(e.start, off + 116);
    this.buf.writeUInt32LE(e.size, off + 120);
  }
  flushFat() {
    for (let i = 0; i < this.fatSectors.length; i++) {
      const off = this.sectorOffset(this.fatSectors[i]);
      for (let j = 0; j < 128; j++) {
        const idx = i * 128 + j;
        this.buf.writeUInt32LE(idx < this.fat.length ? this.fat[idx] : FREESECT, off + j * 4);
      }
    }
    for (let i = 0; i < this.miniFatSectors.length; i++) {
      const off = this.sectorOffset(this.miniFatSectors[i]);
      for (let j = 0; j < 128; j++) {
        const idx = i * 128 + j;
        this.buf.writeUInt32LE(idx < this.miniFat.length ? this.miniFat[idx] : FREESECT, off + j * 4);
      }
    }
  }
  /** 미니섹터 k의 파일 내 바이트 오프셋 (root 체인 경유) */
  miniOffset(k, rootChain) {
    const within = k * MINI_SECTOR;
    const sec = rootChain[Math.floor(within / SECTOR)];
    if (sec === void 0) throw new OleSurgeonError("mini stream \uBC94\uC704 \uCD08\uACFC");
    return this.sectorOffset(sec) + within % SECTOR;
  }
  // ── 메인 ──
  replace(path, newData) {
    const entry = this.findEntry(path);
    if (entry.size > 0 && entry.start !== ENDOFCHAIN) {
      if (entry.size < MINI_CUTOFF) {
        for (const s of this.miniChain(entry.start)) this.miniFat[s] = FREESECT;
      } else {
        for (const s of this.chain(entry.start)) this.fat[s] = FREESECT;
      }
    }
    if (newData.length < MINI_CUTOFF) {
      const count = Math.ceil(newData.length / MINI_SECTOR) || 1;
      const sectors = this.allocMiniSectors(count);
      const rootChain = this.chain(this.rootEntry().start);
      for (let i = 0; i < sectors.length; i++) {
        this.miniFat[sectors[i]] = i + 1 < sectors.length ? sectors[i + 1] : ENDOFCHAIN;
        const off = this.miniOffset(sectors[i], rootChain);
        this.buf.fill(0, off, off + MINI_SECTOR);
        newData.copy(this.buf, off, i * MINI_SECTOR, Math.min((i + 1) * MINI_SECTOR, newData.length));
      }
      entry.start = sectors[0];
    } else {
      const count = Math.ceil(newData.length / SECTOR);
      const sectors = this.allocSectors(count);
      for (let i = 0; i < sectors.length; i++) {
        this.fat[sectors[i]] = i + 1 < sectors.length ? sectors[i + 1] : ENDOFCHAIN;
        const off = this.sectorOffset(sectors[i]);
        this.buf.fill(0, off, off + SECTOR);
        newData.copy(this.buf, off, i * SECTOR, Math.min((i + 1) * SECTOR, newData.length));
      }
      entry.start = sectors[0];
    }
    entry.size = newData.length;
    this.writeDirEntry(entry);
  }
  finish() {
    this.flushFat();
    return this.buf;
  }
}, _class4);

// src/roundtrip/hwp5-patch.ts
var require3 = _module.createRequire.call(void 0, _chunkGS7T56RPcjs.importMetaUrl);
var CFB2 = require3("cfb");
var TAG_PARA_LINE_SEG = 69;
function cid2(s) {
  return (s.charCodeAt(0) << 24 | s.charCodeAt(1) << 16 | s.charCodeAt(2) << 8 | s.charCodeAt(3)) >>> 0;
}
var CTRL_TBL2 = cid2("tbl ");
var CTRL_GSO2 = cid2("gso ");
function swap322(id) {
  return ((id & 255) << 24 | (id >>> 8 & 255) << 16 | (id >>> 16 & 255) << 8 | id >>> 24 & 255) >>> 0;
}
function isCtrl(rec, id) {
  if (rec.tagId !== TAG_CTRL_HEADER || rec.data.length < 4) return false;
  const raw = rec.data.readUInt32LE(0);
  return raw === id || swap322(raw) === id;
}
function readRecordsStrict(stream) {
  const recs = [];
  let off = 0;
  while (off < stream.length) {
    if (off + 4 > stream.length) return null;
    const h = stream.readUInt32LE(off);
    off += 4;
    const tagId = h & 1023;
    const level = h >>> 10 & 1023;
    let size = h >>> 20 & 4095;
    if (size === 4095) {
      if (off + 4 > stream.length) return null;
      size = stream.readUInt32LE(off);
      off += 4;
    }
    if (off + size > stream.length) return null;
    recs.push({ tagId, level, data: stream.subarray(off, off + size) });
    off += size;
  }
  return recs;
}
function serializeRecords(recs, repl, inserts) {
  const parts = [];
  const push = (tagId, level, data) => {
    const ext = data.length >= 4095;
    const header = Buffer.alloc(ext ? 8 : 4);
    header.writeUInt32LE((tagId & 1023 | (level & 1023) << 10 | (ext ? 4095 : data.length) << 20) >>> 0, 0);
    if (ext) header.writeUInt32LE(data.length, 4);
    parts.push(header, data);
  };
  for (let i = 0; i < recs.length; i++) {
    for (const ins of _nullishCoalesce(_optionalChain([inserts, 'optionalAccess', _336 => _336.get, 'call', _337 => _337(i)]), () => ( []))) push(ins.tagId, ins.level, ins.data);
    push(recs[i].tagId, recs[i].level, _nullishCoalesce(_optionalChain([repl, 'optionalAccess', _338 => _338.get, 'call', _339 => _339(i)]), () => ( recs[i].data)));
  }
  return Buffer.concat(parts);
}
function scanSection(stream, sectionIndex, compressed) {
  const records = readRecordsStrict(stream);
  if (!records) return { records: [], safe: false, paras: [], tables: [], compressed, repl: /* @__PURE__ */ new Map(), inserts: /* @__PURE__ */ new Map() };
  const safe = serializeRecords(records).equals(stream);
  const parent = new Int32Array(records.length).fill(-1);
  const stack = [];
  for (let i = 0; i < records.length; i++) {
    while (stack.length > 0 && records[stack[stack.length - 1]].level >= records[i].level) stack.pop();
    parent[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
    stack.push(i);
  }
  const ancestorCtrl = (i, id) => {
    for (let p = parent[i]; p >= 0; p = parent[p]) if (isCtrl(records[p], id)) return true;
    return false;
  };
  const paras = [];
  const parasByHeader = /* @__PURE__ */ new Map();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.tagId !== TAG_PARA_HEADER || rec.data.length < 18) continue;
    let textIdx = -1;
    let charShapeIdx = -1;
    let lineSegIdx = -1;
    const state = createParaTextState();
    for (let j = i + 1; j < records.length && records[j].level > rec.level; j++) {
      if (records[j].level !== rec.level + 1) continue;
      const t = records[j].tagId;
      if (t === TAG_PARA_TEXT) {
        textIdx = textIdx === -1 ? j : -2;
        appendParaText(state, records[j].data);
      } else if (t === TAG_CHAR_SHAPE && charShapeIdx === -1) charShapeIdx = j;
      else if (t === TAG_PARA_LINE_SEG && lineSegIdx === -1) lineSegIdx = j;
    }
    let ctrlSeen = false, nonGso = false;
    for (let a = parent[i]; a >= 0; a = parent[a]) {
      if (records[a].tagId === TAG_CTRL_HEADER) {
        ctrlSeen = true;
        if (!isCtrl(records[a], CTRL_GSO2)) nonGso = true;
      }
    }
    const kind = !ctrlSeen || !nonGso ? "body" : "other";
    const para = {
      sectionIndex,
      headerIdx: i,
      kind,
      textIdx,
      charShapeIdx,
      lineSegIdx,
      rangeTagCount: rec.data.readUInt16LE(14),
      ctrlMask: rec.data.readUInt32LE(4),
      nCharsRaw: rec.data.readUInt32LE(0),
      rawText: state.text
    };
    paras.push(para);
    parasByHeader.set(i, para);
  }
  const tables = [];
  for (let i = 0; i < records.length; i++) {
    if (!isCtrl(records[i], CTRL_TBL2) || ancestorCtrl(i, CTRL_TBL2)) continue;
    const ctrlLevel = records[i].level;
    let rows = 0, cols = 0, tableIdx = -1;
    for (let j2 = i + 1; j2 < records.length && records[j2].level > ctrlLevel; j2++) {
      if (records[j2].level === ctrlLevel + 1 && records[j2].tagId === TAG_TABLE && records[j2].data.length >= 8) {
        rows = records[j2].data.readUInt16LE(4);
        cols = records[j2].data.readUInt16LE(6);
        tableIdx = j2;
        break;
      }
    }
    if (tableIdx < 0 || rows === 0 || cols === 0) continue;
    const cells = /* @__PURE__ */ new Map();
    let j = tableIdx + 1;
    while (j < records.length && records[j].level > ctrlLevel) {
      if (records[j].tagId !== TAG_LIST_HEADER) {
        j++;
        continue;
      }
      const lh = records[j];
      const cellLevel = lh.level;
      const cellParas = [];
      let k = j + 1;
      while (k < records.length) {
        const r = records[k];
        if (r.level < cellLevel) break;
        if (r.level === cellLevel && (r.tagId === TAG_LIST_HEADER || r.tagId === TAG_TABLE)) break;
        if (r.level === cellLevel && r.tagId === TAG_PARA_HEADER) {
          const cp = parasByHeader.get(k);
          if (cp) {
            cp.kind = "cell";
            cellParas.push(cp);
          }
        }
        k++;
      }
      if (lh.data.length >= 16) {
        cells.set(`${lh.data.readUInt16LE(10)},${lh.data.readUInt16LE(8)}`, { paras: cellParas });
      }
      j = k;
    }
    tables.push({ sectionIndex, rows, cols, cells });
  }
  return { records, safe, paras, tables, compressed, repl: /* @__PURE__ */ new Map(), inserts: /* @__PURE__ */ new Map() };
}
async function patchHwp(original, editedMarkdown, options) {
  const skipped = [];
  let applied = 0;
  const originalBuf = Buffer.from(original.buffer, original.byteOffset, original.byteLength);
  let cfb;
  try {
    cfb = CFB2.parse(originalBuf);
  } catch (err) {
    return fail(`CFB \uCEE8\uD14C\uC774\uB108 \uD30C\uC2F1 \uC2E4\uD328: ${msg(err)}`);
  }
  const fhEntry = CFB2.find(cfb, "/FileHeader");
  if (!_optionalChain([fhEntry, 'optionalAccess', _340 => _340.content])) return fail("FileHeader \uC2A4\uD2B8\uB9BC\uC774 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 HWP 5.x \uD30C\uC77C\uC774 \uC544\uB2D9\uB2C8\uB2E4");
  let flags;
  try {
    flags = parseFileHeader(Buffer.from(fhEntry.content)).flags;
  } catch (err) {
    return fail(`FileHeader \uD30C\uC2F1 \uC2E4\uD328: ${msg(err)}`);
  }
  if (flags & (FLAG_ENCRYPTED | FLAG_DISTRIBUTION | FLAG_DRM)) {
    return fail("\uC554\uD638\uD654/\uBC30\uD3EC\uC6A9/DRM \uBB38\uC11C\uB294 \uD328\uCE58\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
  }
  const compressed = (flags & FLAG_COMPRESSED) !== 0;
  let origBlocks;
  try {
    origBlocks = parseHwp5Document(originalBuf).blocks;
  } catch (err) {
    return fail(`\uC6D0\uBCF8 HWP \uD30C\uC2F1 \uC2E4\uD328: ${msg(err)}`);
  }
  const sectionPaths = cfb.FullPaths.map((p) => p.replace(/^Root Entry/, "")).filter((p) => /^\/BodyText\/Section\d+$/.test(p)).sort((a, b) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]));
  if (sectionPaths.length === 0) return fail("BodyText \uC139\uC158 \uC2A4\uD2B8\uB9BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  const scans = [];
  for (let i = 0; i < sectionPaths.length; i++) {
    const entry = CFB2.find(cfb, sectionPaths[i]);
    if (!_optionalChain([entry, 'optionalAccess', _341 => _341.content])) return fail(`\uC139\uC158 \uC2A4\uD2B8\uB9BC \uC77D\uAE30 \uC2E4\uD328: ${sectionPaths[i]}`);
    let stream;
    try {
      stream = compressed ? decompressStream(Buffer.from(entry.content)) : Buffer.from(entry.content);
    } catch (err) {
      return fail(`\uC139\uC158 \uC555\uCD95 \uD574\uC81C \uC2E4\uD328: ${msg(err)}`);
    }
    scans.push(scanSection(stream, i, compressed));
  }
  const origUnits = buildOrigUnits(origBlocks);
  const editedUnits = splitMarkdownUnits(editedMarkdown);
  const pairs = alignUnits(origUnits.map((u) => u.raw), editedUnits.map((u) => u.raw));
  const paraMap = resolveParaMappings(origBlocks, scans);
  const tableMap = resolveTableMappings(origBlocks, scans.flatMap((s) => s.tables));
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) {
      const orig = origUnits[oi];
      const edited = editedUnits[ei];
      if (orig.raw === edited.raw) continue;
      applied += handleModified(orig, edited, {
        origBlocks,
        paraMap,
        scans,
        tableMap,
        skipped
      });
    } else if (oi !== null) {
      skipped.push({ reason: "\uBE14\uB85D \uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0 (v1) \u2014 \uC6D0\uBCF8 \uC720\uC9C0", before: summarize(origUnits[oi].raw) });
    } else if (ei !== null) {
      skipped.push({ reason: "\uBE14\uB85D \uCD94\uAC00\uB294 \uBBF8\uC9C0\uC6D0 (v1)", after: summarize(editedUnits[ei].raw) });
    }
  }
  let data;
  const dirty = scans.some((s) => s.repl.size > 0 || s.inserts.size > 0);
  if (!dirty) {
    data = new Uint8Array(original);
  } else {
    try {
      let out = originalBuf;
      for (let i = 0; i < scans.length; i++) {
        if (scans[i].repl.size === 0 && scans[i].inserts.size === 0) continue;
        const newStream = serializeRecords(scans[i].records, scans[i].repl, scans[i].inserts);
        const content = compressed ? _zlib.deflateRawSync.call(void 0, newStream) : newStream;
        out = replaceOleStream(out, sectionPaths[i], content);
      }
      data = new Uint8Array(out);
    } catch (err) {
      return { success: false, applied: 0, skipped, error: `HWP \uC139\uD130 \uC218\uC220 \uC2E4\uD328: ${msg(err)}` };
    }
  }
  let verification;
  if (_optionalChain([options, 'optionalAccess', _342 => _342.verify]) !== false) {
    try {
      const reparsed = parseHwp5Document(Buffer.from(data));
      const normBr = (u) => ({ ...u, raw: u.raw.replace(/<br\s*\/?\s*>/gi, "\n") });
      verification = diffUnitLists(splitMarkdownUnits(reparsed.markdown).map(normBr), editedUnits.map(normBr));
    } catch (err) {
      return { success: false, applied, skipped, error: `\uD328\uCE58\uBCF8 \uC7AC\uD30C\uC2F1 \uC2E4\uD328 \u2014 \uD328\uCE58 \uC911\uB2E8: ${msg(err)}` };
    }
  }
  return { success: true, data, applied, skipped, verification };
  function fail(error) {
    return { success: false, applied: 0, skipped, error };
  }
}
function msg(err) {
  return err instanceof Error ? err.message : String(err);
}
function resolveParaMappings(blocks, scans) {
  const buckets = /* @__PURE__ */ new Map();
  for (const scan of scans) {
    for (const para of scan.paras) {
      if (para.kind === "other") continue;
      const key = normForMatch(para.rawText);
      if (!key) continue;
      let list = buckets.get(key);
      if (!list) buckets.set(key, list = []);
      list.push(para);
    }
  }
  const usable = (list) => list.length === 1 || list.every((p) => p.kind === "body");
  const counters = /* @__PURE__ */ new Map();
  const result = /* @__PURE__ */ new Map();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "paragraph" && b.type !== "heading" || !b.text) continue;
    let key = normForMatch(b.text);
    let prefixStripped = false;
    if (!buckets.has(key)) {
      const sp = b.text.indexOf(" ");
      if (sp > 0) {
        const alt = normForMatch(b.text.slice(sp + 1));
        if (alt && buckets.has(alt)) {
          key = alt;
          prefixStripped = true;
        }
      }
    }
    const list = buckets.get(key);
    if (!list || !usable(list)) {
      result.set(i, {});
      continue;
    }
    const occ = _nullishCoalesce(counters.get(key), () => ( 0));
    counters.set(key, occ + 1);
    result.set(i, occ < list.length ? { para: list[occ], prefixStripped } : {});
  }
  return result;
}
function resolveTableMappings(blocks, scanTables) {
  const result = /* @__PURE__ */ new Map();
  let si = 0;
  for (let i = 0; i < blocks.length; i++) {
    const table = blocks[i].table;
    if (blocks[i].type !== "table" || !table) continue;
    const cands = [];
    for (let k = si; k < scanTables.length; k++) {
      if (scanTables[k].rows === table.rows && scanTables[k].cols === table.cols) cands.push(k);
    }
    if (cands.length === 0) continue;
    let pick2 = cands[0];
    if (cands.length > 1) {
      let best = tableContentScore(table, scanTables[cands[0]]);
      for (let ci = 1; ci < cands.length; ci++) {
        const sc = tableContentScore(table, scanTables[cands[ci]]);
        if (sc > best) {
          best = sc;
          pick2 = cands[ci];
        }
      }
    }
    result.set(i, scanTables[pick2]);
    si = pick2 + 1;
  }
  return result;
}
function tableContentScore(irTable, scanTable) {
  let matched = 0;
  for (const [key, scanCell] of scanTable.cells) {
    const comma = key.indexOf(",");
    const r = Number(key.slice(0, comma)), c = Number(key.slice(comma + 1));
    const irCell = _optionalChain([irTable, 'access', _343 => _343.cells, 'access', _344 => _344[r], 'optionalAccess', _345 => _345[c]]);
    if (!irCell) continue;
    const a = normForMatch(scanCell.paras.map((p) => p.rawText).join(" "));
    const b = normForMatch(stripCellTokens(irCell.text));
    if (a && a === b) matched++;
  }
  return matched;
}
function handleModified(orig, edited, ctx) {
  const block = ctx.origBlocks[orig.blockIdx];
  const skip = (reason) => {
    ctx.skipped.push({ reason, before: summarize(orig.raw), after: summarize(edited.raw) });
    return 0;
  };
  if (orig.role === "caption") return skip("\uD45C \uCEA1\uC158 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 (v1)");
  if (orig.kind === "separator" || orig.kind === "image") return skip("\uC774\uBBF8\uC9C0/\uAD6C\uBD84\uC120 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
  if (!block) return skip("\uBE14\uB85D \uB9E4\uD551 \uC2E4\uD328");
  if (orig.fragment) return skip("\uBB38\uB2E8 \uBD84\uC808(\uAC15\uC81C \uC904\uBC14\uAFC8/\uBCD1\uD569 \uC720\uB2DB) \u2014 \uBD80\uBD84 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 (v1)");
  if (block.type === "table" && block.table) {
    if (orig.kind !== edited.kind) return skip("\uD45C \u2194 \uBE44\uD45C \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0 (\uD45C \uAD6C\uC870 \uBCC0\uACBD)");
    const scanTable = ctx.tableMap.get(orig.blockIdx);
    if (!scanTable) return skip("\uD45C \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328 \u2014 \uD45C \uAC1C\uC218/\uAD6C\uC870 \uBD88\uC77C\uCE58\uB85C \uC2E0\uB8B0 \uBD88\uAC00");
    if (orig.kind === "gfm-table") return patchGfmCells(scanTable, orig, edited, ctx, skip);
    if (orig.kind === "html-table") return patchHtmlCells5(block.table, scanTable, orig, edited, ctx, skip);
    return patchTextChunk5(block.table, scanTable, orig, edited, ctx, skip);
  }
  if ((block.type === "paragraph" || block.type === "heading") && orig.kind === "text") {
    if (edited.kind === "text") return patchParagraph(block, orig, edited, ctx, skip);
    if (edited.kind === "gfm-table" || edited.kind === "html-table") {
      return skip("HWP5(.hwp) \uBC14\uC774\uB108\uB9AC\uB294 \uBB38\uB2E8\u2192\uD45C \uC778\uD50C\uB808\uC774\uC2A4 \uBCC0\uD658 \uBBF8\uC9C0\uC6D0 \u2014 generate\uB85C \uC0C8 \uBB38\uC11C\uB97C \uB9CC\uB4E4\uAC70\uB098, HWPX(.hwpx)\uB85C \uC800\uC7A5 \uD6C4 patch\uD558\uC138\uC694");
    }
  }
  return skip("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uBE14\uB85D \uC720\uD615 \uBCC0\uACBD");
}
function patchParagraph(block, orig, edited, ctx, skip) {
  const mapping = ctx.paraMap.get(orig.blockIdx);
  if (!_optionalChain([mapping, 'optionalAccess', _346 => _346.para])) return skip("\uBB38\uB2E8 \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328 (\uBA38\uB9AC\uB9D0/\uAE00\uC0C1\uC790/\uCEA1\uC158 \uC601\uC5ED\uC774\uAC70\uB098 \uD14D\uC2A4\uD2B8 \uBD88\uC77C\uCE58)");
  const restoreBr = (s) => s.replace(/(?:\s*<br\s*\/?\s*>\s*)+/gi, "\n");
  let newPlain = restoreBr(textUnitToPlain(edited.raw, block));
  if (block.text && block.text.includes("\n") && !newPlain.includes("\n")) {
    return skip("\uB2E4\uC911\uC904 \uBB38\uB2E8 \uC218\uC815\uC5D0 <br> \uC5C6\uC74C \u2014 \uC904\uBC14\uAFC8 \uC704\uCE58 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0 (\uC904\uBC14\uAFC8\uC740 <br>\uB85C \uD45C\uAE30)");
  }
  if (block.footnoteText) {
    const noteMatch = newPlain.match(/\s*\(주: ([\s\S]*)\)$/);
    if (noteMatch) {
      newPlain = newPlain.slice(0, noteMatch.index).trimEnd();
      if (normForMatch(noteMatch[1]) !== normForMatch(block.footnoteText)) {
        ctx.skipped.push({ reason: "\uAC01\uC8FC \uD14D\uC2A4\uD2B8 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 \u2014 \uBCF8\uBB38\uB9CC \uC801\uC6A9", before: block.footnoteText, after: noteMatch[1] });
      }
    } else {
      ctx.skipped.push({ reason: "\uAC01\uC8FC \uD45C\uAE30 \uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0 \u2014 \uAC01\uC8FC \uC720\uC9C0, \uBCF8\uBB38\uB9CC \uC801\uC6A9", before: `(\uC8FC: ${block.footnoteText})` });
    }
  }
  if (mapping.prefixStripped) {
    const origPrefix = block.text.split(" ", 1)[0];
    const sp = newPlain.indexOf(" ");
    const newFirst = sp > 0 ? newPlain.slice(0, sp) : newPlain;
    if (newFirst === origPrefix || AUTONUM_PREFIX_RE.test(newFirst)) {
      newPlain = sp > 0 ? newPlain.slice(sp + 1) : "";
    } else {
      ctx.skipped.push({ reason: "\uC790\uB3D9\uBC88\uD638 \uC811\uB450 \uC2DD\uBCC4 \uC2E4\uD328 \u2014 \uBC88\uD638 \uD3EC\uD568 \uD14D\uC2A4\uD2B8\uB85C \uC801\uC6A9 (\uBDF0\uC5B4\uC5D0\uC11C \uC911\uBCF5 \uD45C\uC2DC \uAC00\uB2A5)", after: summarize(newPlain) });
    }
  }
  const origPlain = block.text != null ? block.text : restoreBr(textUnitToPlain(orig.raw, block));
  if (newPlain === origPlain) return skip("\uD14D\uC2A4\uD2B8 \uC678 \uBCC0\uACBD(\uD5E4\uB529 \uB808\uBCA8/\uC11C\uC2DD)\uB9CC \uAC10\uC9C0 \u2014 \uC2A4\uD0C0\uC77C \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
  if (sanitizeText(newPlain) !== newPlain) {
    return skip("\uACF5\uBC31 \uC815\uADDC\uD654 \uBD88\uC548\uC815 \uD14D\uC2A4\uD2B8 \u2014 \uD328\uCE58 \uC2DC \uC6D0\uBB38 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0");
  }
  return stageParaPatch(ctx.scans[mapping.para.sectionIndex], mapping.para, newPlain, skip);
}
function patchGfmCells(scanTable, orig, edited, ctx, skip) {
  const origRows = parseGfmTable(orig.lines);
  const editedRows = parseGfmTable(edited.lines);
  if (origRows.length !== editedRows.length || origRows.some((r, i) => r.length !== editedRows[i].length)) {
    return skip("\uD45C \uAD6C\uC870 \uBCC0\uACBD(\uD589/\uC5F4 \uC218)\uC740 \uBBF8\uC9C0\uC6D0 (v1)");
  }
  let applied = 0;
  for (let r = 0; r < origRows.length; r++) {
    for (let c = 0; c < origRows[r].length; c++) {
      if (origRows[r][c] === editedRows[r][c]) continue;
      const cellSkip = (reason) => {
        ctx.skipped.push({ reason, before: summarize(origRows[r][c]), after: summarize(editedRows[r][c]) });
        return 0;
      };
      const cell = scanTable.cells.get(`${r},${c}`);
      if (!cell) {
        cellSkip("\uBCD1\uD569 \uC601\uC5ED \uC140 \u2014 \uC575\uCEE4 \uC140\uC774 \uC544\uB2C8\uBBC0\uB85C \uBBF8\uC9C0\uC6D0");
        continue;
      }
      const beforeParts = origRows[r][c].split(/<br\s*\/?>/i);
      const afterParts = editedRows[r][c].split(/<br\s*\/?>/i);
      if (cell.paras.length === 1) {
        const beforeEach = beforeParts.map(gfmCellToPlain);
        const afterEach = afterParts.map(gfmCellToPlain);
        if (beforeEach.some((p) => p === null) || afterEach.some((p) => p === null)) {
          cellSkip("\uC11C\uC2DD/\uB9C1\uD06C/\uC774\uBBF8\uC9C0 \uD3EC\uD568 \uC140 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 (v1)");
          continue;
        }
        const before = beforeEach.join("\n");
        const after = afterEach.join("\n");
        if (before === after) continue;
        const para = cell.paras[0];
        if (normForMatch(para.rawText) !== normForMatch(before)) {
          cellSkip("\uC140 \uD14D\uC2A4\uD2B8 \uBD88\uC77C\uCE58 \u2014 \uC18C\uC2A4\uB9F5 \uC2E0\uB8B0 \uBD88\uAC00");
          continue;
        }
        if (afterEach.some((l) => sanitizeText(l) !== l)) {
          cellSkip("\uACF5\uBC31 \uC815\uADDC\uD654 \uBD88\uC548\uC815 \uD14D\uC2A4\uD2B8 \u2014 \uBBF8\uC9C0\uC6D0");
          continue;
        }
        applied += stageParaPatch(ctx.scans[para.sectionIndex], para, after, cellSkip);
        continue;
      }
      if (beforeParts.length !== cell.paras.length || afterParts.length !== cell.paras.length) {
        cellSkip("\uC140 \uBB38\uB2E8 \uC218 \uBCC0\uACBD \u2014 \uBBF8\uC9C0\uC6D0 (\uBB38\uB2E8 \uCD94\uAC00/\uC0AD\uC81C)");
        continue;
      }
      for (let k = 0; k < cell.paras.length; k++) {
        const before = gfmCellToPlain(beforeParts[k]);
        const after = gfmCellToPlain(afterParts[k]);
        if (before === null || after === null) {
          cellSkip("\uC11C\uC2DD/\uB9C1\uD06C/\uC774\uBBF8\uC9C0 \uD3EC\uD568 \uC140 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 (v1)");
          break;
        }
        if (before === after) continue;
        if (after.includes("\n")) {
          cellSkip("\uC140 \uB0B4 \uC904\uBC14\uAFC8 \uCD94\uAC00\uB294 \uBBF8\uC9C0\uC6D0 (v1)");
          break;
        }
        const para = cell.paras[k];
        if (normForMatch(para.rawText) !== normForMatch(before)) {
          cellSkip("\uC140 \uD14D\uC2A4\uD2B8 \uBD88\uC77C\uCE58 \u2014 \uC18C\uC2A4\uB9F5 \uC2E0\uB8B0 \uBD88\uAC00");
          break;
        }
        if (sanitizeText(after) !== after) {
          cellSkip("\uACF5\uBC31 \uC815\uADDC\uD654 \uBD88\uC548\uC815 \uD14D\uC2A4\uD2B8 \u2014 \uBBF8\uC9C0\uC6D0");
          break;
        }
        applied += stageParaPatch(ctx.scans[para.sectionIndex], para, after, cellSkip);
      }
    }
  }
  return applied;
}
function patchHtmlCells5(table, scanTable, orig, edited, ctx, skip) {
  if (replicateTableToHtml(table) !== orig.raw) return skip("\uD45C \uC88C\uD45C \uC7AC\uD604 \uBD88\uC77C\uCE58 \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
  const replica = replicateHtmlTable(table);
  const origRows = parseHtmlTable(orig.raw);
  if (!origRows || origRows.length !== replica.length || origRows.some((r, i) => r.cells.length !== replica[i].cells.length || r.cells.some((c, j) => c.inner !== replica[i].cells[j].inner))) {
    return skip("\uC140 \uACBD\uACC4 \uBAA8\uD638 (\uB9AC\uD130\uB7F4 \uD0DC\uADF8 \uC758\uC2EC) \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
  }
  const editedRows = parseHtmlTable(edited.raw);
  if (!editedRows) return skip("\uD3B8\uC9D1\uB41C HTML \uD45C \uD30C\uC2F1 \uC2E4\uD328");
  if (editedRows.length !== replica.length) return skip("\uD45C \uD589 \uCD94\uAC00/\uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0 (\uD45C \uAD6C\uC870 \uBCC0\uACBD)");
  let applied = 0;
  for (let r = 0; r < replica.length; r++) {
    if (editedRows[r].cells.length !== replica[r].cells.length) {
      skip(`\uD45C ${r + 1}\uD589 \uC140 \uC218 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0`);
      continue;
    }
    for (let c = 0; c < replica[r].cells.length; c++) {
      const oc = replica[r].cells[c];
      const ec = editedRows[r].cells[c];
      if (oc.colSpan !== ec.colSpan || oc.rowSpan !== ec.rowSpan) {
        skip("\uC140 \uBCD1\uD569(colspan/rowspan) \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
        continue;
      }
      if (oc.inner === ec.inner) continue;
      const origContent = htmlCellInnerToLines(oc.inner);
      const editedContent = htmlCellInnerToLines(ec.inner);
      if (origContent.hadNonText || editedContent.hadNonText) {
        if (extractImgTags(oc.inner) !== extractImgTags(ec.inner)) {
          skip("\uC140 \uB0B4 \uC774\uBBF8\uC9C0 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
          continue;
        }
        if (extractTopLevelTables(oc.inner).join("\n") !== extractTopLevelTables(ec.inner).join("\n")) {
          skip("\uC140 \uB0B4 \uC911\uCCA9\uD45C \uC218\uC815\uC740 HWP5 \uBBF8\uC9C0\uC6D0 (v1)");
          continue;
        }
      }
      if (origContent.lines.join("\n") !== editedContent.lines.join("\n")) {
        const newLines = editedContent.lines.map((l) => unescapeGfm(l));
        applied += applyCellEdit5(table, scanTable, oc.gridR, oc.gridC, newLines, ctx, oc.inner, ec.inner, origContent.lines.length);
      }
    }
  }
  return applied;
}
function patchTextChunk5(table, scanTable, orig, edited, ctx, skip) {
  if (table.rows === 1 && table.cols === 1) {
    const content = sanitizeText(table.cells[0][0].text);
    const replicaLines = content.split(/\n/).map((line) => {
      const t = line.trim();
      if (!t) return "";
      if (/^\d+\.\s/.test(t)) return `**${escapeGfm(t)}**`;
      return escapeGfm(t);
    }).filter(Boolean);
    if (replicaLines.join("\n") !== orig.lines.join("\n")) return skip("\uD45C \uC88C\uD45C \uC7AC\uD604 \uBD88\uC77C\uCE58 \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
    if (extractCellTokens(orig.raw) !== extractCellTokens(edited.raw)) return skip("\uC140 \uB0B4 \uC774\uBBF8\uC9C0 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
    const newLines = edited.lines.map((l) => {
      const m = l.match(/^\*\*([\s\S]*)\*\*$/);
      const unwrap = m && /^\d+\.\s/.test(unescapeGfm(m[1]));
      return stripCellTokens(unescapeGfm(unwrap ? m[1] : l)).trim();
    }).filter(Boolean);
    return applyCellEdit5(table, scanTable, 0, 0, newLines, ctx, orig.raw, edited.raw, orig.lines.length);
  }
  if (table.cols === 1 && table.rows >= 2) {
    const replica = [];
    for (let r = 0; r < table.rows; r++) {
      const line = escapeGfm(sanitizeText(table.cells[r][0].text)).replace(/\n/g, " ");
      if (line) replica.push({ line, gridR: r });
    }
    if (replica.map((x) => x.line).join("\n") !== orig.lines.join("\n")) return skip("\uD45C \uC88C\uD45C \uC7AC\uD604 \uBD88\uC77C\uCE58 \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
    if (edited.lines.length !== replica.length) return skip("\uD45C \uD589 \uCD94\uAC00/\uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0 (\uD45C \uAD6C\uC870 \uBCC0\uACBD)");
    let applied = 0;
    for (let i = 0; i < replica.length; i++) {
      if (replica[i].line === edited.lines[i]) continue;
      if (extractCellTokens(replica[i].line) !== extractCellTokens(edited.lines[i])) {
        skip("\uC140 \uB0B4 \uC774\uBBF8\uC9C0 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0");
        continue;
      }
      const newLines = [stripCellTokens(unescapeGfm(edited.lines[i])).trim()].filter(Boolean);
      applied += applyCellEdit5(table, scanTable, replica[i].gridR, 0, newLines, ctx, replica[i].line, edited.lines[i], 1);
    }
    return applied;
  }
  return skip("\uD45C \uB80C\uB354 \uACBD\uB85C \uC2DD\uBCC4 \uC2E4\uD328");
}
function applyCellEdit5(table, scanTable, gridR, gridC, newLines, ctx, before, after, origLineCount) {
  const skip = (reason) => {
    ctx.skipped.push({ reason, before: summarize(before), after: summarize(after) });
    return 0;
  };
  const cell = scanTable.cells.get(`${gridR},${gridC}`);
  if (!cell) return skip("\uC140 \uC88C\uD45C \uB9E4\uD551 \uC2E4\uD328 (\uBCD1\uD569 \uC601\uC5ED\uC758 \uBE48 \uCE78\uC774\uAC70\uB098 \uC88C\uD45C \uBD88\uC77C\uCE58)");
  const irCell = _optionalChain([table, 'access', _347 => _347.cells, 'access', _348 => _348[gridR], 'optionalAccess', _349 => _349[gridC]]);
  const scanJoined = cell.paras.map((p) => p.rawText).filter((t) => normForMatch(t)).join("\n");
  if (irCell && normForMatch(scanJoined) !== normForMatch(stripCellTokens(irCell.text))) {
    if (normForMatch(irCell.text) !== "" || normForMatch(scanJoined) !== "") {
      const flatBlocks = (_nullishCoalesce(irCell.blocks, () => ( []))).filter((b) => b.type === "paragraph" || b.type === "heading");
      const flatJoined = flatBlocks.map((b) => _nullishCoalesce(b.text, () => ( ""))).join("\n");
      if (normForMatch(scanJoined) !== normForMatch(flatJoined)) {
        return skip("\uC140 \uCF58\uD150\uCE20 \uAD6C\uC870 \uBCF5\uC7A1 (\uC911\uCCA9\uD45C/\uAE00\uC0C1\uC790) \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00");
      }
    }
  }
  const nonEmpty = cell.paras.filter((p) => normForMatch(p.rawText) !== "");
  if (origLineCount !== void 0 && nonEmpty.length > 0 && origLineCount !== nonEmpty.length) {
    return skip("\uC140 \uC904 \uACBD\uACC4 \uB9E4\uD551 \uBAA8\uD638 (\uBB38\uB2E8 \uB0B4 \uC904\uBC14\uAFC8) \u2014 \uBBF8\uC9C0\uC6D0");
  }
  const unstable = newLines.find((l) => sanitizeText(l) !== l);
  if (unstable !== void 0) return skip("\uACF5\uBC31 \uC815\uADDC\uD654 \uBD88\uC548\uC815 \uD14D\uC2A4\uD2B8 \u2014 \uD328\uCE58 \uC2DC \uC6D0\uBB38 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0");
  const targets = nonEmpty.length > 0 ? nonEmpty : cell.paras;
  if (targets.length === 0) return skip("\uC140\uC5D0 \uBB38\uB2E8\uC774 \uC5C6\uC74C \u2014 \uBBF8\uC9C0\uC6D0");
  const assigned = [];
  for (let i = 0; i < targets.length; i++) {
    if (i < newLines.length) {
      assigned.push(i === targets.length - 1 && newLines.length > targets.length ? newLines.slice(i).join("\n") : newLines[i]);
    } else {
      assigned.push("");
    }
  }
  if (newLines.length > targets.length) {
    ctx.skipped.push({ reason: "\uC140 \uB0B4 \uCD94\uAC00 \uC904\uC744 \uB9C8\uC9C0\uB9C9 \uBB38\uB2E8\uC5D0 \uAC15\uC81C \uC904\uBC14\uAFC8\uC73C\uB85C \uBCD1\uD569(\uBB38\uB2E8 \uC0DD\uC131 \uB300\uC2E0)", after: summarize(after), partial: true });
  } else if (newLines.length < nonEmpty.length && nonEmpty.length > 1) {
    ctx.skipped.push({ reason: "\uC140 \uB0B4 \uC904 \uC0AD\uC81C\uB294 \uBB38\uB2E8 \uC81C\uAC70 \uBBF8\uC9C0\uC6D0 \u2014 \uBE48 \uBB38\uB2E8 \uC794\uC874(\uBDF0\uC5B4\uC5D0 \uBE48 \uC904 \uD45C\uC2DC \uAC00\uB2A5)", before: summarize(before), after: summarize(after), partial: true });
  }
  let staged = 0;
  for (let i = 0; i < targets.length; i++) {
    if (assigned[i] === targets[i].rawText || normForMatch(assigned[i]) === normForMatch(targets[i].rawText)) continue;
    staged += stageParaPatch(ctx.scans[targets[i].sectionIndex], targets[i], assigned[i], skip);
  }
  return staged > 0 ? 1 : 0;
}
function gfmCellToPlain(md2) {
  let t = md2.trim();
  const bold = t.match(/^\*\*([\s\S]+)\*\*$/);
  if (bold) t = bold[1];
  if (/[*`]|!\[|\]\(/.test(t)) return null;
  if (/<(?!br\s*\/?>)[a-zA-Z/]/i.test(t)) return null;
  return unescapeGfm(unescapeGfmCell(t));
}
function splitParaText(data) {
  const toks = [];
  let i = 0;
  while (i + 1 < data.length) {
    const ch = data.readUInt16LE(i);
    const start = i;
    i += 2;
    if (ch >= 32) {
      let units = 1;
      if (ch >= 55296 && ch <= 56319 && i + 1 < data.length) {
        const lo = data.readUInt16LE(i);
        if (lo >= 56320 && lo <= 57343) {
          i += 2;
          units = 2;
        }
      }
      toks.push({ start, end: i, units, plain: true, visible: true });
      continue;
    }
    switch (ch) {
      case 0:
      case 24:
      case 25:
      case 30:
      case 31:
        toks.push({ start, end: i, units: 1, plain: false, visible: true });
        break;
      case 9:
        if (i + 14 <= data.length) i += 14;
        toks.push({ start, end: i, units: 1, plain: false, visible: true });
        break;
      case 13:
        toks.push({ start, end: i, units: 1, plain: false, visible: false });
        break;
      case 10:
        if (i + 16 <= data.length && data.readUInt16LE(i) === 11) {
          i += 16;
          toks.push({ start, end: i, units: 1, plain: false, visible: false });
        } else {
          toks.push({ start, end: i, units: 1, plain: true, visible: true });
        }
        break;
      default: {
        const ext = isExtendedOnlyCtrlChar(ch);
        const inl = ch >= 4 && ch <= 9 || ch >= 19 && ch <= 20;
        if ((ext || inl) && i + 14 <= data.length) i += 14;
        toks.push({ start, end: i, units: 1, plain: false, visible: false });
        break;
      }
    }
  }
  if (i !== data.length) return null;
  let firstP = -1, lastP = -1;
  for (let k = 0; k < toks.length; k++) if (toks[k].plain) {
    if (firstP < 0) firstP = k;
    lastP = k;
  }
  if (firstP < 0) {
    if (toks.some((t) => t.visible)) return null;
    let cut = data.length;
    for (const t of toks) if (data.readUInt16LE(t.start) === 13) {
      cut = t.start;
      break;
    }
    return {
      prefix: data.subarray(0, cut),
      prefixUnits: cut / 2,
      core: "",
      suffix: data.subarray(cut),
      suffixUnits: (data.length - cut) / 2
    };
  }
  for (let k = firstP; k <= lastP; k++) if (!toks[k].plain) return null;
  for (let k = 0; k < firstP; k++) if (toks[k].visible) return null;
  for (let k = lastP + 1; k < toks.length; k++) if (toks[k].visible) return null;
  const prefixEnd = toks[firstP].start;
  const coreEnd = toks[lastP].end;
  const prefixUnits = prefixEnd / 2;
  const suffixUnits = (data.length - coreEnd) / 2;
  return {
    prefix: data.subarray(0, prefixEnd),
    prefixUnits,
    core: data.subarray(prefixEnd, coreEnd).toString("utf16le"),
    suffix: data.subarray(coreEnd),
    suffixUnits
  };
}
function rebuildCharShape(csData, coreStartUnit) {
  const pairs = [];
  for (let o = 0; o + 8 <= csData.length; o += 8) pairs.push([csData.readUInt32LE(o), csData.readUInt32LE(o + 4)]);
  if (pairs.length === 0) return { buf: Buffer.from(csData.subarray(0, 8)), count: 1 };
  let coreId = pairs[0][1];
  for (const [p, id] of pairs) if (p <= coreStartUnit) coreId = id;
  const kept = pairs.filter(([p]) => p < coreStartUnit);
  if (kept.length === 0 || kept[kept.length - 1][1] !== coreId) kept.push([coreStartUnit, coreId]);
  const buf = Buffer.alloc(kept.length * 8);
  kept.forEach(([p, id], k) => {
    buf.writeUInt32LE(p >>> 0, k * 8);
    buf.writeUInt32LE(id >>> 0, k * 8 + 4);
  });
  return { buf, count: kept.length };
}
function synthesizeLineSegs(lineSegData, newRaw, startUnits) {
  if (lineSegData.length < 36) return null;
  const seg0 = lineSegData.subarray(0, 36);
  const vPos0 = seg0.readInt32LE(4);
  const pitch = seg0.readInt32LE(8) + seg0.readInt32LE(20);
  if (pitch <= 0) return null;
  const lines = newRaw.split("\n");
  const segs = [];
  let pos = startUnits;
  for (let k = 0; k < lines.length; k++) {
    const s = Buffer.from(seg0);
    s.writeUInt32LE((k === 0 ? 0 : pos) >>> 0, 0);
    s.writeInt32LE(vPos0 + k * pitch, 4);
    segs.push(s);
    pos += lines[k].length + 1;
  }
  return { buf: Buffer.concat(segs), count: lines.length };
}
function stageParaPatch(scan, para, newPlain, skip) {
  if (!scan.safe) return skip("\uC139\uC158 \uB808\uCF54\uB4DC \uC7AC\uC9C1\uB82C\uD654 \uBD88\uC77C\uCE58 \u2014 \uC548\uC804\uC744 \uC704\uD574 \uC774 \uC139\uC158\uC740 \uBBF8\uC9C0\uC6D0");
  if (para.textIdx === -2) return skip("\uBCF5\uC218 PARA_TEXT \uB808\uCF54\uB4DC \uBB38\uB2E8 \u2014 \uBBF8\uC9C0\uC6D0 (v1)");
  if (para.rangeTagCount > 0) return skip("\uBC94\uC704 \uD0DC\uADF8(\uD615\uAD11\uD39C/\uAD50\uC815\uBD80\uD638) \uBB38\uB2E8 \u2014 \uBBF8\uC9C0\uC6D0 (v1)");
  if (para.charShapeIdx < 0 || para.lineSegIdx < 0) return skip("\uBB38\uB2E8 \uB808\uCF54\uB4DC \uAD6C\uC131 \uBE44\uC815\uD615 \u2014 \uBBF8\uC9C0\uC6D0");
  if (scan.repl.has(para.headerIdx)) return skip("\uB3D9\uC77C \uBB38\uB2E8 \uC911\uBCF5 \uC218\uC815 \u2014 \uCCAB \uC218\uC815\uB9CC \uC801\uC6A9");
  if (/[\u0000-\u0009\u000b-\u001f]/.test(newPlain)) return skip("\uC0C8 \uD14D\uC2A4\uD2B8\uC5D0 \uC81C\uC5B4\uBB38\uC790 \uD3EC\uD568 \u2014 \uBBF8\uC9C0\uC6D0");
  const records = scan.records;
  const headerRec = records[para.headerIdx];
  const charShapeRec = records[para.charShapeIdx];
  if (charShapeRec.data.length < 8) {
    return skip("CHAR_SHAPE \uB808\uCF54\uB4DC \uBE44\uC815\uD615 \u2014 \uBBF8\uC9C0\uC6D0");
  }
  if (para.textIdx === -1) {
    const nCharsLow = para.nCharsRaw & 2147483647;
    if (nCharsLow > 1) return skip("PARA_TEXT \uC5C6\uB294 \uBB38\uB2E8\uC758 nChars \uBE44\uC815\uD615 \u2014 \uBBF8\uC9C0\uC6D0");
    const paraEnd = nCharsLow === 1 ? Buffer.from([13, 0]) : Buffer.alloc(0);
    const at = para.headerIdx + 1;
    const list = _nullishCoalesce(scan.inserts.get(at), () => ( []));
    list.push({ tagId: TAG_PARA_TEXT, level: headerRec.level + 1, data: Buffer.concat([Buffer.from(newPlain, "utf16le"), paraEnd]) });
    scan.inserts.set(at, list);
    const newHeader2 = Buffer.from(headerRec.data);
    newHeader2.writeUInt32LE((para.nCharsRaw & 2147483648 | newPlain.length + nCharsLow) >>> 0, 0);
    const cs2 = rebuildCharShape(charShapeRec.data, 0);
    scan.repl.set(para.charShapeIdx, cs2.buf);
    newHeader2.writeUInt16LE(cs2.count, 12);
    if (newPlain.includes("\n")) {
      const synth = synthesizeLineSegs(records[para.lineSegIdx].data, newPlain, 0);
      if (synth) {
        scan.repl.set(para.lineSegIdx, synth.buf);
        newHeader2.writeUInt16LE(synth.count, 16);
      }
    }
    scan.repl.set(para.headerIdx, newHeader2);
    return 1;
  }
  const textRec = records[para.textIdx];
  const seg = splitParaText(textRec.data);
  if (!seg) {
    return skip(para.ctrlMask !== 0 ? "\uCEE8\uD2B8\uB864 \uBB38\uC790(\uD0ED/\uD544\uB4DC/\uD2B9\uC218\uACF5\uBC31 \uB4F1 \uD14D\uC2A4\uD2B8 \uC911\uAC04) \uD3EC\uD568 \uBB38\uB2E8 \u2014 \uBBF8\uC9C0\uC6D0 (v1)" : "PARA_TEXT \uC7AC\uAD6C\uC131 \uBD88\uC77C\uCE58 \u2014 \uC6D0\uBB38 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0");
  }
  if (seg.core !== para.rawText) return skip("PARA_TEXT \uC7AC\uAD6C\uC131 \uBD88\uC77C\uCE58 \u2014 \uC6D0\uBB38 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0");
  const lead = para.rawText.match(/^\s*/)[0];
  const trail = para.rawText.match(/\s*$/)[0];
  const newRaw = para.rawText.trim() === para.rawText ? newPlain : lead + newPlain + trail;
  const newText = Buffer.concat([seg.prefix, Buffer.from(newRaw, "utf16le"), seg.suffix]);
  scan.repl.set(para.textIdx, newText);
  const newHeader = Buffer.from(headerRec.data);
  const nChars = seg.prefixUnits + newRaw.length + seg.suffixUnits;
  newHeader.writeUInt32LE((para.nCharsRaw & 2147483648 | nChars) >>> 0, 0);
  const cs = rebuildCharShape(charShapeRec.data, seg.prefixUnits);
  scan.repl.set(para.charShapeIdx, cs.buf);
  newHeader.writeUInt16LE(cs.count, 12);
  if (newRaw.includes("\n")) {
    const synth = synthesizeLineSegs(records[para.lineSegIdx].data, newRaw, seg.prefixUnits);
    if (synth) {
      scan.repl.set(para.lineSegIdx, synth.buf);
      newHeader.writeUInt16LE(synth.count, 16);
    }
  }
  scan.repl.set(para.headerIdx, newHeader);
  return 1;
}

// src/validate.ts


var REQUIRED_FILES = [
  "mimetype",
  "META-INF/container.xml",
  "Contents/content.hpf",
  "Contents/header.xml",
  "Contents/section0.xml"
];
var EXPECTED_MIMETYPE = "application/hwp+zip";
var XML_SUFFIXES = [".xml", ".hpf", ".rdf"];
var SECTION_FILE_RE = /^Contents\/section\d+\.xml$/;
var SECCNT_RE = /<(?:\w+:)?head\b[^>]*?\bsecCnt="(\d+)"/;
var OPF_HREF_RE = /<opf:item\b[^>]*?\bhref="([^"]*)"/g;
async function validateHwpx(buffer) {
  const issues = [];
  let zip;
  try {
    zip = await _jszip2.default.loadAsync(buffer);
  } catch (err) {
    return {
      ok: false,
      issues: [{ message: `\uC720\uD6A8\uD55C ZIP\uC774 \uC544\uB2D8: ${err instanceof Error ? err.message : String(err)}` }],
      entryCount: 0
    };
  }
  const rawNames = Object.keys(zip.files);
  const names = rawNames.filter((n) => !zip.files[n].dir);
  if (names.length === 0) return { ok: false, issues: [{ message: "\uBE48 ZIP" }], entryCount: 0 };
  if (rawNames[0] !== "mimetype") {
    issues.push({ message: `\uCCAB zip \uC5D4\uD2B8\uB9AC\uAC00 '${rawNames[0]}' \u2014 'mimetype'\uC774\uC5B4\uC57C \uD568` });
  }
  const nameset = new Set(names);
  if (nameset.has("mimetype")) {
    const mt = (await zip.files["mimetype"].async("string")).trim();
    if (mt !== EXPECTED_MIMETYPE) {
      issues.push({ path: "mimetype", message: `\uB0B4\uC6A9\uC774 '${mt}' \u2014 '${EXPECTED_MIMETYPE}'\uC774\uC5B4\uC57C \uD568` });
    }
  }
  for (const req of REQUIRED_FILES) {
    if (!nameset.has(req)) issues.push({ message: `\uD544\uC218 \uD30C\uC77C \uB204\uB77D: ${req}` });
  }
  for (const name of names) {
    if (!XML_SUFFIXES.some((s) => name.endsWith(s))) continue;
    const text = await zip.files[name].async("string");
    let firstError = null;
    try {
      new (0, _xmldom.DOMParser)({
        onError(level, msg2) {
          if (level !== "warning" && firstError === null) firstError = String(msg2);
        }
      }).parseFromString(text, "text/xml");
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
    }
    if (firstError !== null) {
      issues.push({ path: name, message: `XML \uC6F0\uD3FC\uB4DC \uC704\uBC18: ${firstError.split("\n")[0]}` });
    }
  }
  if (nameset.has("Contents/header.xml")) {
    const header = await zip.files["Contents/header.xml"].async("string");
    const m = SECCNT_RE.exec(header);
    if (m) {
      const declared = Number(m[1]);
      const actual = names.filter((n) => SECTION_FILE_RE.test(n)).length;
      if (declared !== actual) {
        issues.push({
          path: "Contents/header.xml",
          message: `secCnt=${declared}\uC778\uB370 \uC2E4\uC81C sectionN.xml\uC740 ${actual}\uAC1C \u2014 \uD55C\uCEF4\uB3C5\uC2A4\uAC00 \uC5F4\uAE30\uB97C \uAC70\uBD80\uD568`
        });
      }
    }
  }
  if (nameset.has("Contents/content.hpf")) {
    const hpf = await zip.files["Contents/content.hpf"].async("string");
    for (const m of hpf.matchAll(OPF_HREF_RE)) {
      const href = m[1];
      if (!nameset.has(href) && !nameset.has(`Contents/${href}`)) {
        issues.push({ path: "Contents/content.hpf", message: `manifest\uAC00 \uC5C6\uB294 \uD30C\uC77C\uC744 \uCC38\uC870: ${href}` });
      }
    }
  }
  return { ok: issues.length === 0, issues, entryCount: names.length };
}

// src/roundtrip/session.ts

async function buildState(bytes) {
  const parsed = await parseHwpxDocument(u8ToArrayBuffer2(bytes));
  const zip = await _jszip2.default.loadAsync(bytes);
  const sectionPaths = await resolveSectionEntryNames(zip);
  if (sectionPaths.length === 0) {
    throw new Error("HWPX \uC139\uC158 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  }
  const scans = [];
  for (let i = 0; i < sectionPaths.length; i++) {
    const xml = await zip.file(sectionPaths[i]).async("text");
    scans.push(scanSectionXml(xml, i));
  }
  const paraMap = resolveParagraphMappings(parsed.blocks, scans);
  const scanTables = scans.flatMap((s) => s.tables.filter((t) => t.rows.length > 0));
  const tableOrdinals = buildTableOrdinals(parsed.blocks);
  const fragmentBlocks = /* @__PURE__ */ new Set();
  const unitBlocks = /* @__PURE__ */ new Set();
  for (const u of buildOrigUnits(parsed.blocks)) {
    unitBlocks.add(u.blockIdx);
    if (u.fragment) fragmentBlocks.add(u.blockIdx);
  }
  for (let i = 0; i < parsed.blocks.length; i++) {
    const b = parsed.blocks[i];
    if ((b.type === "paragraph" || b.type === "heading") && b.text && !unitBlocks.has(i)) {
      fragmentBlocks.add(i);
    }
  }
  return {
    bytes,
    blocks: parsed.blocks,
    markdown: parsed.markdown,
    sectionPaths,
    scans,
    paraMap,
    scanTables,
    tableOrdinals,
    fragmentBlocks
  };
}
function u8ToArrayBuffer2(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
function irCellLines(text) {
  return stripCellTokens(sanitizeText(text)).split("\n").map((s) => s.trim()).filter(Boolean);
}
var HwpxSession = (_class5 = class _HwpxSession {
  
  constructor(state) {;_class5.prototype.__init12.call(this);
    this.state = state;
  }
  /** HWPX 바이트로 세션을 연다 (입력은 복사되어 외부 변이와 격리) */
  static async open(input) {
    const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input.slice(0));
    return new _HwpxSession(await buildState(bytes));
  }
  /** 현재 문서의 IR 블록 — patchBlocks 후 갱신되므로 호출마다 다시 읽을 것 */
  get blocks() {
    return this.state.blocks;
  }
  /** 현재 문서의 마크다운 */
  get markdown() {
    return this.state.markdown;
  }
  /** 현재 문서 바이트 (복사본) */
  get bytes() {
    return new Uint8Array(this.state.bytes);
  }
  /** 블록 → 원본 위치 참조. 매핑 실패 시 undefined */
  sourceRef(blockIndex) {
    const st = this.state;
    const block = st.blocks[blockIndex];
    if (!block) return void 0;
    if (block.type === "paragraph" || block.type === "heading") {
      const para = _optionalChain([st, 'access', _350 => _350.paraMap, 'access', _351 => _351.get, 'call', _352 => _352(blockIndex), 'optionalAccess', _353 => _353.para]);
      if (!para) return void 0;
      return { kind: "paragraph", sectionIndex: para.sectionIndex, xmlStart: para.start };
    }
    if (block.type === "table" && block.table) {
      if (st.tableOrdinals.size !== st.scanTables.length) return void 0;
      const ordinal = st.tableOrdinals.get(blockIndex);
      const t = ordinal !== void 0 ? st.scanTables[ordinal] : void 0;
      if (!t) return void 0;
      return { kind: "table", sectionIndex: t.sectionIndex, xmlStart: t.start };
    }
    return void 0;
  }
  /** 블록 편집 가능성 사전 판정 — patcher graceful-skip 게이트의 사전 버전 */
  capability(blockIndex) {
    const st = this.state;
    const block = st.blocks[blockIndex];
    if (!block) return { capability: "locked", reason: "\uBE14\uB85D \uC778\uB371\uC2A4 \uBC94\uC704 \uBC16" };
    if (block.type === "paragraph" || block.type === "heading") {
      if (st.fragmentBlocks.has(blockIndex)) {
        return { capability: "locked", reason: "\uBB38\uB2E8 \uBD84\uC808(\uAC15\uC81C \uC904\uBC14\uAFC8/\uBCD1\uD569 \uC720\uB2DB) \u2014 \uBD80\uBD84 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 (v1)" };
      }
      if (block.text && block.text.includes("\n")) {
        return { capability: "locked", reason: "\uBB38\uB2E8 \uB0B4 \uAC15\uC81C \uC904\uBC14\uAFC8 \uD3EC\uD568 \u2014 \uC218\uC815 \uC2DC \uC904\uBC14\uAFC8 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0 (v1)" };
      }
      if (!_optionalChain([st, 'access', _354 => _354.paraMap, 'access', _355 => _355.get, 'call', _356 => _356(blockIndex), 'optionalAccess', _357 => _357.para])) {
        return { capability: "locked", reason: "\uBB38\uB2E8 \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328 (\uBA38\uB9AC\uB9D0/\uAE00\uC0C1\uC790/\uCEA1\uC158 \uC601\uC5ED\uC774\uAC70\uB098 \uD14D\uC2A4\uD2B8 \uBD88\uC77C\uCE58)" };
      }
      return { capability: "text" };
    }
    if (block.type === "table" && block.table) {
      if (st.tableOrdinals.size !== st.scanTables.length) {
        return { capability: "locked", reason: "\uD45C \uAC1C\uC218 \uBD88\uC77C\uCE58 \u2014 \uC18C\uC2A4\uB9F5 \uC2E0\uB8B0 \uBD88\uAC00" };
      }
      const ordinal = st.tableOrdinals.get(blockIndex);
      const scanTable = ordinal !== void 0 ? st.scanTables[ordinal] : void 0;
      if (!scanTable) {
        return { capability: "locked", reason: "\uD45C \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328" };
      }
      const table = block.table;
      const cells = [];
      let anyEditable = false;
      for (let r = 0; r < table.rows; r++) {
        const row = [];
        for (let c = 0; c < table.cols; c++) {
          const info = cellStaticCheck(table, scanTable, r, c);
          if (info.editable) anyEditable = true;
          row.push(info);
        }
        cells.push(row);
      }
      if (!anyEditable) return { capability: "locked", reason: "\uD3B8\uC9D1 \uAC00\uB2A5\uD55C \uC140 \uC5C6\uC74C", cells };
      return { capability: "cell-text", cells };
    }
    return { capability: "locked", reason: `${block.type} \uBE14\uB85D \uD3B8\uC9D1\uC740 \uBBF8\uC9C0\uC6D0 (v1)` };
  }
  /** 전 블록의 편집 가능성 */
  capabilities() {
    return this.state.blocks.map((_, i) => this.capability(i));
  }
  /**
   * 블록 단위 증분 패치 — 적용 후 세션 상태가 새 바이트로 갱신된다.
   *
   * - 호출은 내부적으로 직렬화된다 (동시 호출 시 도착 순서대로 누적 적용)
   * - 무변경 편집(현재 텍스트와 동일)은 조용히 건너뜀 (applied/skipped 모두 제외)
   * - 변경이 하나도 적용되지 않으면 반환 data는 현재 문서와 바이트 동일
   * - changes는 "패치 전 → 후" 문서 diff — modified 수가 기대 편집 수와
   *   일치하는지 확인 용도. patchHwpx의 verification(잔차 검증)과 의미가 다르다.
   */
  async patchBlocks(edits, options) {
    const run = this.opQueue.then(() => this.patchBlocksInner(edits, options));
    this.opQueue = run.then(() => void 0, () => void 0);
    return run;
  }
  __init12() {this.opQueue = Promise.resolve()}
  async patchBlocksInner(edits, options) {
    const st = this.state;
    const skipped = [];
    let applied = 0;
    const sectionSplices = st.scans.map(() => []);
    const cellCtx = { scans: st.scans, sectionSplices, skipped };
    const seenParas = /* @__PURE__ */ new Set();
    const seenCells = /* @__PURE__ */ new Set();
    for (const edit of edits) {
      const i = edit.blockIndex;
      const block = st.blocks[i];
      if (!block) {
        skipped.push({ reason: `\uBE14\uB85D \uC778\uB371\uC2A4 \uBC94\uC704 \uBC16: ${i}` });
        continue;
      }
      if (block.type === "table" && block.table) {
        if (!_optionalChain([edit, 'access', _358 => _358.cells, 'optionalAccess', _359 => _359.length])) {
          skipped.push({ reason: "\uD45C \uBE14\uB85D\uC5D0\uB294 cells \uD3B8\uC9D1\uB9CC \uC9C0\uC6D0", before: summarize(_nullishCoalesce(block.table.caption, () => ( "(\uD45C)"))) });
          continue;
        }
        if (st.tableOrdinals.size !== st.scanTables.length) {
          skipped.push({ reason: "\uD45C \uAC1C\uC218 \uBD88\uC77C\uCE58 \u2014 \uC18C\uC2A4\uB9F5 \uC2E0\uB8B0 \uBD88\uAC00" });
          continue;
        }
        const ordinal = st.tableOrdinals.get(i);
        const scanTable = ordinal !== void 0 ? st.scanTables[ordinal] : void 0;
        if (!scanTable) {
          skipped.push({ reason: "\uD45C \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328" });
          continue;
        }
        for (const cellEdit of edit.cells) {
          const key = `${i}:${cellEdit.row},${cellEdit.col}`;
          if (seenCells.has(key)) {
            skipped.push({ reason: "\uAC19\uC740 \uC140\uC5D0 \uC911\uBCF5 \uD3B8\uC9D1 \u2014 \uBA3C\uC800 \uC801\uC6A9\uB41C \uD3B8\uC9D1 \uC720\uC9C0", after: summarize(cellEdit.text) });
            continue;
          }
          const irCell = _optionalChain([block, 'access', _360 => _360.table, 'access', _361 => _361.cells, 'access', _362 => _362[cellEdit.row], 'optionalAccess', _363 => _363[cellEdit.col]]);
          if (!irCell) {
            skipped.push({ reason: `\uC140 \uC88C\uD45C \uBC94\uC704 \uBC16: ${cellEdit.row},${cellEdit.col}`, after: summarize(cellEdit.text) });
            continue;
          }
          if (extractCellTokens(irCell.text) !== extractCellTokens(cellEdit.text)) {
            skipped.push({ reason: "\uC140 \uB0B4 \uC774\uBBF8\uC9C0 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0", before: summarize(irCell.text), after: summarize(cellEdit.text) });
            continue;
          }
          const newLines = stripCellTokens(cellEdit.text).split("\n").map((s) => s.trim()).filter(Boolean);
          const origLines = irCellLines(irCell.text);
          if (newLines.join("\n") === origLines.join("\n")) continue;
          const n = applyCellEdit(
            block.table,
            scanTable,
            cellEdit.row,
            cellEdit.col,
            newLines,
            cellCtx,
            irCell.text,
            cellEdit.text,
            origLines.length
          );
          if (n > 0) seenCells.add(key);
          applied += n;
        }
        continue;
      }
      if ((block.type === "paragraph" || block.type === "heading") && edit.newText !== void 0) {
        if (seenParas.has(i)) {
          skipped.push({ reason: "\uAC19\uC740 \uBE14\uB85D\uC5D0 \uC911\uBCF5 \uD3B8\uC9D1 \u2014 \uBA3C\uC800 \uC801\uC6A9\uB41C \uD3B8\uC9D1 \uC720\uC9C0", after: summarize(edit.newText) });
          continue;
        }
        const n = this.patchParagraphPlain(i, block, edit.newText, sectionSplices, skipped);
        if (n > 0) seenParas.add(i);
        applied += n;
        continue;
      }
      skipped.push({
        reason: `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uBE14\uB85D \uC720\uD615(${block.type}) \uB610\uB294 \uD3B8\uC9D1 \uD615\uC2DD`,
        before: summarize(_nullishCoalesce(block.text, () => ( "")))
      });
    }
    const replacements = /* @__PURE__ */ new Map();
    const encoder = new TextEncoder();
    try {
      for (let s = 0; s < st.scans.length; s++) {
        if (sectionSplices[s].length === 0) continue;
        sectionSplices[s].push(...allLinesegRemovalSplices(st.scans[s].xml));
        replacements.set(st.sectionPaths[s], encoder.encode(applySplices(st.scans[s].xml, sectionSplices[s])));
      }
    } catch (err) {
      return { success: false, applied: 0, skipped, error: `\uC18C\uC2A4\uB9F5 splice \uC2E4\uD328: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (replacements.size === 0) {
      let changes2;
      if (_optionalChain([options, 'optionalAccess', _364 => _364.verify]) !== false) {
        const units = splitMarkdownUnits(st.markdown);
        changes2 = diffUnitLists(units, units);
      }
      return { success: true, data: new Uint8Array(st.bytes), applied, skipped, changes: changes2 };
    }
    let data;
    try {
      data = patchZipEntries(st.bytes, replacements);
    } catch (err) {
      return { success: false, applied: 0, skipped, error: `ZIP \uC7AC\uC870\uB9BD \uC2E4\uD328: ${err instanceof Error ? err.message : String(err)}` };
    }
    const beforeMarkdown = st.markdown;
    let newState;
    try {
      newState = await buildState(data);
    } catch (err) {
      return { success: false, applied, skipped, error: `\uD328\uCE58\uBCF8 \uC7AC\uD30C\uC2F1 \uC2E4\uD328 \u2014 \uD328\uCE58 \uC911\uB2E8: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.state = newState;
    let changes;
    if (_optionalChain([options, 'optionalAccess', _365 => _365.verify]) !== false) {
      changes = diffUnitLists(splitMarkdownUnits(beforeMarkdown), splitMarkdownUnits(newState.markdown));
    }
    return { success: true, data: new Uint8Array(data), applied, skipped, changes };
  }
  /** 문단/헤딩 평문 편집 — patcher.patchParagraphUnit의 평문 입력 버전 */
  patchParagraphPlain(blockIndex, block, newTextRaw, sectionSplices, skipped) {
    const skip = (reason) => {
      skipped.push({ reason, before: summarize(_nullishCoalesce(block.text, () => ( ""))), after: summarize(newTextRaw) });
      return 0;
    };
    const st = this.state;
    if (newTextRaw === (_nullishCoalesce(block.text, () => ( "")))) return 0;
    if (st.fragmentBlocks.has(blockIndex)) {
      return skip("\uBB38\uB2E8 \uBD84\uC808(\uAC15\uC81C \uC904\uBC14\uAFC8/\uBCD1\uD569 \uC720\uB2DB) \u2014 \uBD80\uBD84 \uC218\uC815\uC740 \uBBF8\uC9C0\uC6D0 (v1)");
    }
    if (block.text && block.text.includes("\n")) {
      return skip("\uBB38\uB2E8 \uB0B4 \uAC15\uC81C \uC904\uBC14\uAFC8 \uD3EC\uD568 \u2014 \uC218\uC815 \uC2DC \uC904\uBC14\uAFC8 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0 (v1)");
    }
    const mapping = st.paraMap.get(blockIndex);
    if (!_optionalChain([mapping, 'optionalAccess', _366 => _366.para])) {
      return skip("\uBB38\uB2E8 \uC18C\uC2A4\uB9F5 \uB9E4\uD551 \uC2E4\uD328 (\uBA38\uB9AC\uB9D0/\uAE00\uC0C1\uC790/\uCEA1\uC158 \uC601\uC5ED\uC774\uAC70\uB098 \uD14D\uC2A4\uD2B8 \uBD88\uC77C\uCE58)");
    }
    let newPlain = newTextRaw.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
    if (mapping.prefixStripped) {
      const origPrefix = block.text.split(" ", 1)[0];
      const sp = newPlain.indexOf(" ");
      const newFirst = sp > 0 ? newPlain.slice(0, sp) : newPlain;
      if (newFirst === origPrefix || AUTONUM_PREFIX_RE.test(newFirst)) {
        newPlain = sp > 0 ? newPlain.slice(sp + 1) : "";
      } else {
        skipped.push({ reason: "\uC790\uB3D9\uBC88\uD638 \uC811\uB450 \uC2DD\uBCC4 \uC2E4\uD328 \u2014 \uBC88\uD638 \uD3EC\uD568 \uD14D\uC2A4\uD2B8\uB85C \uC801\uC6A9 (\uBDF0\uC5B4\uC5D0\uC11C \uC911\uBCF5 \uD45C\uC2DC \uAC00\uB2A5)", after: summarize(newPlain) });
      }
    }
    if (newPlain === "") {
      return skip("\uBE14\uB85D \uBE44\uC6B0\uAE30/\uC0AD\uC81C\uB294 \uBBF8\uC9C0\uC6D0 (v1) \u2014 \uC6D0\uBCF8 \uC720\uC9C0");
    }
    if (sanitizeText(newPlain) !== newPlain) {
      return skip("\uACF5\uBC31 \uC815\uADDC\uD654 \uBD88\uC548\uC815 \uD14D\uC2A4\uD2B8 \u2014 \uD328\uCE58 \uC2DC \uC6D0\uBB38 \uBCF4\uC874 \uBD88\uAC00\uB85C \uBBF8\uC9C0\uC6D0");
    }
    const splices = buildParagraphSplices(mapping.para, newPlain, _optionalChain([st, 'access', _367 => _367.scans, 'access', _368 => _368[mapping.para.sectionIndex], 'optionalAccess', _369 => _369.xml]));
    if (splices === null) return skip("\uBB38\uB2E8\uC5D0 \uD14D\uC2A4\uD2B8 \uB178\uB4DC\uB97C \uB9CC\uB4E4 \uC218 \uC5C6\uC74C");
    sectionSplices[mapping.para.sectionIndex].push(...splices);
    return 1;
  }
}, _class5);
function cellStaticCheck(table, scanTable, r, c) {
  const irCell = _optionalChain([table, 'access', _370 => _370.cells, 'access', _371 => _371[r], 'optionalAccess', _372 => _372[c]]);
  if (!irCell) return { editable: false, reason: "\uC140 \uC88C\uD45C \uBC94\uC704 \uBC16" };
  const cell = scanTable.cellByAnchor.get(`${r},${c}`);
  if (!cell) return { editable: false, reason: "\uBCD1\uD569 \uC601\uC5ED\uC758 \uBE48 \uCE78\uC774\uAC70\uB098 \uC88C\uD45C \uBD88\uC77C\uCE58" };
  const scanJoined = cell.paragraphs.map((p) => p.text).filter((t) => normForMatch(t)).join("\n");
  if (normForMatch(scanJoined) !== normForMatch(stripCellTokens(irCell.text))) {
    if (normForMatch(irCell.text) !== "" || normForMatch(scanJoined) !== "") {
      const flatBlocks = (_nullishCoalesce(irCell.blocks, () => ( []))).filter((b) => b.type === "paragraph" || b.type === "heading");
      const flatJoined = flatBlocks.map((b) => _nullishCoalesce(b.text, () => ( ""))).join("\n");
      if (normForMatch(scanJoined) !== normForMatch(flatJoined)) {
        return { editable: false, reason: "\uC140 \uCF58\uD150\uCE20 \uAD6C\uC870 \uBCF5\uC7A1 (\uC911\uCCA9\uD45C/\uAE00\uC0C1\uC790) \u2014 \uB9E4\uD551 \uC2E0\uB8B0 \uBD88\uAC00" };
      }
    }
  }
  const nonEmpty = cell.paragraphs.filter((p) => normForMatch(p.text) !== "");
  if (nonEmpty.length === 0) {
    if (cell.paragraphs.length === 0) {
      return { editable: false, reason: "\uBE48 \uC140\uC5D0 \uBB38\uB2E8\uC774 \uC5C6\uC5B4 \uD14D\uC2A4\uD2B8 \uC0BD\uC785 \uBD88\uAC00" };
    }
    return { editable: true };
  }
  const lines = irCellLines(irCell.text);
  if (lines.length !== nonEmpty.length) {
    return { editable: false, reason: "\uC140 \uC904 \uACBD\uACC4 \uB9E4\uD551 \uBAA8\uD638 (\uB9AC\uD130\uB7F4 <br>/\uBB38\uB2E8 \uB0B4 \uC904\uBC14\uAFC8) \u2014 \uBBF8\uC9C0\uC6D0" };
  }
  return { editable: true };
}
async function openHwpxDocument(input) {
  return HwpxSession.open(input);
}
async function patchHwpxBlocks(original, edits, options) {
  const session = await HwpxSession.open(original);
  return session.patchBlocks(edits, options);
}

// src/print/renderer.ts
var _fs = require('fs');
var _markdownit = require('markdown-it'); var _markdownit2 = _interopRequireDefault(_markdownit);
var PRESETS = {
  default: `
    @page { size: A4; margin: 20mm; }
    body { font-family: 'Pretendard', 'Malgun Gothic', '\uB9D1\uC740 \uACE0\uB515', sans-serif; font-size: 11pt; line-height: 1.6; color: #111; }
    h1 { font-size: 20pt; margin: 1em 0 0.5em; }
    h2 { font-size: 16pt; margin: 1em 0 0.4em; }
    h3 { font-size: 13pt; margin: 0.8em 0 0.3em; }
    p { margin: 0.4em 0; }
    table { border-collapse: collapse; margin: 0.6em 0; width: 100%; }
    th, td { border: 1px solid #555; padding: 4px 8px; text-align: left; vertical-align: top; }
    th { background: #f0f0f0; }
    code { background: #f5f5f5; padding: 1px 4px; border-radius: 2px; font-family: 'D2Coding', Consolas, monospace; }
    pre { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow-x: auto; }
    blockquote { border-left: 3px solid #ccc; padding-left: 12px; color: #555; margin: 0.6em 0; }
    img { max-width: 100%; }
  `,
  "gov-formal": `
    @page { size: A4; margin: 25mm 20mm; }
    body { font-family: '\uD568\uCD08\uB86C\uBC14\uD0D5', 'HCR Batang', 'Batang', 'Malgun Gothic', serif; font-size: 11pt; line-height: 1.7; color: #000; }
    h1 { font-size: 18pt; text-align: center; margin: 0.5em 0 1em; letter-spacing: 0.05em; }
    h2 { font-size: 14pt; margin: 1em 0 0.4em; border-bottom: 1px solid #999; padding-bottom: 2px; }
    h3 { font-size: 12pt; margin: 0.8em 0 0.3em; }
    p { margin: 0.3em 0; text-indent: 1em; }
    table { border-collapse: collapse; margin: 0.8em 0; width: 100%; }
    th, td { border: 1px solid #000; padding: 5px 8px; vertical-align: top; }
    th { background: #e8e8e8; font-weight: normal; }
    blockquote { border-left: 2px solid #555; padding-left: 12px; margin: 0.6em 0; }
  `,
  compact: `
    @page { size: A4; margin: 10mm; }
    body { font-family: 'Pretendard', 'Malgun Gothic', sans-serif; font-size: 9pt; line-height: 1.4; color: #111; }
    h1 { font-size: 14pt; margin: 0.5em 0 0.3em; }
    h2 { font-size: 12pt; margin: 0.5em 0 0.3em; }
    h3 { font-size: 10pt; margin: 0.4em 0 0.2em; }
    p { margin: 0.2em 0; }
    table { border-collapse: collapse; margin: 0.3em 0; width: 100%; font-size: 8pt; }
    th, td { border: 1px solid #777; padding: 2px 4px; }
    th { background: #f0f0f0; }
  `
};
var md = new (0, _markdownit2.default)({
  html: true,
  linkify: true,
  breaks: false
});
function renderHtml(markdown, options) {
  const preset = _nullishCoalesce(_optionalChain([options, 'optionalAccess', _373 => _373.preset]), () => ( "default"));
  const css = PRESETS[preset] + (_nullishCoalesce(_optionalChain([options, 'optionalAccess', _374 => _374.extraCss]), () => ( "")));
  const body = md.render(markdown);
  const watermark = _optionalChain([options, 'optionalAccess', _375 => _375.watermark]) ? `<div class="watermark">${escapeHtml(options.watermark)}</div>` : "";
  const watermarkCss = _optionalChain([options, 'optionalAccess', _376 => _376.watermark]) ? `
    .watermark {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) rotate(-30deg);
      font-size: 80pt;
      color: rgba(0,0,0,0.08);
      pointer-events: none;
      z-index: 9999;
      white-space: nowrap;
    }` : "";
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>${css}${watermarkCss}</style>
</head>
<body>
${watermark}
${body}
</body>
</html>`;
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
async function htmlToPdf(html, options) {
  let puppeteer;
  try {
    puppeteer = await Promise.resolve().then(() => _interopRequireWildcard(require("puppeteer-core")));
  } catch (e30) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)(
      "PDF \uC0DD\uC131\uC5D0 puppeteer-core\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4. \uC124\uCE58: npm install puppeteer-core"
    );
  }
  const executablePath = _nullishCoalesce(process.env.PUPPETEER_EXECUTABLE_PATH, () => ( findChromiumPath()));
  if (!executablePath) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)(
      "Chromium \uC2E4\uD589 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. PUPPETEER_EXECUTABLE_PATH \uD658\uACBD\uBCC0\uC218\uB97C \uC124\uC815\uD558\uC138\uC694."
    );
  }
  const browser = await puppeteer.default.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const margin = _optionalChain([options, 'optionalAccess', _377 => _377.margin]);
    const pdf = await page.pdf({
      format: _nullishCoalesce(_optionalChain([options, 'optionalAccess', _378 => _378.pageSize]), () => ( "A4")),
      landscape: _optionalChain([options, 'optionalAccess', _379 => _379.orientation]) === "landscape",
      printBackground: true,
      margin: margin ? {
        top: toCss(margin.top),
        right: toCss(margin.right),
        bottom: toCss(margin.bottom),
        left: toCss(margin.left)
      } : void 0,
      displayHeaderFooter: !!(_optionalChain([options, 'optionalAccess', _380 => _380.header]) || _optionalChain([options, 'optionalAccess', _381 => _381.footer])),
      headerTemplate: _nullishCoalesce(_optionalChain([options, 'optionalAccess', _382 => _382.header]), () => ( "<div></div>")),
      footerTemplate: _nullishCoalesce(_optionalChain([options, 'optionalAccess', _383 => _383.footer]), () => ( '<div style="font-size:8pt;width:100%;text-align:center;color:#777;"><span class="pageNumber"></span>/<span class="totalPages"></span></div>'))
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
function toCss(v) {
  return typeof v === "number" ? `${v}mm` : v;
}
function findChromiumPath() {
  const win = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ];
  const linux = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  const candidates = process.platform === "win32" ? win : process.platform === "darwin" ? mac : linux;
  for (const p of candidates) {
    if (p && _fs.existsSync.call(void 0, p)) return p;
  }
  return null;
}
async function markdownToPdf(markdown, options) {
  const html = renderHtml(markdown, options);
  return htmlToPdf(html, options);
}
async function blocksToPdf(blocks, options) {
  const markdown = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, blocks);
  return markdownToPdf(markdown, options);
}

// src/render/svg-render.ts


// src/render/layout.ts
function toInt32(v, fallback = 0) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n > 2147483647 ? n - 4294967296 : n;
}
function solveBoundaries(constraints, count, total) {
  const x = new Array(count + 1).fill(void 0);
  x[0] = 0;
  if (total != null && total > 0) x[count] = total;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < count + 8) {
    changed = false;
    for (const c of constraints) {
      if (c.a < 0 || c.b > count || c.a >= c.b) continue;
      const xa = x[c.a];
      const xb = x[c.b];
      if (xa != null && xb == null) {
        x[c.b] = xa + c.size;
        changed = true;
      } else if (xb != null && xa == null) {
        x[c.a] = xb - c.size;
        changed = true;
      }
    }
  }
  let i = 0;
  while (i <= count) {
    if (x[i] != null) {
      i++;
      continue;
    }
    let lo = i - 1;
    let hi = i;
    while (hi <= count && x[hi] == null) hi++;
    const loV = x[lo];
    const hiV = hi <= count ? x[hi] : loV + (hi - lo) * 1e3;
    const n = hi - lo;
    for (let k = 1; k < n; k++) x[lo + k] = loV + (hiV - loV) * k / n;
    if (hi > count) x[count] = hiV;
    i = hi;
  }
  const out = x;
  for (let k = 1; k <= count; k++) if (out[k] < out[k - 1]) out[k] = out[k - 1];
  return out;
}
function solveRowHeights(cells, rowCount) {
  const h = new Array(rowCount).fill(0);
  for (const c of cells) {
    if (c.rowSpan === 1 && c.rowAddr >= 0 && c.rowAddr < rowCount) {
      h[c.rowAddr] = Math.max(h[c.rowAddr], c.height);
    }
  }
  for (const c of cells) {
    if (c.rowSpan <= 1) continue;
    const rows = [];
    for (let r = c.rowAddr; r < Math.min(c.rowAddr + c.rowSpan, rowCount); r++) rows.push(r);
    const known = rows.reduce((s, r) => s + h[r], 0);
    const missing = rows.filter((r) => h[r] === 0);
    if (missing.length > 0 && c.height > known) {
      const each = (c.height - known) / missing.length;
      for (const r of missing) h[r] = each;
    }
  }
  for (const c of cells) {
    if (c.rowSpan === 1 && c.contentH != null && c.rowAddr >= 0 && c.rowAddr < rowCount) {
      if (c.contentH > h[c.rowAddr]) h[c.rowAddr] = c.contentH;
    }
  }
  return h;
}

// src/render/reflow.ts
var LINESEG_FLAGS = "393216";
var BASELINE_RATIO = 0.85;
function ln(el) {
  return (el.tagName || "").replace(/^[^:]+:/, "");
}
function elements(el) {
  const out = [];
  const kids2 = el.childNodes;
  if (!kids2) return out;
  for (let i = 0; i < kids2.length; i++) if (kids2[i].nodeType === 1) out.push(kids2[i]);
  return out;
}
function num2(el, attr, fallback = 0) {
  return el ? toInt32(_nullishCoalesce(el.getAttribute(attr), () => ( void 0)), fallback) : fallback;
}
function shiftParaVert(p, delta) {
  for (const lsa of elements(p)) {
    if (ln(lsa) !== "linesegarray") continue;
    for (const seg of elements(lsa)) {
      if (ln(seg) !== "lineseg") continue;
      seg.setAttribute("vertpos", String(num2(seg, "vertpos") + delta));
    }
  }
}
function pitchFor(height, geom) {
  const v = geom.lineSpacingValue;
  switch (geom.lineSpacingType) {
    case "PERCENT":
      return Math.round(height * v / 100);
    case "FIXED":
      return v > 0 ? v : Math.round(height * 1.6);
    // 고정 줄높이(HWPUNIT)
    case "AT_LEAST":
      return Math.max(v, height);
    default:
      return Math.round(height * 1.6);
  }
}
function reflowPara(p, doc, styles, areaW, startV, mode) {
  const m = buildPara(p);
  if (m.segs.length > 0) return null;
  const realIdx = [];
  let text = "";
  for (let i = 0; i < m.chars.length; i++) {
    const ch = m.chars[i].ch;
    if (ch === "") continue;
    for (let u = 0; u < ch.length; u++) realIdx.push(i);
    text += ch;
  }
  const geom = _nullishCoalesce(styles.paraGeom.get(_nullishCoalesce(m.paraPrId, () => ( ""))), () => ( DEFAULT_PARA_GEOM));
  let domChar = DEFAULT_CHAR;
  for (const c of m.chars) {
    if (c.ch !== "" && c.prId != null) {
      const st = styles.charPr.get(c.prId);
      if (st) {
        domChar = st;
        break;
      }
    }
  }
  const height = domChar.height || 1e3;
  const ratio = domChar.ratio || 100;
  const spacingPct = domChar.spacing || 0;
  const marginL = geom.marginLeft;
  const avail = Math.max(1e3, areaW - marginL - geom.marginRight);
  const firstWidth = avail;
  const contWidth = Math.max(500, avail + Math.min(0, geom.marginIntent));
  const contHorz = marginL - Math.min(0, geom.marginIntent);
  const wrap = text.length === 0 ? { lines: 1, starts: [0], lastLineWidth: 0 } : simulateWrap(text, firstWidth, contWidth, height, ratio, mode, { spacingPct });
  const pitch = pitchFor(height, geom);
  const baseline = Math.round(height * BASELINE_RATIO);
  const spacing = Math.max(0, pitch - height);
  const lsa = doc.createElement("hp:linesegarray");
  for (let li = 0; li < wrap.starts.length; li++) {
    const startReal = wrap.starts[li];
    const textpos = startReal < realIdx.length ? realIdx[startReal] : 0;
    const vertpos = startV + li * pitch;
    const isFirst = li === 0;
    const seg = doc.createElement("hp:lineseg");
    seg.setAttribute("textpos", String(textpos));
    seg.setAttribute("vertpos", String(vertpos));
    seg.setAttribute("vertsize", String(height));
    seg.setAttribute("textheight", String(height));
    seg.setAttribute("baseline", String(baseline));
    seg.setAttribute("spacing", String(spacing));
    seg.setAttribute("horzpos", String(isFirst ? marginL : contHorz));
    seg.setAttribute("horzsize", String(isFirst ? firstWidth : contWidth));
    seg.setAttribute("flags", LINESEG_FLAGS);
    lsa.appendChild(seg);
  }
  p.appendChild(lsa);
  const textBottom = startV + wrap.starts.length * pitch;
  let objBottom = startV;
  for (const o of m.objs) {
    const h = o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el)) : o.height;
    objBottom = Math.max(objBottom, startV + h);
  }
  return { paraBottom: Math.max(textBottom, objBottom), spaceAfter: geom.spaceAfter };
}
function reflowTablesIn(p, doc, styles, mode, counter) {
  for (const run of elements(p)) {
    if (ln(run) !== "run") continue;
    for (const obj of elements(run)) {
      if (ln(obj) !== "tbl") continue;
      for (const tr of elements(obj)) {
        if (ln(tr) !== "tr") continue;
        for (const tc of elements(tr)) {
          if (ln(tc) !== "tc") continue;
          const csz = findChildByLocalName(tc, "cellSz");
          const cm = findChildByLocalName(tc, "cellMargin");
          const cellW = num2(csz, "width");
          const mL = cm ? num2(cm, "left", 141) : 141;
          const mR = cm ? num2(cm, "right", 141) : 141;
          const areaW = Math.max(500, cellW - mL - mR);
          const sub = findChildByLocalName(tc, "subList");
          if (sub) reflowBlockFlow(sub, doc, styles, areaW, mode, counter, 0);
        }
      }
    }
  }
}
function reflowBlockFlow(container, doc, styles, areaW, mode, counter, bodyH) {
  let cursorV = 0;
  let prevSpaceAfter = 0;
  for (const p of elements(container)) {
    if (ln(p) !== "p") continue;
    reflowTablesIn(p, doc, styles, mode, counter);
    const g = styles.paraGeom.get(_nullishCoalesce(p.getAttribute("paraPrIDRef"), () => ( "")));
    const startV = cursorV + prevSpaceAfter + (_nullishCoalesce(_optionalChain([g, 'optionalAccess', _384 => _384.spaceBefore]), () => ( 0)));
    const res = reflowPara(p, doc, styles, areaW, startV, mode);
    if (res) {
      const paraH = res.paraBottom - startV;
      if (bodyH > 0 && startV > 0 && res.paraBottom > bodyH && paraH <= bodyH) {
        shiftParaVert(p, -startV);
        cursorV = paraH;
      } else {
        cursorV = res.paraBottom;
      }
      prevSpaceAfter = res.spaceAfter;
      counter.n++;
    }
  }
}
function reflowSection(root, styles, geom, mode = "keep") {
  const doc = root.ownerDocument;
  const counter = { n: 0 };
  reflowBlockFlow(root, doc, styles, geom.BODY_W, mode, counter, geom.BODY_H);
  return counter.n;
}

// src/render/svg-render.ts
function ln2(el) {
  return (el.tagName || "").replace(/^[^:]+:/, "");
}
function elements2(el) {
  const out = [];
  const children = el.childNodes;
  if (!children) return out;
  for (let i = 0; i < children.length; i++) {
    if (children[i].nodeType === 1) out.push(children[i]);
  }
  return out;
}
function num3(el, attr, fallback = 0) {
  return el ? toInt32(_nullishCoalesce(el.getAttribute(attr), () => ( void 0)), fallback) : fallback;
}
function findFirst(el, name, depth = 0) {
  if (depth > 64) return null;
  for (const ch of elements2(el)) {
    if (ln2(ch) === name) return ch;
    const found = findFirst(ch, name, depth + 1);
    if (found) return found;
  }
  return null;
}
function escapeXml3(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var OBJ_TAGS = /* @__PURE__ */ new Set(["tbl", "pic", "container", "equation", "rect", "ellipse", "polygon", "curv", "line", "arc", "ole", "textart"]);
var pt = (u) => String(Math.round(u) / 100);
function emit(ctx, s) {
  ctx.pages[ctx.page].push(s);
}
function warnOnce(ctx, key, msg2) {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  ctx.warnings.push(msg2);
}
var CHAR_CTRL_1SLOT = /* @__PURE__ */ new Set(["lineBreak", "hyphen", "nbSpace", "fwSpace"]);
function pushFillers(chars, n, prId) {
  for (let i = 0; i < n; i++) chars.push({ ch: "", prId });
}
function pushTextSlots(t, chars, prId, depth) {
  if (depth > 32) return;
  const kids2 = t.childNodes;
  if (!kids2) return;
  for (let i = 0; i < kids2.length; i++) {
    const c = kids2[i];
    if (c.nodeType === 3) {
      for (const cp of _nullishCoalesce(c.textContent, () => ( ""))) {
        chars.push({ ch: cp, prId });
        if (cp.length === 2) chars.push({ ch: "", prId });
      }
    } else if (c.nodeType === 1) {
      const el = c;
      const tag = ln2(el);
      if (tag === "tab") {
        pushFillers(chars, 8, prId);
      } else if (CHAR_CTRL_1SLOT.has(tag)) {
        chars.push({ ch: tag === "nbSpace" || tag === "fwSpace" ? " " : "", prId });
      } else {
        pushTextSlots(el, chars, prId, depth + 1);
      }
    }
  }
}
function buildPara(p) {
  const chars = [];
  const objs = [];
  let segs = [];
  for (const runEl of elements2(p)) {
    const tag = ln2(runEl);
    if (tag === "run") {
      const prId = runEl.getAttribute("charPrIDRef");
      for (const ch of elements2(runEl)) {
        const cn = ln2(ch);
        if (cn === "t") {
          pushTextSlots(ch, chars, prId, 0);
        } else if (OBJ_TAGS.has(cn)) {
          const sz = findChildByLocalName(ch, "sz");
          const pos = findChildByLocalName(ch, "pos");
          const w = num3(sz, "width") || num3(findChildByLocalName(ch, "curSz"), "width") || num3(findChildByLocalName(ch, "orgSz"), "width");
          const h = num3(sz, "height") || num3(findChildByLocalName(ch, "curSz"), "height") || num3(findChildByLocalName(ch, "orgSz"), "height");
          objs.push({
            el: ch,
            tag: cn,
            index: chars.length,
            inline: _optionalChain([pos, 'optionalAccess', _385 => _385.getAttribute, 'call', _386 => _386("treatAsChar")]) === "1",
            width: w,
            height: h
          });
          pushFillers(chars, 8, prId);
        } else {
          pushFillers(chars, 8, prId);
        }
      }
    } else if (tag === "linesegarray") {
      segs = elements2(runEl).filter((s) => ln2(s) === "lineseg").map((s) => ({
        textpos: num3(s, "textpos"),
        vertpos: num3(s, "vertpos"),
        horzpos: num3(s, "horzpos"),
        horzsize: num3(s, "horzsize"),
        textheight: num3(s, "textheight", 1e3),
        baseline: num3(s, "baseline", 850)
      }));
    }
  }
  return { chars, segs, objs, paraPrId: p.getAttribute("paraPrIDRef") };
}
function charW(c, styles) {
  const st = _nullishCoalesce((c.prId != null ? styles.charPr.get(c.prId) : void 0), () => ( DEFAULT_CHAR));
  return measureTextWidth(c.ch, st.height, st.ratio, { spacingPct: st.spacing });
}
function lineNaturalWidth(m, styles, start, end) {
  let text = 0;
  for (let i = start; i < end && i < m.chars.length; i++) text += charW(m.chars[i], styles);
  let obj = 0;
  for (const o of m.objs) if (o.inline && o.index >= start && o.index < end) obj += o.width;
  return { text, obj };
}
function planLines(m, styles) {
  const align = _nullishCoalesce((m.paraPrId != null ? styles.paraAlign.get(m.paraPrId) : void 0), () => ( "JUSTIFY"));
  const plans = [];
  for (let i = 0; i < m.segs.length; i++) {
    const seg = m.segs[i];
    const start = seg.textpos;
    const end = i + 1 < m.segs.length ? m.segs[i + 1].textpos : Math.max(m.chars.length, start);
    const nat = lineNaturalWidth(m, styles, start, end);
    const isLast = i === m.segs.length - 1;
    let xoff = 0;
    let scale = 1;
    const avail = seg.horzsize - nat.obj;
    if (nat.text > 0 && (!isLast || align === "DISTRIBUTE" || align === "DISTRIBUTE_SPACE")) {
      scale = avail > 0 ? avail / nat.text : 1;
    } else if (nat.text + nat.obj > 0 && isLast) {
      const w = nat.text + nat.obj;
      if (align === "CENTER") xoff = Math.max(0, (seg.horzsize - w) / 2);
      else if (align === "RIGHT") xoff = Math.max(0, seg.horzsize - w);
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    scale = Math.min(4, Math.max(0.25, scale));
    plans.push({ seg, xoff, scale, start, end });
  }
  return plans;
}
function advanceTo(m, styles, plan, upto) {
  let x = 0;
  for (let i = plan.start; i < upto && i < m.chars.length; i++) x += charW(m.chars[i], styles) * plan.scale;
  for (const o of m.objs) if (o.inline && o.index >= plan.start && o.index < upto) x += o.width;
  return x;
}
function drawPara(p, ox, oy, areaW, ctx, depth, segPages) {
  if (depth > 16) {
    warnOnce(ctx, "depth", "\uC911\uCCA9 \uAE4A\uC774 16 \uCD08\uACFC \u2014 \uC774\uD558 \uC0DD\uB7B5");
    return;
  }
  const m = buildPara(p);
  if (m.segs.length === 0) {
    if (m.chars.some((c) => c.ch !== "")) {
      warnOnce(ctx, "no-lineseg", "\uC870\uD310 \uCE90\uC2DC \uC5C6\uB294 \uBB38\uB2E8 \uD14D\uC2A4\uD2B8 \uC0DD\uB7B5 \u2014 reflow \uC635\uC158\uC73C\uB85C \uD569\uC131 \uAC00\uB2A5");
    }
    for (const o of m.objs) drawObject(o, ox, oy, 0, areaW, ctx, depth);
    return;
  }
  const plans = planLines(m, ctx.styles);
  const baseV = m.segs[0].vertpos;
  for (let li = 0; li < plans.length; li++) {
    const plan = plans[li];
    if (segPages && segPages[li] !== void 0) ctx.page = segPages[li];
    const { seg } = plan;
    let i = plan.start;
    let cursor = ox + seg.horzpos + plan.xoff;
    const y = oy + seg.vertpos + seg.baseline;
    while (i < plan.end && i < m.chars.length) {
      if (m.chars[i].ch === "") {
        for (const o of m.objs) if (o.inline && o.index === i) cursor += o.width;
        i++;
        continue;
      }
      const prId = m.chars[i].prId;
      let j = i;
      let piece = "";
      while (j < plan.end && j < m.chars.length && m.chars[j].prId === prId && m.chars[j].ch !== "") {
        piece += m.chars[j].ch;
        j++;
      }
      {
        const cut = piece.search(/ {2,}/);
        if (cut > 0) {
          piece = piece.slice(0, cut);
          j = i + cut;
        } else if (cut === 0) {
          const runEnd = piece.match(/^ +/)[0].length;
          piece = piece.slice(0, runEnd);
          j = i + runEnd;
        }
      }
      const st = _nullishCoalesce((prId != null ? ctx.styles.charPr.get(prId) : void 0), () => ( DEFAULT_CHAR));
      const renderSeg = (text, cx, hit) => {
        const sw = measureTextWidth(text, st.height, st.ratio, { spacingPct: st.spacing }) * plan.scale;
        if (hit) {
          emit(ctx, `<rect x="${pt(cx)}" y="${pt(oy + seg.vertpos)}" width="${pt(sw)}" height="${pt(seg.textheight)}" fill="#ffd54f" fill-opacity="0.45"/>`);
        }
        if (text.trim().length > 0) {
          const attrs = [`x="${pt(cx)}"`, `y="${pt(y)}"`, `font-size="${pt(st.height)}"`];
          if (st.fontFamily) attrs.push(`font-family="${st.fontFamily}"`);
          if ([...text].length > 1 && sw > 50) {
            attrs.push(`textLength="${pt(sw)}"`, `lengthAdjust="${plan.scale < 1 ? "spacingAndGlyphs" : "spacing"}"`);
          }
          if (st.bold) attrs.push(`font-weight="bold"`);
          if (st.italic) attrs.push(`font-style="italic"`);
          if (st.underline) attrs.push(`text-decoration="underline"`);
          if (st.color) attrs.push(`fill="${escapeXml3(st.color)}"`);
          emit(ctx, `<text ${attrs.join(" ")}>${escapeXml3(text)}</text>`);
          ctx.stats.texts++;
        }
        return sw;
      };
      const merged = [];
      if (ctx.highlights.length > 0 && piece.trim().length > 0) {
        const found = [];
        const lower = piece.toLowerCase();
        for (const term of ctx.highlights) {
          for (let f = lower.indexOf(term); f !== -1; f = lower.indexOf(term, f + term.length)) {
            found.push([f, f + term.length]);
          }
        }
        found.sort((a, b) => a[0] - b[0]);
        for (const [s, e] of found) {
          const tail = merged[merged.length - 1];
          if (tail && s <= tail[1]) tail[1] = Math.max(tail[1], e);
          else merged.push([s, e]);
        }
      }
      if (merged.length === 0) {
        cursor += renderSeg(piece, cursor, false);
      } else {
        let segCur = cursor;
        let last = 0;
        for (const [s, e] of merged) {
          segCur += renderSeg(piece.slice(last, s), segCur, false);
          segCur += renderSeg(piece.slice(s, e), segCur, true);
          last = e;
        }
        segCur += renderSeg(piece.slice(last), segCur, false);
        cursor = segCur;
      }
      i = j;
    }
  }
  for (const o of m.objs) {
    if (o.inline) {
      let planIdx = 0;
      for (let k = 0; k < plans.length; k++) {
        const pl = plans[k];
        if (pl.start <= o.index && (o.index < pl.end || k === plans.length - 1)) planIdx = k;
      }
      const plan = plans[planIdx];
      if (segPages && segPages[planIdx] !== void 0) ctx.page = segPages[planIdx];
      const x = ox + plan.seg.horzpos + plan.xoff + advanceTo(m, ctx.styles, plan, o.index);
      const yTop = oy + plan.seg.vertpos + Math.max(0, plan.seg.baseline - o.height);
      drawObject(o, x, yTop, baseV, areaW, ctx, depth);
    } else {
      if (segPages && segPages[0] !== void 0) ctx.page = segPages[0];
      const { x, y } = anchorObject(o, ox, oy, baseV, areaW, ctx);
      drawObject(o, x, y, baseV, areaW, ctx, depth);
    }
  }
}
function anchorObject(o, ox, oy, baseV, areaW, ctx) {
  const { PW, PH, ML, MT, BODY_W, BODY_H } = ctx.geom;
  const pos = findChildByLocalName(o.el, "pos");
  const om = findChildByLocalName(o.el, "outMargin");
  const omT = num3(om, "top"), omB = num3(om, "bottom");
  const w = o.width, h = o.height;
  if (!pos) return { x: ox, y: oy + baseV };
  const vo = num3(pos, "vertOffset");
  const ho = num3(pos, "horzOffset");
  const vrel = _nullishCoalesce(pos.getAttribute("vertRelTo"), () => ( "PARA"));
  const hrel = _nullishCoalesce(pos.getAttribute("horzRelTo"), () => ( "PARA"));
  const va = _nullishCoalesce(pos.getAttribute("vertAlign"), () => ( "TOP"));
  const ha = _nullishCoalesce(pos.getAttribute("horzAlign"), () => ( "LEFT"));
  const wrap = _nullishCoalesce(o.el.getAttribute("textWrap"), () => ( "TOP_AND_BOTTOM"));
  let y;
  if (vrel === "PAPER") {
    y = va === "BOTTOM" ? PH - h - vo : va === "CENTER" ? (PH - h) / 2 + vo : vo;
  } else if (vrel === "PAGE") {
    y = va === "BOTTOM" ? MT + BODY_H - h - vo : va === "CENTER" ? MT + (BODY_H - h) / 2 + vo : MT + vo;
  } else if (wrap === "TOP_AND_BOTTOM") {
    const pushed = baseV - (omT + h + omB);
    const anchor = pushed >= -100 ? pushed : baseV;
    y = oy + anchor + omT + vo;
  } else {
    y = oy + baseV + vo;
  }
  let x;
  if (hrel === "PAGE") {
    x = ha === "RIGHT" ? ML + BODY_W - w - ho : ha === "CENTER" ? ML + (BODY_W - w) / 2 + ho : ML + ho;
  } else if (hrel === "PAPER") {
    x = ha === "RIGHT" ? PW - w - ho : ha === "CENTER" ? (PW - w) / 2 + ho : ho;
  } else {
    x = ha === "RIGHT" ? ox + areaW - w - ho : ha === "CENTER" ? ox + (areaW - w) / 2 + ho : ox + ho;
  }
  return { x, y };
}
function drawObject(o, x, y, baseV, areaW, ctx, depth) {
  if (o.tag === "tbl") drawTable(o.el, x, y, ctx, depth + 1);
  else if (o.tag === "pic") drawPic(o.el, x, y, ctx);
  else if (o.tag === "container") {
    for (const ch of elements2(o.el)) {
      const tag = ln2(ch);
      if (!OBJ_TAGS.has(tag)) continue;
      const sz = findChildByLocalName(ch, "sz");
      const off = findChildByLocalName(ch, "offset");
      const sub = { el: ch, tag, index: 0, inline: true, width: num3(sz, "width"), height: num3(sz, "height") };
      drawObject(sub, x + num3(off, "x"), y + num3(off, "y"), baseV, areaW, ctx, depth + 1);
    }
  } else if (o.tag === "equation") {
    warnOnce(ctx, "equation", "\uC218\uC2DD \uAC1C\uCCB4\uB294 \uB80C\uB354 \uBBF8\uC9C0\uC6D0 \u2014 \uC0DD\uB7B5");
  } else if (SHAPE_TAGS.has(o.tag)) {
    drawShape(o, x, y, ctx, depth);
  } else {
    warnOnce(ctx, `shape:${o.tag}`, `\uAC1C\uCCB4(${o.tag}) \uB80C\uB354 \uBBF8\uC9C0\uC6D0 \u2014 \uC0DD\uB7B5`);
  }
}
var SHAPE_TAGS = /* @__PURE__ */ new Set(["rect", "ellipse", "line", "polygon", "curv", "arc"]);
function shapeStrokePt(v) {
  return Math.max(0.2, v / 100 * 2.834645);
}
function drawShape(o, x, y, ctx, depth) {
  const el = o.el;
  const orgSz = findChildByLocalName(el, "orgSz");
  const curSz = findChildByLocalName(el, "curSz");
  const ow = num3(orgSz, "width"), oh = num3(orgSz, "height");
  const w = num3(curSz, "width") || ow || o.width;
  const h = num3(curSz, "height") || oh || o.height;
  const sx = ow > 0 ? w / ow : 1;
  const sy = oh > 0 ? h / oh : 1;
  const lineShape = findChildByLocalName(el, "lineShape");
  const lstyle = _nullishCoalesce(_optionalChain([lineShape, 'optionalAccess', _387 => _387.getAttribute, 'call', _388 => _388("style")]), () => ( "SOLID"));
  const strokeCol = _optionalChain([lineShape, 'optionalAccess', _389 => _389.getAttribute, 'call', _390 => _390("color")]) || "#000000";
  const hasStroke = lstyle !== "NONE";
  const strokeW = hasStroke ? shapeStrokePt(lineShape ? num3(lineShape, "width") : 33) : 0;
  const dash = /DASH|DOT/.test(lstyle) ? ` stroke-dasharray="${lstyle.includes("DOT") ? "1,1.5" : "3,1.5"}"` : "";
  const strokeAttr = hasStroke ? ` stroke="${escapeXml3(strokeCol)}" stroke-width="${strokeW.toFixed(2)}"${dash}` : "";
  const fillBrush = findChildByLocalName(el, "fillBrush");
  const winBrush = fillBrush ? findChildByLocalName(fillBrush, "winBrush") : null;
  const face = _optionalChain([winBrush, 'optionalAccess', _391 => _391.getAttribute, 'call', _392 => _392("faceColor")]);
  const fill = face && face.toLowerCase() !== "none" ? face : "none";
  const fillAttr = ` fill="${fill === "none" ? "none" : escapeXml3(fill)}"`;
  if (o.tag === "rect") {
    emit(ctx, `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}"${fillAttr}${strokeAttr}/>`);
  } else if (o.tag === "ellipse") {
    emit(ctx, `<ellipse cx="${pt(x + w / 2)}" cy="${pt(y + h / 2)}" rx="${pt(w / 2)}" ry="${pt(h / 2)}"${fillAttr}${strokeAttr}/>`);
  } else if (o.tag === "line") {
    const s = findChildByLocalName(el, "startPt"), e = findChildByLocalName(el, "endPt");
    const x1 = x + num3(s, "x") * sx, y1 = y + num3(s, "y") * sy;
    const x2 = x + num3(e, "x") * sx, y2 = y + num3(e, "y") * sy;
    emit(ctx, `<line x1="${pt(x1)}" y1="${pt(y1)}" x2="${pt(x2)}" y2="${pt(y2)}" stroke="${escapeXml3(strokeCol)}" stroke-width="${(strokeW || 0.3).toFixed(2)}"${dash}/>`);
  } else if (o.tag === "polygon" || o.tag === "curv") {
    const pts = [];
    for (const c of elements2(el)) if (ln2(c) === "pt") pts.push(`${pt(x + num3(c, "x") * sx)},${pt(y + num3(c, "y") * sy)}`);
    if (pts.length >= 2) emit(ctx, `<polygon points="${pts.join(" ")}"${fillAttr}${strokeAttr}/>`);
  } else if (o.tag === "arc") {
    emit(ctx, `<ellipse cx="${pt(x + w / 2)}" cy="${pt(y + h / 2)}" rx="${pt(w / 2)}" ry="${pt(h / 2)}" fill="none"${strokeAttr || ` stroke="${escapeXml3(strokeCol)}" stroke-width="0.3"`}/>`);
  }
  const dt = findChildByLocalName(el, "drawText");
  const sub = dt ? findChildByLocalName(dt, "subList") : null;
  if (sub) {
    for (const p of elements2(sub)) if (ln2(p) === "p") drawPara(p, x, y, w, ctx, depth + 1);
  }
}
function cellContentExtent(cell) {
  if (!cell.sub) return 0;
  let ext = 0;
  for (const p of elements2(cell.sub)) {
    if (ln2(p) !== "p") continue;
    const m = buildPara(p);
    for (const s of m.segs) ext = Math.max(ext, s.vertpos + s.textheight);
    const baseV = _nullishCoalesce(_optionalChain([m, 'access', _393 => _393.segs, 'access', _394 => _394[0], 'optionalAccess', _395 => _395.vertpos]), () => ( 0));
    for (const o of m.objs) {
      if (o.inline) {
        const h = o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el)) : o.height;
        ext = Math.max(ext, baseV + h);
        continue;
      }
      const pos = findChildByLocalName(o.el, "pos");
      if ((_nullishCoalesce(_optionalChain([pos, 'optionalAccess', _396 => _396.getAttribute, 'call', _397 => _397("vertRelTo")]), () => ( "PARA"))) !== "PARA") continue;
      const om = findChildByLocalName(o.el, "outMargin");
      const pushed = baseV - (num3(om, "top") + o.height + num3(om, "bottom"));
      const anchor = pushed >= -100 ? pushed : baseV;
      ext = Math.max(ext, anchor + num3(om, "top") + num3(pos, "vertOffset") + o.height);
    }
  }
  return ext;
}
function edgeLine(x1, y1, x2, y2, e) {
  const dash = /DASH|DOT/.test(e.type) ? ` stroke-dasharray="${e.type.includes("DOT") ? "1,1.5" : "3,1.5"}"` : "";
  return `<line x1="${pt(x1)}" y1="${pt(y1)}" x2="${pt(x2)}" y2="${pt(y2)}" stroke="${escapeXml3(e.color)}" stroke-width="${e.widthPt.toFixed(2)}"${dash}/>`;
}
function collectCells(tbl) {
  const inMargin = findChildByLocalName(tbl, "inMargin");
  const defL = num3(inMargin, "left", 141), defR = num3(inMargin, "right", 141);
  const defT = num3(inMargin, "top", 141), defB = num3(inMargin, "bottom", 141);
  const cells = [];
  for (const tr of elements2(tbl)) {
    if (ln2(tr) !== "tr") continue;
    for (const tc of elements2(tr)) {
      if (ln2(tc) !== "tc") continue;
      const addr = findChildByLocalName(tc, "cellAddr");
      const span = findChildByLocalName(tc, "cellSpan");
      const csz = findChildByLocalName(tc, "cellSz");
      const cm = findChildByLocalName(tc, "cellMargin");
      if (!addr || !csz) continue;
      cells.push({
        el: tc,
        ca: num3(addr, "colAddr"),
        ra: num3(addr, "rowAddr"),
        cs: Math.max(1, num3(span, "colSpan", 1)),
        rs: Math.max(1, num3(span, "rowSpan", 1)),
        w: num3(csz, "width"),
        h: num3(csz, "height"),
        bfId: tc.getAttribute("borderFillIDRef"),
        sub: findChildByLocalName(tc, "subList"),
        marginL: cm ? num3(cm, "left", defL) : defL,
        marginR: cm ? num3(cm, "right", defR) : defR,
        marginT: cm ? num3(cm, "top", defT) : defT,
        marginB: cm ? num3(cm, "bottom", defB) : defB
      });
    }
  }
  return cells;
}
function measureTableHeight(tbl) {
  const cells = collectCells(tbl);
  if (cells.length === 0 || cells.length > 4096) return 0;
  const nRows = Math.max(...cells.map((c) => c.ra + c.rs));
  const rowH = solveRowHeights(
    cells.map((c) => ({ rowAddr: c.ra, rowSpan: c.rs, height: c.h, contentH: c.rs === 1 ? cellContentExtent(c) : void 0 })),
    nRows
  );
  let sum = 0;
  for (const h of rowH) sum += h;
  return sum;
}
function drawTable(tbl, tx, ty, ctx, depth) {
  if (depth > 16) {
    warnOnce(ctx, "depth", "\uC911\uCCA9 \uAE4A\uC774 16 \uCD08\uACFC \u2014 \uC774\uD558 \uC0DD\uB7B5");
    return;
  }
  ctx.stats.tables++;
  const tblSz = findChildByLocalName(tbl, "sz");
  const cells = collectCells(tbl);
  if (cells.length === 0 || cells.length > 4096) return;
  const nCols = Math.max(...cells.map((c) => c.ca + c.cs));
  const nRows = Math.max(...cells.map((c) => c.ra + c.rs));
  const colCons = cells.map((c) => ({ a: c.ca, b: c.ca + c.cs, size: c.w }));
  const colX = solveBoundaries(colCons, nCols, num3(tblSz, "width") || void 0);
  const rowH = solveRowHeights(
    cells.map((c) => ({ rowAddr: c.ra, rowSpan: c.rs, height: c.h, contentH: c.rs === 1 ? cellContentExtent(c) : void 0 })),
    nRows
  );
  const rowY = [0];
  for (let r = 0; r < nRows; r++) rowY.push(rowY[r] + rowH[r]);
  const geom = cells.map((c) => ({
    c,
    x: tx + colX[c.ca],
    y: ty + rowY[c.ra],
    w: colX[Math.min(c.ca + c.cs, nCols)] - colX[c.ca],
    h: rowY[Math.min(c.ra + c.rs, nRows)] - rowY[c.ra]
  }));
  for (const g of geom) {
    const bf = g.c.bfId != null ? ctx.styles.borderFill.get(g.c.bfId) : void 0;
    if (_optionalChain([bf, 'optionalAccess', _398 => _398.fill])) emit(ctx, `<rect x="${pt(g.x)}" y="${pt(g.y)}" width="${pt(g.w)}" height="${pt(g.h)}" fill="${escapeXml3(bf.fill)}"/>`);
  }
  for (const g of geom) {
    const { c } = g;
    if (!c.sub) continue;
    const innerH = g.h - c.marginT - c.marginB;
    const extent = cellContentExtent(c);
    const va = _nullishCoalesce(c.sub.getAttribute("vertAlign"), () => ( "TOP"));
    let yoff = 0;
    if (va === "CENTER") yoff = Math.max(0, (innerH - extent) / 2);
    else if (va === "BOTTOM") yoff = Math.max(0, innerH - extent);
    for (const p of elements2(c.sub)) {
      if (ln2(p) !== "p") continue;
      drawPara(p, g.x + c.marginL, g.y + c.marginT + yoff, g.w - c.marginL - c.marginR, ctx, depth + 1);
    }
  }
  for (const g of geom) {
    const bf = g.c.bfId != null ? ctx.styles.borderFill.get(g.c.bfId) : void 0;
    if (!bf) continue;
    if (bf.top) emit(ctx, edgeLine(g.x, g.y, g.x + g.w, g.y, bf.top));
    if (bf.bottom) emit(ctx, edgeLine(g.x, g.y + g.h, g.x + g.w, g.y + g.h, bf.bottom));
    if (bf.left) emit(ctx, edgeLine(g.x, g.y, g.x, g.y + g.h, bf.left));
    if (bf.right) emit(ctx, edgeLine(g.x + g.w, g.y, g.x + g.w, g.y + g.h, bf.right));
  }
}
function imageSymbol(loaded, ctx) {
  if (!loaded.symId) {
    loaded.symId = `bin${ctx.defs.length}`;
    ctx.defs.push(
      `<symbol id="${loaded.symId}" viewBox="0 0 100 100" preserveAspectRatio="none"><image width="100" height="100" preserveAspectRatio="none" href="${loaded.dataUri}"/></symbol>`
    );
  }
  return loaded.symId;
}
function drawPic(pic, x, y, ctx) {
  const sz = findChildByLocalName(pic, "sz");
  const w = num3(sz, "width", 5669), h = num3(sz, "height", 5669);
  const img = findFirst(pic, "img");
  const ref = _optionalChain([img, 'optionalAccess', _399 => _399.getAttribute, 'call', _400 => _400("binaryItemIDRef")]);
  const loaded = ref != null ? ctx.images.get(ref) : void 0;
  if (!loaded) {
    emit(ctx, `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}" fill="#eee" stroke="#c00" stroke-width="0.5"/>`);
    warnOnce(ctx, `img:${ref}`, `\uC774\uBBF8\uC9C0 \uBC14\uC774\uB108\uB9AC \uB204\uB77D: ${_nullishCoalesce(ref, () => ( "(ref \uC5C6\uC74C)"))}`);
    return;
  }
  ctx.stats.images++;
  const clip = findChildByLocalName(pic, "imgClip");
  const imgDim = findChildByLocalName(pic, "imgDim");
  const orgSz = findChildByLocalName(pic, "orgSz");
  const dimW = num3(imgDim, "dimwidth"), dimH = num3(imgDim, "dimheight");
  const refW = dimW > 0 ? dimW : num3(orgSz, "width");
  const refH = dimH > 0 ? dimH : num3(orgSz, "height");
  const cl = num3(clip, "left"), ct = num3(clip, "top");
  const cr = num3(clip, "right", refW), cb = num3(clip, "bottom", refH);
  const cropped = refW > 0 && refH > 0 && clip != null && (cl > 0 || ct > 0 || cr < refW || cb < refH) && cr > cl && cb > ct;
  const symId = imageSymbol(loaded, ctx);
  if (cropped) {
    emit(
      ctx,
      `<svg x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}" viewBox="${pt(cl)} ${pt(ct)} ${pt(cr - cl)} ${pt(cb - ct)}" preserveAspectRatio="none"><use href="#${symId}" x="0" y="0" width="${pt(refW)}" height="${pt(refH)}"/></svg>`
    );
  } else {
    emit(ctx, `<use href="#${symId}" x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}"/>`);
  }
}
function sniffMime(name, bytes) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png") || bytes.length > 4 && bytes[0] === 137 && bytes[1] === 80) return "image/png";
  if (lower.endsWith(".bmp") || bytes.length > 2 && bytes[0] === 66 && bytes[1] === 77) return "image/bmp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}
function readSectionGeom(root) {
  const pagePr = findFirst(root, "pagePr");
  const margin = pagePr ? findChildByLocalName(pagePr, "margin") : null;
  let PW = num3(pagePr, "width", 59528), PH = num3(pagePr, "height", 84188);
  if (_optionalChain([pagePr, 'optionalAccess', _401 => _401.getAttribute, 'call', _402 => _402("landscape")]) === "NARROWLY" && PW < PH) {
    const t = PW;
    PW = PH;
    PH = t;
  }
  const ML = num3(margin, "left", 8504);
  const MT = num3(margin, "top", 5668) + num3(margin, "header", 0);
  const BODY_H = PH - MT - num3(margin, "bottom", 4252) - num3(margin, "footer", 0);
  const BODY_W = PW - ML - num3(margin, "right", 8504);
  return { PW, PH, ML, MT, BODY_W, BODY_H };
}
function renderSectionToPages(root, geom, ctxBase, hasCache, reflowMode) {
  const { PW, PH, ML, MT, BODY_W, BODY_H } = geom;
  if (!hasCache) reflowSection(root, ctxBase.styles, { BODY_W, BODY_H }, reflowMode);
  const colPr = findFirst(root, "colPr");
  const multiCol = num3(colPr, "colCount", 1) > 1;
  const paraSegPages = /* @__PURE__ */ new Map();
  let nPages = 1;
  let maxTopV = 0;
  {
    let prevV = Number.NEGATIVE_INFINITY;
    let prevH = Number.NEGATIVE_INFINITY;
    let cur = 0;
    for (const p of elements2(root)) {
      if (ln2(p) !== "p") continue;
      const lsa = findChildByLocalName(p, "linesegarray");
      const segEls = lsa ? elements2(lsa).filter((s) => ln2(s) === "lineseg") : [];
      const pagesOf = [];
      let paraFirst = true;
      for (const s of segEls) {
        const v = num3(s, "vertpos");
        const h = num3(s, "horzpos");
        const brk = v < prevV ? !multiCol || h <= prevH : paraFirst && v === prevV && h <= prevH;
        if (brk) cur++;
        paraFirst = false;
        pagesOf.push(cur);
        maxTopV = Math.max(maxTopV, v + num3(s, "textheight", 1e3));
        prevV = v;
        prevH = h;
      }
      paraSegPages.set(p, pagesOf);
      nPages = Math.max(nPages, cur + 1);
    }
  }
  const ctx = {
    ...ctxBase,
    pages: Array.from({ length: nPages }, () => []),
    page: 0,
    geom
  };
  for (const p of elements2(root)) {
    if (ln2(p) !== "p") continue;
    drawPara(p, ML, MT, BODY_W, ctx, 0, paraSegPages.get(p));
  }
  const pageH = nPages === 1 ? Math.max(PH, MT + maxTopV + 2e3) : PH;
  return { pages: ctx.pages, pageH };
}
async function renderHwpxToSvg(input, options) {
  const maxImg = _nullishCoalesce(_optionalChain([options, 'optionalAccess', _403 => _403.maxImageBytes]), () => ( 40 * 1024 * 1024));
  const ab = input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input;
  _chunkR2H34FY5cjs.precheckZipSize.call(void 0, ab, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES);
  let zip;
  try {
    zip = await _jszip2.default.loadAsync(input);
  } catch (e31) {
    throw new (0, _chunkR2H34FY5cjs.KordocError)("HWPX(ZIP) \uD615\uC2DD\uC774 \uC544\uB2D9\uB2C8\uB2E4 \u2014 \uB80C\uB354\uB294 HWPX\uB9CC \uC9C0\uC6D0");
  }
  const secFiles = zip.file(/Contents\/section\d+\.xml$/i).sort((a, b) => a.name.localeCompare(b.name));
  if (secFiles.length === 0) throw new (0, _chunkR2H34FY5cjs.KordocError)("Contents/section0.xml \uC5C6\uC74C \u2014 HWPX\uAC00 \uC544\uB2C8\uAC70\uB098 \uC190\uC0C1\uB428");
  const warnings = [];
  const headFile = _nullishCoalesce(zip.file("Contents/header.xml"), () => ( zip.file("Contents/head.xml")));
  const styles = headFile ? parseRenderStyles(await headFile.async("string")) : { charPr: /* @__PURE__ */ new Map(), paraAlign: /* @__PURE__ */ new Map(), paraGeom: /* @__PURE__ */ new Map(), borderFill: /* @__PURE__ */ new Map() };
  if (!headFile) warnings.push("header.xml \uC5C6\uC74C \u2014 \uAE30\uBCF8 \uC2A4\uD0C0\uC77C\uB85C \uB80C\uB354");
  const secXmls = [];
  for (const f of secFiles) {
    const xml = await f.async("string");
    if (xml.length > MAX_DECOMPRESS_SIZE) throw new (0, _chunkR2H34FY5cjs.KordocError)("\uC139\uC158 XML\uC774 \uD5C8\uC6A9 \uD06C\uAE30\uB97C \uCD08\uACFC");
    secXmls.push(xml);
  }
  const binmap = /* @__PURE__ */ new Map();
  const hpf = zip.file(/content\.hpf$/i)[0];
  if (hpf) {
    const man = await hpf.async("string");
    for (const m of man.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhref="(BinData\/[^"]+)"[^>]*>/g)) binmap.set(m[1], m[2]);
    for (const m of man.matchAll(/<[^>]*\bhref="(BinData\/[^"]+)"[^>]*\bid="([^"]+)"[^>]*>/g)) binmap.set(m[2], m[1]);
  }
  const MAX_IMAGE_REFS = 256;
  const MAX_TOTAL_IMAGE_BYTES = 128 * 1024 * 1024;
  const images = /* @__PURE__ */ new Map();
  const refs = /* @__PURE__ */ new Set();
  for (const xml of secXmls) for (const m of xml.matchAll(/binaryItemIDRef="([^"]+)"/g)) refs.add(m[1]);
  let totalImgBytes = 0;
  for (const ref of refs) {
    if (images.size >= MAX_IMAGE_REFS) {
      warnings.push(`\uC774\uBBF8\uC9C0 ${refs.size}\uC885 \uC911 ${MAX_IMAGE_REFS}\uC885\uB9CC \uB85C\uB529 \u2014 \uAC1C\uC218 \uD55C\uB3C4 \uCD08\uACFC\uBD84 \uC0DD\uB7B5`);
      break;
    }
    let href = binmap.get(ref);
    if (!href) {
      const cand = zip.file(new RegExp(`BinData/.*${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"))[0];
      href = _optionalChain([cand, 'optionalAccess', _404 => _404.name]);
    }
    if (!href) continue;
    const f = _nullishCoalesce(zip.file(href), () => ( zip.file("Contents/" + href)));
    if (!f) continue;
    const bytes = await f.async("uint8array");
    if (bytes.length > maxImg) {
      warnings.push(`\uC774\uBBF8\uC9C0 ${href} ${(bytes.length / 1048576).toFixed(1)}MB \u2014 \uD55C\uB3C4 \uCD08\uACFC\uB85C \uC0DD\uB7B5`);
      continue;
    }
    if (totalImgBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
      warnings.push(`\uC774\uBBF8\uC9C0 \uB204\uC801 ${Math.round(MAX_TOTAL_IMAGE_BYTES / 1048576)}MB \uD55C\uB3C4 \uCD08\uACFC \u2014 \uC774\uD6C4 \uC0DD\uB7B5`);
      break;
    }
    totalImgBytes += bytes.length;
    images.set(ref, { dataUri: `data:${sniffMime(href, bytes)};base64,${Buffer.from(bytes).toString("base64")}` });
  }
  const ctxBase = {
    styles,
    images,
    defs: [],
    highlights: (_nullishCoalesce(_optionalChain([options, 'optionalAccess', _405 => _405.highlights]), () => ( []))).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0),
    warnings,
    warned: /* @__PURE__ */ new Set(),
    stats: { texts: 0, images: 0, tables: 0 }
  };
  const rendered = [];
  let noCacheSkipped = false;
  for (let si = 0; si < secXmls.length; si++) {
    const secXml = secXmls[si];
    const hasCache = /<(?:[A-Za-z][\w.-]*:)?linesegarray[\s/>]/.test(secXml);
    if (!hasCache && !_optionalChain([options, 'optionalAccess', _406 => _406.reflow])) {
      noCacheSkipped = true;
      warnings.push(`\uAD6C\uC5ED ${si}: \uC870\uD310 \uCE90\uC2DC \uC5C6\uC74C \u2014 reflow \uC635\uC158 \uD544\uC694, \uC0DD\uB7B5`);
      continue;
    }
    const doc = createXmlParser().parseFromString(secXml, "text/xml");
    const root = doc.documentElement;
    if (!root) {
      warnings.push(`\uAD6C\uC5ED ${si} XML \uD30C\uC2F1 \uC2E4\uD328 \u2014 \uC0DD\uB7B5`);
      continue;
    }
    const geom = readSectionGeom(root);
    const { pages, pageH } = renderSectionToPages(root, geom, ctxBase, hasCache, _nullishCoalesce(_optionalChain([options, 'optionalAccess', _407 => _407.reflowMode]), () => ( "keep")));
    rendered.push({ pages, PW: geom.PW, pageH, clipId: `pgclip${si}` });
  }
  if (rendered.length === 0) {
    if (noCacheSkipped) {
      throw new (0, _chunkR2H34FY5cjs.KordocError)("\uC870\uD310 \uCE90\uC2DC(linesegarray) \uC5C6\uC74C \u2014 \uD55C\uCEF4\uC5D0\uC11C \uC800\uC7A5\uD55C HWPX\uB9CC \uB80C\uB354 \uAC00\uB2A5 (reflow \uC635\uC158\uC73C\uB85C \uD569\uC131 \uB80C\uB354 \uAC00\uB2A5)");
    }
    throw new (0, _chunkR2H34FY5cjs.KordocError)("\uB80C\uB354\uD560 \uAD6C\uC5ED\uC774 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 HWPX\uAC00 \uC190\uC0C1\uB418\uC5C8\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4");
  }
  const GAP = 2400;
  const clipDefs = [];
  const groups = [];
  let y = 0;
  let maxPW = 0;
  let pageNo = 0;
  for (const rs of rendered) {
    maxPW = Math.max(maxPW, rs.PW);
    clipDefs.push(`<clipPath id="${rs.clipId}"><rect x="0" y="0" width="${pt(rs.PW)}" height="${pt(rs.pageH)}"/></clipPath>`);
    for (const buf of rs.pages) {
      pageNo++;
      groups.push(
        `<g data-page="${pageNo}" transform="translate(0 ${pt(y)})"><rect width="${pt(rs.PW)}" height="${pt(rs.pageH)}" fill="white" stroke="#c9c7c4" stroke-width="0.75"/><g clip-path="url(#${rs.clipId})">
${buf.join("\n")}
</g></g>`
      );
      y += rs.pageH + GAP;
    }
  }
  const totalH = Math.max(0, y - GAP);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pt(maxPW)} ${pt(totalH)}" width="${pt(maxPW)}pt" height="${pt(totalH)}pt" font-family="'HCR Batang','\uD568\uCD08\uB86C\uBC14\uD0D5','Hancom Batang',AppleMyungjo,'Noto Serif CJK KR',serif" xml:space="preserve">
<defs>${clipDefs.join("")}${ctxBase.defs.join("")}</defs>
${groups.join("\n")}
</svg>`;
  return { svg, width: Math.round(maxPW) / 100, height: Math.round(totalH) / 100, pageCount: pageNo, warnings, stats: ctxBase.stats };
}

// src/index.ts
async function parse(input, options) {
  let buffer;
  const opts = typeof input === "string" && !_optionalChain([options, 'optionalAccess', _408 => _408.filePath]) ? { ...options, filePath: input } : options;
  if (typeof input === "string") {
    try {
      const buf = await _promises.readFile.call(void 0, input);
      buffer = _chunkR2H34FY5cjs.toArrayBuffer.call(void 0, buf);
    } catch (err) {
      const msg2 = err instanceof Error && "code" in err && err.code === "ENOENT" ? `\uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${input}` : `\uD30C\uC77C \uC77D\uAE30 \uC2E4\uD328: ${input}`;
      return { success: false, fileType: "unknown", error: msg2, code: "PARSE_ERROR" };
    }
  } else if (Buffer.isBuffer(input)) {
    buffer = _chunkR2H34FY5cjs.toArrayBuffer.call(void 0, input);
  } else {
    buffer = input;
  }
  if (!buffer || buffer.byteLength === 0) {
    return { success: false, fileType: "unknown", error: "\uBE48 \uBC84\uD37C\uC774\uAC70\uB098 \uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uC785\uB825\uC785\uB2C8\uB2E4.", code: "EMPTY_INPUT" };
  }
  const format = detectFormat(buffer);
  switch (format) {
    case "hwpx": {
      const zipFormat = await detectZipFormat(buffer);
      if (zipFormat === "xlsx") return parseXlsx(buffer, opts);
      if (zipFormat === "docx") return parseDocx(buffer, opts);
      return parseHwpx(buffer, opts);
    }
    case "hwp": {
      const ole2Format = detectOle2Format(buffer);
      if (ole2Format === "xls") return parseXls(buffer, opts);
      return parseHwp(buffer, opts);
    }
    case "hwp3":
      return parseHwp3(buffer, opts);
    case "hwpml":
      return parseHwpml(buffer, opts);
    case "pdf":
      return parsePdf(buffer, opts);
    default:
      return { success: false, fileType: "unknown", error: "\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD30C\uC77C \uD615\uC2DD\uC785\uB2C8\uB2E4.", code: "UNSUPPORTED_FORMAT" };
  }
}
async function parseHwp3(buffer, options) {
  try {
    const { markdown, blocks, metadata, outline, warnings } = parseHwp3Document(buffer, options);
    return { success: true, fileType: "hwp3", markdown, blocks, metadata, outline, warnings };
  } catch (err) {
    return { success: false, fileType: "hwp3", error: err instanceof Error ? err.message : "HWP3 \uD30C\uC2F1 \uC2E4\uD328", code: _chunkR2H34FY5cjs.classifyError.call(void 0, err) };
  }
}
async function parseHwpx(buffer, options) {
  try {
    const { markdown, blocks, metadata, outline, warnings, images } = await parseHwpxDocument(buffer, options);
    return { success: true, fileType: "hwpx", markdown, blocks, metadata, outline, warnings, images: _optionalChain([images, 'optionalAccess', _409 => _409.length]) ? images : void 0 };
  } catch (err) {
    return { success: false, fileType: "hwpx", error: err instanceof Error ? err.message : "HWPX \uD30C\uC2F1 \uC2E4\uD328", code: _chunkR2H34FY5cjs.classifyError.call(void 0, err) };
  }
}
async function parseHwp(buffer, options) {
  try {
    const { markdown, blocks, metadata, outline, warnings, images } = parseHwp5Document(Buffer.from(buffer), options);
    if (isDistributionSentinel(markdown) && isComFallbackAvailable() && _optionalChain([options, 'optionalAccess', _410 => _410.filePath])) {
      try {
        const { pages, pageCount, warnings: comWarns } = extractTextViaCom(options.filePath);
        if (pages.some((p) => p && p.trim().length > 0)) {
          const com = comResultToParseResult(pages, pageCount, comWarns);
          return {
            success: true,
            fileType: "hwp",
            markdown: com.markdown,
            blocks: com.blocks,
            metadata: com.metadata,
            warnings: com.warnings
          };
        }
      } catch (e32) {
      }
    }
    return { success: true, fileType: "hwp", markdown, blocks, metadata, outline, warnings, images: _optionalChain([images, 'optionalAccess', _411 => _411.length]) ? images : void 0 };
  } catch (err) {
    return { success: false, fileType: "hwp", error: err instanceof Error ? err.message : "HWP \uD30C\uC2F1 \uC2E4\uD328", code: _chunkR2H34FY5cjs.classifyError.call(void 0, err) };
  }
}
async function parsePdf(buffer, options) {
  let parsePdfDocument;
  try {
    const mod = await Promise.resolve().then(() => _interopRequireWildcard(require("./parser-XEY5MRGV.cjs")));
    parsePdfDocument = mod.parsePdfDocument;
  } catch (e33) {
    return {
      success: false,
      fileType: "pdf",
      error: "PDF \uD30C\uC2F1\uC5D0 pdfjs-dist\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4. \uC124\uCE58: npm install pdfjs-dist",
      code: "MISSING_DEPENDENCY"
    };
  }
  try {
    const { markdown, blocks, metadata, outline, warnings, isImageBased, pageQuality, qualitySummary } = await parsePdfDocument(buffer, options);
    return { success: true, fileType: "pdf", markdown, blocks, metadata, outline, warnings, isImageBased, pageQuality, qualitySummary };
  } catch (err) {
    const isImageBased = err instanceof Error && "isImageBased" in err ? true : void 0;
    return { success: false, fileType: "pdf", error: err instanceof Error ? err.message : "PDF \uD30C\uC2F1 \uC2E4\uD328", code: _chunkR2H34FY5cjs.classifyError.call(void 0, err), isImageBased };
  }
}
async function parseXlsx(buffer, options) {
  try {
    const { markdown, blocks, metadata, warnings } = await parseXlsxDocument(buffer, options);
    return { success: true, fileType: "xlsx", markdown, blocks, metadata, warnings };
  } catch (err) {
    return { success: false, fileType: "xlsx", error: err instanceof Error ? err.message : "XLSX \uD30C\uC2F1 \uC2E4\uD328", code: _chunkR2H34FY5cjs.classifyError.call(void 0, err) };
  }
}
async function parseXls(buffer, options) {
  try {
    const { markdown, blocks, metadata, warnings } = await parseXlsDocument(buffer, options);
    return { success: true, fileType: "xls", markdown, blocks, metadata, warnings };
  } catch (err) {
    return { success: false, fileType: "xls", error: err instanceof Error ? err.message : "XLS \uD30C\uC2F1 \uC2E4\uD328", code: _chunkR2H34FY5cjs.classifyError.call(void 0, err) };
  }
}
async function parseDocx(buffer, options) {
  try {
    const { markdown, blocks, metadata, outline, warnings, images } = await parseDocxDocument(buffer, options);
    return { success: true, fileType: "docx", markdown, blocks, metadata, outline, warnings, images: _optionalChain([images, 'optionalAccess', _412 => _412.length]) ? images : void 0 };
  } catch (err) {
    return { success: false, fileType: "docx", error: err instanceof Error ? err.message : "DOCX \uD30C\uC2F1 \uC2E4\uD328", code: _chunkR2H34FY5cjs.classifyError.call(void 0, err) };
  }
}
async function parseHwpml(buffer, options) {
  try {
    const { markdown, blocks, metadata, outline, warnings } = parseHwpmlDocument(buffer, options);
    return { success: true, fileType: "hwpml", markdown, blocks, metadata, outline, warnings };
  } catch (err) {
    return { success: false, fileType: "hwpml", error: err instanceof Error ? err.message : "HWPML \uD30C\uC2F1 \uC2E4\uD328", code: _chunkR2H34FY5cjs.classifyError.call(void 0, err) };
  }
}
async function fillForm(input, values, outputFormat = "markdown") {
  let buffer;
  if (typeof input === "string") {
    const buf = await _promises.readFile.call(void 0, input);
    buffer = _chunkR2H34FY5cjs.toArrayBuffer.call(void 0, buf);
  } else if (Buffer.isBuffer(input)) {
    buffer = _chunkR2H34FY5cjs.toArrayBuffer.call(void 0, input);
  } else {
    buffer = input;
  }
  if (outputFormat === "hwpx-preserve") {
    const format = detectFormat(buffer);
    if (format === "hwpx") {
      const zipFormat = await detectZipFormat(buffer);
      if (zipFormat !== "hwpx") {
        throw new Error(`hwpx-preserve \uD3EC\uB9F7\uC740 HWPX \uC785\uB825\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4 (\uAC10\uC9C0\uB41C \uD3EC\uB9F7: ${zipFormat})`);
      }
    } else {
      throw new Error(`hwpx-preserve \uD3EC\uB9F7\uC740 HWPX \uC785\uB825\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4 (\uAC10\uC9C0\uB41C \uD3EC\uB9F7: ${format})`);
    }
    const hwpxResult = await fillHwpx(buffer, values);
    return {
      output: hwpxResult.buffer,
      format: "hwpx-preserve",
      fill: { filled: hwpxResult.filled, unmatched: hwpxResult.unmatched }
    };
  }
  const parsed = await parse(buffer);
  if (!parsed.success) {
    throw new Error(`\uC11C\uC2DD \uD30C\uC2F1 \uC2E4\uD328: ${parsed.error}`);
  }
  const fill = fillFormFields(parsed.blocks, values);
  const markdown = _chunkR2H34FY5cjs.blocksToMarkdown.call(void 0, fill.blocks);
  if (outputFormat === "hwpx") {
    const hwpxBuffer = await markdownToHwpx(markdown);
    return { output: hwpxBuffer, format: "hwpx", fill };
  }
  return { output: markdown, format: "markdown", fill };
}

























































exports.HwpxSession = HwpxSession; exports.PRESET_ALIAS = PRESET_ALIAS; exports.SPACE_EM_FIXED = SPACE_EM_FIXED; exports.SPACE_EM_FONT = SPACE_EM_FONT; exports.VERSION = _chunkR2H34FY5cjs.VERSION; exports.ValueCursor = ValueCursor; exports.applySplices = applySplices; exports.blocksToMarkdown = _chunkR2H34FY5cjs.blocksToMarkdown; exports.blocksToPdf = blocksToPdf; exports.buildParagraphSplices = buildParagraphSplices; exports.buildRangeSplices = buildRangeSplices; exports.charWidthEm1000 = charWidthEm1000; exports.compare = compare; exports.detectFormat = detectFormat; exports.detectOle2Format = detectOle2Format; exports.detectZipFormat = detectZipFormat; exports.diffBlocks = diffBlocks; exports.extractFormFields = extractFormFields; exports.extractFormSchema = extractFormSchema; exports.fillForm = fillForm; exports.fillFormFields = fillFormFields; exports.fillHwpx = fillHwpx; exports.fillWithUniqueGuard = fillWithUniqueGuard; exports.fitRatioForFewerLines = fitRatioForFewerLines; exports.formatFillValue = formatFillValue; exports.hwpxToProfile = hwpxToProfile; exports.inferFieldType = inferFieldType; exports.isHwpxFile = isHwpxFile; exports.isLabelCell = isLabelCell; exports.isOldHwpFile = isOldHwpFile; exports.isPdfFile = isPdfFile; exports.isZipFile = isZipFile; exports.markdownToHwpx = markdownToHwpx; exports.markdownToPdf = markdownToPdf; exports.measureTextWidth = measureTextWidth; exports.normalizeGongmunPreset = normalizeGongmunPreset; exports.openHwpxDocument = openHwpxDocument; exports.parse = parse; exports.parseDocx = parseDocx; exports.parseHwp = parseHwp; exports.parseHwp3 = parseHwp3; exports.parseHwpml = parseHwpml; exports.parseHwpx = parseHwpx; exports.parsePdf = parsePdf; exports.parseXls = parseXls; exports.parseXlsx = parseXlsx; exports.patchHwp = patchHwp; exports.patchHwpx = patchHwpx; exports.patchHwpxBlocks = patchHwpxBlocks; exports.placeSealHwpx = placeSealHwpx; exports.renderHtml = renderHtml; exports.renderHwpxToSvg = renderHwpxToSvg; exports.scanSectionXml = scanSectionXml; exports.simulateWrap = simulateWrap; exports.simulateWrapKeepWord = simulateWrapKeepWord; exports.validateHwpx = validateHwpx;
//# sourceMappingURL=index.cjs.map