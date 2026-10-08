#!/usr/bin/env node
// Deterministic formatting lint for Korean public-sector documents (공문서)
// drafted in Markdown. Zero dependencies; Node.js 18 or newer.
//
// Statute-backed rules report severity "warn" with their citation. Common
// drafting conventions that the statutes do not spell out report "info".
// The linter never edits the input; it returns findings and suggestions.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const DECREE = "「행정업무의 운영 및 혁신에 관한 규정」";
const RULE = "같은 규정 시행규칙";

export const RULES = Object.freeze({
  date: { source: "statute", citation: `${DECREE} 제7조제5항` },
  time: { source: "statute", citation: `${DECREE} 제7조제5항` },
  amount: { source: "statute", citation: `${RULE} 제2조제2항` },
  "item-order": { source: "statute", citation: `${RULE} 제2조제1항` },
  "item-sequence": { source: "statute", citation: `${RULE} 제2조제1항` },
  "end-mark": { source: "statute", citation: `${RULE} 제4조제5항` },
  "end-mark-spacing": { source: "statute", citation: `${RULE} 제4조제5항` },
  "end-mark-style": { source: "convention", citation: "실무 관행(법령 문언은 「끝」)" },
  attachment: { source: "statute", citation: `${RULE} 제4조제4항` },
  "date-style": { source: "convention", citation: "실무 관행(법령은 글자 생략과 온점만 규정)" },
  "amount-comma": { source: "convention", citation: "실무 관행(법령 예시에만 쉼표 사용)" },
});

export const PROFILES = Object.freeze(["gongmun", "general"]);

const HANGUL_ORDER = "가나다라마바사아자차카타파하";
const CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const CIRCLED_HANGUL = "㉮㉯㉰㉱㉲㉳㉴㉵㉶㉷㉸㉹㉺㉻";

// Item levels in the statutory order: 1. → 가. → 1) → 가) → (1) → (가) → ① → ㉮
const ITEM_LEVELS = Object.freeze([
  { label: "1.", pattern: /^(\d{1,3})\.(?=\s)/u, index: (m) => Number(m[1]) },
  { label: "가.", pattern: new RegExp(`^([${HANGUL_ORDER}])\\.(?=\\s)`, "u"), index: (m) => HANGUL_ORDER.indexOf(m[1]) + 1 },
  { label: "1)", pattern: /^(\d{1,3})\)(?=\s)/u, index: (m) => Number(m[1]) },
  { label: "가)", pattern: new RegExp(`^([${HANGUL_ORDER}])\\)(?=\\s)`, "u"), index: (m) => HANGUL_ORDER.indexOf(m[1]) + 1 },
  { label: "(1)", pattern: /^\((\d{1,3})\)(?=\s)/u, index: (m) => Number(m[1]) },
  { label: "(가)", pattern: new RegExp(`^\\(([${HANGUL_ORDER}])\\)(?=\\s)`, "u"), index: (m) => HANGUL_ORDER.indexOf(m[1]) + 1 },
  { label: "①", pattern: new RegExp(`^([${CIRCLED_DIGITS}])(?=\\s)`, "u"), index: (m) => CIRCLED_DIGITS.indexOf(m[1]) + 1 },
  { label: "㉮", pattern: new RegExp(`^([${CIRCLED_HANGUL}])(?=\\s)`, "u"), index: (m) => CIRCLED_HANGUL.indexOf(m[1]) + 1 },
]);

const DIGITS = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const SMALL_UNITS = ["", "십", "백", "천"];
const LARGE_UNITS = ["", "만", "억", "조", "경"];

/** Reads a non-negative integer the way the statutory example does (일십일만…). */
export function koreanAmount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("amount out of range");
  if (value === 0) return "영";
  let result = "";
  let group = 0;
  let remaining = value;
  while (remaining > 0) {
    const chunk = remaining % 10_000;
    if (chunk > 0) {
      let text = "";
      let digits = chunk;
      for (let position = 0; digits > 0; position += 1) {
        const digit = digits % 10;
        if (digit > 0) text = `${DIGITS[digit]}${SMALL_UNITS[position]}${text}`;
        digits = Math.floor(digits / 10);
      }
      result = `${text}${LARGE_UNITS[group]}${result}`;
    }
    remaining = Math.floor(remaining / 10_000);
    group += 1;
  }
  return result;
}

