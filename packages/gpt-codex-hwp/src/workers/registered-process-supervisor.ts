type RegisteredIdentityCounts = Readonly<{
  registeredIdentityCount: number;
  remainingIdentityCount: number;
}>;

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
    }>
  | (Readonly<{
      gone: true;
      proof: "registered-groups-empty";
    }> & RegisteredIdentityCounts)
  | (Readonly<{
      gone: false;
      proof: "unverified";
      reason:
        | "registration"
        | "identity"
        | "channel"
        | "permission"
        | "deadline"
        | "termination";
    }> & RegisteredIdentityCounts);

export type RegisteredProcessGroupTerminationReceipt = Extract<
  ProcessTreeTerminationReceipt,
  RegisteredIdentityCounts
>;

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

export interface RegisteredPosixProcessGroupSupervisor
  extends RegisteredProcessGroupSupervisor {
  terminate(): Promise<RegisteredProcessGroupTerminationReceipt>;
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
export const MAX_REGISTERED_PROCESS_GROUPS = 16;

export function createRegisteredPosixProcessGroupSupervisor(
  dependencies: RegisteredPosixProcessGroupDependencies,
): RegisteredPosixProcessGroupSupervisor {
  const signalGroup = dependencies.signalGroup ?? ((processGroupId, signal) => {
    process.kill(-processGroupId, signal);
  });
  const delay = dependencies.delay ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const terminationGraceMs = dependencies.terminationGraceMs
    ?? DEFAULT_TERMINATION_GRACE_MS;
  const registered = new Map<number, RegisteredProcessGroupIdentity>();
  const pendingPids = new Set<number>();
  const provenAbsent = new Set<string>();
  let registryGeneration = 0;
  let verifiedReceipt: Readonly<{
    generation: number;
    receipt: RegisteredProcessGroupTerminationReceipt;
  }> | undefined;
  let activeTermination: Promise<RegisteredProcessGroupTerminationReceipt> | undefined;

  return {
    processTreeRss: dependencies.processTreeRss,
    async registerRoot(
      pid: number,
      expectedParentPid?: number,
    ): Promise<RegisteredProcessGroupIdentity> {
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
        if (registered.has(pid)) throw new Error("process group already registered");
        const retained = Object.freeze({ ...after });
        registered.set(pid, retained);
        registryGeneration += 1;
        verifiedReceipt = undefined;
        return retained;
      } finally {
        pendingPids.delete(pid);
      }
    },
    terminate(): Promise<RegisteredProcessGroupTerminationReceipt> {
      if (pendingPids.size === 0 &&
        verifiedReceipt?.generation === registryGeneration &&
        verifiedReceipt.receipt.gone === true) {
        return Promise.resolve(verifiedReceipt.receipt);
      }
      const generation = registryGeneration;
      const generationCurrent = (): boolean =>
        registryGeneration === generation && pendingPids.size === 0;
      activeTermination ??= terminateRegisteredGroups(
        [...registered.values()],
        provenAbsent,
        dependencies.inspectIdentity,
        signalGroup,
        delay,
        terminationGraceMs,
        generationCurrent,
      ).then((receipt) => {
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

type TypeContract<Condition extends true> = Condition;
type ExactType<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type GenericSupervisorTerminationContract = TypeContract<ExactType<
  Awaited<ReturnType<RegisteredProcessGroupSupervisor["terminate"]>>,
  ProcessTreeTerminationReceipt
>>;
type ConcretePosixSupervisorFactoryContract = TypeContract<ExactType<
  ReturnType<typeof createRegisteredPosixProcessGroupSupervisor>,
  RegisteredPosixProcessGroupSupervisor
>>;
type ConcretePosixSupervisorTerminationContract = TypeContract<ExactType<
  Awaited<ReturnType<
    ReturnType<typeof createRegisteredPosixProcessGroupSupervisor>["terminate"]
  >>,
  RegisteredProcessGroupTerminationReceipt
>>;

export function normalizeProcessTreeTerminationReceipt(
  value: unknown,
  invalidReason: UnverifiedTerminationReason = "termination",
): ProcessTreeTerminationReceipt {
  if (!isPlainRecord(value)) return unverifiedTermination(invalidReason);
  const keys = Object.keys(value).sort().join(",");
  if (keys === "gone,proof,registeredIdentityCount,remainingIdentityCount"
    && value.gone === true && value.proof === "registered-groups-empty"
    && validRegisteredIdentityCounts(value, true)) {
    return Object.freeze({
      gone: true,
      proof: "registered-groups-empty",
      registeredIdentityCount: value.registeredIdentityCount,
      remainingIdentityCount: value.remainingIdentityCount,
    });
  }
  if (keys === "gone,proof,reason,registeredIdentityCount,remainingIdentityCount"
    && value.gone === false && value.proof === "unverified"
    && isUnverifiedReason(value.reason)
    && validRegisteredIdentityCounts(value, false)) {
    return Object.freeze({
      gone: false,
      proof: "unverified",
      reason: value.reason,
      registeredIdentityCount: value.registeredIdentityCount,
      remainingIdentityCount: value.remainingIdentityCount,
    });
  }
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

async function terminateRegisteredGroups(
  registered: readonly RegisteredProcessGroupIdentity[],
  provenAbsent: Set<string>,
  inspectIdentity: RegisteredPosixProcessGroupDependencies["inspectIdentity"],
  signalGroup: NonNullable<RegisteredPosixProcessGroupDependencies["signalGroup"]>,
  delay: NonNullable<RegisteredPosixProcessGroupDependencies["delay"]>,
  terminationGraceMs: number,
  generationCurrent: () => boolean,
): Promise<RegisteredProcessGroupTerminationReceipt> {
  if (registered.length === 0) {
    return countedTermination(unverifiedTermination("registration"), 0, 0);
  }
  const unresolved = new Map(
    registered
      .filter((identity) => !provenAbsent.has(processIdentityKey(identity)))
      .map((identity) => [identity.pid, identity]),
  );
  let failure: UnverifiedTerminationReason | undefined;

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const signalled = new Set<number>();
    const eligible = new Set<number>();
    for (const identity of unresolved.values()) {
      let current: RegisteredProcessGroupIdentity | undefined;
      try {
        current = await inspectIdentity(identity.pid);
      } catch {
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
      } else if (result === "signalled") {
        signalled.add(identity.pid);
      } else {
        failure = preferFailure(failure, result);
      }
    }
    if (signalled.size > 0) await delay(terminationGraceMs);

    for (const identity of [...unresolved.values()]) {
      if (!eligible.has(identity.pid)) continue;
      const presence = probeRegisteredGroup(identity.processGroupId, signalGroup);
      if (presence === "absent") {
        provenAbsent.add(processIdentityKey(identity));
        unresolved.delete(identity.pid);
      } else if (presence !== "present") {
        failure = preferFailure(failure, presence);
      }
    }

    if (unresolved.size === 0) {
      return countedTermination(
        generationCurrent()
          ? Object.freeze({ gone: true, proof: "registered-groups-empty" })
          : unverifiedTermination("registration"),
        registered.length,
        0,
      );
    }
  }
  return countedTermination(
    !generationCurrent()
      ? unverifiedTermination("registration")
      : unverifiedTermination(failure ?? "deadline"),
    registered.length,
    unresolved.size,
  );
}

function countedTermination(
  receipt: ProcessTreeTerminationReceipt,
  registeredIdentityCount: number,
  remainingIdentityCount: number,
): RegisteredProcessGroupTerminationReceipt {
  return receipt.gone
    ? Object.freeze({
        gone: true,
        proof: "registered-groups-empty",
        registeredIdentityCount,
        remainingIdentityCount,
      })
    : Object.freeze({
        gone: false,
        proof: "unverified",
        reason: receipt.reason,
        registeredIdentityCount,
        remainingIdentityCount,
      });
}

function signalRegisteredGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
  signalGroup: NonNullable<RegisteredPosixProcessGroupDependencies["signalGroup"]>,
): "signalled" | "absent" | UnverifiedTerminationReason {
  try {
    signalGroup(processGroupId, signal);
    return "signalled";
  } catch (error: unknown) {
    if (hasErrorCode(error, "ESRCH")) return "absent";
    if (hasErrorCode(error, "EPERM")) return "permission";
    return "termination";
  }
}

function probeRegisteredGroup(
  processGroupId: number,
  signalGroup: NonNullable<RegisteredPosixProcessGroupDependencies["signalGroup"]>,
): "present" | "absent" | UnverifiedTerminationReason {
  try {
    signalGroup(processGroupId, 0);
    return "present";
  } catch (error: unknown) {
    if (hasErrorCode(error, "ESRCH")) return "absent";
    if (hasErrorCode(error, "EPERM")) return "permission";
    return "termination";
  }
}

function sameRegistrationIdentity(
  left: RegisteredProcessGroupIdentity,
  right: RegisteredProcessGroupIdentity,
): boolean {
  return left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.processGroupId === right.processGroupId &&
    left.identity === right.identity &&
    left.startOrder === right.startOrder;
}

function sameKernelIdentity(
  left: RegisteredProcessGroupIdentity,
  right: RegisteredProcessGroupIdentity,
): boolean {
  return left.pid === right.pid &&
    left.processGroupId === right.processGroupId &&
    left.identity === right.identity &&
    left.startOrder === right.startOrder;
}

function processIdentityKey(identity: RegisteredProcessGroupIdentity): string {
  return `${identity.pid}:${identity.processGroupId}:${identity.identity}:${identity.startOrder}`;
}

function preferFailure(
  current: UnverifiedTerminationReason | undefined,
  candidate: UnverifiedTerminationReason,
): UnverifiedTerminationReason {
  const priority: Readonly<Record<UnverifiedTerminationReason, number>> = {
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

function validRegisteredIdentityCounts(
  value: Record<string, unknown>,
  requireRegisteredIdentity: boolean,
): value is Record<string, unknown> & RegisteredIdentityCounts {
  const registered = value.registeredIdentityCount;
  const remaining = value.remainingIdentityCount;
  return Number.isSafeInteger(registered) && Number.isSafeInteger(remaining)
    && (registered as number) >= (requireRegisteredIdentity ? 1 : 0)
    && (remaining as number) >= 0
    && (remaining as number) <= (registered as number)
    && (registered as number) <= MAX_REGISTERED_PROCESS_GROUPS
    && (!requireRegisteredIdentity || remaining === 0);
}
