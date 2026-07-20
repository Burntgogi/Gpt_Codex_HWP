import assert from "node:assert/strict";
import {
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as publicContentPolicy from "../scripts/public-content-policy.mjs";
import {
  PUBLIC_BINARY_ALLOWLIST,
  assertPublicContentBuffer,
  createOwnedBoundary,
  formatPublicFindings,
  readOwnedRegularFile,
  runBoundedProcess,
  scanPublicDirectory,
  scanTrackedPublicTree,
  terminatePosixProcessGroup,
  walkOwnedRegularFiles,
} from "../scripts/public-content-policy.mjs";
import { addTaggedRootTrees, scanPublicHistory } from "../scripts/scan-public-history.mjs";
import { REQUIRED_RELEASE_STAGES } from "../scripts/release-verify.mjs";
import { createCanonicalTemporaryDirectory } from "../scripts/canonical-temp.mjs";

const OWNER_EMAIL = fragments("224273819+Burntgogi", "@users.noreply.github.com");
const REPOSITORY_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const APPROVED_HWP_FIXTURE_PATH =
  "packages/gpt-codex-hwp/tests/fixtures/rhwp/re-01-hangul-only-hancom.hwp";

test("public content policy detects secrets, personal paths, and unsafe metadata without disclosure", async (t) => {
  const rejected = [
    ["provider token", fragments("sk", "-proj-", "a".repeat(48)), "provider credential"],
    ["GitHub token", fragments("gh", "p_", "A".repeat(36)), "provider credential"],
    ["cloud access key", fragments("AK", "IA", "A".repeat(16)), "cloud credential"],
    ["cloud secret assignment", fragments("AWS_SECRET", "_ACCESS_KEY=", "w".repeat(40)), "literal credential"],
    ["private key", fragments("-----BEGIN ", "OPENSSH ", "PRIVATE KEY-----"), "private key"],
    ["literal assignment", fragments("api", "Key=", "literal-value"), "literal credential"],
    ["Windows home", fragments("C:", "\\", "Users", "\\private-person\\work"), "personal home path"],
    ["macOS home", fragments("/Us", "ers/private-person/work"), "personal home path"],
    ["Linux home", fragments("/ho", "me/private-person/work"), "personal home path"],
    ["Unicode case variant", fragments("ＡＷＳ＿ＳＥＣＲＥＴ＿ＡＣＣＥＳＳ＿ＫＥＹ＝", "x".repeat(40)), "literal credential"],
  ];
  for (const [name, contents, category] of rejected) {
    await t.test(name, () => {
      const findings = captureThrown(
        () => assertPublicContentBuffer(Buffer.from(contents), { label: "safe/example.txt" }),
      ).findings;
      assert.ok(findings.some((finding) => finding.category === category));
      const output = formatPublicFindings(findings);
      assert.equal(output.includes(contents), false);
      assert.match(output, /category=.*label=safe\/example\.txt.*remediation=/u);
    });
  }

  const sourceMap = JSON.stringify({ version: 3, sources: [fragments("C:", "\\", "Users", "\\private-person\\src.ts")] });
  const mapError = captureThrown(() =>
    assertPublicContentBuffer(Buffer.from(sourceMap), { label: "dist/index.js.map" }));
  assert.ok(mapError.findings.some((finding) => finding.category === "absolute source map path"));
});

test("public content policy preserves deliberate false-positive controls", () => {
  const safe = [
    fragments("OPENAI_API", "_KEY=$", "{OPENAI_API_KEY}\n"),
    fragments("api", "Key=<your-key>\n"),
    "Never paste a private key, password, token, or secret here.\n",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA public@example.invalid\n",
    "-----BEGIN CERTIFICATE-----\npublic material\n-----END CERTIFICATE-----\n",
    "https://example.invalid/users/alice/profile\n",
    "app.get('/users/alice/profile', handler);\n",
    "C:\\Users\\username\\workspace\n/Users/<your-user>/workspace\n/home/example/workspace\n",
  ];
  for (const [index, contents] of safe.entries()) {
    assert.doesNotThrow(() =>
      assertPublicContentBuffer(Buffer.from(contents), { label: `docs/example-${index}.md` }));
  }
});

test("public content policy limits progress-token exceptions to protocol context", () => {
  const identifierReference = fragments(
    "sendNotification({ method: \"notifications/progress\", params: { progress",
    "Token", ": progressId, progress: 1 } });",
  );
  assert.doesNotThrow(() => assertPublicContentBuffer(Buffer.from(identifierReference), {
    label: "dist/tool-context.js",
    scope: "runtime",
  }));

  const literalReference = fragments(
    "sendNotification({ method: \"notifications/progress\", params: { progress",
    "Token", ": \"literal-value\", progress: 1 } });",
  );
  assert.throws(() => assertPublicContentBuffer(Buffer.from(literalReference), {
    label: "dist/tool-context.js",
    scope: "runtime",
  }));

  const sourceProtocolFixture = fragments(
    "client.callTool({ name, arguments: {}, _meta: { progress",
    "Token", ": \"edge-token\" } });",
  );
  assert.doesNotThrow(() => assertPublicContentBuffer(Buffer.from(sourceProtocolFixture), {
    label: "tests/protocol.test.ts",
    scope: "source",
  }));
  assert.throws(() => assertPublicContentBuffer(Buffer.from(
    fragments("const unrelated = { progress", "Token", ": \"literal-value\" };"),
  ), { label: "src/unrelated.ts", scope: "source" }));

  assert.doesNotThrow(() => assertPublicContentBuffer(Buffer.from(
    fragments("const stdout", "Secret", " = `${build", "Fixture()}`;"),
  ), { label: "tests/fixture.test.ts", scope: "source" }));
  assert.throws(() => assertPublicContentBuffer(Buffer.from(
    fragments("const stdout", "Secret", " = \"literal-value\";"),
  ), { label: "src/credential.ts", scope: "source" }));
});

test("credential references must occupy the whole assigned expression", () => {
  const accepted = [
    fragments("api", "Key = process", ".env.OPENAI_API_KEY"),
    fragments("api", "Key = $", "{OPENAI_API_KEY}"),
    fragments("api", "Key = os", ".environ[\"OPENAI_API_KEY\"]"),
    fragments("GH_", "TOK", "EN", ": $", "{{github.token}}"),
    fragments("GH_", "TOK", "EN", ": $", "{{secrets.GITHUB_TOKEN}}"),
  ];
  for (const contents of accepted) assert.doesNotThrow(() => assertPublicContentBuffer(
    Buffer.from(contents), { label: "safe/reference.ts", scope: "runtime" },
  ));

  const rejected = [
    fragments("api", "Key = process", ".env.OPENAI_API_KEY || fallback"),
    fragments("api", "Key = process", ".env.OPENAI_API_KEY + suffix"),
    fragments("api", "Key = $", "{OPENAI_API_KEY}-suffix"),
    fragments("api", "Key = `$", "{OPENAI_API_KEY}-suffix`"),
    fragments("GH_", "TOK", "EN", ": $", "{{github.token}}-suffix"),
  ];
  for (const contents of rejected) assert.throws(() => assertPublicContentBuffer(
    Buffer.from(contents), { label: "unsafe/reference.ts", scope: "runtime" },
  ));
});

test("GitHub workflow OIDC permissions allow only exact non-secret access levels", () => {
  const workflowPermission = (value) => fragments("id", "-to", "ken", ": ", value);
  for (const value of ["write", "none"]) {
    assert.doesNotThrow(() => assertPublicContentBuffer(
      Buffer.from(workflowPermission(value)),
      { label: ".github/workflows/release.yml", scope: "source" },
    ));
  }

  const rejected = [
    { contents: workflowPermission("literal-value"), label: ".github/workflows/release.yml" },
    { contents: workflowPermission("write"), label: "docs/release.yml" },
    { contents: fragments("api", "-to", "ken", ": write"), label: ".github/workflows/release.yml" },
  ];
  for (const { contents, label } of rejected) {
    assert.throws(() => assertPublicContentBuffer(
      Buffer.from(contents), { label, scope: "source" },
    ));
  }
});

test("public content policy enforces exact binary, file, aggregate, link, and entry contracts", async (t) => {
  assert.ok(PUBLIC_BINARY_ALLOWLIST.some((record) =>
    record.size === 8704 && record.sha256 === "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd"));
  assert.ok(PUBLIC_BINARY_ALLOWLIST.every((record) =>
    Number.isSafeInteger(record.size) && /^[a-f0-9]{64}$/u.test(record.sha256)
    && Array.isArray(record.paths) && record.paths.length > 0));

  const approvedBanner = await readFile(new URL("../assets/gpt-codex-hwp-banner.png", import.meta.url));
  assert.doesNotThrow(() => assertPublicContentBuffer(approvedBanner, {
    label: "assets/gpt-codex-hwp-banner.png",
  }));
  assert.throws(() => assertPublicContentBuffer(approvedBanner, {
    label: "copied/gpt-codex-hwp-banner.png",
  }));

  const root = await temporaryDirectory(t, "public-content-policy-");
  await writeFile(join(root, "safe.txt"), "safe\n");
  await assert.doesNotReject(scanPublicDirectory(root, { maxFileBytes: 5, maxAggregateBytes: 5 }));
  await writeFile(join(root, "safe.txt"), "unsafe");
  await assert.rejects(
    scanPublicDirectory(root, { maxFileBytes: 5, maxAggregateBytes: 5 }),
    /public content scan failed/iu,
  );

  await writeFile(join(root, "safe.txt"), "x");
  await writeFile(join(root, "second.txt"), "12345");
  await assert.rejects(
    scanPublicDirectory(root, { maxFileBytes: 5, maxAggregateBytes: 5 }),
    /public content scan failed/iu,
  );
  await rm(join(root, "second.txt"));

  const unknown = Buffer.from([0, 255, 1, 2]);
  await writeFile(join(root, "asset.png"), unknown);
  await assert.rejects(scanPublicDirectory(root), /public content scan failed/iu);
  await rm(join(root, "asset.png"));

  try {
    await symlink(join(root, "safe.txt"), join(root, "linked.txt"));
    await assert.rejects(scanPublicDirectory(root), /public content scan failed/iu);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }

  if (process.platform !== "win32") {
    const fifo = join(root, "pipe");
    const made = spawnSync("mkfifo", [fifo]);
    if (made.status === 0) await assert.rejects(scanPublicDirectory(root), /public content scan failed/iu);
  }
});

test("owned directory boundary rejects a linked root before reading target content", async (t) => {
  const parent = await temporaryDirectory(t, "public-owned-boundary-");
  const outside = join(parent, "outside");
  const linked = join(parent, "linked");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), fragments("gh", "p_", "Q".repeat(36)));
  try {
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return;
    throw error;
  }
  await assert.rejects(scanPublicDirectory(linked), /public content scan failed/iu);
});

