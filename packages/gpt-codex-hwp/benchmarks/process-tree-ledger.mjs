import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const START_IDENTITY_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/u;

function ledgerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateIdentity(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)
    || !Number.isSafeInteger(record.pid) || record.pid < 1
    || !Number.isSafeInteger(record.parentPid) || record.parentPid < 0
    || typeof record.startIdentity !== "string"
    || !START_IDENTITY_PATTERN.test(record.startIdentity)
    || JSON.stringify(Object.keys(record).sort())
      !== JSON.stringify(["parentPid", "pid", "startIdentity"])) {
    throw ledgerError("PROCESS_IDENTITY_INVALID");
  }
  return record;
}

function identityKey(record) {
  return `${record.pid}:${record.startIdentity}`;
}

export function selectProcessTreeIdentities(rootPids, snapshot) {
  if (!Array.isArray(rootPids) || rootPids.length < 1
    || rootPids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
    || new Set(rootPids).size !== rootPids.length
    || !Array.isArray(snapshot) || snapshot.length > 4_096) {
    throw ledgerError("PROCESS_SNAPSHOT_INVALID");
  }
  const records = snapshot.map(validateIdentity);
  const byPid = new Map(records.map((record) => [record.pid, record]));
  if (rootPids.some((pid) => !byPid.has(pid))) throw ledgerError("PROCESS_ROOT_MISSING");
  const selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (selected.has(record.parentPid) && !selected.has(record.pid)) {
        selected.add(record.pid);
        changed = true;
      }
    }
  }
  return records.filter(({ pid }) => selected.has(pid));
}

export function observeIdentityLedger(ledger, snapshot) {
  if (!(ledger instanceof Map) || ledger.size > 4_096
    || !Array.isArray(snapshot) || snapshot.length > 4_096) {
    throw ledgerError("PROCESS_LEDGER_INVALID");
  }
  for (const raw of snapshot) {
    const record = validateIdentity(raw);
    const key = identityKey(record);
    if (!ledger.has(key)) {
      if (ledger.size >= 4_096) throw ledgerError("PROCESS_LEDGER_LIMIT_EXCEEDED");
      ledger.set(key, Object.freeze({
        pid: record.pid,
        parentPid: record.parentPid,
        startIdentity: record.startIdentity,
      }));
    }
  }
  return ledger;
}

export async function waitForIdentityLedgerGone({
  ledger,
  snapshot,
  timeoutMs,
  pollIntervalMs = 50,
  now = performance.now.bind(performance),
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!(ledger instanceof Map) || ledger.size < 1 || ledger.size > 4_096
    || typeof snapshot !== "function" || typeof now !== "function" || typeof delay !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
    || pollIntervalMs > timeoutMs) {
    throw ledgerError("PROCESS_LEDGER_WAIT_INVALID");
  }
  for (const [key, record] of ledger) {
    validateIdentity(record);
    if (key !== identityKey(record)) throw ledgerError("PROCESS_LEDGER_INVALID");
  }
  const started = now();
  let remainingIdentityCount = ledger.size;
  while (true) {
    const current = await snapshot();
    if (!Array.isArray(current) || current.length > 4_096) {
      throw ledgerError("PROCESS_SNAPSHOT_INVALID");
    }
    const currentKeys = new Set(current.map((record) => identityKey(validateIdentity(record))));
    remainingIdentityCount = [...ledger.keys()].filter((key) => currentKeys.has(key)).length;
    if (remainingIdentityCount === 0 || now() - started >= timeoutMs) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (now() - started))));
  }
  return Object.freeze({
    observedIdentityCount: ledger.size,
    remainingIdentityCount,
  });
}

export async function snapshotProcessTreeIdentities(rootPids) {
  if (process.platform === "win32") {
    return selectProcessTreeIdentities(rootPids, await snapshotWindowsIdentities());
  }
  const parents = await snapshotPosixParents();
  const selectedPids = selectTreePids(rootPids, parents);
  const records = await Promise.all(selectedPids.map((pid) => process.platform === "linux"
    ? snapshotLinuxIdentity(pid)
    : snapshotMacosIdentity(pid)));
  if (records.some((record) => record === undefined)) throw ledgerError("PROCESS_IDENTITY_CHANGED");
  return records;
}

