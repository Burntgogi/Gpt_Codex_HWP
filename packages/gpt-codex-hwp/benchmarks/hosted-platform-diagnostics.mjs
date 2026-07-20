const WINDOWS_BOUNDARIES = new Set([
  "helper-spawn",
  "preframe-stderr",
  "preframe-exit",
  "frame-timeout",
  "frame-invalid",
  "ready-mode-2",
  "ready-mode-1",
  "termination-receipt",
  "helper-close",
  "target-close",
]);
const WINDOWS_LATE_BOUNDARIES = new Set([
  "ready-late",
  "late-preframe-error",
  "observer-timeout",
  "helper-close",
  "target-close",
]);
const MAC_BACKEND_BOUNDARIES = new Set([
  "worker-error",
  "worker-exit",
  "backend-import",
  "backend-init",
  "backend-ready",
]);
const MAC_WORKER_BOUNDARIES = new Set([
  "worker-error",
  "worker-exit",
  "pre-ready-failure",
  "ready",
  "result",
]);
const LINUX_STAGES = new Set([
  "ready-mode-1",
  "ready-mode-2",
  "error-startup",
  "error-baseline-rss",
  "error-sampling",
  "error-termination",
  "error-rss-receipt",
  "finalizer",
  "channel",
  "posix-root-authority",
  "posix-telemetry-initialize",
  "posix-telemetry-sample",
]);
const WINDOWS_TARGET_CLOSE_MS = 5_000;

export async function runHostedWindowsSupervisorDiagnostic(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") throw diagnosticError();
  const targetCloseTimeoutMs = dependencies.targetCloseTimeoutMs
    ?? WINDOWS_TARGET_CLOSE_MS;
  if (!Number.isSafeInteger(targetCloseTimeoutMs)
    || targetCloseTimeoutMs <= 0 || targetCloseTimeoutMs > WINDOWS_TARGET_CLOSE_MS) {
    throw diagnosticError();
  }
  const childProcess = dependencies.spawnTarget === undefined
    ? await import("node:child_process")
    : undefined;
  const childClient = dependencies.superviseTarget === undefined
    || dependencies.observeTargetClose === undefined
    ? await import("../src/workers/document-child-client.ts")
    : undefined;
  const spawnTarget = dependencies.spawnTarget ?? (() => childProcess.spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { shell: false, windowsHide: true, stdio: "ignore" },
  ));
  const observeTargetClose = dependencies.observeTargetClose
    ?? childClient.observeChildProcessClose;
  const superviseTarget = dependencies.superviseTarget ?? ((target, observe, observeLate) =>
    childClient.superviseDocumentProcessTree(target, {
      hostedDiagnosticObserver: observe,
      hostedDiagnosticLateObserver: observeLate,
    }));
  let target;
  let boundary = "helper-spawn";
  let lateBoundary;
  let targetClose;
  try {
    target = spawnTarget();
    targetClose = observeTargetClose(target);
    const supervisor = await superviseTarget(target, (value) => {
      boundary = WINDOWS_BOUNDARIES.has(value) ? value : "frame-invalid";
    }, (value) => {
      lateBoundary = WINDOWS_LATE_BOUNDARIES.has(value) ? value : "late-preframe-error";
    });
    if (boundary === "ready-mode-1") {
      const receipt = await supervisor.terminate();
      if (receipt?.gone !== true || receipt?.proof !== "windows-job-empty"
        || Object.keys(receipt).sort().join(",") !== "gone,proof") {
        boundary = boundary === "helper-close" ? boundary : "termination-receipt";
      } else {
        boundary = "helper-close";
        const close = await waitForBoundedReceipt(targetClose, targetCloseTimeoutMs);
        if (!isExactWindowsTargetCloseReceipt(close)) {
          boundary = "target-close";
        } else {
          boundary = "target-close";
        }
      }
    }
  } catch {
    // The fixed production/late boundaries are returned after typed target cleanup.
  } finally {
    if (target !== undefined && targetClose !== undefined) {
      let close = await waitForBoundedReceipt(targetClose, 1);
      if (!isExactWindowsTargetCloseReceipt(close)) {
        try { target.kill("SIGKILL"); } catch {}
        close = await waitForBoundedReceipt(targetClose, targetCloseTimeoutMs);
      }
      if (!isExactWindowsTargetCloseReceipt(close)) {
        if (lateBoundary === undefined) boundary = "target-close";
        else lateBoundary = "target-close";
      }
    }
  }
  return Object.freeze({
    production: Object.freeze({ boundary }),
    ...(lateBoundary === undefined
      ? {}
      : { late: Object.freeze({ boundary: lateBoundary }) }),
  });
}

