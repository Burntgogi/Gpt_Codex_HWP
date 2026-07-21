#!/usr/bin/env node
import {
  HEADING_RATIO_H1,
  HEADING_RATIO_H2,
  HEADING_RATIO_H3,
  blocksToMarkdown
} from "./chunk-2IBFK5ZO.js";
import {
  parsePageRange
} from "./chunk-MOL7MDBG.js";
import {
  KordocError,
  safeMax,
  safeMin
} from "./chunk-UNV7F3FK.js";

// src/pdf/line-extract.ts
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
var ORIENTATION_TOL = 2;
var MIN_LINE_LENGTH = 15;
var MAX_LINE_WIDTH = 5;
function extractLines(fnArray, argsArray) {
  const horizontals = [];
  const verticals = [];
  let lineWidth = 1;
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  const applyCtm = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const ctmScale = () => (Math.hypot(ctm[0], ctm[1]) + Math.hypot(ctm[2], ctm[3])) / 2;
  let currentPath = [];
  let pathStartX = 0, pathStartY = 0;
  let curX = 0, curY = 0;
  function pushSeg(x1, y1, x2, y2) {
    const [tx1, ty1] = applyCtm(x1, y1);
    const [tx2, ty2] = applyCtm(x2, y2);
    currentPath.push({ x1: tx1, y1: ty1, x2: tx2, y2: ty2 });
  }
  function pushRectangle(rx, ry, rw, rh) {
    const effH = Math.abs(rh) * Math.hypot(ctm[2], ctm[3]);
    const effW = Math.abs(rw) * Math.hypot(ctm[0], ctm[1]);
    if (effH < ORIENTATION_TOL * 2) {
      pushSeg(rx, ry + rh / 2, rx + rw, ry + rh / 2);
    } else if (effW < ORIENTATION_TOL * 2) {
      pushSeg(rx + rw / 2, ry, rx + rw / 2, ry + rh);
    } else {
      pushSeg(rx, ry, rx + rw, ry);
      pushSeg(rx + rw, ry, rx + rw, ry + rh);
      pushSeg(rx + rw, ry + rh, rx, ry + rh);
      pushSeg(rx, ry + rh, rx, ry);
    }
  }
  function flushPath(isStroke, fromFill = false) {
    if (!isStroke) {
      currentPath = [];
      return;
    }
    const effWidth = lineWidth * ctmScale();
    for (const seg of currentPath) {
      classifyAndAdd(seg, effWidth, horizontals, verticals, fromFill);
    }
    currentPath = [];
  }
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];
    switch (op) {
      case OPS.setLineWidth:
        lineWidth = args[0] || 1;
        break;
      case OPS.save:
        ctmStack.push(ctm.slice());
        break;
      case OPS.restore:
        ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case OPS.transform: {
        const t = args;
        ctm = [
          ctm[0] * t[0] + ctm[2] * t[1],
          ctm[1] * t[0] + ctm[3] * t[1],
          ctm[0] * t[2] + ctm[2] * t[3],
          ctm[1] * t[2] + ctm[3] * t[3],
          ctm[0] * t[4] + ctm[2] * t[5] + ctm[4],
          ctm[1] * t[4] + ctm[3] * t[5] + ctm[5]
        ];
        break;
      }
      case OPS.constructPath: {
        const arg0 = args[0];
        if (Array.isArray(arg0)) {
          const subOps = arg0;
          const coords = args[1];
          let ci = 0;
          for (const subOp of subOps) {
            if (subOp === OPS.moveTo) {
              curX = coords[ci++];
              curY = coords[ci++];
              pathStartX = curX;
              pathStartY = curY;
            } else if (subOp === OPS.lineTo) {
              const x2 = coords[ci++], y2 = coords[ci++];
              pushSeg(curX, curY, x2, y2);
              curX = x2;
              curY = y2;
            } else if (subOp === OPS.rectangle) {
              const rx = coords[ci++], ry = coords[ci++];
              const rw = coords[ci++], rh = coords[ci++];
              pushRectangle(rx, ry, rw, rh);
            } else if (subOp === OPS.closePath) {
              if (curX !== pathStartX || curY !== pathStartY) {
                pushSeg(curX, curY, pathStartX, pathStartY);
              }
              curX = pathStartX;
              curY = pathStartY;
            } else if (subOp === OPS.curveTo) {
              ci += 6;
            } else if (subOp === OPS.curveTo2 || subOp === OPS.curveTo3) {
              ci += 4;
            }
          }
        } else {
          const afterOp = arg0;
          const dataArr = args[1];
          const pathData = dataArr?.[0];
          if (pathData && typeof pathData === "object") {
            const len = Object.keys(pathData).length;
            let di = 0;
            while (di < len) {
              const drawOp = pathData[di++];
              if (drawOp === 0 /* moveTo */) {
                curX = pathData[di++];
                curY = pathData[di++];
                pathStartX = curX;
                pathStartY = curY;
              } else if (drawOp === 1 /* lineTo */) {
                const x2 = pathData[di++], y2 = pathData[di++];
                pushSeg(curX, curY, x2, y2);
                curX = x2;
                curY = y2;
              } else if (drawOp === 2 /* curveTo */) {
                di += 6;
              } else if (drawOp === 3 /* quadraticCurveTo */) {
                di += 4;
              } else if (drawOp === 4 /* closePath */) {
                if (curX !== pathStartX || curY !== pathStartY) {
                  pushSeg(curX, curY, pathStartX, pathStartY);
                }
                curX = pathStartX;
                curY = pathStartY;
              } else {
                break;
              }
            }
          }
          if (afterOp === OPS.stroke || afterOp === OPS.closeStroke) {
            flushPath(true);
          } else if (afterOp === OPS.fill || afterOp === OPS.eoFill) {
            flushPath(true, true);
          } else if (afterOp === OPS.fillStroke || afterOp === OPS.eoFillStroke || afterOp === OPS.closeFillStroke || afterOp === OPS.closeEOFillStroke) {
            flushPath(true);
          } else if (afterOp === OPS.endPath) {
            flushPath(false);
          }
        }
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
        flushPath(true);
        break;
      case OPS.fill:
      case OPS.eoFill:
        flushPath(true, true);
        break;
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        flushPath(true);
        break;
      case OPS.endPath:
        flushPath(false);
        break;
    }
  }
  return { horizontals, verticals };
}
function classifyAndAdd(seg, lineWidth, horizontals, verticals, fromFill = false) {
  const dx = Math.abs(seg.x2 - seg.x1);
  const dy = Math.abs(seg.y2 - seg.y1);
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < MIN_LINE_LENGTH) return;
  if (dy <= ORIENTATION_TOL) {
    const y = (seg.y1 + seg.y2) / 2;
    const x1 = Math.min(seg.x1, seg.x2);
    const x2 = Math.max(seg.x1, seg.x2);
    horizontals.push({ x1, y1: y, x2, y2: y, lineWidth, fromFill });
  } else if (dx <= ORIENTATION_TOL) {
    const x = (seg.x1 + seg.x2) / 2;
    const y1 = Math.min(seg.y1, seg.y2);
    const y2 = Math.max(seg.y1, seg.y2);
    verticals.push({ x1: x, y1, x2: x, y2, lineWidth, fromFill });
  }
}
function preprocessLines(horizontals, verticals) {
  let h = horizontals.filter((l) => l.lineWidth <= MAX_LINE_WIDTH);
  let v = verticals.filter((l) => l.lineWidth <= MAX_LINE_WIDTH);
  h = dropShadingStacks(h, "h");
  v = dropShadingStacks(v, "v");
  h = mergeParallelLines(h, "h");
  v = mergeParallelLines(v, "v");
  return { horizontals: h, verticals: v };
}
var STACK_GAP = 2;
var STACK_MIN_LINES = 6;
function dropShadingStacks(lines, dir) {
  if (lines.length < STACK_MIN_LINES) return lines;
  const groups = /* @__PURE__ */ new Map();
  for (const l of lines) {
    const key = dir === "h" ? `${Math.round(l.x1)}:${Math.round(l.x2)}` : `${Math.round(l.y1)}:${Math.round(l.y2)}`;
    const arr = groups.get(key);
    if (arr) arr.push(l);
    else groups.set(key, [l]);
  }
  const dropped = /* @__PURE__ */ new Set();
  const coord = (l) => dir === "h" ? l.y1 : l.x1;
  for (const group of groups.values()) {
    if (group.length < STACK_MIN_LINES) continue;
    group.sort((a, b) => coord(a) - coord(b));
    let runStart = 0;
    for (let i = 1; i <= group.length; i++) {
      const gap = i < group.length ? coord(group[i]) - coord(group[i - 1]) : Infinity;
      if (gap < STACK_GAP) continue;
      if (i - runStart >= STACK_MIN_LINES) {
        let s = runStart;
        let e = i - 1;
        const wKey = (l) => Math.round(l.lineWidth * 100);
        const wCount = /* @__PURE__ */ new Map();
        for (let j = s; j <= e; j++) wCount.set(wKey(group[j]), (wCount.get(wKey(group[j])) ?? 0) + 1);
        let domW = 0;
        let domN = 0;
        for (const [w, n] of wCount) if (n > domN) {
          domW = w;
          domN = n;
        }
        const pitches = [];
        for (let j = s + 1; j <= e; j++) pitches.push(coord(group[j]) - coord(group[j - 1]));
        pitches.sort((a, b) => a - b);
        const medPitch = pitches[Math.floor(pitches.length / 2)] ?? 0;
        let fillN = 0;
        for (let j = s; j <= e; j++) if (group[j].fromFill) fillN++;
        const stackIsFill = fillN * 2 > e - s + 1;
        const edgeAlien = (j, inwardGap) => stackIsFill && !group[j].fromFill || wKey(group[j]) !== domW || medPitch > 0 && inwardGap > medPitch * 1.8;
        while (e - s + 1 >= STACK_MIN_LINES) {
          if (edgeAlien(s, coord(group[s + 1]) - coord(group[s]))) {
            s++;
            continue;
          }
          if (edgeAlien(e, coord(group[e]) - coord(group[e - 1]))) {
            e--;
            continue;
          }
          break;
        }
        if (e - s + 1 >= STACK_MIN_LINES) {
          for (let j = s; j <= e; j++) dropped.add(group[j]);
        }
      }
      runStart = i;
    }
  }
  return dropped.size ? lines.filter((l) => !dropped.has(l)) : lines;
}
var EDGE_ALIGN_TOL = 3;
var EDGE_MIN_RULES = 3;
var EDGE_MIN_SPAN = 12;
var EDGE_INSET = 15;
var EDGE_NEAR = 10;
var EDGE_CONNECT_TOL = 5;
var EDGE_YGAP_SPLIT_K = 2.5;
var EDGE_YGAP_ABS_MIN = 30;
var CHAIN_Y_TOL = 1.5;
var CHAIN_GAP = 3;
function chainCollinearRules(horizontals) {
  if (horizontals.length <= 1) return horizontals;
  const sorted = [...horizontals].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  const rules = [];
  let bandStart = 0;
  const flushBand = (end) => {
    const band = sorted.slice(bandStart, end).sort((a, b) => a.x1 - b.x1);
    let cur = { ...band[0] };
    for (let i = 1; i < band.length; i++) {
      const seg = band[i];
      if (seg.x1 - cur.x2 <= CHAIN_GAP) {
        if (seg.x2 > cur.x2) cur.x2 = seg.x2;
        if (seg.lineWidth > cur.lineWidth) cur.lineWidth = seg.lineWidth;
      } else {
        rules.push(cur);
        cur = { ...seg };
      }
    }
    rules.push(cur);
  };
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i].y1 - sorted[bandStart].y1 > CHAIN_Y_TOL) {
      flushBand(i);
      bandStart = i;
    }
  }
  return rules;
}
function closeOpenTableEdges(horizontals, verticals) {
  if (horizontals.length < EDGE_MIN_RULES) return verticals;
  const groups = [];
  for (const hl of chainCollinearRules(horizontals)) {
    let placed = false;
    for (const g2 of groups) {
      if (Math.abs(g2[0].x1 - hl.x1) <= EDGE_ALIGN_TOL && Math.abs(g2[0].x2 - hl.x2) <= EDGE_ALIGN_TOL) {
        g2.push(hl);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([hl]);
  }
  const splitGroups = [];
  for (const g2 of groups) {
    const sorted = [...g2].sort((a, b) => a.y1 - b.y1);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].y1 - sorted[i - 1].y1);
    const median = gaps.length ? [...gaps].sort((a, b) => a - b)[gaps.length >> 1] : 0;
    const threshold = median * EDGE_YGAP_SPLIT_K;
    let cur = sorted.length ? [sorted[0]] : [];
    for (let i = 1; i < sorted.length; i++) {
      const yLo = sorted[i - 1].y1, yHi = sorted[i].y1;
      const gap = yHi - yLo;
      const gx1 = Math.min(sorted[i - 1].x1, sorted[i].x1);
      const gx2 = Math.max(sorted[i - 1].x2, sorted[i].x2);
      const bridged = verticals.some((vl) => vl.y1 <= yLo + EDGE_NEAR && vl.y2 >= yHi - EDGE_NEAR && vl.x1 >= gx1 - EDGE_CONNECT_TOL && vl.x1 <= gx2 + EDGE_CONNECT_TOL);
      if (median > 0 && gap > threshold && gap > EDGE_YGAP_ABS_MIN && !bridged && cur.length >= EDGE_MIN_RULES && sorted.length - i >= EDGE_MIN_RULES) {
        splitGroups.push(cur);
        cur = [];
      }
      cur.push(sorted[i]);
    }
    if (cur.length) splitGroups.push(cur);
  }
  const synthesized = [];
  for (const g2 of splitGroups) {
    if (g2.length < EDGE_MIN_RULES) continue;
    let yMin = Infinity, yMax = -Infinity, x1 = 0, x2 = 0;
    for (const hl of g2) {
      if (hl.y1 < yMin) yMin = hl.y1;
      if (hl.y1 > yMax) yMax = hl.y1;
      x1 += hl.x1;
      x2 += hl.x2;
    }
    x1 /= g2.length;
    x2 /= g2.length;
    if (yMax - yMin < EDGE_MIN_SPAN) continue;
    const crossCount = (v) => {
      let n = 0;
      for (const hl of g2) {
        if (v.x1 >= hl.x1 - EDGE_CONNECT_TOL && v.x1 <= hl.x2 + EDGE_CONNECT_TOL && hl.y1 >= v.y1 - EDGE_CONNECT_TOL && hl.y1 <= v.y2 + EDGE_CONNECT_TOL) n++;
      }
      return n;
    };
    const hasInterior = verticals.some((v) => v.x1 > x1 + EDGE_INSET && v.x1 < x2 - EDGE_INSET && crossCount(v) >= 2);
    if (!hasInterior) continue;
    for (const edgeX of [x1, x2]) {
      const closed = verticals.some((v) => Math.abs(v.x1 - edgeX) <= EDGE_NEAR && v.y1 <= yMax + EDGE_CONNECT_TOL && v.y2 >= yMin - EDGE_CONNECT_TOL);
      if (!closed) {
        synthesized.push({ x1: edgeX, y1: yMin, x2: edgeX, y2: yMax, lineWidth: 0.5 });
      }
    }
  }
  return synthesized.length ? [...verticals, ...synthesized] : verticals;
}
function mergeParallelLines(lines, dir) {
  if (lines.length <= 1) return lines;
  const sorted = [...lines].sort((a, b) => {
    const posA = dir === "h" ? a.y1 : a.x1;
    const posB = dir === "h" ? b.y1 : b.x1;
    if (Math.abs(posA - posB) > 0.1) return posA - posB;
    return dir === "h" ? a.x1 - b.x1 : a.y1 - b.y1;
  });
  const MERGE_TOL = 3;
  const result = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1];
    const curr = sorted[i];
    const prevPos = dir === "h" ? prev.y1 : prev.x1;
    const currPos = dir === "h" ? curr.y1 : curr.x1;
    if (Math.abs(prevPos - currPos) <= MERGE_TOL) {
      const prevStart = dir === "h" ? prev.x1 : prev.y1;
      const prevEnd = dir === "h" ? prev.x2 : prev.y2;
      const currStart = dir === "h" ? curr.x1 : curr.y1;
      const currEnd = dir === "h" ? curr.x2 : curr.y2;
      const overlap = Math.min(prevEnd, currEnd) - Math.max(prevStart, currStart);
      const minLen = Math.min(prevEnd - prevStart, currEnd - currStart);
      if (overlap > minLen * 0.3) {
        if (dir === "h") {
          prev.x1 = Math.min(prev.x1, curr.x1);
          prev.x2 = Math.max(prev.x2, curr.x2);
          prev.y1 = (prev.y1 + curr.y1) / 2;
          prev.y2 = prev.y1;
        } else {
          prev.y1 = Math.min(prev.y1, curr.y1);
          prev.y2 = Math.max(prev.y2, curr.y2);
          prev.x1 = (prev.x1 + curr.x1) / 2;
          prev.x2 = prev.x1;
        }
        prev.lineWidth = Math.max(prev.lineWidth, curr.lineWidth);
        continue;
      }
    }
    result.push(curr);
  }
  return result;
}
function filterPageBorderLines(horizontals, verticals, pageWidth, pageHeight) {
  const margin = 5;
  return {
    horizontals: horizontals.filter(
      (l) => !(Math.abs(l.y1) < margin || Math.abs(l.y1 - pageHeight) < margin) || l.x2 - l.x1 < pageWidth * 0.9
    ),
    verticals: verticals.filter(
      (l) => !(Math.abs(l.x1) < margin || Math.abs(l.x1 - pageWidth) < margin) || l.y2 - l.y1 < pageHeight * 0.9
    )
  };
}

