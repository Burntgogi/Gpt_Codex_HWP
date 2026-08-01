import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import packageJson from "../package.json" with { type: "json" };
import {
  assertExactToolSchemas,
  prepareRestartSafeRuntime,
} from "../../../scripts/installed-runtime-smoke.mjs";

const SOURCE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("built MCP server initializes and registers exactly nine tools without stderr", { timeout: 15_000 }, async () => {
  const configuredServerPath = process.env.HWP_MCP_SERVER_PATH?.trim();
  const prepared = configuredServerPath ? undefined : await prepareRestartSafeRuntime();
  const serverPath = configuredServerPath
    ? resolve(configuredServerPath)
    : join(prepared!.managedRoot, "dist", "mcp.js");
  await access(serverPath);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: prepared?.managedRoot ?? SOURCE_ROOT,
    ...(prepared === undefined ? {} : {
      env: Object.fromEntries(Object.entries({
        ...process.env,
        CODEX_HOME: prepared.codexHome,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: `${packageJson.name}-smoke`, version: packageJson.version });
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
    const catalog = JSON.parse(await readFile(
      join(SOURCE_ROOT, "examples", "oneshot-tool-schemas.json"),
      "utf8",
    ));
    assert.doesNotThrow(() => assertExactToolSchemas(response.tools, catalog));
  } finally {
    await client.close();
    await transport.close();
    await prepared?.cleanup();
  }

  assert.equal(stderr, "");
});
