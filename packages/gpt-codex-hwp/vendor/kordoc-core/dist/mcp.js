#!/usr/bin/env node
import {
  compare,
  extractFormFields,
  extractHwp5MetadataOnly,
  extractHwpxMetadataOnly,
  fillFormFields,
  fillHwpx,
  fillWithUniqueGuard,
  markdownToHwpx,
  parse,
  patchHwp,
  patchHwpx
} from "./chunk-7K5P4RNT.js";
import {
  blocksToMarkdown
} from "./chunk-2IBFK5ZO.js";
import {
  detectFormat,
  detectZipFormat
} from "./chunk-MEPHGCPQ.js";
import "./chunk-MOL7MDBG.js";
import "./chunk-NZJAXMN7.js";
import "./chunk-QMJJI6TD.js";
import "./chunk-4RGDFDQ2.js";
import {
  KordocError,
  VERSION,
  sanitizeError,
  toArrayBuffer
} from "./chunk-UNV7F3FK.js";

// src/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, realpathSync, openSync, readSync, closeSync, statSync, mkdirSync } from "fs";
import { resolve, isAbsolute, extname, dirname } from "path";
var ALLOWED_EXTENSIONS = /* @__PURE__ */ new Set([".hwp", ".hwpx", ".pdf", ".xlsx", ".docx"]);
var MAX_FILE_SIZE = 500 * 1024 * 1024;
function safePath(filePath) {
  if (!filePath) throw new KordocError("\uD30C\uC77C \uACBD\uB85C\uAC00 \uBE44\uC5B4\uC788\uC2B5\uB2C8\uB2E4");
  const resolved = resolve(filePath);
  let real;
  try {
    real = realpathSync(resolved);
  } catch (err) {
    if (err?.code === "ENOENT") throw new KordocError(`\uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${resolved}`);
    if (err?.code === "EACCES" || err?.code === "EPERM") throw new KordocError(`\uD30C\uC77C \uC811\uADFC \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4: ${resolved}`);
    throw new KordocError(`\uACBD\uB85C \uCC98\uB9AC \uC624\uB958 [${err?.code ?? "UNKNOWN"}]`);
  }
  if (!isAbsolute(real)) throw new KordocError("\uC808\uB300 \uACBD\uB85C\uB9CC \uD5C8\uC6A9\uB429\uB2C8\uB2E4");
  const ext = extname(real).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new KordocError(`\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD655\uC7A5\uC790\uC785\uB2C8\uB2E4: ${ext} (\uD5C8\uC6A9: ${[...ALLOWED_EXTENSIONS].join(", ")})`);
  return real;
}
var MAX_METADATA_FILE_SIZE = 50 * 1024 * 1024;
function readValidatedFile(filePath, maxSize = MAX_FILE_SIZE) {
  const resolved = safePath(filePath);
  let fileSize;
  try {
    fileSize = statSync(resolved).size;
  } catch (err) {
    throw new KordocError(`\uD30C\uC77C \uC0C1\uD0DC \uC77D\uAE30 \uC2E4\uD328 [${err?.code ?? "UNKNOWN"}]: ${resolved}`);
  }
  if (fileSize > maxSize) {
    throw new KordocError(`\uD30C\uC77C\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${(fileSize / 1024 / 1024).toFixed(1)}MB (\uCD5C\uB300 ${maxSize / 1024 / 1024}MB)`);
  }
  let raw;
  try {
    raw = readFileSync(resolved);
  } catch (err) {
    throw new KordocError(`\uD30C\uC77C \uC77D\uAE30 \uC2E4\uD328 [${err?.code ?? "UNKNOWN"}]: ${resolved}`);
  }
  return { buffer: toArrayBuffer(raw), resolved };
}
function detectFormatFromHeader(resolved) {
  const fd = openSync(resolved, "r");
  try {
    const headerBuf = Buffer.alloc(16);
    readSync(fd, headerBuf, 0, 16, 0);
    return detectFormat(toArrayBuffer(headerBuf));
  } finally {
    closeSync(fd);
  }
}
var server = new McpServer({
  name: "kordoc",
  version: VERSION
});
server.tool(
  "parse_document",
  "\uD55C\uAD6D \uBB38\uC11C \uD30C\uC77C(HWP, HWPX, PDF, XLSX, DOCX)\uC744 \uB9C8\uD06C\uB2E4\uC6B4\uC73C\uB85C \uBCC0\uD658\uD569\uB2C8\uB2E4. \uD30C\uC77C \uACBD\uB85C\uB97C \uC785\uB825\uD558\uBA74 \uD3EC\uB9F7\uC744 \uC790\uB3D9 \uAC10\uC9C0\uD558\uC5EC \uD14D\uC2A4\uD2B8\uB97C \uCD94\uCD9C\uD569\uB2C8\uB2E4.",
  {
    file_path: z.string().min(1).describe("\uD30C\uC2F1\uD560 \uBB38\uC11C \uD30C\uC77C\uC758 \uC808\uB300 \uACBD\uB85C (HWP, HWPX, PDF, XLSX, DOCX)")
  },
  async ({ file_path }) => {
    try {
      const { buffer } = readValidatedFile(file_path);
      const format = detectFormat(buffer);
      if (format === "unknown") {
        return {
          content: [{ type: "text", text: `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD30C\uC77C \uD615\uC2DD\uC785\uB2C8\uB2E4: ${file_path}` }],
          isError: true
        };
      }
      const result = await parse(buffer);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `\uD30C\uC2F1 \uC2E4\uD328 (${result.fileType}): ${result.error}` }],
          isError: true
        };
      }
      const markdown = result.markdown;
      const meta = [
        `\uD3EC\uB9F7: ${result.fileType.toUpperCase()}`,
        result.pageCount ? `\uD398\uC774\uC9C0: ${result.pageCount}` : null,
        result.metadata?.title ? `\uC81C\uBAA9: ${result.metadata.title}` : null,
        result.metadata?.author ? `\uC791\uC131\uC790: ${result.metadata.author}` : null,
        result.isImageBased ? "\uC774\uBBF8\uC9C0 \uAE30\uBC18 PDF (\uD14D\uC2A4\uD2B8 \uCD94\uCD9C \uBD88\uAC00)" : null
      ].filter(Boolean).join(" | ");
      const parts = [`[${meta}]`];
      if (result.outline && result.outline.length > 0) {
        const outlineText = result.outline.map((o) => `${"  ".repeat(o.level - 1)}- ${o.text}`).join("\n");
        parts.push(`
\u{1F4D1} \uBB38\uC11C \uAD6C\uC870:
${outlineText}`);
      }
      if (result.warnings && result.warnings.length > 0) {
        const warnText = result.warnings.map((w) => `- [p${w.page || "?"}] ${w.message}`).join("\n");
        parts.push(`
\u26A0\uFE0F \uACBD\uACE0:
${warnText}`);
      }
      parts.push(`

${markdown}`);
      return {
        content: [{ type: "text", text: parts.join("") }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "detect_format",
  "\uD30C\uC77C\uC758 \uD3EC\uB9F7\uC744 \uB9E4\uC9C1 \uBC14\uC774\uD2B8\uB85C \uAC10\uC9C0\uD569\uB2C8\uB2E4 (hwpx, hwp, pdf, unknown).",
  {
    file_path: z.string().min(1).describe("\uAC10\uC9C0\uD560 \uD30C\uC77C\uC758 \uC808\uB300 \uACBD\uB85C")
  },
  async ({ file_path }) => {
    try {
      const resolved = safePath(file_path);
      const format = detectFormatFromHeader(resolved);
      return {
        content: [{ type: "text", text: `${file_path}: ${format}` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "parse_metadata",
  "\uBB38\uC11C\uC758 \uBA54\uD0C0\uB370\uC774\uD130(\uC81C\uBAA9, \uC791\uC131\uC790, \uB0A0\uC9DC \uB4F1)\uB9CC \uBE60\uB974\uAC8C \uCD94\uCD9C\uD569\uB2C8\uB2E4. \uC804\uCCB4 \uD30C\uC2F1 \uC5C6\uC774 \uD5E4\uB354/\uB9E4\uB2C8\uD398\uC2A4\uD2B8\uB9CC \uC77D\uC2B5\uB2C8\uB2E4.",
  {
    file_path: z.string().min(1).describe("\uBA54\uD0C0\uB370\uC774\uD130\uB97C \uCD94\uCD9C\uD560 \uBB38\uC11C \uD30C\uC77C\uC758 \uC808\uB300 \uACBD\uB85C")
  },
  async ({ file_path }) => {
    try {
      const resolved = safePath(file_path);
      const format = detectFormatFromHeader(resolved);
      if (format === "unknown") {
        return {
          content: [{ type: "text", text: `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD30C\uC77C \uD615\uC2DD\uC785\uB2C8\uB2E4: ${file_path}` }],
          isError: true
        };
      }
      const { buffer } = readValidatedFile(file_path, MAX_METADATA_FILE_SIZE);
      let metadata;
      let effectiveFormat = format;
      if (format === "hwpx") {
        const { detectZipFormat: detectZipFormat2 } = await import("./detect-RI2MQ33K.js");
        const zipFormat = await detectZipFormat2(buffer);
        if (zipFormat === "xlsx" || zipFormat === "docx") effectiveFormat = zipFormat;
      }
      switch (effectiveFormat) {
        case "hwp":
          metadata = extractHwp5MetadataOnly(Buffer.from(buffer));
          break;
        case "hwpx":
          metadata = await extractHwpxMetadataOnly(buffer);
          break;
        case "pdf":
          try {
            const { extractPdfMetadataOnly } = await import("./parser-DOBK652H.js");
            metadata = await extractPdfMetadataOnly(buffer);
          } catch {
            metadata = void 0;
          }
          break;
        case "xlsx":
        case "docx": {
          const result = await parse(buffer);
          metadata = result.success ? result.metadata : void 0;
          break;
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ format, ...metadata }, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "parse_pages",
  "\uBB38\uC11C\uC758 \uD2B9\uC815 \uD398\uC774\uC9C0/\uC139\uC158 \uBC94\uC704\uB9CC \uD30C\uC2F1\uD569\uB2C8\uB2E4. PDF\uB294 \uC815\uD655\uD55C \uD398\uC774\uC9C0, HWP/HWPX\uB294 \uC139\uC158 \uB2E8\uC704 \uADFC\uC0AC\uCE58\uC785\uB2C8\uB2E4.",
  {
    file_path: z.string().min(1).describe("\uD30C\uC2F1\uD560 \uBB38\uC11C \uD30C\uC77C\uC758 \uC808\uB300 \uACBD\uB85C"),
    pages: z.string().min(1).describe("\uD398\uC774\uC9C0 \uBC94\uC704 (\uC608: '1-3', '1,3,5-7')")
  },
  async ({ file_path, pages }) => {
    try {
      const { buffer } = readValidatedFile(file_path);
      const format = detectFormat(buffer);
      if (format === "unknown") {
        return {
          content: [{ type: "text", text: `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD30C\uC77C \uD615\uC2DD\uC785\uB2C8\uB2E4: ${file_path}` }],
          isError: true
        };
      }
      const result = await parse(buffer, { pages });
      if (!result.success) {
        return {
          content: [{ type: "text", text: `\uD30C\uC2F1 \uC2E4\uD328 (${result.fileType}): ${result.error}` }],
          isError: true
        };
      }
      const meta = [
        `\uD3EC\uB9F7: ${result.fileType.toUpperCase()}`,
        `\uBC94\uC704: ${pages}`,
        result.pageCount ? `\uD398\uC774\uC9C0: ${result.pageCount}` : null
      ].filter(Boolean).join(" | ");
      return {
        content: [{ type: "text", text: `[${meta}]

${result.markdown}` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "parse_table",
  "\uBB38\uC11C\uC5D0\uC11C N\uBC88\uC9F8 \uD14C\uC774\uBE14\uB9CC \uCD94\uCD9C\uD569\uB2C8\uB2E4 (0-based index). \uD14C\uC774\uBE14\uC774 \uC5C6\uAC70\uB098 \uC778\uB371\uC2A4 \uBC94\uC704\uB97C \uCD08\uACFC\uD558\uBA74 \uC624\uB958\uB97C \uBC18\uD658\uD569\uB2C8\uB2E4.",
  {
    file_path: z.string().min(1).describe("\uD30C\uC2F1\uD560 \uBB38\uC11C \uD30C\uC77C\uC758 \uC808\uB300 \uACBD\uB85C"),
    table_index: z.number().int().min(0).describe("\uCD94\uCD9C\uD560 \uD14C\uC774\uBE14 \uC778\uB371\uC2A4 (0\uBD80\uD130 \uC2DC\uC791)")
  },
  async ({ file_path, table_index }) => {
    try {
      const { buffer } = readValidatedFile(file_path);
      const format = detectFormat(buffer);
      if (format === "unknown") {
        return {
          content: [{ type: "text", text: `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD30C\uC77C \uD615\uC2DD\uC785\uB2C8\uB2E4: ${file_path}` }],
          isError: true
        };
      }
      const result = await parse(buffer);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `\uD30C\uC2F1 \uC2E4\uD328 (${result.fileType}): ${result.error}` }],
          isError: true
        };
      }
      const tableBlocks = result.blocks.filter((b) => b.type === "table" && b.table);
      if (tableBlocks.length === 0) {
        return {
          content: [{ type: "text", text: `\uBB38\uC11C\uC5D0 \uD14C\uC774\uBE14\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.` }],
          isError: true
        };
      }
      if (table_index >= tableBlocks.length) {
        return {
          content: [{ type: "text", text: `\uD14C\uC774\uBE14 \uC778\uB371\uC2A4 \uCD08\uACFC: ${table_index} (\uCD1D ${tableBlocks.length}\uAC1C \uD14C\uC774\uBE14)` }],
          isError: true
        };
      }
      const tableBlock = tableBlocks[table_index];
      const tableMarkdown = blocksToMarkdown([tableBlock]);
      return {
        content: [{ type: "text", text: `[\uD14C\uC774\uBE14 #${table_index} / \uCD1D ${tableBlocks.length}\uAC1C]

${tableMarkdown}` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "compare_documents",
  "\uB450 \uD55C\uAD6D \uBB38\uC11C \uD30C\uC77C\uC744 \uBE44\uAD50\uD558\uC5EC \uCD94\uAC00/\uC0AD\uC81C/\uBCC0\uACBD\uB41C \uBE14\uB85D\uC744 \uD45C\uC2DC\uD569\uB2C8\uB2E4. \uC2E0\uAD6C\uB300\uC870\uD45C \uC0DD\uC131\uC5D0 \uD65C\uC6A9\uB429\uB2C8\uB2E4. \uD06C\uB85C\uC2A4 \uD3EC\uB9F7(HWP\u2194HWPX) \uBE44\uAD50 \uAC00\uB2A5.",
  {
    file_path_a: z.string().min(1).describe("\uBE44\uAD50 \uC6D0\uBCF8 \uBB38\uC11C\uC758 \uC808\uB300 \uACBD\uB85C"),
    file_path_b: z.string().min(1).describe("\uBE44\uAD50 \uB300\uC0C1 \uBB38\uC11C\uC758 \uC808\uB300 \uACBD\uB85C")
  },
  async ({ file_path_a, file_path_b }) => {
    try {
      const { buffer: bufA } = readValidatedFile(file_path_a);
      const { buffer: bufB } = readValidatedFile(file_path_b);
      const result = await compare(bufA, bufB);
      const { stats, diffs } = result;
      const lines = [
        `## \uBB38\uC11C \uBE44\uAD50 \uACB0\uACFC`,
        `\uCD94\uAC00: ${stats.added} | \uC0AD\uC81C: ${stats.removed} | \uBCC0\uACBD: ${stats.modified} | \uB3D9\uC77C: ${stats.unchanged}`,
        ""
      ];
      for (const d of diffs) {
        const prefix = d.type === "added" ? "+" : d.type === "removed" ? "-" : d.type === "modified" ? "~" : " ";
        const text = d.after?.text || d.before?.text || (d.after?.table ? "[\uD14C\uC774\uBE14]" : d.before?.table ? "[\uD14C\uC774\uBE14]" : "");
        const sim = d.similarity !== void 0 ? ` (${(d.similarity * 100).toFixed(0)}%)` : "";
        lines.push(`${prefix} ${text.substring(0, 200)}${sim}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "parse_form",
  "\uD55C\uAD6D \uC11C\uC2DD \uBB38\uC11C\uC5D0\uC11C \uB808\uC774\uBE14-\uAC12 \uC30D\uC744 \uAD6C\uC870\uD654\uB41C JSON\uC73C\uB85C \uCD94\uCD9C\uD569\uB2C8\uB2E4. \uC591\uC2DD/\uC11C\uC2DD \uBB38\uC11C\uC5D0 \uCD5C\uC801\uD654.",
  {
    file_path: z.string().min(1).describe("\uC11C\uC2DD \uBB38\uC11C \uD30C\uC77C\uC758 \uC808\uB300 \uACBD\uB85C")
  },
  async ({ file_path }) => {
    try {
      const { buffer } = readValidatedFile(file_path);
      const result = await parse(buffer);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `\uD30C\uC2F1 \uC2E4\uD328: ${result.error}` }],
          isError: true
        };
      }
      const form = extractFormFields(result.blocks);
      return {
        content: [{ type: "text", text: JSON.stringify(form, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
function buildFillInputs(fields, formats) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    const format = formats?.[k];
    out[k] = format ? { value: v, format } : v;
  }
  return out;
}
server.tool(
  "fill_form",
  "\uD55C\uAD6D \uC11C\uC2DD \uBB38\uC11C\uC758 \uBE48\uCE78\uC744 \uCC44\uC6CC\uC11C \uC0C8 \uBB38\uC11C\uB85C \uCD9C\uB825\uD569\uB2C8\uB2E4. hwpx-preserve\uB97C \uC0AC\uC6A9\uD558\uBA74 \uC6D0\uBCF8 \uC11C\uC2DD(\uD14C\uB450\uB9AC, \uD3F0\uD2B8, \uBCD1\uD569 \uB4F1)\uC744 100% \uC720\uC9C0\uD569\uB2C8\uB2E4.",
  {
    file_path: z.string().min(1).describe("\uC11C\uC2DD \uD15C\uD50C\uB9BF \uBB38\uC11C\uC758 \uC808\uB300 \uACBD\uB85C (HWP, HWPX, PDF, XLSX, DOCX)"),
    fields: z.record(z.string(), z.string()).describe('\uCC44\uC6B8 \uD544\uB4DC \uB9F5 (\uB77C\uBCA8 \u2192 \uAC12). \uC608: {"\uC131\uBA85": "\uD64D\uAE38\uB3D9", "\uC804\uD654\uBC88\uD638": "010-1234-5678"}'),
    formats: z.record(z.string(), z.string()).optional().describe("\uD544\uB4DC\uBCC4 \uAC12 \uC11C\uC2DD (\uB77C\uBCA8 \u2192 \uD3EC\uB9F7). \uC815\uC900\uAC12 \uD558\uB098\uB85C \uC11C\uC2DD\uB9C8\uB2E4 \uB2E4\uB978 \uBAA8\uC591\uC744 \uCC44\uC6B8 \uB54C: date:yy.mm.dd / phone:hyphen\xB7dot\xB7digits / rrn:hyphen\xB7masked / mask:###-## / \uC790\uC720 \uD328\uD134(yyyy\uB144 m\uC6D4 d\uC77C, ###-####-####)"),
    require_unique: z.boolean().optional().describe("\uD55C \uD0A4\uAC00 \uC11C\uC2DD\uC758 2\uACF3 \uC774\uC0C1\uC5D0 \uB9E4\uCE6D\uB418\uBA74 \uCC44\uC6B0\uC9C0 \uC54A\uACE0 \uAC70\uBD80 \u2014 \uBC18\uBCF5 \uB77C\uBCA8 \uC591\uC2DD\uC5D0\uC11C \uB0A8\uC758 \uBE14\uB85D \uC624\uC5FC \uBC29\uC9C0 (\uBC30\uC5F4 \uAC12\uC740 \uC608\uC678)"),
    mask_values: z.boolean().optional().describe("\uC751\uB2F5\uC5D0 \uAC12 \uB300\uC2E0 \uAE00\uC790\uC218\uB9CC \uD45C\uC2DC \u2014 \uAC1C\uC778\uC815\uBCF4 \uCC44\uC6C0 \uC2DC \uAC12\uC774 \uB300\uD654 \uB85C\uADF8\uC5D0 \uB0A8\uC9C0 \uC54A\uAC8C"),
    output_format: z.enum(["markdown", "hwpx", "hwpx-preserve"]).default("hwpx-preserve").describe("\uCD9C\uB825 \uD3EC\uB9F7: hwpx-preserve (\uC6D0\uBCF8 \uC2A4\uD0C0\uC77C \uBCF4\uC874, HWPX \uC804\uC6A9), hwpx (\uC0C8 HWPX \uC0DD\uC131), markdown"),
    output_path: z.string().optional().describe("\uCD9C\uB825 \uD30C\uC77C \uC800\uC7A5 \uACBD\uB85C (\uC120\uD0DD). \uC9C0\uC815 \uC2DC \uD30C\uC77C\uB85C \uC800\uC7A5, \uBBF8\uC9C0\uC815 \uC2DC \uD14D\uC2A4\uD2B8\uB85C \uBC18\uD658")
  },
  async ({ file_path, fields, formats, require_unique, mask_values, output_format, output_path }) => {
    try {
      const { buffer } = readValidatedFile(file_path);
      if (output_format === "hwpx-preserve") {
        const format = detectFormat(buffer);
        let isHwpx = format === "hwpx";
        if (isHwpx) {
          const zipFormat = await detectZipFormat(buffer);
          isHwpx = zipFormat === "hwpx";
        }
        if (!isHwpx) {
          return {
            content: [{ type: "text", text: `hwpx-preserve\uB294 HWPX \uD30C\uC77C\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4 (\uAC10\uC9C0\uB41C \uD3EC\uB9F7: ${format}). hwpx \uB610\uB294 markdown\uC744 \uC0AC\uC6A9\uD558\uC138\uC694.` }],
            isError: true
          };
        }
        const inputs = buildFillInputs(fields, formats);
        const hwpxResult = require_unique ? await fillWithUniqueGuard(inputs, (vals, blocked) => fillHwpx(buffer, vals, blocked)) : { ...await fillHwpx(buffer, inputs), rejected: [] };
        let verifyLine = null;
        if (mask_values && hwpxResult.filled.length > 0) {
          const reparsed = await parse(Buffer.from(hwpxResult.buffer));
          const norm = (s) => s.replace(/\\([\\`*_{}[\]()#+.!|~>-])/g, "$1").replace(/\s+/g, " ");
          const normMd = reparsed.success ? norm(reparsed.markdown) : "";
          const okCount = reparsed.success ? hwpxResult.filled.filter((f) => f.value !== "" && normMd.includes(norm(f.value))).length : 0;
          verifyLine = `\uAC80\uC99D(\uB9C8\uC2A4\uD0B9): ${okCount}/${hwpxResult.filled.length} FILLED \u2014 \uC7AC\uD30C\uC2F1 \uB300\uC870, \uAC12 \uBBF8\uB178\uCD9C`;
        }
        const summary2 = [
          `\uCC44\uC6CC\uC9C4 \uD544\uB4DC: ${hwpxResult.filled.length}\uAC1C (\uC6D0\uBCF8 \uC2A4\uD0C0\uC77C \uBCF4\uC874)`,
          hwpxResult.rejected.length > 0 ? `\uBAA8\uD638 \uB77C\uBCA8 \uAC70\uBD80(2\uACF3+ \uB9E4\uCE6D): ${hwpxResult.rejected.join(", ")}` : null,
          hwpxResult.unmatched.length > 0 ? `\uB9E4\uCE6D \uC2E4\uD328: ${hwpxResult.unmatched.join(", ")}` : null,
          verifyLine
        ].filter(Boolean).join(" | ");
        const filledList = hwpxResult.filled.map((f) => `  - ${f.label}: ${mask_values ? `[${[...f.value].length}\uC790]` : f.value}`).join("\n");
        if (output_path) {
          mkdirSync(dirname(resolve(output_path)), { recursive: true });
          writeFileSync(resolve(output_path), Buffer.from(hwpxResult.buffer));
          return {
            content: [{ type: "text", text: `[${summary2}]

\uCC44\uC6CC\uC9C4 \uD544\uB4DC:
${filledList}

HWPX \uD30C\uC77C \uC800\uC7A5 (\uC6D0\uBCF8 \uC11C\uC2DD \uC720\uC9C0): ${resolve(output_path)}` }]
          };
        }
        return {
          content: [{ type: "text", text: `[${summary2}]

\uCC44\uC6CC\uC9C4 \uD544\uB4DC:
${filledList}

\u26A0\uFE0F output_path\uB97C \uC9C0\uC815\uD558\uBA74 \uC6D0\uBCF8 \uC11C\uC2DD\uC774 \uC720\uC9C0\uB41C HWPX \uD30C\uC77C\uB85C \uC800\uC7A5\uB429\uB2C8\uB2E4.` }]
        };
      }
      const result = await parse(buffer);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `\uD30C\uC2F1 \uC2E4\uD328: ${result.error}` }],
          isError: true
        };
      }
      const formInfo = extractFormFields(result.blocks);
      const irInputs = buildFillInputs(fields, formats);
      const fillResult = require_unique ? await fillWithUniqueGuard(irInputs, (vals, blocked) => fillFormFields(result.blocks, vals, blocked)) : { ...fillFormFields(result.blocks, irInputs), rejected: [] };
      if (fillResult.filled.length === 0 && formInfo.fields.length === 0) {
        return {
          content: [{ type: "text", text: `\uC11C\uC2DD \uD544\uB4DC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC77C\uBC18 \uBB38\uC11C\uC774\uAC70\uB098 \uC11C\uC2DD \uD328\uD134\uC774 \uAC10\uC9C0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.` }],
          isError: true
        };
      }
      const markdown = blocksToMarkdown(fillResult.blocks);
      const previewMd = mask_values ? "\u26A0\uFE0F mask_values \uD65C\uC131 \u2014 \uAC1C\uC778\uC815\uBCF4 \uB178\uCD9C \uBC29\uC9C0\uB97C \uC704\uD574 \uBCF8\uBB38\uC744 \uC751\uB2F5\uC5D0 \uD3EC\uD568\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. output_path \uB85C \uD30C\uC77C \uC800\uC7A5 \uD6C4 \uD655\uC778\uD558\uC138\uC694." : markdown;
      const summary = [
        `\uCC44\uC6CC\uC9C4 \uD544\uB4DC: ${fillResult.filled.length}\uAC1C`,
        fillResult.rejected.length > 0 ? `\uBAA8\uD638 \uB77C\uBCA8 \uAC70\uBD80(2\uACF3+ \uB9E4\uCE6D): ${fillResult.rejected.join(", ")}` : null,
        fillResult.unmatched.length > 0 ? `\uB9E4\uCE6D \uC2E4\uD328: ${fillResult.unmatched.join(", ")}` : null,
        formInfo.fields.length > 0 ? `\uC11C\uC2DD \uD544\uB4DC: ${formInfo.fields.length}\uAC1C (\uD655\uC2E0\uB3C4 ${(formInfo.confidence * 100).toFixed(0)}%)` : null
      ].filter(Boolean).join(" | ");
      if (output_format === "hwpx") {
        const hwpxBuffer = await markdownToHwpx(markdown);
        if (output_path) {
          mkdirSync(dirname(resolve(output_path)), { recursive: true });
          writeFileSync(resolve(output_path), Buffer.from(hwpxBuffer));
          return {
            content: [{ type: "text", text: `[${summary}]

HWPX \uD30C\uC77C \uC800\uC7A5: ${resolve(output_path)}` }]
          };
        }
        return {
          content: [{ type: "text", text: `[${summary}]

\u26A0\uFE0F output_path\uB97C \uC9C0\uC815\uD558\uBA74 HWPX \uD30C\uC77C\uB85C \uC800\uC7A5\uB429\uB2C8\uB2E4. \uBBF8\uB9AC\uBCF4\uAE30:

${previewMd}` }]
        };
      }
      if (output_path) {
        mkdirSync(dirname(resolve(output_path)), { recursive: true });
        writeFileSync(resolve(output_path), markdown, "utf-8");
        return {
          content: [{ type: "text", text: `[${summary}]

\uB9C8\uD06C\uB2E4\uC6B4 \uD30C\uC77C \uC800\uC7A5: ${resolve(output_path)}

${previewMd}` }]
        };
      }
      return {
        content: [{ type: "text", text: `[${summary}]

${previewMd}` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "place_seal",
  '\uB3C4\uC7A5/\uC11C\uBA85 \uC774\uBBF8\uC9C0\uB97C \uC575\uCEE4 \uBB38\uAD6C("(\uC778)"\xB7"\uC11C\uBA85 \uB610\uB294 \uC778" \uB4F1) \uC704\uC5D0 \uBD80\uC720(\uAE00 \uC55E) \uBC30\uCE58\uD569\uB2C8\uB2E4. \uD45C/\uD398\uC774\uC9C0\uB97C \uD0A4\uC6B0\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4 (HWPX \uC804\uC6A9).',
  {
    file_path: z.string().min(1).describe("\uB300\uC0C1 HWPX \uBB38\uC11C\uC758 \uC808\uB300 \uACBD\uB85C"),
    image_path: z.string().min(1).describe("\uB3C4\uC7A5/\uC11C\uBA85 \uC774\uBBF8\uC9C0 \uC808\uB300 \uACBD\uB85C (\uD22C\uBA85 \uBC30\uACBD PNG \uAD8C\uC7A5)"),
    anchor: z.string().default("(\uC778)").describe("\uC575\uCEE4 \uBB38\uAD6C \u2014 \uC774 \uBB38\uAD6C \uAE30\uC900\uC73C\uB85C \uBC30\uCE58"),
    occurrence: z.number().int().min(0).default(0).describe("\uAC19\uC740 \uC575\uCEE4\uAC00 \uC5EC\uB7FF\uC77C \uB54C 0-based \uC120\uD0DD"),
    size_mm: z.number().positive().optional().describe("\uB3C4\uC7A5 \uD55C \uBCC0 \uD06C\uAE30 mm (\uAE30\uBCF8: \uC904\uB192\uC774\xD71.6, 7~18 \uD074\uB7A8\uD504)"),
    mode: z.enum(["overlap", "right", "auto"]).default("auto").describe("overlap=\uBB38\uAD6C \uC704 \uACB9\uCE68, right=\uBB38\uAD6C \uC624\uB978\uCABD \uC606, auto=\uACF5\uAC04 \uC788\uC73C\uBA74 right"),
    dx_mm: z.number().optional().describe("x \uBBF8\uC138\uC870\uC815 mm"),
    dy_mm: z.number().optional().describe("y \uBBF8\uC138\uC870\uC815 mm"),
    output_path: z.string().min(1).describe("\uCD9C\uB825 HWPX \uC800\uC7A5 \uACBD\uB85C")
  },
  async ({ file_path, image_path, anchor, occurrence, size_mm, mode, dx_mm, dy_mm, output_path }) => {
    try {
      const { buffer } = readValidatedFile(file_path);
      const format = detectFormat(buffer);
      if (format !== "hwpx") {
        return {
          content: [{ type: "text", text: `place_seal \uC740 HWPX \uD30C\uC77C\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4 (\uAC10\uC9C0\uB41C \uD3EC\uB9F7: ${format}).` }],
          isError: true
        };
      }
      const imgResolved = resolve(image_path);
      if (statSync(imgResolved).size > 500 * 1024 * 1024) {
        return { content: [{ type: "text", text: `\uB3C4\uC7A5 \uC774\uBBF8\uC9C0\uAC00 \uB108\uBB34 \uD07D\uB2C8\uB2E4 (${(statSync(imgResolved).size / 1024 / 1024).toFixed(0)}MB) \u2014 500MB \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.` }], isError: true };
      }
      const image = new Uint8Array(readFileSync(imgResolved));
      const ext = extname(image_path).slice(1).toLowerCase() || "png";
      const { placeSealHwpx } = await import("./seal-6Z6H4YXN.js");
      const result = await placeSealHwpx(buffer, [{
        anchor,
        occurrence,
        image,
        ext,
        sizeMm: size_mm,
        mode,
        dxMm: dx_mm,
        dyMm: dy_mm
      }]);
      mkdirSync(dirname(resolve(output_path)), { recursive: true });
      writeFileSync(resolve(output_path), Buffer.from(result.buffer));
      const p0 = result.placed[0];
      const warnLines = (p0.warnings ?? []).map((w) => `
\u26A0\uFE0F ${w}`).join("");
      return {
        content: [{
          type: "text",
          text: `\uB3C4\uC7A5 \uBC30\uCE58 \uC644\uB8CC: "${p0.anchor}" #${p0.occurrence} \u2192 ${p0.mode} (x ${p0.posXMm}mm, y ${p0.posYMm}mm, ${p0.sizeMm}mm\uAC01, ${p0.entry})
\uC800\uC7A5: ${resolve(output_path)}${warnLines}
\uD45C/\uD398\uC774\uC9C0 \uBD88\uD655\uC7A5(\uAE00 \uC55E \uBD80\uC720) \u2014 \uD55C\uCEF4\uC5D0\uC11C \uC704\uCE58 \uD655\uC778 \uD6C4 dx_mm/dy_mm \uB85C \uBBF8\uC138\uC870\uC815 \uAC00\uB2A5\uD569\uB2C8\uB2E4.`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uB3C4\uC7A5 \uBC30\uCE58 \uC2E4\uD328: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "patch_document",
  "\uC6D0\uBCF8 HWPX/HWP\uC758 \uC11C\uC2DD(\uAE00\uAF34\xB7\uD45C\xB7\uB3C4\uC7A5\uCE78\xB7\uC774\uBBF8\uC9C0)\uC744 1\uBC14\uC774\uD2B8\uB3C4 \uAC74\uB4DC\uB9AC\uC9C0 \uC54A\uACE0, \uD3B8\uC9D1\uB41C \uB9C8\uD06C\uB2E4\uC6B4\uC758 \uBC14\uB010 \uD14D\uC2A4\uD2B8\uB9CC \uC81C\uC790\uB9AC \uCE58\uD658\uD574 \uC0C8 \uBB38\uC11C\uB85C \uCD9C\uB825\uD569\uB2C8\uB2E4. parse_document\uB85C \uC5BB\uC740 \uB9C8\uD06C\uB2E4\uC6B4\uC744 \uC218\uC815\uD574 \uB118\uAE30\uC138\uC694 \u2014 \uC591\uC2DD \uBE48\uCE78 \uCC44\uC6B0\uAE30\xB7\uBB38\uAD6C \uC218\uC815\uC5D0 \uC801\uD569\uD558\uBA70 \uD55C\uCEF4 \uD55C\uAE00\uC5D0\uC11C \uBCC0\uC870 \uACBD\uACE0 \uC5C6\uC774 \uC5F4\uB9BD\uB2C8\uB2E4. (\uBE14\uB85D \uCD94\uAC00/\uC0AD\uC81C\xB7\uD45C \uAD6C\uC870 \uBCC0\uACBD\uC740 \uBBF8\uC9C0\uC6D0, \uBBF8\uC801\uC6A9 \uD56D\uBAA9\uC740 \uACB0\uACFC\uC5D0 \uBCF4\uACE0)",
  {
    file_path: z.string().min(1).describe("\uC6D0\uBCF8 \uBB38\uC11C\uC758 \uC808\uB300 \uACBD\uB85C (HWPX \uB610\uB294 HWP 5.x)"),
    edited_markdown: z.string().min(1).describe("parse_document \uCD9C\uB825 \uB9C8\uD06C\uB2E4\uC6B4\uC744 \uD3B8\uC9D1\uD55C \uC804\uCCB4 \uB9C8\uD06C\uB2E4\uC6B4. \uBC14\uB010 \uBB38\uB2E8/\uC140 \uD14D\uC2A4\uD2B8\uB9CC \uBC18\uC601\uD558\uACE0 \uBE14\uB85D \uC218\xB7\uC21C\uC11C\uB294 \uC6D0\uBCF8\uACFC \uAC19\uAC8C \uC720\uC9C0\uD558\uC138\uC694"),
    output_path: z.string().min(1).describe("\uCD9C\uB825 \uD30C\uC77C \uC800\uC7A5 \uC808\uB300 \uACBD\uB85C (\uC6D0\uBCF8\uACFC \uAC19\uC740 \uD655\uC7A5\uC790: .hwpx \uB610\uB294 .hwp)")
  },
  async ({ file_path, edited_markdown, output_path }) => {
    try {
      const { buffer } = readValidatedFile(file_path);
      const format = detectFormat(buffer);
      let isHwpx = format === "hwpx";
      if (isHwpx) {
        const zipFormat = await detectZipFormat(buffer);
        isHwpx = zipFormat === "hwpx";
      }
      if (!isHwpx && format !== "hwp") {
        return {
          content: [{ type: "text", text: `patch_document\uB294 HWPX \uB610\uB294 HWP 5.x\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4 (\uAC10\uC9C0\uB41C \uD3EC\uB9F7: ${format}).` }],
          isError: true
        };
      }
      const original = new Uint8Array(buffer);
      const result = isHwpx ? await patchHwpx(original, edited_markdown) : await patchHwp(original, edited_markdown);
      if (!result.success || !result.data) {
        return {
          content: [{ type: "text", text: `\uD328\uCE58 \uC2E4\uD328: ${result.error ?? "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}` }],
          isError: true
        };
      }
      const out = resolve(output_path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(result.data));
      const v = result.verification?.stats;
      const lossless = v ? v.modified === 0 && v.added === 0 && v.removed === 0 : void 0;
      const lines = [
        `\u2713 ${result.applied}\uAC1C \uBCC0\uACBD \uC801\uC6A9 (${isHwpx ? "HWPX" : "HWP"}, \uC6D0\uBCF8 \uC11C\uC2DD \uBCF4\uC874) \u2192 ${out}`,
        lossless === true ? "\uAC80\uC99D: \uD3B8\uC9D1 \uB0B4\uC6A9\uACFC \uC7AC\uD30C\uC2F1 \uACB0\uACFC \uC644\uC804 \uC77C\uCE58" : lossless === false ? `\uAC80\uC99D \uC794\uCC28: \uC218\uC815 ${v.modified} \xB7 \uCD94\uAC00 ${v.added} \xB7 \uC0AD\uC81C ${v.removed} (\uBC18\uC601 \uC548 \uB41C \uD3B8\uC9D1 \uC788\uC74C)` : null,
        result.skipped.length > 0 ? `\uBBF8\uC801\uC6A9 ${result.skipped.length}\uAC74:
` + result.skipped.map((s) => `  - ${s.reason}`).join("\n") : null
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
server.tool(
  "generate_document",
  "\uB9C8\uD06C\uB2E4\uC6B4\uC744 HWPX \uD55C\uAE00 \uBB38\uC11C\uB85C \uC0DD\uC131\uD569\uB2C8\uB2E4. GFM \uD45C(| \uD5E4\uB354 | \u2026 |)\xB7\uD5E4\uB529\xB7\uB9AC\uC2A4\uD2B8\xB7\uBCFC\uB4DC\uB97C \uD55C\uAE00 \uBB38\uC11C \uC694\uC18C\uB85C \uBCC0\uD658\uD558\uBA70, \uACF5\uBB38\uC11C \uD504\uB9AC\uC14B \uC9C0\uC815 \uC2DC \uD589\uC815 \uD45C\uC900 \uC11C\uC2DD(\uD56D\uBAA9\uBD80\uD638 8\uB2E8\uACC4\xB7\uACF5\uC2DD \uC5EC\uBC31\xB7\uBA85\uC870 15pt)\uC73C\uB85C \uB80C\uB354\uB9C1\uD569\uB2C8\uB2E4. \uD65C\uC6A9: \uD3C9\uBB38 \uBB38\uC7A5\uC744 \uD45C\uB85C \uAD6C\uC870\uD654\uD574 \uC0C8 \uD55C\uAE00\uD30C\uC77C\uB85C \uB9CC\uB4E4\uAC70\uB098, parse_document\uB85C \uC77D\uC740 \uB0B4\uC6A9\uC744 \uD3B8\uC9D1\uD574 \uB2E4\uC2DC HWPX\uB85C \uCD9C\uB825. (\uC6D0\uBCF8 \uC11C\uC2DD\uC744 \uBCF4\uC874\uD558\uBA70 \uC77C\uBD80 \uD14D\uC2A4\uD2B8/\uD45C\uB9CC \uC81C\uC790\uB9AC \uC218\uC815\uD558\uB824\uBA74 patch_document \uC0AC\uC6A9)",
  {
    markdown: z.string().min(1).describe("HWPX\uB85C \uBCC0\uD658\uD560 \uB9C8\uD06C\uB2E4\uC6B4 \uC804\uBB38. \uD45C\uB294 GFM \uBB38\uBC95 \uC0AC\uC6A9 (\uC608: '| \uC774\uB984 | \uBD80\uC11C |\\n| --- | --- |\\n| \uD64D\uAE38\uB3D9 | \uAE30\uD68D\uD300 |')"),
    output_path: z.string().min(1).describe("\uCD9C\uB825 HWPX \uD30C\uC77C\uC758 \uC808\uB300 \uACBD\uB85C (.hwpx \uAD8C\uC7A5)"),
    preset: z.enum(["\uAE30\uC548\uBB38", "\uBCF4\uACE0\uC11C", "\uACC4\uD68D\uC11C", "\uD1B5\uC9C0", "\uD68C\uC758\uB85D", "official", "report", "plan", "notice", "minutes"]).optional().describe("\uACF5\uBB38\uC11C \uD504\uB9AC\uC14B \u2014 \uC9C0\uC815 \uC2DC \uD55C\uAD6D \uD589\uC815 \uACF5\uBB38\uC11C \uD45C\uC900 \uC11C\uC2DD \uC801\uC6A9. \uBBF8\uC9C0\uC815 \uC2DC \uBC94\uC6A9 \uB9C8\uD06C\uB2E4\uC6B4 \uBCC0\uD658"),
    font: z.enum(["myeongjo", "gothic"]).optional().describe("\uBCF8\uBB38 \uAE00\uAF34(\uACF5\uBB38\uC11C \uBAA8\uB4DC): myeongjo=\uD568\uCD08\uB86C\uBC14\uD0D5(\uBA85\uC870), gothic=\uB9D1\uC740 \uACE0\uB515"),
    body_pt: z.number().int().min(6).max(40).optional().describe("\uBCF8\uBB38 \uAE00\uC790 \uD06C\uAE30(pt, \uACF5\uBB38\uC11C \uBAA8\uB4DC). \uAE30\uBCF8 15")
  },
  async ({ markdown, output_path, preset, font, body_pt }) => {
    try {
      let gongmun;
      if (preset) {
        gongmun = { preset };
        if (font) gongmun.bodyFont = font;
        if (body_pt) gongmun.bodyPt = body_pt;
      }
      const buf = await markdownToHwpx(markdown, gongmun ? { gongmun } : void 0);
      const out = resolve(output_path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(buf));
      const mode = gongmun ? `\uACF5\uBB38\uC11C:${gongmun.preset}` : "\uBC94\uC6A9";
      const tableCount = (markdown.match(/^\s*\|.*\|\s*$/gm) || []).length > 0 ? `, \uD45C \uD3EC\uD568` : "";
      return {
        content: [{ type: "text", text: `\u2713 HWPX \uC0DD\uC131 (${mode}${tableCount}) \u2192 ${out}
\uD06C\uAE30: ${(buf.byteLength / 1024).toFixed(1)}KB` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `\uC624\uB958: ${sanitizeError(err)}` }],
        isError: true
      };
    }
  }
);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
//# sourceMappingURL=mcp.js.map