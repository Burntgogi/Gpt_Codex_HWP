import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  freezeEvidenceBundle,
  runEvidenceCli,
  verifyEvidenceBundle,
} from "../scripts/node-phase-a-evidence.mjs";

const CONTROL_REVISION = "6983ffaf7e0a392bc9852a121ae14895ab4160fb";
const CANDIDATE_REVISION = "05efdd9a901e82567887d50d1501ce7fd2ee9370";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("evidence freeze copies exact bytes without source paths and rejects tampering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "node-phase-a-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "private-source.json");
  const outputRoot = join(root, "bundle");
  const sourceBytes = Buffer.from('{"status":"exploratory"}\n', "utf8");
  await writeFile(sourcePath, sourceBytes);

  const manifest = await freezeEvidenceBundle({
    spec: {
      metadata: {
        schemaVersion: 1,
        controlRevision: CONTROL_REVISION,
        candidateRevision: CANDIDATE_REVISION,
      },
      entries: [{
        logicalName: "idle-final",
        sourcePath,
        expectedSha256: sha256(sourceBytes),
        schemaVersion: 1,
      }],
    },
    outputRoot,
  });

  assert.deepEqual(manifest.entries[0], {
    logicalName: "idle-final",
    relativePath: "files/idle-final.json",
    bytes: sourceBytes.length,
    sha256: sha256(sourceBytes),
    schemaVersion: 1,
  });
  assert.deepEqual(await readFile(join(outputRoot, "files", "idle-final.json")), sourceBytes);
  assert.doesNotMatch(JSON.stringify(manifest), /Users|Work|sourcePath/iu);
  assert.deepEqual(await verifyEvidenceBundle({ bundleRoot: outputRoot }), manifest);

  await writeFile(join(outputRoot, "files", "idle-final.json"), "tampered\n");
  await assert.rejects(
    () => verifyEvidenceBundle({ bundleRoot: outputRoot }),
    /EVIDENCE_HASH_MISMATCH/u,
  );
});

test("evidence freeze rejects credential-shaped metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "node-phase-a-evidence-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.json");
  const sourceBytes = Buffer.from("{}\n", "utf8");
  const credentialKey = ["api", "Key"].join("");
  await writeFile(sourcePath, sourceBytes);

  await assert.rejects(
    () => freezeEvidenceBundle({
      spec: {
        metadata: {
          schemaVersion: 1,
          controlRevision: CONTROL_REVISION,
          candidateRevision: CANDIDATE_REVISION,
          [credentialKey]: "fixture-value-must-never-enter-a-manifest",
        },
        entries: [{
          logicalName: "idle",
          sourcePath,
          expectedSha256: sha256(sourceBytes),
          schemaVersion: 1,
        }],
      },
      outputRoot: join(root, "bundle"),
    }),
    /EVIDENCE_MANIFEST_UNSAFE/u,
  );
});

test("evidence freeze is exclusive and verification rejects unindexed files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "node-phase-a-evidence-exclusive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.md");
  const outputRoot = join(root, "bundle");
  const sourceBytes = Buffer.from("# evidence\n", "utf8");
  await writeFile(sourcePath, sourceBytes);
  const request = {
    spec: {
      metadata: {
        schemaVersion: 1,
        controlRevision: CONTROL_REVISION,
        candidateRevision: CANDIDATE_REVISION,
      },
      entries: [{
        logicalName: "audit",
        sourcePath,
        expectedSha256: sha256(sourceBytes),
        schemaVersion: 1,
      }],
    },
    outputRoot,
  };

  await freezeEvidenceBundle(request);
  await assert.rejects(() => freezeEvidenceBundle(request), /EVIDENCE_OUTPUT_EXISTS/u);
  await writeFile(join(outputRoot, "files", "not-indexed.txt"), "extra\n");
  await assert.rejects(
    () => verifyEvidenceBundle({ bundleRoot: outputRoot }),
    /EVIDENCE_FILE_SET_MISMATCH/u,
  );
});

test("evidence CLI emits only a fixed receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "node-phase-a-evidence-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.json");
  const outputRoot = join(root, "bundle");
  const specPath = join(root, "spec.json");
  const sourceBytes = Buffer.from('{"ok":true}\n', "utf8");
  await writeFile(sourcePath, sourceBytes);
  await writeFile(specPath, JSON.stringify({
    metadata: {
      schemaVersion: 1,
      controlRevision: CONTROL_REVISION,
      candidateRevision: CANDIDATE_REVISION,
    },
    entries: [{
      logicalName: "idle",
      sourcePath,
      expectedSha256: sha256(sourceBytes),
      schemaVersion: 1,
    }],
  }));
  let output = "";
  const io = { stdout: { write(value) { output += value; } } };

  assert.equal(await runEvidenceCli([
    "freeze", "--spec", specPath, "--output", outputRoot,
  ], io), 0);
  assert.equal(await runEvidenceCli(["verify", "--bundle", outputRoot], io), 0);
  assert.equal(output, "EVIDENCE_BUNDLE_OK entries=1\nEVIDENCE_BUNDLE_OK entries=1\n");
  assert.doesNotMatch(output, /Users|AppData|node-phase-a-evidence-cli|source\.json/iu);
});