// src/pdf/image-regions.ts
import { OPS as OPS2 } from "pdfjs-dist/legacy/build/pdf.mjs";
function multiplyTransform(m, t) {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5]
  ];
}
function extractImageRegions(fnArray, argsArray) {
  const regions = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    switch (op) {
      case OPS2.save:
        stack.push(ctm);
        break;
      case OPS2.restore:
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        break;
      case OPS2.transform: {
        const t = argsArray[i];
        if (Array.isArray(t) && t.length >= 6) ctm = multiplyTransform(ctm, t);
        break;
      }
      case OPS2.paintImageXObject:
      case OPS2.paintInlineImageXObject:
      case OPS2.paintImageMaskXObject:
      case OPS2.paintImageXObjectRepeat: {
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const [u, v] of corners) {
          const x = ctm[0] * u + ctm[2] * v + ctm[4];
          const y = ctm[1] * u + ctm[3] * v + ctm[5];
          if (x < x1) x1 = x;
          if (x > x2) x2 = x;
          if (y < y1) y1 = y;
          if (y > y2) y2 = y;
        }
        if (x2 - x1 > 0 && y2 - y1 > 0) regions.push({ x1, y1, x2, y2 });
        break;
      }
    }
  }
  return regions;
}

// src/pdf/line-types.ts
var VERTEX_MERGE_FACTOR = 4;

// src/pdf/table-grid.ts
var CONNECT_TOL = 5;
var MIN_COL_WIDTH = 15;
var MIN_ROW_HEIGHT = 6;
var MIN_COORD_MERGE_TOL = 8;
function buildVertices(horizontals, verticals) {
  const vertices = [];
  const tol = CONNECT_TOL;
  for (const h of horizontals) {
    for (const v of verticals) {
      if (v.x1 >= h.x1 - tol && v.x1 <= h.x2 + tol && h.y1 >= v.y1 - tol && h.y1 <= v.y2 + tol) {
        const radius = Math.max(h.lineWidth, v.lineWidth, 1);
        vertices.push({ x: v.x1, y: h.y1, radius });
      }
    }
  }
  return vertices;
}
function mergeVertices(vertices) {
  if (vertices.length <= 1) return vertices;
  const merged = [];
  const used = new Array(vertices.length).fill(false);
  for (let i = 0; i < vertices.length; i++) {
    if (used[i]) continue;
    let sumX = vertices[i].x, sumY = vertices[i].y;
    let maxRadius = vertices[i].radius;
    let count = 1;
    for (let j = i + 1; j < vertices.length; j++) {
      if (used[j]) continue;
      const mergeTol = VERTEX_MERGE_FACTOR * Math.max(maxRadius, vertices[j].radius);
      if (Math.abs(vertices[i].x - vertices[j].x) <= mergeTol && Math.abs(vertices[i].y - vertices[j].y) <= mergeTol) {
        sumX += vertices[j].x;
        sumY += vertices[j].y;
        maxRadius = Math.max(maxRadius, vertices[j].radius);
        count++;
        used[j] = true;
      }
    }
    merged.push({ x: sumX / count, y: sumY / count, radius: maxRadius });
  }
  return merged;
}
function buildTableGrids(horizontals, verticals) {
  if (horizontals.length < 2 || verticals.length < 2) return [];
  const allVertices = buildVertices(horizontals, verticals);
  const vertices = mergeVertices(allVertices);
  if (vertices.length < 4) return [];
  const globalRadius = vertices.reduce((max, v) => Math.max(max, v.radius), 1);
  const allLines = [
    ...horizontals.map((l, i) => ({ ...l, type: "h", id: i })),
    ...verticals.map((l, i) => ({ ...l, type: "v", id: i + horizontals.length }))
  ];
  const groups = groupConnectedLines(allLines);
  const grids = [];
  for (const group of groups) {
    const hLines = group.filter((l) => l.type === "h");
    const vLines = group.filter((l) => l.type === "v");
    if (hLines.length < 2 || vLines.length < 2) continue;
    let gx1 = Infinity, gy1 = Infinity, gx2 = -Infinity, gy2 = -Infinity;
    for (const l of vLines) {
      if (l.x1 < gx1) gx1 = l.x1;
      if (l.x1 > gx2) gx2 = l.x1;
    }
    for (const l of hLines) {
      if (l.y1 < gy1) gy1 = l.y1;
      if (l.y1 > gy2) gy2 = l.y1;
    }
    const groupBbox = {
      x1: gx1 - CONNECT_TOL,
      y1: gy1 - CONNECT_TOL,
      x2: gx2 + CONNECT_TOL,
      y2: gy2 + CONNECT_TOL
    };
    const groupVertices = vertices.filter(
      (v) => v.x >= groupBbox.x1 && v.x <= groupBbox.x2 && v.y >= groupBbox.y1 && v.y <= groupBbox.y2
    );
    const groupRadius = groupVertices.length > 0 ? groupVertices.reduce((max, v) => Math.max(max, v.radius), 1) : globalRadius;
    const coordMergeTol = Math.max(VERTEX_MERGE_FACTOR * groupRadius, MIN_COORD_MERGE_TOL);
    const rawYs = [
      ...hLines.map((l) => l.y1),
      ...groupVertices.map((v) => v.y)
    ];
    const rowYs = clusterCoordinates(rawYs, coordMergeTol).sort((a, b) => b - a);
    const rawXs = [
      ...vLines.map((l) => l.x1),
      ...groupVertices.map((v) => v.x)
    ];
    const colXs = clusterCoordinates(rawXs, coordMergeTol).sort((a, b) => a - b);
    if (rowYs.length < 2 || colXs.length < 2) continue;
    const validColXs = enforceMinWidth(colXs, MIN_COL_WIDTH);
    const validRowYs = enforceMinHeight(rowYs, MIN_ROW_HEIGHT);
    if (validRowYs.length < 2 || validColXs.length < 2) continue;
    const bbox = {
      x1: validColXs[0],
      y1: validRowYs[validRowYs.length - 1],
      x2: validColXs[validColXs.length - 1],
      y2: validRowYs[0]
    };
    grids.push({ rowYs: validRowYs, colXs: validColXs, bbox, vertexRadius: groupRadius });
  }
  return mergeAdjacentGrids(grids);
}
function enforceMinWidth(colXs, minWidth) {
  if (colXs.length <= 2) return colXs;
  const result = [colXs[0]];
  for (let i = 1; i < colXs.length; i++) {
    const prevX = result[result.length - 1];
    if (colXs[i] - prevX < minWidth && i < colXs.length - 1) {
      continue;
    }
    result.push(colXs[i]);
  }
  return result;
}
function enforceMinHeight(rowYs, minHeight) {
  if (rowYs.length <= 2) return rowYs;
  const result = [rowYs[0]];
  for (let i = 1; i < rowYs.length; i++) {
    const prevY = result[result.length - 1];
    if (prevY - rowYs[i] < minHeight && i < rowYs.length - 1) {
      continue;
    }
    result.push(rowYs[i]);
  }
  return result;
}
function mergeAdjacentGrids(grids) {
  if (grids.length <= 1) return grids;
  const sorted = [...grids].sort((a, b) => b.bbox.y2 - a.bbox.y2);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (prev.colXs.length === curr.colXs.length) {
      const mergeTol = Math.max(VERTEX_MERGE_FACTOR * Math.max(prev.vertexRadius, curr.vertexRadius), 6) * 3;
      const colMatch = prev.colXs.every((x, ci) => Math.abs(x - curr.colXs[ci]) <= mergeTol);
      const verticalGap = prev.bbox.y1 - curr.bbox.y2;
      if (colMatch && verticalGap >= -CONNECT_TOL && verticalGap <= 20) {
        const allRowYs = [.../* @__PURE__ */ new Set([...prev.rowYs, ...curr.rowYs])].sort((a, b) => b - a);
        merged[merged.length - 1] = {
          rowYs: allRowYs,
          colXs: prev.colXs,
          bbox: {
            x1: Math.min(prev.bbox.x1, curr.bbox.x1),
            y1: Math.min(prev.bbox.y1, curr.bbox.y1),
            x2: Math.max(prev.bbox.x2, curr.bbox.x2),
            y2: Math.max(prev.bbox.y2, curr.bbox.y2)
          },
          vertexRadius: Math.max(prev.vertexRadius, curr.vertexRadius)
        };
        continue;
      }
    }
    merged.push(curr);
  }
  return merged;
}
function clusterCoordinates(values, tolerance) {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [{ sum: sorted[0], count: 1 }];
  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    const avg = last.sum / last.count;
    if (Math.abs(sorted[i] - avg) <= tolerance) {
      last.sum += sorted[i];
      last.count++;
    } else {
      clusters.push({ sum: sorted[i], count: 1 });
    }
  }
  return clusters.map((c) => c.sum / c.count);
}
function groupConnectedLines(lines) {
  const parent = lines.map((_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (linesIntersect(lines[i], lines[j])) {
        union(i, j);
      }
    }
  }
  const groups = /* @__PURE__ */ new Map();
  for (let i = 0; i < lines.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(lines[i]);
  }
  return [...groups.values()];
}
function linesIntersect(a, b) {
  if (a.type === b.type) {
    if (a.type === "h") {
      if (Math.abs(a.y1 - b.y1) > CONNECT_TOL) return false;
      return Math.min(a.x2, b.x2) >= Math.max(a.x1, b.x1) - CONNECT_TOL;
    } else {
      if (Math.abs(a.x1 - b.x1) > CONNECT_TOL) return false;
      return Math.min(a.y2, b.y2) >= Math.max(a.y1, b.y1) - CONNECT_TOL;
    }
  }
  const h = a.type === "h" ? a : b;
  const v = a.type === "h" ? b : a;
  const tol = CONNECT_TOL;
  return v.x1 >= h.x1 - tol && v.x1 <= h.x2 + tol && h.y1 >= v.y1 - tol && h.y1 <= v.y2 + tol;
}

// src/pdf/cell-extract.ts
function extractCells(grid, horizontals, verticals) {
  const { rowYs, colXs } = grid;
  const numRows = rowYs.length - 1;
  const numCols = colXs.length - 1;
  if (numRows <= 0 || numCols <= 0) return [];
  const vBorders = Array.from(
    { length: numRows },
    (_, r) => Array.from(
      { length: numCols + 1 },
      (_2, c) => hasVerticalLine(verticals, colXs[c], rowYs[r], rowYs[r + 1], grid.vertexRadius)
    )
  );
  const hBorders = Array.from(
    { length: numRows + 1 },
    (_, r) => Array.from(
      { length: numCols },
      (_2, c) => hasHorizontalLine(horizontals, rowYs[r], colXs[c], colXs[c + 1], grid.vertexRadius)
    )
  );
  const occupied = Array.from({ length: numRows }, () => Array(numCols).fill(false));
  const cells = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (occupied[r][c]) continue;
      let colSpan = 1;
      let rowSpan = 1;
      while (c + colSpan < numCols && !vBorders[r][c + colSpan]) {
        let canExpand = true;
        for (let dr = 0; dr < rowSpan; dr++) {
          if (vBorders[r + dr][c + colSpan]) {
            canExpand = false;
            break;
          }
        }
        if (!canExpand) break;
        colSpan++;
      }
      while (r + rowSpan < numRows) {
        let hasLine = false;
        for (let dc = 0; dc < colSpan; dc++) {
          if (hBorders[r + rowSpan][c + dc]) {
            hasLine = true;
            break;
          }
        }
        if (hasLine) break;
        rowSpan++;
      }
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          occupied[r + dr][c + dc] = true;
        }
      }
      cells.push({
        row: r,
        col: c,
        rowSpan,
        colSpan,
        bbox: {
          x1: colXs[c],
          y1: rowYs[r + rowSpan],
          x2: colXs[c + colSpan],
          y2: rowYs[r]
        }
      });
    }
  }
  return cells;
}
function hasVerticalLine(verticals, x, topY, botY, vertexRadius) {
  const tol = Math.max(VERTEX_MERGE_FACTOR * vertexRadius, 4);
  for (const v of verticals) {
    if (Math.abs(v.x1 - x) <= tol) {
      const cellH = Math.abs(topY - botY);
      if (cellH < 0.1) continue;
      const overlapTop = Math.min(v.y2, topY);
      const overlapBot = Math.max(v.y1, botY);
      const overlap = overlapTop - overlapBot;
      if (overlap >= cellH * 0.75) return true;
    }
  }
  return false;
}
function hasHorizontalLine(horizontals, y, leftX, rightX, vertexRadius) {
  const tol = Math.max(VERTEX_MERGE_FACTOR * vertexRadius, 4);
  for (const h of horizontals) {
    if (Math.abs(h.y1 - y) <= tol) {
      const cellW = Math.abs(rightX - leftX);
      if (cellW < 0.1) continue;
      const overlapLeft = Math.max(h.x1, leftX);
      const overlapRight = Math.min(h.x2, rightX);
      const overlap = overlapRight - overlapLeft;
      if (overlap >= cellW * 0.75) return true;
    }
  }
  return false;
}

// src/pdf/cell-text.ts
var CELL_PADDING = 2;
var SPACE_GAP_RATIO = 0.17;
function spaceGapThreshold(fontSize) {
  return Math.max(fontSize * SPACE_GAP_RATIO, 1);
}
function mapTextToCells(items, cells) {
  const result = /* @__PURE__ */ new Map();
  for (const cell of cells) {
    result.set(cell, []);
  }
  for (const item of items) {
    const pad = CELL_PADDING;
    let bestCell = null;
    let bestScore = 0;
    for (const cell of cells) {
      const ix1 = Math.max(item.x, cell.bbox.x1 - pad);
      const ix2 = Math.min(item.x + item.w, cell.bbox.x2 + pad);
      const iy1 = Math.max(item.y, cell.bbox.y1 - pad);
      const iy2 = Math.min(item.y + (item.h || item.fontSize), cell.bbox.y2 + pad);
      if (ix1 >= ix2 || iy1 >= iy2) continue;
      const intersectArea = (ix2 - ix1) * (iy2 - iy1);
      const itemArea = Math.max(item.w, 1) * Math.max(item.h || item.fontSize, 1);
      const score = intersectArea / itemArea;
      if (score > bestScore) {
        bestScore = score;
        bestCell = cell;
      }
    }
    if (bestCell && bestScore > 0.3) {
      result.get(bestCell).push(item);
    }
  }
  return result;
}
function cellTextToString(items) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0].text;
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let curLine = [sorted[0]];
  let curY = sorted[0].y;
  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(3, Math.min(sorted[i].fontSize, curLine[0].fontSize) * 0.6);
    if (Math.abs(sorted[i].y - curY) <= tol) {
      curLine.push(sorted[i]);
    } else {
      lines.push(curLine);
      curLine = [sorted[i]];
      curY = sorted[i].y;
    }
  }
  lines.push(curLine);
  const textLines = lines.map((line) => {
    const s = line.sort((a, b) => a.x - b.x);
    if (s.length === 1) return s[0].text;
    const evenSpaced = detectEvenSpacedItems(s);
    let result = s[0].text;
    for (let j = 1; j < s.length; j++) {
      if (evenSpaced[j]) {
        result += s[j].text;
        continue;
      }
      const gap = s[j].x - (s[j - 1].x + s[j - 1].w);
      const avgFs = (s[j].fontSize + s[j - 1].fontSize) / 2;
      if (s[j].hasSpaceBefore && gap >= avgFs * 0.05) {
        result += " " + s[j].text;
      } else if (gap > spaceGapThreshold(avgFs)) {
        result += " " + s[j].text;
      } else {
        result += s[j].text;
      }
    }
    return result;
  });
  return mergeCellTextLines(textLines);
}
function detectEvenSpacedItems(items) {
  const result = new Array(items.length).fill(false);
  if (items.length < 3) return result;
  let runStart = -1;
  for (let i = 0; i < items.length; i++) {
    const isShortKorean = /^[가-힣]{1}$/.test(items[i].text) || /^[\d]{1}$/.test(items[i].text);
    if (isShortKorean && runStart >= 0 && items[i].hasSpaceBefore) {
      if (i - runStart >= 3) markEvenRun(items, result, runStart, i);
      runStart = i;
      continue;
    }
    if (isShortKorean && runStart >= 0 && i > 0) {
      const gap = items[i].x - (items[i - 1].x + items[i - 1].w);
      const maxRunGap = Math.max(items[i].fontSize * 3, 30);
      if (gap > maxRunGap) {
        if (i - runStart >= 3) markEvenRun(items, result, runStart, i);
        runStart = i;
        continue;
      }
    }
    if (isShortKorean) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && i - runStart >= 3) {
        markEvenRun(items, result, runStart, i);
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && items.length - runStart >= 3) {
    markEvenRun(items, result, runStart, items.length);
  }
  return result;
}
function markEvenRun(items, result, start, end) {
  const gaps = [];
  for (let i = start + 1; i < end; i++) {
    gaps.push(items[i].x - (items[i - 1].x + items[i - 1].w));
  }
  const posGaps = gaps.filter((g2) => g2 > 0);
  if (posGaps.length < 2) return;
  let minGap = Infinity, maxGap = -Infinity;
  for (const g2 of posGaps) {
    if (g2 < minGap) minGap = g2;
    if (g2 > maxGap) maxGap = g2;
  }
  const avgFs = items[start].fontSize;
  if (minGap >= avgFs * 0.1 && maxGap <= avgFs * 3 && maxGap / Math.max(minGap, 0.1) <= 3) {
    for (let i = start + 1; i < end; i++) {
      result[i] = true;
    }
  }
}
function mergeCellTextLines(textLines) {
  if (textLines.length <= 1) return textLines[0] || "";
  const merged = [textLines[0]];
  for (let i = 1; i < textLines.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = textLines[i];
    if (/[가-힣]$/.test(prev) && /^[가-힣]+$/.test(curr) && curr.length <= 8 && !curr.includes(" ")) {
      merged[merged.length - 1] = prev + curr;
    } else if (curr.trim().length <= 3 && /^[)\]%}]/.test(curr.trim())) {
      merged[merged.length - 1] = prev + curr.trim();
    } else if (/[,(]$/.test(prev.trim()) && curr.trim().length <= 15) {
      merged[merged.length - 1] = prev + curr.trim();
    } else if (/[\d,]$/.test(prev) && /^[\d,]+[)\]]?$/.test(curr.trim()) && curr.trim().length <= 10) {
      merged[merged.length - 1] = prev + curr.trim();
    } else {
      merged.push(curr);
    }
  }
  return merged.join("\n");
}

