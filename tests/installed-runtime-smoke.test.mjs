import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const smokeModule = await import("../scripts/installed-runtime-smoke.mjs").catch(() => ({}));
const EXACT_RUNTIME_ARGS = Object.freeze(["--max-semi-space-size=1", "./dist/mcp.js"]);
const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const CATALOG = JSON.parse(await readFile(join(ROOT, "plugins", "gpt-codex-hwp", "examples", "oneshot-tool-schemas.json"), "utf8"));

function toolList() {
  return Object.entries(CATALOG.tools).map(([name, schema]) => ({
    name,
    inputSchema: structuredClone(schema),
  }));
}

async function writeManualMcpManifest(runtimeRoot, serialized) {
  await mkdir(join(runtimeRoot, "examples"), { recursive: true });
  await writeFile(join(runtimeRoot, "examples", "mcp-manual.json"), serialized);
  await writeFile(join(runtimeRoot, "examples", "oneshot-tool-schemas.json"), JSON.stringify(CATALOG));
}

test("installed runtime smoke validates the exact nine names and schema surface", () => {
  assert.equal(typeof smokeModule.assertExactToolSchemas, "function");
  assert.doesNotThrow(() => smokeModule.assertExactToolSchemas(toolList(), CATALOG));
  const changed = toolList();
  changed[0] = {
    ...changed[0],
    inputSchema: { ...changed[0].inputSchema, properties: { broad: { type: "string" } } },
  };
  assert.throws(() => smokeModule.assertExactToolSchemas(changed, CATALOG), /schema/iu);
});

test("schema catalog rejects scalar, enum, nested-item, limit, and extra-key drift", () => {
  const mutations = [
    (tools) => { tools[1].inputSchema.properties.file_path.type = "integer"; },
    (tools) => { tools[3].inputSchema.properties.preset.enum[0] = "drift"; },
    (tools) => { tools[7].inputSchema.properties.highlight.items.type = "number"; },
    (tools) => { tools[2].inputSchema.properties.fields.additionalProperties.anyOf[1].items.type = "number"; },
    (tools) => { tools[0].inputSchema.properties.prompt_or_spec.maxLength = 999999; },
    (tools) => { tools[8].inputSchema.unevaluatedProperties = false; },
    (tools) => { tools[0].inputSchema.properties.description = { type: "string" }; },
  ];
  for (const mutate of mutations) {
    const tools = toolList();
    mutate(tools);
    assert.throws(() => smokeModule.assertExactToolSchemas(tools, CATALOG), /schema/iu);
  }
});

test("schema catalog deliberately excludes non-contract description prose", () => {
  const tools = toolList();
  tools[1].inputSchema.description = "Changed top-level prose.";
  tools[1].inputSchema.properties.file_path.description = "Changed field prose.";
  assert.doesNotThrow(() => smokeModule.assertExactToolSchemas(tools, CATALOG));
});

test("schema catalog retains own enumerable __proto__ schema keys", () => {
  for (const target of [
    (tools) => tools[0].inputSchema,
    (tools) => tools[0].inputSchema.properties,
  ]) {
    const tools = toolList();
    Object.defineProperty(target(tools), "__proto__", {
      configurable: true,
      enumerable: true,
      value: { type: "string" },
      writable: true,
    });
    assert.throws(() => smokeModule.assertExactToolSchemas(tools, CATALOG), /schema/iu);
  }
});

test("installed runtime smoke encodes the allowed root as the runtime's exact JSON contract", () => {
  assert.deepEqual(smokeModule.createRuntimeSessionEnvironment("C:\\bounded-root"), {
    GPT_CODEX_HWP_ALLOWED_ROOTS: "[\"C:\\\\bounded-root\"]",
  });
});

test("default installed runtime smoke invokes the real compiled one-shot and verifies bounded cleanup", async () => {
  assert.equal(typeof smokeModule.runInstalledOneShotSmoke, "function");
  let output = "";
  const receipt = await smokeModule.runInstalledOneShotSmoke({
    stdout: { write(value) { output += value; return true; } },
    setExitCode(code) { assert.equal(code, 0); },
  });

  assert.ok(receipt.hwpxBytes > 4);
  assert.equal(receipt.remainingDescendantCount, 0);
  assert.match(output, /^RUNTIME_SMOKE status=passed tools=9 hwpxBytes=\d+ hwpx=passed stderrBytes=0 remainingDescendants=0\n$/u);
});

