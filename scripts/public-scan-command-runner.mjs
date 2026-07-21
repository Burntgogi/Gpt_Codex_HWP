import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const control = createWriteStream("", { fd: 3, autoClose: false });
control.write("GPT_CODEX_HWP_SCAN_RUNNER_READY\n");
control.end();

let wire;
try {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_FRAME_BYTES + MAX_INPUT_BYTES + 4) process.exit(125);
    chunks.push(Buffer.from(chunk));
  }
  wire = Buffer.concat(chunks, total);
} catch {
  process.exit(125);
}
if (wire.length < 4 || wire.length > MAX_FRAME_BYTES + MAX_INPUT_BYTES + 4) process.exit(125);
const frameBytes = wire.readUInt32BE(0);
if (frameBytes < 2 || frameBytes > MAX_FRAME_BYTES || wire.length < 4 + frameBytes) process.exit(125);

let frame;
try {
  frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(wire.subarray(4, 4 + frameBytes)));
} catch {
  process.exit(125);
}
if (frame === null || typeof frame !== "object" || Array.isArray(frame)
  || typeof frame.tool !== "string" || frame.tool.length < 1 || frame.tool.length > 4096
  || !Array.isArray(frame.args) || frame.args.length > 100_000
  || frame.args.some((value) => typeof value !== "string" || value.length > 4096)) {
  process.exit(125);
}

const child = spawn(frame.tool, frame.args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "inherit", "inherit"],
});
child.once("error", () => process.exit(126));
child.once("close", (code, signal) => {
  process.exitCode = signal === null && Number.isInteger(code) ? code : 127;
});
child.stdin.end(wire.subarray(4 + frameBytes));
