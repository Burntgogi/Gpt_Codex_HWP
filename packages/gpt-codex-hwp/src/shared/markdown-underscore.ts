import JSZip from "jszip";

// Kordoc's Markdown-to-HWPX converter treats an underscore inside a word as
// emphasis, so "Gpt_Codex_HWP" became "Gpt" + italic "Codex" + "HWP" with the
// underscores lost. CommonMark never opens or closes "_" emphasis inside a
// word, so escaping only those underscores keeps the intended text while
// "_word_" emphasis at word boundaries still works.
//
// Text that Kordoc keeps verbatim is left untouched, mirroring Kordoc's block
// detection: fenced code, the math part of closed "$$" display math, and HTML
// tables that Kordoc renders as tables. Text after a closing "$$" and HTML
// that Kordoc falls back to rendering as a paragraph are escaped as usual.
//
// This applies to generation only. hwp_patch_document inserts edited text
// literally, where an escape would leave a visible backslash.

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
// Kordoc stops a multi-line "$$" block at any indented fence, not only at a
// fence indented by up to three spaces.
const MATH_FENCE_STOP = /^\s*(`{3,}|~{3,})/u;
const MATH_OPEN = /^\s*\$\$/u;
const HTML_TABLE_OPEN = /^<table[\s>]/iu;
const INTRAWORD_UNDERSCORES = /(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu;
const PREVIEW_TEXT_PATH = "Preview/PrvText.txt";
const WHITESPACE = /\s/u;

export function escapeIntrawordUnderscores(markdown: string): string {
  const lines = markdown.split("\n");
  let index = 0;
  while (index < lines.length) {
    const block = protectedBlock(lines, index);
    if (block === undefined) {
      lines[index] = escapeLine(lines[index]!);
      index += 1;
      continue;
    }
    if (block.escapeAll === true) {
      // Kordoc joins the whole block into one paragraph, so code spans may
      // cross lines; escape it as one string and split it back.
      const escaped = escapeLine(lines.slice(index, block.end).join("\n")).split("\n");
      lines.splice(index, block.end - index, ...escaped);
      index = block.end;
      continue;
    }
    // Text after a closing "$$" on the same line is an ordinary paragraph.
    if (block.trailingFrom !== undefined) {
      const closing = lines[block.end - 1]!;
      lines[block.end - 1] = closing.slice(0, block.trailingFrom)
        + escapeLine(closing.slice(block.trailingFrom));
    }
    index = block.end;
  }
  return lines.join("\n");
}

interface ProtectedBlock {
  /** Index after the last line of the block. */
  readonly end: number;
  /** Offset in the last line where text outside the block starts. */
  readonly trailingFrom?: number;
  /** Kordoc consumes the lines as one inline-Markdown paragraph. */
  readonly escapeAll?: boolean;
}

/**
 * Mirrors Kordoc's parseHtmlTable + generateHtmlTableXml table-or-fallback
 * decision. Kordoc finds tags with
 * /<(\/?)(table|tr|td|th)((?:"[^"]*"|'[^']*'|[^>"'])*?)>/gi; this yields the
 * same matches in linear time, so a crafted unclosed table cannot make the
 * scan quadratic.
 */
export function htmlTableRenders(raw: string): boolean {
  let depth = 0;
  let rowOpen = false;
  let rowCells = 0;
  let cellOpen = false;
  let renderedCell = false;
  for (const match of htmlTableTags(raw)) {
    const isClose = match.isClose;
    const tag = match.tag;
    if (tag === "table") {
      depth += isClose ? -1 : 1;
      if (depth < 0) return false;
      continue;
    }
    if (depth !== 1) continue;
    if (tag === "tr") {
      if (!isClose) {
        rowOpen = true;
        rowCells = 0;
      } else if (rowOpen) {
        if (rowCells > 0) renderedCell = true;
        rowOpen = false;
      }
    } else if (!isClose) {
      cellOpen = true;
    } else if (cellOpen && rowOpen) {
      rowCells += 1;
      cellOpen = false;
    }
  }
  return depth === 0 && renderedCell;
}

export interface HtmlTableTag {
  readonly start: number;
  readonly end: number;
  readonly isClose: boolean;
  readonly tag: "table" | "tr" | "td" | "th";
}

export function* htmlTableTags(raw: string): Generator<HtmlTableTag> {
  const length = raw.length;
  // tagEnd[p]: index of the ">" that ends attributes scanned from p, skipping
  // quoted strings, or -1 when an unclosed quote or the end comes first.
  const nextDouble = new Int32Array(length + 1).fill(-1);
  const nextSingle = new Int32Array(length + 1).fill(-1);
  const tagEnd = new Int32Array(length + 1).fill(-1);
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = raw[index];
    nextDouble[index] = char === "\"" ? index : nextDouble[index + 1]!;
    nextSingle[index] = char === "'" ? index : nextSingle[index + 1]!;
    if (char === ">") {
      tagEnd[index] = index;
    } else if (char === "\"" || char === "'") {
      const close = (char === "\"" ? nextDouble : nextSingle)[index + 1]!;
      tagEnd[index] = close < 0 ? -1 : tagEnd[close + 1]!;
    } else {
      tagEnd[index] = tagEnd[index + 1]!;
    }
  }
  let position = 0;
  while (position < length) {
    const open = raw.indexOf("<", position);
    if (open < 0) return;
    let cursor = open + 1;
    const isClose = raw[cursor] === "/";
    if (isClose) cursor += 1;
    const tag = (["table", "tr", "td", "th"] as const)
      .find((name) => raw.slice(cursor, cursor + name.length).toLowerCase() === name);
    const end = tag === undefined ? -1 : tagEnd[cursor + tag.length]!;
    if (tag === undefined || end < 0) {
      position = open + 1;
      continue;
    }
    yield { start: open, end: end + 1, isClose, tag };
    position = end + 1;
  }
}

function protectedBlock(lines: readonly string[], start: number): ProtectedBlock | undefined {
  const line = lines[start]!;
  const mathOpen = MATH_OPEN.exec(line);
  if (mathOpen !== null) {
    const openLength = mathOpen[0].length;
    const sameLine = findMathDelimiter(line.slice(openLength));
    if (sameLine >= 0) return { end: start + 1, trailingFrom: openLength + sameLine + 2 };
    // Multi-line display math counts only when it closes before a blank line
    // or a fence; otherwise Kordoc reads the lines as an ordinary paragraph.
    for (let index = start + 1; index < lines.length; index += 1) {
      const next = lines[index]!;
      if (next.trim().length === 0 || MATH_FENCE_STOP.test(next)) return undefined;
      const close = findMathDelimiter(next);
      if (close >= 0) return { end: index + 1, trailingFrom: close + 2 };
    }
    return undefined;
  }
  const fence = FENCE.exec(line)?.[1];
  if (fence !== undefined) {
    let index = start + 1;
    while (index < lines.length) {
      const marker = FENCE.exec(lines[index]!)?.[1];
      index += 1;
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) break;
    }
    return { end: index };
  }
  if (HTML_TABLE_OPEN.test(line.trimStart())) {
    let depth = 0;
    let index = start;
    const blockLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      blockLines.push(current);
      depth += (current.match(/<table[\s>]/giu) ?? []).length;
      depth -= (current.match(/<\/table>/giu) ?? []).length;
      index += 1;
      if (depth <= 0) break;
    }
    // Kordoc renders the block as a table only when parseHtmlTable finds a
    // closed row with a closed cell; otherwise the whole block becomes one
    // paragraph that runs inline Markdown, so every line of it is escaped.
    return htmlTableRenders(blockLines.join("\n"))
      ? { end: index }
      : { end: index, escapeAll: true };
  }
  return undefined;
}

function findMathDelimiter(text: string): number {
  let index = text.indexOf("$$");
  while (index > 0) {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 0) break;
    index = text.indexOf("$$", index + 1);
  }
  return index;
}

function escapeLine(line: string): string {
  if (!line.includes("_")) return line;
  let result = "";
  let last = 0;
  for (const [start, end] of protectedInlineRanges(line)) {
    result += escapeText(line.slice(last, start));
    result += line.slice(start, end);
    last = end;
  }
  return result + escapeText(line.slice(last));
}

/**
 * Inline code spans (Kordoc only knows single-backtick spans), autolinks, link
 * destinations, and bare URLs keep their underscores verbatim. The ranges are
 * exactly the matches of
 * /`[^`]+`|<[a-z][a-z0-9+.-]*:[^>\s]*>|\]\([^)\s]*\)|\bhttps?:\/\/\S+/giu,
 * found in linear time: that regex rescans to the end of the line from every
 * failed "](" or "<x:", which a crafted line turns into quadratic work.
 */
