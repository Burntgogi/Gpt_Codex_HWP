import { randomUUID } from "node:crypto";
import { close, closeSync, createReadStream, createWriteStream, fstatSync, readSync, writeSync, } from "node:fs";
import { performance } from "node:perf_hooks";
import { normalizeProcessTreeTerminationReceipt, unverifiedTermination, } from "./registered-process-supervisor.js";
export const DOCUMENT_START_DESCRIPTOR = 7;
export const BENCHMARK_REGISTRATION_DESCRIPTOR = 8;
export const BENCHMARK_ACK_DESCRIPTOR = 9;
export const DOCUMENT_START_FRAME = "GPT_CODEX_HWP_START_V1\n";
export const DOCUMENT_START_GATE_READY_FRAME = "GPT_CODEX_HWP_START_GATE_READY_V1";
export const MAX_REGISTRATION_FRAME_BYTES = 1_024;
export const MAX_REGISTRATION_CHANNEL_BYTES = 16 * 1_024;
export const MAX_REGISTERED_DOCUMENT_GROUPS = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const START_BYTES = TEXT_ENCODER.encode(DOCUMENT_START_FRAME);
export function parseRegisterFrame(value) {
    try {
        return validateRegisterValue(parseFrameValue(value));
    }
    catch {
        throw new Error("invalid register frame");
    }
}
export function parseAckFrame(value) {
    try {
        return validateAckValue(parseFrameValue(value));
    }
    catch {
        throw new Error("invalid ack frame");
    }
}
export function encodeRegisterFrame(frame) {
    try {
        return encodeFrame(validateRegisterValue(frame));
    }
    catch {
        throw new Error("invalid register frame");
    }
}
export function encodeAckFrame(frame) {
    try {
        return encodeFrame(validateAckValue(frame));
    }
    catch {
        throw new Error("invalid ack frame");
    }
}
export function createProcessRegistrationCoordinator(options) {
    if (!isSafePositiveInteger(options.casePid) ||
        !Number.isFinite(options.deadlineAt) ||
        options.deadlineAt <= performance.now()) {
        throw new Error("invalid registration coordinator options");
    }
    let state = "open";
    let started = false;
    let closingRequested = false;
    let readableEnded = false;
    let readableClosed = false;
    let caseExited = false;
    let channelBytes = 0;
    let pendingFrame = Buffer.alloc(0);
    let inFlightRegistrations = 0;
    let retainedGroups = 0;
    let poisonReason;
    let queueTail = Promise.resolve();
    let authorityCleanupTail = Promise.resolve();
    let sealPromise;
    let pendingAckReject;
    const nonces = new Set();
    const pids = new Set();
    const registrationSettlements = new Set();
    let resolveReadableEnd;
    const readableEnd = new Promise((resolvePromise) => {
        resolveReadableEnd = resolvePromise;
    });
    let acknowledgementCloseSettled = false;
    let settleAcknowledgementClose;
    const acknowledgementCloseReceipt = new Promise((resolvePromise) => {
        settleAcknowledgementClose = resolvePromise;
    });
    const remaining = Math.max(0, options.deadlineAt - performance.now());
    const deadlineTimer = setTimeout(() => {
        fail("deadline");
    }, remaining);
    deadlineTimer.unref();
    const onAcknowledgementError = (error) => {
        if (!acknowledgementCloseSettled) {
            acknowledgementCloseSettled = true;
            settleAcknowledgementClose({ closed: false, error });
        }
        pendingAckReject?.(error);
        fail("channel");
    };
    const onAcknowledgementClose = () => {
        options.acknowledgementOutput.removeListener("error", onAcknowledgementError);
        if (!acknowledgementCloseSettled) {
            acknowledgementCloseSettled = true;
            settleAcknowledgementClose({ closed: true, error: null });
        }
    };
    options.acknowledgementOutput.on("error", onAcknowledgementError);
    options.acknowledgementOutput.once("close", onAcknowledgementClose);
    void options.caseExited.then(() => { caseExited = true; }, () => { fail("channel"); }).catch(() => { fail("channel"); });
    const enqueue = (operation) => {
        const result = queueTail.then(operation);
        queueTail = result.catch(() => { });
        return result;
    };
    const currentState = () => state;
    const runAcknowledgementOperation = (operation) => bounded(new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        const settle = (error) => {
            if (settled)
                return;
            settled = true;
            if (pendingAckReject === rejectAck)
                pendingAckReject = undefined;
            if (error === undefined || error === null)
                resolvePromise();
            else
                rejectPromise(error);
        };
        const rejectAck = (error) => settle(error);
        pendingAckReject = rejectAck;
        try {
            operation(settle);
        }
        catch (error) {
            settle(error instanceof Error ? error : new Error("ACK write failed"));
        }
    }));
    const writeAcknowledgement = (frame) => runAcknowledgementOperation((settle) => {
        options.acknowledgementOutput.write(Buffer.from(encodeAckFrame(frame)), (error) => settle(error));
    });
    const scheduleAuthorityCleanup = () => {
        authorityCleanupTail = authorityCleanupTail.then(async () => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                let receipt;
                try {
                    receipt = normalizeProcessTreeTerminationReceipt(await options.supervisor.terminate());
                }
                catch {
                    receipt = unverifiedTermination("termination");
                }
                if (receipt.gone === true && receipt.proof === "registered-groups-empty")
                    return;
            }
        }).catch(() => {
            // Retention remains owned and a later public termination can retry authority.
        });
    };
    const reserveAndQueue = (bytes) => {
        if (state === "failed" || state === "sealed")
            return;
        let frame;
        try {
            frame = parseRegisterFrame(bytes);
        }
        catch {
            fail("channel");
            return;
        }
        if (nonces.has(frame.nonce) || pids.has(frame.pid) ||
            nonces.size >= MAX_REGISTERED_DOCUMENT_GROUPS ||
            inFlightRegistrations !== 0) {
            fail("channel");
            return;
        }
        nonces.add(frame.nonce);
        pids.add(frame.pid);
        inFlightRegistrations += 1;
        void enqueue(async () => {
            let retained = false;
            try {
                if (state === "failed" || state === "sealed")
                    return;
                const commitState = currentState();
                if (commitState === "open" && frame.parentPid !== options.casePid) {
                    fail("channel");
                    throw new Error("registration frame parent mismatch");
                }
                const expectedParentPid = commitState === "open" ? options.casePid : undefined;
                const registration = Promise.resolve().then(() => options.supervisor.registerRoot(frame.pid, expectedParentPid));
                const ownedRegistration = registration.then((identity) => {
                    retained = true;
                    retainedGroups += 1;
                    if (state === "failed")
                        scheduleAuthorityCleanup();
                    return identity;
                });
                let settlement;
                settlement = ownedRegistration.then(() => { registrationSettlements.delete(settlement); }, () => { registrationSettlements.delete(settlement); });
                registrationSettlements.add(settlement);
                await bounded(ownedRegistration);
                if (currentState() === "failed" || currentState() === "sealed") {
                    scheduleAuthorityCleanup();
                    throw new Error("registration coordinator poisoned after retention");
                }
                const status = state === "open" ? "accepted" : "rejected";
                await writeAcknowledgement({
                    schemaVersion: 1,
                    type: "ack",
                    nonce: frame.nonce,
                    status,
                });
            }
            catch {
                fail(poisonReason ?? (retained ? "channel" : "identity"));
                if (retained)
                    scheduleAuthorityCleanup();
                throw new Error("registration coordinator job failed");
            }
            finally {
                inFlightRegistrations -= 1;
            }
        });
    };
    const onData = (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        channelBytes += bytes.byteLength;
        if (channelBytes > MAX_REGISTRATION_CHANNEL_BYTES) {
            fail("channel");
            return;
        }
        if (state === "failed")
            return;
        if (inFlightRegistrations !== 0) {
            fail("channel");
            return;
        }
        let offset = 0;
        while (offset < bytes.byteLength) {
            const newline = bytes.indexOf(0x0a, offset);
            const end = newline === -1 ? bytes.byteLength : newline + 1;
            const segment = bytes.subarray(offset, end);
            if (pendingFrame.byteLength + segment.byteLength > MAX_REGISTRATION_FRAME_BYTES) {
                fail("channel");
                return;
            }
            pendingFrame = Buffer.concat([pendingFrame, segment]);
            offset = end;
            if (newline !== -1) {
                const complete = pendingFrame;
                pendingFrame = Buffer.alloc(0);
                reserveAndQueue(complete);
                if (currentState() === "failed")
                    return;
                if (offset < bytes.byteLength && inFlightRegistrations !== 0) {
                    fail("channel");
                    return;
                }
            }
        }
    };
    const onEnd = () => {
        readableEnded = true;
        if (pendingFrame.byteLength !== 0)
            fail("channel");
        resolveReadableEnd();
    };
    const onError = () => { fail("channel"); };
    const onClose = () => {
        readableClosed = true;
        if (!readableEnded)
            fail("channel");
    };
    function fail(reason) {
        poisonReason ??= reason;
        state = "failed";
        clearTimeout(deadlineTimer);
        pendingAckReject?.(new Error("registration acknowledgement channel failed"));
        try {
            const destroy = options.acknowledgementOutput
                .destroy;
            destroy?.call(options.acknowledgementOutput);
        }
        catch {
            // The channel is already permanently unverified.
        }
    }
    function bounded(promise) {
        const milliseconds = options.deadlineAt - performance.now();
        if (milliseconds <= 0) {
            fail("deadline");
            return Promise.reject(new Error("registration coordinator deadline exceeded"));
        }
        return new Promise((resolvePromise, rejectPromise) => {
            const timer = setTimeout(() => {
                fail("deadline");
                rejectPromise(new Error("registration coordinator deadline exceeded"));
            }, milliseconds);
            timer.unref();
            void promise.then((value) => {
                clearTimeout(timer);
                resolvePromise(value);
            }, (error) => {
                clearTimeout(timer);
                rejectPromise(error);
            });
        });
    }
    const coordinator = {
        get state() { return state; },
        start() {
            if (started)
                return;
            started = true;
            options.registrationInput.on("data", onData);
            options.registrationInput.once("end", onEnd);
            options.registrationInput.once("error", onError);
            options.registrationInput.once("close", onClose);
        },
        beginClosing() {
            closingRequested = true;
            return enqueue(() => {
                if (state === "failed") {
                    throw new Error("registration coordinator failed");
                }
                if (state === "open")
                    state = "closing";
            });
        },
        seal() {
            if (sealPromise !== undefined)
                return sealPromise;
            if (!started || !closingRequested) {
                return Promise.reject(new Error("registration coordinator is not closing"));
            }
            if (state === "failed") {
                return Promise.reject(new Error("registration coordinator failed"));
            }
            sealPromise = bounded((async () => {
                await readableEnd;
                await options.caseExited;
                caseExited = true;
                await queueTail;
                if (currentState() === "failed" || !readableEnded || readableClosed && !readableEnded ||
                    pendingFrame.byteLength !== 0 || inFlightRegistrations !== 0 || !caseExited) {
                    throw new Error("registration coordinator failed to seal");
                }
                await runAcknowledgementOperation((settle) => {
                    const end = options.acknowledgementOutput.end;
                    if (end === undefined) {
                        settle();
                        return;
                    }
                    end.call(options.acknowledgementOutput, () => settle());
                });
                const closeReceipt = await bounded(acknowledgementCloseReceipt);
                if (!closeReceipt.closed || closeReceipt.error !== null) {
                    throw closeReceipt.error ?? new Error("ACK channel failed to close cleanly");
                }
                if (poisonReason !== undefined || currentState() !== "closing") {
                    throw new Error("registration coordinator failed before ACK channel close");
                }
                state = "sealed";
                clearTimeout(deadlineTimer);
            })()).catch((error) => {
                fail(poisonReason ?? "channel");
                throw error;
            });
            return sealPromise;
        },
        async terminateRegisteredGroups() {
            try {
                await bounded(Promise.all([
                    queueTail,
                    ...registrationSettlements,
                ]));
            }
            catch {
                // Deadline/channel poison keeps proof unverified, but authority still runs.
            }
            let receipt;
            if (retainedGroups === 0 && state === "sealed") {
                receipt = Object.freeze({ gone: true, proof: "registered-groups-empty" });
            }
            else {
                try {
                    receipt = normalizeProcessTreeTerminationReceipt(await options.supervisor.terminate());
                }
                catch {
                    receipt = unverifiedTermination("termination");
                }
            }
            if (poisonReason !== undefined || state === "failed") {
                return unverifiedTermination(poisonReason ?? "channel");
            }
            if (state !== "sealed")
                return unverifiedTermination("registration");
            return receipt;
        },
    };
    return coordinator;
}
export async function runDocumentChildStartGate() {
    try {
        const registrationPresent = probeRegistrationDescriptors();
        if (registrationPresent)
            await registerDocumentProcess();
        await waitForStartAndInstallLifelineWatcher();
    }
    catch {
        privateExit(79 /* PrivateExitCode.Unexpected */);
    }
}
export function runDocumentChildStartGateWindowsSync() {
    try {
        const registrationPresent = probeRegistrationDescriptors();
        if (registrationPresent)
            registerDocumentProcessSync();
        readStartFrameSync();
        installLifelineWatcher();
    }
    catch {
        privateExit(79 /* PrivateExitCode.Unexpected */);
    }
}
function parseFrameValue(value) {
    if (!(value instanceof Uint8Array) ||
        value.byteLength < 2 ||
        value.byteLength > MAX_REGISTRATION_FRAME_BYTES ||
        value[value.byteLength - 1] !== 0x0a) {
        throw new Error("invalid bounded frame");
    }
    for (let index = 0; index < value.byteLength - 1; index += 1) {
        if (value[index] === 0x0a)
            throw new Error("trailing frame data");
    }
    const json = TEXT_DECODER.decode(value.subarray(0, value.byteLength - 1));
    return JSON.parse(json);
}
function encodeFrame(value) {
    const json = JSON.stringify(value);
    if (json === undefined)
        throw new Error("frame is not serializable");
    const payload = TEXT_ENCODER.encode(json);
    if (payload.byteLength + 1 > MAX_REGISTRATION_FRAME_BYTES) {
        throw new Error("frame exceeds limit");
    }
    const frame = new Uint8Array(payload.byteLength + 1);
    frame.set(payload);
    frame[frame.byteLength - 1] = 0x0a;
    return frame;
}
function validateRegisterValue(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ["schemaVersion", "type", "nonce", "pid", "parentPid"]) ||
        value.schemaVersion !== 1 ||
        value.type !== "register" ||
        typeof value.nonce !== "string" ||
        !UUID_PATTERN.test(value.nonce) ||
        !isSafePositiveInteger(value.pid) ||
        !isSafePositiveInteger(value.parentPid)) {
        throw new Error("invalid register frame");
    }
    return {
        schemaVersion: 1,
        type: "register",
        nonce: value.nonce,
        pid: value.pid,
        parentPid: value.parentPid,
    };
}
function validateAckValue(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ["schemaVersion", "type", "nonce", "status"]) ||
        value.schemaVersion !== 1 ||
        value.type !== "ack" ||
        typeof value.nonce !== "string" ||
        !UUID_PATTERN.test(value.nonce) ||
        (value.status !== "accepted" && value.status !== "rejected")) {
        throw new Error("invalid ack frame");
    }
    return {
        schemaVersion: 1,
        type: "ack",
        nonce: value.nonce,
        status: value.status,
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const sorted = [...expected].sort();
    return actual.length === sorted.length &&
        actual.every((key, index) => key === sorted[index]);
}
function isSafePositiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function probeRegistrationDescriptors() {
    let registration;
    let acknowledgement;
    try {
        registration = descriptorPresent(BENCHMARK_REGISTRATION_DESCRIPTOR);
        acknowledgement = descriptorPresent(BENCHMARK_ACK_DESCRIPTOR);
    }
    catch {
        privateExit(71 /* PrivateExitCode.DescriptorProbe */);
    }
    if (registration !== acknowledgement)
        privateExit(71 /* PrivateExitCode.DescriptorProbe */);
    return registration;
}
function descriptorPresent(descriptor) {
    try {
        fstatSync(descriptor);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "EBADF")
            return false;
        throw error;
    }
}
async function registerDocumentProcess() {
    const nonce = randomUUID();
    const frame = encodeRegisterFrame({
        schemaVersion: 1,
        type: "register",
        nonce,
        pid: process.pid,
        parentPid: process.ppid,
    });
    try {
        await writeDescriptorAll(BENCHMARK_REGISTRATION_DESCRIPTOR, frame);
    }
    catch {
        privateExit(72 /* PrivateExitCode.RegistrationWrite */);
    }
    let acknowledgement;
    try {
        acknowledgement = parseAckFrame(await readOneRegistrationFrame(BENCHMARK_ACK_DESCRIPTOR));
    }
    catch {
        privateExit(73 /* PrivateExitCode.RegistrationAck */);
    }
    if (acknowledgement.nonce !== nonce || acknowledgement.status !== "accepted") {
        privateExit(73 /* PrivateExitCode.RegistrationAck */);
    }
    try {
        await closeDescriptor(BENCHMARK_REGISTRATION_DESCRIPTOR);
        await closeDescriptor(BENCHMARK_ACK_DESCRIPTOR);
    }
    catch {
        privateExit(74 /* PrivateExitCode.RegistrationClose */);
    }
}
async function writeDescriptorAll(descriptor, bytes) {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const written = await writeDescriptor(descriptor, bytes, offset, bytes.byteLength - offset);
        if (written <= 0)
            throw new Error("registration write failed");
        offset += written;
    }
}
async function readOneRegistrationFrame(descriptor) {
    const frame = Buffer.allocUnsafeSlow(MAX_REGISTRATION_FRAME_BYTES);
    const readBuffer = Buffer.allocUnsafeSlow(MAX_REGISTRATION_CHANNEL_BYTES);
    let frameBytes = 0;
    while (true) {
        const count = await readDescriptor(descriptor, readBuffer, 0, readBuffer.byteLength);
        if (count === 0)
            throw new Error("registration channel ended");
        const newline = readBuffer.subarray(0, count).indexOf(0x0a);
        if (newline !== -1 && newline !== count - 1) {
            throw new Error("trailing registration data");
        }
        if (frameBytes + count > MAX_REGISTRATION_FRAME_BYTES) {
            throw new Error("registration frame exceeds limit");
        }
        frame.set(readBuffer.subarray(0, count), frameBytes);
        frameBytes += count;
        if (newline !== -1)
            return frame.subarray(0, frameBytes);
    }
}
async function waitForStartAndInstallLifelineWatcher() {
    if (!process.connected || typeof process.send !== "function") {
        privateExit(75 /* PrivateExitCode.StartFrame */);
    }
    await new Promise((resolvePromise) => {
        let started = false;
        process.on("message", (message) => {
            if (!started && message === DOCUMENT_START_FRAME) {
                started = true;
                resolvePromise();
                return;
            }
            privateExit(started ? 76 /* PrivateExitCode.LifelineData */ : 75 /* PrivateExitCode.StartFrame */);
        });
        process.once("disconnect", () => {
            if (!started)
                privateExit(75 /* PrivateExitCode.StartFrame */);
            handleLifelineEnd();
        });
        process.send(DOCUMENT_START_GATE_READY_FRAME, (error) => {
            if (error !== null)
                privateExit(75 /* PrivateExitCode.StartFrame */);
        });
    });
}
function readDescriptor(descriptor, buffer, offset, length) {
    return new Promise((resolvePromise, rejectPromise) => {
        const attempt = () => {
            const input = createReadStream("", {
                fd: descriptor,
                autoClose: false,
                highWaterMark: length,
            });
            let settled = false;
            const settle = (error, bytes) => {
                if (settled)
                    return;
                settled = true;
                input.removeAllListeners();
                input.destroy();
                if (error !== undefined && isRetryableNonBlockingError(error)) {
                    setTimeout(attempt, 1);
                }
                else if (error !== undefined) {
                    rejectPromise(error);
                }
                else if (bytes === undefined) {
                    resolvePromise(0);
                }
                else {
                    buffer.set(bytes, offset);
                    resolvePromise(bytes.byteLength);
                }
            };
            input.once("data", (chunk) => {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                settle(undefined, bytes);
            });
            input.once("end", () => settle(undefined));
            input.once("error", (error) => settle(error));
        };
        attempt();
    });
}
function writeDescriptor(descriptor, buffer, offset, length) {
    return new Promise((resolvePromise, rejectPromise) => {
        const attempt = () => {
            const output = createWriteStream("", {
                fd: descriptor,
                autoClose: false,
            });
            let settled = false;
            const settle = (error) => {
                if (settled)
                    return;
                settled = true;
                output.removeAllListeners();
                output.destroy();
                if (error !== undefined && error !== null && isRetryableNonBlockingError(error)) {
                    setTimeout(attempt, 1);
                }
                else if (error !== undefined && error !== null) {
                    rejectPromise(error);
                }
                else {
                    resolvePromise(length);
                }
            };
            output.once("error", settle);
            output.write(Buffer.from(buffer.buffer, buffer.byteOffset + offset, length), settle);
        };
        attempt();
    });
}
function isRetryableNonBlockingError(error) {
    return isNodeError(error) && ["EAGAIN", "EWOULDBLOCK"].includes(String(error.code));
}
function closeDescriptor(descriptor) {
    return new Promise((resolvePromise, rejectPromise) => {
        close(descriptor, (error) => {
            if (error === null)
                resolvePromise();
            else
                rejectPromise(error);
        });
    });
}
function registerDocumentProcessSync() {
    const nonce = randomUUID();
    const frame = encodeRegisterFrame({
        schemaVersion: 1,
        type: "register",
        nonce,
        pid: process.pid,
        parentPid: process.ppid,
    });
    try {
        writeAllSync(BENCHMARK_REGISTRATION_DESCRIPTOR, frame);
    }
    catch {
        privateExit(72 /* PrivateExitCode.RegistrationWrite */);
    }
    let acknowledgement;
    try {
        acknowledgement = parseAckFrame(readOneRegistrationFrameSync(BENCHMARK_ACK_DESCRIPTOR));
    }
    catch {
        privateExit(73 /* PrivateExitCode.RegistrationAck */);
    }
    if (acknowledgement.nonce !== nonce || acknowledgement.status !== "accepted") {
        privateExit(73 /* PrivateExitCode.RegistrationAck */);
    }
    try {
        closeSync(BENCHMARK_REGISTRATION_DESCRIPTOR);
        closeSync(BENCHMARK_ACK_DESCRIPTOR);
    }
    catch {
        privateExit(74 /* PrivateExitCode.RegistrationClose */);
    }
}
function writeAllSync(descriptor, bytes) {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
        if (written <= 0)
            throw new Error("registration write failed");
        offset += written;
    }
}
function readOneRegistrationFrameSync(descriptor) {
    const frame = Buffer.allocUnsafeSlow(MAX_REGISTRATION_FRAME_BYTES);
    const readBuffer = Buffer.allocUnsafeSlow(MAX_REGISTRATION_CHANNEL_BYTES);
    let frameBytes = 0;
    while (true) {
        const count = readSync(descriptor, readBuffer, 0, readBuffer.byteLength, null);
        if (count === 0)
            throw new Error("registration channel ended");
        const newline = readBuffer.subarray(0, count).indexOf(0x0a);
        if (newline !== -1 && newline !== count - 1) {
            throw new Error("trailing registration data");
        }
        if (frameBytes + count > MAX_REGISTRATION_FRAME_BYTES) {
            throw new Error("registration frame exceeds limit");
        }
        frame.set(readBuffer.subarray(0, count), frameBytes);
        frameBytes += count;
        if (newline !== -1)
            return frame.subarray(0, frameBytes);
    }
}
function readStartFrameSync() {
    const received = Buffer.allocUnsafeSlow(START_BYTES.byteLength + 1);
    let offset = 0;
    try {
        while (offset < START_BYTES.byteLength) {
            const count = readSync(DOCUMENT_START_DESCRIPTOR, received, offset, received.byteLength - offset, null);
            if (count === 0)
                privateExit(75 /* PrivateExitCode.StartFrame */);
            offset += count;
            if (offset > START_BYTES.byteLength)
                privateExit(75 /* PrivateExitCode.StartFrame */);
        }
    }
    catch {
        privateExit(75 /* PrivateExitCode.StartFrame */);
    }
    if (!received.subarray(0, offset).equals(START_BYTES)) {
        privateExit(75 /* PrivateExitCode.StartFrame */);
    }
}
function installLifelineWatcher() {
    const lifeline = createReadStream("", {
        fd: DOCUMENT_START_DESCRIPTOR,
        autoClose: false,
    });
    let terminal = false;
    lifeline.on("data", () => {
        if (terminal)
            return;
        terminal = true;
        privateExit(76 /* PrivateExitCode.LifelineData */);
    });
    lifeline.on("error", () => {
        if (terminal)
            return;
        terminal = true;
        privateExit(77 /* PrivateExitCode.LifelineError */);
    });
    lifeline.on("end", () => {
        if (terminal)
            return;
        terminal = true;
        handleLifelineEnd();
    });
    lifeline.resume();
}
function handleLifelineEnd() {
    if (process.platform === "win32")
        privateExit(78 /* PrivateExitCode.LifelineEnd */);
    try {
        process.kill(-process.pid, "SIGKILL");
    }
    catch {
        privateExit(78 /* PrivateExitCode.LifelineEnd */);
    }
    return privateExit(78 /* PrivateExitCode.LifelineEnd */);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function privateExit(code) {
    process.exit(code);
}
