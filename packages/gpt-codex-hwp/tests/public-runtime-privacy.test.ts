import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPublicRuntimePrivacy,
  classifyRuntimeEntryForTest,
} from "../release-scripts/public-runtime-privacy.mjs";
import { buildRuntime } from "../../../scripts/project-runtime.mjs";
import { createCanonicalTemporaryDirectory } from "../../../scripts/canonical-temp.mjs";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = dirname(TEST_ROOT);
const REPOSITORY_ROOT = dirname(dirname(SOURCE_ROOT));

test("runtime projection rejects staged sensitive content before promotion", async (t) => {
  const temporaryRoot = await temporaryRuntime(t, "privacy-projection-integration-");
  const fixtureRoot = join(temporaryRoot, "fixture");
  const fixtureSource = join(fixtureRoot, "packages", "gpt-codex-hwp");
  const outputRoot = join(temporaryRoot, "runtime");
  const swapId = `privacy-probe-${randomUUID()}`;
  await createProjectionFixture(fixtureRoot, fixtureSource);
  await writeFile(
    join(fixtureSource, "assets", "privacy-probe.txt"),
    credentialAssignment(["OPENAI", "API", "KEY"], ["sk", "projection", "probe"]),
  );
  await assert.rejects(
    buildRuntime({ root: fixtureRoot, outputRoot, swapId }),
    /runtime privacy violation.*literal credential/iu,
  );
  await assert.rejects(lstat(outputRoot), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(temporaryRoot)).filter((name) => name.startsWith(".runtime.")),
    [],
    "failed validation must not leave a staged or backup projection",
  );
});

test("public runtime privacy rejects personal paths and secrets before projection", async (t) => {
  const cases = [
    ["POSIX personal path", fragments("export const value = \"", "/Us", "ers/pri", "vate/workspace", "\";\n")],
    ["Windows personal path", fragments("export const value = \"", "C:", "\\", "Users", "\\private\\workspace", "\";\n")],
    ["private key", privateKeyHeader("OPENSSH")],
    ["literal credential", credentialAssignment(["OPENAI", "API", "KEY"], ["sk", "test", "only"])],
  ] as const;

  for (const [label, contents] of cases) {
    await t.test(label, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-rejection-");
      await writeFile(join(root, "runtime.js"), contents);
      await assert.rejects(
        assertPublicRuntimePrivacy(root),
        /runtime privacy|personal home path|private key|literal credential/iu,
      );
    });
  }
});

test("public runtime privacy reuses provider and Unicode-aware public policy", async (t) => {
  for (const [label, contents] of [
    ["provider token", fragments("sk", "-proj-", "a".repeat(48))],
    ["Unicode assignment", fragments("ＡＷＳ＿ＳＥＣＲＥＴ＿ＡＣＣＥＳＳ＿ＫＥＹ＝", "x".repeat(40))],
  ] as const) {
    await t.test(label, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-shared-policy-");
      await writeFile(join(root, "runtime.txt"), contents);
      await assert.rejects(assertPublicRuntimePrivacy(root), /runtime privacy violation/iu);
    });
  }
});

test("public runtime privacy accepts a redacted credential placeholder", async (t) => {
  const root = await temporaryRuntime(t, "privacy-placeholder-");
  const contents = fragments(
    "// ",
    ["OPENAI", "API", "KEY"].join("_"),
    "=<",
    "your-key",
    ">\nexport const ok = true;\n",
  );
  await writeFile(join(root, "runtime.js"), contents);
  await assert.doesNotReject(assertPublicRuntimePrivacy(root));
});

