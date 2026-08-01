import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile, } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyWindowsOwnerOnlyAcl } from "./shared/windows-owner-only-acl.js";
import { RuntimeBootstrapError, readVerifiedManagedRuntimeFile, resolveDurableRoot, resolveInstalledRuntime, resolveManagedRuntime, resolveNpmCommand, } from "./runtime-bootstrap.js";
const LOCK_STALE_MS = 15 * 60 * 1000;
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_OUTPUT_BYTES = 64 * 1024;
const LOCK_BYTES = 4096;
const TOOL_NAMES = Object.freeze([
    "hwp_create_svg_asset",
    "hwp_detect_format",
    "hwp_fill_form",
    "hwp_generate_hwpx",
    "hwp_insert_image",
    "hwp_patch_document",
    "hwp_read",
    "hwp_render_preview",
    "hwp_validate",
]);
export class RuntimeInstallError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "RuntimeInstallError";
    }
}
export async function installRuntime(importMetaUrl, options = {}) {
    const identity = await resolveManagedRuntime(importMetaUrl, options);
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? (() => randomBytes(16).toString("hex"));
    const runCommand = options.runCommand ?? runBoundedCommand;
    const secureDirectory = options.secureDirectory ?? secureRuntimeDirectory;
    const finalRoot = resolveDurableRoot(identity);
    const versionRoot = dirname(finalRoot);
    await ensureRuntimeParents(identity, secureDirectory);
    const platformKey = `${identity.platform}-${identity.arch}`;
    const lockPath = join(versionRoot, `.${platformKey}.install.lock`);
    const lock = await acquireInstallLock(lockPath, now(), randomId);
    let ownedStage;
    try {
        const existing = await existingRuntime(importMetaUrl, identity, options, runCommand);
        if (existing !== undefined)
            return existing;
        const stagePath = join(versionRoot, `.${platformKey}.stage-${requiredRandomId(randomId())}`);
        await mkdir(stagePath, { recursive: false, mode: 0o700 });
        ownedStage = await ownDirectory(stagePath);
        if (!await secureDirectory(stagePath))
            throw installFailure();
        await copyManifestFiles(identity, stagePath);
        await runNpm(identity, stagePath, [
            "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--install-links=true",
        ], runCommand);
        const dependencyTree = await runNpm(identity, stagePath, [
            "ls", "--omit=dev", "--json", "--install-links=true",
        ], runCommand);
        assertDependencyTree(dependencyTree.stdout, identity);
        const validation = await validateStagedRuntime(stagePath);
        const receipt = buildReceipt(identity, now(), validation.toolCount);
        await writeFile(join(stagePath, "install-receipt.json"), `${JSON.stringify(receipt)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        if (await pathExists(finalRoot)) {
            const invalidPath = join(versionRoot, `.${platformKey}.invalid-${requiredRandomId(randomId())}`);
            await rename(finalRoot, invalidPath);
        }
        await rename(stagePath, finalRoot);
        ownedStage = undefined;
        return receipt;
    }
    catch (error) {
        if (error instanceof RuntimeBootstrapError || error instanceof RuntimeInstallError)
            throw error;
        throw installFailure();
    }
    finally {
        if (ownedStage !== undefined)
            await removeOwnedDirectory(ownedStage, randomId).catch(() => undefined);
        await releaseInstallLock(lock).catch(() => undefined);
    }
}
export async function installRuntimeEntry(args = process.argv.slice(2), io = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
}) {
    if (args.length !== 1 || args[0] !== "--json") {
        io.stdout(`${JSON.stringify({ schemaVersion: 1, code: "RUNTIME_INSTALL_FAILED", ok: false })}\n`);
        return 2;
    }
    try {
        const receipt = await installRuntime(import.meta.url);
        io.stdout(`${JSON.stringify({ ...receipt, ok: true })}\n`);
        return 0;
    }
    catch (error) {
        const code = error instanceof RuntimeInstallError || error instanceof RuntimeBootstrapError
            ? error.code
            : "RUNTIME_INSTALL_FAILED";
        io.stdout(`${JSON.stringify({ schemaVersion: 1, code, ok: false })}\n`);
        return 1;
    }
}
async function existingRuntime(importMetaUrl, identity, options, runCommand) {
    try {
        const installed = await resolveInstalledRuntime(importMetaUrl, "dist/oneshot-main.js", options);
        const result = await runNpm(identity, installed.root, [
            "ls", "--omit=dev", "--json", "--install-links=true",
        ], runCommand);
        assertDependencyTree(result.stdout, identity);
        return installed.receipt;
    }
    catch (error) {
        if (error instanceof RuntimeBootstrapError && error.code !== "RUNTIME_PATH_INVALID")
            return undefined;
        throw error;
    }
}
async function ensureRuntimeParents(identity, secureDirectory) {
    let current = identity.codexHome;
    for (const name of ["plugin-runtime-data", identity.productId, identity.pluginVersion]) {
        current = join(current, name);
        let created = false;
        try {
            await mkdir(current, { recursive: false, mode: 0o700 });
            created = true;
        }
        catch (error) {
            if (!hasCode(error, "EEXIST"))
                throw error;
        }
        const status = await lstat(current);
        if (!status.isDirectory() || status.isSymbolicLink()
            || !samePath(current, await realpath(current))) {
            throw new RuntimeBootstrapError("RUNTIME_PATH_INVALID");
        }
        if (created && !await secureDirectory(current))
            throw installFailure();
    }
}
async function copyManifestFiles(identity, stageRoot) {
    for (const record of identity.manifestFiles) {
        const destination = join(stageRoot, ...record.path.split("/"));
        const sourceBytes = await readVerifiedManagedRuntimeFile(identity, record);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, sourceBytes, { flag: "wx", mode: 0o600 });
        const [destinationStatus, destinationBytes] = await Promise.all([
            lstat(destination), readFile(destination),
        ]);
        if (!destinationStatus.isFile() || destinationStatus.isSymbolicLink()
            || destinationBytes.byteLength !== record.size || sha256(destinationBytes) !== record.sha256) {
            throw installFailure();
        }
    }
}
async function runNpm(identity, cwd, args, runCommand) {
    const npm = await resolveNpmCommand();
    if (npm === null)
        throw installFailure();
    const result = await runCommand(Object.freeze({
        command: npm.command,
        args: Object.freeze([...npm.argsPrefix, ...args]),
        cwd,
        env: npmEnvironment(process.env),
        timeoutMs: NPM_TIMEOUT_MS,
        maxOutputBytes: COMMAND_OUTPUT_BYTES,
    }));
    if (result.code !== 0 || result.timedOut
        || result.stdout.byteLength > COMMAND_OUTPUT_BYTES
        || result.stderr.byteLength > COMMAND_OUTPUT_BYTES) {
        throw installFailure();
    }
    if (identity.nodeVersion.split(".")[0] !== process.versions.node.split(".")[0]) {
        throw new RuntimeBootstrapError("RUNTIME_PLATFORM_MISMATCH");
    }
    return result;
}
function assertDependencyTree(bytes, identity) {
    if (bytes.byteLength < 2 || bytes.byteLength > COMMAND_OUTPUT_BYTES)
        throw installFailure();
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        throw installFailure();
    }
    const tree = record(parsed);
    const dependencies = record(tree?.dependencies);
    if (tree?.name !== identity.productId || dependencies === undefined
        || identity.directDependencies.some((name) => record(dependencies[name]) === undefined)) {
        throw installFailure();
    }
}
async function validateStagedRuntime(stageRoot) {
    let output = "";
    const doctor = await import(pathToFileURL(join(stageRoot, "dist", "doctor-main.js")).href);
    if (typeof doctor.doctorMain !== "function")
        throw installFailure();
    const code = await doctor.doctorMain(["--json"], {
        stdout(value) {
            if (Buffer.byteLength(output + value, "utf8") > COMMAND_OUTPUT_BYTES)
                throw installFailure();
            output += value;
        },
        stderr() { throw installFailure(); },
    });
    let report;
    try {
        report = record(JSON.parse(output));
    }
    catch {
        throw installFailure();
    }
    const checks = Array.isArray(report?.checks) ? report.checks : [];
    const toolCheck = checks.map(record).find((check) => check?.code === "MCP_TOOL_COUNT_OK");
    if (code !== 0 || report?.code !== "DOCTOR_OK" || report?.ok !== true || toolCheck?.count !== 9) {
        throw installFailure();
    }
    const catalog = record(JSON.parse(await readFile(join(stageRoot, "examples", "oneshot-tool-schemas.json"), "utf8")));
    const tools = record(catalog?.tools);
    if (tools === undefined || JSON.stringify(Object.keys(tools)) !== JSON.stringify(TOOL_NAMES)) {
        throw installFailure();
    }
    const verifier = await import(pathToFileURL(join(stageRoot, "scripts", "kordoc-runtime-verifier.mjs")).href);
    if (typeof verifier.verifyKordocCoreRuntime !== "function"
        || typeof verifier.kordocFileRecords !== "function")
        throw installFailure();
    const kordoc = await verifier.verifyKordocCoreRuntime(join(stageRoot, "vendor", "kordoc-core"));
    if (!Array.isArray(kordoc.files) || kordoc.files.length < 1 || kordoc.files.length > 10_000) {
        throw installFailure();
    }
    const installedKordoc = await verifier.kordocFileRecords(join(stageRoot, "node_modules", "kordoc"));
    if (JSON.stringify(installedKordoc) !== JSON.stringify(kordoc.files))
        throw installFailure();
    return { toolCount: 9 };
}
function buildReceipt(identity, createdAt, toolCount) {
    if (!Number.isFinite(createdAt.getTime()))
        throw installFailure();
    return Object.freeze({
        schemaVersion: 1,
        code: "RUNTIME_INSTALL_OK",
        productId: identity.productId,
        pluginVersion: identity.pluginVersion,
        platform: identity.platform,
        arch: identity.arch,
        nodeMajor: Number(identity.nodeVersion.split(".")[0]),
        nodeVersion: identity.nodeVersion,
        manifestSha256: identity.manifestSha256,
        packageLockSha256: identity.packageLockSha256,
        toolCount,
        doctorCode: "DOCTOR_OK",
        dependencyCount: identity.directDependencies.length,
        createdAt: createdAt.toISOString(),
    });
}
async function acquireInstallLock(path, now, randomId) {
    const nonce = requiredRandomId(randomId());
    const create = async () => {
        const handle = await open(path, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, nonce, createdAt: now.toISOString() })}\n`, "utf8");
            await handle.sync();
            const status = await handle.stat();
            return Object.freeze({ path, nonce, dev: status.dev, ino: status.ino });
        }
        finally {
            await handle.close();
        }
    };
    try {
        return await create();
    }
    catch (error) {
        if (!hasCode(error, "EEXIST"))
            throw error;
    }
    const stale = await staleLock(path, now);
    if (!stale)
        throw new RuntimeInstallError("RUNTIME_INSTALL_BUSY");
    const quarantine = `${path}.stale-${requiredRandomId(randomId())}`;
    await rename(path, quarantine);
    return await create();
}
async function staleLock(path, now) {
    try {
        const status = await lstat(path);
        if (!status.isFile() || status.isSymbolicLink() || status.size < 2 || status.size > LOCK_BYTES)
            return true;
        const value = record(JSON.parse(await readFile(path, "utf8")));
        const created = Date.parse(String(value?.createdAt ?? ""));
        const nonce = value?.nonce;
        return value?.schemaVersion !== 1 || typeof nonce !== "string" || !/^[a-f0-9]{32}$/u.test(nonce)
            || !Number.isFinite(created) || now.getTime() - created >= LOCK_STALE_MS || now.getTime() < created;
    }
    catch {
        return true;
    }
}
async function releaseInstallLock(lock) {
    const releasePath = `${lock.path}.release-${lock.nonce}`;
    await rename(lock.path, releasePath);
    const status = await lstat(releasePath);
    if (status.dev !== lock.dev || status.ino !== lock.ino || !status.isFile() || status.isSymbolicLink())
        return;
    await rm(releasePath, { force: false });
}
async function ownDirectory(path) {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink())
        throw installFailure();
    return Object.freeze({ path, dev: status.dev, ino: status.ino });
}
async function removeOwnedDirectory(owner, randomId) {
    const quarantine = `${owner.path}.cleanup-${requiredRandomId(randomId())}`;
    await rename(owner.path, quarantine);
    const status = await lstat(quarantine);
    if (status.dev !== owner.dev || status.ino !== owner.ino
        || !status.isDirectory() || status.isSymbolicLink())
        return;
    await rm(quarantine, { recursive: true, force: false });
}
async function secureRuntimeDirectory(path) {
    if (process.platform === "win32")
        return await applyWindowsOwnerOnlyAcl(path, "directory") === "OK";
    await chmod(path, 0o700);
    return true;
}
async function runBoundedCommand(spec) {
    return await new Promise((resolveResult) => {
        const child = spawn(spec.command, [...spec.args], {
            cwd: spec.cwd,
            env: spec.env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let overflow = false;
        const consume = (target, chunk, stream) => {
            const bytes = stream === "stdout" ? stdoutBytes + chunk.byteLength : stderrBytes + chunk.byteLength;
            if (stream === "stdout")
                stdoutBytes = bytes;
            else
                stderrBytes = bytes;
            if (bytes > spec.maxOutputBytes) {
                overflow = true;
                child.kill();
                return;
            }
            target.push(Buffer.from(chunk));
        };
        child.stdout?.on("data", (chunk) => consume(stdout, chunk, "stdout"));
        child.stderr?.on("data", (chunk) => consume(stderr, chunk, "stderr"));
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, spec.timeoutMs);
        child.once("error", () => {
            clearTimeout(timer);
            resolveResult({ code: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut });
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolveResult({
                code: overflow ? null : code,
                stdout: Buffer.concat(stdout),
                stderr: Buffer.concat(stderr),
                timedOut,
            });
        });
    });
}
function npmEnvironment(source) {
    const allowed = [
        "APPDATA", "HOME", "LOCALAPPDATA", "PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR",
        "USERPROFILE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
        "NPM_CONFIG_CACHE", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_USERCONFIG",
    ];
    return Object.fromEntries(allowed.flatMap((name) => {
        const value = source[name];
        return value === undefined || value.startsWith("()") ? [] : [[name, value]];
    }));
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function requiredRandomId(value) {
    if (!/^[a-f0-9]{32}$/u.test(value))
        throw installFailure();
    return value;
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function samePath(left, right) {
    const leftPath = resolve(left);
    const rightPath = resolve(right);
    return process.platform === "win32"
        ? leftPath.toLocaleLowerCase("en-US") === rightPath.toLocaleLowerCase("en-US")
        : leftPath === rightPath;
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (hasCode(error, "ENOENT"))
            return false;
        throw error;
    }
}
function hasCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error
        && error.code === code;
}
function installFailure() {
    return new RuntimeInstallError("RUNTIME_INSTALL_FAILED");
}
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
    installRuntimeEntry().then((code) => { process.exitCode = code; }).catch(() => {
        process.stdout.write('{"schemaVersion":1,"code":"RUNTIME_INSTALL_FAILED","ok":false}\n');
        process.exitCode = 1;
    });
}
