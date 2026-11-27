# Verify synthetic reflow spacing

The fixture uses the real Markdown generator, font normalization, and
`after-paragraph` image insertion. It contains a long Korean table cell, the
following row, and a rectangle between two paragraphs. The rectangle is a local
SVG; no external assets or credentials are required.

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

The source tests verify table padding, the paragraph after the table, and the
spacing around the inserted image. The floating-image case changes the fixture to
a paragraph-anchored picture with top-and-bottom wrapping and verifies both
neighboring paragraphs against its position and margins.

Hancom Office 2018 opened the generated mixed fixture with the cell text,
table borders, body paragraphs, and image visually separated.

The vendoring script applies the fix to the authenticated Kordoc archive so
the preview, worker, and packaged runtime use the same synthetic geometry.
