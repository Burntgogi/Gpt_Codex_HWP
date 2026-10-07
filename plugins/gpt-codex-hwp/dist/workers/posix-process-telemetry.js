import { open, opendir } from "node:fs/promises";
import { bindMacosProcessRecords, macosKernelIdentities, snapshotMacosPsRecords, } from "./macos-process-identity.js";
import { MAX_TRACKED_PROCESS_IDENTITIES, } from "./posix-process-records.js";
import { createRegisteredPosixProcessGroupSupervisor, normalizeProcessTreeTerminationReceipt, } from "./registered-process-supervisor.js";
const LINUX_PROCESS_SAMPLE_MS = 25;
const MACOS_PROCESS_SAMPLE_MS = 100;
const MAX_LINUX_TASKS_PER_PROCESS = 1_024;
const MAX_LINUX_CHILDREN_PER_PROCESS = 4_096;
const MAX_LINUX_PROC_STAT_BYTES = 64 * 1024;
const MAX_LINUX_PROC_STATUS_BYTES = 256 * 1024;
const MAX_LINUX_TASK_CHILDREN_BYTES = 64 * 1024;
const MAX_LINUX_MISSING_RSS_ATTEMPTS = 3;
export function createPosixProcessTelemetryTrackerForTest(rootPid, platform, snapshots) {
    return new PosixProcessTreeTracker(rootPid, platform, snapshots);
}
export function createPosixProcessTreeSupervisorForTest(child, platform, dependencies) {
    return createPosixProcessTreeSupervisor(child, platform, dependencies);
}
export async function createPosixProcessTreeSupervisor(child, platform, dependencies = {}) {
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
    let telemetryQuiescing = false;
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
        telemetryQuiescing = false;
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
        if (telemetryQuiescing) {
            stoppedProcessTreeRss = readCompleteProcessTreeRss();
            const available = stoppedProcessTreeRss !== undefined;
            const waiters = [...coverageWaiters];
            coverageWaiters.clear();
            deactivateTelemetry("stopped");
            for (const settle of waiters)
                settle(available);
            return;
        }
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
    const queueSample = (requiredForFlush = false) => {
        if (telemetryState !== "active" || (telemetryQuiescing && !requiredForFlush))
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
            if (coveredTelemetryGeneration < requiredTelemetryGeneration ||
                (!telemetryQuiescing && sampleRequested)) {
                queueSample(telemetryQuiescing);
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
                sampler = scheduleInterval(() => queueSample(), platform === "linux" ? LINUX_PROCESS_SAMPLE_MS : MACOS_PROCESS_SAMPLE_MS);
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
            if (telemetryState !== "active" || telemetryQuiescing) {
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
            if (telemetryState === "stopped") {
                return Promise.resolve(stoppedProcessTreeRss !== undefined);
            }
            if (telemetryState !== "active")
                return Promise.resolve(false);
            telemetryQuiescing = true;
            clearSampler();
            return new Promise((resolvePromise) => {
                coverageWaiters.add(resolvePromise);
                if (!sampleRunning && coveredTelemetryGeneration < requiredTelemetryGeneration) {
                    queueSample(true);
                }
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
    const confirmedAbsentRetainedPids = new Set();
    const missingRetainedPids = retainedPids.filter((pid) => !identitiesAfter.has(pid));
    if (missingRetainedPids.length > 0) {
        const finalPsPids = new Set((await snapshotMacosPsRecords()).map((record) => record.pid));
        for (const pid of missingRetainedPids) {
            if (!finalPsPids.has(pid))
                confirmedAbsentRetainedPids.add(pid);
        }
    }
    return bindMacosProcessRecords(psRecords, identitiesBefore, identitiesAfter, retained, confirmedAbsentRetainedPids);
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
export function snapshotLinuxProcessForTest(pid, requireRss, readProcText) {
    return snapshotLinuxProcess(pid, requireRss, readProcText);
}
async function snapshotLinuxProcess(pid, requireRss = true, readProcText = readBoundedProcText) {
    try {
        let expectedIdentity;
        const attempts = requireRss ? MAX_LINUX_MISSING_RSS_ATTEMPTS : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const statBefore = await readProcText(`/proc/${pid}/stat`, MAX_LINUX_PROC_STAT_BYTES);
            const status = requireRss
                ? await readProcText(`/proc/${pid}/status`, MAX_LINUX_PROC_STATUS_BYTES)
                : undefined;
            const statAfter = await readProcText(`/proc/${pid}/stat`, MAX_LINUX_PROC_STAT_BYTES);
            const before = parseLinuxStat(pid, statBefore);
            const after = parseLinuxStat(pid, statAfter);
            if (before.identity !== after.identity || before.parentPid !== after.parentPid)
                return undefined;
            if (expectedIdentity !== undefined && after.identity !== expectedIdentity)
                return undefined;
            const record = linuxPosixProcessRecord(after);
            if (status === undefined)
                return Object.freeze({ ...record, rssBytes: 0 });
            const rssMatch = /^VmRSS:\s+([0-9]+)\s+kB$/mu.exec(status);
            if (rssMatch !== null) {
                const rssBytes = Number(rssMatch[1]) * 1024;
                if (!Number.isSafeInteger(rssBytes) || rssBytes < 0) {
                    throw new Error("invalid Linux VmRSS");
                }
                return Object.freeze({ ...record, rssBytes });
            }
            const statusState = /^State:\s+([A-Za-z])(?:\s|\()/mu.exec(status)?.[1];
            if (before.state === after.state && statusState === after.state &&
                (after.state === "Z" || after.state === "X")) {
                return Object.freeze({ ...record, rssBytes: 0 });
            }
            if (attempt + 1 === attempts)
                throw new Error("Linux VmRSS unavailable");
            expectedIdentity ??= after.identity;
            await new Promise((resolveWait) => setImmediate(resolveWait));
        }
        throw new Error("Linux VmRSS unavailable");
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
function linuxPosixProcessRecord(stat) {
    return Object.freeze({
        pid: stat.pid,
        parentPid: stat.parentPid,
        processGroupId: stat.processGroupId,
        identity: stat.identity,
        startOrder: stat.startOrder,
    });
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
    const state = fields[0];
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startOrder = Number(fields[19]);
    if (![pid, parentPid, processGroupId, startOrder].every(Number.isSafeInteger)
        || pid <= 0 || parentPid < 0 || processGroupId <= 0 || startOrder <= 0) {
        throw new Error("invalid Linux process record");
    }
    return Object.freeze({
        pid,
        state,
        parentPid,
        processGroupId,
        identity: String(startOrder),
        startOrder,
    });
}
function isMissingProcessError(error) {
    return typeof error === "object" && error !== null && "code" in error
        && ["ENOENT", "ESRCH"].includes(String(error.code));
}
