import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "kordoc";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "rhwp",
);
const fixturePath = join(fixtureRoot, "re-01-hangul-only-hancom.hwp");
const licensePath = join(fixtureRoot, "LICENSE");
const provenancePath = join(fixtureRoot, "provenance.json");

const expectedProvenance = {
  project: "rhwp",
  repository: "https://github.com/edwardkim/rhwp",
  release: "v0.7.17",
  revision: "03351190ec35436e58cbfee0aa9278a8fdc04a59",
  additionRevision: "a200cfd93d100a6f20f29bb0b836b4bc6faa37fd",
  path: "samples/re-01-hangul-only-hancom.hwp",
  gitBlobSha1: "408e850375cede568ee23c91f6ff5b6d011faba3",
  bytes: 8_704,
  sha256: "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd",
  license: "MIT",
  licensePath: "LICENSE",
  licenseUrl:
    "https://raw.githubusercontent.com/edwardkim/rhwp/03351190ec35436e58cbfee0aa9278a8fdc04a59/LICENSE",
  licenseBytes: 1_072,
  licenseSha256:
    "1c3a7d5643b163a3ead4965e1bea33b832caee5bfca265efe42afcd7bc696b5b",
  copyright: "Copyright (c) 2025-2026 Edward Kim",
};

const expectedMarkdown = {
  characters: 100,
  bytes: 300,
  sha256: "34ba9b31ab7f208d922763be29c72ee7f68c0e3300285ff83eba3eb73dfe7a34",
};

function digest(algorithm: "sha1" | "sha256", bytes: Uint8Array): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

test("rhwp fixture integrity and Kordoc parsing", { timeout: 10_000 }, async () => {
  const pristineBytes = await readFile(fixturePath);
  const pristineSha256 = digest("sha256", pristineBytes);

  assert.equal(pristineBytes.byteLength, expectedProvenance.bytes);
  assert.equal(pristineSha256, expectedProvenance.sha256);
  assert.equal(gitBlobSha1(pristineBytes), expectedProvenance.gitBlobSha1);

  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  assert.deepEqual(provenance, expectedProvenance);

  const licenseBytes = await readFile(licensePath);
  assert.equal(licenseBytes.byteLength, expectedProvenance.licenseBytes);
  assert.equal(
    digest("sha256", licenseBytes),
    expectedProvenance.licenseSha256,
  );

  const parseInput = Buffer.from(pristineBytes);
  const parseInputSnapshot = Buffer.from(parseInput);
  const parseInputSha256 = digest("sha256", parseInput);
  const parsed = await parse(parseInput, { filePath: fixturePath });

  assert.deepEqual(parseInput, parseInputSnapshot);
  assert.equal(digest("sha256", parseInput), parseInputSha256);
  const bytesAfterParsing = await readFile(fixturePath);
  assert.deepEqual(bytesAfterParsing, pristineBytes);
  assert.equal(digest("sha256", bytesAfterParsing), pristineSha256);

  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.fileType, "hwp");
  assert.equal(parsed.markdown.length, expectedMarkdown.characters);
  assert.equal(Buffer.byteLength(parsed.markdown, "utf8"), expectedMarkdown.bytes);
  assert.equal(
    digest("sha256", Buffer.from(parsed.markdown, "utf8")),
    expectedMarkdown.sha256,
  );
  assert.deepEqual(parsed.blocks, [
    {
      type: "paragraph",
      text: parsed.markdown,
      pageNumber: 1,
      style: { fontSize: 100 },
    },
  ]);
  assert.deepEqual(parsed.metadata, { version: "5.x", pageCount: 1 });
  assert.equal(parsed.warnings, undefined);
  assert.equal("error" in parsed, false);
});
