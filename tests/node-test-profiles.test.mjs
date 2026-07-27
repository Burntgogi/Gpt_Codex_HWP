import assert from "node:assert/strict";
import test from "node:test";

const profilesModule = await import("../scripts/node-test-profiles.mjs").catch(() => ({}));

const INSTALLED_RUNTIME_NAME =
  "installed runtime verifies provenance, npm ls, and all nine tools";
const BP16_NAME =
  "benchmark policy bounds synthetic child-tree stress and verifies every identity gone";

test("Node test profiles expose the fixed full, Windows PR, and macOS PR policy", async () => {
  assert.equal(typeof profilesModule.resolveNodeTestProfile, "function");
  assert.deepEqual(Object.keys(profilesModule.NODE_TEST_PROFILES), ["full", "pr", "pr-macos"]);

  const full = await profilesModule.resolveNodeTestProfile("full");
  const pr = await profilesModule.resolveNodeTestProfile("pr");
  const macos = await profilesModule.resolveNodeTestProfile("pr-macos");

  assert.equal(full.testFiles.length, 41);
  assert.deepEqual(full.deferredCases, []);
  assert.deepEqual(pr.deferredCases.map(({ testName }) => testName), [INSTALLED_RUNTIME_NAME]);
  assert.deepEqual(macos.deferredCases.map(({ testName }) => testName), [
    INSTALLED_RUNTIME_NAME,
    BP16_NAME,
  ]);
  assert.equal(pr.skipPatternFor("benchmark-policy.test.ts"), undefined);
  assert.equal(macos.skipPatternFor("benchmark-policy.test.ts"), `^${BP16_NAME}$`);
});

test("deferred cases carry exact file, reason, and replacement workflow ownership", () => {
  assert.deepEqual(
    profilesModule.DEFERRED_NODE_TEST_CASES.map((record) => Object.keys(record).sort()),
    [
      ["file", "id", "reason", "replacementWorkflow", "testName"],
      ["file", "id", "reason", "replacementWorkflow", "testName"],
    ],
  );
  for (const record of profilesModule.DEFERRED_NODE_TEST_CASES) {
    assert.match(record.file, /\.test\.ts$/u);
    assert.ok(record.testName.length > 20);
    assert.ok(record.reason.length > 20);
    assert.ok(record.replacementWorkflow.length > 5);
  }
});

test("skip patterns are anchored exact escapes rather than broad regular expressions", () => {
  assert.equal(
    profilesModule.createExactSkipPattern(["literal (case) [x].*?"]),
    "^literal \\(case\\) \\[x\\]\\.\\*\\?$",
  );
  assert.throws(() => profilesModule.createExactSkipPattern([]), /empty/iu);
  assert.throws(
    () => profilesModule.assertRegisteredExactSkipPattern(".*", "compact-runtime.test.ts"),
    /registered exact/iu,
  );
});

test("profile policy rejects an empty full inventory and unregistered deferred skips", async () => {
  const readSourceFile = async () => "";
  await assert.rejects(
    profilesModule.resolveNodeTestProfile("full", { testFiles: [], readSourceFile }),
    /full.*empty/iu,
  );
  await assert.rejects(
    profilesModule.resolveNodeTestProfile("pr", {
      profiles: {
        ...profilesModule.NODE_TEST_PROFILES,
        pr: { name: "pr", deferredCaseIds: ["unregistered"] },
      },
      readSourceFile,
    }),
    /unregistered/iu,
  );
});

test("preflight requires every deferred exact name to match one top-level source test", async () => {
  const sources = new Map([
    ["compact-runtime.test.ts", `test(${JSON.stringify(INSTALLED_RUNTIME_NAME)}, () => {});\n`],
    ["benchmark-policy.test.ts", `test(${JSON.stringify(BP16_NAME)}, () => {});\n`],
  ]);
  const testFiles = [...sources.keys()];
  const plan = await profilesModule.resolveNodeTestProfile("pr-macos", {
    testFiles,
    readSourceFile: async (file) => sources.get(file) ?? "",
  });
  assert.equal(plan.deferredCaseCount, 2);

  sources.set(
    "benchmark-policy.test.ts",
    `test(${JSON.stringify(BP16_NAME)}, () => {});\ntest(${JSON.stringify(BP16_NAME)}, () => {});\n`,
  );
  await assert.rejects(
    profilesModule.resolveNodeTestProfile("pr-macos", {
      testFiles,
      readSourceFile: async (file) => sources.get(file) ?? "",
    }),
    /exactly one top-level test/iu,
  );
});

test("profile CLI accepts one exact profile and rejects unknown or duplicate arguments", () => {
  assert.equal(profilesModule.parseNodeTestProfileArguments([]), "full");
  assert.equal(profilesModule.parseNodeTestProfileArguments(["--profile=pr"]), "pr");
  assert.equal(profilesModule.parseNodeTestProfileArguments(["--profile=pr-macos"]), "pr-macos");
  assert.throws(() => profilesModule.parseNodeTestProfileArguments(["--profile=wide"]), /profile/iu);
  assert.throws(
    () => profilesModule.parseNodeTestProfileArguments(["--profile=pr", "--profile=full"]),
    /argument/iu,
  );
});
