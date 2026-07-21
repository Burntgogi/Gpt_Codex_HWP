import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  HWP_CREATE_SVG_ASSET_TOOL_NAME,
  HWP_INSERT_IMAGE_TOOL_NAME,
  registerHwpCreateSvgAsset,
  registerHwpInsertImage,
} from "./assets.js";
import {
  HWP_DETECT_FORMAT_TOOL_NAME,
  registerHwpDetectFormat,
} from "./detect.js";
import {
  HWP_RENDER_PREVIEW_TOOL_NAME,
  registerHwpRenderPreview,
} from "./preview.js";
import {
  HWP_FILL_FORM_TOOL_NAME,
  HWP_PATCH_DOCUMENT_TOOL_NAME,
  registerHwpFillForm,
  registerHwpPatchDocument,
} from "./patch.js";
import { HWP_READ_TOOL_NAME, registerHwpRead } from "./read.js";
import {
  HWP_GENERATE_HWPX_TOOL_NAME,
  HWP_VALIDATE_TOOL_NAME,
  registerHwpGenerateHwpx,
  registerHwpValidate,
} from "./write.js";

export interface ToolDefinition {
  readonly name: string;
  readonly register: (server: McpServer) => void;
}

export const toolDefinitions: readonly ToolDefinition[] = Object.freeze([
  {
    name: HWP_DETECT_FORMAT_TOOL_NAME,
    register: registerHwpDetectFormat,
  },
  {
    name: HWP_READ_TOOL_NAME,
    register: registerHwpRead,
  },
  {
    name: HWP_GENERATE_HWPX_TOOL_NAME,
    register: registerHwpGenerateHwpx,
  },
  {
    name: HWP_VALIDATE_TOOL_NAME,
    register: registerHwpValidate,
  },
  {
    name: HWP_RENDER_PREVIEW_TOOL_NAME,
    register: registerHwpRenderPreview,
  },
  {
    name: HWP_PATCH_DOCUMENT_TOOL_NAME,
    register: registerHwpPatchDocument,
  },
  {
    name: HWP_FILL_FORM_TOOL_NAME,
    register: registerHwpFillForm,
  },
  {
    name: HWP_CREATE_SVG_ASSET_TOOL_NAME,
    register: registerHwpCreateSvgAsset,
  },
  {
    name: HWP_INSERT_IMAGE_TOOL_NAME,
    register: registerHwpInsertImage,
  },
]);

export function registerTools(
  server: McpServer,
  definitions: readonly ToolDefinition[] = toolDefinitions,
): void {
  if (definitions.length === 0) {
    server.server.registerCapabilities({ tools: { listChanged: false } });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    return;
  }

  for (const definition of definitions) {
    definition.register(server);
  }
}
