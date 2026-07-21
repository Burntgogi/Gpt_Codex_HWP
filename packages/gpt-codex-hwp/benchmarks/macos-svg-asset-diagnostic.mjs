import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function diagnose() {
  let boundary = "root";
  let root;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "hwp-svg-diagnostic-")));
    boundary = "handler-import";
    const { handleHwpCreateSvgAsset } = await import("../src/tools/assets.ts");
    boundary = "sharp-import";
    const { default: sharp } = await import("sharp");
    const svgPath = join(root, "도표.svg");
    const pngPath = join(root, "도표.png");
    boundary = "handler";
    const result = await handleHwpCreateSvgAsset({
      prompt_or_spec: JSON.stringify({
        width: 320,
        height: 180,
        background: "#ffffff",
        elements: [
          { type: "rect", x: 10, y: 10, width: 300, height: 160, fill: "#dbeafe" },
          { type: "text", x: 160, y: 90, text: "매출 <증가> & 안전", fill: "#111827", fontSize: 24, textAnchor: "middle" },
        ],
      }),
      output_svg_path: svgPath,
      output_png_path: pngPath,
    });
    if (result?.isError === true) {
      const bypass = await handleHwpCreateSvgAsset({
        prompt_or_spec: JSON.stringify({
          width: 320,
          height: 180,
          background: "#ffffff",
          elements: [
            { type: "rect", x: 10, y: 10, width: 300, height: 160, fill: "#dbeafe" },
            { type: "text", x: 160, y: 90, text: "매출 <증가> & 안전", fill: "#111827", fontSize: 24, textAnchor: "middle" },
          ],
        }),
        output_svg_path: join(root, "bypass.svg"),
        output_png_path: join(root, "bypass.png"),
      }, { validateSvg: async () => {} });
      if (bypass?.isError === true) return "path-or-build";
      const bypassWarnings = bypass?.structuredContent?.warnings;
      return Array.isArray(bypassWarnings) && bypassWarnings.length === 0
        ? "validation"
        : "render";
    }
    const details = result?.structuredContent;
    if (!Array.isArray(details?.warnings) || details.warnings.length !== 0) {
      return "handler-warning";
    }
    boundary = "svg-read";
    const svg = await readFile(svgPath, "utf8");
    boundary = "svg-content";
    if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u.test(svg)
      || !/매출 &lt;증가&gt; &amp; 안전/u.test(svg)
      || /매출 <증가>/u.test(svg)) return boundary;
    boundary = "png-read";
    const png = await readFile(pngPath);
    boundary = "png-magic";
    if (!png.subarray(0, 8).equals(PNG_MAGIC)) return boundary;
    boundary = "metadata";
    const metadata = await sharp(png).metadata();
    boundary = "dimensions";
    if (metadata.width !== 320 || metadata.height !== 180) return boundary;
    return "passed";
  } catch {
    return boundary;
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

process.stdout.write(`MAC_SVG_ASSET boundary=${await diagnose()}\n`);
