---
name: korean-official-doc
description: Check Korean public-sector document (공문서, 기안문, 시행문, 보고서) drafts against the statutory formatting rules for dates, times, amounts, item symbols, attachments, and the "끝" mark. Use when drafting or reviewing a Korean official document in Markdown, before generating HWPX, or when the user asks to follow 공문서 작성 규칙.
---

# Korean official document rules

This skill checks a Markdown draft against the formatting rules in 「행정업무의 운영 및 혁신에 관한 규정」 (the decree) and its 시행규칙 (the rule). It is deterministic, has no dependencies beyond Node.js 18 or newer, and never edits the draft. Use it before `hwp_generate_hwpx` or `hwp_patch_document` when Gpt_Codex_HWP is installed; it also works on its own.

## Workflow

1. Write or obtain the draft as UTF-8 Markdown in a file.
2. Run the linter from this skill directory, passing every token as a separate argument:

   ```text
   node {skill_dir}/scripts/lint-official-doc.mjs {absolute_draft.md} --json
   ```

   Use `--profile general` for reports and memos that do not end with 「끝」 or carry 붙임. The default `gongmun` profile is for 기안문 and 시행문. `--strict` exits `1` when any `warn` finding remains; usage errors exit `2`.
3. Apply each `warn` finding. Show the user every change you make; never silently rewrite quoted text, names, legal citations, or form values the user asked to keep.
4. Treat `info` findings as optional style suggestions. Mention them once; follow the user's or the institution's house style when it differs.
5. Re-run the linter until no `warn` findings remain, then generate or patch the HWPX.

Each finding has `rule`, `severity`, `line`, `column`, `text`, `message`, an optional `suggestion`, and `basis` with `source` (`statute` or `convention`) and `citation`. Quote the citation when explaining a change.

## What is checked

See [references/rules.md](references/rules.md) for the rule table and citations. In short:

- Dates use numbers with periods in place of 연·월·일: `2026. 10. 8.`
- Times use the 24-hour clock with a colon: `15:30`
- Amounts use Arabic numerals followed by the Hangul reading in parentheses: `113,560원(일십일만삼천오백육십원)`
- Item symbols descend 1. → 가. → 1) → 가) → (1) → (가) → ① → ㉮ and count up in order; □, ○, -, · are allowed as special symbols.
- 붙임 lists each attachment's name and quantity.
- The body (or the last 붙임) ends with one character of space and 「끝」; a table that ends the document is followed by 「끝」 or has 「이하 빈칸」 in the next cell.

## Limits

- The linter reads Markdown text only. Paper size, page numbers, 간인, and signatures belong to the HWPX layout; check them in the generated document or its preview.
- It does not check spelling or spacing (어문규범). Do not send document text to an online spell checker unless the user explicitly asks and accepts that the text leaves the machine.
- Rules can change. The citations were checked against the current text on 국가법령정보센터 on 2026-10-08. When a finding conflicts with a newer rule or an institution's own guide, follow that source and tell the user.
- Statutes are not protected works under 저작권법 제7조, so their requirements are summarized directly. Government handbooks are not statutes; this skill does not copy their text, and conventions it reports as `info` are written in its own words.
