#!/usr/bin/env node
import {
  DEFAULT_CHAR,
  DEFAULT_PARA_GEOM,
  MAX_DECOMPRESS_SIZE,
  MAX_ZIP_ENTRIES,
  createXmlParser,
  findChildByLocalName,
  parseRenderStyles
} from "./chunk-4RGDFDQ2.js";
import {
  KordocError,
  precheckZipSize
} from "./chunk-UNV7F3FK.js";

// src/render/svg-render.ts
import JSZip from "jszip";

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
  const spaceEm = opts?.spaceEm ?? SPACE_EM_FIXED;
  const spacing = opts?.spacingPct ?? 0;
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
  const spaceEm = opts?.spaceEm ?? SPACE_EM_FIXED;
  const spacing = opts?.spacingPct ?? 0;
  const k = height * ratioPct / 100 / 1e3;
  const cwCp = (cp) => (cp === 32 ? spaceEm : charWidthEm1000(cp)) * (1 + spacing / 100) * k;
  const charW2 = (ch) => cwCp(ch.codePointAt(0));
  const rangeW = (from, to) => {
    let w = 0;
    for (const ch of text.slice(from, to)) w += charW2(ch);
    return w;
  };
  const units = text.match(mode === "keep" ? / +|[^ ]+/g : / +|[^ ]/g) ?? [];
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

