import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  callOneShotTool,
  createOneShotCleanupEvidenceCollector,
  MAX_ONESHOT_REQUEST_BYTES,
  parseOneShotArguments,
  parseOneShotRequest,
  runOneShot,
} from "../src/oneshot.js";

const REQUEST_PATH = resolve("request.json");
const RESPONSE_PATH = resolve("response.json");
const SOURCE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const HWP_FIXTURE = join(
  SOURCE_ROOT,
  "tests",
  "fixtures",
  "rhwp",
  "re-01-hangul-only-hancom.hwp",
);

test("one-shot cleanup evidence requires one recognized platform receipt", () => {
  let observe: (message: unknown) => void = () => undefined;
  let unsubscribed = false;
  const collector = createOneShotCleanupEvidenceCollector({
    platform: "linux",
    subscribe(observer) {
      observe = observer;
      return () => { unsubscribed = true; };
    },
  });
  observe({
    gone: true,
    proof: "registered-groups-empty",
    registeredIdentityCount: 1,
    remainingIdentityCount: 0,
  });
  assert.equal(
    collector.finish(),
    "ONESHOT_CLEANUP proof=registered-groups-empty observedProcessTrees=1 remainingProcessTrees=0\n",
  );
  assert.equal(unsubscribed, true);

  const duplicate = createOneShotCleanupEvidenceCollector({
    platform: "win32",
    subscribe(observer) {
      observer({ gone: true, proof: "windows-job-empty" });
      observer({ gone: true, proof: "windows-job-empty" });
      return () => undefined;
    },
  });
  assert.throws(() => duplicate.finish(), /cleanup evidence/iu);

  const remaining = createOneShotCleanupEvidenceCollector({
    platform: "linux",
    subscribe(observer) {
      observer({
        gone: false,
        proof: "unverified",
        reason: "deadline",
        registeredIdentityCount: 1,
        remainingIdentityCount: 1,
      });
      return () => undefined;
    },
  });
  assert.throws(() => remaining.finish(), /unverified/iu);
});

test("one-shot supplies its full deadline and cancellation signal to the MCP call", async () => {
  const controller = new AbortController();
  let observedOptions: { timeout?: number; signal?: AbortSignal } | undefined;
  const client = {
    async callTool(_request: unknown, _schema: unknown, options: unknown) {
      observedOptions = options as typeof observedOptions;
      return { content: [] };
    },
  } as unknown as Pick<Client, "callTool">;

  await callOneShotTool(client, {
    schemaVersion: 1,
    tool: "hwp_detect_format",
    arguments: { file_path: HWP_FIXTURE },
  }, { signal: controller.signal });

  assert.equal(observedOptions?.timeout, 315_000);
  assert.equal(observedOptions?.signal, controller.signal);
});

test("one-shot accepts one exact request and response pair", () => {
  assert.deepEqual(
    parseOneShotArguments([
      "--request",
      REQUEST_PATH,
      "--response",
      RESPONSE_PATH,
    ]),
    { requestPath: REQUEST_PATH, responsePath: RESPONSE_PATH },
  );
});

test("one-shot rejects malformed invocation without disclosing paths", () => {
  const invalidArguments = [
    [],
    ["--response", RESPONSE_PATH, "--request", REQUEST_PATH],
    ["--request", "request.json", "--response", RESPONSE_PATH],
    ["--request", REQUEST_PATH, "--response", REQUEST_PATH],
    ["--request", REQUEST_PATH, "--response", resolve("response.txt")],
  ];

  for (const argv of invalidArguments) {
    assert.throws(
      () => parseOneShotArguments(argv),
      (error: unknown) => error instanceof Error
        && error.message === "Invalid one-shot invocation."
        && !error.message.includes(REQUEST_PATH)
        && !error.message.includes(RESPONSE_PATH),
    );
  }
});

test("one-shot accepts an exact known-tool request", () => {
  assert.deepEqual(
    parseOneShotRequest(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_detect_format",
      arguments: { path: join("documents", "sample.hwp") },
    }))),
    {
      schemaVersion: 1,
      tool: "hwp_detect_format",
      arguments: { path: join("documents", "sample.hwp") },
    },
  );
});

