import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import CFB from "cfb";
import JSZip from "jszip";
import { markdownToHwpx } from "kordoc";
import sharp from "sharp";

import { encodeBoundedJsonFrame } from "../src/workers/bounded-frame.js";

import {
  createDocumentChildClient,
  isIntegrityVerifiedResultSpool,
} from "../src/workers/document-child-client.js";
import type { IntegrityVerifiedResultSpool } from "../src/workers/document-execution-policy.js";
import {
  createDocumentWorkerClient,
} from "../src/workers/document-worker-client.js";
import type {
  DocumentEngineOperation,
  DocumentResultPayload,
  LogicalDocumentRequest,
} from "../src/workers/document-protocol.js";
import type {
  SpoolDocumentSnapshot,
  WorkerDocumentSnapshot,
} from "../src/shared/document-snapshot.js";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_ROOT, "..");
const WORKER_ENTRY = join(PACKAGE_ROOT, "dist", "workers", "document-worker.js");
const CHILD_ENTRY = join(PACKAGE_ROOT, "dist", "workers", "document-child.js");
const FIXTURE_CHILD = join(TEST_ROOT, "fixtures", "workers", "engine-test-child.mjs");
const RHWP_HOOK_REGISTER = join(TEST_ROOT, "fixtures", "workers", "rhwp-hook-register.mjs");
const INSERT_IMAGE_HELPER = join(PACKAGE_ROOT, "scripts", "hwpx-safe-edit", "insert_image.py");
const HWP_FIXTURE = join(
  TEST_ROOT,
  "fixtures",
  "rhwp",
  "re-01-hangul-only-hancom.hwp",
);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
let largeNoisePngPromise: Promise<Buffer> | undefined;

test("document worker operations use only bytes for HWPX generation, parse, render, patch, fill, validation, and image placement", { timeout: 60_000 }, async () => {
  const client = createBuiltWorkerClient();
  const markdown = [
    "# Worker synthetic",
    "",
    "Approval anchor: (인)",
    "",
    "| 항목 | 값 |",
    "| --- | --- |",
    "| 성명 | |",
  ].join("\n");

  const generated = await client.run(request("generateHwpx", {
    input: { markdown },
  }), undefined);
  assert.ok(generated.bytes.byteLength > 0);

  const detected = await client.run(
    request("detect"),
    workerSnapshot(generated.bytes.slice(0)),
  );
  assert.deepEqual(detected, { format: "hwpx" });

  const parsed = await client.run(
    request("parse"),
    workerSnapshot(generated.bytes.slice(0)),
  );
  assert.equal(parsed.fileType, "hwpx");
  assert.match(parsed.markdown, /Worker synthetic/u);

  const rendered = await client.run(
    request("render", { options: { reflow: true } }),
    workerSnapshot(generated.bytes.slice(0)),
  );
  assert.match(rendered.svg, /^\s*<svg\b/iu);

  const edited = parsed.markdown.replace("Worker synthetic", "Worker updated");
  assert.notEqual(edited, parsed.markdown);
  const patched = await client.run(
    request("patchHwpx", { input: { markdown: edited } }),
    workerSnapshot(generated.bytes.slice(0)),
  );
  const patchedRead = await client.run(
    request("parse"),
    workerSnapshot(patched.bytes.slice(0)),
  );
  assert.match(patchedRead.markdown, /Worker updated/u);

  const filled = await client.run(
    request("fillHwpx", { input: { fields: { "성명": "홍길동" } } }),
    workerSnapshot(generated.bytes.slice(0)),
  );
  const filledRead = await client.run(
    request("parse"),
    workerSnapshot(filled.bytes.slice(0)),
  );
  assert.match(filledRead.markdown, /홍길동/u);

  const checked = await client.run(
    request("validateHwpx"),
    workerSnapshot(generated.bytes.slice(0)),
  );
  assert.equal(checked.ok, true);
  assert.equal(checked.issues.length, 0);

  const imageBuffer = exactArrayBuffer(ONE_PIXEL_PNG);
  const inserted = await client.run(
    request("insertImage", {
      input: { anchorText: "(인)" },
      options: { mode: "seal-anchor", sizeMm: 8, anchorOccurrence: 0 },
    }),
    workerSnapshot(generated.bytes.slice(0)),
    { imageInput: { transport: "buffer", buffer: imageBuffer } },
  );
  const insertedCheck = await client.run(
    request("validateHwpx"),
    workerSnapshot(inserted.bytes.slice(0)),
  );
  assert.equal(insertedCheck.ok, true);

  await assert.rejects(
    client.run(
      request("insertImage", {
        input: { anchorText: "(인)" },
        options: { mode: "after-paragraph" },
      }),
      workerSnapshot(generated.bytes.slice(0)),
      {
        imageInput: {
          transport: "buffer",
          buffer: exactArrayBuffer(ONE_PIXEL_PNG),
        },
      },
    ),
    hasEngineCode("ENGINE_PROTOCOL_ERROR"),
    "after-paragraph must fail closed before Kordoc placement dispatch",
  );
});

test("validateHwpx reports font-integrity issues when structural validation has no issues", async () => {
  const client = createBuiltWorkerClient();
  const unnormalized = await markdownToHwpx("결재: (인)");

  const checked = await client.run(
    request("validateHwpx"),
    workerSnapshot(unnormalized.slice(0)),
  );

  assert.equal(checked.ok, false);
  assert.ok(checked.issues.some((issue) => /font ID/iu.test(issue.message)));
});

