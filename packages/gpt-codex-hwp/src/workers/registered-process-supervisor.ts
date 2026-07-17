export type ProcessTreeTerminationReceipt =
  | Readonly<{
      gone: true;
      proof: "windows-job-empty" | "registered-groups-empty";
    }>
  | Readonly<{
      gone: false;
      proof: "unverified";
      reason:
        | "registration"
        | "identity"
        | "channel"
        | "permission"
        | "deadline"
        | "termination";
    }>;

export interface RegisteredProcessGroupIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly identity: string;
  readonly startOrder: number;
}

export interface RegisteredProcessGroupSupervisor {
  registerRoot(
    pid: number,
    expectedParentPid?: number,
  ): Promise<RegisteredProcessGroupIdentity>;
  terminate(): Promise<ProcessTreeTerminationReceipt>;
  processTreeRss?(): Readonly<{
    baselineBytes: number;
    peakBytes: number;
  }> | undefined;
}

export type UnverifiedTerminationReason = Extract<
  ProcessTreeTerminationReceipt,
  { gone: false }
>["reason"];

export interface RegisteredPosixProcessGroupDependencies {
  readonly inspectIdentity: (
    pid: number,
  ) => Promise<RegisteredProcessGroupIdentity | undefined>;
  readonly signalGroup?: (
    processGroupId: number,
    signal: NodeJS.Signals | 0,
  ) => void;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly terminationGraceMs?: number;
  readonly processTreeRss?: () => Readonly<{
    baselineBytes: number;
    peakBytes: number;
  }> | undefined;
}

const DEFAULT_TERMINATION_GRACE_MS = 100;

export function createRegisteredPosixProcessGroupSupervisor(
  dependencies: RegisteredPosixProcessGroupDependencies,
): RegisteredProcessGroupSupervisor {
  const signalGroup = dependencies.signalGroup ?? ((processGroupId, signal) => {
    process.kill(-processGroupId, signal);
  });
  const delay = dependencies.delay ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const terminationGraceMs = dependencies.terminationGraceMs
    ?? DEFAULT_TERMINATION_GRACE_MS;
  let registered: RegisteredProcessGroupIdentity | undefined;
  let verifiedReceipt: ProcessTreeTerminationReceipt | undefined;
  let activeTermination: Promise<ProcessTreeTerminationReceipt> | undefined;

  return {
    processTreeRss: dependencies.processTreeRss,
    async registerRoot(
      pid: number,
      expectedParentPid?: number,
    ): Promise<RegisteredProcessGroupIdentity> {
      if (registered !== undefined) throw new Error("process group already registered");
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("invalid process group root pid");
      }
      const before = await dependencies.inspectIdentity(pid);
      const after = await dependencies.inspectIdentity(pid);
      if (before === undefined || after === undefined || !sameIdentity(before, after)) {
        throw new Error("process group root identity unavailable");
      }
      if (after.pid !== pid || after.processGroupId !== pid) {
        throw new Error("process group root is not its group leader");
      }
      if (expectedParentPid !== undefined && after.parentPid !== expectedParentPid) {
        throw new Error("process group root parent identity mismatch");
      }
      registered = Object.freeze({ ...after });
      return registered;
    },
    terminate(): Promise<ProcessTreeTerminationReceipt> {
      if (verifiedReceipt?.gone === true) return Promise.resolve(verifiedReceipt);
      activeTermination ??= terminateRegisteredGroup(
        registered,
        dependencies.inspectIdentity,
        signalGroup,
        delay,
        terminationGraceMs,
      ).then((receipt) => {
        if (receipt.gone) verifiedReceipt = receipt;
        return receipt;
      }).finally(() => {
        activeTermination = undefined;
      });
      return activeTermination;
    },
  };
}

export function normalizeProcessTreeTerminationReceipt(
  value: unknown,
  invalidReason: UnverifiedTerminationReason = "termination",
): ProcessTreeTerminationReceipt {
  if (!isPlainRecord(value)) return unverifiedTermination(invalidReason);
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

export function unverifiedTermination(
  reason: UnverifiedTerminationReason,
): ProcessTreeTerminationReceipt {
  return Object.freeze({ gone: false, proof: "unverified", reason });
}

async function terminateRegisteredGroup(
  registered: RegisteredProcessGroupIdentity | undefined,
  inspectIdentity: RegisteredPosixProcessGroupDependencies["inspectIdentity"],
  signalGroup: NonNullable<RegisteredPosixProcessGroupDependencies["signalGroup"]>,
  delay: NonNullable<RegisteredPosixProcessGroupDependencies["delay"]>,
  terminationGraceMs: number,
): Promise<ProcessTreeTerminationReceipt> {
  if (registered === undefined) return unverifiedTermination("registration");
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    let current: RegisteredProcessGroupIdentity | undefined;
    try {
      current = await inspectIdentity(registered.pid);
    } catch {
      return unverifiedTermination("channel");
    }
    if (current !== undefined && !sameIdentity(current, registered)) {
      return unverifiedTermination("identity");
    }
    const signalled = signalRegisteredGroup(registered.processGroupId, signal, signalGroup);
    if (signalled !== undefined) return signalled;
    await delay(terminationGraceMs);
    const presence = probeRegisteredGroup(registered.processGroupId, signalGroup);
    if (presence !== undefined) return presence;
  }
  return unverifiedTermination("deadline");
}

function signalRegisteredGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
  signalGroup: NonNullable<RegisteredPosixProcessGroupDependencies["signalGroup"]>,
): ProcessTreeTerminationReceipt | undefined {
  try {
    signalGroup(processGroupId, signal);
    return undefined;
  } catch (error: unknown) {
    if (hasErrorCode(error, "ESRCH")) {
      return Object.freeze({ gone: true, proof: "registered-groups-empty" });
    }
    if (hasErrorCode(error, "EPERM")) return unverifiedTermination("permission");
    return unverifiedTermination("termination");
  }
}

function probeRegisteredGroup(
  processGroupId: number,
  signalGroup: NonNullable<RegisteredPosixProcessGroupDependencies["signalGroup"]>,
): ProcessTreeTerminationReceipt | undefined {
  try {
    signalGroup(processGroupId, 0);
    return undefined;
  } catch (error: unknown) {
    if (hasErrorCode(error, "ESRCH")) {
      return Object.freeze({ gone: true, proof: "registered-groups-empty" });
    }
    if (hasErrorCode(error, "EPERM")) return unverifiedTermination("permission");
    return unverifiedTermination("termination");
  }
}

function sameIdentity(
  left: RegisteredProcessGroupIdentity,
  right: RegisteredProcessGroupIdentity,
): boolean {
  return left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.processGroupId === right.processGroupId &&
    left.identity === right.identity &&
    left.startOrder === right.startOrder;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    String((error as { code?: unknown }).code) === code;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnverifiedReason(value: unknown): value is UnverifiedTerminationReason {
  return value === "registration" || value === "identity" || value === "channel" ||
    value === "permission" || value === "deadline" || value === "termination";
}
