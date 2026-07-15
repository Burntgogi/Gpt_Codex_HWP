import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  detectFormat,
  detectOle2Format,
  detectZipFormat,
  fillForm,
  fillHwpx,
  fillWithUniqueGuard,
  parse,
  patchHwpx,
  validateHwpx,
  type FileType,
  type FillFormOutput,
  type FillInput,
  type FormField,
  type HwpxFillResult,
  type ParseOptions,
  type ParseResult,
  type PatchOptions,
  type PatchResult,
  type ValidateResult,
} from "kordoc";
import { z } from "zod";

import { writeFilesExclusively } from "../shared/output.js";
import {
  HwpxOutputRequiredError,
  assertHwpxOutputPath,
} from "../shared/document-contract.js";
import { readFileBounded } from "../shared/files.js";
import { resolveLocalPath } from "../shared/paths.js";
import { inspectExactDocumentProtection } from "../shared/protection.js";
import { toolError, toolSuccess } from "../shared/result.js";
import {
  MAX_FILL_VALUES,
  ResourceLimitError,
  assertFillValueBudget,
  sumStringCharacters,
} from "../shared/resource-limits.js";

export const HWP_PATCH_DOCUMENT_TOOL_NAME = "hwp_patch_document";
export const HWP_FILL_FORM_TOOL_NAME = "hwp_fill_form";
const MAX_TEXT_INPUT_CHARACTERS = 5_000_000;

export interface HwpPatchDocumentInput {
  file_path: string;
  edited_markdown: string;
  output_path: string;
  verify?: boolean;
}

export interface HwpFillFormInput {
  file_path: string;
  fields: Record<string, string | string[]>;
  output_path: string;
  formats?: Record<string, string>;
  require_unique?: boolean;
  mask_values?: boolean;
}

export type DetectDocumentFormat = (
  input: ArrayBuffer,
) => Promise<FileType>;

export type ParseDocument = (
  input: string | ArrayBuffer | Buffer,
  options?: ParseOptions,
) => Promise<ParseResult>;

export type PatchDocument = (
  original: Uint8Array,
  editedMarkdown: string,
  options?: PatchOptions,
) => Promise<PatchResult>;

export type ValidateHwpxDocument = (
  input: ArrayBuffer | Uint8Array,
) => Promise<ValidateResult>;

export interface PatchDependencies {
  detectDocumentFormat: DetectDocumentFormat;
  parseDocument: ParseDocument;
  patchHwpxDocument: PatchDocument;
  validateHwpxDocument: ValidateHwpxDocument;
}

export type FillFormDocument = (
  input: string | ArrayBuffer | Buffer,
  values: Record<string, FillInput>,
  outputFormat?: "markdown" | "hwpx" | "hwpx-preserve",
) => Promise<FillFormOutput>;

export type FillHwpxDocument = (
  input: ArrayBuffer,
  values: Record<string, FillInput>,
  blockedLabels?: Set<string>,
) => Promise<HwpxFillResult>;

export interface FillDependencies {
  detectDocumentFormat: DetectDocumentFormat;
  parseDocument: ParseDocument;
  fillFormDocument: FillFormDocument;
  fillHwpxDocument: FillHwpxDocument;
  fillWithUniqueGuard: typeof fillWithUniqueGuard;
  validateHwpxDocument: ValidateHwpxDocument;
}

const defaultPatchDependencies: PatchDependencies = {
  detectDocumentFormat: detectPreciseDocumentFormat,
  parseDocument: parse,
  patchHwpxDocument: patchHwpx,
  validateHwpxDocument: validateHwpx,
};

const defaultFillDependencies: FillDependencies = {
  detectDocumentFormat: detectPreciseDocumentFormat,
  parseDocument: parse,
  fillFormDocument: fillForm,
  fillHwpxDocument: fillHwpx,
  fillWithUniqueGuard,
  validateHwpxDocument: validateHwpx,
};

