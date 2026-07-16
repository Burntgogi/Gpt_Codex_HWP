import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  HwpxOutputRequiredError,
  assertHwpxOutputPath,
} from "../shared/document-contract.js";
import {
  defaultDocumentEngineFacade,
  type DocumentEngineFacade,
} from "../shared/document-engine.js";
import { openDocumentSnapshot } from "../shared/document-snapshot.js";
import { resolveLocalPath } from "../shared/paths.js";
import { toolError, toolSuccess } from "../shared/result.js";
import {
  runWithToolExecutionContext,
  toDocumentEngineExecutionContext,
  type ToolExecutionContext,
} from "../shared/tool-context.js";
import {
  MAX_FILL_VALUES,
  ResourceLimitError,
  assertFillValueBudget,
  sumStringCharacters,
} from "../shared/resource-limits.js";
import type {
  DocumentResultPayload,
  SafeJsonValue,
} from "../workers/document-protocol.js";
import { maxWorkerSnapshotBytesForRequest } from "../workers/document-execution-policy.js";

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

export async function handleHwpPatchDocument(
  input: HwpPatchDocumentInput,
  facade: DocumentEngineFacade = defaultDocumentEngineFacade,
  context?: ToolExecutionContext,
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
    const snapshot = await openDocumentSnapshot(filePath, {
      workerInputMaxBytes: maxWorkerSnapshotBytesForRequest({
        input: { markdown: input.edited_markdown },
        options: {},
      }),
    });
    const format = snapshot.metadata.shallowFormat.candidate;

    if (format === "hwp") {
      await closeUnconsumedSnapshot(snapshot);
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
      await closeUnconsumedSnapshot(snapshot);
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

    const patchResult = await facade.patch(
      snapshot,
      input.edited_markdown,
      toDocumentEngineExecutionContext(context),
    );
    try {
      const metadata = readPatchMetadata(patchResult.resultMetadata);
      const complete = patchIsComplete(metadata);
      if (!complete) {
        return toolError(
          `Patch was incomplete because edits were skipped or remained after verification; no output was written.`,
          {
            code: "PATCH_INCOMPLETE",
            file_path: filePath,
            output_path: outputPath,
            format,
            applied: metadata.applied,
            skipped: metadata.skipped,
            verification: metadata.verification,
            complete: false,
          },
        );
      }

      const validation = patchResult.validation;
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

      await patchResult.writeOutputExclusively(outputPath, {
        sourcePaths: [filePath],
      });

      return toolSuccess(
        "Patched and semantically verified the HWPX document.",
        {
          output_path: outputPath,
          format,
          applied: metadata.applied,
          skipped: metadata.skipped,
          verification: metadata.verification,
          complete,
        },
      );
    } finally {
      await patchResult.cleanup();
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (error instanceof HwpxOutputRequiredError) {
      return toolError("HWPX output is required.", {
        code: error.code,
        error: message,
      });
    }
    if (errorCode(error, "PATCH_ERROR") === "UNSUPPORTED_FORMAT") {
      return toolError(
        "Document patching supports only HWPX files (detected: unknown).",
        {
          code: "UNSUPPORTED_PATCH_FORMAT",
          file_path: filePath ?? safeResolvedPath(input.file_path),
          output_path: outputPath ?? safeResolvedPath(input.output_path),
          format: "unknown",
        },
      );
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
  facade: DocumentEngineFacade = defaultDocumentEngineFacade,
  context?: ToolExecutionContext,
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
    const fillOptions = {
      ...(input.formats === undefined ? {} : { formats: input.formats }),
      ...(input.require_unique === undefined
        ? {}
        : { requireUnique: input.require_unique }),
    };
    const snapshot = await openDocumentSnapshot(filePath, {
      workerInputMaxBytes: maxWorkerSnapshotBytesForRequest({
        input: { fields: input.fields },
        options: fillOptions,
      }),
    });
    const format = snapshot.metadata.shallowFormat.candidate;

    if (format === "hwp") {
      await closeUnconsumedSnapshot(snapshot);
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
      await closeUnconsumedSnapshot(snapshot);
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

    const fillResult = await facade.fill(
      snapshot,
      input.fields,
      fillOptions,
      toDocumentEngineExecutionContext(context),
    );
    try {
      const metadata = readFillMetadata(fillResult.resultMetadata);
      const { filled, unmatched, rejected } = metadata;
      const validation = fillResult.validation;
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

      await fillResult.writeOutputExclusively(outputPath, {
        sourcePaths: [filePath],
      });

      return toolSuccess(`Filled ${filled.length} HWPX fields.`, {
        output_path: outputPath,
        filled_count: filled.length,
        filled: presentFilledFields(filled, input.mask_values !== false),
        unmatched,
        rejected,
        validation: presentedValidation,
      });
    } finally {
      await fillResult.cleanup();
    }
  } catch (error: unknown) {
    const message = redactFieldValues(errorMessage(error), input.fields);
    if (error instanceof HwpxOutputRequiredError) {
      return toolError("HWPX output is required.", {
        code: error.code,
        error: message,
      });
    }
    if (errorCode(error, "FILL_ERROR") === "UNSUPPORTED_FORMAT") {
      return toolError(
        "Preserve-form filling supports only HWPX files (detected: unknown).",
        {
          code: "UNSUPPORTED_FILL_FORMAT",
          file_path: filePath ?? safeResolvedPath(input.file_path),
          output_path: outputPath ?? safeResolvedPath(input.output_path),
          format: "unknown",
        },
      );
    }
    return toolError(`Could not fill the HWPX form: ${message}`, {
      code: safeFillErrorCode(errorCode(error, "FILL_ERROR"), "FILL_ERROR", input.fields),
      error: message,
      file_path: filePath ?? safeResolvedPath(input.file_path),
      output_path: outputPath ?? safeResolvedPath(input.output_path),
    });
  }
}

export function registerHwpPatchDocument(
  server: McpServer,
  facade: DocumentEngineFacade = defaultDocumentEngineFacade,
): void {
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
    (args, extra) => runWithToolExecutionContext(
      extra,
      (context) => handleHwpPatchDocument(args, facade, context),
    ),
  );
}

export function registerHwpFillForm(
  server: McpServer,
  facade: DocumentEngineFacade = defaultDocumentEngineFacade,
): void {
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
    (args, extra) => runWithToolExecutionContext(
      extra,
      (context) => handleHwpFillForm(args, facade, context),
    ),
  );
}

interface PatchMetadata {
  readonly applied: number;
  readonly skipped: readonly SafeJsonValue[];
  readonly verification: SafeJsonValue | null;
}

interface FilledField extends Readonly<Record<string, SafeJsonValue>> {
  readonly label: string;
  readonly value: string;
}

interface FillMetadata {
  readonly filled: readonly FilledField[];
  readonly unmatched: readonly string[];
  readonly rejected: readonly string[];
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
  validation: DocumentResultPayload<"validateHwpx">,
  fields: Record<string, string | string[]>,
): DocumentResultPayload<"validateHwpx"> {
  return {
    ...validation,
    issues: validation.issues.map((issue) => ({
      ...issue,
      entry:
        issue.entry === undefined
          ? undefined
          : redactFieldValues(issue.entry, fields),
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
  filled: readonly FilledField[],
  maskValues: boolean,
): Array<FilledField | (Omit<FilledField, "value"> & { value_length: number })> {
  if (!maskValues) {
    return [...filled];
  }
  return filled.map(({ value, ...field }) => ({
    ...field,
    value_length: [...value].length,
  }));
}

function patchIsComplete(result: PatchMetadata): boolean {
  const verification = result.verification;
  const stats = isRecord(verification) && isRecord(verification.stats)
    ? verification.stats
    : undefined;
  return (
    result.skipped.length === 0 &&
    stats !== undefined &&
    stats.added === 0 &&
    stats.removed === 0 &&
    stats.modified === 0
  );
}

function readPatchMetadata(metadata: SafeJsonValue | undefined): PatchMetadata {
  if (
    !isRecord(metadata) ||
    metadata.operation !== "patchHwpx" ||
    !Number.isSafeInteger(metadata.applied) ||
    Number(metadata.applied) < 0 ||
    !Array.isArray(metadata.skipped)
  ) {
    throw protocolError();
  }
  return {
    applied: Number(metadata.applied),
    skipped: [...metadata.skipped] as SafeJsonValue[],
    verification: metadata.verification ?? null,
  };
}

function readFillMetadata(metadata: SafeJsonValue | undefined): FillMetadata {
  if (
    !isRecord(metadata) ||
    metadata.operation !== "fillHwpx" ||
    !Array.isArray(metadata.filled) ||
    !isStringArray(metadata.unmatched) ||
    !isStringArray(metadata.rejected)
  ) {
    throw protocolError();
  }
  const filled = metadata.filled.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.label !== "string" ||
      typeof entry.value !== "string"
    ) {
      throw protocolError();
    }
    return { ...entry, label: entry.label, value: entry.value } as FilledField;
  });
  return {
    filled,
    unmatched: [...metadata.unmatched],
    rejected: [...metadata.rejected],
  };
}

async function closeUnconsumedSnapshot(
  snapshot: Awaited<ReturnType<typeof openDocumentSnapshot>>,
): Promise<void> {
  try {
    await snapshot.verifySourceUnchanged();
  } finally {
    await snapshot.cleanup();
  }
}

function protocolError(): Error {
  const error = new Error("The isolated engine returned an invalid HWPX result.");
  Object.assign(error, { code: "ENGINE_PROTOCOL_ERROR" });
  return error;
}

function isRecord(value: unknown): value is Record<string, SafeJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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