test("document worker operations read and render the pinned HWP but reject every HWP mutation before mutation dispatch", { timeout: 60_000 }, async () => {
  const client = createBuiltWorkerClient();
  const hwp = await readFile(HWP_FIXTURE);

  assert.deepEqual(
    await client.run(request("detect"), workerSnapshot(exactArrayBuffer(hwp))),
    { format: "hwp" },
  );
  const parsed = await client.run(
    request("parse"),
    workerSnapshot(exactArrayBuffer(hwp)),
  );
  assert.equal(parsed.fileType, "hwp");
  assert.equal(Buffer.byteLength(parsed.markdown, "utf8"), 300);

  const rendered = await client.run(
    request("render"),
    workerSnapshot(exactArrayBuffer(hwp)),
  );
  assert.match(rendered.svg, /^\s*<svg\b/iu);

  for (const operation of [
    request("patchHwpx", { input: { markdown: parsed.markdown } }),
    request("fillHwpx", { input: { fields: { name: "value" } } }),
    request("validateHwpx"),
  ] as const) {
    await assert.rejects(
      client.run(operation as never, workerSnapshot(exactArrayBuffer(hwp))),
      hasEngineCode("ENGINE_PROTOCOL_ERROR"),
      operation.operation,
    );
  }

  await assert.rejects(
    client.run(
      request("insertImage", { input: { anchorText: "anchor" } }),
      workerSnapshot(exactArrayBuffer(hwp)),
      {
        imageInput: {
          transport: "buffer",
          buffer: exactArrayBuffer(ONE_PIXEL_PNG),
        },
      },
    ),
    hasEngineCode("ENGINE_PROTOCOL_ERROR"),
  );
});

test("real worker and child refuse protected HWPX and HWP before parse or render dispatch", { timeout: 120_000 }, async () => {
  const worker = createBuiltWorkerClient();
  const child = createBuiltChildClient();
  const generated = await worker.run(request("generateHwpx", {
    input: { markdown: "# Protected isolate fixture\n" },
  }), undefined);
  const cases = [
    {
      name: "signed HWPX",
      bytes: await protectedHwpx(generated.bytes, "signed"),
      code: "SIGNED_DOCUMENT",
      message: "The document is digitally signed and cannot be processed.",
    },
    {
      name: "encrypted HWPX",
      bytes: await protectedHwpx(generated.bytes, "encrypted"),
      code: "ENCRYPTED",
      message: "The document is encrypted and cannot be processed.",
    },
    {
      name: "DRM HWPX",
      bytes: await protectedHwpx(generated.bytes, "drm"),
      code: "DRM_PROTECTED",
      message: "The document is DRM or distribution protected and cannot be processed.",
    },
    {
      name: "invalid HWPX protection metadata",
      bytes: await invalidProtectionHwpx(generated.bytes),
      code: "INVALID_HWPX_PROTECTION_METADATA",
      message: "The HWPX protection metadata is invalid and cannot be processed.",
    },
    {
      name: "signed HWP",
      bytes: syntheticHwpWithFlags(1 << 7),
      code: "SIGNED_DOCUMENT",
      message: "The document is digitally signed and cannot be processed.",
    },
    {
      name: "encrypted HWP",
      bytes: syntheticHwpWithFlags(1 << 1),
      code: "ENCRYPTED",
      message: "The document is encrypted and cannot be processed.",
    },
    {
      name: "DRM HWP",
      bytes: syntheticHwpWithFlags(1 << 4),
      code: "DRM_PROTECTED",
      message: "The document is DRM or distribution protected and cannot be processed.",
    },
    {
      name: "invalid HWP FileHeader",
      bytes: syntheticHwpWithFlags(0, 39),
      code: "INVALID_HWP_FILE_HEADER",
      message: "The HWP file header is invalid and cannot be processed.",
    },
  ] as const;

  for (const transport of ["worker", "child"] as const) {
    for (const fixture of cases) {
      for (const operation of ["parse", "render"] as const) {
        const run = transport === "worker"
          ? worker.run(request(operation), workerSnapshot(exactArrayBuffer(fixture.bytes)))
          : runChildReadOnly(child, operation, fixture.bytes);
        await assert.rejects(run, (error: unknown) => {
          assert.equal((error as { code?: string }).code, fixture.code,
            `${transport} ${operation} ${fixture.name}`);
          assert.equal((error as Error).message, fixture.message,
            `${transport} ${operation} ${fixture.name}`);
          return true;
        });
      }
    }
  }
});

test("worker reaches ready and completes non-HWP-render operations without loading unavailable or slow rhwp", { timeout: 30_000 }, async () => {
  const client = createRhwpBlockedWorkerClient(1_000);
  const started = performance.now();
  const generated = await stage("generate", client.run(request("generateHwpx", {
    input: { markdown: "# Lazy rhwp\n" },
  }), undefined, { deadlineMs: 3_000 }));
  assert.ok(performance.now() - started < 3_000);
  assert.deepEqual(
    await stage("detect", client.run(request("detect"), workerSnapshot(generated.bytes.slice(0)))),
    { format: "hwpx" },
  );
  const parsed = await stage("parse", client.run(
    request("parse"),
    workerSnapshot(generated.bytes.slice(0)),
  ));
  assert.equal(parsed.fileType, "hwpx");
  const rendered = await stage("hwpx render", client.run(
    request("render", { options: { reflow: true } }),
    workerSnapshot(generated.bytes.slice(0)),
  ));
  assert.match(rendered.svg, /^\s*<svg\b/iu);
});

