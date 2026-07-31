import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  evaluateNodeMemoryQualification,
  qualificationSemanticDigest,
  validateGateDecision,
} from "./node-memory-gate.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const COMMAND_IDS = Object.freeze(["build", "idle", "documents", "recovery"]);
const EVIDENCE_IDS = Object.freeze(["idle", "documents", "recovery"]);
const MAX_CAPTURE_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const SAFE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

function qualificationRunError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function qualificationCommandFailureCode(commandId, stderr) {
  if (!COMMAND_IDS.includes(commandId)) {
    throw qualificationRunError("QUALIFICATION_SPEC_INVALID");
  }
  const base = `QUALIFICATION_COMMAND_FAILED_${commandId.toUpperCase()}`;
  const childCode = typeof stderr === "string" ? stderr.trim() : "";
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(childCode) ? `${base}_${childCode}` : base;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactTimestamp(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.valueOf())) {
    throw qualificationRunError("QUALIFICATION_CLOCK_INVALID");
  }
  return date.toISOString();
}

export function scrubQualificationEnvironment(source = process.env) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(source)) {
    if (SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase()) && typeof value === "string") {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

function validateCommand(value, expectedId) {
  const keys = value?.environment === undefined
    ? ["args", "command", "id"]
    : ["args", "command", "environment", "id"];
  if (!exactKeys(value, keys) || value.id !== expectedId
    || typeof value.command !== "string" || !isAbsolute(value.command)
    || !Array.isArray(value.args) || value.args.length > 64
    || value.args.some((argument) => typeof argument !== "string" || argument.length > 32_768)) {
    throw qualificationRunError("QUALIFICATION_SPEC_INVALID");
  }
  if (value.environment !== undefined
    && (!exactKeys(value.environment, ["HWP_BENCH_LARGE"])
      || value.environment.HWP_BENCH_LARGE !== "1")) {
    throw qualificationRunError("QUALIFICATION_SPEC_INVALID");
  }
  return value;
}

function validateSpec(value) {
  if (!exactKeys(value, [
    "commands",
    "controlRevision",
    "decisionSha256",
    "evidenceFiles",
    "expectedHead",
    "schemaVersion",
  ]) || value.schemaVersion !== 1
    || !REVISION_PATTERN.test(value.expectedHead)
    || !REVISION_PATTERN.test(value.controlRevision)
    || !HASH_PATTERN.test(value.decisionSha256)
    || !Array.isArray(value.commands) || value.commands.length !== COMMAND_IDS.length
    || !exactKeys(value.evidenceFiles, EVIDENCE_IDS)) {
    throw qualificationRunError("QUALIFICATION_SPEC_INVALID");
  }
  for (const [index, id] of COMMAND_IDS.entries()) validateCommand(value.commands[index], id);
  for (const id of EVIDENCE_IDS) {
    if (typeof value.evidenceFiles[id] !== "string"
      || !/^[a-z0-9][a-z0-9._-]{0,63}\.json$/u.test(value.evidenceFiles[id])) {
      throw qualificationRunError("QUALIFICATION_SPEC_INVALID");
    }
  }
  return value;
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw qualificationRunError(code);
  }
}

async function git(repositoryRoot, args, { allowNonZero = false } = {}) {
  const result = await runBoundedCommand({
    command: "git",
    args,
    cwd: repositoryRoot,
    environment: scrubQualificationEnvironment(),
  });
  if (!allowNonZero && result.exitCode !== 0) {
    throw qualificationRunError("QUALIFICATION_GIT_FAILED");
  }
  return result;
}

