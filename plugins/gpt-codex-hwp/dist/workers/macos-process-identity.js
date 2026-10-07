import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_TRACKED_PROCESS_IDENTITIES, } from "./posix-process-records.js";
import { pythonCommandCandidates, resolvePythonCommand } from "../shared/python-command.js";
const execFileAsync = promisify(execFile);
// Resolved once per process from the same trusted absolute locations as the
// image helper, so a Homebrew python3 is preferred over the /usr/bin/python3
// stub that may prompt for the Command Line Tools.
let macosPythonCommand;
function resolveMacosPython() {
    macosPythonCommand ??= resolvePythonCommand(pythonCommandCandidates("darwin"))
        .then((python) => {
        if (python === undefined)
            throw new Error("macOS process identity requires Python 3");
        return python.command;
    });
    return macosPythonCommand;
}
const MAX_MACOS_IDENTITY_STABILIZATION_ROUNDS = 4;
export async function snapshotMacosPsRecords() {
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
export function bindMacosProcessRecords(psRecords, identitiesBefore, identitiesAfter, retained, confirmedAbsentRetainedPids) {
    const records = [];
    const retainedPids = new Set([...retained.values()].map((record) => record.pid));
    for (const psRecord of psRecords) {
        const before = identitiesBefore.get(psRecord.pid);
        const after = identitiesAfter.get(psRecord.pid);
        if (before === undefined || after === undefined) {
            if (retainedPids.has(psRecord.pid)) {
                if (confirmedAbsentRetainedPids.has(psRecord.pid))
                    continue;
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
const MACOS_LIBPROC_IDENTITY_SCRIPT = String.raw `
import ctypes, errno, json, sys
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
        if error not in (0, errno.EPERM, errno.ESRCH): raise OSError(error, "proc_pidinfo")
        continue
    if size != ctypes.sizeof(info) or info.pbi_pid != pid: raise RuntimeError("invalid proc_pidinfo")
    out.append({"pid": pid, "ppid": info.pbi_ppid, "pgid": info.pbi_pgid, "sec": info.pbi_start_tvsec, "usec": info.pbi_start_tvusec})
print(json.dumps(out, separators=(",", ":")))
`;
export async function macosKernelIdentities(pids = []) {
    if (pids.length > MAX_TRACKED_PROCESS_IDENTITIES)
        throw new Error("macOS PID limit exceeded");
    const result = await execFileAsync(await resolveMacosPython(), ["-c", MACOS_LIBPROC_IDENTITY_SCRIPT, ...pids.map(String)], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
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
