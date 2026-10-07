export const MAX_TRACKED_PROCESS_IDENTITIES = 4_096;

export interface PosixProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly identity: string;
  readonly startOrder: number;
  readonly rssBytes: number;
}

export interface RetainedPosixProcess extends PosixProcessRecord {
  readonly depth: number;
}
