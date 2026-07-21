#!/usr/bin/env node
import {
  parseRenderStyles
} from "./chunk-4RGDFDQ2.js";
import {
  KordocError
} from "./chunk-UNV7F3FK.js";

// src/form/seal.ts
import JSZip from "jszip";

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
    } catch {
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
          const ca = parseInt(getAttr(attrsRaw, "colAddr") || "", 10);
          const ra = parseInt(getAttr(attrsRaw, "rowAddr") || "", 10);
          if (!isNaN(ca)) cell.colAddr = ca;
          if (!isNaN(ra)) cell.rowAddr = ra;
          cell.addrTagRange = { start: m.index, end: m.index + full.length };
        }
      } else if (local === "cellSpan") {
        const cell = cellStack[cellStack.length - 1];
        if (cell && insideCurrentTable(stack, tableStack)) {
          const cs = parseInt(getAttr(attrsRaw, "colSpan") || "1", 10);
          const rs = parseInt(getAttr(attrsRaw, "rowSpan") || "1", 10);
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
          const ca = parseInt(getAttr(attrsRaw, "colAddr") || "", 10);
          const ra = parseInt(getAttr(attrsRaw, "rowAddr") || "", 10);
          if (!isNaN(ca)) cell.colAddr = ca;
          if (!isNaN(ra)) cell.rowAddr = ra;
          cell.addrTagRange = { start: m.index, end: contentStart };
        } else {
          const cs = parseInt(getAttr(attrsRaw, "colSpan") || "1", 10);
          const rs = parseInt(getAttr(attrsRaw, "rowSpan") || "1", 10);
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
function getAttr(attrsRaw, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = attrsRaw.match(re);
  return m ? m[1] ?? m[2] : void 0;
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
import { deflateRawSync } from "zlib";
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
  if (eocdOffset < 0) throw new KordocError("ZIP EOCD\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset === 4294967295 || totalEntries === 65535) throw new KordocError("ZIP64\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
  if (eocdOffset >= 20 && view.getUint32(eocdOffset - 20, true) === ZIP64_EOCD_LOC_SIG) {
    throw new KordocError("ZIP64\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
  }
  const decoder = new TextDecoder("utf-8");
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(pos, true) !== CD_SIG) throw new KordocError("ZIP Central Directory \uC190\uC0C1");
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
      throw new KordocError("ZIP64\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4");
    }
    const name = decoder.decode(buf.subarray(pos + 46, pos + 46 + nameLen));
    const cdEnd = pos + 46 + nameLen + extraLen + commentLen;
    entries.push({ cdStart: pos, cdEnd, name, flags, method, crc, compSize, uncompSize, localOffset });
    pos = cdEnd;
  }
  return { entries, cdOffset, cdSize, eocdOffset };
}
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(data) {
  let crc = 4294967295;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
function patchZipEntries(original, replacements, additions) {
  const { entries, cdOffset, eocdOffset } = parseCentralDirectory(original);
  const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
  for (const name of replacements.keys()) {
    if (!entries.some((e) => e.name === name)) throw new KordocError(`ZIP\uC5D0 \uC5C6\uB294 \uC5D4\uD2B8\uB9AC: ${name}`);
  }
  if (additions) {
    for (const name of additions.keys()) {
      if (entries.some((e) => e.name === name)) throw new KordocError(`ZIP\uC5D0 \uC774\uBBF8 \uC788\uB294 \uC5D4\uD2B8\uB9AC: ${name}`);
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
    if (view.getUint32(e.localOffset, true) !== LOCAL_SIG) throw new KordocError("ZIP \uB85C\uCEEC \uD5E4\uB354 \uC2DC\uADF8\uB2C8\uCC98 \uBD88\uC77C\uCE58");
    const nameLen = view.getUint16(e.localOffset + 26, true);
    const extraLen = view.getUint16(e.localOffset + 28, true);
    const headerLen = 30 + nameLen + extraLen;
    const header = copyBytes(original, e.localOffset, e.localOffset + headerLen);
    const hview = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const method = e.method;
    const compData = method === 0 ? newData : new Uint8Array(deflateRawSync(newData));
    const crc = crc32(newData);
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
      const deflated = new Uint8Array(deflateRawSync(data));
      const method = deflated.length < data.length ? 8 : 0;
      const compData = method === 8 ? deflated : data;
      const crc = crc32(data);
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

// src/form/seal.ts
var HU_PER_MM = 7200 / 25.4;
var mm2hu = (mm) => Math.round(mm * HU_PER_MM);
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
  for (const ch of text) w += glyphEm(ch.codePointAt(0) ?? 0) * emMm;
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
  return m?.[1];
}
function paraOpenTag(xml, para) {
  const end = xml.indexOf(">", para.start);
  return end === -1 ? "" : xml.slice(para.start, end + 1);
}
function anchorRunInfo(xml, para, anchor) {
  let tr = para.tRanges.find((r) => !r.selfClosing && xml.slice(r.contentStart, r.contentEnd).includes(anchor));
  if (!tr) {
    const head = anchor[0];
    tr = para.tRanges.find((r) => !r.selfClosing && xml.slice(r.contentStart, r.contentEnd).includes(head)) ?? para.tRanges[para.tRanges.length - 1];
  }
  if (!tr) return null;
  const before = xml.slice(Math.max(0, para.start), tr.contentStart);
  const runOpen = [...before.matchAll(/<([A-Za-z0-9]+):run\b[^>]*>/g)].pop();
  const prefix = runOpen?.[1] ?? tr.prefix ?? "hp";
  const charPr = runOpen && attrOf(runOpen[0], "charPrIDRef") || "0";
  const close = xml.indexOf(`</${prefix}:run>`, tr.contentEnd);
  if (close === -1) return null;
  return { charPr, prefix, insertAt: close + `</${prefix}:run>`.length };
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
  const mg = win?.match(/<[A-Za-z0-9]+:cellMargin\b[^>]*>/);
  if (mg) {
    content -= Number(attrOf(mg[0], "left") ?? 0) + Number(attrOf(mg[0], "right") ?? 0);
  }
  return content > 0 ? content / HU_PER_MM : null;
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
  for (let col = 0; col < cell.colAddr; col++) sum += colW.get(col) ?? 0;
  return sum / HU_PER_MM;
}
function bodyColumnWidthMm(xml) {
  const page = xml.match(/<[A-Za-z0-9]+:pagePr\b[^>]*\bwidth="(\d+)"[^>]*>/);
  const margin = xml.match(/<[A-Za-z0-9]+:margin\b[^>]*\bleft="(\d+)"[^>]*\bright="(\d+)"[^>]*>/);
  if (!page) return 150;
  const w = Number(page[1]) - (margin ? Number(margin[1]) + Number(margin[2]) : 0);
  return w > 0 ? w / HU_PER_MM : 150;
}
function buildFloatPicXml(itemId, sizeHu, posXHu, posYHu, ids) {
  const w = sizeHu;
  const h = sizeHu;
  return `<hp:pic xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" id="${ids.id}" zOrder="0" numberingType="PICTURE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${ids.instid}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect><hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${w}" dimheight="${h}"/><hc:img binaryItemIDRef="${itemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/><hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="${posYHu}" horzOffset="${posXHu}"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>kordoc seal</hp:shapeComment></hp:pic>`;
}
async function placeSealHwpx(hwpxBuffer, ops) {
  if (ops.length === 0) throw new KordocError("place_seal: \uBC30\uCE58\uD560 \uB3C4\uC7A5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4");
  const u8 = new Uint8Array(hwpxBuffer);
  const zip = await JSZip.loadAsync(hwpxBuffer);
  const sectionPaths = Object.keys(zip.files).filter((name) => /[Ss]ection\d+\.xml$/i.test(name)).sort((a, b) => Number(a.match(/(\d+)\.xml$/i)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/i)?.[1] ?? 0));
  if (sectionPaths.length === 0) throw new KordocError("HWPX\uC5D0\uC11C \uC139\uC158 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
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
    if (!op.anchor) throw new KordocError("place_seal: anchor \uBB38\uAD6C\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4");
    if (!op.image || op.image.length === 0) throw new KordocError("place_seal: \uB3C4\uC7A5 \uC774\uBBF8\uC9C0\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4");
    const ext = (op.ext ?? "png").toLowerCase();
    if (!MIME[ext]) throw new KordocError(`place_seal: \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uC774\uBBF8\uC9C0 \uD655\uC7A5\uC790 .${ext} (png/jpg/bmp/gif)`);
    if (!imageMagicMatches(op.image, ext)) throw new KordocError(`place_seal: \uC774\uBBF8\uC9C0 \uB0B4\uC6A9\uC774 .${ext} \uD615\uC2DD\uC774 \uC544\uB2D9\uB2C8\uB2E4 (\uB9E4\uC9C1\uBC14\uC774\uD2B8 \uBD88\uC77C\uCE58)`);
    const wantOcc = op.occurrence ?? 0;
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
      throw new KordocError(
        `place_seal: \uC575\uCEE4 "${op.anchor}" ${wantOcc}\uBC88\uC9F8 \uB4F1\uC7A5\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (\uBCF8\uBB38 \uB0B4 ${total}\uD68C \uB4F1\uC7A5 \u2014 occurrence 0..${Math.max(0, total - 1)})`
      );
    }
    const { si, site, idxInText } = found;
    const xml = sectionXmls[si];
    const run = anchorRunInfo(xml, site.para, op.anchor);
    if (!run) {
      throw new KordocError(`place_seal: \uC575\uCEE4 "${op.anchor}" \uBB38\uB2E8\uC5D0\uC11C run\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4`);
    }
    const charPrHeight = styles?.charPr.get(run.charPr)?.height ?? 1e3;
    const fontPt = charPrHeight / 100;
    const emMm = fontPt * 25.4 / 72;
    const lineHMm = emMm;
    const startXMm = measureMm(site.para.text.slice(0, idxInText), emMm);
    const anchorWMm = measureMm(op.anchor, emMm);
    const sizeMm = op.sizeMm != null && Number.isFinite(op.sizeMm) && op.sizeMm > 0 ? op.sizeMm : Math.max(7, Math.min(18, lineHMm * 1.6));
    const availMm = (site.cell ? cellContentWidthMm(xml, site.cell) : null) ?? bodyColumnWidthMm(xml);
    const paraPrId = attrOf(paraOpenTag(xml, site.para), "paraPrIDRef") ?? "0";
    const align = styles?.paraAlign.get(paraPrId);
    let alignShiftMm = 0;
    if (align === "CENTER" || align === "RIGHT") {
      const paraWMm = measureMm(site.para.text, emMm);
      alignShiftMm = align === "CENTER" ? (availMm - paraWMm) / 2 : availMm - paraWMm;
      if (!Number.isFinite(alignShiftMm) || alignShiftMm < 0) alignShiftMm = 0;
    }
    let mode = op.mode ?? "auto";
    if (mode === "auto") {
      mode = availMm - (alignShiftMm + startXMm + anchorWMm) >= sizeMm + 2 ? "right" : "overlap";
    }
    const cellShiftMm = site.cell && site.table ? cellLeftOffsetMm(xml, site.table, site.cell) + (site.outer ?? []).reduce((s, o) => s + cellLeftOffsetMm(xml, o.table, o.cell), 0) : 0;
    const posXMm = (mode === "right" ? startXMm + anchorWMm + 2 : startXMm + anchorWMm / 2 - sizeMm / 2) + alignShiftMm + cellShiftMm + (op.dxMm ?? 0);
    const posYMm = -(sizeMm - lineHMm) / 2 + (op.dyMm ?? 0);
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

export {
  escapeXmlText,
  scanSectionXml,
  findElementEnd,
  buildParagraphSplices,
  paraTText,
  paraTextPureT,
  buildRangeSplices,
  allLinesegRemovalSplices,
  applySplices,
  patchZipEntries,
  placeSealHwpx
};
//# sourceMappingURL=chunk-NZJAXMN7.js.map