async function stage<T>(name: string, promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error: unknown) {
    throw new Error(`${name}: ${String((error as Error).message)}`, { cause: error });
  }
}

test("unavailable rhwp HWP render maps to a stable safe capability error", { timeout: 30_000 }, async () => {
  const client = createRhwpBlockedWorkerClient(0);
  const hwp = await readFile(HWP_FIXTURE);
  await assert.rejects(
    client.run(request("render"), workerSnapshot(exactArrayBuffer(hwp))),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ENGINE_INIT_FAILED");
      assert.deepEqual((error as { details?: unknown }).details, {
        stage: "render",
        remediation: "check_installation",
      });
      assert.doesNotMatch(String((error as Error).message), /SENSITIVE_RHWP_LOADER_REASON/u);
      return true;
    },
  );
});

test("document worker operations child route uses inherited handles and the one-shot decoder returns validated exact results", { timeout: 60_000 }, async () => {
  const child = createBuiltChildClient();
  const generatedResult = await child.run(
    request("generateHwpx", { input: { markdown: "# Child generated\n" } }),
    undefined,
  );

  const { decodeDocumentResultSpool } = await import(
    "../src/workers/document-compute-backend.js"
  );
  const generated = isIntegrityVerifiedResultSpool(generatedResult)
    ? await decodeDocumentResultSpool(
        generatedResult as IntegrityVerifiedResultSpool<"generateHwpx">,
      )
    : generatedResult;
  assert.ok(generated.bytes.byteLength > 0);

  const owned = spoolSnapshot(new Uint8Array(generated.bytes));
  const parsed = await child.run(request("parse"), owned.snapshot);
  const parsedPayload = isIntegrityVerifiedResultSpool(parsed)
    ? await decodeDocumentResultSpool(parsed as IntegrityVerifiedResultSpool<"parse">)
    : parsed;
  assert.equal(parsedPayload.fileType, "hwpx");
  assert.match(parsedPayload.markdown, /Child generated/u);
  owned.cleanup();
});

test("compiled child performs default, explicit after-paragraph, and seal-anchor placement through fd4 and refuses HWP mutation", { timeout: 120_000 }, async () => {
  const worker = createBuiltWorkerClient();
  const generated = await worker.run(request("generateHwpx", {
    input: { markdown: "# Placement\n\nApproval anchor: (인)\n" },
  }), undefined);

  for (const options of [{}, { mode: "after-paragraph" }, { mode: "seal-anchor" }] as const) {
    const inserted = await runBuiltChildInsert(generated.bytes, ONE_PIXEL_PNG, options);
    const validation = await worker.run(
      request("validateHwpx"),
      workerSnapshot(inserted.bytes.slice(0)),
    );
    assert.equal(validation.ok, true);
    if (options.mode !== "seal-anchor") {
      await assertImageParagraphImmediatelyAfter(inserted.bytes, "(인)");
    }
  }

  const hwp = await readFile(HWP_FIXTURE);
  await assert.rejects(
    runBuiltChildInsert(exactArrayBuffer(hwp), ONE_PIXEL_PNG, {}),
    hasEngineCode("ENGINE_PROTOCOL_ERROR"),
  );
});

