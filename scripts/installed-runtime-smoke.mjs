import { execFile as nativeExecFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(nativeExecFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RUNTIME_ROOT = resolve(PROJECT_ROOT, "plugins/gpt-codex-hwp");
const ALLOWED_ROOTS_ENVIRONMENT_VARIABLE = "GPT_CODEX_HWP_ALLOWED_ROOTS";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_MCP_STDOUT_BYTES = 512 * 1024;
const MAX_MCP_FRAME_BYTES = 128 * 1024;
const MAX_SVG_BYTES = 1024;
const MAX_PNG_BYTES = 16 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG_INPUT = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#000"/></svg>';
const INITIALIZE_BOUNDARIES = new Set([
  "session-create",
  "runtime-imports",
  "transport-created",
  "process-spawned",
  "supervisor-ready",
  "gate-released",
  "mcp-connected",
  "process-inventory",
]);

export const RUNTIME_TOOL_SCHEMA_FINGERPRINTS = Object.freeze({
  hwp_detect_format: "1a645a175df1695f59f8e1c38320c270a1a851ef88b74fb7cbdce7dd076b3906",
  hwp_read: "cb9c5a8f36c234c0faa85e46edcd2470b9af69adde265e03f9472caa2b7523de",
  hwp_generate_hwpx: "517de4d6704483924191a24b2dfcde918219aa34cd29adac96afc3604bbe964e",
  hwp_validate: "1a645a175df1695f59f8e1c38320c270a1a851ef88b74fb7cbdce7dd076b3906",
  hwp_render_preview: "c03bcba38861cae0af3d444078f395d8f9187125b6f1633ce688b6507034af07",
  hwp_patch_document: "e5627927b65838bd2080b3a268e9d4472cf4f73d9677c37981766ada631f21ee",
  hwp_fill_form: "a57442c1b00a1af26197b301374edb1fe24271e1a2740822a79edff89a49ee39",
  hwp_create_svg_asset: "e5ff17677192ffdc0b5107ba35d3da312f2359d08004af68006df1c1586e0f02",
  hwp_insert_image: "30113ddf59786dcb82f444b9cfa072426d974f4d6d2590975009f12ed9f03f5c",
});

export function assertExactToolSchemas(tools) {
  if (!Array.isArray(tools)) throw new Error("Runtime tools schema response is invalid.");
  const names = Object.keys(RUNTIME_TOOL_SCHEMA_FINGERPRINTS);
  if (tools.length !== names.length
    || tools.some((tool, index) => tool?.name !== names[index])) {
    throw new Error("Runtime tools do not match the exact nine-tool schema contract.");
  }
  for (const tool of tools) {
    if (schemaFingerprint(tool.inputSchema) !== RUNTIME_TOOL_SCHEMA_FINGERPRINTS[tool.name]) {
      throw new Error(`Runtime tool ${tool.name} has an invalid exact schema contract.`);
    }
  }
}

export function schemaFingerprint(schema) {
  const state = { nodes: 0 };
  const canonical = JSON.stringify(canonicalSchemaValue(schema, state, 0, "schema"));
  if (Buffer.byteLength(canonical, "utf8") > 64 * 1024) {
    throw new Error("Runtime tool schema exceeds its canonical bound.");
  }
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalSchemaValue(value, state, depth, mode) {
  state.nodes += 1;
  if (state.nodes > 2_048 || depth > 16) throw new Error("Runtime tool schema exceeds its structural bound.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const entryMode = mode === "schema-list" ? "schema" : mode;
    return value.map((entry) => canonicalSchemaValue(entry, state, depth + 1, entryMode));
  }
  if (typeof value !== "object") throw new Error("Runtime tool schema contains a non-JSON value.");
  const result = Object.create(null);
  const keys = Object.keys(value).filter((key) => mode !== "schema" || key !== "description").sort();
  for (const key of keys) {
    let childMode = mode;
    if (mode === "schema") {
      if (["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"].includes(key)) {
        childMode = "schema-map";
      } else if (["allOf", "anyOf", "oneOf"].includes(key)) {
        childMode = "schema-list";
      } else if (["const", "default", "enum", "examples"].includes(key)) {
        childMode = "data";
      }
    } else if (mode === "schema-map") {
      childMode = "schema";
    }
    result[key] = canonicalSchemaValue(value[key], state, depth + 1, childMode);
  }
  return result;
}

export function createRuntimeSessionEnvironment(allowedRoot) {
  if (typeof allowedRoot !== "string" || allowedRoot.length === 0) {
    throw new Error("Runtime allowed root is invalid.");
  }
  return { [ALLOWED_ROOTS_ENVIRONMENT_VARIABLE]: JSON.stringify([allowedRoot]) };
}

export async function runInstalledRuntimeSmoke(options = {}) {
  const runtimeRoot = resolve(options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT);
  const stdout = options.stdout ?? process.stdout;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  const createTemporaryRoot = options.createTemporaryRoot
    ?? (() => mkdtemp(join(tmpdir(), "gpt-codex-hwp-runtime-smoke-")));
  const createRuntimeSession = options.createRuntimeSession ?? createDefaultRuntimeSession;
  let stage = "manifest";
  let ownedRoot;
  let cleanupRoot;
  let session;
  let stderrBytes = 0;
  let initializeBoundary = "session-create";
  let processIdentities = [];
  let report;
  let failure;
  try {
    const command = await readExactManifestCommand(runtimeRoot);
    stage = "temporary-root";
    const requestedRoot = resolve(await createTemporaryRoot());
    ownedRoot = await assertOwnedTemporaryRoot(requestedRoot);
    cleanupRoot = ownedRoot;
    const svgPath = join(ownedRoot, "sharp-smoke.svg");
    const pngPath = join(ownedRoot, "sharp-smoke.png");
    assertPathInside(ownedRoot, svgPath);
    assertPathInside(ownedRoot, pngPath);

    stage = "initialize";
    session = await createRuntimeSession({
      command: command.command,
      args: command.args,
      cwd: runtimeRoot,
      allowedRoot: ownedRoot,
    }, {
      onStderr(chunk) {
        stderrBytes = Buffer.isBuffer(chunk)
          ? Math.min(MAX_STDERR_BYTES + 1, stderrBytes + chunk.byteLength)
          : MAX_STDERR_BYTES + 1;
      },
      onInitializeBoundary(boundary) {
        if (INITIALIZE_BOUNDARIES.has(boundary)) initializeBoundary = boundary;
      },
    });
    initializeBoundary = "process-inventory";
    if (!Number.isSafeInteger(session?.pid) || session.pid < 1) {
      throw new Error("Runtime MCP process identity is invalid.");
    }
    processIdentities = mergeProcessIdentities(
      processIdentities,
      assertProcessIdentityInventory(await session.processIdentities(), session.pid),
    );

    stage = "tools";
    const listed = await session.listTools();
    assertExactToolSchemas(listed?.tools);

    stage = "asset";
    if (Buffer.byteLength(SVG_INPUT, "utf8") > MAX_SVG_BYTES) {
      throw new Error("Runtime smoke SVG input exceeds its bound.");
    }
    const result = await session.callTool({
      name: "hwp_create_svg_asset",
      arguments: {
        prompt_or_spec: SVG_INPUT,
        output_svg_path: svgPath,
        output_png_path: pngPath,
      },
    });
    assertAssetResult(result, svgPath, pngPath);
    const svg = await readBoundedRegularFile(svgPath, MAX_SVG_BYTES);
    const png = await readBoundedRegularFile(pngPath, MAX_PNG_BYTES);
    if (png.byteLength < PNG_SIGNATURE.byteLength
      || !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
      throw new Error("Runtime Sharp PNG output is invalid.");
    }
    processIdentities = mergeProcessIdentities(
      processIdentities,
      assertProcessIdentityInventory(await session.processIdentities(), session.pid),
    );
    report = {
      toolCount: Object.keys(RUNTIME_TOOL_SCHEMA_FINGERPRINTS).length,
      svgBytes: svg.byteLength,
      stderrBytes,
      remainingDescendantCount: -1,
    };
  } catch {
    failure = stage;
  } finally {
    stage = "cleanup";
    if (session !== undefined) {
      try {
        processIdentities = mergeProcessIdentities(
          processIdentities,
          assertProcessIdentityInventory(await session.processIdentities(), session.pid),
        );
      } catch { failure ??= stage; }
      try { await session.close(); } catch { failure ??= stage; }
      try {
        assertVerifiedTerminationReceipt(await session.terminateTree());
      } catch { failure ??= stage; }
      try {
        const identityReceipt = assertIdentityAbsenceReceipt(
          await session.verifyProcessIdentitiesAbsent(processIdentities),
          processIdentities.length,
        );
        if (report !== undefined) {
          report.remainingDescendantCount = identityReceipt.remainingIdentityCount;
        }
        if (identityReceipt.remainingIdentityCount !== 0) failure ??= stage;
      } catch { failure ??= stage; }
    }
    if (stderrBytes !== 0) failure ??= "stderr";
    if (cleanupRoot !== undefined) {
      try {
        await rm(cleanupRoot, { recursive: true, force: true });
        await lstat(cleanupRoot).then(
          () => { throw new Error("temporary root remains"); },
          (error) => { if (error?.code !== "ENOENT") throw error; },
        );
      } catch { failure ??= stage; }
    }
  }

  if (failure !== undefined || report === undefined) {
    const diagnostic = failure === "initialize"
      ? ` boundary=${initializeBoundary} stderrBytes=${stderrBytes}`
      : "";
    stdout.write(`RUNTIME_SMOKE status=failed stage=${failure ?? "unknown"}${diagnostic}\n`);
    setExitCode(1);
    return false;
  }
  stdout.write(
    `RUNTIME_SMOKE status=passed tools=${report.toolCount} svgBytes=${report.svgBytes} png=passed stderrBytes=${report.stderrBytes} remainingDescendants=${report.remainingDescendantCount}\n`,
  );
  setExitCode(0);
  return Object.freeze(report);
}

async function readExactManifestCommand(runtimeRoot) {
  const manifest = JSON.parse(await readFile(join(runtimeRoot, ".mcp.json"), "utf8"));
  const servers = manifest?.mcpServers;
  const names = servers !== null && typeof servers === "object" ? Object.keys(servers) : [];
  const server = names.length === 1 && names[0] === "gpt-codex-hwp"
    ? servers["gpt-codex-hwp"]
    : undefined;
  if (server?.command !== "node" || !sameStrings(server.args, ["./dist/mcp.js"])
    || server.cwd !== "." || Object.keys(server).sort().join(",") !== "args,command,cwd") {
    throw new Error("Runtime MCP manifest command is invalid.");
  }
  return Object.freeze({ command: "node", args: Object.freeze(["./dist/mcp.js"]) });
}

export async function createDefaultRuntimeSession(spec, observers = {}, dependencies = {}) {
  const [{ Client }, stdio, documentChild, registration] = await Promise.all([
    import(pathToFileURL(join(
      spec.cwd,
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    )).href),
    import(pathToFileURL(join(
      spec.cwd,
      "node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js",
    )).href),
    import(pathToFileURL(join(
      spec.cwd,
      "dist/workers/document-child-client.js",
    )).href),
    import(pathToFileURL(join(
      spec.cwd,
      "dist/workers/document-process-registration.js",
    )).href),
  ]);
  emitInitializeBoundary(observers.onInitializeBoundary, "runtime-imports");
  const transport = createSupervisedStdioTransport({
    spec,
    ReadBuffer: stdio.ReadBuffer,
    serializeMessage: stdio.serializeMessage,
    superviseProcessTree: documentChild.superviseDocumentProcessTree,
    observeChildProcessClose: documentChild.observeChildProcessClose,
    terminateGatedChildByHandle: documentChild.terminateGatedChildByHandle,
    startGateEntry: join(spec.cwd, "dist/workers/document-child-start-gate.js"),
    startFrame: registration.DOCUMENT_START_FRAME,
    registrationEnvironmentVariable: registration.DOCUMENT_REGISTRATION_ENV,
    spawnProcess: dependencies.spawnProcess,
    onStderr: observers.onStderr,
    onInitializeBoundary: observers.onInitializeBoundary,
  });
  emitInitializeBoundary(observers.onInitializeBoundary, "transport-created");
  const client = new Client({ name: "gpt-codex-hwp-runtime-smoke", version: "1" });
  try {
    await client.connect(transport);
    emitInitializeBoundary(observers.onInitializeBoundary, "mcp-connected");
  } catch (error) {
    let terminationVerified = false;
    try {
      assertVerifiedTerminationReceipt(await transport.terminateTree(), true);
      terminationVerified = true;
    } catch {}
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (!terminationVerified) {
      throw new Error("Runtime MCP supervised process cleanup could not be verified.");
    }
    throw error;
  }
  return {
    get pid() { return transport.pid; },
    listTools: () => client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS }),
    callTool: (request) => client.callTool(request, undefined, { timeout: REQUEST_TIMEOUT_MS }),
    processIdentities: () => snapshotRuntimeProcessIdentities(
      transport.pid,
      documentChild.snapshotRegisteredPosixProcessGroupIdentity,
    ),
    verifyProcessIdentitiesAbsent: (identities) => verifyRuntimeProcessIdentitiesAbsent(
      identities,
      documentChild.snapshotRegisteredPosixProcessGroupIdentity,
    ),
    close: () => client.close(),
    terminateTree: () => transport.terminateTree(),
  };
}

export function createSupervisedStdioTransport({
  spec,
  ReadBuffer,
  serializeMessage,
  superviseProcessTree,
  observeChildProcessClose,
  terminateGatedChildByHandle,
  startGateEntry,
  startFrame,
  registrationEnvironmentVariable,
  spawnProcess = spawn,
  onStderr,
  onInitializeBoundary,
}) {
  const readBuffer = new ReadBuffer();
  const stdoutBudget = createMcpStdoutBudget({
    maximumAggregateBytes: MAX_MCP_STDOUT_BYTES,
    maximumFrameBytes: MAX_MCP_FRAME_BYTES,
  });
  let child;
  let gate;
  let supervisor;
  let termination;
  let gatedRootClosed = false;
  let protocolFailure;
  let started = false;
  const closeGate = () => {
    if (gate === undefined) return;
    const current = gate;
    gate = undefined;
    try { current.destroy(); } catch {}
  };
  const transport = {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    get pid() { return child?.pid ?? null; },
    async start() {
      if (started) throw new Error("Runtime transport already started.");
      started = true;
      if (typeof startGateEntry !== "string" || !isAbsolute(startGateEntry)
        || typeof startFrame !== "string" || Buffer.byteLength(startFrame, "utf8") > 64
        || typeof registrationEnvironmentVariable !== "string"
        || !/^[A-Z0-9_]{1,64}$/u.test(registrationEnvironmentVariable)) {
        throw new Error("Runtime start-gate contract is invalid.");
      }
      const target = resolve(spec.cwd, spec.args[0]);
      const args = process.platform === "win32"
        ? ["--import", pathToFileURL(startGateEntry).href, target]
        : [startGateEntry, target];
      child = spawnProcess(spec.command, args, {
        cwd: spec.cwd,
        detached: process.platform !== "win32",
        env: {
          ...defaultRuntimeEnvironment(),
          ...createRuntimeSessionEnvironment(spec.allowedRoot),
          [registrationEnvironmentVariable]: "0",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      const closeReceipt = observeChildProcessClose(child);
      gate = child.stdio?.[7];
      if (gate === null || gate === undefined
        || typeof gate.write !== "function" || typeof gate.destroy !== "function") {
        closeGate();
        if (!await terminateGatedChildByHandle(child, closeReceipt)) {
          throw new Error("Runtime gated root cleanup could not be verified.");
        }
        gatedRootClosed = true;
        termination = Promise.resolve(Object.freeze({ gone: true, proof: "gated-root-closed" }));
        throw new Error("Runtime start-gate pipe is unavailable.");
      }
      const failProtocol = (error) => {
        if (protocolFailure !== undefined) return;
        protocolFailure = error instanceof Error ? error : new Error("Runtime MCP stdout is invalid.");
        try { child.stdout?.destroy(); } catch {}
        try { child.stdin?.destroy(); } catch {}
        try { transport.onerror?.(protocolFailure); } catch {}
        if (supervisor !== undefined) void transport.terminateTree().catch(() => undefined);
      };
      child.stdout?.on("data", (chunk) => {
        try {
          stdoutBudget.consume(chunk);
          readBuffer.append(chunk);
          while (true) {
            const message = readBuffer.readMessage();
            if (message === null) break;
            transport.onmessage?.(message);
          }
        } catch (error) { failProtocol(error); }
      });
      child.stdout?.on("error", (error) => transport.onerror?.(error));
      child.stdin?.on("error", (error) => transport.onerror?.(error));
      child.stderr?.on("data", (chunk) => onStderr?.(chunk));
      child.stderr?.on("error", (error) => transport.onerror?.(error));
      child.once("close", () => {
        closeGate();
        readBuffer.clear();
        transport.onclose?.();
      });
      try {
        await new Promise((resolveStart, rejectStart) => {
          const spawned = () => {
            child.removeListener("error", failed);
            resolveStart();
          };
          const failed = (error) => {
            child.removeListener("spawn", spawned);
            rejectStart(error);
          };
          child.once("spawn", spawned);
          child.once("error", failed);
        });
      } catch (error) {
        closeGate();
        if (!await terminateGatedChildByHandle(child, closeReceipt)) {
          throw new Error("Runtime gated root cleanup could not be verified.");
        }
        gatedRootClosed = true;
        termination = Promise.resolve(Object.freeze({ gone: true, proof: "gated-root-closed" }));
        throw error;
      }
      emitInitializeBoundary(onInitializeBoundary, "process-spawned");
      child.on("error", (error) => transport.onerror?.(error));
      try {
        supervisor = await superviseProcessTree(child);
      } catch (error) {
        closeGate();
        if (!await terminateGatedChildByHandle(child, closeReceipt)) {
          throw new Error("Runtime gated root cleanup could not be verified.");
        }
        gatedRootClosed = true;
        termination = Promise.resolve(Object.freeze({ gone: true, proof: "gated-root-closed" }));
        throw error;
      }
      emitInitializeBoundary(onInitializeBoundary, "supervisor-ready");
      if (protocolFailure !== undefined) {
        await transport.terminateTree();
        throw protocolFailure;
      }
      try {
        await new Promise((resolveStart, rejectStart) => {
          gate.write(startFrame, (error) => {
            if (error === undefined || error === null) resolveStart();
            else rejectStart(error);
          });
        });
      } catch (error) {
        await transport.terminateTree();
        throw error;
      }
      emitInitializeBoundary(onInitializeBoundary, "gate-released");
    },
    async send(message) {
      if (child?.stdin === null || child?.stdin === undefined) throw new Error("Runtime is not connected.");
      const frame = serializeMessage(message);
      if (child.stdin.write(frame)) return;
      await new Promise((resolveDrain, rejectDrain) => {
        child.stdin.once("drain", resolveDrain);
        child.stdin.once("error", rejectDrain);
      });
    },
    async close() {
      if (child === undefined) return;
      try { child.stdin?.end(); } catch {}
      if (child.exitCode !== null || child.signalCode !== null) return;
      await Promise.race([
        new Promise((resolveClose) => child.once("close", resolveClose)),
        new Promise((resolveClose) => setTimeout(resolveClose, 2_000)),
      ]);
      readBuffer.clear();
    },
    async terminateTree() {
      if (termination !== undefined) return termination;
      if (gatedRootClosed) {
        return Object.freeze({ gone: true, proof: "gated-root-closed" });
      }
      if (supervisor === undefined) throw new Error("Runtime process-tree authority is unavailable.");
      termination = (async () => {
        try { return await supervisor.terminate(); }
        finally { closeGate(); }
      })();
      return termination;
    },
  };
  return transport;
}

function emitInitializeBoundary(observer, boundary) {
  if (typeof observer !== "function" || !INITIALIZE_BOUNDARIES.has(boundary)) return;
  try { observer(boundary); } catch {}
}

export function createMcpStdoutBudget({ maximumAggregateBytes, maximumFrameBytes }) {
  if (!Number.isSafeInteger(maximumAggregateBytes) || maximumAggregateBytes < 1
    || maximumAggregateBytes > 1024 * 1024
    || !Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1
    || maximumFrameBytes > maximumAggregateBytes) {
    throw new Error("Runtime MCP stdout budget is invalid.");
  }
  let aggregateBytes = 0;
  let frameBytes = 0;
  let failed = false;
  return Object.freeze({
    consume(chunk) {
      if (failed || !Buffer.isBuffer(chunk)) {
        failed = true;
        throw new Error("Runtime MCP stdout is invalid.");
      }
      aggregateBytes += chunk.byteLength;
      if (aggregateBytes > maximumAggregateBytes) {
        failed = true;
        throw new Error("Runtime MCP stdout exceeds its aggregate bound.");
      }
      for (const byte of chunk) {
        frameBytes += 1;
        if (frameBytes > maximumFrameBytes) {
          failed = true;
          throw new Error("Runtime MCP stdout frame exceeds its bound.");
        }
        if (byte === 0x0a) frameBytes = 0;
      }
    },
  });
}

function defaultRuntimeEnvironment() {
  const names = process.platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
  return Object.fromEntries(names.flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value.startsWith("()") ? [] : [[name, value]];
  }));
}

async function snapshotRuntimeProcessIdentities(rootPid, snapshotPosixIdentity) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) {
    throw new Error("Runtime process root identity is invalid.");
  }
  const rows = process.platform === "win32"
    ? await snapshotWindowsProcessTable()
    : await snapshotPosixParentTable();
  const byPid = new Map(rows.map((record) => [record.pid, record]));
  if (!byPid.has(rootPid)) throw new Error("Runtime process root is absent from its identity snapshot.");
  const children = new Map();
  for (const record of rows) {
    const values = children.get(record.parentPid) ?? [];
    values.push(record.pid);
    children.set(record.parentPid, values);
  }
  const pids = [rootPid];
  const retained = new Set(pids);
  for (let index = 0; index < pids.length; index += 1) {
    for (const pid of children.get(pids[index]) ?? []) {
      if (retained.has(pid)) continue;
      if (pids.length >= 257) throw new Error("Runtime process identity inventory exceeded its bound.");
      retained.add(pid);
      pids.push(pid);
    }
  }
  if (process.platform === "win32") {
    return pids.map((pid) => {
      const record = byPid.get(pid);
      return Object.freeze({ pid, identity: record.identity });
    });
  }
  const identities = [];
  for (const pid of pids) {
    const expected = byPid.get(pid);
    const identity = await snapshotPosixIdentity(pid);
    if (identity === undefined || identity.parentPid !== expected.parentPid) {
      throw new Error("Runtime POSIX process identity changed during its snapshot.");
    }
    identities.push(Object.freeze({ pid, identity: identity.identity }));
  }
  return identities;
}

