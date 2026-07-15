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
const SOURCE = resolve(PACKAGE_ROOT, "src", "workers", "windows-job-supervisor.ps1");
const DESTINATION = resolve(PACKAGE_ROOT, "dist", "workers", "windows-job-supervisor.ps1");

await assertRegularFile(SOURCE, "source supervisor asset");
await mkdir(dirname(DESTINATION), { recursive: true });
try {
  const existing = await lstat(DESTINATION);
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error("destination supervisor asset must be a regular file");
  }
  await unlink(DESTINATION);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await copyFile(SOURCE, DESTINATION, fsConstants.COPYFILE_EXCL);
await assertRegularFile(DESTINATION, "copied supervisor asset");

const [sourceBytes, destinationBytes] = await Promise.all([
  readFile(SOURCE),
  readFile(DESTINATION),
]);
if (sha256(sourceBytes) !== sha256(destinationBytes)) {
  throw new Error("copied supervisor asset hash does not match source");
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
