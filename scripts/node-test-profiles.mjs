import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_TEST_ROOT = resolve(PROJECT_ROOT, "packages/gpt-codex-hwp/tests");

export const SOURCE_NODE_TEST_FILES = Object.freeze([
  "allowed-roots.test.ts", "assets.test.ts", "benchmark-policy.test.ts",
  "bounded-frame.test.ts", "build-assets.test.ts", "compact-runtime.test.ts",
  "doctor-command-runner.test.ts", "doctor.test.ts", "document-child-client.test.ts",
  "document-contract.test.ts", "document-mutation-preflight.test.ts",
  "document-process-registration.test.ts", "document-protocol.test.ts",
  "document-snapshot.test.ts", "document-worker-client.test.ts",
  "document-worker-operations.test.ts", "files.test.ts", "font-integrity.test.ts",
  "hwp-fixture-integrity.test.ts", "hwp-fixture.test.ts", "hwp-plugin.test.ts",
  "hwpx-anchor.test.ts", "kordoc-core-runtime.test.ts", "markdown-output.test.ts",
  "mcp-cancellation-progress.test.ts", "mcp-smoke.test.ts",
  "output-budget-atomicity.test.ts", "patch.test.ts", "paths.test.ts",
  "protection.test.ts", "public-runtime-privacy.test.ts", "read-worker-safety.test.ts",
  "release-artifacts.test.ts", "release-metadata.test.ts", "result.test.ts",
  "rhwp-backend.test.ts", "runtime-projection.test.ts", "tools.test.ts",
  "validation-regressions.test.ts", "windows-hosted-diagnostic.test.ts",
  "write-worker-safety.test.ts",
]);

export const DEFERRED_NODE_TEST_CASES = Object.freeze([
  Object.freeze({
    id: "installed-runtime-stress",
    file: "compact-runtime.test.ts",
    testName: "installed runtime verifies provenance, npm ls, and all nine tools",
    reason: "Fresh installation, provenance, dependency, audit, and nine-tool stress is too broad for the PR source profile.",
    replacementWorkflow: "Security policy plus scheduled compatibility and the full release gate",
  }),
  Object.freeze({
    id: "macos-bp16-process-tree-stress",
    file: "benchmark-policy.test.ts",
    testName: "benchmark policy bounds synthetic child-tree stress and verifies every identity gone",
    reason: "The 24-child process-tree stress has demonstrated hosted macOS scheduling variance while retaining strict cleanup semantics.",
    replacementWorkflow: "Scheduled macOS compatibility and the full release gate",
  }),
]);

export const NODE_TEST_PROFILES = Object.freeze({
  full: Object.freeze({ name: "full", deferredCaseIds: Object.freeze([]) }),
  pr: Object.freeze({
    name: "pr",
    deferredCaseIds: Object.freeze(["installed-runtime-stress"]),
  }),
  "pr-macos": Object.freeze({
    name: "pr-macos",
    deferredCaseIds: Object.freeze([
      "installed-runtime-stress",
      "macos-bp16-process-tree-stress",
    ]),
  }),
});

export function parseNodeTestProfileArguments(args) {
  if (!Array.isArray(args) || args.length > 1) {
    throw new Error("Expected zero arguments or one exact --profile argument.");
  }
  if (args.length === 0) return "full";
  const match = /^--profile=(full|pr|pr-macos)$/u.exec(args[0]);
  if (match === null) throw new Error("Unknown Node test profile argument.");
  return match[1];
}

export function createExactSkipPattern(testNames) {
  if (!Array.isArray(testNames) || testNames.length === 0) {
    throw new Error("Cannot create an exact skip pattern from an empty test-name list.");
  }
  const escaped = testNames.map((name) => {
    if (typeof name !== "string" || name.length === 0 || /[\r\n]/u.test(name)) {
      throw new Error("Deferred test names must be nonempty single-line strings.");
    }
    return escapeRegExp(name);
  });
  return escaped.length === 1 ? `^${escaped[0]}$` : `^(?:${escaped.join("|")})$`;
}

export function assertRegisteredExactSkipPattern(pattern, file) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("A test skip must be one registered exact pattern.");
  }
  const records = DEFERRED_NODE_TEST_CASES.filter((record) => record.file === file);
  const allowed = new Set(records.map((record) => createExactSkipPattern([record.testName])));
  if (!allowed.has(pattern)) {
    throw new Error("A test skip must be one registered exact pattern for its source file.");
  }
  return pattern;
}

