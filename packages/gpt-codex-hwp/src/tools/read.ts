import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import { extname, join, parse as parsePath, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  defaultDocumentEngineFacade,
  type DocumentEngineFacade,
} from "../shared/document-engine.js";
import { openDocumentSnapshot } from "../shared/document-snapshot.js";
import { resolveLocalPath } from "../shared/paths.js";
import {
  MarkdownDeliveryError,
  planMarkdownDelivery,
  type MarkdownDeliveryPlan,
} from "../shared/markdown-output.js";
import { writeFilesExclusively } from "../shared/output.js";
import { toolError, toolSuccess } from "../shared/result.js";
import {
  MAX_MCP_RESPONSE_BYTES,
  serializedBytes,
} from "../shared/resource-limits.js";
import type {
  ParseImageResult as ExtractedImage,
  ParseWarningResult as ParseWarning,
} from "../workers/document-protocol.js";

export const HWP_READ_TOOL_NAME = "hwp_read";

export interface HwpReadInput {
  file_path: string;
  output_dir?: string;
  markdown_output_path?: string;
  pages?: string;
  extract_images?: boolean;
}

interface ReadWarning {
  page?: number;
  code: string;
  message: string;
}

export async function handleHwpRead(
  input: HwpReadInput,
  documentEngine: DocumentEngineFacade = defaultDocumentEngineFacade,
): Promise<CallToolResult> {
  let filePath: string;

  try {
    filePath = resolveLocalPath(input.file_path, "file_path");
    const snapshot = await openDocumentSnapshot(filePath);
    if (snapshot.metadata.shallowFormat.candidate === "unknown") {
      try {
        await snapshot.verifySourceUnchanged();
        return toolError("Only HWP and HWPX documents are supported.", {
          code: "UNSUPPORTED_FORMAT",
          file_path: filePath,
          file_type: "unknown",
          supported_formats: ["hwp", "hwpx"],
        });
      } finally {
        await snapshot.cleanup();
      }
    }
    const engineResult = await documentEngine.parse(snapshot, {
      ...(input.pages === undefined ? {} : { pages: input.pages }),
    });
    const parsed = engineResult.payload;
    let delivery: MarkdownDeliveryPlan;
    try {
      delivery = planMarkdownDelivery(
        parsed.markdown,
        input.markdown_output_path,
      );
    } catch (error: unknown) {
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

    const warnings: ReadWarning[] = copyWarnings(parsed.warnings);
    const shouldExtractImages =
      input.extract_images ?? input.output_dir !== undefined;
    const assets = shouldExtractImages
      ? await collectImageAssets(
          parsed.images ?? [],
          input.output_dir,
          filePath,
          warnings,
        )
      : [];
    const metadata: Record<string, unknown> = {
      ...(parsed.metadata ?? {}),
      fileType: parsed.fileType,
    };

    if (parsed.pageCount !== undefined) {
      metadata.pageCount = parsed.pageCount;
    }
    if (parsed.isImageBased !== undefined) {
      metadata.isImageBased = parsed.isImageBased;
    }

    const details: Record<string, unknown> = {
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
    const responseBytes = serializedBytes(successResult);
    if (responseBytes > MAX_MCP_RESPONSE_BYTES) {
      return toolError(
        "The complete result is too large for one MCP response. Read a smaller page/section range with pages.",
        {
          code: "RESPONSE_TOO_LARGE",
          file_path: filePath,
          file_type: parsed.fileType,
          response_bytes: responseBytes,
          maximum_response_bytes: MAX_MCP_RESPONSE_BYTES,
          guidance: "Retry hwp_read with a narrower pages range.",
        },
      );
    }

    if (delivery.outputPath !== undefined) {
      await writeFilesExclusively(
        [{ path: delivery.outputPath, data: parsed.markdown }],
        { sourcePaths: [filePath] },
      );
    }
    return successResult;
  } catch (error: unknown) {
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
    const details: Record<string, unknown> = {
      code,
      error: message,
      file_path: safeResolvedPath(input.file_path),
    };
    const markdownOutputPath = safeResolvedPath(
      input.markdown_output_path,
      "markdown_output_path",
    );
    if (markdownOutputPath !== undefined) {
      details.markdown_output_path = markdownOutputPath;
    }
    return toolError(`Could not read the document: ${message}`, details);
  }
}

export function registerHwpRead(server: McpServer): void {
  server.registerTool(
    HWP_READ_TOOL_NAME,
    {
      title: "Read HWP document",
      description:
        "Read the exact requested local HWP/HWPX document as Markdown with metadata, warnings, and optional extracted images.",
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
          .describe(
            "New local .md path for the complete extracted Markdown; existing files are never overwritten.",
          ),
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
    },
    (args) => handleHwpRead(args),
  );
}

function copyWarnings(warnings: readonly ParseWarning[] | undefined): ReadWarning[] {
  return (warnings ?? []).map((warning) => ({ ...warning }));
}

async function collectImageAssets(
  images: readonly ExtractedImage[],
  outputDir: string | undefined,
  sourceFilePath: string,
  warnings: ReadWarning[],
): Promise<string[]> {
  const filenames = uniqueSafeFilenames(images);

  if (outputDir === undefined) {
    warnings.push({
      code: "IMAGES_NOT_WRITTEN",
      message:
        "extract_images was requested without output_dir; returning image names only, without raw bytes.",
    });
    return filenames;
  }

  const resolvedOutputDir = resolveLocalPath(outputDir, "output_dir");
  const resolvedSourceFilePath = resolveLocalPath(
    sourceFilePath,
    "file_path",
  );
  const outputDirectory = await prepareCanonicalOutputDirectory(
    resolvedOutputDir,
  );
  const paths: string[] = [];

  for (const [index, image] of images.entries()) {
    paths.push(
      await writeImageAssetExclusively(
        image,
        filenames[index]!,
        outputDirectory,
        resolvedSourceFilePath,
      ),
    );
  }

  return paths;
}

interface FileSystemIdentity {
  device: bigint;
  inode: bigint;
}

interface OutputDirectoryIdentity extends FileSystemIdentity {
  path: string;
  realPath: string;
}

class UnsafeOutputDirectoryError extends Error {
  readonly code = "UNSAFE_OUTPUT_DIR";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutputDirectoryError";
  }
}

async function prepareCanonicalOutputDirectory(
  outputDir: string,
): Promise<OutputDirectoryIdentity> {
  await assertNoLinkedExistingComponents(outputDir);
  await mkdir(outputDir, { recursive: true });
  await assertNoLinkedExistingComponents(outputDir);

  const [canonicalPath, stats] = await Promise.all([
    realpath(outputDir),
    stat(outputDir, { bigint: true }),
  ]);

  if (!stats.isDirectory()) {
    throw new UnsafeOutputDirectoryError(
      "output_dir must resolve to a directory.",
    );
  }
  if (comparablePath(canonicalPath) !== comparablePath(outputDir)) {
    throw new UnsafeOutputDirectoryError(
      "output_dir must be a canonical path without symlinks or junctions.",
    );
  }

  return {
    path: outputDir,
    realPath: canonicalPath,
    device: stats.dev,
    inode: stats.ino,
  };
}

async function assertCanonicalDirectoryIdentity(
  expected: OutputDirectoryIdentity,
): Promise<void> {
  await assertNoLinkedExistingComponents(expected.path);
  const [canonicalPath, stats] = await Promise.all([
    realpath(expected.path),
    stat(expected.path, { bigint: true }),
  ]);

  if (
    !stats.isDirectory() ||
    comparablePath(canonicalPath) !== comparablePath(expected.realPath) ||
    comparablePath(canonicalPath) !== comparablePath(expected.path) ||
    stats.dev !== expected.device ||
    stats.ino !== expected.inode
  ) {
    throw new UnsafeOutputDirectoryError(
      "output_dir changed or became non-canonical before asset creation.",
    );
  }
}

async function assertNoLinkedExistingComponents(path: string): Promise<void> {
  for (const component of absolutePathComponents(path)) {
    let stats;
    try {
      stats = await lstat(component);
    } catch (error: unknown) {
      if (errorCode(error, "") === "ENOENT") {
        return;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new UnsafeOutputDirectoryError(
        `output_dir path component is a symlink or junction: ${component}`,
      );
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

async function writeImageAssetExclusively(
  image: ExtractedImage,
  baseFilename: string,
  outputDirectory: OutputDirectoryIdentity,
  sourceFilePath: string,
): Promise<string> {
  let attempt = 1;

  while (true) {
    const filename = filenameForAttempt(baseFilename, attempt);
    const outputPath = resolve(outputDirectory.path, filename);

    if (comparablePath(outputPath) === comparablePath(sourceFilePath)) {
      attempt += 1;
      continue;
    }

    await assertCanonicalDirectoryIdentity(outputDirectory);

    let handle;
    try {
      handle = await open(outputPath, "wx");
    } catch (error: unknown) {
      if (errorCode(error, "") === "EEXIST") {
        attempt += 1;
        continue;
      }
      throw error;
    }

    let closed = false;

    try {
      await handle.stat({ bigint: true });
      await handle.writeFile(new Uint8Array(image.bytes));
      await handle.close();
      closed = true;
      return outputPath;
    } catch (error: unknown) {
      if (!closed) {
        await handle.close().catch(() => undefined);
      }
      // Never delete a failed output by pathname: a concurrent replacement
      // could be removed between any identity check and deletion.
      throw error;
    }
  }
}

function filenameForAttempt(baseFilename: string, attempt: number): string {
  if (attempt === 1) {
    return baseFilename;
  }

  const extension = extname(baseFilename);
  const stem =
    extension.length > 0
      ? baseFilename.slice(0, -extension.length)
      : baseFilename;
  return `${stem}_${attempt}${extension}`;
}

function uniqueSafeFilenames(images: readonly ExtractedImage[]): string[] {
  const used = new Set<string>();

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

function safeFilename(filename: string, mimeType: string, index: number): string {
  const leaf = filename.replaceAll("\\", "/").split("/").at(-1) ?? "";
  let safe = leaf
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_")
    .replace(/[. ]+$/gu, "");

  if (safe.length === 0 || safe === "." || safe === "..") {
    safe = `image_${String(index + 1).padStart(3, "0")}${extensionForMime(mimeType)}`;
  }

  const deviceName = safe.split(".", 1)[0]?.toUpperCase();
  if (
    deviceName !== undefined &&
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceName)
  ) {
    safe = `_${safe}`;
  }

  return safe;
}

function extensionForMime(mimeType: string): string {
  const extensions: Record<string, string> = {
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

function comparableFilename(filename: string): string {
  return process.platform === "win32"
    ? filename.toLocaleLowerCase("en-US")
    : filename;
}

function comparablePath(path: string): string {
  return process.platform === "win32"
    ? path.toLocaleLowerCase("en-US")
    : path;
}

function safeResolvedPath(
  path: unknown,
  label = "file_path",
): string | undefined {
  try {
    return typeof path === "string"
      ? resolveLocalPath(path, label)
      : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
