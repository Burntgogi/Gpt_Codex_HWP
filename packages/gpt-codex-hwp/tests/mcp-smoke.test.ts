import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import packageJson from "../package.json" with { type: "json" };

test("built MCP server initializes, lists tools, and exits without stderr", { timeout: 15_000 }, async () => {
  const serverPath = resolve(
    process.env.HWP_MCP_SERVER_PATH ?? "dist/mcp.js",
  );
  await access(serverPath);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "hwp-korean-docs-smoke", version: "0.1.0" });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, packageJson.version);
    const response = await client.listTools();
    assert.deepEqual(
      response.tools.map((tool) => tool.name),
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
  } finally {
    await client.close();
    await transport.close();
  }

  assert.equal(stderr, "");
});