test("public runtime privacy permits only the typed MCP progress token field", async (t) => {
  const acceptedRoot = await temporaryRuntime(t, "privacy-mcp-progress-");
  await writeFile(
    join(acceptedRoot, "runtime.js"),
    [
      fragments("const progressId = request.params._meta.progress", "Token;"),
      "await sendNotification({",
      "  method: \"notifications/progress\",",
      fragments("  params: { progress", "Token", ": progressId, progress: 1, total: 2, message: \"Processing document.\" },"),
      "});",
    ].join("\n"),
  );
  await assert.doesNotReject(assertPublicRuntimePrivacy(acceptedRoot));

  for (const [name, contents] of [
    [
      "literal protocol credential",
      fragments("sendNotification({ method: \"notifications/progress\", params: { progress", "Token", ": \"literal-token\", progress: 1 } });"),
    ],
    [
      "out-of-context token field",
      fragments("const progressId = request.params.id; const value = { progress", "Token", ": progressId };"),
    ],
    [
      "other credential field in protocol object",
      fragments("sendNotification({ method: \"notifications/progress\", params: { github", "Token", ": \"literal-token\", progress: 1 } });"),
    ],
  ] as const) {
    await t.test(name, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-mcp-progress-reject-");
      await writeFile(join(root, "runtime.js"), contents);
      await assert.rejects(
        assertPublicRuntimePrivacy(root),
        /literal credential.*runtime\.js/iu,
      );
    });
  }
});

test("public runtime privacy scanner covers key, credential, and home-path variants", async (t) => {
  const rejected = [
    ["encrypted key", privateKeyHeader("ENCRYPTED")],
    ["PGP block", fragments("-----BEGIN ", "PGP ", "PRIVATE KEY BLOCK-----\n")],
    ["SSH2 conventional", fragments("---- BEGIN ", "SSH2 ", "ENCRYPTED PRIVATE KEY ----\n")],
    ["snake credential", credentialAssignment(["OPENAI", "API", "KEY"], ["sk", "review", "secret"])],
    ["kebab credential", fragments("openai", "-api", "-key=", ["sk", "review", "secret"].join("-"), "\n")],
    ["camel API key", fragments("openai", "Api", "Key=", ["sk", "review", "secret"].join("-"), "\n")],
    ["camel private key", fragments("private", "Key=", "literal-private-material", "\n")],
    ["prefixed token", fragments("github", "Token", "=", "literal-token", "\n")],
    ["prefixed secret", fragments("client", "Secret", "=", "literal-secret", "\n")],
    ["cloud secret access key", credentialAssignment(["AWS", "SECRET", "ACCESS", "KEY"], ["fake", "validation", "secret"])],
    ["prefixed password", fragments("database", "Password", "=", "literal-password", "\n")],
    ["lowercase Windows", fragments("c:", "\\", "users", "\\private\\workspace")],
    ["repeated Windows separators", fragments("C:", "\\\\", "USERS", "\\\\private\\\\workspace")],
    ["lowercase macOS", fragments("path=\"", "/us", "ers/private/workspace", "\"\n")],
    ["repeated POSIX separators", fragments("open(", "/Us", "ers//private//workspace", ")\n")],
  ] as const;

  for (const [label, contents] of rejected) {
    await t.test(label, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-pattern-");
      const nested = join(root, "nested");
      await mkdir(nested);
      await writeFile(join(nested, "runtime.js"), contents);
      await assert.rejects(assertPublicRuntimePrivacy(root), (error: unknown) => {
        assert.match(String(error), /runtime privacy violation/iu);
        assert.match(String(error), /nested\/runtime\.js/u);
        assert.equal(String(error).includes(contents.trim()), false, "diagnostic must not echo sensitive content");
        return true;
      });
    });
  }

  const accepted = [
    ["prose", "Never paste your API key or private key in documentation.\n"],
    ["braced env", fragments("openai", "Api", "Key = \"${", "OPENAI_API_KEY", "}\"\n")],
    ["quoted JSON env", fragments("\"api", "-key\": \"${", "OPENAI_API_KEY", "}\"\n")],
    ["named env brace", fragments("private", "Key={env:", "PRIVATE_KEY", "}\n")],
    ["POSIX placeholder", fragments("/us", "ers/<your-user>/workspace\n")],
    ["Windows placeholder", fragments("C:", "\\", "USERS", "\\username\\workspace")],
  ] as const;
  for (const [label, contents] of accepted) {
    await t.test(`allows ${label}`, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-allowed-");
      await writeFile(join(root, "runtime.js"), contents);
      await assert.doesNotReject(assertPublicRuntimePrivacy(root));
    });
  }
});

