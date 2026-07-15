import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertHwpFixtureByteLimit,
  resolveHwpFixture,
} from "../release-scripts/hwp-fixture.mjs";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOLVER_SOURCE = join(SOURCE_ROOT, "release-scripts", "hwp-fixture.mjs");
const TRACKED_ROOT = join(SOURCE_ROOT, "tests", "fixtures", "rhwp");
const TRACKED_FIXTURE = join(TRACKED_ROOT, "re-01-hangul-only-hancom.hwp");
const TRACKED_PROVENANCE = join(TRACKED_ROOT, "provenance.json");
const EXPECTED_BYTES = 8_704;
const EXPECTED_SHA256 =
  "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd";
const MAX_FIXTURE_BYTES = 512 * 1024 * 1024;

test("HWP fixture resolver enforces the 512 MiB boundary before hashing", () => {
  assert.doesNotThrow(() => assertHwpFixtureByteLimit(MAX_FIXTURE_BYTES));
  assert.throws(
    () => assertHwpFixtureByteLimit(MAX_FIXTURE_BYTES + 1),
    (error: Error & { code?: string }) =>
      error.code === "HWP_FIXTURE_TOO_LARGE",
  );
});

test("HWP fixture resolver returns frozen tracked metadata", async () => {
  await withFixtureEnvironment(undefined, async () => {
    const fixture = await resolveHwpFixture({ requireTracked: true });

    assert.equal(fixture.path, TRACKED_FIXTURE);
    assert.equal(fixture.bytes, EXPECTED_BYTES);
    assert.equal(fixture.sha256, EXPECTED_SHA256);
    assert.deepEqual(
      fixture.provenance,
      JSON.parse(await readFile(TRACKED_PROVENANCE, "utf8")),
    );
    assert.equal(Object.isFrozen(fixture), true);
    assert.equal(Object.isFrozen(fixture.provenance), true);
  });
});

test("HWP fixture resolver fails closed for missing and mismatched tracked bytes", async (t) => {
  await withFixtureEnvironment(undefined, async () => {
    const provenance = JSON.parse(await readFile(TRACKED_PROVENANCE, "utf8"));
    const trackedBytes = await readFile(TRACKED_FIXTURE);

    const wrongProvenanceResolver = await isolatedResolver(t, {
      provenance: {
        ...provenance,
        revision: "0000000000000000000000000000000000000000",
      },
      fixtureBytes: trackedBytes,
    });
    await assertFixtureError(
      wrongProvenanceResolver({ requireTracked: true }),
      "HWP_FIXTURE_PROVENANCE_MISMATCH",
    );

    const missingResolver = await isolatedResolver(t, { provenance });
    await assertFixtureError(
      missingResolver({ requireTracked: true }),
      "HWP_FIXTURE_NOT_FOUND",
    );

    const sizeSentinel = "DO_NOT_LEAK_WRONG_SIZE_CONTENT";
    const wrongSize = Buffer.alloc(EXPECTED_BYTES - 1);
    Buffer.from(sizeSentinel).copy(wrongSize);
    const wrongSizeResolver = await isolatedResolver(t, {
      provenance,
      fixtureBytes: wrongSize,
    });
    await assertFixtureError(
      wrongSizeResolver({ requireTracked: true }),
      "HWP_FIXTURE_SIZE_MISMATCH",
      [sizeSentinel],
    );

    const shaSentinel = "DO_NOT_LEAK_WRONG_SHA_CONTENT";
    const wrongSha = Buffer.alloc(EXPECTED_BYTES);
    Buffer.from(shaSentinel).copy(wrongSha);
    const wrongShaResolver = await isolatedResolver(t, {
      provenance,
      fixtureBytes: wrongSha,
    });
    await assertFixtureError(
      wrongShaResolver({ requireTracked: true }),
      "HWP_FIXTURE_SHA256_MISMATCH",
      [shaSentinel],
    );
  });
});

test("HWP fixture resolver accepts explicit diagnostic override", async (t) => {
  const diagnosticBytes = Buffer.from("arbitrary explicit diagnostic HWP bytes");
  const diagnosticPath = await diagnosticFixture(
    t,
    "explicit-diagnostic.HWP",
    diagnosticBytes,
  );

  await withFixtureEnvironment(undefined, async () => {
    const fixture = await resolveHwpFixture({ overridePath: diagnosticPath });
    assert.equal(fixture.path, diagnosticPath);
    assert.equal(fixture.bytes, diagnosticBytes.byteLength);
    assert.equal(fixture.sha256, sha256(diagnosticBytes));
    assert.deepEqual(fixture.provenance, {
      kind: "diagnostic",
      tracked: false,
    });
    assert.equal(Object.isFrozen(fixture), true);
    assert.equal(Object.isFrozen(fixture.provenance), true);
  });
});

test("HWP fixture resolver accepts HWP_TEST_FIXTURE only for diagnostics", async (t) => {
  const diagnosticBytes = Buffer.from("arbitrary environment diagnostic HWP bytes");
  const diagnosticPath = await diagnosticFixture(
    t,
    "environment-diagnostic.hwp",
    diagnosticBytes,
  );

  await withFixtureEnvironment(diagnosticPath, async () => {
    const fixture = await resolveHwpFixture();
    assert.equal(fixture.path, diagnosticPath);
    assert.equal(fixture.bytes, diagnosticBytes.byteLength);
    assert.equal(fixture.sha256, sha256(diagnosticBytes));
    assert.deepEqual(fixture.provenance, {
      kind: "diagnostic",
      tracked: false,
    });
  });
});

