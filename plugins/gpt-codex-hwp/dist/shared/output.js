import { lstat, mkdir, open, realpath, stat, } from "node:fs/promises";
import { read as readFd } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { resolveLocalPath } from "./paths.js";
import { AllowedRootsPathError, authorizeExistingPath, authorizeFuturePath, } from "./allowed-roots.js";
export class OutputConflictError extends Error {
    code = "OUTPUT_CONFLICT";
    constructor(path) {
        super(`Refusing to overwrite an existing output path: ${path}`);
        this.name = "OutputConflictError";
    }
}
/**
 * A write failed after outputs were reserved. Reserved files are never removed
 * by pathname (that races with a concurrent replacement), so the message
 * reports only what this process knows about each reserved file.
 */
export class OutputPlaceholderLeftError extends Error {
    code;
    release;
    constructor(cause, release) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const parts = [
            release.emptied > 0 ? `${release.emptied} emptied` : undefined,
            release.neverWritten > 0 ? `${release.neverWritten} never written` : undefined,
            release.complete > 0 ? `${release.complete} complete` : undefined,
            release.possiblyPartial > 0 ? `${release.possiblyPartial} possibly partial` : undefined,
        ].filter((part) => part !== undefined);
        super(`${reason} The output was not completed. Files may remain at the output paths (${parts.join(", ")}); check and remove them before retrying.`, { cause });
        this.name = "OutputPlaceholderLeftError";
        this.code = errorCode(cause, "OUTPUT_WRITE_FAILED");
        this.release = Object.freeze({ ...release });
    }
}
async function releaseFailedReservations(reservations, progress) {
    let emptied = 0;
    let possiblyPartial = 0;
    let complete = 0;
    let neverWritten = 0;
    await Promise.all(reservations.map(async (reservation, index) => {
        const state = progress[index];
        // A handle is closed only after every write finished, so a closed file is
        // complete; it cannot be emptied any more through its handle.
        if (state.closed) {
            complete += 1;
            return;
        }
        if (state.started) {
            try {
                await reservation.handle.truncate(0);
                emptied += 1;
            }
            catch {
                possiblyPartial += 1;
            }
        }
        else {
            neverWritten += 1;
        }
        await reservation.handle.close().catch(() => undefined);
    }));
    return { emptied, possiblyPartial, complete, neverWritten };
}
async function rethrowAfterFailedWrite(error, reservations, progress) {
    const release = await releaseFailedReservations(reservations, progress);
    // Failures before any write keep their original error, as before.
    if (release.emptied + release.possiblyPartial + release.complete === 0)
        throw error;
    throw new OutputPlaceholderLeftError(error, release);
}
export class PathAliasError extends Error {
    code = "PATH_ALIAS";
    constructor(message) {
        super(message);
        this.name = "PathAliasError";
    }
}
export class UnsafeOutputPathError extends Error {
    code = "UNSAFE_OUTPUT_PATH";
    constructor(message) {
        super(message);
        this.name = "UnsafeOutputPathError";
    }
}
export async function writeFilesExclusively(files, options = {}) {
    if (files.length === 0) {
        return [];
    }
    const resolvedFiles = await Promise.all(files.map(async (file) => ({
        ...file,
        path: await authorizeFuturePath(resolveLocalPath(file.path, "output_path")),
    })));
    const resolvedSources = await Promise.all((options.sourcePaths ?? []).map((path) => authorizeExistingPath(resolveLocalPath(path, "source_path"))));
    assertDistinctOutputPaths(resolvedFiles.map((file) => file.path));
    assertNoLexicalSourceAliases(resolvedFiles.map((file) => file.path), resolvedSources);
    const sourceIdentities = await existingSourceIdentities(resolvedSources);
    for (const file of resolvedFiles) {
        await rejectExistingTarget(file.path, sourceIdentities);
    }
    const directoryPlan = await prepareOutputDirectoryPlan(resolvedFiles.map((file) => file.path), options.expectedDirectoryIdentities ?? [], options.unitTestDirectoryIdentityCheck);
    const reservations = [];
    const progress = [];
    try {
        await options.beforeOpen?.();
        for (const [index, file] of resolvedFiles.entries()) {
            const directory = outputDirectoryForPath(file.path, directoryPlan);
            await assertPlannedDirectoryIdentity(directory, directoryPlan);
            await assertFuturePathStillAuthorized(file.path);
            let handle;
            try {
                handle = await openExclusiveOutput(file);
            }
            catch (error) {
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
                progress.push({ started: false, closed: false });
                await options.unitTestAfterOpen?.(file.path, index);
            }
            catch (error) {
                await handle.close().catch(() => undefined);
                // The identity is unknown, so deleting this path could remove a
                // concurrent replacement. Leaving an empty orphan is the safe choice.
                throw error;
            }
        }
        for (const [index, reservation] of reservations.entries()) {
            const directory = outputDirectoryForPath(reservation.path, directoryPlan);
            await assertReservedOutputIdentity(reservation, directory, directoryPlan);
            await options.unitTestBeforeWrite?.(reservation.path, index);
            progress[index].started = true;
            await reservation.handle.writeFile(resolvedFiles[index].data);
        }
        for (const [index, reservation] of reservations.entries()) {
            await reservation.handle.close();
            progress[index].closed = true;
        }
        return resolvedFiles.map((file) => file.path);
    }
    catch (error) {
        // Do not unlink by pathname after a failed write. Even an inode check
        // followed by unlink has a replacement race on Windows. Instead, empty the
        // started files through the handles we own so no truncated document
        // survives, and report what remains.
        return rethrowAfterFailedWrite(error, reservations, progress);
    }
}
export async function preflightExclusiveOutput(outputPath, options = {}) {
    const path = await authorizeFuturePath(resolveLocalPath(outputPath, "output_path"));
    const sourcePaths = await Promise.all((options.sourcePaths ?? []).map((sourcePath) => authorizeExistingPath(resolveLocalPath(sourcePath, "source_path"))));
    assertNoLexicalSourceAliases([path], sourcePaths);
    await rejectExistingTarget(path, await existingSourceIdentities(sourcePaths));
    const directory = await captureExistingOutputDirectoryIdentity(dirname(path));
    if (directory === undefined) {
        throw new UnsafeOutputPathError(`Output parent does not exist: ${dirname(path)}`);
    }
    await prepareOutputDirectoryPlan([path], [directory]);
    return Object.freeze({
        path,
        expectedDirectoryIdentities: Object.freeze([directory]),
    });
}
export async function captureExistingOutputDirectoryIdentity(directoryPath) {
    const resolvedDirectory = await authorizeFuturePath(resolveLocalPath(directoryPath, "output_dir"));
    await assertNoLinkedExistingComponents(resolvedDirectory);
    try {
        const linked = await lstat(resolvedDirectory);
        if (!linked.isDirectory() || linked.isSymbolicLink()) {
            throw new UnsafeOutputPathError(`Output parent is not a directory: ${resolvedDirectory}`);
        }
    }
    catch (error) {
        if (errorCode(error, "") === "ENOENT")
            return undefined;
        throw error;
    }
    const [canonicalPath, directory] = await Promise.all([
        realpath(resolvedDirectory),
        stat(resolvedDirectory, { bigint: true }),
    ]);
    if (!directory.isDirectory() ||
        comparablePath(canonicalPath) !== comparablePath(resolvedDirectory)) {
        throw new UnsafeOutputPathError(`Output parent must not contain symlinks or junctions: ${resolvedDirectory}`);
    }
    return Object.freeze({
        path: resolvedDirectory,
        realPath: canonicalPath,
        device: directory.dev,
        inode: directory.ino,
    });
}
export async function writeFileRangeExclusively(outputPath, input, options = {}) {
    if (!Number.isSafeInteger(input.fd) || input.fd < 0 ||
        !Number.isSafeInteger(input.offset) || input.offset < 0 ||
        !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
        throw new Error("Exclusive input range is invalid.");
    }
    const resolvedOutput = await authorizeFuturePath(resolveLocalPath(outputPath, "output_path"));
    const resolvedSources = await Promise.all((options.sourcePaths ?? []).map((path) => authorizeExistingPath(resolveLocalPath(path, "source_path"))));
    assertNoLexicalSourceAliases([resolvedOutput], resolvedSources);
    const sourceIdentities = await existingSourceIdentities(resolvedSources);
    await rejectExistingTarget(resolvedOutput, sourceIdentities);
    const directoryPlan = await prepareOutputDirectoryPlan([resolvedOutput], options.expectedDirectoryIdentities ?? [], options.unitTestDirectoryIdentityCheck);
    const directory = outputDirectoryForPath(resolvedOutput, directoryPlan);
    await assertPlannedDirectoryIdentity(directory, directoryPlan);
    await options.beforeOpen?.();
    await assertPlannedDirectoryIdentity(directory, directoryPlan);
    await assertFuturePathStillAuthorized(resolvedOutput);
    const reservations = [];
    const progress = [];
    let handle;
    try {
        handle = await open(resolvedOutput, "wx");
    }
    catch (error) {
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
        reservations.push(reservation);
        progress.push({ started: false, closed: false });
        await assertReservedOutputIdentity(reservation, directory, directoryPlan);
        await options.unitTestAfterOpen?.(resolvedOutput, 0);
        progress[0].started = true;
        await copyRangeToHandle(handle, input, () => assertReservedOutputIdentity(reservation, directory, directoryPlan));
        await handle.close();
        progress[0].closed = true;
        return resolvedOutput;
    }
    catch (error) {
        if (reservations.length === 0) {
            await handle.close().catch(() => undefined);
            throw error;
        }
        // Match writeFilesExclusively: never pathname-delete a possibly replaced file.
        return rethrowAfterFailedWrite(error, reservations, progress);
    }
}
export async function writeFileRangeAndFilesExclusively(outputPath, input, companionFiles, options = {}) {
    assertValidInputRange(input);
    const resolvedFiles = [
        {
            path: await authorizeFuturePath(resolveLocalPath(outputPath, "output_path")),
            range: input,
        },
        ...await Promise.all(companionFiles.map(async (file) => ({
            path: await authorizeFuturePath(resolveLocalPath(file.path, "output_path")),
            data: file.data,
        }))),
    ];
    const resolvedSources = await Promise.all((options.sourcePaths ?? []).map((path) => authorizeExistingPath(resolveLocalPath(path, "source_path"))));
    assertDistinctOutputPaths(resolvedFiles.map((file) => file.path));
    assertNoLexicalSourceAliases(resolvedFiles.map((file) => file.path), resolvedSources);
    const sourceIdentities = await existingSourceIdentities(resolvedSources);
    for (const file of resolvedFiles) {
        await rejectExistingTarget(file.path, sourceIdentities);
    }
    const directoryPlan = await prepareOutputDirectoryPlan(resolvedFiles.map((file) => file.path), options.expectedDirectoryIdentities ?? [], options.unitTestDirectoryIdentityCheck);
    const reservations = [];
    const progress = [];
    try {
        await options.beforeOpen?.();
        for (const [index, file] of resolvedFiles.entries()) {
            const directory = outputDirectoryForPath(file.path, directoryPlan);
            await assertPlannedDirectoryIdentity(directory, directoryPlan);
            await assertFuturePathStillAuthorized(file.path);
            let handle;
            try {
                handle = await openExclusiveOutput(file);
            }
            catch (error) {
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
                progress.push({ started: false, closed: false });
                await options.unitTestAfterOpen?.(file.path, index);
            }
            catch (error) {
                await handle.close().catch(() => undefined);
                throw error;
            }
        }
        const rangeReservation = reservations[0];
        const rangeDirectory = outputDirectoryForPath(rangeReservation.path, directoryPlan);
        progress[0].started = true;
        await copyRangeToHandle(rangeReservation.handle, input, () => assertReservedOutputIdentity(rangeReservation, rangeDirectory, directoryPlan));
        for (let index = 1; index < reservations.length; index += 1) {
            await assertReservedOutputIdentity(reservations[index], outputDirectoryForPath(reservations[index].path, directoryPlan), directoryPlan);
            progress[index].started = true;
            await reservations[index].handle.writeFile(resolvedFiles[index].data);
        }
        for (const [index, reservation] of reservations.entries()) {
            await reservation.handle.close();
            progress[index].closed = true;
        }
        return resolvedFiles.map((file) => file.path);
    }
    catch (error) {
        return rethrowAfterFailedWrite(error, reservations, progress);
    }
}
async function prepareOutputDirectoryPlan(outputPaths, expectedIdentities, unitTestDirectoryIdentityCheck) {
    const expectedDirectories = expectedDirectoryMap(expectedIdentities);
    const outputParentKeys = new Set(outputPaths.map((outputPath) => comparablePath(dirname(outputPath))));
    for (const [key, identity] of expectedDirectories) {
        if (!outputParentKeys.has(key)) {
            throw new OutputConflictError(identity.path);
        }
    }
    const directories = new Map();
    for (const outputPath of outputPaths) {
        const parentPath = dirname(outputPath);
        const key = comparablePath(parentPath);
        if (directories.has(key))
            continue;
        const expected = expectedDirectories.get(key);
        if (expected === undefined) {
            directories.set(key, await prepareCanonicalDirectory(parentPath));
        }
        else {
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
function openExclusiveOutput(file) {
    return file.mode === undefined
        ? open(file.path, "wx")
        : open(file.path, "wx", file.mode);
}
function outputDirectoryForPath(outputPath, plan) {
    const directory = plan.directories.get(comparablePath(dirname(outputPath)));
    if (directory === undefined) {
        throw new Error("Output directory reservation is missing.");
    }
    return directory;
}
async function assertPlannedDirectoryIdentity(directory, plan) {
    if (plan.expectedDirectories.has(comparablePath(directory.path))) {
        await assertExpectedDirectoryIdentity(directory);
    }
    else {
        await assertDirectoryIdentity(directory);
    }
    await plan.unitTestDirectoryIdentityCheck?.(directory);
}
async function assertReservedOutputIdentity(reservation, directory, plan) {
    await assertPlannedDirectoryIdentity(directory, plan);
    await assertOpenedPathIdentity(reservation.path, reservation.device, reservation.inode);
}
function assertValidInputRange(input) {
    if (!Number.isSafeInteger(input.fd) || input.fd < 0 ||
        !Number.isSafeInteger(input.offset) || input.offset < 0 ||
        !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
        throw new Error("Exclusive input range is invalid.");
    }
}
async function assertFuturePathStillAuthorized(path) {
    const authorized = await authorizeFuturePath(path);
    if (comparablePath(authorized) !== comparablePath(path)) {
        throw new AllowedRootsPathError();
    }
}
async function assertOpenedPathIdentity(path, device, inode) {
    const status = await lstat(path, { bigint: true });
    if (!status.isFile() ||
        status.isSymbolicLink() ||
        status.dev !== device ||
        status.ino !== inode) {
        throw new UnsafeOutputPathError("Output path changed while it was being created.");
    }
}
async function copyRangeToHandle(handle, input, beforeWrite) {
    const buffer = Buffer.allocUnsafeSlow(1024 * 1024);
    let copied = 0;
    while (copied < input.sizeBytes) {
        const requested = Math.min(buffer.byteLength, input.sizeBytes - copied);
        const count = await readPositionally(input.fd, buffer, requested, input.offset + copied);
        if (count === 0)
            throw new Error("Exclusive input range is truncated.");
        await beforeWrite?.();
        await writeChunkFully(handle, buffer, count, copied);
        copied += count;
    }
}
async function writeChunkFully(handle, buffer, length, position) {
    let written = 0;
    while (written < length) {
        const result = await handle.write(buffer, written, length - written, position + written);
        if (result.bytesWritten === 0) {
            throw new Error("Exclusive output write made no progress.");
        }
        written += result.bytesWritten;
    }
}
function readPositionally(fd, buffer, length, position) {
    return new Promise((resolvePromise, rejectPromise) => {
        readFd(fd, buffer, 0, length, position, (error, bytesRead) => {
            if (error === null)
                resolvePromise(bytesRead);
            else
                rejectPromise(error);
        });
    });
}
function assertDistinctOutputPaths(paths) {
    const seen = new Set();
    for (const path of paths) {
        const key = comparablePath(path);
        if (seen.has(key)) {
            throw new PathAliasError("Output paths must be different from each other.");
        }
        seen.add(key);
    }
}
function assertNoLexicalSourceAliases(outputPaths, sourcePaths) {
    const sources = new Set(sourcePaths.map(comparablePath));
    for (const outputPath of outputPaths) {
        if (sources.has(comparablePath(outputPath))) {
            throw new PathAliasError("A source path and output path must be different.");
        }
    }
}
async function existingSourceIdentities(sourcePaths) {
    const identities = [];
    for (const path of sourcePaths) {
        try {
            const source = await stat(path, { bigint: true });
            identities.push({ path, device: source.dev, inode: source.ino });
        }
        catch (error) {
            if (errorCode(error, "") !== "ENOENT") {
                throw error;
            }
        }
    }
    return identities;
}
async function rejectExistingTarget(outputPath, sources) {
    try {
        await lstat(outputPath);
    }
    catch (error) {
        if (errorCode(error, "") === "ENOENT") {
            return;
        }
        throw error;
    }
    try {
        const target = await stat(outputPath, { bigint: true });
        const alias = sources.find((source) => source.device === target.dev && source.inode === target.ino);
        if (alias !== undefined) {
            throw new PathAliasError(`Output path aliases the source file: ${alias.path}`);
        }
    }
    catch (error) {
        if (error instanceof PathAliasError) {
            throw error;
        }
        if (errorCode(error, "") !== "ENOENT") {
            throw error;
        }
    }
    throw new OutputConflictError(outputPath);
}
async function prepareCanonicalDirectory(directoryPath) {
    await assertNoLinkedExistingComponents(directoryPath);
    await mkdir(directoryPath, { recursive: true });
    await assertNoLinkedExistingComponents(directoryPath);
    const [canonicalPath, directory] = await Promise.all([
        realpath(directoryPath),
        stat(directoryPath, { bigint: true }),
    ]);
    if (!directory.isDirectory()) {
        throw new UnsafeOutputPathError(`Output parent is not a directory: ${directoryPath}`);
    }
    if (comparablePath(canonicalPath) !== comparablePath(directoryPath)) {
        throw new UnsafeOutputPathError(`Output parent must not contain symlinks or junctions: ${directoryPath}`);
    }
    return {
        path: directoryPath,
        realPath: canonicalPath,
        device: directory.dev,
        inode: directory.ino,
    };
}
async function assertDirectoryIdentity(expected) {
    await assertNoLinkedExistingComponents(expected.path);
    const [canonicalPath, directory] = await Promise.all([
        realpath(expected.path),
        stat(expected.path, { bigint: true }),
    ]);
    if (!directory.isDirectory() ||
        comparablePath(canonicalPath) !== comparablePath(expected.realPath) ||
        comparablePath(canonicalPath) !== comparablePath(expected.path) ||
        directory.dev !== expected.device ||
        directory.ino !== expected.inode) {
        throw new UnsafeOutputPathError(`Output parent changed before file creation: ${expected.path}`);
    }
}
async function assertExpectedDirectoryIdentity(expected) {
    try {
        await assertDirectoryIdentity(expected);
    }
    catch {
        throw new OutputConflictError(expected.path);
    }
}
function expectedDirectoryMap(identities) {
    const result = new Map();
    for (const identity of identities) {
        const key = comparablePath(identity.path);
        if (result.has(key)) {
            throw new Error("Expected output directory identities must be unique.");
        }
        result.set(key, identity);
    }
    return result;
}
async function assertNoLinkedExistingComponents(path) {
    for (const component of absolutePathComponents(path)) {
        try {
            const componentStats = await lstat(component);
            if (componentStats.isSymbolicLink()) {
                throw new UnsafeOutputPathError(`Output path component is a symlink or junction: ${component}`);
            }
        }
        catch (error) {
            if (errorCode(error, "") === "ENOENT") {
                return;
            }
            throw error;
        }
    }
}
function absolutePathComponents(path) {
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
function comparablePath(path) {
    return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}
function errorCode(error, fallback) {
    if (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.length > 0) {
        return error.code;
    }
    return fallback;
}