test("Python insert-image descriptor mode directly consumes fd3/fd4 and writes fd5 without path arguments", { timeout: 60_000 }, async () => {
  const worker = createBuiltWorkerClient();
  const generated = await worker.run(request("generateHwpx", {
    input: { markdown: "# Direct descriptor\n\nApproval anchor: (인)\n" },
  }), undefined);
  const root = mkdtempSync(join(tmpdir(), "gpt-codex-hwp-descriptor-"));
  const sourcePath = join(root, "source.bin");
  const imagePath = join(root, "image.bin");
  const outputPath = join(root, "output.bin");
  writeFileSync(sourcePath, new Uint8Array(generated.bytes));
  writeFileSync(imagePath, ONE_PIXEL_PNG);
  const sourceFd = openSync(sourcePath, "r");
  const imageFd = openSync(imagePath, "r");
  const outputFd = openSync(outputPath, "w+");
  try {
    const command = process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "py.exe")
      : "/usr/bin/python3";
    const child = spawn(command, [
      ...(process.platform === "win32" ? ["-3"] : []),
      INSERT_IMAGE_HELPER,
      "--descriptor-mode",
    ], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", sourceFd, imageFd, outputFd],
    });
    child.stdin.end(encodeBoundedJsonFrame({
      sourceSize: generated.bytes.byteLength,
      imageSize: ONE_PIXEL_PNG.byteLength,
      anchorText: "(인)",
      occurrence: 0,
    }, 64 * 1024));
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  } finally {
    closeSync(sourceFd);
    closeSync(imageFd);
    closeSync(outputFd);
  }
  try {
    const output = await readFile(outputPath);
    const validation = await worker.run(
      request("validateHwpx"),
      workerSnapshot(exactArrayBuffer(output)),
    );
    assert.equal(validation.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor helper command line never contains a distinctive document anchor", {
  timeout: 120_000,
  skip: process.platform !== "win32" ? "Windows process command lines are required." : false,
}, async () => {
  const anchor = "PRIVATE-ANCHOR-79f4d6c1-DO-NOT-EXPOSE";
  const worker = createBuiltWorkerClient();
  const generated = await worker.run(request("generateHwpx", {
    input: { markdown: `# Privacy\n\n${anchor}\n` },
  }), undefined);
  const image = await largeNoisePng();

  const monitor = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$deadline=(Get-Date).AddSeconds(15)",
      "while ((Get-Date) -lt $deadline) {",
      "$p=Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(py|python|python3)\\.exe$' -and $_.CommandLine -like '*insert_image.py*' } | Select-Object -First 1",
      "if ($null -ne $p) { $p.CommandLine; exit 0 }",
      "Start-Sleep -Milliseconds 10",
      "}",
      "exit 2",
    ].join("; "),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const monitorOutput: Buffer[] = [];
  const monitorError: Buffer[] = [];
  monitor.stdout.on("data", (chunk: Buffer) => monitorOutput.push(chunk));
  monitor.stderr.on("data", (chunk: Buffer) => monitorError.push(chunk));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));

  const insertion = runBuiltChildInsert(
    generated.bytes,
    image,
    { mode: "after-paragraph", anchorOccurrence: 0, sizeMm: 17 },
    anchor,
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const [monitorCode] = await once(monitor, "exit");
  assert.equal(monitorCode, 0, Buffer.concat(monitorError).toString("utf8"));
  const observed = Buffer.concat(monitorOutput).toString("utf8").trim();
  assert.ok(observed, "the deliberately slow helper was never observed");
  assert.doesNotMatch(observed, new RegExp(anchor, "u"));
  assert.doesNotMatch(observed, new RegExp(String(generated.bytes.byteLength), "u"));
  assert.doesNotMatch(observed, new RegExp(String(image.byteLength), "u"));
  assert.doesNotMatch(observed, /(?:^|\s)0(?:\s|$)|(?:^|\s)17(?:\s|$)/u);
  assert.doesNotMatch(
    observed,
    /--(?:source-size|image-size|anchor-text|occurrence|width-mm)\b/u,
  );
  const outcome = await insertion;
  if ("error" in outcome) throw outcome.error;
  const inserted = outcome.value;
  assert.ok(inserted.bytes.byteLength > 0);
});

test("compiled child streams and decodes a validated after-paragraph result larger than 8 MiB", { timeout: 120_000 }, async () => {
  const worker = createBuiltWorkerClient();
  const generated = await worker.run(request("generateHwpx", {
    input: { markdown: "# Large placement\n\nApproval anchor: (인)\n" },
  }), undefined);
  const image = await largeNoisePng();
  const inserted = await runBuiltChildInsert(generated.bytes, image, {});
  assert.ok(inserted.bytes.byteLength > 8 * 1024 * 1024);
  const validation = await worker.run(
    request("validateHwpx"),
    workerSnapshot(inserted.bytes.slice(0)),
  );
  assert.equal(validation.ok, true);
});