// src/pdf/undersegmented.ts
var MAX_UNDERSEGMENTED_ROWS = 2;
var MIN_UNDERSEGMENTED_COLUMNS = 3;
var MIN_UNDERSEGMENTED_TEXT_LINES = 8;
var MIN_ROW_BAND_MISMATCH = 2;
var MIN_ROW_BAND_EPSILON = 3;
var ROW_BAND_EPSILON_RATIO = 0.6;
function itemCenterY(item) {
  return item.y + (item.h > 0 ? item.h : item.fontSize) / 2;
}
function itemHeight(item) {
  return item.h > 0 ? item.h : item.fontSize;
}
function findColumnIndex(item, colXs) {
  const cx = item.x + item.w / 2;
  for (let c = 0; c < colXs.length - 1; c++) {
    if (cx >= colXs[c] && cx <= colXs[c + 1]) return c;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let c = 0; c < colXs.length - 1; c++) {
    const center = (colXs[c] + colXs[c + 1]) / 2;
    const d = Math.abs(cx - center);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
function groupItemsToVisualLines(items) {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = [sorted[0]];
  let curY = sorted[0].y;
  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(3, Math.min(sorted[i].fontSize, cur[0].fontSize) * 0.6);
    if (Math.abs(sorted[i].y - curY) <= tol) {
      cur.push(sorted[i]);
    } else {
      lines.push(cur);
      cur = [sorted[i]];
      curY = sorted[i].y;
    }
  }
  lines.push(cur);
  return lines;
}
function normalizeUndersegmentedTable(originalCells, colXs, items) {
  const numRows = originalCells.length;
  const numCols = colXs.length - 1;
  if (numRows > MAX_UNDERSEGMENTED_ROWS || numCols < MIN_UNDERSEGMENTED_COLUMNS) return null;
  if (items.length === 0) return null;
  const itemsByCol = Array.from({ length: numCols }, () => []);
  for (const item of items) {
    if (!item.text.trim()) continue;
    itemsByCol[findColumnIndex(item, colXs)].push(item);
  }
  let denseColumns = 0;
  for (const colItems of itemsByCol) {
    if (groupItemsToVisualLines(colItems).length >= MIN_UNDERSEGMENTED_TEXT_LINES) denseColumns++;
  }
  if (denseColumns < 2) return null;
  const allLines = groupItemsToVisualLines(items.filter((i) => i.text.trim()));
  const bands = [];
  for (const line of allLines) {
    let cy = 0, h = 0;
    for (const it of line) {
      cy += itemCenterY(it);
      h += itemHeight(it);
    }
    cy /= line.length;
    h /= line.length;
    const top = cy + h / 2;
    const bottom = cy - h / 2;
    let matched = null;
    for (const band of bands) {
      const epsilon = Math.max(MIN_ROW_BAND_EPSILON, Math.min(band.avgHeight, h) * ROW_BAND_EPSILON_RATIO);
      if (Math.abs(band.centerY - cy) <= epsilon || bottom <= band.topY && top >= band.bottomY) {
        matched = band;
        break;
      }
    }
    if (!matched) {
      matched = { centerY: 0, avgHeight: 0, topY: -Infinity, bottomY: Infinity, lineCount: 0, itemsByCol: Array.from({ length: numCols }, () => []) };
      bands.push(matched);
    }
    matched.centerY = (matched.centerY * matched.lineCount + cy) / (matched.lineCount + 1);
    matched.avgHeight = (matched.avgHeight * matched.lineCount + h) / (matched.lineCount + 1);
    matched.topY = Math.max(matched.topY, top);
    matched.bottomY = Math.min(matched.bottomY, bottom);
    matched.lineCount++;
    for (const it of line) {
      matched.itemsByCol[findColumnIndex(it, colXs)].push(it);
    }
  }
  if (bands.length < numRows + MIN_ROW_BAND_MISMATCH) return null;
  bands.sort((a, b) => b.centerY - a.centerY);
  const rebuilt = bands.map(
    (band) => band.itemsByCol.map((colItems) => colItems.length > 0 ? cellTextToString(colItems) : "")
  );
  const countNonEmptyRows = (cells) => cells.filter((row) => row.some((c) => (typeof c === "string" ? c : c.text).trim() !== "")).length;
  const countNonEmptyCols = (cells, cols) => {
    let n = 0;
    for (let c = 0; c < cols; c++) {
      if (cells.some((row) => row[c] != null && (typeof row[c] === "string" ? row[c] : row[c].text).trim() !== "")) n++;
    }
    return n;
  };
  if (countNonEmptyRows(rebuilt) <= countNonEmptyRows(originalCells)) return null;
  if (countNonEmptyCols(rebuilt, numCols) < countNonEmptyCols(originalCells, numCols)) return null;
  return rebuilt;
}

// src/pdf/quality.ts
function computePageQuality(page, text) {
  let total = 0;
  let hangul = 0;
  let control = 0;
  let replacement = 0;
  let pua = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    total++;
    if (code < 32 || code === 127 || code >= 128 && code <= 159) {
      control++;
      continue;
    }
    if (code === 65533) {
      replacement++;
      continue;
    }
    if (code >= 44032 && code <= 55203) {
      hangul++;
      continue;
    }
    if (code >= 57344 && code <= 63743 || code >= 56192 && code <= 56319) {
      pua++;
      continue;
    }
  }
  const denom = total || 1;
  const puaRatio = pua / denom;
  const controlCharRatio = control / denom;
  const replacementCharRatio = replacement / denom;
  let needsOcr = false;
  let ocrReason;
  if (total < LOW_TEXT_THRESHOLD) {
    needsOcr = true;
    ocrReason = "low_text";
  } else if (puaRatio >= HIGH_PUA_THRESHOLD) {
    needsOcr = true;
    ocrReason = "high_pua";
  } else if (controlCharRatio >= HIGH_CONTROL_THRESHOLD) {
    needsOcr = true;
    ocrReason = "high_control";
  } else if (replacementCharRatio >= HIGH_REPLACEMENT_THRESHOLD) {
    needsOcr = true;
    ocrReason = "high_replacement";
  }
  return {
    page,
    textChars: total,
    hangulRatio: hangul / denom,
    controlCharRatio,
    replacementCharRatio,
    puaRatio,
    needsOcr,
    ocrReason
  };
}
var LOW_TEXT_THRESHOLD = 20;
var HIGH_PUA_THRESHOLD = 0.2;
var HIGH_CONTROL_THRESHOLD = 0.05;
var HIGH_REPLACEMENT_THRESHOLD = 0.05;
var DOC_NEEDS_OCR_PAGE_RATIO = 0.3;
function stripControlChars(text) {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, "");
}
function summarizeDocumentQuality(pages) {
  if (pages.length === 0) {
    return {
      totalPages: 0,
      totalTextChars: 0,
      avgHangulRatio: 0,
      avgControlCharRatio: 0,
      avgReplacementCharRatio: 0,
      avgPuaRatio: 0,
      lowTextPageCount: 0,
      highPuaPageCount: 0,
      needsOcr: false,
      ocrCandidatePages: []
    };
  }
  let textChars = 0;
  let hangul = 0;
  let control = 0;
  let replacement = 0;
  let pua = 0;
  let lowText = 0;
  let highPua = 0;
  const ocrCandidatePages = [];
  for (const p of pages) {
    textChars += p.textChars;
    hangul += p.hangulRatio;
    control += p.controlCharRatio;
    replacement += p.replacementCharRatio;
    pua += p.puaRatio;
    if (p.textChars < LOW_TEXT_THRESHOLD) lowText++;
    if (p.puaRatio >= HIGH_PUA_THRESHOLD) highPua++;
    if (p.needsOcr) ocrCandidatePages.push(p.page);
  }
  const n = pages.length;
  return {
    totalPages: n,
    totalTextChars: textChars,
    avgHangulRatio: hangul / n,
    avgControlCharRatio: control / n,
    avgReplacementCharRatio: replacement / n,
    avgPuaRatio: pua / n,
    lowTextPageCount: lowText,
    highPuaPageCount: highPua,
    needsOcr: ocrCandidatePages.length / n >= DOC_NEEDS_OCR_PAGE_RATIO,
    ocrCandidatePages
  };
}

// src/pdf/text-line.ts
function filterHiddenText(items, pageWidth, pageHeight) {
  let hiddenCount = 0;
  const visible = [];
  for (const item of items) {
    if (item.isHidden) {
      hiddenCount++;
      continue;
    }
    const margin = Math.max(pageWidth, pageHeight) * 0.1;
    if (item.x < -margin || item.x > pageWidth + margin || item.y < -margin || item.y > pageHeight + margin) {
      hiddenCount++;
      continue;
    }
    visible.push(item);
  }
  return { visible, hiddenCount };
}
function collapseEvenSpacing(text) {
  const tokens = text.split(" ");
  const singleCharCount = tokens.filter((t) => t.length === 1).length;
  if (tokens.length >= 3 && singleCharCount / tokens.length >= 0.7) {
    return tokens.join("");
  }
  return text.replace(
    /(?<![가-힣])[가-힣](?: [가-힣\d]){2,}(?![가-힣])/g,
    (match) => match.replace(/ /g, "")
  );
}
function computeBBox(items, pageNum) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of items) {
    if (i.x < minX) minX = i.x;
    if (i.y < minY) minY = i.y;
    if (i.x + i.w > maxX) maxX = i.x + i.w;
    const effectiveH = i.h > 0 ? i.h : i.fontSize;
    if (i.y + effectiveH > maxY) maxY = i.y + effectiveH;
  }
  return { page: pageNum, x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
function dominantStyle(items) {
  if (items.length === 0) return void 0;
  const freq = /* @__PURE__ */ new Map();
  let maxCount = 0, dominantSize = 0;
  for (const i of items) {
    if (i.fontSize <= 0) continue;
    const count = (freq.get(i.fontSize) || 0) + 1;
    freq.set(i.fontSize, count);
    if (count > maxCount) {
      maxCount = count;
      dominantSize = i.fontSize;
    }
  }
  if (dominantSize === 0) return void 0;
  const fontName = items.find((i) => i.fontSize === dominantSize)?.fontName || void 0;
  return { fontSize: dominantSize, fontName };
}
function normalizeItems(rawItems) {
  const items = [];
  const spacePositions = [];
  for (const i of rawItems) {
    if (typeof i.str !== "string") continue;
    const x = Math.round(i.transform[4]);
    const y = Math.round(i.transform[5]);
    if (!i.str.trim()) {
      spacePositions.push({ x, y });
      continue;
    }
    const scaleX = Math.hypot(i.transform[0], i.transform[1]);
    const scaleY = Math.hypot(i.transform[2], i.transform[3]);
    const fontSize = Math.round(Math.max(scaleY, scaleX));
    const w = Math.round(i.width);
    const h = Math.round(i.height);
    const isHidden = fontSize === 0 || i.width === 0 && i.str.trim().length > 0;
    let text = i.str.trim();
    if (/^[\d\s\-().·,☎]+$/.test(text) && /\d/.test(text) && / /.test(text)) {
      text = text.replace(/ /g, "");
    }
    const split = splitEvenSpacedItem(text, x, w, fontSize);
    if (split) {
      for (const s of split) {
        items.push({ text: s.text, x: s.x, y, w: s.w, h, fontSize, fontName: i.fontName || "", isHidden });
      }
    } else {
      items.push({ text, x, y, w, h, fontSize, fontName: i.fontName || "", isHidden });
    }
  }
  const sorted = items.sort((a, b) => b.y - a.y || a.x - b.x);
  const deduped = [];
  for (let i = 0; i < sorted.length; i++) {
    let isDup = false;
    for (let j = deduped.length - 1; j >= 0; j--) {
      const prev = deduped[j];
      if (prev.y - sorted[i].y > 3) break;
      if (Math.abs(prev.y - sorted[i].y) <= 3 && prev.text === sorted[i].text && Math.abs(prev.x - sorted[i].x) <= 3) {
        isDup = true;
        break;
      }
    }
    if (!isDup) deduped.push(sorted[i]);
  }
  if (spacePositions.length > 0) {
    for (const sp of spacePositions) {
      let nearest = null;
      for (const item of deduped) {
        if (Math.abs(sp.y - item.y) > 3) continue;
        const dist = item.x - sp.x;
        if (dist >= -1 && dist <= 20 && (!nearest || item.x < nearest.x)) {
          nearest = item;
        }
      }
      if (nearest) nearest.hasSpaceBefore = true;
    }
  }
  return deduped;
}
function splitEvenSpacedItem(text, itemX, itemW, fontSize) {
  if (!/^[가-힣\d](?: [가-힣\d]){2,}$/.test(text)) return null;
  const chars = text.split(" ");
  if (chars.length < 3) return null;
  const charW = itemW / chars.length;
  if (charW > fontSize * 2) return null;
  return chars.map((ch, idx) => ({
    text: ch,
    x: Math.round(itemX + idx * charW),
    w: Math.round(charW * 0.8)
    // 실제 글자 폭은 간격보다 좁음
  }));
}
function groupByY(items) {
  if (items.length === 0) return [];
  const lines = [];
  let curY = items[0].y;
  let curLine = [items[0]];
  for (let i = 1; i < items.length; i++) {
    if (Math.abs(items[i].y - curY) > 3) {
      lines.push(curLine);
      curLine = [];
      curY = items[i].y;
    }
    curLine.push(items[i]);
  }
  if (curLine.length > 0) lines.push(curLine);
  return lines;
}
function mergeSuperscriptLines(lines) {
  if (lines.length <= 1) return lines;
  const band = (line) => {
    let bottom = Infinity, top = -Infinity;
    for (const i of line) {
      const h = i.h > 0 ? i.h : i.fontSize;
      if (i.y < bottom) bottom = i.y;
      if (i.y + h > top) top = i.y + h;
    }
    return { bottom, top, height: top - bottom };
  };
  const isFrag = (line) => line.length <= 3 && line.every((i) => i.text.trim().length <= 8);
  const result = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prev = result[result.length - 1];
    const curr = lines[i];
    const a = band(prev);
    const b = band(curr);
    const overlap = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
    const prevIsFrag = isFrag(prev) && a.height <= b.height * 0.8 && overlap >= a.height * 0.5;
    const currIsFrag = isFrag(curr) && b.height <= a.height * 0.8 && overlap >= b.height * 0.5;
    if (prevIsFrag || currIsFrag) {
      result[result.length - 1] = [...prev, ...curr];
    } else {
      result.push(curr);
    }
  }
  return result;
}
function mergeLineSimple(items) {
  if (items.length <= 1) return items[0]?.text || "";
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const isEvenSpaced = detectEvenSpacedItems(sorted);
  let result = sorted[0].text;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w);
    const avgFs = (sorted[i].fontSize + sorted[i - 1].fontSize) / 2;
    const tabThreshold = Math.max(avgFs * 2, 30);
    if (gap > tabThreshold) {
      result += "	";
      result += sorted[i].text;
      continue;
    }
    if (isEvenSpaced[i]) {
      result += sorted[i].text;
      continue;
    }
    if (sorted[i].hasSpaceBefore && gap >= avgFs * 0.05) {
      result += " ";
      result += sorted[i].text;
      continue;
    }
    if (/[□■○●▶◆◇ㅇ]$/.test(sorted[i - 1].text) && /^[가-힣]/.test(sorted[i].text) && gap > 1) {
      result += " ";
      result += sorted[i].text;
      continue;
    }
    if (gap > spaceGapThreshold(avgFs)) result += " ";
    result += sorted[i].text;
  }
  return result;
}