test("owned boundary rejects a replaced root before walk or direct content read", async (t) => {
  const parent = await temporaryDirectory(t, "public-root-replacement-");
  const root = join(parent, "owned");
  const original = join(parent, "original");
  await mkdir(root);
  await writeFile(join(root, "data.txt"), "original\n");
  const boundary = await createOwnedBoundary(root);
  await rename(root, original);
  await mkdir(root);
  await writeFile(join(root, "data.txt"), "replacement\n");

  let observedReads = 0;
  await assert.rejects(readOwnedRegularFile(
    boundary,
    join(root, "data.txt"),
    "data.txt",
    1024,
    { onContentRead: () => { observedReads += 1; } },
  ), { code: "PUBLIC_FILE_CHANGED" });
  let observedRecords = 0;
  await assert.rejects(async () => {
    for await (const _record of walkOwnedRegularFiles(boundary, {
      onContentRead: () => { observedReads += 1; },
    })) observedRecords += 1;
  }, { code: "PUBLIC_FILE_CHANGED" });
  assert.equal(observedReads, 0);
  assert.equal(observedRecords, 0);
});

test("owned file read rejects swap-open-restore before the first byte", async (t) => {
  const parent = await temporaryDirectory(t, "public-open-restore-");
  const root = join(parent, "owned");
  const path = join(root, "data.txt");
  const saved = join(parent, "saved.txt");
  const replacement = join(parent, "replacement.txt");
  await mkdir(root);
  await writeFile(path, "original\n");
  await writeFile(replacement, "replacement\n");
  const boundary = await createOwnedBoundary(root);

  let observedReads = 0;
  await assert.rejects(readOwnedRegularFile(
    boundary,
    path,
    "data.txt",
    1024,
    {
      beforeOpen: async () => {
        await rename(path, saved);
        await rename(replacement, path);
      },
      afterOpen: async () => {
        await rename(path, replacement);
        await rename(saved, path);
      },
      onContentRead: () => { observedReads += 1; },
    },
  ), { code: "PUBLIC_FILE_CHANGED" });
  assert.equal(observedReads, 0);
});

test("Git history privacy finds deleted blobs, metadata, identities, and refs while keeping diagnostics redacted", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-positive-");
  await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);

  const deletedSecret = fragments("gh", "p_", "Z".repeat(36));
  await commitFile(root, "temporary.txt", deletedSecret, "temporary content", OWNER_EMAIL);
  git(root, ["rm", "-q", "temporary.txt"]);
  git(root, ["commit", "-qm", "remove temporary content"]);

  const sensitiveMessage = fragments("rotate ", "sk", "-proj-", "b".repeat(48));
  await commitFile(root, "message.txt", "safe\n", sensitiveMessage, OWNER_EMAIL);

  const personalEmail = fragments("private.person", "@example.com");
  await commitFile(root, "identity.txt", "safe\n", "identity probe", personalEmail);

  const tagMessage = fragments("tag contains ", "gh", "o_", "T".repeat(36));
  git(root, ["tag", "-a", "metadata-probe", "-m", tagMessage]);
  const refName = fragments("refs/heads/leaked-", "AK", "IA", "Q".repeat(16));
  git(root, ["update-ref", refName, "HEAD"]);

  const result = await scanPublicHistory(syntheticHistoryOptions(root));
  const categories = new Set(result.findings.map((finding) => finding.category));
  for (const expected of [
    "provider credential",
    "personal identity",
    "sensitive Git metadata",
    "sensitive ref name",
  ]) assert.ok(categories.has(expected), expected);
  const output = formatPublicFindings(result.findings);
  assert.match(output, /object=(?:blob|commit|tag|tree|ref):[a-f0-9]{40}/u);
  for (const sensitive of [deletedSecret, sensitiveMessage, personalEmail, tagMessage, refName]) {
    assert.equal(output.includes(sensitive), false, "diagnostics must never disclose matching content");
  }
});

test("Git history binds binary approval to every reachable tree path", async (t) => {
  t.diagnostic("PUBLIC_CONTENT_BINARY_PATH_STAGE_SCAN");
  const root = await temporaryGitRepository(t, "public-history-binary-path-");
  const banner = await readFile(new URL("../assets/gpt-codex-hwp-banner.png", import.meta.url));
  await commitFile(root, "assets/gpt-codex-hwp-banner.png", banner, "approved path", OWNER_EMAIL);
  await mkdir(join(root, "copied"));
  await writeFile(join(root, "copied", "gpt-codex-hwp-banner.png"), banner);
  git(root, ["add", "copied/gpt-codex-hwp-banner.png"]);
  git(root, ["commit", "-qm", "same blob at unapproved path"]);
  const result = await scanPublicHistory(syntheticHistoryOptions(root));
  t.diagnostic("PUBLIC_CONTENT_BINARY_PATH_STAGE_FINDING");
  assert.ok(result.findings.some((finding) =>
    finding.category === "binary not allowlisted"
    && finding.label === "copied/gpt-codex-hwp-banner.png"),
  "PUBLIC_CONTENT_BINARY_PATH_FINDING");
  t.diagnostic("PUBLIC_CONTENT_BINARY_PATH_STAGE_BODY_COMPLETE");
});

test("Git history rejects private evidence paths after their files are deleted", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-private-path-");
  await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);
  const privatePath = ".superpowers/sdd/private-review.md";
  await commitFile(root, privatePath, "safe but private evidence\n", "private evidence", OWNER_EMAIL);
  git(root, ["rm", "-q", "--", privatePath]);
  git(root, ["commit", "-qm", "remove private evidence"]);

  const result = await scanPublicHistory(syntheticHistoryOptions(root));
  assert.ok(result.findings.some((finding) =>
    finding.category === "private repository path"
    && finding.label === privatePath));
});