test("HWP fixture resolver explicit override takes precedence over environment", async (t) => {
  const explicitBytes = Buffer.from("explicit diagnostic wins");
  const environmentBytes = Buffer.from("environment diagnostic loses");
  const explicitPath = await diagnosticFixture(t, "explicit-wins.hwp", explicitBytes);
  const environmentPath = await diagnosticFixture(
    t,
    "environment-loses.hwp",
    environmentBytes,
  );

  await withFixtureEnvironment(environmentPath, async () => {
    const fixture = await resolveHwpFixture({ overridePath: explicitPath });
    assert.equal(fixture.path, explicitPath);
    assert.equal(fixture.bytes, explicitBytes.byteLength);
    assert.equal(fixture.sha256, sha256(explicitBytes));
  });
});

test("HWP fixture resolver release mode refuses explicit and environment overrides", async () => {
  await withFixtureEnvironment(undefined, async () => {
    await assertFixtureError(
      resolveHwpFixture({ overridePath: TRACKED_FIXTURE, requireTracked: true }),
      "HWP_FIXTURE_OVERRIDE_FORBIDDEN",
      [TRACKED_FIXTURE],
    );
    await assertFixtureError(
      resolveHwpFixture({ overridePath: "", requireTracked: true }),
      "HWP_FIXTURE_OVERRIDE_FORBIDDEN",
    );
  });

  const rawEnvironmentValue = join(
    tmpdir(),
    `forbidden-environment-value-${randomUUID()}.hwp`,
  );
  await withFixtureEnvironment(rawEnvironmentValue, async () => {
    await assertFixtureError(
      resolveHwpFixture({ requireTracked: true }),
      "HWP_FIXTURE_OVERRIDE_FORBIDDEN",
      [rawEnvironmentValue],
    );
  });
  await withFixtureEnvironment("", async () => {
    await assertFixtureError(
      resolveHwpFixture({ requireTracked: true }),
      "HWP_FIXTURE_OVERRIDE_FORBIDDEN",
    );
  });
});

test("HWP fixture resolver errors do not expose the raw environment value", async () => {
  const rawEnvironmentValue = join(
    tmpdir(),
    `private-environment-value-${randomUUID()}.hwp`,
  );

  await withFixtureEnvironment(rawEnvironmentValue, async () => {
    await assertFixtureError(
      resolveHwpFixture(),
      "HWP_FIXTURE_NOT_FOUND",
      [rawEnvironmentValue],
    );
  });
});

test("HWP fixture resolver diagnostics require a regular .hwp file", async (t) => {
  const wrongExtension = await diagnosticFixture(
    t,
    "diagnostic-not-hwp.bin",
    Buffer.from("diagnostic"),
  );
  await withFixtureEnvironment(undefined, async () => {
    await assertFixtureError(
      resolveHwpFixture({ overridePath: wrongExtension }),
      "HWP_FIXTURE_EXTENSION_INVALID",
      [wrongExtension],
    );
  });

  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-fixture-directory-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const directoryPath = join(root, "not-a-regular-file.hwp");
  await mkdir(directoryPath);
  await withFixtureEnvironment(undefined, async () => {
    await assertFixtureError(
      resolveHwpFixture({ overridePath: directoryPath }),
      "HWP_FIXTURE_NOT_REGULAR",
      [directoryPath],
    );
  });
});

async function diagnosticFixture(
  t: TestContext,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-fixture-diagnostic-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const destination = join(root, filename);
  await writeFile(destination, bytes);
  return destination;
}

async function isolatedResolver(
  t: TestContext,
  options: { provenance: unknown; fixtureBytes?: Uint8Array },
): Promise<typeof resolveHwpFixture> {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-fixture-module-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const releaseScripts = join(root, "release-scripts");
  const fixtureRoot = join(root, "tests", "fixtures", "rhwp");
  await mkdir(releaseScripts, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  const modulePath = join(releaseScripts, "hwp-fixture.mjs");
  await copyFile(RESOLVER_SOURCE, modulePath);
  await writeFile(
    join(fixtureRoot, "provenance.json"),
    `${JSON.stringify(options.provenance, null, 2)}\n`,
  );
  if (options.fixtureBytes !== undefined) {
    await writeFile(
      join(fixtureRoot, "re-01-hangul-only-hancom.hwp"),
      options.fixtureBytes,
    );
  }
  const isolated = await import(
    `${pathToFileURL(modulePath).href}?case=${randomUUID()}`
  );
  return isolated.resolveHwpFixture;
}

async function assertFixtureError(
  operation: Promise<unknown>,
  code: string,
  forbiddenValues: string[] = [],
): Promise<void> {
  await assert.rejects(operation, (error: Error & { code?: string }) => {
    assert.equal(error.code, code);
    const rendered = `${error.name}\n${error.message}\n${error.stack ?? ""}`;
    for (const forbidden of forbiddenValues) {
      assert.equal(rendered.includes(forbidden), false);
    }
    return true;
  });
}

async function withFixtureEnvironment<T>(
  value: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = process.env.HWP_TEST_FIXTURE;
  try {
    if (value === undefined) delete process.env.HWP_TEST_FIXTURE;
    else process.env.HWP_TEST_FIXTURE = value;
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.HWP_TEST_FIXTURE;
    else process.env.HWP_TEST_FIXTURE = previous;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
