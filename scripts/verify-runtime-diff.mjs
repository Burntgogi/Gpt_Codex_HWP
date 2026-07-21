import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compareRuntime } from "./project-runtime.mjs";

export { compareRuntime } from "./project-runtime.mjs";

async function main() {
  const [expectedRoot, actualRoot, ...extra] = process.argv.slice(2);
  if (!expectedRoot || !actualRoot || extra.length > 0) {
    throw new Error("Usage: node scripts/verify-runtime-diff.mjs <expected-runtime> <actual-runtime>");
  }
  const result = await compareRuntime({ expectedRoot, actualRoot });
  process.stdout.write(`Runtime trees match (${result.files} files).\n`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
