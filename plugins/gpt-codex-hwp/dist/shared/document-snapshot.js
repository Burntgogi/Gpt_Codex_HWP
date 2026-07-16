import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readdir, rename, rmdir, stat, unlink, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { FileLimitError, MAX_DOCUMENT_BYTES, openFileForBoundedRead, } from "./files.js";
import { toOwnedExactBytes } from "./owned-bytes.js";
export const WORKER_INPUT_MAX_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const PREFLIGHT_BYTES = 8;
const SPOOL_PREFIX = "gpt-codex-hwp-snapshot-";
const SPOOL_FILENAME = "input.bin";
const QUARANTINE_PREFIX = "gpt-codex-hwp-quarantine-";
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const execFileAsync = promisify(execFile);
const OLE2_MAGIC = Uint8Array.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
export class DocumentSnapshotError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "DocumentSnapshotError";
    }
}
export async function openDocumentSnapshot(path, options = {}) {
    const normalized = validateOptions(options);
    if (typeof path !== "string" || path.trim().length === 0) {
        throw openFailedError();
    }
    let pendingSpool;
    try {
        const handle = await openFileForBoundedRead(path);
        let preparation;
        let sizeBytes;
        let initialIdentity;
        try {
            const initialHandleStatus = await handle.stat({ bigint: true });
            if (!initialHandleStatus.isFile()) {
                throw openFailedError();
            }
            if (initialHandleStatus.size > BigInt(normalized.maximumBytes)) {
                throw new FileLimitError(`Source file exceeds the ${normalized.maximumBytes}-byte safety limit.`);
            }
            sizeBytes = Number(initialHandleStatus.size);
            initialIdentity = sourceIdentityOf(initialHandleStatus);
            assertSameSourceIdentity(initialIdentity, await pathSourceIdentity(path));
            if (sizeBytes <= normalized.workerInputMaxBytes) {
                preparation = await prepareWorkerSnapshot(handle, sizeBytes, normalized);
            }
            else {
                preparation = await prepareSpoolSnapshot(handle, sizeBytes, normalized);
                pendingSpool = preparation.owner;
            }
            await normalized.testHooks?.afterSourceRead?.();
            assertSameSourceIdentity(initialIdentity, sourceIdentityOf(await handle.stat({ bigint: true })));
            assertSameSourceIdentity(initialIdentity, await pathSourceIdentity(path));
        }
        finally {
            try {
                await handle.close();
            }
            catch {
                throw openFailedError();
            }
        }
        const metadata = createMetadata(sizeBytes, preparation.sha256, preparation.preflight);
        const verifySourceUnchanged = createSourceVerifier(path, initialIdentity, preparation.sha256, sizeBytes, normalized.allocationObserver);
        if (preparation.kind === "worker") {
            const owned = toOwnedExactBytes(preparation.bytes);
            return createWorkerSnapshot(metadata, owned.transferable, verifySourceUnchanged);
        }
        const snapshot = createSpoolSnapshot(metadata, preparation.owner, normalized.testHooks, verifySourceUnchanged);
        pendingSpool = undefined;
        return snapshot;
    }
    catch (error) {
        if (pendingSpool !== undefined) {
            try {
                await cleanupPrivateSpool(pendingSpool);
            }
            catch {
                throw cleanupFailedError();
            }
        }
        if (error instanceof DocumentSnapshotError || error instanceof FileLimitError) {
            throw error;
        }
        throw openFailedError();
    }
}
async function prepareWorkerSnapshot(handle, sizeBytes, options) {
    options.allocationObserver?.(sizeBytes);
    const bytes = new Uint8Array(sizeBytes);
    const hash = createHash("sha256");
    await readSourcePositionally(handle, bytes, sizeBytes, (chunk) => {
        hash.update(chunk);
    });
    return {
        kind: "worker",
        bytes,
        sha256: hash.digest("hex"),
        preflight: bytes.subarray(0, Math.min(PREFLIGHT_BYTES, sizeBytes)),
    };
}
async function prepareSpoolSnapshot(sourceHandle, sizeBytes, options) {
    let directoryPath;
    let filePath;
    let directoryIdentity;
    let fileIdentity;
    let writer;
    let reader;
    try {
        directoryPath = await mkdtemp(join(options.spoolRoot, SPOOL_PREFIX));
        directoryIdentity = await ownedDirectoryIdentity(directoryPath);
        await setOwnerOnlyAccess(directoryPath, "directory", 0o700);
        filePath = join(directoryPath, SPOOL_FILENAME);
        writer = await open(filePath, "wx", 0o600);
        const created = await writer.stat({ bigint: true });
        fileIdentity = fileSystemIdentityOf(created);
        await setOwnerOnlyAccess(filePath, "file", 0o600);
        const reusableBytes = Math.max(1, Math.min(READ_CHUNK_BYTES, sizeBytes));
        options.allocationObserver?.(reusableBytes);
        const reusable = Buffer.allocUnsafeSlow(reusableBytes);
        const preflight = new Uint8Array(Math.min(PREFLIGHT_BYTES, sizeBytes));
        const hash = createHash("sha256");
        let position = 0;
        let preflightBytes = 0;
        while (position < sizeBytes) {
            const requested = Math.min(reusable.byteLength, sizeBytes - position);
            const { bytesRead } = await sourceHandle.read(reusable, 0, requested, position);
            if (bytesRead === 0)
                throw sourceChangedError();
            const chunk = reusable.subarray(0, bytesRead);
            hash.update(chunk);
            if (preflightBytes < preflight.byteLength) {
                const retained = Math.min(preflight.byteLength - preflightBytes, bytesRead);
                preflight.set(chunk.subarray(0, retained), preflightBytes);
                preflightBytes += retained;
            }
            await writePositionally(writer, reusable, bytesRead, position);
            position += bytesRead;
        }
        await writer.sync();
        const completed = await writer.stat({ bigint: true });
        if (completed.size !== BigInt(sizeBytes)) {
            throw openFailedError();
        }
        await writer.close();
        writer = undefined;
        await setOwnerOnlyAccess(filePath, "file", 0o600);
        const fileStatus = await lstat(filePath, { bigint: true });
        if (!fileStatus.isFile() ||
            fileStatus.isSymbolicLink() ||
            fileStatus.dev !== fileIdentity.device ||
            fileStatus.ino !== fileIdentity.inode ||
            fileStatus.size !== BigInt(sizeBytes)) {
            throw openFailedError();
        }
        reader = await open(filePath, "r");
        const openedForRead = await reader.stat({ bigint: true });
        if (openedForRead.dev !== fileIdentity.device ||
            openedForRead.ino !== fileIdentity.inode ||
            openedForRead.size !== BigInt(sizeBytes)) {
            throw openFailedError();
        }
        const owner = {
            directoryPath,
            filePath,
            directoryIdentity,
            fileIdentity: { ...fileIdentity, size: BigInt(sizeBytes) },
            handle: reader,
            handleClosed: false,
            cleanupHookRan: false,
            unlinkHookRan: false,
            fileRemoved: false,
            cleaned: false,
        };
        await options.testHooks?.onSpoolCreated?.({ directoryPath, filePath });
        reader = undefined;
        return {
            kind: "spool",
            owner,
            sha256: hash.digest("hex"),
            preflight,
        };
    }
    catch (error) {
        await closeFileHandle(reader);
        await closeFileHandle(writer);
        if (directoryPath !== undefined && directoryIdentity !== undefined) {
            try {
                await removeOwnedSpoolPaths(directoryPath, directoryIdentity, filePath, fileIdentity);
            }
            catch {
                throw cleanupFailedError();
            }
        }
        throw error;
    }
}
async function readSourcePositionally(handle, target, sizeBytes, observeChunk) {
    let position = 0;
    while (position < sizeBytes) {
        const requested = Math.min(READ_CHUNK_BYTES, sizeBytes - position);
        const { bytesRead } = await handle.read(target, position, requested, position);
        if (bytesRead === 0)
            throw sourceChangedError();
        observeChunk(target.subarray(position, position + bytesRead));
        position += bytesRead;
    }
}
async function writePositionally(handle, bytes, byteLength, filePosition) {
    let written = 0;
    while (written < byteLength) {
        const result = await handle.write(bytes, written, byteLength - written, filePosition + written);
        if (result.bytesWritten === 0)
            throw openFailedError();
        written += result.bytesWritten;
    }
}
function createSourceVerifier(path, initialIdentity, expectedSha256, sizeBytes, allocationObserver) {
    return async () => {
        let handle;
        try {
            handle = await openFileForBoundedRead(path);
            const openedStatus = await handle.stat({ bigint: true });
            if (!openedStatus.isFile())
                throw postOpenSourceChangedError();
            assertSamePostOpenSourceIdentity(initialIdentity, sourceIdentityOf(openedStatus));
            assertSamePostOpenSourceIdentity(initialIdentity, await pathSourceIdentityAfterOpen(path));
            const reusableBytes = Math.min(READ_CHUNK_BYTES, sizeBytes);
            allocationObserver?.(reusableBytes);
            const reusable = Buffer.allocUnsafeSlow(reusableBytes);
            const hash = createHash("sha256");
            let position = 0;
            while (position < sizeBytes) {
                const requested = Math.min(reusable.byteLength, sizeBytes - position);
                const { bytesRead } = await handle.read(reusable, 0, requested, position);
                if (bytesRead === 0)
                    throw postOpenSourceChangedError();
                hash.update(reusable.subarray(0, bytesRead));
                position += bytesRead;
            }
            assertSamePostOpenSourceIdentity(initialIdentity, sourceIdentityOf(await handle.stat({ bigint: true })));
            assertSamePostOpenSourceIdentity(initialIdentity, await pathSourceIdentityAfterOpen(path));
            if (hash.digest("hex") !== expectedSha256) {
                throw postOpenSourceChangedError();
            }
        }
        catch {
            throw postOpenSourceChangedError();
        }
        finally {
            if (handle !== undefined) {
                try {
                    await handle.close();
                }
                catch {
                    throw postOpenSourceChangedError();
                }
            }
        }
    };
}
function createMetadata(sizeBytes, sha256, preflight) {
    const shallowFormat = Object.freeze(detectShallowFormat(preflight));
    const protection = Object.freeze({
        status: "requires-engine-validation",
        candidateFormat: shallowFormat.candidate,
        exact: false,
    });
    return Object.freeze({ sizeBytes, sha256, shallowFormat, protection });
}
function createWorkerSnapshot(metadata, initialTransferable, verifySourceUnchanged) {
    let transferable = initialTransferable;
    let transferred = false;
    let disposed = false;
    return Object.freeze({
        transport: "worker",
        metadata,
        verifySourceUnchanged,
        takeTransferable() {
            if (transferred)
                throw transferredError();
            if (disposed || transferable === undefined)
                throw disposedError();
            const result = transferable;
            transferable = undefined;
            transferred = true;
            return result;
        },
        async cleanup() {
            if (disposed)
                return;
            transferable = undefined;
            disposed = true;
        },
    });
}
function createSpoolSnapshot(metadata, owner, testHooks, verifySourceUnchanged) {
    let transferred = false;
    let disposed = false;
    return Object.freeze({
        transport: "spool",
        metadata,
        verifySourceUnchanged,
        takeSpoolHandle() {
            if (transferred)
                throw transferredError();
            if (disposed || owner.cleaned)
                throw disposedError();
            transferred = true;
            return Object.freeze({ fd: owner.handle.fd, sizeBytes: metadata.sizeBytes });
        },
        async cleanup() {
            if (disposed)
                return;
            try {
                await cleanupPrivateSpool(owner, testHooks?.beforeSpoolCleanup, testHooks?.afterSpoolFileUnlink);
                disposed = true;
            }
            catch {
                throw cleanupFailedError();
            }
        },
    });
}
async function cleanupPrivateSpool(owner, beforeCleanup, afterFileUnlink) {
    if (owner.cleaned)
        return;
    if (!owner.handleClosed) {
        await owner.handle.close();
        owner.handleClosed = true;
    }
    if (!owner.cleanupHookRan && beforeCleanup !== undefined) {
        owner.cleanupHookRan = true;
        await beforeCleanup({
            directoryPath: owner.directoryPath,
            filePath: owner.filePath,
        });
    }
    if (owner.quarantinePath === undefined) {
        owner.quarantinePath = await moveOwnedDirectoryToQuarantine(owner.directoryPath);
    }
    const quarantineFilePath = join(owner.quarantinePath, SPOOL_FILENAME);
    await assertOwnedDirectory(owner.quarantinePath, owner.directoryIdentity);
    if (!owner.fileRemoved) {
        await removeOwnedSpoolFile(owner.quarantinePath, quarantineFilePath, owner.fileIdentity, owner.fileIdentity.size);
        owner.fileRemoved = true;
    }
    if (!owner.unlinkHookRan && afterFileUnlink !== undefined) {
        owner.unlinkHookRan = true;
        await afterFileUnlink({
            directoryPath: owner.quarantinePath,
            filePath: quarantineFilePath,
        });
    }
    await assertOwnedDirectory(owner.quarantinePath, owner.directoryIdentity);
    if ((await readdir(owner.quarantinePath)).length !== 0) {
        throw cleanupFailedError();
    }
    await rmdir(owner.quarantinePath);
    owner.cleaned = true;
}
async function removeOwnedSpoolPaths(directoryPath, directoryIdentity, filePath, fileIdentity, expectedSize) {
    const quarantinePath = await moveOwnedDirectoryToQuarantine(directoryPath);
    await assertOwnedDirectory(quarantinePath, directoryIdentity);
    if (filePath === undefined || fileIdentity === undefined) {
        if ((await readdir(quarantinePath)).length !== 0) {
            throw cleanupFailedError();
        }
        await rmdir(quarantinePath);
        return;
    }
    await removeOwnedSpoolFile(quarantinePath, join(quarantinePath, basename(filePath)), fileIdentity, expectedSize);
    await assertOwnedDirectory(quarantinePath, directoryIdentity);
    if ((await readdir(quarantinePath)).length !== 0)
        throw cleanupFailedError();
    await rmdir(quarantinePath);
}
async function moveOwnedDirectoryToQuarantine(directoryPath) {
    const quarantinePath = join(dirname(directoryPath), `${QUARANTINE_PREFIX}${randomUUID()}`);
    await rename(directoryPath, quarantinePath);
    return quarantinePath;
}
async function assertOwnedDirectory(directoryPath, directoryIdentity) {
    const directoryStatus = await lstat(directoryPath, { bigint: true });
    if (!directoryStatus.isDirectory() ||
        directoryStatus.isSymbolicLink() ||
        directoryStatus.dev !== directoryIdentity.device ||
        directoryStatus.ino !== directoryIdentity.inode) {
        throw cleanupFailedError();
    }
}
async function removeOwnedSpoolFile(directoryPath, filePath, fileIdentity, expectedSize) {
    const entries = await readdir(directoryPath);
    if (entries.length !== 1 || entries[0] !== basename(filePath)) {
        throw cleanupFailedError();
    }
    const fileStatus = await lstat(filePath, { bigint: true });
    if (!fileStatus.isFile() ||
        fileStatus.isSymbolicLink() ||
        fileStatus.dev !== fileIdentity.device ||
        fileStatus.ino !== fileIdentity.inode ||
        (expectedSize !== undefined && fileStatus.size !== expectedSize)) {
        throw cleanupFailedError();
    }
    await unlink(filePath);
}
async function closeFileHandle(handle) {
    if (handle === undefined)
        return;
    try {
        await handle.close();
    }
    catch {
        throw cleanupFailedError();
    }
}
async function setOwnerOnlyAccess(path, kind, mode) {
    if (process.platform !== "win32") {
        await chmod(path, mode);
        return;
    }
    try {
        const sid = await currentWindowsSid();
        const currentGrant = kind === "directory" ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
        const systemGrant = kind === "directory"
            ? `*${WINDOWS_SYSTEM_SID}:(OI)(CI)F`
            : `*${WINDOWS_SYSTEM_SID}:F`;
        await runAclCommand("icacls.exe", [
            path,
            "/inheritance:r",
            "/grant:r",
            currentGrant,
            systemGrant,
            "/q",
        ]);
        await verifyWindowsAcl(path, sid, kind);
    }
    catch {
        throw openFailedError();
    }
}
async function currentWindowsSid() {
    const result = await runAclCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const match = /"(S-\d+(?:-\d+)+)"/u.exec(result.stdout);
    if (match?.[1] === undefined)
        throw openFailedError();
    return match[1];
}
async function verifyWindowsAcl(path, sid, kind) {
    const script = [
        "$item=if($env:GPT_CODEX_HWP_ACL_KIND -eq 'directory'){[System.IO.DirectoryInfo]::new($env:GPT_CODEX_HWP_ACL_PATH)}else{[System.IO.FileInfo]::new($env:GPT_CODEX_HWP_ACL_PATH)}",
        "$acl=$item.GetAccessControl()",
        "$sid=$env:GPT_CODEX_HWP_ACL_SID",
        `$system='${WINDOWS_SYSTEM_SID}'`,
        "if(-not $acl.AreAccessRulesProtected){exit 17}",
        "$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
        "if(@($rules | Where-Object { $_.IdentityReference.Value -ne $sid -and $_.IdentityReference.Value -ne $system }).Count -ne 0){exit 18}",
        "if(@($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq $sid -and (($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) }).Count -eq 0){exit 19}",
        "[Console]::Out.Write('OK')",
    ].join(";");
    const result = await runAclCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        ...process.env,
        GPT_CODEX_HWP_ACL_PATH: path,
        GPT_CODEX_HWP_ACL_SID: sid,
        GPT_CODEX_HWP_ACL_KIND: kind,
    });
    if (result.stdout !== "OK")
        throw openFailedError();
}
async function runAclCommand(command, args, env = process.env) {
    const result = await execFileAsync(command, [...args], {
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
}
function validateOptions(rawOptions) {
    if (typeof rawOptions !== "object" || rawOptions === null) {
        throw optionsInvalidError();
    }
    const threshold = rawOptions.workerInputMaxBytes ?? WORKER_INPUT_MAX_BYTES;
    const maximumBytes = rawOptions.maximumBytes ?? MAX_DOCUMENT_BYTES;
    if (!Number.isSafeInteger(threshold) ||
        threshold < 0 ||
        threshold > WORKER_INPUT_MAX_BYTES) {
        throw optionsInvalidError();
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
        maximumBytes > MAX_DOCUMENT_BYTES) {
        throw optionsInvalidError();
    }
    if (rawOptions.allocationObserver !== undefined &&
        typeof rawOptions.allocationObserver !== "function") {
        throw optionsInvalidError();
    }
    const hooks = rawOptions.testHooks;
    if (hooks !== undefined) {
        if (typeof hooks !== "object" || hooks === null) {
            throw optionsInvalidError();
        }
        if (hooks.spoolRoot !== undefined &&
            (typeof hooks.spoolRoot !== "string" || hooks.spoolRoot.trim().length === 0)) {
            throw optionsInvalidError();
        }
        for (const hook of [
            hooks.afterSourceRead,
            hooks.onSpoolCreated,
            hooks.beforeSpoolCleanup,
            hooks.afterSpoolFileUnlink,
        ]) {
            if (hook !== undefined && typeof hook !== "function") {
                throw optionsInvalidError();
            }
        }
    }
    return {
        workerInputMaxBytes: threshold,
        maximumBytes,
        ...(rawOptions.allocationObserver === undefined
            ? {}
            : { allocationObserver: rawOptions.allocationObserver }),
        ...(hooks === undefined ? {} : { testHooks: hooks }),
        spoolRoot: hooks?.spoolRoot ?? tmpdir(),
    };
}
async function pathSourceIdentity(path) {
    try {
        return sourceIdentityOf(await stat(path, { bigint: true }));
    }
    catch {
        throw sourceChangedError();
    }
}
async function pathSourceIdentityAfterOpen(path) {
    try {
        return sourceIdentityOf(await stat(path, { bigint: true }));
    }
    catch {
        throw postOpenSourceChangedError();
    }
}
async function ownedDirectoryIdentity(path) {
    const status = await lstat(path, { bigint: true });
    if (!status.isDirectory() || status.isSymbolicLink())
        throw openFailedError();
    return fileSystemIdentityOf(status);
}
function fileSystemIdentityOf(status) {
    return { device: status.dev, inode: status.ino };
}
function sourceIdentityOf(status) {
    return {
        ...fileSystemIdentityOf(status),
        size: status.size,
        modified: status.mtimeNs,
        changed: status.ctimeNs,
    };
}
function assertSameSourceIdentity(expected, actual) {
    if (expected.device !== actual.device ||
        expected.inode !== actual.inode ||
        expected.size !== actual.size ||
        expected.modified !== actual.modified ||
        expected.changed !== actual.changed) {
        throw sourceChangedError();
    }
}
function assertSamePostOpenSourceIdentity(expected, actual) {
    if (expected.device !== actual.device ||
        expected.inode !== actual.inode ||
        expected.size !== actual.size ||
        expected.modified !== actual.modified ||
        expected.changed !== actual.changed) {
        throw postOpenSourceChangedError();
    }
}
function detectShallowFormat(bytes) {
    if (startsWith(bytes, OLE2_MAGIC)) {
        return { candidate: "hwp", container: "ole2", exact: false };
    }
    if (bytes.byteLength >= 4 &&
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
            (bytes[2] === 0x05 && bytes[3] === 0x06) ||
            (bytes[2] === 0x07 && bytes[3] === 0x08))) {
        return { candidate: "hwpx", container: "zip", exact: false };
    }
    return { candidate: "unknown", container: "unknown", exact: false };
}
function startsWith(bytes, prefix) {
    if (bytes.byteLength < prefix.byteLength)
        return false;
    for (let index = 0; index < prefix.byteLength; index += 1) {
        if (bytes[index] !== prefix[index])
            return false;
    }
    return true;
}
function sourceChangedError() {
    return new DocumentSnapshotError("SOURCE_CHANGED", "Source document changed while its snapshot was opened.");
}
function postOpenSourceChangedError() {
    return new DocumentSnapshotError("SOURCE_CHANGED", "Source document changed after its snapshot was opened.");
}
function transferredError() {
    return new DocumentSnapshotError("SNAPSHOT_TRANSFERRED", "Document snapshot transport was already taken.");
}
function disposedError() {
    return new DocumentSnapshotError("SNAPSHOT_DISPOSED", "Document snapshot was already cleaned up.");
}
function openFailedError() {
    return new DocumentSnapshotError("SNAPSHOT_OPEN_FAILED", "Could not open a safe document snapshot.");
}
function optionsInvalidError() {
    return new DocumentSnapshotError("SNAPSHOT_OPTIONS_INVALID", "Document snapshot options are invalid.");
}
function cleanupFailedError() {
    return new DocumentSnapshotError("SNAPSHOT_CLEANUP_FAILED", "Could not safely clean up the private document spool.");
}
