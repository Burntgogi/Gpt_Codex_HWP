---
name: gpt-codex-hwp
description: Read, create, edit, fill, validate, and preview Korean Hangul documents with Codex. Use for .hwp, .hwpx, or .hml files; 한글/한컴 documents; Korean official-document generation; HWPX tables, forms, images, SVG/PNG assets, preserve-format text patches, or document validation.
---

# Gpt_Codex_HWP
Use the bundled `hwp_*` MCP tools for Korean Hangul document work.

## Core workflow

1. Call `hwp_detect_format` before reading or editing an unfamiliar file and inspect `file_size_bytes`.
2. Call `hwp_read` to obtain Markdown, metadata, warnings, and extracted image paths. If the source exceeds 8 MiB, provide a new `.md` `markdown_output_path` on this first call.
3. Choose the least destructive operation:
   - Create a new HWPX with `hwp_generate_hwpx`.
   - Change existing HWPX text with `hwp_patch_document`; binary HWP returns `HWP_READ_ONLY`.
   - Fill labeled fields with `hwp_fill_form`.
   - Create a safe SVG/PNG pair with `hwp_create_svg_asset`.
   - Insert a supported bitmap or SVG image with `hwp_insert_image`; it is normalized to PNG before insertion.
4. Always provide an `output_path` different from every input path. Never overwrite a source document.
5. Call `hwp_validate` on every generated or edited HWPX.
6. Call `hwp_render_preview` when layout or placement needs visual review.

## Create documents and tables

Write document content as Markdown. Use GFM pipe tables for ordinary tables and HTML tables only when merged cells are required. Pass an official-document preset when the user requests a 기안문, 보고서, 계획서, 통지, or 회의록. Treat HWPX as the canonical writable format.

## Create and insert visual assets

Use `hwp_create_svg_asset` for deterministic diagrams or charts described by a structured SVG specification. Preserve the SVG source and create a PNG companion for HWPX compatibility. Insert the raster asset with `hwp_insert_image`, then validate and preview the result.

Pass either a documented JSON shape specification or safe inline `<svg>` to `hwp_create_svg_asset`. It does not interpret arbitrary natural-language image prompts. Active content, external references, scripts, foreign objects, and unsafe namespaces are rejected.

Use `seal-anchor` mode for signatures or stamps positioned around anchor text. Use `after-paragraph` mode for ordinary figures that must follow a matching paragraph. `anchor_text` is required for both modes; use `anchor_occurrence` when the text repeats. Report an ambiguous or missing anchor instead of guessing.

## Preserve existing formatting

Use preserve patching only with Markdown read from the same HWPX source document. Keep block order and table structure stable. Report every skipped edit; do not claim success when a requested edit was skipped. For binary HWP, read the source and recreate or edit an HWPX instead. For forms, inspect labels first and use uniqueness guards for repeated scalar labels.

## Binary HWP limitations

Read and preview supported classic HWP 5.x files. Binary HWP is strictly input-only: detection, reading, and preview are allowed, while generation, patching, form filling, image insertion, conversion, and export must produce HWPX. Return `HWP_READ_ONLY` when a writable operation targets binary HWP. HWP 3.x has no bundled real fixture and must not be claimed as verified. Reject signed, encrypted, DRM, or distribution documents with an explicit explanation; never attempt bypasses.

`hwp_render_preview` uses Kordoc first. Its optional rhwp fallback renders page 0 only, ignores requested Kordoc reflow/highlights, and uses approximate Node font metrics; report the returned warnings and do not present the fallback SVG as exact Hancom layout.

The target platforms are Windows x64 and macOS Apple Silicon. Windows x64 is verified for this release; actual macOS Apple Silicon smoke remains a gate for declaring macOS validated support until recorded. The plugin requires Node.js 22 or newer and target-local installation with `npm ci --omit=dev`; never copy `node_modules` between platforms. `after-paragraph` image insertion also requires Python 3.10 or newer on `PATH`. Windows tries `python` then `py -3`; macOS tries `python3` then `python`. If neither command exists, only that mode fails with `PYTHON_NOT_FOUND`; other tools remain available.

## Privacy and errors

The source-document hard ceiling is 512 MiB, but stricter engine limits apply: Kordoc 3.18.1 currently limits total HWP/HWPX decompression to 100 MiB and HWPX packages to 500 entries. Do not describe 512 MiB as guaranteed parse capacity.

Normal inline Markdown is limited to 64,000 JavaScript string characters, and the final serialized MCP result is limited to 8 MiB. When `hwp_read` reports `RESPONSE_TOO_LARGE`, retry once with a new `.md` `markdown_output_path`. The tool parses the source once per call, saves complete UTF-8 Markdown up to 256 MiB without overwriting, and returns a 64,000-character preview plus `recommended_chunk_characters`; read that derived file in native chunks instead of reparsing the source. A source above 8 MiB should use `markdown_output_path` on the first read.

Form values are masked by default. Use `mask_values: false` only when the user explicitly requests values in the MCP response. Preserve warnings from the document engine. Treat validation failure, malformed XML, ZIP-integrity failure, protected documents, unsafe Windows paths, or output/source path equality as a hard error.
