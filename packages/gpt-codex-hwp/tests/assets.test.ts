import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import {
  markdownToHwpx,
  parse,
  renderHwpxToSvg,
  validateHwpx,
} from "kordoc";
import sharp from "sharp";

import {
  handleHwpCreateSvgAsset,
  handleHwpInsertImage,
  pythonCommandCandidates,
  runPython,
} from "../src/tools/assets.js";

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const HWPX_SAFE_EDIT_ROOT = join(SOURCE_ROOT, "scripts", "hwpx-safe-edit");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
type XmlEncoding = "utf8" | "utf16le" | "utf16be";

test("Python candidates are platform-specific", () => {
  assert.deepEqual(pythonCommandCandidates("win32"), [
    { command: "python", argsPrefix: ["-X", "utf8"] },
    { command: "py", argsPrefix: ["-3", "-X", "utf8"] },
  ]);
  assert.deepEqual(pythonCommandCandidates("darwin"), [
    { command: "python3", argsPrefix: ["-X", "utf8"] },
    { command: "python", argsPrefix: ["-X", "utf8"] },
  ]);
});

test("runPython reports PYTHON_NOT_FOUND after every candidate is missing", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runPython("helper.py", ["input.hwpx"], "darwin", async (command) => {
      calls.push(command);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PYTHON_NOT_FOUND");
      return true;
    },
  );
  assert.deepEqual(calls, ["python3", "python"]);
});

test("Python XML policy rejects encoded DTDs and protection manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-python-xml-policy-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, "xml_policy_regression.py");
  const helperDirectory = HWPX_SAFE_EDIT_ROOT;
  await writeFile(
    script,
    `import io\nimport json\nimport sys\nimport zipfile\nsys.path.insert(0, sys.argv[1])\nimport hwpxlib as H\nimport insert_image as I\n\ndef encoded(text, encoding):\n    if encoding == "utf8":\n        return b"\\xef\\xbb\\xbf" + text.encode("utf-8")\n    if encoding == "utf16le":\n        return b"\\xff\\xfe" + text.encode("utf-16le")\n    return b"\\xfe\\xff" + text.encode("utf-16be")\n\ndef dtd_rejected(encoding):\n    declaration = "UTF-8" if encoding == "utf8" else "UTF-16"\n    xml = f'<?xml version="1.0" encoding="{declaration}"?><!DOCTYPE root [<!ENTITY benign "ok">]><root>&benign;</root>'\n    try:\n        H.parse_xml(encoded(xml, encoding))\n    except ValueError:\n        return True\n    return False\n\ndef protection_rejected(encoding):\n    declaration = "UTF-8" if encoding == "utf8" else "UTF-16"\n    xml = f'<?xml version="1.0" encoding="{declaration}"?><manifest><distribution/></manifest>'\n    archive = io.BytesIO()\n    with zipfile.ZipFile(archive, "w") as zipped:\n        zipped.writestr("META-INF/manifest.xml", encoded(xml, encoding))\n    archive.seek(0)\n    with zipfile.ZipFile(archive) as zipped:\n        try:\n            I.guard_protected_package(zipped)\n        except I.ProtectedDocumentError as error:\n            return error.code\n    return None\n\nencodings = ("utf8", "utf16le", "utf16be")\nprint(json.dumps({\n    "dtd": {encoding: dtd_rejected(encoding) for encoding in encodings},\n    "protection": {encoding: protection_rejected(encoding) for encoding in encodings},\n}))\n`,
    "utf8",
  );

  const executed = await runPython(script, [helperDirectory]);
  const result = JSON.parse(executed.stdout) as {
    dtd: Record<XmlEncoding, boolean>;
    protection: Record<XmlEncoding, string | null>;
  };
  assert.deepEqual(result.dtd, { utf8: true, utf16le: true, utf16be: true });
  assert.deepEqual(result.protection, {
    utf8: "ENCRYPTED",
    utf16le: "ENCRYPTED",
    utf16be: "ENCRYPTED",
  });
});

