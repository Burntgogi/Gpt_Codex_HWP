import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  markdownToHwpx,
  renderHwpxToSvg,
  validateHwpx,
  type GongmunPreset,
  type MarkdownToHwpxOptions,
  type RenderSvgOptions,
  type RenderSvgResult,
  type ValidateResult,
} from "kordoc";
import { z } from "zod";

import {
  HwpxFontReferenceError,
  inspectHwpxFontReferences,
  normalizeGeneratedFontReferences,
  type FontNormalizationResult,
  type FontReferenceInspection,
} from "../shared/hwpx-font-integrity.js";
import {
  HwpxOutputRequiredError,
  assertHwpxOutputPath,
} from "../shared/document-contract.js";
import { writeFilesExclusively } from "../shared/output.js";
import { readFileBounded } from "../shared/files.js";
import { resolveLocalPath } from "../shared/paths.js";
import { inspectExactDocumentProtection } from "../shared/protection.js";
import { toolError, toolSuccess } from "../shared/result.js";
import { detectPreciseDocumentFormat } from "./rhwp-backend.js";

export const HWP_GENERATE_HWPX_TOOL_NAME = "hwp_generate_hwpx";
export const HWP_VALIDATE_TOOL_NAME = "hwp_validate";
const MAX_MARKDOWN_INPUT_CHARACTERS = 5_000_000;

export interface HwpGenerateHwpxInput {
  markdown: string;
  output_path: string;
  preset?: GongmunPreset;
  validate?: boolean;
  preview_svg_path?: string;
}

export interface HwpValidateInput {
  file_path: string;
}

export type GenerateHwpx = (
  markdown: string,
  options?: MarkdownToHwpxOptions,
) => Promise<ArrayBuffer>;

export type ValidateDocument = (
  input: ArrayBuffer | Uint8Array,
) => Promise<ValidateResult>;

export type RenderDocument = (
  input: ArrayBuffer | Uint8Array,
  options?: RenderSvgOptions,
) => Promise<RenderSvgResult>;

export type NormalizeFonts = (
  input: ArrayBuffer | Uint8Array,
) => Promise<FontNormalizationResult>;

export type InspectFonts = (
  input: ArrayBuffer | Uint8Array,
) => Promise<FontReferenceInspection>;

export interface GenerationDependencies {
  markdownToHwpx: GenerateHwpx;
  normalizeGeneratedFontReferences: NormalizeFonts;
  inspectHwpxFontReferences: InspectFonts;
  validateHwpx: ValidateDocument;
  renderHwpxToSvg: RenderDocument;
}

const defaultDependencies: GenerationDependencies = {
  markdownToHwpx,
  normalizeGeneratedFontReferences,
  inspectHwpxFontReferences,
  validateHwpx,
  renderHwpxToSvg,
};

export async function handleHwpGenerateHwpx(
  input: HwpGenerateHwpxInput,
  dependencyOverrides: Partial<GenerationDependencies> = {},
): Promise<CallToolResult> {
  let outputPath: string | undefined;
  let previewPath: string | undefined;

  try {
    outputPath = resolveLocalPath(input.output_path, "output_path");
    assertHwpxOutputPath(outputPath);
    previewPath =
      input.preview_svg_path === undefined
        ? undefined
        : resolveLocalPath(input.preview_svg_path, "preview_svg_path");
    if (input.markdown.length > MAX_MARKDOWN_INPUT_CHARACTERS) {
      return toolError("Markdown exceeds the safe generation input limit.", {
        code: "INPUT_TOO_LARGE",
        maximum_characters: MAX_MARKDOWN_INPUT_CHARACTERS,
        actual_characters: input.markdown.length,
      });
    }
    if (input.validate === false) {
      return toolError(
        "Generated HWPX must pass structural validation before it can be written.",
        {
          code: "VALIDATION_REQUIRED",
          output_path: outputPath,
          preview_svg_path: previewPath,
        },
      );
    }
    const dependencies = { ...defaultDependencies, ...dependencyOverrides };
    const generationOptions: MarkdownToHwpxOptions | undefined =
      input.preset === undefined
        ? undefined
        : { gongmun: { preset: input.preset } };
    const rawGenerated = await dependencies.markdownToHwpx(
      input.markdown,
      generationOptions,
    );
    const normalized = await dependencies.normalizeGeneratedFontReferences(
      rawGenerated,
    );
    const generated = normalized.bytes;

    const checked = await dependencies.validateHwpx(generated);
    const validation = validationDetails(checked);
    if (!checked.ok) {
      return toolError(
        "Generated HWPX failed structural validation; no artifact was written.",
        {
          code: "HWPX_VALIDATION_FAILED",
          output_path: outputPath,
          validation,
        },
      );
    }
    const fontInspection = await dependencies.inspectHwpxFontReferences(
      generated,
    );
    if (fontInspection.issues.length > 0) {
      throw new HwpxFontReferenceError(
        "Generated HWPX still has invalid font references after normalization.",
        fontInspection.issues,
      );
    }

    const preview =
      previewPath === undefined
        ? undefined
        : await dependencies.renderHwpxToSvg(generated, { reflow: true });

    const files: Array<{ path: string; data: string | Uint8Array }> = [
      { path: outputPath, data: new Uint8Array(generated) },
    ];
    if (previewPath !== undefined && preview !== undefined) {
      files.push({ path: previewPath, data: preview.svg });
    }
    await writeFilesExclusively(files);

    const details: Record<string, unknown> = {
      output_path: outputPath,
      validation,
      font_normalization: {
        changed: normalized.changed,
        changed_reference_count: normalized.changed_reference_count,
      },
    };
    if (previewPath !== undefined && preview !== undefined) {
      details.preview_svg_path = previewPath;
      details.preview = previewDetails(preview);
    }

    return toolSuccess("Generated HWPX document.", details);
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (error instanceof HwpxOutputRequiredError) {
      return toolError("HWPX output is required.", {
        code: error.code,
        error: message,
      });
    }
    if (error instanceof HwpxFontReferenceError) {
      return toolError(`Could not normalize HWPX font references: ${message}`, {
        code: error.code,
        error: message,
        issues: error.issues.map((issue) => ({ ...issue })),
        output_path: outputPath ?? safeResolvedPath(input.output_path),
        preview_svg_path:
          previewPath ?? safeResolvedPath(input.preview_svg_path),
      });
    }
    return toolError(`Could not generate the HWPX document: ${message}`, {
      code: errorCode(error, "HWPX_GENERATION_ERROR"),
      error: message,
      output_path: outputPath ?? safeResolvedPath(input.output_path),
      preview_svg_path:
        previewPath ?? safeResolvedPath(input.preview_svg_path),
    });
  }
}