function isExactWindowsTargetCloseReceipt(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "code,error,signal"
    || value.error !== null) {
    return false;
  }
  const codePresent = value.code !== null;
  const signalPresent = value.signal !== null;
  if (codePresent === signalPresent) return false;
  if (codePresent) return Number.isSafeInteger(value.code);
  return value.signal === "SIGBREAK" || value.signal === "SIGINT"
    || value.signal === "SIGKILL" || value.signal === "SIGTERM";
}

async function waitForBoundedReceipt(receipt, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      receipt,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runHostedMacDiagnostics(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") throw diagnosticError();
  const backendBoundary = await safeMacProbe(
    dependencies.probeBackend ?? probeMacBackend,
  );
  const workerBoundary = await safeMacProbe(
    dependencies.probeWorker ?? probeMacWorker,
  );
  const backend = Object.freeze({ boundary: backendBoundary });
  const worker = Object.freeze({ boundary: workerBoundary });
  formatHostedMacBackendDiagnostic(backend);
  formatHostedMacWorkerDiagnostic(worker);
  return Object.freeze({ backend, worker });
}

async function safeMacProbe(probe) {
  try {
    return await probe();
  } catch {
    return "worker-error";
  }
}

export function formatHostedWindowsSupervisorDiagnostic(value) {
  assertExactBoundary(value, WINDOWS_BOUNDARIES);
  return `HOSTED_WINDOWS_SUPERVISOR boundary=${value.boundary}`;
}

export function formatHostedWindowsSupervisorLateDiagnostic(value) {
  assertExactBoundary(value, WINDOWS_LATE_BOUNDARIES);
  return `HOSTED_WINDOWS_SUPERVISOR_LATE boundary=${value.boundary}`;
}

export function formatHostedMacBackendDiagnostic(value) {
  assertExactBoundary(value, MAC_BACKEND_BOUNDARIES);
  return `HOSTED_MAC_BACKEND boundary=${value.boundary}`;
}

export function formatHostedMacWorkerDiagnostic(value) {
  assertExactBoundary(value, MAC_WORKER_BOUNDARIES);
  return `HOSTED_MAC_WORKER boundary=${value.boundary}`;
}

export function formatLinuxRealDetectDiagnostic(value) {
  assertExactKeys(value, [
    "framePresent",
    "processGone",
    "rssPresent",
    "stage",
    "status",
    "telemetryEnded",
  ]);
  if (value.status !== "failed"
    || typeof value.processGone !== "boolean"
    || typeof value.telemetryEnded !== "boolean"
    || typeof value.framePresent !== "boolean"
    || typeof value.rssPresent !== "boolean"
    || !LINUX_STAGES.has(value.stage)) {
    throw diagnosticError();
  }
  return `LINUX_REAL_DETECT status=failed processGone=${value.processGone}`
    + ` telemetryEnded=${value.telemetryEnded} framePresent=${value.framePresent}`
    + ` rssPresent=${value.rssPresent} stage=${value.stage}`;
}

export function rethrowWithLinuxRealDetectDiagnostic(error, emit) {
  try {
    if (typeof emit !== "function") throw diagnosticError();
    emit(formatLinuxRealDetectDiagnostic(error?.telemetryDiagnostic));
  } catch {
    // Invalid or unavailable diagnostics remain completely silent.
  }
  throw error;
}

function assertExactBoundary(value, boundaries) {
  assertExactKeys(value, ["boundary"]);
  if (!boundaries.has(value.boundary)) throw diagnosticError();
}

function assertExactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw diagnosticError();
  }
}

function diagnosticError() {
  return Object.assign(new Error("HOSTED_DIAGNOSTIC_INVALID"), {
    code: "HOSTED_DIAGNOSTIC_INVALID",
  });
}