// src/pdf/cluster-detector.ts
var Y_TOL = 3;
var COL_CLUSTER_TOL = 15;
var MIN_ROWS = 3;
var MIN_COLS = 2;
var MIN_GAP_FACTOR = 2;
var MIN_GAP_ABSOLUTE = 20;
var MIN_COL_FILL_RATIO = 0.4;
function detectClusterTables(items, pageNum) {
  if (items.length < MIN_ROWS * MIN_COLS) return [];
  const { merged, originMap } = mergeEvenSpacedClusters(items);
  const rows = mergeOverlappingRows(groupByBaseline(merged));
  if (rows.length < MIN_ROWS) return [];
  const results = [];
  const headerResult = detectHeaderRow(rows);
  if (headerResult) {
    const { columns, headerIdx } = headerResult;
    const headerRow = rows[headerIdx];
    const headerItems = [...headerRow.items].sort((a, b) => a.x - b.x);
    const headerAndBelow = rows.slice(headerIdx);
    const mergedRows = mergeMultiLineRows(headerAndBelow, columns);
    const tableRegions = findTableRegionsByHeader(mergedRows, columns, headerItems);
    for (const region of tableRegions) {
      const table = buildClusterTable(region.rows, columns, pageNum);
      if (table) {
        expandUsedItems(table.usedItems, originMap);
        results.push(table);
      }
    }
  }
  if (results.length === 0) {
    const suspiciousRows = rows.filter((row) => hasSuspiciousGaps(row));
    if (suspiciousRows.length >= MIN_ROWS) {
      const columns = extractColumnClusters(suspiciousRows);
      if (columns.length >= MIN_COLS) {
        const tableRegions = findTableRegions(rows, columns);
        for (const region of tableRegions) {
          const mergedRows = mergeMultiLineRows(region.rows, columns);
          const table = buildClusterTable(mergedRows, columns, pageNum);
          if (table) {
            expandUsedItems(table.usedItems, originMap);
            results.push(table);
          }
        }
      }
    }
  }
  return results.filter((r) => !isTwoColumnProse(r));
}
function isTwoColumnProse(r) {
  const t = r.table;
  if (t.rows < 8) return false;
  const dense = [];
  for (let c = 0; c < t.cols; c++) {
    const filled = t.cells.filter((row) => row[c]?.text.trim()).length;
    if (filled / t.rows >= 0.3) dense.push(c);
  }
  if (dense.length !== 2) return false;
  for (const c of dense) {
    const lens = t.cells.map((row) => row[c]?.text.replace(/\s+/g, "").length ?? 0).filter((n) => n > 0);
    const avg = lens.reduce((s, v) => s + v, 0) / (lens.length || 1);
    if (avg < 12) return false;
  }
  return findTwoColumnProseCutX([...r.usedItems]) !== null;
}
function findTwoColumnProseCutX(items) {
  const lines = groupByBaseline(items);
  if (lines.length < 8) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const i of items) {
    if (i.x < minX) minX = i.x;
    if (i.x + i.w > maxX) maxX = i.x + i.w;
  }
  if (!Number.isFinite(maxX - minX)) return null;
  if (maxX - minX < 100) return null;
  const lo = minX + (maxX - minX) * 0.3;
  const hi = minX + (maxX - minX) * 0.7;
  const step = Math.max(2, (hi - lo) / 400);
  let cutX = 0;
  let bestCover = Infinity;
  for (let x = lo; x <= hi; x += step) {
    let cover = 0;
    for (const line of lines) {
      if (line.items.some((i) => i.x < x && i.x + i.w > x)) cover++;
    }
    if (cover < bestCover) {
      bestCover = cover;
      cutX = x;
    }
  }
  if (bestCover / lines.length > 0.15) return null;
  const left = [];
  const right = [];
  let twoSide = 0;
  for (const line of lines) {
    let hasL = false;
    let hasR = false;
    for (const i of line.items) {
      if (i.x + i.w <= cutX) {
        left.push(i);
        hasL = true;
      } else if (i.x >= cutX) {
        right.push(i);
        hasR = true;
      }
    }
    if (hasL && hasR) twoSide++;
  }
  if (twoSide / lines.length < 0.55) return null;
  if (left.length < 5 || right.length < 5) return null;
  const allText = items.map((i) => i.text).join("").replace(/\s+/g, "");
  const digits = (allText.match(/[\d,.%△—-]/g) || []).length;
  if (allText.length === 0 || digits / allText.length > 0.15) return null;
  const stats = [left, right].map((side) => {
    let sMinX = Infinity;
    let sMaxR = -Infinity;
    let fsSum = 0;
    const rowEnds = /* @__PURE__ */ new Map();
    const rowLens = /* @__PURE__ */ new Map();
    const rowFirst = /* @__PURE__ */ new Map();
    for (const i of side) {
      if (i.x < sMinX) sMinX = i.x;
      const rgt = i.x + i.w;
      if (rgt > sMaxR) sMaxR = rgt;
      fsSum += i.fontSize;
      const key = Math.round(i.y / 4);
      rowEnds.set(key, Math.max(rowEnds.get(key) ?? -Infinity, rgt));
      rowLens.set(key, (rowLens.get(key) ?? 0) + i.text.replace(/\s+/g, "").length);
      const f = rowFirst.get(key);
      if (!f || i.x < f.x) rowFirst.set(key, i);
    }
    const ends = [...rowEnds.values()].sort((a, b) => a - b);
    const p85 = ends[Math.floor(ends.length * 0.85)] ?? sMaxR;
    const fs = fsSum / side.length;
    const justified = ends.filter((e) => Math.abs(e - p85) <= fs).length / ends.length;
    const lens = [...rowLens.values()];
    const avgLen = lens.reduce((s, v) => s + v, 0) / (lens.length || 1);
    const markers = [...rowFirst.values()].filter((i) => /^[•▪◦‣∙·\-–—□■◇◆▶※*]/.test(i.text)).length;
    return { width: sMaxR - sMinX, justified, avgLen, markerRatio: markers / (rowFirst.size || 1) };
  });
  if (stats.some((s) => s.avgLen < 12)) return null;
  if (stats.some((s) => s.markerRatio > 0.1)) return null;
  const widthSym = Math.min(stats[0].width, stats[1].width) / Math.max(stats[0].width, stats[1].width);
  if (widthSym < 0.6) return null;
  if (Math.min(stats[0].justified, stats[1].justified) < 0.55) return null;
  return cutX;
}
function mergeEvenSpacedClusters(items) {
  const originMap = /* @__PURE__ */ new Map();
  const rows = groupByBaseline(items);
  const merged = [];
  for (const row of rows) {
    const sorted = [...row.items].sort((a, b) => a.x - b.x);
    let i = 0;
    while (i < sorted.length) {
      if (/^[가-힣\d]$/.test(sorted[i].text)) {
        let runEnd = i + 1;
        while (runEnd < sorted.length && /^[가-힣\d]$/.test(sorted[runEnd].text)) {
          if (sorted[runEnd].hasSpaceBefore) break;
          const gap = sorted[runEnd].x - (sorted[runEnd - 1].x + sorted[runEnd - 1].w);
          const fs = sorted[runEnd].fontSize;
          if (gap < fs * 0.1 || gap > fs * 3) break;
          runEnd++;
        }
        if (runEnd - i >= 3) {
          const gaps = [];
          for (let g2 = i + 1; g2 < runEnd; g2++) {
            gaps.push(sorted[g2].x - (sorted[g2 - 1].x + sorted[g2 - 1].w));
          }
          let minG = Infinity, maxG = -Infinity;
          for (const g2 of gaps) {
            if (g2 < minG) minG = g2;
            if (g2 > maxG) maxG = g2;
          }
          if (minG > 0 && maxG / minG <= 3) {
            const run = sorted.slice(i, runEnd);
            const text = run.map((r) => r.text).join("");
            const first = run[0], last = run[runEnd - i - 1];
            const item = {
              text,
              x: first.x,
              y: first.y,
              w: last.x + last.w - first.x,
              h: first.h,
              fontSize: first.fontSize,
              fontName: first.fontName
            };
            originMap.set(item, run);
            merged.push(item);
            i = runEnd;
            continue;
          }
        }
      }
      merged.push(sorted[i]);
      i++;
    }
  }
  return { merged, originMap };
}
function expandUsedItems(usedItems, originMap) {
  const toAdd = [];
  for (const item of usedItems) {
    const origins = originMap.get(item);
    if (origins) for (const o of origins) toAdd.push(o);
  }
  for (const a of toAdd) usedItems.add(a);
}
function detectHeaderRow(rows) {
  const allItems = rows.flatMap((r) => r.items);
  if (allItems.length === 0) return null;
  let allMinX = Infinity, allMaxX = -Infinity;
  for (const i of allItems) {
    if (i.x < allMinX) allMinX = i.x;
    const r = i.x + i.w;
    if (r > allMaxX) allMaxX = r;
  }
  const pageSpan = allMaxX - allMinX;
  if (pageSpan <= 0) return null;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (row.items.length < MIN_COLS || row.items.length > 6) continue;
    if (row.items.some((i) => i.text.length > 8)) continue;
    if (!row.items.some((i) => /[가-힣]/.test(i.text))) continue;
    if (row.items.some((i) => /^[□■○●·※▶▷◆◇\-]/.test(i.text))) continue;
    const sorted = [...row.items].sort((a, b) => a.x - b.x);
    const xSpan = sorted[sorted.length - 1].x + sorted[sorted.length - 1].w - sorted[0].x;
    if (xSpan / pageSpan < 0.4) continue;
    const avgFs = sorted.reduce((s, i) => s + i.fontSize, 0) / sorted.length;
    let hasLargeGap = false;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w);
      if (gap >= avgFs * 2.5) {
        hasLargeGap = true;
        break;
      }
    }
    if (!hasLargeGap) continue;
    const columns = sorted.map((item) => ({ x: item.x, count: 0 }));
    let matchCount = 0;
    for (let j = ri + 1; j < rows.length && matchCount < MIN_ROWS + 2; j++) {
      const matched = countMatchedColumnsRange(rows[j], columns, sorted);
      if (matched >= MIN_COLS) matchCount++;
    }
    if (matchCount < MIN_ROWS) continue;
    return { columns, headerIdx: ri };
  }
  return null;
}
function mergeOverlappingRows(rows) {
  if (rows.length <= 1) return rows;
  const result = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    const prev = result[result.length - 1];
    const curr = rows[i];
    const a = rowBand(prev);
    const b = rowBand(curr);
    const overlap = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
    const prevIsFrag = isFragmentRow(prev) && a.height <= b.height * 0.8 && overlap >= a.height * 0.5;
    const currIsFrag = isFragmentRow(curr) && b.height <= a.height * 0.8 && overlap >= b.height * 0.5;
    if (prevIsFrag || currIsFrag) {
      const baseY = prevIsFrag ? curr.y : prev.y;
      result[result.length - 1] = { y: baseY, items: [...prev.items, ...curr.items] };
    } else {
      result.push(curr);
    }
  }
  return result;
}
function isFragmentRow(row) {
  return row.items.length <= 3 && row.items.every((i) => i.text.length <= 8);
}
function rowBand(row) {
  let bottom = Infinity, top = -Infinity;
  for (const i of row.items) {
    const h = i.h > 0 ? i.h : i.fontSize;
    if (i.y < bottom) bottom = i.y;
    if (i.y + h > top) top = i.y + h;
  }
  return { bottom, top, height: top - bottom };
}
function mergeMultiLineRows(rows, columns) {
  if (rows.length <= 1) return rows;
  const result = [rows[0]];
  const allFontSizes = rows.flatMap((r) => r.items).map((i) => i.fontSize);
  const avgFontSize = allFontSizes.length > 0 ? allFontSizes.reduce((s, v) => s + v, 0) / allFontSizes.length : 12;
  for (let i = 1; i < rows.length; i++) {
    const prev = result[result.length - 1];
    const curr = rows[i];
    const yGap = Math.abs(prev.y - curr.y);
    const matchedCols = countMatchedColumns(curr, columns);
    if (yGap < avgFontSize * 1.8 && curr.items.length <= 2 && (matchedCols < MIN_COLS || curr.items.length === 1)) {
      result[result.length - 1] = {
        y: prev.y,
        items: [...prev.items, ...curr.items]
      };
    } else {
      result.push(curr);
    }
  }
  return result;
}
function groupByBaseline(items) {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let curItems = [sorted[0]];
  let curY = sorted[0].y;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - curY) <= Y_TOL) {
      curItems.push(sorted[i]);
    } else {
      rows.push({ y: curY, items: curItems });
      curItems = [sorted[i]];
      curY = sorted[i].y;
    }
  }
  if (curItems.length > 0) rows.push({ y: curY, items: curItems });
  return rows;
}
function hasSuspiciousGaps(row) {
  if (row.items.length < 2) return false;
  const sorted = [...row.items].sort((a, b) => a.x - b.x);
  if (sorted.length === 2 && sorted[1].text.length > 20) return false;
  const avgFontSize = sorted.reduce((s, i) => s + i.fontSize, 0) / sorted.length;
  const minGap = Math.max(avgFontSize * MIN_GAP_FACTOR, MIN_GAP_ABSOLUTE);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w);
    if (gap >= minGap) return true;
  }
  return false;
}
function extractColumnClusters(rows) {
  const allX = [];
  for (const row of rows) {
    for (const item of row.items) allX.push(item.x);
  }
  if (allX.length === 0) return [];
  allX.sort((a, b) => a - b);
  const clusters = [];
  let clusterStart = 0;
  for (let i = 1; i <= allX.length; i++) {
    if (i === allX.length || allX[i] - allX[i - 1] > COL_CLUSTER_TOL) {
      const slice = allX.slice(clusterStart, i);
      const avg = Math.round(slice.reduce((s, v) => s + v, 0) / slice.length);
      clusters.push({ x: avg, count: slice.length });
      clusterStart = i;
    }
  }
  const minCount = Math.max(2, Math.floor(rows.length * MIN_COL_FILL_RATIO));
  return clusters.filter((c) => c.count >= minCount).sort((a, b) => a.x - b.x);
}
function findTableRegionsByHeader(allRows, columns, headerItems) {
  const regions = [];
  let currentRegion = [];
  let missStreak = 0;
  for (const row of allRows) {
    const matchedCols = countMatchedColumnsRange(row, columns, headerItems);
    if (matchedCols >= MIN_COLS) {
      currentRegion.push(row);
      missStreak = 0;
    } else if (currentRegion.length > 0 && (row.items.length <= 2 || missStreak === 0)) {
      currentRegion.push(row);
      missStreak++;
    } else {
      while (currentRegion.length > 0) {
        const last = currentRegion[currentRegion.length - 1];
        if (countMatchedColumnsRange(last, columns, headerItems) >= MIN_COLS) break;
        currentRegion.pop();
      }
      if (currentRegion.length >= MIN_ROWS) {
        regions.push({ rows: [...currentRegion] });
      }
      currentRegion = [];
      missStreak = 0;
    }
  }
  while (currentRegion.length > 0) {
    const last = currentRegion[currentRegion.length - 1];
    if (countMatchedColumnsRange(last, columns, headerItems) >= MIN_COLS) break;
    currentRegion.pop();
  }
  if (currentRegion.length >= MIN_ROWS) {
    regions.push({ rows: currentRegion });
  }
  return regions;
}
function findTableRegions(allRows, columns) {
  const regions = [];
  let currentRegion = [];
  for (const row of allRows) {
    const matchedCols = countMatchedColumns(row, columns);
    if (matchedCols >= MIN_COLS) {
      currentRegion.push(row);
    } else if (row.items.length === 1) {
      if (currentRegion.length > 0) {
        currentRegion.push(row);
      }
    } else {
      if (currentRegion.length >= MIN_ROWS) {
        regions.push({ rows: [...currentRegion] });
      }
      currentRegion = [];
    }
  }
  if (currentRegion.length >= MIN_ROWS) {
    regions.push({ rows: currentRegion });
  }
  return regions;
}
function countMatchedColumns(row, columns) {
  const matched = /* @__PURE__ */ new Set();
  for (const item of row.items) {
    for (let ci = 0; ci < columns.length; ci++) {
      if (Math.abs(item.x - columns[ci].x) <= COL_CLUSTER_TOL * 2) {
        matched.add(ci);
        break;
      }
    }
  }
  return matched.size;
}
function countMatchedColumnsRange(row, columns, headerItems) {
  const boundaries = [];
  for (let ci = 0; ci < headerItems.length; ci++) {
    const left = ci === 0 ? 0 : (headerItems[ci - 1].x + headerItems[ci - 1].w + headerItems[ci].x) / 2;
    const right = ci === headerItems.length - 1 ? Infinity : (headerItems[ci].x + headerItems[ci].w + headerItems[ci + 1].x) / 2;
    boundaries.push({ left, right });
  }
  const matched = /* @__PURE__ */ new Set();
  for (const item of row.items) {
    for (let ci = 0; ci < boundaries.length; ci++) {
      if (item.x >= boundaries[ci].left && item.x < boundaries[ci].right) {
        matched.add(ci);
        break;
      }
    }
  }
  return matched.size;
}
function assignRowItems(items, columns, numCols) {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const colCenters = columns.map((c) => c.x);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push({ idx: i, size: sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w) });
  }
  const gapSizes = gaps.map((g2) => g2.size).sort((a, b) => a - b);
  const medianGap = gapSizes.length > 0 ? gapSizes[Math.floor(gapSizes.length / 2)] : 0;
  const gapThreshold = sorted.length <= numCols + 1 ? 12 : Math.max(medianGap * 2.5, 12);
  const significantGaps = gaps.filter((g2) => g2.size >= gapThreshold).sort((a, b) => b.size - a.size).slice(0, numCols - 1).sort((a, b) => a.idx - b.idx);
  const groups = [];
  let start = 0;
  for (const gap of significantGaps) {
    groups.push(sorted.slice(start, gap.idx));
    start = gap.idx;
  }
  groups.push(sorted.slice(start));
  const result = [];
  const usedCols = /* @__PURE__ */ new Set();
  const groupCenters = groups.map((g2) => {
    let minX = Infinity, maxX = -Infinity;
    for (const i of g2) {
      if (i.x < minX) minX = i.x;
      const r = i.x + i.w;
      if (r > maxX) maxX = r;
    }
    return (minX + maxX) / 2;
  });
  const assignments = [];
  for (let gi = 0; gi < groups.length; gi++) {
    for (let ci = 0; ci < numCols; ci++) {
      assignments.push({ gi, ci, dist: Math.abs(groupCenters[gi] - colCenters[ci]) });
    }
  }
  assignments.sort((a, b) => a.dist - b.dist);
  const assignedGroups = /* @__PURE__ */ new Set();
  for (const { gi, ci } of assignments) {
    if (assignedGroups.has(gi) || usedCols.has(ci)) continue;
    result.push({ col: ci, items: groups[gi] });
    assignedGroups.add(gi);
    usedCols.add(ci);
  }
  for (let gi = 0; gi < groups.length; gi++) {
    if (assignedGroups.has(gi)) continue;
    let bestCol = 0, bestDist = Infinity;
    for (let ci = 0; ci < numCols; ci++) {
      const d = Math.abs(groupCenters[gi] - colCenters[ci]);
      if (d < bestDist) {
        bestDist = d;
        bestCol = ci;
      }
    }
    result.push({ col: bestCol, items: groups[gi] });
  }
  return result;
}
function buildClusterTable(rows, columns, pageNum) {
  const numCols = columns.length;
  const numRows = rows.length;
  if (numRows < MIN_ROWS || numCols < MIN_COLS) return null;
  const cells = Array.from(
    { length: numRows },
    () => Array.from({ length: numCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 }))
  );
  const usedItems = /* @__PURE__ */ new Set();
  for (let r = 0; r < numRows; r++) {
    const row = rows[r];
    if (row.items.length === 1 && numCols > 1) {
      cells[r][0] = { text: row.items[0].text, colSpan: numCols, rowSpan: 1 };
      usedItems.add(row.items[0]);
      continue;
    }
    const assignments = assignRowItems(row.items, columns, numCols);
    for (const { col, items } of assignments) {
      const text = items.map((i) => i.text).join(" ");
      const existing = cells[r][col].text;
      cells[r][col].text = existing ? existing + " " + text : text;
      for (const item of items) usedItems.add(item);
    }
  }
  let emptyRows = 0;
  for (const row of cells) {
    if (row.every((c) => c.text === "")) emptyRows++;
  }
  if (emptyRows > numRows * 0.5) return null;
  for (let c = 0; c < numCols; c++) {
    const hasValue = cells.some((row) => row[c].text !== "");
    if (!hasValue) return null;
  }
  for (let r = numRows - 1; r >= 1; r--) {
    const nonEmptyCols = cells[r].filter((c) => c.text.trim()).length;
    if (nonEmptyCols !== 1) continue;
    if (cells[r][0].text.trim() !== "") continue;
    const contentText = cells[r].find((c) => c.text.trim())?.text.trim() || "";
    if (/^[○●▶\-·]/.test(contentText)) continue;
    for (let pr = r - 1; pr >= 0; pr--) {
      if (cells[pr].some((c) => c.text.trim())) {
        for (let c = 0; c < numCols; c++) {
          const prev = cells[pr][c].text.trim();
          const curr = cells[r][c].text.trim();
          if (curr) cells[pr][c].text = prev ? prev + " " + curr : curr;
        }
        for (let c = 0; c < numCols; c++) cells[r][c].text = "";
        break;
      }
    }
  }
  for (let r = 0; r < cells.length - 1; r++) {
    const row = cells[r];
    const hasCol0 = row[0].text.trim() !== "";
    const hasColLast = numCols > 1 && row[numCols - 1].text.trim() !== "";
    const midEmpty = row.slice(1, numCols - 1).every((c) => c.text.trim() === "");
    if (hasCol0 && hasColLast && midEmpty) {
      const next = cells[r + 1];
      if (next[0].text.trim() === "" && next.some((c) => c.text.trim())) {
        for (let c = 1; c < numCols; c++) {
          const curr = next[c].text.trim();
          if (curr) row[c].text = row[c].text.trim() ? row[c].text.trim() + " " + curr : curr;
        }
        for (let c = 0; c < numCols; c++) next[c].text = "";
      }
    }
  }
  const filteredCells = cells.filter((row) => row.some((c) => c.text.trim()));
  const finalRowCount = filteredCells.length;
  if (finalRowCount < MIN_ROWS) return null;
  const irTable = {
    rows: finalRowCount,
    cols: numCols,
    cells: filteredCells,
    hasHeader: finalRowCount > 1
  };
  const allItems = rows.flatMap((r) => r.items);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of allItems) {
    if (i.x < minX) minX = i.x;
    if (i.y < minY) minY = i.y;
    if (i.x + i.w > maxX) maxX = i.x + i.w;
    const h = i.h > 0 ? i.h : i.fontSize;
    if (i.y + h > maxY) maxY = i.y + h;
  }
  return {
    table: irTable,
    bbox: { page: pageNum, x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    usedItems
  };
}

