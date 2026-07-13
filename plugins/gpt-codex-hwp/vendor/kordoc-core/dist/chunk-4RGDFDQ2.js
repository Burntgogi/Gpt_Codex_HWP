#!/usr/bin/env node
import {
  KordocError
} from "./chunk-UNV7F3FK.js";

// src/hwpx/parser-shared.ts
import { DOMParser } from "@xmldom/xmldom";
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
  return new DOMParser({
    onError(level, msg) {
      if (level === "fatalError") throw new KordocError(`XML \uD30C\uC2F1 \uC2E4\uD328: ${msg}`);
      warnings?.push({ code: "MALFORMED_XML", message: `XML ${level === "warn" ? "\uACBD\uACE0" : "\uC624\uB958"}: ${msg}` });
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
  const trimmed = (face ?? "").trim();
  if (!trimmed) return "";
  const generic = isSerifFace(trimmed) ? "'HCR Batang','Batang','Noto Serif KR',serif" : "'Malgun Gothic','HCR Dotum','Noto Sans KR',sans-serif";
  const head = FONT_ALIASES[trimmed] ?? cssQuote(trimmed);
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
    if ((e.getAttribute("lang") ?? "").toUpperCase() === "HANGUL") {
      group = e;
      break;
    }
  }
  group = group ?? firstGroup;
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
  const n = parseFloat(v ?? "");
  if (!Number.isFinite(n)) return 0.34;
  return n * 2.834645;
}
function parseEdge(el) {
  if (!el) return void 0;
  const type = el.getAttribute("type") ?? "NONE";
  if (type === "NONE") return void 0;
  return { type, widthPt: borderWidthPt(el.getAttribute("width")), color: el.getAttribute("color") ?? "#000000" };
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
    g.lineSpacingType = ls.getAttribute("type") ?? "PERCENT";
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
        const fontId = fontRef?.getAttribute("hangul") ?? fontRef?.getAttribute("latin");
        const face = fontId != null ? hangulFonts.get(fontId) : void 0;
        styles.charPr.set(id, {
          height: Number(el.getAttribute("height")) || 1e3,
          bold: findChildByLocalName(el, "bold") != null,
          italic: findChildByLocalName(el, "italic") != null,
          underline: underlineEl != null && (underlineEl.getAttribute("type") ?? "NONE") !== "NONE",
          color: textColor && textColor !== "#000000" && textColor.toLowerCase() !== "none" ? textColor : void 0,
          ratio: Number(ratioEl?.getAttribute("hangul")) || 100,
          spacing: Number(spacingEl?.getAttribute("hangul")) || 0,
          fontFamily: face ? hwpFaceToCssStack(face) : void 0
        });
      }
    } else if (tag === "paraPr") {
      const id = el.getAttribute("id");
      if (id != null) {
        const align = findChildByLocalName(el, "align");
        styles.paraAlign.set(id, align?.getAttribute("horizontal") || "JUSTIFY");
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
        const face = winBrush?.getAttribute("faceColor");
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

export {
  MAX_DECOMPRESS_SIZE,
  MAX_ZIP_ENTRIES,
  clampSpan,
  MAX_XML_DEPTH,
  createSectionShared,
  createXmlParser,
  applyPageText,
  findChildByLocalName,
  extractTextFromNode,
  DEFAULT_PARA_GEOM,
  DEFAULT_CHAR,
  parseRenderStyles
};
//# sourceMappingURL=chunk-4RGDFDQ2.js.map