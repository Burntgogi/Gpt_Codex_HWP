# Rule table

Sources (checked on 국가법령정보센터, https://www.law.go.kr, 2026-10-08):

- 「행정업무의 운영 및 혁신에 관한 규정」 (대통령령), current text in force from 2026-10-02. Article 7 was last amended on 2023-06-27 (title only).
- 「행정업무의 운영 및 혁신에 관한 규정 시행규칙」 (행정안전부령 제408호), amended 2023-06-28.

Summaries below are written in this project's own words.

| Linter rule | Severity | Requirement | Basis |
| --- | --- | --- | --- |
| `date` | warn | Write dates in numbers; omit 연·월·일 and put a period in their place. A special reason may justify another form. | 규정 제7조제5항 |
| `time` | warn | Write times on the 24-hour clock; omit 시·분 and separate them with a colon. Same exception as dates. 오전·새벽·아침, 오후·낮·저녁, and 밤 (1 to 5 o'clock after midnight, 6 to 11 in the evening) are converted; a bare 1 to 12 o'clock gets no suggestion because it is ambiguous. | 규정 제7조제5항 |
| `amount` | warn | Write an amount in Arabic numerals and repeat it in Hangul inside parentheses right after the number. | 시행규칙 제2조제2항 |
| `item-order` | warn | Mark items in the order 1. → 가. → 1) → 가) → (1) → (가) → ① → ㉮; special symbols such as □, ○, -, · may be used when needed. | 시행규칙 제2조제1항 |
| `item-sequence` | warn | Within one level, numbers ascend and Hangul follows 가나다 order. | 시행규칙 제2조제1항 |
| `attachment` | warn | When something is attached, write 「붙임」 on the line after the body and give each attachment's name and quantity; several attachments are itemized, and that numbering starts again at 1. | 시행규칙 제4조제4항 |
| `end-mark` | warn | Leave one character of space after the last character of the body (or of the 붙임) and write 「끝」. A table that ends the document gets 「끝」 below it, or 「이하 빈칸」 in the next cell when the table is not filled. | 시행규칙 제4조제5항 |
| `end-mark-spacing` | warn | The space before 「끝」 is required. | 시행규칙 제4조제5항 |
| `date-style` | info | `2026. 10. 8.` with a space after each period and a final period is the common form; the decree itself only requires the period. | convention |
| `amount-comma` | info | Thousands separators are common; the rule's example uses them but the text does not require them. | convention |
| `end-mark-style` | info | Two spaces before 「끝.」 with a period is common practice; the rule's text writes 「끝」 without a period. | convention |

Related requirements outside the linter's scope:

- Documents are written in Hangul following the 어문규범 of 「국어기본법」 제3조제3호, horizontally, with Hanja or foreign words in parentheses when needed (규정 제7조제1항). Numbers are Arabic numerals unless there is a special reason (규정 제7조제4항).
- Paper is 210 mm × 297 mm unless there is a special reason (규정 제7조제6항).
- Page numbers, issue numbers, or 간인 are required for multi-page documents whose order matters and for certificates and permits; electronic documents show the page number at the bottom center (규정 제19조, 시행규칙 제18조).
- Reviewers may omit 「끝」 when drafting through a document management card (시행규칙 제21조제2항). Classified documents add their grade after 「끝」 or 「이하 빈칸」; confirm the exact article before relying on it.
