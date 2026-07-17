import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { read as readFd } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";

import { resolveLocalPath } from "./paths.js";
import {
  AllowedRootsPathError,
  authorizeExistingPath,
  authorizeFuturePath,
} from "./allowed-roots.js";

export interface ExclusiveOutputFile {
  path: string;
  data: string | Uint8Array;
}

export interface ExclusiveOutputOptions {
  sourcePaths?: readonly string[];
  beforeOpen?: () => void | Promise<void>;
  expectedDirectoryIdentities?: readonly OutputDirectoryIdentity[];
  /** Unit-test-only hook for deterministic post-open identity races. */
  unitTestAfterOpen?: (path: string, index: number) => void | Promise<void>;
  /** Unit-test-only identity seam; production callers must leave this unset. */
  unitTestDirectoryIdentityCheck?: (
    directory: OutputDirectoryIdentity,
  ) => void | Promise<void>;
}

export interface ExclusiveInputRange {
  readonly fd: number;
  readonly offset: number;
  readonly sizeBytes: number;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

interface SourceIdentity extends FileIdentity {
  path: string;
}

export interface OutputDirectoryIdentity extends FileIdentity {
  path: string;
  realPath: string;
}

interface ReservedOutput extends FileIdentity {
  path: string;
  handle: FileHandle;
}

interface OutputDirectoryPlan {
  readonly directories: ReadonlyMap<string, OutputDirectoryIdentity>;
  readonly expectedDirectories: ReadonlyMap<string, OutputDirectoryIdentity>;
  readonly unitTestDirectoryIdentityCheck?: (
    directory: OutputDirectoryIdentity,
  ) => void | Promise<void>;
}

export class OutputConflictError extends Error {
  readonly code = "OUTPUT_CONFLICT";

  constructor(path: string) {
    super(`Refusing to overwrite an existing output path: ${path}`);
    this.name = "OutputConflictError";
  }
}

export class PathAliasError extends Error {
  readonly code = "PATH_ALIAS";

  constructor(message: string) {
    super(message);
    this.name = "PathAliasError";
  }
}

export class UnsafeOutputPathError extends Error {
  readonly code = "UNSAFE_OUTPUT_PATH";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutputPathError";
  }
}

export async function writeFilesExclusively(
  files: readonly ExclusiveOutputFile[],
  options: ExclusiveOutputOptions = {},
): Promise<string[]> {
  if (files.length === 0) {
    return [];
  }

  const resolvedFiles = await Promise.all(files.map(async (file) => ({
    ...file,
    path: await authorizeFuturePath(
      resolveLocalPath(file.path, "output_path"),
    ),
  })));
  const resolvedSources = await Promise.all(
    (options.sourcePaths ?? []).map((path) =>
      authorizeExistingPath(resolveLocalPath(path, "source_path"))
    ),
  );

  assertDistinctOutputPaths(resolvedFiles.map((file) => file.path));
  assertNoLexicalSourceAliases(
    resolvedFiles.map((file) => file.path),
    resolvedSources,
  );

  const sourceIdentities = await existingSourceIdentities(resolvedSources);
  for (const file of resolvedFiles) {
    await rejectExistingTarget(file.path, sourceIdentities);
  }

  const directoryPlan = await prepareOutputDirectoryPlan(
    resolvedFiles.map((file) => file.path),
    options.expectedDirectoryIdentities ?? [],
    options.unitTestDirectoryIdentityCheck,
  );

  const reservations: ReservedOutput[] = [];
  try {
    await options.beforeOpen?.();
    for (const [index, file] of resolvedFiles.entries()) {
      const directory = outputDirectoryForPath(file.path, directoryPlan);
      await assertPlannedDirectoryIdentity(directory, directoryPlan);
      await assertFuturePathStillAuthorized(file.path);

      let handle: FileHandle;
      try {
        handle = await open(file.path, "wx");
      } catch (error: unknown) {
        if (errorCode(error, "") === "EEXIST") {
          await rejectExistingTarget(file.path, sourceIdentities);
          throw new OutputConflictError(file.path);
        }
        throw error;
      }

      try {
        const created = await handle.stat({ bigint: true });
        const reservation = {
          path: file.path,
          handle,
          device: created.dev,
          inode: created.ino,
        };
        await assertReservedOutputIdentity(reservation, directory, directoryPlan);
        reservations.push(reservation);
        await options.unitTestAfterOpen?.(file.path, index);
      } catch (error: unknown) {
        await handle.close().catch(() => undefined);
        // The identity is unknown, so deleting this path could remove a
        // concurrent replacement. Leaving an empty orphan is the safe choice.
        throw error;
      }
    }

    for (const [index, reservation] of reservations.entries()) {
      const directory = outputDirectoryForPath(reservation.path, directoryPlan);
      await assertReservedOutputIdentity(reservation, directory, directoryPlan);
      await reservation.handle.writeFile(resolvedFiles[index]!.data);
    }
    for (const reservation of reservations) {
      await reservation.handle.close();
    }

    return resolvedFiles.map((file) => file.path);
  } catch (error: unknown) {
    await Promise.all(
      reservations.map((reservation) =>
        reservation.handle.close().catch(() => undefined),
      ),
    );
    // Do not unlink by pathname after a failed write. Even an inode check
    // followed by unlink has a replacement race on Windows. A partial orphan
    // is safer than deleting a concurrent replacement owned by another actor.
    throw error;
  }
}