test("large-document smoke uses the compiled one-shot detect path and proves the source unchanged", async (t) => {
  assert.equal(typeof smokeModule.runInstalledLargeDocumentSmoke, "function");
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-large-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let output = "";
  const receipt = await smokeModule.runInstalledLargeDocumentSmoke({
    sizeMiB: 100,
    createTemporaryRoot: async () => root,
    generateSource: async ({ outputPath, requestedBytes }) => {
      const handle = await open(outputPath, "wx", 0o600);
      await handle.write(Buffer.from("PK\u0003\u0004bounded-large-document-smoke"), 0, undefined, 0);
      await handle.truncate(requestedBytes);
      await handle.close();
    },
    runProcess: async (_tool, args) => {
      const responsePath = args.at(-1);
      await writeFile(responsePath, JSON.stringify({
        isError: false,
        structuredContent: {
          format: "hwpx",
          details: { file_size_bytes: 100 * 1024 * 1024 },
        },
      }), { flag: "wx", mode: 0o600 });
      return {
        code: 0,
        signal: null,
        overflow: false,
        timedOut: false,
        terminationFailed: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          "ONESHOT_CLEANUP proof=registered-groups-empty observedProcessTrees=1 remainingProcessTrees=0\nONESHOT_OK\n",
        ),
        platform: "linux",
      };
    },
    stdout: { write(value) { output += value; return true; } },
    setExitCode() {},
  });

  assert.notEqual(receipt, false, output);
  assert.equal(receipt.requestedMiB, 100);
  assert.equal(receipt.format, "hwpx");
  assert.equal(receipt.sourceUnchanged, true);
  assert.equal(receipt.remainingDescendantCount, 0);
  assert.match(output, /^LARGE_DOCUMENT_SMOKE status=passed requestedMiB=100 actualBytes=\d+ format=hwpx sourceUnchanged=true remainingDescendants=0\n$/u);
});

test("large-document smoke fails closed when detection changes the source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-large-mutated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let output = "";
  const receipt = await smokeModule.runInstalledLargeDocumentSmoke({
    sizeMiB: 100,
    createTemporaryRoot: async () => root,
    generateSource: async ({ outputPath, requestedBytes }) => {
      const handle = await open(outputPath, "wx", 0o600);
      await handle.write(Buffer.from("PK\u0003\u0004bounded-large-document-smoke"), 0, 32, 0);
      await handle.truncate(requestedBytes);
      await handle.close();
    },
    runProcess: async (_tool, args) => {
      const request = JSON.parse(await readFile(args.at(-3), "utf8"));
      const source = await open(request.arguments.file_path, "r+");
      await source.write(Buffer.from([0x78]), 0, 1, 8);
      await source.close();
      await writeFile(args.at(-1), JSON.stringify({
        isError: false,
        structuredContent: {
          format: "hwpx",
          details: { file_size_bytes: 100 * 1024 * 1024 },
        },
      }), { flag: "wx", mode: 0o600 });
      return {
        code: 0,
        signal: null,
        overflow: false,
        timedOut: false,
        terminationFailed: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          "ONESHOT_CLEANUP proof=registered-groups-empty observedProcessTrees=1 remainingProcessTrees=0\nONESHOT_OK\n",
        ),
        platform: "linux",
      };
    },
    stdout: { write(value) { output += value; return true; } },
    setExitCode() {},
  });

  assert.equal(receipt, false);
  assert.equal(output, "LARGE_DOCUMENT_SMOKE status=failed stage=response\n");
});

test("one-shot cleanup rejects a recorded detached identity after the outer group is gone", () => {
  assert.equal(typeof smokeModule.assertOneShotProcessCleanup, "function");
  assert.throws(() => smokeModule.assertOneShotProcessCleanup({
    terminationFailed: false,
    stdout: Buffer.from(
      "ONESHOT_CLEANUP proof=registered-groups-empty observedProcessTrees=1 remainingProcessTrees=1\nONESHOT_OK\n",
    ),
    platform: "linux",
  }), /descendant|identity|cleanup/iu);
});