test("Git history associates private paths reachable only from an annotated tree tag", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-tree-tag-");
  await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);
  const blob = gitInput(root, ["hash-object", "-w", "--stdin"], "safe but private evidence\n").trim();
  const sddTree = gitInput(root, ["mktree"], `100644 blob ${blob}\treport.md\n`).trim();
  const privateTree = gitInput(root, ["mktree"], `040000 tree ${sddTree}\tsdd\n`).trim();
  const rootTree = gitInput(root, ["mktree"], `040000 tree ${privateTree}\t.superpowers\n`).trim();
  git(root, ["tag", "-a", "private-tree", "-m", "private tree tag", rootTree]);

  const result = await scanPublicHistory(syntheticHistoryOptions(root));
  assert.ok(result.findings.some((finding) =>
    finding.category === "private repository path"
    && finding.label === ".superpowers/sdd/report.md"));
});

test("Git history checks private tree and gitlink entry paths even without blobs", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-non-blob-path-");
  const parent = await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);
  const emptyTree = gitInput(root, ["mktree"], "").trim();
  const rootTree = gitInput(root, ["mktree"], [
    `040000 tree ${emptyTree}\tempty.hwpx`,
    `160000 commit ${parent}\tlinked.hwpx`,
    "",
  ].join("\n")).trim();
  const commit = gitInput(root, ["commit-tree", rootTree, "-p", parent], "private non-blob paths\n").trim();
  git(root, ["reset", "--hard", "-q", commit]);

  const result = await scanPublicHistory(syntheticHistoryOptions(root));
  for (const path of ["empty.hwpx", "linked.hwpx"]) {
    assert.ok(result.findings.some((finding) =>
      finding.category === "private repository path"
      && finding.label === path), path);
  }
});

test("Git history rejects the approved fixture path when it is a tree or gitlink", async (t) => {
  const cases = [
    { kind: "tree", mode: "040000", type: "tree" },
    { kind: "gitlink", mode: "160000", type: "commit" },
  ];
  for (const { kind, mode, type } of cases) {
    const root = await temporaryGitRepository(t, `public-history-fixture-${kind}-`);
    const parent = await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);
    const objectId = kind === "tree" ? gitInput(root, ["mktree"], "").trim() : parent;
    const rootTree = treeWithEntryAtPath(
      root,
      APPROVED_HWP_FIXTURE_PATH,
      mode,
      type,
      objectId,
    );
    const commit = gitInput(
      root,
      ["commit-tree", rootTree, "-p", parent],
      `fixture ${kind}\n`,
    ).trim();
    git(root, ["reset", "--hard", "-q", commit]);

    const result = await scanPublicHistory(syntheticHistoryOptions(root));
    assert.ok(result.findings.some((finding) =>
      finding.category === "private repository path"
      && finding.label === APPROVED_HWP_FIXTURE_PATH), kind);
  }
});

test("Git history document exception requires the allowlisted bytes in a regular blob entry", async (t) => {
  const fixture = await readFile(new URL(
    `../${APPROVED_HWP_FIXTURE_PATH}`,
    import.meta.url,
  ));
  const cases = [
    { expected: "passed", mode: "100644", bytes: fixture },
    { expected: "binary not allowlisted", mode: "100644", bytes: Buffer.from("not the fixture\n") },
    { expected: "private repository path", mode: "120000", bytes: fixture },
  ];
  for (const [index, { expected, mode, bytes }] of cases.entries()) {
    const root = await temporaryGitRepository(t, `public-history-fixture-blob-${index}-`);
    const parent = await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);
    const blob = gitInput(root, ["hash-object", "-w", "--stdin"], bytes).trim();
    const rootTree = treeWithEntryAtPath(
      root,
      APPROVED_HWP_FIXTURE_PATH,
      mode,
      "blob",
      blob,
    );
    const commit = gitInput(root, ["commit-tree", rootTree, "-p", parent], "fixture blob\n").trim();
    git(root, ["reset", "--hard", "-q", commit]);

    const result = await scanPublicHistory(syntheticHistoryOptions(root));
    if (expected === "passed") {
      assert.equal(result.findings.length, 0);
    } else {
      assert.ok(result.findings.some((finding) =>
        finding.category === expected && finding.label === APPROVED_HWP_FIXTURE_PATH), expected);
    }
  }
});

test("Git history disables and rejects replacement refs that hide a private tree", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-replace-ref-");
  const base = await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);
  const privatePath = ".superpowers/sdd/private-review.md";
  const privateCommit = await commitFile(
    root,
    privatePath,
    "safe but private evidence\n",
    "private evidence",
    OWNER_EMAIL,
  );
  const baseTree = git(root, ["rev-parse", `${base}^{tree}`]).trim();
  const cleanReplacement = gitInput(
    root,
    ["commit-tree", baseTree, "-p", base],
    "clean replacement\n",
  ).trim();
  git(root, ["replace", privateCommit, cleanReplacement]);
  git(root, ["reset", "--hard", "-q", privateCommit]);

  const result = await scanPublicHistory(syntheticHistoryOptions(root));
  assert.ok(result.findings.some((finding) =>
    finding.category === "private repository path"
    && finding.label === privatePath));
  assert.ok(result.findings.some((finding) => finding.category === "Git semantic override"));
});

test("Git history fails closed when info/grafts exists", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-grafts-");
  await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);
  git(root, ["config", "advice.graftFileDeprecated", "false"]);
  await writeFile(join(root, ".git", "info", "grafts"), "");

  await assert.rejects(scanPublicHistory(syntheticHistoryOptions(root)), /history scan failed/iu);
});

test("annotated tag chains are memoized within a linear traversal budget", () => {
  const tags = 20_000;
  const tree = "f".repeat(40);
  const tagTargets = new Map();
  const objectTypes = new Map([[tree, "tree"]]);
  for (let index = 0; index < tags; index += 1) {
    const objectId = index.toString(16).padStart(40, "0");
    const nextObjectId = index + 1 === tags
      ? tree
      : (index + 1).toString(16).padStart(40, "0");
    const type = index + 1 === tags ? "tree" : "tag";
    tagTargets.set(objectId, Object.freeze({ objectId: nextObjectId, type }));
    objectTypes.set(objectId, "tag");
  }
  const rootTrees = new Set();

  const receipt = addTaggedRootTrees(tagTargets, objectTypes, rootTrees);

  assert.deepEqual(rootTrees, new Set([tree]));
  assert.deepEqual(receipt, { traversalSteps: tags, resolvedTags: tags });
});

test("tracked public tree rejects benign content stored under a private evidence path", async (t) => {
  const root = await temporaryGitRepository(t, "public-tree-private-path-");
  await commitFile(root, "README.md", "safe\n", "safe initial", OWNER_EMAIL);
  const privatePath = "nested/.superpowers/sdd/private-review.md";
  await commitFile(root, privatePath, "safe but private evidence\n", "private evidence", OWNER_EMAIL);

  await assert.rejects(
    scanTrackedPublicTree({ root }),
    (error) => {
      assert.ok(error.findings.some((finding) =>
        finding.category === "private repository path"
        && finding.label === privatePath));
      return true;
    },
  );
});

test("tracked public tree binds the document exception to the exact raw fixture path", async (t) => {
  const fixture = await readFile(new URL(
    `../${APPROVED_HWP_FIXTURE_PATH}`,
    import.meta.url,
  ));
  const exactRoot = await temporaryGitRepository(t, "public-tree-exact-hwp-");
  await commitFile(exactRoot, APPROVED_HWP_FIXTURE_PATH, fixture, "approved fixture", OWNER_EMAIL);
  await assert.doesNotReject(scanTrackedPublicTree({ root: exactRoot }));

  const aliases = [
    APPROVED_HWP_FIXTURE_PATH.toUpperCase(),
    "packages/gpt-codex-hwp/tests/fixtures/rhwp/ｒｅ－０１－ｈａｎｇｕｌ－ｏｎｌｙ－ｈａｎｃｏｍ．ｈｗｐ",
  ];
  for (const [index, alias] of aliases.entries()) {
    const root = await temporaryGitRepository(t, `public-tree-hwp-alias-${index}-`);
    await commitFile(root, alias, fixture, "fixture alias", OWNER_EMAIL);
    await assert.rejects(
      scanTrackedPublicTree({ root }),
      (error) => {
        assert.ok(error.findings.some((finding) =>
          finding.category === "private repository path"
          && finding.label === alias.normalize("NFKC")), alias);
        return true;
      },
    );
  }
});