export async function resolveNodeTestProfile(profileName = "full", options = {}) {
  const testFiles = options.testFiles ?? SOURCE_NODE_TEST_FILES;
  const profiles = options.profiles ?? NODE_TEST_PROFILES;
  const deferredCases = options.deferredCases ?? DEFERRED_NODE_TEST_CASES;
  const readSourceFile = options.readSourceFile
    ?? ((file) => readFile(resolve(PACKAGE_TEST_ROOT, file), "utf8"));

  validateDefinitions(profileName, testFiles, profiles, deferredCases);
  const sourceByFile = new Map();
  for (const file of testFiles) sourceByFile.set(file, await readSourceFile(file));
  for (const record of deferredCases) {
    let matches = 0;
    let matchedFile;
    for (const [file, source] of sourceByFile) {
      const count = countTopLevelTest(source, record.testName);
      if (count > 0) matchedFile = file;
      matches += count;
    }
    if (matches !== 1 || matchedFile !== record.file) {
      throw new Error(
        `Deferred case ${record.id} must match exactly one top-level test in ${record.file}.`,
      );
    }
  }

  const registry = new Map(deferredCases.map((record) => [record.id, record]));
  const profile = profiles[profileName];
  const selected = Object.freeze(profile.deferredCaseIds.map((id) => registry.get(id)));
  const patterns = new Map();
  for (const file of testFiles) {
    const names = selected.filter((record) => record.file === file).map((record) => record.testName);
    if (names.length > 0) patterns.set(file, createExactSkipPattern(names));
  }
  return Object.freeze({
    name: profileName,
    testFiles: Object.freeze([...testFiles]),
    deferredCases: selected,
    deferredCaseCount: selected.length,
    skipPatternFor(file) { return patterns.get(file); },
    isDeferred(file, testName) {
      return selected.some((record) => record.file === file && record.testName === testName);
    },
  });
}

function validateDefinitions(profileName, testFiles, profiles, deferredCases) {
  if (!Array.isArray(testFiles) || testFiles.length === 0) {
    throw new Error("The full Node test profile inventory cannot be empty.");
  }
  if (new Set(testFiles).size !== testFiles.length
    || testFiles.some((file) => typeof file !== "string" || !/^[a-z0-9-]+\.test\.ts$/u.test(file))) {
    throw new Error("The full Node test profile inventory is invalid.");
  }
  if (profiles === null || typeof profiles !== "object"
    || Object.keys(profiles).join(",") !== "full,pr,pr-macos") {
    throw new Error("Node test profiles must be exactly full, pr, and pr-macos.");
  }
  if (!(profileName in profiles)) throw new Error("Unknown Node test profile.");
  if (!Array.isArray(deferredCases) || deferredCases.length !== 2) {
    throw new Error("The deferred Node test registry is invalid.");
  }
  const registry = new Map();
  for (const record of deferredCases) {
    if (record === null || typeof record !== "object"
      || typeof record.id !== "string" || record.id.length === 0
      || typeof record.file !== "string" || !testFiles.includes(record.file)
      || typeof record.testName !== "string" || record.testName.length === 0
      || /[\r\n]/u.test(record.testName)
      || typeof record.reason !== "string" || record.reason.trim().length === 0
      || typeof record.replacementWorkflow !== "string"
      || record.replacementWorkflow.trim().length === 0
      || registry.has(record.id)) {
      throw new Error("Deferred Node test cases must be exact registered records.");
    }
    registry.set(record.id, record);
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile?.name !== name || !Array.isArray(profile.deferredCaseIds)
      || new Set(profile.deferredCaseIds).size !== profile.deferredCaseIds.length) {
      throw new Error("Node test profile definition is invalid.");
    }
    for (const id of profile.deferredCaseIds) {
      if (!registry.has(id)) throw new Error(`Node test profile contains unregistered skip ${id}.`);
    }
  }
  if (profiles.full.deferredCaseIds.length !== 0
    || profiles.pr.deferredCaseIds.join(",") !== "installed-runtime-stress"
    || profiles["pr-macos"].deferredCaseIds.join(",")
      !== "installed-runtime-stress,macos-bp16-process-tree-stress") {
    throw new Error("Node test profile deferred ownership is invalid.");
  }
}

function countTopLevelTest(source, testName) {
  if (typeof source !== "string") throw new Error("Test source must be text.");
  const pattern = new RegExp(
    `^test\\(\\s*([\"'\`])${escapeRegExp(testName)}\\1\\s*,`,
    "gmu",
  );
  return [...source.matchAll(pattern)].length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