function withCommas(digits) {
  // Callers pass a safe integer, so this string has at most 16 digits; a long
  // run of leading zeros would otherwise make the lookahead quadratic.
  return String(Number(digits)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/** Masks fenced code, inline code, and URLs so they are never linted. */
function lintableLines(markdown) {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let fence;
  return lines.map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence !== undefined) {
      if (fenceMatch !== null && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      return "";
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1];
      return "";
    }
    return line
      .replace(/`[^`]*`/gu, (span) => " ".repeat(span.length))
      .replace(/\bhttps?:\/\/\S+/gu, (url) => " ".repeat(url.length));
  });
}

function stripListPrefix(line) {
  const heading = /^(\s{0,3}#{1,6}\s+)/u.exec(line);
  const quote = heading === null ? /^(\s*>\s?)/u.exec(line) : null;
  const prefix = heading?.[1] ?? quote?.[1] ?? "";
  const rest = line.slice(prefix.length);
  const indent = /^\s*/u.exec(rest)[0];
  return { offset: prefix.length + indent.length, text: rest.slice(indent.length) };
}

function finding(rule, severity, lineIndex, column, text, message, suggestion) {
  return {
    rule,
    severity,
    line: lineIndex + 1,
    column: column + 1,
    text,
    message,
    ...(suggestion === undefined ? {} : { suggestion }),
    basis: RULES[rule],
  };
}

function lintDates(lines, findings) {
  const patterns = [
    /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu,
    /(?<![\d.])(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?![\d/-])/gu,
  ];
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const [year, month, day] = match.slice(1, 4).map(Number);
        if (month < 1 || month > 12 || day < 1 || day > 31) continue;
        findings.push(finding(
          "date",
          "warn",
          index,
          match.index,
          match[0],
          "날짜는 숫자로 쓰고 연·월·일 글자 대신 온점을 찍습니다.",
          `${year}. ${month}. ${day}.`,
        ));
      }
    }
    for (const match of line.matchAll(/(?<![\d.])(\d{4})\.(\d{1,2})\.(\d{1,2})\.?(?![\d.])/gu)) {
      const [year, month, day] = match.slice(1, 4).map(Number);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      findings.push(finding(
        "date-style",
        "info",
        index,
        match.index,
        match[0],
        "온점 뒤를 한 칸 띄우고 일 뒤에도 온점을 찍는 표기가 흔히 쓰입니다.",
        `${year}. ${month}. ${day}.`,
      ));
    }
  });
}

function lintTimes(lines, findings) {
  const pattern = /(?:(오전|오후|새벽|아침|낮|저녁|밤)\s*)?(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?(?=$|[\s,.)~]|부터|까지|에)/gu;
  lines.forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      const marker = match[1];
      let hour = Number(match[2]);
      const minute = match[3] === undefined ? 0 : Number(match[3]);
      if (hour > 24 || minute > 59) continue;
      if (marker === "오후") {
        if (hour < 12) hour += 12;
      } else if (marker === "저녁") {
        if (hour < 12) hour += 12;
        else if (hour === 12) hour = 0; // 저녁 12시 is midnight, not noon.
      } else if (marker === "밤") {
        // 밤 1시 to 5시 are after midnight; 밤 6시 to 11시 are evening.
        if (hour === 12) hour = 0;
        else if (hour >= 6 && hour < 12) hour += 12;
      } else if (marker === "낮") {
        if (hour < 12 && hour <= 6) hour += 12;
      } else if (marker === "오전" || marker === "새벽" || marker === "아침") {
        if (hour === 12) hour = 0;
      }
      // Without a time-of-day word, 1 to 12 o'clock is ambiguous, so the
      // finding states the rule without guessing a 24-hour value.
      const ambiguous = marker === undefined && hour >= 1 && hour <= 12;
      findings.push(finding(
        "time",
        "warn",
        index,
        match.index,
        match[0],
        ambiguous
          ? "시각은 24시각제 숫자로 쓰고 시·분 글자 대신 쌍점으로 구분합니다. 오전·오후를 확인해 00:00 형식으로 고치십시오."
          : "시각은 24시각제 숫자로 쓰고 시·분 글자 대신 쌍점으로 구분합니다.",
        ambiguous
          ? undefined
          : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      ));
    }
  });
}

function lintAmounts(lines, findings) {
  // "원" followed by these syllables starts another word (원칙, 원장, …).
  // A leading 금 counts only as its own word, not as the end of 지원금 or 상금.
  const pattern = /((?<!\p{L})금\s?)?(?<![\d,.])(\d{1,3}(?:,\d{3})+|\d+)(\s?)원(?![칙장인문본리래활고격형단])(?!\s?\(\s?금?\s?[일이삼사오육칠팔구십백천만억조영]+\s?원\s?\))/gu;
  lines.forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      const digits = match[2].replaceAll(",", "");
      const value = Number(digits);
      if (!Number.isSafeInteger(value)) continue;
      const prefix = match[1] === undefined ? "" : "금";
      const formatted = withCommas(digits);
      findings.push(finding(
        "amount",
        "warn",
        index,
        match.index,
        match[0],
        "금액은 아라비아 숫자로 쓰고 바로 뒤 괄호 안에 한글로 적습니다.",
        `${prefix}${formatted}원(${prefix}${koreanAmount(value)}원)`,
      ));
      if (digits.length > 4 && !match[2].includes(",")) {
        findings.push(finding(
          "amount-comma",
          "info",
          index,
          match.index,
          match[0],
          "세 자리마다 쉼표를 넣으면 읽기 쉽습니다.",
          `${prefix}${formatted}원`,
        ));
      }
    }
  });
}

function lintItems(lines, findings) {
  // stack[i] = { level, last } for each currently open item level.
  let stack = [];
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    const stripped = stripListPrefix(line);
    let { offset, text } = stripped;
    // 붙임 starts its own outline: "붙임  1. 계획서 1부." then "2. 명단 1부."
    // Only a bare 붙임 header or one followed by an item marker counts, not a
    // sentence such as "붙임과 같이 보고합니다".
    const attachment = /^붙\s?임(?:\s*$|\s+(?=(?:\d{1,3}|[가-하])[.)]\s))/u.exec(text);
    if (attachment !== null) {
      stack = [];
      offset += attachment[0].length;
      text = text.slice(attachment[0].length);
    }
    if (/^[□■○●◦◎\-·•*+]\s/u.test(text)) return; // permitted special symbols
    let level = -1;
    let match;
    for (const [candidate, definition] of ITEM_LEVELS.entries()) {
      match = definition.pattern.exec(text);
      if (match !== null) { level = candidate; break; }
    }
    if (level < 0) return;
    const value = ITEM_LEVELS[level].index(match);
    const position = stack.findIndex((entry) => entry.level === level);
    if (position >= 0) {
      const expected = stack[position].last + 1;
      if (value !== expected) {
        findings.push(finding(
          "item-sequence",
          "warn",
          index,
          offset,
          match[0],
          `항목 번호가 순서대로가 아닙니다. 이 자리에는 ${ITEM_LEVELS[level].label} 단계의 ${expected}번째 기호가 와야 합니다.`,
        ));
      }
      stack = stack.slice(0, position + 1);
      stack[position] = { level, last: value };
      return;
    }
    // A shallower level that is not open starts a new outline from that level.
    if (stack.length > 0 && level < stack.at(-1).level) {
      stack = stack.filter((entry) => entry.level < level);
    }
    const parent = stack.at(-1);
    const expectedLevel = parent === undefined ? 0 : parent.level + 1;
    if (level !== expectedLevel && !(parent === undefined && level > 0 && value === 1)) {
      findings.push(finding(
        "item-order",
        "warn",
        index,
        offset,
        match[0],
        `항목 기호는 1. → 가. → 1) → 가) → (1) → (가) → ① → ㉮ 순서로 내려갑니다. 이 위치에는 ${ITEM_LEVELS[Math.min(expectedLevel, ITEM_LEVELS.length - 1)].label} 단계가 와야 합니다.`,
      ));
    }
    if (value !== 1) {
      findings.push(finding(
        "item-sequence",
        "warn",
        index,
        offset,
        match[0],
        "새 단계의 항목은 첫 번째 기호(1 또는 가)부터 시작합니다.",
      ));
    }
    stack.push({ level, last: value });
  });
}

function lastContentLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim().length > 0) return index;
  }
  return -1;
}

function lintEndMark(lines, findings) {
  const index = lastContentLine(lines);
  if (index < 0) return;
  // trimEnd is linear; /\s+$/ rescans every whitespace run that is not final.
  const line = lines[index].trimEnd();
  if (/^\s*\|.*\|$/u.test(line)) {
    if (!/(?:이하\s?빈칸|끝)/u.test(line)) {
      findings.push(finding(
        "end-mark",
        "warn",
        index,
        0,
        line.trim(),
        "표로 끝나는 문서는 표 아래에 한 글자 띄우고 「끝」을 쓰거나, 표가 다 채워지지 않았으면 다음 칸에 「이하 빈칸」을 씁니다.",
      ));
    }
    return;
  }
  const end = finalEndMark(line);
  if (end === null) {
    findings.push(finding(
      "end-mark",
      "warn",
      index,
      line.length,
      line.trim(),
      "본문(붙임이 있으면 붙임)의 마지막 글자에서 한 글자 띄우고 「끝」을 표시합니다.",
      `${line.trim()}  끝.`,
    ));
    return;
  }
  if (end[1].length === 0 && end.index > 0) {
    findings.push(finding(
      "end-mark-spacing",
      "warn",
      index,
      end.index,
      line.trim(),
      "마지막 글자와 「끝」 사이를 한 글자 띄웁니다.",
    ));
  }
  if (end[2].length === 0 || (end[1].length > 0 && end[1].length !== 2)) {
    findings.push(finding(
      "end-mark-style",
      "info",
      index,
      end.index,
      line.trim(),
      "실무에서는 공백 두 칸 뒤 「끝.」처럼 온점을 붙여 쓰는 경우가 많습니다.",
    ));
  }
}

/**
 * Same result as /(\s*)끝(\.?)$/u.exec(line) without its quadratic rescans of a
 * long whitespace run: [whitespace before 끝, "." or ""] with `index` set.
 */
function finalEndMark(line) {
  const dot = line.endsWith("끝.") ? "." : "";
  if (dot === "" && !line.endsWith("끝")) return null;
  const mark = line.length - 1 - dot.length;
  let start = mark;
  while (start > 0 && /\s/u.test(line[start - 1])) start -= 1;
  const result = [line.slice(start), line.slice(start, mark), dot];
  result.index = start;
  return result;
}

function lintAttachments(lines, findings) {
  lines.forEach((line, index) => {
    const { offset, text } = stripListPrefix(line);
    if (!/^붙\s?임(?=\s|$)/u.test(text)) return;
    const body = text.replace(/^붙\s?임\s*/u, "");
    if (body.length === 0) return; // items follow on the next lines
    // (?<!\d) starts each try at the beginning of a digit run, keeping it linear.
    if (!/(?<!\d)\d+\s*(?:부|매|권|건|장|개|종|점)/u.test(body)) {
      findings.push(finding(
        "attachment",
        "warn",
        index,
        offset,
        text.trim(),
        "붙임에는 첨부물의 명칭과 수량을 적습니다.",
        `${text.trim()} 1부.`,
      ));
    }
  });
}

export function lintOfficialDocument(markdown, options = {}) {
  if (typeof markdown !== "string") throw new TypeError("markdown must be a string");
  const profile = options.profile ?? "gongmun";
  if (!PROFILES.includes(profile)) throw new RangeError(`unknown profile: ${profile}`);
  const lines = lintableLines(markdown);
  const findings = [];
  lintDates(lines, findings);
  lintTimes(lines, findings);
  lintAmounts(lines, findings);
  lintItems(lines, findings);
  if (profile === "gongmun") {
    lintAttachments(lines, findings);
    lintEndMark(lines, findings);
  }
  findings.sort((left, right) => left.line - right.line || left.column - right.column);
  return {
    profile,
    summary: {
      warn: findings.filter((entry) => entry.severity === "warn").length,
      info: findings.filter((entry) => entry.severity === "info").length,
    },
    findings,
  };
}

function formatText(report, file) {
  const lines = [`${file}: warn ${report.summary.warn}, info ${report.summary.info} (profile ${report.profile})`];
  for (const entry of report.findings) {
    lines.push(
      `${entry.line}:${entry.column} ${entry.severity} ${entry.rule} ${entry.message}`
      + (entry.suggestion === undefined ? "" : ` → ${entry.suggestion}`)
      + ` [${entry.basis.citation}]`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const USAGE = "Usage: node lint-official-doc.mjs <draft.md> [--profile gongmun|general] [--json] [--strict]\n";

export async function main(argv = process.argv.slice(2), io = process) {
  const files = [];
  let profile = "gongmun";
  let json = false;
  let strict = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--strict") strict = true;
    else if (argument === "--profile") profile = argv[++index];
    else if (argument.startsWith("--profile=")) profile = argument.slice("--profile=".length);
    else if (argument.startsWith("-")) { io.stderr.write(USAGE); return 2; }
    else files.push(argument);
  }
  if (files.length !== 1 || !PROFILES.includes(profile)) {
    io.stderr.write(USAGE);
    return 2;
  }
  let markdown;
  try {
    markdown = await readFile(resolve(files[0]), "utf8");
  } catch {
    io.stderr.write("Cannot read the Markdown draft.\n");
    return 2;
  }
  const report = lintOfficialDocument(markdown, { profile });
  io.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report, files[0]));
  return strict && report.summary.warn > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await main();
}
