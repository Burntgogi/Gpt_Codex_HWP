import type { ChildProcess } from "node:child_process";
import { open, opendir } from "node:fs/promises";

import type { ChildLifecycleSupervisor } from "./child-process-primitives.js";
import {
  bindMacosProcessRecords,
  macosKernelIdentities,
  snapshotMacosPsRecords,
} from "./macos-process-identity.js";
import {
  MAX_TRACKED_PROCESS_IDENTITIES,
  type PosixProcessRecord,
  type RetainedPosixProcess,
} from "./posix-process-records.js";
import {
  createRegisteredPosixProcessGroupSupervisor,
  normalizeProcessTreeTerminationReceipt,
  type ProcessTreeTerminationReceipt,
  type RegisteredProcessGroupIdentity,
  type RegisteredProcessGroupSupervisor,
} from "./registered-process-supervisor.js";

const LINUX_PROCESS_SAMPLE_MS = 25;
const MACOS_PROCESS_SAMPLE_MS = 100;
const MAX_LINUX_TASKS_PER_PROCESS = 1_024;
const MAX_LINUX_CHILDREN_PER_PROCESS = 4_096;
const MAX_LINUX_PROC_STAT_BYTES = 64 * 1024;
const MAX_LINUX_PROC_STATUS_BYTES = 256 * 1024;
const MAX_LINUX_TASK_CHILDREN_BYTES = 64 * 1024;
const MAX_LINUX_MISSING_RSS_ATTEMPTS = 3;

export interface PosixProcessTelemetryTestRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly identity: string;
  readonly startOrder: number;
  readonly rssBytes: number;
}

export interface PosixProcessTelemetryTracker {
  initialize(): Promise<void>;
  registerRoot(identity: RegisteredProcessGroupIdentity): void;
  sample(): Promise<unknown>;
  disableTelemetry(): void;
  telemetryAvailable(): boolean;
  processTreeRss(): Readonly<{ baselineBytes: number; peakBytes: number }>;
}

export function createPosixProcessTelemetryTrackerForTest(
  rootPid: number,
  platform: "linux" | "darwin",
  snapshots: Readonly<{
    root(): Promise<PosixProcessTelemetryTestRecord | undefined>;
    tree(): Promise<readonly PosixProcessTelemetryTestRecord[]>;
  }>,
): PosixProcessTelemetryTracker {
  return new PosixProcessTreeTracker(rootPid, platform, snapshots);
}

export interface PosixTelemetryIntervalHandle {
  unref(): void;
}

export interface PosixProcessTreeSupervisorTestDependencies {
  readonly registeredSupervisor?: RegisteredProcessGroupSupervisor;
  readonly tracker?: PosixProcessTelemetryTracker;
  readonly scheduleInterval?: (
    callback: () => void,
    milliseconds: number,
  ) => PosixTelemetryIntervalHandle;
  readonly clearScheduledInterval?: (handle: PosixTelemetryIntervalHandle) => void;
  readonly deferProcessTreeTelemetryStop?: boolean;
  readonly frameObserver?: (frame: string) => void;
}

export function createPosixProcessTreeSupervisorForTest(
  child: ChildProcess,
  platform: "linux" | "darwin",
  dependencies: PosixProcessTreeSupervisorTestDependencies,
): Promise<ChildLifecycleSupervisor> {
  return createPosixProcessTreeSupervisor(child, platform, dependencies);
}