export function protectedInlineRanges(line: string): Array<readonly [number, number]> {
  const length = line.length;
  // First ")" or whitespace, ">" or whitespace, and whitespace at or after i.
  const parenStop = new Int32Array(length + 1).fill(length);
  const angleStop = new Int32Array(length + 1).fill(length);
  const spaceStop = new Int32Array(length + 1).fill(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = line[index]!;
    const space = WHITESPACE.test(char);
    spaceStop[index] = space ? index : spaceStop[index + 1]!;
    parenStop[index] = space || char === ")" ? index : parenStop[index + 1]!;
    angleStop[index] = space || char === ">" ? index : angleStop[index + 1]!;
  }
  const ranges: Array<readonly [number, number]> = [];
  let backticksExhausted = false;
  let index = 0;
  while (index < length) {
    const char = line[index]!;
    let end = -1;
    if (char === "`" && !backticksExhausted) {
      const close = line.indexOf("`", index + 1);
      if (close < 0) backticksExhausted = true;
      else if (close > index + 1) end = close + 1;
    } else if (char === "<" && isSchemeStart(line[index + 1])) {
      let cursor = index + 2;
      while (cursor < length && isSchemeChar(line[cursor]!)) cursor += 1;
      if (line[cursor] === ":") {
        const stop = angleStop[cursor + 1]!;
        if (line[stop] === ">") end = stop + 1;
      }
    } else if (char === "]" && line[index + 1] === "(") {
      const stop = parenStop[index + 2]!;
      if (line[stop] === ")") end = stop + 1;
    } else if (foldsTo(char, "h") && !isWordChar(line[index - 1])) {
      const scheme = matchHttpScheme(line, index);
      if (scheme > 0 && scheme < length && spaceStop[scheme]! > scheme) end = spaceStop[scheme]!;
    }
    if (end > index) {
      ranges.push([index, end]);
      index = end;
    } else {
      index += 1;
    }
  }
  return ranges;
}

