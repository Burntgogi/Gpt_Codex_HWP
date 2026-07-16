import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  buildDeterministicZip,
  buildReleaseArtifacts,
} from "../release-scripts/build-release-artifacts.mjs";
import {
  inspectReleaseZipForTest,
  verifyReleaseArtifacts,
} from "../../../scripts/verify-release-artifacts.mjs";

const executeFile = promisify(execFile);
const EPOCH = 1_700_000_000;
const REPRODUCIBLE_EPOCH = EPOCH + 2;
const VERSIONS = { node: "v22.22.2", npm: "10.9.7", zlib: process.versions.zlib, tool: "1" };
const NPMRC_POLICY = "engine-strict=true\nsave-exact=true\npackage-lock=true\nfund=false\nignore-scripts=true\naudit=false\n";
const TOOL_NAMES = [
  "hwp_create_svg_asset",
  "hwp_detect_format",
  "hwp_fill_form",
  "hwp_generate_hwpx",
  "hwp_insert_image",
  "hwp_patch_document",
  "hwp_read",
  "hwp_render_preview",
  "hwp_validate",
];

test("release artifacts are deterministic and independently verifiable", async (t) => {
  const fixture = await createReleaseFixture(t);
  const first = join(fixture.parent, "artifacts-one");
  const second = join(fixture.parent, "artifacts-two");
  const probed = join(fixture.parent, "artifacts-probed-toolchain");
  const probedAgain = join(fixture.parent, "artifacts-probed-toolchain-again");

  const firstReceipt = await buildReleaseArtifacts({
    root: fixture.root,
    output: first,
    sourceDateEpoch: REPRODUCIBLE_EPOCH,
    prepareRuntime: fixture.prepareRuntime,
    versions: VERSIONS,
  });
  const secondReceipt = await buildReleaseArtifacts({
    root: fixture.root,
    output: second,
    sourceDateEpoch: REPRODUCIBLE_EPOCH,
    prepareRuntime: fixture.prepareRuntime,
    versions: VERSIONS,
  });
  const probedReceipt = await buildReleaseArtifacts({
    root: fixture.root,
    output: probed,
    sourceDateEpoch: REPRODUCIBLE_EPOCH,
    prepareRuntime: fixture.prepareRuntime,
  });
  const probedAgainReceipt = await buildReleaseArtifacts({
    root: fixture.root,
    output: probedAgain,
    sourceDateEpoch: REPRODUCIBLE_EPOCH,
    prepareRuntime: fixture.prepareRuntime,
  });

  assert.deepEqual(firstReceipt.files, [
    "SHA256SUMS",
    "gpt-codex-hwp-0.1.4.spdx.json",
    "gpt-codex-hwp-0.1.4.zip",
    "provenance.json",
  ]);
  assert.deepEqual(firstReceipt.hashes, secondReceipt.hashes);
  assert.deepEqual(probedReceipt.hashes, probedAgainReceipt.hashes);
  const probedProvenance = JSON.parse(await readFile(join(probed, "provenance.json"), "utf8"));
  assert.equal(probedProvenance.toolchain.node, process.version);
  assert.equal(probedProvenance.toolchain.zlib, process.versions.zlib);
  assert.match(probedProvenance.toolchain.npm, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
  for (const name of firstReceipt.files) {
    assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)), name);
  }

  const verified = await verifyReleaseArtifacts({
    root: fixture.root, artifacts: first, sourceDateEpoch: REPRODUCIBLE_EPOCH,
  });
  assert.equal(verified.status, "passed");
  assert.equal(verified.runtimeFiles, fixture.runtimeFiles.length);
  assert.equal(verified.productionPackages, 4);
  assert.equal(verified.toolCount, 9);

  const archive = inspectReleaseZipForTest(await readFile(join(first, "gpt-codex-hwp-0.1.4.zip")));
  assert.deepEqual(archive.map((entry) => entry.name), fixture.runtimeFiles);
  assert.equal(
    Buffer.from(archive.find((entry) => entry.name === ".npmrc")?.bytes ?? []).toString("utf8"),
    NPMRC_POLICY,
  );
  assert.equal(archive.every((entry) => entry.mode === 0o100644), true);
  assert.equal(archive.every((entry) => entry.epoch === REPRODUCIBLE_EPOCH), true);
  assert.equal(archive.every((entry) => entry.compression === "deflate"), true);

  const spdx = JSON.parse(await readFile(join(first, "gpt-codex-hwp-0.1.4.spdx.json"), "utf8"));
  assert.equal(spdx.spdxVersion, "SPDX-2.3");
  assert.deepEqual(spdx.creationInfo.created, "2023-11-14T22:13:22.000Z");
  assert.deepEqual(spdx.packages.map((record: { name: string }) => record.name), [
    "alpha",
    "beta",
    "gpt-codex-hwp",
    "kordoc",
  ]);
  assert.equal(spdx.packages.some((record: { name: string }) => record.name === "dev-only"), false);

  const provenance = JSON.parse(await readFile(join(first, "provenance.json"), "utf8"));
  assert.equal(provenance.repository.clean, true);
  assert.equal(provenance.reproducibleEpoch, REPRODUCIBLE_EPOCH);
  assert.equal(provenance.toolchain.zlib, process.versions.zlib);
  assert.equal(provenance.epochSource, "environment");
  assert.deepEqual(provenance.toolContract.names, TOOL_NAMES);
  assert.equal(provenance.kordoc.source.name, "kordoc");
  assert.equal(JSON.stringify(provenance).includes(fixture.root), false);
  assert.equal(Object.hasOwn(provenance.artifacts, "provenance"), false);

  const sums = (await readFile(join(first, "SHA256SUMS"), "utf8")).trim().split("\n");
  assert.deepEqual(sums.map((line) => line.slice(66)), [
    "gpt-codex-hwp-0.1.4.spdx.json",
    "gpt-codex-hwp-0.1.4.zip",
    "provenance.json",
  ]);
  assert.equal(sums.every((line) => /^[a-f0-9]{64}  [A-Za-z0-9._-]+$/u.test(line)), true);
});

