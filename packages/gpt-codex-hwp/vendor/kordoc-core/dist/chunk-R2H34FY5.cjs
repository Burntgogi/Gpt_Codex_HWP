"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }// src/utils.ts
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
  const ai = Number(_nullishCoalesce(_optionalChain([a, 'access', _2 => _2.match, 'call', _3 => _3(/[Ss]ection(\d+)\.xml$/), 'optionalAccess', _4 => _4[1]]), () => ( Number.MAX_SAFE_INTEGER)));
  const bi = Number(_nullishCoalesce(_optionalChain([b, 'access', _5 => _5.match, 'call', _6 => _6(/[Ss]ection(\d+)\.xml$/), 'optionalAccess', _7 => _7[1]]), () => ( Number.MAX_SAFE_INTEGER)));
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

// src/shared/pua.ts
var BMP_SYMBOL_MAP = {
  // 도형/기호
  108: "\u25CF",
  // ●
  109: "\u25CF",
  // ● (그림자 원 근사)
  110: "\u25A0",
  // ■
  111: "\u25A1",
  // □
  112: "\u25A1",
  // □ (굵은 흰 사각 근사)
  113: "\u25A1",
  // □ (그림자 근사)
  114: "\u25A1",
  // □ (그림자 근사)
  115: "\u2B27",
  // ⬧
  116: "\u29EB",
  // ⧫
  117: "\u25C6",
  // ◆
  118: "\u2756",
  // ❖
  119: "\u2B25",
  // ⬥
  // 체크/별/점
  158: "\xB7",
  // ·
  159: "\u2022",
  // •
  160: "\xB7",
  // · (한컴 PDF 정답지 정합 — ▪ 아님)
  161: "\u26AA",
  // ⚪
  162: "\u25CB",
  // ○
  163: "\u25CB",
  // ○
  164: "\u25C9",
  // ◉
  165: "\u25CE",
  // ◎
  167: "\u25AA",
  // ▪
  168: "\u25FB",
  // ◻
  170: "\u2726",
  // ✦
  171: "\u2605",
  // ★
  172: "\u2736",
  // ✶
  173: "\u2734",
  // ✴
  174: "\u2739",
  // ✹
  // 손 모양
  69: "\u261C",
  // ☜
  70: "\u261E",
  // ☞
  71: "\u261D",
  // ☝
  72: "\u261F",
  // ☟
  // 체크마크
  251: "\u2717",
  // ✗
  252: "\u2714",
  // ✔
  253: "\u2612",
  // ☒
  254: "\u2611",
  // ☑
  // 화살표
  232: "\u2794",
  // ➔ (heavy wide-headed — 한컴 PDF 정답지 정합)
  239: "\u21E6",
  // ⇦
  240: "\u21E8",
  // ⇨
  241: "\u21E7",
  // ⇧
  242: "\u21E9",
  // ⇩
  // 기타
  34: "\u2702",
  // ✂
  54: "\u231B",
  // ⌛
  74: "\u263A",
  // ☺
  78: "\u2620",
  // ☠
  82: "\u263C",
  // ☼
  84: "\u2744",
  // ❄
  88: "\u2720",
  // ✠
  89: "\u2721"
  // ✡
};
var SUPPLEMENTARY_MAP = {
  983099: "\u2193",
  // ↓
  983791: "\xB7",
  // ·
  985172: "\u300A",
  // 《
  985173: "\u300B",
  // 》
  983258: "\u25B8",
  // ▸
  985103: "\u2501",
  // ━
  985127: "\u25A0"
  // ■
};
function mapPuaChar(code) {
  if (code >= 61472 && code <= 61695) {
    return BMP_SYMBOL_MAP[code - 61440];
  }
  if (code >= 983040 && code <= 985599) {
    return SUPPLEMENTARY_MAP[code];
  }
  return void 0;
}
function mapPuaText(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += _nullishCoalesce(mapPuaChar(code), () => ( ch));
  }
  return out;
}

