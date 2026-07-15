#!/usr/bin/env node

// src/ocr/provider.ts
async function ocrPages(doc, provider, pageFilter, effectivePageCount) {
  const blocks = [];
  for (let i = 1; i <= effectivePageCount; i++) {
    if (pageFilter && !pageFilter.has(i)) continue;
    const page = await doc.getPage(i);
    try {
      const imageData = await renderPageToPng(page);
      const text = await provider(imageData, i, "image/png");
      if (text.trim()) {
        blocks.push({ type: "paragraph", text: text.trim(), pageNumber: i });
      }
    } catch {
      blocks.push({ type: "paragraph", text: `[OCR \uC2E4\uD328: \uD398\uC774\uC9C0 ${i}]` });
    }
  }
  return blocks;
}
async function renderPageToPng(page) {
  let createCanvas;
  try {
    const canvasModule = await import("canvas");
    createCanvas = canvasModule.createCanvas;
  } catch {
    throw new Error("OCR\uC744 \uC0AC\uC6A9\uD558\uB824\uBA74 'canvas' \uD328\uD0A4\uC9C0\uB97C \uC124\uCE58\uD558\uC138\uC694: npm install canvas");
  }
  const scale = 2;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Uint8Array(canvas.toBuffer("image/png"));
}
export {
  ocrPages
};
//# sourceMappingURL=provider-AKROB7WQ.js.map