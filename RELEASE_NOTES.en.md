# Gpt_Codex_HWP v0.1.4 Release Notes

- Status: final release
- Prepared: 2026-07-13
- Validated platform: Windows x64

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Overview

v0.1.4 is the final release that treats HWP as a safe read-only input format and writes every new or edited document as HWPX. The public runtime includes only the Kordoc Core required for document workflows; optional PDF, OCR, ONNX, and formula engines are excluded. The public surface remains exactly nine tools.

## Highlights

- Binary HWP is limited to format detection, reading, and preview. Direct generation, editing, or saving is refused with `HWP_READ_ONLY`.
- Markdown-to-HWPX generation, structure-preserving patching, form filling, image insertion, validation, and SVG preview are supported.
- The outer 512 MiB source-file ceiling and 64,000-character inline Markdown policy remain in place. Large results parse the source once, save a new UTF-8 Markdown file, and are then read in chunks.
- The official Kordoc 3.18.1 npm archive is authenticated against a pinned SHA-512 value; unnecessary source maps and optional dependency engines are removed.
- The installed dependency tree rejects PDF, OCR, ONNX, and formula-engine packages at both top-level and nested paths.
- Both distribution builders reject personal home paths, private keys, literal credentials, `.env` files, source maps, test documents, and user documents.
- Credential scanning rejects cloud secret names including `AWS_SECRET_ACCESS_KEY`, and the public runtime explicitly carries the two icons referenced by skill metadata.
- The release gate automatically verifies Kordoc provenance, `npm ls`, `npm audit`, size budgets, MCP stderr, and all nine tool smokes.
- Historical generated `release/**` trees were removed from public source and retained only in local backups.

## Public tools

`hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, `hwp_insert_image`

## Verification results

- Node tests: 330 passed out of 334, with 4 expected platform/privilege skips and 0 failures
- Python safe-edit tests: 16/16 passed
- Production `npm audit`: 0 known vulnerabilities
- Official Kordoc rebuild: all 41 files, including provenance, matched byte-for-byte
- Real read-only HWP smoke and all nine MCP tool smokes passed with 0 bytes on stderr
- Legacy and public distributions passed packing, privacy scanning, `npm ci --omit=dev --ignore-scripts`, and `npm ls`
- Package archive size, including the banner and icons, is approximately 3.1 MiB; the verified Windows x64 production installation is approximately 50 MB

## Installation and upgrade

After the GitHub release is published, pin the `v0.1.4` tag instead of the moving `main` branch. Validate the returned `installedPath` and plugin ID, then run the following commands only from that validated directory:

```powershell
npm ci --omit=dev --ignore-scripts
npm audit --omit=dev
```

Restart Codex or open a new task and verify exactly nine tools. Do not remove an older working plugin until the new installation passes verification. Follow the [agent-assisted GitHub installation section](README.en.md#agent-assisted-installation-from-github) for the complete sequence.

## Compatibility and known limitations

- Developed and validated on Windows x64.
- macOS Apple Silicon is a compatibility target but has not been validated on a physical Mac.
- HWP 5.x is read-only. HWP 3.x is not guaranteed because no real fixture has been validated.
- Font files are not bundled, installed, or embedded. Rendering and line wrapping depend on fonts installed on the system that opens the document.
- Protected, encrypted, signed, or DRM-controlled documents are refused without bypass.
- Engine limits such as Kordoc's 100 MiB decompression ceiling and 500-entry HWPX ceiling may apply before the outer 512 MiB file limit.

## License and acknowledgements

Project code is distributed under Apache-2.0. Kordoc, rhwp, hwpx-editing-skill, and other third-party components remain subject to their original copyrights and licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for pinned versions, usage scopes, and notices.

These are the final `v0.1.4` release notes. Install from the immutable `v0.1.4` tag rather than the moving `main` branch.
