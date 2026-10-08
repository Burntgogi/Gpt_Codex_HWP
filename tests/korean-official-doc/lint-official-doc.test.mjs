import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  koreanAmount,
  lintOfficialDocument,
  main,
} from "../../plugins/korean-official-doc/skills/korean-official-doc/scripts/lint-official-doc.mjs";

const rulesOf = (markdown, options) =>
  lintOfficialDocument(markdown, options).findings.map((entry) => `${entry.line}:${entry.rule}`);

test("amounts are read like the statutory example", () => {
  assert.equal(koreanAmount(113_560), "일십일만삼천오백육십");
  assert.equal(koreanAmount(1_000), "일천");
  assert.equal(koreanAmount(20_500), "이만오백");
  assert.equal(koreanAmount(100_000_000), "일억");
  assert.equal(koreanAmount(0), "영");
  assert.throws(() => koreanAmount(-1), RangeError);
});

test("dates and times follow the decree format", () => {
  const report = lintOfficialDocument("회의: 2026년 10월 8일 오후 3시 30분\n기한 2026-10-31\n", {
    profile: "general",
  });
  assert.deepEqual(
    report.findings.map((entry) => [entry.rule, entry.suggestion]),
    [["date", "2026. 10. 8."], ["time", "15:30"], ["date", "2026. 10. 31."]],
  );
  assert.ok(report.findings.every((entry) => entry.basis.source === "statute"));
  assert.deepEqual(rulesOf("2026. 10. 8. 15:30\n3시간 소요, 원칙대로\n", { profile: "general" }), []);
  assert.deepEqual(rulesOf("2026.10.8.\n", { profile: "general" }), ["1:date-style"]);
});

test("amounts need a Hangul reading in parentheses", () => {
  const report = lintOfficialDocument("예산 113560원, 금1,000원(금일천원), 회원 30명\n", {
    profile: "general",
  });
  assert.deepEqual(
    report.findings.map((entry) => [entry.rule, entry.severity, entry.suggestion]),
    [
      ["amount", "warn", "113,560원(일십일만삼천오백육십원)"],
      ["amount-comma", "info", "113,560원"],
    ],
  );
  assert.deepEqual(rulesOf("금5,000원 원칙\n", { profile: "general" })[0], "1:amount");
});

test("item symbols descend in the statutory order and count up", () => {
  const ok = "1. 개요\n  가. 배경\n    1) 경과\n      가) 세부\n  나. 목적\n2. 계획\n- 참고\n□ 비고\n";
  assert.deepEqual(rulesOf(ok, { profile: "general" }), []);
  assert.deepEqual(
    rulesOf("1. 개요\n  가. 배경\n  다. 건너뜀\n    (1) 잘못된 단계\n", { profile: "general" }),
    ["3:item-sequence", "4:item-order"],
  );
  assert.deepEqual(rulesOf("가. 단독 시작\n나. 다음\n", { profile: "general" }), []);
});

test("gongmun profile checks the end mark and attachments", () => {
  assert.deepEqual(rulesOf("1. 내용입니다.\n\n붙임  계획서 1부.  끝.\n"), []);
  assert.deepEqual(rulesOf("1. 내용입니다.\n\n붙임 계획서\n"), ["3:attachment", "3:end-mark"]);
  assert.deepEqual(rulesOf("내용입니다.끝.\n"), ["1:end-mark-spacing"]);
  assert.deepEqual(rulesOf("내용입니다. 끝\n"), ["1:end-mark-style"]);
  assert.deepEqual(rulesOf("| 항목 | 값 |\n| --- | --- |\n| 가 | 이하 빈칸 |\n"), []);
  assert.deepEqual(rulesOf("| 항목 | 값 |\n| --- | --- |\n| 가 | 1 |\n"), ["3:end-mark"]);
  assert.deepEqual(rulesOf("내용입니다.\n", { profile: "general" }), []);
});

test("code, inline code, and URLs are never linted", () => {
  const markdown = "```\n2026년 1월 1일 113560원\n```\n`오후 3시` https://example.com/2026-01-01\n";
  assert.deepEqual(rulesOf(markdown, { profile: "general" }), []);
});