export async function captureExistingOutputDirectoryIdentity(
  directoryPath: string,
): Promise<OutputDirectoryIdentity | undefined> {
  const resolvedDirectory = await authorizeFuturePath(
    resolveLocalPath(directoryPath, "output_dir"),
  );
  await assertNoLinkedExistingComponents(resolvedDirectory);
  try {
    const linked = await lstat(resolvedDirectory);
    if (!linked.isDirectory() || linked.isSymbolicLink()) {
      throw new UnsafeOutputPathError(
        `Output parent is not a directory: ${resolvedDirectory}`,
      );
    }
  } catch (error: unknown) {
    if (errorCode(error, "") === "ENOENT") return undefined;
    throw error;
  }

  const [canonicalPath, directory] = await Promise.all([
    realpath(resolvedDirectory),
    stat(resolvedDirectory, { bigint: true }),
  ]);
  if (!directory.isDirectory() ||
    comparablePath(canonicalPath) !== comparablePath(resolvedDirectory)) {
    throw new UnsafeOutputPathError(
      `Output parent must not contain symlinks or junctions: ${resolvedDirectory}`,
    );
  }
  return Object.freeze({
    path: resolvedDirectory,
    realPath: canonicalPath,
    device: directory.dev,
    inode: directory.ino,
  });
}

export async function writeFileRangeExclusively(
  outputPath: string,
  input: ExclusiveInputRange,
  options: ExclusiveOutputOptions = {},
): Promise<string> {
  if (!Number.isSafeInteger(input.fd) || input.fd < 0 ||
    !Number.isSafeInteger(input.offset) || input.offset < 0 ||
    !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new Error("Exclusive input range is invalid.");
  }
  const resolvedOutput = await authorizeFuturePath(
    resolveLocalPath(outputPath, "output_path"),
  );
  const resolvedSources = await Promise.all(
    (options.sourcePaths ?? []).map((path) =>
      authorizeExistingPath(resolveLocalPath(path, "source_path"))
    ),
  );
  assertNoLexicalSourceAliases([resolvedOutput], resolvedSources);
  const sourceIdentities = await existingSourceIdentities(resolvedSources);
  await rejectExistingTarget(resolvedOutput, sourceIdentities);
  const directoryPlan = await prepareOutputDirectoryPlan(
    [resolvedOutput],
    options.expectedDirectoryIdentities ?? [],
    options.unitTestDirectoryIdentityCheck,
  );
  const directory = outputDirectoryForPath(resolvedOutput, directoryPlan);
  await assertPlannedDirectoryIdentity(directory, directoryPlan);
  await options.beforeOpen?.();
  await assertPlannedDirectoryIdentity(directory, directoryPlan);
  await assertFuturePathStillAuthorized(resolvedOutput);

  let handle: FileHandle;
  try {
    handle = await open(resolvedOutput, "wx");
  } catch (error: unknown) {
    if (errorCode(error, "") === "EEXIST") {
      await rejectExistingTarget(resolvedOutput, sourceIdentities);
      throw new OutputConflictError(resolvedOutput);
    }
    throw error;
  }
  try {
    const created = await handle.stat({ bigint: true });
    const reservation = {
      path: resolvedOutput,
      handle,
      device: created.dev,
      inode: created.ino,
    };
    await assertReservedOutputIdentity(reservation, directory, directoryPlan);
    await options.unitTestAfterOpen?.(resolvedOutput, 0);
    await copyRangeToHandle(handle, input, () =>
      assertReservedOutputIdentity(reservation, directory, directoryPlan)
    );
    await handle.close();
    return resolvedOutput;
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    // Match writeFilesExclusively: never pathname-delete a possibly replaced file.
    throw error;
  }
}

