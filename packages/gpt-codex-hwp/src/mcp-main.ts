import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PROJECT_METADATA } from "./generated/project-metadata.js";
import {
  createAllowedRootsPolicy,
  setActiveAllowedRootsPolicy,
  type AllowedRootsPolicy,
} from "./shared/allowed-roots.js";
import { registerTools } from "./tools/index.js";

export const ALLOWED_ROOTS_ENVIRONMENT_VARIABLE =
  "GPT_CODEX_HWP_ALLOWED_ROOTS";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: PROJECT_METADATA.productId,
    version: PROJECT_METADATA.version,
  });
  registerTools(server);
  return server;
}

export async function runMcpServer(): Promise<void> {
  await configureAllowedRootsForMcp();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function configureAllowedRootsForMcp(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AllowedRootsPolicy> {
  const policy = await createAllowedRootsPolicy(
    environment[ALLOWED_ROOTS_ENVIRONMENT_VARIABLE],
  );
  setActiveAllowedRootsPolicy(policy);
  return policy;
}
