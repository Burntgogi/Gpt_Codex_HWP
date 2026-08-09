import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RuntimeBootstrapError,
  resolveInstalledRuntime,
  type RuntimeBootstrapOptions,
} from "./runtime-bootstrap.js";

export async function runOneShotBootstrap(
  importMetaUrl: string,
  argv: readonly string[] = process.argv.slice(2),
  options: RuntimeBootstrapOptions = {},
  io: Readonly<{ stdout(value: string): void; stderr(value: string): void }> = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
): Promise<0 | 1 | 2> {
  try {
    const runtime = await resolveInstalledRuntime(importMetaUrl, "dist/oneshot-main.js", options);
    const main = await import(runtime.mainUrl) as {
      runOneShotEntry?: (args: readonly string[]) => Promise<0 | 1 | 2>;
    };
    if (typeof main.runOneShotEntry !== "function") {
      throw new RuntimeBootstrapError("RUNTIME_DEPENDENCIES_INVALID");
    }
    return await main.runOneShotEntry(argv);
  } catch (error) {
    const code = error instanceof RuntimeBootstrapError
      ? error.code
      : "RUNTIME_DEPENDENCIES_INVALID";
    io.stderr(`${code}\n`);
    return 2;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  void runOneShotBootstrap(import.meta.url).then((code) => { process.exitCode = code; });
}