async function verifyRuntimeProcessIdentitiesAbsent(identities, snapshotPosixIdentity) {
  const captured = assertProcessIdentityInventory(identities);
  let remainingIdentityCount = 0;
  if (process.platform === "win32") {
    const current = new Map(
      (await snapshotWindowsProcessTable()).map((record) => [record.pid, record.identity]),
    );
    for (const identity of captured) {
      if (current.get(identity.pid) === identity.identity) remainingIdentityCount += 1;
    }
  } else {
    for (const identity of captured) {
      const current = await snapshotPosixIdentity(identity.pid);
      if (current?.identity === identity.identity) remainingIdentityCount += 1;
    }
  }
  return Object.freeze({
    checkedIdentityCount: captured.length,
    remainingIdentityCount,
  });
}

async function snapshotWindowsProcessTable() {
  const { stdout } = await execFile("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { if ($null -ne $_.CreationDate) { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToFileTimeUtc() } }",
  ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000, windowsHide: true });
  return parseRuntimeProcessTable(stdout, true);
}

async function snapshotPosixParentTable() {
  const { stdout } = await execFile("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000,
  });
  return parseRuntimeProcessTable(stdout, false);
}

export function parseRuntimeProcessTable(stdout, hasIdentity) {
  const records = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    if (records.length >= 4_096) throw new Error("Runtime process table exceeds its bound.");
    const match = hasIdentity
      ? /^\s*([0-9]+),([0-9]+),([1-9][0-9]*)\s*$/u.exec(line)
      : /^\s*([1-9][0-9]*)\s+([0-9]+)\s*$/u.exec(line);
    if (match === null) throw new Error("Runtime process table is invalid.");
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)
      || pid < 0 || parentPid < 0) {
      throw new Error("Runtime process table is invalid.");
    }
    if (pid === 0) continue;
    records.push(Object.freeze({
      pid,
      parentPid,
      ...(hasIdentity ? { identity: match[3] } : {}),
    }));
  }
  return records;
}

