import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RuntimeBootstrapError,
  resolveInstalledRuntime,
  type RuntimeBootstrapOptions,
} from "./runtime-bootstrap.js";

export async function runMcpBootstrap(
  importMetaUrl: string,
  options: RuntimeBootstrapOptions = {},
  io: Readonly<{ stdout(value: string): void; stderr(value: string): void }> = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
): Promise<0 | 1> {
  try {
    const runtime = await resolveInstalledRuntime(importMetaUrl, "dist/mcp-main.js", options);
    const main = await import(runtime.mainUrl) as { runMcpServer?: () => Promise<void> };
    if (typeof main.runMcpServer !== "function") {
      throw new RuntimeBootstrapError("RUNTIME_DEPENDENCIES_INVALID");
    }
    await main.runMcpServer();
    return 0;
  } catch (error) {
    const code = error instanceof RuntimeBootstrapError
      ? error.code
      : allowedRootsErrorCode(error) ?? "RUNTIME_DEPENDENCIES_INVALID";
    io.stderr(`${code}\n`);
    return 1;
  }
}

function allowedRootsErrorCode(error: unknown): "INVALID_ALLOWED_ROOTS_CONFIGURATION" | undefined {
  try {
    return typeof error === "object" && error !== null
      && (error as { code?: unknown }).code === "INVALID_ALLOWED_ROOTS_CONFIGURATION"
      ? "INVALID_ALLOWED_ROOTS_CONFIGURATION"
      : undefined;
  } catch {
    return undefined;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  void runMcpBootstrap(import.meta.url).then((code) => { process.exitCode = code; });
}