test("initialization failure emits only the last bounded lifecycle boundary and stderr count", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-initialize-boundary-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");
  let output = "";
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createRuntimeSession: async (_spec, observers) => {
      observers.onInitializeBoundary("process-spawned");
      observers.onStderr(Buffer.alloc(70 * 1024, 0x78));
      throw new Error("private hosted initialization failure");
    },
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(
    output,
    "RUNTIME_SMOKE status=failed stage=initialize boundary=process-spawned stderrBytes=65537\n",
  );
  assert.doesNotMatch(output, /private|hosted initialization|runtime-smoke-initialize-boundary/iu);
});

test("Windows identity snapshots ignore only the non-process PID zero record", () => {
  assert.equal(typeof smokeModule.parseRuntimeProcessTable, "function");
  assert.deepEqual(
    smokeModule.parseRuntimeProcessTable(
      "0,0,134295304540227520\n4,0,134295304540227521\n",
      true,
    ),
    [{ pid: 4, parentPid: 0, identity: "134295304540227521" }],
  );
  assert.throws(
    () => smokeModule.parseRuntimeProcessTable("invalid-private-line\n", true),
    /process table/iu,
  );
});

test("supervisor establishment rejection closes the still-gated owned root before returning", async (t) => {
  assert.equal(typeof smokeModule.createSupervisedStdioTransport, "function");
  const root = await mkdtemp(join(tmpdir(), "runtime-smoke-gated-rejection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "target-started.txt");
  const target = join(root, "target.mjs");
  await writeFile(target, `await import("node:fs/promises").then(({writeFile})=>writeFile(${JSON.stringify(marker)},"started"));setInterval(()=>{},1000);\n`, "utf8");
  const runtimeRoot = join(process.cwd(), "plugins", "gpt-codex-hwp");
  const documentChild = await import(pathToFileURL(join(
    runtimeRoot, "dist", "workers", "document-child-client.js",
  )).href);
  const registration = await import(pathToFileURL(join(
    runtimeRoot, "dist", "workers", "document-process-registration.js",
  )).href);
  let child;
  const boundaries = [];
  class EmptyReadBuffer {
    append() {}
    readMessage() { return null; }
    clear() {}
  }
  const transport = smokeModule.createSupervisedStdioTransport({
    spec: { command: process.execPath, args: [target], cwd: runtimeRoot, allowedRoot: root },
    ReadBuffer: EmptyReadBuffer,
    serializeMessage: (message) => `${JSON.stringify(message)}\n`,
    superviseProcessTree: async () => { throw new Error("private supervisor rejection"); },
    observeChildProcessClose: documentChild.observeChildProcessClose,
    terminateGatedChildByHandle: documentChild.terminateGatedChildByHandle,
    startGateEntry: join(runtimeRoot, "dist", "workers", "document-child-start-gate.js"),
    startFrame: registration.DOCUMENT_START_FRAME,
    registrationEnvironmentVariable: registration.DOCUMENT_REGISTRATION_ENV,
    onInitializeBoundary(boundary) { boundaries.push(boundary); },
    spawnProcess(command, args, options) {
      child = spawn(command, args, options);
      return child;
    },
  });
  await assert.rejects(transport.start(), /supervisor|cleanup/iu);
  assert.ok(child !== undefined);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(await readFile(marker).catch(() => undefined), undefined);
  assert.deepEqual(boundaries, ["process-spawned"]);
});

test("MCP stdout budget rejects per-frame and aggregate overflow before buffering", () => {
  assert.equal(typeof smokeModule.createMcpStdoutBudget, "function");
  const frameBudget = smokeModule.createMcpStdoutBudget({
    maximumAggregateBytes: 32,
    maximumFrameBytes: 5,
  });
  assert.doesNotThrow(() => frameBudget.consume(Buffer.from("1234\n")));
  assert.throws(() => frameBudget.consume(Buffer.from("123456")), /stdout|frame|bound/iu);

  const aggregateBudget = smokeModule.createMcpStdoutBudget({
    maximumAggregateBytes: 8,
    maximumFrameBytes: 5,
  });
  assert.doesNotThrow(() => aggregateBudget.consume(Buffer.from("{}\n{}\n")));
  assert.throws(() => aggregateBudget.consume(Buffer.from("{}\n")), /stdout|aggregate|bound/iu);
});

test("over-limit MCP stdout emits one fixed initialization failure and closes the supervised root", async (t) => {
  assert.equal(typeof smokeModule.createDefaultRuntimeSession, "function");
  const root = await mkdtemp(join(tmpdir(), "runtime-smoke-stdout-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "oversized-stdout.mjs");
  await writeFile(
    target,
    "process.stdout.write(Buffer.alloc(1024*1024,0x78));setInterval(()=>{},1000);\n",
    "utf8",
  );
  const runtimeRoot = join(process.cwd(), "plugins", "gpt-codex-hwp");
  let child;
  let output = "";
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createRuntimeSession: (spec, observers) => smokeModule.createDefaultRuntimeSession(
      { ...spec, args: [target] },
      observers,
      {
        spawnProcess(command, args, options) {
          child = spawn(command, args, options);
          return child;
        },
      },
    ),
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.ok(child !== undefined);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(
    output,
    "RUNTIME_SMOKE status=failed stage=initialize boundary=gate-released stderrBytes=1019\n",
  );
  assert.doesNotMatch(output, /oversized-stdout|runtime-smoke-stdout-limit|private/iu);
});

test("owned temporary-root validation accepts a canonicalized ancestor alias", async () => {
  const rawParent = join(tmpdir(), "ancestor-alias");
  const canonicalParent = join(tmpdir(), "canonical-ancestor");
  const root = join(rawParent, "gpt-codex-hwp-runtime-smoke-alias-case");
  const canonicalRoot = join(canonicalParent, "gpt-codex-hwp-runtime-smoke-alias-case");
  assert.equal(await smokeModule.assertOwnedTemporaryRoot(root, {
    temporaryParent: rawParent,
    lstatPath: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    realpathPath: async (path) => path === root
      ? canonicalRoot
      : canonicalParent,
  }), canonicalRoot);
});

test("installed runtime smoke uses the exact manifest command and one bounded Sharp PNG path", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-fixture-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await mkdir(join(runtimeRoot, "dist"));
  await writeFile(join(runtimeRoot, "dist", "mcp.js"), "", "utf8");
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");

  let sessionSpec;
  let assetArguments;
  let output = "";
  let exitCode;
  let ownedRoot;
  const report = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createTemporaryRoot: async () => {
      ownedRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-owned-"));
      return ownedRoot;
    },
    createRuntimeSession: async (spec) => {
      sessionSpec = spec;
      return {
        pid: 701,
        listTools: async () => ({ tools: toolList() }),
        callTool: async ({ name, arguments: args }) => {
          assert.equal(name, "hwp_create_svg_asset");
          assetArguments = args;
          await writeFile(args.output_svg_path, args.prompt_or_spec, "utf8");
          await writeFile(args.output_png_path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
          return { isError: false, structuredContent: { svg_path: args.output_svg_path, png_path: args.output_png_path, warnings: [] } };
        },
        processIdentities: (() => {
          let calls = 0;
          return async () => ++calls === 1
            ? [{ pid: 701, identity: "root-701" }, { pid: 702, identity: "child-702" }]
            : [
                { pid: 701, identity: "root-701" },
                { pid: 702, identity: "child-702" },
                { pid: 703, identity: "child-703" },
              ];
        })(),
        close: async () => undefined,
        terminateTree: async () => ({ gone: true, proof: "windows-job-empty" }),
        verifyProcessIdentitiesAbsent: async (identities) => ({
          checkedIdentityCount: identities.length,
          remainingIdentityCount: 0,
        }),
      };
    },
    stdout: { write(value) { output += value; } },
    setExitCode(value) { exitCode = value; },
  });

  assert.deepEqual(sessionSpec, {
    command: "node",
    args: EXACT_RUNTIME_ARGS,
    cwd: runtimeRoot,
    allowedRoot: ownedRoot,
  });
  assert.ok(Buffer.byteLength(assetArguments.prompt_or_spec, "utf8") <= 1024);
  assert.equal(assetArguments.output_svg_path.startsWith(`${ownedRoot}\\`) || assetArguments.output_svg_path.startsWith(`${ownedRoot}/`), true);
  assert.equal(assetArguments.output_png_path.startsWith(`${ownedRoot}\\`) || assetArguments.output_png_path.startsWith(`${ownedRoot}/`), true);
  assert.equal(await readFile(assetArguments.output_png_path).catch(() => undefined), undefined);
  assert.equal(report.toolCount, 9);
  assert.equal(report.stderrBytes, 0);
  assert.equal(report.remainingDescendantCount, 0);
  assert.match(output, /^RUNTIME_SMOKE status=passed tools=9 svgBytes=\d+ png=passed stderrBytes=0 remainingDescendants=0\n$/u);
  assert.equal(exitCode, 0);
});

test("installed runtime smoke rejects any manifest command drift before MCP initialization", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-manifest-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "npm", args: ["start"], cwd: "." },
    },
  }), "utf8");
  let sessions = 0;
  let output = "";
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createRuntimeSession: async () => { sessions += 1; },
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(sessions, 0);
  assert.equal(output, "RUNTIME_SMOKE status=failed stage=manifest\n");
});

