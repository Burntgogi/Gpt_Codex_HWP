import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PUBLIC_BINARY_ALLOWLIST,
  assertPublicContentBuffer,
  formatPublicFindings,
  scanPublicDirectory,
} from "../scripts/public-content-policy.mjs";
import { scanPublicHistory } from "../scripts/scan-public-history.mjs";
import { REQUIRED_RELEASE_STAGES } from "../scripts/release-verify.mjs";

const OWNER_EMAIL = fragments("224273819+Burntgogi", "@users.noreply.github.com");

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
    "OPENAI_API_KEY=${OPENAI_API_KEY}\n",
    "apiKey=<your-key>\n",
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

test("public content policy enforces exact binary, file, aggregate, link, and entry contracts", async (t) => {
  assert.ok(PUBLIC_BINARY_ALLOWLIST.some((record) =>
    record.size === 8704 && record.sha256 === "61538931d2e2cf38f35050618ce7698960823938884d0d8977812c94587e85fd"));
  assert.ok(PUBLIC_BINARY_ALLOWLIST.every((record) =>
    Number.isSafeInteger(record.size) && /^[a-f0-9]{64}$/u.test(record.sha256)));

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

  const result = await scanPublicHistory({ root });
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

test("Git history privacy allows only the approved owner and exact neutral immutable objects", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-identity-");
  const ownerCommit = await commitFile(root, "owner.txt", "safe\n", "owner", OWNER_EMAIL);
  let result = await scanPublicHistory({ root });
  assert.equal(result.findings.length, 0);

  const neutralEmail = fragments("codex", "@local");
  const neutralCommit = await commitFile(root, "neutral.txt", "safe\n", "neutral", neutralEmail);
  result = await scanPublicHistory({ root });
  assert.ok(result.findings.some((finding) => finding.category === "personal identity"));

  result = await scanPublicHistory({
    root,
    neutralObjectAllowlist: new Set([neutralCommit]),
  });
  assert.equal(result.findings.length, 0);

  git(root, ["-c", `user.email=${neutralEmail}`, "tag", "-a", "neutral-tag", "-m", "safe tag"]);
  const tagObject = git(root, ["rev-parse", "refs/tags/neutral-tag"]).trim();
  result = await scanPublicHistory({
    root,
    neutralObjectAllowlist: new Set([neutralCommit]),
  });
  assert.ok(result.findings.some((finding) => finding.objectId === tagObject));
  result = await scanPublicHistory({
    root,
    neutralObjectAllowlist: new Set([neutralCommit, tagObject]),
  });
  assert.equal(result.findings.length, 0);
  assert.match(ownerCommit, /^[a-f0-9]{40}$/u);
});

test("Git history privacy fails closed for shallow and malformed Git operations", async (t) => {
  const source = await temporaryGitRepository(t, "public-history-source-");
  await commitFile(source, "safe.txt", "safe\n", "safe", OWNER_EMAIL);
  const clone = await temporaryDirectory(t, "public-history-shallow-");
  await rm(clone, { recursive: true, force: true });
  git(process.cwd(), ["clone", "-q", "--depth=1", `file:///${source.replaceAll("\\", "/")}`, clone]);
  await assert.rejects(scanPublicHistory({ root: clone }), /history scan failed/iu);
  await assert.rejects(
    scanPublicHistory({ root: source, runGit: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) }),
    /history scan failed/iu,
  );
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

function fragments(...parts) {
  return parts.join("");
}

function captureThrown(operation) {
  try { operation(); }
  catch (error) { return error; }
  assert.fail("operation did not throw");
}

async function temporaryDirectory(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function temporaryGitRepository(t, prefix) {
  const root = await temporaryDirectory(t, prefix);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Gpt_Codex_HWP contributors"]);
  git(root, ["config", "user.email", OWNER_EMAIL]);
  return root;
}

async function commitFile(root, name, contents, message, email) {
  await mkdir(join(root, name, ".."), { recursive: true });
  await writeFile(join(root, name), contents);
  git(root, ["add", "--", name]);
  git(root, ["-c", `user.email=${email}`, "commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args[0]} failed`);
  return result.stdout;
}