export async function handleHwpPatchDocument(
  input: HwpPatchDocumentInput,
  dependencyOverrides: Partial<PatchDependencies> = {},
): Promise<CallToolResult> {
  let filePath: string | undefined;
  let outputPath: string | undefined;

  try {
    filePath = resolveLocalPath(input.file_path, "file_path");
    outputPath = resolveLocalPath(input.output_path, "output_path");
    assertHwpxOutputPath(outputPath);
    if (input.verify === false) {
      return toolError("Semantic patch verification is mandatory.", {
        code: "VERIFICATION_REQUIRED",
        file_path: filePath,
        output_path: outputPath,
      });
    }
    if (input.edited_markdown.length > MAX_TEXT_INPUT_CHARACTERS) {
      return toolError("edited_markdown exceeds the safe input limit.", {
        code: "INPUT_TOO_LARGE",
        maximum_characters: MAX_TEXT_INPUT_CHARACTERS,
        actual_characters: input.edited_markdown.length,
      });
    }
    const dependencies = {
      ...defaultPatchDependencies,
      ...dependencyOverrides,
    };
    const sourceBytes = await readFileBounded(filePath, "source document");
    const exactBuffer = toExactArrayBuffer(sourceBytes);
    const format = await dependencies.detectDocumentFormat(exactBuffer);

    if (format === "hwp") {
      return toolError(
        "Binary HWP is read-only in hwp_patch_document. Read the source and create or edit an HWPX document instead.",
        {
          code: "HWP_READ_ONLY",
          file_path: filePath,
          output_path: outputPath,
          format,
        },
      );
    }
    if (format !== "hwpx") {
      return toolError(
        `Document patching supports only HWPX files (detected: ${format}).`,
        {
          code: "UNSUPPORTED_PATCH_FORMAT",
          file_path: filePath,
          output_path: outputPath,
          format,
        },
      );
    }

    const exactProtection = await inspectExactDocumentProtection(
      sourceBytes,
      format,
    );
    if (exactProtection !== undefined) {
      return toolError(
        `Cannot patch the protected document: ${exactProtection.error}`,
        {
          code: exactProtection.code,
          error: exactProtection.error,
          file_path: filePath,
          output_path: outputPath,
          format,
        },
      );
    }

    const preflight = await dependencies.parseDocument(exactBuffer);
    if (!preflight.success) {
      return toolError(`Cannot patch the document: ${preflight.error}`, {
        code: preflight.code ?? "PARSE_ERROR",
        error: preflight.error,
        file_path: filePath,
        output_path: outputPath,
        format,
      });
    }

    const patchResult = await dependencies.patchHwpxDocument(new Uint8Array(exactBuffer), input.edited_markdown, {
      verify: true,
    });
    if (!patchResult.success || patchResult.data === undefined) {
      return patchFailure(patchResult, filePath, outputPath, format);
    }

    const complete = patchIsComplete(patchResult);
    if (!complete) {
      return toolError(
        `Patch was incomplete because edits were skipped or remained after verification; no output was written.`,
        {
          code: "PATCH_INCOMPLETE",
          file_path: filePath,
          output_path: outputPath,
          format,
          applied: patchResult.applied,
          skipped: patchResult.skipped,
          verification: patchResult.verification ?? null,
          complete: false,
        },
      );
    }

    const validation = await dependencies.validateHwpxDocument(
      patchResult.data,
    );
    if (!validation.ok) {
      return toolError(
        "Patched HWPX failed structural validation; no output was written.",
        {
          code: "HWPX_VALIDATION_FAILED",
          file_path: filePath,
          output_path: outputPath,
          format,
          validation,
        },
      );
    }

    await writeFilesExclusively(
      [{ path: outputPath, data: patchResult.data }],
      { sourcePaths: [filePath] },
    );

    return toolSuccess(
      "Patched and semantically verified the HWPX document.",
      {
        output_path: outputPath,
        format,
        applied: patchResult.applied,
        skipped: patchResult.skipped,
        verification: patchResult.verification ?? null,
        complete,
      },
    );
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (error instanceof HwpxOutputRequiredError) {
      return toolError("HWPX output is required.", {
        code: error.code,
        error: message,
      });
    }
    return toolError(`Could not patch the document: ${message}`, {
      code: errorCode(error, "PATCH_ERROR"),
      error: message,
      file_path: filePath ?? safeResolvedPath(input.file_path),
      output_path: outputPath ?? safeResolvedPath(input.output_path),
    });
  }
}