test("tracked public tree rejects descendants beneath document-extension segments", async (t) => {
  const root = await temporaryGitRepository(t, "public-tree-document-directory-");
  const privatePaths = [
    "exports/report.hwp/child.txt",
    "exports/report.hwpx/nested/child.txt",
  ];
  for (const path of privatePaths) {
    await commitFile(root, path, "safe but private evidence\n", "document directory", OWNER_EMAIL);
  }

  await assert.rejects(
    scanTrackedPublicTree({ root }),
    (error) => {
      for (const path of privatePaths) {
        assert.ok(error.findings.some((finding) =>
          finding.category === "private repository path" && finding.label === path), path);
      }
      return true;
    },
  );
});

test("Git history requires exact names and scans every header plus ref label", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-metadata-contract-");
  await commitFile(root, "safe.txt", "safe\n", "safe", OWNER_EMAIL);
  await writeFile(join(root, "wrong-owner.txt"), "safe\n");
  git(root, ["add", "wrong-owner.txt"]);
  git(root, ["-c", `user.name=Wrong Owner`, "commit", "-qm", "wrong owner name"]);

  const base = git(root, ["cat-file", "commit", "HEAD"]);
  const headerPath = fragments("C:", "\\", "Users", "\\private-person\\work");
  const boundary = base.indexOf("\n\n");
  const crafted = `${base.slice(0, boundary)}\nencoding ${headerPath}${base.slice(boundary)}`;
  const craftedId = gitInput(root, ["hash-object", "-t", "commit", "-w", "--stdin"], crafted).trim();
  git(root, ["update-ref", "refs/heads/header-probe", craftedId]);
  git(root, ["update-ref", "refs/heads/credentials.json", "HEAD"]);

  const result = await scanPublicHistory(syntheticHistoryOptions(root));
  assert.ok(
    result.findings.some((finding) => finding.category === "personal identity"),
    "PUBLIC_CONTENT_METADATA_PERSONAL_IDENTITY",
  );
  assert.ok(result.findings.some((finding) => finding.objectId === craftedId
    && finding.category === "sensitive Git metadata"), "PUBLIC_CONTENT_METADATA_COMMIT_HEADER");
  assert.ok(
    result.findings.some((finding) => finding.category === "sensitive ref name"),
    "PUBLIC_CONTENT_METADATA_REF_NAME",
  );
});

test("Git history pins frozen releases to annotated tag objects and peeled commits", async (t) => {
  let stage = "SETUP";
  const enterStage = (value) => {
    stage = value;
    t.diagnostic(`PUBLIC_CONTENT_FROZEN_TAG_STAGE_${value}`);
  };
  try {
    enterStage("SETUP");
    const root = await temporaryGitRepository(t, "public-history-frozen-tags-");
    const pinnedCommit = await commitFile(root, "safe.txt", "safe\n", "safe", OWNER_EMAIL);
    git(root, ["tag", "-a", "v-inner", "-m", "inner frozen release"]);
    git(root, ["tag", "-a", "v-test", "-m", "outer frozen release", "v-inner"]);
    const pinnedTagObject = git(root, ["rev-parse", "refs/tags/v-test"]).trim();
    const expected = new Map([["v-test", Object.freeze({
      tagObject: pinnedTagObject,
      commit: pinnedCommit,
    })]]);

    enterStage("INITIAL_PASS");
    const passed = await scanPublicHistory({ root, frozenReleaseTags: expected });
    assert.equal(passed.findings.length, 0);

    enterStage("RETARGET_COMMIT");
    const otherCommit = await commitFile(root, "retargeted.txt", "safe\n", "retarget", OWNER_EMAIL);
    await assert.rejects(
      scanPublicHistory({
        root,
        frozenReleaseTags: new Map([["v-test", Object.freeze({
          tagObject: pinnedTagObject,
          commit: otherCommit,
        })]]),
      }),
      /history scan failed/iu,
    );

    enterStage("RETARGET_TAG");
    git(root, ["tag", "-d", "v-test"]);
    git(root, ["tag", "-a", "v-test", "-m", "retargeted release"]);
    await assert.rejects(
      scanPublicHistory({ root, frozenReleaseTags: expected }),
      /history scan failed/iu,
    );

    enterStage("LIGHTWEIGHT");
    git(root, ["tag", "-d", "v-test"]);
    git(root, ["tag", "v-test", pinnedCommit]);
    await assert.rejects(
      scanPublicHistory({ root, frozenReleaseTags: expected }),
      /history scan failed/iu,
    );

    enterStage("MISSING");
    await assert.rejects(
      scanPublicHistory({
        root,
        frozenReleaseTags: new Map([["v-missing", Object.freeze({
          tagObject: pinnedTagObject,
          commit: pinnedCommit,
        })]]),
      }),
      /history scan failed/iu,
    );
    enterStage("BODY_COMPLETE");
  } catch {
    throw new Error(`PUBLIC_CONTENT_FROZEN_TAG_${stage}`);
  }
});

