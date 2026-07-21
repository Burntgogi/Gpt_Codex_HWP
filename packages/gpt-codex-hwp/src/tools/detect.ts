import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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
import { maxWorkerSnapshotBytesForRequest } from "../workers/document-execution-policy.js";

export const HWP_DETECT_FORMAT_TOOL_NAME = "hwp_detect_format";

export interface HwpDetectFormatInput {
  file_path: string;
}

interface FormatDetails {
  file_path: string;
  file_size_bytes: number;
  container_format?: "zip" | "ole2";
  detection_warning?: string;
}

export async function handleHwpDetectFormat(
  input: HwpDetectFormatInput,
  documentEngine: DocumentEngineFacade = defaultDocumentEngineFacade,
  context?: ToolExecutionContext,
): Promise<CallToolResult> {
  let filePath: string;

  try {
    filePath = resolveLocalPath(input.file_path, "file_path");
    const snapshot = await openDocumentSnapshot(filePath, {
      workerInputMaxBytes: maxWorkerSnapshotBytesForRequest({
        input: {},
        options: {},
      }),
    });
    const detected = await documentEngine.detect(
      snapshot,
      toDocumentEngineExecutionContext(context),
    );
    const details: FormatDetails = {
      file_path: filePath,
      file_size_bytes: detected.snapshotMetadata.sizeBytes,
    };

    const container = detected.snapshotMetadata.shallowFormat.container;
    if (container === "zip" || container === "ole2") {
      details.container_format = container;
    }
    if (detected.payload.format === "unknown" && container !== undefined) {
      details.detection_warning = container === "zip"
        ? "The ZIP container is not a supported HWPX document."
        : "The OLE2 container is not a supported HWP document.";
    }

    return toolSuccess(`Detected ${detected.payload.format} document format.`, {
      format: detected.payload.format,
      details,
    });
  } catch (error: unknown) {
    const message = errorMessage(error);
    return toolError(`Could not detect the document format: ${message}`, {
      code: errorCode(error, "DETECT_ERROR"),
      error: message,
      file_path: safeResolvedPath(input.file_path),
    });
  }
}

export function registerHwpDetectFormat(
  server: McpServer,
  documentEngine: DocumentEngineFacade = defaultDocumentEngineFacade,
): void {
  server.registerTool(
    HWP_DETECT_FORMAT_TOOL_NAME,
    {
      title: "Detect HWP document format",
      description:
        "Detect the exact requested local document format before applying the HWP/HWPX-only read contract.",
      inputSchema: {
        file_path: z.string().min(1).describe("Local document path to inspect."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    (args, extra) => runWithToolExecutionContext(
      extra,
      (context) => handleHwpDetectFormat(args, documentEngine, context),
    ),
  );
}

function safeResolvedPath(path: unknown): string | undefined {
  try {
    return typeof path === "string"
      ? resolveLocalPath(path, "file_path")
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
