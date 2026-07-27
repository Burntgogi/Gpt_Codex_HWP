import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runMacNodeTestsDiagnostic } from "./macos-node-tests-diagnostic.mjs";
import { parseNodeTestProfileArguments } from "./node-test-profiles.mjs";

export async function runSourceNodeTestsIsolated(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const profile = options.profile ?? "full";
  return runMacNodeTestsDiagnostic({
    ...options,
    profile,
    stdout: {
      write(value) {
        return stdout.write(value.replace(/(^|\n)MAC_/gu, "$1SOURCE_"));
      },
    },
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  let profile;
  try { profile = parseNodeTestProfileArguments(process.argv.slice(2)); }
  catch {
    process.stderr.write("Invalid Node test profile.\n");
    process.exitCode = 1;
  }
  if (profile !== undefined) await runSourceNodeTestsIsolated({ profile });
}
