# Gpt_Codex_HWP v0.3.3 Release Notes

- Prepared: 2026-10-21
- Plugin version: `0.3.3+codex.20261021134251`
- Claude Code cache: `0.3.3-codex.20261021134251`
- Publication check: after publication, verify exact SHA, full gate, same-run attestation and four original assets on the [immutable v0.3.3 release](https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.3.3). Another tag's passed checks are not substitute evidence.

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Release-path improvements without relaxed limits

The artifact producer, verifier and platform receipts share the existing Git `cat-file --batch` protocol and retain committed blob OIDs instead of launching size/content subprocesses for every runtime file. Per-file and aggregate bounds, OID/type/framing and exact-stream checks, committed-versus-staged bytes, Git environment isolation and disclosure checks remain.

When an original test run stops at its deadline, the executor retains reported completion ordinal/summary from already captured bounded TAP and spawn/exit/stdout-end/close/deadline/grace evidence. A reported ordinal does not identify the active case; termination settlement or its Boolean result is not cleanup proof. Even complete passing TAP remains failure when the process does not close before its deadline. Ordinary 120-second file, five-second close grace and 512 KiB capture limits are unchanged; no raw content, paths, environment or private canary is printed.

The [counterbalanced Windows experiment](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39609784474) executed each variant once in both orders; all four executions passed inside the original limit. Reduced file completion times are observed performance evidence, not proof of the historical timeout's exact cause. A separate real Linux child-process probe preserved formerly discarded failed TAP while both versions remained failed, with independently observed owned-group absence.

## Unpublished v0.3.2 candidate

The immutable `v0.3.2` tag's [full gate and attestation](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39599590179) passed, but the original Windows `release-artifacts.test.ts` exceeded its deadline in [postmerge main CI](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39599469450), so no GitHub Release was published. Its exact historical cause cannot be reconstructed; later diagnostic success does not invalidate that failure. Preserve the tag and artifacts instead of moving/replacing them; use v0.3.3's fresh identity and its own validation.

## Normal reparenting and real RSS

A process remains the same PID/group/start identity when its parent exits and it is adopted. The previous collector rejected real VmRSS solely because the parent PID changed. v0.3.3 reuses the existing stable-identity comparison and rejects group/start drift within a read or across attempts. Missing RSS for live, unknown or inaccessible processes still fails; the existing maximum three attempts, intervals, deadlines and independent cleanup proof remain unchanged.

A controlled, actual Linux parent/child reparenting probe rejected the sample before the fix, then returned RSS equal to real `/proc` VmRSS afterward; registered authority independently proved the owned group gone. Seven new regression cases failed before and passed after. A later CI instance's stage-only log does not prove that exact instance had this race. Literal diagnostic/default-stage, wording and source-regex assertions were retired rather than re-pinned; failure status, measured RSS, privacy and cleanup requirements remain.

## Installation and verification scope

Follow the README's v0.3.3 tag-change procedure. Even when source remove/add retains the previous cache, Codex CLI 0.162.1 `plugin add` can remove that cache. Do not manually delete the old durable runtime. Verify the new identity and `installedPath`, explicit installation, doctor, host restart and a document operation. The v0.3.1 markdown-it 14.3.3 security fix remains, as do nine tools and read-only HWP/HWPX writing.

Preserve the v0.3.1 tag, assets and historical verification. Judge this patch's publication and platform checks only by its own v0.3.3 release evidence above. Hosted macOS is not physical-Mac/Desktop/Claude Code/Hancom GUI validation. Publish only ZIP, SPDX, provenance and SHA256SUMS from the same exact immutable-tag run that passes the full gate and attestation; never substitute a local rebuild.

## Historical v0.3.1 public record

# Gpt_Codex_HWP v0.3.1 Release Notes

- Status: [v0.3.1 published](https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.3.1)
- Published: 2026-10-21T11:32:22Z
- Plugin version: `0.3.1+codex.20261021043114`
- Claude Code cache directory: `0.3.1-codex.20261021043114`

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Security patch

v0.3.1 updates source and generated-runtime markdown-it from 14.3.1 to 14.3.3 for [GHSA-gfr2-rv44-r23c](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-gfr2-rv44-r23c), [GHSA-r7fv-28h4-cvq7](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-r7fv-28h4-cvq7), and [GHSA-vfgh-jcmw-g37q](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-vfgh-jcmw-g37q). The existing 14.x API and parser options remain; no new capabilities, PDF support, or MCP surface are enabled.

## Installation and upgrade

Use the README's published `v0.3.1` tag-pinned installation commands. v0.3.0 is the prior public release. Reinstall the plugin and validate that `version` is `0.3.1+codex.20261021043114` and `installedPath` identifies the new cache directory (Claude Code spells `+` as `-`). The new identity does not reuse the older runtime; updating the old runtime's dependencies in place is not an upgrade.

