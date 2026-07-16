import { lstat, mkdir, open, realpath, stat, } from "node:fs/promises";
import { extname, join, parse as parsePath, resolve } from "node:path";
import { z } from "zod";
import { defaultDocumentEngineFacade, } from "../shared/document-engine.js";
import { openDocumentSnapshot } from "../shared/document-snapshot.js";
import { resolveLocalPath } from "../shared/paths.js";
import { authorizeExistingPath, authorizeFuturePath, } from "../shared/allowed-roots.js";
import { MarkdownDeliveryError, planMarkdownDelivery, } from "../shared/markdown-output.js";
import { writeFilesExclusively } from "../shared/output.js";
import { toolError, toolSuccess } from "../shared/result.js";
import { requireToolNotCancelled, runWithToolExecutionContext, toDocumentEngineExecutionContext, } from "../shared/tool-context.js";
import { maxWorkerSnapshotBytesForRequest } from "../workers/document-execution-policy.js";
export const HWP_READ_TOOL_NAME = "hwp_read";
export async function handleHwpRead(input, documentEngine = defaultDocumentEngineFacade, context) {
    let filePath;
    try {
        filePath = resolveLocalPath(input.file_path, "file_path");
        const parseOptions = {
            ...(input.pages === undefined ? {} : { pages: input.pages }),
        };
        const snapshot = await openDocumentSnapshot(filePath, {
            workerInputMaxBytes: maxWorkerSnapshotBytesForRequest({
                input: {},
                options: parseOptions,
            }),
        });
        if (snapshot.metadata.shallowFormat.candidate === "unknown") {
            try {
                await snapshot.verifySourceUnchanged();
                return toolError("Only HWP and HWPX documents are supported.", {
                    code: "UNSUPPORTED_FORMAT",
                    file_path: filePath,
                    file_type: "unknown",
                    supported_formats: ["hwp", "hwpx"],
                });
            }
            finally {
                await snapshot.cleanup();
            }
        }
        const engineResult = await documentEngine.parse(snapshot, parseOptions, toDocumentEngineExecutionContext(context));
        const parsed = engineResult.payload;
        let delivery;
        try {
            delivery = planMarkdownDelivery(parsed.markdown, input.markdown_output_path);
        }
        catch (error) {
            if (error instanceof MarkdownDeliveryError) {
                return toolError(error.message, {
                    code: error.code,
                    file_path: filePath,
                    file_type: parsed.fileType,
                    ...error.details,
                });
            }
            throw error;
        }
        const warnings = copyWarnings(parsed.warnings);
        const shouldExtractImages = input.extract_images ?? input.output_dir !== undefined;
        const assets = shouldExtractImages
            ? await collectImageAssets(parsed.images ?? [], input.output_dir, filePath, warnings, context)
            : [];
        const metadata = {
            ...(parsed.metadata ?? {}),
            fileType: parsed.fileType,
        };
        if (parsed.pageCount !== undefined) {
            metadata.pageCount = parsed.pageCount;
        }
        if (parsed.isImageBased !== undefined) {
            metadata.isImageBased = parsed.isImageBased;
        }
        const details = {
            markdown: delivery.inlineMarkdown,
            metadata,
            warnings,
            assets,
        };
        if (delivery.outputPath !== undefined) {
            Object.assign(details, {
                markdown_truncated: delivery.truncated,
                markdown_path: delivery.outputPath,
                markdown_characters: delivery.characters,
                markdown_bytes: delivery.bytes,
                recommended_chunk_characters: delivery.recommendedChunkCharacters,
                source_fingerprint: engineResult.snapshotMetadata.sha256,
            });
        }
        const summary = delivery.outputPath === undefined
            ? `Read ${parsed.fileType} document.`
            : `Read ${parsed.fileType} document and saved complete Markdown.`;
        const successResult = toolSuccess(summary, details);
        if (successResult.isError)
            return successResult;
        if (delivery.outputPath !== undefined) {
            await writeFilesExclusively([{ path: delivery.outputPath, data: parsed.markdown }], {
                sourcePaths: [filePath],
                beforeOpen: async () => requireToolNotCancelled(context),
            });
        }
        return successResult;
    }
    catch (error) {
        const message = errorMessage(error);
        const code = errorCode(error, "READ_ERROR");
        if (code === "UNSUPPORTED_FORMAT") {
            return toolError("Only HWP and HWPX documents are supported.", {
                code,
                error: message,
                file_path: safeResolvedPath(input.file_path),
                supported_formats: ["hwp", "hwpx"],
            });
        }
        const details = {
            code,
            error: message,
            file_path: safeResolvedPath(input.file_path),
        };
        const markdownOutputPath = safeResolvedPath(input.markdown_output_path, "markdown_output_path");
        if (markdownOutputPath !== undefined) {
            details.markdown_output_path = markdownOutputPath;
        }
        return toolError(`Could not read the document: ${message}`, details);
    }
}
export function registerHwpRead(server, documentEngine = defaultDocumentEngineFacade) {
    server.registerTool(HWP_READ_TOOL_NAME, {
        title: "Read HWP document",
        description: "Read the exact requested local HWP/HWPX document as Markdown with metadata, warnings, and optional extracted images.",
        inputSchema: {
            file_path: z.string().min(1).describe("Local document path to read."),
            output_dir: z
                .string()
                .min(1)
                .optional()
                .describe("Directory for extracted image files."),
            markdown_output_path: z
                .string()
                .min(1)
                .optional()
                .describe("New local .md path for the complete extracted Markdown; existing files are never overwritten."),
            pages: z
                .string()
                .min(1)
                .optional()
                .describe("1-based page or section range, such as 1-3 or 1,3,5."),
            extract_images: z
                .boolean()
                .optional()
                .describe("Return or write extracted image assets."),
        },
        annotations: {
            readOnlyHint: false,
        },
    }, (args, extra) => runWithToolExecutionContext(extra, (context) => handleHwpRead(args, documentEngine, context)));
}
function copyWarnings(warnings) {
    return (warnings ?? []).map((warning) => ({ ...warning }));
}
async function collectImageAssets(images, outputDir, sourceFilePath, warnings, context) {
    const filenames = uniqueSafeFilenames(images);
    if (outputDir === undefined) {
        warnings.push({
            code: "IMAGES_NOT_WRITTEN",
            message: "extract_images was requested without output_dir; returning image names only, without raw bytes.",
        });
        return filenames;
    }
    requireToolNotCancelled(context);
    const resolvedOutputDir = await authorizeFuturePath(resolveLocalPath(outputDir, "output_dir"));
    const resolvedSourceFilePath = await authorizeExistingPath(resolveLocalPath(sourceFilePath, "file_path"));
    const outputDirectory = await prepareCanonicalOutputDirectory(resolvedOutputDir);
    const paths = [];
    for (const [index, image] of images.entries()) {
        paths.push(await writeImageAssetExclusively(image, filenames[index], outputDirectory, resolvedSourceFilePath, context));
    }
    return paths;
}
class UnsafeOutputDirectoryError extends Error {
    code = "UNSAFE_OUTPUT_DIR";
    constructor(message) {
        super(message);
        this.name = "UnsafeOutputDirectoryError";
    }
}
async function prepareCanonicalOutputDirectory(outputDir) {
    await assertNoLinkedExistingComponents(outputDir);
    await mkdir(outputDir, { recursive: true });
    await assertNoLinkedExistingComponents(outputDir);
    const [canonicalPath, stats] = await Promise.all([
        realpath(outputDir),
        stat(outputDir, { bigint: true }),
    ]);
    if (!stats.isDirectory()) {
        throw new UnsafeOutputDirectoryError("output_dir must resolve to a directory.");
    }
    if (comparablePath(canonicalPath) !== comparablePath(outputDir)) {
        throw new UnsafeOutputDirectoryError("output_dir must be a canonical path without symlinks or junctions.");
    }
    return {
        path: outputDir,
        realPath: canonicalPath,
        device: stats.dev,
        inode: stats.ino,
    };
}
async function assertCanonicalDirectoryIdentity(expected) {
    await assertNoLinkedExistingComponents(expected.path);
    const [canonicalPath, stats] = await Promise.all([
        realpath(expected.path),
        stat(expected.path, { bigint: true }),
    ]);
    if (!stats.isDirectory() ||
        comparablePath(canonicalPath) !== comparablePath(expected.realPath) ||
        comparablePath(canonicalPath) !== comparablePath(expected.path) ||
        stats.dev !== expected.device ||
        stats.ino !== expected.inode) {
        throw new UnsafeOutputDirectoryError("output_dir changed or became non-canonical before asset creation.");
    }
}
async function assertNoLinkedExistingComponents(path) {
    for (const component of absolutePathComponents(path)) {
        let stats;
        try {
            stats = await lstat(component);
        }
        catch (error) {
            if (errorCode(error, "") === "ENOENT") {
                return;
            }
            throw error;
        }
        if (stats.isSymbolicLink()) {
            throw new UnsafeOutputDirectoryError(`output_dir path component is a symlink or junction: ${component}`);
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
async function writeImageAssetExclusively(image, baseFilename, outputDirectory, sourceFilePath, context) {
    let attempt = 1;
    while (true) {
        const filename = filenameForAttempt(baseFilename, attempt);
        const outputPath = await authorizeFuturePath(resolve(outputDirectory.path, filename));
        if (comparablePath(outputPath) === comparablePath(sourceFilePath)) {
            attempt += 1;
            continue;
        }
        await assertCanonicalDirectoryIdentity(outputDirectory);
        if (comparablePath(await authorizeFuturePath(outputPath)) !== comparablePath(outputPath)) {
            throw new UnsafeOutputDirectoryError("output_dir changed before asset creation.");
        }
        requireToolNotCancelled(context);
        let handle;
        try {
            handle = await open(outputPath, "wx");
        }
        catch (error) {
            if (errorCode(error, "") === "EEXIST") {
                attempt += 1;
                continue;
            }
            throw error;
        }
        let closed = false;
        try {
            const created = await handle.stat({ bigint: true });
            await assertCanonicalDirectoryIdentity(outputDirectory);
            const openedPath = await lstat(outputPath, { bigint: true });
            if (!openedPath.isFile() ||
                openedPath.isSymbolicLink() ||
                openedPath.dev !== created.dev ||
                openedPath.ino !== created.ino ||
                comparablePath(await authorizeFuturePath(outputPath)) !==
                    comparablePath(outputPath)) {
                throw new UnsafeOutputDirectoryError("Extracted asset path changed while it was being created.");
            }
            await handle.writeFile(new Uint8Array(image.bytes));
            await handle.close();
            closed = true;
            return outputPath;
        }
        catch (error) {
            if (!closed) {
                await handle.close().catch(() => undefined);
            }
            // Never delete a failed output by pathname: a concurrent replacement
            // could be removed between any identity check and deletion.
            throw error;
        }
    }
}
function filenameForAttempt(baseFilename, attempt) {
    if (attempt === 1) {
        return baseFilename;
    }
    const extension = extname(baseFilename);
    const stem = extension.length > 0
        ? baseFilename.slice(0, -extension.length)
        : baseFilename;
    return `${stem}_${attempt}${extension}`;
}
function uniqueSafeFilenames(images) {
    const used = new Set();
    return images.map((image, index) => {
        const original = safeFilename(image.filename, image.mimeType, index);
        const extension = extname(original);
        const stem = extension.length > 0 ? original.slice(0, -extension.length) : original;
        let filename = original;
        let suffix = 2;
        while (used.has(comparableFilename(filename))) {
            filename = `${stem}_${suffix}${extension}`;
            suffix += 1;
        }
        used.add(comparableFilename(filename));
        return filename;
    });
}
function safeFilename(filename, mimeType, index) {
    const leaf = filename.replaceAll("\\", "/").split("/").at(-1) ?? "";
    let safe = leaf
        .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_")
        .replace(/[. ]+$/gu, "");
    if (safe.length === 0 || safe === "." || safe === "..") {
        safe = `image_${String(index + 1).padStart(3, "0")}${extensionForMime(mimeType)}`;
    }
    const deviceName = safe.split(".", 1)[0]?.toUpperCase();
    if (deviceName !== undefined &&
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceName)) {
        safe = `_${safe}`;
    }
    return safe;
}
function extensionForMime(mimeType) {
    const extensions = {
        "image/bmp": ".bmp",
        "image/gif": ".gif",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/svg+xml": ".svg",
        "image/tiff": ".tiff",
        "image/webp": ".webp",
    };
    return extensions[mimeType.toLowerCase()] ?? ".bin";
}
function comparableFilename(filename) {
    return process.platform === "win32"
        ? filename.toLocaleLowerCase("en-US")
        : filename;
}
function comparablePath(path) {
    return process.platform === "win32"
        ? path.toLocaleLowerCase("en-US")
        : path;
}
function safeResolvedPath(path, label = "file_path") {
    try {
        return typeof path === "string"
            ? resolveLocalPath(path, label)
            : undefined;
    }
    catch {
        return undefined;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
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
