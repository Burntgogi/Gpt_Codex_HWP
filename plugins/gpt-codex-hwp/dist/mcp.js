import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PROJECT_METADATA } from "./generated/project-metadata.js";
import { createAllowedRootsPolicy, setActiveAllowedRootsPolicy, } from "./shared/allowed-roots.js";
import { registerTools } from "./tools/index.js";
export const ALLOWED_ROOTS_ENVIRONMENT_VARIABLE = "GPT_CODEX_HWP_ALLOWED_ROOTS";
export function createMcpServer() {
    const server = new McpServer({
        name: PROJECT_METADATA.productId,
        version: PROJECT_METADATA.version,
    });
    registerTools(server);
    return server;
}
export async function runMcpServer() {
    await configureAllowedRootsForMcp();
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
export async function configureAllowedRootsForMcp(environment = process.env) {
    const policy = await createAllowedRootsPolicy(environment[ALLOWED_ROOTS_ENVIRONMENT_VARIABLE]);
    setActiveAllowedRootsPolicy(policy);
    return policy;
}
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
    runMcpServer().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Failed to start ${PROJECT_METADATA.productId}: ${message}\n`);
        process.exitCode = 1;
    });
}