// src/pdf/xy-cut.ts
var MAX_XYCUT_DEPTH = 50;
var XYCUT_MIN_GAP = 5;
var CROSS_LAYOUT_BETA = 2;
var CROSS_OVERLAP_RATIO = 0.1;
var CROSS_MIN_OVERLAPS = 2;
var CROSS_MAX_MASK_RATIO = 0.2;
var NARROW_ELEMENT_WIDTH_RATIO = 0.1;
function xyCutOrder(items, gapThreshold, depth = 0) {
  if (items.length === 0) return [];
  if (items.length <= 2 || depth >= MAX_XYCUT_DEPTH) return [items];
  if (depth === 0 && items.length >= 3) {
    const cross = identifyCrossLayoutItems(items);
    if (cross.size > 0 && cross.size <= items.length * CROSS_MAX_MASK_RATIO) {
      const rest = items.filter((i) => !cross.has(i));
      if (rest.length > 0) {
        const groups = xyCutOrder(rest, gapThreshold, 1);
        return mergeCrossLayoutGroups(groups, [...cross]);
      }
    }
  }
  const minGap = Math.max(XYCUT_MIN_GAP, gapThreshold);
  const hCut = findHorizontalCut(items);
  const vCut = findVerticalCutWithOutlierFilter(items, minGap);
  const hValid = hCut.gap >= minGap;
  const vValid = vCut.gap >= minGap;
  let useHorizontal;
  if (hValid && vValid) useHorizontal = vCut.gap <= hCut.gap * 1.5;
  else if (hValid) useHorizontal = true;
  else if (vValid) useHorizontal = false;
  else return [items];
  if (useHorizontal) {
    const upper = items.filter((i) => i.y > hCut.position);
    const lower = items.filter((i) => i.y <= hCut.position);
    if (upper.length > 0 && lower.length > 0 && upper.length < items.length) {
      return [...xyCutOrder(upper, gapThreshold, depth + 1), ...xyCutOrder(lower, gapThreshold, depth + 1)];
    }
  } else {
    const left = items.filter((i) => i.x + i.w / 2 < vCut.position);
    const right = items.filter((i) => i.x + i.w / 2 >= vCut.position);
    if (left.length > 0 && right.length > 0 && left.length < items.length) {
      return [...xyCutOrder(left, gapThreshold, depth + 1), ...xyCutOrder(right, gapThreshold, depth + 1)];
    }
  }
  return [items];
}
function identifyCrossLayoutItems(items) {
  const cross = /* @__PURE__ */ new Set();
  if (items.length < 3) return cross;
  let maxWidth = 0;
  for (const i of items) {
    if (i.w > maxWidth) maxWidth = i.w;
  }
  const threshold = CROSS_LAYOUT_BETA * maxWidth;
  for (const item of items) {
    if (item.w < threshold) continue;
    let overlaps = 0;
    for (const other of items) {
      if (other === item) continue;
      const left = Math.max(item.x, other.x);
      const right = Math.min(item.x + item.w, other.x + other.w);
      const overlapW = right - left;
      if (overlapW <= 0) continue;
      const smaller = Math.min(item.w, other.w);
      if (smaller > 0 && overlapW / smaller >= CROSS_OVERLAP_RATIO) {
        overlaps++;
        if (overlaps >= CROSS_MIN_OVERLAPS) break;
      }
    }
    if (overlaps >= CROSS_MIN_OVERLAPS) cross.add(item);
  }
  return cross;
}
function mergeCrossLayoutGroups(groups, cross) {
  if (cross.length === 0) return groups;
  const sortedCross = [...cross].sort((a, b) => b.y + b.h - (a.y + a.h) || a.x - b.x);
  const groupTop = (g2) => {
    let top = -Infinity;
    for (const i of g2) {
      const t = i.y + i.h;
      if (t > top) top = t;
    }
    return top;
  };
  const result = [];
  let gi = 0, ci = 0;
  while (gi < groups.length || ci < sortedCross.length) {
    if (ci >= sortedCross.length) {
      result.push(groups[gi++]);
      continue;
    }
    if (gi >= groups.length) {
      result.push([sortedCross[ci++]]);
      continue;
    }
    const crossTop = sortedCross[ci].y + sortedCross[ci].h;
    if (crossTop >= groupTop(groups[gi])) result.push([sortedCross[ci++]]);
    else result.push(groups[gi++]);
  }
  return result;
}
function findHorizontalCut(items) {
  if (items.length < 2) return { position: 0, gap: 0 };
  const sorted = [...items].sort((a, b) => b.y - a.y);
  let largestGap = 0;
  let position = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prevBottom = sorted[i - 1].y - sorted[i - 1].h;
    const currTop = sorted[i].y;
    const gap = prevBottom - currTop;
    if (gap > largestGap) {
      largestGap = gap;
      position = (prevBottom + currTop) / 2;
    }
  }
  return { position, gap: largestGap };
}
function findVerticalCutWithOutlierFilter(items, minGap) {
  const edgeCut = findVerticalCut(items);
  if (edgeCut.gap >= minGap) return edgeCut;
  if (items.length >= 3) {
    let minX = Infinity, maxX = -Infinity;
    for (const i of items) {
      if (i.x < minX) minX = i.x;
      const r = i.x + i.w;
      if (r > maxX) maxX = r;
    }
    const narrowThreshold = (maxX - minX) * NARROW_ELEMENT_WIDTH_RATIO;
    const filtered = items.filter((i) => i.w >= narrowThreshold);
    if (filtered.length >= 2 && filtered.length < items.length && filtered.length >= items.length * 0.7) {
      const filteredCut = findVerticalCut(filtered);
      if (filteredCut.gap > edgeCut.gap && filteredCut.gap >= minGap) {
        return filteredCut;
      }
    }
  }
  return edgeCut;
}
function findVerticalCut(items) {
  if (items.length < 2) return { position: 0, gap: 0 };
  const sorted = [...items].sort((a, b) => a.x - b.x || a.x + a.w - (b.x + b.w));
  let largestGap = 0;
  let position = 0;
  let prevRight = null;
  for (const it of sorted) {
    const left = it.x;
    const right = it.x + it.w;
    if (prevRight !== null && left > prevRight) {
      const gap = left - prevRight;
      if (gap > largestGap) {
        largestGap = gap;
        position = (prevRight + left) / 2;
      }
    }
    prevRight = prevRight === null ? right : Math.max(prevRight, right);
  }
  return { position, gap: largestGap };
}

// src/pdf/columns.ts
function isProseSpread(items) {
  if (items.length < 4) return false;
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w));
  }
  const maxGap = safeMax(gaps);
  const avgLen = items.reduce((s, i) => s + i.text.length, 0) / items.length;
  return maxGap < 40 && avgLen < 5;
}
function detectColumns(yLines) {
  const allItems = yLines.flat();
  if (allItems.length === 0) return null;
  const pageWidth = safeMax(allItems.map((i) => i.x + i.w)) - safeMin(allItems.map((i) => i.x));
  if (pageWidth < 100) return null;
  let bigoLineIdx = -1;
  for (let i = 0; i < yLines.length; i++) {
    if (yLines[i].length <= 2 && yLines[i].some((item) => item.text === "\uBE44\uACE0")) {
      bigoLineIdx = i;
      break;
    }
  }
  const tableYLines = bigoLineIdx >= 0 ? yLines.slice(0, bigoLineIdx) : yLines;
  const CLUSTER_TOL = 22;
  const xClusters = [];
  for (const line of tableYLines) {
    if (isProseSpread(line)) continue;
    for (const item of line) {
      let found = false;
      for (const c of xClusters) {
        if (Math.abs(item.x - c.center) <= CLUSTER_TOL) {
          c.center = Math.round((c.center * c.count + item.x) / (c.count + 1));
          c.minX = Math.min(c.minX, item.x);
          c.count++;
          found = true;
          break;
        }
      }
      if (!found) {
        xClusters.push({ center: item.x, count: 1, minX: item.x });
      }
    }
  }
  const peaks = xClusters.filter((c) => c.count >= 3).sort((a, b) => a.minX - b.minX);
  if (peaks.length < 3) return null;
  const MERGE_TOL = 40;
  const merged = [peaks[0]];
  for (let i = 1; i < peaks.length; i++) {
    const prev = merged[merged.length - 1];
    if (peaks[i].minX - prev.minX < MERGE_TOL) {
      if (peaks[i].count > prev.count) {
        prev.center = peaks[i].center;
      }
      prev.count += peaks[i].count;
      prev.minX = Math.min(prev.minX, peaks[i].minX);
    } else {
      merged.push({ ...peaks[i] });
    }
  }
  const rawColumns = merged.filter((c) => c.count >= 3).map((c) => c.minX);
  if (rawColumns.length < 3) return null;
  const MIN_DETECT_COL_WIDTH = 30;
  const columns = [rawColumns[0]];
  for (let i = 1; i < rawColumns.length; i++) {
    if (rawColumns[i] - columns[columns.length - 1] < MIN_DETECT_COL_WIDTH) continue;
    columns.push(rawColumns[i]);
  }
  return columns.length >= 3 ? columns : null;
}
function findColumn(x, columns) {
  for (let i = columns.length - 1; i >= 0; i--) {
    if (x >= columns[i] - 10) return i;
  }
  return 0;
}
function extractWithColumns(yLines, columns) {
  const result = [];
  const colMin = columns[0];
  const colMax = columns[columns.length - 1];
  let bigoIdx = -1;
  for (let i = 0; i < yLines.length; i++) {
    if (yLines[i].length <= 2 && yLines[i].some((item) => item.text === "\uBE44\uACE0")) {
      bigoIdx = i;
      break;
    }
  }
  let tableStart = -1;
  for (let i = 0; i < (bigoIdx >= 0 ? bigoIdx : yLines.length); i++) {
    const usedCols = new Set(yLines[i].map((item) => findColumn(item.x, columns)));
    if (usedCols.size >= 3) {
      tableStart = i;
      break;
    }
  }
  const tableEnd = bigoIdx >= 0 ? bigoIdx : yLines.length;
  for (let i = 0; i < (tableStart >= 0 ? tableStart : tableEnd); i++) {
    result.push(mergeLineSimple(yLines[i]));
  }
  if (tableStart >= 0) {
    const tableLines = yLines.slice(tableStart, tableEnd);
    const gridLines = [];
    for (const line of tableLines) {
      const inRange = line.some(
        (item) => item.x >= colMin - 20 && item.x <= colMax + 200
      );
      if (inRange && !isProseSpread(line)) {
        gridLines.push(line);
      } else {
        if (gridLines.length > 0) {
          result.push(buildGridTable(gridLines.splice(0), columns));
        }
        result.push(mergeLineSimple(line));
      }
    }
    if (gridLines.length > 0) {
      result.push(buildGridTable(gridLines, columns));
    }
  }
  if (bigoIdx >= 0) {
    result.push("");
    for (let i = bigoIdx; i < yLines.length; i++) {
      result.push(mergeLineSimple(yLines[i]));
    }
  }
  return result.join("\n");
}
function buildGridTable(lines, columns) {
  const numCols = columns.length;
  const yRows = lines.map((items) => {
    const row = Array(numCols).fill("");
    for (const item of items) {
      const col = findColumn(item.x, columns);
      row[col] = row[col] ? row[col] + " " + item.text : item.text;
    }
    return row;
  });
  const dataColStart = Math.max(2, Math.floor(numCols / 2));
  const merged = [];
  for (const row of yRows) {
    if (row.every((c) => c === "")) continue;
    if (merged.length === 0) {
      merged.push([...row]);
      continue;
    }
    const prev = merged[merged.length - 1];
    const filledCols = row.map((c, i) => c ? i : -1).filter((i) => i >= 0);
    const filledCount = filledCols.length;
    let isNewRow = false;
    if (row[0] && row[0].length >= 3) {
      isNewRow = true;
    }
    if (!isNewRow && numCols > 1 && row[1]) {
      isNewRow = true;
    }
    if (!isNewRow) {
      const hasData = row.slice(dataColStart).some((c) => c !== "");
      const prevHasData = prev.slice(dataColStart).some((c) => c !== "");
      if (hasData && prevHasData) {
        isNewRow = true;
      }
    }
    if (isNewRow && filledCount === 1 && row[0] && row[0].length <= 2) {
      isNewRow = false;
    }
    if (isNewRow) {
      merged.push([...row]);
    } else {
      for (let c = 0; c < numCols; c++) {
        if (row[c]) {
          prev[c] = prev[c] ? prev[c] + " " + row[c] : row[c];
        }
      }
    }
  }
  if (merged.length < 2) {
    return merged.map((r) => r.filter((c) => c).join(" ")).join("\n");
  }
  let headerEnd = 0;
  for (let r = 0; r < merged.length; r++) {
    const hasDataValues = merged[r].slice(dataColStart).some((c) => c && /\d/.test(c));
    if (hasDataValues) break;
    headerEnd = r + 1;
  }
  if (headerEnd > 1) {
    const headerRow = Array(numCols).fill("");
    for (let r = 0; r < headerEnd; r++) {
      for (let c = 0; c < numCols; c++) {
        if (merged[r][c]) {
          headerRow[c] = headerRow[c] ? headerRow[c] + " " + merged[r][c] : merged[r][c];
        }
      }
    }
    merged.splice(0, headerEnd, headerRow);
  }
  for (const row of merged) {
    for (let c = 0; c < row.length; c++) {
      if (row[c]) row[c] = collapseEvenSpacing(row[c]);
    }
  }
  const totalCells = merged.length * numCols;
  const filledCells = merged.reduce((s, row) => s + row.filter((c) => c).length, 0);
  if (filledCells < totalCells * 0.35 || merged.length < 2 || merged.length <= 3 && numCols >= 7) {
    return merged.map((r) => r.filter((c) => c).join("	")).join("\n");
  }
  const md = [];
  md.push("| " + merged[0].join(" | ") + " |");
  md.push("| " + merged[0].map(() => "---").join(" | ") + " |");
  for (let r = 1; r < merged.length; r++) {
    md.push("| " + merged[r].join(" | ") + " |");
  }
  return md.join("\n");
}