test("Git history production pins contain the exact published identities with no CLI bypass", async () => {
  const source = await readFile(new URL("../scripts/scan-public-history.mjs", import.meta.url), "utf8");
  const identities = [
    ["v0.1.0", "ef0912777438499192c570f6e4f8e638f723f713", "8ab57d6b289727a6ea4b53f21193223e314c5f11"],
    ["v0.1.1", "c40236454d48ab5010d5df39761220fb7bf0759b", "356eb97d4627769a9593529b0c08adf481ca0eb8"],
    ["v0.1.2", "95d563c8edeeb1db97129c364cc353938faf1eb2", "4fe07da12d12fdba928f98fb9167a9ce70c98151"],
    ["v0.1.3", "35f5792981d8306ab9554d107b6fbe33576df99c", "4132b280cb206f7da426c1c479e950ac208d9639"],
    ["v0.1.4", "e400d45c1f9f746d177f7ffcc2a5737ae699beee", "27e44224241628e336181727c85b1598dfe74fd2"],
  ];
  assert.match(source, /const FROZEN_RELEASE_TAGS = Object\.freeze\(\{/u);
  assert.doesNotMatch(source, /export\s+(?:const|\{[^}]*\})\s*FROZEN_RELEASE_TAGS/u);
  assert.doesNotMatch(source, /--(?:skip|ignore|disable)[^\s"']*tag/iu);
  for (const [tag, tagObject, commit] of identities) {
    for (const identity of [tag, tagObject, commit]) assert.equal(source.includes(identity), true, identity);
    assert.equal(git(REPOSITORY_ROOT, ["--no-replace-objects", "cat-file", "-t", `refs/tags/${tag}`]).trim(), "tag", tag);
    assert.equal(git(REPOSITORY_ROOT, ["--no-replace-objects", "rev-parse", `refs/tags/${tag}`]).trim(), tagObject, tag);
    assert.equal(git(REPOSITORY_ROOT, ["--no-replace-objects", "rev-parse", `refs/tags/${tag}^{commit}`]).trim(), commit, tag);
  }
});

test("Git history privacy allows only the approved owner and exact neutral immutable objects", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-identity-");
  const ownerCommit = await commitFile(root, "owner.txt", "safe\n", "owner", OWNER_EMAIL);
  let result = await scanPublicHistory(syntheticHistoryOptions(root));
  assert.equal(result.findings.length, 0);

  const neutralEmail = fragments("codex", "@local");
  const neutralCommit = await commitFile(root, "neutral.txt", "safe\n", "neutral", neutralEmail, "Codex");
  result = await scanPublicHistory(syntheticHistoryOptions(root));
  assert.ok(result.findings.some((finding) => finding.category === "personal identity"));

  result = await scanPublicHistory(syntheticHistoryOptions(root, {
    neutralObjectAllowlist: new Set([neutralCommit]),
  }));
  assert.equal(result.findings.length, 0);

  git(root, ["-c", "user.name=Codex", "-c", `user.email=${neutralEmail}`, "tag", "-a", "neutral-tag", "-m", "safe tag"]);
  const tagObject = git(root, ["rev-parse", "refs/tags/neutral-tag"]).trim();
  result = await scanPublicHistory(syntheticHistoryOptions(root, {
    neutralObjectAllowlist: new Set([neutralCommit]),
  }));
  assert.ok(result.findings.some((finding) => finding.objectId === tagObject));
  result = await scanPublicHistory(syntheticHistoryOptions(root, {
    neutralObjectAllowlist: new Set([neutralCommit, tagObject]),
  }));
  assert.equal(result.findings.length, 0);
  assert.match(ownerCommit, /^[a-f0-9]{40}$/u);
});

test("Git history privacy fails closed for shallow and malformed Git operations", async (t) => {
  const source = await temporaryGitRepository(t, "public-history-source-");
  await commitFile(source, "safe.txt", "safe\n", "safe", OWNER_EMAIL);
  const clone = await temporaryDirectory(t, "public-history-shallow-");
  await rm(clone, { recursive: true, force: true });
  git(process.cwd(), ["clone", "-q", "--depth=1", `file:///${source.replaceAll("\\", "/")}`, clone]);
  await assert.rejects(scanPublicHistory(syntheticHistoryOptions(clone)), /history scan failed/iu);
  await assert.rejects(
    scanPublicHistory(syntheticHistoryOptions(source, {
      runGit: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    })),
    /history scan failed/iu,
  );
});

test("bounded process enforces a deadline and closes with a redacted receipt", async () => {
  const started = Date.now();
  const result = await runBoundedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 150,
    maxOutputBytes: 1024,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, -1);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
});

test("bounded process proves termination while keeping fast target bytes separate from control frames", async () => {
  const result = await runBoundedProcess(process.execPath, [
    "-e",
    "process.stdout.write(Buffer.from([0,255,65]));process.stderr.write(Buffer.from([66,0,254]));",
  ], { timeoutMs: 5_000, maxOutputBytes: 64 });
  assert.equal(result.code, 0);
  assert.equal(result.terminationFailed, false);
  assert.deepEqual(result.stdout, Buffer.from([0, 255, 65]));
  assert.deepEqual(result.stderr, Buffer.from([66, 0, 254]));
});

test("public runner stdin retains owner-lifetime error handling after its end callback", async () => {
  const dispatch = publicContentPolicy.dispatchPublicProcessInput;
  assert.equal(typeof dispatch, "function");
  const child = new EventEmitter();
  const input = new PassThrough();
  child.stdin = input;
  let listenersAfterCallback = -1;
  let laterErrorEmitted = false;
  input.end = ((_chunk, callback) => {
    callback?.();
    listenersAfterCallback = input.listenerCount("error");
    if (listenersAfterCallback > 0) {
      laterErrorEmitted = true;
      input.emit("error", Object.assign(new Error("late public runner pipe failure"), { code: "EPIPE" }));
    }
    return input;
  });

  await dispatch(child, input, Buffer.from("request"), Date.now() + 100);
  assert.equal(listenersAfterCallback, 1);
  assert.equal(laterErrorEmitted, true);
  assert.equal(input.listenerCount("error"), 1);
  child.emit("close", 0, null);
  assert.equal(input.listenerCount("error"), 0);
});

test("public runner stdin dispatch is bounded by the startup deadline", async () => {
  const dispatch = publicContentPolicy.dispatchPublicProcessInput;
  assert.equal(typeof dispatch, "function");
  const child = new EventEmitter();
  const input = new PassThrough();
  child.stdin = input;
  input.end = (() => input);
  const started = Date.now();
  await assert.rejects(
    dispatch(child, input, Buffer.from("request"), Date.now() + 20),
    (error) => error?.code === "PUBLIC_PROCESS_TIMEOUT",
  );
  assert.ok(Date.now() - started < 1_000);
  child.emit("close", null, "SIGKILL");
  assert.equal(input.listenerCount("error"), 0);
});

test("public supervisor line reader rejects high-bit bytes before ASCII decoding", async () => {
  const Reader = publicContentPolicy.BoundedLineReader;
  assert.equal(typeof Reader, "function");
  const stream = new PassThrough();
  const reader = new Reader(stream, 128);
  const exactAsciiAlias = Buffer.from("GPT_CODEX_HWP_JOB READY 7 1 9\n", "ascii");
  exactAsciiAlias[0] |= 0x80;
  const pending = reader.next(50);
  stream.end(exactAsciiAlias);
  await assert.rejects(pending, (error) => error?.code === "PUBLIC_PROCESS_START");
});

test("public supervisor raw-byte rejection permanently poisons final transcript proof", async () => {
  const Reader = publicContentPolicy.BoundedLineReader;
  const finalize = publicContentPolicy.finalizePublicWindowsSupervisor;
  assert.equal(typeof Reader, "function");
  assert.equal(typeof finalize, "function");
  const stream = new PassThrough();
  const reader = new Reader(stream, 128);
  stream.write("GPT_CODEX_HWP_JOB RSS 10 20\nGPT_CODEX_HWP_JOB GONE 0 1\n", "ascii");
  assert.equal(await reader.next(50), "GPT_CODEX_HWP_JOB RSS 10 20");
  assert.equal(await reader.next(50), "GPT_CODEX_HWP_JOB GONE 0 1");

  const ended = new Promise((resolvePromise) => stream.once("end", resolvePromise));
  stream.write(Buffer.from([0x80]));
  stream.end();
  await ended;

  const finalized = await finalize({
    closeReceipt: Promise.resolve({ code: 0, signal: null, error: null }),
    forceClose: () => true,
    allowForceClose: true,
    transcriptReceipt: () => ({
      stdinFailed: false,
      stderrBytes: 0,
      ...reader.transcriptReceipt(),
    }),
    gracefulCloseMs: 20,
    forcedCloseMs: 20,
  });
  assert.equal(finalized, false);
  assert.equal(reader.transcriptReceipt().protocolFailed, true);
});

test("production public process API does not expose the forced tracker switch", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "scripts", "public-content-policy.mjs"), "utf8");
  assert.equal(source.includes("options.forceWindowsTracker"), false);
  assert.equal(source.includes("async function abortStartup("), false);
});

test("public startup failure receipt preserves unverified cleanup", async () => {
  const error = Object.assign(new Error("startup cleanup unverified"), {
    code: "PUBLIC_PROCESS_START",
    terminationFailed: true,
  });
  const result = await runBoundedProcess("unused-tool", [], {
    maxOutputBytes: 64,
    startProcess: async () => { throw error; },
  });
  assert.equal(result.code, -1);
  assert.equal(result.terminationFailed, true);
});

test("public startup abort proves actual helper and runner close receipts", async (t) => {
  const abort = publicContentPolicy.abortPublicProcessStartup;
  assert.equal(typeof abort, "function");
  const runner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const helper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    try { runner.kill("SIGKILL"); } catch {}
    try { helper.kill("SIGKILL"); } catch {}
  });
  const runnerClose = publicContentPolicy.observePublicProcessClose(runner);
  const helperClose = publicContentPolicy.observePublicProcessClose(helper);
  await Promise.all([
    new Promise((resolvePromise, reject) => runner.once("spawn", resolvePromise).once("error", reject)),
    new Promise((resolvePromise, reject) => helper.once("spawn", resolvePromise).once("error", reject)),
  ]);

  const cleanup = await abort({
    child: runner,
    childCloseReceipt: runnerClose,
    startupHelper: { helper, closeReceipt: helperClose },
    platform: "win32",
    timeoutMs: 1_000,
  });
  assert.deepEqual(cleanup, {
    helperClosed: true,
    runnerClosed: true,
    verified: true,
  });
  assert.equal((await helperClose).error, null);
  assert.equal((await runnerClose).error, null);
});

test("public startup abort never signals the runner before helper close proof", async () => {
  const abort = publicContentPolicy.abortPublicProcessStartup;
  assert.equal(typeof abort, "function");
  const helper = new EventEmitter();
  helper.stdin = new PassThrough();
  helper.stdout = new PassThrough();
  helper.stderr = new PassThrough();
  helper.stdio = [helper.stdin, helper.stdout, helper.stderr];
  helper.exitCode = null;
  helper.signalCode = null;
  helper.unref = () => {};
  let helperKills = 0;
  helper.kill = () => { helperKills += 1; return true; };
  const runner = new EventEmitter();
  runner.stdin = new PassThrough();
  runner.stdout = new PassThrough();
  runner.stderr = new PassThrough();
  runner.stdio = [runner.stdin, runner.stdout, runner.stderr];
  runner.exitCode = null;
  runner.signalCode = null;
  runner.unref = () => {};
  let runnerSignals = 0;
  runner.kill = () => { runnerSignals += 1; return true; };
  const cleanup = await abort({
    child: runner,
    childCloseReceipt: publicContentPolicy.observePublicProcessClose(runner),
    startupHelper: {
      helper,
      closeReceipt: publicContentPolicy.observePublicProcessClose(helper),
    },
    platform: "win32",
    timeoutMs: 20,
  });
  assert.deepEqual(cleanup, {
    helperClosed: false,
    runnerClosed: false,
    verified: false,
  });
  assert.equal(helperKills, 1);
  assert.equal(runnerSignals, 0);
});

