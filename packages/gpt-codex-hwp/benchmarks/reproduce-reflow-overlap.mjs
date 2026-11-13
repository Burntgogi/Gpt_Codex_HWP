import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createReflowOverlapFixture } from "../tests/fixtures/reflow-overlap.ts";

const root = process.argv[2] === undefined
  ? await mkdtemp(join(tmpdir(), "hwp-reflow-overlap-")) : resolve(process.argv[2]);
if (process.argv[2] !== undefined) await mkdir(root, { recursive: false });
const fixture = await createReflowOverlapFixture(root);
for (const [name, preview] of [["source", fixture.sourcePreview], ["mixed", fixture.mixedPreview]]) {
  await sharp(Buffer.from(preview.svg), { density: 96 }).png().toFile(join(root, `${name}-reflow.png`));
}
await writeFile(join(root, "comparison.json"), JSON.stringify({
  source: fixture.sourcePreview.stats, mixed: fixture.mixedPreview.stats,
  layout: "synthetic reflow; native Hancom layout not checked",
}, null, 2));
console.log(root);
