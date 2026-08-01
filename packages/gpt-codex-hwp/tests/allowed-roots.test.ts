import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import test, { after, afterEach, before } from "node:test";
import { promisify } from "node:util";

import { prepareRestartSafeRuntime } from "../../../scripts/installed-runtime-smoke.mjs";
import {
  AllowedRootsConfigurationError,
  AllowedRootsPathError,
  createAllowedRootsPolicy,
  resetActiveAllowedRootsPolicy,
  setActiveAllowedRootsPolicy,
} from "../src/shared/allowed-roots.js";
import { openDocumentSnapshot } from "../src/shared/document-snapshot.js";
import { readFileBounded } from "../src/shared/files.js";
import { writeFilesExclusively } from "../src/shared/output.js";
import {
  configureAllowedRootsForMcp,
  createMcpServer,
} from "../src/mcp-main.js";
import {
  handleHwpCreateSvgAsset,
  handleHwpInsertImage,
} from "../src/tools/assets.js";
import { handleHwpDetectFormat } from "../src/tools/detect.js";
import {
  handleHwpFillForm,
  handleHwpPatchDocument,
} from "../src/tools/patch.js";
import { handleHwpRenderPreview } from "../src/tools/preview.js";
import { handleHwpRead } from "../src/tools/read.js";
import {
  handleHwpGenerateHwpx,
  handleHwpValidate,
} from "../src/tools/write.js";

let sandbox = "";
let allowedRoot = "";
let siblingRoot = "";
let allowedFile = "";
let siblingFile = "";
const execFileAsync = promisify(execFile);

before(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "gpt-codex-hwp-allowed-roots-")));
  allowedRoot = join(sandbox, "documents");
  siblingRoot = join(sandbox, "documents-private");
  await Promise.all([
    mkdir(join(allowedRoot, "nested"), { recursive: true }),
    mkdir(siblingRoot, { recursive: true }),
  ]);
  allowedFile = join(allowedRoot, "nested", "input.hwpx");
  siblingFile = join(siblingRoot, "secret.hwpx");
  await Promise.all([
    writeFile(allowedFile, Uint8Array.from([0x50, 0x4b, 0x03, 0x04])),
    writeFile(siblingFile, "outside"),
  ]);
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

afterEach(() => {
  resetActiveAllowedRootsPolicy();
});

test("allowed roots: absent configuration preserves unrestricted local paths", async () => {
  const policy = await createAllowedRootsPolicy(undefined);
  assert.equal(policy.configured, false);
  assert.equal(
    await policy.authorizeExistingPath(siblingFile),
    await realpath(siblingFile),
  );
  assert.equal(
    await policy.authorizeFuturePath(join(siblingRoot, "new", "output.hwpx")),
    resolve(siblingRoot, "new", "output.hwpx"),
  );
});

test("allowed roots: malformed, empty, relative, duplicate, and oversized configuration fails closed without values", async () => {
  const privateValue = join(sandbox, "private-value-that-must-not-leak");
  const cases = [
    "[",
    "[]",
    "{}",
    JSON.stringify(["relative/path"]),
    JSON.stringify([allowedRoot, allowedRoot]),
    JSON.stringify([privateValue]),
    " ".repeat(16_385),
  ];

  for (const config of cases) {
    await assert.rejects(
      createAllowedRootsPolicy(config),
      (error: unknown) => {
        assert.ok(error instanceof AllowedRootsConfigurationError);
        assert.equal(error.code, "INVALID_ALLOWED_ROOTS_CONFIGURATION");
        assert.doesNotMatch(error.message, /private-value|documents|relative/iu);
        assert.doesNotMatch(error.message, new RegExp(escapeRegExp(sandbox), "iu"));
        return true;
      },
    );
  }
});

test("allowed roots: normal descendants and missing output parents return canonical safe paths", async () => {
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  assert.equal(policy.configured, true);
  assert.equal(
    await policy.authorizeExistingPath(allowedFile),
    await realpath(allowedFile),
  );
  assert.equal(
    await policy.authorizeExistingPath(join(allowedRoot, "nested", "..", "nested", "input.hwpx")),
    await realpath(allowedFile),
  );
  assert.equal(
    await policy.authorizeFuturePath(join(allowedRoot, "future", "deep", "output.hwpx")),
    resolve(allowedRoot, "future", "deep", "output.hwpx"),
  );
});

test("allowed roots: prefix siblings, traversal, and mixed separators fail with a stable redacted error", async () => {
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  const candidates = [
    siblingFile,
    join(allowedRoot, "..", "documents-private", "secret.hwpx"),
    process.platform === "win32"
      ? siblingFile.replaceAll("\\", "/")
      : siblingFile,
  ];

  for (const candidate of candidates) {
    await assert.rejects(
      policy.authorizeExistingPath(candidate),
      (error: unknown) => assertRedactedOutsideError(error),
    );
  }
});

