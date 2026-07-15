import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PROJECT_METADATA } from "./generated/project-metadata.js";
import { registerTools } from "./tools/index.js";
export function createMcpServer() {
    const server = new McpServer({
        name: PROJECT_METADATA.productId,
        version: PROJECT_METADATA.version,
    });
    registerTools(server);
    return server;
}
export async function runMcpServer() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
    runMcpServer().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Failed to start ${PROJECT_METADATA.productId}: ${message}\n`);
        process.exitCode = 1;
    });
}