test("importing the compiled result decoder does not load Kordoc or rhwp in the MCP process", () => {
  const loader = [
    "export async function resolve(specifier, context, nextResolve) {",
    "if (specifier === 'kordoc' || specifier === '@rhwp/core') throw new Error('ENGINE_IMPORT_LEAK');",
    "return nextResolve(specifier, context);",
    "}",
  ].join("\n");
  const decoderUrl = pathToFileURL(join(
    PACKAGE_ROOT,
    "dist",
    "workers",
    "document-compute-backend.js",
  )).href;
  const script = [
    "import { register } from 'node:module';",
    `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);`,
    `await import(${JSON.stringify(decoderUrl)});`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("document worker operations spool decoder rejects hash-valid but semantically invalid parse and render spools and always cleans", { timeout: 30_000 }, async () => {
  const { decodeDocumentResultSpool } = await import(
    "../src/workers/document-compute-backend.js"
  );

  for (const operation of ["parse", "render"] as const) {
    const owned = spoolSnapshot(Buffer.from("K".repeat(1024)));
    const client = createFixtureChildClient("spool-result", "1024");
    const result = await client.run(request(operation), owned.snapshot);
    assert.equal(isIntegrityVerifiedResultSpool(result), true);
    await assert.rejects(
      decodeDocumentResultSpool(result as IntegrityVerifiedResultSpool<typeof operation>),
      hasEngineCode("ENGINE_PROTOCOL_ERROR"),
    );
    assert.throws(() => result.takeHandle(), hasEngineCode("ENGINE_PROTOCOL_ERROR"));
    owned.cleanup();
  }
});

test("render spool uses a versioned bounded metadata header before exact SVG bytes", async () => {
  const { encodeDocumentResultSpool } = await import(
    "../src/workers/document-compute-backend.js"
  );
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>metadata</text></svg>';
  const metadata = {
    backend: "kordoc",
    pageCount: 2,
    width: 612,
    height: 792,
    warnings: ["bounded"],
    stats: { paragraphs: 3 },
  };

  const encoded = encodeDocumentResultSpool("render", { svg, metadata });
  const buffer = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const headerBytes = buffer.readUInt32BE(0);
  assert.ok(headerBytes > 0 && headerBytes <= 8 * 1024 * 1024);
  const header = JSON.parse(buffer.subarray(4, 4 + headerBytes).toString("utf8"));
  assert.deepEqual(header, {
    version: 1,
    svgBytes: Buffer.byteLength(svg, "utf8"),
    metadata,
  });
  assert.equal(buffer.subarray(4 + headerBytes).toString("utf8"), svg);
});

test("worker backend rejects active or networked SVG output before transport", async () => {
  const { encodeDocumentResultSpool } = await import(
    "../src/workers/document-compute-backend.js"
  );
  for (const unsafe of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><svg:script/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><x:foreignObject/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><x:style/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text onclick="run()">x</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:run()">x</a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a>rest.png"/></svg>',
  ]) {
    assert.throws(
      () => encodeDocumentResultSpool("render", { svg: unsafe }),
      hasEngineCode("ENGINE_PROTOCOL_ERROR"),
    );
  }
});

test("incremental SVG policy rejects split active tokens and quoted tag terminators", async () => {
  const { IncrementalSvgPolicyValidator } = await import(
    "../src/shared/svg-policy.js"
  );
  for (const unsafe of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text onload="x">x</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:x">x</a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(https://evil.test/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u&#x72;l(https://evil.test/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72 l(https://evil.test/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><set href="#i" attributeName="href" to="https://evil.test/x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><svg:set href="#i" attributeName="href" to="https://evil.test/x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a>rest"/></svg>',
  ]) {
    const validator = new IncrementalSvgPolicyValidator();
    assert.throws(() => {
      for (const character of unsafe) validator.push(character);
      validator.finish();
    }, undefined, unsafe);
  }
});

test("incremental SVG policy streams only bounded safe embedded image payloads", async () => {
  const { IncrementalSvgPolicyValidator, assertSafeSvgString } = await import(
    "../src/shared/svg-policy.js"
  );
  const payload = Buffer.alloc(331_169, 0xa5).toString("base64");
  const safe = `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><image href="data:image/png;base64,${payload}" x="1"/><path fill="url(#g)"/></svg>`;
  const validator = new IncrementalSvgPolicyValidator();
  for (const character of safe) validator.push(character);
  assert.doesNotThrow(() => validator.finish());

  for (const type of ["png", "jpeg", "jpg", "gif", "webp"]) {
    assert.doesNotThrow(() => assertSafeSvgString(
      `<svg><image src="data:image/${type};base64,AAAA"/></svg>`,
    ));
  }
  assert.doesNotThrow(() => assertSafeSvgString(
    '<svg><image href="data:image/png;base64,AA=="/><image href="data:image/png;base64,AAA="/></svg>',
  ));
  for (const unsafe of [
    '<svg><image href="data:image/png;base64,AAA"/></svg>',
    '<svg><image href="data:image/png;base64,AA*A"/></svg>',
    '<svg><image href="data:image/png;base64,AA=A"/></svg>',
    '<svg><image href="data:image/png;base64,A==="/></svg>',
    '<svg><image href="data:image/png;base64,AB=="/></svg>',
    '<svg><image href="data:image/png;base64,AAB="/></svg>',
    '<svg><image href="data:image/svg+xml;base64,AAAA"/></svg>',
    '<svg><image href="https://evil.test/x.png"/></svg>',
    '<svg><image href="data:image/png;base64,AAAA" onload="run()"/></svg>',
    '<svg><image href="data:image/png;base64,AAAA',
    '<svg><image href="data:image/png;base64,AAAA</svg>',
    `<svg><path aria-label="${"x".repeat(64 * 1024)}"/></svg>`,
  ]) {
    const split = new IncrementalSvgPolicyValidator();
    assert.throws(() => {
      for (const character of unsafe) split.push(character);
      split.finish();
    }, undefined, unsafe);
  }
});

test("incremental SVG policy rejects active encodings, dynamic URL mutation, and extra roots", async () => {
  const { assertSafeSvgString } = await import("../src/shared/svg-policy.js");
  for (const unsafe of [
    '<svg><path fill="u&#x72;l(https://evil.test/x)"/></svg>',
    '<svg><path fill="u\\72 l(https://evil.test/x)"/></svg>',
    '<svg><animate/></svg>',
    '<svg><x:set/></svg>',
    '<svg><animateTransform/></svg>',
    '<svg><x:animateMotion/></svg>',
    '<svg><mpath/></svg>',
    '<svg><discard/></svg>',
    '<svg></svg><svg></svg>',
    '<svg></svg>trailing',
    '<svg></svg><text/>',
  ]) {
    assert.throws(() => assertSafeSvgString(unsafe), undefined, unsafe);
  }
  assert.doesNotThrow(() => assertSafeSvgString(
    '<svg><defs><linearGradient id="g"/></defs><svg><path fill="url(#g)"/></svg></svg>',
  ));
});

test("incremental SVG policy rejects XML Base without matching inert base attributes", async () => {
  const { IncrementalSvgPolicyValidator, assertSafeSvgString } = await import(
    "../src/shared/svg-policy.js"
  );
  for (const unsafe of [
    '<svg xml:base="https://evil.test/"><image href="#x"/></svg>',
    '<svg><g xml:base="https://evil.test/"><image href="#x"/></g></svg>',
    '<svg xml:base="h&#x74;tps://evil.test/"><image href="#x"/></svg>',
  ]) {
    const validator = new IncrementalSvgPolicyValidator();
    assert.throws(() => {
      for (const character of unsafe) validator.push(character);
      validator.finish();
    }, undefined, unsafe);
  }
  assert.doesNotThrow(() => assertSafeSvgString(
    '<svg base="https://example.test/" data-base="https://example.test/"><image href="#x"/></svg>',
  ));
});

test("incremental SVG policy rejects embedded navigation elements and srcdoc", async () => {
  const { IncrementalSvgPolicyValidator, assertSafeSvgString } = await import(
    "../src/shared/svg-policy.js"
  );
  for (const unsafe of [
    '<svg xmlns:h="http://www.w3.org/1999/xhtml"><h:iframe srcdoc="&lt;script&gt;run()&lt;/script&gt;"/></svg>',
    '<svg xmlns:h="http://www.w3.org/1999/xhtml"><g><h:meta http-equiv="refresh" content="0;url=https://evil.test/"/></g></svg>',
    '<svg><g srcdoc="&lt;script&gt;run()&lt;/script&gt;"/></svg>',
    '<svg><iframe/></svg>',
    '<svg><object/></svg>',
    '<svg><embed/></svg>',
    '<svg><audio/></svg>',
    '<svg><video/></svg>',
    '<svg><canvas/></svg>',
    '<svg><link/></svg>',
    '<svg><meta/></svg>',
    '<svg><base/></svg>',
    '<svg xmlns:x="urn:test"><x:g/></svg>',
  ]) {
    const validator = new IncrementalSvgPolicyValidator();
    assert.throws(() => {
      for (const character of unsafe) validator.push(character);
      validator.finish();
    }, undefined, unsafe);
  }
  assert.doesNotThrow(() => assertSafeSvgString(
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><g><image xlink:href="#x"/></g></svg>',
  ));
});

test("incremental SVG policy accepts only the standard SVG and XLink namespace declarations", async () => {
  const { IncrementalSvgPolicyValidator, assertSafeSvgString } = await import(
    "../src/shared/svg-policy.js"
  );
  for (const unsafe of [
    '<svg xmlns="http://www.w3.org/1999/xhtml"><form/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><form xmlns="http://www.w3.org/1999/xhtml"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><form xmlns="http://www.w3.org/1999/xht&#x6d;l"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="https://evil.test/xlink"/>',
  ]) {
    const validator = new IncrementalSvgPolicyValidator();
    assert.throws(() => {
      for (const character of unsafe) validator.push(character);
      validator.finish();
    }, undefined, unsafe);
  }
  assert.doesNotThrow(() => assertSafeSvgString(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="#x"/></svg>',
  ));
});

test("render spool decoder rejects unknown metadata header keys", async () => {
  const { decodeDocumentResultSpool, encodeDocumentResultSpool } = await import(
    "../src/workers/document-compute-backend.js"
  );
  const encoded = Buffer.from(encodeDocumentResultSpool("render", {
    svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  }));
  const headerBytes = encoded.readUInt32BE(0);
  const header = JSON.parse(encoded.subarray(4, 4 + headerBytes).toString("utf8"));
  const replacement = Buffer.from(JSON.stringify({ ...header, unexpected: "value" }), "utf8");
  const malformed = Buffer.concat([
    Buffer.from([
      replacement.byteLength >>> 24,
      replacement.byteLength >>> 16,
      replacement.byteLength >>> 8,
      replacement.byteLength,
    ]),
    replacement,
    encoded.subarray(4 + headerBytes),
  ]);
  const owned = spoolSnapshot(Buffer.from("input"));
  const client = createFixtureChildClient("spool-base64", malformed.toString("base64"));
  const result = await client.run(request("render"), owned.snapshot);
  await assert.rejects(
    decodeDocumentResultSpool(result as IntegrityVerifiedResultSpool<"render">),
    hasEngineCode("ENGINE_PROTOCOL_ERROR"),
  );
  owned.cleanup();
});

test("document worker operations parse spool header uses fatal UTF-8 and cleans its one-shot handle", { timeout: 30_000 }, async () => {
  const { decodeDocumentResultSpool } = await import(
    "../src/workers/document-compute-backend.js"
  );
  const header = Buffer.from(JSON.stringify({
    version: 1,
    markdownBytes: 0,
    fileType: "hwpx",
    metadata: { title: "X" },
    warnings: [],
    images: [],
  }), "utf8");
  const marker = header.indexOf(0x58);
  assert.notEqual(marker, -1);
  header[marker] = 0xff;
  const encoded = Buffer.alloc(4 + header.byteLength);
  encoded.writeUInt32BE(header.byteLength, 0);
  header.copy(encoded, 4);
  const owned = spoolSnapshot(Buffer.from("input"));
  const client = createFixtureChildClient("spool-base64", encoded.toString("base64"));
  const result = await client.run(request("parse"), owned.snapshot);
  assert.equal(isIntegrityVerifiedResultSpool(result), true);
  await assert.rejects(
    decodeDocumentResultSpool(result as IntegrityVerifiedResultSpool<"parse">),
    hasEngineCode("ENGINE_PROTOCOL_ERROR"),
  );
  assert.throws(() => result.takeHandle(), hasEngineCode("ENGINE_PROTOCOL_ERROR"));
  owned.cleanup();
});

test("document child waits for EOF and rejects a later second frame or trailing partial before ready", { timeout: 30_000 }, async () => {
  const wire = request("generateHwpx", { input: { markdown: "# framing" } });
  const frame = encodeBoundedJsonFrame(wire, 512 * 1024);
  for (const suffix of [frame, Buffer.from([0, 0, 0, 9, 0x7b])] as const) {
    const child = spawn(process.execPath, [CHILD_ENTRY], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "pipe"],
    });
    const control: Buffer[] = [];
    child.stdio[6]?.on("data", (chunk: Buffer) => control.push(chunk));
    child.stdin.write(frame);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    child.stdin.end(suffix);
    const [code] = await once(child, "exit");
    assert.equal(code, 19);
    assert.equal(Buffer.concat(control).byteLength, 0);
  }
});