test("public startup abort resumes exact runner cleanup after a late helper close", {
  timeout: 2_000,
}, async () => {
  const abort = publicContentPolicy.abortPublicProcessStartup;
  const helper = trackedPublicProcessOwner();
  const runner = trackedPublicProcessOwner();
  const helperSignals = [];
  const runnerSignals = [];
  helper.child.kill = (signal = "SIGTERM") => {
    helperSignals.push(signal);
    return true;
  };
  runner.child.kill = (signal = "SIGTERM") => {
    runnerSignals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => runner.child.emit("close", null, "SIGKILL"));
    }
    return true;
  };
  const helperClose = publicContentPolicy.observePublicProcessClose(helper.child);
  const runnerClose = publicContentPolicy.observePublicProcessClose(runner.child);

  const cleanup = await abort({
    child: runner.child,
    childCloseReceipt: runnerClose,
    startupHelper: { helper: helper.child, closeReceipt: helperClose },
    platform: "win32",
    timeoutMs: 20,
  });
  assert.deepEqual(cleanup, {
    helperClosed: false,
    runnerClosed: false,
    verified: false,
  });
  assert.deepEqual(helperSignals, ["SIGTERM"]);
  assert.deepEqual(runnerSignals, []);

  helper.child.emit("close", null, "SIGTERM");
  await helperClose;
  await runnerClose;
  assert.deepEqual(runnerSignals, [0, "SIGKILL"]);
  assert.deepEqual(helper.destroyCalls, [1, 1, 1]);
  assert.equal(helper.unrefCalls(), 1);
  assert.deepEqual(runner.destroyCalls, [1, 1, 1]);
  assert.equal(runner.unrefCalls(), 1);
});

test("public startup treats an error followed by exact helper close as closed", async () => {
  const abort = publicContentPolicy.abortPublicProcessStartup;
  const helper = trackedPublicProcessOwner();
  const runner = trackedPublicProcessOwner();
  const runnerSignals = [];
  helper.child.kill = () => {
    queueMicrotask(() => {
      helper.child.emit("error", new Error("helper failed before close"));
      helper.child.emit("close", null, null);
    });
    return true;
  };
  runner.child.kill = (signal = "SIGTERM") => {
    runnerSignals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => runner.child.emit("close", null, "SIGKILL"));
    }
    return true;
  };
  const helperClose = publicContentPolicy.observePublicProcessClose(helper.child);
  const runnerClose = publicContentPolicy.observePublicProcessClose(runner.child);

  const cleanup = await abort({
    child: runner.child,
    childCloseReceipt: runnerClose,
    startupHelper: { helper: helper.child, closeReceipt: helperClose },
    platform: "win32",
    timeoutMs: 50,
  });

  assert.deepEqual(cleanup, {
    helperClosed: true,
    runnerClosed: true,
    verified: true,
  });
  assert.notEqual((await helperClose).error, null);
  assert.deepEqual(runnerSignals, [0, "SIGKILL"]);
  assert.deepEqual(helper.destroyCalls, [1, 1, 1]);
  assert.equal(helper.unrefCalls(), 1);
  assert.deepEqual(runner.destroyCalls, [1, 1, 1]);
  assert.equal(runner.unrefCalls(), 1);
});

test("Windows public invalid READY path reports verified helper and runner close", {
  skip: process.platform !== "win32" ? "Windows process supervision is Windows-only" : false,
}, async () => {
  const start = publicContentPolicy.startBoundedProcessWithWindowsRunnerForTest;
  assert.equal(typeof start, "function");
  const runnerPath = fileURLToPath(new URL("./fixtures/public-invalid-ready-runner.mjs", import.meta.url));
  await assert.rejects(
    start(process.execPath, ["-e", "process.exit(99)"], { timeoutMs: 2_000 }, runnerPath),
    (error) => {
      assert.equal(error?.code, "PUBLIC_PROCESS_START");
      assert.equal(error?.terminationFailed, false);
      assert.deepEqual(error?.startupCleanup, {
        helperClosed: true,
        runnerClosed: true,
        verified: true,
      });
      return true;
    },
  );
});

test("Windows public scanner rejects mode 2 before dispatching an ephemeral-intermediate payload", {
  skip: process.platform !== "win32" ? "Windows process tracking is Windows-only" : false,
  timeout: 15_000,
}, async (t) => {
  const root = await temporaryDirectory(t, "public-mode2-gate-");
  const dispatchMarker = join(root, "dispatched.txt");
  const leafPidPath = join(root, "leaf.pid");
  t.after(async () => {
    try { process.kill(Number(await readFile(leafPidPath, "utf8")), "SIGKILL"); } catch {}
  });
  const leaf = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(leafPidPath)},String(process.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const intermediate = [
    "const {spawn}=require('node:child_process');",
    `spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore'}).unref();`,
  ].join("");
  const payload = [
    "const {spawn}=require('node:child_process');const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(dispatchMarker)},'dispatched');`,
    `spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore'});`,
    "setInterval(()=>{},1000);",
  ].join("");

  let startupError;
  const result = await runBoundedProcess(process.execPath, ["-e", payload], {
    timeoutMs: 3_000,
    maxOutputBytes: 1_024,
    startProcess: async (tool, args, options) => {
      try {
        return await publicContentPolicy.startBoundedProcessWithForcedWindowsTrackerForTest(
          tool,
          args,
          options,
        );
      } catch (error) {
        startupError = error;
        throw error;
      }
    },
  });

  assert.equal(result.code, -1);
  assert.equal(result.terminationFailed, false);
  assert.deepEqual(startupError?.startupCleanup, {
    helperClosed: true,
    runnerClosed: true,
    verified: true,
  });
  await assert.rejects(readFile(dispatchMarker), { code: "ENOENT" });
  await assert.rejects(readFile(leafPidPath), { code: "ENOENT" });
});

test("public scanner supervisor finalizer requires exact close and an exhausted transcript", async () => {
  const finalize = publicContentPolicy.finalizePublicWindowsSupervisor;
  assert.equal(typeof finalize, "function");
  for (const [label, closeReceipt, transcriptReceipt, expected] of [
    ["clean zero", { code: 0, signal: null, error: null }, cleanPublicSupervisorTranscript(), true],
    ["nonzero", { code: 9, signal: null, error: null }, cleanPublicSupervisorTranscript(), false],
    ["signal", { code: null, signal: "SIGTERM", error: null }, cleanPublicSupervisorTranscript(), false],
    ["spawn error", { code: null, signal: null, error: new Error("spawn failed") }, cleanPublicSupervisorTranscript(), false],
    ["stdin error", { code: 0, signal: null, error: null }, { ...cleanPublicSupervisorTranscript(), stdinFailed: true }, false],
    ["late stderr", { code: 0, signal: null, error: null }, { ...cleanPublicSupervisorTranscript(), stderrBytes: 1 }, false],
    ["trailing frame", { code: 0, signal: null, error: null }, { ...cleanPublicSupervisorTranscript(), queuedFrames: 1 }, false],
    ["trailing partial", { code: 0, signal: null, error: null }, { ...cleanPublicSupervisorTranscript(), partialBytes: 1 }, false],
  ]) {
    let forceCalls = 0;
    assert.equal(await finalize({
      closeReceipt: Promise.resolve(closeReceipt),
      forceClose: () => { forceCalls += 1; return true; },
      allowForceClose: true,
      transcriptReceipt: () => transcriptReceipt,
      gracefulCloseMs: 20,
      forcedCloseMs: 20,
    }), expected, label);
    assert.equal(forceCalls, 0, label);
  }
});

test("public scanner mode 1 protocol rejects an unexpected TRACKER frame before RSS", () => {
  const parseRss = publicContentPolicy.parsePublicWindowsSupervisorRssFrame;
  assert.equal(typeof parseRss, "function");
  assert.equal(parseRss("GPT_CODEX_HWP_JOB TRACKER 1 3"), undefined);
  assert.deepEqual(parseRss("GPT_CODEX_HWP_JOB RSS 10 20"), {
    baselineRss: 10,
    peakRss: 20,
  });
});