test("installed runtime smoke verifies root and descendants and removes outputs after call and close failures", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-failure-fixture-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");
  let ownedRoot;
  let supervisorTerminations = 0;
  let output = "";
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createTemporaryRoot: async () => {
      ownedRoot = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-failure-owned-"));
      return ownedRoot;
    },
    createRuntimeSession: async () => ({
      pid: 801,
      listTools: async () => ({ tools: toolList() }),
      callTool: async () => { throw new Error("private call failure"); },
      processIdentities: async () => [
        { pid: 801, identity: "root-801" },
        { pid: 802, identity: "child-802" },
      ],
      close: async () => { throw new Error("private close failure"); },
      terminateTree: async () => {
        supervisorTerminations += 1;
        return { gone: true, proof: "windows-job-empty" };
      },
      verifyProcessIdentitiesAbsent: async (identities) => ({
        checkedIdentityCount: identities.length,
        remainingIdentityCount: 0,
      }),
    }),
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(supervisorTerminations, 1);
  assert.equal(await readFile(join(ownedRoot, "sharp-smoke.svg")).catch(() => undefined), undefined);
  assert.equal(output, "RUNTIME_SMOKE status=failed stage=asset\n");
  assert.doesNotMatch(output, /private|801|802|runtime-smoke-failure/iu);
});