// src/pdf/block-detect.ts
function computeMedianFontSizeFromFreq(freq) {
  if (freq.size === 0) return 0;
  let total = 0;
  for (const count of freq.values()) total += count;
  const sorted = [...freq.entries()].sort((a, b) => a[0] - b[0]);
  const mid = Math.floor(total / 2);
  let cumulative = 0;
  for (const [size, count] of sorted) {
    cumulative += count;
    if (cumulative > mid) return size;
  }
  return sorted[sorted.length - 1][0];
}
function detectHeadings(blocks, medianFontSize) {
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text || !block.style?.fontSize) continue;
    const text = block.text.trim();
    if (text.length === 0 || text.length > 200) continue;
    if (/^\d+$/.test(text)) continue;
    const ratio = block.style.fontSize / medianFontSize;
    let level = 0;
    if (ratio >= HEADING_RATIO_H1) level = 1;
    else if (ratio >= HEADING_RATIO_H2) level = 2;
    else if (ratio >= HEADING_RATIO_H3) level = 3;
    if (level > 0) {
      block.type = "heading";
      block.level = level;
      block.text = collapseEvenSpacing(text);
    }
  }
}
function shouldDemoteTable(table) {
  const allCells = table.cells.flatMap((row) => row.map((c) => c.text.trim())).filter(Boolean);
  const allText = allCells.join(" ");
  if (table.rows >= 2 && table.cols >= 2 && table.cells[0].every((c) => {
    const t = c.text.trim();
    return t.length > 0 && t.length <= 12 && !/[□■◆○●▶ㅇ<>]/.test(t);
  }) && table.cells.slice(1).some((row) => row.some((c) => c.text.trim() !== ""))) return false;
  if (table.rows <= 3 && table.cols <= 3 && allText.length <= 200) {
    const totalCells2 = table.rows * table.cols;
    const emptyCells2 = totalCells2 - allCells.length;
    if (emptyCells2 >= totalCells2 * 0.3) return true;
    if (/[□■◆○●▶ㅇ]/.test(allText)) return true;
    if (/<[^>]+>/.test(allText)) return true;
  }
  if (allText.length > 200) return false;
  if (/[□■◆○●▶]/.test(allText) && table.rows <= 3) return true;
  const totalCells = table.rows * table.cols;
  const emptyCells = totalCells - allCells.length;
  if (table.rows <= 2 && emptyCells > totalCells * 0.5) return true;
  if (table.rows === 1 && !/\d{2,}/.test(allText)) return true;
  return false;
}
function demoteTableToText(table) {
  const lines = [];
  for (let r = 0; r < table.rows; r++) {
    const cells = table.cells[r].map((c) => c.text.trim()).filter(Boolean);
    if (cells.length === 0) continue;
    if (table.cols === 2 && cells.length === 2) {
      lines.push(`${cells[0]} : ${cells[1]}`);
    } else {
      lines.push(cells.join(" "));
    }
  }
  return lines.join("\n");
}
function detectMarkerHeadings(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "paragraph" || !block.text) continue;
    const text = block.text.trim();
    if (text.length < 50 && /^[□■◆◇▶]\s*[가-힣]/.test(text)) {
      block.type = "heading";
      block.level = 4;
      continue;
    }
    if (/^[가-힣]{2,6}$/.test(text) && block.style?.fontSize) {
      const prev = blocks[i - 1];
      const next = blocks[i + 1];
      const prevIsStructural = !prev || prev.type === "table" || prev.type === "heading" || prev.type === "separator";
      const nextIsStructural = !next || next.type === "table" || next.type === "heading" || next.type === "paragraph" && next.text && /^[□■◆○●]/.test(next.text.trim());
      if (prevIsStructural || nextIsStructural) {
        block.type = "heading";
        block.level = 3;
      }
    }
  }
}
var TABLE_CAPTION_RE = /^[<\[(【〈]?\s*(표|그림|도표|Table|Figure|Fig\.?)\s*[\d①-⑮][\d.\-]*\s*[\])】〉>]?[.:]?\s*/i;
var CAPTION_MAX_LENGTH = 100;
var CAPTION_MAX_GAP = 30;
function detectTableCaptions(blocks) {
  const isCaptionCandidate = (b, table) => {
    if (!b || b.type !== "paragraph" || !b.text) return false;
    if (b.pageNumber !== table.pageNumber) return false;
    const text = b.text.trim();
    if (!text || text.length > CAPTION_MAX_LENGTH || text.includes("\n")) return false;
    if (!TABLE_CAPTION_RE.test(text)) return false;
    if (b.bbox && table.bbox) {
      const capTop = b.bbox.y + b.bbox.height;
      const capBottom = b.bbox.y;
      const tblTop = table.bbox.y + table.bbox.height;
      const tblBottom = table.bbox.y;
      const gap = capBottom >= tblTop ? capBottom - tblTop : tblBottom - capTop;
      if (gap > CAPTION_MAX_GAP) return false;
      const overlap = Math.min(b.bbox.x + b.bbox.width, table.bbox.x + table.bbox.width) - Math.max(b.bbox.x, table.bbox.x);
      if (overlap < Math.min(b.bbox.width, table.bbox.width) * 0.3) return false;
    }
    return true;
  };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "table" || !block.table || block.table.caption) continue;
    if (isCaptionCandidate(blocks[i - 1], block)) {
      block.table.caption = blocks[i - 1].text.trim();
      blocks.splice(i - 1, 1);
      i--;
    } else if (isCaptionCandidate(blocks[i + 1], block)) {
      block.table.caption = blocks[i + 1].text.trim();
      blocks.splice(i + 1, 1);
    }
  }
}
var KOREAN_LIST_SEQ = "\uAC00\uB098\uB2E4\uB77C\uB9C8\uBC14\uC0AC\uC544\uC790\uCC28\uCE74\uD0C0\uD30C\uD558";
function parseListLabel(text) {
  let m = text.match(/^(\d{1,2})\.(?!\d)\s+/);
  if (m) return { family: "arabicDot", ord: parseInt(m[1], 10) };
  m = text.match(/^([가-하])\.\s+/);
  if (m) {
    const idx = KOREAN_LIST_SEQ.indexOf(m[1]);
    if (idx >= 0) return { family: "korDot", ord: idx + 1 };
  }
  m = text.match(/^(\d{1,2})\)\s*/);
  if (m) return { family: "arabicParen", ord: parseInt(m[1], 10) };
  m = text.match(/^([가-하])\)\s*/);
  if (m) {
    const idx = KOREAN_LIST_SEQ.indexOf(m[1]);
    if (idx >= 0) return { family: "korParen", ord: idx + 1 };
  }
  m = text.match(/^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮])\s*/);
  if (m) return { family: "circled", ord: m[1].charCodeAt(0) - 9312 + 1 };
  return null;
}
var ATTACHMENT_RE = /^붙\s*임\s*(\d+[.:]?)?\s/;
function detectKoreanListBlocks(blocks) {
  const labeled = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type !== "paragraph" && b.type !== "list" || !b.text) continue;
    const label = parseListLabel(b.text.trim());
    if (label) labeled.push({ idx: i, label });
  }
  const validated = /* @__PURE__ */ new Set();
  const byFamily = /* @__PURE__ */ new Map();
  for (const l of labeled) {
    const arr = byFamily.get(l.label.family) || [];
    arr.push(l);
    byFamily.set(l.label.family, arr);
  }
  for (const arr of byFamily.values()) {
    let chain = [];
    for (const item of arr) {
      const prev = chain[chain.length - 1];
      if (prev && item.label.ord === prev.label.ord + 1 && item.idx - prev.idx <= 20) {
        chain.push(item);
      } else {
        if (chain.length >= 2) for (const c of chain) validated.add(c.idx);
        chain = [item];
      }
    }
    if (chain.length >= 2) for (const c of chain) validated.add(c.idx);
  }
  let familyStack = [];
  let lastTopLevelList = null;
  const toRemove = /* @__PURE__ */ new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "table" || b.type === "heading" || b.type === "separator") {
      familyStack = [];
      lastTopLevelList = null;
      continue;
    }
    if (b.type !== "paragraph" && b.type !== "list" || !b.text) continue;
    const text = b.text.trim();
    if (b.type === "paragraph" && ATTACHMENT_RE.test(text)) {
      blocks[i] = { ...b, type: "list", listType: "unordered" };
      continue;
    }
    if (!validated.has(i)) continue;
    const label = parseListLabel(text);
    let depth = familyStack.indexOf(label.family);
    if (depth < 0) {
      familyStack.push(label.family);
      depth = familyStack.length - 1;
    } else {
      familyStack = familyStack.slice(0, depth + 1);
    }
    const listType = label.family === "arabicDot" ? "ordered" : "unordered";
    const listBlock = { ...b, type: "list", listType };
    if (depth === 0) {
      blocks[i] = listBlock;
      lastTopLevelList = listBlock;
    } else if (lastTopLevelList) {
      if (!lastTopLevelList.children) lastTopLevelList.children = [];
      lastTopLevelList.children.push(listBlock);
      toRemove.add(i);
    } else {
      blocks[i] = listBlock;
      lastTopLevelList = listBlock;
    }
  }
  if (toRemove.size > 0) {
    const sorted = [...toRemove].sort((a, b) => b - a);
    for (const idx of sorted) blocks.splice(idx, 1);
  }
}
function detectListBlocks(blocks) {
  const result = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "paragraph" && block.text) {
      const text = block.text.trim();
      if (/^\d+\.\s/.test(text)) {
        result.push({ ...block, type: "list", listType: "ordered", text: block.text });
        continue;
      }
      if (/^[○●·※▶▷◆◇\-]\s/.test(text)) {
        result.push({ ...block, type: "list", listType: "unordered", text: block.text });
        continue;
      }
    }
    result.push(block);
  }
  return result;
}
var KOREAN_TABLE_HEADER_RE = /^\(?(구분|항목|종류|분류|유형|대상|내용|기간|금액|비율|방법|절차|요건|조건|근거|목적|범위|기준)\)?[:\s]/;
var KV_FALSE_POSITIVE_RE = /\d{1,2}:\d{2}|:\/\/|\d+:\d+/;
function detectSpecialKoreanTables(blocks) {
  const result = [];
  let kvLines = [];
  const flushKvTable = () => {
    if (kvLines.length < 2) {
      for (const kv of kvLines) result.push(kv.block);
      kvLines = [];
      return;
    }
    const cells = kvLines.map((kv) => {
      if (kv.value) {
        return [
          { text: kv.key, colSpan: 1, rowSpan: 1 },
          { text: kv.value, colSpan: 1, rowSpan: 1 }
        ];
      }
      return [
        { text: kv.key, colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 }
      ];
    });
    const irTable = {
      rows: cells.length,
      cols: 2,
      cells,
      hasHeader: true
    };
    const firstBlock = kvLines[0].block;
    result.push({
      type: "table",
      table: irTable,
      pageNumber: firstBlock.pageNumber,
      bbox: firstBlock.bbox
    });
    kvLines = [];
  };
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text) {
      flushKvTable();
      result.push(block);
      continue;
    }
    const text = block.text.trim();
    if (KOREAN_TABLE_HEADER_RE.test(text)) {
      const colonIdx = text.indexOf(":");
      if (colonIdx >= 0) {
        kvLines.push({
          key: text.slice(0, colonIdx).trim(),
          value: text.slice(colonIdx + 1).trim(),
          block
        });
      } else {
        const spaceIdx = text.search(/\s/);
        if (spaceIdx > 0) {
          kvLines.push({
            key: text.slice(0, spaceIdx).trim(),
            value: text.slice(spaceIdx + 1).trim(),
            block
          });
        } else {
          kvLines.push({ key: text, value: "", block });
        }
      }
      continue;
    }
    if (kvLines.length > 0 && text.includes(":")) {
      if (!KV_FALSE_POSITIVE_RE.test(text) && !text.includes("(") && !text.includes(")")) {
        const colonIdx = text.indexOf(":");
        const key = text.slice(0, colonIdx).trim();
        if (/^[가-힣]+$/.test(key) && key.length >= 2 && key.length <= 8) {
          kvLines.push({
            key,
            value: text.slice(colonIdx + 1).trim(),
            block
          });
          continue;
        }
      }
    }
    flushKvTable();
    result.push(block);
  }
  flushKvTable();
  return result;
}
function removeHeaderFooterBlocks(blocks, pageHeights, warnings) {
  const ZONE_RATIO = 0.12;
  const MIN_REPEAT = 3;
  const topEntries = [];
  const bottomEntries = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (!b.bbox || !b.pageNumber || !b.text?.trim()) continue;
    const ph = pageHeights.get(b.bbox.page) || pageHeights.get(b.pageNumber);
    if (!ph) continue;
    const blockTop = ph - (b.bbox.y + b.bbox.height);
    const blockBottom = ph - b.bbox.y;
    const entry = { blockIdx: bi, page: b.pageNumber, text: b.text.trim() };
    if (blockBottom <= ph * ZONE_RATIO) bottomEntries.push(entry);
    else if (blockTop >= ph * (1 - ZONE_RATIO)) topEntries.push(entry);
  }
  const removeSet = /* @__PURE__ */ new Set();
  for (const entries of [topEntries, bottomEntries]) {
    if (entries.length === 0) continue;
    const patternCount = /* @__PURE__ */ new Map();
    const patternPages = /* @__PURE__ */ new Map();
    for (const e of entries) {
      const norm = e.text.replace(/\d+/g, "#");
      patternCount.set(norm, (patternCount.get(norm) || 0) + 1);
      const pages = patternPages.get(norm) || /* @__PURE__ */ new Set();
      pages.add(e.page);
      patternPages.set(norm, pages);
    }
    const repeatedPatterns = /* @__PURE__ */ new Set();
    for (const [p, count] of patternCount) {
      if (count >= MIN_REPEAT && (patternPages.get(p)?.size ?? 0) >= MIN_REPEAT) {
        repeatedPatterns.add(p);
      }
    }
    for (const e of entries) {
      const norm = e.text.replace(/\d+/g, "#");
      if (repeatedPatterns.has(norm)) {
        removeSet.add(e.blockIdx);
      }
    }
  }
  if (removeSet.size > 0) {
    warnings.push({ message: `${removeSet.size}\uAC1C \uBA38\uB9AC\uAE00/\uBC14\uB2E5\uAE00 \uC694\uC18C \uC81C\uAC70\uB428`, code: "HIDDEN_TEXT_FILTERED" });
  }
  return [...removeSet].sort((a, b) => a - b);
}