// src/table/builder.ts
var MAX_COLS = 200;
var MAX_ROWS = 1e4;
function buildTable(rows) {
  if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);
  const numRows = rows.length;
  const hasAddr = rows.some((row) => row.some((c) => c.colAddr !== void 0 && c.rowAddr !== void 0));
  if (hasAddr) return buildTableDirect(rows, numRows);
  let maxCols = 0;
  const tempOccupied = Array.from({ length: numRows }, () => []);
  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0;
    for (const cell of rows[rowIdx]) {
      while (colIdx < MAX_COLS && tempOccupied[rowIdx][colIdx]) colIdx++;
      if (colIdx >= MAX_COLS) break;
      for (let r = rowIdx; r < Math.min(rowIdx + cell.rowSpan, numRows); r++) {
        for (let c = colIdx; c < Math.min(colIdx + cell.colSpan, MAX_COLS); c++) {
          tempOccupied[r][c] = true;
        }
      }
      colIdx += cell.colSpan;
      if (colIdx > maxCols) maxCols = colIdx;
    }
  }
  if (maxCols === 0) return { rows: 0, cols: 0, cells: [], hasHeader: false };
  const grid = Array.from(
    { length: numRows },
    () => Array.from({ length: maxCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 }))
  );
  const occupied = Array.from({ length: numRows }, () => Array(maxCols).fill(false));
  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0;
    let cellIdx = 0;
    while (colIdx < maxCols && cellIdx < rows[rowIdx].length) {
      while (colIdx < maxCols && occupied[rowIdx][colIdx]) colIdx++;
      if (colIdx >= maxCols) break;
      const cell = rows[rowIdx][cellIdx];
      grid[rowIdx][colIdx] = {
        text: cell.text.trim(),
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan
      };
      for (let r = rowIdx; r < Math.min(rowIdx + cell.rowSpan, numRows); r++) {
        for (let c = colIdx; c < Math.min(colIdx + cell.colSpan, maxCols); c++) {
          occupied[r][c] = true;
        }
      }
      colIdx += cell.colSpan;
      cellIdx++;
    }
  }
  return trimAndReturn(grid, numRows, maxCols);
}
function buildTableDirect(rows, numRows) {
  let maxCols = 0;
  for (const row of rows) {
    for (const cell of row) {
      const end = (_nullishCoalesce(cell.colAddr, () => ( 0))) + cell.colSpan;
      if (end > maxCols) maxCols = end;
    }
  }
  if (maxCols > MAX_COLS) maxCols = MAX_COLS;
  if (maxCols === 0) return { rows: 0, cols: 0, cells: [], hasHeader: false };
  const grid = Array.from(
    { length: numRows },
    () => Array.from({ length: maxCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 }))
  );
  for (const row of rows) {
    for (const cell of row) {
      const r = _nullishCoalesce(cell.rowAddr, () => ( 0));
      const c = _nullishCoalesce(cell.colAddr, () => ( 0));
      if (r >= numRows || c >= maxCols || r < 0 || c < 0) continue;
      grid[r][c] = { text: cell.text.trim(), colSpan: cell.colSpan, rowSpan: cell.rowSpan };
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (r + dr < numRows && c + dc < maxCols) {
            grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 };
          }
        }
      }
    }
  }
  return trimAndReturn(grid, numRows, maxCols);
}
function trimAndReturn(grid, numRows, maxCols) {
  let effectiveCols = maxCols;
  while (effectiveCols > 0) {
    const colEmpty = grid.every((row) => !_optionalChain([row, 'access', _8 => _8[effectiveCols - 1], 'optionalAccess', _9 => _9.text, 'optionalAccess', _10 => _10.trim, 'call', _11 => _11()]));
    if (!colEmpty) break;
    effectiveCols--;
  }
  if (effectiveCols < maxCols && effectiveCols > 0) {
    const trimmed = grid.map((row) => row.slice(0, effectiveCols));
    return { rows: numRows, cols: effectiveCols, cells: trimmed, hasHeader: numRows > 1 };
  }
  return { rows: numRows, cols: maxCols, cells: grid, hasHeader: numRows > 1 };
}
function convertTableToText(rows) {
  return rows.map(
    (row) => row.map((c) => c.text.trim().replace(/\n/g, " ").replace(/\|/g, "\\|")).filter(Boolean).join(" / ")
  ).filter(Boolean).join("\n");
}
function escapeGfm(text) {
  const NUL = String.fromCharCode(0);
  const spans = [];
  const masked = text.replace(/\$\$[^$]*\$\$|\$[^$\n]*\$/g, (m) => {
    spans.push(m);
    return NUL + (spans.length - 1) + NUL;
  });
  const escaped = masked.replace(/([~*])/g, "\\$1");
  return escaped.replace(new RegExp(NUL + "(\\d+)" + NUL, "g"), (_, n) => spans[Number(n)]);
}
var HWP_SHAPE_ALT_TEXT_RE = /(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|이등변 삼각형|직각 삼각형|선|직선|곡선|화살표|굵은 화살표|이중 화살표|오각형|육각형|팔각형|별|[4-8]점별|십자|십자형|구름|구름형|마름모|도넛|평행사변형|사다리꼴|부채꼴|호|반원|물결|번개|하트|빗금|블록 화살표|수식|표|그림|개체|그리기\s?개체|묶음\s?개체|글상자|수식\s?개체|OLE\s?개체)\s?입니다\.?/g;
function sanitizeText(text) {
  let result = mapPuaText(text).replace(/[\u{F0000}-\u{FFFFD}]/gu, "").replace(HWP_SHAPE_ALT_TEXT_RE, "").replace(/  +/g, " ").trim();
  if (result.length <= 30 && result.includes(" ")) {
    const tokens = result.split(" ");
    const koreanSingleCharCount = tokens.filter((t) => t.length === 1 && /[\uAC00-\uD7AF\u3131-\u318E]/.test(t)).length;
    if (tokens.length >= 3 && koreanSingleCharCount / tokens.length >= 0.7) {
      result = tokens.join("");
    }
  }
  return result;
}
function flattenLayoutTables(blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.type !== "table" || !block.table) {
      result.push(block);
      continue;
    }
    const { rows: numRows, cols: numCols, cells } = block.table;
    if (numRows === 1 && numCols === 1) {
      result.push(block);
      continue;
    }
    if (numRows <= 3) {
      let totalNewlines = 0;
      let totalTextLen = 0;
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          const t = _optionalChain([cells, 'access', _12 => _12[r], 'optionalAccess', _13 => _13[c], 'optionalAccess', _14 => _14.text]) || "";
          totalNewlines += (t.match(/\n/g) || []).length;
          totalTextLen += t.length;
        }
      }
      if (numCols < 4 && (totalNewlines > 5 || numRows <= 2 && totalTextLen > 300)) {
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            const cell = _optionalChain([cells, 'access', _15 => _15[r], 'optionalAccess', _16 => _16[c]]);
            if (!cell) continue;
            if (_optionalChain([cell, 'access', _17 => _17.blocks, 'optionalAccess', _18 => _18.length])) {
              result.push(...flattenLayoutTables(cell.blocks));
              continue;
            }
            const cellText = _optionalChain([cell, 'access', _19 => _19.text, 'optionalAccess', _20 => _20.trim, 'call', _21 => _21()]);
            if (!cellText) continue;
            for (const line of cellText.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              result.push({ type: "paragraph", text: trimmed, pageNumber: block.pageNumber });
            }
          }
        }
        continue;
      }
    }
    result.push(block);
  }
  return result;
}
var RUNNING_HEADER_MAX_LEN = 40;
var RUNNING_HEADER_MIN_FREQ = 3;
function isRunningHeaderCandidate(block) {
  if (block.type !== "paragraph" && block.type !== "heading") return false;
  const text = _optionalChain([block, 'access', _22 => _22.text, 'optionalAccess', _23 => _23.trim, 'call', _24 => _24()]);
  if (!text || text.length > RUNNING_HEADER_MAX_LEN) return false;
  return /^\d+\.\s/.test(text);
}
function dedupeRunningHeaders(blocks) {
  const freq = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    if (!isRunningHeaderCandidate(block)) continue;
    const text = block.text.trim();
    freq.set(text, (_nullishCoalesce(freq.get(text), () => ( 0))) + 1);
  }
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const block of blocks) {
    if (isRunningHeaderCandidate(block)) {
      const text = block.text.trim();
      if ((_nullishCoalesce(freq.get(text), () => ( 0))) >= RUNNING_HEADER_MIN_FREQ) {
        if (seen.has(text)) continue;
        seen.add(text);
      }
    }
    result.push(block);
  }
  return result;
}
function blocksToMarkdown(blocks) {
  const lines = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "heading" && block.text) {
      const prefix = "#".repeat(Math.min(block.level || 2, 6));
      const headingText = sanitizeText(block.text);
      if (headingText) lines.push("", `${prefix} ${escapeGfm(headingText)}`, "");
      continue;
    }
    if (block.type === "image" && block.text) {
      lines.push("", `![image](${block.text})`, "");
      continue;
    }
    if (block.type === "separator") {
      lines.push("", "---", "");
      continue;
    }
    if (block.type === "list" && block.text) {
      const listText = sanitizeText(block.text);
      if (!listText) continue;
      const alreadyNumbered = block.listType === "ordered" && /^\d+\.\s/.test(listText);
      const prefix = alreadyNumbered ? "" : block.listType === "ordered" ? "1. " : "- ";
      lines.push(`${prefix}${escapeGfm(listText)}`);
      if (block.children) {
        for (const child of block.children) {
          const childPrefix = child.listType === "ordered" ? "1." : "-";
          lines.push(`  ${childPrefix} ${escapeGfm(child.text || "")}`);
        }
      }
      continue;
    }
    if (block.type === "paragraph" && block.text) {
      let text = sanitizeText(block.text);
      if (!text) continue;
      if (/^\[별표\s*\d+/.test(text)) {
        const nextBlock = blocks[i + 1];
        if (_optionalChain([nextBlock, 'optionalAccess', _25 => _25.type]) === "paragraph" && nextBlock.text && /관련\)?$/.test(nextBlock.text)) {
          lines.push("", `## ${escapeGfm(text)} ${escapeGfm(nextBlock.text)}`, "");
          i++;
        } else {
          lines.push("", `## ${escapeGfm(text)}`, "");
        }
        continue;
      }
      if (/^\([^)]*조[^)]*관련\)$/.test(text)) {
        lines.push(`*${escapeGfm(text)}*`, "");
        continue;
      }
      if (block.href) {
        const href = sanitizeHref(block.href);
        if (href) text = `[${text}](${href})`;
      }
      if (block.footnoteText) {
        text += ` (\uC8FC: ${block.footnoteText})`;
      }
      lines.push(escapeGfm(text), "");
    } else if (block.type === "table" && block.table) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      if (block.table.caption) {
        const caption = sanitizeText(block.table.caption);
        if (caption) lines.push(`**${escapeGfm(caption)}**`, "");
      }
      const tableMd = tableToMarkdown(block.table);
      if (tableMd) {
        lines.push(tableMd);
        lines.push("");
      }
    }
  }
  return lines.join("\n").trim();
}
function hasMergedCells(table) {
  for (const row of table.cells) {
    for (const cell of row) {
      if (cell.colSpan > 1 || cell.rowSpan > 1) return true;
    }
  }
  return false;
}
function hasNestedTables(table) {
  for (const row of table.cells) {
    for (const cell of row) {
      if (_optionalChain([cell, 'access', _26 => _26.blocks, 'optionalAccess', _27 => _27.some, 'call', _28 => _28((b) => b.type === "table" && b.table)])) return true;
    }
  }
  return false;
}
function cellInnerHtml(cell) {
  if (_optionalChain([cell, 'access', _29 => _29.blocks, 'optionalAccess', _30 => _30.length])) {
    return cell.blocks.map((b) => {
      if (b.type === "table" && b.table) {
        const cap = b.table.caption ? sanitizeText(b.table.caption) : "";
        return (cap ? cap + "<br>" : "") + tableToHtml(b.table);
      }
      if (b.type === "image" && b.text) return `<img src="${b.text}" alt="image">`;
      const t = sanitizeText(_nullishCoalesce(b.text, () => ( "")));
      return t ? t.replace(/\n/g, "<br>") : "";
    }).filter(Boolean).join("<br>");
  }
  return sanitizeText(cell.text).replace(/\n/g, "<br>");
}
function containsInlineMath(text) {
  return /(^|[^\\])\$(?=\S)(?:\\.|[^$\n])+?\S\$/.test(text);
}
function tableContainsInlineMath(table) {
  for (const row of table.cells) {
    for (const cell of row) {
      if (containsInlineMath(cell.text)) return true;
    }
  }
  return false;
}
function tableToHtml(table) {
  const { cells, rows: numRows, cols: numCols } = table;
  const skip = /* @__PURE__ */ new Set();
  const lines = ["<table>"];
  for (let r = 0; r < numRows; r++) {
    const tag = r === 0 ? "th" : "td";
    const rowHtml = [];
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue;
      const cell = _optionalChain([cells, 'access', _31 => _31[r], 'optionalAccess', _32 => _32[c]]);
      if (!cell) continue;
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (r + dr < numRows && c + dc < numCols) skip.add(`${r + dr},${c + dc}`);
        }
      }
      const text = cellInnerHtml(cell);
      const attrs = [];
      if (cell.colSpan > 1) attrs.push(`colspan="${cell.colSpan}"`);
      if (cell.rowSpan > 1) attrs.push(`rowspan="${cell.rowSpan}"`);
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";
      rowHtml.push(`<${tag}${attrStr}>${text}</${tag}>`);
    }
    if (rowHtml.length) lines.push(`<tr>${rowHtml.join("")}</tr>`);
  }
  lines.push("</table>");
  return lines.join("\n");
}
function tableToMarkdown(table) {
  if (table.rows === 0 || table.cols === 0) return "";
  const { cells, rows: numRows, cols: numCols } = table;
  if ((hasMergedCells(table) || hasNestedTables(table)) && !tableContainsInlineMath(table)) {
    return tableToHtml(table);
  }
  if (numRows === 1 && numCols === 1) {
    const content = sanitizeText(cells[0][0].text);
    if (!content) return "";
    return content.split(/\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (/^\d+\.\s/.test(trimmed)) return `**${escapeGfm(trimmed)}**`;
      if (/^[가-힣]\.\s/.test(trimmed)) return `  ${escapeGfm(trimmed)}`;
      return escapeGfm(trimmed);
    }).filter(Boolean).join("\n");
  }
  if (numCols === 1 && numRows >= 2) {
    return cells.map((row) => escapeGfm(sanitizeText(row[0].text)).replace(/\n/g, " ")).filter(Boolean).join("\n");
  }
  const display = Array.from({ length: numRows }, () => Array(numCols).fill(""));
  const skip = /* @__PURE__ */ new Set();
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue;
      const cell = _optionalChain([cells, 'access', _33 => _33[r], 'optionalAccess', _34 => _34[c]]);
      if (!cell) continue;
      display[r][c] = escapeGfm(sanitizeText(cell.text)).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (r + dr < numRows && c + dc < numCols) {
            skip.add(`${r + dr},${c + dc}`);
          }
        }
      }
      c += cell.colSpan - 1;
    }
  }
  const uniqueRows = [];
  let pendingLabelRow = null;
  for (let r = 0; r < display.length; r++) {
    const row = display[r];
    const isEmptyPlaceholder = row.every((cell) => cell === "");
    if (isEmptyPlaceholder) continue;
    const nonEmptyCols = row.filter((cell) => cell !== "");
    const hasSkipInRow = row.some((_, c) => skip.has(`${r},${c}`));
    if (!hasSkipInRow && nonEmptyCols.length === 1 && row[0] !== "" && row.slice(1).every((c) => c === "")) {
      if (pendingLabelRow) uniqueRows.push(pendingLabelRow);
      pendingLabelRow = row;
      continue;
    }
    if (pendingLabelRow) {
      if (row[0] === "") row[0] = pendingLabelRow[0];
      else uniqueRows.push(pendingLabelRow);
      pendingLabelRow = null;
    }
    uniqueRows.push(row);
  }
  if (pendingLabelRow) uniqueRows.push(pendingLabelRow);
  if (uniqueRows.length === 0) return "";
  const md = [];
  md.push("| " + uniqueRows[0].join(" | ") + " |");
  md.push("| " + uniqueRows[0].map(() => "---").join(" | ") + " |");
  for (let i = 1; i < uniqueRows.length; i++) {
    md.push("| " + uniqueRows[i].join(" | ") + " |");
  }
  return md.join("\n");
}

