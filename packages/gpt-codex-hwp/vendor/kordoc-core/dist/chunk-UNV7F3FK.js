#!/usr/bin/env node

// src/utils.ts
var VERSION = true ? "3.18.1" : "0.0.0-dev";
function toArrayBuffer(buf) {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return buf.buffer;
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
var KordocError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "KordocError";
  }
};
function sanitizeError(err) {
  if (err instanceof KordocError) return err.message;
  return "\uBB38\uC11C \uCC98\uB9AC \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4";
}
function isPathTraversal(name) {
  if (name.includes("\0")) return true;
  const normalized = name.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments.some((s) => s === "..") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized);
}
function normalizeSectionHref(href) {
  if (!href) return null;
  let normalized = href.replace(/\\/g, "/").replace(/^\/+/, "");
  if (isPathTraversal(normalized)) return null;
  if (/^[Ss]ection\d+\.xml$/.test(normalized)) normalized = "Contents/" + normalized;
  return /(?:^|\/)[Ss]ection\d+\.xml$/.test(normalized) ? normalized : null;
}
function compareSectionPaths(a, b) {
  const ai = Number(a.match(/[Ss]ection(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const bi = Number(b.match(/[Ss]ection(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return ai === bi ? a.localeCompare(b) : ai - bi;
}
function precheckZipSize(buffer, maxUncompressedSize = 100 * 1024 * 1024, maxEntries = 500) {
  try {
    const data = new DataView(buffer);
    const len = buffer.byteLength;
    let eocdOffset = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (data.getUint32(i, true) === 101010256) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) return { totalUncompressed: 0, entryCount: 0 };
    const entryCount = data.getUint16(eocdOffset + 10, true);
    if (entryCount > maxEntries) {
      throw new KordocError(`ZIP \uC5D4\uD2B8\uB9AC \uC218 \uCD08\uACFC: ${entryCount} (\uCD5C\uB300 ${maxEntries})`);
    }
    const cdSize = data.getUint32(eocdOffset + 12, true);
    const cdOffset = data.getUint32(eocdOffset + 16, true);
    if (cdOffset + cdSize > len) return { totalUncompressed: 0, entryCount };
    let totalUncompressed = 0;
    let pos = cdOffset;
    for (let i = 0; i < entryCount && pos + 46 <= cdOffset + cdSize; i++) {
      if (data.getUint32(pos, true) !== 33639248) break;
      totalUncompressed += data.getUint32(pos + 24, true);
      const nameLen = data.getUint16(pos + 28, true);
      const extraLen = data.getUint16(pos + 30, true);
      const commentLen = data.getUint16(pos + 32, true);
      pos += 46 + nameLen + extraLen + commentLen;
    }
    if (totalUncompressed > maxUncompressedSize) {
      throw new KordocError(`ZIP \uBE44\uC555\uCD95 \uD06C\uAE30 \uCD08\uACFC: ${(totalUncompressed / 1024 / 1024).toFixed(1)}MB (\uCD5C\uB300 ${maxUncompressedSize / 1024 / 1024}MB)`);
    }
    return { totalUncompressed, entryCount };
  } catch (err) {
    if (err instanceof KordocError) throw err;
    return { totalUncompressed: 0, entryCount: 0 };
  }
}
function stripDtd(xml) {
  return xml.replace(/<!DOCTYPE\s[^[>]*(\[[\s\S]*?\])?\s*>/gi, "");
}
var SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|#)/i;
function sanitizeHref(href) {
  const trimmed = href.trim();
  if (!trimmed || !SAFE_HREF_RE.test(trimmed)) return null;
  return trimmed;
}
function safeMin(arr) {
  let min = Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] < min) min = arr[i];
  return min;
}
function safeMax(arr) {
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  return max;
}
function classifyError(err) {
  if (!(err instanceof Error)) return "PARSE_ERROR";
  const msg = err.message;
  if (msg.includes("\uC554\uD638\uD654")) return "ENCRYPTED";
  if (msg.includes("DRM")) return "DRM_PROTECTED";
  if (msg.includes("ZIP bomb") || msg.includes("ZIP \uBE44\uC555\uCD95 \uD06C\uAE30 \uCD08\uACFC") || msg.includes("ZIP \uC5D4\uD2B8\uB9AC \uC218 \uCD08\uACFC")) return "ZIP_BOMB";
  if (msg.includes("bomb") || msg.includes("\uD06C\uAE30 \uCD08\uACFC") || msg.includes("\uC555\uCD95 \uD574\uC81C")) return "DECOMPRESSION_BOMB";
  if (msg.includes("\uC774\uBBF8\uC9C0 \uAE30\uBC18")) return "IMAGE_BASED_PDF";
  if (msg.includes("\uC139\uC158") && (msg.includes("\uCC3E\uC744 \uC218 \uC5C6") || msg.includes("\uC5C6\uC74C"))) return "NO_SECTIONS";
  if (msg.includes("\uC2DC\uADF8\uB2C8\uCC98") || msg.includes("\uBCF5\uAD6C\uD560 \uC218 \uC5C6")) return "CORRUPTED";
  return "PARSE_ERROR";
}

export {
  VERSION,
  toArrayBuffer,
  KordocError,
  sanitizeError,
  isPathTraversal,
  normalizeSectionHref,
  compareSectionPaths,
  precheckZipSize,
  stripDtd,
  sanitizeHref,
  safeMin,
  safeMax,
  classifyError
};
//# sourceMappingURL=chunk-UNV7F3FK.js.map