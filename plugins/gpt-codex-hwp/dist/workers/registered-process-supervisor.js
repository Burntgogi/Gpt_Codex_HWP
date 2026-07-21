const DEFAULT_TERMINATION_GRACE_MS = 100;
const MAX_REGISTERED_PROCESS_GROUPS = 16;
export function createRegisteredPosixProcessGroupSupervisor(dependencies) {
    const signalGroup = dependencies.signalGroup ?? ((processGroupId, signal) => {
        process.kill(-processGroupId, signal);
    });
    const delay = dependencies.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const terminationGraceMs = dependencies.terminationGraceMs
        ?? DEFAULT_TERMINATION_GRACE_MS;
    const registered = new Map();
    const pendingPids = new Set();
    const provenAbsent = new Set();
    let registryGeneration = 0;
    let verifiedReceipt;
    let activeTermination;
    return {
        processTreeRss: dependencies.processTreeRss,
        async registerRoot(pid, expectedParentPid) {
            if (!Number.isSafeInteger(pid) || pid <= 0) {
                throw new Error("invalid process group root pid");
            }
            if (registered.has(pid) || pendingPids.has(pid)) {
                throw new Error("process group already registered");
            }
            if (registered.size + pendingPids.size >= MAX_REGISTERED_PROCESS_GROUPS) {
                throw new Error("registered process group limit exceeded");
            }
            pendingPids.add(pid);
            try {
                const before = await dependencies.inspectIdentity(pid);
                const after = await dependencies.inspectIdentity(pid);
                if (before === undefined || after === undefined ||
                    !sameRegistrationIdentity(before, after)) {
                    throw new Error("process group root identity unavailable");
                }
                if (after.pid !== pid || after.processGroupId !== pid) {
                    throw new Error("process group root is not its group leader");
                }
                if (expectedParentPid !== undefined && after.parentPid !== expectedParentPid) {
                    throw new Error("process group root parent identity mismatch");
                }
                if (registered.has(pid))
                    throw new Error("process group already registered");
                const retained = Object.freeze({ ...after });
                registered.set(pid, retained);
                registryGeneration += 1;
                verifiedReceipt = undefined;
                return retained;
            }
            finally {
                pendingPids.delete(pid);
            }
        },
        terminate() {
            if (pendingPids.size === 0 &&
                verifiedReceipt?.generation === registryGeneration &&
                verifiedReceipt.receipt.gone === true) {
                return Promise.resolve(verifiedReceipt.receipt);
            }
            const generation = registryGeneration;
            const generationCurrent = () => registryGeneration === generation && pendingPids.size === 0;
            activeTermination ??= terminateRegisteredGroups([...registered.values()], provenAbsent, dependencies.inspectIdentity, signalGroup, delay, terminationGraceMs, generationCurrent).then((receipt) => {
                if (receipt.gone && generationCurrent()) {
                    verifiedReceipt = Object.freeze({ generation, receipt });
                }
                return receipt;
            }).finally(() => {
                activeTermination = undefined;
            });
            return activeTermination;
        },
    };
}
export function normalizeProcessTreeTerminationReceipt(value, invalidReason = "termination") {
    if (!isPlainRecord(value))
        return unverifiedTermination(invalidReason);
    const keys = Object.keys(value).sort().join(",");
    if (keys === "gone,proof" && value.gone === true &&
        (value.proof === "windows-job-empty" || value.proof === "registered-groups-empty")) {
        return Object.freeze({ gone: true, proof: value.proof });
    }
    if (keys === "gone,proof,reason" && value.gone === false &&
        value.proof === "unverified" && isUnverifiedReason(value.reason)) {
        return Object.freeze({ gone: false, proof: "unverified", reason: value.reason });
    }
    return unverifiedTermination(invalidReason);
}
export function unverifiedTermination(reason) {
    return Object.freeze({ gone: false, proof: "unverified", reason });
}
async function terminateRegisteredGroups(registered, provenAbsent, inspectIdentity, signalGroup, delay, terminationGraceMs, generationCurrent) {
    if (registered.length === 0)
        return unverifiedTermination("registration");
    const unresolved = new Map(registered
        .filter((identity) => !provenAbsent.has(processIdentityKey(identity)))
        .map((identity) => [identity.pid, identity]));
    let failure;
    for (const signal of ["SIGTERM", "SIGKILL"]) {
        const signalled = new Set();
        const eligible = new Set();
        for (const identity of unresolved.values()) {
            let current;
            try {
                current = await inspectIdentity(identity.pid);
            }
            catch {
                failure = preferFailure(failure, "channel");
                continue;
            }
            if (current !== undefined && !sameKernelIdentity(current, identity)) {
                failure = preferFailure(failure, "identity");
                continue;
            }
            eligible.add(identity.pid);
            const result = signalRegisteredGroup(identity.processGroupId, signal, signalGroup);
            if (result === "absent") {
                provenAbsent.add(processIdentityKey(identity));
                unresolved.delete(identity.pid);
            }
            else if (result === "signalled") {
                signalled.add(identity.pid);
            }
            else {
                failure = preferFailure(failure, result);
            }
        }
        if (signalled.size > 0)
            await delay(terminationGraceMs);
        for (const identity of [...unresolved.values()]) {
            if (!eligible.has(identity.pid))
                continue;
            const presence = probeRegisteredGroup(identity.processGroupId, signalGroup);
            if (presence === "absent") {
                provenAbsent.add(processIdentityKey(identity));
                unresolved.delete(identity.pid);
            }
            else if (presence !== "present") {
                failure = preferFailure(failure, presence);
            }
        }
        if (unresolved.size === 0) {
            return generationCurrent()
                ? Object.freeze({ gone: true, proof: "registered-groups-empty" })
                : unverifiedTermination("registration");
        }
    }
    if (!generationCurrent())
        return unverifiedTermination("registration");
    return unverifiedTermination(failure ?? "deadline");
}
function signalRegisteredGroup(processGroupId, signal, signalGroup) {
    try {
        signalGroup(processGroupId, signal);
        return "signalled";
    }
    catch (error) {
        if (hasErrorCode(error, "ESRCH"))
            return "absent";
        if (hasErrorCode(error, "EPERM"))
            return "permission";
        return "termination";
    }
}
function probeRegisteredGroup(processGroupId, signalGroup) {
    try {
        signalGroup(processGroupId, 0);
        return "present";
    }
    catch (error) {
        if (hasErrorCode(error, "ESRCH"))
            return "absent";
        if (hasErrorCode(error, "EPERM"))
            return "permission";
        return "termination";
    }
}
function sameRegistrationIdentity(left, right) {
    return left.pid === right.pid &&
        left.parentPid === right.parentPid &&
        left.processGroupId === right.processGroupId &&
        left.identity === right.identity &&
        left.startOrder === right.startOrder;
}
function sameKernelIdentity(left, right) {
    return left.pid === right.pid &&
        left.processGroupId === right.processGroupId &&
        left.identity === right.identity &&
        left.startOrder === right.startOrder;
}
function processIdentityKey(identity) {
    return `${identity.pid}:${identity.processGroupId}:${identity.identity}:${identity.startOrder}`;
}
function preferFailure(current, candidate) {
    const priority = {
        registration: 6,
        identity: 5,
        channel: 4,
        permission: 3,
        termination: 2,
        deadline: 1,
    };
    return current === undefined || priority[candidate] > priority[current]
        ? candidate
        : current;
}
function hasErrorCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error &&
        String(error.code) === code;
}
function isPlainRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isUnverifiedReason(value) {
    return value === "registration" || value === "identity" || value === "channel" ||
        value === "permission" || value === "deadline" || value === "termination";
}