export async function handleHwpFillForm(
  input: HwpFillFormInput,
  dependencyOverrides: Partial<FillDependencies> = {},
): Promise<CallToolResult> {
  let filePath: string | undefined;
  let outputPath: string | undefined;

  try {
    filePath = resolveLocalPath(input.file_path, "file_path");
    outputPath = resolveLocalPath(input.output_path, "output_path");
    assertHwpxOutputPath(outputPath);
    try {
      assertFillValueBudget(input.fields);
    } catch (error: unknown) {
      if (error instanceof ResourceLimitError) {
        return toolError("Form fields exceed the safe input limit.", {
          code: error.code,
          maximum_values: error.maximum,
          actual_values_at_least: error.actualAtLeast,
        });
      }
      throw error;
    }
    const fieldCharacters = sumStringCharacters(
      fieldStringValues(input.fields),
      MAX_TEXT_INPUT_CHARACTERS,
    );
    if (
      Object.keys(input.fields).length > 10_000 ||
      fieldCharacters > MAX_TEXT_INPUT_CHARACTERS
    ) {
      return toolError("Form fields exceed the safe input limit.", {
        code: "INPUT_TOO_LARGE",
        maximum_fields: 10_000,
        maximum_characters: MAX_TEXT_INPUT_CHARACTERS,
      });
    }
    const dependencies = {
      ...defaultFillDependencies,
      ...dependencyOverrides,
    };
    const sourceBytes = await readFileBounded(filePath, "source document");
    const exactBuffer = toExactArrayBuffer(sourceBytes);
    const format = await dependencies.detectDocumentFormat(exactBuffer);

    if (format === "hwpx" || format === "hwp") {
      const exactProtection = await inspectExactDocumentProtection(
        sourceBytes,
        format,
      );
      if (exactProtection !== undefined) {
        return toolError(
          `Cannot fill the protected document: ${exactProtection.error}`,
          {
            code: exactProtection.code,
            error: exactProtection.error,
            file_path: filePath,
            output_path: outputPath,
            format,
          },
        );
      }
    }

    if (format === "hwp") {
      return toolError(
        "Preserve-form filling is not supported for binary HWP. Read the source and create or edit an HWPX document instead.",
        {
          code: "UNSUPPORTED_HWP_PRESERVE_FILL",
          file_path: filePath,
          output_path: outputPath,
          format,
        },
      );
    }
    if (format !== "hwpx") {
      return toolError(
        `Preserve-form filling supports only HWPX files (detected: ${format}).`,
        {
          code: "UNSUPPORTED_FILL_FORMAT",
          file_path: filePath,
          output_path: outputPath,
          format,
        },
      );
    }

    const preflight = await dependencies.parseDocument(exactBuffer);
    if (!preflight.success) {
      const safeError = redactFieldValues(preflight.error, input.fields);
      return toolError(`Cannot fill the document: ${safeError}`, {
        code: safeFillErrorCode(preflight.code, "PARSE_ERROR", input.fields),
        error: safeError,
        file_path: filePath,
        output_path: outputPath,
        format,
      });
    }

    const inputs = buildFillInputs(input.fields, input.formats);
    let filled: FormField[];
    let unmatched: string[];
    let rejected: string[];
    let filledBuffer: ArrayBuffer;
    if (input.require_unique === true) {
      const guarded = await dependencies.fillWithUniqueGuard(
        inputs,
        (values, blockedLabels) =>
          dependencies.fillHwpxDocument(
            exactBuffer,
            values,
            blockedLabels,
          ),
      );
      filled = guarded.filled;
      unmatched = guarded.unmatched;
      rejected = guarded.rejected;
      filledBuffer = guarded.buffer;
    } else {
      const fillResult = await dependencies.fillFormDocument(
        exactBuffer,
        inputs,
        "hwpx-preserve",
      );
      if (
        fillResult.format !== "hwpx-preserve" ||
        typeof fillResult.output === "string"
      ) {
        return toolError(
          "Preserve-form fill returned an unexpected output format; no output was written.",
          {
            code: "FILL_OUTPUT_INVALID",
            file_path: filePath,
            output_path: outputPath,
            format: fillResult.format,
          },
        );
      }
      filled = fillResult.fill.filled;
      unmatched = fillResult.fill.unmatched;
      rejected = [];
      filledBuffer = fillResult.output;
    }

    const validation = await dependencies.validateHwpxDocument(
      filledBuffer,
    );
    const presentedValidation = redactValidation(validation, input.fields);
    if (!validation.ok) {
      return toolError(
        "Filled HWPX failed structural validation; no output was written.",
        {
          code: "HWPX_VALIDATION_FAILED",
          file_path: filePath,
          output_path: outputPath,
          validation: presentedValidation,
        },
      );
    }
    const reparsed = await dependencies.parseDocument(filledBuffer);
    if (!reparsed.success) {
      const safeError = redactFieldValues(reparsed.error, input.fields);
      return toolError(
        `Filled HWPX could not be reparsed; no output was written: ${safeError}`,
        {
          code: "FILL_VERIFICATION_FAILED",
          error: safeError,
          file_path: filePath,
          output_path: outputPath,
        },
      );
    }

    await writeFilesExclusively(
      [{ path: outputPath, data: new Uint8Array(filledBuffer) }],
      { sourcePaths: [filePath] },
    );

    return toolSuccess(`Filled ${filled.length} HWPX fields.`, {
      output_path: outputPath,
      filled: presentFilledFields(filled, input.mask_values !== false),
      unmatched,
      rejected,
      validation: presentedValidation,
    });
  } catch (error: unknown) {
    const message = redactFieldValues(errorMessage(error), input.fields);
    if (error instanceof HwpxOutputRequiredError) {
      return toolError("HWPX output is required.", {
        code: error.code,
        error: message,
      });
    }
    return toolError(`Could not fill the HWPX form: ${message}`, {
      code: safeFillErrorCode(errorCode(error, "FILL_ERROR"), "FILL_ERROR", input.fields),
      error: message,
      file_path: filePath ?? safeResolvedPath(input.file_path),
      output_path: outputPath ?? safeResolvedPath(input.output_path),
    });
  }
}

