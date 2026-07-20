import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(TEST_ROOT, "..");
const WORKER_ASSETS = Object.freeze([
  "windows-job-supervisor.ps1",
  "gpt-codex-hwp-job.dll",
]);

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

  for (const filename of WORKER_ASSETS) {
    const sourceAsset = join(SOURCE_ROOT, "src", "workers", filename);
    const distAsset = join(SOURCE_ROOT, "dist", "workers", filename);
    const metadata = await lstat(distAsset);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.isFile(), true);
    const [source, compiled] = await Promise.all([
      readFile(sourceAsset),
      readFile(distAsset),
    ]);
    assert.equal(sha256(compiled), sha256(source));
  }

  const compiledClient = await import(
    `${pathToFileURL(join(SOURCE_ROOT, "dist", "workers", "document-child-client.js")).href}?asset-test=${Date.now()}`
  ) as { resolveWindowsJobSupervisorScript(): string };
  assert.equal(
    compiledClient.resolveWindowsJobSupervisorScript(),
    join(SOURCE_ROOT, "dist", "workers", "windows-job-supervisor.ps1"),
  );
});

test("Windows supervisor loads only the pinned first-party interop assembly", async () => {
  const script = await readFile(
    join(SOURCE_ROOT, "src", "workers", "windows-job-supervisor.ps1"),
    "utf8",
  );
  const assembly = await readFile(
    join(SOURCE_ROOT, "src", "workers", "gpt-codex-hwp-job.dll"),
  );
  assert.doesNotMatch(script, /Add-Type\s+-TypeDefinition/iu);
  assert.doesNotMatch(
    script,
    /New-Object\s+GptCodexHwpJob\+/iu,
  );
  assert.doesNotMatch(script, /\bSort-Object\b/iu);
  assert.doesNotMatch(script, /\bStart-Sleep\b/iu);
  assert.match(script, /\[System\.Threading\.Thread\]::Sleep\(20\)/u);
  assert.match(script, /if \(\[int\]\$left\.Depth -gt \[int\]\$right\.Depth\) \{ return -1 \}/u);
  assert.match(script, /if \(\[int\]\$left\.Depth -lt \[int\]\$right\.Depth\) \{ return 1 \}/u);
  assert.match(script, /if \(\[long\]\$left\.CreationTime -gt \[long\]\$right\.CreationTime\) \{ return -1 \}/u);
  assert.match(script, /if \(\[long\]\$left\.CreationTime -lt \[long\]\$right\.CreationTime\) \{ return 1 \}/u);
  assert.match(
    script,
    /\[GptCodexHwpJob\+JOBOBJECT_EXTENDED_LIMIT_INFORMATION\]::new\(\)/u,
  );
  assert.match(
    script,
    /\[GptCodexHwpJob\+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION\]::new\(\)/u,
  );
  assert.match(script, /\[System\.Reflection\.Assembly\]::Load\(\$assemblyBytes\)/u);
  assert.match(script, new RegExp(sha256(assembly), "u"));
  const provenance = JSON.parse(await readFile(
    join(SOURCE_ROOT, "src", "workers", "windows-job-interop.provenance.json"),
    "utf8",
  ));
  assert.equal(provenance.artifactBytes, assembly.byteLength);
  assert.equal(provenance.artifactSha256, sha256(assembly));
  assert.deepEqual(provenance.externalRuntimePackages, []);
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