export async function createPosixProcessTreeSupervisor(
  child: ChildProcess,
  platform: NodeJS.Platform,
  dependencies: PosixProcessTreeSupervisorTestDependencies = {},
): Promise<ChildLifecycleSupervisor> {
  if (child.pid === undefined) throw new Error("child pid unavailable");
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`unsupported process-tree metrics platform: ${platform}`);
  }
  const registeredSupervisor = dependencies.registeredSupervisor
    ?? createRegisteredPosixProcessGroupSupervisor({
      inspectIdentity: (pid) => snapshotRegisteredPosixProcessGroupIdentity(pid, platform),
    });
  try {
    await registeredSupervisor.registerRoot(child.pid, process.pid);
  } catch (error: unknown) {
    dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR root-authority");
    throw error;
  }
  const tracker = dependencies.tracker ?? new PosixProcessTreeTracker(child.pid, platform);
  const scheduleInterval = dependencies.scheduleInterval ?? ((callback, milliseconds) =>
    setInterval(callback, milliseconds));
  const clearScheduledInterval = dependencies.clearScheduledInterval ?? ((handle) => {
    clearInterval(handle as NodeJS.Timeout);
  });
  let telemetryState: "initializing" | "active" | "disabled" | "stopped" = "initializing";
  let telemetryQuiescing = false;
  let sampler: PosixTelemetryIntervalHandle | undefined;
  let sampleRunning = false;
  let sampleRequested = false;
  let requiredTelemetryGeneration = 0;
  let coveredTelemetryGeneration = 0;
  const telemetryRootKeys = new Set<string>();
  const coverageWaiters = new Set<(available: boolean) => void>();
  let settleTelemetryReady!: (available: boolean) => void;
  let telemetryReadySettled = false;
  const processTreeTelemetryReady = new Promise<boolean>((resolve) => {
    settleTelemetryReady = (available) => {
      if (telemetryReadySettled) return;
      telemetryReadySettled = true;
      resolve(available);
    };
  });
  let stoppedProcessTreeRss: Readonly<{
    baselineBytes: number;
    peakBytes: number;
  }> | undefined;
  let verifiedTerminationReceipt: ProcessTreeTerminationReceipt | undefined;
  let activeTermination: Promise<ProcessTreeTerminationReceipt> | undefined;

  const clearSampler = (): void => {
    const handle = sampler;
    sampler = undefined;
    if (handle === undefined) return;
    try { clearScheduledInterval(handle); } catch {}
  };
  const disableTracker = (): void => {
    try { tracker.disableTelemetry(); } catch {}
  };
  const deactivateTelemetry = (state: "disabled" | "stopped"): void => {
    telemetryState = state;
    telemetryQuiescing = false;
    settleTelemetryReady(false);
    sampleRequested = false;
    clearSampler();
    disableTracker();
    for (const settle of coverageWaiters) settle(false);
    coverageWaiters.clear();
  };
  const settleCoverageWaiters = (): void => {
    if (telemetryState !== "active" || sampleRunning ||
      coveredTelemetryGeneration < requiredTelemetryGeneration) return;
    if (telemetryQuiescing) {
      stoppedProcessTreeRss = readCompleteProcessTreeRss();
      const available = stoppedProcessTreeRss !== undefined;
      const waiters = [...coverageWaiters];
      coverageWaiters.clear();
      deactivateTelemetry("stopped");
      for (const settle of waiters) settle(available);
      return;
    }
    for (const settle of coverageWaiters) settle(true);
    coverageWaiters.clear();
  };
  const readCompleteProcessTreeRss = (): Readonly<{
    baselineBytes: number;
    peakBytes: number;
  }> | undefined => {
    if (telemetryState !== "active" || sampleRunning ||
      coveredTelemetryGeneration < requiredTelemetryGeneration) return undefined;
    try {
      return tracker.telemetryAvailable() ? tracker.processTreeRss() : undefined;
    } catch {
      deactivateTelemetry("disabled");
      return undefined;
    }
  };
  const queueSample = (requiredForFlush = false): void => {
    if (telemetryState !== "active" || (telemetryQuiescing && !requiredForFlush)) return;
    if (sampleRunning) {
      sampleRequested = true;
      return;
    }
    sampleRunning = true;
    sampleRequested = false;
    const sampleGeneration = requiredTelemetryGeneration;
    let sample: Promise<unknown>;
    try {
      sample = tracker.sample();
    } catch {
      sampleRunning = false;
      deactivateTelemetry("disabled");
      return;
    }
    void sample.then(
      () => {
        sampleRunning = false;
        if (telemetryState !== "active") return;
        coveredTelemetryGeneration = Math.max(
          coveredTelemetryGeneration,
          sampleGeneration,
        );
        if (coveredTelemetryGeneration < requiredTelemetryGeneration ||
          (!telemetryQuiescing && sampleRequested)) {
          queueSample(telemetryQuiescing);
          return;
        }
        settleCoverageWaiters();
      },
      () => {
        sampleRunning = false;
        if (telemetryState === "active") {
          dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR telemetry-sample");
          deactivateTelemetry("disabled");
        }
      },
    ).catch(() => {
      sampleRunning = false;
      if (telemetryState === "active") {
        dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR telemetry-sample");
        deactivateTelemetry("disabled");
      }
    });
  };

  let initialization: Promise<void> | undefined;
  try {
    initialization = tracker.initialize();
  } catch {
    dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR telemetry-initialize");
    deactivateTelemetry("disabled");
  }
  if (initialization !== undefined) {
    void initialization.then(
      () => {
        if (telemetryState !== "initializing") return;
        telemetryState = "active";
        try {
          sampler = scheduleInterval(
            () => queueSample(),
            platform === "linux" ? LINUX_PROCESS_SAMPLE_MS : MACOS_PROCESS_SAMPLE_MS,
          );
          sampler.unref();
          settleTelemetryReady(true);
        } catch {
          deactivateTelemetry("disabled");
        }
      },
      () => {
        if (telemetryState === "initializing") {
          dependencies.frameObserver?.("GPT_CODEX_HWP_POSIX ERROR telemetry-initialize");
          deactivateTelemetry("disabled");
        }
      },
    ).catch(() => {
      if (telemetryState !== "stopped") deactivateTelemetry("disabled");
    });
  }

  const stopTelemetry = (): void => {
    if (telemetryState === "stopped") return;
    stoppedProcessTreeRss = readCompleteProcessTreeRss();
    deactivateTelemetry("stopped");
  };

  return {
    processTreeTelemetryReady,
    registerProcessTreeTelemetryRoot(identity): void {
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
    finishProcessTreeTelemetry(): void {
      stopTelemetry();
    },
    flushProcessTreeTelemetry(): Promise<boolean> {
      if (telemetryState === "stopped") {
        return Promise.resolve(stoppedProcessTreeRss !== undefined);
      }
      if (telemetryState !== "active") return Promise.resolve(false);
      telemetryQuiescing = true;
      clearSampler();
      return new Promise<boolean>((resolvePromise) => {
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
    terminate(): Promise<ProcessTreeTerminationReceipt> {
      if (verifiedTerminationReceipt?.gone === true) {
        return Promise.resolve(verifiedTerminationReceipt);
      }
      if (activeTermination !== undefined) return activeTermination;
      let registeredTermination: Promise<ProcessTreeTerminationReceipt>;
      try {
        registeredTermination = registeredSupervisor.terminate();
      } catch (error: unknown) {
        registeredTermination = Promise.reject(error);
      }
      const settledAttempt = registeredTermination.then(
        (receipt) => {
          if (dependencies.deferProcessTreeTelemetryStop !== true) stopTelemetry();
          const recognized = normalizeProcessTreeTerminationReceipt(receipt);
          if (recognized.gone === true) verifiedTerminationReceipt = recognized;
          return receipt;
        },
        (error: unknown) => {
          if (dependencies.deferProcessTreeTelemetryStop !== true) stopTelemetry();
          throw error;
        },
      );
      let sharedAttempt: Promise<ProcessTreeTerminationReceipt>;
      sharedAttempt = settledAttempt.finally(() => {
        if (activeTermination === sharedAttempt) activeTermination = undefined;
      });
      activeTermination = sharedAttempt;
      return sharedAttempt;
    },
  };
}

class PosixProcessTreeTracker {
  readonly #rootPid: number;
  readonly #platform: "linux" | "darwin";
  readonly #retained = new Map<string, RetainedPosixProcess>();
  readonly #retainedByPid = new Map<number, RetainedPosixProcess[]>();
  #baselineBytes = 0;
  #peakBytes = 0;
  #telemetryAvailable = true;

  constructor(
    rootPid: number,
    platform: "linux" | "darwin",
    readonly snapshots?: Readonly<{
      root(): Promise<PosixProcessTelemetryTestRecord | undefined>;
      tree(): Promise<readonly PosixProcessTelemetryTestRecord[]>;
    }>,
  ) {
    this.#rootPid = rootPid;
    this.#platform = platform;
  }

  async initialize(): Promise<void> {
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
    if (this.#baselineBytes <= 0) throw new Error("baseline process-tree RSS unavailable");
    this.#peakBytes = this.#baselineBytes;
  }

  async sample(): Promise<readonly RetainedPosixProcess[]> {
    const live = this.#observe(await this.#snapshot());
    this.#peakBytes = Math.max(this.#peakBytes, sumProcessRss(live));
    return live;
  }

  registerRoot(identity: RegisteredProcessGroupIdentity): void {
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

  async #snapshot(): Promise<PosixProcessRecord[]> {
    if (this.snapshots !== undefined) return [...await this.snapshots.tree()];
    return this.#platform === "linux"
      ? snapshotLinuxRetainedTree(this.#retained)
      : snapshotPosixProcesses(this.#platform, this.#retained);
  }

  processTreeRss(): Readonly<{ baselineBytes: number; peakBytes: number }> {
    return Object.freeze({
      baselineBytes: this.#baselineBytes,
      peakBytes: this.#peakBytes,
    });
  }

  telemetryAvailable(): boolean {
    return this.#telemetryAvailable;
  }

  disableTelemetry(): void {
    this.#telemetryAvailable = false;
  }

  #observe(records: readonly PosixProcessRecord[]): RetainedPosixProcess[] {
    const liveByPid = new Map(records.map((record) => [record.pid, record]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        const key = posixIdentityKey(record);
        if (this.#retained.has(key)) continue;
        const parent = this.#retainedParent(record, liveByPid);
        if (parent === undefined || record.startOrder < parent.startOrder) continue;
        this.#retain({ ...record, depth: parent.depth + 1 });
        changed = true;
      }
    }
    return records.flatMap((record) => {
      const retained = this.#retained.get(posixIdentityKey(record));
      return retained === undefined ? [] : [{ ...retained, rssBytes: record.rssBytes }];
    });
  }

  #retainedParent(
    record: PosixProcessRecord,
    liveByPid: ReadonlyMap<number, PosixProcessRecord>,
  ): RetainedPosixProcess | undefined {
    const liveParent = liveByPid.get(record.parentPid);
    if (liveParent !== undefined) {
      return this.#retained.get(posixIdentityKey(liveParent));
    }
    return this.#retainedByPid.get(record.parentPid)
      ?.filter((candidate) => candidate.startOrder <= record.startOrder)
      .sort((left, right) => right.startOrder - left.startOrder)[0];
  }

  #retain(record: RetainedPosixProcess): void {
    if (this.#retained.size >= MAX_TRACKED_PROCESS_IDENTITIES) {
      throw new Error("retained process identity limit exceeded");
    }
    const key = posixIdentityKey(record);
    this.#retained.set(key, record);
    const identities = this.#retainedByPid.get(record.pid) ?? [];
    identities.push(record);
    this.#retainedByPid.set(record.pid, identities);
  }

  #replaceRetained(record: RetainedPosixProcess): void {
    const key = posixIdentityKey(record);
    const identities = this.#retainedByPid.get(record.pid);
    const index = identities?.findIndex((candidate) =>
      posixIdentityKey(candidate) === key) ?? -1;
    if (index < 0 || identities === undefined) {
      throw new Error("retained process identity index mismatch");
    }
    const replacement = [...identities];
    replacement[index] = record;
    this.#retained.set(key, record);
    this.#retainedByPid.set(record.pid, replacement);
  }

}

function samePosixStableIdentity(
  left: Pick<PosixProcessRecord, "pid" | "processGroupId" | "identity" | "startOrder">,
  right: Pick<PosixProcessRecord, "pid" | "processGroupId" | "identity" | "startOrder">,
): boolean {
  return left.pid === right.pid &&
    left.processGroupId === right.processGroupId &&
    left.identity === right.identity &&
    left.startOrder === right.startOrder;
}

function posixIdentityKey(record: Pick<PosixProcessRecord, "pid" | "identity">): string {
  return `${record.pid}:${record.identity}`;
}

function sumProcessRss(records: readonly Pick<PosixProcessRecord, "rssBytes">[]): number {
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

async function snapshotPosixProcesses(
  platform: "linux" | "darwin",
  retained: ReadonlyMap<string, RetainedPosixProcess> = new Map(),
): Promise<PosixProcessRecord[]> {
  if (platform === "linux") throw new Error("Linux uses retained /proc task traversal");
  const identitiesBefore = await macosKernelIdentities();
  const psRecords = await snapshotMacosPsRecords();
  const retainedPids = [...new Set([...retained.values()].map((record) => record.pid))];
  const identitiesAfter = await macosKernelIdentities(
    [...new Set([...psRecords.map((record) => record.pid), ...retainedPids])],
  );
  const confirmedAbsentRetainedPids = new Set<number>();
  const missingRetainedPids = retainedPids.filter((pid) => !identitiesAfter.has(pid));
  if (missingRetainedPids.length > 0) {
    const finalPsPids = new Set(
      (await snapshotMacosPsRecords()).map((record) => record.pid),
    );
    for (const pid of missingRetainedPids) {
      if (!finalPsPids.has(pid)) confirmedAbsentRetainedPids.add(pid);
    }
  }
  return bindMacosProcessRecords(
    psRecords,
    identitiesBefore,
    identitiesAfter,
    retained,
    confirmedAbsentRetainedPids,
  );
}

async function snapshotLinuxRetainedTree(
  retained: ReadonlyMap<string, RetainedPosixProcess>,
  requireRss = true,
): Promise<PosixProcessRecord[]> {
  const records = new Map<string, PosixProcessRecord>();
  const queued = new Set<string>();
  const queue: Array<{ pid: number; expectedIdentity: string }> = [];
  for (const process of retained.values()) {
    enqueueLinuxProcess(queue, queued, {
      pid: process.pid,
      expectedIdentity: process.identity,
    });
  }
  while (queue.length > 0) {
    const item = queue.shift()!;
    const process = await snapshotLinuxProcess(item.pid, requireRss);
    if (process === undefined || process.identity !== item.expectedIdentity) continue;
    const processKey = posixIdentityKey(process);
    if (!records.has(processKey) && records.size >= MAX_TRACKED_PROCESS_IDENTITIES) {
      throw new Error("Linux process record limit exceeded");
    }
    records.set(processKey, process);
    for (const childPid of await linuxTaskChildren(process.pid)) {
      const child = await snapshotLinuxProcess(childPid, requireRss);
      if (child === undefined) continue;
      if (child.parentPid !== process.pid) continue;
      enqueueLinuxProcess(queue, queued, {
        pid: childPid,
        expectedIdentity: child.identity,
      });
    }
  }
  return [...records.values()];
}

function enqueueLinuxProcess(
  queue: Array<{ pid: number; expectedIdentity: string }>,
  queued: Set<string>,
  item: { pid: number; expectedIdentity: string },
): void {
  const key = `${item.pid}:${item.expectedIdentity}`;
  if (queued.has(key)) return;
  if (queued.size >= MAX_TRACKED_PROCESS_IDENTITIES) {
    throw new Error("Linux process queue limit exceeded");
  }
  queued.add(key);
  queue.push(item);
}

async function linuxTaskChildren(pid: number): Promise<number[]> {
  try {
    const taskDirectories: string[] = [];
    const directory = await opendir(`/proc/${pid}/task`);
    for await (const entry of directory) {
      if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
      if (taskDirectories.length >= MAX_LINUX_TASKS_PER_PROCESS) {
        throw new Error("Linux task limit exceeded");
      }
      taskDirectories.push(entry.name);
    }
    const children = new Set<number>();
    for (const taskName of taskDirectories) {
      const content = await readBoundedProcText(
        `/proc/${pid}/task/${taskName}/children`,
        MAX_LINUX_TASK_CHILDREN_BYTES,
      ).catch((error: unknown) => {
        if (isMissingProcessError(error)) return "";
        throw error;
      });
      for (const token of content.trim().split(/\s+/u)) {
        if (token === "") continue;
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
  } catch (error: unknown) {
    if (isMissingProcessError(error)) return [];
    throw error;
  }
}

async function snapshotPosixIdentity(
  platform: "linux" | "darwin",
  pid: number,
): Promise<PosixProcessRecord | undefined> {
  if (platform === "linux") return snapshotLinuxProcess(pid, false);
  const identity = (await macosKernelIdentities([pid])).get(pid);
  return identity === undefined
    ? undefined
    : Object.freeze({ pid, ...identity, rssBytes: 0 });
}

export async function snapshotRegisteredPosixProcessGroupIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<RegisteredProcessGroupIdentity | undefined> {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`unsupported registered process-group platform: ${platform}`);
  }
  const record = await snapshotPosixIdentity(platform, pid);
  if (record === undefined) return undefined;
  return Object.freeze({
    pid: record.pid,
    parentPid: record.parentPid,
    processGroupId: record.processGroupId,
    identity: record.identity,
    startOrder: record.startOrder,
  });
}

type LinuxProcTextReader = (path: string, maxBytes: number) => Promise<string>;

export function snapshotLinuxProcessForTest(
  pid: number,
  requireRss: boolean,
  readProcText: LinuxProcTextReader,
): Promise<PosixProcessRecord | undefined> {
  return snapshotLinuxProcess(pid, requireRss, readProcText);
}

async function snapshotLinuxProcess(
  pid: number,
  requireRss = true,
  readProcText: LinuxProcTextReader = readBoundedProcText,
): Promise<PosixProcessRecord | undefined> {
  try {
    let expectedIdentity: string | undefined;
    const attempts = requireRss ? MAX_LINUX_MISSING_RSS_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const statBefore = await readProcText(
        `/proc/${pid}/stat`,
        MAX_LINUX_PROC_STAT_BYTES,
      );
      const status = requireRss
        ? await readProcText(`/proc/${pid}/status`, MAX_LINUX_PROC_STATUS_BYTES)
        : undefined;
      const statAfter = await readProcText(
        `/proc/${pid}/stat`,
        MAX_LINUX_PROC_STAT_BYTES,
      );
      const before = parseLinuxStat(pid, statBefore);
      const after = parseLinuxStat(pid, statAfter);
      if (before.identity !== after.identity || before.parentPid !== after.parentPid) return undefined;
      if (expectedIdentity !== undefined && after.identity !== expectedIdentity) return undefined;
      const record = linuxPosixProcessRecord(after);
      if (status === undefined) return Object.freeze({ ...record, rssBytes: 0 });
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
      if (attempt + 1 === attempts) throw new Error("Linux VmRSS unavailable");
      expectedIdentity ??= after.identity;
      await new Promise<void>((resolveWait) => setImmediate(resolveWait));
    }
    throw new Error("Linux VmRSS unavailable");
  } catch (error: unknown) {
    if (isMissingProcessError(error)) return undefined;
    throw error;
  }
}

async function readBoundedProcText(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const receipt = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (receipt.bytesRead === 0) break;
      offset += receipt.bytesRead;
    }
    if (offset > maxBytes) throw new Error("Linux proc record is oversized");
    return bytes.toString("utf8", 0, offset);
  } finally {
    await handle.close();
  }
}

interface LinuxProcessStatRecord extends Omit<PosixProcessRecord, "rssBytes"> {
  readonly state: string;
}

function linuxPosixProcessRecord(
  stat: LinuxProcessStatRecord,
): Omit<PosixProcessRecord, "rssBytes"> {
  return Object.freeze({
    pid: stat.pid,
    parentPid: stat.parentPid,
    processGroupId: stat.processGroupId,
    identity: stat.identity,
    startOrder: stat.startOrder,
  });
}

function parseLinuxStat(pid: number, stat: string): LinuxProcessStatRecord {
    if (stat.length > 64 * 1024) throw new Error("Linux process stat is oversized");
    const close = stat.lastIndexOf(")");
    if (close < 0) throw new Error("invalid Linux process stat");
    const fields = stat.slice(close + 1).trim().split(/\s+/u);
    if (fields.length < 20 || fields.length > 64) throw new Error("invalid Linux process stat fields");
    const state = fields[0]!;
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

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ["ENOENT", "ESRCH"].includes(String((error as { code?: unknown }).code));
}