For Codex already pinned to another tag, close the host and remove only its source registration with `codex plugin marketplace remove gpt-codex-hwp-local --json`, then run `marketplace add ... --ref v0.3.1 --json` and `plugin add ... --json`. Repeating `marketplace add` on the existing registration does not change its ref. In the isolated Linux upgrade with Codex CLI 0.162.1, `plugin add` removed the old cache while the old durable runtime's lock and receipt stayed unchanged. The [README tag-change section](README.en.md#changing-the-tag-of-an-existing-installation) has the exact commands and the verified old-tag cache recovery that passed doctor. Do not manually delete the old durable runtime.

From the validated new `installedPath`, explicitly run:

    node dist/install-runtime.js --json
    node dist/doctor.js --json

Require `RUNTIME_INSTALL_OK` and `DOCTOR_OK`. Fully close and reopen every active Codex CLI and Desktop host, or the Claude Code session. Complete one document operation, verify its output, and confirm that the one-shot process and descendants exit. Do not manually delete the old durable runtime before these steps succeed; remove only an exact unused version directory afterward.

## Verification and publication boundary

- [Windows x64, macOS arm64, and Linux CI](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39585790921) and [Security policy](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39585790893) passed on tag commit `4180a8d35e01aa95205a39c60ae9686486f6f9cb`. Its tree matched main `633421e39e0ecad35817bcfe8b061f7b80da7ea8` at merge, and [post-merge CI](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39587356229) also passed. No protection changes or merge bypass were used.
- [Immutable-tag full gate and attestation run 39589053351](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39589053351) succeeded. Only that run's ZIP, SPDX SBOM, provenance, and SHA256SUMS were published; GitHub asset digests match those originals. All three subject signatures were independently verified against the exact repo, source SHA/ref, workflow@tag, GitHub-hosted runner, and same run invocation. The existing artifact verifier also confirmed 135 runtime files, 152 production packages, nine tools, source commit/tree, and checksums.
- A fresh isolated Linux profile with actual Codex CLI 0.162.1 verified the v0.3.0 → v0.3.1 tag upgrade. All 135 cached files match the verified ZIP byte for byte. The new runtime returned `RUNTIME_INSTALL_OK` and `DOCTOR_OK`, used markdown-it 14.3.3, and generated/validated HWPX (14,421 bytes) with zero stderr bytes and zero remaining supervised descendants. The old durable runtime's lock and receipt hashes stayed unchanged.

The historical v0.3.0 records below do not replace this evidence. Hosted macOS success is not physical-Mac validation of Codex Desktop, Claude Code, or Hancom Office GUI use. The user's default profile and running hosts were untouched; restart and verify a document operation in the actual installation environment. No local rebuild was used as a distribution artifact.

## Historical v0.3.0 release record (2026-10-08)

# Gpt_Codex_HWP v0.3.0 Release Notes

- Status: final release
- Date: 2026-10-08
- Validation baseline: local Windows x64 checks; hosted Windows x64, macOS arm64, and Linux CI passed; Claude Code verified on Windows x64 only; physical Mac unverified

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Overview

v0.3.0 lets the same plugin folder serve both Codex and Claude Code. It lowers the CI-verified document tier to 10 MiB and adds `korean-official-doc`, an optional plugin that checks 공문서 drafts. It retains v0.2.7's read-only HWP policy, HWPX writing, nine internal one-shot tools, and explicit runtime installation.

## Main changes

- Claude Code support: a repository-root `.claude-plugin/marketplace.json` and a generated `plugins/gpt-codex-hwp/.claude-plugin/plugin.json`. The runtime recognizes Claude Code's cache layout (a version directory with `+` replaced by `-`) and keeps production dependencies under `<CLAUDE_CONFIG_DIR or ~/.claude>/plugin-runtime-data`, separate from Codex.
- Size tier: the CI-verified envelope drops from 100 MiB to 10 MiB; most Hangul documents are around 1 MiB. Over 10 MiB through 512 MiB is theoretically supported but not verified size by size, and over 512 MiB is still rejected.
- Optional `korean-official-doc` plugin: an offline check of 공문서 Markdown drafts for date, time, and amount notation, item-symbol order, 붙임, and the 「끝」 mark, citing 「행정업무의 운영 및 혁신에 관한 규정」 and its 시행규칙. It has no dependencies and is Apache-2.0.
- Companion recommendations: after an installation the user asked for, the agent recommends `ai-slop-thresher`, `kar-plain`, and `korean-official-doc` once. Nothing is installed automatically.
- HWPX generation no longer turns underscores inside words such as `Gpt_Codex_HWP` into emphasis and drops them.
- Path safety: Windows network (UNC) paths are rejected without an allowed root, decided before any filesystem access. Windows 8.3 short names and the macOS `/tmp`, `/var`, and `/etc` aliases are rewritten to their real paths instead of being rejected.
- Failed writes: when a reserved output fails, files whose writing started are emptied, and each output path is reported as emptied, never written, complete, or possibly partial.
- Python: the image helper and doctor share one list of trusted locations (never PATH) and the same 3.10 minimum. Helper failure codes pass through.
- Dependencies: @modelcontextprotocol/sdk 1.32.1, proxy-addr pinned to 2.0.8, fast-uri 3.1.8, markdown-it 14.3.1, and the optional @rhwp/core 0.8.7.
- Plugin version `0.3.0+codex.20261008150000` keeps its runtime separate from v0.2.7.