test("CLI prints JSON, honors --strict, and rejects bad usage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "official-doc-lint-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const draft = join(root, "draft.md");
  await writeFile(draft, "2026년 1월 2일\n", "utf8");
  const capture = () => {
    const io = { out: "", err: "" };
    io.stdout = { write: (value) => { io.out += value; } };
    io.stderr = { write: (value) => { io.err += value; } };
    return io;
  };

  const json = capture();
  assert.equal(await main([draft, "--json", "--profile=general"], json), 0);
  assert.equal(JSON.parse(json.out).summary.warn, 1);

  assert.equal(await main([draft, "--strict", "--profile", "general"], capture()), 1);
  assert.equal(await main([], capture()), 2);
  assert.equal(await main([draft, "--profile", "unknown"], capture()), 2);
  assert.equal(await main([join(root, "missing.md")], capture()), 2);
});

test("an itemized 붙임 block starts its own numbering after a numbered body", () => {
  const draft = "1. 관련: 지침\n2. 위 호와 관련하여 보고합니다.\n\n붙임  1. 계획서 1부.\n      2. 명단 1부.  끝.\n";
  assert.deepEqual(rulesOf(draft), []);
  assert.deepEqual(rulesOf("내용입니다.\n\n붙임  1. 계획서 1부.\n      3. 명단 1부.  끝.\n"), ["4:item-sequence"]);
  assert.deepEqual(rulesOf("1. 개요\n붙임과 같이 보고합니다.\n2. 계획\n", { profile: "general" }), [],
    "a sentence that starts with 붙임 does not restart the outline");
  assert.deepEqual(rulesOf("1. 개요\n2. 계획\n\n붙임\n  1. 계획서 1부.\n  2. 명단 1부.  끝.\n"), []);
});

test("a 금 that ends a compound noun is not taken as the amount prefix", () => {
  const report = lintOfficialDocument("지원금 5,000,000원을 지급하고 상금 300,000원을 준다.\n", { profile: "general" });
  assert.deepEqual(
    report.findings.filter((entry) => entry.rule === "amount").map((entry) => [entry.text, entry.suggestion]),
    [["5,000,000원", "5,000,000원(오백만원)"], ["300,000원", "300,000원(삼십만원)"]],
  );
});

test("crafted whitespace and zero runs are linted in linear time", () => {
  // Each input targets one fixed pattern: trailing whitespace, comma grouping,
  // the 끝 mark after a long whitespace run, and the 붙임 quantity check.
  for (const draft of [
    `내용입니다.\n${" ".repeat(200_000)}x\n`,
    `${"0".repeat(200_000)}1원\n`,
    `내용입니다.\n${" ".repeat(200_000)}x끝\n`,
    `붙임 ${"1".repeat(200_000)}x부\n`,
  ]) {
    const started = performance.now();
    lintOfficialDocument(draft, { profile: "gongmun" });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3_000, `took ${Math.round(elapsed)} ms`);
  }
  const report = lintOfficialDocument("예산 0001000원\n", { profile: "general" });
  assert.equal(report.findings.find((entry) => entry.rule === "amount").suggestion, "1,000원(일천원)",
    "leading zeros are dropped from the suggestion");
});

test("time-of-day words convert to the right 24-hour value and bare hours are not guessed", () => {
  const report = lintOfficialDocument("저녁 7시, 밤 9시까지, 밤 12시, 낮 2시, 새벽 5시, 3시 회의, 15시, 밤 1시, 저녁 12시\n", { profile: "general" });
  assert.deepEqual(
    report.findings.map((entry) => [entry.text, entry.suggestion]),
    [
      ["저녁 7시", "19:00"],
      ["밤 9시", "21:00"],
      ["밤 12시", "00:00"],
      ["낮 2시", "14:00"],
      ["새벽 5시", "05:00"],
      ["3시", undefined],
      ["15시", "15:00"],
      ["밤 1시", "01:00"],
      ["저녁 12시", "00:00"],
    ],
  );
});
