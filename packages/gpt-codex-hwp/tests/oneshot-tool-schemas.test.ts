import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { canonicalToolSchema } from "../../../scripts/installed-runtime-smoke.mjs";
import { createMcpServer } from "../src/mcp.js";

const SOURCE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const EXPECTED_NAMES = [
  "hwp_create_svg_asset",
  "hwp_detect_format",
  "hwp_fill_form",
  "hwp_generate_hwpx",
  "hwp_insert_image",
  "hwp_patch_document",
  "hwp_read",
  "hwp_render_preview",
  "hwp_validate",
];
const REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "tool", "arguments"],
  properties: {
    schemaVersion: { const: 1 },
    tool: { enum: EXPECTED_NAMES },
    arguments: { type: "object" },
  },
};

test("one-shot tool schema catalog matches all live registrations", async () => {
  const catalog = JSON.parse(await readFile(join(SOURCE_ROOT, "examples", "oneshot-tool-schemas.json"), "utf8"));
  assert.deepEqual(Object.keys(catalog), ["schemaVersion", "requestSchema", "tools"]);
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(catalog.requestSchema, REQUEST_SCHEMA);
  assert.deepEqual(Object.keys(catalog.tools), EXPECTED_NAMES);
  for (const schema of Object.values(catalog.tools)) {
    assert.equal(JSON.stringify(schema), JSON.stringify(canonicalToolSchema(schema)));
  }

  const server = createMcpServer();
  const client = new Client({ name: "oneshot-tool-schemas", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(
      Object.fromEntries(listed.tools.map((tool) => [tool.name, canonicalToolSchema(tool.inputSchema)])),
      catalog.tools,
    );
  } finally {
    await client.close();
    await server.close();
  }
});