function assertVerifiedTerminationReceipt(receipt, allowGatedRootClosed = false) {
  const allowedProofs = allowGatedRootClosed
    ? ["gated-root-closed", "windows-job-empty", "registered-groups-empty"]
    : ["windows-job-empty", "registered-groups-empty"];
  if (receipt?.gone !== true
    || !allowedProofs.includes(receipt.proof)) {
    throw new Error("Runtime process-tree termination is unverified.");
  }
  const hasCounts = "registeredIdentityCount" in receipt || "remainingIdentityCount" in receipt;
  if (hasCounts && (!Number.isSafeInteger(receipt.registeredIdentityCount)
    || receipt.registeredIdentityCount < 1
    || receipt.registeredIdentityCount > 257
    || receipt.remainingIdentityCount !== 0)) {
    throw new Error("Runtime process-tree termination receipt is invalid.");
  }
  return {
    remainingIdentityCount: hasCounts ? receipt.remainingIdentityCount : 0,
  };
}

function assertIdentityAbsenceReceipt(receipt, expectedCount) {
  if (receipt === null || typeof receipt !== "object"
    || receipt.checkedIdentityCount !== expectedCount
    || !Number.isSafeInteger(receipt.remainingIdentityCount)
    || receipt.remainingIdentityCount < 0
    || receipt.remainingIdentityCount > expectedCount) {
    throw new Error("Runtime process identity absence receipt is invalid.");
  }
  return receipt;
}