test("image insertion uses the bounded ZIP loader seam", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-bounded-zip-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  const outputPath = join(root, "output.hwpx");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("본문")));
  await writeFile(imagePath, await testPng());
  let loadCalls = 0;

  const result = await handleHwpInsertImage(
    {
      file_path: sourcePath,
      image_path: imagePath,
      output_path: outputPath,
      anchor_text: "없는 앵커",
    },
    {
      loadZip: async (bytes) => {
        loadCalls += 1;
        return await JSZip.loadAsync(bytes);
      },
    },
  );

  assert.equal(resultCode(result), "ANCHOR_NOT_FOUND");
  assert.equal(loadCalls, 1);
  await assertMissing(outputPath);
});

test("hwp_create_svg_asset escapes a structured spec and renders a real PNG", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-svg-structured-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const svgPath = join(root, "도표.svg");
  const pngPath = join(root, "도표.png");
  const spec = {
    width: 320,
    height: 180,
    background: "#ffffff",
    elements: [
      { type: "rect", x: 10, y: 10, width: 300, height: 160, fill: "#dbeafe" },
      { type: "text", x: 160, y: 90, text: "매출 <증가> & 안전", fill: "#111827", fontSize: 24, textAnchor: "middle" },
    ],
  };

  const result = await handleHwpCreateSvgAsset({
    prompt_or_spec: JSON.stringify(spec),
    output_svg_path: svgPath,
    output_png_path: pngPath,
  });

  assert.equal(result.isError, false);
  assert.deepEqual(details(result).warnings, []);
  const svg = await readFile(svgPath, "utf8");
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.match(svg, /매출 &lt;증가&gt; &amp; 안전/u);
  assert.doesNotMatch(svg, /매출 <증가>/u);
  const png = await readFile(pngPath);
  assert.deepEqual(png.subarray(0, 8), PNG_MAGIC);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 180);
});

test("hwp_create_svg_asset accepts safe inline SVG and rejects active content without artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-svg-sanitize-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const safePath = join(root, "safe.svg");
  const safe = await handleHwpCreateSvgAsset({
    prompt_or_spec: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#fff"/><text x="10" y="35">안전</text></svg>',
    output_svg_path: safePath,
  });
  assert.equal(safe.isError, false);
  assert.match(await readFile(safePath, "utf8"), /<text[^>]*>안전<\/text>/u);

  const normalizedNamespacePath = join(root, "normalized-namespace.svg");
  const normalizedNamespace = await handleHwpCreateSvgAsset({
    prompt_or_spec: '<svg width="40" height="20"><rect width="40" height="20" fill="#fff"/></svg>',
    output_svg_path: normalizedNamespacePath,
  });
  assert.equal(normalizedNamespace.isError, false, JSON.stringify(normalizedNamespace));
  assert.match(
    await readFile(normalizedNamespacePath, "utf8"),
    /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u,
  );

  for (const [name, svg] of [
    ["script", '<svg width="10" height="10"><script>alert(1)</script></svg>'],
    ["event", '<svg width="10" height="10"><rect onload="alert(1)"/></svg>'],
    ["external", '<svg width="10" height="10"><image href="https://example.test/x.png"/></svg>'],
    ["namespace-alias", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"><s:script>alert(1)</s:script></svg>'],
    ["prefixed-reference", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="urn:unsafe" width="10" height="10"><image q:href="https://example.test/x.png"/></svg>'],
    ["entity-url", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="u&#x72;l(https://example.test/a.svg#x)"/></svg>'],
    ["entity-javascript", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="javas&#99;ript:alert(1)"/></svg>'],
    ["doctype", '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg width="10" height="10">&x;</svg>'],
  ] as const) {
    const output = join(root, `${name}.svg`);
    const rejected = await handleHwpCreateSvgAsset({
      prompt_or_spec: svg,
      output_svg_path: output,
    });
    assert.equal(rejected.isError, true, name);
    assert.equal(details(rejected).code, "UNSAFE_SVG", name);
    await assertMissing(output);
  }
});

test("hwp_create_svg_asset reserves both outputs atomically and preserves SVG on renderer failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-svg-output-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const input = '<svg width="32" height="24"><rect width="32" height="24" fill="#0f0"/></svg>';

  const conflictSvg = join(root, "conflict.svg");
  const conflictPng = join(root, "conflict.png");
  await writeFile(conflictPng, "keep");
  const conflict = await handleHwpCreateSvgAsset({
    prompt_or_spec: input,
    output_svg_path: conflictSvg,
    output_png_path: conflictPng,
  });
  assert.equal(resultCode(conflict), "OUTPUT_CONFLICT");
  await assertMissing(conflictSvg);
  assert.equal(await readFile(conflictPng, "utf8"), "keep");

  const fallbackSvg = join(root, "fallback.svg");
  const fallbackPng = join(root, "fallback.png");
  const fallback = await handleHwpCreateSvgAsset(
    {
      prompt_or_spec: input,
      output_svg_path: fallbackSvg,
      output_png_path: fallbackPng,
    },
    {
      renderSvgToPng: async () => {
        throw new Error("renderer unavailable");
      },
    },
  );
  assert.equal(fallback.isError, false);
  assert.equal(details(fallback).png_path, undefined);
  assert.match((details(fallback).warnings as string[])[0] ?? "", /renderer unavailable/u);
  await access(fallbackSvg);
  await assertMissing(fallbackPng);

  const samePath = join(root, "same-output.png");
  const sameOutput = await handleHwpCreateSvgAsset(
    {
      prompt_or_spec: input,
      output_svg_path: samePath,
      output_png_path: samePath,
    },
    {
      renderSvgToPng: async () => {
        throw new Error("renderer unavailable");
      },
    },
  );
  assert.equal(resultCode(sameOutput), "PATH_ALIAS");
  await assertMissing(samePath);
});

test("hwp_create_svg_asset treats an unsafe PNG output parent as a hard failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-svg-unsafe-parent-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  if (process.platform !== "win32") {
    t.skip("Windows junction behavior is the target of this regression test.");
    return;
  }
  const realDirectory = join(root, "real");
  const junction = join(root, "junction");
  await mkdir(realDirectory);
  try {
    await symlink(realDirectory, junction, "junction");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Junction creation is unavailable (EPERM).");
      return;
    }
    throw error;
  }
  const svgPath = join(root, "safe.svg");
  const pngPath = join(junction, "unsafe.png");

  const result = await handleHwpCreateSvgAsset({
    prompt_or_spec: '<svg width="16" height="16"><rect width="16" height="16" fill="#000"/></svg>',
    output_svg_path: svgPath,
    output_png_path: pngPath,
  });

  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(resultCode(result), "UNSAFE_OUTPUT_PATH");
  await assertMissing(svgPath);
  await assertMissing(pngPath);
});

