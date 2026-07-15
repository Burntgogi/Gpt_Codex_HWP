import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import {
  HwpxAnchorResolutionError,
  resolveHwpxAnchorOccurrence,
} from "../src/shared/hwpx-anchor.js";

test("ambiguous anchor resolution stops before reading a later section", async () => {
  const { archive, lateReads } = lazyArchive("앵커 앵커");

  await assert.rejects(
    resolveHwpxAnchorOccurrence(
      new Uint8Array([1]),
      "앵커",
      undefined,
      scanTextSection,
      async () => archive,
    ),
    (error: unknown) => {
      assert.ok(error instanceof HwpxAnchorResolutionError);
      assert.equal(error.code, "AMBIGUOUS_ANCHOR");
      return true;
    },
  );
  assert.equal(lateReads(), 0);
});

test("explicit anchor occurrence returns before reading a later section", async () => {
  const { archive, lateReads } = lazyArchive("앵커 앵커");

  assert.equal(
    await resolveHwpxAnchorOccurrence(
      new Uint8Array([1]),
      "앵커",
      1,
      scanTextSection,
      async () => archive,
    ),
    1,
  );
  assert.equal(lateReads(), 0);
});

function lazyArchive(firstSectionText: string): {
  archive: JSZip;
  lateReads(): number;
} {
  const archive = new JSZip();
  archive.file("Contents/section0.xml", firstSectionText);
  archive.file("Contents/section999.xml", "late");
  let reads = 0;
  const late = archive.file("Contents/section999.xml")!;
  late.async = (async () => {
    reads += 1;
    return "late";
  }) as typeof late.async;
  return { archive, lateReads: () => reads };
}

function scanTextSection(xml: string) {
  return {
    bodyParagraphs: [{
      kind: "body",
      text: xml,
      start: 0,
    }],
    tables: [],
  } as never;
}