test("list, result, and close failures still take a final snapshot and verify tree termination", async (t) => {
  const cases = [
    { fault: "list", expectedStage: "tools", expectedQueries: 2 },
    { fault: "result", expectedStage: "asset", expectedQueries: 2 },
    { fault: "close", expectedStage: "cleanup", expectedQueries: 3 },
  ];
  for (const { fault, expectedStage, expectedQueries } of cases) {
    const runtimeRoot = await mkdtemp(join(tmpdir(), `runtime-smoke-${fault}-fixture-`));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
      mcpServers: {
        "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
      },
    }), "utf8");
    let descendantQueries = 0;
    let supervisorTerminations = 0;
    let output = "";
    const passed = await smokeModule.runInstalledRuntimeSmoke({
      runtimeRoot,
      createTemporaryRoot: () => mkdtemp(join(tmpdir(), `gpt-codex-hwp-runtime-smoke-${fault}-`)),
      createRuntimeSession: async () => ({
        pid: 43001,
        listTools: async () => {
          if (fault === "list") throw new Error("private list failure");
          return { tools: toolList() };
        },
        callTool: async ({ arguments: args }) => {
          if (fault === "result") return { isError: true, content: [{ type: "text", text: "private" }] };
          await writeFile(args.output_svg_path, args.prompt_or_spec, "utf8");
          await writeFile(args.output_png_path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
          return { isError: false, structuredContent: { svg_path: args.output_svg_path, png_path: args.output_png_path, warnings: [] } };
        },
        processIdentities: async () => {
          descendantQueries += 1;
          return [
            { pid: 43001, identity: "root-43001" },
            { pid: 43002, identity: "child-43002" },
          ];
        },
        close: async () => {
          if (fault === "close") throw new Error("private close failure");
        },
        terminateTree: async () => {
          supervisorTerminations += 1;
          return {
            gone: true,
            proof: "registered-groups-empty",
            registeredIdentityCount: 2,
            remainingIdentityCount: 0,
          };
        },
        verifyProcessIdentitiesAbsent: async (identities) => ({
          checkedIdentityCount: identities.length,
          remainingIdentityCount: 0,
        }),
      }),
      stdout: { write(value) { output += value; } },
      setExitCode() {},
    });
    assert.equal(passed, false, fault);
    assert.equal(descendantQueries, expectedQueries, fault);
    assert.equal(supervisorTerminations, 1, fault);
    assert.equal(output, `RUNTIME_SMOKE status=failed stage=${expectedStage}\n`, fault);
    assert.doesNotMatch(output, /private|43001|43002|runtime-smoke/iu, fault);
  }
});

