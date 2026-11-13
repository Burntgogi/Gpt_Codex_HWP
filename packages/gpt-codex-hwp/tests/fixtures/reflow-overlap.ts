import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { markdownToHwpx, renderHwpxToSvg, validateHwpx } from "kordoc";
import { normalizeGeneratedFontReferences } from "../../src/shared/hwpx-font-integrity.js";
import { handleHwpInsertImage } from "../../src/tools/assets.js";

export async function createReflowOverlapFixture(root: string) {
  await mkdir(root, { recursive: true });
  const markdown = [
    "# 표와 그림 겹침 재현",
    "",
    "표 앞의 한국어 본문입니다. 문단과 표의 간격을 확인합니다.",
    "",
    "| 구분 | 여러 줄 한국어 내용 |",
    "| --- | --- |",
    `| 첫 행 | ${"셀 안의 여러 줄 본문과 아래 테두리가 겹치지 않아야 합니다. ".repeat(8)} |`,
    "| 다음 행 | 다음 행의 한국어 본문입니다. |",
    "",
    "AFTERTABLEMARKER 표 다음 문단입니다.",
    "",
    "IMAGEANCHOR 그림을 삽입할 문단입니다.",
    "",
    "AFTERIMAGEMARKER 그림 다음 문단입니다.",
  ].join("\n");
  const source = (await normalizeGeneratedFontReferences(await markdownToHwpx(markdown))).bytes;
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "rectangle.svg");
  const outputPath = join(root, "mixed.hwpx");
  await writeFile(join(root, "source.md"), markdown);
  await writeFile(sourcePath, source);
  await writeFile(imagePath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#2563eb"/></svg>');
  const inserted = await handleHwpInsertImage({
    file_path: sourcePath, image_path: imagePath, output_path: outputPath,
    anchor_text: "IMAGEANCHOR", mode: "after-paragraph", size_mm: 42,
  });
  assert.equal(inserted.isError, false, JSON.stringify(inserted));
  const mixed = await readFile(outputPath);
  const validation = await validateHwpx(mixed);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const sourcePreview = await renderHwpxToSvg(source, { reflow: true });
  const mixedPreview = await renderHwpxToSvg(mixed, { reflow: true });
  await writeFile(join(root, "source-reflow.svg"), sourcePreview.svg);
  await writeFile(join(root, "mixed-reflow.svg"), mixedPreview.svg);
  return { source, mixed, sourcePreview, mixedPreview };
}
