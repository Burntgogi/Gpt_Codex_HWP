import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];

if (mode === "--descriptor-case") {
  const [markerPath, startGatePath, fixturePath] = process.argv.slice(3);
  const bootstrap = spawnGatedBootstrap(
    startGatePath,
    fixturePath,
    ["--descriptor-payload", markerPath],
  );
  process.stdout.write(`${JSON.stringify({ bootstrapPid: bootstrap.pid })}\n`);
  await sendStart(bootstrap);
  bootstrap.unref();
  await waitForPath(markerPath);
  await waitForPath(`${markerPath}.helper`);
  process.exit(0);
} else if (mode === "--sequential-case") {
  const [markerPrefix, startGatePath, fixturePath] = process.argv.slice(3);
  const bootstrapPids = [];
  for (let index = 0; index < 2; index += 1) {
    const markerPath = `${markerPrefix}-${index}.json`;
    const bootstrap = spawnGatedBootstrap(
      startGatePath,
      fixturePath,
      ["--descriptor-payload", markerPath],
    );
    bootstrapPids.push(bootstrap.pid);
    await sendStart(bootstrap);
    await waitForPath(markerPath);
    await waitForPath(`${markerPath}.helper`);
    closeStart(bootstrap);
    await once(bootstrap, "close");
  }
  process.stdout.write(`${JSON.stringify({ bootstrapPids })}\n`);
  process.exit(0);
} else if (mode === "--overlap-case") {
  const [markerPrefix, identityBarrierPath, startGatePath, fixturePath] = process.argv.slice(3);
  const first = spawnGatedBootstrap(
    startGatePath,
    fixturePath,
    ["--descriptor-payload", `${markerPrefix}-0.json`],
  );
  await sendStart(first);
  await waitForPath(identityBarrierPath);
  const second = spawnGatedBootstrap(
    startGatePath,
    fixturePath,
    ["--descriptor-payload", `${markerPrefix}-1.json`],
  );
  const bootstraps = [first, second];
  process.stdout.write(`${JSON.stringify({
    bootstrapPids: bootstraps.map((bootstrap) => bootstrap.pid),
  })}\n`);
  await sendStart(second);
  await Promise.all(bootstraps.map((bootstrap) => once(bootstrap, "close")));
  process.exit(0);
} else if (mode === "--stale-ack-case") {
  const [payloadMarkerPath, startGatePath, fixturePath] = process.argv.slice(3);
  const first = spawn(process.execPath, [fixturePath, "--register-no-read"], {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: [
      "ignore", "ignore", "ignore", "ignore", "ignore",
      "ignore", "ignore", "ignore", 5, 6,
    ],
  });
  await once(first, "close");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  const second = spawnGatedBootstrap(
    startGatePath,
    fixturePath,
    ["--race-payload", `${payloadMarkerPath}.pids`, payloadMarkerPath],
  );
  await sendStart(second);
  await once(second, "close");
  process.stdout.write(`${JSON.stringify({ firstPid: first.pid, secondPid: second.pid })}\n`);
  process.exit(0);
} else if (mode === "--register-no-read") {
  writeSync(8, `${JSON.stringify({
    schemaVersion: 1,
    type: "register",
    nonce: randomUUID(),
    pid: process.pid,
    parentPid: process.ppid,
  })}\n`);
  process.exit(0);
} else if (mode === "--descriptor-payload") {
  const markerPath = process.argv[3];
  const helperMarkerPath = `${markerPath}.helper`;
  const registrationDeclared = process.env.GPT_CODEX_HWP_REGISTRATION !== undefined;
  if (registrationDeclared) process.exit(91);
  const helper = spawn(process.execPath, [process.argv[1], "--descriptor-helper", helperMarkerPath], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  writeFileSync(markerPath, JSON.stringify({
    payloadPid: process.pid,
    helperPid: helper.pid,
    registrationDeclared,
    ipcConnected: process.connected === true,
  }));
  setInterval(() => {}, 1_000);
} else if (mode === "--descriptor-helper") {
  const markerPath = process.argv[3];
  writeFileSync(markerPath, JSON.stringify({
    pid: process.pid,
    registrationDeclared: process.env.GPT_CODEX_HWP_REGISTRATION !== undefined,
  }));
} else if (mode === "--leak-case") {
  const holder = spawn(process.execPath, [process.argv[1], "--holder"], {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ignore", "ignore", 5],
  });
  holder.unref();
  process.stdout.write(`${JSON.stringify({ holderPid: holder.pid })}\n`);
  process.exit(0);
} else if (mode === "--holder") {
  setInterval(() => {}, 1_000);
} else if (mode === "--race-case") {
  const [pidLogPath, payloadMarkerPath, startGatePath, fixturePath] = process.argv.slice(3);
  appendFileSync(pidLogPath, `${process.pid}\n`);
  process.once("SIGTERM", async () => {
    const bootstrap = spawnGatedBootstrap(
      startGatePath,
      fixturePath,
      ["--race-payload", pidLogPath, payloadMarkerPath],
    );
    appendFileSync(pidLogPath, `${bootstrap.pid}\n`);
    await sendStart(bootstrap);
    bootstrap.unref();
    process.exit(0);
  });
  process.stdout.write("READY\n");
  setInterval(() => {}, 1_000);
} else if (mode === "--race-payload") {
  const [pidLogPath, payloadMarkerPath] = process.argv.slice(3);
  appendFileSync(pidLogPath, `${process.pid}\n`);
  writeFileSync(payloadMarkerPath, "payload-ran");
  setInterval(() => {}, 1_000);
} else {
  process.exit(90);
}

function spawnGatedBootstrap(startGatePath, fixturePath, fixtureArguments) {
  const startGateSpecifier = process.platform === "win32"
    ? pathToFileURL(startGatePath).href
    : startGatePath;
  const child = spawn(process.execPath, ["--import", "tsx",
    ...(process.platform === "win32"
      ? ["--import", startGateSpecifier, fixturePath]
      : [startGateSpecifier, fixturePath]),
    ...fixtureArguments,
  ], {
    detached: true,
    shell: false,
    windowsHide: true,
    env: { ...process.env, GPT_CODEX_HWP_REGISTRATION: "1" },
    stdio: [
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "pipe",
      5,
      6,
    ],
  });
  child.stdio[7].on("error", () => {});
  return child;
}

async function sendStart(child) {
  await new Promise((resolvePromise, rejectPromise) => {
    child.stdio[7].write("GPT_CODEX_HWP_START_V1\n", (error) => {
      if (error === null || error === undefined) resolvePromise();
      else rejectPromise(error);
    });
  });
}

function closeStart(child) {
  child.stdio[7].end();
}

async function waitForPath(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("fixture path timeout");
}