test("after-paragraph inserts a normalized PNG after a body anchor and passes structural gates", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "한글 그림 삽입-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "원본 문서.hwpx");
  const imagePath = join(root, "원본 시각자료.svg");
  const outputPath = join(root, "삽입 결과.hwpx");
  const source = await withStaleLineSeg(
    await markdownToHwpx("앞 문단\n\n여기에 그림\n\n뒤 문단"),
  );
  await writeFile(sourcePath, source);
  await writeFile(
    imagePath,
    '<svg width="80" height="40" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="40" fill="#2563eb"/></svg>',
  );
  const beforeHash = sha256(source);

  const result = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: outputPath,
    anchor_text: "여기에 그림",
    mode: "after-paragraph",
    size_mm: 42,
  });

  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(details(result).mode, "after-paragraph");
  assert.match(String(details(result).image_entry), /^BinData\/image\d+\.png$/u);
  const output = await readFile(outputPath);
  assert.equal(sha256(await readFile(sourcePath)), beforeHash);
  const validation = await validateHwpx(output);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  assert.equal((details(result).validation as Record<string, unknown>).ok, true);

  const [sourceParsed, outputParsed] = await Promise.all([
    parse(exactArrayBuffer(source)),
    parse(exactArrayBuffer(output)),
  ]);
  assert.equal(sourceParsed.success, true);
  assert.equal(outputParsed.success, true);
  if (!sourceParsed.success || !outputParsed.success) return;
  assert.match(outputParsed.markdown, /앞 문단[\s\S]*여기에 그림[\s\S]*뒤 문단/u);
  assert.equal(imageCount(outputParsed), imageCount(sourceParsed) + 1);

  const zip = await JSZip.loadAsync(output);
  const section = await zip.file("Contents/section0.xml")!.async("text");
  assert.doesNotMatch(section, /<hp:linesegarray\b/u);
  const anchorEnd = section.indexOf("</hp:p>", section.indexOf("여기에 그림"));
  const nextParagraph = section.indexOf("<hp:p", anchorEnd + 1);
  assert.ok(anchorEnd >= 0 && nextParagraph > anchorEnd);
  assert.ok(section.indexOf("<hp:pic", nextParagraph) > nextParagraph);
  await assertImageTriplet(zip, section, String(details(result).image_entry));
  const render = await renderHwpxToSvg(output, { reflow: true });
  assert.ok(render.svg.length > 100);
  assert.match(render.svg, /<image\b/u);

  const verify = await runVerifier(outputPath, sourcePath);
  assert.match(verify.stdout, /RESULT: all hard checks PASSED/u);
});

