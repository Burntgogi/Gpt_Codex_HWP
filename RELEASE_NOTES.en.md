# Gpt_Codex_HWP v0.2.1 Release Notes

- Status: final release
- Prepared: 2026-07-22
- Validation: Windows x64, macOS arm64, Linux, and security release gates; physical Mac unverified

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Overview

v0.2.1 treats HWP as a safe read-only input format and writes every new or edited document as HWPX. The public runtime includes only the Kordoc Core required for document workflows; optional PDF, OCR, ONNX, and formula engines are excluded. The public surface remains exactly nine tools. This release adds public-tree and Git-history scans, least-privilege CI, and reproducible ZIP, SBOM, and provenance verification and attestation gates. The `v0.2.0` candidate was withdrawn before a GitHub Release was published when a new security advisory appeared; `v0.2.1` is the actual public release.

## Highlights

- Binary HWP is limited to format detection, reading, and preview. Direct generation, editing, or saving is refused with `HWP_READ_ONLY`.
- The MCP SDK's `@hono/node-server` dependency is exactly overridden to security-fixed 2.0.11, with zero known production vulnerabilities in both source and compact-runtime audits.
- The release attestation workflow builds large-document evidence and artifacts on validated Windows x64 and fails closed unless its immutable tag, exact commit SHA, and version inputs agree.
- Markdown-to-HWPX generation, structure-preserving patching, form filling, image insertion, validation, and SVG preview are supported.
- The outer 512 MiB source-file ceiling and 64,000-character inline Markdown policy remain in place. Large results parse the source once, save a new UTF-8 Markdown file, and are then read in chunks.
- The official Kordoc 3.18.1 npm archive is authenticated against a pinned SHA-512 value; unnecessary source maps and optional dependency engines are removed.
- The installed dependency tree rejects PDF, OCR, ONNX, and formula-engine packages at both top-level and nested paths.
- Both distribution builders reject personal home paths, private keys, literal credentials, `.env` files, source maps, test documents, and user documents.
- Credential scanning rejects cloud secret names including `AWS_SECRET_ACCESS_KEY`, and the public runtime explicitly carries the two icons referenced by skill metadata.
- The release gate automatically verifies Kordoc provenance, `npm ls`, `npm audit`, size budgets, MCP stderr, and all nine tool smokes.
- Historical generated `release/**` trees were removed from public source and retained only in local backups.
- The README introduction now leads with the original pixel-art banner, status badges, fast navigation, and a preview of an actually generated HWPX.
- The README example HWPX was generated from privacy-safe synthetic Markdown and verified as one page with one table, zero structural issues, and zero preview warnings.
- The new HWPX result PNG is pinned by exact size and SHA-256 in the public-content policy so an unapproved binary replacement fails closed. The original title banner keeps its existing pinned policy.

## README Design References

GitHub repository search on 2026-07-22 found no repository with at least one million stars, so the introduction patterns of the actual five most-starred repositories were reviewed instead. No original copy or imagery was reused.

- [codecrafters-io/build-your-own-x](https://github.com/codecrafters-io/build-your-own-x): a full-width banner that owns the first screen
- [sindresorhus/awesome](https://github.com/sindresorhus/awesome): centered brand identity and concise navigation
- [freeCodeCamp/freeCodeCamp](https://github.com/freeCodeCamp/freeCodeCamp): trust status surfaced through badges
- [public-apis/public-apis](https://github.com/public-apis/public-apis): purpose and usage paths exposed immediately
- [EbookFoundation/free-programming-books](https://github.com/EbookFoundation/free-programming-books): clear separation of language, license, and contribution routes

## Public tools

`hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, `hwp_insert_image`

## Verification results

Release policy requires the exact commit referenced by the tag to pass the Windows x64, macOS arm64, Linux, and security checks. The runs below are passing records for the pre-release hardening baseline; the final tag is published only after the current release commit passes every required check.

- [CI run 29834487275](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/29834487275): Windows x64 full release gate and platform receipt, macOS arm64 full release gate and platform receipt, and Linux lifecycle checks passed
- [Security run 29834486173](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/29834486173): public-tree and all-reachable Git object/identity scans, source/runtime production audits, runtime projection, and artifact build and verification passed
- The platform release gates include the authenticated Kordoc rebuild, fresh large-document evidence, real read-only HWP smoke, all nine MCP tool smokes, and artifact-integrity checks
- The hosted macOS arm64 gate passed, but actual use with Codex Desktop and Hancom Office Hangul on a physical Mac remains unverified

## Installation and upgrade

For installation, pin the immutable `v0.2.1` tag instead of the moving `main` branch. Validate the returned `installedPath` and plugin ID, then run the following commands only from that validated directory:

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

These are the stable `v0.2.1` release notes. Install from the immutable `v0.2.1` tag rather than the moving `main` branch.
