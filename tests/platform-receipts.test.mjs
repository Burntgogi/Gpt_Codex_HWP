import assert from "node:assert/strict";
import test from "node:test";

import {
  PINNED_HWP_FIXTURE_SHA256,
  REQUIRED_PLATFORM_STAGES,
  validatePlatformReceipt,
} from "../scripts/platform-receipts.mjs";

const EXPECTED = Object.freeze({
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  version: "0.2.0",
  platform: "darwin",
  arch: "arm64",
  runtimeSha256: "c".repeat(64),
});

function validReceipt() {
  return {
    schemaVersion: 1,
    commit: EXPECTED.commit,
    tree: EXPECTED.tree,
    version: EXPECTED.version,
    platform: EXPECTED.platform,
    arch: EXPECTED.arch,
    toolchains: {
      node: "v22.22.2",
      npm: "10.9.7",
      python: "3.12.11",
    },
    stages: REQUIRED_PLATFORM_STAGES.map((name, index) => ({
      name,
      status: "passed",
      elapsedMs: index + 1,
    })),
    toolCount: 9,
    fixtureSha256: PINNED_HWP_FIXTURE_SHA256,
    sourceUnchanged: true,
    hwpxRoundTrip: true,
    runtimeSha256: EXPECTED.runtimeSha256,
    skippedRequiredGates: 0,
  };
}

test("platform receipt accepts exact current-head redacted evidence", () => {
  const validated = validatePlatformReceipt(validReceipt(), EXPECTED);

  assert.deepEqual(validated, validReceipt());
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.toolchains), true);
  assert.equal(Object.isFrozen(validated.stages), true);
  assert.equal(Object.isFrozen(validated.stages[0]), true);
});

test("platform receipt rejects stale or mismatched identity", () => {
  for (const [field, value] of [
    ["commit", "d".repeat(40)],
    ["tree", "e".repeat(40)],
    ["version", "0.2.1"],
    ["platform", "win32"],
    ["arch", "x64"],
    ["runtimeSha256", "f".repeat(64)],
  ]) {
    const receipt = validReceipt();
    receipt[field] = value;
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_IDENTITY_MISMATCH/u,
      field,
    );
  }
});

test("platform receipt requires every gate once, passed, and measured", () => {
  const mutations = [
    (receipt) => receipt.stages.pop(),
    (receipt) => receipt.stages.push({ ...receipt.stages[0] }),
    (receipt) => { receipt.stages[0].status = "skipped"; },
    (receipt) => { receipt.stages[0].status = "failed"; },
    (receipt) => { receipt.stages[0].elapsedMs = -1; },
    (receipt) => { receipt.skippedRequiredGates = 1; },
  ];
  for (const mutate of mutations) {
    const receipt = validReceipt();
    mutate(receipt);
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_GATE_INVALID/u,
    );
  }
});

test("platform receipt requires nine tools and immutable HWP/HWPX results", () => {
  for (const [field, value] of [
    ["toolCount", 8],
    ["fixtureSha256", "0".repeat(64)],
    ["sourceUnchanged", false],
    ["hwpxRoundTrip", false],
  ]) {
    const receipt = validReceipt();
    receipt[field] = value;
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_EVIDENCE_INVALID/u,
      field,
    );
  }
});

test("platform receipt requires the pinned Node and npm toolchains with Python 3.12", () => {
  for (const [toolchain, value] of [
    ["node", "v22.22.1"],
    ["npm", "10.9.6"],
    ["python", "3.11.9"],
  ]) {
    const receipt = validReceipt();
    receipt.toolchains[toolchain] = value;
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_EVIDENCE_INVALID/u,
      toolchain,
    );
  }
});

test("platform receipt rejects logs paths environment and document content", () => {
  for (const [key, value] of [
    ["logs", "private diagnostic output"],
    ["path", "workspace/document.hwpx"],
    ["environment", { HWP_TEST_FIXTURE: "fixture.hwp" }],
    ["documentContent", "private document text"],
  ]) {
    const receipt = validReceipt();
    receipt[key] = value;
    assert.throws(
      () => validatePlatformReceipt(receipt, EXPECTED),
      /PLATFORM_RECEIPT_SHAPE_INVALID/u,
      key,
    );
  }

  const nested = validReceipt();
  nested.stages[0].stdout = "private diagnostic output";
  assert.throws(
    () => validatePlatformReceipt(nested, EXPECTED),
    /PLATFORM_RECEIPT_SHAPE_INVALID/u,
  );
});

test("platform receipt errors do not echo untrusted evidence", () => {
  const marker = "private-document-marker";
  const receipt = validReceipt();
  receipt.logs = marker;

  assert.throws(
    () => validatePlatformReceipt(receipt, EXPECTED),
    (error) => {
      assert.match(error.message, /^PLATFORM_RECEIPT_[A-Z_]+$/u);
      assert.doesNotMatch(error.message, new RegExp(marker, "u"));
      return true;
    },
  );
});