function runBoundedCommand({ command, args, cwd, environment }) {
  return new Promise((resolveCommand, rejectCommand) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) rejectCommand(error);
      else resolveCommand(result);
    };
    const capture = (target) => (chunk) => {
      if (settled) return;
      const next = Buffer.concat([target === "stdout" ? stdout : stderr, chunk]);
      if (next.length > MAX_CAPTURE_BYTES) {
        child.kill();
        finish(qualificationRunError("QUALIFICATION_COMMAND_OUTPUT_EXCEEDED"));
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.once("error", () => finish(qualificationRunError("QUALIFICATION_COMMAND_START_FAILED")));
    child.once("close", (exitCode, signal) => finish(undefined, {
      exitCode: exitCode ?? -1,
      signal,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
    }));
    const timer = setTimeout(() => {
      child.kill();
      finish(qualificationRunError("QUALIFICATION_COMMAND_TIMEOUT"));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
  });
}

async function assertRepositoryState(repositoryRoot, expectedHead) {
  const requestedRoot = await realpath(repositoryRoot);
  const discovered = (await git(repositoryRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const discoveredRoot = await realpath(discovered);
  if (requestedRoot.toLowerCase() !== discoveredRoot.toLowerCase()) {
    throw qualificationRunError("QUALIFICATION_REPOSITORY_MISMATCH");
  }
  const status = (await git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]))
    .stdout.trim();
  if (status.length !== 0) throw qualificationRunError("QUALIFICATION_WORKTREE_DIRTY");
  const head = (await git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== expectedHead) throw qualificationRunError("QUALIFICATION_HEAD_MISMATCH");
  return head;
}

function assertInsideRepository(repositoryRoot, outputRoot) {
  const relation = relative(repositoryRoot, outputRoot);
  if (relation.length === 0 || relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(relation)) {
    throw qualificationRunError("QUALIFICATION_OUTPUT_UNSAFE");
  }
}

async function assertIgnoredOutput(repositoryRoot, outputRoot) {
  const result = await git(repositoryRoot, ["check-ignore", "-q", "--", outputRoot], {
    allowNonZero: true,
  });
  if (result.exitCode !== 0) throw qualificationRunError("QUALIFICATION_OUTPUT_NOT_IGNORED");
}

function expandArguments(args, outputRoot) {
  return args.map((argument) => argument.replaceAll("{outputRoot}", outputRoot));
}

async function readEvidence(outputRoot, filename) {
  const path = resolve(outputRoot, filename);
  if (dirname(path) !== resolve(outputRoot)) {
    throw qualificationRunError("QUALIFICATION_EVIDENCE_PATH_INVALID");
  }
  const metadata = await lstat(path).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw qualificationRunError("QUALIFICATION_EVIDENCE_FILE_INVALID");
  }
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw qualificationRunError("QUALIFICATION_EVIDENCE_FILE_INVALID");
  }
  return { bytes, value };
}

function preparedSpec({
  repositoryRoot,
  controlRoot,
  controlRevision,
  candidateRevision,
  decisionSha256,
  npmCliPath,
}) {
  const packageRelative = join("packages", "gpt-codex-hwp");
  const candidatePackage = join(repositoryRoot, packageRelative);
  const controlPackage = join(controlRoot, packageRelative);
  const benchmarkRoot = join(candidatePackage, "benchmarks");
  const tsxLoader = pathToFileURL(
    join(candidatePackage, "node_modules", "tsx", "dist", "loader.mjs"),
  ).href;
  return {
    schemaVersion: 1,
    expectedHead: candidateRevision,
    controlRevision,
    decisionSha256,
    evidenceFiles: {
      idle: "idle.json",
      documents: "documents.json",
      recovery: "recovery.json",
    },
    commands: [
      {
        id: "build",
        command: process.execPath,
        args: [
          fileURLToPath(import.meta.url),
          "build-runtimes",
          "--control-root",
          controlRoot,
          "--npm-cli",
          npmCliPath,
        ],
      },
      {
        id: "idle",
        command: process.execPath,
        args: [
          join(benchmarkRoot, "mcp-idle-memory.mjs"),
          "--runtime=node",
          "--sessions", "1,5,20",
          "--pairs", "5",
          "--control-mcp", join(controlPackage, "dist", "mcp.js"),
          "--candidate-mcp", join(candidatePackage, "dist", "mcp.js"),
          "--output", "{outputRoot}/idle.json",
          "--control-revision", controlRevision,
          "--candidate-revision", candidateRevision,
          "--candidate-node-arg=--max-semi-space-size=1",
        ],
      },
      {
        id: "documents",
        command: process.execPath,
        args: [
          "--import",
          tsxLoader,
          join(benchmarkRoot, "node-phase-a-document-paired.mjs"),
          "--sizes", "10,100",
          "--pairs", "5",
          "--output", "{outputRoot}/documents.json",
        ],
        environment: { HWP_BENCH_LARGE: "1" },
      },
      {
        id: "recovery",
        command: process.execPath,
        args: [
          "--import",
          tsxLoader,
          join(benchmarkRoot, "node-phase-a-recovery.mjs"),
          "--size", "100",
          "--output", "{outputRoot}/recovery.json",
        ],
        environment: { HWP_BENCH_LARGE: "1" },
      },
    ],
  };
}

