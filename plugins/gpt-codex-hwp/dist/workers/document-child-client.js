import { execFile, spawn, } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, open, opendir, readdir, rename, rmdir, unlink, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BoundedFrameDecoder, encodeBoundedJsonFrame, parseBoundedJsonFrame, } from "./bounded-frame.js";
import { DocumentEngineRunError, createDocumentEngineRunError, normalizeDocumentEngineError, } from "./document-errors.js";
import { defaultDocumentDeadlineMs, HeavyChildGate, } from "./document-execution-policy.js";
import { createChildDocumentEventValidator, createWireDocumentRequest, MAX_CHILD_INLINE_RESULT_BYTES, MAX_CHILD_REQUEST_FRAME_BYTES, validateLogicalDocumentRequest, } from "./document-protocol.js";
import { DOCUMENT_START_FRAME } from "./document-process-registration.js";
import { createRegisteredPosixProcessGroupSupervisor, normalizeProcessTreeTerminationReceipt, unverifiedTermination, } from "./registered-process-supervisor.js";
const execFileAsync = promisify(execFile);
const MAX_DRAIN_ACCOUNTED_BYTES = 64 * 1024;
const TREE_KILL_GRACE_MS = 100;
const OUTPUT_SPOOL_PREFIX = "gpt-codex-hwp-result-";
const OUTPUT_SPOOL_FILENAME = "output.bin";
const OUTPUT_READ_CHUNK_BYTES = 1024 * 1024;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const LINUX_PROCESS_SAMPLE_MS = 25;
const MACOS_PROCESS_SAMPLE_MS = 100;
const MAX_TRACKED_PROCESS_IDENTITIES = 4_096;
const MAX_LINUX_TASKS_PER_PROCESS = 1_024;
const MAX_LINUX_CHILDREN_PER_PROCESS = 4_096;
const MAX_LINUX_PROC_STAT_BYTES = 64 * 1024;
const MAX_LINUX_PROC_STATUS_BYTES = 256 * 1024;
const MAX_LINUX_TASK_CHILDREN_BYTES = 64 * 1024;
const MAX_MACOS_IDENTITY_STABILIZATION_ROUNDS = 4;
const WINDOWS_SUPERVISOR_TERMINATION_FRAME_MS = 5_000;
const gatedRootGoneErrors = new WeakSet();
const supervisorHelperUnclosedErrors = new WeakMap();
const supervisorHelperRetentionsByProcess = new WeakMap();
const supervisorHelperCleanupPromises = new WeakMap();
const releasedSupervisorHelpers = new WeakSet();
const unsafeSupervisorHelperRetentions = new Set();
const childProcessCloseReceipts = new WeakMap();
function gatedRootGoneError() {
    const error = new Error("Windows Job authority unavailable after gated root cleanup");
    gatedRootGoneErrors.add(error);
    return error;
}
function supervisorHelperUnclosedError(helper, closeReceipt) {
    const error = new Error("Windows Job supervisor cleanup unverified");
    supervisorHelperUnclosedErrors.set(error, retainUnclosedWindowsSupervisorHelper(helper, closeReceipt));
    return error;
}
export function isGatedRootGoneError(error) {
    return typeof error === "object" && error !== null && gatedRootGoneErrors.has(error);
}
export function isSupervisorHelperUnclosedError(error) {
    return typeof error === "object" && error !== null && supervisorHelperUnclosedErrors.has(error);
}
const verifiedResultSpools = new WeakSet();
export function isIntegrityVerifiedResultSpool(value) {
    return typeof value === "object" && value !== null &&
        verifiedResultSpools.has(value);
}
export function createDocumentChildClient(dependencies = {}) {
    const childEntry = dependencies.childEntry ?? fileURLToPath(new URL("./document-child.js", import.meta.url));
    const childArguments = dependencies.childArguments ?? [];
    const startGateEntry = dependencies.startGateEntry ?? fileURLToPath(import.meta.url.endsWith(".ts")
        ? new URL("../../dist/workers/document-child-start-gate.js", import.meta.url)
        : new URL("./document-child-start-gate.js", import.meta.url));
    if (!isAbsolute(startGateEntry)) {
        throw new Error("absolute document child start gate entry is required");
    }
    const gate = dependencies.heavyChildGate ?? new HeavyChildGate();
    const spawnFactory = dependencies.spawnFactory ?? ((specification) => spawn(specification.command, [...specification.args], specification.options));
    const legacyTreeTerminator = dependencies.treeTerminator ?? terminateProcessTree;
    const fallbackTerminator = async (child) => {
        try {
            await legacyTreeTerminator(child);
        }
        catch {
            // Generic cleanup has no identity-bound proof authority.
        }
        return unverifiedTermination("termination");
    };
    return {
        concurrencyManaged: true,
        async run(request, snapshot, options = {}) {
            const requestStartedAt = performance.now();
            try {
                validateLogicalDocumentRequest(request);
            }
            catch {
                await cleanupSnapshot(snapshot);
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            if ((request.operation === "generateHwpx" && snapshot !== undefined) ||
                (request.operation !== "generateHwpx" && snapshot?.transport !== "spool")) {
                await cleanupUnknownSnapshot(snapshot);
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            if (options.signal?.aborted === true) {
                await cleanupSnapshot(snapshot);
                throw createDocumentEngineRunError("REQUEST_CANCELLED");
            }
            let deadlineMs;
            try {
                deadlineMs = normalizeDeadline(options.deadlineMs ?? defaultDocumentDeadlineMs(request.operation));
            }
            catch (error) {
                await cleanupSnapshot(snapshot);
                throw error;
            }
            let release;
            try {
                release = await gate.acquire(options.signal, deadlineMs);
            }
            catch (error) {
                await cleanupSnapshot(snapshot);
                throw error;
            }
            let remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
            if (remainingDeadlineMs <= 0) {
                release();
                await cleanupSnapshot(snapshot);
                throw createDocumentEngineRunError("ENGINE_TIMEOUT");
            }
            const startupLifecycle = createStartupLifecycleState(options.signal, requestStartedAt + deadlineMs);
            const initialTerminationReason = startupLifecycle.terminationReason();
            if (initialTerminationReason !== undefined) {
                startupLifecycle.dispose();
                release();
                await cleanupSnapshot(snapshot);
                throw startupTerminationError(initialTerminationReason);
            }
            let outputOwner;
            try {
                outputOwner = await createPrivateOutputSpool(dependencies.spoolRoot ?? tmpdir(), dependencies.outputSpoolCleanupHooks);
                await dependencies.outputSpoolReadyHook?.();
            }
            catch (error) {
                const terminationReason = startupLifecycle.terminationReason();
                startupLifecycle.dispose();
                release();
                if (outputOwner !== undefined)
                    await cleanupOutputSpool(outputOwner);
                await cleanupSnapshot(snapshot);
                if (terminationReason !== undefined) {
                    throw startupTerminationError(terminationReason);
                }
                throw new DocumentEngineRunError(normalizeDocumentEngineError(error, {
                    ready: false,
                    stage: "startup",
                }));
            }
            remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
            const postSpoolTerminationReason = startupLifecycle.terminationReason();
            if (postSpoolTerminationReason !== undefined) {
                startupLifecycle.dispose();
                release();
                await cleanupOutputSpool(outputOwner);
                await cleanupSnapshot(snapshot);
                throw startupTerminationError(postSpoolTerminationReason);
            }
            let child;
            let startGate;
            let startupCapture;
            try {
                const input = request.operation === "generateHwpx"
                    ? undefined
                    : requireSpool(snapshot);
                const imageInputFd = options.imageInput?.transport === "spool"
                    ? options.imageInput.fd
                    : undefined;
                const stdio = [
                    process.platform === "win32" ? "pipe" : "ipc",
                    "pipe",
                    "pipe",
                    input?.fd ?? "ignore",
                    imageInputFd ?? "ignore",
                    outputOwner.handle.fd,
                    "pipe",
                    "pipe",
                    ...(dependencies.benchmarkRegistrationDescriptors === undefined
                        ? []
                        : [
                            dependencies.benchmarkRegistrationDescriptors.writeFd,
                            dependencies.benchmarkRegistrationDescriptors.ackFd,
                        ]),
                ];
                const specification = {
                    command: process.execPath,
                    args: process.platform === "win32"
                        ? [
                            "--import",
                            pathToFileURL(startGateEntry).href,
                            childEntry,
                            ...childArguments,
                        ]
                        : [startGateEntry, childEntry, ...childArguments],
                    options: {
                        shell: false,
                        windowsHide: true,
                        detached: process.platform !== "win32",
                        env: minimalChildEnvironment(),
                        stdio,
                    },
                };
                const preSpawnTerminationReason = startupLifecycle.terminationReason();
                if (preSpawnTerminationReason !== undefined) {
                    throw startupTerminationError(preSpawnTerminationReason);
                }
                child = spawnFactory(specification);
                startupCapture = createChildStartupCapture(child);
                startGate = requireStartGateOwner(child);
            }
            catch (error) {
                const terminationReason = startupLifecycle.terminationReason();
                if (child !== undefined) {
                    closeStartGate(startGate);
                    const capture = startupCapture ?? createChildStartupCapture(child);
                    await terminateGatedChildByHandle(child, capture.closeReceipt);
                    await cleanupFailedPreDispatch(child, snapshot, outputOwner, release, capture, startupLifecycle, startGate);
                    throw terminationFailedError();
                }
                startupLifecycle.dispose();
                release();
                await cleanupOutputSpool(outputOwner);
                await cleanupSnapshot(snapshot);
                if (terminationReason !== undefined) {
                    throw startupTerminationError(terminationReason);
                }
                if (error instanceof DocumentEngineRunError)
                    throw error;
                throw new DocumentEngineRunError(normalizeDocumentEngineError(error, {
                    ready: false,
                    stage: "startup",
                }));
            }
            const spawnedChild = child;
            const childStartGate = startGate;
            const childStartupCapture = startupCapture;
            let supervisedTerminator = fallbackTerminator;
            const supervisorFactory = dependencies.jobSupervisorFactory ??
                (process.platform === "win32"
                    ? (childProcess, readyMs) => createWindowsJobSupervisor(childProcess, readyMs, dependencies.jobSupervisorFrameObserver)
                    : (childProcess) => createPosixProcessTreeSupervisor(childProcess, process.platform));
            const supervisorPromise = Promise.resolve().then(() => supervisorFactory(spawnedChild, Math.min(5_000, remainingDeadlineMs)));
            const supervisorOutcome = await waitForStartupPhase(supervisorPromise, startupLifecycle);
            if (supervisorOutcome.kind === "failed") {
                closeStartGate(childStartGate);
                if (isSupervisorHelperUnclosedError(supervisorOutcome.error)) {
                    retainUnverifiedPreDispatch(spawnedChild, snapshot, outputOwner, release, childStartupCapture, startupLifecycle, childStartGate);
                    throw terminationFailedError();
                }
                if (!isGatedRootGoneError(supervisorOutcome.error)) {
                    await terminateGatedChildByHandle(spawnedChild, childStartupCapture.closeReceipt);
                }
                await cleanupFailedPreDispatch(spawnedChild, snapshot, outputOwner, release, childStartupCapture, startupLifecycle, childStartGate);
                throw terminationFailedError();
            }
            if (supervisorOutcome.kind === "terminated") {
                closeStartGate(childStartGate);
                retainUntilLateSupervisor(supervisorPromise, spawnedChild, snapshot, outputOwner, release, childStartupCapture, startupLifecycle, childStartGate);
                throw terminationFailedError();
            }
            supervisedTerminator = createVerifiedTerminator(supervisorOutcome.value, childStartGate);
            remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
            if (startupLifecycle.terminationReason() !== undefined) {
                closeStartGate(childStartGate);
                return terminateExpiredStartup(spawnedChild, snapshot, outputOwner, release, supervisedTerminator, childStartupCapture, startupLifecycle, childStartGate);
            }
            const startOutcome = await waitForStartupPhase(writeStartFrame(childStartGate), startupLifecycle);
            if (startOutcome.kind === "terminated") {
                closeStartGate(childStartGate);
                return terminateExpiredStartup(spawnedChild, snapshot, outputOwner, release, supervisedTerminator, childStartupCapture, startupLifecycle, childStartGate);
            }
            if (startOutcome.kind === "failed") {
                closeStartGate(childStartGate);
                const receipt = await terminateWithReceipt(supervisedTerminator, spawnedChild, "channel");
                if (!receipt.gone) {
                    scheduleCleanupAfterActualExit(spawnedChild, snapshot, outputOwner, release, childStartupCapture, supervisedTerminator, childStartGate);
                    startupLifecycle.dispose();
                    throw terminationFailedError();
                }
                await cleanupFailedPreDispatch(spawnedChild, snapshot, outputOwner, release, childStartupCapture, startupLifecycle, childStartGate);
                throw createDocumentEngineRunError("ENGINE_INIT_FAILED", { stage: "startup" });
            }
            remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
            if (startupLifecycle.terminationReason() !== undefined) {
                closeStartGate(childStartGate);
                return terminateExpiredStartup(spawnedChild, snapshot, outputOwner, release, supervisedTerminator, childStartupCapture, startupLifecycle, childStartGate);
            }
            return runChild(request, snapshot, options, remainingDeadlineMs, spawnedChild, release, outputOwner, supervisedTerminator, dependencies.controlFrameAllocationObserver, childStartupCapture, startupLifecycle, childStartGate);
        },
    };
}
function requireStartGateOwner(child) {
    if (process.platform !== "win32")
        return requireIpcStartGateOwner(child);
    const stream = child.stdio[7];
    if (stream === null || stream === undefined || typeof stream.write !== "function") {
        throw new Error("document child start gate pipe unavailable");
    }
    let owner;
    const onError = (error) => {
        owner.failure ??= error;
        owner.settleStart?.(error);
    };
    const onClose = () => {
        owner.closed = true;
        owner.failure ??= new Error("document child start gate closed");
        owner.settleStart?.(owner.failure);
        stream.removeListener("error", onError);
    };
    owner = {
        sendStart: (callback) => stream.write(DOCUMENT_START_FRAME, callback),
        close: () => {
            if ("destroy" in stream && typeof stream.destroy === "function")
                stream.destroy();
            else
                stream.end();
        },
        started: false,
        closed: false,
    };
    stream.on("error", onError);
    stream.once("close", onClose);
    return owner;
}
function requireIpcStartGateOwner(child) {
    if (!child.connected || typeof child.send !== "function") {
        throw new Error("document child start gate IPC unavailable");
    }
    let owner;
    const onError = (error) => {
        owner.failure ??= error;
        owner.settleStart?.(error);
    };
    const onDisconnect = () => {
        owner.closed = true;
        owner.failure ??= new Error("document child start gate disconnected");
        owner.settleStart?.(owner.failure);
        child.removeListener("error", onError);
    };
    owner = {
        sendStart: (callback) => {
            child.send(DOCUMENT_START_FRAME, (error) => callback(error));
        },
        close: () => {
            if (child.connected)
                child.disconnect();
        },
        started: false,
        closed: false,
    };
    child.on("error", onError);
    child.once("disconnect", onDisconnect);
    return owner;
}
async function writeStartFrame(owner) {
    if (owner.started || owner.closed)
        throw new Error("document child start gate unavailable");
    if (owner.failure !== undefined)
        throw owner.failure;
    owner.started = true;
    await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (error) => {
            if (settled)
                return;
            settled = true;
            if (owner.settleStart === settle)
                owner.settleStart = undefined;
            if (error === undefined || error === null) {
                resolve();
            }
            else {
                reject(error);
            }
        };
        owner.settleStart = settle;
        try {
            owner.sendStart(settle);
        }
        catch (error) {
            settle(error);
        }
    });
}
function closeStartGate(owner) {
    if (owner === undefined || owner.closed)
        return;
    owner.closed = true;
    owner.failure ??= new Error("document child start gate closed");
    owner.settleStart?.(owner.failure);
    try {
        owner.close();
    }
    catch {
        // Closing the private gate is best-effort after ownership has been retained.
    }
}
function waitForStartupPhase(phase, startupLifecycle) {
    return Promise.race([
        phase.then((value) => {
            const reason = startupLifecycle.terminationReason();
            return reason === undefined
                ? { kind: "completed", value }
                : { kind: "terminated", reason };
        }, (error) => {
            const reason = startupLifecycle.terminationReason();
            return reason === undefined
                ? { kind: "failed", error }
                : { kind: "terminated", reason };
        }),
        startupLifecycle.waitForTermination().then((reason) => ({ kind: "terminated", reason })),
    ]);
}
function retainUntilLateSupervisor(supervisorPromise, child, snapshot, outputOwner, release, capture, startupLifecycle, startGate) {
    const retention = { child, snapshot, outputOwner, release, capture, startGate };
    unsafeChildRetentions.add(retention);
    startupLifecycle.dispose();
    const finalizeGatedRoot = async () => {
        const close = await capture.closeReceipt;
        if (close.error !== null)
            return;
        await drainCapturedChildStreams(child);
        closeStartGate(startGate);
        capture.detachAll();
        try {
            await cleanupSnapshot(snapshot);
            await cleanupOutputSpool(outputOwner);
            release();
            unsafeChildRetentions.delete(retention);
        }
        catch {
            // Exact root close is known, but owned-resource cleanup remains fail-closed.
        }
    };
    const finalizeWithProof = async (supervisor) => {
        const terminator = createVerifiedTerminator(supervisor, startGate);
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const receipt = await terminateWithReceipt(terminator, child);
            if (!receipt.gone) {
                await unrefDelay(100);
                continue;
            }
            await drainCapturedChildStreams(child);
            closeStartGate(startGate);
            capture.detachAll();
            try {
                await cleanupSnapshot(snapshot);
                await cleanupOutputSpool(outputOwner);
                release();
                unsafeChildRetentions.delete(retention);
            }
            catch {
                // Fail closed: recognized absence is required but cleanup must also complete.
            }
            return;
        }
        // The provisional record deliberately retains ownership after unverified cleanup.
    };
    void supervisorPromise.then((supervisor) => {
        void finalizeWithProof(supervisor).catch(() => {
            // A late supervisor failure leaves the provisional retention intact.
        });
    }, (error) => {
        if (isGatedRootGoneError(error)) {
            void finalizeGatedRoot().catch(() => {
                // Exact root close is known, but owned-resource cleanup remains fail-closed.
            });
        }
        // Untyped late readiness rejection has no proof authority; retain fail-closed.
    }).catch(() => {
        // Both handlers are non-throwing, but keep the terminal chain rejection-safe.
    });
}
function createVerifiedTerminator(supervisor, startGate) {
    return async () => {
        const receipt = await terminateWithReceipt(async () => supervisor.terminate(), undefined);
        if (receipt.gone)
            closeStartGate(startGate);
        return receipt;
    };
}
async function terminateWithReceipt(terminator, child, failureReason = "termination") {
    try {
        return normalizeProcessTreeTerminationReceipt(await terminator(child), failureReason);
    }
    catch {
        return unverifiedTermination(failureReason);
    }
}
function terminationFailedError() {
    return createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
        stage: "shutdown",
        remediation: "check_installation",
    });
}
async function cleanupFailedPreDispatch(child, snapshot, outputOwner, release, capture, startupLifecycle, startGate) {
    const close = await waitWithTimeout(capture.closeReceipt, 1_000);
    if (close === undefined || close.error !== null) {
        startupLifecycle.dispose();
        retainUntilGatedRootClose(child, snapshot, outputOwner, release, capture, startGate);
        return;
    }
    closeStartGate(startGate);
    await drainCapturedChildStreams(child);
    capture.detachAll();
    startupLifecycle.dispose();
    await cleanupSnapshot(snapshot);
    await cleanupOutputSpool(outputOwner);
    release();
}
function retainUntilGatedRootClose(child, snapshot, outputOwner, release, capture, startGate) {
    const retention = { child, snapshot, outputOwner, release, capture, startGate };
    unsafeChildRetentions.add(retention);
    void capture.closeReceipt.then(async (close) => {
        if (close.error !== null)
            return;
        closeStartGate(startGate);
        await drainCapturedChildStreams(child);
        capture.detachAll();
        await cleanupSnapshot(snapshot);
        await cleanupOutputSpool(outputOwner);
        release();
        unsafeChildRetentions.delete(retention);
    }).catch(() => {
        // A missing exact close receipt retains the gate and owned spools fail-closed.
    });
}
function retainUnverifiedPreDispatch(child, snapshot, outputOwner, release, capture, startupLifecycle, startGate) {
    unsafeChildRetentions.add({ child, snapshot, outputOwner, release, capture, startGate });
    startupLifecycle.dispose();
}
async function terminateExpiredStartup(child, snapshot, outputOwner, release, treeTerminator, startupCapture, startupLifecycle, startGate) {
    const receipt = await terminateWithReceipt(treeTerminator, child);
    if (!receipt.gone) {
        startupLifecycle.dispose();
        scheduleCleanupAfterActualExit(child, snapshot, outputOwner, release, startupCapture, treeTerminator, startGate);
        throw terminationFailedError();
    }
    await drainCapturedChildStreams(child);
    startupCapture.detachAll();
    const terminationReason = startupLifecycle.terminationReason();
    startupLifecycle.dispose();
    await cleanupSnapshot(snapshot);
    await cleanupOutputSpool(outputOwner);
    release();
    if (startupCapture.oomDetector.matched) {
        throw createDocumentEngineRunError("ENGINE_OOM", {
            stage: "startup",
            remediation: "reduce_input",
        });
    }
    if (terminationReason !== undefined) {
        throw startupTerminationError(terminationReason);
    }
    if (startupCapture.terminal.observedAt !== undefined) {
        throw createDocumentEngineRunError("ENGINE_INIT_FAILED", {
            stage: "startup",
        });
    }
    throw createDocumentEngineRunError("ENGINE_TIMEOUT");
}
async function runChild(request, snapshot, options, deadlineMs, child, release, outputOwner, treeTerminator, controlFrameAllocationObserver, startupCapture, startupLifecycle, startGate) {
    const startedAt = Date.now();
    const validator = createChildDocumentEventValidator(request.requestId, request.operation, request.operation === "generateHwpx"
        ? 0
        : snapshot?.metadata.sizeBytes ?? 0);
    let ready = false;
    let settling = false;
    let deadlineTimer;
    let abortListener;
    const capture = startupCapture ?? createChildStartupCapture(child);
    const drainReceipt = capture.drainReceipt;
    const oomDetector = capture.oomDetector;
    const controlDecoder = new BoundedFrameDecoder(MAX_CHILD_INLINE_RESULT_BYTES, controlFrameAllocationObserver);
    const controlStream = child.stdio[6];
    if (controlStream == null) {
        throw createDocumentEngineRunError("ENGINE_INIT_FAILED");
    }
    return new Promise((resolve, reject) => {
        const onStdout = capture.onStdout;
        const onStderr = capture.onStderr;
        const requestInput = child.stdin;
        let requestDispatchSettled = false;
        const detachListeners = () => {
            child.off("error", onError);
            child.off("exit", onExit);
            controlStream.off("data", onControlData);
            controlStream.off("end", onControlEnd);
            controlStream.off("error", onControlError);
            if (deadlineTimer !== undefined)
                clearTimeout(deadlineTimer);
            if (startupLifecycle !== undefined) {
                startupLifecycle.dispose();
            }
            else if (abortListener !== undefined && options.signal !== undefined) {
                options.signal.removeEventListener("abort", abortListener);
            }
        };
        const settle = (outcome) => {
            if (settling)
                return;
            settling = true;
            detachListeners();
            void (async () => {
                let terminalError = "error" in outcome ? outcome.error : undefined;
                const receipt = await terminateWithReceipt(treeTerminator, child);
                if (!receipt.gone) {
                    scheduleCleanupAfterActualExit(child, snapshot, outputOwner, release, capture, treeTerminator, startGate);
                    reject(terminationFailedError());
                    return;
                }
                await drainCapturedChildStreams(child);
                capture.detachAll();
                if (oomDetector.matched) {
                    terminalError = createDocumentEngineRunError("ENGINE_OOM", {
                        stage: ready ? request.operation : "startup",
                        remediation: "reduce_input",
                    });
                }
                try {
                    await cleanupSnapshot(snapshot);
                }
                catch (error) {
                    terminalError ??= error;
                }
                let resolvedResult;
                if (terminalError === undefined) {
                    try {
                        if ("spoolReceipt" in outcome) {
                            resolvedResult = await verifyOutputSpool(outputOwner, outcome.spoolReceipt);
                        }
                        else {
                            await assertEmptyOutputSpool(outputOwner);
                            await cleanupOutputSpool(outputOwner);
                            resolvedResult = outcome.result;
                        }
                    }
                    catch {
                        terminalError = createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
                    }
                }
                if (terminalError !== undefined) {
                    try {
                        await cleanupOutputSpool(outputOwner);
                    }
                    catch (error) {
                        terminalError = error;
                    }
                }
                release();
                if (terminalError !== undefined) {
                    if (terminalError instanceof DocumentEngineRunError) {
                        reject(terminalError);
                        return;
                    }
                    reject(new DocumentEngineRunError(normalizeDocumentEngineError(terminalError, {
                        ready,
                        ...(!("terminationReason" in outcome) || outcome.terminationReason === undefined
                            ? {}
                            : { terminationReason: outcome.terminationReason }),
                        stage: ready ? request.operation : "startup",
                        elapsedMs: Math.max(0, Date.now() - startedAt),
                    })));
                    return;
                }
                resolve(resolvedResult);
            })();
        };
        const settleRequestDispatch = (error) => {
            if (requestDispatchSettled)
                return;
            requestDispatchSettled = true;
            if (error !== undefined && error !== null)
                settle({ error });
        };
        const onRequestInputError = (error) => settleRequestDispatch(error);
        const onRequestInputOwnerClose = () => {
            requestInput?.removeListener("error", onRequestInputError);
        };
        requestInput?.on("error", onRequestInputError);
        child.once("close", onRequestInputOwnerClose);
        const onMessage = (value) => {
            if (settling)
                return;
            try {
                const event = validator.accept(value);
                if (event.type === "ready") {
                    ready = true;
                    return;
                }
                if (event.type === "progress") {
                    options.onProgress?.(event.completed, event.total);
                    return;
                }
                if (event.type === "metrics") {
                    options.onMetrics?.(Object.freeze({ copiedBytes: event.copiedBytes }));
                    return;
                }
                if (event.type === "failure") {
                    settle({
                        error: event.error.code === "ENGINE_OOM" || ready
                            ? new DocumentEngineRunError(event.error)
                            : createDocumentEngineRunError("ENGINE_INIT_FAILED", {
                                stage: "startup",
                            }),
                    });
                    return;
                }
                if (event.type === "spoolResult") {
                    settle({ spoolReceipt: event.receipt });
                    return;
                }
                settle({ result: event.payload });
            }
            catch {
                settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
            }
        };
        const onError = (error) => settle({ error });
        const onExit = (code, signal) => {
            if (!settling)
                settle({ error: new Error(`child exit ${code ?? signal ?? "unknown"}`) });
        };
        const onControlData = (chunk) => {
            if (settling)
                return;
            try {
                for (const frame of controlDecoder.push(chunk)) {
                    onMessage(parseBoundedJsonFrame(frame));
                }
            }
            catch {
                settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
            }
        };
        const onControlEnd = () => {
            if (settling)
                return;
            try {
                controlDecoder.finish();
            }
            catch {
                settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
            }
        };
        const onControlError = () => {
            if (!settling) {
                settle({ error: createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR") });
            }
        };
        controlStream.on("data", onControlData);
        controlStream.on("end", onControlEnd);
        controlStream.on("error", onControlError);
        child.on("error", onError);
        child.on("exit", onExit);
        capture.detachTerminal();
        abortListener = () => settle({
            error: new Error("cancelled"),
            terminationReason: "abort",
        });
        if (startupLifecycle !== undefined) {
            startupLifecycle.handoffAbort(abortListener);
            const startupTerminationReason = startupLifecycle.terminationReason();
            if (startupTerminationReason !== undefined) {
                settle({
                    error: new Error(startupTerminationReason),
                    terminationReason: startupTerminationReason,
                });
                return;
            }
        }
        else {
            options.signal?.addEventListener("abort", abortListener, { once: true });
            if (options.signal?.aborted === true) {
                abortListener();
                return;
            }
        }
        deadlineTimer = setTimeout(() => settle({
            error: new Error("deadline"),
            terminationReason: "deadline",
        }), deadlineMs);
        deadlineTimer.unref();
        if (capture.terminal.error !== undefined || capture.terminal.exit !== undefined) {
            settle({
                error: capture.terminal.error ?? new Error("child exited during startup"),
            });
            return;
        }
        if (oomDetector.matched) {
            settle({
                error: createDocumentEngineRunError("ENGINE_OOM", {
                    stage: "startup",
                    remediation: "reduce_input",
                }),
            });
            return;
        }
        try {
            const transports = {};
            if (request.operation !== "generateHwpx") {
                if (snapshot?.transport !== "spool") {
                    throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
                }
                transports.document = {
                    transport: "spool",
                    descriptor: 3,
                    sizeBytes: snapshot.metadata.sizeBytes,
                };
            }
            if (request.operation === "insertImage") {
                if (options.imageInput?.transport === "spool") {
                    transports.image = {
                        transport: "spool",
                        descriptor: 4,
                        sizeBytes: options.imageInput.sizeBytes,
                    };
                }
                else {
                    throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
                }
            }
            const wire = createWireDocumentRequest(request, transports, "child");
            const frame = encodeBoundedJsonFrame(wire, MAX_CHILD_REQUEST_FRAME_BYTES);
            if (requestInput === null)
                throw new Error("child stdin unavailable");
            requestInput.end(frame, (error) => settleRequestDispatch(error));
        }
        catch (error) {
            settleRequestDispatch(error);
        }
    });
}
async function createWindowsJobSupervisor(child, readyDeadlineMs, frameObserver, forceTracker = false) {
    if (child.pid === undefined)
        throw new Error("child pid unavailable");
    const targetCloseReceipt = observeChildProcessClose(child);
    const powershell = resolveWindowsSystemExecutable("powershell.exe", "win32", process.env.SystemRoot);
    const script = resolveWindowsJobSupervisorScript();
    const helper = spawn(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-TargetPid",
        String(child.pid),
        ...(forceTracker ? ["-ForceTracker"] : []),
    ], {
        shell: false,
        windowsHide: true,
        env: createJobHelperEnvironment(process.env),
        stdio: ["pipe", "pipe", "pipe"],
    });
    const closeReceipt = observeChildProcessClose(helper);
    let stdinFailed = helper.stdin === null;
    helper.stdin?.on("error", () => { stdinFailed = true; });
    let stderrBytes = 0;
    helper.stderr?.on("data", (chunk) => {
        stderrBytes = Math.min(MAX_DRAIN_ACCOUNTED_BYTES, stderrBytes + chunk.byteLength);
    });
    helper.stderr?.on("error", () => { stderrBytes = Math.max(1, stderrBytes); });
    if (helper.stdout === null || helper.stdin === null || helper.stderr === null) {
        if (!await cleanupWindowsSupervisorHelper(helper, closeReceipt)) {
            throw supervisorHelperUnclosedError(helper, closeReceipt);
        }
        throw new Error("job supervisor pipes unavailable");
    }
    const lines = new BoundedSupervisorLineReader(helper.stdout, 128);
    let readyMode;
    try {
        const ready = await lines.next(readyDeadlineMs);
        frameObserver?.(ready);
        const readyMatch = new RegExp(`^GPT_CODEX_HWP_JOB READY ${child.pid} ([12]) [0-9]+$`, "u").exec(ready);
        if (readyMatch === null) {
            throw new Error("invalid job supervisor READY frame");
        }
        readyMode = Number(readyMatch[1]);
    }
    catch (error) {
        if (!await cleanupWindowsSupervisorHelper(helper, closeReceipt)) {
            throw supervisorHelperUnclosedError(helper, closeReceipt);
        }
        throw error;
    }
    let commandSent = false;
    let gatedRootGone = false;
    let helperCleanupVerified = true;
    let verifiedReceipt;
    let activeTermination;
    let processTreeRss;
    const supervisor = {
        processTreeTelemetryReady: Promise.resolve(true),
        processTreeRss: () => processTreeRss,
        terminate() {
            if (verifiedReceipt?.gone === true)
                return Promise.resolve(verifiedReceipt);
            activeTermination ??= (async () => {
                let proved = false;
                try {
                    if (!commandSent) {
                        commandSent = true;
                        helper.stdin.end("TERMINATE\n");
                    }
                    let frame = await lines.next(WINDOWS_SUPERVISOR_TERMINATION_FRAME_MS);
                    if (forceTracker && /^GPT_CODEX_HWP_JOB TRACKER [0-9]+ [0-9]+$/u.test(frame)) {
                        frameObserver?.(frame);
                        frame = await lines.next(WINDOWS_SUPERVISOR_TERMINATION_FRAME_MS);
                    }
                    frameObserver?.(frame);
                    processTreeRss = parseProcessTreeRssFrame(frame);
                    const gone = await lines.next(WINDOWS_SUPERVISOR_TERMINATION_FRAME_MS);
                    frameObserver?.(gone);
                    const matchingGone = gone === `GPT_CODEX_HWP_JOB GONE 0 ${readyMode}`;
                    const authorityGone = readyMode === 1 && matchingGone;
                    const finalized = await finalizeVerifiedWindowsSupervisor({
                        closeReceipt,
                        forceClose: () => helper.kill(),
                        allowForceClose: authorityGone,
                        transcriptReceipt: () => Object.freeze({
                            stdinFailed,
                            stderrBytes,
                            ...lines.transcriptReceipt(),
                        }),
                    });
                    if (!finalized)
                        return unverifiedTermination("termination");
                    if (readyMode === 2 && matchingGone) {
                        const targetClose = await waitWithTimeout(targetCloseReceipt, 5_000);
                        gatedRootGone = targetClose !== undefined && targetClose.error === null;
                        return unverifiedTermination("identity");
                    }
                    if (!matchingGone || !authorityGone) {
                        return unverifiedTermination("identity");
                    }
                    verifiedReceipt = Object.freeze({
                        gone: true,
                        proof: "windows-job-empty",
                    });
                    proved = true;
                    return verifiedReceipt;
                }
                catch {
                    return unverifiedTermination("channel");
                }
                finally {
                    if (!proved) {
                        if (!await cleanupWindowsSupervisorHelper(helper, closeReceipt)) {
                            helperCleanupVerified = false;
                        }
                    }
                    activeTermination = undefined;
                }
            })();
            return activeTermination;
        },
    };
    if (readyMode !== 1) {
        await supervisor.terminate();
        if (gatedRootGone)
            throw gatedRootGoneError();
        if (!helperCleanupVerified)
            throw supervisorHelperUnclosedError(helper, closeReceipt);
        throw new Error("Windows Job authority unavailable");
    }
    return supervisor;
}
export async function finalizeVerifiedWindowsSupervisor({ closeReceipt, forceClose, allowForceClose, transcriptReceipt, gracefulExitMs = 1_000, forcedExitMs = 4_000, }) {
    const gracefulClose = await waitWithTimeout(closeReceipt, gracefulExitMs);
    if (gracefulClose !== undefined) {
        return gracefulClose.code === 0 && gracefulClose.signal === null &&
            gracefulClose.error === null && cleanWindowsSupervisorTranscript(transcriptReceipt);
    }
    let closeRequested = false;
    try {
        closeRequested = forceClose();
    }
    catch {
        closeRequested = false;
    }
    const forcedClose = await waitWithTimeout(closeReceipt, forcedExitMs);
    return allowForceClose && closeRequested && forcedClose !== undefined && forcedClose.code === null &&
        forcedClose.signal === "SIGTERM" && forcedClose.error === null &&
        cleanWindowsSupervisorTranscript(transcriptReceipt);
}
function cleanWindowsSupervisorTranscript(receipt) {
    try {
        const value = receipt();
        return value.stdinFailed === false && value.stderrBytes === 0 && value.stdoutEnded === true &&
            value.stdoutFailed === false && value.protocolFailed === false && value.queuedFrames === 0 &&
            value.partialBytes === 0;
    }
    catch {
        return false;
    }
}
export async function superviseDocumentProcessTree(child, options = {}) {
    if (child.pid === undefined)
        throw new Error("child pid unavailable");
    if (process.platform === "win32") {
        return createWindowsJobSupervisor(child, 5_000, options.frameObserver);
    }
    return createPosixProcessTreeSupervisor(child, process.platform, {
        deferProcessTreeTelemetryStop: options.deferProcessTreeTelemetryStop,
        frameObserver: options.frameObserver,
    });
}
/** Test-only authority-failure entrypoint; production callers cannot disable Job assignment. */
export async function superviseDocumentProcessTreeWithForcedTrackerForTest(child, frameObserver) {
    if (process.platform !== "win32")
        throw new Error("Windows tracker test is unavailable");
    return createWindowsJobSupervisor(child, 5_000, frameObserver, true);
}
export function createPosixProcessTelemetryTrackerForTest(rootPid, platform, snapshots) {
    return new PosixProcessTreeTracker(rootPid, platform, snapshots);
}
export function createPosixProcessTreeSupervisorForTest(child, platform, dependencies) {
    return createPosixProcessTreeSupervisor(child, platform, dependencies);
}
async function createPosixProcessTreeSupervisor(child, platform, dependencies = {}) {
    if (child.pid === undefined)
        throw new Error("child pid unavailable");
    if (platform !== "linux" && platform !== "darwin") {
        throw new Error(`unsupported process-tree metrics platform: ${platform}`);
    }
    const registeredSupervisor = dependencies.registeredSupervisor
        ?? createRegisteredPosixProcessGroupSupervisor({
            inspectIdentity: (pid) => snapshotRegisteredPosixProcessGroupIdentity(pid, platform),
        });
    try {
        await registeredSupervisor.registerRoot(child.pid, process.pid);
    }
    catch (error) {
        dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR root-authority");
        throw error;
    }
    const tracker = dependencies.tracker ?? new PosixProcessTreeTracker(child.pid, platform);
    const scheduleInterval = dependencies.scheduleInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    const clearScheduledInterval = dependencies.clearScheduledInterval ?? ((handle) => {
        clearInterval(handle);
    });
    let telemetryState = "initializing";
    let sampler;
    let sampleRunning = false;
    let sampleRequested = false;
    let requiredTelemetryGeneration = 0;
    let coveredTelemetryGeneration = 0;
    const telemetryRootKeys = new Set();
    const coverageWaiters = new Set();
    let settleTelemetryReady;
    let telemetryReadySettled = false;
    const processTreeTelemetryReady = new Promise((resolve) => {
        settleTelemetryReady = (available) => {
            if (telemetryReadySettled)
                return;
            telemetryReadySettled = true;
            resolve(available);
        };
    });
    let stoppedProcessTreeRss;
    let verifiedTerminationReceipt;
    let activeTermination;
    const clearSampler = () => {
        const handle = sampler;
        sampler = undefined;
        if (handle === undefined)
            return;
        try {
            clearScheduledInterval(handle);
        }
        catch { }
    };
    const disableTracker = () => {
        try {
            tracker.disableTelemetry();
        }
        catch { }
    };
    const deactivateTelemetry = (state) => {
        telemetryState = state;
        settleTelemetryReady(false);
        sampleRequested = false;
        clearSampler();
        disableTracker();
        for (const settle of coverageWaiters)
            settle(false);
        coverageWaiters.clear();
    };
    const settleCoverageWaiters = () => {
        if (telemetryState !== "active" || sampleRunning ||
            coveredTelemetryGeneration < requiredTelemetryGeneration)
            return;
        for (const settle of coverageWaiters)
            settle(true);
        coverageWaiters.clear();
    };
    const readCompleteProcessTreeRss = () => {
        if (telemetryState !== "active" || sampleRunning ||
            coveredTelemetryGeneration < requiredTelemetryGeneration)
            return undefined;
        try {
            return tracker.telemetryAvailable() ? tracker.processTreeRss() : undefined;
        }
        catch {
            deactivateTelemetry("disabled");
            return undefined;
        }
    };
    const queueSample = () => {
        if (telemetryState !== "active")
            return;
        if (sampleRunning) {
            sampleRequested = true;
            return;
        }
        sampleRunning = true;
        sampleRequested = false;
        const sampleGeneration = requiredTelemetryGeneration;
        let sample;
        try {
            sample = tracker.sample();
        }
        catch {
            sampleRunning = false;
            deactivateTelemetry("disabled");
            return;
        }
        void sample.then(() => {
            sampleRunning = false;
            if (telemetryState !== "active")
                return;
            coveredTelemetryGeneration = Math.max(coveredTelemetryGeneration, sampleGeneration);
            if (sampleRequested ||
                coveredTelemetryGeneration < requiredTelemetryGeneration) {
                queueSample();
                return;
            }
            settleCoverageWaiters();
        }, () => {
            sampleRunning = false;
            if (telemetryState === "active") {
                dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR telemetry-sample");
                deactivateTelemetry("disabled");
            }
        }).catch(() => {
            sampleRunning = false;
            if (telemetryState === "active") {
                dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR telemetry-sample");
                deactivateTelemetry("disabled");
            }
        });
    };
    let initialization;
    try {
        initialization = tracker.initialize();
    }
    catch {
        dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR telemetry-initialize");
        deactivateTelemetry("disabled");
    }
    if (initialization !== undefined) {
        void initialization.then(() => {
            if (telemetryState !== "initializing")
                return;
            telemetryState = "active";
            try {
                sampler = scheduleInterval(queueSample, platform === "linux" ? LINUX_PROCESS_SAMPLE_MS : MACOS_PROCESS_SAMPLE_MS);
                sampler.unref();
                settleTelemetryReady(true);
            }
            catch {
                deactivateTelemetry("disabled");
            }
        }, () => {
            if (telemetryState === "initializing") {
                dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR telemetry-initialize");
                deactivateTelemetry("disabled");
            }
        }).catch(() => {
            if (telemetryState !== "stopped")
                deactivateTelemetry("disabled");
        });
    }
    const stopTelemetry = () => {
        if (telemetryState === "stopped")
            return;
        stoppedProcessTreeRss = readCompleteProcessTreeRss();
        deactivateTelemetry("stopped");
    };
    return {
        processTreeTelemetryReady,
        registerProcessTreeTelemetryRoot(identity) {
            if (telemetryState !== "active") {
                throw new Error("process-tree telemetry is not active");
            }
            const key = `${identity.pid}:${identity.processGroupId}:${identity.identity}:${identity.startOrder}`;
            if (telemetryRootKeys.has(key)) {
                throw new Error("process-tree telemetry root already registered");
            }
            tracker.registerRoot(identity);
            telemetryRootKeys.add(key);
            requiredTelemetryGeneration += 1;
            queueSample();
        },
        finishProcessTreeTelemetry() {
            stopTelemetry();
        },
        flushProcessTreeTelemetry() {
            if (telemetryState !== "active")
                return Promise.resolve(false);
            if (!sampleRunning && coveredTelemetryGeneration >= requiredTelemetryGeneration) {
                return Promise.resolve(true);
            }
            return new Promise((resolvePromise) => {
                coverageWaiters.add(resolvePromise);
                if (!sampleRunning)
                    queueSample();
                settleCoverageWaiters();
            });
        },
        processTreeRss: () => telemetryState === "stopped"
            ? stoppedProcessTreeRss
            : readCompleteProcessTreeRss(),
        terminate() {
            if (verifiedTerminationReceipt?.gone === true) {
                return Promise.resolve(verifiedTerminationReceipt);
            }
            if (activeTermination !== undefined)
                return activeTermination;
            let registeredTermination;
            try {
                registeredTermination = registeredSupervisor.terminate();
            }
            catch (error) {
                registeredTermination = Promise.reject(error);
            }
            const settledAttempt = registeredTermination.then((receipt) => {
                if (dependencies.deferProcessTreeTelemetryStop !== true)
                    stopTelemetry();
                const recognized = normalizeProcessTreeTerminationReceipt(receipt);
                if (recognized.gone === true)
                    verifiedTerminationReceipt = recognized;
                return receipt;
            }, (error) => {
                if (dependencies.deferProcessTreeTelemetryStop !== true)
                    stopTelemetry();
                throw error;
            });
            let sharedAttempt;
            sharedAttempt = settledAttempt.finally(() => {
                if (activeTermination === sharedAttempt)
                    activeTermination = undefined;
            });
            activeTermination = sharedAttempt;
            return sharedAttempt;
        },
    };
}
class PosixProcessTreeTracker {
    snapshots;
    #rootPid;
    #platform;
    #retained = new Map();
    #retainedByPid = new Map();
    #baselineBytes = 0;
    #peakBytes = 0;
    #telemetryAvailable = true;
    constructor(rootPid, platform, snapshots) {
        this.snapshots = snapshots;
        this.#rootPid = rootPid;
        this.#platform = platform;
    }
    async initialize() {
        const root = this.snapshots === undefined
            ? this.#platform === "linux"
                ? await snapshotLinuxProcess(this.#rootPid)
                : (await snapshotPosixProcesses(this.#platform))
                    .find((record) => record.pid === this.#rootPid)
            : await this.snapshots.root();
        if (root === undefined || root.rssBytes <= 0) {
            throw new Error("root process identity or RSS unavailable");
        }
        this.#retain({ ...root, depth: 0 });
        const records = await this.#snapshot();
        const live = this.#observe(records);
        this.#baselineBytes = sumProcessRss(live);
        if (this.#baselineBytes <= 0)
            throw new Error("baseline process-tree RSS unavailable");
        this.#peakBytes = this.#baselineBytes;
    }
    async sample() {
        const live = this.#observe(await this.#snapshot());
        this.#peakBytes = Math.max(this.#peakBytes, sumProcessRss(live));
        return live;
    }
    registerRoot(identity) {
        if (identity.pid !== identity.processGroupId) {
            throw new Error("telemetry root is not a process-group leader");
        }
        const key = posixIdentityKey(identity);
        const sampled = this.#retained.get(key);
        if (sampled !== undefined) {
            if (!samePosixStableIdentity(sampled, identity)) {
                throw new Error("telemetry root identity mismatch");
            }
            this.#replaceRetained(Object.freeze({ ...sampled, depth: 0 }));
            return;
        }
        this.#retain(Object.freeze({
            ...identity,
            rssBytes: 0,
            depth: 0,
        }));
    }
    async #snapshot() {
        if (this.snapshots !== undefined)
            return [...await this.snapshots.tree()];
        return this.#platform === "linux"
            ? snapshotLinuxRetainedTree(this.#retained)
            : snapshotPosixProcesses(this.#platform, this.#retained);
    }
    processTreeRss() {
        return Object.freeze({
            baselineBytes: this.#baselineBytes,
            peakBytes: this.#peakBytes,
        });
    }
    telemetryAvailable() {
        return this.#telemetryAvailable;
    }
    disableTelemetry() {
        this.#telemetryAvailable = false;
    }
    #observe(records) {
        const liveByPid = new Map(records.map((record) => [record.pid, record]));
        let changed = true;
        while (changed) {
            changed = false;
            for (const record of records) {
                const key = posixIdentityKey(record);
                if (this.#retained.has(key))
                    continue;
                const parent = this.#retainedParent(record, liveByPid);
                if (parent === undefined || record.startOrder < parent.startOrder)
                    continue;
                this.#retain({ ...record, depth: parent.depth + 1 });
                changed = true;
            }
        }
        return records.flatMap((record) => {
            const retained = this.#retained.get(posixIdentityKey(record));
            return retained === undefined ? [] : [{ ...retained, rssBytes: record.rssBytes }];
        });
    }
    #retainedParent(record, liveByPid) {
        const liveParent = liveByPid.get(record.parentPid);
        if (liveParent !== undefined) {
            return this.#retained.get(posixIdentityKey(liveParent));
        }
        return this.#retainedByPid.get(record.parentPid)
            ?.filter((candidate) => candidate.startOrder <= record.startOrder)
            .sort((left, right) => right.startOrder - left.startOrder)[0];
    }
    #retain(record) {
        if (this.#retained.size >= MAX_TRACKED_PROCESS_IDENTITIES) {
            throw new Error("retained process identity limit exceeded");
        }
        const key = posixIdentityKey(record);
        this.#retained.set(key, record);
        const identities = this.#retainedByPid.get(record.pid) ?? [];
        identities.push(record);
        this.#retainedByPid.set(record.pid, identities);
    }
    #replaceRetained(record) {
        const key = posixIdentityKey(record);
        const identities = this.#retainedByPid.get(record.pid);
        const index = identities?.findIndex((candidate) => posixIdentityKey(candidate) === key) ?? -1;
        if (index < 0 || identities === undefined) {
            throw new Error("retained process identity index mismatch");
        }
        const replacement = [...identities];
        replacement[index] = record;
        this.#retained.set(key, record);
        this.#retainedByPid.set(record.pid, replacement);
    }
}
function samePosixStableIdentity(left, right) {
    return left.pid === right.pid &&
        left.processGroupId === right.processGroupId &&
        left.identity === right.identity &&
        left.startOrder === right.startOrder;
}
function posixIdentityKey(record) {
    return `${record.pid}:${record.identity}`;
}
function sumProcessRss(records) {
    let total = 0;
    for (const record of records) {
        if (!Number.isSafeInteger(record.rssBytes) || record.rssBytes < 0
            || total > Number.MAX_SAFE_INTEGER - record.rssBytes) {
            throw new Error("process-tree RSS overflow");
        }
        total += record.rssBytes;
    }
    return total;
}
async function snapshotPosixProcesses(platform, retained = new Map()) {
    if (platform === "linux")
        throw new Error("Linux uses retained /proc task traversal");
    const identitiesBefore = await macosKernelIdentities();
    const psRecords = await snapshotMacosPsRecords();
    const retainedPids = [...new Set([...retained.values()].map((record) => record.pid))];
    const identitiesAfter = await macosKernelIdentities([...new Set([...psRecords.map((record) => record.pid), ...retainedPids])]);
    return bindMacosProcessRecords(psRecords, identitiesBefore, identitiesAfter, retained);
}
async function snapshotMacosPsRecords() {
    const result = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,rss="], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
    const records = [];
    for (const line of String(result.stdout).split(/\r?\n/u)) {
        if (line.trim() === "")
            continue;
        if (records.length >= MAX_TRACKED_PROCESS_IDENTITIES) {
            throw new Error("macOS ps process limit exceeded");
        }
        const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s+([0-9]+)\s*$/u.exec(line);
        if (match === null)
            throw new Error("invalid macOS ps record");
        const pid = Number(match[1]);
        const parentPid = Number(match[2]);
        const rssBytes = Number(match[3]) * 1024;
        if (![pid, parentPid, rssBytes].every(Number.isSafeInteger)
            || pid <= 0 || parentPid < 0 || rssBytes < 0) {
            throw new Error("invalid macOS process record");
        }
        records.push(Object.freeze({ pid, parentPid, rssBytes }));
    }
    return records;
}
function bindMacosProcessRecords(psRecords, identitiesBefore, identitiesAfter, retained) {
    const records = [];
    const retainedPids = new Set([...retained.values()].map((record) => record.pid));
    for (const psRecord of psRecords) {
        const before = identitiesBefore.get(psRecord.pid);
        const after = identitiesAfter.get(psRecord.pid);
        if (before === undefined || after === undefined) {
            if (retainedPids.has(psRecord.pid)) {
                throw new Error("visible retained macOS identity unavailable");
            }
            continue;
        }
        if (before.identity !== after.identity
            || before.startOrder !== after.startOrder
            || before.parentPid !== after.parentPid
            || psRecord.parentPid !== before.parentPid) {
            if (retainedPids.has(psRecord.pid)) {
                throw new Error("retained macOS identity changed during ps sample");
            }
            continue;
        }
        records.push(Object.freeze({
            ...psRecord,
            identity: before.identity,
            startOrder: before.startOrder,
            processGroupId: before.processGroupId,
        }));
    }
    const psPids = new Set(psRecords.map((record) => record.pid));
    for (const retainedProcess of retained.values()) {
        if (psPids.has(retainedProcess.pid))
            continue;
        const before = identitiesBefore.get(retainedProcess.pid);
        const after = identitiesAfter.get(retainedProcess.pid);
        if (before?.identity === retainedProcess.identity
            && after?.identity === retainedProcess.identity) {
            throw new Error("live retained macOS process missing from ps");
        }
    }
    return records;
}
export async function snapshotMacosIdentityTree(retained, identitySource = macosKernelIdentities) {
    const identitiesBefore = await identitySource();
    const identitiesAfter = await identitySource();
    assertMacosIdentityLimit(identitiesBefore, "before snapshot");
    assertMacosIdentityLimit(identitiesAfter, "after snapshot");
    if (retained.size > MAX_TRACKED_PROCESS_IDENTITIES) {
        throw new Error("retained macOS identity limit exceeded");
    }
    const accepted = new Map();
    for (const retainedProcess of retained.values()) {
        const before = identitiesBefore.get(retainedProcess.pid);
        const after = identitiesAfter.get(retainedProcess.pid);
        if (after?.identity !== retainedProcess.identity)
            continue;
        if (before === undefined || !sameMacosKernelIdentity(before, after)) {
            throw new Error("live retained macOS identity did not stabilize");
        }
        addAcceptedMacosIdentity(accepted, Object.freeze({
            pid: retainedProcess.pid,
            ...after,
            rssBytes: 0,
        }));
    }
    const childrenByParent = new Map();
    for (const entry of identitiesAfter) {
        const [pid, identity] = entry;
        const children = childrenByParent.get(identity.parentPid) ?? [];
        children.push(entry);
        childrenByParent.set(identity.parentPid, children);
    }
    const queue = [...accepted.values()];
    let queueIndex = 0;
    let pendingCandidates = new Map();
    const collectReachableCandidates = () => {
        while (queueIndex < queue.length) {
            const parent = queue[queueIndex];
            queueIndex += 1;
            for (const [pid, after] of childrenByParent.get(parent.pid) ?? []) {
                if (accepted.has(pid) || pendingCandidates.has(pid))
                    continue;
                if (after.startOrder < parent.startOrder) {
                    throw new Error("macOS child predates its accepted parent");
                }
                const before = identitiesBefore.get(pid);
                const parentBefore = identitiesBefore.get(parent.pid);
                const parentAfter = identitiesAfter.get(parent.pid);
                const stableAcrossFullSnapshots = before !== undefined
                    && sameMacosKernelIdentity(before, after);
                const stableExactParent = parentBefore !== undefined
                    && parentAfter !== undefined
                    && sameMacosKernelIdentity(parentBefore, parentAfter)
                    && sameMacosKernelIdentity(parentAfter, parent);
                if (stableAcrossFullSnapshots && stableExactParent) {
                    const record = Object.freeze({ pid, ...after, rssBytes: 0 });
                    addAcceptedMacosIdentity(accepted, record);
                    queue.push(record);
                    continue;
                }
                pendingCandidates.set(pid, Object.freeze({ identity: after, parent }));
            }
        }
    };
    collectReachableCandidates();
    for (let round = 0; pendingCandidates.size > 0 && round < MAX_MACOS_IDENTITY_STABILIZATION_ROUNDS; round += 1) {
        const queriedPids = new Set();
        for (const [pid, candidate] of pendingCandidates) {
            queriedPids.add(pid);
            queriedPids.add(candidate.parent.pid);
        }
        if (queriedPids.size > MAX_TRACKED_PROCESS_IDENTITIES) {
            throw new Error("macOS targeted PID limit exceeded");
        }
        const identities = await identitySource([...queriedPids]);
        assertMacosIdentityLimit(identities, "targeted snapshot");
        for (const observedPid of identities.keys()) {
            if (!queriedPids.has(observedPid)) {
                throw new Error("macOS targeted identity query returned an unexpected PID");
            }
        }
        const previousCandidates = pendingCandidates;
        pendingCandidates = new Map();
        for (const [pid, candidate] of previousCandidates) {
            const currentParent = identities.get(candidate.parent.pid);
            if (currentParent === undefined
                || !sameMacosKernelIdentity(currentParent, candidate.parent)) {
                throw new Error("accepted macOS parent identity changed during stabilization");
            }
            const current = identities.get(pid);
            if (current === undefined || current.parentPid !== candidate.parent.pid
                || current.startOrder < candidate.parent.startOrder) {
                throw new Error("macOS child identity changed ancestry during stabilization");
            }
            if (!sameMacosKernelIdentity(candidate.identity, current)) {
                pendingCandidates.set(pid, Object.freeze({
                    identity: current,
                    parent: candidate.parent,
                }));
                continue;
            }
            const record = Object.freeze({ pid, ...current, rssBytes: 0 });
            addAcceptedMacosIdentity(accepted, record);
            queue.push(record);
        }
        collectReachableCandidates();
    }
    if (pendingCandidates.size > 0) {
        throw new Error("macOS child identity stabilization rounds exhausted");
    }
    return [...accepted.values()];
}
function sameMacosKernelIdentity(left, right) {
    return left.identity === right.identity
        && left.startOrder === right.startOrder
        && left.parentPid === right.parentPid
        && left.processGroupId === right.processGroupId;
}
function assertMacosIdentityLimit(identities, label) {
    if (identities.size > MAX_TRACKED_PROCESS_IDENTITIES) {
        throw new Error(`macOS ${label} identity limit exceeded`);
    }
}
function addAcceptedMacosIdentity(accepted, record) {
    if (!accepted.has(record.pid) && accepted.size >= MAX_TRACKED_PROCESS_IDENTITIES) {
        throw new Error("accepted macOS identity limit exceeded");
    }
    accepted.set(record.pid, record);
}
async function snapshotLinuxRetainedTree(retained, requireRss = true) {
    const records = new Map();
    const queued = new Set();
    const queue = [];
    for (const process of retained.values()) {
        enqueueLinuxProcess(queue, queued, {
            pid: process.pid,
            expectedIdentity: process.identity,
        });
    }
    while (queue.length > 0) {
        const item = queue.shift();
        const process = await snapshotLinuxProcess(item.pid, requireRss);
        if (process === undefined || process.identity !== item.expectedIdentity)
            continue;
        const processKey = posixIdentityKey(process);
        if (!records.has(processKey) && records.size >= MAX_TRACKED_PROCESS_IDENTITIES) {
            throw new Error("Linux process record limit exceeded");
        }
        records.set(processKey, process);
        for (const childPid of await linuxTaskChildren(process.pid)) {
            const child = await snapshotLinuxProcess(childPid, requireRss);
            if (child === undefined)
                continue;
            if (child.parentPid !== process.pid)
                continue;
            enqueueLinuxProcess(queue, queued, {
                pid: childPid,
                expectedIdentity: child.identity,
            });
        }
    }
    return [...records.values()];
}
function enqueueLinuxProcess(queue, queued, item) {
    const key = `${item.pid}:${item.expectedIdentity}`;
    if (queued.has(key))
        return;
    if (queued.size >= MAX_TRACKED_PROCESS_IDENTITIES) {
        throw new Error("Linux process queue limit exceeded");
    }
    queued.add(key);
    queue.push(item);
}
async function linuxTaskChildren(pid) {
    try {
        const taskDirectories = [];
        const directory = await opendir(`/proc/${pid}/task`);
        for await (const entry of directory) {
            if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name))
                continue;
            if (taskDirectories.length >= MAX_LINUX_TASKS_PER_PROCESS) {
                throw new Error("Linux task limit exceeded");
            }
            taskDirectories.push(entry.name);
        }
        const children = new Set();
        for (const taskName of taskDirectories) {
            const content = await readBoundedProcText(`/proc/${pid}/task/${taskName}/children`, MAX_LINUX_TASK_CHILDREN_BYTES).catch((error) => {
                if (isMissingProcessError(error))
                    return "";
                throw error;
            });
            for (const token of content.trim().split(/\s+/u)) {
                if (token === "")
                    continue;
                const childPid = Number(token);
                if (!Number.isSafeInteger(childPid) || childPid <= 0) {
                    throw new Error("invalid Linux task children record");
                }
                if (!children.has(childPid) && children.size >= MAX_LINUX_CHILDREN_PER_PROCESS) {
                    throw new Error("Linux child limit exceeded");
                }
                children.add(childPid);
            }
        }
        return [...children];
    }
    catch (error) {
        if (isMissingProcessError(error))
            return [];
        throw error;
    }
}
async function snapshotPosixIdentity(platform, pid) {
    if (platform === "linux")
        return snapshotLinuxProcess(pid, false);
    const identity = (await macosKernelIdentities([pid])).get(pid);
    return identity === undefined
        ? undefined
        : Object.freeze({ pid, ...identity, rssBytes: 0 });
}
export async function snapshotRegisteredPosixProcessGroupIdentity(pid, platform = process.platform) {
    if (platform !== "linux" && platform !== "darwin") {
        throw new Error(`unsupported registered process-group platform: ${platform}`);
    }
    const record = await snapshotPosixIdentity(platform, pid);
    if (record === undefined)
        return undefined;
    return Object.freeze({
        pid: record.pid,
        parentPid: record.parentPid,
        processGroupId: record.processGroupId,
        identity: record.identity,
        startOrder: record.startOrder,
    });
}
async function snapshotLinuxProcess(pid, requireRss = true) {
    try {
        const statBefore = await readBoundedProcText(`/proc/${pid}/stat`, MAX_LINUX_PROC_STAT_BYTES);
        const status = requireRss
            ? await readBoundedProcText(`/proc/${pid}/status`, MAX_LINUX_PROC_STATUS_BYTES)
            : undefined;
        const statAfter = await readBoundedProcText(`/proc/${pid}/stat`, MAX_LINUX_PROC_STAT_BYTES);
        const before = parseLinuxStat(pid, statBefore);
        const after = parseLinuxStat(pid, statAfter);
        if (before.identity !== after.identity || before.parentPid !== after.parentPid)
            return undefined;
        if (status === undefined)
            return Object.freeze({ ...after, rssBytes: 0 });
        const rssMatch = /^VmRSS:\s+([0-9]+)\s+kB$/mu.exec(status);
        if (rssMatch === null)
            throw new Error("Linux VmRSS unavailable");
        const rssBytes = Number(rssMatch[1]) * 1024;
        if (!Number.isSafeInteger(rssBytes) || rssBytes < 0)
            throw new Error("invalid Linux VmRSS");
        return Object.freeze({ ...after, rssBytes });
    }
    catch (error) {
        if (isMissingProcessError(error))
            return undefined;
        throw error;
    }
}
async function readBoundedProcText(path, maxBytes) {
    const handle = await open(path, "r");
    try {
        const bytes = Buffer.allocUnsafe(maxBytes + 1);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const receipt = await handle.read(bytes, offset, bytes.byteLength - offset, null);
            if (receipt.bytesRead === 0)
                break;
            offset += receipt.bytesRead;
        }
        if (offset > maxBytes)
            throw new Error("Linux proc record is oversized");
        return bytes.toString("utf8", 0, offset);
    }
    finally {
        await handle.close();
    }
}
function parseLinuxStat(pid, stat) {
    if (stat.length > 64 * 1024)
        throw new Error("Linux process stat is oversized");
    const close = stat.lastIndexOf(")");
    if (close < 0)
        throw new Error("invalid Linux process stat");
    const fields = stat.slice(close + 1).trim().split(/\s+/u);
    if (fields.length < 20 || fields.length > 64)
        throw new Error("invalid Linux process stat fields");
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startOrder = Number(fields[19]);
    if (![pid, parentPid, processGroupId, startOrder].every(Number.isSafeInteger)
        || pid <= 0 || parentPid < 0 || processGroupId <= 0 || startOrder <= 0) {
        throw new Error("invalid Linux process record");
    }
    return Object.freeze({
        pid,
        parentPid,
        processGroupId,
        identity: String(startOrder),
        startOrder,
    });
}
const MACOS_LIBPROC_IDENTITY_SCRIPT = String.raw `
import ctypes, errno, json, os, sys
class ProcBsdInfo(ctypes.Structure):
    _fields_ = [("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32),
      ("pbi_xstatus", ctypes.c_uint32), ("pbi_pid", ctypes.c_uint32),
      ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
      ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32),
      ("pbi_rgid", ctypes.c_uint32), ("pbi_svuid", ctypes.c_uint32),
      ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
      ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32),
      ("pbi_nfiles", ctypes.c_uint32), ("pbi_pgid", ctypes.c_uint32),
      ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
      ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32),
      ("pbi_start_tvsec", ctypes.c_uint64), ("pbi_start_tvusec", ctypes.c_uint64)]
lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
if ctypes.sizeof(ProcBsdInfo) != 136: raise RuntimeError("unexpected proc_bsdinfo layout")
lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
lib.proc_listpids.restype = ctypes.c_int
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidinfo.restype = ctypes.c_int
if len(sys.argv) > 1:
    pids = [int(value) for value in sys.argv[1:]]
else:
    values = (ctypes.c_int * 4096)()
    size = lib.proc_listpids(1, 0, values, ctypes.sizeof(values))
    if size < 0: raise OSError(ctypes.get_errno(), "proc_listpids")
    if size >= ctypes.sizeof(values): raise RuntimeError("process identity limit exceeded")
    pids = list(values)[:size // ctypes.sizeof(ctypes.c_int)]
out = []
for pid in pids:
    if pid <= 0: continue
    info = ProcBsdInfo(); ctypes.set_errno(0)
    size = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size == 0:
        error = ctypes.get_errno()
        if error not in (0, errno.ESRCH): raise OSError(error, "proc_pidinfo")
        try:
            os.kill(pid, 0)
            exists = True
        except ProcessLookupError:
            exists = False
        except PermissionError:
            exists = True
        if exists: raise RuntimeError("proc_pidinfo unavailable for live pid")
        continue
    if size != ctypes.sizeof(info) or info.pbi_pid != pid: raise RuntimeError("invalid proc_pidinfo")
    out.append({"pid": pid, "ppid": info.pbi_ppid, "pgid": info.pbi_pgid, "sec": info.pbi_start_tvsec, "usec": info.pbi_start_tvusec})
print(json.dumps(out, separators=(",", ":")))
`;
async function macosKernelIdentities(pids = []) {
    if (pids.length > MAX_TRACKED_PROCESS_IDENTITIES)
        throw new Error("macOS PID limit exceeded");
    const result = await execFileAsync("/usr/bin/python3", ["-c", MACOS_LIBPROC_IDENTITY_SCRIPT, ...pids.map(String)], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
    const value = JSON.parse(String(result.stdout));
    if (!Array.isArray(value) || value.length > MAX_TRACKED_PROCESS_IDENTITIES) {
        throw new Error("invalid macOS identity receipt");
    }
    const identities = new Map();
    for (const item of value) {
        if (item === null || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).sort().join(",") !== "pgid,pid,ppid,sec,usec") {
            throw new Error("invalid macOS identity receipt");
        }
        const { pid, ppid, pgid, sec, usec } = item;
        if (![pid, ppid, pgid, sec, usec].every(Number.isSafeInteger)
            || Number(pid) <= 0 || Number(ppid) < 0 || Number(pgid) <= 0 || Number(sec) <= 0
            || Number(usec) < 0 || Number(usec) >= 1_000_000) {
            throw new Error("invalid macOS kernel identity");
        }
        const startOrder = Number(sec) * 1_000_000 + Number(usec);
        if (!Number.isSafeInteger(startOrder) || identities.has(Number(pid))) {
            throw new Error("invalid macOS kernel identity");
        }
        identities.set(Number(pid), Object.freeze({
            identity: `${sec}:${usec}`,
            startOrder,
            parentPid: Number(ppid),
            processGroupId: Number(pgid),
        }));
    }
    return identities;
}
function isMissingProcessError(error) {
    return typeof error === "object" && error !== null && "code" in error
        && ["ENOENT", "ESRCH"].includes(String(error.code));
}
function parseProcessTreeRssFrame(frame) {
    const match = /^GPT_CODEX_HWP_JOB RSS ([0-9]+) ([0-9]+)$/u.exec(frame);
    if (match === null)
        throw new Error("invalid job supervisor RSS frame");
    const baselineBytes = Number(match[1]);
    const peakBytes = Number(match[2]);
    if (!Number.isSafeInteger(baselineBytes) ||
        baselineBytes <= 0 ||
        !Number.isSafeInteger(peakBytes) ||
        peakBytes < baselineBytes) {
        throw new Error("invalid job supervisor RSS values");
    }
    return Object.freeze({ baselineBytes, peakBytes });
}
export function resolveWindowsJobSupervisorScript() {
    return fileURLToPath(new URL("./windows-job-supervisor.ps1", import.meta.url));
}
class BoundedSupervisorLineReader {
    #buffer;
    #length = 0;
    #queue = [];
    #waiters = [];
    #failed;
    #stdoutEnded = false;
    #stdoutFailed = false;
    #protocolFailed = false;
    constructor(stream, maxLineBytes) {
        this.#buffer = Buffer.alloc(maxLineBytes);
        stream.on("data", (chunk) => this.#push(chunk));
        stream.on("end", () => {
            this.#stdoutEnded = true;
            this.#fail(new Error("job supervisor stream ended"));
        });
        stream.on("error", () => {
            this.#stdoutFailed = true;
            this.#fail(new Error("job supervisor stream failed"));
        });
        stream.on("close", () => {
            if (this.#stdoutEnded)
                return;
            this.#stdoutFailed = true;
            this.#fail(new Error("job supervisor stream closed before end"));
        });
    }
    next(timeoutMs) {
        if (this.#queue.length > 0)
            return Promise.resolve(this.#queue.shift());
        if (this.#failed !== undefined)
            return Promise.reject(this.#failed);
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            this.#waiters.push(waiter);
            const timer = setTimeout(() => {
                const index = this.#waiters.indexOf(waiter);
                if (index >= 0)
                    this.#waiters.splice(index, 1);
                reject(new Error("job supervisor frame timeout"));
            }, timeoutMs);
            const resolveOnce = waiter.resolve;
            const rejectOnce = waiter.reject;
            waiter.resolve = (line) => {
                clearTimeout(timer);
                resolveOnce(line);
            };
            waiter.reject = (error) => {
                clearTimeout(timer);
                rejectOnce(error);
            };
        });
    }
    transcriptReceipt() {
        return Object.freeze({
            stdoutEnded: this.#stdoutEnded,
            stdoutFailed: this.#stdoutFailed,
            protocolFailed: this.#protocolFailed,
            queuedFrames: this.#queue.length,
            partialBytes: this.#length,
        });
    }
    #push(chunk) {
        if (this.#failed !== undefined)
            return;
        for (const byte of chunk) {
            if (byte === 0x0a) {
                const end = this.#length > 0 && this.#buffer[this.#length - 1] === 0x0d
                    ? this.#length - 1
                    : this.#length;
                const line = this.#buffer.toString("ascii", 0, end);
                this.#length = 0;
                const waiter = this.#waiters.shift();
                if (waiter === undefined)
                    this.#queue.push(line);
                else
                    waiter.resolve(line);
                continue;
            }
            if ((byte < 0x20 && byte !== 0x0d) ||
                byte > 0x7e ||
                this.#length >= this.#buffer.byteLength) {
                this.#protocolFailed = true;
                this.#fail(new Error("invalid job supervisor frame"));
                return;
            }
            this.#buffer[this.#length] = byte;
            this.#length += 1;
        }
    }
    #fail(error) {
        if (this.#failed !== undefined)
            return;
        this.#failed = error;
        for (const waiter of this.#waiters.splice(0))
            waiter.reject(error);
    }
}
export function observeChildProcessClose(child) {
    const existing = childProcessCloseReceipts.get(child);
    if (existing !== undefined)
        return existing;
    const receipt = new Promise((resolve) => {
        let childError = null;
        const onError = (error) => { childError ??= error; };
        child.on("error", onError);
        child.once("close", (code, signal) => {
            child.removeListener("error", onError);
            resolve(Object.freeze({ code, signal, error: childError }));
        });
    });
    childProcessCloseReceipts.set(child, receipt);
    return receipt;
}
export function cleanupWindowsSupervisorHelper(helper, closeReceipt, timeoutMs = 1_000) {
    const existing = supervisorHelperCleanupPromises.get(helper);
    if (existing !== undefined)
        return existing;
    const cleanup = performWindowsSupervisorHelperCleanup(helper, closeReceipt, timeoutMs);
    supervisorHelperCleanupPromises.set(helper, cleanup);
    return cleanup;
}
async function performWindowsSupervisorHelperCleanup(helper, closeReceipt, timeoutMs) {
    let closed = await waitWithTimeout(closeReceipt, 1);
    const firstWaitMs = Math.max(1, Math.floor(timeoutMs / 2));
    if (closed === undefined) {
        try {
            helper.kill();
        }
        catch { /* escalate below */ }
        closed = await waitWithTimeout(closeReceipt, firstWaitMs);
    }
    if (closed === undefined) {
        try {
            helper.kill("SIGKILL");
        }
        catch { /* bounded cleanup is exhausted */ }
        closed = await waitWithTimeout(closeReceipt, Math.max(1, timeoutMs - firstWaitMs));
    }
    if (closed === undefined) {
        retainUnclosedWindowsSupervisorHelper(helper, closeReceipt);
        return false;
    }
    releaseClosedWindowsSupervisorHelper(helper);
    return true;
}
function retainUnclosedWindowsSupervisorHelper(helper, closeReceipt) {
    const existing = supervisorHelperRetentionsByProcess.get(helper);
    if (existing !== undefined)
        return existing;
    const retention = Object.freeze({ helper, closeReceipt });
    supervisorHelperRetentionsByProcess.set(helper, retention);
    unsafeSupervisorHelperRetentions.add(retention);
    void closeReceipt.then(() => {
        releaseClosedWindowsSupervisorHelper(helper);
        unsafeSupervisorHelperRetentions.delete(retention);
        supervisorHelperRetentionsByProcess.delete(helper);
    }, () => {
        // A rejected receipt cannot prove close; retain the exact helper owner.
    });
    return retention;
}
function releaseClosedWindowsSupervisorHelper(helper) {
    if (releasedSupervisorHelpers.has(helper))
        return;
    releasedSupervisorHelpers.add(helper);
    for (const stream of [helper.stdin, helper.stdout, helper.stderr]) {
        try {
            stream?.destroy();
        }
        catch { /* cleanup remains best effort */ }
    }
    try {
        helper.unref();
    }
    catch { /* cleanup remains best effort */ }
}
export async function terminateGatedChildByHandle(child, closeReceipt = observeChildProcessClose(child), timeoutMs = 1_000) {
    let closed = await waitWithTimeout(closeReceipt, 1);
    if (closed !== undefined)
        return closed.error === null;
    if (child.exitCode === null && child.signalCode === null) {
        let alive = false;
        try {
            alive = child.kill(0);
        }
        catch {
            alive = false;
        }
        if (alive) {
            try {
                child.kill("SIGKILL");
            }
            catch { /* exact close remains authoritative */ }
        }
    }
    closed = await waitWithTimeout(closeReceipt, timeoutMs);
    return closed !== undefined && closed.error === null;
}
function waitForChildExit(child) {
    if (child.exitCode !== null)
        return Promise.resolve(child.exitCode);
    return new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
    });
}
function waitWithTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        void promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, () => {
            clearTimeout(timer);
            resolve(undefined);
        });
    });
}
async function terminateProcessTree(child) {
    const pid = child.pid;
    return pid === undefined ? true : terminateDocumentProcessTreeByPid(pid);
}
export async function terminateDocumentProcessTreeByPid(pid, dependencies = {}) {
    const platform = dependencies.platform ?? process.platform;
    const kill = dependencies.kill ?? ((target, signal) => process.kill(target, signal));
    const isAlive = dependencies.isAlive ?? isProcessAlive;
    const delay = dependencies.delay ?? boundedDelay;
    if (platform === "win32") {
        const command = resolveWindowsSystemExecutable("taskkill.exe", platform, dependencies.systemRoot ?? process.env.SystemRoot);
        try {
            if (dependencies.execFile !== undefined) {
                await dependencies.execFile(command, ["/PID", String(pid), "/T", "/F"]);
            }
            else {
                await execFileAsync(command, ["/PID", String(pid), "/T", "/F"], {
                    timeout: 2_000,
                    windowsHide: true,
                    maxBuffer: 64 * 1024,
                });
            }
        }
        catch {
            // The bounded liveness check determines the safe result.
        }
        await delay(TREE_KILL_GRACE_MS);
        return !isAlive(pid);
    }
    try {
        kill(-pid, "SIGTERM");
    }
    catch { }
    await delay(TREE_KILL_GRACE_MS);
    if (!isAlive(-pid))
        return true;
    try {
        kill(-pid, "SIGKILL");
    }
    catch { }
    await delay(TREE_KILL_GRACE_MS);
    return !isAlive(-pid);
}
export function resolveWindowsSystemExecutable(name, platform = process.platform, systemRoot) {
    if (platform !== "win32")
        return name;
    if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
        throw new Error("absolute SystemRoot is required");
    }
    if (name.toLowerCase() === "powershell.exe") {
        return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", name);
    }
    return win32.join(systemRoot, "System32", name);
}
function scheduleCleanupAfterActualExit(child, snapshot, outputOwner, release, capture, treeTerminator, startGate) {
    const retention = { child, snapshot, outputOwner, release, capture, startGate };
    unsafeChildRetentions.add(retention);
    void (async () => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const receipt = await terminateWithReceipt(treeTerminator, child);
            if (!receipt.gone) {
                await unrefDelay(100);
                continue;
            }
            await drainCapturedChildStreams(child);
            closeStartGate(startGate);
            capture.detachAll();
            try {
                await cleanupSnapshot(snapshot);
                await cleanupOutputSpool(outputOwner);
                release();
                unsafeChildRetentions.delete(retention);
            }
            catch {
                // Fail closed: the gate remains occupied after unsafe cleanup.
            }
            return;
        }
        // The retained record deliberately owns the gate and spools for process lifetime.
    })();
}
const unsafeChildRetentions = new Set();
function unrefDelay(milliseconds) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
    });
}
async function drainCapturedChildStreams(child) {
    const waits = [];
    for (const stream of [child.stdout, child.stderr]) {
        if (stream === null || stream.readableEnded || stream.destroyed)
            continue;
        waits.push(new Promise((resolve) => {
            const done = () => {
                stream.off("end", done);
                stream.off("close", done);
                stream.off("error", done);
                resolve();
            };
            stream.once("end", done);
            stream.once("close", done);
            stream.once("error", done);
        }));
    }
    if (waits.length > 0) {
        await waitWithTimeout(Promise.all(waits), 500);
    }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function boundedDelay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
const OOM_SIGNATURES = [
    "heap out of memory",
    "reached heap limit",
    "allocation failed",
    "array buffer allocation failed",
    "enomem",
];
class StreamingOomDetector {
    #states = OOM_SIGNATURES.map(() => 0);
    matched = false;
    push(chunk) {
        if (this.matched)
            return;
        for (const rawByte of chunk) {
            const byte = rawByte >= 0x41 && rawByte <= 0x5a
                ? rawByte + 0x20
                : rawByte;
            for (let index = 0; index < OOM_SIGNATURES.length; index += 1) {
                const pattern = OOM_SIGNATURES[index];
                let state = this.#states[index];
                const expected = pattern.charCodeAt(state);
                if (byte === expected) {
                    state += 1;
                }
                else {
                    state = byte === pattern.charCodeAt(0) ? 1 : 0;
                }
                if (state === pattern.length) {
                    this.matched = true;
                    return;
                }
                this.#states[index] = state;
            }
        }
    }
}
function createChildStartupCapture(child) {
    const oomDetector = new StreamingOomDetector();
    const closeReceipt = observeChildProcessClose(child);
    const drainReceipt = { stdoutBytes: 0, stderrBytes: 0 };
    const terminal = {};
    const onStdout = (chunk) => {
        drainReceipt.stdoutBytes = Math.min(MAX_DRAIN_ACCOUNTED_BYTES, drainReceipt.stdoutBytes + chunk.byteLength);
    };
    const onStderr = (chunk) => {
        oomDetector.push(chunk);
        drainReceipt.stderrBytes = Math.min(MAX_DRAIN_ACCOUNTED_BYTES, drainReceipt.stderrBytes + chunk.byteLength);
    };
    const onError = (error) => {
        terminal.error ??= error;
        terminal.observedAt ??= Date.now();
    };
    const onExit = (code, signal) => {
        terminal.exit ??= { code, signal };
        terminal.observedAt ??= Date.now();
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
    let terminalAttached = true;
    let streamsAttached = true;
    const detachTerminal = () => {
        if (!terminalAttached)
            return;
        terminalAttached = false;
        child.off("error", onError);
        child.off("exit", onExit);
    };
    return {
        oomDetector,
        drainReceipt,
        onStdout,
        onStderr,
        terminal,
        closeReceipt,
        detachTerminal,
        detachAll() {
            detachTerminal();
            if (!streamsAttached)
                return;
            streamsAttached = false;
            child.stdout?.off("data", onStdout);
            child.stderr?.off("data", onStderr);
        },
    };
}
function requireSpool(snapshot) {
    if (snapshot?.transport !== "spool") {
        throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
    }
    return snapshot.takeSpoolHandle();
}
async function createPrivateOutputSpool(root, cleanupHooks) {
    if (!isAbsolute(root))
        throw new Error("invalid output spool root");
    let directoryPath;
    let filePath;
    let handle;
    try {
        directoryPath = await mkdtemp(join(root, OUTPUT_SPOOL_PREFIX));
        await setOwnerOnlyAccess(directoryPath, "directory", 0o700);
        filePath = join(directoryPath, OUTPUT_SPOOL_FILENAME);
        handle = await open(filePath, "wx+", 0o600);
        await setOwnerOnlyAccess(filePath, "file", 0o600);
        const directoryStatus = await lstat(directoryPath, { bigint: true });
        const fileStatus = await handle.stat({ bigint: true });
        if (!directoryStatus.isDirectory() ||
            directoryStatus.isSymbolicLink() ||
            !fileStatus.isFile()) {
            throw new Error("invalid output spool identity");
        }
        return {
            directoryPath,
            filePath,
            handle,
            directoryDevice: directoryStatus.dev,
            directoryInode: directoryStatus.ino,
            fileDevice: fileStatus.dev,
            fileInode: fileStatus.ino,
            handleClosed: false,
            cleaned: false,
            cleanupUnlink: cleanupHooks?.unlink ?? unlink,
            cleanupRmdir: cleanupHooks?.rmdir ?? rmdir,
        };
    }
    catch (error) {
        if (handle !== undefined) {
            try {
                await handle.close();
            }
            catch { }
        }
        if (filePath !== undefined) {
            try {
                await unlink(filePath);
            }
            catch { }
        }
        if (directoryPath !== undefined) {
            try {
                await rmdir(directoryPath);
            }
            catch { }
        }
        throw error;
    }
}
async function verifyOutputSpool(owner, receipt) {
    const before = await owner.handle.stat({ bigint: true });
    if (!before.isFile() ||
        before.dev !== owner.fileDevice ||
        before.ino !== owner.fileInode ||
        before.size !== BigInt(receipt.sizeBytes)) {
        throw new Error("output spool size mismatch");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafeSlow(Math.min(OUTPUT_READ_CHUNK_BYTES, receipt.sizeBytes));
    let position = 0;
    while (position < receipt.sizeBytes) {
        const requested = Math.min(buffer.byteLength, receipt.sizeBytes - position);
        const { bytesRead } = await owner.handle.read(buffer, 0, requested, position);
        if (bytesRead === 0)
            throw new Error("output spool truncated");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
    }
    const after = await owner.handle.stat({ bigint: true });
    if (after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        hash.digest("hex") !== receipt.sha256) {
        throw new Error("output spool hash mismatch");
    }
    let taken = false;
    const metadata = Object.freeze({
        operation: receipt.operation,
        encoding: receipt.encoding,
        sizeBytes: receipt.sizeBytes,
        sha256: receipt.sha256,
        ...(receipt.metadata === undefined
            ? {}
            : { resultMetadata: receipt.metadata }),
    });
    const result = Object.freeze({
        transport: "spool",
        metadata,
        takeHandle() {
            if (taken || owner.cleaned || owner.handleClosed) {
                throw createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
            }
            taken = true;
            return Object.freeze({ fd: owner.handle.fd, sizeBytes: receipt.sizeBytes });
        },
        async cleanup() {
            await cleanupOutputSpool(owner);
        },
    });
    verifiedResultSpools.add(result);
    return result;
}
async function assertEmptyOutputSpool(owner) {
    const status = await owner.handle.stat({ bigint: true });
    if (status.dev !== owner.fileDevice ||
        status.ino !== owner.fileInode ||
        status.size !== 0n) {
        throw new Error("unexpected output spool content");
    }
}
async function cleanupOutputSpool(owner) {
    if (owner.cleaned)
        return;
    if (!owner.handleClosed) {
        await owner.handle.close();
        owner.handleClosed = true;
    }
    if (owner.quarantinePath === undefined) {
        const directoryStatus = await lstat(owner.directoryPath, { bigint: true });
        const fileStatus = await lstat(owner.filePath, { bigint: true });
        if (!directoryStatus.isDirectory() ||
            directoryStatus.isSymbolicLink() ||
            directoryStatus.dev !== owner.directoryDevice ||
            directoryStatus.ino !== owner.directoryInode ||
            !fileStatus.isFile() ||
            fileStatus.isSymbolicLink() ||
            fileStatus.dev !== owner.fileDevice ||
            fileStatus.ino !== owner.fileInode) {
            throw new Error("output spool cleanup identity mismatch");
        }
        const quarantinePath = join(dirname(owner.directoryPath), `.gpt-codex-hwp-result-quarantine-${randomUUID()}`);
        await rename(owner.directoryPath, quarantinePath);
        owner.quarantinePath = quarantinePath;
    }
    const quarantinePath = owner.quarantinePath;
    const directoryStatus = await lstat(quarantinePath, { bigint: true });
    if (!directoryStatus.isDirectory() ||
        directoryStatus.isSymbolicLink() ||
        directoryStatus.dev !== owner.directoryDevice ||
        directoryStatus.ino !== owner.directoryInode) {
        throw new Error("output spool quarantine identity mismatch");
    }
    const entries = await readdir(quarantinePath);
    const filename = basename(owner.filePath);
    if (entries.length > 1 || (entries.length === 1 && entries[0] !== filename)) {
        throw new Error("output spool cleanup contents changed");
    }
    if (entries.length === 1) {
        const quarantinedFile = join(quarantinePath, filename);
        const fileStatus = await lstat(quarantinedFile, { bigint: true });
        if (!fileStatus.isFile() ||
            fileStatus.isSymbolicLink() ||
            fileStatus.dev !== owner.fileDevice ||
            fileStatus.ino !== owner.fileInode) {
            throw new Error("output spool quarantined file identity mismatch");
        }
        await owner.cleanupUnlink(quarantinedFile);
    }
    await owner.cleanupRmdir(quarantinePath);
    owner.cleaned = true;
}
async function setOwnerOnlyAccess(path, kind, mode) {
    if (process.platform !== "win32") {
        await chmod(path, mode);
        return;
    }
    const sidResult = await execFileAsync(systemExecutable("whoami.exe"), [
        "/user",
        "/fo",
        "csv",
        "/nh",
    ], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        env: minimalWindowsHelperEnvironment(process.env),
    });
    const sid = /"(S-\d+(?:-\d+)+)"/u.exec(sidResult.stdout)?.[1];
    if (sid === undefined)
        throw new Error("could not determine spool owner");
    const ownerGrant = kind === "directory" ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
    const systemGrant = kind === "directory"
        ? `*${WINDOWS_SYSTEM_SID}:(OI)(CI)F`
        : `*${WINDOWS_SYSTEM_SID}:F`;
    await execFileAsync(systemExecutable("icacls.exe"), [
        path,
        "/inheritance:r",
        "/grant:r",
        ownerGrant,
        systemGrant,
        "/q",
    ], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        env: minimalWindowsHelperEnvironment(process.env),
    });
    await verifyWindowsAcl(path, sid, kind);
}
async function verifyWindowsAcl(path, sid, kind) {
    const script = [
        "$item=if($env:GPT_CODEX_HWP_ACL_KIND -eq 'directory'){[System.IO.DirectoryInfo]::new($env:GPT_CODEX_HWP_ACL_PATH)}else{[System.IO.FileInfo]::new($env:GPT_CODEX_HWP_ACL_PATH)}",
        "$acl=$item.GetAccessControl()",
        "$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {[PSCustomObject]@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow);full=(($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)}})",
        "$receipt=[PSCustomObject]@{protected=$acl.AreAccessRulesProtected;rules=$rules}",
        "[Console]::Out.Write(($receipt | ConvertTo-Json -Compress -Depth 4))",
    ].join(";");
    const result = await execFileAsync(systemExecutable("powershell.exe"), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: createAclHelperEnvironment(path, sid, kind, process.env),
    });
    let receipt;
    try {
        receipt = JSON.parse(result.stdout);
    }
    catch {
        throw new Error("invalid Windows ACL receipt");
    }
    if (!validateWindowsAclReceipt(receipt, sid)) {
        throw new Error("unsafe Windows ACL receipt");
    }
}
export function createAclHelperEnvironment(path, sid, kind, source = process.env) {
    return {
        ...minimalWindowsHelperEnvironment(source),
        GPT_CODEX_HWP_ACL_PATH: path,
        GPT_CODEX_HWP_ACL_SID: sid,
        GPT_CODEX_HWP_ACL_KIND: kind,
    };
}
function minimalWindowsHelperEnvironment(source) {
    const result = {};
    for (const key of ["SystemRoot", "WINDIR", "LANG", "LC_ALL"]) {
        const value = source[key];
        if (value !== undefined)
            result[key] = value;
    }
    return result;
}
export function createJobHelperEnvironment(source) {
    const result = minimalWindowsHelperEnvironment(source);
    for (const key of ["TEMP", "TMP"]) {
        const value = source[key];
        if (value !== undefined)
            result[key] = value;
    }
    return result;
}
export function validateWindowsAclReceipt(value, currentSid) {
    if (!isPlainDataRecord(value))
        return false;
    const root = value;
    if (!hasExactKeys(root, ["protected", "rules"]) ||
        root.protected !== true ||
        !Array.isArray(root.rules) ||
        root.rules.length !== 2) {
        return false;
    }
    const seen = new Set();
    for (const rawRule of root.rules) {
        if (!isPlainDataRecord(rawRule))
            return false;
        const rule = rawRule;
        if (!hasExactKeys(rule, ["sid", "allow", "full"]) ||
            typeof rule.sid !== "string" ||
            (rule.sid !== currentSid && rule.sid !== WINDOWS_SYSTEM_SID) ||
            rule.allow !== true ||
            rule.full !== true ||
            seen.has(rule.sid)) {
            return false;
        }
        seen.add(rule.sid);
    }
    return seen.has(currentSid) && seen.has(WINDOWS_SYSTEM_SID);
}
function isPlainDataRecord(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value, expected) {
    const keys = Object.keys(value).sort();
    return keys.length === expected.length &&
        keys.every((key, index) => key === [...expected].sort()[index]);
}
function systemExecutable(name) {
    return resolveWindowsSystemExecutable(name, process.platform, process.env.SystemRoot);
}
function createStartupLifecycleState(signal, deadlineAt) {
    let abortObservedAt = signal?.aborted === true
        ? performance.now()
        : undefined;
    let abortCallback;
    let deadlineTimer;
    let terminationPromise;
    let resolveTermination;
    let disposed = false;
    const terminationReason = () => {
        const now = performance.now();
        if (abortObservedAt !== undefined && abortObservedAt < deadlineAt) {
            return "abort";
        }
        if (now >= deadlineAt)
            return "deadline";
        return abortObservedAt === undefined ? undefined : "abort";
    };
    const publishTermination = () => {
        const reason = terminationReason();
        if (reason === undefined)
            return;
        if (deadlineTimer !== undefined) {
            clearTimeout(deadlineTimer);
            deadlineTimer = undefined;
        }
        resolveTermination?.(reason);
        resolveTermination = undefined;
    };
    const armDeadline = () => {
        if (disposed || deadlineTimer !== undefined || resolveTermination === undefined)
            return;
        const remainingMs = deadlineAt - performance.now();
        if (remainingMs <= 0) {
            publishTermination();
            return;
        }
        deadlineTimer = setTimeout(() => {
            deadlineTimer = undefined;
            publishTermination();
            if (resolveTermination !== undefined)
                armDeadline();
        }, Math.max(1, Math.ceil(remainingMs)));
    };
    const onAbort = () => {
        abortObservedAt ??= performance.now();
        publishTermination();
        if (terminationReason() === "abort")
            abortCallback?.();
    };
    if (signal !== undefined && abortObservedAt === undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
        deadlineAt,
        terminationReason,
        waitForTermination() {
            const current = terminationReason();
            if (current !== undefined)
                return Promise.resolve(current);
            terminationPromise ??= new Promise((resolve) => {
                resolveTermination = resolve;
            });
            armDeadline();
            return terminationPromise;
        },
        handoffAbort(callback) {
            abortCallback = callback;
            if (terminationReason() === "abort")
                callback();
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            if (deadlineTimer !== undefined)
                clearTimeout(deadlineTimer);
            deadlineTimer = undefined;
            resolveTermination = undefined;
            abortCallback = undefined;
            signal?.removeEventListener("abort", onAbort);
        },
    };
}
function startupTerminationError(reason) {
    return createDocumentEngineRunError(reason === "abort" ? "REQUEST_CANCELLED" : "ENGINE_TIMEOUT");
}
function normalizeDeadline(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw createDocumentEngineRunError("ENGINE_RESOURCE_LIMIT", {
            remediation: "reduce_input",
        });
    }
    return value;
}
function minimalChildEnvironment() {
    const result = {};
    for (const key of [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ]) {
        const value = process.env[key];
        if (value !== undefined)
            result[key] = value;
    }
    return result;
}
async function cleanupSnapshot(snapshot) {
    if (snapshot !== undefined)
        await snapshot.cleanup();
}
async function cleanupUnknownSnapshot(snapshot) {
    if (snapshot !== undefined)
        await snapshot.cleanup();
}
