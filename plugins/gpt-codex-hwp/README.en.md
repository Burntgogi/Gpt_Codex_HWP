![Gpt_Codex_HWP](assets/gpt-codex-hwp-banner.png)

[한국어](README.md) | [English](README.en.md)

# Gpt_Codex_HWP

## Overview

Gpt_Codex_HWP is a local Codex plugin for reading, creating, editing, validating, and previewing Korean HWP/HWPX documents. HWPX is the supported write format, and edits preserve the existing raw ZIP/XML structure whenever possible. Classic HWP is a read-only input format for detection, reading, and preview; its content can be saved as a new HWPX.

## Features

- Generate HWPX reports, plans, official documents, and meeting notes from Markdown
- Patch text while preserving existing HWPX structure and fill label-based forms
- Create safe SVG/PNG assets and insert images into HWPX documents
- Detect HWP/HWPX formats, read Markdown, validate structure/font references, and render SVG previews
- Refuse protected documents, prevent output overwrite, and defend against path/ZIP traversal
- Parse large documents once, save complete UTF-8 Markdown, and read it safely in chunks

## Format Support

| Format | Support |
| --- | --- |
| HWPX | Read, generate, structure-preserving patch, form fill, image insertion, validation, preview |
| HWP 5.x | Detect, read, and preview only; read content can be saved as a new HWPX |
| HWP 3.x | Not guaranteed because no real fixture has been validated |
| PDF, DOCX, XLSX, and others | Detection and reading where supported by Kordoc |

HWPX is the supported authoring format. To revise a binary HWP, read it with `hwp_read`, organize the required content as Markdown, and save it to a new HWPX path with `hwp_generate_hwpx`.

## Requirements

- Node.js 22 or later
- Windows x64 or macOS Apple Silicon
- Python 3.10 or later on PATH for `after-paragraph` image insertion
- An environment with Codex plugin marketplace commands

Without Python, only the Python-backed image insertion mode fails with `PYTHON_NOT_FOUND`; the other tools remain available.

## Notable Pre-Release Hardening