test("public runtime privacy scanner enforces exact budgets and staged file types", async (t) => {
  await t.test("file boundary and plus one", async (subtest) => {
    const root = await temporaryRuntime(subtest, "privacy-file-limit-");
    const path = join(root, "nested", "runtime.txt");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "1234");
    await assert.doesNotReject(assertPublicRuntimePrivacy(root, { maxFileBytes: 4, maxRuntimeBytes: 8 }));
    await writeFile(path, "12345");
    await assert.rejects(
      assertPublicRuntimePrivacy(root, { maxFileBytes: 4, maxRuntimeBytes: 8 }),
      /file byte budget.*nested\/runtime\.txt/iu,
    );
  });

  await t.test("aggregate boundary and plus one", async (subtest) => {
    const root = await temporaryRuntime(subtest, "privacy-runtime-limit-");
    await writeFile(join(root, "one.txt"), "1234");
    await writeFile(join(root, "two.txt"), "5678");
    await assert.doesNotReject(assertPublicRuntimePrivacy(root, { maxFileBytes: 8, maxRuntimeBytes: 8 }));
    await writeFile(join(root, "three.txt"), "9");
    await assert.rejects(
      assertPublicRuntimePrivacy(root, { maxFileBytes: 8, maxRuntimeBytes: 8 }),
      /aggregate byte budget.*(?:one|two|three)\.txt/iu,
    );
  });

  await t.test("only exact allowlisted binary is accepted and map is rejected", async (subtest) => {
    const root = await temporaryRuntime(subtest, "privacy-extension-");
    await writeFile(join(root, "asset.png"), Buffer.from([0, 255, 1]));
    await assert.rejects(assertPublicRuntimePrivacy(root), /binary not allowlisted/iu);
    await rm(join(root, "asset.png"));
    await mkdir(join(root, "assets"));
    await copyFile(
      join(SOURCE_ROOT, "assets", "gpt-codex-hwp-icon-64.png"),
      join(root, "assets", "gpt-codex-hwp-icon-64.png"),
    );
    await assert.doesNotReject(assertPublicRuntimePrivacy(root));
    await writeFile(join(root, "unknown.blobx"), "safe");
    await assert.rejects(assertPublicRuntimePrivacy(root), /unsupported staged extension.*unknown\.blobx/iu);
    await rm(join(root, "unknown.blobx"));
    await writeFile(join(root, "runtime.js.map"), "{}");
    await assert.rejects(assertPublicRuntimePrivacy(root), /source map.*runtime\.js\.map/iu);
  });

  await t.test("package-local npm policy is scanned and literal registry credentials are rejected", async (subtest) => {
    const root = await temporaryRuntime(subtest, "privacy-npmrc-");
    const npmrc = join(root, ".npmrc");
    await writeFile(
      npmrc,
      "engine-strict=true\nsave-exact=true\npackage-lock=true\nfund=false\nignore-scripts=true\naudit=false\n",
    );
    await assert.doesNotReject(assertPublicRuntimePrivacy(root));
    await writeFile(npmrc, "//registry.npmjs.org/:_authToken=literal-secret\n");
    await assert.rejects(assertPublicRuntimePrivacy(root), /literal credential.*\.npmrc/iu);
  });

  await t.test("only the fixed supervisor PowerShell path is accepted", async (subtest) => {
    const root = await temporaryRuntime(subtest, "privacy-powershell-path-");
    await mkdir(join(root, "dist", "workers"), { recursive: true });
    await writeFile(
      join(root, "dist", "workers", "windows-job-supervisor.ps1"),
      "param([int]$TargetPid)\n",
    );
    await assert.doesNotReject(assertPublicRuntimePrivacy(root));
    await writeFile(join(root, "unexpected.ps1"), "Write-Output safe\n");
    await assert.rejects(
      assertPublicRuntimePrivacy(root),
      /unsupported staged extension.*unexpected\.ps1/iu,
    );
  });

  await t.test("only the pinned Windows interop assembly is accepted", async (subtest) => {
    const root = await temporaryRuntime(subtest, "privacy-windows-interop-");
    const workers = join(root, "dist", "workers");
    await mkdir(workers, { recursive: true });
    await copyFile(
      join(SOURCE_ROOT, "src", "workers", "gpt-codex-hwp-job.dll"),
      join(workers, "gpt-codex-hwp-job.dll"),
    );
    await assert.doesNotReject(assertPublicRuntimePrivacy(root));
    await writeFile(join(workers, "unexpected.dll"), Buffer.from([0, 1, 2, 3]));
    await assert.rejects(
      assertPublicRuntimePrivacy(root),
      /binary not allowlisted.*unexpected\.dll/iu,
    );
  });

  await t.test("nested symlink reports from the original runtime root", async (subtest) => {
    const root = await temporaryRuntime(subtest, "privacy-symlink-");
    await mkdir(join(root, "deep", "nested"), { recursive: true });
    await writeFile(join(root, "target.js"), "export {};\n");
    try {
      await symlink(join(root, "target.js"), join(root, "deep", "nested", "link.js"));
    } catch (error: unknown) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        subtest.skip("Windows symlink privilege is unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(assertPublicRuntimePrivacy(root), /symbolic link.*deep\/nested\/link\.js/iu);
  });

  await t.test("non-regular entries classify fail closed", () => {
    assert.equal(classifyRuntimeEntryForTest({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => false,
    }), "non-regular");
  });
});

