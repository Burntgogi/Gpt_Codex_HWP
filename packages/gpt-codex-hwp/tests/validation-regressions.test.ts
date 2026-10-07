import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import { markdownToHwpx } from "kordoc";
import JSZip from "jszip";

import { normalizeGeneratedFontReferences } from "../src/shared/hwpx-font-integrity.js";
import { handleHwpValidate } from "../src/tools/write.js";

const HEADER_NAMESPACE = "http://www.hancom.co.kr/hwpml/2011/head";

test("hwp_validate rejects every audited font-structure reproduction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hwp-font-validation-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const raw = new Uint8Array(await markdownToHwpx("# 검증\n\n본문"));
  const valid = (await normalizeGeneratedFontReferences(raw)).bytes;

  for (const [name, expectedCode, mutate] of [
    ["namespace spoof", "HWPX_HEADER_NAMESPACE_INVALID", spoofNamespace],
    ["duplicate HANGUL group", "FONTFACE_DUPLICATE", duplicateHangulGroup],
    ["fontfaces itemCnt mismatch", "FONTFACE_COUNT_MISMATCH", mismatchItemCount],
    ["missing fontRef", "FONT_REF_MISSING", removeFontRef],
  ] as const) {
    await t.test(name, async () => {
      const path = join(root, `${name.replaceAll(" ", "-")}.hwpx`);
      await writeFile(path, await mutate(valid));

      const result = await handleHwpValidate({ file_path: path });
      assert.equal(result.isError, false);
      const details = result.structuredContent as {
        ok: boolean;
        issues: Array<{ code?: string }>;
      };
      assert.equal(details.ok, false);
      assert.ok(details.issues.some((issue) => issue.code === expectedCode));
    });
  }
});

async function spoofNamespace(input: Uint8Array): Promise<Uint8Array> {
  return mutateHeader(input, (_document, xml) =>
    xml.replaceAll(HEADER_NAMESPACE, "urn:not-hancom"),
  );
}

async function duplicateHangulGroup(input: Uint8Array): Promise<Uint8Array> {
  return mutateHeader(input, (document) => {
    const fontfaces = firstElement(document, "fontfaces");
    const hangul = allElements(document, "fontface").find(
      (element) => element.getAttribute("lang") === "HANGUL",
    );
    assert.ok(hangul);
    fontfaces.appendChild(hangul.cloneNode(true));
    fontfaces.setAttribute("itemCnt", String(directElements(fontfaces, "fontface").length));
  });
}

async function mismatchItemCount(input: Uint8Array): Promise<Uint8Array> {
  return mutateHeader(input, (document) => {
    firstElement(document, "fontfaces").setAttribute("itemCnt", "99");
  });
}

async function removeFontRef(input: Uint8Array): Promise<Uint8Array> {
  return mutateHeader(input, (document) => {
    const charPr = firstElement(document, "charPr");
    const fontRef = directElements(charPr, "fontRef")[0];
    assert.ok(fontRef);
    charPr.removeChild(fontRef);
  });
}

async function mutateHeader(
  input: Uint8Array,
  mutation: (document: Document, xml: string) => void | string,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(input);
  const entry = zip.file("Contents/header.xml");
  assert.ok(entry);
  const xml = await entry.async("string");
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const replacement = mutation(document, xml);
  zip.file(
    "Contents/header.xml",
    typeof replacement === "string"
      ? replacement
      : new XMLSerializer().serializeToString(document),
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function firstElement(document: Document, localName: string): Element {
  const element = allElements(document, localName)[0];
  assert.ok(element, `missing ${localName}`);
  return element;
}

function allElements(document: Document, localName: string): Element[] {
  const nodes = document.getElementsByTagName("*");
  const result: Element[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index);
    if (node !== null && node.localName === localName) result.push(node);
  }
  return result;
}

function directElements(parent: Element, localName: string): Element[] {
  const result: Element[] = [];
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1 && child.localName === localName) result.push(child as Element);
  }
  return result;
}