// src/pdf/page-blocks.ts
function extractPageBlocksWithLines(items, pageNum, opList, pageWidth, pageHeight) {
  if (items.length === 0) return [];
  let { horizontals, verticals } = extractLines(opList.fnArray, opList.argsArray);
  ({ horizontals, verticals } = filterPageBorderLines(horizontals, verticals, pageWidth, pageHeight));
  ({ horizontals, verticals } = preprocessLines(horizontals, verticals));
  verticals = closeOpenTableEdges(horizontals, verticals);
  markStrikethroughItems(items, horizontals);
  wrapStrikethroughRuns(items);
  const grids = buildTableGrids(horizontals, verticals);
  if (grids.length > 0) {
    return extractBlocksWithGrids(items, pageNum, grids, horizontals, verticals);
  }
  return extractPageBlocksFallback(items, pageNum, true);
}
var STRIKE_MAX_THICKNESS = 2;
var STRIKE_MAX_THICKNESS_RATIO = 0.25;
var STRIKE_CENTER_TOLERANCE = 0.25;
var STRIKE_MIN_OVERLAP_RATIO = 0.8;
var STRIKE_MAX_LINE_TO_TEXT_RATIO = 1.5;
function markStrikethroughItems(items, horizontals) {
  if (items.length === 0 || horizontals.length === 0) return;
  for (const line of horizontals) {
    if (line.lineWidth > STRIKE_MAX_THICKNESS) continue;
    const matches = [];
    for (const item of items) {
      const h = item.h > 0 ? item.h : item.fontSize;
      if (h <= 0 || item.w <= 0) continue;
      if (line.lineWidth > h * STRIKE_MAX_THICKNESS_RATIO) continue;
      const centerY = item.y + h * 0.4;
      if (Math.abs(line.y1 - centerY) > h * STRIKE_CENTER_TOLERANCE) continue;
      const overlap = Math.min(line.x2, item.x + item.w) - Math.max(line.x1, item.x);
      if (overlap / item.w < STRIKE_MIN_OVERLAP_RATIO) continue;
      matches.push(item);
    }
    if (matches.length === 0) continue;
    let totalW = 0;
    for (const m of matches) totalW += m.w;
    if (totalW <= 0 || (line.x2 - line.x1) / totalW > STRIKE_MAX_LINE_TO_TEXT_RATIO) continue;
    for (const m of matches) m.strike = true;
  }
}
function wrapStrikethroughRuns(items) {
  const struck = items.filter((i) => i.strike);
  if (struck.length === 0) return;
  const lines = /* @__PURE__ */ new Map();
  for (const item of struck) {
    const key = Math.round(item.y / 3);
    const arr = lines.get(key) || [];
    arr.push(item);
    lines.set(key, arr);
  }
  for (const arr of lines.values()) {
    arr.sort((a, b) => a.x - b.x);
    arr[0].text = "~~" + arr[0].text;
    arr[arr.length - 1].text = arr[arr.length - 1].text + "~~";
  }
}
var PROSEBOX_FULLWIDTH_MIN = 0.6;
var PROSEBOX_LONG_CELL_CHARS = 80;
var PROSEBOX_LONG_CELL_MIN = 3;
var PROSEBOX_LONG_CELL_RATIO = 0.4;
var PROSEBOX_X_TOL = 8;
function verticalCoverageAt(verticals, x, yMin, yMax) {
  const tol = PROSEBOX_X_TOL;
  const spans = [];
  for (const v of verticals) {
    if (Math.abs(v.x1 - x) > tol) continue;
    const lo = Math.max(v.y1, yMin), hi = Math.min(v.y2, yMax);
    if (hi > lo) spans.push([lo, hi]);
  }
  if (spans.length === 0) return 0;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0, s = spans[0][0], e = spans[0][1];
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] <= e) {
      if (spans[i][1] > e) e = spans[i][1];
    } else {
      total += e - s;
      s = spans[i][0];
      e = spans[i][1];
    }
  }
  return total + (e - s);
}
function isProseBoxGrid(grid, verticals, table) {
  const numCols = grid.colXs.length - 1;
  if (numCols < 2 || grid.rowYs.length < 3) return false;
  const gyMax = grid.rowYs[0], gyMin = grid.rowYs[grid.rowYs.length - 1];
  const span = gyMax - gyMin;
  if (span <= 0) return false;
  const interior = grid.colXs.slice(1, -1);
  let fullWidthHeight = 0;
  for (let r = 0; r < grid.rowYs.length - 1; r++) {
    const top = grid.rowYs[r], bot = grid.rowYs[r + 1];
    const h = top - bot;
    if (h <= 0) continue;
    const hasDivider = interior.some((cx) => verticalCoverageAt(verticals, cx, bot, top) >= h * 0.5);
    if (!hasDivider) fullWidthHeight += h;
  }
  if (fullWidthHeight < span * PROSEBOX_FULLWIDTH_MIN) return false;
  const texts = table.cells.flat().map((c) => c.text.trim()).filter(Boolean);
  const longCells = texts.filter((s) => s.length > PROSEBOX_LONG_CELL_CHARS).length;
  if (longCells < PROSEBOX_LONG_CELL_MIN || longCells < texts.length * PROSEBOX_LONG_CELL_RATIO) return false;
  return true;
}
function extractBlocksWithGrids(items, pageNum, grids, horizontals, verticals) {
  const blocks = [];
  const usedItems = /* @__PURE__ */ new Set();
  const sortedGrids = [...grids].sort((a, b) => b.bbox.y2 - a.bbox.y2);
  for (const grid of sortedGrids) {
    const numGridRows = grid.rowYs.length - 1;
    const numGridCols = grid.colXs.length - 1;
    if (numGridRows === 1 && numGridCols >= 2) continue;
    if (numGridCols === 1 && numGridRows >= 2) continue;
    const tableItems = [];
    const pad = 3;
    const gridW = grid.bbox.x2 - grid.bbox.x1;
    for (const item of items) {
      if (usedItems.has(item)) continue;
      if (item.y < grid.bbox.y1 - pad || item.y > grid.bbox.y2 + pad) continue;
      if (item.x < grid.bbox.x1 - pad || item.x + item.w > grid.bbox.x2 + pad) continue;
      if (gridW < 120 && item.x + item.w > grid.bbox.x2 - 2) continue;
      tableItems.push(item);
      usedItems.add(item);
    }
    const cells = extractCells(grid, horizontals, verticals);
    if (cells.length === 0) continue;
    const textItems = tableItems.map((i) => ({
      text: i.text,
      x: i.x,
      y: i.y,
      w: i.w,
      h: i.h,
      fontSize: i.fontSize,
      fontName: i.fontName,
      hasSpaceBefore: i.hasSpaceBefore
    }));
    const cellTextMap = mapTextToCells(textItems, cells);
    const numRows = grid.rowYs.length - 1;
    const numCols = grid.colXs.length - 1;
    const irGrid = Array.from(
      { length: numRows },
      () => Array.from({ length: numCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 }))
    );
    for (const cell of cells) {
      const cellItems = cellTextMap.get(cell) || [];
      let text = cellTextToString(cellItems);
      text = text.replace(/^[\s]*[-–—]\s*\d+\s*[-–—][\s]*$/gm, "").trim();
      text = text.split("\n").map((line) => collapseEvenSpacing(line)).join("\n");
      irGrid[cell.row][cell.col] = {
        text,
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan
      };
    }
    let finalGrid = irGrid;
    let finalRows = numRows;
    if (numRows <= 2 && numCols >= 3) {
      const rebuilt = normalizeUndersegmentedTable(irGrid, grid.colXs, textItems);
      if (rebuilt) {
        finalGrid = rebuilt.map((row) => row.map((rawText) => {
          const cleaned = rawText.replace(/^[\s]*[-–—]\s*\d+\s*[-–—][\s]*$/gm, "").trim();
          return {
            text: cleaned.split("\n").map((line) => collapseEvenSpacing(line)).join("\n"),
            colSpan: 1,
            rowSpan: 1
          };
        }));
        finalRows = finalGrid.length;
      }
    }
    const irTable = {
      rows: finalRows,
      cols: numCols,
      cells: finalGrid,
      hasHeader: finalRows > 1
    };
    const hasContent = finalGrid.some((row) => row.some((cell) => cell.text.trim() !== ""));
    if (!hasContent) continue;
    if (isProseBoxGrid(grid, verticals, irTable)) {
      for (const it of tableItems) usedItems.delete(it);
      continue;
    }
    const tableBbox = {
      page: pageNum,
      x: grid.bbox.x1,
      y: grid.bbox.y1,
      width: grid.bbox.x2 - grid.bbox.x1,
      height: grid.bbox.y2 - grid.bbox.y1
    };
    if (shouldDemoteTable(irTable)) {
      const demoted = demoteTableToText(irTable);
      if (demoted) {
        const text = numGridRows === 1 ? "\n" + demoted + "\n" : demoted;
        blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox: tableBbox, style: dominantStyle(tableItems) });
      }
      continue;
    }
    blocks.push({ type: "table", table: irTable, pageNumber: pageNum, bbox: tableBbox });
  }
  let remaining = items.filter((i) => !usedItems.has(i));
  if (remaining.length > 0) {
    remaining.sort((a, b) => b.y - a.y || a.x - b.x);
    const clusterItems = remaining.map((i) => ({
      text: i.text,
      x: i.x,
      y: i.y,
      w: i.w,
      h: i.h,
      fontSize: i.fontSize,
      fontName: i.fontName,
      hasSpaceBefore: i.hasSpaceBefore
    }));
    const clusterResults = detectClusterTables(clusterItems, pageNum);
    if (clusterResults.length > 0) {
      const ciToIdx = /* @__PURE__ */ new Map();
      for (let ci = 0; ci < clusterItems.length; ci++) ciToIdx.set(clusterItems[ci], ci);
      const usedClusterIndices = /* @__PURE__ */ new Set();
      for (const cr of clusterResults) {
        for (const ci of cr.usedItems) {
          const idx = ciToIdx.get(ci);
          if (idx !== void 0) usedClusterIndices.add(idx);
        }
        blocks.push({ type: "table", table: cr.table, pageNumber: pageNum, bbox: cr.bbox });
      }
      remaining = remaining.filter((_, idx) => !usedClusterIndices.has(idx));
    }
    if (remaining.length > 0) {
      const allY = remaining.map((i) => i.y);
      const pageH = safeMax(allY) - safeMin(allY);
      const groups = xyCutOrder(remaining, Math.max(15, pageH * 0.03));
      const textBlocks = [];
      for (const group of groups) {
        if (group.length === 0) continue;
        const groupBlocks = extractPageBlocksFallback(group, pageNum);
        for (const b of groupBlocks) textBlocks.push(b);
      }
      const finalTextBlocks = detectListBlocks(textBlocks);
      for (const b of finalTextBlocks) blocks.push(b);
    }
    blocks.sort((a, b) => {
      const ay = a.bbox ? a.bbox.y + a.bbox.height : 0;
      const by = b.bbox ? b.bbox.y + b.bbox.height : 0;
      return by - ay;
    });
    return mergeAdjacentTableBlocks(blocks);
  }
  return mergeAdjacentTableBlocks(blocks);
}
var NEIGHBOR_TABLE_EPSILON = 0.2;
function mergeCrossPageTables(blocks) {
  for (let i = blocks.length - 2; i >= 0; i--) {
    const prev = blocks[i];
    const curr = blocks[i + 1];
    if (prev.type !== "table" || curr.type !== "table" || !prev.table || !curr.table) continue;
    if (!prev.pageNumber || !curr.pageNumber || curr.pageNumber !== prev.pageNumber + 1) continue;
    if (prev.table.cols !== curr.table.cols) continue;
    if (!prev.bbox || !curr.bbox) continue;
    const width = Math.max(prev.bbox.width, curr.bbox.width, 1);
    const leftDiff = Math.abs(prev.bbox.x - curr.bbox.x);
    const rightDiff = Math.abs(prev.bbox.x + prev.bbox.width - (curr.bbox.x + curr.bbox.width));
    if (leftDiff > width * NEIGHBOR_TABLE_EPSILON || rightDiff > width * NEIGHBOR_TABLE_EPSILON) continue;
    let currCells = curr.table.cells;
    if (currCells.length > 1 && prev.table.cells.length > 0 && rowTextsEqual(prev.table.cells[0], currCells[0])) {
      currCells = currCells.slice(1);
    }
    if (currCells.length === 0) {
      blocks.splice(i + 1, 1);
      continue;
    }
    const merged = {
      rows: prev.table.rows + currCells.length,
      cols: prev.table.cols,
      cells: [...prev.table.cells, ...currCells],
      hasHeader: prev.table.hasHeader,
      caption: prev.table.caption
    };
    blocks[i] = { ...prev, table: merged };
    blocks.splice(i + 1, 1);
  }
}
function rowTextsEqual(a, b) {
  if (a.length !== b.length) return false;
  const norm = (t) => t.replace(/\s+/g, "");
  for (let i = 0; i < a.length; i++) {
    if (norm(a[i].text) !== norm(b[i].text)) return false;
  }
  return a.some((c) => c.text.trim() !== "");
}
function mergeAdjacentTableBlocks(blocks) {
  if (blocks.length <= 1) return blocks;
  const result = [blocks[0]];
  for (let i = 1; i < blocks.length; i++) {
    const prev = result[result.length - 1];
    const curr = blocks[i];
    if (prev.type === "table" && curr.type === "table" && prev.table && curr.table && prev.table.cols === curr.table.cols) {
      const merged = {
        rows: prev.table.rows + curr.table.rows,
        cols: prev.table.cols,
        cells: [...prev.table.cells, ...curr.table.cells],
        hasHeader: prev.table.hasHeader
      };
      result[result.length - 1] = { ...prev, table: merged };
    } else {
      result.push(curr);
    }
  }
  return result;
}
function splitTwoColumnProse(items, cutX) {
  const left = [];
  const right = [];
  const cross = [];
  for (const i of items) {
    if (i.x + i.w <= cutX) left.push(i);
    else if (i.x >= cutX) right.push(i);
    else cross.push(i);
  }
  if (cross.length === 0) {
    return [left, right].filter((g2) => g2.length > 0);
  }
  cross.sort((a, b) => b.y - a.y);
  const crossLines = [];
  for (const c of cross) {
    const last = crossLines[crossLines.length - 1];
    if (last && Math.abs(last[0].y - c.y) <= 3) last.push(c);
    else crossLines.push([c]);
  }
  const bandItem = (arr) => arr.filter((i) => {
    for (const cl of crossLines) {
      if (Math.abs(cl[0].y - i.y) <= 3) {
        cl.push(i);
        return false;
      }
    }
    return true;
  });
  const leftRest = bandItem(left);
  const rightRest = bandItem(right);
  const boundYs = crossLines.map((cl) => cl[0].y);
  const bandOf = (y) => {
    let k = 0;
    while (k < boundYs.length && y < boundYs[k]) k++;
    return k;
  };
  const groups = [];
  for (let k = 0; k <= crossLines.length; k++) {
    const L = leftRest.filter((i) => bandOf(i.y) === k);
    const R = rightRest.filter((i) => bandOf(i.y) === k);
    if (L.length > 0) groups.push(L);
    if (R.length > 0) groups.push(R);
    if (k < crossLines.length) groups.push(crossLines[k]);
  }
  return groups;
}
function extractPageBlocksFallback(items, pageNum, fullPage = false) {
  if (items.length === 0) return [];
  const blocks = [];
  const clusterItems = items.map((i) => ({
    text: i.text,
    x: i.x,
    y: i.y,
    w: i.w,
    h: i.h,
    fontSize: i.fontSize,
    fontName: i.fontName,
    hasSpaceBefore: i.hasSpaceBefore
  }));
  const clusterResults = detectClusterTables(clusterItems, pageNum);
  if (clusterResults.length > 0) {
    const ciToIdx = /* @__PURE__ */ new Map();
    for (let ci = 0; ci < clusterItems.length; ci++) ciToIdx.set(clusterItems[ci], ci);
    const usedIndices = /* @__PURE__ */ new Set();
    for (const cr of clusterResults) {
      for (const ci of cr.usedItems) {
        const idx = ciToIdx.get(ci);
        if (idx !== void 0) usedIndices.add(idx);
      }
      blocks.push({ type: "table", table: cr.table, pageNumber: pageNum, bbox: cr.bbox });
    }
    const remaining = items.filter((_, idx) => !usedIndices.has(idx));
    if (remaining.length > 0) {
      const yLines = mergeSuperscriptLines(groupByY(remaining));
      for (const line of yLines) {
        const text = mergeLineSimple(line);
        if (!text.trim()) continue;
        const bbox = computeBBox(line, pageNum);
        blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox, style: dominantStyle(line) });
      }
    }
    blocks.sort((a, b) => {
      const ay = a.bbox ? a.bbox.y + a.bbox.height : 0;
      const by = b.bbox ? b.bbox.y + b.bbox.height : 0;
      return by - ay;
    });
  } else {
    const proseCutX = fullPage ? findTwoColumnProseCutX(items) : null;
    const allYLines = mergeSuperscriptLines(groupByY(items));
    const columns = proseCutX !== null ? null : detectColumns(allYLines);
    if (columns && columns.length >= 3) {
      const tableText = extractWithColumns(allYLines, columns);
      const bbox = computeBBox(items, pageNum);
      blocks.push({ type: "paragraph", text: tableText, pageNumber: pageNum, bbox, style: dominantStyle(items) });
    } else {
      const allY = items.map((i) => i.y);
      const pageHeight = safeMax(allY) - safeMin(allY);
      const gapThreshold = Math.max(15, pageHeight * 0.03);
      const orderedGroups = proseCutX !== null ? splitTwoColumnProse(items, proseCutX) : xyCutOrder(items, gapThreshold);
      for (const group of orderedGroups) {
        if (group.length === 0) continue;
        const yLines = mergeSuperscriptLines(groupByY(group));
        const groupColumns = detectColumns(yLines);
        if (groupColumns && groupColumns.length >= 3) {
          const tableText = extractWithColumns(yLines, groupColumns);
          const bbox = computeBBox(group, pageNum);
          blocks.push({ type: "paragraph", text: tableText, pageNumber: pageNum, bbox, style: dominantStyle(group) });
        } else {
          for (const line of yLines) {
            const text = mergeLineSimple(line);
            if (!text.trim()) continue;
            const bbox = computeBBox(line, pageNum);
            blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox, style: dominantStyle(line) });
          }
        }
      }
    }
  }
  return detectSpecialKoreanTables(blocks);
}

// src/pdf/text-clean.ts
function sanitizeBlockControlChars(blocks) {
  for (const b of blocks) {
    if (b.text) b.text = stripControlChars(b.text);
    if (b.table) {
      for (const row of b.table.cells) {
        for (const cell of row) {
          if (cell.text) cell.text = stripControlChars(cell.text);
        }
      }
    }
    if (b.children) sanitizeBlockControlChars(b.children);
  }
}
function cleanPdfText(text) {
  return mergeKoreanLines(
    stripControlChars(text).replace(/^\d{1,4}\n/, "").replace(/^[\s]*[-–—]\s*[-–—]?\d+[-–—]?[\s]*[-–—]?[\s]*$/gm, "").replace(/^\s*\d+\s*\/\s*\d+\s*$/gm, "").replace(/\n\d{1,4}\n/g, "\n").replace(/\n\d{1,4}$/, "").replace(/^#{1,6}\s*\d{1,4}\s*$/gm, "")
  ).replace(/^(?!\| ---).*$/gm, (line) => {
    if (/^\s*\${1,2}.+\${1,2}\s*$/.test(line)) return line;
    return collapseEvenSpacing(line);
  }).replace(/([□■◆○●▶ㅇ])\s+([가-힣])\s+([가-힣])/g, "$1 $2$3").replace(/\\~\\~/g, "~~").replace(/~~~~/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function startsWithMarker(line) {
  const t = line.trimStart();
  return /^[가-힣ㄱ-ㅎ][.)]/.test(t) || /^\d+[.)]/.test(t) || /^\([가-힣ㄱ-ㅎ\d]+\)/.test(t) || /^[○●※▶▷◆◇■□★☆\-·]\s/.test(t) || /^제\d+[조항호장절]/.test(t);
}
function isStandaloneHeader(line) {
  return /^제\d+[조항호장절](\([^)]*\))?(\s+\S+){0,7}$/.test(line.trim());
}
function mergeKoreanLines(text) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= 1) return text;
  const result = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prev = result[result.length - 1];
    const curr = lines[i];
    const currTrimmed = curr.trim();
    if (/^#{1,6}\s/.test(prev) || /^#{1,6}\s/.test(curr) || /^\|/.test(currTrimmed) || /^---/.test(currTrimmed)) {
      result.push(curr);
      continue;
    }
    if (/,$/.test(prev.trim()) && currTrimmed.length > 0) {
      result[result.length - 1] = prev + "\n" + curr;
      continue;
    }
    if (/^\(※/.test(currTrimmed)) {
      result[result.length - 1] = prev + " " + currTrimmed;
      continue;
    }
    if (/[가-힣·,\-]$/.test(prev) && /^[가-힣(]/.test(curr) && !startsWithMarker(curr) && !isStandaloneHeader(prev) && !startsWithMarker(prev)) {
      result[result.length - 1] = prev + " " + curr;
    } else {
      result.push(curr);
    }
  }
  return result.join("\n");
}