test("public runtime privacy scanner rejects literal environment assignments", async (t) => {
  const environmentName = ["OPENAI", "API", "KEY"].join("_");
  const rejected = [
    ["Node environment object", fragments("process.env.", environmentName, " = \"", ["sk", "node", "literal"].join("-"), "\";\n")],
    ["Node bracket environment double quote", fragments("process.env[\"", environmentName, "\"] = \"", ["sk", "node", "bracket"].join("-"), "\";\n")],
    ["Node bracket environment single quote", fragments("process.env['", "TOKEN", "'] = '", "literal-node-token", "';\n")],
    ["Python environment object", fragments("os.environ[\"", environmentName, "\"] = \"", ["sk", "python", "literal"].join("-"), "\"\n")],
    ["PowerShell environment object", fragments("$env:", environmentName, " = \"", ["sk", "powershell", "literal"].join("-"), "\"\n")],
  ] as const;
  for (const [label, contents] of rejected) {
    await t.test(label, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-env-assignment-");
      await writeFile(join(root, "runtime.txt"), contents);
      await assert.rejects(assertPublicRuntimePrivacy(root), (error: unknown) => {
        assert.match(String(error), /literal credential.*runtime\.txt/iu);
        assert.equal(String(error).includes(contents.trim()), false, "diagnostic must not echo the assignment");
        return true;
      });
    });
  }

  const references = [
    fragments("apiKey = process.env.", environmentName, "\n"),
    fragments("apiKey = \"${", environmentName, "}\"\n"),
    fragments("apiKey = {env:", environmentName, "}\n"),
    fragments("process.env[\"", environmentName, "\"] = process.env.", "SOURCE_API_KEY", ";\n"),
    fragments("process.env['", "TOKEN", "'] = '${", "SOURCE_TOKEN", "}';\n"),
  ];
  for (const [index, contents] of references.entries()) {
    await t.test(`allows environment value reference ${index + 1}`, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-env-reference-");
      await writeFile(join(root, "runtime.txt"), contents);
      await assert.doesNotReject(assertPublicRuntimePrivacy(root));
    });
  }
});

