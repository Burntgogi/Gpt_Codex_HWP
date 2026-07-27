# Changelog

This file records published tags. Work under `Unreleased` is not a release claim.

## [Unreleased]

- No unreleased changes.

## [0.2.2] - 2026-07-27

- Added bounded Windows x64, macOS arm64, Linux, and Security pull-request
  gates plus a scheduled/manual full compatibility workflow.
- Established 100 MiB as the CI-verified document support envelope while
  retaining 256 and 512 MiB as explicit, non-guaranteed local experiments.
- Fixed installed-runtime smoke initialization on hosted Windows and macOS by
  reusing the verified canonical temporary root instead of its runner alias.
- Added privacy-safe lifecycle diagnostics, exact process-cleanup receipts,
  stale-run cancellation, and fail-closed release preflight handling.

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

[Unreleased]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Burntgogi/Gpt_Codex_HWP/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.2.0
[0.1.4]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.4
[0.1.3]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.3
[0.1.2]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.2
[0.1.1]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.1
[0.1.0]: https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.1.0