test("one-shot rejects malformed requests with one fixed message", () => {
  const invalidRequests: unknown[] = [
    Buffer.from("{"),
    Buffer.from(JSON.stringify(null)),
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_unknown",
      arguments: {},
    })),
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_detect_format",
      arguments: [],
    })),
    Buffer.from(JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_detect_format",
      arguments: {},
      command: "sensitive-command",
    })),
  ];

  for (const bytes of invalidRequests) {
    assert.throws(
      () => parseOneShotRequest(bytes as Uint8Array),
      (error: unknown) => error instanceof Error
        && error.message === "Invalid one-shot request."
        && !error.message.includes("sensitive-command"),
    );
  }
});

test("one-shot publishes one successful existing tool result", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-oneshot-"));
  try {
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    await writeFile(requestPath, JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_detect_format",
      arguments: { file_path: HWP_FIXTURE },
    }));

    assert.equal(
      await runOneShot(["--request", requestPath, "--response", responsePath]),
      0,
    );
    const result = JSON.parse(await readFile(responsePath, "utf8"));
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.format, "hwp");
    if (process.platform !== "win32") {
      assert.equal((await stat(responsePath)).mode & 0o077, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-shot preflights a response collision before mutating tools dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-oneshot-"));
  try {
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    const svgPath = join(root, "asset.svg");
    const pngPath = join(root, "asset.png");
    await writeFile(requestPath, JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_create_svg_asset",
      arguments: {
        prompt_or_spec: '<svg width="10" height="10"><rect width="10" height="10"/></svg>',
        output_svg_path: svgPath,
        output_png_path: pngPath,
      },
    }));
    await writeFile(responsePath, "sentinel");

    assert.equal(
      await runOneShot(["--request", requestPath, "--response", responsePath]),
      2,
    );
    assert.equal(await readFile(responsePath, "utf8"), "sentinel");
    await assert.rejects(readFile(svgPath), { code: "ENOENT" });
    await assert.rejects(readFile(pngPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-shot publishes a tool error with exit one", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-oneshot-"));
  try {
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    await writeFile(requestPath, JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_detect_format",
      arguments: { file_path: join(root, "missing.hwp") },
    }));

    assert.equal(
      await runOneShot(["--request", requestPath, "--response", responsePath]),
      1,
    );
    assert.equal(JSON.parse(await readFile(responsePath, "utf8")).isError, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-shot never overwrites a response and rejects oversized requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-oneshot-"));
  try {
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    await writeFile(requestPath, JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_detect_format",
      arguments: { file_path: HWP_FIXTURE },
    }));
    await writeFile(responsePath, "sentinel");
    assert.equal(
      await runOneShot(["--request", requestPath, "--response", responsePath]),
      2,
    );
    assert.equal(await readFile(responsePath, "utf8"), "sentinel");

    const oversizedPath = join(root, "oversized.json");
    const newResponsePath = join(root, "new-response.json");
    await writeFile(oversizedPath, Buffer.alloc(MAX_ONESHOT_REQUEST_BYTES + 1, 0x20));
    assert.equal(
      await runOneShot(["--request", oversizedPath, "--response", newResponsePath]),
      2,
    );
    await assert.rejects(readFile(newResponsePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-shot rejects a symbolic-link request", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-oneshot-"));
  try {
    const targetPath = join(root, "target.json");
    const requestPath = join(root, "request.json");
    const responsePath = join(root, "response.json");
    await writeFile(targetPath, JSON.stringify({
      schemaVersion: 1,
      tool: "hwp_detect_format",
      arguments: { file_path: HWP_FIXTURE },
    }));
    try {
      await symlink(targetPath, requestPath, "file");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("symbolic-link creation is unavailable");
        return;
      }
      throw error;
    }
    assert.equal(
      await runOneShot(["--request", requestPath, "--response", responsePath]),
      2,
    );
    await assert.rejects(readFile(responsePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