test("after-paragraph inserts inside the same table-cell subList", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-table-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  const outputPath = join(root, "output.hwpx");
  await writeFile(
    sourcePath,
    Buffer.from(await markdownToHwpx("| 구분 | 내용 |\n| --- | --- |\n| 그림 | 표 안 앵커 |")),
  );
  await writeFile(imagePath, await testPng());

  const result = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: outputPath,
    anchor_text: "표 안 앵커",
    mode: "after-paragraph",
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  const zip = await JSZip.loadAsync(await readFile(outputPath));
  const section = await zip.file("Contents/section0.xml")!.async("text");
  const anchorPos = section.indexOf("표 안 앵커");
  const subListStart = section.lastIndexOf("<hp:subList", anchorPos);
  const subListEnd = section.indexOf("</hp:subList>", anchorPos);
  const picPos = section.indexOf("<hp:pic", anchorPos);
  assert.ok(subListStart >= 0 && picPos > anchorPos && picPos < subListEnd);
});

test("after-paragraph ignores a hidden-comment anchor before the eligible body anchor", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-hidden-anchor-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  const outputPath = join(root, "output.hwpx");
  const zip = await JSZip.loadAsync(await markdownToHwpx("본문 앵커"));
  let section = await zip.file("Contents/section0.xml")!.async("text");
  const bodyStart = section.indexOf("<hp:p");
  section = `${section.slice(0, bodyStart)}<hp:hiddenComment><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>본문 앵커</hp:t></hp:run></hp:p></hp:hiddenComment>${section.slice(bodyStart)}`;
  zip.file("Contents/section0.xml", section);
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(sourcePath, await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  await writeFile(imagePath, await testPng());

  const result = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: outputPath,
    anchor_text: "본문 앵커",
    mode: "after-paragraph",
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  const outputZip = await JSZip.loadAsync(await readFile(outputPath));
  const outputSection = await outputZip.file("Contents/section0.xml")!.async("text");
  const hiddenEnd = outputSection.indexOf("</hp:hiddenComment>");
  const picture = outputSection.indexOf("<hp:pic");
  assert.ok(hiddenEnd >= 0 && picture > hiddenEnd, outputSection);
});

test("after-paragraph edits the immutable source snapshot even if the source path is swapped and restored", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-source-snapshot-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  const outputPath = join(root, "output.hwpx");
  const original = Uint8Array.from(
    new Uint8Array(await markdownToHwpx("원본 표식\n\n공통 앵커")),
  );
  const replacement = Uint8Array.from(
    new Uint8Array(await markdownToHwpx("교체 표식\n\n공통 앵커")),
  );
  await writeFile(sourcePath, original);
  await writeFile(imagePath, await testPng());
  let parseCalls = 0;

  const result = await handleHwpInsertImage(
    {
      file_path: sourcePath,
      image_path: imagePath,
      output_path: outputPath,
      anchor_text: "공통 앵커",
      mode: "after-paragraph",
    },
    {
      parseDocument: async (input, options) => {
        parseCalls += 1;
        if (parseCalls === 1) {
          const parsed = await parse(input, options);
          await writeFile(sourcePath, replacement);
          return parsed;
        }
        await writeFile(sourcePath, original);
        return parse(input, options);
      },
    },
  );

  assert.equal(result.isError, false, JSON.stringify(result));
  const parsed = await parse(await readFile(outputPath));
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.match(parsed.markdown, /원본 표식/u);
    assert.doesNotMatch(parsed.markdown, /교체 표식/u);
  }
  assert.deepEqual(await readFile(sourcePath), Buffer.from(original));
});