test("call failure still captures a late descendant and invokes verified supervisor termination", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-late-fixture-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");
  let descendantQueries = 0;
  let supervisorTerminations = 0;
  let output = "";
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createTemporaryRoot: () => mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-late-")),
    createRuntimeSession: async () => ({
      pid: 41001,
      listTools: async () => ({ tools: toolList() }),
      callTool: async () => { throw new Error("private call failure after spawn"); },
      processIdentities: async () => ++descendantQueries === 1
        ? [{ pid: 41001, identity: "root-41001" }]
        : [
            { pid: 41001, identity: "root-41001" },
            { pid: 41002, identity: "late-41002" },
          ],
      close: async () => { throw new Error("private close failure"); },
      terminateTree: async () => {
        supervisorTerminations += 1;
        return {
          gone: true,
          proof: "registered-groups-empty",
          registeredIdentityCount: 2,
          remainingIdentityCount: 0,
        };
      },
      verifyProcessIdentitiesAbsent: async (identities) => ({
        checkedIdentityCount: identities.length,
        remainingIdentityCount: 0,
      }),
    }),
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(descendantQueries, 2);
  assert.equal(supervisorTerminations, 1);
  assert.equal(output, "RUNTIME_SMOKE status=failed stage=asset\n");
  assert.doesNotMatch(output, /private|41001|41002|runtime-smoke-late/iu);
});

test("unverified supervisor termination fails closed without leaking identity details", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-unverified-fixture-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");
  let output = "";
  let supervisorTerminations = 0;
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createTemporaryRoot: () => mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-unverified-")),
    createRuntimeSession: async () => ({
      pid: 42001,
      listTools: async () => ({ tools: toolList() }),
      callTool: async ({ arguments: args }) => {
        await writeFile(args.output_svg_path, args.prompt_or_spec, "utf8");
        await writeFile(args.output_png_path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        return { isError: false, structuredContent: { svg_path: args.output_svg_path, png_path: args.output_png_path, warnings: [] } };
      },
      processIdentities: async () => [
        { pid: 42001, identity: "root-42001" },
        { pid: 42002, identity: "child-42002" },
      ],
      close: async () => undefined,
      terminateTree: async () => {
        supervisorTerminations += 1;
        return {
          gone: false,
          proof: "unverified",
          reason: "identity",
          registeredIdentityCount: 2,
          remainingIdentityCount: 1,
        };
      },
      verifyProcessIdentitiesAbsent: async (identities) => ({
        checkedIdentityCount: identities.length,
        remainingIdentityCount: 0,
      }),
    }),
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(supervisorTerminations, 1);
  assert.equal(output, "RUNTIME_SMOKE status=failed stage=cleanup\n");
  assert.doesNotMatch(output, /identity|42001|42002|runtime-smoke-unverified/iu);
});

