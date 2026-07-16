import { execFile, spawn, } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readdir, rename, rmdir, unlink, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BoundedFrameDecoder, encodeBoundedJsonFrame, parseBoundedJsonFrame, } from "./bounded-frame.js";
import { DocumentEngineRunError, createDocumentEngineRunError, normalizeDocumentEngineError, } from "./document-errors.js";
import { defaultDocumentDeadlineMs, HeavyChildGate, } from "./document-execution-policy.js";
import { createChildDocumentEventValidator, createWireDocumentRequest, MAX_CHILD_INLINE_RESULT_BYTES, MAX_CHILD_REQUEST_FRAME_BYTES, validateLogicalDocumentRequest, } from "./document-protocol.js";
const execFileAsync = promisify(execFile);
const MAX_DRAIN_ACCOUNTED_BYTES = 64 * 1024;
const TREE_KILL_GRACE_MS = 100;
const OUTPUT_SPOOL_PREFIX = "gpt-codex-hwp-result-";
const OUTPUT_SPOOL_FILENAME = "output.bin";
const OUTPUT_READ_CHUNK_BYTES = 1024 * 1024;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const verifiedResultSpools = new WeakSet();
export function isIntegrityVerifiedResultSpool(value) {
    return typeof value === "object" && value !== null &&
        verifiedResultSpools.has(value);
}
export function createDocumentChildClient(dependencies = {}) {
    const childEntry = dependencies.childEntry ?? fileURLToPath(new URL("./document-child.js", import.meta.url));
    const childArguments = dependencies.childArguments ?? [];
    const gate = dependencies.heavyChildGate ?? new HeavyChildGate();
    const spawnFactory = dependencies.spawnFactory ?? ((specification) => spawn(specification.command, [...specification.args], specification.options));
    const treeTerminator = dependencies.treeTerminator ?? terminateProcessTree;
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
            let startupCapture;
            try {
                const input = request.operation === "generateHwpx"
                    ? undefined
                    : requireSpool(snapshot);
                const imageInputFd = options.imageInput?.transport === "spool"
                    ? options.imageInput.fd
                    : undefined;
                const stdio = [
                    "pipe",
                    "pipe",
                    "pipe",
                    input?.fd ?? "ignore",
                    imageInputFd ?? "ignore",
                    outputOwner.handle.fd,
                    "pipe",
                ];
                const specification = {
                    command: process.execPath,
                    args: [childEntry, ...childArguments],
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
            }
            catch (error) {
                const terminationReason = startupLifecycle.terminationReason();
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
            let supervisedTerminator = treeTerminator;
            const supervisorFactory = dependencies.jobSupervisorFactory ??
                (process.platform === "win32"
                    ? (childProcess, readyMs) => createWindowsJobSupervisor(childProcess, readyMs, dependencies.jobSupervisorFrameObserver, dependencies.forceWindowsTracker)
                    : undefined);
            if (supervisorFactory !== undefined) {
                try {
                    const supervisor = await supervisorFactory(child, Math.min(5_000, remainingDeadlineMs));
                    supervisedTerminator = () => supervisor.terminate();
                }
                catch (error) {
                    const terminated = await treeTerminator(child).catch(() => false);
                    const exitCode = terminated
                        ? await waitWithTimeout(waitForChildExit(child), 1_000)
                        : undefined;
                    if (terminated && exitCode !== undefined) {
                        await drainCapturedChildStreams(child);
                        startupCapture.detachAll();
                        await cleanupOutputSpool(outputOwner);
                        await cleanupSnapshot(snapshot);
                        release();
                        startupLifecycle.dispose();
                    }
                    else {
                        startupLifecycle.dispose();
                        scheduleCleanupAfterActualExit(child, snapshot, outputOwner, release, startupCapture, treeTerminator);
                        throw createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
                            stage: "shutdown",
                            remediation: "check_installation",
                        });
                    }
                    if (startupCapture.oomDetector.matched) {
                        throw createDocumentEngineRunError("ENGINE_OOM", {
                            stage: "startup",
                            remediation: "reduce_input",
                        });
                    }
                    const terminationReason = startupLifecycle.terminationReason();
                    if (terminationReason !== undefined) {
                        throw startupTerminationError(terminationReason);
                    }
                    throw new DocumentEngineRunError(normalizeDocumentEngineError(error, {
                        ready: false,
                        stage: "startup",
                    }));
                }
            }
            remainingDeadlineMs = deadlineMs - (performance.now() - requestStartedAt);
            if (startupLifecycle.terminationReason() !== undefined) {
                return terminateExpiredStartup(child, snapshot, outputOwner, release, supervisedTerminator, startupCapture, startupLifecycle);
            }
            return runChild(request, snapshot, options, remainingDeadlineMs, child, release, outputOwner, supervisedTerminator, dependencies.controlFrameAllocationObserver, startupCapture, startupLifecycle);
        },
    };
}
async function terminateExpiredStartup(child, snapshot, outputOwner, release, treeTerminator, startupCapture, startupLifecycle) {
    let terminated = false;
    try {
        terminated = await treeTerminator(child);
    }
    catch {
        terminated = false;
    }
    if (!terminated) {
        startupLifecycle.dispose();
        scheduleCleanupAfterActualExit(child, snapshot, outputOwner, release, startupCapture, treeTerminator);
        throw createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
            stage: "shutdown",
            remediation: "check_installation",
        });
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
async function runChild(request, snapshot, options, deadlineMs, child, release, outputOwner, treeTerminator, controlFrameAllocationObserver, startupCapture, startupLifecycle) {
    const startedAt = Date.now();
    const validator = createChildDocumentEventValidator(request.requestId, request.operation);
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
                let terminated = false;
                try {
                    terminated = await treeTerminator(child);
                }
                catch {
                    terminated = false;
                }
                if (!terminated) {
                    scheduleCleanupAfterActualExit(child, snapshot, outputOwner, release, capture, treeTerminator);
                    reject(createDocumentEngineRunError("ENGINE_TERMINATION_FAILED", {
                        stage: "shutdown",
                        remediation: "check_installation",
                    }));
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
            const wire = createWireDocumentRequest(request, transports);
            const frame = encodeBoundedJsonFrame(wire, MAX_CHILD_REQUEST_FRAME_BYTES);
            if (child.stdin === null)
                throw new Error("child stdin unavailable");
            child.stdin.end(frame, (error) => {
                if (error != null)
                    settle({ error });
            });
        }
        catch (error) {
            settle({ error });
        }
    });
}
async function createWindowsJobSupervisor(child, readyDeadlineMs, frameObserver, forceTracker = false) {
    if (child.pid === undefined)
        throw new Error("child pid unavailable");
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
    let stderrBytes = 0;
    helper.stderr?.on("data", (chunk) => {
        stderrBytes = Math.min(MAX_DRAIN_ACCOUNTED_BYTES, stderrBytes + chunk.byteLength);
    });
    if (helper.stdout === null || helper.stdin === null) {
        helper.kill();
        throw new Error("job supervisor pipes unavailable");
    }
    const lines = new BoundedSupervisorLineReader(helper.stdout, 128);
    const exitReceipt = waitForChildExit(helper);
    try {
        const ready = await lines.next(readyDeadlineMs);
        frameObserver?.(ready);
        if (!new RegExp(`^GPT_CODEX_HWP_JOB READY ${child.pid} [12] [0-9]+$`, "u").test(ready)) {
            throw new Error("invalid job supervisor READY frame");
        }
    }
    catch (error) {
        helper.stdin.destroy();
        helper.kill();
        throw error;
    }
    let commandSent = false;
    let terminationComplete = false;
    let activeTermination;
    return {
        terminate() {
            if (terminationComplete)
                return Promise.resolve(true);
            activeTermination ??= (async () => {
                try {
                    if (!commandSent) {
                        commandSent = true;
                        helper.stdin.end("TERMINATE\n");
                    }
                    let gone = await lines.next(3_000);
                    if (forceTracker && /^GPT_CODEX_HWP_JOB TRACKER [0-9]+ [0-9]+$/u.test(gone)) {
                        frameObserver?.(gone);
                        gone = await lines.next(3_000);
                    }
                    frameObserver?.(gone);
                    if (!/^GPT_CODEX_HWP_JOB GONE 0 [12]$/u.test(gone))
                        return false;
                    terminationComplete = await finalizeVerifiedWindowsSupervisor({
                        exitReceipt,
                        forceClose: () => helper.kill(),
                    });
                    return terminationComplete;
                }
                catch {
                    return false;
                }
                finally {
                    activeTermination = undefined;
                }
            })();
            return activeTermination;
        },
    };
}
export async function finalizeVerifiedWindowsSupervisor({ exitReceipt, forceClose, gracefulExitMs = 1_000, forcedExitMs = 5_000, }) {
    const gracefulExit = await waitWithTimeout(exitReceipt, gracefulExitMs);
    if (gracefulExit !== undefined)
        return true;
    let closeRequested = false;
    try {
        closeRequested = forceClose();
    }
    catch {
        closeRequested = false;
    }
    const forcedExit = await waitWithTimeout(exitReceipt, forcedExitMs);
    return forcedExit !== undefined && (closeRequested || forcedExit === 0);
}
export async function superviseDocumentProcessTree(child) {
    if (child.pid === undefined)
        throw new Error("child pid unavailable");
    if (process.platform === "win32") {
        return createWindowsJobSupervisor(child, 5_000, undefined, true);
    }
    let terminationComplete = false;
    return {
        async terminate() {
            if (terminationComplete)
                return true;
            terminationComplete = await terminateProcessTree(child);
            return terminationComplete;
        },
    };
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
    constructor(stream, maxLineBytes) {
        this.#buffer = Buffer.alloc(maxLineBytes);
        stream.on("data", (chunk) => this.#push(chunk));
        stream.on("end", () => this.#fail(new Error("job supervisor stream ended")));
        stream.on("error", () => this.#fail(new Error("job supervisor stream failed")));
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
function scheduleCleanupAfterActualExit(child, snapshot, outputOwner, release, capture, treeTerminator) {
    const retention = { child, snapshot, outputOwner, release, capture };
    unsafeChildRetentions.add(retention);
    void (async () => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            let gone = false;
            try {
                gone = await treeTerminator(child);
            }
            catch {
                gone = false;
            }
            if (!gone) {
                await unrefDelay(100);
                continue;
            }
            await drainCapturedChildStreams(child);
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
    const onAbort = () => {
        abortObservedAt ??= performance.now();
        if (terminationReason() === "abort")
            abortCallback?.();
    };
    if (signal !== undefined && abortObservedAt === undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
        deadlineAt,
        terminationReason,
        handoffAbort(callback) {
            abortCallback = callback;
            if (terminationReason() === "abort")
                callback();
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
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