export async function readBoundedRegularFile(path, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024) {
    throw new Error("Runtime asset read bound is invalid.");
  }
  const pathBefore = await lstat(path, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error("Runtime asset is not a regular file.");
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino
      || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error("Runtime asset size exceeds its bound.");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const receipt = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (receipt.bytesRead === 0) throw new Error("Runtime asset ended before its declared size.");
      offset += receipt.bytesRead;
    }
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error("Runtime asset identity changed during its bounded read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertAssetResult(result, svgPath, pngPath) {
  const details = result?.structuredContent;
  if (result?.isError === true || details === null || typeof details !== "object"
    || details.svg_path !== svgPath || details.png_path !== pngPath
    || !Array.isArray(details.warnings) || details.warnings.length !== 0) {
    throw new Error("Runtime SVG/PNG tool result is invalid.");
  }
}

export async function assertOwnedTemporaryRoot(root, options = {}) {
  if (!isAbsolute(root) || !basename(root).startsWith("gpt-codex-hwp-runtime-smoke-")) {
    throw new Error("Runtime smoke temporary root is not owned.");
  }
  const lstatPath = options.lstatPath ?? lstat;
  const realpathPath = options.realpathPath ?? realpath;
  const temporaryParent = options.temporaryParent ?? tmpdir();
  const status = await lstatPath(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Runtime smoke temporary root is not a regular directory.");
  }
  const canonicalRoot = await realpathPath(root);
  const canonicalTemporaryParent = await realpathPath(temporaryParent);
  const expectedCanonicalRoot = join(canonicalTemporaryParent, basename(root));
  if (pathKey(canonicalRoot) !== pathKey(expectedCanonicalRoot)) {
    throw new Error("Runtime smoke temporary root is outside the system temporary directory.");
  }
  return canonicalRoot;
}

