import { REQUIRED_RELEASE_STAGES } from "./release-verify.mjs";

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const TOOLCHAIN_VERSION_PATTERNS = Object.freeze({
  node: /^v22\.22\.2$/u,
  npm: /^10\.9\.7$/u,
  python: /^3\.12\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u,
});

const RECEIPT_KEYS = Object.freeze([
  "arch",
  "commit",
  "fixtureSha256",
  "hwpxRoundTrip",
  "platform",
  "runtimeSha256",
  "schemaVersion",
  "skippedRequiredGates",
  "sourceUnchanged",
  "stages",
  "toolCount",
  "toolchains",
  "tree",
  "version",
]);
const EXPECTATION_KEYS = Object.freeze([
  "arch",
  "commit",
  "platform",
  "runtimeSha256",
  "tree",
  "version",
]);
const TOOLCHAIN_KEYS = Object.freeze(["node", "npm", "python"]);
const STAGE_KEYS = Object.freeze(["elapsedMs", "name", "status"]);

export const PINNED_HWP_FIXTURE_SHA256 =
  "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd";

export const REQUIRED_PLATFORM_STAGES = REQUIRED_RELEASE_STAGES;

export function validatePlatformReceipt(receipt, expected) {
  assertExactObject(receipt, RECEIPT_KEYS, "PLATFORM_RECEIPT_SHAPE_INVALID");
  assertExactObject(expected, EXPECTATION_KEYS, "PLATFORM_RECEIPT_EXPECTATION_INVALID");

  if (receipt.schemaVersion !== 1) {
    throw receiptError("PLATFORM_RECEIPT_SHAPE_INVALID");
  }
  assertIdentity(expected, "PLATFORM_RECEIPT_EXPECTATION_INVALID");
  assertIdentity(receipt, "PLATFORM_RECEIPT_IDENTITY_MISMATCH");
  for (const key of EXPECTATION_KEYS) {
    if (receipt[key] !== expected[key]) {
      throw receiptError("PLATFORM_RECEIPT_IDENTITY_MISMATCH");
    }
  }

  assertExactObject(receipt.toolchains, TOOLCHAIN_KEYS, "PLATFORM_RECEIPT_SHAPE_INVALID");
  for (const key of TOOLCHAIN_KEYS) {
    if (
      typeof receipt.toolchains[key] !== "string"
      || !TOOLCHAIN_VERSION_PATTERNS[key].test(receipt.toolchains[key])
    ) {
      throw receiptError("PLATFORM_RECEIPT_EVIDENCE_INVALID");
    }
  }

  if (!Array.isArray(receipt.stages) || receipt.stages.length !== REQUIRED_PLATFORM_STAGES.length) {
    throw receiptError("PLATFORM_RECEIPT_GATE_INVALID");
  }
  const stages = receipt.stages.map((stage, index) => {
    assertExactObject(stage, STAGE_KEYS, "PLATFORM_RECEIPT_SHAPE_INVALID");
    if (
      stage.name !== REQUIRED_PLATFORM_STAGES[index]
      || stage.status !== "passed"
      || !Number.isSafeInteger(stage.elapsedMs)
      || stage.elapsedMs < 0
    ) {
      throw receiptError("PLATFORM_RECEIPT_GATE_INVALID");
    }
    return Object.freeze({
      name: stage.name,
      status: stage.status,
      elapsedMs: stage.elapsedMs,
    });
  });
  if (receipt.skippedRequiredGates !== 0) {
    throw receiptError("PLATFORM_RECEIPT_GATE_INVALID");
  }

  if (
    receipt.toolCount !== 9
    || receipt.fixtureSha256 !== PINNED_HWP_FIXTURE_SHA256
    || receipt.sourceUnchanged !== true
    || receipt.hwpxRoundTrip !== true
  ) {
    throw receiptError("PLATFORM_RECEIPT_EVIDENCE_INVALID");
  }

  return Object.freeze({
    schemaVersion: 1,
    commit: receipt.commit,
    tree: receipt.tree,
    version: receipt.version,
    platform: receipt.platform,
    arch: receipt.arch,
    toolchains: Object.freeze({
      node: receipt.toolchains.node,
      npm: receipt.toolchains.npm,
      python: receipt.toolchains.python,
    }),
    stages: Object.freeze(stages),
    toolCount: 9,
    fixtureSha256: PINNED_HWP_FIXTURE_SHA256,
    sourceUnchanged: true,
    hwpxRoundTrip: true,
    runtimeSha256: receipt.runtimeSha256,
    skippedRequiredGates: 0,
  });
}

function assertIdentity(value, code) {
  if (
    !SHA1_PATTERN.test(value.commit)
    || !SHA1_PATTERN.test(value.tree)
    || !VERSION_PATTERN.test(value.version)
    || !SHA256_PATTERN.test(value.runtimeSha256)
    || !isSupportedPlatform(value.platform, value.arch)
  ) {
    throw receiptError(code);
  }
}

function isSupportedPlatform(platform, arch) {
  return (platform === "win32" && arch === "x64")
    || (platform === "darwin" && arch === "arm64");
}

function assertExactObject(value, expectedKeys, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw receiptError(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw receiptError(code);
  }
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length) throw receiptError(code);
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (actualKeys[index] !== expectedKeys[index]) throw receiptError(code);
  }
}

function receiptError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
