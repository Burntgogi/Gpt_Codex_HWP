#!/usr/bin/env node

// src/page-range.ts
function parsePageRange(spec, maxPages) {
  const result = /* @__PURE__ */ new Set();
  if (maxPages <= 0) return result;
  if (Array.isArray(spec)) {
    for (const n of spec) {
      const page = Math.round(n);
      if (page >= 1 && page <= maxPages) result.add(page);
    }
    return result;
  }
  if (typeof spec !== "string" || spec.trim() === "") return result;
  const parts = spec.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(1, parseInt(rangeMatch[1], 10));
      const end = Math.min(maxPages, parseInt(rangeMatch[2], 10));
      for (let i = start; i <= end; i++) result.add(i);
    } else {
      const page = parseInt(trimmed, 10);
      if (!isNaN(page) && page >= 1 && page <= maxPages) result.add(page);
    }
  }
  return result;
}

export {
  parsePageRange
};
//# sourceMappingURL=chunk-MOL7MDBG.js.map