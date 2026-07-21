import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runMacNodeTestsDiagnostic } from "./macos-node-tests-diagnostic.mjs";

export async function runSourceNodeTestsIsolated(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  return runMacNodeTestsDiagnostic({
    ...options,
    stdout: {
      write(value) {
        return stdout.write(value.replace(/(^|\n)MAC_/gu, "$1SOURCE_"));
      },
    },
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runSourceNodeTestsIsolated();
}