export async function handleHwpValidate(
  input: HwpValidateInput,
  validateDocument: ValidateDocument = validateHwpx,
  inspectFontReferences: InspectFonts = inspectHwpxFontReferences,
): Promise<CallToolResult> {
  let filePath: string | undefined;

  try {
    filePath = resolveLocalPath(input.file_path, "file_path");
    const bytes = await readFileBounded(filePath, "source document");
    const preciseFormat = await detectPreciseDocumentFormat(
      exactArrayBuffer(bytes),
    );
    if (preciseFormat === "hwp" || preciseFormat === "hwpx") {
      const protection = await inspectExactDocumentProtection(
        bytes,
        preciseFormat,
      );
      if (protection !== undefined) {
        return toolError(
          `Could not validate the protected document: ${protection.error}`,
          {
            code: protection.code,
            error: protection.error,
            file_path: filePath,
            format: preciseFormat,
          },
        );
      }
    }
    const validation = await validateDocument(bytes);
    const fontIssues = preciseFormat === "hwpx" && validation.ok
      ? (await inspectFontReferences(bytes)).issues
      : [];
    const issues = [
      ...validation.issues.map((issue) => ({ ...issue })),
      ...fontIssues.map((issue) => ({ ...issue })),
    ];
    const ok = validation.ok && issues.length === 0;
    return toolSuccess(
      ok
        ? "HWPX structure is valid."
        : "HWPX structure has validation issues.",
      {
        file_path: filePath,
        ok,
        issues,
        entry_count: validation.entryCount,
      },
    );
  } catch (error: unknown) {
    const message = errorMessage(error);
    return toolError(`Could not validate the HWPX document: ${message}`, {
      code: errorCode(error, "HWPX_VALIDATION_ERROR"),
      error: message,
      file_path: filePath ?? safeResolvedPath(input.file_path),
    });
  }
}

export function registerHwpGenerateHwpx(server: McpServer): void {
  server.registerTool(
    HWP_GENERATE_HWPX_TOOL_NAME,
    {
      title: "Generate HWPX document",
      description:
        "Generate a new HWPX document from Markdown, optionally applying a Korean public-document preset and producing an SVG preview.",
      inputSchema: {
        markdown: z
          .string()
          .min(1)
          .max(MAX_MARKDOWN_INPUT_CHARACTERS)
          .describe("Markdown document content."),
        output_path: z
          .string()
          .min(1)
          .describe("New local .hwpx path; existing files are never overwritten."),
        preset: z
          .enum(["official", "report", "plan", "notice", "minutes"])
          .optional()
          .describe("Optional Korean public-document formatting preset."),
        validate: z
          .literal(true)
          .optional()
          .describe("Validation is mandatory; omit this field or pass true."),
        preview_svg_path: z
          .string()
          .min(1)
          .optional()
          .describe("Optional new local SVG preview path."),
      },
      annotations: {
        readOnlyHint: false,
      },
    },
    (args) => handleHwpGenerateHwpx(args),
  );
}

export function registerHwpValidate(server: McpServer): void {
  server.registerTool(
    HWP_VALIDATE_TOOL_NAME,
    {
      title: "Validate HWPX structure",
      description:
        "Validate the ZIP and XML structure of the exact requested local HWPX file.",
      inputSchema: {
        file_path: z.string().min(1).describe("Local HWPX path to validate."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    (args) => handleHwpValidate(args),
  );
}

function validationDetails(validation: ValidateResult): Record<string, unknown> {
  return {
    ok: validation.ok,
    issues: validation.issues.map((issue) => ({ ...issue })),
    entry_count: validation.entryCount,
  };
}

function previewDetails(preview: RenderSvgResult): Record<string, unknown> {
  return {
    page_count: preview.pageCount,
    dimensions: {
      width: preview.width,
      height: preview.height,
    },
    warnings: [...preview.warnings],
    stats: { ...preview.stats },
  };
}

function safeResolvedPath(path: unknown): string | undefined {
  try {
    return typeof path === "string"
      ? resolveLocalPath(path, "path")
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

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = Uint8Array.from(bytes);
  return copy.buffer;
}
