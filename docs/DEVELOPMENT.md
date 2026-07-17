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

Benchmark receipts use exact schema version 2. `dispatchStarted` changes from
false only when the isolated worker/child emits its initial zero-byte metric
immediately before the first engine execution. `copiedBytes` is an observed,
cumulative safe integer: exact-buffer and descriptor/spool snapshot ownership
report zero, and successful format detection reports one defensive copy equal
to the source length. Never derive this field from `actualBytes`, and never add
copy or RSS data to MCP responses.

RSS is owned by the outer supervisor, whose baseline is taken before inherited
case control is released. Sampling uses a configured nominal cadence: 20 ms on
Windows, 25 ms through Linux `/proc/<pid>/task/*/children` plus `VmRSS`, and
100 ms with bounded macOS `ps`. Scheduler delay and the work performed by a
sample can make observations later than that configured cadence. Sampler
processes are outside the target tree. macOS topology/RSS from `ps` is paired
with microsecond `libproc` start identity; Windows keeps one synchronized
process handle per retained identity. PID plus creation/start identity must be
preserved until every retained identity is proven gone; missing process facts,
incomplete fd4 telemetry, or an unverified termination invalidates the run
rather than producing estimates.

## Child lifecycle descriptors and proof scope

The supervised child owns no caller-selected filesystem path. Descriptor
numbers are local to each spawned process and must not be conflated. For an
ordinary document child, the document and optional image inputs are inherited
on fd 3 and fd 4; fd 5 is a parent-owned result spool created before spawn that
the child may write; fd 6 carries bounded child-to-parent control frames; and
fd 7 is the parent-owned start gate and then the parent-lifeline.

The outer benchmark case has a separate descriptor namespace. Its fd 3 reads
the one-shot ownership/control frame and fd 4 writes case telemetry. On POSIX,
fd 5 is the registration-writer endpoint held by the case and inherited by its
nested document children; the outer benchmark parent owns the reader endpoint.
The case's fd 6 is the ACK-reader endpoint inherited by those children; the
outer benchmark parent owns the writer endpoint. The case maps its fd 5 and fd 6
to a nested document child's benchmark-only fd 8 registration-writer and fd 9
ACK-reader, respectively. That mapping does not replace the nested child's own
fd 5 result spool, fd 6 control stream, or fd 7 start gate/lifeline. These
descriptors are private transport and never MCP response fields. Lifecycle
control and registration frames carry neither user paths nor document content.

The child registers first when registration descriptors are present, waits for
one exact START frame on fd 7 only after the parent has obtained supervision,
and receives the document request only after that gate succeeds. After START,
fd 7 remains a lifeline: data, error, or parent-close is terminal and causes a
fail-closed exit. The parent closes the gate on startup, deadline, cancellation,
or supervision failure and retains resources until a typed termination receipt
is available.

Termination evidence is deliberately narrow. The only successful proof values
are `windows-job-empty` and `registered-groups-empty`; any missing, malformed,
identity-mismatched, timed-out, permission-denied, or poisoned registration
channel produces `unverified` with a bounded reason. Registration is cleanly
sealed only after closing has begun, the case has exited, the registration input
has ended without partial frames or in-flight work, and the acknowledgement side
has closed. These receipts apply only to groups and identities accepted by this
repository-controlled registration lifecycle.

This lifecycle is a reliability and cleanup mechanism, not a security sandbox.
It does not grant protection from a hostile document or a same-user process;
run untrusted inputs under an appropriate least-privilege OS account or sandbox.

For a public-release evidence gate, set `HWP_BENCH_REQUIRE_LARGE=1`. The release
verifier then checks the exact large receipt schema, order, and freshness. Set
`HWP_BENCH_LARGE_EVIDENCE` only when the ignored receipt is not at the default
`.superpowers/benchmarks/large.json` location.

Windows x64 is the currently exercised and verified device class. macOS Apple
Silicon remains a compatibility target with unverified-device status; no
completed macOS capacity or Hancom Office claim is made.
