# Gpt_Codex_HWP v0.2.6 Release Notes

- Status: final release
- Date: 2026-09-29
- Validation baseline: local Windows x64 checks; hosted Windows x64, macOS arm64, and Linux CI passed; physical Mac unverified

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Overview

v0.2.6 updates the packages reported in [dependency audit issue #18](https://github.com/Burntgogi/Gpt_Codex_HWP/issues/18). It retains v0.2.5's read-only HWP policy, HWPX writing, nine internal one-shot tools, and explicit runtime installation.

## Main changes

- Updated the direct dependencies @xmldom/xmldom to 0.9.12 and sharp to 0.35.5.
- Updated the source and generated runtime locks to fast-uri 3.1.7, hono 4.13.11, qs 6.16.0, and ip-address 10.7.2.
- HWPX font integrity output now uses `requireWellFormed: true` during XML serialization. It removes the parsed XML declaration and restores a UTF-8 declaration to produce valid documents.
- Dependency audit reporting now includes every advisory for a package. The same advisory in both locks, or multiple fix suggestions for it, no longer creates duplicate rows.
- Plugin version 0.2.6+codex.20260929182230 keeps its runtime separate. The v0.2.5 tag and assets are unchanged.

## Release verification

- On Node.js 22.22.2/npm 10.9.7, production npm audit returned zero known vulnerabilities for both source and distribution locks.
- Of 459 repository Node tests, 457 passed and two were skipped for Windows environment restrictions, with zero failures. All 53 policy tests passed.
- Of 106 focused XML, protection, image, and runtime tests, 104 passed and two were skipped for environment restrictions. The generated runtime check and installed-runtime nine-tool smoke also passed.
- Windows x64, macOS arm64, and Linux CI and security policy checks passed on PR #19 and the follow-up PR #20. The v0.2.6 ZIP, SPDX, provenance, and checksums were independently verified locally.
- Distribution assets come only from the same run that passes the full immutable-tag release gate and attestation. After installation, restart the host and verify one document operation.

## User resource statement

There are zero persistent Gpt_Codex_HWP Node processes while the plugin is idle. This dependency update does not claim a lower fixed RSS or installation size.

## Installation and upgrade

After installing the v0.2.6 plugin, validate the returned installedPath against the path and plugin-identity rules. Install production dependencies and check status from that path:

    node dist/install-runtime.js --json
    node dist/doctor.js --json

The first command must return JSON code RUNTIME_INSTALL_OK. Fully close and reopen every active Codex CLI and Desktop host. Run one document operation, require it to succeed, verify the generated output, and confirm that the one-shot process and its descendants exit. Document operations never install dependencies automatically; on RUNTIME_NOT_INSTALLED, explicitly rerun the installer from the validated installedPath. Keep the older working version until verification succeeds.

Production dependencies remain at $CODEX_HOME/plugin-runtime-data/gpt-codex-hwp/<full-plugin-version>/<platform>-<arch>-node<Node-major>. Manually clean up an older runtime only after confirming that its exact version directory is no longer used.

## Compatibility and known limitations

- Development and related feature validation were performed on Windows x64. macOS Apple Silicon is a compatibility target, but Codex Desktop and Hancom Office Hangul remain unverified on a physical Mac.
- HWP 5.x is read-only; generated or edited results are HWPX. HWP 3.x has no real fixture and is not guaranteed.
- Documents through 100 MiB are in the CI-verified envelope. Over 100 MiB through 512 MiB is non-guaranteed best-effort; over 512 MiB is rejected.
- Protected, encrypted, signed, and DRM documents are not bypassed. Font files are not bundled, installed, or embedded.

## License and acknowledgements

Project code is distributed under Apache-2.0. Kordoc, rhwp, hwpx-editing-skill, and other third-party components remain under their original copyrights and licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