test("document worker operations isolate requests contain no source path or Node IPC fields", () => {
  const requests = [
    request("detect"),
    request("parse", { options: { pages: "1" } }),
    request("render", { options: { reflow: true, highlights: ["term"] } }),
    request("generateHwpx", { input: { markdown: "# path-free" } }),
    request("patchHwpx", { input: { markdown: "edited" } }),
    request("fillHwpx", { input: { fields: { key: "value" } } }),
    request("validateHwpx", { options: { maxIssues: 5 } }),
    request("insertImage", { input: { anchorText: "anchor" } }),
  ];
  for (const value of requests) {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /(?:file|source|spool)[_-]?path|\bipc\b/iu);
  }
});

function createBuiltWorkerClient() {
  return createDocumentWorkerClient({
    workerFactory: (options) => new Worker(pathToFileURL(WORKER_ENTRY), options),
  });
}

function createRhwpBlockedWorkerClient(delayMs: number) {
  return createDocumentWorkerClient({
    workerFactory: (options) => new Worker(pathToFileURL(WORKER_ENTRY), {
      ...options,
      execArgv: ["--import", pathToFileURL(RHWP_HOOK_REGISTER).href],
      workerData: { rhwpHookDelayMs: delayMs },
    }),
  });
}

function createBuiltChildClient() {
  return createChildClient(CHILD_ENTRY, []);
}