test("public runtime privacy scanner distinguishes URLs from filesystem paths", async (t) => {
  const acceptedUrls = [
    fragments("https://host", "/us", "ers/private/workspace\n"),
    fragments("https://host", "/ho", "me/private/workspace\n"),
  ];
  for (const [index, contents] of acceptedUrls.entries()) {
    await t.test(`allows URL route ${index + 1}`, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-url-");
      await writeFile(join(root, "runtime.txt"), contents);
      await assert.doesNotReject(assertPublicRuntimePrivacy(root));
    });
  }

  const rejectedPaths = [
    fragments("const path = \"", "/Us", "ers/private/workspace", "\";\n"),
    fragments("path=", "/ho", "me/private/workspace\n"),
    fragments("open(", "/Us", "ers//private//workspace", ")\n"),
    fragments("root: '", "/HO", "ME/private/workspace", "'\n"),
    fragments("/ho", "me/private/application-route\n"),
    fragments("/us", "ers/private/application-route\n"),
  ];
  for (const [index, contents] of rejectedPaths.entries()) {
    await t.test(`rejects filesystem path ${index + 1}`, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-filesystem-");
      await writeFile(join(root, "runtime.txt"), contents);
      await assert.rejects(assertPublicRuntimePrivacy(root), /personal home path.*runtime\.txt/iu);
    });
  }
});

test("public runtime privacy scanner classifies POSIX candidates by context", async (t) => {
  const rejected = [
    ["stack trace", fragments("    at ", "/Us", "ers/alice/project/runtime.js:10:2\n")],
    ["prose workspace", fragments("workspace ", "/ho", "me/alice/project\n")],
    ["Markdown backticks", fragments("Use `", "/Us", "ers/alice/project`, for the checkout.\n")],
    ["quoted assignment", fragments("const workspace = \"", "/ho", "me/alice/project", "\";\n")],
    ["ambiguous bare users", fragments("/Us", "ers/alice/project\n")],
    ["ambiguous bare home", fragments("/ho", "me/alice/project\n")],
  ] as const;
  for (const [label, contents] of rejected) {
    await t.test(`rejects ${label}`, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-posix-candidate-");
      await writeFile(join(root, "runtime.txt"), contents);
      await assert.rejects(assertPublicRuntimePrivacy(root), /personal home path.*runtime\.txt/iu);
    });
  }

  const accepted = [
    ["HTTPS users", fragments("https://host", "/us", "ers/alice/profile\n")],
    ["HTTP home", fragments("http://host", "/ho", "me/alice/profile\n")],
    ["app route", fragments("app.get(\"", "/us", "ers/alice/profile", "\", handler);\n")],
    ["router route", fragments("router.post('", "/ho", "me/alice/profile", "', handler);\n")],
    ["server route", fragments("server.use(\"", "/Us", "ers/alice/profile", "\", middleware);\n")],
  ] as const;
  for (const [label, contents] of accepted) {
    await t.test(`allows ${label}`, async (subtest) => {
      const root = await temporaryRuntime(subtest, "privacy-route-candidate-");
      await writeFile(join(root, "runtime.txt"), contents);
      await assert.doesNotReject(assertPublicRuntimePrivacy(root));
    });
  }
});

test("public runtime privacy scanner bounds limit override maxima", async (t) => {
  const root = await temporaryRuntime(t, "privacy-limit-overrides-");
  await writeFile(join(root, "runtime.txt"), "safe\n");
  const maxFileBytes = 16 * 1024 * 1024;
  const maxRuntimeBytes = 64 * 1024 * 1024;
  await assert.doesNotReject(assertPublicRuntimePrivacy(root, { maxFileBytes, maxRuntimeBytes }));
  await assert.rejects(
    assertPublicRuntimePrivacy(root, { maxFileBytes: maxFileBytes + 1, maxRuntimeBytes }),
    /file byte budget/iu,
  );
  await assert.rejects(
    assertPublicRuntimePrivacy(root, { maxFileBytes, maxRuntimeBytes: maxRuntimeBytes + 1 }),
    /aggregate byte budget/iu,
  );
});

test("public runtime privacy counts directories and files with streaming entry bounds", async (t) => {
  const root = await temporaryRuntime(t, "privacy-entry-bound-");
  await mkdir(join(root, "one", "two"), { recursive: true });
  await writeFile(join(root, "one", "two", "safe.txt"), "safe\n");
  await assert.rejects(
    assertPublicRuntimePrivacy(root, { maxEntries: 2 }),
    /aggregate entry budget/iu,
  );
  await assert.doesNotReject(assertPublicRuntimePrivacy(root, { maxEntries: 3 }));
});