test("release artifacts reject unsafe source and output states", async (t) => {
  await t.test("dirty source", async (t) => {
    const fixture = await createReleaseFixture(t);
    await writeFile(join(fixture.root, "dirty.txt"), "private\n");
    await assert.rejects(
      buildReleaseArtifacts({
        root: fixture.root,
        output: join(fixture.parent, "dirty-output"),
        sourceDateEpoch: EPOCH,
        prepareRuntime: fixture.prepareRuntime,
        versions: VERSIONS,
      }),
      /RELEASE_ARTIFACTS_SOURCE_DIRTY/u,
    );
  });

  await t.test("pre-existing output", async (t) => {
    const fixture = await createReleaseFixture(t);
    const output = join(fixture.parent, "existing");
    await mkdir(output);
    await assert.rejects(
      buildReleaseArtifacts({
        root: fixture.root,
        output,
        sourceDateEpoch: EPOCH,
        prepareRuntime: fixture.prepareRuntime,
        versions: VERSIONS,
      }),
      /RELEASE_ARTIFACTS_OUTPUT_EXISTS/u,
    );
  });

  await t.test("missing release input", async (t) => {
    const fixture = await createReleaseFixture(t);
    await rm(join(fixture.root, "packages", "gpt-codex-hwp", "package-lock.json"));
    await runGit(fixture.root, ["add", "-A"]);
    await runGit(fixture.root, ["commit", "-m", "remove lock"]);
    await assert.rejects(
      buildReleaseArtifacts({
        root: fixture.root,
        output: join(fixture.parent, "missing-input"),
        sourceDateEpoch: EPOCH,
        prepareRuntime: fixture.prepareRuntime,
        versions: VERSIONS,
      }),
      /RELEASE_ARTIFACTS_INPUT_MISSING/u,
    );
  });

  await t.test("runtime link", async (t) => {
    const fixture = await createReleaseFixture(t);
    const source = join(fixture.root, "plugins", "gpt-codex-hwp", "README.md");
    const target = join(fixture.root, "plugins", "gpt-codex-hwp", "linked.md");
    try {
      await symlink(source, target, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }
    await runGit(fixture.root, ["add", "plugins/gpt-codex-hwp/linked.md"]);
    await runGit(fixture.root, ["commit", "-m", "add link"]);
    await assert.rejects(
      buildReleaseArtifacts({
        root: fixture.root,
        output: join(fixture.parent, "linked-output"),
        sourceDateEpoch: EPOCH,
        prepareRuntime: fixture.prepareRuntime,
        versions: VERSIONS,
      }),
      /RELEASE_ARTIFACTS_ENTRY_UNSAFE/u,
    );
  });
});

test("release artifacts require the exact configured Git identity", async (t) => {
  const fixture = await createReleaseFixture(t);
  await runGit(fixture.root, ["config", "user.email", "wrong@example.invalid"]);
  await assert.rejects(
    buildReleaseArtifacts({
      root: fixture.root,
      output: join(fixture.parent, "wrong-identity"),
      sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime,
      versions: VERSIONS,
    }),
    /RELEASE_ARTIFACTS_GIT_IDENTITY_MISSING/u,
  );
});

test("release artifacts reject padded Git identity and staged bytes outside the commit", async (t) => {
  await t.test("padded identity", async (t) => {
    const fixture = await createReleaseFixture(t);
    await runGit(fixture.root, ["config", "user.name", " Gpt_Codex_HWP contributors"]);
    await assert.rejects(buildReleaseArtifacts({
      root: fixture.root, output: join(fixture.parent, "padded"),
      sourceDateEpoch: REPRODUCIBLE_EPOCH, prepareRuntime: fixture.prepareRuntime, versions: VERSIONS,
    }), /RELEASE_ARTIFACTS_GIT_IDENTITY_MISSING/u);
  });
  await t.test("stage differs from commit", async (t) => {
    const fixture = await createReleaseFixture(t);
    await assert.rejects(buildReleaseArtifacts({
      root: fixture.root, output: join(fixture.parent, "stage-mismatch"),
      sourceDateEpoch: REPRODUCIBLE_EPOCH, versions: VERSIONS,
      prepareRuntime: async (options) => {
        await fixture.prepareRuntime(options);
        await writeFile(join(options.stageRoot, "README.md"), "not the commit\n");
      },
    }), /RELEASE_ARTIFACTS_RUNTIME_CONTENT/u);
  });
});

test("release artifacts reject malformed registry integrity", async (t) => {
  const fixture = await createReleaseFixture(t);
  const lockPath = join(fixture.root, "packages", "gpt-codex-hwp", "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages["node_modules/alpha"].integrity = "sha512-invalid";
  await writeJson(lockPath, lock);
  await runGit(fixture.root, ["add", lockPath]);
  await runGit(fixture.root, ["commit", "-m", "malformed integrity"]);
  await assert.rejects(buildReleaseArtifacts({
    root: fixture.root, output: join(fixture.parent, "bad-integrity"),
    sourceDateEpoch: REPRODUCIBLE_EPOCH, prepareRuntime: fixture.prepareRuntime, versions: VERSIONS,
  }), /RELEASE_ARTIFACTS_SPDX_INVALID/u);
});

test("release artifacts reject malformed SPDX license expressions", async (t) => {
  const fixture = await createReleaseFixture(t);
  const lockPath = join(fixture.root, "packages", "gpt-codex-hwp", "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages["node_modules/alpha"].license = "MIT OR";
  await writeJson(lockPath, lock);
  await runGit(fixture.root, ["add", lockPath]);
  await runGit(fixture.root, ["commit", "-m", "malformed license"]);
  await assert.rejects(
    buildReleaseArtifacts({
      root: fixture.root,
      output: join(fixture.parent, "malformed-license"),
      sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime,
      versions: VERSIONS,
    }),
    /RELEASE_ARTIFACTS_SPDX_INVALID/u,
  );
});

test("release artifacts verifier requires exact tool and Kordoc file contracts", async (t) => {
  await t.test("extra MCP tool", async (t) => {
    const fixture = await createReleaseFixture(t);
    const toolPath = join(fixture.root, "plugins", "gpt-codex-hwp", "dist", "tools", "index.js");
    const source = await readFile(toolPath, "utf8");
    await writeFile(toolPath, source.replace(
      "\n]);\n", "\n  { name: \"hwp_\" + \"extra\", register: registerExtra, },\n]);\n",
    ));
    await runGit(fixture.root, ["add", "."]);
    await runGit(fixture.root, ["commit", "-m", "extra tool"]);
    const output = join(fixture.parent, "extra-tool");
    await buildReleaseArtifacts({
      root: fixture.root, output, sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime, versions: VERSIONS,
    });
    await assert.rejects(
      verifyReleaseArtifacts({ root: fixture.root, artifacts: output, sourceDateEpoch: REPRODUCIBLE_EPOCH }),
      /RELEASE_ARTIFACTS_TOOL_CONTRACT/u,
    );
  });

  await t.test("computed extra registerTool call", async (t) => {
    const fixture = await createReleaseFixture(t);
    const outsideToolPath = join(
      fixture.root, "plugins", "gpt-codex-hwp", "dist", "mcp.js",
    );
    await writeFile(
      outsideToolPath,
      "export function addExtra(server) { server.registerTool(\"hwp_\" + \"extra\", {}); }\n",
    );
    await runGit(fixture.root, ["add", "."]);
    await runGit(fixture.root, ["commit", "-m", "computed extra registration"]);
    const output = join(fixture.parent, "computed-extra-tool");
    await buildReleaseArtifacts({ root: fixture.root, output, sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime, versions: VERSIONS });
    await assert.rejects(
      verifyReleaseArtifacts({ root: fixture.root, artifacts: output, sourceDateEpoch: REPRODUCIBLE_EPOCH }),
      /RELEASE_ARTIFACTS_TOOL_CONTRACT/u,
    );
  });

  await t.test("extra Kordoc file", async (t) => {
    const fixture = await createReleaseFixture(t);
    await writeFile(
      join(fixture.root, "plugins", "gpt-codex-hwp", "vendor", "kordoc-core", "EXTRA.md"),
      "unexpected\n",
    );
    await runGit(fixture.root, ["add", "."]);
    await runGit(fixture.root, ["commit", "-m", "extra kordoc file"]);
    const output = join(fixture.parent, "extra-kordoc");
    await buildReleaseArtifacts({
      root: fixture.root, output, sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime, versions: VERSIONS,
    });
    await assert.rejects(
      verifyReleaseArtifacts({ root: fixture.root, artifacts: output, sourceDateEpoch: REPRODUCIBLE_EPOCH }),
      /RELEASE_ARTIFACTS_KORDOC_INVALID/u,
    );
  });
});

test("release artifacts reject local Kordoc provenance URLs", async (t) => {
  const fixture = await createReleaseFixture(t);
  const provenancePath = join(
    fixture.root, "plugins", "gpt-codex-hwp", "vendor", "kordoc-core", "PROVENANCE.json",
  );
  const record = JSON.parse(await readFile(provenancePath, "utf8"));
  record.source.resolved = "file:C:/private/kordoc.tgz";
  await writeJson(provenancePath, record);
  await runGit(fixture.root, ["add", "."]);
  await runGit(fixture.root, ["commit", "-m", "local Kordoc source"]);
  await assert.rejects(
    buildReleaseArtifacts({
      root: fixture.root,
      output: join(fixture.parent, "local-kordoc"),
      sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime,
      versions: VERSIONS,
    }),
    /RELEASE_ARTIFACTS_KORDOC_INVALID/u,
  );
});

test("release verifier binds epochs and rejects extra nested provenance or SPDX keys", async (t) => {
  await t.test("epoch mismatch", async (t) => {
    const fixture = await createReleaseFixture(t);
    const output = join(fixture.parent, "epoch-mismatch");
    await buildReleaseArtifacts({ root: fixture.root, output, sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime, versions: VERSIONS });
    await assert.rejects(
      verifyReleaseArtifacts({ root: fixture.root, artifacts: output, sourceDateEpoch: EPOCH }),
      /RELEASE_ARTIFACTS_PROVENANCE_INVALID/u,
    );
  });
  await t.test("commit epoch artifact cannot ignore verifier environment epoch", async (t) => {
    const fixture = await createReleaseFixture(t);
    const output = join(fixture.parent, "commit-epoch-vs-environment");
    await buildReleaseArtifacts({ root: fixture.root, output,
      prepareRuntime: fixture.prepareRuntime, versions: VERSIONS });
    await assert.rejects(
      verifyReleaseArtifacts({ root: fixture.root, artifacts: output, sourceDateEpoch: REPRODUCIBLE_EPOCH }),
      /RELEASE_ARTIFACTS_PROVENANCE_INVALID/u,
    );
  });
  await t.test("extra nested provenance key", async (t) => {
    const fixture = await createReleaseFixture(t);
    const output = join(fixture.parent, "private-provenance");
    await buildReleaseArtifacts({ root: fixture.root, output, sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime, versions: VERSIONS });
    const provenance = JSON.parse(await readFile(join(output, "provenance.json"), "utf8"));
    provenance.runtime.secretToken = "opaque-value";
    await writeJson(join(output, "provenance.json"), provenance);
    await rewriteChecksums(output);
    await assert.rejects(verifyReleaseArtifacts({ root: fixture.root, artifacts: output,
      sourceDateEpoch: REPRODUCIBLE_EPOCH }), /RELEASE_ARTIFACTS_PROVENANCE_INVALID/u);
  });
  await t.test("extra SPDX package key", async (t) => {
    const fixture = await createReleaseFixture(t);
    const output = join(fixture.parent, "extra-spdx-key");
    await buildReleaseArtifacts({ root: fixture.root, output, sourceDateEpoch: REPRODUCIBLE_EPOCH,
      prepareRuntime: fixture.prepareRuntime, versions: VERSIONS });
    const sbomPath = join(output, "gpt-codex-hwp-0.1.4.spdx.json");
    const sbom = JSON.parse(await readFile(sbomPath, "utf8"));
    sbom.packages[0].environment = "secret";
    await writeJson(sbomPath, sbom);
    const provenancePath = join(output, "provenance.json");
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.artifacts.sbom.sha256 = sha256(await readFile(sbomPath));
    await writeJson(provenancePath, provenance);
    await rewriteChecksums(output);
    await assert.rejects(verifyReleaseArtifacts({ root: fixture.root, artifacts: output,
      sourceDateEpoch: REPRODUCIBLE_EPOCH }), /RELEASE_ARTIFACTS_SPDX_INVALID/u);
  });
});

test("release artifacts ZIP construction rejects hostile names and collisions", () => {
  const valid = { name: "gpt-codex-hwp/package.json", bytes: Buffer.from("{}\n") };
  for (const name of [
    "../escape.json",
    "/absolute.json",
    "C:/absolute.json",
    "gpt-codex-hwp\\bad.json",
    "gpt-codex-hwp/bad:name.json",
    "gpt-codex-hwp/bad\nname.json",
    "gpt-codex-hwp/private.pem",
    "gpt-codex-hwp/document.hwpx",
  ]) {
    assert.throws(
      () => buildDeterministicZip([{ name, bytes: Buffer.alloc(0) }], EPOCH),
      /RELEASE_ARTIFACTS_ENTRY_UNSAFE/u,
      name,
    );
  }
  assert.throws(
    () => buildDeterministicZip([valid, valid], EPOCH),
    /RELEASE_ARTIFACTS_ENTRY_DUPLICATE/u,
  );
  assert.throws(
    () => buildDeterministicZip([
      valid,
      { name: "GPT-CODEX-HWP/package.json", bytes: Buffer.from("{}\n") },
    ], EPOCH),
    /RELEASE_ARTIFACTS_ENTRY_CASE_COLLISION/u,
  );

  const emptyZip = buildDeterministicZip([
    { name: "empty.json", bytes: Buffer.alloc(0) },
  ], EPOCH);
  const emptyEntries = inspectReleaseZipForTest(emptyZip);
  assert.equal(emptyEntries.length, 1);
  assert.equal(emptyEntries[0].bytes.length, 0);

  const invalidUtf8 = Buffer.from(buildDeterministicZip([
    { name: "package.json", bytes: Buffer.from("{}\n") },
  ], EPOCH));
  invalidUtf8[30] = 0xff;
  const centralOffset = invalidUtf8.readUInt32LE(invalidUtf8.length - 6);
  invalidUtf8[centralOffset + 46] = 0xff;
  assert.throws(
    () => inspectReleaseZipForTest(invalidUtf8),
    /RELEASE_ARTIFACTS_ENTRY_UNSAFE|RELEASE_ARTIFACTS_ZIP_INVALID/u,
  );

  const content = Buffer.from("canonical compression ".repeat(200));
  const canonical = buildDeterministicZip([{ name: "payload.json", bytes: content }], EPOCH);
  const oldCentral = canonical.readUInt32LE(canonical.length - 6);
  const dataOffset = 30 + canonical.readUInt16LE(26);
  const alternate = deflateRawSync(content, { level: 1 });
  const noncanonical = Buffer.concat([
    canonical.subarray(0, dataOffset), alternate, canonical.subarray(oldCentral),
  ]);
  noncanonical.writeUInt32LE(alternate.length, 18);
  const newCentral = dataOffset + alternate.length;
  noncanonical.writeUInt32LE(alternate.length, newCentral + 20);
  noncanonical.writeUInt32LE(newCentral, noncanonical.length - 6);
  assert.throws(
    () => inspectReleaseZipForTest(noncanonical),
    /RELEASE_ARTIFACTS_ZIP_METADATA/u,
  );
});

test("release artifacts verifier fails closed on tampering and unexpected output", async (t) => {
  const fixture = await createReleaseFixture(t);
  const output = join(fixture.parent, "verified-output");
  await buildReleaseArtifacts({
    root: fixture.root,
    output,
    sourceDateEpoch: REPRODUCIBLE_EPOCH,
    prepareRuntime: fixture.prepareRuntime,
    versions: VERSIONS,
  });

  const provenancePath = join(output, "provenance.json");
  const original = await readFile(provenancePath);
  await writeFile(provenancePath, Buffer.concat([original, Buffer.from(" ")]));
  await assert.rejects(
    verifyReleaseArtifacts({ root: fixture.root, artifacts: output, sourceDateEpoch: REPRODUCIBLE_EPOCH }),
    /RELEASE_ARTIFACTS_CHECKSUM_MISMATCH/u,
  );
  await writeFile(provenancePath, original);

  await writeFile(join(output, "private.txt"), "not allowed\n");
  await assert.rejects(
    verifyReleaseArtifacts({ root: fixture.root, artifacts: output, sourceDateEpoch: REPRODUCIBLE_EPOCH }),
    /RELEASE_ARTIFACTS_OUTPUT_CONTRACT/u,
  );
});

async function createReleaseFixture(t: test.TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-release-test-"));
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  const root = join(parent, "repository");
  await mkdir(root, { recursive: true });
  const runtimeRoot = join(root, "plugins", "gpt-codex-hwp");
  const sourceRoot = join(root, "packages", "gpt-codex-hwp");
  await mkdir(join(runtimeRoot, "dist", "tools"), { recursive: true });
  await mkdir(join(runtimeRoot, "vendor", "kordoc-core"), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });

  await writeJson(join(root, "package.json"), {
    name: "fixture-repository",
    version: "0.1.4",
    license: "Apache-2.0",
  });
  await writeJson(join(sourceRoot, "package.json"), {
    name: "gpt-codex-hwp",
    version: "0.1.4",
    license: "Apache-2.0",
    dependencies: { alpha: "1.0.0", kordoc: "file:vendor/kordoc-core" },
    devDependencies: { "dev-only": "2.0.0" },
  });
  await writeJson(join(sourceRoot, "package-lock.json"), {
    name: "gpt-codex-hwp",
    version: "0.1.4",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "gpt-codex-hwp",
        version: "0.1.4",
        license: "Apache-2.0",
        dependencies: { alpha: "1.0.0", kordoc: "file:vendor/kordoc-core" },
        devDependencies: { "dev-only": "2.0.0" },
      },
      "node_modules/alpha": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        license: "MIT",
        peerDependencies: { beta: "1.0.0" },
      },
      "node_modules/beta": { version: "1.0.0", license: "Apache-2.0" },
      "node_modules/dev-only": { version: "2.0.0", dev: true, license: "ISC" },
      "node_modules/kordoc": {
        resolved: "vendor/kordoc-core",
        link: true,
      },
      "vendor/kordoc-core": { name: "kordoc", version: "3.18.1", license: "MIT" },
    },
  });
  await writeJson(join(runtimeRoot, "package.json"), {
    name: "gpt-codex-hwp",
    version: "0.1.4",
    license: "Apache-2.0",
  });
  await writeJson(join(runtimeRoot, "package-lock.json"), {
    name: "gpt-codex-hwp",
    version: "0.1.4",
    lockfileVersion: 3,
    packages: {},
  });
  await writeFile(join(runtimeRoot, ".npmrc"), NPMRC_POLICY);
  await writeJson(join(runtimeRoot, ".mcp.json"), { mcpServers: { "gpt-codex-hwp": { command: "node" } } });
  await writeFile(join(runtimeRoot, "README.md"), "# Public runtime\n");
  await writeFile(
    join(runtimeRoot, "dist", "tools", "index.js"),
    `${TOOL_NAMES.map((name) => `export const ${name.toUpperCase()}_TOOL_NAME = ${JSON.stringify(name)};`).join("\n")}\n${TOOL_NAMES.map((name) => `export function register_${name}(server) { server.registerTool(${name.toUpperCase()}_TOOL_NAME, {}); }`).join("\n")}\nexport const toolDefinitions = Object.freeze([\n${TOOL_NAMES.map((name) => `  { name: ${name.toUpperCase()}_TOOL_NAME, register: register_${name}, },`).join("\n")}\n]);\n`,
  );
  await writeJson(join(runtimeRoot, "vendor", "kordoc-core", "PROVENANCE.json"), {
    schemaVersion: 2,
    generatorVersion: 2,
    source: {
      name: "kordoc",
      version: "3.18.1",
      resolved: "https://registry.npmjs.org/kordoc/-/kordoc-3.18.1.tgz",
      integrity: "sha512-YWJj",
    },
    archive: { sha512: "sha512-YWJj" },
    files: [],
  });

  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.name", "Gpt_Codex_HWP contributors"]);
  await runGit(root, ["config", "user.email", "224273819+Burntgogi@users.noreply.github.com"]);
  await runGit(root, ["remote", "add", "origin", "https://github.com/Burntgogi/Gpt_Codex_HWP.git"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", "fixture"]);

  const runtimeFiles = (await gitOutput(root, [
    "ls-tree", "-r", "--name-only", "HEAD", "--", "plugins/gpt-codex-hwp",
  ])).trim().split("\n").map((path) => path.slice("plugins/gpt-codex-hwp/".length)).sort();
  return {
    parent,
    root,
    runtimeFiles,
    prepareRuntime: async ({ stageRoot }: { stageRoot: string }) => {
      await cp(runtimeRoot, stageRoot, { recursive: true, errorOnExist: true, force: false });
      const metadata = await lstat(stageRoot);
      assert.equal(metadata.isDirectory(), true);
    },
  };
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function rewriteChecksums(output: string) {
  const names = ["gpt-codex-hwp-0.1.4.spdx.json", "gpt-codex-hwp-0.1.4.zip", "provenance.json"];
  const text = (await Promise.all(names.map(async (name) =>
    `${sha256(await readFile(join(output, name)))}  ${name}\n`))).join("");
  await writeFile(join(output, "SHA256SUMS"), text);
}

async function runGit(root: string, args: string[]) {
  await executeFile("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2023-11-14T22:13:20Z",
      GIT_COMMITTER_DATE: "2023-11-14T22:13:20Z",
    },
  });
}

async function gitOutput(root: string, args: string[]) {
  const result = await executeFile("git", args, { cwd: root, encoding: "utf8" });
  return result.stdout;
}
