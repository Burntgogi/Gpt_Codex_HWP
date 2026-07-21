import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { syncProjectMetadata } from "./project-metadata.mjs";

export { syncProjectMetadata } from "./project-metadata.mjs";

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !["--check", "--write"].includes(mode)) {
    throw new Error("Usage: node scripts/sync-project-metadata.mjs --check|--write");
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await syncProjectMetadata({ root, check: mode === "--check" });
  process.stdout.write(`Project metadata ${mode === "--check" ? "matches" : "synchronized"}.\n`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
