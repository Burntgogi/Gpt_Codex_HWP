import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  publicRuntimeIdentity,
  validateIdleMemoryReportV2,
} from "./idle-memory-report.mjs";
import { validateArmWorkerReceipt } from "./node-memory-arm-receipt.mjs";
import { runSupervisedArm as superviseArm } from "./node-memory-arm-supervisor.mjs";
import { snapshotProcessTreeIdentities } from "./process-tree-ledger.mjs";

const execFileAsync = promisify(execFile);
const SAMPLE_COUNT = 60;
const SAMPLE_INTERVAL_MS = 100;
const SETTLE_MS = 5_000;
const MAX_INTERVAL_DRIFT_MS = 50;
const REQUIRED_PAIR_COUNT = 5;
export const CONTROL_V8_FLAGS = Object.freeze([]);
export const CANDIDATE_V8_FLAGS = Object.freeze(["--max-semi-space-size=1"]);
const PRIVACY_KEY_PATTERN = /(?:^|_)(?:content|document|env|environment|host|hostname|path|pid|user|username)(?:$|_)/iu;
const PRIVACY_VALUE_PATTERNS = [
  /(?:^|[\\/])Users[\\/][^\\/]+/iu,
  /(?:^|[\\/])home[\\/][^\\/]+/u,
  /(?:OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|USERPROFILE)=?/iu,
  /\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/u,
];

export function shouldAdoptV8Profile({
  functionalPass,
  oomDetected,
  privateReduction,
  performanceRegression,
}) {
  return functionalPass === true
    && oomDetected === false
    && Number.isFinite(privateReduction)
    && privateReduction >= 0.10
    && Number.isFinite(performanceRegression)
    && performanceRegression <= 0.15;
}

export function parseSessionCounts(raw) {
  if (raw !== "1,5,20") {
    throw new Error("sessions must be exactly 1,5,20");
  }
  return Object.freeze([1, 5, 20]);
}

export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("nearest-rank requires at least one sample");
  }
  if (!(percentile > 0 && percentile <= 1)) {
    throw new Error("percentile must be greater than zero and at most one");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("summary requires at least one sample");
  }
  return Object.freeze({
    median: nearestRank(samples, 0.5),
    p95: nearestRank(samples, 0.95),
    min: Math.min(...samples),
    max: Math.max(...samples),
  });
}

export async function settleBeforeSampling({
  now = performance.now.bind(performance),
  delay: wait = delay,
  durationMs = SETTLE_MS,
} = {}) {
  if (typeof now !== "function" || typeof wait !== "function"
    || !Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new Error("SETTLING_CONTRACT_INVALID");
  }
  const started = now();
  if (!Number.isFinite(started)) throw new Error("SETTLING_CLOCK_INVALID");
  let elapsed = 0;
  while (elapsed < durationMs) {
    await wait(Math.max(0, durationMs - elapsed));
    elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("SETTLING_CLOCK_INVALID");
  }
  return Object.freeze({ requestedMs: durationMs, actualMs: Math.round(elapsed) });
}

export function summarizeSamplingTiming(timestamps, scheduledIntervalMs) {
  if (!Array.isArray(timestamps) || timestamps.length < 2
    || !Number.isSafeInteger(scheduledIntervalMs) || scheduledIntervalMs < 1
    || timestamps.some((timestamp) => !Number.isFinite(timestamp))) {
    throw new Error("SAMPLING_TIMING_INVALID");
  }
  const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
  if (intervals.some((interval) => interval <= 0)) throw new Error("SAMPLING_TIMING_INVALID");
  if (intervals.some((interval) => interval > scheduledIntervalMs + MAX_INTERVAL_DRIFT_MS)) {
    throw new Error("SAMPLING_INTERVAL_UNSTABLE");
  }
  return Object.freeze({
    actualIntervalMedianMs: Math.round(nearestRank(intervals, 0.5)),
    actualIntervalP95Ms: Math.round(nearestRank(intervals, 0.95)),
    actualIntervalMaxMs: Math.round(Math.max(...intervals)),
    durationMs: Math.round(timestamps.at(-1) - timestamps[0]),
  });
}

export function observeStderrLifecycle(stream) {
  if (stream === null || typeof stream !== "object" || typeof stream.on !== "function") {
    throw new Error("BENCHMARK_STDERR_STREAM_INVALID");
  }
  let bytes = 0;
  let settled = false;
  const closed = new Promise((resolveClosed) => {
    const finish = (closedCleanly) => {
      if (settled) return;
      settled = true;
      resolveClosed(Object.freeze({ bytes, closed: closedCleanly }));
    };
    stream.on("data", (chunk) => {
      bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
    });
    stream.once("end", () => finish(true));
    stream.once("close", () => finish(true));
    stream.once("error", () => finish(false));
    if (stream.readableEnded === true || stream.destroyed === true) queueMicrotask(() => finish(true));
  });
  return Object.freeze({ closed });
}