## Behavior changes from 0.2.x

- Windows network (UNC) paths require their UNC root in `GPT_CODEX_HWP_ALLOWED_ROOTS`. Without it, documents on a mapped network drive can still be read, but outputs are not written to that share.
- `after-paragraph` image insertion requires Python 3.10 or newer in a trusted location; otherwise it returns `PYTHON_NOT_FOUND`.
- Previewing HWPX without a Hancom layout cache (including documents this plugin generates) without `reflow` returns `PREVIEW_REFLOW_REQUIRED` instead of `ENGINE_CRASH`. Retry with `reflow: true`.
- A write that fails after writing started returns the cause's code, or `OUTPUT_WRITE_FAILED` when the cause has none. A helper report that the source is not HWPX becomes `SOURCE_HWPX_INVALID`; other helper failures become `IMAGE_INSERTION_FAILED`.
- One-shot exit 2 writes `ONESHOT_INVOCATION_ERROR reason=<STAGE>` to stderr. Callers that compared the whole string should compare the prefix.
- The CI-verified envelope ends at 10 MiB. Larger documents may work, but there is no size-by-size evidence for them.

## Release verification

- On Node.js 22, production npm audit returned zero known vulnerabilities for both source and distribution locks.
- Of 474 repository Node tests, 472 passed and two were skipped for environment restrictions, with zero failures. All 54 policy tests and 10 official-document linter tests passed.
- In CI all 45 source test files passed, and the generated runtime check and installed-runtime nine-tool smoke also passed. On local Node 22.17 one release-artifact test file fails on the zlib version string format; it passes on the Node 22.22.2 that CI pins.
- Windows x64, macOS arm64, and Linux CI and security policy checks passed on PR #23. The v0.3.0 ZIP, SPDX, provenance, and checksums are verified by the release gate.
- The Claude Code path was checked on Windows x64 by installing into an isolated `CLAUDE_CONFIG_DIR` and running the runtime installer, doctor, and HWPX generate, validate, read, and preview.
- Distribution assets come only from the same run that passes the full immutable-tag release gate and attestation. After installation, restart the host and verify one document operation.

## User resource statement

There are zero persistent Gpt_Codex_HWP Node processes while the plugin is idle. This release does not claim a lower fixed RSS or installation size.

## Installation and upgrade

After installing the v0.3.0 plugin, validate the returned installedPath against the path and plugin-identity rules. Install production dependencies and check status from that path:

    node dist/install-runtime.js --json
    node dist/doctor.js --json

The first command must return JSON code RUNTIME_INSTALL_OK. Fully close and reopen every active Codex CLI and Desktop host, or the Claude Code session. Run one document operation, require it to succeed, verify the generated output, and confirm that the one-shot process and its descendants exit. Document operations never install dependencies automatically; on RUNTIME_NOT_INSTALLED, explicitly rerun the installer from the validated installedPath. Keep the older working version until verification succeeds.

Production dependencies live under $CODEX_HOME/plugin-runtime-data for Codex and <CLAUDE_CONFIG_DIR or ~/.claude>/plugin-runtime-data for Claude Code, at gpt-codex-hwp/<full-plugin-version>/<platform>-<arch>-node<Node-major>. Manually clean up an older runtime only after confirming that its exact version directory is no longer used.

## Compatibility and known limitations

- Development and related feature validation were performed on Windows x64. macOS Apple Silicon is a compatibility target, but Codex Desktop, Claude Code, and Hancom Office Hangul remain unverified on a physical Mac.
- HWP 5.x is read-only; generated or edited results are HWPX. HWP 3.x has no real fixture and is not guaranteed.
- Documents through 10 MiB are in the CI-verified envelope. Over 10 MiB through 512 MiB is theoretically supported but unverified; over 512 MiB is rejected.
- Documents whose intraword underscores are escaped run Kordoc generation a second time to match the preview text, so generation takes about twice as long.
- Protected, encrypted, signed, and DRM documents are not bypassed. Font files are not bundled, installed, or embedded.

## License and acknowledgements

Project code is distributed under Apache-2.0. Kordoc, rhwp, hwpx-editing-skill, and other third-party components remain under their original copyrights and licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
