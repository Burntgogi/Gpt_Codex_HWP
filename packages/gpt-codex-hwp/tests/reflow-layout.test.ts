import assert from "node:assert/strict";
import { before, test } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { renderHwpxToSvg } from "kordoc";
import { createReflowSource } from "./fixtures/reflow-overlap.js";

let fixture: Awaited<ReturnType<typeof createFixture>>;
before(async () => {
  fixture = await createFixture();
});

async function createFixture() {
  const { source } = await createReflowSource();
  const zip = await JSZip.loadAsync(source);
  const sectionPath = "Contents/section0.xml";
  const manifestPath = "Contents/content.hpf";
  const section = new DOMParser().parseFromString(await zip.file(sectionPath)!.async("text"), "text/xml");
  const anchor = Array.from(section.documentElement.childNodes).find(
    (node) => node.nodeName === "hp:p" && node.textContent?.startsWith("IMAGEANCHOR"),
  );
  assert.ok(anchor);

  // Give the renderer the same paragraph and picture geometry as the manual insertion fixture.
  const imageParagraph = new DOMParser().parseFromString(
    `<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"
              xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" paraPrIDRef="0">
       <hp:run charPrIDRef="0">
         <hp:pic textWrap="TOP_AND_BOTTOM">
           <hp:sz width="11906" height="5953"/>
           <hp:pos treatAsChar="1" vertRelTo="PARA" horzRelTo="PARA"/>
           <hp:outMargin top="0" bottom="0"/>
           <hc:img binaryItemIDRef="image1"/>
         </hp:pic>
       </hp:run>
     </hp:p>`, "text/xml",
  ).documentElement;
  section.documentElement.insertBefore(section.importNode(imageParagraph, true), anchor.nextSibling);
  zip.file(sectionPath, section.toString());
  const manifest = await zip.file(manifestPath)!.async("text");
  zip.file(manifestPath, manifest.replace("</opf:manifest>",
    '<opf:item id="image1" href="BinData/image1.png" media-type="image/png"/></opf:manifest>'));
  zip.file("BinData/image1.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    { base64: true });
  const mixed = await zip.generateAsync({ type: "uint8array" });
  const sourcePreview = await renderHwpxToSvg(source, { reflow: true });
  const mixedPreview = await renderHwpxToSvg(mixed, { reflow: true });
  return { source, mixed, sourcePreview, mixedPreview };
}

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
    const nextParagraph = texts.find((node) => node.textContent?.startsWith("AFTERTABLEMARKER"));
    assert.ok(nextParagraph);
    assert.ok(Number(nextParagraph.getAttribute("y")) - Number(nextParagraph.getAttribute("font-size")) * 0.85
      >= rowEdges[3] - 0.02, "the next paragraph starts after the whole table");
  });
}

test("after-paragraph image reserves space between its neighboring paragraphs", () => {
  assertPictureSpacing(fixture.mixedPreview.svg);
});

test("paragraph-anchored top-and-bottom image reserves its margins during synthetic reflow", async () => {
  const zip = await JSZip.loadAsync(fixture.mixed);
  const path = "Contents/section0.xml";
  const section = new DOMParser().parseFromString(await zip.file(path)!.async("text"), "text/xml");
  const picture = section.getElementsByTagName("hp:pic")[0];
  assert.ok(picture);
  const anchor = picture.getElementsByTagName("hp:pos")[0];
  const margin = picture.getElementsByTagName("hp:outMargin")[0];
  assert.ok(anchor && margin);
  anchor.setAttribute("treatAsChar", "0");
  anchor.setAttribute("vertRelTo", "PARA");
  margin.setAttribute("top", "300");
  margin.setAttribute("bottom", "400");
  zip.file(path, section.toString());

  const preview = await renderHwpxToSvg(await zip.generateAsync({ type: "uint8array" }), { reflow: true });
  assertPictureSpacing(preview.svg, 4);
});

function assertPictureSpacing(svg: string, bottomMargin = 0) {
  const texts = svgElements(svg, "text");
  const beforeImage = texts.find((node) => node.textContent?.startsWith("IMAGEANCHOR"));
  const afterImage = texts.find((node) => node.textContent?.startsWith("AFTERIMAGEMARKER"));
  const images = svgElements(svg, "use");
  assert.ok(beforeImage && afterImage);
  assert.equal(images.length, 1);
  const top = Number(images[0].getAttribute("y"));
  const bottom = top + Number(images[0].getAttribute("height"));
  assert.ok(top > Number(beforeImage.getAttribute("y")), "the picture starts after the preceding text");
  assert.ok(bottom + bottomMargin <= Number(afterImage.getAttribute("y")) - Number(afterImage.getAttribute("font-size")) * 0.85 + 0.02,
    "the text after the picture starts below its bottom margin");
}