test("public scanner invalid frame performs bounded helper cleanup without proof", async () => {
  const terminate = publicContentPolicy.terminatePublicWindowsSupervisor;
  assert.equal(typeof terminate, "function");
  const helper = new EventEmitter();
  helper.stdin = new PassThrough();
  helper.stdout = new PassThrough();
  helper.stderr = new PassThrough();
  helper.stdio = [helper.stdin, helper.stdout, helper.stderr];
  helper.exitCode = null;
  helper.signalCode = null;
  helper.unref = () => {};
  const signals = [];
  helper.kill = (signal = "SIGTERM") => {
    signals.push(signal);
    queueMicrotask(() => helper.emit("close", null, signal));
    return true;
  };
  const closeReceipt = publicContentPolicy.observePublicProcessClose(helper);

  const result = await terminate({
    helper,
    lines: { next: async () => "GPT_CODEX_HWP_JOB TRACKER 1 3" },
    closeReceipt,
    transcriptReceipt: cleanPublicSupervisorTranscript,
    frameTimeoutMs: 20,
    cleanupTimeoutMs: 50,
  });

  assert.equal(result, false);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(helper.stdin.destroyed, true);
  assert.equal(helper.stdout.destroyed, true);
  assert.equal(helper.stderr.destroyed, true);
});

test("public scanner retains an unclosed helper until its exact late close", async () => {
  const cleanup = publicContentPolicy.cleanupPublicProcessHelper;
  assert.equal(typeof cleanup, "function");
  const owner = trackedPublicProcessOwner();
  const signals = [];
  owner.child.kill = (signal = "SIGTERM") => {
    signals.push(signal);
    return true;
  };
  const closeReceipt = publicContentPolicy.observePublicProcessClose(owner.child);

  const results = await Promise.all([
    cleanup(owner.child, closeReceipt, 20),
    cleanup(owner.child, closeReceipt, 20),
  ]);
  assert.deepEqual(results, [false, false]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(owner.destroyCalls, [0, 0, 0]);
  assert.equal(owner.unrefCalls(), 0);

  owner.child.emit("close", null, "SIGKILL");
  await closeReceipt;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(owner.destroyCalls, [1, 1, 1]);
  assert.equal(owner.unrefCalls(), 1);
});

test("bounded process retains an unclosed runner after failed termination proof", async () => {
  const owner = trackedPublicProcessOwner();
  const closeReceipt = publicContentPolicy.observePublicProcessClose(owner.child);
  const result = await runBoundedProcess("unused-tool", [], {
    maxOutputBytes: 64,
    terminationTimeoutMs: 20,
    startProcess: async () => ({
      child: owner.child,
      closeReceipt,
      deadline: Date.now() + 10,
      exit: new Promise(() => {}),
      terminate: async () => false,
    }),
  });

  assert.equal(result.terminationFailed, true);
  assert.deepEqual(owner.destroyCalls, [0, 0, 0]);
  assert.equal(owner.unrefCalls(), 0);

  owner.child.emit("close", null, "SIGKILL");
  await closeReceipt;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(owner.destroyCalls, [1, 1, 1]);
  assert.equal(owner.unrefCalls(), 1);
});

test("public scanner supervisor force-close requires valid GONE and expected SIGTERM", async () => {
  const finalize = publicContentPolicy.finalizePublicWindowsSupervisor;
  assert.equal(typeof finalize, "function");
  let forceCalls = 0;
  let resolveInvalidClose;
  const invalidClose = new Promise((resolvePromise) => { resolveInvalidClose = resolvePromise; });
  assert.equal(await finalize({
    closeReceipt: invalidClose,
    forceClose: () => {
      forceCalls += 1;
      resolveInvalidClose({ code: null, signal: "SIGTERM", error: null });
      return true;
    },
    allowForceClose: false,
    transcriptReceipt: cleanPublicSupervisorTranscript,
    gracefulCloseMs: 5,
    forcedCloseMs: 50,
  }), false);
  assert.equal(forceCalls, 1);

  forceCalls = 0;
  let resolveClose;
  const closeReceipt = new Promise((resolvePromise) => { resolveClose = resolvePromise; });
  assert.equal(await finalize({
    closeReceipt,
    forceClose: () => {
      forceCalls += 1;
      resolveClose({ code: null, signal: "SIGTERM", error: null });
      return true;
    },
    allowForceClose: true,
    transcriptReceipt: cleanPublicSupervisorTranscript,
    gracefulCloseMs: 5,
    forcedCloseMs: 50,
  }), true);
  assert.equal(forceCalls, 1);
});

test("Windows public scanner observes actual helper.kill as an expected SIGTERM close", {
  skip: process.platform !== "win32" ? "Windows helper signal receipts are Windows-only" : false,
  timeout: 10_000,
}, async (t) => {
  const observeClose = publicContentPolicy.observePublicProcessClose;
  const finalize = publicContentPolicy.finalizePublicWindowsSupervisor;
  assert.equal(typeof observeClose, "function");
  assert.equal(typeof finalize, "function");
  const powershell = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const helper = spawn(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Start-Sleep -Seconds 30",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { helper.kill("SIGKILL"); } catch {} });
  await new Promise((resolvePromise, rejectPromise) => {
    helper.once("spawn", resolvePromise);
    helper.once("error", rejectPromise);
  });
  const closeReceipt = observeClose(helper);
  const finalized = await finalize({
    closeReceipt,
    forceClose: () => helper.kill(),
    allowForceClose: true,
    transcriptReceipt: cleanPublicSupervisorTranscript,
    gracefulCloseMs: 5,
    forcedCloseMs: 2_000,
  });

  assert.equal(finalized, true);
  assert.deepEqual(await closeReceipt, { code: null, signal: "SIGTERM", error: null });
});

test("bounded process kills a descendant after its parent exits with inherited pipes", async (t) => {
  const root = await temporaryDirectory(t, "public-process-tree-");
  const pidPath = join(root, "descendant.pid");
  const sentinelPath = join(root, "descendant-sentinel.txt");
  const descendant = [
    "const fs=require('node:fs');",
    `setTimeout(()=>fs.writeFileSync(${JSON.stringify(sentinelPath)},'unexpected'),6000);`,
    "setInterval(()=>{},1000);",
  ].join("");
  const parent = [
    "const {spawn}=require('node:child_process');const fs=require('node:fs');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],`,
    "{stdio:['ignore','inherit','inherit']});",
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
  ].join("");
  const result = await runBoundedProcess(process.execPath, ["-e", parent], {
    timeoutMs: 4_000,
    maxOutputBytes: 1024,
  });
  assert.equal(result.timedOut, true);
  const descendantPid = Number(await readFile(pidPath, "utf8"));
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_200));
  assert.equal(processExists(descendantPid), false);
  await assert.rejects(readFile(sentinelPath), { code: "ENOENT" });
});

test("bounded process makes terminator failure authoritative after early parent exit", async () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  const result = await runBoundedProcess("unused-tool", [], {
    maxOutputBytes: 64,
    startProcess: async () => ({
      child,
      deadline: Date.now() + 1_000,
      exit: Promise.resolve({ code: 0, signal: null, error: false }),
      terminate: async () => false,
    }),
    terminationTimeoutMs: 50,
  });
  assert.equal(result.code, -1);
  assert.equal(result.terminationFailed, true);
});

test("bounded process bounds a hanging terminator after early parent exit", async () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  const started = Date.now();
  const result = await runBoundedProcess("unused-tool", [], {
    maxOutputBytes: 64,
    startProcess: async () => ({
      child,
      deadline: Date.now() + 1_000,
      exit: Promise.resolve({ code: 0, signal: null, error: false }),
      terminate: () => new Promise(() => {}),
    }),
    terminationTimeoutMs: 20,
  });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(result.code, -1);
  assert.equal(result.terminationFailed, true);
});