test("public runtime privacy rejects a junction root before target content is read", async (t) => {
  const parent = await temporaryRuntime(t, "privacy-junction-boundary-");
  const outside = join(parent, "outside");
  const linked = join(parent, "linked");
  await mkdir(outside);
  await writeFile(join(outside, "unsafe.txt"), fragments("gh", "p_", "R".repeat(36)));
  try {
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return;
    throw error;
  }
  await assert.rejects(assertPublicRuntimePrivacy(linked), /runtime privacy violation/iu);
});

test("runtime privacy fixtures canonicalize an injected aliased temp parent", async (t) => {
  const alias = await temporaryDirectoryAlias(t, "runtime-canonical-parent-");
  if (alias === undefined) return;
  const root = await temporaryRuntime(t, "owned-fixture-", alias.path);
  assert.equal(dirname(root), alias.canonicalParent);
  await writeFile(join(root, "safe.txt"), "safe\n");
  await assert.doesNotReject(assertPublicRuntimePrivacy(root));
});

test("split release-suite sources contain no assembled privacy probe", async (t) => {
  const root = await temporaryRuntime(t, "privacy-split-source-");
  for (const name of [
    "kordoc-core-runtime.test.ts",
    "runtime-projection.test.ts",
    "public-runtime-privacy.test.ts",
    "release-metadata.test.ts",
    "release-test-migration.json",
  ]) {
    await copyFile(join(TEST_ROOT, name), join(root, name));
  }
  await assert.doesNotReject(assertPublicRuntimePrivacy(root));
});

function fragments(...parts: string[]): string {
  return parts.join("");
}

function privateKeyHeader(kind: string): string {
  return fragments("-----BEGIN ", kind, " PRIVATE KEY-----\n");
}

function credentialAssignment(keyParts: string[], valueParts: string[]): string {
  return fragments(keyParts.join("_"), "=", valueParts.join("-"), "\n");
}

async function temporaryRuntime(t: TestContext, prefix: string, parent?: string): Promise<string> {
  const root = await createCanonicalTemporaryDirectory({ parent, prefix });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function temporaryDirectoryAlias(
  t: TestContext,
  prefix: string,
): Promise<{ canonicalParent: string; path: string } | undefined> {
  const base = await createCanonicalTemporaryDirectory({ prefix });
  const canonicalParent = join(base, "canonical");
  const path = join(base, "alias");
  await mkdir(canonicalParent);
  try {
    await symlink(canonicalParent, path, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code)) {
      t.skip(`directory aliases are unavailable (${(error as NodeJS.ErrnoException).code})`);
      return undefined;
    }
    throw error;
  }
  t.after(async () => rm(base, { recursive: true, force: true }));
  return { canonicalParent: await realpath(canonicalParent), path };
}

async function createProjectionFixture(fixtureRoot: string, fixtureSource: string): Promise<void> {
  await mkdir(fixtureSource, { recursive: true });
  for (const name of [
    "LICENSE",
    "NOTICE",
    "README.en.md",
    "README.md",
    "RELEASE_NOTES.en.md",
    "RELEASE_NOTES.md",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
  ]) await copyFile(join(REPOSITORY_ROOT, name), join(fixtureRoot, name));
  await mkdir(join(fixtureRoot, "scripts"));
  for (const name of ["kordoc-runtime-verifier.mjs"]) {
    await copyFile(
      join(REPOSITORY_ROOT, "scripts", name),
      join(fixtureRoot, "scripts", name),
    );
  }

  for (const name of [
    ".npmrc",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]) {
    await copyFile(join(SOURCE_ROOT, name), join(fixtureSource, name));
  }
  for (const name of ["assets", "src", "scripts", "skills", "vendor"]) {
    await cp(join(SOURCE_ROOT, name), join(fixtureSource, name), { recursive: true });
  }

  const dependencySource = join(SOURCE_ROOT, "node_modules");
  const dependencyTarget = join(fixtureSource, "node_modules");
  try {
    await symlink(dependencySource, dependencyTarget, process.platform === "win32" ? "junction" : "dir");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(code)) throw error;
    await cp(dependencySource, dependencyTarget, { recursive: true, dereference: true });
  }
}