test("seal-anchor calls the real Kordoc placement path and preserves placement metadata", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-seal-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "seal.png");
  const outputPath = join(root, "sealed.hwpx");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("결재: (인)")));
  await writeFile(imagePath, await testPng());

  const result = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: outputPath,
    anchor_text: "(인)",
    mode: "seal-anchor",
    size_mm: 12,
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(details(result).mode, "seal-anchor");
  const placement = details(result).placement as Record<string, unknown>;
  assert.equal(placement.anchor, "(인)");
  assert.equal(placement.occurrence, 0);
  assert.equal(placement.sizeMm, 12);
  const parsed = await parse(exactArrayBuffer(await readFile(outputPath)));
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(imageCount(parsed), 1);
});

test("image insertion rejects missing and ambiguous anchors before creating output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-anchor-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("같은 문단 중복, 다시 중복")));
  await writeFile(imagePath, await testPng());

  const ambiguousPath = join(root, "ambiguous.hwpx");
  const ambiguous = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: ambiguousPath,
    anchor_text: "중복",
  });
  assert.equal(resultCode(ambiguous), "AMBIGUOUS_ANCHOR");
  await assertMissing(ambiguousPath);

  const selectedPath = join(root, "selected.hwpx");
  const selected = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: selectedPath,
    anchor_text: "중복",
    anchor_occurrence: 1,
  });
  assert.equal(selected.isError, false, JSON.stringify(selected));

  const missingPath = join(root, "missing.hwpx");
  const missing = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: missingPath,
    anchor_text: "없음",
  });
  assert.equal(resultCode(missing), "ANCHOR_NOT_FOUND");
  await assertMissing(missingPath);
});

test("ambiguous anchor detection stops after the second match", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-anchor-stream-ambiguous-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  const outputPath = join(root, "output.hwpx");
  const zip = await JSZip.loadAsync(await markdownToHwpx("앵커 앵커"));
  zip.file("Contents/section999.xml", "not XML");
  const sourceBytes = await zip.generateAsync({ type: "uint8array" });
  await writeFile(sourcePath, sourceBytes);
  await writeFile(imagePath, await testPng());
  let lateSectionReads = 0;

  const result = await handleHwpInsertImage(
    {
      file_path: sourcePath,
      image_path: imagePath,
      output_path: outputPath,
      anchor_text: "앵커",
    },
    {
      validateDocument: async () => ({ ok: true, issues: [], entryCount: 1 }),
      parseDocument: async () => ({
        success: true,
        fileType: "hwpx",
        markdown: "앵커 앵커",
        blocks: [],
      }),
      loadZip: async () => {
        const loaded = await JSZip.loadAsync(sourceBytes);
        const late = loaded.file("Contents/section999.xml")!;
        late.async = (async () => {
          lateSectionReads += 1;
          throw new Error("late section must not be read");
        }) as typeof late.async;
        return loaded;
      },
    },
  );
  assert.equal(resultCode(result), "AMBIGUOUS_ANCHOR");
  assert.equal(lateSectionReads, 0);
  await assertMissing(outputPath);
});

test("requested anchor occurrence returns before scanning later sections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-anchor-stream-selected-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  const outputPath = join(root, "output.hwpx");
  const zip = await JSZip.loadAsync(await markdownToHwpx("앵커"));
  zip.file("Contents/section999.xml", "not XML");
  const sourceBytes = await zip.generateAsync({ type: "uint8array" });
  await writeFile(sourcePath, sourceBytes);
  await writeFile(imagePath, await testPng());
  let placementCalls = 0;
  let lateSectionReads = 0;

  await handleHwpInsertImage(
    {
      file_path: sourcePath,
      image_path: imagePath,
      output_path: outputPath,
      anchor_text: "앵커",
      anchor_occurrence: 0,
      mode: "seal-anchor",
    },
    {
      validateDocument: async () => ({ ok: true, issues: [], entryCount: 1 }),
      parseDocument: async () => ({
        success: true,
        fileType: "hwpx",
        markdown: "앵커",
        blocks: [],
      }),
      placeSeal: async () => {
        placementCalls += 1;
        throw new Error("stop after anchor selection");
      },
      loadZip: async () => {
        const loaded = await JSZip.loadAsync(sourceBytes);
        const late = loaded.file("Contents/section999.xml")!;
        late.async = (async () => {
          lateSectionReads += 1;
          throw new Error("late section must not be read");
        }) as typeof late.async;
        return loaded;
      },
    },
  );
  assert.equal(lateSectionReads, 0);
  assert.equal(placementCalls, 1);
  await assertMissing(outputPath);
});