Before its first release, Gpt_Codex_HWP hardened document-processing boundaries identified while integrating and applying public open-source work including [Kordoc](https://github.com/chrisryugj/kordoc), [rhwp](https://github.com/edwardkim/rhwp), and [hwpx-editing-skill](https://github.com/kangdacool/hwpx-editing-skill). This does not imply that the same bugs or vulnerabilities exist in those upstream projects. We thank all of their maintainers and contributors for making this work available.

- Resource limits inspect the ZIP central directory's actual entry count and size budget before loading an HWPX package into memory.
- Protection manifests that differ only by letter case are rejected, and UTF-8/UTF-16 protection settings are detected consistently.
- Size limits cover document and image processing as well as the actual final MCP response.
- Mutations receive semantic post-verification, and Python anchor selection streams matches without materializing the full result set.
- Personal identifying traces were removed from public distribution metadata.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for exact usage scopes, pinned versions, copyright notices, and licenses.

## Development and Platform Validation

This project was developed and validated primarily on Windows x64. Its launcher and runtime paths are designed for macOS Apple Silicon compatibility, but no smoke test has yet been run on a real Mac. macOS Apple Silicon is therefore a compatibility target, not a currently validated platform.

## Agent-assisted installation from GitHub

`v0.1.3`, when published, will be the first release published under GitHub release immutability. `v0.1.0`, `v0.1.1`, and `v0.1.2` remain historical releases; new installations should use `v0.1.3` after it is published.

A user can ask a Codex agent:

> Install release `v0.1.3` of `Burntgogi/Gpt_Codex_HWP`. Follow the sequence in this section, validate `installedPath`, install production dependencies from the lockfile, and verify all nine MCP tools in a new task.

1. Check Git, the Codex CLI, Node.js 22 or later, and npm. Python 3.10 or later is additionally required only for `after-paragraph` image insertion.
2. Pin the release tag instead of registering the moving `main` branch.

```powershell
codex plugin marketplace add Burntgogi/Gpt_Codex_HWP --ref v0.1.3 --json
```

Verify that the returned JSON has `marketplaceName` equal to `gpt-codex-hwp-local`.

3. Request the installation result as JSON and extract only the reported path.

```powershell
$installed = codex plugin add gpt-codex-hwp@gpt-codex-hwp-local --json | ConvertFrom-Json
$installedPath = [System.IO.Path]::GetFullPath([string]$installed.installedPath)
```

4. Verify that the installation JSON has `pluginId` equal to `gpt-codex-hwp@gpt-codex-hwp-local` and a non-empty `version`. Verify that `installedPath` is an absolute path to an existing directory and ends with the exact cache identity `plugins/cache/gpt-codex-hwp-local/gpt-codex-hwp/<version>`. It must contain `.codex-plugin/plugin.json`, `package.json`, `package-lock.json`, and `dist/mcp.js`. Never evaluate a JSON string as a command or run npm from an unexpected path.
5. From that exact validated path, install and audit the lockfile-based production dependencies.

```powershell
Push-Location -LiteralPath $installedPath
try {
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  npm audit --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm audit failed" }
} finally {
  Pop-Location
}
```

6. Restart Codex or open a new task and verify exactly these nine tools: `hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, and `hwp_insert_image`. If verification fails, do not remove an older working plugin; report only the error and `installedPath`. Do not report tokens, environment variables, or user document contents.

## Installation and Migration

Use this sequence to migrate safely from an existing installation:

1. Register the new local marketplace from the new project directory.
```powershell
cd Gpt_Codex_HWP
codex plugin marketplace add .
```

2. Install the new plugin.
```powershell
codex plugin add gpt-codex-hwp@gpt-codex-hwp-local
```

This command alone does not prepare npm production dependencies. From the validated runtime path returned by installation, run `npm ci --omit=dev` as described under `Runtime Installation` below.

3. Open a new Codex task and verify the `gpt-codex-hwp@gpt-codex-hwp-local` plugin ID and exactly nine registered tools: `hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, and `hwp_insert_image`.

4. Only after the new installation passes verification, remove the old plugin.
```powershell
codex plugin remove hwp-korean-docs@hwp-local
```

5. If verification fails, keep the old plugin, remove only the new installation, and retry. After updating local source, update the manifest version cache-buster and reinstall the new plugin.

## Tools

| Tool | Purpose |
| --- | --- |
| `hwp_detect_format` | Detect the file's actual document format and container. |
| `hwp_read` | Read HWP/HWPX as Markdown and metadata. |
| `hwp_generate_hwpx` | Generate a new HWPX from Markdown. |
| `hwp_validate` | Check HWPX structure and font-reference integrity. |
| `hwp_render_preview` | Render HWP/HWPX to an SVG preview. |
| `hwp_patch_document` | Patch text while preserving existing HWPX structure; binary HWP returns `HWP_READ_ONLY`. |
| `hwp_fill_form` | Safely fill label-based form values. |
| `hwp_create_svg_asset` | Create safe SVG and PNG visual assets. |
| `hwp_insert_image` | Insert an image into HWPX relative to an anchor. |

## Workflows

For a new document, call `hwp_generate_hwpx`, then use `hwp_detect_format`, `hwp_validate`, `hwp_read`, and `hwp_render_preview` to check its format, structure, content, and layout.

For an existing HWPX, read it first and call `hwp_patch_document` with Markdown that retains block order and table structure. For a binary HWP, use `hwp_read` and then save the content to a new HWPX with `hwp_generate_hwpx`. Use `hwp_fill_form` for forms and combine `hwp_create_svg_asset` with `hwp_insert_image` for visuals. `after-paragraph` suits ordinary figures and `seal-anchor` suits signatures or seals; the plugin does not choose arbitrarily when an anchor is missing or ambiguous.

## Large-document reading

The source-file hard ceiling is 512 MiB; stricter format-engine limits may apply. This outer safety limit does not guarantee that every 512 MiB document can be parsed. Kordoc 3.18.1 currently caps total HWP/HWPX decompression at 100 MiB and HWPX packages at 500 entries.

Inline Markdown defaults to 64,000 JavaScript string characters. For larger results, pass a new `.md` path as `markdown_output_path`. The plugin parses the source once, saves complete UTF-8 Markdown up to 256 MiB without overwriting, and returns a 64,000-character preview with total size, source fingerprint, and recommended chunk size. Codex can then read the derived Markdown in roughly 64,000-character chunks without reparsing the HWP/HWPX source.

The final serialized MCP result is capped at 8 MiB. For source files above 8 MiB, provide `markdown_output_path` on the first read. For smaller sources, retry with a new `.md` path if `hwp_read` returns `RESPONSE_TOO_LARGE`.

## Safety

- Input and output paths must differ, and existing output files are never overwritten.
- Signed, encrypted, DRM-protected, or distribution-protected documents are refused without bypassing protection.
- Path aliases, hard links, symbolic links, Windows junctions, and ZIP path traversal are defended against.
- A generated or edited artifact is not written when HWPX validation fails.
- Semantic verification is mandatory for `hwp_patch_document`; it cannot publish when verification is disabled or verification statistics are missing.
- Protection manifests are inspected with UTF-8/UTF-16 awareness, and ZIP entry counts are capped at 10,000 before JSZip loads the archive.
- Form values are masked in MCP results by default and disclosed only when explicitly requested.
- Direct binary-HWP patching is refused with `HWP_READ_ONLY`.

## Font Integrity

HWPX maintains separate font tables for `HANGUL`, `LATIN`, `HANJA`, `JAPANESE`, `OTHER`, `SYMBOL`, and `USER`. Generation normalizes only references that point to no valid entry; it does not change Kordoc's width, spacing, relative size, position, or font names. `hwp_validate` checks missing/duplicate font tables, counts, IDs, empty names, and invalid `fontRef` values.

The plugin does not bundle font files, embed them in HWPX, or install system fonts. Actual font display and line wrapping depend on fonts available on the system that opens the document.

## Known Limitations

- Classic HWP is read-only; all generated and edited documents are written as HWPX.
- The 512 MiB source ceiling remains subject to stricter engine limits, including Kordoc 3.18.1's 100 MiB decompression and 500-entry HWPX limits.
- Inline Markdown is capped at 64,000 characters, derived Markdown at 256 MiB, and the final serialized MCP result at 8 MiB.
- Kordoc or rhwp previews may not match Hancom GUI output pixel-for-pixel.
- The rhwp preview fallback may render only the first page and use approximate Node-side font widths.
- Passwords and DRM on protected documents are not removed or bypassed.
- HWP 3.x is not presented as validated support because no real fixture is available.
- Preview SVG output is limited to 128 MiB.
- Preview highlights are limited to 256 terms and 16,384 aggregate characters; one form-fill request is limited to 10,000 total values.

## Runtime Installation

Install platform-specific native dependencies separately in each runtime environment. Do not copy Windows `node_modules` to macOS.

```bash
npm ci --omit=dev
```

This command uses the lockfile to install runtime dependencies, including Sharp, for the current OS and CPU. It does not install font files.

## Open-Source Acknowledgements

The use of `hwpx-editing-skill` differs from ordinary runtime dependencies: this project adapted its pinned raw-entry and compression-metadata-preserving HWPX repack flow, selected safety principles, and verification workflow. We thank its maintainers and contributors.

Kordoc supplies document detection, reading, HWPX generation/validation, and preview runtime functions; rhwp supplies optional HWP/HWPX parsing and preview fallback for read-only document workflows. The Model Context Protocol TypeScript SDK supplies the MCP server and stdio transport, xmldom supplies XML DOM handling, SheetJS CFB supplies OLE compound-file handling for binary HWP, JSZip supplies HWPX ZIP handling, Sharp supplies safe image conversion, and Zod supplies tool-input schema validation. We thank every project's maintainers and contributors.

Pixelify Sans was used only to render title text into the final raster banner; the font file is not bundled with the plugin. We thank the Pixelify Sans Project Authors and Google Fonts maintainers. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for exact versions, copyrights, licenses, and usage details.

## License

Gpt_Codex_HWP is distributed under [Apache-2.0](LICENSE). Third-party components and production inputs remain subject to their respective licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
