import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  PUBLIC_BINARY_ALLOWLIST,
  assertPublicContentBuffer,
  createOwnedBoundary,
  formatPublicFindings,
  readOwnedRegularFile,
  runBoundedProcess,
  scanPublicDirectory,
  terminatePosixProcessGroup,
  walkOwnedRegularFiles,
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

test("Git history binds binary approval to every reachable tree path", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-binary-path-");
  const banner = await readFile(new URL("../assets/gpt-codex-hwp-banner.png", import.meta.url));
  await commitFile(root, "assets/gpt-codex-hwp-banner.png", banner, "approved path", OWNER_EMAIL);
  await mkdir(join(root, "copied"));
  await writeFile(join(root, "copied", "gpt-codex-hwp-banner.png"), banner);
  git(root, ["add", "copied/gpt-codex-hwp-banner.png"]);
  git(root, ["commit", "-qm", "same blob at unapproved path"]);
  const result = await scanPublicHistory({ root });
  assert.ok(result.findings.some((finding) =>
    finding.category === "binary not allowlisted"
    && finding.label === "copied/gpt-codex-hwp-banner.png"));
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

  const result = await scanPublicHistory({ root });
  assert.ok(result.findings.some((finding) => finding.category === "personal identity"));
  assert.ok(result.findings.some((finding) => finding.objectId === craftedId
    && finding.category === "sensitive Git metadata"));
  assert.ok(result.findings.some((finding) => finding.category === "sensitive ref name"));
});

test("Git history privacy allows only the approved owner and exact neutral immutable objects", async (t) => {
  const root = await temporaryGitRepository(t, "public-history-identity-");
  const ownerCommit = await commitFile(root, "owner.txt", "safe\n", "owner", OWNER_EMAIL);
  let result = await scanPublicHistory({ root });
  assert.equal(result.findings.length, 0);

  const neutralEmail = fragments("codex", "@local");
  const neutralCommit = await commitFile(root, "neutral.txt", "safe\n", "neutral", neutralEmail, "Codex");
  result = await scanPublicHistory({ root });
  assert.ok(result.findings.some((finding) => finding.category === "personal identity"));

  result = await scanPublicHistory({
    root,
    neutralObjectAllowlist: new Set([neutralCommit]),
  });
  assert.equal(result.findings.length, 0);

  git(root, ["-c", "user.name=Codex", "-c", `user.email=${neutralEmail}`, "tag", "-a", "neutral-tag", "-m", "safe tag"]);
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

test("bounded process keeps fast target bytes separate from control frames", async () => {
  const result = await runBoundedProcess(process.execPath, [
    "-e",
    "process.stdout.write(Buffer.from([0,255,65]));process.stderr.write(Buffer.from([66,0,254]));",
  ], { timeoutMs: 5_000, maxOutputBytes: 64 });
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, Buffer.from([0, 255, 65]));
  assert.deepEqual(result.stderr, Buffer.from([66, 0, 254]));
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

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}