test("image insertion rejects non-HWPX, bad images, existing output, and source/image aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-errors-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("앵커")));
  await writeFile(imagePath, await testPng());

  const badDocument = join(root, "not-hwpx.zip");
  await writeFile(badDocument, "not a document");
  const unsupported = await handleHwpInsertImage({
    file_path: badDocument,
    image_path: imagePath,
    output_path: join(root, "bad-doc-output.hwpx"),
    anchor_text: "앵커",
  });
  assert.equal(resultCode(unsupported), "UNSUPPORTED_IMAGE_DOCUMENT_FORMAT");

  const badImage = join(root, "bad.png");
  await writeFile(badImage, "not png");
  const invalidImage = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: badImage,
    output_path: join(root, "bad-image-output.hwpx"),
    anchor_text: "앵커",
  });
  assert.equal(resultCode(invalidImage), "INVALID_IMAGE");

  const existingPath = join(root, "existing.hwpx");
  await writeFile(existingPath, "keep");
  const existing = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: existingPath,
    anchor_text: "앵커",
  });
  assert.equal(resultCode(existing), "OUTPUT_CONFLICT");
  assert.equal(await readFile(existingPath, "utf8"), "keep");

  const imageAlias = join(root, "image-alias.hwpx");
  await link(imagePath, imageAlias);
  const alias = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: imageAlias,
    anchor_text: "앵커",
  });
  assert.equal(resultCode(alias), "PATH_ALIAS");
  assert.deepEqual((await readFile(imageAlias)).subarray(0, 8), PNG_MAGIC);

  const sourceAlias = join(root, "source-alias.hwpx");
  await link(sourcePath, sourceAlias);
  const sourceAliasResult = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: sourceAlias,
    anchor_text: "앵커",
  });
  assert.equal(resultCode(sourceAliasResult), "PATH_ALIAS");
  assert.equal(sha256(await readFile(sourceAlias)), sha256(await readFile(sourcePath)));
});

test("image insertion rejects encrypted and signed HWPX packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-protected-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const imagePath = join(root, "image.png");
  await writeFile(imagePath, await testPng());

  const encryptedPath = join(root, "encrypted.hwpx");
  const encryptedZip = await JSZip.loadAsync(await markdownToHwpx("앵커"));
  encryptedZip.file(
    "META-INF/manifest.xml",
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:encryption-data/></manifest:manifest>',
  );
  encryptedZip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(encryptedPath, await encryptedZip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  const encryptedOutput = join(root, "encrypted-output.hwpx");
  const encrypted = await handleHwpInsertImage({
    file_path: encryptedPath,
    image_path: imagePath,
    output_path: encryptedOutput,
    anchor_text: "앵커",
  });
  assert.equal(resultCode(encrypted), "ENCRYPTED");
  await assertMissing(encryptedOutput);

  const signedPath = join(root, "signed.hwpx");
  const signedZip = await JSZip.loadAsync(await markdownToHwpx("앵커"));
  signedZip.file("_xmlsignatures/sig1.xml", "<signature/>");
  signedZip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(signedPath, await signedZip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  const signedOutput = join(root, "signed-output.hwpx");
  const signed = await handleHwpInsertImage({
    file_path: signedPath,
    image_path: imagePath,
    output_path: signedOutput,
    anchor_text: "앵커",
  });
  assert.equal(resultCode(signed), "SIGNED_DOCUMENT");
  await assertMissing(signedOutput);

  const drmPath = join(root, "drm.hwpx");
  const drmZip = await JSZip.loadAsync(await markdownToHwpx("앵커"));
  drmZip.file(
    "META-INF/manifest.xml",
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:drm/></manifest:manifest>',
  );
  drmZip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(drmPath, await drmZip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  const drmOutput = join(root, "drm-output.hwpx");
  const drm = await handleHwpInsertImage({
    file_path: drmPath,
    image_path: imagePath,
    output_path: drmOutput,
    anchor_text: "앵커",
    mode: "seal-anchor",
  });
  assert.equal(resultCode(drm), "DRM_PROTECTED");
  await assertMissing(drmOutput);
});

test("image insertion rejects case-equivalent duplicate protection manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-ambiguous-manifest-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  const outputPath = join(root, "output.hwpx");
  await writeFile(imagePath, await testPng());

  const zip = await JSZip.loadAsync(await markdownToHwpx("앵커"));
  zip.file("meta-inf/MANIFEST.XML", "<manifest/>");
  zip.file("META-INF/manifest.xml", "<manifest><encryption-data/></manifest>");
  await writeFile(sourcePath, await zip.generateAsync({ type: "uint8array" }));

  const result = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: outputPath,
    anchor_text: "앵커",
  });

  assert.equal(resultCode(result), "INVALID_HWPX_PROTECTION_METADATA");
  await assertMissing(outputPath);
});

