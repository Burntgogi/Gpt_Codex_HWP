import assert from "node:assert/strict";
import test from "node:test";

import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

import {
  HwpxFontReferenceError,
  inspectHwpxFontReferences,
  normalizeGeneratedFontReferences,
} from "../src/shared/hwpx-font-integrity.js";

const scripts = [
  "hangul",
  "latin",
  "hanja",
  "japanese",
  "other",
  "symbol",
  "user",
] as const;

type Script = (typeof scripts)[number];
type MalformedKind =
  | "missing fontfaces container"
  | "fontfaces itemCnt mismatch"
  | "duplicate language group"
  | "fontCnt mismatch"
  | "invalid font ID"
  | "duplicate font ID"
  | "missing ID zero"
  | "missing font face"
  | "missing language group"
  | "invalid charPr ID"
  | "duplicate charPr ID"
  | "missing fontRef"
  | "duplicate fontRef"
  | "missing fontRef attribute"
  | "invalid header namespace";

interface FixtureOptions {
  uniformRef?: string;
  refs?: Record<Script, string>;
  malformed?: MalformedKind;
  ratios?: string[];
}

test("font inspector reports every language-specific out-of-range reference", async () => {
  const input = await fontFixture({ uniformRef: "2" });
  const inspected = await inspectHwpxFontReferences(input);

  assert.deepEqual(
    inspected.issues
      .filter((issue) => issue.code === "FONT_REF_INVALID")
      .map((issue) => issue.script),
    ["hanja", "japanese", "other", "symbol", "user"],
  );
});

test("font inspector accepts language-specific valid references", async () => {
  const input = await fontFixture({
    refs: {
      hangul: "2",
      latin: "2",
      hanja: "0",
      japanese: "0",
      other: "0",
      symbol: "0",
      user: "0",
    },
  });

  assert.deepEqual((await inspectHwpxFontReferences(input)).issues, []);
});

test("font inspection uses the bounded ZIP loader seam", async () => {
  const input = await fontFixture({ uniformRef: "0" });
  let loadCalls = 0;
  const result = await inspectHwpxFontReferences(input, async (bytes) => {
    loadCalls += 1;
    return await JSZip.loadAsync(bytes);
  });
  assert.deepEqual(result.issues, []);
  assert.equal(loadCalls, 1);
});

for (const [name, code] of [
  ["missing fontfaces container", "FONTFACE_CONTAINER_MISSING"],
  ["fontfaces itemCnt mismatch", "FONTFACE_COUNT_MISMATCH"],
  ["duplicate language group", "FONTFACE_DUPLICATE"],
  ["fontCnt mismatch", "FONT_COUNT_MISMATCH"],
  ["invalid font ID", "FONT_ID_INVALID"],
  ["duplicate font ID", "FONT_ID_DUPLICATE"],
  ["missing ID zero", "FONT_ID_ZERO_MISSING"],
  ["missing font face", "FONT_FACE_NAME_MISSING"],
  ["missing language group", "FONTFACE_MISSING"],
  ["invalid charPr ID", "CHAR_PR_ID_INVALID"],
  ["duplicate charPr ID", "CHAR_PR_ID_DUPLICATE"],
  ["missing fontRef", "FONT_REF_MISSING"],
  ["duplicate fontRef", "FONT_REF_DUPLICATE"],
  ["missing fontRef attribute", "FONT_REF_ATTRIBUTE_MISSING"],
  ["invalid header namespace", "HWPX_HEADER_NAMESPACE_INVALID"],
] as const) {
  test(`font inspector reports ${name}`, async () => {
    const inspected = await inspectHwpxFontReferences(
      await malformedFontFixture(name),
    );

    assert.ok(inspected.issues.some((issue) => issue.code === code));
    assert.ok(inspected.issues.every((issue) => issue.path === "Contents/header.xml"));
  });
}

test("normalizer changes only invalid script references to zero", async () => {
  const source = await fontFixture({ uniformRef: "2" });
  const beforeTypography = await typographySnapshot(source);
  const result = await normalizeGeneratedFontReferences(source);

  assert.equal(result.changed, true);
  assert.equal(result.changed_reference_count, 5);
  assert.deepEqual(
    result.changes.map((change) => change.script),
    ["hanja", "japanese", "other", "symbol", "user"],
  );
  assert.deepEqual((await inspectHwpxFontReferences(result.bytes)).issues, []);
  assert.deepEqual(await typographySnapshot(result.bytes), beforeTypography);
  assert.deepEqual(
    await unchangedEntrySnapshot(result.bytes),
    await unchangedEntrySnapshot(source),
  );
});

