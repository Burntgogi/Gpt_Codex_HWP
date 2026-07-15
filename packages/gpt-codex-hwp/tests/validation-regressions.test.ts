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
  t.after(async () => rm(root, { recursive: true, force: true }));
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