test("allowed roots: an existing final symlink is rejected even when it targets the allowed tree", async (t) => {
  const linkPath = join(allowedRoot, "linked-input.hwpx");
  try {
    await symlink(allowedFile, linkPath, "file");
  } catch (error: unknown) {
    t.skip(`symlink creation is unavailable: ${errorCode(error) ?? "unknown filesystem reason"}`);
    return;
  }
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  await assert.rejects(
    policy.authorizeExistingPath(linkPath),
    (error: unknown) => assertRedactedOutsideError(error),
  );
});

test("allowed roots: a configured symlink or junction root is rejected without disclosure", async (t) => {
  const linkedRoot = join(sandbox, "linked-root");
  try {
    await symlink(allowedRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error: unknown) {
    t.skip(`directory-link creation is unavailable: ${errorCode(error) ?? "unknown filesystem reason"}`);
    return;
  }
  await assert.rejects(
    createAllowedRootsPolicy(JSON.stringify([linkedRoot])),
    (error: unknown) => {
      assert.ok(error instanceof AllowedRootsConfigurationError);
      assert.doesNotMatch(error.message, /linked-root|documents/iu);
      return true;
    },
  );
});

test("allowed roots: a hard link reached through an outside path is rejected", async (t) => {
  const outsideHardLink = join(siblingRoot, "outside-hard-link.hwpx");
  try {
    await link(allowedFile, outsideHardLink);
  } catch (error: unknown) {
    t.skip(`hard-link creation is unavailable: ${errorCode(error) ?? "unknown filesystem reason"}`);
    return;
  }
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  await assert.rejects(
    policy.authorizeExistingPath(outsideHardLink),
    (error: unknown) => assertRedactedOutsideError(error),
  );
});

test("allowed roots: Unicode normalization aliases cannot escape the configured root", async () => {
  const nfcRoot = join(sandbox, "caf\u00e9");
  const nfdSibling = join(sandbox, "cafe\u0301-private");
  await Promise.all([
    mkdir(nfcRoot),
    mkdir(nfdSibling),
  ]);
  const inside = join(nfcRoot, "inside.hwpx");
  const outside = join(nfdSibling, "outside.hwpx");
  await Promise.all([writeFile(inside, "in"), writeFile(outside, "out")]);
  const policy = await createAllowedRootsPolicy(JSON.stringify([nfcRoot]));
  assert.equal(await policy.authorizeExistingPath(inside), await realpath(inside));
  await assert.rejects(
    policy.authorizeExistingPath(outside),
    (error: unknown) => assertRedactedOutsideError(error),
  );
});

test("allowed roots: platform root and case semantics follow the filesystem", async () => {
  const volumeRoot = parse(allowedRoot).root;
  const policy = await createAllowedRootsPolicy(JSON.stringify([volumeRoot]));
  assert.equal(await policy.authorizeExistingPath(allowedFile), await realpath(allowedFile));

  if (process.platform === "win32") {
    const casePolicy = await createAllowedRootsPolicy(
      JSON.stringify([allowedRoot.toUpperCase()]),
    );
    assert.equal(
      (await casePolicy.authorizeExistingPath(allowedFile)).toLocaleLowerCase("en-US"),
      (await realpath(allowedFile)).toLocaleLowerCase("en-US"),
    );
  }
});

test("allowed roots: UNC semantics are capability-skipped when no test share is available", (t) => {
  if (process.platform !== "win32") {
    t.skip("UNC paths are a Windows filesystem capability.");
    return;
  }
  t.skip("No isolated UNC test share is provisioned; inaccessible UNC parsing is covered separately.");
});

test("allowed roots: inaccessible UNC configuration fails closed without the server or share name", async (t) => {
  if (process.platform !== "win32") {
    t.skip("UNC paths are a Windows filesystem capability.");
    return;
  }
  const server = ["unavailable", "test-host"].join("-");
  const share = ["private", "share"].join("-");
  const uncPath = `\\\\${server}\\${share}`;
  await assert.rejects(
    createAllowedRootsPolicy(JSON.stringify([uncPath])),
    (error: unknown) => {
      assert.ok(error instanceof AllowedRootsConfigurationError);
      assert.doesNotMatch(error.message, new RegExp(`${server}|${share}`, "iu"));
      return true;
    },
  );
});

test("allowed roots: active policy is enforced at snapshot, bounded-read, output, and MCP result boundaries", async () => {
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  setActiveAllowedRootsPolicy(policy);

  await assert.rejects(
    openDocumentSnapshot(siblingFile),
    (error: unknown) => assertRedactedOutsideError(error),
  );
  await assert.rejects(
    readFileBounded(siblingFile, "image"),
    (error: unknown) => assertRedactedOutsideError(error),
  );

  const blockedOutput = join(siblingRoot, "blocked-output.hwpx");
  await assert.rejects(
    writeFilesExclusively([{ path: blockedOutput, data: "blocked" }]),
    (error: unknown) => assertRedactedOutsideError(error),
  );

  const result = await handleHwpDetectFormat({ file_path: siblingFile });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.code, "PATH_OUTSIDE_ALLOWED_ROOTS");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(escapeRegExp(siblingFile), "iu"));
  assert.doesNotMatch(serialized, /documents-private|secret\.hwpx/iu);
});