export async function prepareNodeMemoryQualification({
  repositoryRoot,
  controlRevision,
  decisionPath,
  outputRoot,
  npmCliPath = process.env.npm_execpath,
  now = () => new Date(),
}, {
  executeQualification = runNodeMemoryQualification,
} = {}) {
  const root = resolve(repositoryRoot);
  if (!REVISION_PATTERN.test(controlRevision)
    || typeof npmCliPath !== "string" || !isAbsolute(npmCliPath)) {
    throw qualificationRunError("QUALIFICATION_PREPARE_INVALID");
  }
  const candidateRevision = await assertRepositoryState(root,
    (await git(root, ["rev-parse", "HEAD"])).stdout.trim());
  await git(root, ["cat-file", "-e", `${controlRevision}^{commit}`]);
  const decisionBytes = await readFile(decisionPath).catch(() => {
    throw qualificationRunError("QUALIFICATION_DECISION_INVALID");
  });
  const privateRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-qualification-"));
  const controlRoot = join(privateRoot, "control");
  const specPath = join(privateRoot, "qualification-spec.json");
  let worktreeAdded = false;
  try {
    await git(root, ["worktree", "add", "--detach", controlRoot, controlRevision]);
    worktreeAdded = true;
    const spec = preparedSpec({
      repositoryRoot: root,
      controlRoot,
      controlRevision,
      candidateRevision,
      decisionSha256: sha256(decisionBytes),
      npmCliPath,
    });
    validateSpec(spec);
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return await executeQualification({
      repositoryRoot: root,
      specPath,
      decisionPath,
      outputRoot,
      now,
    });
  } finally {
    if (worktreeAdded) {
      await git(root, ["worktree", "remove", "--force", controlRoot], { allowNonZero: true });
    }
    await rm(privateRoot, { recursive: true, force: true });
  }
}

async function buildQualificationRuntimes({ repositoryRoot, controlRoot, npmCliPath }) {
  const packages = [
    join(repositoryRoot, "packages", "gpt-codex-hwp"),
    join(controlRoot, "packages", "gpt-codex-hwp"),
  ];
  for (const packageRoot of packages) {
    for (const args of [
      [npmCliPath, "ci", "--ignore-scripts", "--prefix", packageRoot],
      [npmCliPath, "--prefix", packageRoot, "run", "build"],
    ]) {
      const result = await runBoundedCommand({
        command: process.execPath,
        args,
        cwd: repositoryRoot,
        environment: scrubQualificationEnvironment(),
      });
      if (result.exitCode !== 0 || result.signal !== null) {
        throw qualificationRunError("QUALIFICATION_BUILD_FAILED");
      }
    }
  }
}

