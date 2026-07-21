import {
  lstat,
} from "node:fs/promises";
import { extname, resolve } from "node:path";

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
  authorizeExistingPath,
  authorizeFuturePath,
} from "../shared/allowed-roots.js";
import {
  MarkdownDeliveryError,
  planMarkdownDelivery,
  type MarkdownDeliveryPlan,
} from "../shared/markdown-output.js";
import {
  captureExistingOutputDirectoryIdentity,
  UnsafeOutputPathError,
  writeFilesExclusively,
  type ExclusiveOutputFile,
  type OutputDirectoryIdentity,
} from "../shared/output.js";
import {
  commitBudgetedToolSuccess,
  toolError,
} from "../shared/result.js";
import {
  requireToolNotCancelled,
  runWithToolExecutionContext,
  toDocumentEngineExecutionContext,
  type ToolExecutionContext,
} from "../shared/tool-context.js";
import { maxWorkerSnapshotBytesForRequest } from "../workers/document-execution-policy.js";
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
  context?: ToolExecutionContext,
): Promise<CallToolResult> {
  let filePath: string;

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
      } finally {
        await snapshot.cleanup();
      }
    }
    const engineResult = await documentEngine.parse(
      snapshot,
      parseOptions,
      toDocumentEngineExecutionContext(context),
    );
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
    const plannedAssets = shouldExtractImages
      ? await planImageAssets(
          parsed.images ?? [],
          input.output_dir,
          filePath,
          warnings,
          context,
        )
      : EMPTY_IMAGE_ASSET_PLAN;
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
      assets: plannedAssets.assets,
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
    return await commitBudgetedToolSuccess(summary, details, async () => {
      const files: ExclusiveOutputFile[] = [
        ...plannedAssets.files,
        ...(delivery.outputPath === undefined
          ? []
          : [{ path: delivery.outputPath, data: parsed.markdown }]),
      ];
      if (files.length === 0) {
        requireToolNotCancelled(context);
        await engineResult.verifySourceUnchanged();
        requireToolNotCancelled(context);
        return;
      }
      await writeFilesExclusively(
        files,
        {
          sourcePaths: [filePath],
          beforeOpen: async () => {
            await engineResult.verifySourceUnchanged();
            requireToolNotCancelled(context);
          },
          ...(plannedAssets.existingDirectoryIdentity === undefined
            ? {}
            : {
                expectedDirectoryIdentities: [
                  plannedAssets.existingDirectoryIdentity,
                ],
              }),
        },
      );
    });
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

export function registerHwpRead(
  server: McpServer,
  documentEngine: DocumentEngineFacade = defaultDocumentEngineFacade,
): void {
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
    (args, extra) => runWithToolExecutionContext(
      extra,
      (context) => handleHwpRead(args, documentEngine, context),
    ),
  );
}

function copyWarnings(warnings: readonly ParseWarning[] | undefined): ReadWarning[] {
  return (warnings ?? []).map((warning) => ({ ...warning }));
}

interface PlannedImageAssets {
  readonly assets: readonly string[];
  readonly files: readonly ExclusiveOutputFile[];
  readonly existingDirectoryIdentity?: OutputDirectoryIdentity;
}

const EMPTY_IMAGE_ASSET_PLAN: PlannedImageAssets = Object.freeze({
  assets: Object.freeze([]),
  files: Object.freeze([]),
});

async function planImageAssets(
  images: readonly ExtractedImage[],
  outputDir: string | undefined,
  sourceFilePath: string,
  warnings: ReadWarning[],
  context?: ToolExecutionContext,
): Promise<PlannedImageAssets> {
  const filenames = uniqueSafeFilenames(images);

  if (outputDir === undefined) {
    warnings.push({
      code: "IMAGES_NOT_WRITTEN",
      message:
        "extract_images was requested without output_dir; returning image names only, without raw bytes.",
    });
    return { assets: filenames, files: [] };
  }

  requireToolNotCancelled(context);
  if (images.length === 0) return EMPTY_IMAGE_ASSET_PLAN;

  const resolvedOutputDir = await authorizeFuturePath(
    resolveLocalPath(outputDir, "output_dir"),
  );
  const resolvedSourceFilePath = await authorizeExistingPath(
    resolveLocalPath(sourceFilePath, "file_path"),
  );
  let existingDirectoryIdentity: OutputDirectoryIdentity | undefined;
  try {
    existingDirectoryIdentity = await captureExistingOutputDirectoryIdentity(
      resolvedOutputDir,
    );
  } catch (error: unknown) {
    if (error instanceof UnsafeOutputPathError) {
      throw new UnsafeOutputDirectoryError(error.message);
    }
    throw error;
  }
  const paths: string[] = [];
  const files: ExclusiveOutputFile[] = [];
  const reserved = new Set<string>();

  for (const [index, image] of images.entries()) {
    let attempt = 1;
    while (true) {
      const filename = filenameForAttempt(filenames[index]!, attempt);
      const outputPath = await authorizeFuturePath(
        resolve(resolvedOutputDir, filename),
      );
      const key = comparablePath(outputPath);
      if (key === comparablePath(resolvedSourceFilePath) ||
        reserved.has(key) || await outputPathExists(outputPath)) {
        attempt += 1;
        continue;
      }
      reserved.add(key);
      paths.push(outputPath);
      files.push({ path: outputPath, data: new Uint8Array(image.bytes) });
      break;
    }
  }

  return {
    assets: paths,
    files,
    ...(existingDirectoryIdentity === undefined
      ? {}
      : { existingDirectoryIdentity }),
  };
}

class UnsafeOutputDirectoryError extends Error {
  readonly code = "UNSAFE_OUTPUT_DIR";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutputDirectoryError";
  }
}

async function outputPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error, "") === "ENOENT") return false;
    throw error;
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
