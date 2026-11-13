# Reproduce issue #25

The fixture uses the real Markdown generator, font normalization, and
`after-paragraph` image insertion. It contains a long Korean table cell, the
following row, and a rectangle between two paragraphs. The rectangle is a local
SVG; no external assets or credentials are required.

From `packages/gpt-codex-hwp`, after installing dependencies and building:

```sh
node --import tsx --test benchmarks/reflow-overlap-repro.test.ts
node --import tsx benchmarks/reproduce-reflow-overlap.mjs
```

The second command prints a new temporary directory containing `source.md`,
`source.hwpx`, `mixed.hwpx`, and their reflow SVG/PNG previews. An optional output
directory argument must not already exist. Keep these generated artifacts outside
the repository. Open both HWPX files in Hancom separately for a native-layout
comparison; synthetic reflow alone cannot establish native layout correctness.

The first command is a standalone RED reproducer, outside the normal test profile.
It reports two passing control cases and two failing table-padding cases, with a last baseline of
356.70 pt, a row bottom of 356.79 pt, and requested bottom padding of 1.41 pt.
The baseline is already inside the reserved padding, before accounting for glyph
descenders. The PNG also shows the lower border crossing the last Korean line.
After correcting the renderer, move the passing regression cases into the normal
source test profile. The normal CI failure and skip rules are unchanged.

The table-only and table-plus-image documents both reproduce this defect. In the
vendored renderer, `cellContentExtent` measures line extents without cell margins;
`measureTableHeight` and `drawTable` pass that extent to `solveRowHeights`, while
`drawTable` adds top padding when drawing the text. This identifies a synthetic
row-height inconsistency independently of native Hancom behavior. This patch
does not modify the vendored renderer or claim the HWPX generator is cleared.

The current `after-paragraph` image case reserves its full height and passes the
neighboring-paragraph geometry check. The image-overlap report is not reproduced
by this fixture; other placements and a native Hancom comparison remain open.