function assertProcessIdentityInventory(value, requiredRootPid = undefined) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 257) {
    throw new Error("Runtime process identity inventory is invalid.");
  }
  const identities = value.map((record) => {
    if (record === null || typeof record !== "object"
      || !Number.isSafeInteger(record.pid) || record.pid < 1
      || typeof record.identity !== "string"
      || !/^[A-Za-z0-9:._-]{1,128}$/u.test(record.identity)
      || Object.keys(record).sort().join(",") !== "identity,pid") {
      throw new Error("Runtime process identity inventory is invalid.");
    }
    return Object.freeze({ pid: record.pid, identity: record.identity });
  });
  if (new Set(identities.map((record) => `${record.pid}:${record.identity}`)).size !== identities.length) {
    throw new Error("Runtime process identity inventory contains duplicates.");
  }
  if (requiredRootPid !== undefined
    && !identities.some((record) => record.pid === requiredRootPid)) {
    throw new Error("Runtime process identity inventory omits its root.");
  }
  return identities;
}

function mergeProcessIdentities(current, added) {
  const byIdentity = new Map(
    [...current, ...added].map((record) => [`${record.pid}:${record.identity}`, record]),
  );
  const merged = [...byIdentity.values()];
  if (merged.length > 257) throw new Error("Runtime process identity inventory exceeded its bound.");
  return merged;
}

function pathKey(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function assertPathInside(root, candidate) {
  const child = relative(root, candidate);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Runtime smoke output path escapes its allowed temporary root.");
  }
}

function sameStrings(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  if (process.argv.length !== 2) {
    process.stderr.write("Runtime smoke accepts no arguments.\n");
    process.exitCode = 1;
  } else {
    await runInstalledRuntimeSmoke();
  }
}