export async function writeFileRangeAndFilesExclusively(
  outputPath: string,
  input: ExclusiveInputRange,
  companionFiles: readonly ExclusiveOutputFile[],
  options: ExclusiveOutputOptions = {},
): Promise<string[]> {
  assertValidInputRange(input);
  const resolvedFiles = [
    {
      path: await authorizeFuturePath(
        resolveLocalPath(outputPath, "output_path"),
      ),
      range: input,
    },
    ...await Promise.all(companionFiles.map(async (file) => ({
      path: await authorizeFuturePath(
        resolveLocalPath(file.path, "output_path"),
      ),
      data: file.data,
    }))),
  ];
  const resolvedSources = await Promise.all(
    (options.sourcePaths ?? []).map((path) =>
      authorizeExistingPath(resolveLocalPath(path, "source_path"))
    ),
  );
  assertDistinctOutputPaths(resolvedFiles.map((file) => file.path));
  assertNoLexicalSourceAliases(
    resolvedFiles.map((file) => file.path),
    resolvedSources,
  );
  const sourceIdentities = await existingSourceIdentities(resolvedSources);
  for (const file of resolvedFiles) {
    await rejectExistingTarget(file.path, sourceIdentities);
  }

  const directoryPlan = await prepareOutputDirectoryPlan(
    resolvedFiles.map((file) => file.path),
    options.expectedDirectoryIdentities ?? [],
    options.unitTestDirectoryIdentityCheck,
  );

  const reservations: ReservedOutput[] = [];
  try {
    await options.beforeOpen?.();
    for (const [index, file] of resolvedFiles.entries()) {
      const directory = outputDirectoryForPath(file.path, directoryPlan);
      await assertPlannedDirectoryIdentity(directory, directoryPlan);
      await assertFuturePathStillAuthorized(file.path);
      let handle: FileHandle;
      try {
        handle = await open(file.path, "wx");
      } catch (error: unknown) {
        if (errorCode(error, "") === "EEXIST") {
          await rejectExistingTarget(file.path, sourceIdentities);
          throw new OutputConflictError(file.path);
        }
        throw error;
      }
      try {
        const created = await handle.stat({ bigint: true });
        const reservation = {
          path: file.path,
          handle,
          device: created.dev,
          inode: created.ino,
        };
        await assertReservedOutputIdentity(reservation, directory, directoryPlan);
        reservations.push(reservation);
        await options.unitTestAfterOpen?.(file.path, index);
      } catch (error: unknown) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }

    const rangeReservation = reservations[0]!;
    const rangeDirectory = outputDirectoryForPath(
      rangeReservation.path,
      directoryPlan,
    );
    await copyRangeToHandle(rangeReservation.handle, input, () =>
      assertReservedOutputIdentity(
        rangeReservation,
        rangeDirectory,
        directoryPlan,
      )
    );
    for (let index = 1; index < reservations.length; index += 1) {
      await assertReservedOutputIdentity(
        reservations[index]!,
        outputDirectoryForPath(reservations[index]!.path, directoryPlan),
        directoryPlan,
      );
      await reservations[index]!.handle.writeFile(
        (resolvedFiles[index] as { data: string | Uint8Array }).data,
      );
    }
    for (const reservation of reservations) await reservation.handle.close();
    return resolvedFiles.map((file) => file.path);
  } catch (error: unknown) {
    await Promise.all(
      reservations.map((reservation) =>
        reservation.handle.close().catch(() => undefined)
      ),
    );
    throw error;
  }
}

