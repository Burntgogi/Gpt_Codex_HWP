import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  prepareNodeMemoryQualification,
  qualificationCommandFailureCode,
  runNodeMemoryQualification,
  scrubQualificationEnvironment,
} from "../scripts/run-node-memory-qualification.mjs";
import {
  completePassingFixture,
  DECISION,
} from "./fixtures/node-memory-qualification-fixture.mjs";

const execFileAsync = promisify(execFile);

test("qualification command failures retain only one privacy-safe child code", () => {
  assert.equal(
    qualificationCommandFailureCode("idle", "IDLE_REPORT_INVALID\n"),
    "QUALIFICATION_COMMAND_FAILED_IDLE_IDLE_REPORT_INVALID",
  );
  for (const unsafe of [
    "<home>/private.txt\n",
    "IDLE_REPORT_INVALID\nsecond line\n",
    "lowercase_error\n",
  ]) {
    assert.equal(
      qualificationCommandFailureCode("idle", unsafe),
      "QUALIFICATION_COMMAND_FAILED_IDLE",
    );
  }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function git(root, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

async function createRepository(root) {
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Qualification Test");
  await git(root, "config", "user.email", "qualification-test@users.noreply.github.com");
  await writeFile(join(root, ".gitignore"), "/qualification/\n");
  await writeFile(join(root, "tracked.txt"), "control\n");
  await git(root, "add", ".gitignore", "tracked.txt");
  await git(root, "commit", "-m", "control");
  const controlRevision = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "tracked.txt"), "candidate\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "candidate");
  return { controlRevision, candidateRevision: await git(root, "rev-parse", "HEAD") };
}

test("qualification orchestrator binds a clean exact HEAD and emits privacy-safe receipts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "node-memory-qualification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { controlRevision, candidateRevision } = await createRepository(root);
  const fixture = completePassingFixture({ controlRevision, candidateRevision });
  const inputRoot = join(root, "qualification-inputs");
  const outputRoot = join(root, "qualification", "run-1");
  await execFileAsync(process.execPath, ["-e", "require('fs').mkdirSync(process.argv[1],{recursive:true})", inputRoot]);
  const decisionBytes = Buffer.from(`${JSON.stringify(DECISION, null, 2)}\n`);
  const evidence = {
    idle: Buffer.from(`${JSON.stringify(fixture.idle)}\n`),
    documents: Buffer.from(`${JSON.stringify(fixture.documents)}\n`),
    recovery: Buffer.from(`${JSON.stringify(fixture.recovery)}\n`),
  };
  const sourcePaths = {};
  await writeFile(join(root, ".gitignore"), "/qualification/\n/qualification-inputs/\n");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "ignore qualification inputs");
  const exactHead = await git(root, "rev-parse", "HEAD");
  fixture.idle.runtimeIdentities.candidate.revision = exactHead;
  evidence.idle = Buffer.from(`${JSON.stringify(fixture.idle)}\n`);
  const decisionPath = join(inputRoot, "decision.json");
  await writeFile(decisionPath, decisionBytes);
  for (const [name, bytes] of Object.entries(evidence)) {
    const path = join(inputRoot, `${name}.json`);
    sourcePaths[name] = path;
    await writeFile(path, bytes);
  }
  const copyScript = "require('fs').copyFileSync(process.argv[1],process.argv[2])";
  const spec = {
    schemaVersion: 1,
    expectedHead: exactHead,
    controlRevision,
    decisionSha256: sha256(decisionBytes),
    evidenceFiles: { idle: "idle.json", documents: "documents.json", recovery: "recovery.json" },
    commands: [
      { id: "build", command: process.execPath, args: ["-e", ""] },
      { id: "idle", command: process.execPath, args: ["-e", copyScript, sourcePaths.idle, "{outputRoot}/idle.json"] },
      { id: "documents", command: process.execPath, args: ["-e", copyScript, sourcePaths.documents, "{outputRoot}/documents.json"] },
      { id: "recovery", command: process.execPath, args: ["-e", copyScript, sourcePaths.recovery, "{outputRoot}/recovery.json"] },
    ],
  };
  const specPath = join(inputRoot, "spec.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const times = [
    new Date("2026-07-29T00:00:01.000Z"),
    new Date("2026-07-29T00:01:00.000Z"),
  ];

  const result = await runNodeMemoryQualification({
    repositoryRoot: root,
    specPath,
    decisionPath,
    outputRoot,
    now: () => times.shift(),
  });

  assert.equal(result.decision.decision, "go");
  const manifestText = await readFile(join(outputRoot, "qualification-manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.commandIds, ["build", "idle", "documents", "recovery"]);
  assert.equal(manifest.candidateRevision, exactHead);
  assert.equal(manifest.decisionFileSha256, sha256(decisionBytes));
  assert.equal(manifest.evidenceFileDigests.idle, sha256(evidence.idle));
  assert.doesNotMatch(manifestText, /node-memory-qualification-|qualification-inputs|AWS_SECRET|process\.execPath/iu);
  assert.equal(JSON.parse(await readFile(
    join(outputRoot, "qualification-decision.json"), "utf8",
  )).decision, "go");

  await writeFile(join(root, "dirty.txt"), "untracked\n");
  await assert.rejects(
    () => runNodeMemoryQualification({
      repositoryRoot: root,
      specPath,
      decisionPath,
      outputRoot: join(root, "qualification", "run-2"),
      now: () => new Date("2026-07-29T00:02:00.000Z"),
    }),
    /QUALIFICATION_WORKTREE_DIRTY/u,
  );
});

test("qualification environment drops inherited credentials and keeps runtime essentials", () => {
  const scrubbed = scrubQualificationEnvironment({
    PATH: "runtime-path",
    SYSTEMROOT: "system-root",
    TEMP: "temp-root",
    AWS_SECRET_ACCESS_KEY: "must-not-propagate",
    OPENAI_API_KEY: "must-not-propagate",
  });
  assert.deepEqual(scrubbed, {
    PATH: "runtime-path",
    SYSTEMROOT: "system-root",
    TEMP: "temp-root",
  });
});

test("prepared qualification creates an exact private spec and removes its control worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "node-memory-prepared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { controlRevision } = await createRepository(root);
  const candidateRevision = await git(root, "rev-parse", "HEAD");
  const decisionPath = join(root, "qualification", "decision.json");
  const outputRoot = join(root, "qualification", "prepared-output");
  await mkdir(dirname(decisionPath), { recursive: true });
  await writeFile(decisionPath, `${JSON.stringify(DECISION, null, 2)}\n`);
  let privateSpec;
  let privateSpecPath;

  const result = await prepareNodeMemoryQualification({
    repositoryRoot: root,
    controlRevision,
    decisionPath,
    outputRoot,
    npmCliPath: process.execPath,
  }, {
    executeQualification: async (options) => {
      privateSpecPath = options.specPath;
      privateSpec = JSON.parse(await readFile(options.specPath, "utf8"));
      return { decision: { decision: "go" } };
    },
  });

  assert.equal(result.decision.decision, "go");
  assert.equal(privateSpec.expectedHead, candidateRevision);
  assert.equal(privateSpec.controlRevision, controlRevision);
  assert.deepEqual(privateSpec.commands.map(({ id }) => id), [
    "build", "idle", "documents", "recovery",
  ]);
  assert.match(privateSpec.commands[1].args.join(" "), /--control-mcp .*dist[\\/]mcp\.js/u);
  assert.match(privateSpec.commands[1].args.join(" "), /--candidate-node-arg=--max-semi-space-size=1/u);
  for (const command of privateSpec.commands.slice(2)) {
    assert.equal(command.args[0], "--import");
    assert.match(command.args[1], /^file:\/\/\/.*tsx\/dist\/loader\.mjs$/iu);
  }
  assert.equal(privateSpec.commands[2].environment.HWP_BENCH_LARGE, "1");
  assert.equal(privateSpec.commands[3].environment.HWP_BENCH_LARGE, "1");
  await assert.rejects(() => readFile(privateSpecPath), { code: "ENOENT" });
  const controlRoot = privateSpec.commands[0].args[
    privateSpec.commands[0].args.indexOf("--control-root") + 1
  ];
  await assert.rejects(() => readFile(join(controlRoot, "tracked.txt")), { code: "ENOENT" });
});