test("normalizer preserves every ratio, spacing, relative-size, and offset variant", async () => {
  const source = await fontFixture({
    uniformRef: "2",
    ratios: ["95", "91", "92", "93"],
  });
  const before = await typographySnapshot(source);

  const result = await normalizeGeneratedFontReferences(source);

  assert.equal(result.changed_reference_count, 20);
  assert.deepEqual(await typographySnapshot(result.bytes), before);
});

test("normalizer returns the original bytes for an already valid HWPX", async () => {
  const source = await fontFixture({
    refs: {
      hangul: "2",
      latin: "2",
      hanja: "0",
      japanese: "0",
      other: "0",
      symbol: "0",
      user: "0",
    },
  });

  const result = await normalizeGeneratedFontReferences(source);

  assert.equal(result.changed, false);
  assert.equal(result.changed_reference_count, 0);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.bytes, source);
});

for (const [name, code] of [
  ["missing fontfaces container", "FONTFACE_CONTAINER_MISSING"],
  ["fontfaces itemCnt mismatch", "FONTFACE_COUNT_MISMATCH"],
  ["duplicate language group", "FONTFACE_DUPLICATE"],
  ["fontCnt mismatch", "FONT_COUNT_MISMATCH"],
  ["invalid font ID", "FONT_ID_INVALID"],
  ["duplicate font ID", "FONT_ID_DUPLICATE"],
  ["missing ID zero", "FONT_ID_ZERO_MISSING"],
  ["missing font face", "FONT_FACE_NAME_MISSING"],
  ["missing language group", "FONTFACE_MISSING"],
  ["invalid charPr ID", "CHAR_PR_ID_INVALID"],
  ["duplicate charPr ID", "CHAR_PR_ID_DUPLICATE"],
  ["missing fontRef", "FONT_REF_MISSING"],
  ["duplicate fontRef", "FONT_REF_DUPLICATE"],
  ["missing fontRef attribute", "FONT_REF_ATTRIBUTE_MISSING"],
  ["invalid header namespace", "HWPX_HEADER_NAMESPACE_INVALID"],
] as const) {
  test(`normalizer rejects non-repairable ${name}`, async () => {
    await assert.rejects(
      normalizeGeneratedFontReferences(await malformedFontFixture(name)),
      (error: unknown) => {
        assert.ok(error instanceof HwpxFontReferenceError);
        assert.equal(error.code, "HWPX_FONT_REFERENCE_ERROR");
        assert.ok(error.issues.some((issue) => issue.code === code));
        return true;
      },
    );
  });
}

async function malformedFontFixture(kind: MalformedKind): Promise<Uint8Array> {
  return fontFixture({
    refs: {
      hangul: "0",
      latin: "0",
      hanja: "0",
      japanese: "0",
      other: "0",
      symbol: "0",
      user: "0",
    },
    malformed: kind,
  });
}

