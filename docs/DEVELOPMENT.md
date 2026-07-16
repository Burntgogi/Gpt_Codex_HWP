# Development

## Reproducible source workflow

The authoritative implementation lives under `packages/gpt-codex-hwp` and in
the repository `scripts`. The committed `plugins/gpt-codex-hwp` directory is a
generated runtime projection. Do not edit generated runtime files directly.
Use test-driven development: first add and run a focused test that demonstrates
the failure, change authoritative source, then run the focused test and the full
suite. Security-boundary changes require adversarial regression tests and owner
review.

```powershell
npm ci --prefix packages/gpt-codex-hwp --ignore-scripts
npm run build
npm test
npm run test:python
npm run security:scan-tree
npm run runtime:write
npm run runtime:check
npm run release:artifacts
npm run release:verify
```

Runtime projection is an explicit step because end-user README and third-party
notice changes are shipped, while contributor documents, tests, fixtures, and
benchmark receipts are not. Review both source and generated diffs. The public
contract remains exactly nine MCP tools, classic HWP read-only input, and HWPX
output for every new or modified document. See [Architecture](ARCHITECTURE.md)
and [Contributing](../CONTRIBUTING.md).

## Document benchmark modes

The bounded document benchmark is engineering evidence for the production
isolation policy. It is not an MCP tool and does not promise that every file at
the 512 MiB source ceiling can be processed successfully.

The ordinary local, CI, and release check runs only the 10 MiB case:

```powershell
npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 10 --output .superpowers/benchmarks/10m.json
```

This case runs the production `detectFormat` engine operation and demonstrates
the transferable-worker route. The receipt is written
only below a Git-ignored directory and records sizes, timings, bounded resource
measurements, status codes, and hashes. It never records document content,
values, anchors, user paths, temporary paths, or raw errors.

Provisioned hosts can collect the larger cases sequentially:

```powershell
$env:HWP_BENCH_LARGE = "1"
npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 100,256,512 --output .superpowers/benchmarks/large.json
Remove-Item Env:HWP_BENCH_LARGE
```

Do not enable this mode in ordinary pull requests. Each case runs in a fresh
orchestrator process with concurrency fixed at one. The 100 and 256 MiB cases
are descriptor-transport and supervised-child evidence; they are not proof that
Kordoc can parse document content above its own 100 MiB decompression guard.
The post-case probe performs a small normal parse/read to prove the engine still
serves ordinary work. The source fixture and all
engine inputs live in a fresh owned temporary directory below the ignored
output directory and are removed in `finally`. Delete old ignored receipts when
they are no longer needed.

For a public-release evidence gate, set `HWP_BENCH_REQUIRE_LARGE=1`. The release
verifier then checks the exact large receipt schema, order, and freshness. Set
`HWP_BENCH_LARGE_EVIDENCE` only when the ignored receipt is not at the default
`.superpowers/benchmarks/large.json` location.

Windows x64 is the currently exercised and verified device class. macOS Apple
Silicon remains a compatibility target with unverified-device status; no
completed macOS capacity or Hancom Office claim is made.