// Case-insensitive Unicode matching (the "iu" flags) also folds U+017F (long
// s) to "s" and U+212A (Kelvin sign) to "k".
function foldsTo(char: string | undefined, lower: string): boolean {
  if (char === undefined) return false;
  if (char.toLowerCase() === lower && char.length === 1) return true;
  return (lower === "s" && char === "ſ") || (lower === "k" && char === "K");
}

function isSchemeStart(char: string | undefined): boolean {
  return char !== undefined && (/^[a-z]$/iu.test(char) || char === "ſ" || char === "K");
}

function isSchemeChar(char: string): boolean {
  return isSchemeStart(char) || /^[0-9+.-]$/u.test(char);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && (/^\w$/u.test(char) || char === "ſ" || char === "K");
}

/** Index after "http://" or "https://" (case-insensitive) at `start`, or -1. */
function matchHttpScheme(line: string, start: number): number {
  let cursor = start;
  for (const expected of "http") {
    if (!foldsTo(line[cursor], expected)) return -1;
    cursor += 1;
  }
  if (foldsTo(line[cursor], "s")) cursor += 1;
  return line.startsWith("://", cursor) ? cursor + 3 : -1;
}

function escapeText(text: string): string {
  return text.replace(INTRAWORD_UNDERSCORES, (run) => "\\_".repeat(run.length));
}

/**
 * Kordoc copies raw block text into Preview/PrvText.txt, so the escapes would
 * show there. Escaping never changes block segmentation, so the preview text
 * Kordoc builds from the original Markdown is exactly the right one: copy it
 * from `reference` (generated from the unescaped Markdown) into `target`.
 */
export async function copyPreviewText(target: Uint8Array, reference: Uint8Array): Promise<Uint8Array> {
  const [targetZip, referenceZip] = await Promise.all([
    JSZip.loadAsync(target),
    JSZip.loadAsync(reference),
  ]);
  const preview = referenceZip.file(PREVIEW_TEXT_PATH);
  if (preview === null || targetZip.file(PREVIEW_TEXT_PATH) === null) return target;
  const text = await preview.async("uint8array");
  const current = await targetZip.file(PREVIEW_TEXT_PATH)!.async("uint8array");
  if (Buffer.from(text).equals(Buffer.from(current))) return target;
  targetZip.file(PREVIEW_TEXT_PATH, text);
  const mimetype = targetZip.file("mimetype");
  if (mimetype !== null) {
    targetZip.file("mimetype", await mimetype.async("string"), { compression: "STORE" });
  }
  return targetZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
