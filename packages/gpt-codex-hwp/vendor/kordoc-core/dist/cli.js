#!/usr/bin/env node
import {
  PRESET_ALIAS,
  extractFormFields,
  fillFormFields,
  fillHwpx,
  markdownToHwpx,
  parse
} from "./chunk-7K5P4RNT.js";
import {
  blocksToMarkdown
} from "./chunk-2IBFK5ZO.js";
import {
  detectFormat,
  detectZipFormat
} from "./chunk-MEPHGCPQ.js";
import "./chunk-MOL7MDBG.js";
import "./chunk-NZJAXMN7.js";
import "./chunk-QMJJI6TD.js";
import "./chunk-4RGDFDQ2.js";
import {
  VERSION,
  sanitizeError,
  toArrayBuffer
} from "./chunk-UNV7F3FK.js";

// src/cli.ts
import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { basename, dirname, resolve, extname } from "path";
import { Command } from "commander";
var program = new Command();
program.name("kordoc").description("\uBAA8\uB450 \uD30C\uC2F1\uD574\uBC84\uB9AC\uACA0\uB2E4 \u2014 HWP, HWPX, PDF, XLSX, DOCX \u2192 Markdown").version(VERSION).argument("<files...>", "\uBCC0\uD658\uD560 \uD30C\uC77C \uACBD\uB85C (HWP, HWPX, PDF, XLSX, DOCX)").option("-o, --output <path>", "\uCD9C\uB825 \uD30C\uC77C \uACBD\uB85C (\uB2E8\uC77C \uD30C\uC77C \uC2DC)").option("-d, --out-dir <dir>", "\uCD9C\uB825 \uB514\uB809\uD1A0\uB9AC (\uB2E4\uC911 \uD30C\uC77C \uC2DC)").option("-p, --pages <range>", "\uD398\uC774\uC9C0/\uC139\uC158 \uBC94\uC704 (\uC608: 1-3, 1,3,5)").option("--format <type>", "\uCD9C\uB825 \uD615\uC2DD: markdown (\uAE30\uBCF8) \uB610\uB294 json", "markdown").option("--no-header-footer", "PDF \uBA38\uB9AC\uAE00/\uBC14\uB2E5\uAE00 \uC790\uB3D9 \uC81C\uAC70").option("--formula-ocr", "PDF \uC218\uC2DD OCR \uD65C\uC131\uD654 (MFD+MFR ONNX, \uCCAB \uC0AC\uC6A9 \uC2DC \uBAA8\uB378 ~155MB \uC790\uB3D9 \uB2E4\uC6B4\uB85C\uB4DC)").option("--dedupe-headers", "HWP5 \uB808\uC774\uC544\uC6C3 \uD45C \uD398\uC774\uC9C0 \uBC18\uBCF5 \uB7EC\uB2DD \uD5E4\uB354 \uC911\uBCF5 \uC81C\uAC70 (\uAE30\uBCF8 off \u2014 \uBD99\uC784\uBCC4 \uC7AC\uBC88\uD638 \uC624\uC0AD\uC81C \uC8FC\uC758)").option("--inline-images", "\uC774\uBBF8\uC9C0\uB97C base64 data URI \uB85C \uB9C8\uD06C\uB2E4\uC6B4\uC5D0 \uC778\uB77C\uC778 (BMP\u2192PNG \uC555\uCD95, HWP5 \uC804\uC6A9 \u2014 \uC778\uB77C\uC778\uB41C \uACBD\uC6B0\uB9CC \uD30C\uC77C \uBBF8\uC800\uC7A5, \uADF8 \uC678 \uD3EC\uB9F7\uC740 \uC800\uC7A5 \uC720\uC9C0)").option("--silent", "\uC9C4\uD589 \uBA54\uC2DC\uC9C0 \uC228\uAE30\uAE30").action(async (files, opts) => {
  const validFormats = ["markdown", "json"];
  if (!validFormats.includes(opts.format)) {
    process.stderr.write(`[kordoc] \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD615\uC2DD: ${opts.format} (markdown \uB610\uB294 json)
`);
    process.exit(1);
  }
  for (let fi = 0; fi < files.length; fi++) {
    const filePath = files[fi];
    const absPath = resolve(filePath);
    const fileName = basename(absPath);
    const filePrefix = files.length > 1 ? `[${fi + 1}/${files.length}] ` : "";
    try {
      const fileSize = statSync(absPath).size;
      if (fileSize > 500 * 1024 * 1024) {
        process.stderr.write(`
[kordoc] SKIP: ${fileName} \u2014 \uD30C\uC77C\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4 (${(fileSize / 1024 / 1024).toFixed(1)}MB)
`);
        process.exitCode = 1;
        continue;
      }
      const buffer = readFileSync(absPath);
      const arrayBuffer = toArrayBuffer(buffer);
      const format = detectFormat(arrayBuffer);
      if (!opts.silent) {
        process.stderr.write(`[kordoc] ${filePrefix}${fileName} (${format}) ...`);
      }
      const parseOptions = { filePath: absPath };
      if (opts.pages) parseOptions.pages = opts.pages;
      if (opts.headerFooter === false) parseOptions.removeHeaderFooter = false;
      if (opts.formulaOcr) parseOptions.formulaOcr = true;
      if (opts.dedupeHeaders) parseOptions.dedupeRunningHeaders = true;
      if (opts.inlineImages) parseOptions.inlineImages = true;
      if (!opts.silent) {
        parseOptions.onProgress = (current, total) => {
          process.stderr.write(`\r[kordoc] ${filePrefix}${fileName} (${format}) [${current}/${total}]`);
        };
      }
      const result = await parse(arrayBuffer, parseOptions);
      if (!result.success) {
        process.stderr.write(` FAIL
`);
        process.stderr.write(`  \u2192 ${result.error}
`);
        process.exitCode = 1;
        continue;
      }
      if (!opts.silent) process.stderr.write(` OK
`);
      let markdown = result.markdown;
      const imagesInlined = opts.inlineImages && result.fileType === "hwp";
      if (opts.outDir && result.images?.length && !imagesInlined) {
        markdown = markdown.replace(/!\[image\]\(image_/g, "![image](images/image_").replace(/(<img\b[^>]*\bsrc=")image_/g, "$1images/image_");
      }
      const output = opts.format === "json" ? JSON.stringify(
        result,
        (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
        2
      ) : markdown;
      const saveImages = (dir) => {
        if (!result.images?.length || imagesInlined) return;
        const imgDir = resolve(dir, "images");
        mkdirSync(imgDir, { recursive: true });
        for (const img of result.images) {
          writeFileSync(resolve(imgDir, img.filename), img.data);
        }
        if (!opts.silent) process.stderr.write(`  \u2192 ${result.images.length}\uAC1C \uC774\uBBF8\uC9C0 \u2192 ${imgDir}
`);
      };
      if (opts.output && files.length === 1) {
        writeFileSync(opts.output, output, "utf-8");
        if (!opts.silent) process.stderr.write(`  \u2192 ${opts.output}
`);
        saveImages(resolve(opts.output, ".."));
      } else if (opts.outDir) {
        mkdirSync(opts.outDir, { recursive: true });
        const outExt = opts.format === "json" ? ".json" : ".md";
        const outPath = resolve(opts.outDir, fileName.replace(/\.[^.]+$/, outExt));
        writeFileSync(outPath, output, "utf-8");
        if (!opts.silent) process.stderr.write(`  \u2192 ${outPath}
`);
        saveImages(opts.outDir);
      } else {
        process.stdout.write(output + "\n");
      }
    } catch (err) {
      process.stderr.write(`
[kordoc] ERROR: ${fileName} \u2014 ${sanitizeError(err)}
`);
      process.exitCode = 1;
    }
  }
});
program.command("watch <dir>").description("\uB514\uB809\uD1A0\uB9AC \uAC10\uC2DC \u2014 \uC0C8 \uBB38\uC11C \uC790\uB3D9 \uBCC0\uD658").option("--webhook <url>", "\uACB0\uACFC \uC804\uC1A1 \uC6F9\uD6C5 URL").option("-d, --out-dir <dir>", "\uBCC0\uD658 \uACB0\uACFC \uCD9C\uB825 \uB514\uB809\uD1A0\uB9AC").option("-p, --pages <range>", "\uD398\uC774\uC9C0/\uC139\uC158 \uBC94\uC704").option("--format <type>", "\uCD9C\uB825 \uD615\uC2DD: markdown \uB610\uB294 json", "markdown").option("--silent", "\uC9C4\uD589 \uBA54\uC2DC\uC9C0 \uC228\uAE30\uAE30").action(async (dir, opts, command) => {
  const rootOpts = program.opts();
  opts.outDir ??= rootOpts.outDir;
  opts.pages ??= rootOpts.pages;
  opts.silent ??= rootOpts.silent;
  if (command.getOptionValueSource("format") === "default" && program.getOptionValueSource("format") === "cli") {
    opts.format = rootOpts.format;
  }
  const { watchDirectory } = await import("./watch-2MNRQWGV.js");
  await watchDirectory({
    dir,
    outDir: opts.outDir,
    webhook: opts.webhook,
    format: opts.format,
    pages: opts.pages,
    silent: opts.silent
  });
});
program.command("fill <template>").description("\uC11C\uC2DD \uBB38\uC11C\uC758 \uBE48\uCE78\uC744 \uCC44\uC6CC\uC11C \uCD9C\uB825 \u2014 kordoc fill \uC2E0\uCCAD\uC11C.hwpx -f '\uC131\uBA85=\uD64D\uAE38\uB3D9,\uC804\uD654=010-1234-5678' -o \uACB0\uACFC.hwpx").option("-f, --fields <pairs>", "\uCC44\uC6B8 \uD544\uB4DC (key=value \uC27C\uD45C \uAD6C\uBD84 \uB610\uB294 JSON)").option("-j, --json <path>", "\uCC44\uC6B8 \uD544\uB4DC JSON \uD30C\uC77C \uACBD\uB85C").option("-o, --output <path>", "\uCD9C\uB825 \uD30C\uC77C \uACBD\uB85C (\uD655\uC7A5\uC790\uB85C \uD3EC\uB9F7 \uACB0\uC815: .md, .hwpx)").option("--format <type>", "\uCD9C\uB825 \uD3EC\uB9F7: hwpx-preserve (\uAE30\uBCF8, \uC6D0\uBCF8 \uC2A4\uD0C0\uC77C \uBCF4\uC874), hwpx, markdown", "hwpx-preserve").option("--dry-run", "\uCC44\uC6B0\uC9C0 \uC54A\uACE0 \uC11C\uC2DD \uD544\uB4DC \uBAA9\uB85D\uB9CC \uCD9C\uB825").option("--silent", "\uC9C4\uD589 \uBA54\uC2DC\uC9C0 \uC228\uAE30\uAE30").action(async (template, opts, command) => {
  try {
    const rootOpts = program.opts();
    opts.output ??= rootOpts.output;
    opts.silent ??= rootOpts.silent;
    if (command.getOptionValueSource("format") === "default" && program.getOptionValueSource("format") === "cli") {
      opts.format = rootOpts.format;
    }
    const absPath = resolve(template);
    const fileSize = statSync(absPath).size;
    if (fileSize > 500 * 1024 * 1024) {
      process.stderr.write(`[kordoc] \uD30C\uC77C\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4 (${(fileSize / 1024 / 1024).toFixed(1)}MB)
`);
      process.exit(1);
    }
    const buffer = readFileSync(absPath);
    const arrayBuffer = toArrayBuffer(buffer);
    if (!opts.silent) process.stderr.write(`[kordoc] ${basename(absPath)} \uD30C\uC2F1 \uC911...
`);
    if (opts.dryRun) {
      const result2 = await parse(arrayBuffer);
      if (!result2.success) {
        process.stderr.write(`[kordoc] \uD30C\uC2F1 \uC2E4\uD328: ${result2.error}
`);
        process.exit(1);
      }
      const formInfo2 = extractFormFields(result2.blocks);
      if (formInfo2.fields.length === 0) {
        process.stderr.write(`[kordoc] \uC11C\uC2DD \uD544\uB4DC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.
`);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(formInfo2, null, 2) + "\n");
      return;
    }
    let values = {};
    if (opts.json) {
      const jsonPath = resolve(opts.json);
      const jsonContent = readFileSync(jsonPath, "utf-8");
      values = JSON.parse(jsonContent);
    } else if (opts.fields) {
      const fieldsStr = opts.fields;
      if (fieldsStr.startsWith("{")) {
        values = JSON.parse(fieldsStr);
      } else {
        const pairs = fieldsStr.split(/,(?=[가-힣A-Za-z][가-힣A-Za-z\s]*=)/);
        for (const pair of pairs) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx > 0) {
            const key = pair.slice(0, eqIdx).trim();
            const val = pair.slice(eqIdx + 1).trim();
            values[key] = val;
          }
        }
      }
    } else {
      process.stderr.write(`[kordoc] \uCC44\uC6B8 \uD544\uB4DC\uB97C \uC9C0\uC815\uD574\uC8FC\uC138\uC694 (-f \uB610\uB294 -j \uC635\uC158)
`);
      process.exit(1);
    }
    let outputFormat = opts.format;
    if (opts.output) {
      const ext = extname(opts.output).toLowerCase();
      if (ext === ".hwpx") outputFormat = outputFormat === "markdown" ? "hwpx-preserve" : outputFormat;
      else if (ext === ".md") outputFormat = "markdown";
    }
    if (outputFormat === "hwpx-preserve") {
      const format = detectFormat(arrayBuffer);
      let isHwpx = format === "hwpx";
      if (isHwpx) {
        const zipFormat = await detectZipFormat(arrayBuffer);
        isHwpx = zipFormat === "hwpx";
      }
      if (!isHwpx) {
        if (!opts.silent) process.stderr.write(`[kordoc] HWPX\uAC00 \uC544\uB2C8\uBBC0\uB85C hwpx \uBAA8\uB4DC\uB85C \uC804\uD658\uD569\uB2C8\uB2E4
`);
        outputFormat = "hwpx";
      } else {
        const hwpxResult = await fillHwpx(arrayBuffer, values);
        if (!opts.silent) {
          process.stderr.write(`[kordoc] ${hwpxResult.filled.length}\uAC1C \uD544\uB4DC \uCC44\uC6C0 (\uC6D0\uBCF8 \uC2A4\uD0C0\uC77C \uBCF4\uC874)
`);
          if (hwpxResult.unmatched.length > 0) {
            process.stderr.write(`[kordoc] \u26A0\uFE0F \uB9E4\uCE6D \uC2E4\uD328: ${hwpxResult.unmatched.join(", ")}
`);
          }
        }
        if (opts.output) {
          mkdirSync(dirname(resolve(opts.output)), { recursive: true });
          writeFileSync(resolve(opts.output), Buffer.from(hwpxResult.buffer));
          if (!opts.silent) process.stderr.write(`[kordoc] \u2192 ${resolve(opts.output)}
`);
        } else {
          process.stdout.write(Buffer.from(hwpxResult.buffer));
        }
        return;
      }
    }
    const result = await parse(arrayBuffer);
    if (!result.success) {
      process.stderr.write(`[kordoc] \uD30C\uC2F1 \uC2E4\uD328: ${result.error}
`);
      process.exit(1);
    }
    const formInfo = extractFormFields(result.blocks);
    if (!opts.silent) {
      process.stderr.write(`[kordoc] \uC11C\uC2DD \uD544\uB4DC ${formInfo.fields.length}\uAC1C \uAC10\uC9C0 (\uD655\uC2E0\uB3C4 ${(formInfo.confidence * 100).toFixed(0)}%)
`);
    }
    const fillResult = fillFormFields(result.blocks, values);
    if (!opts.silent) {
      process.stderr.write(`[kordoc] ${fillResult.filled.length}\uAC1C \uD544\uB4DC \uCC44\uC6C0
`);
      if (fillResult.unmatched.length > 0) {
        process.stderr.write(`[kordoc] \u26A0\uFE0F \uB9E4\uCE6D \uC2E4\uD328: ${fillResult.unmatched.join(", ")}
`);
      }
    }
    const markdown = blocksToMarkdown(fillResult.blocks);
    if (outputFormat === "hwpx") {
      const hwpxBuffer = await markdownToHwpx(markdown);
      if (opts.output) {
        mkdirSync(dirname(resolve(opts.output)), { recursive: true });
        writeFileSync(resolve(opts.output), Buffer.from(hwpxBuffer));
        if (!opts.silent) process.stderr.write(`[kordoc] \u2192 ${resolve(opts.output)}
`);
      } else {
        process.stdout.write(Buffer.from(hwpxBuffer));
      }
    } else {
      if (opts.output) {
        mkdirSync(dirname(resolve(opts.output)), { recursive: true });
        writeFileSync(resolve(opts.output), markdown, "utf-8");
        if (!opts.silent) process.stderr.write(`[kordoc] \u2192 ${resolve(opts.output)}
`);
      } else {
        process.stdout.write(markdown + "\n");
      }
    }
  } catch (err) {
    process.stderr.write(`[kordoc] \uC624\uB958: ${sanitizeError(err)}
`);
    process.exit(1);
  }
});
program.command("seal <file>").description('\uB3C4\uC7A5/\uC11C\uBA85 \uC774\uBBF8\uC9C0\uB97C \uC575\uCEE4 \uBB38\uAD6C \uC704\uC5D0 \uBD80\uC720 \uBC30\uCE58 (\uD45C/\uD398\uC774\uC9C0 \uBD88\uD655\uC7A5) \u2014 kordoc seal \uC2E0\uCCAD\uC11C.hwpx --image \uB3C4\uC7A5.png --anchor "(\uC778)" -o \uACB0\uACFC.hwpx').requiredOption("--image <path>", "\uB3C4\uC7A5/\uC11C\uBA85 \uC774\uBBF8\uC9C0 (\uD22C\uBA85 \uBC30\uACBD PNG \uAD8C\uC7A5)").option("--anchor <text>", "\uC575\uCEE4 \uBB38\uAD6C", "(\uC778)").option("-n, --occurrence <num>", "\uAC19\uC740 \uC575\uCEE4\uAC00 \uC5EC\uB7FF\uC77C \uB54C 0-based \uC120\uD0DD", "0").option("--size-mm <num>", "\uB3C4\uC7A5 \uD55C \uBCC0 \uD06C\uAE30 mm (\uAE30\uBCF8: \uC904\uB192\uC774\xD71.6, 7~18 \uD074\uB7A8\uD504)").option("--mode <mode>", "overlap(\uBB38\uAD6C \uC704 \uACB9\uCE68) | right(\uC624\uB978\uCABD \uC606) | auto", "auto").option("--dx <mm>", "x \uBBF8\uC138\uC870\uC815 mm", "0").option("--dy <mm>", "y \uBBF8\uC138\uC870\uC815 mm", "0").option("-o, --output <path>", "\uCD9C\uB825 \uACBD\uB85C (\uAE30\uBCF8: <\uC785\uB825>.sealed.hwpx)").option("--silent", "\uC9C4\uD589 \uBA54\uC2DC\uC9C0 \uC228\uAE30\uAE30").action(async (file, opts) => {
  try {
    const { placeSealHwpx, detectFormat: detectFormat2 } = await import("./-V66QW3WA.js");
    const rootOpts = program.opts();
    const output = opts.output ?? rootOpts.output;
    const silent = opts.silent ?? rootOpts.silent;
    const mode = String(opts.mode).toLowerCase();
    if (!["overlap", "right", "auto"].includes(mode)) {
      process.stderr.write(`[kordoc] --mode \uB294 overlap/right/auto \uC911 \uD558\uB098\uC5EC\uC57C \uD569\uB2C8\uB2E4
`);
      process.exit(1);
    }
    const buf = new Uint8Array(readFileSync(resolve(file)));
    if (detectFormat2(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) !== "hwpx") {
      process.stderr.write(`[kordoc] seal \uC740 HWPX \uC804\uC6A9\uC785\uB2C8\uB2E4 (HWP 5.x \uBC14\uC774\uB108\uB9AC\uB294 \uBBF8\uC9C0\uC6D0)
`);
      process.exit(1);
    }
    const imgPath = resolve(opts.image);
    const imgSize = statSync(imgPath).size;
    if (imgSize > 500 * 1024 * 1024) {
      process.stderr.write(`[kordoc] \uB3C4\uC7A5 \uC774\uBBF8\uC9C0\uAC00 \uB108\uBB34 \uD07D\uB2C8\uB2E4 (${(imgSize / 1024 / 1024).toFixed(0)}MB)
`);
      process.exit(1);
    }
    const image = new Uint8Array(readFileSync(imgPath));
    const ext = extname(opts.image).slice(1).toLowerCase() || "png";
    let sizeMm;
    if (opts.sizeMm != null) {
      const n = Number(opts.sizeMm);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`[kordoc] --size-mm \uC740 \uC591\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4: ${opts.sizeMm}
`);
        process.exit(1);
      }
      sizeMm = n;
    }
    const result = await placeSealHwpx(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      [{
        anchor: opts.anchor,
        occurrence: Number(opts.occurrence) || 0,
        image,
        ext,
        sizeMm,
        mode,
        dxMm: Number(opts.dx) || 0,
        dyMm: Number(opts.dy) || 0
      }]
    );
    const outPath = resolve(output ?? file.replace(/\.hwpx$/i, "") + ".sealed.hwpx");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(result.buffer));
    if (!silent) {
      for (const p of result.placed) {
        process.stderr.write(`[kordoc] \uB3C4\uC7A5 \uBC30\uCE58: "${p.anchor}" #${p.occurrence} \u2192 ${p.mode} (${p.posXMm}mm, ${p.posYMm}mm, ${p.sizeMm}mm) [${p.entry}]
`);
        for (const w of p.warnings ?? []) process.stderr.write(`[kordoc] \u26A0\uFE0F ${w}
`);
      }
      process.stderr.write(`[kordoc] \u2192 ${outPath}
`);
    }
  } catch (err) {
    process.stderr.write(`[kordoc] \uC624\uB958: ${sanitizeError(err)}
`);
    process.exit(1);
  }
});
program.command("patch <original> <edited>").description("\uC11C\uC2DD \uBCF4\uC874 \uB77C\uC6B4\uB4DC\uD2B8\uB9BD \uD328\uCE58 \u2014 \uD3B8\uC9D1\uB41C \uB9C8\uD06C\uB2E4\uC6B4\uC744 \uC6D0\uBCF8 HWPX/HWP\uC5D0 in-place \uBC18\uC601 (kordoc patch \uC6D0\uBCF8.hwpx \uD3B8\uC9D1.md -o \uCD9C\uB825.hwpx)").option("-o, --output <path>", "\uCD9C\uB825 \uACBD\uB85C (\uAE30\uBCF8: <\uC6D0\uBCF8>.patched.hwpx|.hwp)").option("--no-verify", "\uD328\uCE58 \uD6C4 \uC7AC\uD30C\uC2F1 \uC790\uB3D9 \uAC80\uC99D \uC0DD\uB7B5").option("--silent", "\uC9C4\uD589 \uBA54\uC2DC\uC9C0 \uC228\uAE30\uAE30").action(async (original, edited, opts) => {
  try {
    const { patchHwpx, patchHwp, detectFormat: detectFormat2 } = await import("./-V66QW3WA.js");
    const rootOpts = program.opts();
    const output = opts.output ?? rootOpts.output;
    const silent = opts.silent ?? rootOpts.silent;
    const originalBuf = new Uint8Array(readFileSync(resolve(original)));
    const editedMarkdown = readFileSync(resolve(edited), "utf-8");
    const format = detectFormat2(originalBuf.buffer);
    const result = format === "hwp" ? await patchHwp(originalBuf, editedMarkdown, { verify: opts.verify !== false }) : await patchHwpx(originalBuf, editedMarkdown, { verify: opts.verify !== false });
    if (!result.success || !result.data) {
      process.stderr.write(`[kordoc] \uD328\uCE58 \uC2E4\uD328: ${result.error ?? "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}
`);
      process.exit(1);
    }
    const ext = format === "hwp" ? ".hwp" : ".hwpx";
    const outPath = resolve(output ?? original.replace(/\.hwpx?$/i, "") + ".patched" + ext);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.data);
    if (!silent) {
      process.stderr.write(`[kordoc] ${result.applied}\uAC1C \uBCC0\uACBD \uC801\uC6A9 (\uC6D0\uBCF8 \uC11C\uC2DD \uBCF4\uC874) \u2192 ${outPath}
`);
      for (const s of result.skipped) {
        process.stderr.write(`[kordoc] \u26A0\uFE0F SKIP: ${s.reason}${s.before ? ` | ${s.before}` : ""}
`);
      }
      if (result.verification) {
        const v = result.verification.stats;
        const residual = v.added + v.removed + v.modified;
        process.stderr.write(residual === 0 ? `[kordoc] \u2713 \uAC80\uC99D: \uD3B8\uC9D1 \uB9C8\uD06C\uB2E4\uC6B4\uACFC \uC7AC\uD30C\uC2F1 \uACB0\uACFC \uC644\uC804 \uC77C\uCE58 (${v.unchanged}\uBE14\uB85D)
` : `[kordoc] \u26A0\uFE0F \uAC80\uC99D \uC794\uCC28: \uC218\uC815 ${v.modified}, \uCD94\uAC00 ${v.added}, \uC0AD\uC81C ${v.removed} (\uBBF8\uC9C0\uC6D0 \uBCC0\uACBD\uC740 skip \uBAA9\uB85D \uCC38\uC870)
`);
      }
    }
    if (result.skipped.length > 0) process.exitCode = 2;
  } catch (err) {
    process.stderr.write(`[kordoc] \uC624\uB958: ${sanitizeError(err)}
`);
    process.exit(1);
  }
});
program.command("validate <file>").description("HWPX \uAD6C\uC870 \uAC80\uC99D \u2014 ZIP\xB7mimetype\xB7\uD544\uC218 \uD30C\uC77C\xB7XML \uC6F0\uD3FC\uB4DC\xB7secCnt\xB7manifest \uCC38\uC870 (\uD55C\uCEF4\uB3C5\uC2A4 \uAC70\uBD80 \uC694\uC778 \uC0AC\uC804 \uCC28\uB2E8)").option("--json", "\uACB0\uACFC\uB97C JSON\uC73C\uB85C stdout\uC5D0 \uCD9C\uB825").action(async (file, opts) => {
  try {
    const { validateHwpx } = await import("./-V66QW3WA.js");
    const buf = new Uint8Array(readFileSync(resolve(file)));
    const result = await validateHwpx(buf);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (result.ok) {
      process.stderr.write(`[kordoc] \u2713 \uAD6C\uC870 \uAC80\uC99D \uD1B5\uACFC (\uC5D4\uD2B8\uB9AC ${result.entryCount}\uAC1C): ${file}
`);
    } else {
      process.stderr.write(`[kordoc] \u2717 \uAD6C\uC870 \uBB38\uC81C ${result.issues.length}\uAC74: ${file}
`);
      for (const i of result.issues) {
        process.stderr.write(`[kordoc]   - ${i.path ? `${i.path}: ` : ""}${i.message}
`);
      }
    }
    if (!result.ok) process.exit(1);
  } catch (err) {
    process.stderr.write(`[kordoc] \uC624\uB958: ${sanitizeError(err)}
`);
    process.exit(1);
  }
});
program.command("generate <markdown>").alias("gen").description("\uB9C8\uD06C\uB2E4\uC6B4 \u2192 \uACF5\uBB38\uC11C HWPX \uC0DD\uC131 \u2014 kordoc generate \uBCF4\uACE0\uC11C.md -o \uBCF4\uACE0\uC11C.hwpx --preset \uBCF4\uACE0\uC11C (markdown\uC5D0 '-' \uC9C0\uC815 \uC2DC stdin)").option("-o, --output <path>", "\uCD9C\uB825 HWPX \uACBD\uB85C (\uAE30\uBCF8: <\uC785\uB825>.hwpx)").option("--preset <name>", "\uACF5\uBB38\uC11C \uD504\uB9AC\uC14B: \uAE30\uC548\uBB38(official)\xB7\uBCF4\uACE0\uC11C(report)\xB7\uACC4\uD68D\uC11C(plan)\xB7\uD1B5\uC9C0(notice)\xB7\uD68C\uC758\uB85D(minutes)", "\uAE30\uC548\uBB38").option("--font <type>", "\uBCF8\uBB38 \uAE00\uAF34: myeongjo(\uD568\uCD08\uB86C\uBC14\uD0D5) \uB610\uB294 gothic(\uB9D1\uC740 \uACE0\uB515)").option("--pt <size>", "\uBCF8\uBB38 \uAE00\uC790 \uD06C\uAE30(pt)").option("--line-spacing <percent>", "\uBCF8\uBB38 \uC904\uAC04\uACA9(%)").option("--plain", "\uACF5\uBB38\uC11C \uBAA8\uB4DC \uB044\uAE30 (\uBC94\uC6A9 \uB9C8\uD06C\uB2E4\uC6B4 \uBCC0\uD658)").option("--silent", "\uC9C4\uD589 \uBA54\uC2DC\uC9C0 \uC228\uAE30\uAE30").action(async (markdown, opts) => {
  try {
    const rootOpts = program.opts();
    const output = opts.output ?? rootOpts.output;
    const silent = opts.silent ?? rootOpts.silent;
    let md;
    let baseName = "document";
    if (markdown === "-") {
      md = readFileSync(0, "utf-8");
    } else {
      const inPath = resolve(markdown);
      md = readFileSync(inPath, "utf-8");
      baseName = basename(inPath).replace(/\.(md|markdown|txt)$/i, "");
    }
    let gongmun;
    if (!opts.plain) {
      const preset = PRESET_ALIAS[String(opts.preset).trim()];
      if (!preset) {
        process.stderr.write(`[kordoc] \uC54C \uC218 \uC5C6\uB294 \uD504\uB9AC\uC14B: ${opts.preset} (\uAE30\uC548\uBB38/\uBCF4\uACE0\uC11C/\uACC4\uD68D\uC11C/\uD1B5\uC9C0/\uD68C\uC758\uB85D)
`);
        process.exit(1);
      }
      gongmun = { preset };
      if (opts.font) {
        if (opts.font !== "myeongjo" && opts.font !== "gothic") {
          process.stderr.write(`[kordoc] --font \uC740 myeongjo \uB610\uB294 gothic
`);
          process.exit(1);
        }
        gongmun.bodyFont = opts.font;
      }
      if (opts.pt) gongmun.bodyPt = Number(opts.pt);
      if (opts.lineSpacing) gongmun.lineSpacing = Number(opts.lineSpacing);
    }
    const buf = await markdownToHwpx(md, gongmun ? { gongmun } : void 0);
    const outPath = resolve(output ?? (markdown === "-" ? `${baseName}.hwpx` : markdown.replace(/\.(md|markdown|txt)$/i, "") + ".hwpx"));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(buf));
    if (!silent) {
      const mode = gongmun ? `\uACF5\uBB38\uC11C:${gongmun.preset}` : "\uBC94\uC6A9";
      process.stderr.write(`[kordoc] HWPX \uC0DD\uC131 (${mode}) \u2192 ${outPath}
`);
    }
  } catch (err) {
    process.stderr.write(`[kordoc] \uC624\uB958: ${sanitizeError(err)}
`);
    process.exit(1);
  }
});
program.command("render <file>").description("\uB808\uC774\uC544\uC6C3 \uBCF4\uC874 \uB80C\uB354 \u2014 \uD55C\uCEF4 \uC800\uC7A5 HWPX\uC758 \uC870\uD310 \uCE90\uC2DC\uB97C SVG\uB85C (\uC804\uCCB4 \uD398\uC774\uC9C0 \uC138\uB85C \uC2A4\uD0DD) \u2014 kordoc render \uBB38\uC11C.hwpx -o \uBB38\uC11C.svg").option("-o, --output <path>", "\uCD9C\uB825 SVG \uACBD\uB85C (\uAE30\uBCF8: <\uC785\uB825>.svg)").option("--highlight <terms>", "\uAC80\uC0C9\uC5B4 \uD615\uAD11\uD39C (\uC27C\uD45C \uAD6C\uBD84)").option("--reflow", "\uC870\uD310 \uCE90\uC2DC \uC5C6\uB294 HWPX\uB3C4 \uC21C\uC218 TS \uC870\uD310\uC73C\uB85C \uB80C\uB354 (markdownToHwpx \uC0B0\uCD9C\uBB3C\xB7\uD3B8\uC9D1\uBCF8)").option("--reflow-mode <mode>", "reflow \uC904\uBC14\uAFC8 \uBAA8\uB4DC: keep(\uC5B4\uC808) | charAll(\uAE00\uC790)", "keep").option("--silent", "\uC9C4\uD589 \uBA54\uC2DC\uC9C0 \uC228\uAE30\uAE30").action(async (file, opts) => {
  try {
    const rootOpts = program.opts();
    const output = opts.output ?? rootOpts.output;
    const silent = opts.silent ?? rootOpts.silent;
    const { renderHwpxToSvg } = await import("./render-VX4H2S4F.js");
    const absPath = resolve(file);
    const buffer = readFileSync(absPath);
    const highlights = opts.highlight ? String(opts.highlight).split(",") : void 0;
    const result = await renderHwpxToSvg(toArrayBuffer(buffer), { highlights, reflow: opts.reflow, reflowMode: opts.reflowMode });
    const outPath = resolve(output ?? file.replace(/\.hwpx$/i, "") + ".svg");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.svg, "utf-8");
    if (!silent) {
      process.stderr.write(`[kordoc] \uB80C\uB354 (${result.pageCount}\uD398\uC774\uC9C0, ${result.width}x${result.height}pt, \uD14D\uC2A4\uD2B8 ${result.stats.texts}\xB7\uC774\uBBF8\uC9C0 ${result.stats.images}\xB7\uD45C ${result.stats.tables}) \u2192 ${outPath}
`);
      for (const w of result.warnings) process.stderr.write(`[kordoc] \u26A0\uFE0F ${w}
`);
    }
  } catch (err) {
    process.stderr.write(`[kordoc] \uC624\uB958: ${sanitizeError(err)}
`);
    process.exit(1);
  }
});
program.command("render-worker").description("persistent \uB80C\uB354 \uC6CC\uCEE4 \u2014 stdin NDJSON \uC694\uCCAD \u2192 \uC870\uD310 SVG \uD30C\uC77C \uCD9C\uB825 (\uD504\uB85C\uC138\uC2A4 \uC720\uC9C0, \uCF5C\uB4DC\uC2A4\uD0C0\uD2B8 \uC81C\uAC70)").action(async () => {
  const { createInterface } = await import("readline");
  const { renderHwpxToSvg } = await import("./render-VX4H2S4F.js");
  const rl = createInterface({ input: process.stdin });
  const write = (o) => void process.stdout.write(JSON.stringify(o) + "\n");
  write({ ready: true, version: VERSION });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let req;
    try {
      req = JSON.parse(t);
    } catch {
      write({ ok: false, error: "\uC798\uBABB\uB41C JSON \uB77C\uC778" });
      continue;
    }
    if (req === null || typeof req !== "object") {
      write({ ok: false, error: "JSON \uAC1D\uCCB4\uAC00 \uC544\uB2D9\uB2C8\uB2E4" });
      continue;
    }
    if (req.cmd === "quit") {
      rl.close();
      break;
    }
    const id = req.id;
    try {
      if (!req.file || !req.out) throw new Error("file\xB7out \uD544\uC218");
      const buffer = readFileSync(resolve(req.file));
      const result = await renderHwpxToSvg(toArrayBuffer(buffer), {
        highlights: req.highlight,
        reflow: req.reflow,
        reflowMode: req.reflowMode
      });
      const outPath = resolve(req.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, result.svg, "utf-8");
      write({ id, ok: true, out: outPath, width: result.width, height: result.height, pageCount: result.pageCount, stats: result.stats, warnings: result.warnings });
    } catch (err) {
      write({ id, ok: false, error: sanitizeError(err) });
    }
  }
});
program.command("mcp").description("MCP \uC11C\uBC84 \uC2E4\uD589 (Claude / Cursor / Windsurf \uC5F0\uB3D9)").action(async () => {
  await import("./mcp.js");
});
program.command("setup").description("\uB300\uD654\uD615 \uC124\uCE58 \uB9C8\uBC95\uC0AC \u2014 AI \uD074\uB77C\uC774\uC5B8\uD2B8 \uC790\uB3D9 \uB4F1\uB85D (Mac/Win/Linux)").action(async () => {
  const { runSetup } = await import("./setup-57FB3LSP.js");
  await runSetup();
});
program.command("check-formula-models").description("PDF \uC218\uC2DD OCR \uBAA8\uB378(MFD + MFR + tokenizer, ~155MB) \uC0C1\uD0DC \uD655\uC778 \u2014 \uC5C6\uAC70\uB098 SHA \uBD88\uC77C\uCE58\uBA74 \uB2E4\uC6B4\uB85C\uB4DC").option("--status-only", "\uC0C1\uD0DC\uB9CC JSON \uC73C\uB85C \uCD9C\uB825 (\uB2E4\uC6B4\uB85C\uB4DC \uC548 \uD568)").action(async (opts) => {
  try {
    const { getFormulaModelStatus, ensureFormulaModels, getFormulaModelsDir } = await import("./formula-JCNF43NE.js");
    const dir = getFormulaModelsDir();
    if (opts.statusOnly) {
      const status = await getFormulaModelStatus();
      process.stdout.write(
        JSON.stringify(
          {
            modelsDir: dir,
            allReady: status.every((s) => s.verified),
            models: status.map((s) => ({
              name: s.spec.name,
              filename: s.spec.filename,
              sizeMb: s.spec.sizeMb,
              exists: s.exists,
              verified: s.verified,
              invalidReason: s.invalidReason,
              path: s.localPath
            }))
          },
          null,
          2
        ) + "\n"
      );
      return;
    }
    process.stderr.write(`[kordoc-formula] \uCE90\uC2DC \uB514\uB809\uD1A0\uB9AC: ${dir}
`);
    await ensureFormulaModels((p) => {
      if (p.phase === "download" && p.total) {
        const pct = Math.floor(p.downloaded / p.total * 100);
        process.stderr.write(
          `\r[kordoc-formula] ${p.spec.name} ${pct}% (${(p.downloaded / 1024 / 1024).toFixed(1)}/${(p.total / 1024 / 1024).toFixed(1)}MB)`
        );
        if (p.downloaded >= p.total) process.stderr.write("\n");
      } else if (p.phase === "verify") {
        process.stderr.write(`[kordoc-formula] ${p.spec.name} SHA-256 \uAC80\uC99D \uC911...
`);
      } else if (p.phase === "done") {
        process.stderr.write(`[kordoc-formula] ${p.spec.name} \uC900\uBE44 \uC644\uB8CC
`);
      } else if (p.phase === "skip") {
        process.stderr.write(`[kordoc-formula] ${p.spec.name} \uC774\uBBF8 \uC874\uC7AC (skip)
`);
      }
    });
    process.stdout.write("ok\n");
  } catch (err) {
    process.stderr.write(`[kordoc] \uC218\uC2DD \uBAA8\uB378 \uC900\uBE44 \uC2E4\uD328: ${sanitizeError(err)}
`);
    process.exit(1);
  }
});
program.parse();
//# sourceMappingURL=cli.js.map