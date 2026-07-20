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

export async function runWindowsNodeTestsDiagnostic(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const runRepositoryFile = options.runRepositoryFile
    ?? ((file) => executeBoundedNodeTestFile(file, { repository: true }));
  const runSourceDiagnostic = options.runSourceDiagnostic ?? runMacNodeTestsDiagnostic;

  for (const file of REPOSITORY_TEST_FILES) {
    let passed = false;
    try { passed = await runRepositoryFile(file) === true; } catch { passed = false; }
    if (!passed) {
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

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  await runWindowsNodeTestsDiagnostic();
}
