import type JSZip from "jszip";
import type {
  ScanParagraph,
  ScanTable,
  scanSectionXml,
} from "kordoc";

import { readZipEntryBounded } from "./zip-bounded-read.js";
import { loadBoundedHwpxZip } from "./zip-preflight.js";

// Same per-part ceiling the font-integrity scan applies to section XML.
const MAX_SECTION_XML_BYTES = 128 * 1024 * 1024;

export type HwpxAnchorResolutionErrorCode =
  | "ANCHOR_NOT_FOUND"
  | "AMBIGUOUS_ANCHOR";

export class HwpxAnchorResolutionError extends Error {
  constructor(readonly code: HwpxAnchorResolutionErrorCode) {
    super(code === "AMBIGUOUS_ANCHOR"
      ? "The image anchor is ambiguous."
      : "The image anchor was not found.");
    this.name = "HwpxAnchorResolutionError";
  }
}

export type HwpxSectionScanner = (
  xml: string,
  sectionIndex: number,
) => ReturnType<typeof scanSectionXml>;

export type HwpxAnchorArchiveLoader = (
  input: ArrayBuffer | Uint8Array,
) => Promise<JSZip>;

export async function resolveHwpxAnchorOccurrence(
  source: ArrayBuffer | Uint8Array,
  anchorText: string,
  requestedOccurrence: number | undefined,
  scan: HwpxSectionScanner,
  loadArchive: HwpxAnchorArchiveLoader = async (input) =>
    loadBoundedHwpxZip(
      input instanceof ArrayBuffer ? new Uint8Array(input) : input,
    ),
): Promise<number> {
  if (anchorText.length === 0 ||
    (requestedOccurrence !== undefined &&
      (!Number.isSafeInteger(requestedOccurrence) || requestedOccurrence < 0))) {
    throw new HwpxAnchorResolutionError("ANCHOR_NOT_FOUND");
  }
  const zip = await loadArchive(source);
  const sectionNames = Object.keys(zip.files)
    // Must match hwpxlib.section_names so the occurrence chosen here selects
    // the same paragraph in the Python image helper.
    .filter((name) => /^Contents\/section\d+\.xml$/u.test(name))
    .sort((left, right) => sectionNumber(left) - sectionNumber(right));
  let matchCount = 0;
  for (const [index, name] of sectionNames.entries()) {
    const entry = zip.file(name);
    if (entry === null) continue;
    const xml = new TextDecoder("utf-8").decode(
      await readZipEntryBounded(entry, MAX_SECTION_XML_BYTES, name),
    );
    const scanned = scan(xml, index);
    for (const paragraph of eligibleParagraphs(
      scanned.bodyParagraphs,
      scanned.tables,
    )) {
      let from = 0;
      while (from <= paragraph.text.length) {
        const found = paragraph.text.indexOf(anchorText, from);
        if (found < 0) break;
        if (requestedOccurrence === matchCount) return matchCount;
        matchCount += 1;
        if (requestedOccurrence === undefined && matchCount > 1) {
          throw new HwpxAnchorResolutionError("AMBIGUOUS_ANCHOR");
        }
        from = found + Math.max(1, anchorText.length);
      }
    }
  }
  if (matchCount === 0 ||
    (requestedOccurrence !== undefined && requestedOccurrence >= matchCount)) {
    throw new HwpxAnchorResolutionError("ANCHOR_NOT_FOUND");
  }
  return 0;
}

function eligibleParagraphs(
  body: readonly ScanParagraph[],
  tables: readonly ScanTable[],
): ScanParagraph[] {
  const paragraphs = [...body];
  const walk = (nestedTables: readonly ScanTable[]): void => {
    for (const table of nestedTables) {
      for (const row of table.rows) {
        for (const cell of row) {
          paragraphs.push(...cell.paragraphs);
          walk(cell.tables);
        }
      }
    }
  };
  walk(tables);
  const byStart = new Map<number, ScanParagraph>();
  for (const paragraph of paragraphs) {
    if (paragraph.kind !== "excluded") byStart.set(paragraph.start, paragraph);
  }
  return [...byStart.values()].sort((left, right) => left.start - right.start);
}

function sectionNumber(path: string): number {
  return Number(path.match(/section(\d+)\.xml$/iu)?.[1] ?? 0);
}
