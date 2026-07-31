import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runBenchmarkCaseFromSource } from "../benchmarks/document-engine-benchmark.mjs";
import { runPairedDocumentBenchmark } from "../benchmarks/node-phase-a-document-paired.mjs";

test("document paired benchmark reuses one exact source per size", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-paired-test-"));
  const calls: Array<{ arm: string; sourceSha256: string }> = [];
  try {
    const report = await runPairedDocumentBenchmark({
      sizesMiB: [10, 100],
      pairCount: 2,
      createSource: async (sizeMiB: number) => {
        const path = join(root, `fixture-${sizeMiB}.hwpx`);
        const bytes = Buffer.from(`source-${sizeMiB}`, "utf8");
        await writeFile(path, bytes);
        return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
      },
      runArm: async (request: { arm: string; sourceSha256: string }) => {
        calls.push({ arm: request.arm, sourceSha256: request.sourceSha256 });
        return { status: "passed", sourceSha256: request.sourceSha256 };
      },
    });
    assert.equal(report.attempts.length, 8);
    assert.equal(report.results.length, 8);
    assert.equal(report.results.every(({ sourceSha256, receipt }: {
      sourceSha256: string;
      receipt: { sourceSha256: string };
    }) => sourceSha256 === receipt.sourceSha256), true);
    assert.deepEqual(
      new Set(calls.map(({ sourceSha256 }) => sourceSha256)),
      new Set(report.sources.map(({ sha256 }: { sha256: string }) => sha256)),
    );
    assert.deepEqual(calls.map(({ arm }) => arm), [
      "control", "candidate", "candidate", "control",
      "control", "candidate", "candidate", "control",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document paired benchmark retries only one approved infrastructure failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-paired-retry-"));
  let calls = 0;
  try {
    const path = join(root, "source.hwpx");
    const bytes = Buffer.from("source", "utf8");
    await writeFile(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const report = await runPairedDocumentBenchmark({
      sizesMiB: [10],
      pairCount: 1,
      createSource: async () => ({ path, sha256 }),
      runArm: async (request: { sourceSha256: string }) => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("bounded infrastructure gap"), {
            code: "BENCHMARK_TERMINATION_FAILED",
            diagnosticStage: "windows-startup",
          });
        }
        return { status: "passed", sourceSha256: request.sourceSha256 };
      },
    });
    assert.equal(calls, 3);
    assert.equal(report.attempts.length, 3);
    assert.deepEqual(report.attempts.map(({ outcome }: { outcome: string }) => outcome), [
      "retryable-infrastructure", "passed", "passed",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document paired benchmark never retries OOM", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-paired-oom-"));
  let calls = 0;
  try {
    const path = join(root, "source.hwpx");
    const bytes = Buffer.from("source", "utf8");
    await writeFile(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await assert.rejects(
      () => runPairedDocumentBenchmark({
        sizesMiB: [10],
        pairCount: 1,
        createSource: async () => ({ path, sha256 }),
        runArm: async () => {
          calls += 1;
          throw Object.assign(new Error("oom"), { code: "ENGINE_OOM" });
        },
      }),
      { code: "ENGINE_OOM" },
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document case verifies the exact source before delegating to its bounded executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-source-case-"));
  const path = join(root, "source.hwpx");
  const bytes = Buffer.from("same-source", "utf8");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes);
  const calls: unknown[] = [];
  try {
    const receipt = await runBenchmarkCaseFromSource({
      sizeMiB: 10,
      sourcePath: path,
      expectedSha256,
      nodeArgs: ["--max-semi-space-size=1"],
    }, {
      executeCase: async (request: unknown) => {
        calls.push(request);
        return { status: "passed", sourceSha256: expectedSha256 };
      },
      allowFixtureSize: true,
    });
    assert.deepEqual(receipt, { status: "passed", sourceSha256: expectedSha256 });
    assert.equal(calls.length, 1);
    await writeFile(path, "changed", "utf8");
    await assert.rejects(
      () => runBenchmarkCaseFromSource({
        sizeMiB: 10,
        sourcePath: path,
        expectedSha256,
        nodeArgs: ["--max-semi-space-size=1"],
      }, { executeCase: async () => receipt, allowFixtureSize: true }),
      { code: "BENCHMARK_SOURCE_CHANGED" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
