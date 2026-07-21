import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const TRACKED_FIXTURE = fileURLToPath(new URL(
  "../tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp",
  import.meta.url,
));
const TRACKED_PROVENANCE = fileURLToPath(new URL(
  "../tests/fixtures/rhwp/provenance.json",
  import.meta.url,
));
const FIXTURE_ENVIRONMENT_VARIABLE = "HWP_TEST_FIXTURE";
const MAX_HWP_FIXTURE_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const EXPECTED_PROVENANCE = Object.freeze({
  project: "rhwp",
  repository: "https://github.com/edwardkim/rhwp",
  release: "v0.7.17",
  revision: "03351190ec35436e58cbfee0aa9278a8fdc04a59",
  additionRevision: "a200cfd93d100a6f20f29bb0b836b4bc6faa37fd",
  path: "samples/re-01-hangul-only-hancom.hwp",
  gitBlobSha1: "408e850375cede568ee23c91f6ff5b6d011faba3",
  bytes: 8_704,
  sha256: "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd",
  license: "MIT",
  licensePath: "LICENSE",
  licenseUrl:
    "https://raw.githubusercontent.com/edwardkim/rhwp/03351190ec35436e58cbfee0aa9278a8fdc04a59/LICENSE",
  licenseBytes: 1_072,
  licenseSha256:
    "1c3a7d5643b163a3ead4965e1bea33b832caee5bfca265efe42afcd7bc696b5b",
  copyright: "Copyright (c) 2025-2026 Edward Kim",
});

export class HwpFixtureError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "HwpFixtureError";
    this.code = code;
  }
}

export async function resolveHwpFixture(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw fixtureError("HWP_FIXTURE_OPTIONS_INVALID", "Fixture options are invalid.");
  }
  const explicitOverridePresent = Object.hasOwn(options, "overridePath");
  const environmentOverridePresent = process.env[FIXTURE_ENVIRONMENT_VARIABLE] !== undefined;
  if (options.requireTracked !== undefined && typeof options.requireTracked !== "boolean") {
    throw fixtureError("HWP_FIXTURE_OPTIONS_INVALID", "Fixture options are invalid.");
  }
  if (options.requireTracked === true
    && (explicitOverridePresent || environmentOverridePresent)) {
    throw fixtureError(
      "HWP_FIXTURE_OVERRIDE_FORBIDDEN",
      "Tracked fixture mode does not permit overrides.",
    );
  }

  if (explicitOverridePresent) {
    return await resolveDiagnosticFixture(options.overridePath);
  }
  if (environmentOverridePresent) {
    return await resolveDiagnosticFixture(process.env[FIXTURE_ENVIRONMENT_VARIABLE]);
  }
  return await resolveTrackedFixture();
}

async function resolveTrackedFixture() {
  const provenance = await readTrackedProvenance();
  const fixture = await readRegularHwp(TRACKED_FIXTURE);
  if (fixture.bytes !== provenance.bytes) {
    throw fixtureError(
      "HWP_FIXTURE_SIZE_MISMATCH",
      "Tracked fixture size does not match its pinned provenance.",
    );
  }
  if (fixture.sha256 !== provenance.sha256) {
    throw fixtureError(
      "HWP_FIXTURE_SHA256_MISMATCH",
      "Tracked fixture digest does not match its pinned provenance.",
    );
  }
  return Object.freeze({
    path: TRACKED_FIXTURE,
    bytes: fixture.bytes,
    sha256: fixture.sha256,
    provenance,
  });
}

async function resolveDiagnosticFixture(overridePath) {
  if (typeof overridePath !== "string" || overridePath.trim().length === 0) {
    throw fixtureError(
      "HWP_FIXTURE_OVERRIDE_INVALID",
      "The diagnostic fixture override is invalid.",
    );
  }
  const path = resolve(overridePath);
  const fixture = await readRegularHwp(path);
  return Object.freeze({
    path,
    bytes: fixture.bytes,
    sha256: fixture.sha256,
    provenance: Object.freeze({ kind: "diagnostic", tracked: false }),
  });
}