// src/pdf/formula-ocr.ts
async function applyFormulaOcr(buffer, blocks, pageFilter, effectivePageCount, warnings, _onProgress) {
  const formulaMod = await import("./formula-JCNF43NE.js");
  const { FormulaPipeline, ensureFormulaModels } = formulaMod;
  await ensureFormulaModels((p) => {
    if (p.phase === "download" && p.total) {
      const pct = Math.floor(p.downloaded / p.total * 100);
      process.stderr.write(`\r[kordoc-formula] ${p.spec.name} ${pct}% (${formatMb(p.downloaded)}/${formatMb(p.total)})`);
      if (p.downloaded >= p.total) process.stderr.write("\n");
    } else if (p.phase === "verify") {
      process.stderr.write(`[kordoc-formula] ${p.spec.name} SHA-256 \uAC80\uC99D \uC911...
`);
    } else if (p.phase === "done") {
      process.stderr.write(`[kordoc-formula] ${p.spec.name} \uC900\uBE44 \uC644\uB8CC
`);
    } else if (p.phase === "skip") {
    }
  });
  const pipeline = await FormulaPipeline.create();
  try {
    const pagesResult = await pipeline.runOnBuffer(buffer, pageFilter);
    if (pagesResult.length === 0) return;
    let insertedCount = 0;
    let removedDupCount = 0;
    for (const page of pagesResult) {
      const pageNumber = page.pageNumber;
      const pdfHeight = page.pdfHeight;
      const scaleX = page.renderedWidth > 0 ? page.pdfWidth / page.renderedWidth : 0.5;
      const scaleY = page.renderedHeight > 0 ? page.pdfHeight / page.renderedHeight : 0.5;
      const candidates = [];
      for (const r of page.regions) {
        if (!r.latex || !r.latex.trim()) continue;
        const wrapped = r.kind === "display" ? `$$${r.latex}$$` : `$${r.latex}$`;
        const x1 = r.bbox.x1 * scaleX;
        const x2 = r.bbox.x2 * scaleX;
        const yTop = pdfHeight - r.bbox.y1 * scaleY;
        const yBottom = pdfHeight - r.bbox.y2 * scaleY;
        const centerY = (yTop + yBottom) / 2;
        const width = x2 - x1;
        const height = yTop - yBottom;
        candidates.push({
          block: {
            type: "paragraph",
            text: wrapped,
            pageNumber,
            bbox: { page: pageNumber, x: x1, y: yBottom, width, height }
          },
          pdfBbox: { x1, x2, yTop, yBottom },
          centerY
        });
      }
      if (candidates.length === 0) continue;
      const OVERLAP_THRESHOLD = 0.6;
      const indicesToRemove = /* @__PURE__ */ new Set();
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.pageNumber !== pageNumber) continue;
        if (b.type === "table") continue;
        if (!b.bbox || b.bbox.width <= 0 || b.bbox.height <= 0) continue;
        const blockArea = b.bbox.width * b.bbox.height;
        if (blockArea <= 0) continue;
        for (const c of candidates) {
          const ox1 = Math.max(b.bbox.x, c.pdfBbox.x1);
          const ox2 = Math.min(b.bbox.x + b.bbox.width, c.pdfBbox.x2);
          const oy1 = Math.max(b.bbox.y, c.pdfBbox.yBottom);
          const oy2 = Math.min(b.bbox.y + b.bbox.height, c.pdfBbox.yTop);
          const interArea = Math.max(0, ox2 - ox1) * Math.max(0, oy2 - oy1);
          if (interArea / blockArea >= OVERLAP_THRESHOLD) {
            indicesToRemove.add(i);
            break;
          }
        }
      }
      if (indicesToRemove.size > 0) {
        const sorted = [...indicesToRemove].sort((a, b) => b - a);
        for (const idx of sorted) blocks.splice(idx, 1);
        removedDupCount += indicesToRemove.size;
      }
      candidates.sort((a, b) => b.centerY - a.centerY);
      for (const c of candidates) {
        let insertIdx = -1;
        let pageFirstIdx = -1;
        let pageLastIdx = -1;
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (b.pageNumber !== pageNumber) continue;
          if (pageFirstIdx === -1) pageFirstIdx = i;
          pageLastIdx = i;
          if (!b.bbox) continue;
          const blockCenter = b.bbox.y + b.bbox.height / 2;
          if (blockCenter < c.centerY) {
            insertIdx = i;
            break;
          }
        }
        if (insertIdx !== -1) {
          blocks.splice(insertIdx, 0, c.block);
        } else if (pageLastIdx !== -1) {
          blocks.splice(pageLastIdx + 1, 0, c.block);
        } else {
          blocks.push(c.block);
        }
        insertedCount++;
      }
    }
    if (insertedCount > 0 || removedDupCount > 0) {
      process.stderr.write(
        `[kordoc-formula] ${insertedCount}\uAC1C \uC218\uC2DD \uC0BD\uC785, ${removedDupCount}\uAC1C \uC911\uBCF5 block \uC81C\uAC70 (${pagesResult.length}\uAC1C \uD398\uC774\uC9C0)
`
      );
    }
  } finally {
    await pipeline.destroy().catch(() => {
    });
  }
}
function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// src/pdf/polyfill.ts
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
var g = globalThis;
if (typeof g.DOMMatrix === "undefined") {
  g.DOMMatrix = class DOMMatrix {
    m = [1, 0, 0, 1, 0, 0];
    constructor(init) {
      if (init) this.m = init;
    }
  };
}
if (typeof g.Path2D === "undefined") {
  g.Path2D = class Path2D {
  };
}
g.pdfjsWorker = pdfjsWorker;

// src/pdf/parser.ts
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "module";
import { dirname, join } from "path";
GlobalWorkerOptions.workerSrc = "";
var MAX_PAGES = 5e3;
var MAX_TOTAL_TEXT = 100 * 1024 * 1024;
var PDF_LOAD_TIMEOUT_MS = 3e4;
var pdfjsAssets = {};
try {
  const _require = createRequire(import.meta.url);
  const pkgDir = dirname(_require.resolve("pdfjs-dist/package.json"));
  pdfjsAssets.cMapUrl = join(pkgDir, "cmaps") + "/";
  pdfjsAssets.cMapPacked = true;
  pdfjsAssets.standardFontDataUrl = join(pkgDir, "standard_fonts") + "/";
} catch {
}
async function loadPdfWithTimeout(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    ...pdfjsAssets
  });
  let timer;
  try {
    return await Promise.race([
      loadingTask.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          loadingTask.destroy();
          reject(new KordocError("PDF \uB85C\uB529 \uD0C0\uC784\uC544\uC6C3 (30\uCD08 \uCD08\uACFC)"));
        }, PDF_LOAD_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
async function parsePdfDocument(buffer, options) {
  const formulaBuffer = options?.formulaOcr ? buffer.slice(0) : null;
  const doc = await loadPdfWithTimeout(buffer);
  try {
    const pageCount = doc.numPages;
    if (pageCount === 0) throw new KordocError("PDF\uC5D0 \uD398\uC774\uC9C0\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
    const metadata = { pageCount };
    await extractPdfMetadata(doc, metadata);
    const blocks = [];
    const warnings = [];
    const pageQuality = [];
    let totalChars = 0;
    let totalTextBytes = 0;
    const effectivePageCount = Math.min(pageCount, MAX_PAGES);
    const pageFilter = options?.pages ? parsePageRange(options.pages, effectivePageCount) : null;
    const totalTarget = pageFilter ? pageFilter.size : effectivePageCount;
    const fontSizeFreq = /* @__PURE__ */ new Map();
    const pageHeights = /* @__PURE__ */ new Map();
    const pagesWithLargeImage = /* @__PURE__ */ new Set();
    const skippedImagePages = /* @__PURE__ */ new Map();
    let parsedPages = 0;
    for (let i = 1; i <= effectivePageCount; i++) {
      if (pageFilter && !pageFilter.has(i)) continue;
      try {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        pageHeights.set(i, viewport.height);
        const rawItems = tc.items;
        const items = normalizeItems(rawItems);
        const { visible, hiddenCount } = filterHiddenText(items, viewport.width, viewport.height);
        if (hiddenCount > 0) {
          warnings.push({ page: i, message: `${hiddenCount}\uAC1C \uC228\uACA8\uC9C4 \uD14D\uC2A4\uD2B8 \uC694\uC18C \uD544\uD130\uB9C1\uB428`, code: "HIDDEN_TEXT_FILTERED" });
        }
        for (const item of visible) {
          if (item.fontSize > 0) fontSizeFreq.set(item.fontSize, (fontSizeFreq.get(item.fontSize) || 0) + 1);
        }
        const opList = await page.getOperatorList();
        const pageArea = viewport.width * viewport.height;
        if (pageArea > 0) {
          const imageRegions = extractImageRegions(opList.fnArray, opList.argsArray);
          let uncovered = 0;
          for (const r of imageRegions) {
            const area = (r.x2 - r.x1) * (r.y2 - r.y1);
            if (area < pageArea * 0.05) continue;
            pagesWithLargeImage.add(i);
            const hasText = visible.some((it) => {
              const cx = it.x + it.w / 2;
              const cy = it.y + (it.h || it.fontSize) / 2;
              return cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2;
            });
            if (!hasText) uncovered++;
          }
          if (uncovered > 0) skippedImagePages.set(i, uncovered);
        }
        const pageBlocks = extractPageBlocksWithLines(visible, i, opList, viewport.width, viewport.height);
        for (const b of pageBlocks) blocks.push(b);
        let pageText = "";
        for (const b of pageBlocks) {
          const t = b.text || "";
          totalChars += t.replace(/\s/g, "").length;
          totalTextBytes += t.length * 2;
          pageText += pageText ? "\n" + t : t;
        }
        pageQuality.push(computePageQuality(i, pageText));
        if (totalTextBytes > MAX_TOTAL_TEXT) throw new KordocError("\uD14D\uC2A4\uD2B8 \uCD94\uCD9C \uD06C\uAE30 \uCD08\uACFC");
        parsedPages++;
        options?.onProgress?.(parsedPages, totalTarget);
      } catch (pageErr) {
        if (pageErr instanceof KordocError) throw pageErr;
        warnings.push({ page: i, message: `\uD398\uC774\uC9C0 ${i} \uD30C\uC2F1 \uC2E4\uD328: ${pageErr instanceof Error ? pageErr.message : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`, code: "PARTIAL_PARSE" });
      }
    }
    const parsedPageCount = parsedPages || (pageFilter ? pageFilter.size : effectivePageCount);
    let isImageBased = false;
    if (totalChars / Math.max(parsedPageCount, 1) < 10) {
      if (options?.ocr) {
        try {
          const { ocrPages } = await import("./provider-AKROB7WQ.js");
          const ocrBlocks = await ocrPages(doc, options.ocr, pageFilter, effectivePageCount);
          if (ocrBlocks.length > 0) {
            const ocrMarkdown = ocrBlocks.map((b) => b.text || "").filter(Boolean).join("\n\n");
            return { markdown: ocrMarkdown, blocks: ocrBlocks, metadata, warnings, isImageBased: true, pageQuality, qualitySummary: summarizeDocumentQuality(pageQuality) };
          }
        } catch {
        }
      }
      isImageBased = true;
      warnings.push({
        message: `\uC774\uBBF8\uC9C0 \uAE30\uBC18 PDF (${pageCount}\uD398\uC774\uC9C0, \uD14D\uC2A4\uD2B8 ${totalChars}\uC790) \u2014 \uD14D\uC2A4\uD2B8 \uB808\uC774\uC5B4\uAC00 \uC5C6\uC5B4 OCR\uC774 \uD544\uC694\uD569\uB2C8\uB2E4`,
        code: "NEEDS_OCR"
      });
    }
    if (!isImageBased) {
      const OCR_REASON_MESSAGES = {
        low_text: "\uD14D\uC2A4\uD2B8\uAC00 \uAC70\uC758 \uC5C6\uB294 \uD398\uC774\uC9C0 (\uC2A4\uCE94/\uC774\uBBF8\uC9C0 \uCD94\uC815)",
        high_pua: "\uAE00\uAF34 \uB9E4\uD551 \uC2E4\uD328 (PUA \uBE44\uC728 \uB192\uC74C) \u2014 \uCD94\uCD9C \uD14D\uC2A4\uD2B8 \uC2E0\uB8B0 \uBD88\uAC00",
        high_control: "\uC81C\uC5B4\uBB38\uC790 \uBE44\uC728 \uB192\uC74C \u2014 \uCD94\uCD9C \uD14D\uC2A4\uD2B8 \uC2E0\uB8B0 \uBD88\uAC00",
        high_replacement: "\uB300\uCCB4\uBB38\uC790(U+FFFD) \uBE44\uC728 \uB192\uC74C \u2014 \uCD94\uCD9C \uD14D\uC2A4\uD2B8 \uC2E0\uB8B0 \uBD88\uAC00"
      };
      for (const pq of pageQuality) {
        if (!pq.needsOcr || !pq.ocrReason) continue;
        if (pq.ocrReason === "low_text" && !pagesWithLargeImage.has(pq.page)) continue;
        warnings.push({ page: pq.page, message: `${OCR_REASON_MESSAGES[pq.ocrReason]} \u2014 OCR \uAC80\uD1A0 \uD544\uC694`, code: "NEEDS_OCR" });
      }
    }
    if (!isImageBased) {
      for (const [page, count] of [...skippedImagePages.entries()].sort((a, b) => a[0] - b[0])) {
        warnings.push({ page, message: `${count}\uAC1C \uC774\uBBF8\uC9C0 \uC601\uC5ED\uC5D0 \uCD94\uCD9C \uAC00\uB2A5\uD55C \uD14D\uC2A4\uD2B8 \uC5C6\uC74C (\uADF8\uB9BC/\uCC28\uD2B8/\uB3C4\uC7A5 \uB0B4\uC6A9 \uB204\uB77D \uAC00\uB2A5)`, code: "SKIPPED_IMAGE" });
      }
    }
    if (options?.removeHeaderFooter !== false && parsedPageCount >= 3) {
      const removed = removeHeaderFooterBlocks(blocks, pageHeights, warnings);
      for (let ri = removed.length - 1; ri >= 0; ri--) {
        blocks.splice(removed[ri], 1);
      }
    }
    mergeCrossPageTables(blocks);
    if (options?.formulaOcr && formulaBuffer) {
      try {
        await applyFormulaOcr(formulaBuffer, blocks, pageFilter, effectivePageCount, warnings, options.onProgress);
      } catch (e) {
        warnings.push({
          message: `\uC218\uC2DD OCR \uC2E4\uD328: ${e instanceof Error ? e.message : String(e)}`,
          code: "PARTIAL_PARSE"
        });
      }
    }
    const medianFontSize = computeMedianFontSizeFromFreq(fontSizeFreq);
    if (medianFontSize > 0) {
      detectHeadings(blocks, medianFontSize);
    }
    detectMarkerHeadings(blocks);
    detectTableCaptions(blocks);
    detectKoreanListBlocks(blocks);
    const outline = blocks.filter((b) => b.type === "heading" && b.level && b.text).map((b) => ({ level: b.level, text: b.text, pageNumber: b.pageNumber }));
    sanitizeBlockControlChars(blocks);
    let markdown = cleanPdfText(blocksToMarkdown(blocks));
    return {
      markdown,
      blocks,
      metadata,
      outline: outline.length > 0 ? outline : void 0,
      warnings: warnings.length > 0 ? warnings : void 0,
      isImageBased: isImageBased || void 0,
      pageQuality,
      qualitySummary: summarizeDocumentQuality(pageQuality)
    };
  } finally {
    await doc.destroy().catch(() => {
    });
  }
}
async function extractPdfMetadata(doc, metadata) {
  try {
    const result = await doc.getMetadata();
    if (!result?.info) return;
    const info = result.info;
    if (typeof info.Title === "string" && info.Title.trim()) metadata.title = info.Title.trim();
    if (typeof info.Author === "string" && info.Author.trim()) metadata.author = info.Author.trim();
    if (typeof info.Creator === "string" && info.Creator.trim()) metadata.creator = info.Creator.trim();
    if (typeof info.Subject === "string" && info.Subject.trim()) metadata.description = info.Subject.trim();
    if (typeof info.Keywords === "string" && info.Keywords.trim()) {
      metadata.keywords = info.Keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean);
    }
    if (typeof info.CreationDate === "string") metadata.createdAt = parsePdfDate(info.CreationDate);
    if (typeof info.ModDate === "string") metadata.modifiedAt = parsePdfDate(info.ModDate);
  } catch {
  }
}
function parsePdfDate(dateStr) {
  const m = dateStr.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return void 0;
  const [, year, month = "01", day = "01", hour = "00", min = "00", sec = "00"] = m;
  return `${year}-${month}-${day}T${hour}:${min}:${sec}`;
}
async function extractPdfMetadataOnly(buffer) {
  const doc = await loadPdfWithTimeout(buffer);
  try {
    const metadata = { pageCount: doc.numPages };
    await extractPdfMetadata(doc, metadata);
    return metadata;
  } finally {
    await doc.destroy().catch(() => {
    });
  }
}
export {
  cleanPdfText,
  detectKoreanListBlocks,
  detectTableCaptions,
  extractPdfMetadataOnly,
  mergeCrossPageTables,
  parsePdfDocument,
  removeHeaderFooterBlocks
};
//# sourceMappingURL=parser-DOBK652H.js.map