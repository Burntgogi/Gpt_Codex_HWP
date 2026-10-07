import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import {
  HwpxAnchorResolutionError,
  resolveHwpxAnchorOccurrence,
} from "../src/shared/hwpx-anchor.js";
import { pythonCommandCandidates, resolvePythonCommand } from "../src/shared/python-command.js";
import { imageHelperFailureCode } from "../src/workers/image-helper-errors.js";

test("ambiguous anchor resolution stops before reading a later section", async () => {
  const { archive, lateReads } = lazyArchive("앵커 앵커");

  await assert.rejects(
    resolveHwpxAnchorOccurrence(
      new Uint8Array([1]),
      "앵커",
      undefined,
      scanTextSection,
      async () => archive,
    ),
    (error: unknown) => {
      assert.ok(error instanceof HwpxAnchorResolutionError);
      assert.equal(error.code, "AMBIGUOUS_ANCHOR");
      return true;
    },
  );
  assert.equal(lateReads(), 0);
});

test("explicit anchor occurrence returns before reading a later section", async () => {
  const { archive, lateReads } = lazyArchive("앵커 앵커");

  assert.equal(
    await resolveHwpxAnchorOccurrence(
      new Uint8Array([1]),
      "앵커",
      1,
      scanTextSection,
      async () => archive,
    ),
    1,
  );
  assert.equal(lateReads(), 0);
});

test("anchor resolution counts only Contents/sectionN.xml like the Python helper", async () => {
  const archive = new JSZip();
  archive.file("Contents/section0.xml", "앵커");
  archive.file("Other/section1.xml", "앵커");
  archive.file("contents/section2.xml", "앵커");
  archive.file("Contents/Section3.xml", "앵커");

  assert.equal(
    await resolveHwpxAnchorOccurrence(
      new Uint8Array([1]),
      "앵커",
      undefined,
      scanTextSection,
      async () => archive,
    ),
    0,
  );
});

const encode = (value: string) => new TextEncoder().encode(value);

test("image helper failures keep user-actionable codes and hide helper messages", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['{"ok":false,"code":"ANCHOR_NOT_FOUND","error":"private anchor","matches":0}', "ANCHOR_NOT_FOUND"],
    ['{"ok":false,"code":"INVALID_IMAGE","error":"x"}\n', "INVALID_IMAGE"],
    ['{"ok":false,"code":"DRM_PROTECTED","error":"x"}', "DRM_PROTECTED"],
    ['{"ok":false,"code":"NOT_HWPX","error":"x"}', "SOURCE_HWPX_INVALID"],
    ['{"ok":false,"code":"UNSAFE_ZIP","error":"x"}', "SOURCE_HWPX_INVALID"],
    ['{"ok":false,"code":"OUTPUT_CONFLICT","error":"x"}', "IMAGE_INSERTION_FAILED"],
    ['{"ok":false,"code":"lowercase","error":"x"}', "ENGINE_PROTOCOL_ERROR"],
    ['{"ok":true,"code":"ANCHOR_NOT_FOUND"}', "ENGINE_PROTOCOL_ERROR"],
    ["Traceback (most recent call last):", "ENGINE_PROTOCOL_ERROR"],
    ["", "ENGINE_PROTOCOL_ERROR"],
    ["[]", "ENGINE_PROTOCOL_ERROR"],
  ];
  for (const [stderr, expected] of cases) {
    assert.equal(imageHelperFailureCode(encode(stderr)), expected, stderr);
  }
  assert.equal(imageHelperFailureCode(new Uint8Array([0xff, 0xfe])), "ENGINE_PROTOCOL_ERROR");
});

test("Python helper candidates are absolute trusted locations shared with doctor", () => {
  const windows = pythonCommandCandidates("win32", {
    SystemRoot: "C:/Windows",
    LOCALAPPDATA: "D:/Profiles/Local",
  });
  assert.deepEqual(windows.map((entry) => entry.argsPrefix), [["-3"], ["-3"]]);
  assert.match(windows[0]!.command, /Windows[\\/]py\.exe$/u);
  assert.match(windows[1]!.command, /Programs[\\/]Python[\\/]Launcher[\\/]py\.exe$/u);
  assert.equal(pythonCommandCandidates("win32", { SystemRoot: "C:/Windows" }).length, 1);

  const mac = pythonCommandCandidates("darwin", {}).map((entry) => entry.command);
  assert.equal(mac.at(-1), "/usr/bin/python3", "the CLT stub is tried last");
  assert.ok(mac.every((command) => command.startsWith("/")));
  assert.deepEqual(
    pythonCommandCandidates("linux", {}).map((entry) => entry.command),
    ["/usr/bin/python3", "/usr/local/bin/python3"],
  );
});

test("Python resolution skips missing candidates and reports absence", async () => {
  assert.equal(await resolvePythonCommand([{ command: "/definitely/missing/python3", argsPrefix: [] }]), undefined);
  const existing = { command: process.execPath, argsPrefix: [] };
  assert.equal(
    await resolvePythonCommand([{ command: "/definitely/missing/python3", argsPrefix: [] }, existing]),
    existing,
  );
});

function lazyArchive(firstSectionText: string): {
  archive: JSZip;
  lateReads(): number;
} {
  const archive = new JSZip();
  archive.file("Contents/section0.xml", firstSectionText);
  archive.file("Contents/section999.xml", "late");
  let reads = 0;
  const late = archive.file("Contents/section999.xml")!;
  late.async = (async () => {
    reads += 1;
    return "late";
  }) as typeof late.async;
  return { archive, lateReads: () => reads };
}

function scanTextSection(xml: string) {
  return {
    bodyParagraphs: [{
      kind: "body",
      text: xml,
      start: 0,
    }],
    tables: [],
  } as never;
}