export function assertCleanStderrReceipt(receipt) {
  if (receipt === null || typeof receipt !== "object"
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0
    || receipt.closed !== true) {
    throw new Error("BENCHMARK_STDERR_LIFECYCLE_INVALID");
  }
  if (receipt.bytes !== 0) throw new Error("BENCHMARK_STDERR_NONZERO");
  return receipt;
}

export function parseBenchmarkArguments(args) {
  const values = new Map();
  const candidateNodeArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--runtime=node") continue;
    if (argument.startsWith("--candidate-node-arg=")) {
      const value = argument.slice("--candidate-node-arg=".length);
      if (value.length === 0) throw new Error("candidate Node argument must not be empty");
      candidateNodeArgs.push(value);
      continue;
    }
    if (!["--sessions", "--pairs", "--control-mcp", "--candidate-mcp", "--output", "--control-revision", "--candidate-revision"].includes(argument)) {
      throw new Error(`unsupported idle benchmark argument: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }

  const sessionCounts = parseSessionCounts(values.get("--sessions") ?? "");
  const pairCount = Number(values.get("--pairs"));
  if (pairCount !== REQUIRED_PAIR_COUNT) {
    throw new Error(`pairs must be exactly ${REQUIRED_PAIR_COUNT}`);
  }
  const controlMcpPath = requireAbsolutePath(values.get("--control-mcp"), "control MCP path");
  const candidateMcpPath = requireAbsolutePath(values.get("--candidate-mcp"), "candidate MCP path");
  const outputPath = requireAbsolutePath(values.get("--output"), "output path");
  const controlRevision = requireRevision(values.get("--control-revision"), "control revision");
  const candidateRevision = requireRevision(values.get("--candidate-revision"), "candidate revision");
  if (JSON.stringify(candidateNodeArgs) !== JSON.stringify(CANDIDATE_V8_FLAGS)) {
    throw new Error("candidate Node arguments must be exactly --max-semi-space-size=1");
  }
  return {
    sessionCounts,
    pairCount,
    controlMcpPath,
    candidateMcpPath,
    outputPath,
    controlRevision,
    candidateRevision,
    candidateNodeArgs,
  };
}

function requireRevision(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full commit SHA`);
  }
  return value;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return value;
}

export function validateBenchmarkReport(value) {
  return validateIdleMemoryReportV2(value);
}

