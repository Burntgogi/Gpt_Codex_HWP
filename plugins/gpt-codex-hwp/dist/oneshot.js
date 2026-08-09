import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeBootstrapError, resolveInstalledRuntime, } from "./runtime-bootstrap.js";
export async function runOneShotBootstrap(importMetaUrl, argv = process.argv.slice(2), options = {}, io = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
}) {
    try {
        const runtime = await resolveInstalledRuntime(importMetaUrl, "dist/oneshot-main.js", options);
        const main = await import(runtime.mainUrl);
        if (typeof main.runOneShotEntry !== "function") {
            throw new RuntimeBootstrapError("RUNTIME_DEPENDENCIES_INVALID");
        }
        return await main.runOneShotEntry(argv);
    }
    catch (error) {
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