test("image insertion sanitizes SVG inputs even when XML comments precede the root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-svg-sniff-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.svg");
  const outputPath = join(root, "output.hwpx");
  await writeFile(sourcePath, Buffer.from(await markdownToHwpx("앵커")));
  await writeFile(
    imagePath,
    '<!--leading--><svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"><s:script>alert(1)</s:script><rect width="10" height="10"/></svg>',
  );

  const result = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: outputPath,
    anchor_text: "앵커",
  });
  assert.equal(resultCode(result), "UNSAFE_SVG");
  await assertMissing(outputPath);
});

test("image insertion rejects a dangling manifest href before editing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-image-manifest-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.hwpx");
  const imagePath = join(root, "image.png");
  const outputPath = join(root, "output.hwpx");
  const zip = await JSZip.loadAsync(await markdownToHwpx("앵커"));
  let manifest = await zip.file("Contents/content.hpf")!.async("text");
  manifest = manifest.replace(
    "</opf:manifest>",
    '<opf:item id="foo" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/></opf:manifest>',
  );
  zip.file("Contents/content.hpf", manifest);
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  await writeFile(sourcePath, await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  await writeFile(imagePath, await testPng());

  const result = await handleHwpInsertImage({
    file_path: sourcePath,
    image_path: imagePath,
    output_path: outputPath,
    anchor_text: "앵커",
  });
  assert.equal(resultCode(result), "SOURCE_HWPX_INVALID");
  await assertMissing(outputPath);
});

async function withStaleLineSeg(input: ArrayBuffer): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(input);
  let section = await zip.file("Contents/section0.xml")!.async("text");
  section = section.replace(
    /<\/hp:p>/gu,
    '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="0" horzpos="0" horzsize="10000" flags="0"/></hp:linesegarray></hp:p>',
  );
  zip.file("Contents/section0.xml", section);
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function testPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 16,
      channels: 4,
      background: { r: 210, g: 30, b: 40, alpha: 0.8 },
    },
  })
    .png()
    .toBuffer();
}

async function assertImageTriplet(zip: JSZip, section: string, entry: string): Promise<void> {
  const manifest = await zip.file("Contents/content.hpf")!.async("text");
  const escapedEntry = entry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const item = manifest.match(
    new RegExp(`<opf:item\\b(?=[^>]*href="${escapedEntry}")(?=[^>]*id="([^"]+)")[^>]*/?>`, "u"),
  );
  assert.ok(item, manifest);
  assert.match(section, new RegExp(`binaryItemIDRef="${item[1]}"`, "u"));
  const image = await zip.file(entry)!.async("nodebuffer");
  assert.deepEqual(image.subarray(0, 8), PNG_MAGIC);
}

async function runVerifier(edited: string, original: string): Promise<{ stdout: string; stderr: string }> {
  const script = join(HWPX_SAFE_EDIT_ROOT, "verify.py");
  const args = [
    "-X", "utf8", script, edited, "--orig", original,
    "--allow-changed", "Contents/content.hpf",
    "--allow-changed", "Contents/section0.xml",
    "--allow-added", "BinData/image1.png",
  ];
  try {
    return await execFileAsync("python", args, {
      cwd: dirname(script),
      windowsHide: true,
      encoding: "utf8",
      timeout: 20_000,
    });
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
    return execFileAsync("py", ["-3", ...args], {
      cwd: dirname(script),
      windowsHide: true,
      encoding: "utf8",
      timeout: 20_000,
    });
  }
}

function details(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

function resultCode(result: { structuredContent?: Record<string, unknown> }): unknown {
  return details(result).code;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function imageCount(result: { blocks: Array<{ type: string }> }): number {
  return result.blocks.filter((block) => block.type === "image").length;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), { code: "ENOENT" });
}
