import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SAMPLE_TARGETS_MS = Object.freeze([250, 500, 1_000, 1_500, 2_000]);

export async function runRecoveryProbe(options) {
  if (options === null || typeof options !== "object" || typeof options.operation !== "function") {
    throw new Error("RECOVERY_PROBE_INVALID");
  }
  const preCallSamples = options.preCallSamples ?? await collectPreCallSamples(options);
  validateSamples(preCallSamples, 4);
  await options.operation();
  const observed = options.postCallSamples === undefined
    ? await collectPostCallSamples(options)
    : {
        samples: options.postCallSamples,
        identities: options.postCallIdentityCounts,
      };
  validateSamples(observed.samples, SAMPLE_TARGETS_MS.length);
  validateIdentities(observed.identities);

  const preCallMedianBytes = nearestRank(preCallSamples, 0.5);
  const preCallP95Bytes = nearestRank(preCallSamples, 0.95);
  const recoveryThresholdBytes = Math.max(
    preCallP95Bytes,
    Math.floor(preCallMedianBytes * 1.10),
  );
  const finalBytes = observed.samples.at(-1);
  const finalIdentityCount = observed.identities.at(-1);
  return Object.freeze({
    schemaVersion: 1,
    deadlineMs: 2_000,
    sampleTargetsMs: SAMPLE_TARGETS_MS,
    preCallMedianBytes,
    preCallP95Bytes,
    recoveryThresholdBytes,
    peakBytes: Math.max(...preCallSamples, ...observed.samples),
    finalBytes,
    finalIdentityCount,
    recovered: finalBytes <= recoveryThresholdBytes && finalIdentityCount === 0,
  });
}

async function collectPreCallSamples({ sample, delay = wait }) {
  if (typeof sample !== "function" || typeof delay !== "function") {
    throw new Error("RECOVERY_PROBE_INVALID");
  }
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    if (index > 0) await delay(500);
    values.push((await sample()).rssBytes);
  }
  return values;
}

async function collectPostCallSamples({ sample, delay = wait, now = performance.now.bind(performance) }) {
  if (typeof sample !== "function" || typeof delay !== "function" || typeof now !== "function") {
    throw new Error("RECOVERY_PROBE_INVALID");
  }
  const started = now();
  const samples = [];
  const identities = [];
  for (const targetMs of SAMPLE_TARGETS_MS) {
    await delay(Math.max(0, started + targetMs - now()));
    const value = await sample();
    samples.push(value.rssBytes);
    identities.push(value.identityCount);
  }
  return { samples, identities };
}

function validateSamples(value, minimumLength) {
  if (!Array.isArray(value) || value.length < minimumLength
    || value.some((sample) => !Number.isSafeInteger(sample) || sample < 0)) {
    throw new Error("RECOVERY_PROBE_INVALID");
  }
}

function validateIdentities(value) {
  if (!Array.isArray(value) || value.length !== SAMPLE_TARGETS_MS.length
    || value.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("RECOVERY_PROBE_INVALID");
  }
}

function nearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function wait(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function parseRecoveryCli(args) {
  if (!Array.isArray(args) || args.length !== 4
    || args[0] !== "--size" || args[1] !== "100"
    || args[2] !== "--output" || typeof args[3] !== "string"
    || !isAbsolute(args[3])) {
    throw new Error("RECOVERY_ARGUMENTS_INVALID");
  }
  return { outputPath: resolve(args[3]) };
}

async function createDocumentRecoveryReceipt() {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-recovery-"));
  const sourcePath = join(root, "source.hwpx");
  try {
    const [{ generatePaddedHwpx }, { runBenchmarkCaseFromSource }, { sampleProcessTrees }]
      = await Promise.all([
        import("./generate-padded-hwpx.mjs"),
        import("./document-engine-benchmark.mjs"),
        import("./mcp-idle-memory.mjs"),
      ]);
    const source = await generatePaddedHwpx({
      outputPath: sourcePath,
      requestedBytes: 100 * 1024 * 1024,
    });
    const sample = async () => {
      const measured = await sampleProcessTrees([process.pid], 2, 10);
      const current = measured.samples.at(-1);
      return { rssBytes: current.rssBytes, identityCount: current.descendantCount };
    };
    return await runRecoveryProbe({
      sample,
      operation: async () => {
        const receipt = await runBenchmarkCaseFromSource({
          sizeMiB: 100,
          sourcePath,
          expectedSha256: source.sha256,
          nodeArgs: ["--max-semi-space-size=1"],
        });
        if (receipt.status !== "passed") throw new Error("RECOVERY_OPERATION_FAILED");
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runRecoveryCli(
  args,
  { createReceipt = createDocumentRecoveryReceipt, io = process } = {},
) {
  const { outputPath } = parseRecoveryCli(args);
  const receipt = await createReceipt();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  io.stdout.write("NODE_PHASE_A_RECOVERY_OK\n");
  return 0;
}

async function main() {
  try {
    process.exitCode = await runRecoveryCli(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.message)
      ? error.message
      : "NODE_PHASE_A_RECOVERY_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
