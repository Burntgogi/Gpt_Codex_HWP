import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runInstalledOneShotSmoke } from "../scripts/installed-runtime-smoke.mjs";
import { loadProjectMetadata, pluginVersion } from "../scripts/project-metadata.mjs";
import { buildRuntime } from "../scripts/project-runtime.mjs";

const execute = promisify(execFile);
const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("durable runtime survives managed cache rehydration without another install", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-restart-safe-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const codexHome = join(temporaryRoot, "codex-home");
  const metadata = await loadProjectMetadata(ROOT);
  const version = pluginVersion(metadata);
  const managedRoot = join(
    codexHome,
    "plugins", "cache", metadata.marketplaceName, metadata.productId, version,
  );
  const durableRoot = join(
    codexHome,
    "plugin-runtime-data", metadata.productId, version, `${process.platform}-${process.arch}`,
  );

  await buildRuntime({ root: ROOT, outputRoot: managedRoot, swapId: "restart-safe-first" });
  const installed = await runNode(join(managedRoot, "dist", "install-runtime.js"), ["--json"], managedRoot, codexHome);
  assert.equal(installed.code, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.equal(JSON.parse(installed.stdout).code, "RUNTIME_INSTALL_OK");
  assert.equal(await exists(join(managedRoot, "node_modules")), false);
  assert.equal(await exists(join(durableRoot, "node_modules")), true);
  const receiptPath = join(durableRoot, "install-receipt.json");
  const receiptHash = sha256(await readFile(receiptPath));

  await rm(managedRoot, { recursive: true, force: true });
  await buildRuntime({ root: ROOT, outputRoot: managedRoot, swapId: "restart-safe-second" });
  assert.equal(await exists(join(managedRoot, "node_modules")), false);

  const doctor = await runNode(join(managedRoot, "dist", "doctor.js"), ["--json"], managedRoot, codexHome);
  assert.equal(doctor.code, 0, `${doctor.stdout}\n${doctor.stderr}`);
  assert.equal(JSON.parse(doctor.stdout).code, "DOCTOR_OK");
  const oneShot = await runInstalledOneShotSmoke({
    runtimeRoot: managedRoot,
    stdout: { write() { return true; } },
    setExitCode(code) { assert.equal(code, 0); },
  });
  assert.notEqual(oneShot, false);
  assert.equal(oneShot.remainingDescendantCount, 0);
  assert.equal(sha256(await readFile(receiptPath)), receiptHash);
});

async function runNode(entry, args, cwd, codexHome) {
  try {
    const result = await execute(process.execPath, [entry, ...args], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : -1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
    };
  }
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
