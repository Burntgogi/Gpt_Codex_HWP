# Changelog

This file records release tags and their publication status. Work under `Unreleased` is not a release claim.

## [Unreleased]

- Update source and generated-runtime dependencies to fast-uri 3.1.8 and
  markdown-it 14.3.1 for GHSA-hrr3-gc8f-f4qj and GHSA-253c-mchw-3w2r.
- Record runtime preparation failures and fixed, redacted process failure
  reasons in CI smoke and release diagnostics. Intermittent Windows failures
  are still under investigation; this change makes subsequent failures
  distinguishable without exposing raw process output.
- Lower the CI-verified document tier from 100 MiB to 10 MiB. Most Hangul
  documents finish around 1 MiB, so the weekly Compatibility workflow and the
  release gate now run the 10 MiB production one-shot smoke. Documents over
  10 MiB through the unchanged 512 MiB safety ceiling are theoretically
  supported but not verified size by size; `--large-detect 100` remains an
  optional local experiment.
- Reject Windows network (UNC) paths unless an allowed root names that UNC
  share, and accept `.`/`..` relative components that were wrongly rejected
  on Windows.
- Resolve the image-helper Python from a shared list of trusted absolute
  locations (also used by doctor), return `PYTHON_NOT_FOUND` when none exists,
  and pass helper failures such as `ANCHOR_NOT_FOUND` and `INVALID_IMAGE`
  through instead of `ENGINE_PROTOCOL_ERROR`.
- Count only `Contents/sectionN.xml` when resolving image anchors, matching
  the Python helper, and parse `header.xml` with the DTD-rejecting XML policy.
- Scope hosted-CI pass statements to the release commit they describe, and
  give long-running source test files a larger per-file budget.
- Update @modelcontextprotocol/sdk to 1.32.1 (GHSA-6qxp-vccf-f47h) and
  override proxy-addr to 2.0.8 (GHSA-jqcg-44mw-7w3h). The plugin uses neither
  the OAuth client nor an HTTP server, but the production audit gate now
  passes again.
- Add the optional `korean-official-doc` plugin to both marketplaces: an
  offline, dependency-free linter for 공문서 Markdown drafts that checks date,
  time, and amount notation, item-symbol order, 붙임, and the 「끝」 mark with
  citations to 「행정업무의 운영 및 혁신에 관한 규정」 and its 시행규칙.
  Gpt_Codex_HWP recommends it after installation but never installs it.
- Update the optional @rhwp/core preview and parsing fallback from 0.7.17 to
  0.8.7 (MIT). The APIs this plugin calls are unchanged; the HWP fixture,
  rhwp backend, read-worker, and installed-runtime checks pass.
- Report a fixed, path-free reason with one-shot exit 2
  (`ONESHOT_INVOCATION_ERROR reason=REQUEST_INVALID` and similar).
- When a write fails after outputs were reserved, empty the reserved files
  through their own handles so no truncated document survives, and say that
  an empty placeholder remains at the output path.
- Accept Windows 8.3 short-name paths that contain no links and the macOS
  `/tmp`, `/var`, and `/etc` system aliases by rewriting them to their
  canonical form instead of rejecting them as linked paths.
- Document that macOS process supervision uses Python, and give doctor a
  macOS-specific remediation for `PYTHON_UNAVAILABLE`.
- Count the bytes a ZIP entry actually decompresses to when reading the
  protection manifest, header.xml, and sections, instead of trusting the
  size declared in the ZIP headers.
- Remove unused source (`path-policy.ts`, three test-only path helpers, and
  `scripts/verify-runtime-diff.mjs`).
- Stabilize hosted test runs: retry recursive cleanup, align ACL helper
  timeouts with the product, wait for the CIM process monitor before
  starting the helper, and give desktop CI jobs a 90-minute budget.
- Allow work-in-progress entries under Unreleased in the release identity
  test, refresh stale README statements, extend `.gitignore`, and mark the
  generated runtime as generated for GitHub.

## [0.2.7] - 2026-09-29

- Fixed the dependency advisories reported in issue #18. Updated
  @xmldom/xmldom, sharp, fast-uri, hono, qs, and ip-address in the source
  and generated-runtime dependency graphs; both production audits now report
  zero known vulnerabilities.
- Enabled well-formed XML serialization for the HWPX font-integrity path while
  preserving valid UTF-8 XML declarations and the existing document contract.
- Fixed dependency audit reporting so it includes every advisory without
  duplicate rows across source and runtime locks.
- Assigned a new plugin build identity so this release cannot reuse the
  published v0.2.5 runtime directory.

## [0.2.6] - 2026-09-29

- Preserved this immutable tag as an unpublished candidate. Its GitHub squash
  commit did not meet the release artifact builder's author and committer
  identity requirement, so the release gate stopped before attestation.
  No GitHub Release or distribution assets were published for v0.2.6.
- The dependency and document fixes were carried into v0.2.7 without changing
  their behavior.

