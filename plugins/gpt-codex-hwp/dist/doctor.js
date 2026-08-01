import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeBootstrapError, resolveInstalledRuntime, } from "./runtime-bootstrap.js";
export async function runDoctorBootstrap(importMetaUrl, args = process.argv.slice(2), options = {}, io = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
}) {
    try {
        const runtime = await resolveInstalledRuntime(importMetaUrl, "dist/doctor-main.js", options);
        const main = await import(runtime.mainUrl);
        if (typeof main.doctorMain !== "function") {
            throw new RuntimeBootstrapError("RUNTIME_DEPENDENCIES_INVALID");
        }
        return await main.doctorMain(args, io);
    }
    catch (error) {
        const code = error instanceof RuntimeBootstrapError
            ? error.code
            : "RUNTIME_DEPENDENCIES_INVALID";
        if (args.length === 1 && args[0] === "--json") {
            io.stdout(`${JSON.stringify({
                schemaVersion: 1,
                code: "DOCTOR_REQUIRED_CHECK_FAILED",
                ok: false,
                required: { passed: 0, failed: 1 },
                optional: { available: 0, unavailable: 0 },
                checks: [{
                        code,
                        ok: false,
                        required: true,
                        remediation: "Run node dist/install-runtime.js --json.",
                    }],
            })}\n`);
        }
        else {
            io.stdout(`${code}: run node dist/install-runtime.js --json.\n`);
        }
        return 1;
    }
}
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
    void runDoctorBootstrap(import.meta.url).then((code) => { process.exitCode = code; });
}