async function probeMacBackend() {
  const { Worker } = await import("node:worker_threads");
  const backendUrl = new URL("../dist/workers/document-compute-backend.js", import.meta.url).href;
  const probeUrl = new URL("../tests/fixtures/workers/backend-init-probe.mjs", import.meta.url);
  const worker = new Worker(probeUrl, {
    workerData: { backendUrl },
    stdout: true,
    stderr: true,
  });
  worker.stdout?.resume();
  worker.stderr?.resume();
  const outcome = await new Promise((resolveOutcome) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(value);
    };
    const timer = setTimeout(() => settle("worker-exit"), 30_000);
    timer.unref();
    worker.once("message", (value) => {
      settle(value === "BACKEND_READY"
        ? "backend-ready"
        : MAC_BACKEND_BOUNDARIES.has(value) ? value : "worker-error");
    });
    worker.once("error", () => settle("worker-error"));
    worker.once("exit", () => settle("worker-exit"));
  });
  await worker.terminate().catch(() => undefined);
  return outcome;
}

async function probeMacWorker() {
  const [{ mkdtemp, readFile, rm }, { tmpdir }, { join }, { Worker }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
    import("node:worker_threads"),
  ]);
  const [{ generatePaddedHwpx }, { createDocumentWorkerClient }] = await Promise.all([
    import("./generate-padded-hwpx.mjs"),
    import("../src/workers/document-worker-client.ts"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "hwp-hosted-mac-worker-"));
  let boundary = "worker-error";
  try {
    const sourcePath = join(root, "normal-probe.hwpx");
    await generatePaddedHwpx({ outputPath: sourcePath, requestedBytes: 128 * 1024 });
    const source = await readFile(sourcePath);
    const documentBuffer = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    );
    const client = createDocumentWorkerClient({
      workerFactory: (options) => {
        const worker = new Worker(
          new URL("../dist/workers/document-worker.js", import.meta.url),
          options,
        );
        worker.on("message", (value) => {
          const type = typeof value === "object" && value !== null && "type" in value
            ? value.type
            : undefined;
          if (type === "ready") boundary = "ready";
          else if (type === "failure" && boundary !== "ready") boundary = "pre-ready-failure";
          else if (type === "result") boundary = "result";
        });
        worker.once("error", () => { boundary = "worker-error"; });
        worker.once("exit", () => {
          if (boundary !== "result" && boundary !== "pre-ready-failure") boundary = "worker-exit";
        });
        return worker;
      },
    });
    await client.run(
      { protocolVersion: 1, requestId: "hosted-mac-worker", operation: "parse", input: {}, options: {} },
      {
        transport: "worker",
        metadata: {
          sizeBytes: documentBuffer.byteLength,
          sha256: "0".repeat(64),
          shallowFormat: { candidate: "hwpx", container: "zip", exact: true },
          protection: { status: "clear", candidateFormat: "hwpx", exact: true },
        },
        takeTransferable: () => documentBuffer,
        async verifySourceUnchanged() {},
        async cleanup() {},
      },
      { deadlineMs: 30_000 },
    );
    return boundary;
  } catch {
    return boundary;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.length !== 3) throw diagnosticError();
  if (process.argv[2] === "--windows-supervisor") {
    const result = await runHostedWindowsSupervisorDiagnostic();
    process.stdout.write(`${formatHostedWindowsSupervisorDiagnostic(result.production)}\n`);
    if (result.late !== undefined) {
      process.stdout.write(`${formatHostedWindowsSupervisorLateDiagnostic(result.late)}\n`);
    }
    return;
  }
  if (process.argv[2] === "--mac-worker") {
    const result = await runHostedMacDiagnostics();
    process.stdout.write(`${formatHostedMacBackendDiagnostic(result.backend)}\n`);
    process.stdout.write(`${formatHostedMacWorkerDiagnostic(result.worker)}\n`);
    return;
  }
  throw diagnosticError();
}

if (process.argv[1] !== undefined
  && new URL(import.meta.url).pathname.toLowerCase().endsWith(
    process.argv[1].replaceAll("\\", "/").toLowerCase(),
  )) {
  main().catch(() => {
    process.stderr.write("HOSTED_DIAGNOSTIC_INVALID\n");
    process.exitCode = 1;
  });
}