export async function snapshotLedgerIdentities(ledger) {
  if (!(ledger instanceof Map) || ledger.size < 1 || ledger.size > 4_096) {
    throw ledgerError("PROCESS_LEDGER_INVALID");
  }
  if (process.platform === "win32") {
    const pids = new Set([...ledger.values()].map(({ pid }) => pid));
    return (await snapshotWindowsIdentities()).filter(({ pid }) => pids.has(pid));
  }
  const records = await Promise.all([...ledger.values()].map(({ pid }) => process.platform === "linux"
    ? snapshotLinuxIdentity(pid)
    : snapshotMacosIdentity(pid)));
  return records.filter((record) => record !== undefined);
}

export async function terminateIdentityLedgerProcesses({
  ledger,
  snapshot = () => snapshotLedgerIdentities(ledger),
  terminate = (pid) => process.kill(pid, "SIGKILL"),
}) {
  if (!(ledger instanceof Map) || ledger.size < 1 || ledger.size > 4_096
    || typeof snapshot !== "function" || typeof terminate !== "function") {
    throw ledgerError("PROCESS_LEDGER_INVALID");
  }
  for (const [key, record] of ledger) {
    validateIdentity(record);
    if (key !== identityKey(record)) throw ledgerError("PROCESS_LEDGER_INVALID");
  }
  const current = await snapshot();
  if (!Array.isArray(current) || current.length > 4_096) {
    throw ledgerError("PROCESS_SNAPSHOT_INVALID");
  }
  for (const raw of current) {
    const record = validateIdentity(raw);
    if (!ledger.has(identityKey(record))) continue;
    try { await terminate(record.pid); } catch {}
  }
}

async function snapshotWindowsIdentities() {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { if ($null -ne $_.CreationDate) { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToFileTimeUtc() } }",
  ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000, windowsHide: true });
  const records = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = /^\s*([0-9]+),([0-9]+),([1-9][0-9]*)\s*$/u.exec(line);
    if (match === null || records.length >= 4_096) throw ledgerError("PROCESS_SNAPSHOT_INVALID");
    if (match[1] === "0") continue;
    records.push(validateIdentity({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      startIdentity: match[3],
    }));
  }
  return records;
}

async function snapshotPosixParents() {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000,
  });
  const records = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s*$/u.exec(line);
    if (match === null || records.length >= 4_096) throw ledgerError("PROCESS_SNAPSHOT_INVALID");
    records.push({ pid: Number(match[1]), parentPid: Number(match[2]) });
  }
  return records;
}

function selectTreePids(rootPids, records) {
  const present = new Set(records.map(({ pid }) => pid));
  if (rootPids.some((pid) => !present.has(pid))) throw ledgerError("PROCESS_ROOT_MISSING");
  const selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (selected.has(record.parentPid) && !selected.has(record.pid)) {
        selected.add(record.pid);
        changed = true;
      }
    }
  }
  return [...selected];
}

async function snapshotLinuxIdentity(pid) {
  let stat;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const closing = stat.lastIndexOf(") ");
  const fields = closing < 0 ? [] : stat.slice(closing + 2).trim().split(/\s+/u);
  const parentPid = Number(fields[1]);
  const startIdentity = fields[19];
  if (!Number.isSafeInteger(parentPid) || parentPid < 0
    || typeof startIdentity !== "string" || !/^[0-9]+$/u.test(startIdentity)) {
    throw ledgerError("PROCESS_SNAPSHOT_INVALID");
  }
  return validateIdentity({ pid, parentPid, startIdentity });
}

async function snapshotMacosIdentity(pid) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pid=,ppid=,lstart="], {
      encoding: "utf8", maxBuffer: 8 * 1024, timeout: 5_000,
    }));
  } catch (error) {
    if (error?.code === 1) return undefined;
    throw error;
  }
  const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s+(.+?)\s*$/u.exec(stdout);
  if (match === null) return undefined;
  const startIdentity = match[3].trim().replace(/[^A-Za-z0-9._-]+/gu, "-");
  return validateIdentity({ pid: Number(match[1]), parentPid: Number(match[2]), startIdentity });
}
