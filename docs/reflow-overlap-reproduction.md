# Verify synthetic reflow spacing

The visual reproduction uses the Markdown generator, font normalization, and
`after-paragraph` image insertion. It contains a long Korean table cell and a
local SVG rectangle between two paragraphs.

From `packages/gpt-codex-hwp`, after installing dependencies and building:

```sh
node --import tsx --test tests/reflow-layout.test.ts
node --import tsx benchmarks/reproduce-reflow-overlap.mjs
```

The second command prints a new temporary directory containing `source.md`,
`source.hwpx`, `mixed.hwpx`, and their reflow SVG/PNG previews. An optional output
directory argument must not already exist. Keep these generated artifacts outside
the repository. Open both HWPX files in Hancom separately for a native-layout
comparison; synthetic reflow alone cannot establish native layout correctness.

The source tests generate the same table and assemble the picture geometry in
memory. They verify table padding, the paragraph after the table, and spacing
around inline and paragraph-anchored pictures.

Hancom Office 2018 opened the generated mixed fixture with the cell text,
table borders, body paragraphs, and image visually separated.

The vendoring script applies the fix to the authenticated Kordoc archive so
the preview, worker, and packaged runtime use the same synthetic geometry.