export function registerHwpPatchDocument(server: McpServer): void {
  server.registerTool(
    HWP_PATCH_DOCUMENT_TOOL_NAME,
    {
      title: "Patch an HWPX document",
      description:
        "Apply edited Markdown to a new HWPX file while preserving the source document; binary HWP input is read-only.",
      inputSchema: {
        file_path: z.string().min(1),
        edited_markdown: z.string().min(1).max(MAX_TEXT_INPUT_CHARACTERS),
        output_path: z.string().min(1),
      },
      annotations: { readOnlyHint: false },
    },
    (args) => handleHwpPatchDocument(args),
  );
}

export function registerHwpFillForm(server: McpServer): void {
  server.registerTool(
    HWP_FILL_FORM_TOOL_NAME,
    {
      title: "Fill an HWPX form",
      description:
        "Fill labelled fields into a new HWPX file while preserving the source document and its formatting.",
      inputSchema: {
        file_path: z.string().min(1),
        fields: z.record(
          z.string(),
          z.union([
            z.string().max(MAX_TEXT_INPUT_CHARACTERS),
            z
              .array(z.string().max(MAX_TEXT_INPUT_CHARACTERS))
              .min(1)
              .max(MAX_FILL_VALUES),
          ]),
        ),
        output_path: z.string().min(1),
        formats: z.record(z.string(), z.string()).optional(),
        require_unique: z.boolean().optional(),
        mask_values: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    (args) => handleHwpFillForm(args),
  );
}

function patchFailure(
  result: PatchResult,
  filePath: string,
  outputPath: string,
  format: string,
): CallToolResult {
  return toolError(`Document patch failed: ${result.error ?? "unknown error"}`, {
    code: "PATCH_FAILED",
    error: result.error ?? "unknown error",
    file_path: filePath,
    output_path: outputPath,
    format,
    applied: result.applied,
    skipped: result.skipped,
    verification: result.verification ?? null,
  });
}

function buildFillInputs(
  fields: Record<string, string | string[]>,
  formats?: Record<string, string>,
): Record<string, FillInput> {
  return Object.fromEntries(
    Object.entries(fields).map(([label, value]) => {
      const format = formats?.[label];
      return [label, format === undefined ? value : { value, format }];
    }),
  );
}

function redactFieldValues(
  message: string,
  fields: Record<string, string | string[]>,
): string {
  let redacted = message;
  for (const value of fieldStringValues(fields)) {
    if (value.length > 0) {
      redacted = redacted.replaceAll(value, "[REDACTED]");
    }
  }
  return redacted;
}

function* fieldStringValues(
  fields: Readonly<Record<string, string | readonly string[]>>,
): Generator<string> {
  for (const value of Object.values(fields)) {
    if (typeof value === "string") {
      yield value;
    } else {
      yield* value;
    }
  }
}

function redactValidation(
  validation: ValidateResult,
  fields: Record<string, string | string[]>,
): ValidateResult {
  return {
    ...validation,
    issues: validation.issues.map((issue) => ({
      ...issue,
      path:
        issue.path === undefined
          ? undefined
          : redactFieldValues(issue.path, fields),
      message: redactFieldValues(issue.message, fields),
    })),
  };
}

function safeFillErrorCode(
  value: unknown,
  fallback: string,
  fields: Record<string, string | string[]>,
): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const redacted = redactFieldValues(value, fields);
  return redacted.includes("[REDACTED]") || !/^[A-Z0-9_]{1,128}$/u.test(redacted)
    ? fallback
    : redacted;
}

function presentFilledFields(
  filled: FormField[],
  maskValues: boolean,
): Array<FormField | Omit<FormField, "value"> & { value_length: number }> {
  if (!maskValues) {
    return filled;
  }
  return filled.map(({ value, ...field }) => ({
    ...field,
    value_length: [...value].length,
  }));
}

async function detectPreciseDocumentFormat(
  buffer: ArrayBuffer,
): Promise<FileType> {
  const initialFormat = detectFormat(buffer);
  if (initialFormat === "hwpx") {
    return detectZipFormat(buffer);
  }
  if (initialFormat === "hwp") {
    return detectOle2Format(buffer);
  }
  return initialFormat;
}

function patchIsComplete(result: PatchResult): boolean {
  const stats = result.verification?.stats;
  return (
    result.skipped.length === 0 &&
    stats !== undefined &&
    stats.added === 0 &&
    stats.removed === 0 &&
    stats.modified === 0
  );
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function safeResolvedPath(path: unknown): string | undefined {
  try {
    return typeof path === "string" ? resolveLocalPath(path) : undefined;
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
