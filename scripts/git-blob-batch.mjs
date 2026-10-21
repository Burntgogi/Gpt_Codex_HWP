import { execFile } from "node:child_process";

import {
  noReplaceGitArguments,
  releaseSubprocessEnvironment,
} from "./release-subprocess-environment.mjs";

export async function readGitBlobBatch(root, records, options) {
  validateRecords(records, options);
  if (records.length === 0) return [];
  const input = Buffer.from(`${records.map(({ objectId }) => objectId).join("\n")}\n`, "ascii");
  const batch = await new Promise((resolve, reject) => {
    const child = execFile("git", noReplaceGitArguments(["cat-file", "--batch"]), {
      cwd: root,
      encoding: "buffer",
      env: releaseSubprocessEnvironment(),
      maxBuffer: options.maxOutputBytes,
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null || !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr)
        || stderr.length !== 0) {
        reject(batchError(options.gitCode));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
  return parseGitBlobBatch(batch, records, options);
}

export function parseGitBlobBatch(batch, records, options) {
  validateRecords(records, options);
  if (!Buffer.isBuffer(batch) || batch.length > options.maxOutputBytes) {
    throw batchError(options.invalidCode);
  }
  const contents = [];
  let offset = 0;
  let totalBytes = 0;
  for (const { objectId } of records) {
    const newline = batch.indexOf(0x0a, offset);
    if (newline < 0) throw batchError(options.invalidCode);
    const header = batch.subarray(offset, newline).toString("latin1");
    if (header === `${objectId} missing`) {
      throw batchError(options.missingCode ?? options.invalidCode);
    }
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(header);
    if (match === null || match[1] !== objectId) throw batchError(options.invalidCode);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > options.maxFileBytes
      || size > options.maxTotalBytes - totalBytes) {
      throw batchError(options.invalidCode);
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= batch.length || batch[end] !== 0x0a) throw batchError(options.invalidCode);
    contents.push(batch.subarray(start, end));
    offset = end + 1;
    totalBytes += size;
  }
  if (offset !== batch.length) throw batchError(options.invalidCode);
  return contents;
}

function validateRecords(records, options) {
  if (!Array.isArray(records)
    || records.some((record) => typeof record?.objectId !== "string"
      || !/^[a-f0-9]{40}$/u.test(record.objectId))
    || !Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 0
    || !Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes < 0
    || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw batchError(options.invalidCode);
  }
}

function batchError(code) {
  return Object.assign(new Error(code), { code });
}
