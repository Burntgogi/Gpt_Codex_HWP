import { lstat, mkdir, open, realpath, stat, } from "node:fs/promises";
import { read as readFd } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { resolveLocalPath } from "./paths.js";
export class OutputConflictError extends Error {
    code = "OUTPUT_CONFLICT";
    constructor(path) {
        super(`Refusing to overwrite an existing output path: ${path}`);
        this.name = "OutputConflictError";
    }
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
    const resolvedFiles = files.map((file) => ({
        ...file,
        path: resolveLocalPath(file.path, "output_path"),
    }));
    const resolvedSources = (options.sourcePaths ?? []).map((path) => resolveLocalPath(path, "source_path"));
    assertDistinctOutputPaths(resolvedFiles.map((file) => file.path));
    assertNoLexicalSourceAliases(resolvedFiles.map((file) => file.path), resolvedSources);
    const sourceIdentities = await existingSourceIdentities(resolvedSources);
    for (const file of resolvedFiles) {
        await rejectExistingTarget(file.path, sourceIdentities);
    }
    const directories = new Map();
    for (const file of resolvedFiles) {
        const parentPath = dirname(file.path);
        const key = comparablePath(parentPath);
        if (!directories.has(key)) {
            directories.set(key, await prepareCanonicalDirectory(parentPath));
        }
    }
    const reservations = [];
    try {
        await options.beforeOpen?.();
        for (const file of resolvedFiles) {
            const directory = directories.get(comparablePath(dirname(file.path)));
            if (directory === undefined) {
                throw new Error("Output directory reservation is missing.");
            }
            await assertDirectoryIdentity(directory);
            let handle;
            try {
                handle = await open(file.path, "wx");
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
                reservations.push({
                    path: file.path,
                    handle,
                    device: created.dev,
                    inode: created.ino,
                });
            }
            catch (error) {
                await handle.close().catch(() => undefined);
                // The identity is unknown, so deleting this path could remove a
                // concurrent replacement. Leaving an empty orphan is the safe choice.
                throw error;
            }
        }
        for (const [index, reservation] of reservations.entries()) {
            await reservation.handle.writeFile(resolvedFiles[index].data);
        }
        for (const reservation of reservations) {
            await reservation.handle.close();
        }
        return resolvedFiles.map((file) => file.path);
    }
    catch (error) {
        await Promise.all(reservations.map((reservation) => reservation.handle.close().catch(() => undefined)));
        // Do not unlink by pathname after a failed write. Even an inode check
        // followed by unlink has a replacement race on Windows. A partial orphan
        // is safer than deleting a concurrent replacement owned by another actor.
        throw error;
    }
}
export async function writeFileRangeExclusively(outputPath, input, options = {}) {
    if (!Number.isSafeInteger(input.fd) || input.fd < 0 ||
        !Number.isSafeInteger(input.offset) || input.offset < 0 ||
        !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
        throw new Error("Exclusive input range is invalid.");
    }
    const resolvedOutput = resolveLocalPath(outputPath, "output_path");
    const resolvedSources = (options.sourcePaths ?? []).map((path) => resolveLocalPath(path, "source_path"));
    assertNoLexicalSourceAliases([resolvedOutput], resolvedSources);
    const sourceIdentities = await existingSourceIdentities(resolvedSources);
    await rejectExistingTarget(resolvedOutput, sourceIdentities);
    const directory = await prepareCanonicalDirectory(dirname(resolvedOutput));
    await assertDirectoryIdentity(directory);
    await options.beforeOpen?.();
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
        const buffer = Buffer.allocUnsafeSlow(1024 * 1024);
        let copied = 0;
        while (copied < input.sizeBytes) {
            const requested = Math.min(buffer.byteLength, input.sizeBytes - copied);
            const count = await readPositionally(input.fd, buffer, requested, input.offset + copied);
            if (count === 0)
                throw new Error("Exclusive input range is truncated.");
            await writeChunkFully(handle, buffer, count, copied);
            copied += count;
        }
        await handle.close();
        return resolvedOutput;
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        // Match writeFilesExclusively: never pathname-delete a possibly replaced file.
        throw error;
    }
}
export async function writeFileRangeAndFilesExclusively(outputPath, input, companionFiles, options = {}) {
    assertValidInputRange(input);
    const resolvedFiles = [
        { path: resolveLocalPath(outputPath, "output_path"), range: input },
        ...companionFiles.map((file) => ({
            path: resolveLocalPath(file.path, "output_path"),
            data: file.data,
        })),
    ];
    const resolvedSources = (options.sourcePaths ?? []).map((path) => resolveLocalPath(path, "source_path"));
    assertDistinctOutputPaths(resolvedFiles.map((file) => file.path));
    assertNoLexicalSourceAliases(resolvedFiles.map((file) => file.path), resolvedSources);
    const sourceIdentities = await existingSourceIdentities(resolvedSources);
    for (const file of resolvedFiles) {
        await rejectExistingTarget(file.path, sourceIdentities);
    }
    const directories = new Map();
    for (const file of resolvedFiles) {
        const parentPath = dirname(file.path);
        const key = comparablePath(parentPath);
        if (!directories.has(key)) {
            directories.set(key, await prepareCanonicalDirectory(parentPath));
        }
    }
    const reservations = [];
    try {
        await options.beforeOpen?.();
        for (const file of resolvedFiles) {
            const directory = directories.get(comparablePath(dirname(file.path)));
            if (directory === undefined) {
                throw new Error("Output directory reservation is missing.");
            }
            await assertDirectoryIdentity(directory);
            let handle;
            try {
                handle = await open(file.path, "wx");
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
                reservations.push({
                    path: file.path,
                    handle,
                    device: created.dev,
                    inode: created.ino,
                });
            }
            catch (error) {
                await handle.close().catch(() => undefined);
                throw error;
            }
        }
        await copyRangeToHandle(reservations[0].handle, input);
        for (let index = 1; index < reservations.length; index += 1) {
            await reservations[index].handle.writeFile(resolvedFiles[index].data);
        }
        for (const reservation of reservations)
            await reservation.handle.close();
        return resolvedFiles.map((file) => file.path);
    }
    catch (error) {
        await Promise.all(reservations.map((reservation) => reservation.handle.close().catch(() => undefined)));
        throw error;
    }
}
function assertValidInputRange(input) {
    if (!Number.isSafeInteger(input.fd) || input.fd < 0 ||
        !Number.isSafeInteger(input.offset) || input.offset < 0 ||
        !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
        throw new Error("Exclusive input range is invalid.");
    }
}
async function copyRangeToHandle(handle, input) {
    const buffer = Buffer.allocUnsafeSlow(1024 * 1024);
    let copied = 0;
    while (copied < input.sizeBytes) {
        const requested = Math.min(buffer.byteLength, input.sizeBytes - copied);
        const count = await readPositionally(input.fd, buffer, requested, input.offset + copied);
        if (count === 0)
            throw new Error("Exclusive input range is truncated.");
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
