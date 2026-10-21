import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProjectMetadata, pluginVersion } from "../../../scripts/project-metadata.mjs";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = dirname(TEST_ROOT);
const REPOSITORY_ROOT = dirname(dirname(SOURCE_ROOT));
const RUNTIME_ROOT = join(REPOSITORY_ROOT, "plugins", "gpt-codex-hwp");

test("production metadata derives the current release from the root record", async () => {
  const metadata = await loadProjectMetadata(REPOSITORY_ROOT);
  const [rootPackage, sourcePackage, sourceLock, pluginManifest, runtimePackage, runtimeLock] = await Promise.all([
    readJson(join(REPOSITORY_ROOT, "package.json")),
    readJson(join(SOURCE_ROOT, "package.json")),
    readJson(join(SOURCE_ROOT, "package-lock.json")),
    readJson(join(RUNTIME_ROOT, ".codex-plugin", "plugin.json")),
    readJson(join(RUNTIME_ROOT, "package.json")),
    readJson(join(RUNTIME_ROOT, "package-lock.json")),
  ]);

  assert.equal(rootPackage.version, metadata.version);
  assert.equal(sourcePackage.name, metadata.productId);
  assert.equal(sourcePackage.version, metadata.version);
  assert.equal(sourceLock.name, metadata.productId);
  assert.equal(sourceLock.version, metadata.version);
  assert.equal(sourceLock.packages[""]?.name, metadata.productId);
  assert.equal(sourceLock.packages[""]?.version, metadata.version);
  assert.equal(pluginManifest.name, metadata.productId);
  assert.equal(pluginManifest.version, pluginVersion(metadata));
  assert.equal(runtimePackage.name, metadata.productId);
  assert.equal(runtimePackage.version, metadata.version);
  assert.equal(runtimeLock.name, metadata.productId);
  assert.equal(runtimeLock.version, metadata.version);
  assert.equal(runtimeLock.packages[""]?.version, metadata.version);
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