test("allowed roots: MCP startup rejects malformed configuration without echoing environment values and sync server creation remains available", async () => {
  const privateFragment = ["private", "startup", "value"].join("-");
  const rawValue = `[\"${privateFragment}`;
  await assert.rejects(
    configureAllowedRootsForMcp({ GPT_CODEX_HWP_ALLOWED_ROOTS: rawValue }),
    (error: unknown) => {
      assert.ok(error instanceof AllowedRootsConfigurationError);
      assert.equal(error.code, "INVALID_ALLOWED_ROOTS_CONFIGURATION");
      assert.doesNotMatch(error.message, new RegExp(privateFragment, "iu"));
      assert.equal(error.message.includes(rawValue), false);
      return true;
    },
  );
  assert.doesNotThrow(() => createMcpServer());
  const unrestricted = await configureAllowedRootsForMcp({});
  assert.equal(unrestricted.configured, false);
});

test("allowed roots: the MCP executable exits before transport startup and redacts malformed environment input", async () => {
  const privateFragment = ["never", "print", "startup", "path"].join("-");
  const rawValue = `[\"${privateFragment}`;
  const prepared = await prepareRestartSafeRuntime();
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [resolve(prepared.managedRoot, "dist", "mcp.js")],
        {
          cwd: prepared.managedRoot,
          env: {
            ...process.env,
            CODEX_HOME: prepared.codexHome,
            GPT_CODEX_HWP_ALLOWED_ROOTS: rawValue,
          },
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
        },
      ),
      (error: unknown) => {
        const stderr = typeof error === "object" && error !== null &&
            "stderr" in error && typeof error.stderr === "string"
          ? error.stderr
          : "";
        assert.equal(stderr, "INVALID_ALLOWED_ROOTS_CONFIGURATION\n");
        assert.doesNotMatch(stderr, new RegExp(privateFragment, "iu"));
        assert.equal(stderr.includes(rawValue), false);
        return true;
      },
    );
  } finally {
    await prepared.cleanup();
  }
});

test("allowed roots: all nine MCP tools return the same redacted denial for blocked user paths", async () => {
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  setActiveAllowedRootsPolicy(policy);
  const blockedOutput = join(siblingRoot, "blocked.hwpx");
  const blockedSvg = join(siblingRoot, "blocked.svg");

  const generationFacade = {
    async generate() {
      return {
        validation: { ok: true, issues: [], entryCount: 1 },
        resultMetadata: {
          operation: "generateHwpx",
          fontNormalization: { changed: false, changedReferenceCount: 0 },
        },
        async writeOutputExclusively(path: string) {
          await writeFilesExclusively([
            { path, data: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]) },
          ]);
        },
        async cleanup() {},
      };
    },
  };

  const cases: Array<readonly [string, Promise<unknown>]> = [
    ["hwp_detect_format", handleHwpDetectFormat({ file_path: siblingFile })],
    ["hwp_read", handleHwpRead({ file_path: siblingFile })],
    ["hwp_generate_hwpx", handleHwpGenerateHwpx(
      { markdown: "# blocked", output_path: blockedOutput },
      generationFacade as never,
    )],
    ["hwp_validate", handleHwpValidate({ file_path: siblingFile })],
    ["hwp_render_preview", handleHwpRenderPreview({
      file_path: siblingFile,
      output_svg_path: join(allowedRoot, "preview.svg"),
    })],
    ["hwp_patch_document", handleHwpPatchDocument({
      file_path: siblingFile,
      edited_markdown: "blocked",
      output_path: join(allowedRoot, "patched.hwpx"),
    })],
    ["hwp_fill_form", handleHwpFillForm({
      file_path: siblingFile,
      fields: { field: "blocked" },
      output_path: join(allowedRoot, "filled.hwpx"),
    })],
    ["hwp_create_svg_asset", handleHwpCreateSvgAsset(
      {
        prompt_or_spec: '<svg width="1" height="1"></svg>',
        output_svg_path: blockedSvg,
      },
      { validateSvg: async () => undefined },
    )],
    ["hwp_insert_image", handleHwpInsertImage({
      file_path: siblingFile,
      image_path: siblingFile,
      output_path: join(allowedRoot, "image.hwpx"),
      anchor_text: "anchor",
    })],
  ];

  for (const [toolName, pending] of cases) {
    const result = await pending as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    assert.equal(result.isError, true, toolName);
    assert.equal(
      result.structuredContent?.code,
      "PATH_OUTSIDE_ALLOWED_ROOTS",
      toolName,
    );
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /documents-private|secret\.hwpx|blocked\.(?:hwpx|svg)/iu);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(siblingRoot), "iu"));
  }
});

