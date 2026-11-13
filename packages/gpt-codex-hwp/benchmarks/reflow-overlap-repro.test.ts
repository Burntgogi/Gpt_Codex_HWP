import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { renderHwpxToSvg } from "kordoc";
import { createReflowOverlapFixture } from "../tests/fixtures/reflow-overlap.js";

let root: string;
let fixture: Awaited<ReturnType<typeof createReflowOverlapFixture>>;
before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hwp-reflow-overlap-")));
  fixture = await createReflowOverlapFixture(root);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 }); });

function svgElements(svg: string, tag: string) {
  return Array.from(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName(tag));
}

test("issue 25 fixture isolates synthetic reflow from a Hancom layout cache", async () => {
  for (const bytes of [fixture.source, fixture.mixed]) {
    const zip = await JSZip.loadAsync(bytes);
    const section = await zip.file("Contents/section0.xml")!.async("text");
    assert.doesNotMatch(section, /<hp:linesegarray\b/u);
    await assert.rejects(renderHwpxToSvg(bytes), /linesegarray|reflow/u);
  }
  assert.equal(fixture.sourcePreview.stats.tables, 1);
  assert.equal(fixture.sourcePreview.stats.images, 0);
  assert.equal(fixture.mixedPreview.stats.tables, 1);
  assert.equal(fixture.mixedPreview.stats.images, 1);
});

for (const label of ["table-only", "table-and-image"] as const) {
  test(`issue 25: ${label} reflow preserves bottom padding for a multiline Korean cell`, async () => {
    const [bytes, preview] = label === "table-only"
      ? [fixture.source, fixture.sourcePreview] : [fixture.mixed, fixture.mixedPreview];
    const zip = await JSZip.loadAsync(bytes);
    const section = new DOMParser().parseFromString(await zip.file("Contents/section0.xml")!.async("text"), "text/xml");
    const cell = Array.from(section.getElementsByTagName("hp:tc"))
      .find((node) => node.textContent?.includes("셀 안의 여러 줄"));
    assert.ok(cell);
    const bottomPadding = Number(cell.getElementsByTagName("hp:cellMargin")[0].getAttribute("bottom")) / 100;
    assert.ok(bottomPadding > 0);
    const texts = svgElements(preview.svg, "text");
    const start = texts.findIndex((node) => node.textContent === "첫 행");
    const end = texts.findIndex((node) => node.textContent === "다음 행");
    assert.ok(start >= 0 && end > start + 2, "fixture must wrap the Korean cell onto multiple lines");
    const lastBaseline = Math.max(...texts.slice(start + 1, end).map((node) => Number(node.getAttribute("y"))));
    const rowEdges = [...new Set(svgElements(preview.svg, "line")
      .filter((node) => node.getAttribute("y1") === node.getAttribute("y2"))
      .map((node) => Number(node.getAttribute("y1"))))].sort((a, b) => a - b);
    assert.equal(rowEdges.length, 4, "fixture has three rows");
    // A baseline already inside bottom padding is a conservative overlap signal;
    // actual glyph descenders need additional room. This needs no installed font.
    assert.ok(lastBaseline <= rowEdges[2] - bottomPadding,
      `${label}: last baseline ${lastBaseline}pt, row bottom ${rowEdges[2]}pt, padding ${bottomPadding}pt`);
  });
}

test("after-paragraph image reserves space between its neighboring paragraphs", () => {
  const texts = svgElements(fixture.mixedPreview.svg, "text");
  const beforeImage = texts.find((node) => node.textContent?.startsWith("IMAGEANCHOR"));
  const afterImage = texts.find((node) => node.textContent?.startsWith("AFTERIMAGEMARKER"));
  const images = svgElements(fixture.mixedPreview.svg, "use");
  assert.ok(beforeImage && afterImage);
  assert.equal(images.length, 1);
  const top = Number(images[0].getAttribute("y"));
  const bottom = top + Number(images[0].getAttribute("height"));
  assert.ok(top > Number(beforeImage.getAttribute("y")));
  assert.ok(bottom <= Number(afterImage.getAttribute("y")) - Number(afterImage.getAttribute("font-size")) * 0.85 + 0.02);
});
