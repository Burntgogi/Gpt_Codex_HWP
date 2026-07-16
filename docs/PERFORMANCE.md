# Performance and capacity evidence

The document engine accepts sources up to a 512 MiB safety ceiling, but that
ceiling is an input boundary, not a capacity guarantee. Actual work is also
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

Evidence uses schema version 1. Its envelope includes the generation time,
fixed concurrency, and a SHA-256 digest of the benchmark, package lock, and
current document-engine implementation, including TypeScript/build asset
configuration and the complete vendored Kordoc runtime. Per-case receipts
contain only:

- platform, architecture, and Node runtime;
- requested and exact generated size;
- operation, execution mode, and status;
- elapsed milliseconds and peak orchestrator RSS delta;
- copied and response bytes;
- a bounded public error code; and
- source/output SHA-256 hashes.

Large evidence is accepted only when that implementation digest still matches
the current source and build inputs. Each case runs sequentially behind an
inherited one-shot control pipe and a parent-owned directory. The parent does
not record a result, remove that directory, or start the next case until the
production process-tree supervisor confirms that the case and every tracked
descendant are gone. Failure to prove termination aborts the benchmark instead
of producing ordinary bounded evidence.

Normal and abnormal receipts use the same fresh case-orchestrator RSS sampler.
The case reports bounded monotonic samples to its parent through an inherited
telemetry descriptor, so crash and timeout recovery does not substitute the
outer benchmark coordinator's memory. If no valid case sample is available,
the run aborts without inventing timing or RSS values.

The generated HWPX is intentionally minimal. It contains an unreferenced,
stored `benchmark/pad.bin` entry produced from deterministic zero blocks. The
generator iteratively adjusts the pad so the exact final archive size is at or
below the requested ceiling without materializing multiple full-size copies.

Current local evidence is Windows x64. macOS is an unverified device class, so
these receipts must not be presented as macOS validation. Benchmark files and
receipts are ignored development artifacts and are excluded from the compact
installed runtime. Clean them from the selected ignored output directory after
retaining only the evidence needed for the release decision.