// src/types.ts
var HEADING_RATIO_H1 = 1.5;
var HEADING_RATIO_H2 = 1.3;
var HEADING_RATIO_H3 = 1.15;

























exports.VERSION = VERSION; exports.toArrayBuffer = toArrayBuffer; exports.KordocError = KordocError; exports.isPathTraversal = isPathTraversal; exports.normalizeSectionHref = normalizeSectionHref; exports.compareSectionPaths = compareSectionPaths; exports.precheckZipSize = precheckZipSize; exports.stripDtd = stripDtd; exports.sanitizeHref = sanitizeHref; exports.safeMin = safeMin; exports.safeMax = safeMax; exports.classifyError = classifyError; exports.mapPuaText = mapPuaText; exports.MAX_COLS = MAX_COLS; exports.MAX_ROWS = MAX_ROWS; exports.buildTable = buildTable; exports.convertTableToText = convertTableToText; exports.flattenLayoutTables = flattenLayoutTables; exports.dedupeRunningHeaders = dedupeRunningHeaders; exports.blocksToMarkdown = blocksToMarkdown; exports.HEADING_RATIO_H1 = HEADING_RATIO_H1; exports.HEADING_RATIO_H2 = HEADING_RATIO_H2; exports.HEADING_RATIO_H3 = HEADING_RATIO_H3;
//# sourceMappingURL=chunk-R2H34FY5.cjs.map