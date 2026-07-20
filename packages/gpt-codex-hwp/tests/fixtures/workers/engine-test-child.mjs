import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readSync, writeFileSync, writeSync } from "node:fs";

const mode = process.argv[2] ?? "success";
const delayMs = Number.parseInt(process.argv[3] ?? "250", 10);
let retainedExternal;

if (mode === "gate-payload-marker") {
  writeFileSync(process.argv[4], "payload evaluated\n");
  setInterval(() => {}, 1000);
}

if (mode === "race-spawner") {
  const pidLogPath = process.argv[4];
  const spawnLeaf = () => {
    const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    leaf.unref();
    appendFileSync(pidLogPath, `${leaf.pid}\n`);
  };
  for (let index = 0; index < 8; index += 1) spawnLeaf();
  setInterval(spawnLeaf, 50);
  await new Promise(() => {});
}

if (mode === "orphan-intermediate") {
  const pidLogPath = process.argv[4];
  const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: true,
  });
  leaf.unref();
  appendFileSync(pidLogPath, `${process.pid}\n${leaf.pid}\n`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  appendFileSync(pidLogPath, `EXIT ${process.pid}\n`);
  process.exit(0);
}

if (mode === "crash-before-ready") process.exit(17);
if (mode === "crash-armed-before-ready") {
  writeSync(8, Buffer.from([0x41]));
  const release = Buffer.alloc(1);
  if (readSync(9, release, 0, 1, null) !== 1 || release[0] !== 0x52) process.exit(79);
  process.exit(17);
}
if (mode === "delayed-crash-before-ready") {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  process.exit(17);
}

if (mode === "startup-large-oom") {
  process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 0x53));
  process.stderr.write("heap out of memory");
  process.stderr.write(Buffer.alloc(4 * 1024 * 1024, 0x45));
}