async function runBuiltChildInsert(
  document: ArrayBuffer,
  image: Uint8Array,
  options: Record<string, unknown>,
  anchorText = "(인)",
): Promise<DocumentResultPayload<"insertImage">> {
  const sourceOwned = spoolSnapshot(new Uint8Array(document));
  const imageOwned = spoolSnapshot(image);
  const imageHandle = imageOwned.snapshot.takeSpoolHandle();
  try {
    const compiledClient = await import("../dist/workers/document-child-client.js");
    const childClient = compiledClient.createDocumentChildClient({
      childEntry: CHILD_ENTRY,
      jobSupervisorFactory: async (child) => ({
        terminate: async () => {
          if (child.exitCode !== null || child.signalCode !== null) return true;
          child.kill();
          await once(child, "exit");
          return true;
        },
      }),
    });
    const result = await childClient.run(
      request("insertImage", {
        input: { anchorText },
        options,
      }),
      sourceOwned.snapshot,
      { imageInput: { transport: "spool", ...imageHandle } },
    );
    if (image.byteLength > 8 * 1024 * 1024) {
      assert.equal(compiledClient.isIntegrityVerifiedResultSpool(result), true);
      assert.equal(
        (result as IntegrityVerifiedResultSpool<"insertImage">).metadata.encoding,
        "hwpx-result-v1",
      );
      assert.equal(
        ((result as IntegrityVerifiedResultSpool<"insertImage">).metadata
          .resultMetadata as { mode?: string } | undefined)?.mode,
        "after-paragraph",
      );
      assert.ok((result as IntegrityVerifiedResultSpool<"insertImage">).metadata.sizeBytes > 8 * 1024 * 1024);
    }
    if (!compiledClient.isIntegrityVerifiedResultSpool(result)) return result;
    const { decodeDocumentResultSpool } = await import(
      "../dist/workers/document-compute-backend.js"
    );
    return decodeDocumentResultSpool(
      result as IntegrityVerifiedResultSpool<"insertImage">,
    );
  } finally {
    sourceOwned.cleanup();
    imageOwned.cleanup();
  }
}

async function assertImageParagraphImmediatelyAfter(
  document: ArrayBuffer,
  anchor: string,
): Promise<void> {
  const zipped = await JSZip.loadAsync(document);
  const sectionName = Object.keys(zipped.files)
    .find((name) => /^Contents\/section\d+\.xml$/u.test(name));
  assert.ok(sectionName);
  const xml = await zipped.file(sectionName)?.async("string");
  assert.ok(xml);
  const anchorIndex = xml.indexOf(anchor);
  assert.notEqual(anchorIndex, -1);
  const anchorParagraphEnd = xml.indexOf("</hp:p>", anchorIndex);
  assert.notEqual(anchorParagraphEnd, -1);
  const nextParagraphStart = xml.indexOf("<hp:p", anchorParagraphEnd);
  const nextParagraphEnd = xml.indexOf("</hp:p>", nextParagraphStart);
  assert.ok(nextParagraphStart > anchorParagraphEnd && nextParagraphEnd > nextParagraphStart);
  assert.match(xml.slice(nextParagraphStart, nextParagraphEnd), /<hc:img\b/u);
}

