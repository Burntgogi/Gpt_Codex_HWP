import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(TEST_ROOT, "..");
const SOURCE_ASSET = join(SOURCE_ROOT, "src", "workers", "windows-job-supervisor.ps1");
const DIST_ASSET = join(SOURCE_ROOT, "dist", "workers", "windows-job-supervisor.ps1");

test("package build copies the exact Windows supervisor beside the compiled client", async () => {
  const npmCli = process.env.npm_execpath ?? join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const build = spawnSync(process.execPath, [npmCli, "run", "build", "--silent"], {
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const metadata = await lstat(DIST_ASSET);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.isFile(), true);
  const [source, compiled] = await Promise.all([
    readFile(SOURCE_ASSET),
    readFile(DIST_ASSET),
  ]);
  assert.equal(sha256(compiled), sha256(source));

  const compiledClient = await import(
    `${pathToFileURL(join(SOURCE_ROOT, "dist", "workers", "document-child-client.js")).href}?asset-test=${Date.now()}`
  ) as { resolveWindowsJobSupervisorScript(): string };
  assert.equal(compiledClient.resolveWindowsJobSupervisorScript(), DIST_ASSET);
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