readRequest().then((request) => {
  if (mode === "failure-before-ready") {
    sendControl({
      ...event(request, "failure"),
      error: {
        code: "ENGINE_CRASH",
        message: "The document engine stopped unexpectedly.",
      },
    });
    return;
  }
  if (mode === "malformed") {
    sendControl({ type: "ready", env: process.env });
    return;
  }

  if (mode === "inline-oversize-declaration") {
    sendControl(event(request, "ready"));
    sendControl({
      ...event(request, "result"),
      payload: resultPayload(request.operation),
      outputByteLength: 8 * 1024 * 1024 + 1,
    });
    return;
  }

  if (mode === "inline-9m-attack") {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(9 * 1024 * 1024);
    writeSync(6, header);
    return;
  }

  sendControl(event(request, "ready"));
  if (mode === "fatal-oom") {
    const retained = [];
    while (true) retained.push(new Array(1_000_000).fill(retained.length));
  }
  if (mode === "crash-after-ready") process.kill(process.pid, "SIGKILL");
  if (mode === "oom") {
    sendControl({
      ...event(request, "failure"),
      error: {
        code: "ENGINE_OOM",
        message: "The document engine exceeded its memory limit.",
      },
    });
    return;
  }
  if (mode === "external-memory-stress") {
    retainedExternal = Buffer.alloc(16 * 1024 * 1024, 0x5a);
    for (let index = 0; index < retainedExternal.length; index += 4096) {
      retainedExternal[index] ^= 0xff;
    }
    const evidence = Buffer.from(JSON.stringify({
      kind: "external-memory",
      allocatedBytes: retainedExternal.byteLength,
      externalBytes: process.memoryUsage().external,
    }));
    sendControl({ ...event(request, "progress"), completed: 16, total: 16 });
    sendSpoolResult(request, evidence);
    return;
  }
  if (mode === "spool-result" || mode === "spool-size-tamper" || mode === "spool-hash-tamper") {
    const size = Number.isInteger(delayMs) && delayMs > 0 ? delayMs : 1024;
    const bytes = Buffer.alloc(size, 0x4b);
    sendSpoolResult(request, bytes, mode);
    return;
  }
  if (mode === "spool-base64") {
    sendSpoolResult(request, Buffer.from(process.argv[3] ?? "", "base64"));
    return;
  }
  if (mode === "render-spool") {
    const svgBytes = Number.isInteger(delayMs) && delayMs > 0
      ? delayMs
      : 9 * 1024 * 1024;
    const prefix = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>');
    const suffix = Buffer.from("</text></svg>");
    const svg = Buffer.alloc(svgBytes, 0x41);
    prefix.copy(svg, 0);
    suffix.copy(svg, svg.byteLength - suffix.byteLength);
    const metadata = { backend: "kordoc", pageCount: 3, width: 612, height: 792 };
    const header = Buffer.from(JSON.stringify({ version: 1, svgBytes, metadata }));
    const encoded = Buffer.alloc(4 + header.byteLength + svg.byteLength);
    encoded.writeUInt32BE(header.byteLength, 0);
    header.copy(encoded, 4);
    svg.copy(encoded, 4 + header.byteLength);
    sendSpoolResult(request, encoded);
    return;
  }
  if (mode === "ignore-abort") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    sendControl({
      ...event(request, "progress"),
      completed: descendant.pid,
      total: Number.MAX_SAFE_INTEGER,
    });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "lifeline-hold") {
    const pidLogPath = process.argv[4];
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    appendFileSync(pidLogPath, `${process.pid}\n${descendant.pid}\n`);
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "descendant-then-crash") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: process.platform === "win32",
    });
    sendControl({
      ...event(request, "progress"),
      completed: descendant.pid,
      total: Number.MAX_SAFE_INTEGER,
    });
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
    return;
  }
  if (mode === "multilevel-orphan-then-crash") {
    const pidLogPath = process.argv[4];
    const intermediate = spawn(
      process.execPath,
      [new URL(import.meta.url).pathname.slice(1), "orphan-intermediate", "0", pidLogPath],
      { stdio: "ignore", detached: process.platform === "win32" },
    );
    intermediate.unref();
    sendControl({
      ...event(request, "progress"),
      completed: intermediate.pid,
      total: Number.MAX_SAFE_INTEGER,
    });
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 650);
    return;
  }
  if (mode === "spawn-race-timeout") {
    const pidLogPath = process.argv[4];
    const spawner = spawn(
      process.execPath,
      [new URL(import.meta.url).pathname.slice(1), "race-spawner", String(process.pid), pidLogPath],
      { stdio: "ignore", detached: process.platform === "win32" },
    );
    spawner.unref();
    appendFileSync(pidLogPath, `${spawner.pid}\n`);
    sendControl({
      ...event(request, "progress"),
      completed: spawner.pid,
      total: Number.MAX_SAFE_INTEGER,
    });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "slow") {
    setTimeout(() => sendResult(request), delayMs);
    return;
  }
  if (mode === "progress") {
    sendControl({ ...event(request, "progress"), completed: 1, total: 3 });
    sendControl({ ...event(request, "progress"), completed: 2, total: 3 });
  }
  if (mode === "late-result") {
    sendResult(request);
    sendControl({
      ...event(request, "failure"),
      error: {
        code: "ENGINE_CRASH",
        message: "The document engine stopped unexpectedly.",
      },
    });
    return;
  }
  process.stdout.write("PRIVATE_DOCUMENT_TEXT".repeat(8192));
  process.stderr.write("AWS_SECRET_ACCESS_KEY=fixture-secret".repeat(8192));
  sendResult(request);
}).catch(() => process.exit(19));

function event(request, type) {
  return { protocolVersion: 1, requestId: request.requestId, type };
}

function sendResult(request) {
  const payload = resultPayload(request.operation);
  sendControl({
    ...event(request, "result"),
    payload,
    outputByteLength: resultByteLength(request.operation, payload),
  });
}