test("bounded process owns an overflow-exit race with one authoritative terminator", async () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  let resolveExit;
  let terminations = 0;
  const exit = new Promise((resolvePromise) => { resolveExit = resolvePromise; });
  const resultPromise = runBoundedProcess("unused-tool", [], {
    maxOutputBytes: 8,
    startProcess: async () => ({
      child,
      deadline: Date.now() + 1_000,
      exit,
      terminate: async () => {
        terminations += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        return terminations === 1;
      },
    }),
    terminationTimeoutMs: 100,
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  child.stdout.write(Buffer.alloc(9));
  resolveExit({ code: 0, signal: null, error: false });
  const result = await resultPromise;
  assert.equal(terminations, 1);
  assert.equal(result.overflow, true);
  assert.equal(result.terminationFailed, false);
});

test("POSIX process group termination classifies ESRCH as gone at TERM", async () => {
  const signals = [];
  const result = await terminatePosixProcessGroup({ pid: 41 }, {
    killProcess: (_pid, signal) => {
      signals.push(signal);
      throw systemError("ESRCH");
    },
    delay: async () => {},
  });
  assert.equal(result, true);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("POSIX process group termination stops after TERM when liveness reports gone", async () => {
  const signals = [];
  const result = await terminatePosixProcessGroup({ pid: 45 }, {
    killProcess: (_pid, signal) => { signals.push(signal); },
    liveness: async () => false,
    delay: async () => {},
  });
  assert.equal(result, true);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("POSIX process group termination accepts ESRCH at KILL after bounded polling", async () => {
  const signals = [];
  const result = await terminatePosixProcessGroup({ pid: 42 }, {
    killProcess: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") throw systemError("ESRCH");
    },
    liveness: async () => true,
    delay: async () => {},
    pollAttempts: 2,
  });
  assert.equal(result, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("POSIX process group termination confirms gone after KILL", async () => {
  const signals = [];
  const alive = [true, false];
  const result = await terminatePosixProcessGroup({ pid: 46 }, {
    killProcess: (_pid, signal) => { signals.push(signal); },
    liveness: async () => alive.shift(),
    delay: async () => {},
    pollAttempts: 1,
  });
  assert.equal(result, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("POSIX process group termination treats EPERM as alive and failed", async () => {
  const signals = [];
  const result = await terminatePosixProcessGroup({ pid: 43 }, {
    killProcess: (_pid, signal) => {
      signals.push(signal);
      throw systemError("EPERM");
    },
    delay: async () => {},
    pollAttempts: 2,
  });
  assert.equal(result, false);
  assert.deepEqual(signals, ["SIGTERM", 0, 0, "SIGKILL", 0, 0]);
});

test("POSIX process group termination fails closed while the group remains alive", async () => {
  const signals = [];
  const result = await terminatePosixProcessGroup({ pid: 44 }, {
    killProcess: (_pid, signal) => { signals.push(signal); },
    liveness: async () => true,
    delay: async () => {},
    pollAttempts: 2,
  });
  assert.equal(result, false);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("public content policy is mandatory in root scripts and release ordering", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["security:scan-tree"], "node scripts/public-content-policy.mjs --tree");
  assert.equal(packageJson.scripts["security:scan-history"], "node scripts/scan-public-history.mjs");
  const tree = REQUIRED_RELEASE_STAGES.indexOf("public-tree");
  const history = REQUIRED_RELEASE_STAGES.indexOf("public-history");
  const artifacts = REQUIRED_RELEASE_STAGES.indexOf("release-artifacts");
  assert.ok(tree >= 0 && history > tree && artifacts > history);
});

test("public content fixtures canonicalize an injected aliased temp parent", async (t) => {
  const alias = await temporaryDirectoryAlias(t, "public-canonical-parent-");
  if (alias === undefined) return;
  await assert.rejects(
    temporaryDirectory(t, "../escaped-fixture-", alias.path),
    { code: "CANONICAL_TEMP_PREFIX_INVALID" },
  );
  const root = await temporaryDirectory(t, "owned-fixture-", alias.path);
  assert.equal(dirname(root), alias.canonicalParent);
  assert.equal(dirname(await realpath(root)), alias.canonicalParent);
  assert.match(root, /owned-fixture-[A-Za-z0-9]{6}$/u);
  await writeFile(join(root, "safe.txt"), "safe\n");
  await assert.doesNotReject(scanPublicDirectory(root));
  const boundary = await createOwnedBoundary(root);
  assert.equal(boundary.root, boundary.canonicalRoot);
});

test("canonical temp helper rejects invalid prefixes and non-directory parents", async (t) => {
  const parent = await temporaryDirectory(t, "canonical-contract-parent-");
  const notDirectory = join(parent, "not-a-directory.txt");
  await writeFile(notDirectory, "safe\n");
  for (const prefix of [
    "missing-suffix",
    `${"a".repeat(81)}-`,
    "nested/prefix-",
    "nested\\prefix-",
  ]) {
    await assert.rejects(
      createCanonicalTemporaryDirectory({ parent, prefix }),
      { code: "CANONICAL_TEMP_PREFIX_INVALID" },
    );
  }
  await assert.rejects(
    createCanonicalTemporaryDirectory({ parent: notDirectory, prefix: "valid-prefix-" }),
    { code: "CANONICAL_TEMP_PARENT_INVALID" },
  );
  let unexpectedNullRoot;
  t.after(async () => {
    if (unexpectedNullRoot !== undefined) {
      await rm(unexpectedNullRoot, { recursive: true, force: true });
    }
  });
  await assert.rejects(
    async () => {
      unexpectedNullRoot = await createCanonicalTemporaryDirectory({
        parent: null,
        prefix: "null-parent-invalid-",
      });
    },
    { code: "CANONICAL_TEMP_PARENT_INVALID" },
  );
  const defaultRoot = await createCanonicalTemporaryDirectory({
    prefix: "undefined-parent-default-",
  });
  t.after(async () => rm(defaultRoot, { recursive: true, force: true }));
  assert.equal(dirname(defaultRoot), await realpath(tmpdir()));
});

function fragments(...parts) {
  return parts.join("");
}

function systemError(code) {
  return Object.assign(new Error("redacted system error"), { code });
}

function captureThrown(operation) {
  try { operation(); }
  catch (error) { return error; }
  assert.fail("operation did not throw");
}

function syntheticHistoryOptions(root, overrides = {}) {
  return { root, frozenReleaseTags: new Map(), ...overrides };
}

async function temporaryDirectory(t, prefix, parent) {
  const root = await createCanonicalTemporaryDirectory({ parent, prefix });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function temporaryDirectoryAlias(t, prefix) {
  const base = await createCanonicalTemporaryDirectory({ prefix });
  const canonicalParent = join(base, "canonical");
  const path = join(base, "alias");
  await mkdir(canonicalParent);
  try {
    await symlink(canonicalParent, path, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) {
      t.skip(`directory aliases are unavailable (${error.code})`);
      return undefined;
    }
    throw error;
  }
  t.after(async () => rm(base, { recursive: true, force: true }));
  return { canonicalParent: await realpath(canonicalParent), path };
}

async function temporaryGitRepository(t, prefix) {
  const root = await temporaryDirectory(t, prefix);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Gpt_Codex_HWP contributors"]);
  git(root, ["config", "user.email", OWNER_EMAIL]);
  return root;
}

async function commitFile(root, name, contents, message, email, userName = "Gpt_Codex_HWP contributors") {
  await mkdir(join(root, name, ".."), { recursive: true });
  await writeFile(join(root, name), contents);
  git(root, ["add", "--", name]);
  git(root, ["-c", `user.name=${userName}`, "-c", `user.email=${email}`, "commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args[0]} failed`);
  return result.stdout;
}

function gitInput(root, args, input) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", input });
  assert.equal(result.status, 0, `git ${args[0]} failed`);
  return result.stdout;
}

function treeWithEntryAtPath(root, path, mode, type, objectId) {
  const parts = path.split("/");
  let tree = gitInput(
    root,
    ["mktree"],
    `${mode} ${type} ${objectId}\t${parts.pop()}\n`,
  ).trim();
  while (parts.length > 0) {
    tree = gitInput(
      root,
      ["mktree"],
      `040000 tree ${tree}\t${parts.pop()}\n`,
    ).trim();
  }
  return tree;
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function cleanPublicSupervisorTranscript() {
  return Object.freeze({
    stdinFailed: false,
    stderrBytes: 0,
    stdoutEnded: true,
    stdoutFailed: false,
    protocolFailed: false,
    queuedFrames: 0,
    partialBytes: 0,
  });
}

function trackedPublicProcessOwner() {
  const child = new EventEmitter();
  const streams = [new PassThrough(), new PassThrough(), new PassThrough()];
  const destroyCalls = [0, 0, 0];
  for (const [index, stream] of streams.entries()) {
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (...args) => {
      destroyCalls[index] += 1;
      return destroy(...args);
    };
  }
  [child.stdin, child.stdout, child.stderr] = streams;
  child.stdio = streams;
  child.exitCode = null;
  child.signalCode = null;
  let unrefCalls = 0;
  child.unref = () => { unrefCalls += 1; };
  child.kill = () => true;
  return Object.freeze({
    child,
    destroyCalls,
    unrefCalls: () => unrefCalls,
  });
}
