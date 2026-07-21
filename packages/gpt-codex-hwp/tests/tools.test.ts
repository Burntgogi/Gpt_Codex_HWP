import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  registerTools,
  toolDefinitions,
  type ToolDefinition,
} from "../src/tools/index.js";

test("the registry contains the nine public document tools", () => {
  assert.deepEqual(
    toolDefinitions.map((definition) => definition.name),
    [
      "hwp_detect_format",
      "hwp_read",
      "hwp_generate_hwpx",
      "hwp_validate",
      "hwp_render_preview",
      "hwp_patch_document",
      "hwp_fill_form",
      "hwp_create_svg_asset",
      "hwp_insert_image",
    ],
  );
});

test("registerTools invokes each definition through one registry seam", () => {
  const calls: string[] = [];
  const server = {} as McpServer;
  const definitions: readonly ToolDefinition[] = [
    {
      name: "first",
      register(receivedServer) {
        assert.equal(receivedServer, server);
        calls.push("first");
      },
    },
    {
      name: "second",
      register(receivedServer) {
        assert.equal(receivedServer, server);
        calls.push("second");
      },
    },
  ];

  registerTools(server, definitions);
  assert.deepEqual(calls, ["first", "second"]);
});
