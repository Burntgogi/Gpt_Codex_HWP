#!/usr/bin/env node
import {
  parse
} from "./chunk-7K5P4RNT.js";
import "./chunk-2IBFK5ZO.js";
import {
  detectFormat
} from "./chunk-MEPHGCPQ.js";
import "./chunk-MOL7MDBG.js";
import "./chunk-NZJAXMN7.js";
import "./chunk-QMJJI6TD.js";
import "./chunk-4RGDFDQ2.js";
import {
  toArrayBuffer
} from "./chunk-UNV7F3FK.js";

// src/watch.ts
import { watch, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, realpathSync } from "fs";
import { basename, resolve, extname, sep } from "path";
var SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([".hwp", ".hwpx", ".pdf", ".xlsx", ".docx"]);
var DEBOUNCE_MS = 1e3;
var STABLE_CHECK_MS = 300;
var MAX_FILE_SIZE = 500 * 1024 * 1024;
async function watchDirectory(options) {
  const { dir, outDir, webhook, format = "markdown", pages, silent } = options;
  if (!existsSync(dir)) throw new Error(`\uB514\uB809\uD1A0\uB9AC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${dir}`);
  if (webhook) validateWebhookUrl(webhook);
  if (outDir) mkdirSync(outDir, { recursive: true });
  const log = silent ? () => {
  } : (msg) => process.stderr.write(msg + "\n");
  log(`[kordoc watch] \uAC10\uC2DC \uC2DC\uC791: ${resolve(dir)}`);
  if (outDir) log(`[kordoc watch] \uCD9C\uB825: ${resolve(outDir)}`);
  if (webhook) log(`[kordoc watch] \uC6F9\uD6C5: ${webhook}`);
  const pending = /* @__PURE__ */ new Map();
  const MAX_CONCURRENT = 3;
  let activeCount = 0;
  const inProgress = /* @__PURE__ */ new Set();
  const waitForStableSize = async (absPath) => {
    let prevSize = statSync(absPath).size;
    await new Promise((r) => setTimeout(r, STABLE_CHECK_MS));
    if (!existsSync(absPath)) return 0;
    const currSize = statSync(absPath).size;
    if (currSize !== prevSize) {
      await new Promise((r) => setTimeout(r, STABLE_CHECK_MS));
      if (!existsSync(absPath)) return 0;
      return statSync(absPath).size;
    }
    return currSize;
  };
  const processFile = async (filePath) => {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;
    if (inProgress.has(filePath) || activeCount >= MAX_CONCURRENT) return;
    inProgress.add(filePath);
    activeCount++;
    const fileName = basename(filePath);
    try {
      const rawPath = resolve(dir, filePath);
      if (!existsSync(rawPath)) return;
      let absPath;
      try {
        absPath = realpathSync(rawPath);
      } catch {
        return;
      }
      const realDir = realpathSync(resolve(dir));
      if (!absPath.startsWith(realDir + sep) && absPath !== realDir) return;
      const fileSize = await waitForStableSize(absPath);
      if (fileSize > MAX_FILE_SIZE || fileSize === 0) return;
      log(`[kordoc watch] \uBCC0\uD658 \uC911: ${fileName}`);
      const buffer = readFileSync(absPath);
      const arrayBuffer = toArrayBuffer(buffer);
      const parseOptions = pages ? { pages } : void 0;
      const result = await parse(arrayBuffer, parseOptions);
      if (!result.success) {
        log(`[kordoc watch] \uC2E4\uD328: ${fileName} \u2014 ${result.error}`);
        await sendWebhook(webhook, { file: fileName, format: detectFormat(arrayBuffer), success: false, error: result.error });
        return;
      }
      const output = format === "json" ? JSON.stringify(result, null, 2) : result.markdown;
      if (outDir) {
        const outExt = format === "json" ? ".json" : ".md";
        const outPath = resolve(outDir, fileName.replace(/\.[^.]+$/, outExt));
        writeFileSync(outPath, output, "utf-8");
        log(`[kordoc watch] \uC644\uB8CC: ${fileName} \u2192 ${basename(outPath)}`);
      } else {
        process.stdout.write(output + "\n");
      }
      await sendWebhook(webhook, {
        file: fileName,
        format: result.fileType,
        success: true,
        markdown: format === "markdown" ? output.substring(0, 1e3) : void 0
      });
    } catch (err) {
      log(`[kordoc watch] \uC5D0\uB7EC: ${fileName} \u2014 ${err instanceof Error ? err.message : err}`);
    } finally {
      inProgress.delete(filePath);
      activeCount--;
    }
  };
  watch(dir, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const filePath = filename.toString();
    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);
    pending.set(filePath, setTimeout(() => {
      pending.delete(filePath);
      processFile(filePath).catch((err) => {
        process.stderr.write(`[kordoc watch] \uCC98\uB9AC \uC2E4\uD328: ${filePath} \u2014 ${err instanceof Error ? err.message : String(err)}
`);
      });
    }, DEBOUNCE_MS));
  });
  return new Promise(() => {
  });
}
function validateWebhookUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 webhook URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uB294 webhook \uD504\uB85C\uD1A0\uCF5C: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.") || hostname.startsWith("10.") || hostname.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || hostname === "0.0.0.0" || hostname.startsWith("169.254.") || hostname.endsWith(".local") || // IPv6 사설 대역
  hostname.startsWith("[fc") || hostname.startsWith("[fd") || hostname.startsWith("[fe80:") || hostname === "[::0]" || hostname === "[::]" || // 클라우드 메타데이터 엔드포인트
  hostname === "metadata.google.internal" || hostname === "metadata.google" || // 16진수/8진수/10진수 정수 IP 인코딩 우회 방지
  /^0x[0-9a-f]+$/i.test(hostname) || /^0[0-7]+$/.test(hostname) || /^\d+$/.test(hostname)) {
    throw new Error(`\uB0B4\uBD80 \uB124\uD2B8\uC6CC\uD06C \uB300\uC0C1 webhook\uC740 \uD5C8\uC6A9\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4: ${hostname}`);
  }
}
async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    validateWebhookUrl(url);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, timestamp: (/* @__PURE__ */ new Date()).toISOString() }),
      redirect: "error"
    });
  } catch (err) {
    process.stderr.write(`[kordoc watch] webhook \uC804\uC1A1 \uC2E4\uD328: ${err instanceof Error ? err.message : String(err)}
`);
  }
}
export {
  watchDirectory
};
//# sourceMappingURL=watch-2MNRQWGV.js.map