export function assertPrivacySafeReport(value) {
  const visit = (current) => {
    if (current === null || current === undefined) return;
    if (typeof current === "string") {
      if (PRIVACY_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        throw new Error("idle benchmark report must contain privacy-safe aggregate fields only");
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    if (typeof current === "object") {
      for (const [key, entry] of Object.entries(current)) {
        if (PRIVACY_KEY_PATTERN.test(key)) {
          throw new Error("idle benchmark report must contain privacy-safe aggregate fields only");
        }
        visit(entry);
      }
    }
  };
  visit(value);
}

export async function runIdleMemoryBenchmark(options) {
  const {
    sessionCounts,
    controlMcpPath,
    candidateMcpPath,
    pairCount,
    outputPath,
    controlRevision,
    candidateRevision,
    candidateNodeArgs = [],
  } = options;
  if (sessionCounts.join(",") !== "1,5,20" || pairCount !== REQUIRED_PAIR_COUNT) {
    throw new Error("idle benchmark requires sessions 1,5,20 and five pairs");
  }
  requireRevision(controlRevision, "control revision");
  requireRevision(candidateRevision, "candidate revision");
  if (JSON.stringify(candidateNodeArgs) !== JSON.stringify(CANDIDATE_V8_FLAGS)) {
    throw new Error("candidate Node arguments must be exactly --max-semi-space-size=1");
  }
  await Promise.all([access(controlMcpPath), access(candidateMcpPath)]);

  const benchmarkSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const controlMeasured = await measureRuntimeFiles(controlMcpPath, benchmarkSha256);
  const candidateMeasured = await measureRuntimeFiles(candidateMcpPath, benchmarkSha256);

  const results = [];
  let unexpectedStderrBytes = 0;
  let remainingDescendants = 0;
  let observedIdentityCount = 0;
  let observedToolCount = null;
  let observedToolContractSha256 = null;

  for (let pair = 1; pair <= pairCount; pair += 1) {
    const order = pair % 2 === 1 ? ["control", "candidate"] : ["candidate", "control"];
    for (const sessionCount of sessionCounts) {
      for (const arm of order) {
        const measurement = await runBenchmarkArm({
          arm,
          pair,
          sessionCount,
          mcpPath: arm === "control" ? controlMcpPath : candidateMcpPath,
          nodeArgs: arm === "candidate" ? candidateNodeArgs : [],
        });
        observedToolCount ??= measurement.toolCount;
        if (measurement.toolCount !== observedToolCount) {
          throw new Error("control and candidate tool counts differ");
        }
        observedToolContractSha256 ??= measurement.toolContractSha256;
        if (measurement.toolContractSha256 !== observedToolContractSha256) {
          throw new Error("control and candidate tool contracts differ");
        }
        unexpectedStderrBytes += measurement.unexpectedStderrBytes;
        remainingDescendants += measurement.cleanup.remainingIdentityCount;
        observedIdentityCount += measurement.cleanup.observedIdentityCount;
        results.push(measurement.result);
      }
    }
  }

  const report = {
    schemaVersion: 2,
    runtime: "node",
    platform: platform(),
    arch: arch(),
    sessionCounts: [...sessionCounts],
    pairCount,
    sampleCount: SAMPLE_COUNT,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    settleMs: SETTLE_MS,
    toolCount: observedToolCount,
    unexpectedStderrBytes,
    cleanup: {
      observedIdentityCount,
      remainingIdentityCount: remainingDescendants,
    },
    v8Aggregation: "equal-weight-per-session-private-arithmetic-mean",
    runtimeIdentities: {
      control: publicRuntimeIdentity({
        revision: controlRevision,
        command: process.execPath,
        args: [controlMcpPath],
        cwd: dirname(dirname(controlMcpPath)),
        safeArgs: CONTROL_V8_FLAGS,
      }, {
        ...controlMeasured,
        nodeVersion: process.version,
        toolContractSha256: observedToolContractSha256,
      }),
      candidate: publicRuntimeIdentity({
        revision: candidateRevision,
        command: process.execPath,
        args: [...candidateNodeArgs, candidateMcpPath],
        cwd: dirname(dirname(candidateMcpPath)),
        safeArgs: candidateNodeArgs,
      }, {
        ...candidateMeasured,
        nodeVersion: process.version,
        toolContractSha256: observedToolContractSha256,
      }),
    },
    results,
  };
  validateBenchmarkReport(report);
  assertPrivacySafeReport(report);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function runBenchmarkArm({
  arm,
  pair,
  sessionCount,
  mcpPath,
  nodeArgs,
  dependencies = {},
}) {
  if ((arm !== "control" && arm !== "candidate")
    || !Number.isSafeInteger(pair) || pair < 1 || pair > REQUIRED_PAIR_COUNT
    || ![1, 5, 20].includes(sessionCount)
    || typeof mcpPath !== "string" || !isAbsolute(mcpPath)
    || !Array.isArray(nodeArgs)
    || JSON.stringify(nodeArgs) !== JSON.stringify(arm === "candidate" ? CANDIDATE_V8_FLAGS : CONTROL_V8_FLAGS)) {
    throw new Error("ARM_WORKER_SPEC_INVALID");
  }
  const armWorkerPath = dependencies.armWorkerPath
    ?? fileURLToPath(new URL("./node-memory-arm-worker.mjs", import.meta.url));
  if (typeof armWorkerPath !== "string" || !isAbsolute(armWorkerPath)) {
    throw new Error("ARM_WORKER_SPEC_INVALID");
  }
  const privateRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-memory-arm-"));
  const specPath = join(privateRoot, "launch.json");
  try {
    await writeFile(specPath, `${JSON.stringify({
      schemaVersion: 1,
      arm,
      pair,
      sessionCount,
      mcpPath,
      nodeArgs,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const receipt = validateArmWorkerReceipt(await (dependencies.runSupervisedArm ?? superviseArm)({
      command: process.execPath,
      args: [armWorkerPath],
      cwd: resolve(dirname(armWorkerPath), ".."),
      timeoutMs: 30_000,
      environment: { GPT_CODEX_HWP_ARM_SPEC: specPath },
    }));
    return {
      toolCount: receipt.toolCount,
      toolContractSha256: receipt.toolContractSha256,
      unexpectedStderrBytes: receipt.unexpectedStderrBytes,
      remainingDescendants: receipt.remainingDescendants,
      cleanup: receipt.cleanup,
      result: receipt.result,
    };
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
}

export async function waitForStderrLifecycle(lifecycle, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      lifecycle.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("BENCHMARK_STDERR_CLOSE_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function closeBenchmarkSession({ client, transport, pid }) {
  const ownedPid = pid ?? transport.pid;
  try {
    await withTimeout(client.close(), 5_000, "BENCHMARK_CLIENT_CLOSE_TIMEOUT");
  } catch {
    await withTimeout(
      transport.close().catch(() => undefined),
      5_000,
      "BENCHMARK_TRANSPORT_CLOSE_TIMEOUT",
    ).catch(() => undefined);
    if (Number.isSafeInteger(ownedPid) && ownedPid > 0) {
      try { process.kill(ownedPid, "SIGKILL"); } catch {}
    }
  }
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function measureRuntimeFiles(mcpPath, benchmarkSha256) {
  const runtimeRoot = dirname(dirname(mcpPath));
  return Object.freeze({
    runtimeArtifactSha256: sha256(await readFile(mcpPath)),
    lockfileSha256: sha256(await readFile(join(runtimeRoot, "package-lock.json"))),
    benchmarkSha256,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sampleProcessTrees(rootPids, sampleCount, intervalMs) {
  return process.platform === "win32"
    ? sampleWindowsProcessTrees(rootPids, sampleCount, intervalMs)
    : samplePosixProcessTrees(rootPids, sampleCount, intervalMs);
}

export async function sampleWindowsProcessTrees(rootPids, sampleCount, intervalMs) {
  const identities = await snapshotProcessTreeIdentities(rootPids);
  return sampleWindowsKnownProcesses(identities, sampleCount, intervalMs);
}

export async function sampleWindowsKnownProcesses(identities, sampleCount, intervalMs) {
  if (process.platform !== "win32") throw new Error("BENCHMARK_WINDOWS_SAMPLER_UNAVAILABLE");
  const validated = validateSamplingIdentities(identities);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 2 || sampleCount > 1_000
    || !Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) {
    throw new Error("BENCHMARK_SAMPLING_CONTRACT_INVALID");
  }
  const pidSet = new Set(validated.map(({ pid }) => pid));
  const rootPids = validated.filter(({ parentPid }) => !pidSet.has(parentPid)).map(({ pid }) => pid);
  if (rootPids.length === 0) throw new Error("BENCHMARK_PROCESS_IDENTITY_INVALID");
  const pids = validated.map(({ pid }) => pid).join(",");
  const roots = rootPids.join(",");
  const encodedIdentities = validated
    .map(({ pid, parentPid }) => `[pscustomobject]@{Id=${pid};ParentId=${parentPid}}`)
    .join(",");
  const interopPath = resolve(import.meta.dirname, "..", "src", "workers", "gpt-codex-hwp-job.dll")
    .replaceAll("'", "''");
  const script = [
    `Add-Type -Path '${interopPath}'`,
    `$pids=@(${pids})`,
    `$roots=@(${roots})`,
    `$identities=@(${encodedIdentities})`,
    `$tracked=[System.Collections.Generic.List[object]]::new()`,
    `foreach($identity in $identities){$entry=[GptCodexHwpJob]::OpenSnapshotExact([int]$identity.Id,[int]$identity.ParentId);if($null -eq $entry){throw 'process identity changed'};[void]$tracked.Add($entry)}`,
    `$samples=[System.Collections.Generic.List[object]]::new()`,
    `$clock=[System.Diagnostics.Stopwatch]::StartNew()`,
    `try{`,
    `for($i=0;$i -lt ${sampleCount};$i++){`,
    `$targetMs=[double]($i*${intervalMs})`,
    `$remainingMs=$targetMs-$clock.Elapsed.TotalMilliseconds`,
    `if($remainingMs -gt 0){Start-Sleep -Milliseconds ([int][Math]::Ceiling($remainingMs))}`,
    `$timestampMs=[double]$clock.Elapsed.TotalMilliseconds`,
    `$found=@{}`,
    `$rss=[long]0`,
    `$private=[long]0`,
    `$ownedCount=0`,
    `foreach($entry in $tracked){if([GptCodexHwpJob]::HandleState($entry.Handle) -ne 1){continue};$counters=[GptCodexHwpJob+PROCESS_MEMORY_COUNTERS]::new();$counters.cb=[Runtime.InteropServices.Marshal]::SizeOf($counters);if([GptCodexHwpJob]::GetProcessMemoryInfo($entry.Handle,[ref]$counters,$counters.cb)){$rss+=[long]$counters.WorkingSetSize.ToUInt64();$private+=[long]$counters.PagefileUsage.ToUInt64();$found[[int]$entry.Id]=$true;$ownedCount++}}`,
    `$missingRoots=0`,
    `foreach($root in $roots){if(-not $found.ContainsKey([int]$root)){$missingRoots++}}`,
    `$missingIdentities=$pids.Count-$ownedCount`,
    `[void]$samples.Add([pscustomobject]@{timestampMs=$timestampMs;rssBytes=$rss;privateBytes=$private;descendantCount=[Math]::Max(0,$ownedCount-$roots.Count);missingRootCount=$missingRoots;missingIdentityCount=$missingIdentities})`,
    `}`,
    `}finally{foreach($entry in $tracked){if($entry.Handle -ne [IntPtr]::Zero){[void][GptCodexHwpJob]::CloseHandle($entry.Handle)}}}`,
    `$samples | ConvertTo-Json -Compress`,
  ].join(";");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: sampleCount * intervalMs + 10_000,
      windowsHide: true,
    },
  );
  const parsed = JSON.parse(stdout.trim());
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length !== sampleCount
    || records.some(({ missingIdentityCount }) => missingIdentityCount !== 0)) {
    throw new Error("BENCHMARK_PROCESS_SET_CHANGED");
  }
  let finalIdentities;
  try {
    finalIdentities = await snapshotProcessTreeIdentities(rootPids);
  } catch {
    throw new Error("BENCHMARK_PROCESS_SET_CHANGED");
  }
  if (samplingIdentityKey(finalIdentities) !== samplingIdentityKey(validated)) {
    throw new Error("BENCHMARK_PROCESS_SET_CHANGED");
  }
  return {
    timestamps: records.map(({ timestampMs }) => timestampMs),
    samples: records.map(({ timestampMs: _timestampMs, missingIdentityCount: _missing, ...sample }) => sample),
  };
}

function validateSamplingIdentities(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 257) {
    throw new Error("BENCHMARK_PROCESS_IDENTITY_INVALID");
  }
  const identities = value.map((record) => {
    if (record === null || typeof record !== "object"
      || !Number.isSafeInteger(record.pid) || record.pid < 1
      || !Number.isSafeInteger(record.parentPid) || record.parentPid < 0
      || typeof record.startIdentity !== "string" || record.startIdentity.length < 1
      || record.startIdentity.length > 128) {
      throw new Error("BENCHMARK_PROCESS_IDENTITY_INVALID");
    }
    return Object.freeze({
      pid: record.pid,
      parentPid: record.parentPid,
      startIdentity: record.startIdentity,
    });
  });
  if (new Set(identities.map(({ pid, startIdentity }) => `${pid}:${startIdentity}`)).size !== identities.length) {
    throw new Error("BENCHMARK_PROCESS_IDENTITY_INVALID");
  }
  return identities;
}

function samplingIdentityKey(identities) {
  return validateSamplingIdentities(identities)
    .map(({ pid, parentPid, startIdentity }) => `${pid}:${parentPid}:${startIdentity}`)
    .sort()
    .join("|");
}

async function samplePosixProcessTrees(rootPids, sampleCount, intervalMs) {
  const samples = [];
  const timestamps = [];
  const started = performance.now();
  for (let index = 0; index < sampleCount; index += 1) {
    const target = started + index * intervalMs;
    await delay(Math.max(0, target - performance.now()));
    timestamps.push(performance.now() - started);
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" });
    const records = stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
      const [pid, ppid, rssKiB] = line.trim().split(/\s+/u).map(Number);
      return { pid, ppid, rssBytes: rssKiB * 1024 };
    });
    const selected = new Set(rootPids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        if (selected.has(record.ppid) && !selected.has(record.pid)) {
          selected.add(record.pid);
          changed = true;
        }
      }
    }
    const owned = records.filter(({ pid }) => selected.has(pid));
    samples.push({
      rssBytes: owned.reduce((sum, record) => sum + record.rssBytes, 0),
      privateBytes: null,
      descendantCount: Math.max(0, owned.length - rootPids.length),
      missingRootCount: rootPids.filter((pid) => !owned.some((record) => record.pid === pid)).length,
    });
  }
  return { samples, timestamps };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(fileURLToPath(pathToFileURL(entryPoint))).href) {
  runIdleMemoryBenchmark(parseBenchmarkArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
