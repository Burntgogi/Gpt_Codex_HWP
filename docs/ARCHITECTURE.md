# Architecture

## Distribution boundary

The authoritative source tree is `packages/gpt-codex-hwp` plus the repository
scripts that verify, project, and package it. `plugins/gpt-codex-hwp` is the
generated runtime consumed by Codex. It contains compiled JavaScript, the compact
vendored Kordoc Core, runtime Python helpers, skill assets, manifests, locked
production dependencies, and selected end-user documentation. It deliberately
excludes TypeScript source, tests, fixtures, contributor documents, release
scripts, private plans, benchmark receipts, and temporary artifacts.

Do not edit the generated runtime. `npm run runtime:write` builds a fresh staged
projection from source, verifies it, and atomically promotes it. A clean
`npm run runtime:check` proves that committed runtime bytes match a fresh build.

## Public MCP surface

The server registers exactly these nine tools:

1. `hwp_create_svg_asset`
2. `hwp_detect_format`
3. `hwp_fill_form`
4. `hwp_generate_hwpx`
5. `hwp_insert_image`
6. `hwp_patch_document`
7. `hwp_read`
8. `hwp_render_preview`
9. `hwp_validate`

Classic binary HWP is a read-only input: it can be detected, read, and previewed,
but it is never generated, patched, or exported. HWPX is the only write/output
document format. Reading an HWP and authoring a separate HWPX is not a byte-exact
conversion claim.

## Hybrid engine boundary

The hybrid engine uses the authenticated compact Kordoc Core for format detection,
HWP/HWPX reading, Markdown-to-HWPX generation, validation, and SVG preview.
Optional rhwp provides a second read-only HWP/HWPX parsing and preview path. The
project orchestration layer owns path authorization, protection refusal, resource
limits, child-process supervision, non-overwrite publication, and post-write
validation. Upstream parser success does not bypass those controls, and a preview
is not a pixel-accurate Hancom Office rendering guarantee.

Document operations run through isolated worker threads or supervised child
processes. Large inputs use descriptor transport rather than copying an entire
source buffer into a worker. The caller receives bounded status codes; raw child
errors, environment values, absolute paths, and document content are not emitted
as diagnostics.

## Capacity contracts

The limits are independent safety boundaries, not one interchangeable quota:

- 512 MiB is the outer source-file ceiling, not a promise that every file parses.
- 64 MiB bounds worker input copied inline and worker inline results; larger safe
  inputs use descriptor or supervised-child paths.
- 8 MiB bounds the aggregate serialized MCP response.
- 64,000 JavaScript string characters bound inline Markdown; a new derived
  Markdown output path supports larger read results without reparsing the source.
- 1536 MiB is the supervised-child working-set policy.

Kordoc has separate engine limits, including its current 100 MiB decompression
guard and 500-entry HWPX guard. A resource refusal is a bounded result, not proof
of capacity. See [Performance](PERFORMANCE.md) for evidence semantics.

## Trust and release flow

User paths, document containers, ZIP/XML content, images, child processes, npm
metadata, vendored bytes, and repository history are untrusted. The optional
allowed-root policy, protection checks, ZIP/path defenses, process isolation,
semantic verification, public-content scans, and deterministic release checks are
defense-in-depth; hostile documents still belong in an OS sandbox or separate
least-privilege account.

Project-authored code is Apache-2.0. Kordoc, rhwp, adapted hwpx-editing-skill
material, and other dependencies preserve their upstream licenses and notices in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Windows x64 is the verified
development platform. macOS Apple Silicon is a compatibility target, but device
and Hancom Office behavior remain unverified until an exact-HEAD receipt exists.