async function prepareOutputDirectoryPlan(
  outputPaths: readonly string[],
  expectedIdentities: readonly OutputDirectoryIdentity[],
  unitTestDirectoryIdentityCheck?: (
    directory: OutputDirectoryIdentity,
  ) => void | Promise<void>,
): Promise<OutputDirectoryPlan> {
  const expectedDirectories = expectedDirectoryMap(expectedIdentities);
  const outputParentKeys = new Set(
    outputPaths.map((outputPath) => comparablePath(dirname(outputPath))),
  );
  for (const [key, identity] of expectedDirectories) {
    if (!outputParentKeys.has(key)) {
      throw new OutputConflictError(identity.path);
    }
  }
  const directories = new Map<string, OutputDirectoryIdentity>();
  for (const outputPath of outputPaths) {
    const parentPath = dirname(outputPath);
    const key = comparablePath(parentPath);
    if (directories.has(key)) continue;
    const expected = expectedDirectories.get(key);
    if (expected === undefined) {
      directories.set(key, await prepareCanonicalDirectory(parentPath));
    } else {
      await assertExpectedDirectoryIdentity(expected);
      directories.set(key, expected);
    }
  }
  return {
    directories,
    expectedDirectories,
    ...(unitTestDirectoryIdentityCheck === undefined
      ? {}
      : { unitTestDirectoryIdentityCheck }),
  };
}

function outputDirectoryForPath(
  outputPath: string,
  plan: OutputDirectoryPlan,
): OutputDirectoryIdentity {
  const directory = plan.directories.get(comparablePath(dirname(outputPath)));
  if (directory === undefined) {
    throw new Error("Output directory reservation is missing.");
  }
  return directory;
}

async function assertPlannedDirectoryIdentity(
  directory: OutputDirectoryIdentity,
  plan: OutputDirectoryPlan,
): Promise<void> {
  if (plan.expectedDirectories.has(comparablePath(directory.path))) {
    await assertExpectedDirectoryIdentity(directory);
  } else {
    await assertDirectoryIdentity(directory);
  }
  await plan.unitTestDirectoryIdentityCheck?.(directory);
}

async function assertReservedOutputIdentity(
  reservation: ReservedOutput,
  directory: OutputDirectoryIdentity,
  plan: OutputDirectoryPlan,
): Promise<void> {
  await assertPlannedDirectoryIdentity(directory, plan);
  await assertOpenedPathIdentity(
    reservation.path,
    reservation.device,
    reservation.inode,
  );
}

function assertValidInputRange(input: ExclusiveInputRange): void {
  if (!Number.isSafeInteger(input.fd) || input.fd < 0 ||
    !Number.isSafeInteger(input.offset) || input.offset < 0 ||
    !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new Error("Exclusive input range is invalid.");
  }
}

async function assertFuturePathStillAuthorized(path: string): Promise<void> {
  const authorized = await authorizeFuturePath(path);
  if (comparablePath(authorized) !== comparablePath(path)) {
    throw new AllowedRootsPathError();
  }
}

async function assertOpenedPathIdentity(
  path: string,
  device: bigint,
  inode: bigint,
): Promise<void> {
  const status = await lstat(path, { bigint: true });
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.dev !== device ||
    status.ino !== inode
  ) {
    throw new UnsafeOutputPathError(
      "Output path changed while it was being created.",
    );
  }
}

async function copyRangeToHandle(
  handle: FileHandle,
  input: ExclusiveInputRange,
  beforeWrite?: () => void | Promise<void>,
): Promise<void> {
  const buffer = Buffer.allocUnsafeSlow(1024 * 1024);
  let copied = 0;
  while (copied < input.sizeBytes) {
    const requested = Math.min(buffer.byteLength, input.sizeBytes - copied);
    const count = await readPositionally(
      input.fd,
      buffer,
      requested,
      input.offset + copied,
    );
    if (count === 0) throw new Error("Exclusive input range is truncated.");
    await beforeWrite?.();
    await writeChunkFully(handle, buffer, count, copied);
    copied += count;
  }
}

async function writeChunkFully(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await handle.write(
      buffer,
      written,
      length - written,
      position + written,
    );
    if (result.bytesWritten === 0) {
      throw new Error("Exclusive output write made no progress.");
    }
    written += result.bytesWritten;
  }
}

function readPositionally(
  fd: number,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    readFd(fd, buffer, 0, length, position, (error, bytesRead) => {
      if (error === null) resolvePromise(bytesRead);
      else rejectPromise(error);
    });
  });
}

function assertDistinctOutputPaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = comparablePath(path);
    if (seen.has(key)) {
      throw new PathAliasError("Output paths must be different from each other.");
    }
    seen.add(key);
  }
}

function assertNoLexicalSourceAliases(
  outputPaths: readonly string[],
  sourcePaths: readonly string[],
): void {
  const sources = new Set(sourcePaths.map(comparablePath));
  for (const outputPath of outputPaths) {
    if (sources.has(comparablePath(outputPath))) {
      throw new PathAliasError("A source path and output path must be different.");
    }
  }
}

