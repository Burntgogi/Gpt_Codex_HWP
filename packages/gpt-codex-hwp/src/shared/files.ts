import { constants, type BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";

import { authorizeExistingPath } from "./allowed-roots.js";

export const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const READ_CHUNK_BYTES = 1024 * 1024;

export interface BoundedFileReadTestHooks {
  afterSourceRead?(): void | Promise<void>;
}

export interface BoundedFileReadOptions {
  allocationObserver?: (allocatedBytes: number) => void;
  testHooks?: BoundedFileReadTestHooks;
}

type FileReadErrorCode =
  | "ENOENT"
  | "FILE_READ_ERROR"
  | "INVALID_FILE_TYPE"
  | "INVALID_READ_OPTIONS"
  | "SOURCE_CHANGED";

export async function readFileBounded(
  path: string,
  label: string,
  maximumBytes = MAX_DOCUMENT_BYTES,
  options: BoundedFileReadOptions = {},
): Promise<Buffer> {
  const safeLabel = normalizedLabel(label);
  validateReadOptions(maximumBytes, options);
  if (typeof path !== "string" || path.trim().length === 0) {
    throw readFailedError(safeLabel);
  }
  const authorizedPath = await authorizeExistingPath(path);

  try {
    const handle = await openFileForBoundedRead(authorizedPath);
    try {
      return await readExactFile(
        handle,
        authorizedPath,
        safeLabel,
        maximumBytes,
        options,
      );
    } finally {
      try {
        await handle.close();
      } catch {
        throw readFailedError(safeLabel);
      }
    }
  } catch (error: unknown) {
    if (error instanceof FileLimitError || error instanceof FileReadError) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      throw new FileReadError("ENOENT", `Could not read ${safeLabel} safely.`);
    }
    throw readFailedError(safeLabel);
  }
}

export function openFileForBoundedRead(path: string): Promise<FileHandle> {
  return process.platform === "win32"
    ? open(path, "r")
    : open(path, constants.O_RDONLY | constants.O_NONBLOCK);
}

async function readExactFile(
  handle: FileHandle,
  path: string,
  label: string,
  maximumBytes: number,
  options: BoundedFileReadOptions,
): Promise<Buffer> {
  const initialHandleStatus = await handle.stat({ bigint: true });
  if (!initialHandleStatus.isFile()) {
    throw new FileReadError(
      "INVALID_FILE_TYPE",
      `${label} must be a regular file.`,
    );
  }
  if (initialHandleStatus.size > BigInt(maximumBytes)) {
    throw new FileLimitError(
      `${label} exceeds the ${maximumBytes}-byte safety limit.`,
    );
  }

  const initialIdentity = identityOf(initialHandleStatus);
  assertSameIdentity(initialIdentity, await pathIdentity(path, label), label);
  const sizeBytes = Number(initialHandleStatus.size);
  options.allocationObserver?.(sizeBytes);
  const bytes = Buffer.allocUnsafeSlow(sizeBytes);

  let position = 0;
  while (position < sizeBytes) {
    const requested = Math.min(READ_CHUNK_BYTES, sizeBytes - position);
    const { bytesRead } = await handle.read(
      bytes,
      position,
      requested,
      position,
    );
    if (bytesRead === 0) throw sourceChangedError(label);
    position += bytesRead;
  }

  await options.testHooks?.afterSourceRead?.();
  assertSameIdentity(
    initialIdentity,
    identityOf(await handle.stat({ bigint: true })),
    label,
  );
  assertSameIdentity(initialIdentity, await pathIdentity(path, label), label);
  return bytes;
}

function validateReadOptions(
  maximumBytes: number,
  options: BoundedFileReadOptions,
): void {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    typeof options !== "object" ||
    options === null
  ) {
    throw invalidOptionsError();
  }
  if (
    options.allocationObserver !== undefined &&
    typeof options.allocationObserver !== "function"
  ) {
    throw invalidOptionsError();
  }
  const hooks = options.testHooks;
  if (hooks !== undefined) {
    if (typeof hooks !== "object" || hooks === null) {
      throw invalidOptionsError();
    }
    if (
      hooks.afterSourceRead !== undefined &&
      typeof hooks.afterSourceRead !== "function"
    ) {
      throw invalidOptionsError();
    }
  }
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
}

async function pathIdentity(path: string, label: string): Promise<FileIdentity> {
  try {
    return identityOf(await stat(path, { bigint: true }));
  } catch {
    throw sourceChangedError(label);
  }
}

function identityOf(status: BigIntStats): FileIdentity {
  return {
    device: status.dev,
    inode: status.ino,
    size: status.size,
    modified: status.mtimeNs,
    changed: status.ctimeNs,
  };
}

function assertSameIdentity(
  expected: FileIdentity,
  actual: FileIdentity,
  label: string,
): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.size !== actual.size ||
    expected.modified !== actual.modified ||
    expected.changed !== actual.changed
  ) {
    throw sourceChangedError(label);
  }
}

function normalizedLabel(label: string): string {
  if (
    typeof label === "string" &&
    /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/u.test(label.trim())
  ) {
    return label.trim();
  }
  return "file";
}

export class FileLimitError extends Error {
  readonly code = "FILE_SIZE_LIMIT";

  constructor(message: string) {
    super(message);
    this.name = "FileLimitError";
  }
}

export class FileReadError extends Error {
  constructor(
    readonly code: FileReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FileReadError";
  }
}

function sourceChangedError(label: string): FileReadError {
  return new FileReadError(
    "SOURCE_CHANGED",
    `${normalizedLabel(label)} changed while it was read.`,
  );
}

function readFailedError(label: string): FileReadError {
  return new FileReadError(
    "FILE_READ_ERROR",
    `Could not read ${normalizedLabel(label)} safely.`,
  );
}

function invalidOptionsError(): FileReadError {
  return new FileReadError(
    "INVALID_READ_OPTIONS",
    "Bounded file read options are invalid.",
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}
