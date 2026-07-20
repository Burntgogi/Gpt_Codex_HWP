import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeBoundedNodeTestFile,
  runMacNodeTestsDiagnostic,
} from "./macos-node-tests-diagnostic.mjs";

const REPOSITORY_TEST_FILES = Object.freeze([
  "dependency-contract.test.mjs", "doctor.test.mjs", "github-policy.test.mjs",
  "governance-docs.test.mjs", "kordoc-runtime-ownership.test.mjs",
  "macos-node-tests-diagnostic.test.mjs", "macos-posix-controls.test.mjs",
  "platform-receipts.test.mjs", "project-metadata.test.mjs",
  "public-content-policy.test.mjs", "release-identity.test.mjs",
  "release-verify.test.mjs", "repository-layout.test.mjs",
  "runtime-projection.test.mjs", "security-boundary-docs.test.mjs",
  "windows-node-tests-diagnostic.test.mjs", "workflow-policy.test.mjs",
]);
const KORDOC_OWNERSHIP_CASES = Object.freeze([
  "Kordoc output creation race never deletes an unowned sentinel",
  "Kordoc builder remains compatible without a file-system hook",
  "Kordoc verifier bounds files and empty directories in one streamed entry budget",
  "shared Kordoc verifier rejects every pinned provenance and tree-record deviation",
].map((pattern, index) => Object.freeze({
  id: `ko${String(index + 1).padStart(2, "0")}`,
  pattern: `^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
})));
const RELEASE_VERIFY_CASES = Object.freeze([
  "release subprocess environments scrub Git semantics and Node test context",
  "release subprocess environments preserve exact null-prototype record keys",
  "release verification binds schema 2 receipts to independent source identity",
  "release source identity ignores replacement refs and hostile Git selectors",
  "release verification package scripts use the exact public entry points",
  "release verification runs the exact required stage contract in order",
  "release stages install source dependencies and keep temp nine-tools as runtime authority",
  "release artifacts stage owns a fresh output, verifies it independently, and cleans it",
  "release artifacts stage rejects missing receipts and preserves owned temp evidence",
  "release artifact receipts must match independent identity, not only each other",
  "release artifacts stage preserves late temp evidence after its deadline",
  "release artifacts stage preserves a real temp after an expired deadline",
  "release temp cleanup quarantines first and never deletes a swapped replacement",
  "release temp cleanup preserves a file swapped after quarantine",
  "release temp cleanup follows platform path case semantics",
  "release temp cleanup accepts a canonical ancestor alias",
  "release artifact staging canonicalizes a temporary-directory ancestor alias",
  "release verification redacts command output, document data, paths, and environment",
  "release verification converts runner exceptions to a redacted failure",
  "release verification CLI emits only the receipt and exits nonzero on failure",
  "release verification CLI redacts unexpected failures and exits nonzero",
  "stage command execution is fail-closed and never returns process output",
  "composite stage commands execute sequentially",
  "composite stage commands fail fast before later commands",
  "composite stage fails closed when its final verification command fails",
  "composite stage shares one aggregate output bound across commands",
  "composite stage shares one aggregate timeout across commands",
  "stage command execution enforces output and timeout bounds",
  "Windows process-tree termination bounds taskkill and falls back",
  "POSIX process-tree termination preserves TERM-delay-KILL ordering",
  "stage command requires one passed and zero skipped focused test",
  "actual npm-wrapped real-HWP and HWPX stages satisfy their evidence oracles",
].map((pattern, index) => Object.freeze({
  id: `rv${String(index + 1).padStart(2, "0")}`,
  pattern: `^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
})));
const KORDOC_DEFAULT_STAGES = new Set([
  "output-check", "input-validate", "parent-create", "output-create", "file-write",
  "package-write", "file-records", "provenance-write", "verify", "compare", "cleanup",
]);
const KORDOC_DEFAULT_CODES = Object.freeze([
  "KORDOC_DEFAULT_OUTPUT_CHECK", "KORDOC_DEFAULT_INPUT_VALIDATE",
  "KORDOC_DEFAULT_PARENT_CREATE", "KORDOC_DEFAULT_OUTPUT_CREATE",
  "KORDOC_DEFAULT_FILE_WRITE", "KORDOC_DEFAULT_PACKAGE_WRITE",
  "KORDOC_DEFAULT_FILE_RECORDS", "KORDOC_DEFAULT_PROVENANCE_WRITE",
  "KORDOC_DEFAULT_VERIFY", "KORDOC_DEFAULT_COMPARE", "KORDOC_DEFAULT_CLEANUP",
]);
const RELEASE_ORACLE_STAGES = new Set(["real-hwp", "hwpx-roundtrip"]);
const RELEASE_ORACLE_CODES = Object.freeze([
  "RELEASE_ORACLE_REAL_HWP", "RELEASE_ORACLE_HWPX_ROUNDTRIP",
]);

