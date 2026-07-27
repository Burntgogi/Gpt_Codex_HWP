# Gpt_Codex_HWP v0.2.2 Release Notes

- Status: pre-release candidate
- Prepared: 2026-07-27
- Verification platforms: Windows x64, macOS arm64 hosted runner, Linux x64, and security policy; no physical Mac verification

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Overview

v0.2.2 is a patch release that preserves the HWP-read-only/HWPX-write model and the exact nine-tool MCP surface while making platform CI and large-document verification release-ready. Structurally valid documents through 100 MiB are the CI-verified support envelope. Documents over 100 MiB through 512 MiB remain non-guaranteed best effort, and files over 512 MiB are rejected.

Installed-runtime smoke tests previously stalled for 60 seconds on GitHub hosted Windows and macOS because the displayed temporary-directory path differed from its canonical path. The smoke now reuses the canonical path already proven by its ownership check for the MCP allowed root and output paths.

## Highlights

- Split Windows x64, macOS arm64, Linux lifecycle, and Security policy into stable required pull-request checks.
- Kept the pull-request document smoke at 10 MiB; the post-merge manual/scheduled Compatibility workflow owns full platform verification and 100 MiB evidence.
- Retained 256 and 512 MiB benchmarks as explicit local engineering experiments without compatibility guarantees.
- Accepted hosted-runner path aliases during ownership validation while using only the verified canonical temporary root as the runtime boundary.
- Initialization diagnostics emit only the last allowlisted lifecycle boundary and a bounded stderr byte count. Raw errors, user paths, PIDs, and document content are never emitted.
- Kept process start gates, supervisor readiness, termination receipts, and remaining-child verification fail closed.
- Removed duplicate full-suite ownership from pull-request jobs; Compatibility and immutable release verification own full platform receipts and 100 MiB evidence.
- A failed release 100 MiB preflight now runs only bounded diagnostics and prevents artifact construction and attestation.
- HWP remains detection/read/preview only, and every generated or edited result remains HWPX.

## Public tools

`hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, `hwp_insert_image`

## Current verification evidence

- [PR #5 required CI run 30248171415](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/30248171415): Windows x64, macOS arm64, and Linux lifecycle passed. The previously documented hosted macOS `bp16` scheduling variance passed both the same-run isolated diagnostic and one failed-job rerun.
- [PR #5 Security run 30248171437](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/30248171437): public tree, every reachable Git object and author identity, production dependencies, runtime projection, and policy checks passed.
- Final candidate local verification: repository Node 420 passed, one capability skip, zero failed out of 421; all 41 source files passed with zero deferred; Python 20/20; installed-runtime nine-tool and SVG/PNG smoke passed.
- Source and public-runtime `npm audit --omit=dev`: zero known vulnerabilities.
- Remote repository policy: `compliant` for protected main, immutable tags, and owner-only writes.

Because this pull request introduces the new `Compatibility` workflow, GitHub does not allow manual dispatch until that workflow exists on the default branch. The remaining release gates are to run full Windows x64, macOS arm64, and Linux x64 compatibility plus 100 MiB evidence at the exact merged commit, then run release-candidate verification, artifact checks, and attestation against the immutable `v0.2.2` tag.

## Installation and upgrade

After the final release is published, pin immutable tag `v0.2.2` instead of the moving `main` branch. Validate the returned `installedPath` and plugin ID, then run from that validated directory:

```powershell
npm ci --omit=dev --ignore-scripts
npm audit --omit=dev
```

Restart Codex or open a new task and verify exactly nine tools. Do not remove an existing working installation until the new installation passes validation.

## Compatibility and known limitations

- Development and real-document functional validation were performed on Windows x64.
- macOS Apple Silicon is a hosted-runner compatibility target, but Codex Desktop and Hancom Office Hangul remain unverified on a physical Mac.
- HWP 5.x is read-only; HWP 3.x has no real fixture and is not guaranteed.
- The plugin does not bundle, install, or embed fonts. Rendering and line breaks depend on system fonts.
- Protected, encrypted, signed, and DRM documents are rejected rather than bypassed.
- Inline Markdown is capped at 64,000 characters, derived Markdown at 256 MiB, and the serialized MCP result at 8 MiB.
- Stricter engine policies may apply first, including Kordoc's 100 MiB decompression and 500-entry HWPX limits.

## License and acknowledgements

Project code is released under Apache-2.0. Kordoc, rhwp, hwpx-editing-skill, and all other third-party components remain under their authors' copyrights and licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for exact versions, scope, and notices.

These are pre-release candidate notes for `v0.2.2`. Until compatibility, immutable-tag verification, and the GitHub Release are complete, `v0.2.1` remains the latest public release.