## [0.2.5] - 2026-08-10

- Replaced the monolithic release Node test stage with a bounded per-file runner
  over the exact 26 repository and 41 source test files. Inventory drift fails
  closed, fixed privacy-safe receipts are preserved, and no tests or coverage
  were removed.
- Reused the bounded Windows descendant-tree terminator for every isolated Node
  and SVG path and now waits for both child close and termination settlement.
- Made the synthetic Git-history mode-120000 checkout independent of the host's
  `core.symlinks` setting without weakening the committed-tree policy check.
- User runtime and tool behavior are unchanged from the v0.2.4 candidate.

## [0.2.4] - 2026-08-09

- Preserved this immutable tag as an unpublished candidate after the hosted
  Windows release gate exposed another execution-portability boundary; no GitHub Release or distribution assets were created for v0.2.4.
- Superseded the immutable, unpublished v0.2.3 candidate without publishing it.
- Made the installed-runtime failure receipt portable by validating its
  environment-dependent stderr byte count within the existing bound instead of
  requiring one exact value. User runtime and tool behavior are unchanged from
  the v0.2.3 candidate.

## [0.2.3] - 2026-08-08

- Preserved this immutable tag as an unpublished candidate after the hosted
  Windows release check exposed a portability-only assertion; no GitHub Release
  or distribution assets were created.
- Serialized repository Node test files to prevent shared runtime projection
  races and reduce peak CI process count.
- Added a bounded first-failure phase and TAP ordinal to release verification
  without exposing raw output, paths, environment variables, or document data.
- Prepared installation guidance for the candidate one-shot lifecycle and
  retained all nine internal one-shot contracts.
- Added an explicit verified runtime installer outside the Codex-managed cache
  so plugin cache rehydration does not remove production dependencies.
- Canonicalized hosted-runner temporary roots before installed-runtime work.
- Aggregated worker-only, child-only, and mixed cleanup receipts fail-closed
  and verified zero remaining supervised process trees.
- Updated source and generated-runtime locks to `fast-uri 3.1.5`, `hono 4.13.1`,
  and `ip-address 10.4.0`, with zero known production vulnerabilities.

## [0.2.2] - 2026-08-01

- Added bounded Windows x64, macOS arm64, Linux, and Security pull-request
  gates plus a scheduled/manual full compatibility workflow.
- Established 100 MiB as the CI-verified document support envelope while
  retaining 256 and 512 MiB as explicit, non-guaranteed local experiments.
- Fixed installed-runtime smoke initialization on hosted Windows and macOS by
  reusing the verified canonical temporary root instead of its runner alias.
- Added privacy-safe lifecycle diagnostics, exact process-cleanup receipts,
  stale-run cancellation, and fail-closed release preflight handling.
- Fixed valid GPG-signed commits with empty signature continuation lines being
  misclassified as malformed Git history during the public-history scan.
- Replaced default persistent MCP registration with nine internal one-shot
  contracts while retaining explicit manual MCP compatibility for all nine.

## [0.2.1] - 2026-07-22

- Published the first public 0.2 series release without changing immutable
  v0.1.0-v0.1.4 release bytes.
- Pinned the MCP SDK's transitive `@hono/node-server` adapter to security-fixed
  2.0.11 and verified zero known production vulnerabilities in source and
  compact runtime locks.
- Moved release-subject generation to the validated Windows x64 gate and
  parameterized immutable tag, exact SHA, and SemVer attestation inputs.
- Preserved `v0.2.0` as an unpublished candidate tag after the security
  advisory appeared; no GitHub Release was created for that candidate.

## [0.2.0] - 2026-07-22

- Tagged a release candidate that was withdrawn before publication after a new
  production dependency advisory appeared.
- Added SHA-pinned Windows x64, macOS arm64, and Security policy gates plus a
  non-publishing artifact attestation workflow and declarative repository policy.
- Added public-source hardening, governance controls, reproducible ZIP/SBOM/
  provenance artifacts, and an actual generated HWPX result preview.

## [0.1.4] - 2026-07-13

- Published the Windows x64 validated HWP-read-only/HWPX-write release.
- Added authenticated Kordoc 3.18.1 provenance, compact runtime dependencies,
  release privacy checks, and exact nine-tool smoke verification.

## [0.1.3] - 2026-07-13

- Prepared an immutable installation target and clarified tag-pinned installation.

## [0.1.2] - 2026-07-13

- Corrected release and installation metadata for the packaged runtime.

## [0.1.1] - 2026-07-13

- Added agent-assisted installation guidance and aligned the packaged MCP server
  version with release metadata.

## [0.1.0] - 2026-07-12

- Published the initial Windows x64 validated Gpt_Codex_HWP release.

[Unreleased]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.7...HEAD
[0.2.7]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.2.0
[0.1.4]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.4
[0.1.3]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.3
[0.1.2]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.2
[0.1.1]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.1
[0.1.0]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.0