async function readTrackedProvenance() {
  let serialized;
  try {
    serialized = await readFile(TRACKED_PROVENANCE, "utf8");
  } catch {
    throw fixtureError(
      "HWP_FIXTURE_PROVENANCE_NOT_FOUND",
      "Tracked fixture provenance is unavailable.",
    );
  }
  let provenance;
  try {
    provenance = JSON.parse(serialized);
  } catch {
    throw fixtureError(
      "HWP_FIXTURE_PROVENANCE_INVALID",
      "Tracked fixture provenance is invalid.",
    );
  }
  if (!isDeepStrictEqual(provenance, EXPECTED_PROVENANCE)) {
    throw fixtureError(
      "HWP_FIXTURE_PROVENANCE_MISMATCH",
      "Tracked fixture provenance does not match the pinned record.",
    );
  }
  return Object.freeze({ ...provenance });
}

async function readRegularHwp(path) {
  if (extname(path).toLowerCase() !== ".hwp") {
    throw fixtureError(
      "HWP_FIXTURE_EXTENSION_INVALID",
      "The fixture must use the .hwp extension.",
    );
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT") {
      throw fixtureError("HWP_FIXTURE_NOT_FOUND", "The HWP fixture is unavailable.");
    }
    throw fixtureError("HWP_FIXTURE_UNREADABLE", "The HWP fixture cannot be inspected.");
  }
  if (!metadata.isFile()) {
    throw fixtureError(
      "HWP_FIXTURE_NOT_REGULAR",
      "The HWP fixture must be a regular file.",
    );
  }
  assertHwpFixtureByteLimit(metadata.size);
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT") {
      throw fixtureError("HWP_FIXTURE_NOT_FOUND", "The HWP fixture is unavailable.");
    }
    throw fixtureError("HWP_FIXTURE_UNREADABLE", "The HWP fixture cannot be opened.");
  }
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw fixtureError(
        "HWP_FIXTURE_NOT_REGULAR",
        "The HWP fixture must be a regular file.",
      );
    }
    assertHwpFixtureByteLimit(openedMetadata.size);
    if (!sameFileIdentity(metadata, openedMetadata)) {
      throw fixtureError(
        "HWP_FIXTURE_IDENTITY_MISMATCH",
        "The HWP fixture changed while it was being opened.",
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, openedMetadata.size)));
    let position = 0;
    while (position < openedMetadata.size) {
      const length = Math.min(buffer.byteLength, openedMetadata.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) {
        throw fixtureError(
          "HWP_FIXTURE_CHANGED_DURING_READ",
          "The HWP fixture changed while it was being hashed.",
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (!sameFileIdentity(openedMetadata, finalMetadata)
      || finalMetadata.size !== openedMetadata.size
      || finalMetadata.mtimeMs !== openedMetadata.mtimeMs
      || finalMetadata.ctimeMs !== openedMetadata.ctimeMs) {
      throw fixtureError(
        "HWP_FIXTURE_CHANGED_DURING_READ",
        "The HWP fixture changed while it was being hashed.",
      );
    }
    return { bytes: position, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof HwpFixtureError) throw error;
    throw fixtureError("HWP_FIXTURE_UNREADABLE", "The HWP fixture cannot be read.");
  } finally {
    try {
      await handle.close();
    } catch {
      throw fixtureError("HWP_FIXTURE_UNREADABLE", "The HWP fixture cannot be closed.");
    }
  }
}

export function assertHwpFixtureByteLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw fixtureError("HWP_FIXTURE_SIZE_INVALID", "The HWP fixture size is invalid.");
  }
  if (bytes > MAX_HWP_FIXTURE_BYTES) {
    throw fixtureError(
      "HWP_FIXTURE_TOO_LARGE",
      "The HWP fixture exceeds the 512 MiB safety limit.",
    );
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fixtureError(code, message) {
  return new HwpFixtureError(code, message);
}