function createFixtureChildClient(...args: string[]) {
  return createChildClient(FIXTURE_CHILD, args);
}

function createChildClient(childEntry: string, childArguments: string[]) {
  return createDocumentChildClient({
    childEntry,
    childArguments,
    jobSupervisorFactory: async (child) => ({
      terminate: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        child.kill();
        await Promise.race([
          once(child, "exit"),
          new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000)),
        ]);
        return child.exitCode !== null || child.signalCode !== null;
      },
    }),
  });
}

function request<Operation extends DocumentEngineOperation>(
  operation: Operation,
  overrides: {
    input?: Record<string, unknown>;
    options?: Record<string, unknown>;
  } = {},
): Extract<LogicalDocumentRequest, { operation: Operation }> {
  return {
    protocolVersion: 1,
    requestId: `operations-${operation}-${Math.random().toString(36).slice(2)}`,
    operation,
    input: overrides.input ?? {},
    options: overrides.options ?? {},
  } as Extract<LogicalDocumentRequest, { operation: Operation }>;
}

function workerSnapshot(buffer: ArrayBuffer): WorkerDocumentSnapshot {
  let taken = false;
  let cleaned = false;
  return {
    transport: "worker",
    metadata: Object.freeze({
      sizeBytes: buffer.byteLength,
      sha256: "0".repeat(64),
      candidateFormat: "unknown",
      protection: "unknown",
    }),
    takeTransferable(): ArrayBuffer {
      if (taken || cleaned) throw new Error("snapshot already consumed");
      taken = true;
      return buffer;
    },
    async cleanup(): Promise<void> {
      cleaned = true;
    },
  };
}

function spoolSnapshot(bytes: Uint8Array): {
  snapshot: SpoolDocumentSnapshot;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "gpt-codex-hwp-operation-"));
  const path = join(root, "input.bin");
  writeFileSync(path, bytes);
  const fd = openSync(path, "r");
  let taken = false;
  let cleaned = false;
  return {
    snapshot: {
      transport: "spool",
      metadata: Object.freeze({
        sizeBytes: bytes.byteLength,
        sha256: "0".repeat(64),
        candidateFormat: "unknown",
        protection: "unknown",
      }),
      takeSpoolHandle(): Readonly<{ fd: number; sizeBytes: number }> {
        if (taken || cleaned) throw new Error("snapshot already consumed");
        taken = true;
        return Object.freeze({ fd, sizeBytes: bytes.byteLength });
      },
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        closeSync(fd);
        rmSync(root, { recursive: true, force: true });
      },
    },
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function largeNoisePng(): Promise<Buffer> {
  largeNoisePngPromise ??= (async () => {
    const width = 2_048;
    const height = 1_536;
    const pixels = Buffer.allocUnsafe(width * height * 4);
    randomFillSync(pixels);
    const png = await sharp(pixels, {
      raw: { width, height, channels: 4 },
    }).png().toBuffer();
    assert.ok(png.byteLength > 8 * 1024 * 1024);
    assert.ok(png.byteLength < 25 * 1024 * 1024);
    return png;
  })();
  return largeNoisePngPromise;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  return exact.buffer;
}

async function protectedHwpx(
  source: ArrayBuffer,
  protection: "signed" | "encrypted" | "drm",
): Promise<Uint8Array> {
  const archive = await JSZip.loadAsync(source);
  if (protection === "signed") {
    archive.file("_xmlsignatures/sig1.xml", "<Signature/>");
  } else {
    const element = protection === "encrypted" ? "encryption-data" : "drm";
    archive.file("META-INF/manifest.xml", `<manifest><${element}/></manifest>`);
  }
  return archive.generateAsync({ type: "uint8array" });
}

async function invalidProtectionHwpx(source: ArrayBuffer): Promise<Uint8Array> {
  const archive = await JSZip.loadAsync(source);
  archive.file("META-INF/manifest.xml", "<manifest/>");
  archive.file("meta-inf/MANIFEST.XML", "<manifest/>");
  return archive.generateAsync({ type: "uint8array" });
}

function syntheticHwpWithFlags(flags: number, headerLength = 256): Uint8Array {
  const container = CFB.utils.cfb_new();
  const header = Buffer.alloc(headerLength);
  if (headerLength >= 17) header.write("HWP Document File", 0, "ascii");
  if (headerLength >= 36) header.writeUInt32LE(0x05000302, 32);
  if (headerLength >= 40) header.writeUInt32LE(flags, 36);
  CFB.utils.cfb_add(container, "FileHeader", header);
  return Uint8Array.from(CFB.write(container, { type: "buffer" }) as Buffer);
}

async function runChildReadOnly(
  child: ReturnType<typeof createBuiltChildClient>,
  operation: "parse" | "render",
  bytes: Uint8Array,
): Promise<DocumentResultPayload<"parse"> | DocumentResultPayload<"render">> {
  const owned = spoolSnapshot(bytes);
  try {
    return await child.run(request(operation), owned.snapshot) as
      DocumentResultPayload<"parse"> | DocumentResultPayload<"render">;
  } finally {
    owned.cleanup();
  }
}

function hasEngineCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}
