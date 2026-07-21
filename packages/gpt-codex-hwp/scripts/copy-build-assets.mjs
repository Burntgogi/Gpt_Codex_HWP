import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = Object.freeze([
  "windows-job-supervisor.ps1",
  "gpt-codex-hwp-job.dll",
]);

for (const filename of ASSETS) {
  const source = resolve(PACKAGE_ROOT, "src", "workers", filename);
  const destination = resolve(PACKAGE_ROOT, "dist", "workers", filename);
  await assertRegularFile(source, `source worker asset ${filename}`);
  await mkdir(dirname(destination), { recursive: true });
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`destination worker asset ${filename} must be a regular file`);
    }
    await unlink(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await assertRegularFile(destination, `copied worker asset ${filename}`);
  const [sourceBytes, destinationBytes] = await Promise.all([
    readFile(source),
    readFile(destination),
  ]);
  if (sha256(sourceBytes) !== sha256(destinationBytes)) {
    throw new Error(`copied worker asset ${filename} hash does not match source`);
  }
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