test("a valid supervisor receipt cannot hide a captured surviving identity", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-survivor-fixture-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");
  let output = "";
  let checkedIdentities = 0;
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createTemporaryRoot: () => mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-survivor-")),
    createRuntimeSession: async () => ({
      pid: 44001,
      listTools: async () => ({ tools: toolList() }),
      callTool: async ({ arguments: args }) => {
        await writeFile(args.output_svg_path, args.prompt_or_spec, "utf8");
        await writeFile(args.output_png_path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        return { isError: false, structuredContent: { svg_path: args.output_svg_path, png_path: args.output_png_path, warnings: [] } };
      },
      processIdentities: async () => [
        { pid: 44001, identity: "root-start" },
        { pid: 44002, identity: "escaped-start" },
      ],
      close: async () => undefined,
      terminateTree: async () => ({ gone: true, proof: "windows-job-empty" }),
      verifyProcessIdentitiesAbsent: async (identities) => {
        checkedIdentities = identities.length;
        return { checkedIdentityCount: identities.length, remainingIdentityCount: 1 };
      },
    }),
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(checkedIdentities, 2);
  assert.equal(output, "RUNTIME_SMOKE status=failed stage=cleanup\n");
  assert.doesNotMatch(output, /remainingDescendants=0|44001|44002|escaped-start/iu);
});

test("initialized cleanup rejects a gated-root-only receipt and an inventory missing its root", async (t) => {
  for (const fault of ["gated-receipt", "missing-root"]) {
    const runtimeRoot = await mkdtemp(join(tmpdir(), `runtime-smoke-${fault}-fixture-`));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
      mcpServers: {
        "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
      },
    }), "utf8");
    let output = "";
    const passed = await smokeModule.runInstalledRuntimeSmoke({
      runtimeRoot,
      createTemporaryRoot: () => mkdtemp(join(tmpdir(), `gpt-codex-hwp-runtime-smoke-${fault}-`)),
      createRuntimeSession: async () => ({
        pid: 44501,
        listTools: async () => ({ tools: toolList() }),
        callTool: async ({ arguments: args }) => {
          await writeFile(args.output_svg_path, args.prompt_or_spec, "utf8");
          await writeFile(args.output_png_path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
          return { isError: false, structuredContent: { svg_path: args.output_svg_path, png_path: args.output_png_path, warnings: [] } };
        },
        processIdentities: async () => fault === "missing-root"
          ? [{ pid: 44502, identity: "child-only" }]
          : [{ pid: 44501, identity: "root-44501" }],
        close: async () => undefined,
        terminateTree: async () => fault === "gated-receipt"
          ? { gone: true, proof: "gated-root-closed" }
          : { gone: true, proof: "windows-job-empty" },
        verifyProcessIdentitiesAbsent: async (identities) => ({
          checkedIdentityCount: identities.length,
          remainingIdentityCount: 0,
        }),
      }),
      stdout: { write(value) { output += value; } },
      setExitCode() {},
    });
    assert.equal(passed, false, fault);
    assert.equal(
      output,
      fault === "missing-root"
        ? "RUNTIME_SMOKE status=failed stage=initialize boundary=process-inventory stderrBytes=0\n"
        : "RUNTIME_SMOKE status=failed stage=cleanup\n",
      fault,
    );
  }
});

test("bounded asset reads reject oversized regular files before allocating their contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-smoke-bounded-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oversized = join(root, "oversized.bin");
  await writeFile(oversized, Buffer.alloc(1_025));
  assert.equal(typeof smokeModule.readBoundedRegularFile, "function");
  await assert.rejects(
    smokeModule.readBoundedRegularFile(oversized, 1_024),
    /bound|size/iu,
  );
});