function resultPayload(operation) {
  switch (operation) {
    case "detect": return { format: "unknown" };
    case "parse": return { markdown: "", fileType: "hwpx", warnings: [], images: [] };
    case "render": return { svg: "" };
    case "generateHwpx":
    case "patchHwpx":
    case "fillHwpx":
    case "insertImage": return { bytes: new ArrayBuffer(0) };
    case "validateHwpx": return { ok: true, issues: [], entryCount: 0 };
    default: throw new Error("unsupported fixture operation");
  }
}

function resultByteLength(operation, payload) {
  switch (operation) {
    case "detect": return Buffer.byteLength(payload.format);
    case "parse": return 6;
    case "render": return 0;
    case "generateHwpx":
    case "patchHwpx":
    case "fillHwpx":
    case "insertImage": return payload.bytes.byteLength;
    case "validateHwpx": return 38;
  }
}

function sendSpoolResult(request, bytes, tamperMode = "spool-result") {
  writeSync(5, bytes);
  const encoding = spoolEncoding(request.operation);
  sendControl({
    ...event(request, "spoolResult"),
    receipt: {
      descriptor: 5,
      operation: request.operation,
      encoding,
      sizeBytes: tamperMode === "spool-size-tamper"
        ? bytes.byteLength + 1
        : bytes.byteLength,
      sha256: tamperMode === "spool-hash-tamper"
        ? "0".repeat(64)
        : createHash("sha256").update(bytes).digest("hex"),
      ...(spoolMetadata(request.operation) === undefined
        ? {}
        : { metadata: spoolMetadata(request.operation) }),
    },
  });
}

function spoolEncoding(operation) {
  if (operation === "parse") return "document-result-v1";
  if (operation === "render") return "render-result-v1";
  return "hwpx-result-v1";
}

function spoolMetadata(operation) {
  switch (operation) {
    case "generateHwpx":
      return {
        operation,
        fontNormalization: { changed: false, changedReferenceCount: 0 },
      };
    case "patchHwpx":
      return {
        operation,
        applied: 1,
        skipped: [],
        verification: {
          stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
          diffs: [],
        },
      };
    case "fillHwpx":
      return { operation, filled: [], unmatched: [], rejected: [] };
    case "insertImage":
      return {
        operation,
        mode: "seal-anchor",
        placed: [{
          anchor: "anchor",
          occurrence: 0,
          sectionIndex: 0,
          mode: "overlap",
          posXMm: 0,
          posYMm: 0,
          sizeMm: 10,
          entry: "BinData/image1.png",
          warnings: [],
        }],
      };
    default:
      return undefined;
  }
}

function sendControl(value) {
  const payload = Buffer.from(JSON.stringify(value, (_key, candidate) => {
    if (candidate instanceof ArrayBuffer) {
      return { $gptCodexHwpArrayBuffer: Buffer.from(candidate).toString("base64") };
    }
    return candidate;
  }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength);
  writeSync(6, header);
  writeSync(6, payload);
}

function readRequest() {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let headerBytes = 0;
    let payload;
    let payloadBytes = 0;
    let complete = false;
    process.stdin.on("data", (chunk) => {
      try {
        let offset = 0;
        while (offset < chunk.byteLength) {
          if (complete) throw new Error("trailing request frame");
          if (payload === undefined) {
            const copied = Math.min(4 - headerBytes, chunk.byteLength - offset);
            header.set(chunk.subarray(offset, offset + copied), headerBytes);
            headerBytes += copied;
            offset += copied;
            if (headerBytes < 4) continue;
            const length = header.readUInt32BE(0);
            if (length === 0 || length > 32 * 1024 * 1024) {
              throw new Error("invalid request frame length");
            }
            payload = Buffer.allocUnsafeSlow(length);
          }
          const copied = Math.min(
            payload.byteLength - payloadBytes,
            chunk.byteLength - offset,
          );
          payload.set(chunk.subarray(offset, offset + copied), payloadBytes);
          payloadBytes += copied;
          offset += copied;
          if (payloadBytes === payload.byteLength) complete = true;
        }
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.once("end", () => {
      if (!complete || payload === undefined) {
        reject(new Error("partial request frame"));
        return;
      }
      try {
        resolve(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.once("error", reject);
  });
}
