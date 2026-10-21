# Contributing

Thank you for helping improve Gpt_Codex_HWP. Public issue and pull-request
discussion is welcome. Do not attach private documents, credentials, personal
paths, environment files, or other sensitive data. Report vulnerabilities by
the private process in [SECURITY.md](SECURITY.md).

## Repository mutation policy

The repository owner authors and pushes every commit that changes an official
branch, tag, release, vendored runtime, or generated distribution. External
contributors may describe a problem, propose a diff, or discuss a pull request;
the owner independently reviews, reproduces, and authors any accepted repository
mutation. Automation may report status or open an advisory issue, but it must not
create branches, commit, push, merge, or publish releases. Sensitive paths in
`.github/CODEOWNERS` require owner review.

GitHub Dependabot vulnerability alerts may remain enabled as read-only signals.
Dependabot update and security pull requests are disabled because they create
bot-authored commits. The scheduled dependency audit opens or updates only an
issue containing package, current version, patched version, and advisory link.
Pinned workflow action revisions are changed only in an owner-authored commit.

## Local workflow

Use Node.js 22 or later. Install source dependencies without lifecycle scripts:

```bash
npm ci --prefix packages/gpt-codex-hwp --ignore-scripts
```

Use test-driven development (TDD): add a focused failing test, record the RED
failure, make the smallest source change, and record GREEN verification. Treat
documents, archives, paths, child-process output, repository files, and dependency
metadata as untrusted input. Security fixes require adversarial tests for their
trust boundary and must fail closed without printing secrets or document content.

Run the public checks from the repository root:

```bash
npm run build
npm test
npm run test:python
npm run security:scan-tree
npm run security:scan-history
npm run runtime:write
npm run runtime:check
npm run release:artifacts
npm run release:verify
```

Pull requests use the 10 MiB smoke case. The weekly and manually dispatched
`Compatibility` workflow requires one fresh, passed 10 MiB receipt on each
platform path. Immutable release verification generates and validates the same
single passed 10 MiB evidence before the complete release gate, artifact
verification, checksums, and attestation. The 100, 256, and 512 MiB cases are
explicit local experiments only and must run sequentially as described in
[Development](docs/DEVELOPMENT.md). The
synthetic benchmark exercises the size-handling, isolation, cleanup, and
recovery path; it does not prove every document format or MCP operation at the
requested size.

Most Hangul documents finish around 1 MiB and rarely exceed 10 MiB, so the
size policy has two tiers. Valid documents up to and including 10 MiB are the
default, CI-verified support tier, subject to malformed-archive rejection,
decompression and resource policies, and allowed-root policy. Documents over
10 MiB through the 512 MiB safety ceiling are theoretically supported: they use
the same code path, but no hosted job verifies them size by size and they carry
no compatibility guarantee. Files over 512 MiB are rejected.

## CI verification ownership

The protected pull-request checks keep the stable names `Windows x64`,
`macOS arm64`, `Linux lifecycle`, and `Security policy`. The two desktop
platform jobs are intentionally fast PR gates. In order, each installs source
dependencies, builds, checks the generated runtime projection, performs a fresh
production-only runtime install, runs the bounded installed-runtime smoke,
classifies the hosted platform boundary, runs its PR Node profile, runs the
Python suite, and executes exactly the 10 MiB document smoke. Windows uses
`test:pr` and therefore retains the `bp16` child-tree case; macOS uses
`test:pr:macos` and defers that hosted-runner-sensitive stress case.

`Linux lifecycle` retains the bounded registration, document-child, and
benchmark-policy suite. `Security policy` separately owns repository and
dependency policy. The scheduled/manual Compatibility workflow installs source
and public-runtime dependencies, then runs only the exact 10 MiB production
one-shot smoke on Windows x64, Linux x64, and macOS arm64. Stable Node, Python,
runtime, and platform profiles remain in required CI; full release-candidate,
artifact, and attestation verification remains in the immutable release gate.

The optional `run_bp16_stability` dispatch input creates 20 independent
`macos-15` jobs, each running the exact `bp16` case once. Enable it only after
production process-cleanup semantics change. Scheduled runs never enable it,
and receipt, profile, documentation, or workflow-only changes do not justify
it. The 100, 256, and 512 MiB experiments remain outside every hosted compatibility
or release gate.

If the release 10 MiB preflight fails, the job stops there: the complete
release gate, candidate construction, and attestation do not run, and no
follow-up diagnostic can restore success. Duplicate manual verification for the
same immutable tag and SHA is serialized without cancelling an execution that
already started. If the gate fails for a reason unrelated to the tagged code
(for example a hosted-runner timing failure that passes on rerun), dispatch
`release-verify.yml` again with the same tag and SHA after recording the cause;
do not cut a new version for an unchanged tree.

