import { loadBoundedHwpxZip } from "./zip-preflight.js";
export class HwpxAnchorResolutionError extends Error {
    code;
    constructor(code) {
        super(code === "AMBIGUOUS_ANCHOR"
            ? "The image anchor is ambiguous."
            : "The image anchor was not found.");
        this.code = code;
        this.name = "HwpxAnchorResolutionError";
    }
}
export async function resolveHwpxAnchorOccurrence(source, anchorText, requestedOccurrence, scan, loadArchive = async (input) => loadBoundedHwpxZip(input instanceof ArrayBuffer ? new Uint8Array(input) : input)) {
    if (anchorText.length === 0 ||
        (requestedOccurrence !== undefined &&
            (!Number.isSafeInteger(requestedOccurrence) || requestedOccurrence < 0))) {
        throw new HwpxAnchorResolutionError("ANCHOR_NOT_FOUND");
    }
    const zip = await loadArchive(source);
    const sectionNames = Object.keys(zip.files)
        .filter((name) => /(?:^|\/)section\d+\.xml$/iu.test(name))
        .sort((left, right) => sectionNumber(left) - sectionNumber(right));
    let matchCount = 0;
    for (const [index, name] of sectionNames.entries()) {
        const entry = zip.file(name);
        if (entry === null)
            continue;
        const scanned = scan(await entry.async("text"), index);
        for (const paragraph of eligibleParagraphs(scanned.bodyParagraphs, scanned.tables)) {
            let from = 0;
            while (from <= paragraph.text.length) {
                const found = paragraph.text.indexOf(anchorText, from);
                if (found < 0)
                    break;
                if (requestedOccurrence === matchCount)
                    return matchCount;
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
function eligibleParagraphs(body, tables) {
    const paragraphs = [...body];
    const walk = (nestedTables) => {
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
    const byStart = new Map();
    for (const paragraph of paragraphs) {
        if (paragraph.kind !== "excluded")
            byStart.set(paragraph.start, paragraph);
    }
    return [...byStart.values()].sort((left, right) => left.start - right.start);
}
function sectionNumber(path) {
    return Number(path.match(/section(\d+)\.xml$/iu)?.[1] ?? 0);
}