async function fontFixture(options: FixtureOptions): Promise<Uint8Array> {
  const refs = options.refs ?? Object.fromEntries(
    scripts.map((script) => [script, options.uniformRef ?? "0"]),
  ) as Record<Script, string>;
  const groups: Array<{ lang: string; ids: string[]; count?: number }> = [
    { lang: "HANGUL", ids: ["0", "1", "2"] },
    { lang: "LATIN", ids: ["0", "1", "2"] },
    { lang: "HANJA", ids: ["0"] },
    { lang: "JAPANESE", ids: ["0"] },
    { lang: "OTHER", ids: ["0"] },
    { lang: "SYMBOL", ids: ["0"] },
    { lang: "USER", ids: ["0"] },
  ];

  if (options.malformed === "duplicate language group") {
    groups.push({ lang: "HANGUL", ids: ["0"] });
  } else if (options.malformed === "fontCnt mismatch") {
    groups[2]!.count = 2;
  } else if (options.malformed === "invalid font ID") {
    groups[2]!.ids = ["invalid"];
  } else if (options.malformed === "duplicate font ID") {
    groups[2]!.ids = ["0", "0"];
  } else if (options.malformed === "missing ID zero") {
    groups[2]!.ids = ["1"];
  } else if (options.malformed === "missing language group") {
    groups.pop();
  }

  const fontfaces = groups.map((group) => {
    const fonts = group.ids.map((id, index) =>
      `<hh:font id="${id}" face="${options.malformed === "missing font face" && group.lang === "HANJA" ? "" : `${group.lang}-${index}`}" type="TTF" isEmbedded="0"/>`,
    ).join("");
    return `<hh:fontface lang="${group.lang}" fontCnt="${group.count ?? group.ids.length}">${fonts}</hh:fontface>`;
  }).join("");
  const fontRef = scripts
    .filter((script) => !(options.malformed === "missing fontRef attribute" && script === "user"))
    .map((script) => `${script}="${refs[script]}"`)
    .join(" ");
  const ratios = options.ratios ?? (options.malformed === "duplicate charPr ID" ? ["95", "98"] : ["95"]);
  const charProperties = ratios.map((ratio, index) => `
      <hh:charPr id="${options.malformed === "invalid charPr ID" ? "invalid" : options.malformed === "duplicate charPr ID" ? "7" : String(7 + index)}" height="1500" textColor="#000000" borderFillIDRef="1"${index % 2 === 1 ? " bold=\"1\"" : ""}>
        ${options.malformed === "missing fontRef" ? "" : `<hh:fontRef ${fontRef}/>${options.malformed === "duplicate fontRef" ? `<hh:fontRef ${fontRef}/>` : ""}`}
        <hh:ratio hangul="${ratio}" latin="${ratio}" hanja="${ratio}" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>`).join("");
  const namespace = options.malformed === "invalid header namespace"
    ? "urn:not-hancom"
    : "http://www.hancom.co.kr/hwpml/2011/head";
  const fontfacesContainer = options.malformed === "missing fontfaces container"
    ? ""
    : `<hh:fontfaces itemCnt="${options.malformed === "fontfaces itemCnt mismatch" ? "99" : groups.length}">${fontfaces}</hh:fontfaces>`;
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="${namespace}">
  <hh:refList>
    ${fontfacesContainer}
    <hh:charProperties itemCnt="${ratios.length}">${charProperties}
    </hh:charProperties>
  </hh:refList>
</hh:head>`;
  const zip = new JSZip();
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  zip.file("Contents/header.xml", header);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function typographySnapshot(input: Uint8Array): Promise<unknown[]> {
  const zip = await JSZip.loadAsync(input);
  const header = await requiredEntry(zip, "Contents/header.xml");
  const document = new DOMParser().parseFromString(header, "application/xml");
  const nodes = document.getElementsByTagName("*");
  const snapshot: unknown[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index);
    if (node === null || node.localName !== "charPr") {
      continue;
    }
    const children = Array.from({ length: node.childNodes.length }, (_, childIndex) =>
      node.childNodes.item(childIndex),
    ).filter((child) => child?.nodeType === 1);
    snapshot.push({
      id: node.getAttribute("id"),
      height: node.getAttribute("height"),
      bold: node.getAttribute("bold"),
      italic: node.getAttribute("italic"),
      textColor: node.getAttribute("textColor"),
      borderFillIDRef: node.getAttribute("borderFillIDRef"),
      ratio: attributesOf(children.find((child) => child?.localName === "ratio")),
      spacing: attributesOf(children.find((child) => child?.localName === "spacing")),
      relSz: attributesOf(children.find((child) => child?.localName === "relSz")),
      offset: attributesOf(children.find((child) => child?.localName === "offset")),
    });
  }
  return snapshot;
}

async function unchangedEntrySnapshot(input: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(input);
  const snapshot: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir && name !== "Contents/header.xml") {
      snapshot[name] = Buffer.from(await entry.async("uint8array")).toString("base64");
    }
  }
  return snapshot;
}

async function requiredEntry(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  assert.ok(entry, `missing fixture entry: ${name}`);
  return entry.async("string");
}

function attributesOf(node: { attributes?: { length: number; item(index: number): { name: string; value: string } | null } } | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (node?.attributes === undefined) {
    return result;
  }
  for (let index = 0; index < node.attributes.length; index += 1) {
    const attribute = node.attributes.item(index);
    if (attribute !== null) {
      result[attribute.name] = attribute.value;
    }
  }
  return result;
}