async function existingSourceIdentities(
  sourcePaths: readonly string[],
): Promise<SourceIdentity[]> {
  const identities: SourceIdentity[] = [];
  for (const path of sourcePaths) {
    try {
      const source = await stat(path, { bigint: true });
      identities.push({ path, device: source.dev, inode: source.ino });
    } catch (error: unknown) {
      if (errorCode(error, "") !== "ENOENT") {
        throw error;
      }
    }
  }
  return identities;
}

async function rejectExistingTarget(
  outputPath: string,
  sources: readonly SourceIdentity[],
): Promise<void> {
  try {
    await lstat(outputPath);
  } catch (error: unknown) {
    if (errorCode(error, "") === "ENOENT") {
      return;
    }
    throw error;
  }

  try {
    const target = await stat(outputPath, { bigint: true });
    const alias = sources.find(
      (source) =>
        source.device === target.dev && source.inode === target.ino,
    );
    if (alias !== undefined) {
      throw new PathAliasError(
        `Output path aliases the source file: ${alias.path}`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof PathAliasError) {
      throw error;
    }
    if (errorCode(error, "") !== "ENOENT") {
      throw error;
    }
  }

  throw new OutputConflictError(outputPath);
}

async function prepareCanonicalDirectory(
  directoryPath: string,
): Promise<OutputDirectoryIdentity> {
  await assertNoLinkedExistingComponents(directoryPath);
  await mkdir(directoryPath, { recursive: true });
  await assertNoLinkedExistingComponents(directoryPath);

  const [canonicalPath, directory] = await Promise.all([
    realpath(directoryPath),
    stat(directoryPath, { bigint: true }),
  ]);
  if (!directory.isDirectory()) {
    throw new UnsafeOutputPathError(
      `Output parent is not a directory: ${directoryPath}`,
    );
  }
  if (comparablePath(canonicalPath) !== comparablePath(directoryPath)) {
    throw new UnsafeOutputPathError(
      `Output parent must not contain symlinks or junctions: ${directoryPath}`,
    );
  }

  return {
    path: directoryPath,
    realPath: canonicalPath,
    device: directory.dev,
    inode: directory.ino,
  };
}

async function assertDirectoryIdentity(
  expected: OutputDirectoryIdentity,
): Promise<void> {
  await assertNoLinkedExistingComponents(expected.path);
  const [canonicalPath, directory] = await Promise.all([
    realpath(expected.path),
    stat(expected.path, { bigint: true }),
  ]);

  if (
    !directory.isDirectory() ||
    comparablePath(canonicalPath) !== comparablePath(expected.realPath) ||
    comparablePath(canonicalPath) !== comparablePath(expected.path) ||
    directory.dev !== expected.device ||
    directory.ino !== expected.inode
  ) {
    throw new UnsafeOutputPathError(
      `Output parent changed before file creation: ${expected.path}`,
    );
  }
}

async function assertExpectedDirectoryIdentity(
  expected: OutputDirectoryIdentity,
): Promise<void> {
  try {
    await assertDirectoryIdentity(expected);
  } catch {
    throw new OutputConflictError(expected.path);
  }
}

function expectedDirectoryMap(
  identities: readonly OutputDirectoryIdentity[],
): Map<string, OutputDirectoryIdentity> {
  const result = new Map<string, OutputDirectoryIdentity>();
  for (const identity of identities) {
    const key = comparablePath(identity.path);
    if (result.has(key)) {
      throw new Error("Expected output directory identities must be unique.");
    }
    result.set(key, identity);
  }
  return result;
}

async function assertNoLinkedExistingComponents(path: string): Promise<void> {
  for (const component of absolutePathComponents(path)) {
    try {
      const componentStats = await lstat(component);
      if (componentStats.isSymbolicLink()) {
        throw new UnsafeOutputPathError(
          `Output path component is a symlink or junction: ${component}`,
        );
      }
    } catch (error: unknown) {
      if (errorCode(error, "") === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function absolutePathComponents(path: string): string[] {
  const root = parsePath(path).root;
  const components = [root];
  let current = root;
  for (const segment of path.slice(root.length).split(/[\\/]+/u)) {
    if (segment.length === 0) {
      continue;
    }
    current = join(current, segment);
    components.push(current);
  }
  return components;
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function errorCode(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    return error.code;
  }
  return fallback;
}
