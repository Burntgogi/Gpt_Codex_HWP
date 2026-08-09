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
`Compatibility` workflow requires one fresh, passed 100 MiB receipt on each
platform path. Immutable release verification generates and validates the same
single passed 100 MiB evidence before the complete release gate, artifact
verification, checksums, and attestation. The 256 and 512 MiB cases are
explicit local experiments only and must run sequentially as described in
[Development](docs/DEVELOPMENT.md). The
synthetic benchmark exercises the size-handling, isolation, cleanup, and
recovery path; it does not prove every document format or MCP operation at the
requested size.

Valid documents up to and including 100 MiB are in the CI-verified support
envelope, subject to malformed-archive rejection, decompression and resource
policies, and allowed-root policy. Documents over 100 MiB through the 512 MiB
safety ceiling are best-effort and carry no compatibility guarantee. Files over
512 MiB are rejected.

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
and public-runtime dependencies, then runs only the exact 100 MiB production
one-shot smoke on Windows x64, Linux x64, and macOS arm64. Stable Node, Python,
runtime, and platform profiles remain in required CI; full release-candidate,
artifact, and attestation verification remains in the immutable release gate.

The optional `run_bp16_stability` dispatch input creates 20 independent
`macos-15` jobs, each running the exact `bp16` case once. Enable it only after
production process-cleanup semantics change. Scheduled runs never enable it,
and receipt, profile, documentation, or workflow-only changes do not justify
it. The 256 and 512 MiB experiments remain outside every hosted compatibility
or release gate.

If release 100 MiB preflight fails, the failed job still runs one 10 MiB probe,
the supported-evidence validator, and the Windows hosted-boundary classifier.
Those bounded diagnostics cannot restore success, and candidate construction or
attestation does not run. Duplicate manual verification for the same immutable
tag and SHA is serialized without cancelling an execution that already started.

PR concurrency is scoped by workflow plus PR number or ref. Compatibility
concurrency additionally includes the event name: a newer scheduled run may
cancel an older scheduled run on the same ref, while manual compatibility,
push, release, and dependency work remain separate.

## Source and generated runtime

`packages/gpt-codex-hwp` and `scripts` are the authoritative source tree.
`plugins/gpt-codex-hwp` is a generated runtime projection. Never edit the
generated runtime directly. Change source or end-user documentation, run
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

Create the immutable `v0.2.4` tag only at the exact intended 40-character commit SHA. Resolve that SHA with `git rev-parse 'v0.2.4^{commit}'`, then run `release-verify.yml` with these exact inputs:

```text
release_ref=v0.2.4
expected_release_sha=<the exact 40-character output of git rev-parse v0.2.4^{commit}>
release_version=0.2.4
```

Publish only after both build and attestation jobs succeed. Use only `gpt-codex-hwp-0.2.4.zip`, `gpt-codex-hwp-0.2.4.spdx.json`, `provenance.json`, and `SHA256SUMS` from the same workflow artifact. Never rebuild, repackage, or substitute local files for those verified outputs.