PR concurrency is scoped by workflow plus PR number or ref. Compatibility
concurrency additionally includes the event name: a newer scheduled run may
cancel an older scheduled run on the same ref, while manual compatibility,
push, release, and dependency work remain separate.

## Source and generated runtime

`packages/gpt-codex-hwp` and `scripts` are the authoritative source tree.
`plugins/gpt-codex-hwp` is a generated runtime projection, including its
`.claude-plugin/plugin.json`. Never edit the generated runtime directly.
The root marketplaces (`.agents/plugins/marketplace.json`,
`.claude-plugin/marketplace.json`) and `plugins/korean-official-doc` are
hand-maintained source. When `korean-official-doc` content changes, bump the
version in both of its manifests and record the new content hash in
`tests/repository-layout.test.mjs`; hosts cache installed plugins by version. Change source or end-user documentation, run
`npm run runtime:write`, review the projection, and require
`npm run runtime:check` to pass. Contributor-only documentation, tests, fixtures,
private plans, benchmark receipts, and temporary artifacts must not enter the
runtime.

The public MCP surface is exactly nine tools. Classic binary HWP is read-only;
new and modified documents are written only as HWPX. Changes to those contracts,
the hybrid Kordoc/rhwp boundary, document limits, release scripts, security policy,
Kordoc vendor/provenance, or the runtime generator require explicit owner review.

## Licensing

Project-authored code is offered under [Apache-2.0](LICENSE). Upstream and adapted
components retain their own copyright and license terms. Preserve notices and see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before copying or updating
Kordoc, rhwp, hwpx-editing-skill, or another third-party component.

## Release publication handoff

### v0.3.2 publication procedure

Use plugin `0.3.2+codex.20261021115738` and Claude cache `0.3.2-codex.20261021115738`. Preserve published v0.3.1. After all required checks and owner review, tag only the exact neutral-author/committer release commit whose tree matches merged main. Never move an existing tag. Resolve `v0.3.2^{commit}` to its exact 40-character SHA and dispatch the workflow **at that tag**, not at main with only a checkout override:

```bash
gh workflow run release-verify.yml --repo Burntgogi/Gpt_Codex_HWP --ref v0.3.2 \
  -f release_ref=v0.3.2 \
  -f expected_release_sha="$(git rev-parse 'v0.3.2^{commit}')" \
  -f release_version=0.3.2
```

Require the full build gate and all three attestation steps. Publish only that same run's `gpt-codex-hwp-0.3.2.zip`, `gpt-codex-hwp-0.3.2.spdx.json`, `provenance.json` and `SHA256SUMS`. Independently verify checksums, exact repo/source SHA/ref/workflow@tag, GitHub-hosted runner and certificate run invocation; compare actual installed-cache bytes against the verified ZIP before runtime/doctor/document smoke. No local rebuild, repackage, synthetic RSS or incomplete cleanup is acceptable evidence. Record actual results in the GitHub Release after observing them; do not infer publication or physical Mac use from CI.

### Historical v0.3.1 publication

The [published v0.3.1 security release](https://github.com/Burntgogi/Gpt_Codex_HWP/releases/tag/v0.3.1) uses plugin version `0.3.1+codex.20261021043114` and Claude Code cache directory `0.3.1-codex.20261021043114`. Its immutable owner-authored commit is `4180a8d35e01aa95205a39c60ae9686486f6f9cb`; its tree matched merged main `633421e39e0ecad35817bcfe8b061f7b80da7ea8` before tagging. [Full gate and attestation run 39589053351](https://github.com/Burntgogi/Gpt_Codex_HWP/actions/runs/39589053351) passed with the exact inputs below. Do not recreate or move this tag. For a later release, choose a new version and preserve published tags and historical verification records. The artifact builder checks both author and committer against the neutral release identity; GitHub squash merge commits fail that check. A reviewed owner-authored release commit must match the intended merged tree before publication.

```text
release_ref=v0.3.1
expected_release_sha=4180a8d35e01aa95205a39c60ae9686486f6f9cb
release_version=0.3.1
```

Publish only after both build and attestation jobs succeed. Use only `gpt-codex-hwp-0.3.1.zip`, `gpt-codex-hwp-0.3.1.spdx.json`, `provenance.json`, and `SHA256SUMS` from the same workflow artifact. Never rebuild, repackage, or substitute local files for those verified outputs. Update candidate-status wording only after observing the corresponding checks and publication; never infer physical Mac validation from hosted macOS CI.

The attested archive covers only the `gpt-codex-hwp` runtime. The root
marketplaces and `plugins/korean-official-doc` reach users only through the
Git tag a marketplace is pinned to; the public-tree privacy scan covers them,
but they are not part of the archive, SBOM, provenance, or attestation.