export async function runNodeMemoryQualification({
  repositoryRoot,
  specPath,
  decisionPath,
  outputRoot,
  now = () => new Date(),
}) {
  const root = resolve(repositoryRoot);
  const output = resolve(outputRoot);
  assertInsideRepository(root, output);
  const spec = validateSpec(await readJson(specPath, "QUALIFICATION_SPEC_INVALID"));
  await assertRepositoryState(root, spec.expectedHead);
  await git(root, ["cat-file", "-e", `${spec.controlRevision}^{commit}`]);
  await assertIgnoredOutput(root, output);

  const decisionBytes = await readFile(decisionPath).catch(() => {
    throw qualificationRunError("QUALIFICATION_DECISION_INVALID");
  });
  if (sha256(decisionBytes) !== spec.decisionSha256) {
    throw qualificationRunError("QUALIFICATION_DECISION_HASH_MISMATCH");
  }
  let decision;
  try {
    decision = validateGateDecision(JSON.parse(decisionBytes.toString("utf8")));
  } catch {
    throw qualificationRunError("QUALIFICATION_DECISION_INVALID");
  }
  const measurementStartedAt = exactTimestamp(now());
  if (Date.parse(decision.approvedAt) >= Date.parse(measurementStartedAt)) {
    throw qualificationRunError("QUALIFICATION_DECISION_STALE");
  }

  await mkdir(dirname(output), { recursive: true });
  await mkdir(output).catch((error) => {
    if (error?.code === "EEXIST") throw qualificationRunError("QUALIFICATION_OUTPUT_EXISTS");
    throw error;
  });
  const baseEnvironment = scrubQualificationEnvironment();
  for (const commandSpec of spec.commands) {
    const result = await runBoundedCommand({
      command: commandSpec.command,
      args: expandArguments(commandSpec.args, output),
      cwd: root,
      environment: { ...baseEnvironment, ...(commandSpec.environment ?? {}) },
    });
    if (result.exitCode !== 0 || result.signal !== null) {
      throw qualificationRunError(qualificationCommandFailureCode(commandSpec.id, result.stderr));
    }
  }
  await assertRepositoryState(root, spec.expectedHead);

  const evidence = {};
  for (const id of EVIDENCE_IDS) {
    evidence[id] = await readEvidence(output, spec.evidenceFiles[id]);
  }
  const generatedAt = exactTimestamp(now());
  const manifest = Object.freeze({
    schemaVersion: 1,
    measurementStartedAt,
    generatedAt,
    controlRevision: spec.controlRevision,
    candidateRevision: spec.expectedHead,
    decisionSha256: qualificationSemanticDigest(decision),
    decisionFileSha256: sha256(decisionBytes),
    evidenceDigests: Object.freeze(Object.fromEntries(
      EVIDENCE_IDS.map((id) => [id, qualificationSemanticDigest(evidence[id].value)]),
    )),
    evidenceFileDigests: Object.freeze(Object.fromEntries(
      EVIDENCE_IDS.map((id) => [id, sha256(evidence[id].bytes)]),
    )),
    commandIds: COMMAND_IDS,
  });
  const qualificationDecision = evaluateNodeMemoryQualification({
    decision,
    manifest,
    idle: evidence.idle.value,
    documents: evidence.documents.value,
    recovery: evidence.recovery.value,
  });
  await writeFile(
    resolve(output, "qualification-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    resolve(output, "qualification-decision.json"),
    `${JSON.stringify(qualificationDecision, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return Object.freeze({ manifest, decision: qualificationDecision });
}

function parseCli(args) {
  if (Array.isArray(args) && args.length === 7 && args[0] === "prepare"
    && args[1] === "--control-revision" && args[3] === "--decision"
    && args[5] === "--output") {
    return {
      mode: "prepare",
      controlRevision: args[2],
      decisionPath: args[4],
      outputRoot: args[6],
    };
  }
  if (Array.isArray(args) && args.length === 5 && args[0] === "build-runtimes"
    && args[1] === "--control-root" && args[3] === "--npm-cli") {
    return { mode: "build-runtimes", controlRoot: args[2], npmCliPath: args[4] };
  }
  if (!Array.isArray(args) || args.length !== 6
    || args[0] !== "--spec" || args[2] !== "--decision" || args[4] !== "--output") {
    throw qualificationRunError("QUALIFICATION_USAGE_INVALID");
  }
  return { mode: "spec", specPath: args[1], decisionPath: args[3], outputRoot: args[5] };
}

async function main() {
  try {
    const request = parseCli(process.argv.slice(2));
    if (request.mode === "build-runtimes") {
      await buildQualificationRuntimes({ repositoryRoot: process.cwd(), ...request });
      return;
    }
    const result = request.mode === "prepare"
      ? await prepareNodeMemoryQualification({ repositoryRoot: process.cwd(), ...request })
      : await runNodeMemoryQualification({ repositoryRoot: process.cwd(), ...request });
    process.stdout.write(`NODE_MEMORY_QUALIFICATION_${result.decision.decision === "go" ? "GO" : "NO_GO"}\n`);
    process.exitCode = result.decision.decision === "go" ? 0 : 1;
  } catch (error) {
    const code = typeof error?.code === "string" && error.code.startsWith("QUALIFICATION_")
      ? error.code
      : "QUALIFICATION_INTERNAL_ERROR";
    process.stderr.write(`NODE_MEMORY_QUALIFICATION_INVALID code=${code}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
