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
size-handling and isolation policy. It is not an MCP tool. Its synthetic HWPX
fixture exercises transport, `detectFormat`, process cleanup, and a normal
recovery probe; it does not prove that every document format or every MCP
operation succeeds at the requested size.

The ordinary pull-request smoke runs only the 10 MiB case:

```powershell
npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 10 --output .superpowers/benchmarks/10m.json
```

This case runs the production `detectFormat` engine operation and demonstrates
the transferable-worker route. The receipt is written
only below a Git-ignored directory and records sizes, timings, bounded resource
measurements, status codes, and hashes. It never records document content,
values, anchors, user paths, temporary paths, or raw errors.

The scheduled/manual `Compatibility` workflow generates and validates exactly
one fresh, passed 100 MiB receipt. Immutable release verification uses the same
single-100 MiB contract at
`.superpowers/benchmarks/release-supported-100.json` before the complete
release verifier, checksummed artifact verification, and attestation. The
historical `HWP_BENCH_LARGE` plumbing name remains for compatibility:

```powershell
$env:HWP_BENCH_LARGE = "1"
npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 100 --output .superpowers/benchmarks/supported-100.json
Remove-Item Env:HWP_BENCH_LARGE
npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --validate-large .superpowers/benchmarks/supported-100.json
```

The 256 and 512 MiB cases remain available only as explicit local experiments.
They are schema-validated diagnostics, may pass, fail, or report
`resource-refused`, and never satisfy or fail the required release evidence:

```powershell
$env:HWP_BENCH_LARGE = "1"
npm --prefix packages/gpt-codex-hwp run benchmark:documents -- --sizes 256,512 --output .superpowers/benchmarks/experimental-256-512.json
Remove-Item Env:HWP_BENCH_LARGE
```

Do not enable the experimental cases in hosted CI or ordinary pull requests.
Each case runs in a fresh orchestrator process with concurrency fixed at one.
The descriptor-transport and supervised-child evidence does not prove that
Kordoc can parse document content above its own 100 MiB decompression guard.
Kordoc 3.18.1 also limits HWPX packages to 500 entries. The post-case probe
performs a small normal parse/read to prove the engine still serves ordinary
work. The source fixture and all
engine inputs live in a fresh owned temporary directory below the ignored
output directory and are removed in `finally`. Delete old ignored receipts when
they are no longer needed.

Valid documents up to and including 100 MiB are in the CI-verified support
envelope, subject to malformed-archive rejection, decompression and resource
policies, and allowed-root policy. Documents over 100 MiB through the 512 MiB
safety ceiling are best-effort and carry no compatibility guarantee. Files over
512 MiB are rejected.

## CI gate ownership

The required pull-request jobs and their deliberately bounded responsibilities
are:

| Protected check | Pull-request responsibility |
| --- | --- |
| `Windows x64` | source install, build, `runtime:check`, fresh runtime production install, `verify:runtime-smoke`, Windows hosted classifier, `test:pr` (including `bp16`), Python, then one 10 MiB smoke |
| `macOS arm64` | the same ordered boundary with the macOS hosted classifier and `test:pr:macos`; the installed-runtime stress and hosted `bp16` stress are deferred |
| `Linux lifecycle` | the existing bounded registration, document-child, and benchmark-policy lifecycle suite |
| `Security policy` | repository privacy, dependency, generated-runtime, and workflow policy rather than platform compatibility |

The desktop PR jobs do not create platform receipts, build or verify release
artifacts, request attestation permissions, or generate 100/256/512 MiB
evidence. Their bounded installed-runtime smoke still initializes the exact
runtime manifest, verifies all nine tool schemas, and exercises SVG-to-PNG
Sharp behavior after a fresh production-only install. It is a bounded PR
substitute and does not restore the deferred full compatibility evidence.

The scheduled and manually dispatched compatibility responsibilities are:

| Compatibility job | Full-gate responsibility |
| --- | --- |
| `Windows full compatibility` | source install; generate then validate one passed 100 MiB receipt; create one Windows platform receipt |
| `macOS full compatibility` | the same 100 MiB and platform-receipt boundary on `macos-15` |
| `Linux full compatibility` | full Node profile, Python suite, and generate-plus-validate 100 MiB evidence once each; Linux has no platform-receipt implementation |
| `macOS bp16 stability N of 20` | manual-only exact `bp16` execution after production cleanup-semantics changes |

The Windows/macOS platform receipt invokes the complete release verifier. It
already owns the full Node and Python suites, temporary installed-runtime and
nine-tool verification, and `bp16`; no separate full test or `bp16` command is
allowed in those jobs. Only source dependencies are installed before the 100
MiB benchmark. npm automatically runs `prebenchmark:documents` and builds the
source, while the nine-tool stage builds and installs a fresh temporary public
runtime. Installing the checked-in plugin runtime separately would duplicate
that ownership.

Core validation steps use `continue-on-error` only to preserve later evidence
and diagnostics. The final `compatibility-gate.mjs` consumes the original
`steps.*.outcome` values and accepts only `success`; `failure`, `cancelled`,
`skipped`, missing, or unknown outcomes remain fatal. Node/Python/hosted-boundary
diagnostics run only after their matching failure and cannot change the final
decision. Exact benchmark JSON, platform receipts, and bounded diagnostic text
are uploaded for three days. No dependency tree, user document, runtime tree,
or raw `bp16` TAP is uploaded.

`run_bp16_stability` is a boolean manual-dispatch input. When true, exactly 20
independent `macos-15` matrix jobs run the anchored `bp16` case once each and
retain only a distilled bounded receipt. Scheduled runs cannot activate the
matrix. Enable it only when production process-cleanup semantics changed, not
for receipt, profile, documentation, or workflow-only changes. The 256 and 512
MiB cases remain local opt-in experiments outside every hosted compatibility
and release gate.

Release preflight is deliberately fail-closed. Its 100 MiB step is not
`continue-on-error`; on failure, only a bounded 10 MiB probe, the same
supported-evidence validator, the Windows hosted-boundary classifier, and a
three-day diagnostic artifact run. The original failed step keeps the job red,
so the full release gate, artifact construction, and attestation remain skipped.
Runs for the same immutable tag and SHA are serialized and never auto-cancel an
execution already in progress.

PR concurrency combines the workflow name with pull-request number or ref and
cancels only stale PR executions. Compatibility concurrency also includes the
event name and cancels only stale scheduled work on the same ref; manual runs
remain separate from scheduled, release, and dependency work.

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
fd 7 is a pipe on every platform. It buffers one exact START frame and then
remains open as the parent lifeline.

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
verifier then checks that the evidence contains exactly one fresh, schema-valid,
passed 100 MiB receipt. Set `HWP_BENCH_LARGE_EVIDENCE` only when the ignored
receipt is not at the default `.superpowers/benchmarks/supported-100.json`
location. The environment names remain unchanged for backward-compatible
internal plumbing. `Compatibility` uses
`.superpowers/benchmarks/compatibility-supported-100.json`; immutable release
verification uses `.superpowers/benchmarks/release-supported-100.json`.

Windows x64 is the currently exercised and verified device class. macOS Apple
Silicon remains a compatibility target with unverified-device status; no
completed macOS capacity or Hancom Office claim is made.
