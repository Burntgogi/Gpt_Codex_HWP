# Gpt_Codex_HWP v0.2.2 Release Notes

- Status: pre-release candidate
- Prepared: 2026-08-01
- Verification platforms: Windows x64, macOS arm64 hosted runner, Linux x64, and security policy; no physical Mac verification

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Overview

v0.2.2 is a patch release that preserves the HWP-read-only/HWPX-write model while making platform CI and large-document verification release-ready. Nine internal one-shot contracts are retained; optional manual MCP compatibility retains all nine. Structurally valid documents through 100 MiB are the CI-verified support envelope. Documents over 100 MiB through 512 MiB remain non-guaranteed best effort, and files over 512 MiB are rejected.

Installed-runtime smoke tests previously stalled for 60 seconds on GitHub hosted Windows and macOS because the displayed temporary-directory path differed from its canonical path. The smoke now reuses the canonical path already proven by its ownership check for the MCP allowed root and output paths.

## Highlights

- Split Windows x64, macOS arm64, Linux lifecycle, and Security policy into stable required pull-request checks.
- Kept the pull-request document smoke at 10 MiB; the post-merge manual/scheduled Compatibility workflow owns full platform verification and a 100 MiB detect smoke through the public one-shot runtime.
- Retained 256 and 512 MiB benchmarks as explicit local engineering experiments without compatibility guarantees.
- Accepted hosted-runner path aliases during ownership validation while using only the verified canonical temporary root as the runtime boundary.
- Initialization diagnostics emit only the last allowlisted lifecycle boundary and a bounded stderr byte count. Raw errors, user paths, PIDs, and document content are never emitted.
- Fixed the history scanner incorrectly treating an empty continuation line in a valid GPG-signed commit as malformed Git history.
- Kept process start gates, supervisor readiness, termination receipts, and remaining-child verification fail closed.
- Removed duplicate full-suite ownership from pull-request jobs; Compatibility and immutable release verification own full platform receipts and the production-path 100 MiB smoke.
- A failed release 100 MiB preflight emits only a fixed bounded stage and prevents artifact construction and attestation.
- HWP remains detection/read/preview only, and every generated or edited result remains HWPX.

## User-visible changes from v0.2.1

| Area | v0.2.1 | v0.2.2 | User impact |
| --- | --- | --- | --- |
| HWP/HWPX policy | HWP read-only and HWPX write | Unchanged | Existing document workflows remain compatible |
| Document operations | Nine default MCP tools | Nine internal one-shot contracts retained; optional manual MCP compatibility retains all nine | No document operation was removed |
| Document-size guidance | A 512 MiB outer ceiling and engine limits existed, but the verified support envelope was unclear | At most 100 MiB is CI-verified; over 100 through 512 MiB is non-guaranteed best effort | The support statement now matches actual evidence |
| Installed-runtime initialization | A hosted Windows/macOS temporary-path alias could stall verification | Reuses the ownership-verified canonical temporary root | More reliable installation and upgrade verification |
| Diagnostics and privacy | Limited failure classification | Records only a bounded lifecycle boundary and stderr byte count | Diagnoses failures without user paths, PIDs, or document content |
| Child-process cleanup | Focused on whether termination completed | Validates registered and remaining process counts | More strictly detects Node children left after document work |
| Idle lifecycle | A default MCP server could remain active with its host | No default MCP server; one process per operation | Zero persistent Gpt_Codex_HWP Node processes when unused |

## User resource-use note

The verified resource claim is intentionally narrow: when unused, this plugin has zero persistent Gpt_Codex_HWP Node processes. No fixed RSS percentage or installation-size reduction is claimed.

## Retained one-shot contracts and optional manual MCP tools

`hwp_detect_format`, `hwp_read`, `hwp_generate_hwpx`, `hwp_validate`, `hwp_render_preview`, `hwp_patch_document`, `hwp_fill_form`, `hwp_create_svg_asset`, `hwp_insert_image`

## Current verification evidence

- Clean public-lineage local scan: 406 public-tree entries and all 714 reachable Git objects passed without personal identity, credential, or private-path findings.
- Repository Node tests passed with `452 passed / 2 skipped / 0 failed`; all 41 source Node test files and 20 Python safe-edit tests passed.
- Runtime projection for 119 files, project metadata, and source/public-runtime dependency contracts were verified.
- The installed-runtime one-shot generated an HWPX, validated it, and confirmed zero remaining supervised descendants.
- Source and public-runtime `npm audit --omit=dev`: zero known vulnerabilities.
- Remote repository policy: `compliant` for protected main, immutable tags, and owner-only writes.

The `Compatibility` workflow exists on the default branch. The remaining release gates are to pass Windows x64, macOS arm64, Linux lifecycle, and Security policy on the new candidate pull request; run full-platform compatibility plus the 100 MiB production one-shot smoke at the exact merged commit; and then run release-candidate verification, artifact checks, and attestation against the immutable `v0.2.2` tag.

## Installation and upgrade

After the final release is published, pin immutable tag `v0.2.2` instead of the moving `main` branch. Validate the returned `installedPath` and plugin ID, then run from that validated directory:

```powershell
npm ci --omit=dev --ignore-scripts
npm audit --omit=dev
```

Close and reopen every active Codex CLI and Desktop host once; opening a new task alone is not sufficient. Verify that `/mcp` has no default `gpt-codex-hwp` registration, run one document operation and require it to succeed, verify the generated output, and confirm that its one-shot process and its descendants exit. Do not remove an existing working installation until the new installation passes validation.

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
