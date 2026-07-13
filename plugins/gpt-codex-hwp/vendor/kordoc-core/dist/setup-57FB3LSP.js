#!/usr/bin/env node

// src/setup.ts
import { createInterface } from "readline/promises";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir, platform } from "os";
import { stdin, stdout } from "process";
function detectClients() {
  const home = homedir();
  const os = platform();
  const clients = [];
  const claudePaths = {
    darwin: resolve(home, "Library/Application Support/Claude/claude_desktop_config.json"),
    win32: resolve(process.env["APPDATA"] ?? resolve(home, "AppData/Roaming"), "Claude/claude_desktop_config.json"),
    linux: resolve(home, ".config/Claude/claude_desktop_config.json")
  };
  const claudePath = claudePaths[os];
  if (claudePath) clients.push({ name: "Claude Desktop", configPath: claudePath, format: "mcpServers" });
  clients.push({ name: "Claude Code (\uD604\uC7AC \uB514\uB809\uD1A0\uB9AC)", configPath: resolve(process.cwd(), ".mcp.json"), format: "mcpServers" });
  clients.push({ name: "Cursor", configPath: resolve(home, ".cursor/mcp.json"), format: "mcpServers" });
  clients.push({ name: "VS Code (\uD604\uC7AC \uB514\uB809\uD1A0\uB9AC)", configPath: resolve(process.cwd(), ".vscode/mcp.json"), format: "servers" });
  clients.push({ name: "Windsurf", configPath: resolve(home, ".codeium/windsurf/mcp_config.json"), format: "mcpServers" });
  clients.push({ name: "Gemini CLI", configPath: resolve(home, ".gemini/settings.json"), format: "mcpServers" });
  const zedPaths = {
    darwin: resolve(home, ".zed/settings.json"),
    linux: resolve(home, ".config/zed/settings.json"),
    win32: resolve(home, ".zed/settings.json")
  };
  const zedPath = zedPaths[os];
  if (zedPath) clients.push({ name: "Zed", configPath: zedPath, format: "context_servers" });
  clients.push({ name: "Antigravity", configPath: resolve(home, ".gemini/antigravity/mcp_config.json"), format: "mcpServers" });
  return clients;
}
async function readJsonFile(path) {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}
async function writeJsonFile(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
function buildServerEntry() {
  if (platform() === "win32") {
    return { command: "cmd", args: ["/c", "npx", "-y", "kordoc", "mcp"] };
  }
  return { command: "npx", args: ["-y", "kordoc", "mcp"] };
}
function buildZedEntry() {
  const base = platform() === "win32" ? { path: "cmd", args: ["/c", "npx", "-y", "kordoc", "mcp"] } : { path: "npx", args: ["-y", "kordoc", "mcp"] };
  return { command: base };
}
var ESC = "\x1B[";
var c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  white: `${ESC}37m`
};
function rgb(r, g, b) {
  return `${ESC}38;2;${r};${g};${b}m`;
}
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
async function typewrite(text, delay = 15) {
  for (const ch of text) {
    process.stdout.write(ch);
    await sleep(delay);
  }
  console.log();
}
async function printBanner() {
  const gradients = [
    rgb(255, 120, 80),
    rgb(255, 140, 80),
    rgb(255, 160, 80),
    rgb(240, 180, 80),
    rgb(220, 200, 80),
    rgb(200, 220, 80)
  ];
  const logo = [
    "  _                  _            ",
    " | | _____  _ __ __| | ___   ___ ",
    " | |/ / _ \\| '__/ _` |/ _ \\ / __|",
    " |   < (_) | | | (_| | (_) | (__ ",
    " |_|\\_\\___/|_|  \\__,_|\\___/ \\___|"
  ];
  console.log();
  for (let i = 0; i < logo.length; i++) {
    console.log(`${gradients[i % gradients.length]}${c.bold}${logo[i]}${c.reset}`);
    await sleep(60);
  }
  console.log();
  await typewrite(`${c.dim}  \uBAA8\uB450 \uD30C\uC2F1\uD574\uBC84\uB9AC\uACA0\uB2E4  \u2501\u2501  HWP \xB7 HWPX \xB7 PDF \xB7 XLSX \xB7 DOCX \u2192 Markdown${c.reset}`, 10);
  console.log();
  console.log(`${c.cyan}  ${"\u2501".repeat(60)}${c.reset}`);
  console.log();
}
function stepHeader(step, total, title) {
  const dots = `${c.dim}${"\xB7".repeat(Math.max(0, 40 - title.length))}${c.reset}`;
  console.log(`  ${c.cyan}${c.bold}[${step}/${total}]${c.reset} ${c.white}${c.bold}${title}${c.reset} ${dots}`);
  console.log();
}
function successLine(label, detail) {
  console.log(`  ${c.green}${c.bold}+${c.reset} ${c.white}${label}${c.reset}${c.dim} ${detail}${c.reset}`);
}
function failLine(label, detail) {
  console.log(`  ${c.red}${c.bold}x${c.reset} ${c.white}${label}${c.reset}${c.dim} ${detail}${c.reset}`);
}
async function printComplete() {
  console.log();
  const box = [
    `  ${c.green}${c.bold}\u2554${"\u2550".repeat(50)}\u2557${c.reset}`,
    `  ${c.green}${c.bold}\u2551${c.reset}${" ".repeat(14)}${c.green}${c.bold}Setup Complete!${c.reset}${" ".repeat(22)}${c.green}${c.bold}\u2551${c.reset}`,
    `  ${c.green}${c.bold}\u255A${"\u2550".repeat(50)}\u255D${c.reset}`
  ];
  for (const line of box) {
    console.log(line);
    await sleep(40);
  }
  console.log();
  console.log(`  ${c.dim}\uD074\uB77C\uC774\uC5B8\uD2B8\uB97C \uC7AC\uC2DC\uC791\uD558\uBA74 'kordoc' MCP \uC11C\uBC84\uAC00 \uD65C\uC131\uD654\uB429\uB2C8\uB2E4.${c.reset}`);
  console.log(`  ${c.dim}8\uAC1C \uB3C4\uAD6C: parse_document / parse_metadata / parse_pages / parse_table${c.reset}`);
  console.log(`  ${c.dim}         detect_format / compare_documents / parse_form / fill_form${c.reset}`);
  console.log();
}
async function runSetup() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await printBanner();
    stepHeader(1, 2, "MCP \uD074\uB77C\uC774\uC5B8\uD2B8 \uC120\uD0DD");
    const clients = detectClients();
    clients.forEach((cl, i) => {
      const exists = existsSync(cl.configPath);
      const badge = exists ? `${c.green} [\uAC10\uC9C0\uB428]${c.reset}` : "";
      const num = `${c.cyan}${String(i + 1).padStart(2)}${c.reset}`;
      console.log(`  ${num}) ${c.white}${cl.name}${c.reset}${badge}`);
    });
    console.log();
    const clientInput = (await rl.question(`  ${c.cyan}>${c.reset} \uBC88\uD638 (\uC608: 1,3): `)).trim();
    if (!clientInput) {
      console.log(`
  ${c.yellow}\uC120\uD0DD \uC5C6\uC74C${c.reset} \u2014 \uC218\uB3D9 \uC124\uC815 \uC548\uB0B4:`);
      printManualConfig();
      return;
    }
    const indices = clientInput.split(",").map((s) => parseInt(s.trim(), 10) - 1).filter((i) => i >= 0 && i < clients.length);
    if (indices.length === 0) {
      console.log(`
  ${c.yellow}\uC720\uD6A8\uD55C \uC120\uD0DD \uC5C6\uC74C${c.reset} \u2014 \uC218\uB3D9 \uC124\uC815 \uC548\uB0B4:`);
      printManualConfig();
      return;
    }
    console.log();
    stepHeader(2, 2, "\uC124\uC815 \uD30C\uC77C \uC5C5\uB370\uC774\uD2B8");
    const entry = buildServerEntry();
    for (const idx of indices) {
      const client = clients[idx];
      await sleep(150);
      try {
        const config = await readJsonFile(client.configPath);
        const key = client.format;
        const serverEntry = key === "context_servers" ? buildZedEntry() : entry;
        const servers = config[key] ?? {};
        servers["kordoc"] = serverEntry;
        config[key] = servers;
        await writeJsonFile(client.configPath, config);
        successLine(client.name, client.configPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failLine(client.name, msg);
      }
    }
    await printComplete();
  } catch (err) {
    if (err?.code === "ERR_USE_AFTER_CLOSE") return;
    throw err;
  } finally {
    rl.close();
  }
}
function printManualConfig() {
  const entry = buildServerEntry();
  console.log();
  console.log(`  ${c.dim}\uC544\uB798 JSON\uC744 \uC124\uC815 \uD30C\uC77C\uC758 mcpServers\uC5D0 \uCD94\uAC00\uD558\uC138\uC694:${c.reset}`);
  console.log();
  console.log(`  ${c.cyan}"kordoc"${c.reset}: ${JSON.stringify(entry, null, 4)}`);
  console.log();
}
export {
  runSetup
};
//# sourceMappingURL=setup-57FB3LSP.js.map