test("generation keeps underscores inside identifiers instead of turning them into emphasis", async () => {
  const bs = String.fromCharCode(92);
  const { escapeIntrawordUnderscores } = await import("../src/shared/markdown-underscore.js");
  assert.equal(escapeIntrawordUnderscores("Gpt_Codex_HWP"), `Gpt${bs}_Codex${bs}_HWP`);
  assert.equal(escapeIntrawordUnderscores("a__b 한글_식별자"), `a${bs}_${bs}_b 한글${bs}_식별자`);
  for (const unchanged of [
    "_italic_ and __bold__ at word boundaries",
    "`hwp_read` in code",
    "see https://example.com/a_b_c and <https://x.test/a_b>",
    "[link](https://example.com/a_b)",
    `already${bs}_escaped`,
  ]) assert.equal(escapeIntrawordUnderscores(unchanged), unchanged);
  assert.equal(
    escapeIntrawordUnderscores("```\nsnake_case_code\n```\nsnake_case"),
    `\`\`\`\nsnake_case_code\n\`\`\`\nsnake${bs}_case`,
  );

  // Blocks Kordoc keeps verbatim are not escaped: HTML tables and closed $$ math.
  const htmlTable = "<table><tr><td colspan=\"2\">Gpt_Codex_HWP</td></tr>\n<tr><td>hwp_read</td><td>x</td></tr></table>";
  assert.equal(escapeIntrawordUnderscores(htmlTable), htmlTable);
  const singleMath = `$$${bs}text{total_cost} = a_bc$$`;
  assert.equal(escapeIntrawordUnderscores(singleMath), singleMath);
  const multiMath = `$$\n${bs}text{total_cost}\n= a_bc\n$$\nafter_math`;
  assert.equal(escapeIntrawordUnderscores(multiMath), `$$\n${bs}text{total_cost}\n= a_bc\n$$\nafter${bs}_math`);
  assert.equal(escapeIntrawordUnderscores("$$ open_math\n\nnext_line"), `$$ open${bs}_math\n\nnext${bs}_line`,
    "unclosed math is an ordinary paragraph for Kordoc");
  assert.equal(escapeIntrawordUnderscores("$$x_1$$ see snake_case"), `$$x_1$$ see snake${bs}_case`,
    "text after a closing $$ is an ordinary paragraph");
  assert.equal(escapeIntrawordUnderscores("$$\na_b\ny$$ and foo_bar"), `$$\na_b\ny$$ and foo${bs}_bar`);
  assert.equal(escapeIntrawordUnderscores("$$ a_b\n    ```\n$$"), `$$ a${bs}_b\n    \`\`\`\n$$`,
    "an indented fence ends the math scan as it does in Kordoc");
  assert.equal(escapeIntrawordUnderscores("<table>Gpt_Codex_HWP</table>"), `<table>Gpt${bs}_Codex${bs}_HWP</table>`,
    "a table without cells falls back to a paragraph in Kordoc");
  assert.equal(escapeIntrawordUnderscores("<table><tr><td>a_b</td></tr>"), `<table><tr><td>a${bs}_b</td></tr>`,
    "an unclosed table falls back to a paragraph in Kordoc");

  // Tables Kordoc cannot render fall back to an inline-Markdown paragraph.
  assert.equal(escapeIntrawordUnderscores("<table><tr><td>a_b_c</td></table>"), `<table><tr><td>a${bs}_b${bs}_c</td></table>`,
    "a row without </tr> is not a rendered table");
  assert.equal(escapeIntrawordUnderscores("<table><tr><td>a_b_c</tr></table>"), `<table><tr><td>a${bs}_b${bs}_c</tr></table>`,
    "a cell without </td> is not a rendered table");
  assert.equal(escapeIntrawordUnderscores("<table>\n$$a_b_c$$\n</table>"), `<table>\n$$a${bs}_b${bs}_c$$\n</table>`,
    "lines inside a fallback block are escaped without nested block detection");
  assert.equal(escapeIntrawordUnderscores("<table>\n`my_var\nfoo_bar`\n</table>"), "<table>\n`my_var\nfoo_bar`\n</table>",
    "a code span that crosses lines in a fallback block stays verbatim");
  assert.equal(escapeIntrawordUnderscores("``echo `get_user_name` ``"), `\`\`echo \`get${bs}_user${bs}_name\` \`\``,
    "Kordoc reads single-backtick spans, so `echo ` is code and get_user_name is plain text");
  assert.equal(escapeIntrawordUnderscores("a `` b_c"), `a \`\` b${bs}_c`,
    "an empty backtick pair is not a code span");

  const { markdownToHwpx } = await import("kordoc");
  const JSZip = (await import("jszip")).default;
  const { copyPreviewText } = await import("../src/shared/markdown-underscore.js");
  const source = [
    "# Gpt_Codex_HWP",
    "",
    "| 도구 | 값 |",
    "| --- | --- |",
    "| hwp_detect_format | x_y_z |",
    "",
    htmlTable,
    "",
    "_강조_ 유지, a__b, total_cost",
    "",
    `$$${bs}text{total${bs}_cost}$$`,
    "",
    "```",
    `my${bs}_var`,
    "```",
    "",
    // Long enough that Kordoc's 1024-character PrvText cut lands mid-text.
    Array.from({ length: 80 }, (_, index) => `item_${index}_value`).join(" "),
  ].join("\n");
  const escapedSource = escapeIntrawordUnderscores(source);
  const reference = new Uint8Array(await markdownToHwpx(source));
  const generated = await copyPreviewText(new Uint8Array(await markdownToHwpx(escapedSource)), reference);
  const referencePreview = await (await JSZip.loadAsync(reference)).file("Preview/PrvText.txt")!.async("string");
  const zip = await JSZip.loadAsync(generated);
  const xml = await zip.file("Contents/section0.xml")!.async("string");
  const text = [...xml.matchAll(/<hp:t>([^<]*)<\/hp:t>/gu)].map((match) => match[1]).join("");
  for (const identifier of ["Gpt_Codex_HWP", "hwp_detect_format", "x_y_z", "hwp_read", "a__b"]) {
    assert.ok(text.includes(identifier), identifier);
  }
  for (const escaped of ["Gpt", "hwp", "x", "a", "item", "total"].map((word) => `${word}${bs}_`)) {
    assert.ok(!text.includes(escaped), `no added escape reaches the body or HTML table cells: ${escaped}`);
  }
  assert.ok(text.includes("강조") && !text.includes("_강조_"), "boundary emphasis still parses");
  const previewText = await zip.file("Preview/PrvText.txt")!.async("string");
  assert.equal(previewText, referencePreview, "PrvText.txt equals the unescaped generation exactly");
  assert.ok(previewText.includes(`${bs}text{total${bs}_cost}`), "author-written escapes in math stay");
  assert.ok(previewText.includes("Gpt_Codex_HWP") && previewText.includes("x_y_z"), previewText);
  assert.equal((await zip.file("mimetype")!.async("string")).trim(), "application/hwp+zip");
});
