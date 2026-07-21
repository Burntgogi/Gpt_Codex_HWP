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

The larger 100/256/512 MiB benchmark is opt-in and must run sequentially as
described in [Development](docs/DEVELOPMENT.md). It is not an ordinary pull-request
check.

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