test("oversized SVG and PNG outputs emit only fixed asset failures and still verify cleanup", async (t) => {
  for (const kind of ["svg", "png"]) {
    const runtimeRoot = await mkdtemp(join(tmpdir(), `runtime-smoke-${kind}-limit-fixture-`));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
      mcpServers: {
        "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
      },
    }), "utf8");
    let output = "";
    let terminations = 0;
    let identityChecks = 0;
    const passed = await smokeModule.runInstalledRuntimeSmoke({
      runtimeRoot,
      createTemporaryRoot: () => mkdtemp(join(tmpdir(), `gpt-codex-hwp-runtime-smoke-${kind}-limit-`)),
      createRuntimeSession: async () => ({
        pid: 45001,
        listTools: async () => ({ tools: toolList() }),
        callTool: async ({ arguments: args }) => {
          await writeFile(
            args.output_svg_path,
            kind === "svg" ? Buffer.alloc(1_025, 0x78) : Buffer.from("<svg/>", "utf8"),
          );
          const png = kind === "png"
            ? Buffer.alloc(16 * 1_024 + 1)
            : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          if (kind === "png") {
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
          }
          await writeFile(args.output_png_path, png);
          return { isError: false, structuredContent: { svg_path: args.output_svg_path, png_path: args.output_png_path, warnings: [] } };
        },
        processIdentities: async () => [{ pid: 45001, identity: "asset-root" }],
        close: async () => undefined,
        terminateTree: async () => {
          terminations += 1;
          return { gone: true, proof: "windows-job-empty" };
        },
        verifyProcessIdentitiesAbsent: async (identities) => {
          identityChecks += 1;
          return { checkedIdentityCount: identities.length, remainingIdentityCount: 0 };
        },
      }),
      stdout: { write(value) { output += value; } },
      setExitCode() {},
    });
    assert.equal(passed, false, kind);
    assert.equal(terminations, 1, kind);
    assert.equal(identityChecks, 1, kind);
    assert.equal(output, "RUNTIME_SMOKE status=failed stage=asset\n", kind);
    assert.doesNotMatch(output, /45001|asset-root|runtime-smoke|oversized/iu, kind);
  }
});

test("installed runtime smoke refuses an unowned temporary root without deleting it", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-unowned-fixture-"));
  const unownedRoot = await mkdtemp(join(tmpdir(), "unowned-runtime-smoke-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  t.after(() => rm(unownedRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");
  let sessions = 0;
  let output = "";
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createTemporaryRoot: async () => unownedRoot,
    createRuntimeSession: async () => { sessions += 1; },
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(sessions, 0);
  assert.equal((await lstat(unownedRoot)).isDirectory(), true);
  assert.equal(output, "RUNTIME_SMOKE status=failed stage=temporary-root\n");
});

test("installed runtime smoke rejects schema drift before a tool call with a fixed stage", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-schema-fixture-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");
  let calls = 0;
  let output = "";
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createTemporaryRoot: () => mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-schema-")),
    createRuntimeSession: async () => ({
      pid: 901,
      listTools: async () => ({ tools: toolList().slice(0, 8) }),
      callTool: async () => { calls += 1; },
      processIdentities: async () => [{ pid: 901, identity: "root-901" }],
      close: async () => undefined,
      terminateTree: async () => ({ gone: true, proof: "windows-job-empty" }),
      verifyProcessIdentitiesAbsent: async (identities) => ({
        checkedIdentityCount: identities.length,
        remainingIdentityCount: 0,
      }),
    }),
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal(calls, 0);
  assert.equal(output, "RUNTIME_SMOKE status=failed stage=tools\n");
});

test("installed runtime smoke rejects a linked temporary-root alias without deleting its target", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "runtime-smoke-link-fixture-"));
  const target = await mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-link-target-"));
  const alias = join(tmpdir(), `gpt-codex-hwp-runtime-smoke-link-${randomUUID()}`);
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  t.after(() => rm(alias, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));
  try {
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("Directory-link creation is unavailable.");
    return;
  }
  await writeManualMcpManifest(runtimeRoot, JSON.stringify({
    mcpServers: {
      "gpt-codex-hwp": { command: "node", args: EXACT_RUNTIME_ARGS, cwd: "." },
    },
  }), "utf8");
  let output = "";
  const passed = await smokeModule.runInstalledRuntimeSmoke({
    runtimeRoot,
    createTemporaryRoot: async () => alias,
    createRuntimeSession: async () => { throw new Error("must not initialize"); },
    stdout: { write(value) { output += value; } },
    setExitCode() {},
  });
  assert.equal(passed, false);
  assert.equal((await lstat(target)).isDirectory(), true);
  assert.equal(output, "RUNTIME_SMOKE status=failed stage=temporary-root\n");
});