test("allowed roots: hwp_read blocks Markdown and extracted-image destinations before writing", async () => {
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  setActiveAllowedRootsPolicy(policy);
  const facade = {
    async parse(snapshot: Awaited<ReturnType<typeof openDocumentSnapshot>>) {
      const snapshotMetadata = snapshot.metadata;
      await snapshot.cleanup();
      return {
        snapshotMetadata,
        payload: {
          fileType: "hwpx",
          markdown: "complete markdown",
          images: [{
            filename: "image.png",
            bytes: Uint8Array.from([1, 2, 3]),
          }],
          warnings: [],
        },
      };
    },
  };

  for (const result of [
    await handleHwpRead(
      {
        file_path: allowedFile,
        markdown_output_path: join(siblingRoot, "blocked.md"),
      },
      facade as never,
    ),
    await handleHwpRead(
      {
        file_path: allowedFile,
        output_dir: join(siblingRoot, "blocked-assets"),
        extract_images: true,
      },
      facade as never,
    ),
  ]) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, "PATH_OUTSIDE_ALLOWED_ROOTS");
    assert.doesNotMatch(JSON.stringify(result), /documents-private|blocked/iu);
  }
});

test("allowed roots: an existing linked output parent is rejected", async (t) => {
  const outsideDirectory = join(siblingRoot, "linked-output-target");
  const linkedParent = join(allowedRoot, "linked-output-parent");
  await mkdir(outsideDirectory, { recursive: true });
  try {
    await symlink(
      outsideDirectory,
      linkedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error: unknown) {
    t.skip(`directory-link creation is unavailable: ${errorCode(error) ?? "unknown filesystem reason"}`);
    return;
  }
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  await assert.rejects(
    policy.authorizeFuturePath(join(linkedParent, "output.hwpx")),
    (error: unknown) => assertRedactedOutsideError(error),
  );
});

test("allowed roots: a directory-link swap between authorization and snapshot verification is rejected", async (t) => {
  const liveDirectory = join(allowedRoot, "swap-live");
  const retainedDirectory = join(allowedRoot, "swap-retained");
  const outsideDirectory = join(siblingRoot, "swap-target");
  await Promise.all([
    mkdir(liveDirectory, { recursive: true }),
    mkdir(outsideDirectory, { recursive: true }),
  ]);
  const liveFile = join(liveDirectory, "input.hwpx");
  await Promise.all([
    writeFile(liveFile, "inside"),
    writeFile(join(outsideDirectory, "input.hwpx"), "outside"),
  ]);
  const policy = await createAllowedRootsPolicy(JSON.stringify([allowedRoot]));
  setActiveAllowedRootsPolicy(policy);

  let linkAvailable = true;
  await assert.rejects(
    openDocumentSnapshot(liveFile, {
      testHooks: {
        async afterSourceRead() {
          await rename(liveDirectory, retainedDirectory);
          try {
            await symlink(
              outsideDirectory,
              liveDirectory,
              process.platform === "win32" ? "junction" : "dir",
            );
          } catch {
            linkAvailable = false;
            await rename(retainedDirectory, liveDirectory);
          }
        },
      },
    }),
    (error: unknown) => {
      if (!linkAvailable) return true;
      return errorCode(error) === "SOURCE_CHANGED" ||
        errorCode(error) === "PATH_OUTSIDE_ALLOWED_ROOTS" ||
        errorCode(error) === "SNAPSHOT_OPEN_FAILED";
    },
  );
  if (!linkAvailable) {
    t.skip("directory-link swap is unavailable on this filesystem.");
  }
});

function assertRedactedOutsideError(error: unknown): boolean {
  assert.ok(error instanceof AllowedRootsPathError);
  assert.equal(error.code, "PATH_OUTSIDE_ALLOWED_ROOTS");
  assert.equal(error.message, "Path is outside configured allowed roots.");
  assert.doesNotMatch(error.message, /documents|private|secret|input\.hwpx/iu);
  return true;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
