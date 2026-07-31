import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { generatePaddedHwpx } from "./generate-padded-hwpx.mjs";

const APPROVED_SIZES = Object.freeze([10, 100]);
const CONTROL_ARGS = Object.freeze([]);
const CANDIDATE_ARGS = Object.freeze(["--max-semi-space-size=1"]);
const RETRYABLE_STAGES = new Set(["windows-startup", "frame-timeout"]);
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..", "..");

export async function runPairedDocumentBenchmark({
  sizesMiB,
  pairCount,
  createSource,
  runArm = defaultRunArm,
}) {
  if (!Array.isArray(sizesMiB) || sizesMiB.length < 1 || sizesMiB.length > 2
    || new Set(sizesMiB).size !== sizesMiB.length
    || !sizesMiB.every((size) => APPROVED_SIZES.includes(size))
    || !Number.isSafeInteger(pairCount) || pairCount < 1 || pairCount > 5
    || typeof createSource !== "function" || typeof runArm !== "function") {
    throw new Error("DOCUMENT_PAIRED_CONTRACT_INVALID");
  }
  const sources = [];
  const attempts = [];
  const results = [];
  for (const sizeMiB of sizesMiB) {
    const source = validateSource(await createSource(sizeMiB));
    await assertSourceHash(source.path, source.sha256);
    sources.push(Object.freeze({ sizeMiB, sha256: source.sha256 }));
    for (let pair = 1; pair <= pairCount; pair += 1) {
      const order = pair % 2 === 1 ? ["control", "candidate"] : ["candidate", "control"];
      for (const arm of order) {
        let attempt = 1;
        while (true) {
          await assertSourceHash(source.path, source.sha256);
          const request = Object.freeze({
            sizeMiB,
            pair,
            arm,
            sourcePath: source.path,
            sourceSha256: source.sha256,
            nodeArgs: arm === "candidate" ? CANDIDATE_ARGS : CONTROL_ARGS,
          });
          try {
            const receipt = await runArm(request);
            if (receipt?.status !== "passed" || receipt.sourceSha256 !== source.sha256) {
              throw new Error("DOCUMENT_PAIRED_RECEIPT_INVALID");
            }
            attempts.push(attemptReceipt(request, attempt, "passed"));
            results.push(Object.freeze({
              sizeMiB,
              pair,
              arm,
              sourceSha256: source.sha256,
              receipt,
            }));
            break;
          } catch (error) {
            if (attempt === 1 && retryableInfrastructureFailure(error)) {
              attempts.push(attemptReceipt(request, attempt, "retryable-infrastructure"));
              attempt += 1;
              continue;
            }
            throw error;
          }
        }
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    sizesMiB: Object.freeze([...sizesMiB]),
    pairCount,
    sources: Object.freeze(sources),
    attempts: Object.freeze(attempts),
    results: Object.freeze(results),
  });
}

function validateSource(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "path,sha256"
    || typeof value.path !== "string" || value.path.length === 0
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error("DOCUMENT_PAIRED_SOURCE_INVALID");
  }
  return value;
}

async function assertSourceHash(path, expectedSha256) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", resolveHash);
    stream.once("error", rejectHash);
  });
  if (hash.digest("hex") !== expectedSha256) throw new Error("DOCUMENT_PAIRED_SOURCE_CHANGED");
}

function retryableInfrastructureFailure(error) {
  return error?.code === "BENCHMARK_TERMINATION_FAILED"
    && RETRYABLE_STAGES.has(error?.diagnosticStage);
}

function attemptReceipt(request, attempt, outcome) {
  return Object.freeze({
    sizeMiB: request.sizeMiB,
    pair: request.pair,
    arm: request.arm,
    attempt,
    outcome,
    sourceSha256: request.sourceSha256,
  });
}

async function defaultRunArm(request) {
  const { runBenchmarkCaseFromSource } = await import("./document-engine-benchmark.mjs");
  return runBenchmarkCaseFromSource({
    sizeMiB: request.sizeMiB,
    sourcePath: request.sourcePath,
    expectedSha256: request.sourceSha256,
    nodeArgs: request.nodeArgs,
  });
}

function parseCli(args) {
  if (!Array.isArray(args) || args.length !== 6
    || args[0] !== "--sizes" || args[2] !== "--pairs" || args[4] !== "--output") {
    throw new Error("DOCUMENT_PAIRED_ARGUMENTS_INVALID");
  }
  const sizesMiB = args[1].split(",").map(Number);
  const pairCount = Number(args[3]);
  if (sizesMiB.some((size) => size > 10) && process.env.HWP_BENCH_LARGE !== "1") {
    throw new Error("DOCUMENT_PAIRED_LARGE_DISABLED");
  }
  return {
    sizesMiB,
    pairCount,
    outputPath: resolve(REPOSITORY_ROOT, args[5]),
  };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const { assertIgnoredBenchmarkOutput } = await import("./document-engine-benchmark.mjs");
  await assertIgnoredBenchmarkOutput(options.outputPath);
  await mkdir(dirname(options.outputPath), { recursive: true });
  const sourceRoot = await mkdtemp(join(dirname(options.outputPath), ".node-phase-a-sources-"));
  try {
    const report = await runPairedDocumentBenchmark({
      sizesMiB: options.sizesMiB,
      pairCount: options.pairCount,
      createSource: async (sizeMiB) => {
        const path = join(sourceRoot, `source-${sizeMiB}.hwpx`);
        const generated = await generatePaddedHwpx({
          outputPath: path,
          requestedBytes: sizeMiB * 1024 * 1024,
        });
        return { path, sha256: generated.sha256 };
      },
    });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(
      `DOCUMENT_PAIRED_OK sizes=${report.sizesMiB.join(",")} pairs=${report.pairCount} attempts=${report.attempts.length}\n`,
    );
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error) => {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.message)
      ? error.message
      : "DOCUMENT_PAIRED_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
