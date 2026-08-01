# Gpt_Codex_HWP v0.2.3 Release Notes

- Status: pre-release candidate
- Date: 2026-08-01
- Validation baseline: Windows x64 development and real-document checks; physical Mac unverified

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Overview

v0.2.3 retains v0.2.2's read-only HWP policy, HWPX writing, and all nine internal one-shot tool contracts while adding explicit runtime installation that survives Codex-managed cache rehydration. It removes no user document feature or public tool.

## Main changes

- Repository Node test files now run serially so `runtime-projection` cannot replace the shared `plugins/gpt-codex-hwp` tree while installed-runtime smoke tests use it.
- Release verification now emits only the first safe phase and TAP ordinal on failure. It never publishes raw errors, user paths, PIDs, environment variables, or document content.
- A verified runtime is installed atomically outside the managed plugin cache in a versioned, platform-specific location. Cache rehydration reuses it, while document operations perform no installation or network access.
- Public stable-install guidance now targets v0.2.2 and its default one-shot lifecycle. The default installation does not register a persistent `gpt-codex-hwp` server in `/mcp`.
- The immutable v0.2.2 tag and release remain unchanged; this follow-up uses a new v0.2.3 build ID.

## Verification evidence

- The public v0.2.2 ZIP SHA-256 matched the published `SHA256SUMS` manifest.
- A fresh-directory cold install passed all 11 required doctor checks, real HWP detection and reading, HWPX generation, and independent validation.
- The shared Codex v0.2.2 installed-runtime one-shot generated HWPX, validated it, and reported zero remaining supervised descendants.
- The parallel repository failure was reproduced locally; after restoring runtime dependencies, the affected smoke file passed all 28 tests, confirming a shared-tree race.
- An isolated Codex-home regression installed the runtime, rebuilt the managed cache without dependencies, reran doctor and real HWPX generation/validation, and retained the exact installation-receipt hash.
- Before v0.2.3 release, serial repository tests, source Node tests, Python tests, public tree/history scans, and platform CI must pass again.

## User resource statement

There are zero persistent Gpt_Codex_HWP Node processes while the plugin is idle. Serial repository tests reduce concurrent Node processes in CI and development validation; they do not establish lower fixed RSS or installation size for user document work. No fixed RSS percentage or installation-size reduction is claimed.

## Installation and upgrade

To validate this candidate, first validate the returned `installedPath` against the existing path and plugin-identity rules, then run from that path:

```powershell
node dist/install-runtime.js --json
node dist/doctor.js --json
```

The first command must return JSON `code` `RUNTIME_INSTALL_OK`. Fully close and reopen every active Codex CLI and Desktop host. Run one document operation, require it to succeed, verify the generated output, and confirm that the one-shot process and its descendants exit. Document operations never install dependencies automatically; on `RUNTIME_NOT_INSTALLED`, explicitly rerun the installer from the validated `installedPath`. The v0.2.2 direct installation inside the managed cache was not durable across cache rehydration, so keep the older working version until the new candidate passes the restart check.

## Compatibility and known limitations

- Development and real HWP/HWPX validation were performed on Windows x64.
- macOS Apple Silicon is a compatibility target, but Codex Desktop and Hancom Office Hangul remain unverified on a physical Mac.
- HWP 5.x is read-only and generated or edited results are HWPX. HWP 3.x has no real fixture and is not guaranteed.
- Documents through 100 MiB are in the CI-verified envelope. Over 100 MiB through 512 MiB is non-guaranteed best-effort; over 512 MiB is rejected.
- Protected, encrypted, signed, and DRM documents are not bypassed.
- Font files are not bundled, installed, or embedded.

## License and acknowledgements

Project code is distributed under Apache-2.0. Kordoc, rhwp, hwpx-editing-skill, and other third-party components remain under their original copyrights and licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

These are pre-release candidate notes for `v0.2.3`. The current public stable release is `v0.2.2`.