export async function runWindowsNodeTestsDiagnostic(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const runRepositoryFile = options.runRepositoryFile
    ?? ((file) => executeBoundedNodeTestFile(file, { repository: true }));
  const runKordocCase = options.runKordocCase
    ?? ((record) => executeBoundedNodeTestFile("kordoc-runtime-ownership.test.mjs", {
      repository: true,
      testNamePattern: record.pattern,
    }));
  const runKordocDefaultDiagnostic = options.runKordocDefaultDiagnostic
    ?? executeKordocDefaultDiagnostic;
  const runReleaseVerifyCase = options.runReleaseVerifyCase
    ?? ((record) => executeBoundedNodeTestFile("release-verify.test.mjs", {
      repository: true,
      testNamePattern: record.pattern,
    }));
  const runReleaseOracleDiagnostic = options.runReleaseOracleDiagnostic
    ?? executeReleaseOracleDiagnostic;
  const runPublicContentDiagnostic = options.runPublicContentDiagnostic
    ?? executePublicContentDiagnostic;
  const runSourceDiagnostic = options.runSourceDiagnostic ?? runMacNodeTestsDiagnostic;

  for (const file of REPOSITORY_TEST_FILES) {
    let passed = false;
    try { passed = await runRepositoryFile(file) === true; } catch { passed = false; }
    if (!passed) {
      if (file === "kordoc-runtime-ownership.test.mjs") {
        for (const record of KORDOC_OWNERSHIP_CASES) {
          let casePassed = false;
          try { casePassed = await runKordocCase(record) === true; } catch { casePassed = false; }
          if (!casePassed) {
            if (record.id === "ko02") {
              let stage = "diagnostic-failed";
              try {
                const candidate = await runKordocDefaultDiagnostic();
                if (KORDOC_DEFAULT_STAGES.has(candidate)) stage = candidate;
              } catch {}
              stdout.write(`WINDOWS_KORDOC_DEFAULT stage=${stage}\n`);
            }
            stdout.write(`WINDOWS_REPOSITORY_TEST_CASE case=${record.id} status=failed\n`);
            setExitCode(1);
            return false;
          }
        }
        stdout.write("WINDOWS_REPOSITORY_TEST_CASE case=aggregate status=failed\n");
        setExitCode(1);
        return false;
      }
      if (file === "release-verify.test.mjs") {
        for (const record of RELEASE_VERIFY_CASES) {
          let casePassed = false;
          try { casePassed = await runReleaseVerifyCase(record) === true; } catch { casePassed = false; }
          if (!casePassed) {
            if (record.id === "rv32") {
              let stage = "diagnostic-failed";
              try {
                const candidate = await runReleaseOracleDiagnostic();
                if (RELEASE_ORACLE_STAGES.has(candidate)) stage = candidate;
              } catch {}
              stdout.write(`WINDOWS_RELEASE_ORACLE stage=${stage}\n`);
            }
            stdout.write(`WINDOWS_REPOSITORY_TEST_CASE case=${record.id} status=failed\n`);
            setExitCode(1);
            return false;
          }
        }
        stdout.write("WINDOWS_REPOSITORY_TEST_CASE case=release-aggregate status=failed\n");
        setExitCode(1);
        return false;
      }
      if (file === "public-content-policy.test.mjs") {
        let caseId = "aggregate";
        try {
          const candidate = await runPublicContentDiagnostic();
          if (/^pc(?:0[1-9]|[1-5][0-9]|6[01])$/u.test(candidate)) caseId = candidate;
        } catch {}
        stdout.write(`WINDOWS_REPOSITORY_TEST_CASE case=${caseId} status=failed\n`);
        setExitCode(1);
        return false;
      }
      stdout.write(`WINDOWS_REPOSITORY_TEST_FILE file=${file} status=failed\n`);
      setExitCode(1);
      return false;
    }
  }

  stdout.write(
    `WINDOWS_REPOSITORY_TEST_FILES status=passed files=${REPOSITORY_TEST_FILES.length}\n`,
  );
  try {
    return await runSourceDiagnostic({
      receiptPrefix: "WINDOWS",
      stdout,
      setExitCode,
    });
  } catch {
    stdout.write("WINDOWS_SOURCE_NODE_DIAGNOSTIC status=failed\n");
    setExitCode(1);
    return false;
  }
}

async function executeKordocDefaultDiagnostic() {
  let stage = "diagnostic-failed";
  await executeBoundedNodeTestFile("kordoc-runtime-ownership.test.mjs", {
    repository: true,
    testNamePattern: KORDOC_OWNERSHIP_CASES[1].pattern,
    fixedDiagnostics: KORDOC_DEFAULT_CODES,
    onFixedDiagnostic: (code) => {
      const candidate = code.slice("KORDOC_DEFAULT_".length).toLowerCase().replaceAll("_", "-");
      stage = KORDOC_DEFAULT_STAGES.has(candidate) ? candidate : "diagnostic-failed";
    },
  });
  return stage;
}

async function executeReleaseOracleDiagnostic() {
  let stage = "diagnostic-failed";
  await executeBoundedNodeTestFile("release-verify.test.mjs", {
    repository: true,
    testNamePattern: RELEASE_VERIFY_CASES[31].pattern,
    fixedDiagnostics: RELEASE_ORACLE_CODES,
    onFixedDiagnostic: (code) => {
      const candidate = code.slice("RELEASE_ORACLE_".length).toLowerCase().replaceAll("_", "-");
      stage = RELEASE_ORACLE_STAGES.has(candidate) ? candidate : "diagnostic-failed";
    },
  });
  return stage;
}

async function executePublicContentDiagnostic() {
  let ordinal;
  await executeBoundedNodeTestFile("public-content-policy.test.mjs", {
    repository: true,
    maximumTopLevelTests: 61,
    onFailedTopLevelOrdinal: (value) => { ordinal = value; },
  });
  return ordinal === undefined ? "aggregate" : `pc${String(ordinal).padStart(2, "0")}`;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runWindowsNodeTestsDiagnostic();
}