// src/render/reflow.ts
var LINESEG_FLAGS = "393216";
var BASELINE_RATIO = 0.85;
function ln(el) {
  return (el.tagName || "").replace(/^[^:]+:/, "");
}
function elements(el) {
  const out = [];
  const kids = el.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i]);
  return out;
}
function num(el, attr, fallback = 0) {
  return el ? toInt32(el.getAttribute(attr) ?? void 0, fallback) : fallback;
}
function shiftParaVert(p, delta) {
  for (const lsa of elements(p)) {
    if (ln(lsa) !== "linesegarray") continue;
    for (const seg of elements(lsa)) {
      if (ln(seg) !== "lineseg") continue;
      seg.setAttribute("vertpos", String(num(seg, "vertpos") + delta));
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
  const geom = styles.paraGeom.get(m.paraPrId ?? "") ?? DEFAULT_PARA_GEOM;
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
          const cellW = num(csz, "width");
          const mL = cm ? num(cm, "left", 141) : 141;
          const mR = cm ? num(cm, "right", 141) : 141;
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
    const g = styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "");
    const startV = cursorV + prevSpaceAfter + (g?.spaceBefore ?? 0);
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
function num2(el, attr, fallback = 0) {
  return el ? toInt32(el.getAttribute(attr) ?? void 0, fallback) : fallback;
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
function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var OBJ_TAGS = /* @__PURE__ */ new Set(["tbl", "pic", "container", "equation", "rect", "ellipse", "polygon", "curv", "line", "arc", "ole", "textart"]);
var pt = (u) => String(Math.round(u) / 100);
function emit(ctx, s) {
  ctx.pages[ctx.page].push(s);
}
function warnOnce(ctx, key, msg) {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  ctx.warnings.push(msg);
}
var CHAR_CTRL_1SLOT = /* @__PURE__ */ new Set(["lineBreak", "hyphen", "nbSpace", "fwSpace"]);
function pushFillers(chars, n, prId) {
  for (let i = 0; i < n; i++) chars.push({ ch: "", prId });
}
function pushTextSlots(t, chars, prId, depth) {
  if (depth > 32) return;
  const kids = t.childNodes;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.nodeType === 3) {
      for (const cp of c.textContent ?? "") {
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
          const w = num2(sz, "width") || num2(findChildByLocalName(ch, "curSz"), "width") || num2(findChildByLocalName(ch, "orgSz"), "width");
          const h = num2(sz, "height") || num2(findChildByLocalName(ch, "curSz"), "height") || num2(findChildByLocalName(ch, "orgSz"), "height");
          objs.push({
            el: ch,
            tag: cn,
            index: chars.length,
            inline: pos?.getAttribute("treatAsChar") === "1",
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
        textpos: num2(s, "textpos"),
        vertpos: num2(s, "vertpos"),
        horzpos: num2(s, "horzpos"),
        horzsize: num2(s, "horzsize"),
        textheight: num2(s, "textheight", 1e3),
        baseline: num2(s, "baseline", 850)
      }));
    }
  }
  return { chars, segs, objs, paraPrId: p.getAttribute("paraPrIDRef") };
}
function charW(c, styles) {
  const st = (c.prId != null ? styles.charPr.get(c.prId) : void 0) ?? DEFAULT_CHAR;
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
  const align = (m.paraPrId != null ? styles.paraAlign.get(m.paraPrId) : void 0) ?? "JUSTIFY";
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
      const st = (prId != null ? ctx.styles.charPr.get(prId) : void 0) ?? DEFAULT_CHAR;
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
          if (st.color) attrs.push(`fill="${escapeXml(st.color)}"`);
          emit(ctx, `<text ${attrs.join(" ")}>${escapeXml(text)}</text>`);
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
  const omT = num2(om, "top"), omB = num2(om, "bottom");
  const w = o.width, h = o.height;
  if (!pos) return { x: ox, y: oy + baseV };
  const vo = num2(pos, "vertOffset");
  const ho = num2(pos, "horzOffset");
  const vrel = pos.getAttribute("vertRelTo") ?? "PARA";
  const hrel = pos.getAttribute("horzRelTo") ?? "PARA";
  const va = pos.getAttribute("vertAlign") ?? "TOP";
  const ha = pos.getAttribute("horzAlign") ?? "LEFT";
  const wrap = o.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM";
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
      const sub = { el: ch, tag, index: 0, inline: true, width: num2(sz, "width"), height: num2(sz, "height") };
      drawObject(sub, x + num2(off, "x"), y + num2(off, "y"), baseV, areaW, ctx, depth + 1);
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
  const ow = num2(orgSz, "width"), oh = num2(orgSz, "height");
  const w = num2(curSz, "width") || ow || o.width;
  const h = num2(curSz, "height") || oh || o.height;
  const sx = ow > 0 ? w / ow : 1;
  const sy = oh > 0 ? h / oh : 1;
  const lineShape = findChildByLocalName(el, "lineShape");
  const lstyle = lineShape?.getAttribute("style") ?? "SOLID";
  const strokeCol = lineShape?.getAttribute("color") || "#000000";
  const hasStroke = lstyle !== "NONE";
  const strokeW = hasStroke ? shapeStrokePt(lineShape ? num2(lineShape, "width") : 33) : 0;
  const dash = /DASH|DOT/.test(lstyle) ? ` stroke-dasharray="${lstyle.includes("DOT") ? "1,1.5" : "3,1.5"}"` : "";
  const strokeAttr = hasStroke ? ` stroke="${escapeXml(strokeCol)}" stroke-width="${strokeW.toFixed(2)}"${dash}` : "";
  const fillBrush = findChildByLocalName(el, "fillBrush");
  const winBrush = fillBrush ? findChildByLocalName(fillBrush, "winBrush") : null;
  const face = winBrush?.getAttribute("faceColor");
  const fill = face && face.toLowerCase() !== "none" ? face : "none";
  const fillAttr = ` fill="${fill === "none" ? "none" : escapeXml(fill)}"`;
  if (o.tag === "rect") {
    emit(ctx, `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}"${fillAttr}${strokeAttr}/>`);
  } else if (o.tag === "ellipse") {
    emit(ctx, `<ellipse cx="${pt(x + w / 2)}" cy="${pt(y + h / 2)}" rx="${pt(w / 2)}" ry="${pt(h / 2)}"${fillAttr}${strokeAttr}/>`);
  } else if (o.tag === "line") {
    const s = findChildByLocalName(el, "startPt"), e = findChildByLocalName(el, "endPt");
    const x1 = x + num2(s, "x") * sx, y1 = y + num2(s, "y") * sy;
    const x2 = x + num2(e, "x") * sx, y2 = y + num2(e, "y") * sy;
    emit(ctx, `<line x1="${pt(x1)}" y1="${pt(y1)}" x2="${pt(x2)}" y2="${pt(y2)}" stroke="${escapeXml(strokeCol)}" stroke-width="${(strokeW || 0.3).toFixed(2)}"${dash}/>`);
  } else if (o.tag === "polygon" || o.tag === "curv") {
    const pts = [];
    for (const c of elements2(el)) if (ln2(c) === "pt") pts.push(`${pt(x + num2(c, "x") * sx)},${pt(y + num2(c, "y") * sy)}`);
    if (pts.length >= 2) emit(ctx, `<polygon points="${pts.join(" ")}"${fillAttr}${strokeAttr}/>`);
  } else if (o.tag === "arc") {
    emit(ctx, `<ellipse cx="${pt(x + w / 2)}" cy="${pt(y + h / 2)}" rx="${pt(w / 2)}" ry="${pt(h / 2)}" fill="none"${strokeAttr || ` stroke="${escapeXml(strokeCol)}" stroke-width="0.3"`}/>`);
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
    const baseV = m.segs[0]?.vertpos ?? 0;
    for (const o of m.objs) {
      if (o.inline) {
        const h = o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el)) : o.height;
        ext = Math.max(ext, baseV + h);
        continue;
      }
      const pos = findChildByLocalName(o.el, "pos");
      if ((pos?.getAttribute("vertRelTo") ?? "PARA") !== "PARA") continue;
      const om = findChildByLocalName(o.el, "outMargin");
      const pushed = baseV - (num2(om, "top") + o.height + num2(om, "bottom"));
      const anchor = pushed >= -100 ? pushed : baseV;
      ext = Math.max(ext, anchor + num2(om, "top") + num2(pos, "vertOffset") + o.height);
    }
  }
  return ext;
}
function edgeLine(x1, y1, x2, y2, e) {
  const dash = /DASH|DOT/.test(e.type) ? ` stroke-dasharray="${e.type.includes("DOT") ? "1,1.5" : "3,1.5"}"` : "";
  return `<line x1="${pt(x1)}" y1="${pt(y1)}" x2="${pt(x2)}" y2="${pt(y2)}" stroke="${escapeXml(e.color)}" stroke-width="${e.widthPt.toFixed(2)}"${dash}/>`;
}
function collectCells(tbl) {
  const inMargin = findChildByLocalName(tbl, "inMargin");
  const defL = num2(inMargin, "left", 141), defR = num2(inMargin, "right", 141);
  const defT = num2(inMargin, "top", 141), defB = num2(inMargin, "bottom", 141);
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
        ca: num2(addr, "colAddr"),
        ra: num2(addr, "rowAddr"),
        cs: Math.max(1, num2(span, "colSpan", 1)),
        rs: Math.max(1, num2(span, "rowSpan", 1)),
        w: num2(csz, "width"),
        h: num2(csz, "height"),
        bfId: tc.getAttribute("borderFillIDRef"),
        sub: findChildByLocalName(tc, "subList"),
        marginL: cm ? num2(cm, "left", defL) : defL,
        marginR: cm ? num2(cm, "right", defR) : defR,
        marginT: cm ? num2(cm, "top", defT) : defT,
        marginB: cm ? num2(cm, "bottom", defB) : defB
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
  const colX = solveBoundaries(colCons, nCols, num2(tblSz, "width") || void 0);
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
    if (bf?.fill) emit(ctx, `<rect x="${pt(g.x)}" y="${pt(g.y)}" width="${pt(g.w)}" height="${pt(g.h)}" fill="${escapeXml(bf.fill)}"/>`);
  }
  for (const g of geom) {
    const { c } = g;
    if (!c.sub) continue;
    const innerH = g.h - c.marginT - c.marginB;
    const extent = cellContentExtent(c);
    const va = c.sub.getAttribute("vertAlign") ?? "TOP";
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
  const w = num2(sz, "width", 5669), h = num2(sz, "height", 5669);
  const img = findFirst(pic, "img");
  const ref = img?.getAttribute("binaryItemIDRef");
  const loaded = ref != null ? ctx.images.get(ref) : void 0;
  if (!loaded) {
    emit(ctx, `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}" fill="#eee" stroke="#c00" stroke-width="0.5"/>`);
    warnOnce(ctx, `img:${ref}`, `\uC774\uBBF8\uC9C0 \uBC14\uC774\uB108\uB9AC \uB204\uB77D: ${ref ?? "(ref \uC5C6\uC74C)"}`);
    return;
  }
  ctx.stats.images++;
  const clip = findChildByLocalName(pic, "imgClip");
  const imgDim = findChildByLocalName(pic, "imgDim");
  const orgSz = findChildByLocalName(pic, "orgSz");
  const dimW = num2(imgDim, "dimwidth"), dimH = num2(imgDim, "dimheight");
  const refW = dimW > 0 ? dimW : num2(orgSz, "width");
  const refH = dimH > 0 ? dimH : num2(orgSz, "height");
  const cl = num2(clip, "left"), ct = num2(clip, "top");
  const cr = num2(clip, "right", refW), cb = num2(clip, "bottom", refH);
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
  let PW = num2(pagePr, "width", 59528), PH = num2(pagePr, "height", 84188);
  if (pagePr?.getAttribute("landscape") === "NARROWLY" && PW < PH) {
    const t = PW;
    PW = PH;
    PH = t;
  }
  const ML = num2(margin, "left", 8504);
  const MT = num2(margin, "top", 5668) + num2(margin, "header", 0);
  const BODY_H = PH - MT - num2(margin, "bottom", 4252) - num2(margin, "footer", 0);
  const BODY_W = PW - ML - num2(margin, "right", 8504);
  return { PW, PH, ML, MT, BODY_W, BODY_H };
}
function renderSectionToPages(root, geom, ctxBase, hasCache, reflowMode) {
  const { PW, PH, ML, MT, BODY_W, BODY_H } = geom;
  if (!hasCache) reflowSection(root, ctxBase.styles, { BODY_W, BODY_H }, reflowMode);
  const colPr = findFirst(root, "colPr");
  const multiCol = num2(colPr, "colCount", 1) > 1;
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
        const v = num2(s, "vertpos");
        const h = num2(s, "horzpos");
        const brk = v < prevV ? !multiCol || h <= prevH : paraFirst && v === prevV && h <= prevH;
        if (brk) cur++;
        paraFirst = false;
        pagesOf.push(cur);
        maxTopV = Math.max(maxTopV, v + num2(s, "textheight", 1e3));
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
  const maxImg = options?.maxImageBytes ?? 40 * 1024 * 1024;
  const ab = input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input;
  precheckZipSize(ab, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES);
  let zip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch {
    throw new KordocError("HWPX(ZIP) \uD615\uC2DD\uC774 \uC544\uB2D9\uB2C8\uB2E4 \u2014 \uB80C\uB354\uB294 HWPX\uB9CC \uC9C0\uC6D0");
  }
  const secFiles = zip.file(/Contents\/section\d+\.xml$/i).sort((a, b) => a.name.localeCompare(b.name));
  if (secFiles.length === 0) throw new KordocError("Contents/section0.xml \uC5C6\uC74C \u2014 HWPX\uAC00 \uC544\uB2C8\uAC70\uB098 \uC190\uC0C1\uB428");
  const warnings = [];
  const headFile = zip.file("Contents/header.xml") ?? zip.file("Contents/head.xml");
  const styles = headFile ? parseRenderStyles(await headFile.async("string")) : { charPr: /* @__PURE__ */ new Map(), paraAlign: /* @__PURE__ */ new Map(), paraGeom: /* @__PURE__ */ new Map(), borderFill: /* @__PURE__ */ new Map() };
  if (!headFile) warnings.push("header.xml \uC5C6\uC74C \u2014 \uAE30\uBCF8 \uC2A4\uD0C0\uC77C\uB85C \uB80C\uB354");
  const secXmls = [];
  for (const f of secFiles) {
    const xml = await f.async("string");
    if (xml.length > MAX_DECOMPRESS_SIZE) throw new KordocError("\uC139\uC158 XML\uC774 \uD5C8\uC6A9 \uD06C\uAE30\uB97C \uCD08\uACFC");
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
      href = cand?.name;
    }
    if (!href) continue;
    const f = zip.file(href) ?? zip.file("Contents/" + href);
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
    highlights: (options?.highlights ?? []).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0),
    warnings,
    warned: /* @__PURE__ */ new Set(),
    stats: { texts: 0, images: 0, tables: 0 }
  };
  const rendered = [];
  let noCacheSkipped = false;
  for (let si = 0; si < secXmls.length; si++) {
    const secXml = secXmls[si];
    const hasCache = /<(?:[A-Za-z][\w.-]*:)?linesegarray[\s/>]/.test(secXml);
    if (!hasCache && !options?.reflow) {
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
    const { pages, pageH } = renderSectionToPages(root, geom, ctxBase, hasCache, options?.reflowMode ?? "keep");
    rendered.push({ pages, PW: geom.PW, pageH, clipId: `pgclip${si}` });
  }
  if (rendered.length === 0) {
    if (noCacheSkipped) {
      throw new KordocError("\uC870\uD310 \uCE90\uC2DC(linesegarray) \uC5C6\uC74C \u2014 \uD55C\uCEF4\uC5D0\uC11C \uC800\uC7A5\uD55C HWPX\uB9CC \uB80C\uB354 \uAC00\uB2A5 (reflow \uC635\uC158\uC73C\uB85C \uD569\uC131 \uB80C\uB354 \uAC00\uB2A5)");
    }
    throw new KordocError("\uB80C\uB354\uD560 \uAD6C\uC5ED\uC774 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 HWPX\uAC00 \uC190\uC0C1\uB418\uC5C8\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4");
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

export {
  charWidthEm1000,
  SPACE_EM_FIXED,
  SPACE_EM_FONT,
  measureTextWidth,
  simulateWrap,
  simulateWrapKeepWord,
  fitRatioForFewerLines,
  renderHwpxToSvg
};
//# sourceMappingURL=chunk-QMJJI6TD.js.map