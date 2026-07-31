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

Hosted compatibility and immutable release verification use the installed
production one-shot path instead of the RSS benchmark supervisor. The smoke
generates one 100 MiB HWPX, calls `hwp_detect_format`, verifies the reported
format and size, proves the source SHA-256 is unchanged, and requires zero
remaining descendants:

```powershell
node scripts/installed-runtime-smoke.mjs --large-detect 100
```

The RSS benchmark remains a maintainer-only local measurement tool. Its receipt
is not a hosted compatibility or release gate.

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
| `Windows full compatibility` | source/runtime install; one 100 MiB production-path one-shot smoke; one Windows platform receipt |
| `macOS full compatibility` | the same 100 MiB and platform-receipt boundary on `macos-15` |
| `Linux full compatibility` | source/runtime install, full Node profile, Python suite, and one 100 MiB production-path smoke; Linux has no platform-receipt implementation |
| `macOS bp16 stability N of 20` | manual-only exact `bp16` execution after production cleanup-semantics changes |

The Windows/macOS platform receipt invokes the complete release verifier. It
already owns the full Node and Python suites, temporary installed-runtime and
nine-tool verification, and `bp16`; no separate full test or `bp16` command is
allowed in those jobs. Only source dependencies are installed before the 100
MiB production-path smoke. The smoke uses the checked-in public runtime after
one production-only dependency install, while the platform receipt separately
builds and verifies a fresh release candidate.

Core validation steps use `continue-on-error` only to preserve later evidence
and diagnostics. The final `compatibility-gate.mjs` consumes the original
`steps.*.outcome` values and accepts only `success`; `failure`, `cancelled`,
`skipped`, missing, or unknown outcomes remain fatal. Node/Python/hosted-boundary
diagnostics run only after their matching failure and cannot change the final
decision. Platform receipts and bounded diagnostic text are uploaded for three
days. No benchmark JSON, dependency tree, user document, runtime tree, or raw
`bp16` TAP is uploaded.

`run_bp16_stability` is a boolean manual-dispatch input. When true, exactly 20
independent `macos-15` matrix jobs run the anchored `bp16` case once each and
retain only a distilled bounded receipt. Scheduled runs cannot activate the
matrix. Enable it only when production process-cleanup semantics changed, not
for receipt, profile, documentation, or workflow-only changes. The 256 and 512
MiB cases remain local opt-in experiments outside every hosted compatibility
and release gate.

Release preflight is deliberately fail-closed. Its 100 MiB production-path
smoke is not `continue-on-error`; failure emits only a fixed bounded stage and
stops the full release gate, artifact construction, and attestation.
Runs for the same immutable tag and SHA are serialized and never auto-cancel an
execution already in progress.

PR concurrency combines the workflow name with pull-request number or ref and
cancels only stale PR executions. Compatibility concurrency also includes the
event name and cancels only stale scheduled work on the same ref; manual runs
remain separate from scheduled, release, and dependency work.

## CI resource measurement

The v0.2.2 workflow reduces maintainer CI work by moving full compatibility to
its post-merge owner, not by removing public MCP functionality. An ordinary
v0.2.1 desktop PR generated 100, 256, and 512 MiB on both Windows and macOS:
1,736 MiB in aggregate. v0.2.2 generates one 10 MiB case on each platform:
20 MiB in aggregate, a reduction of about 98.8%. Compatibility and immutable
release verification retain the required 100 MiB production-path smoke. The 256 and 512 MiB
cases remain explicit local experiments.

| Measurement | v0.2.1 baseline | v0.2.2 candidate | Change |
| --- | ---: | ---: | ---: |
| Synthetic large-document volume in an ordinary PR | 1,736 MiB | 20 MiB | About 98.8% less |
| Required platform CI wall time | 14m 22s | 8m 55s | About 37.9% less |
| Aggregate platform runner time | 20m 17s | 13m 56s | About 31.3% less |
| Windows x64 job | 14m 18s | 8m 51s | About 38.1% less |
| macOS arm64 job | 5m 12s | 4m 12s | About 19.2% less |
| Linux lifecycle job | 47s | 53s | 6s longer |
| Security policy job | 36s | 28s | About 22.2% less |

Timings use passing v0.2.1 run `29861590295`, v0.2.2 candidate run
`30250809345`, and their job start/completion timestamps. Security compares
runs `29861590517` and `30250809321`. GitHub runner load varies, so this is a
controlled workflow comparison from two real runs rather than a universal
performance guarantee.

User installation footprint did not materially change. A Windows x64
production-only install measured 46,536,901 bytes (44.38 MiB) for v0.2.1 and
46,273,924 bytes (44.13 MiB) for v0.2.2, about 0.6% less. The latest installed-
runtime smoke reported zero remaining descendants, which supports the cleanup
contract but is not evidence of a percentage reduction in long-session RSS.

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

Public-release verification runs
`node scripts/installed-runtime-smoke.mjs --large-detect 100` directly. Local
RSS receipts and the historical `HWP_BENCH_*` controls remain engineering
tools and cannot satisfy or bypass the public release gate.

Windows x64 is the currently exercised and verified device class. macOS Apple
Silicon remains a compatibility target with unverified-device status; no
completed macOS capacity or Hancom Office claim is made.
