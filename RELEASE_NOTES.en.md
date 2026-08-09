# Gpt_Codex_HWP v0.2.4 Release Notes

- Status: final release
- Date: 2026-08-09
- Validation baseline: Windows x64 development and real-document checks; physical Mac unverified

[한국어](RELEASE_NOTES.md) | [README](README.en.md)

## Overview

v0.2.4 retains v0.2.2's read-only HWP policy, HWPX writing, and all nine internal one-shot tool contracts while adding explicit runtime installation that survives Codex-managed cache rehydration. The immutable `v0.2.3` tag was preserved as an unpublished candidate after a hosted-Windows release-check portability issue was found; no GitHub Release or distribution assets were created for it. v0.2.4 corrects only that verification issue and does not change user runtime or tool behavior from the v0.2.3 candidate.

## Main changes

- Repository Node test files now run serially so `runtime-projection` cannot replace the shared `plugins/gpt-codex-hwp` tree while installed-runtime smoke tests use it.
- Hosted-runner temporary-path aliases are normalized to the verified canonical temporary root.
- Environment- and path-length-dependent stderr byte counts are validated within the `1` through `65,537` bound instead of against one exact value. Fixed stage and boundary checks, raw-output redaction, and child-process cleanup remain required.
- Release verification now emits only the first safe phase and TAP ordinal on failure. It never publishes raw errors, user paths, PIDs, environment variables, or document content.
- A verified runtime is installed atomically outside the managed plugin cache, scoped by full plugin version, platform, architecture, and Node major. Node 22 and Node 24 in one Codex profile do not replace each other's runtime. Cache rehydration reuses the matching runtime, while document operations perform no installation or network access.
- Worker-only, child-only, and mixed cleanup receipts are aggregated fail-closed, and the runtime verifies zero remaining supervised process trees.
- Source and generated-runtime locks now use `fast-uri 3.1.5`, `hono 4.13.1`, and `ip-address 10.4.0`; both production audits report zero known vulnerabilities.
- The Windows PowerShell ACL helper now allows a 15-second cold-start window under host load. The applied DACL and allowed principals are unchanged.
- Public stable-install guidance now targets v0.2.4 and its default one-shot lifecycle. The default installation does not register a persistent `gpt-codex-hwp` server in `/mcp`.
- The public v0.2.2 release and unpublished v0.2.3 candidate tag remain unchanged; v0.2.4 uses a new build ID.

## Verification evidence

- The public v0.2.2 ZIP SHA-256 matched the published `SHA256SUMS` manifest.
- A fresh-directory cold install passed all 11 required doctor checks, real HWP detection and reading, HWPX generation, and independent validation.
- The shared Codex v0.2.2 installed-runtime one-shot generated HWPX, validated it, and reported zero remaining supervised descendants.
- The parallel repository failure was reproduced locally; after restoring runtime dependencies, the affected smoke file passed all 28 tests, confirming a shared-tree race.
- An isolated Codex-home regression installed the runtime, rebuilt the managed cache without dependencies, reran doctor and real HWPX generation/validation, and retained the exact installation-receipt hash.
- The previously intermittent cache-rehydration regression passed three consecutive runs after the fix.
- A regression test now proves that Node 22 and Node 24 resolve to separate runtime paths in one Codex home and that installing one does not alter the other directory.
- Worker-only, child-only, and mixed one-shot cleanup paths produced valid aggregated receipts with zero remaining supervised process trees.
- On the final identity, the repository suite reported 453 total tests, 451 passed, 2 expected capability skips, and 0 failed; all 41 source Node test files passed. Python, public tree/history, runtime projection, release artifact, Windows x64, macOS arm64, Linux lifecycle, and Security policy gates also passed.

## User resource statement

There are zero persistent Gpt_Codex_HWP Node processes while the plugin is idle. Serial repository tests reduce concurrent Node processes in CI and development validation; they do not establish lower fixed RSS or installation size for user document work. No fixed RSS percentage or installation-size reduction is claimed.

## Installation and upgrade

When installing v0.2.4, first validate the returned `installedPath` against the path and plugin-identity rules, then run from that path:

```powershell
node dist/install-runtime.js --json
node dist/doctor.js --json
```

The first command must return JSON `code` `RUNTIME_INSTALL_OK`. Fully close and reopen every active Codex CLI and Desktop host. Run one document operation, require it to succeed, verify the generated output, and confirm that the one-shot process and its descendants exit. Document operations never install dependencies automatically; on `RUNTIME_NOT_INSTALLED`, explicitly rerun the installer from the validated `installedPath`. The v0.2.2 direct installation inside the managed cache was not durable across cache rehydration, so keep the older working version until v0.2.4 passes the restart check.

Production dependencies remain at `$CODEX_HOME/plugin-runtime-data/gpt-codex-hwp/<full-plugin-version>/<platform>-<arch>-node<Node-major>`. To clean up after removing a plugin, close every Codex host and manually remove only the exact full-plugin-version directory that is no longer used. This release intentionally provides no automatic recursive deletion command.

## Compatibility and known limitations

- Development and real HWP/HWPX validation were performed on Windows x64.
- macOS Apple Silicon is a compatibility target, but Codex Desktop and Hancom Office Hangul remain unverified on a physical Mac.
- HWP 5.x is read-only and generated or edited results are HWPX. HWP 3.x has no real fixture and is not guaranteed.
- Documents through 100 MiB are in the CI-verified envelope. Over 100 MiB through 512 MiB is non-guaranteed best-effort; over 512 MiB is rejected.
- Protected, encrypted, signed, and DRM documents are not bypassed.
- Font files are not bundled, installed, or embedded.

## License and acknowledgements

Project code is distributed under Apache-2.0. Kordoc, rhwp, hwpx-editing-skill, and other third-party components remain under their original copyrights and licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

These notes accompany the `v0.2.4` release.
