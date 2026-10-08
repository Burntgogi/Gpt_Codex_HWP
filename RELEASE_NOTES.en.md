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
