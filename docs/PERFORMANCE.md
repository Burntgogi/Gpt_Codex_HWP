# Performance and capacity evidence

The document engine accepts sources up to a 512 MiB safety ceiling, but that
ceiling is an input boundary, not a capacity guarantee. It does not raise the
limits of either engine in the hybrid Kordoc/rhwp path. Actual work is also
bounded by the 64 MiB worker-input and worker-inline result ceilings, the 8 MiB
aggregate MCP response ceiling, the 64,000-character inline Markdown limit, and
the 1536 MiB supervised-child working-set policy.

Every measured size uses the production `detectFormat` engine operation. The
10 MiB default benchmark demonstrates the transferable-worker path. The opt-in
100 and 256 MiB cases are descriptor-transport and supervised-child evidence,
not proof that Kordoc can parse document content above its separate 100 MiB
decompression guard. A small normal parse/read probe runs after each measured
case. The 512 MiB case exercises the supervised-child policy or a permitted
pre-dispatch refusal. A receipt with `ENGINE_OOM` or
`ENGINE_RESOURCE_LIMIT` and `resource-refused` is safe evidence that the policy
declined work cleanly. It is not a benchmark crash. Timeout, process death,
malformed output, a failed post-case normal probe, source mutation, or partial
output is a failed run.

Evidence uses schema version 2. Its envelope includes the generation time,
fixed concurrency, and a SHA-256 digest of the benchmark, package lock, and
current document-engine implementation, including TypeScript/build asset
configuration and the complete vendored Kordoc runtime. Per-case receipts
contain only:

- platform, architecture, and Node runtime;
- requested and exact generated size;
- operation, execution mode, and status;
- elapsed milliseconds and sampled peak process-tree RSS delta;
- the engine-dispatch bit, measured cumulative copied bytes, and response bytes;
- a bounded public error code; and
- source/output SHA-256 hashes.

Large evidence is accepted only when that implementation digest still matches
the current source and build inputs. Each case runs sequentially behind an
inherited one-shot control pipe and a parent-owned directory. The parent does
not record a result, remove that directory, or start the next case until the
production lifecycle has returned a typed receipt for its retained root and any
cleanly registered groups. Failure to obtain that bounded receipt aborts the
benchmark instead of producing ordinary evidence.

Normal and abnormal receipts use the same outer registered-group RSS sampler.
Its baseline is captured before the case receives control. Peak RSS is the
sampled sum of the retained case identity plus identities in accepted lifecycle
groups; it is not the coordinator's RSS and is never accepted from case
telemetry. Windows samples retained Job/tracker identities every 20 ms. Linux
walks `/proc/<pid>/task/*/children`, validates PID/start-time identities, and
samples `VmRSS` every 25 ms. macOS uses a bounded `ps` sampler outside the
measured group at approximately 100 ms and binds each PID to the microsecond
kernel start time returned by `libproc` before exact signaling. Windows retains
the synchronized process handle used to bind PID, parent PID, creation time,
RSS, and termination. This is a sampled sum of per-process RSS, so
operating-system shared pages can be counted in more than one process.

Registration telemetry is closed and sealed before its registered-group receipt
is accepted: closing is requested, the case and registration input end cleanly,
no partial frame or in-flight registration remains, and the acknowledgement
stream closes. A sampled RSS snapshot is telemetry only; it is not termination
proof. Completion requires the typed repository-lifecycle receipt
`windows-job-empty` or `registered-groups-empty`; missing or unverified
registration/identity/channel/deadline evidence invalidates the case.

The case telemetry descriptor contains only exact-shape, cumulative
`elapsedMs`, `dispatchStarted`, and `copiedBytes` observations. The first
zero-byte engine metric immediately before the first engine execution marks
dispatch as started. Direct exact-buffer and descriptor/spool snapshot
ownership adds zero copies. Format detection then makes one intentional,
instrumented defensive engine-input copy and reuses it for all format probes;
therefore a successful detect must finish at exactly the source byte length.
This counter covers explicit copies owned by the plugin boundary, not internal
Kordoc allocations, decompression, or library-private copies.
A pre-dispatch refusal must remain `dispatchStarted: false` with zero copied
bytes, while a dispatched failure may preserve any observed value from zero
through the exact source length. Missing source metadata requires false/zero/
zero. Decreasing, oversized, extra-key, partial, or missing telemetry aborts
evidence validation instead of synthesizing timing, RSS, dispatch, or copy
values.

The generated HWPX is intentionally minimal. It contains an unreferenced,
stored `benchmark/pad.bin` entry produced from deterministic zero blocks. The
generator iteratively adjusts the pad so the exact final archive size is at or
below the requested ceiling without materializing multiple full-size copies.

Current local evidence is Windows x64. macOS is an unverified device class, so
these receipts must not be presented as macOS validation. Benchmark files and
receipts are ignored development artifacts and are excluded from the compact
installed runtime. Clean them from the selected ignored output directory after
retaining only the evidence needed for the release decision.

The benchmark implementation, receipt schema, and release decision are
maintainer-owned security-sensitive surfaces. Change authoritative source and
tests rather than the generated runtime, and require owner review before treating
new numbers as release evidence.
