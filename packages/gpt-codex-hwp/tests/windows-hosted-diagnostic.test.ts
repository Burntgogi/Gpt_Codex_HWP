import assert from "node:assert/strict";
import test from "node:test";

import * as childClientModule from "../src/workers/document-child-client.js";

type WindowsPhase =
  | "script-entry"
  | "assembly-verify"
  | "assembly-load"
  | "job-create"
  | "target-open"
  | "target-identity"
  | "job-bind"
  | "snapshot"
  | "baseline-rss"
  | "ready-write";

const observeWindowsSupervisorLateReadyForTest = (
  childClientModule as unknown as Readonly<{
    observeWindowsSupervisorLateReadyForTest(options: Readonly<{
      targetPid: number;
      timeoutMs: number;
      next: (timeoutMs: number) => Promise<string>;
      transcriptReceipt: () => Readonly<{
        stdoutEnded: boolean;
        stdoutFailed: boolean;
        protocolFailed: boolean;
        queuedFrames: number;
        partialBytes: number;
      }>;
      stderrPresent: () => boolean;
      phaseObserver?: (phase: WindowsPhase) => void;
    }>): Promise<string>;
  }>
).observeWindowsSupervisorLateReadyForTest;

const readWindowsSupervisorReadyFrameForTest = (
  childClientModule as unknown as Readonly<{
    readWindowsSupervisorReadyFrameForTest(options: Readonly<{
      timeoutMs: number;
      next: (timeoutMs: number) => Promise<string>;
      phaseObserver?: (phase: WindowsPhase) => void;
    }>): Promise<string>;
  }>
).readWindowsSupervisorReadyFrameForTest;

const cleanTranscript = () => ({
  stdoutEnded: false,
  stdoutFailed: false,
  protocolFailed: false,
  queuedFrames: 0,
  partialBytes: 0,
});

test("Windows late timeout classifies bounded stderr or partial output as pre-frame error", async () => {
  const pending = async (): Promise<string> => await new Promise(() => {});
  assert.equal(await observeWindowsSupervisorLateReadyForTest({
    targetPid: 8_300,
    timeoutMs: 10,
    next: pending,
    transcriptReceipt: cleanTranscript,
    stderrPresent: () => true,
  }), "late-preframe-error");
  assert.equal(await observeWindowsSupervisorLateReadyForTest({
    targetPid: 8_300,
    timeoutMs: 10,
    next: pending,
    transcriptReceipt: () => ({ ...cleanTranscript(), partialBytes: 1 }),
    stderrPresent: () => false,
  }), "late-preframe-error");
});

test("Windows diagnostic phase frames are consumed without becoming READY", async () => {
  const phases: WindowsPhase[] = [];
  const frames = [
    "GPT_CODEX_HWP_JOB PHASE script-entry",
    "GPT_CODEX_HWP_JOB PHASE assembly-verify",
    "GPT_CODEX_HWP_JOB PHASE snapshot",
    "GPT_CODEX_HWP_JOB READY 8300 1 47",
  ];
  const ready = await readWindowsSupervisorReadyFrameForTest({
    timeoutMs: 250,
    next: async () => {
      const frame = frames.shift();
      if (frame === undefined) return await new Promise(() => {});
      return frame;
    },
    phaseObserver: (phase) => phases.push(phase),
  });
  assert.equal(ready, "GPT_CODEX_HWP_JOB READY 8300 1 47");
  assert.deepEqual(phases, ["script-entry", "assembly-verify", "snapshot"]);
});

test("Windows late observer consumes fixed phases but never promotes late READY", async () => {
  const phases: WindowsPhase[] = [];
  const frames = [
    "GPT_CODEX_HWP_JOB PHASE baseline-rss",
    "GPT_CODEX_HWP_JOB PHASE ready-write",
    "GPT_CODEX_HWP_JOB READY 8300 1 47",
  ];
  assert.equal(await observeWindowsSupervisorLateReadyForTest({
    targetPid: 8_300,
    timeoutMs: 250,
    next: async () => {
      const frame = frames.shift();
      if (frame === undefined) return await new Promise(() => {});
      return frame;
    },
    transcriptReceipt: cleanTranscript,
    stderrPresent: () => false,
    phaseObserver: (phase) => phases.push(phase),
  }), "ready-late");
  assert.deepEqual(phases, ["baseline-rss", "ready-write"]);
});

test("Windows hosted phase formatter accepts only exact fixed-enum tuples", async () => {
  const diagnostics = await import("../benchmarks/hosted-platform-diagnostics.mjs");
  assert.equal(
    diagnostics.formatHostedWindowsSupervisorPhaseDiagnostic({ boundary: "snapshot" }),
    "HOSTED_WINDOWS_SUPERVISOR_PHASE boundary=snapshot",
  );
  for (const value of [
    { boundary: "PRIVATE RAW VALUE" },
    { boundary: "snapshot", raw: "PRIVATE" },
    { boundary: "snapshot\nPRIVATE" },
  ]) {
    assert.throws(
      () => diagnostics.formatHostedWindowsSupervisorPhaseDiagnostic(value),
      { code: "HOSTED_DIAGNOSTIC_INVALID" },
    );
  }
});

test("real Windows hosted diagnostic records a pre-READY phase without changing success", {
  skip: process.platform !== "win32" ? "Windows hosted supervisor integration" : false,
}, async () => {
  const diagnostics = await import("../benchmarks/hosted-platform-diagnostics.mjs");
  const result = await diagnostics.runHostedWindowsSupervisorDiagnostic();
  assert.deepEqual(result.production, { boundary: "target-close" });
  assert.deepEqual(result.phase, { boundary: "ready-write" });
});
