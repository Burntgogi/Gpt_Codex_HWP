"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { newObj[key] = obj[key]; } } } newObj.default = obj; return newObj; } }require('./chunk-GS7T56RP.cjs');

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
    } catch (e) {
      blocks.push({ type: "paragraph", text: `[OCR \uC2E4\uD328: \uD398\uC774\uC9C0 ${i}]` });
    }
  }
  return blocks;
}
async function renderPageToPng(page) {
  let createCanvas;
  try {
    const canvasModule = await Promise.resolve().then(() => _interopRequireWildcard(require("canvas")));
    createCanvas = canvasModule.createCanvas;
  } catch (e2) {
    throw new Error("OCR\uC744 \uC0AC\uC6A9\uD558\uB824\uBA74 'canvas' \uD328\uD0A4\uC9C0\uB97C \uC124\uCE58\uD558\uC138\uC694: npm install canvas");
  }
  const scale = 2;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Uint8Array(canvas.toBuffer("image/png"));
}


exports.ocrPages = ocrPages;
//# sourceMappingURL=provider-G4C2V2PD.cjs.map