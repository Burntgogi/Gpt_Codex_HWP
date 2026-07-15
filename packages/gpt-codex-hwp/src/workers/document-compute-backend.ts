import { read as readFd } from "node:fs";

import type {
  FillInput,
  FileType,
  FormField,
  ParseResult,
  PlaceSealResult,
  ValidateResult,
} from "kordoc";

import { assertSafeSvgString } from "../shared/svg-policy.js";

import { isIntegrityVerifiedResultSpool } from "./document-child-client.js";
import {
  createDocumentEngineRunError,
  DocumentEngineRunError,
} from "./document-errors.js";
import type { IntegrityVerifiedResultSpool } from "./document-execution-policy.js";
import {
  MAX_DOCUMENT_ENGINE_RESULT_BYTES,
  MAX_SAFE_JSON_BYTES,
  measureDocumentResultByteLength,
  resultSpoolEncoding,
  type DocumentEngineOperation,
  type DocumentResultPayload,
  type DocumentSpoolEligibleOperation,
  type SafeJsonValue,
  type WireDocumentRequest,
} from "./document-protocol.js";

const PARSE_SPOOL_VERSION = 1;
const PARSE_SPOOL_PREFIX_BYTES = 4;
const RENDER_SPOOL_VERSION = 1;
const RENDER_SPOOL_PREFIX_BYTES = 4;

type KordocModule = typeof import("kordoc");
type RhwpLoadResult = Awaited<ReturnType<
  typeof import("../tools/rhwp-backend.js")["loadRhwpBackend"]
>>;

interface ComputeDependencies {
  readonly kordoc: KordocModule;
  readonly loadRhwp: () => Promise<RhwpLoadResult>;
}

export interface DocumentComputeProgress {
  readonly stage: DocumentEngineOperation;
  readonly completed: number;
  readonly total: number;
}

export type DocumentComputeProgressHandler = (
  progress: DocumentComputeProgress,
) => void;

export interface DocumentComputeBackend {
  assertMutableHwpx(source: ArrayBuffer): Promise<void>;
  validateExactHwpx(source: ArrayBuffer): Promise<void>;
  execute<Operation extends DocumentEngineOperation>(
    request: Extract<WireDocumentRequest, { operation: Operation }>,
    inputs: Readonly<{ document?: ArrayBuffer; image?: ArrayBuffer }>,
    onProgress?: DocumentComputeProgressHandler,
  ): Promise<DocumentResultPayload<Operation>>;
}

export class RhwpCapabilityError extends Error {
  readonly code = "MISSING_RHWP_BACKEND" as const;

  constructor() {
    super("The optional HWP preview backend is unavailable.");
    this.name = "RhwpCapabilityError";
    rhwpCapabilityErrors.add(this);
  }
}

const rhwpCapabilityErrors = new WeakSet<object>();

export function isRhwpCapabilityError(value: unknown): value is RhwpCapabilityError {
  return typeof value === "object" && value !== null && rhwpCapabilityErrors.has(value);
}

let initialization: Promise<DocumentComputeBackend> | undefined;

export function initializeDocumentComputeBackend(): Promise<DocumentComputeBackend> {
  initialization ??= initializeBackend();
  return initialization;
}

async function initializeBackend(): Promise<DocumentComputeBackend> {
  const kordoc = await import("kordoc");
  requireKordocApi(kordoc);
  let rhwp: Promise<RhwpLoadResult> | undefined;
  const dependencies: ComputeDependencies = {
    kordoc,
    loadRhwp: () => rhwp ??= import("../tools/rhwp-backend.js")
      .then((module) => module.loadRhwpBackend()),
  };
  return Object.freeze({
    async assertMutableHwpx(source: ArrayBuffer): Promise<void> {
      await requireMutableHwpx(kordoc, source);
    },
    async validateExactHwpx(source: ArrayBuffer): Promise<void> {
      await requireMutableHwpx(kordoc, source);
      await requireSuccessfulParse(kordoc, source);
      const validation = await kordoc.validateHwpx(source.slice(0));
      if (!validation.ok) throw protocolError();
    },
    async execute<Operation extends DocumentEngineOperation>(
      request: Extract<WireDocumentRequest, { operation: Operation }>,
      inputs: Readonly<{ document?: ArrayBuffer; image?: ArrayBuffer }>,
      onProgress?: DocumentComputeProgressHandler,
    ): Promise<DocumentResultPayload<Operation>> {
      const payload = await executeOperation(
        dependencies,
        request,
        inputs,
        onProgress,
      );
      validateResultPayload(request.operation, payload);
      return payload as DocumentResultPayload<Operation>;
    },
  });
}

async function executeOperation(
  dependencies: ComputeDependencies,
  request: WireDocumentRequest,
  inputs: Readonly<{ document?: ArrayBuffer; image?: ArrayBuffer }>,
  onProgress?: DocumentComputeProgressHandler,
): Promise<DocumentResultPayload<DocumentEngineOperation>> {
  const { kordoc } = dependencies;
  switch (request.operation) {
    case "detect":
      return { format: await detectSupportedFormat(kordoc, requireDocument(inputs)) };
    case "parse": {
      const source = requireDocument(inputs);
      const format = await requireReadableFormat(kordoc, source);
      await requireUnprotected(source, format);
      const parsed = await kordoc.parse(copyArrayBuffer(source), {
        ...(request.options.pages === undefined
          ? {}
          : { pages: request.options.pages }),
        onProgress: boundedProgress(request.operation, onProgress),
      });
      return parsePayload(parsed, format);
    }
    case "render": {
      const source = requireDocument(inputs);
      const format = await requireReadableFormat(kordoc, source);
      await requireUnprotected(source, format);
      if (format === "hwp") {
        return renderHwpWithRhwp(dependencies, source);
      }
      const rendered = await kordoc.renderHwpxToSvg(copyArrayBuffer(source), {
        ...(request.options.reflow === undefined
          ? {}
          : { reflow: request.options.reflow }),
        ...(request.options.highlights === undefined
          ? {}
          : { highlights: [...request.options.highlights] }),
      });
      assertSvg(rendered.svg);
      return {
        svg: rendered.svg,
        metadata: {
          backend: "kordoc",
          pageCount: rendered.pageCount,
          width: rendered.width,
          height: rendered.height,
          warnings: [...rendered.warnings],
          stats: { ...rendered.stats },
        },
      };
    }
    case "generateHwpx": {
      const generated = await kordoc.markdownToHwpx(request.input.markdown);
      return validatedBinaryPayload(kordoc, generated, {
        operation: "generateHwpx",
      });
    }
    case "patchHwpx": {
      const source = requireDocument(inputs);
      await requireMutableHwpx(kordoc, source);
      await requireSuccessfulParse(kordoc, source);
      const patched = await kordoc.patchHwpx(
        new Uint8Array(copyArrayBuffer(source)),
        request.input.markdown,
        { verify: true },
      );
      if (!patched.success || patched.data === undefined || !patchIsComplete(patched)) {
        throw protocolError();
      }
      return validatedBinaryPayload(kordoc, patched.data, {
        operation: "patchHwpx",
        applied: patched.applied,
        skipped: patched.skipped.length,
        verification: patched.verification?.stats ?? null,
      });
    }
    case "fillHwpx": {
      const source = requireDocument(inputs);
      await requireMutableHwpx(kordoc, source);
      await requireSuccessfulParse(kordoc, source);
      const values = buildFillInputs(request.input.fields, request.options.formats);
      let buffer: ArrayBuffer;
      let filled: FormField[];
      let unmatched: string[];
      let rejected: string[];
      if (request.options.requireUnique === true) {
        const guarded = await kordoc.fillWithUniqueGuard(
          values,
          (candidate, blocked) =>
            kordoc.fillHwpx(copyArrayBuffer(source), candidate, blocked),
        );
        buffer = guarded.buffer;
        filled = guarded.filled;
        unmatched = guarded.unmatched;
        rejected = guarded.rejected;
      } else {
        const result = await kordoc.fillHwpx(copyArrayBuffer(source), values);
        buffer = result.buffer;
        filled = result.filled;
        unmatched = result.unmatched;
        rejected = [];
      }
      await requireSuccessfulParse(kordoc, buffer);
      return validatedBinaryPayload(kordoc, buffer, {
        operation: "fillHwpx",
        filled: filled.length,
        unmatched: [...unmatched],
        rejected: [...rejected],
      });
    }
    case "validateHwpx": {
      const source = requireDocument(inputs);
      await requireMutableHwpx(kordoc, source);
      const validation = await kordoc.validateHwpx(copyArrayBuffer(source));
      const limit = request.options.maxIssues ?? validation.issues.length;
      return validationPayload(validation, limit);
    }
    case "insertImage": {
      if (request.options.mode !== "seal-anchor") throw protocolError();
      const source = requireDocument(inputs);
      const image = requireImage(inputs);
      await requireMutableHwpx(kordoc, source);
      await requireSuccessfulParse(kordoc, source);
      const placed = await kordoc.placeSealHwpx(copyArrayBuffer(source), [{
        anchor: request.input.anchorText,
        ...(request.options.anchorOccurrence === undefined
          ? {}
          : { occurrence: request.options.anchorOccurrence }),
        image: new Uint8Array(copyArrayBuffer(image)),
        ext: imageExtension(image),
        ...(request.options.sizeMm === undefined
          ? {}
          : { sizeMm: request.options.sizeMm }),
        mode: "overlap",
      }]);
      await requireSuccessfulParse(kordoc, placed.buffer);
      return validatedBinaryPayload(kordoc, placed.buffer, placementMetadata(placed));
    }
  }
}

async function renderHwpWithRhwp(
  dependencies: ComputeDependencies,
  source: ArrayBuffer,
): Promise<DocumentResultPayload<"render">> {
  await requireSuccessfulParse(dependencies.kordoc, source);
  const rhwp = await dependencies.loadRhwp();
  if (!rhwp.available) {
    throw new RhwpCapabilityError();
  }
  let document: ReturnType<typeof rhwp.backend.createDocument> | undefined;
  try {
    document = rhwp.backend.createDocument(
      new Uint8Array(copyArrayBuffer(source)),
    );
    const pageCount = document.pageCount();
    if (!Number.isSafeInteger(pageCount) || pageCount <= 0) throw protocolError();
    const svg = document.renderPageSvg(0);
    assertSvg(svg);
    return {
      svg,
      metadata: {
        backend: "rhwp",
        version: rhwp.backend.version,
        pageCount,
        page: 1,
      },
    };
  } finally {
    document?.free();
  }
}

async function detectSupportedFormat(
  kordoc: KordocModule,
  source: ArrayBuffer,
): Promise<"hwp" | "hwpx" | "unknown"> {
  const candidate = kordoc.detectFormat(copyArrayBuffer(source));
  try {
    if (candidate === "hwp") {
      return kordoc.detectOle2Format(copyArrayBuffer(source)) === "hwp"
        ? "hwp"
        : "unknown";
    }
    if (candidate === "hwpx") {
      return await kordoc.detectZipFormat(copyArrayBuffer(source)) === "hwpx"
        ? "hwpx"
        : "unknown";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

async function requireReadableFormat(
  kordoc: KordocModule,
  source: ArrayBuffer,
): Promise<"hwp" | "hwpx"> {
  const format = await detectSupportedFormat(kordoc, source);
  if (format === "unknown") {
    throw createDocumentEngineRunError("UNSUPPORTED_FORMAT");
  }
  return format;
}

async function requireUnprotected(
  source: ArrayBuffer,
  format: "hwp" | "hwpx",
): Promise<void> {
  const { inspectExactDocumentProtection } = await import(
    "../shared/protection.js"
  );
  const protection = await inspectExactDocumentProtection(
    new Uint8Array(source),
    format,
  );
  if (protection !== undefined) {
    throw createDocumentEngineRunError(protection.code);
  }
}

async function requireMutableHwpx(
  kordoc: KordocModule,
  source: ArrayBuffer,
): Promise<void> {
  if (await detectSupportedFormat(kordoc, source) !== "hwpx") {
    throw protocolError();
  }
}

async function requireSuccessfulParse(
  kordoc: KordocModule,
  source: ArrayBuffer,
): Promise<Extract<ParseResult, { success: true }>> {
  const parsed = await kordoc.parse(copyArrayBuffer(source));
  if (!parsed.success) throw protocolError();
  return parsed;
}

function parsePayload(
  parsed: ParseResult,
  expectedFormat: "hwp" | "hwpx",
): DocumentResultPayload<"parse"> {
  if (!parsed.success || parsed.fileType !== expectedFormat) throw protocolError();
  return {
    markdown: parsed.markdown,
    fileType: expectedFormat,
    ...(parsed.metadata === undefined ? {} : { metadata: { ...parsed.metadata } }),
    ...(parsed.pageCount === undefined ? {} : { pageCount: parsed.pageCount }),
    ...(parsed.isImageBased === undefined
      ? {}
      : { isImageBased: parsed.isImageBased }),
    warnings: (parsed.warnings ?? []).map((warning) => ({ ...warning })),
    images: (parsed.images ?? []).map((image) => ({
      filename: image.filename,
      mimeType: image.mimeType,
      bytes: copyArrayBuffer(image.data),
    })),
  };
}

async function validatedBinaryPayload(
  kordoc: KordocModule,
  source: ArrayBuffer | Uint8Array,
  metadata: SafeJsonValue,
): Promise<DocumentResultPayload<"generateHwpx">> {
  const bytes = source instanceof ArrayBuffer
    ? source.slice(0)
    : copyArrayBuffer(source);
  const validation = await kordoc.validateHwpx(bytes.slice(0));
  if (!validation.ok) throw protocolError();
  return { bytes, metadata };
}

function validationPayload(
  validation: ValidateResult,
  maximumIssues: number,
): DocumentResultPayload<"validateHwpx"> {
  return {
    ok: validation.ok,
    issues: validation.issues.slice(0, maximumIssues).map((issue) => ({
      message: issue.message,
      ...(issue.path === undefined ? {} : { entry: issue.path }),
    })),
    entryCount: validation.entryCount,
  };
}

function buildFillInputs(
  fields: Readonly<Record<string, string | readonly string[]>>,
  formats?: Readonly<Record<string, string>>,
): Record<string, FillInput> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    const exactValue = typeof value === "string" ? value : [...value];
    const format = formats?.[key];
    return [key, format === undefined ? exactValue : { value: exactValue, format }];
  }));
}

function patchIsComplete(
  result: Awaited<ReturnType<KordocModule["patchHwpx"]>>,
): boolean {
  const stats = result.verification?.stats;
  return result.skipped.length === 0 && stats !== undefined &&
    stats.added === 0 && stats.removed === 0 && stats.modified === 0;
}

function placementMetadata(result: PlaceSealResult): SafeJsonValue {
  return {
    operation: "insertImage",
    placed: result.placed.map((placement) => ({
      anchor: placement.anchor,
      occurrence: placement.occurrence,
      sectionIndex: placement.sectionIndex,
      mode: placement.mode,
      posXMm: placement.posXMm,
      posYMm: placement.posYMm,
      sizeMm: placement.sizeMm,
      entry: placement.entry,
      warnings: [...(placement.warnings ?? [])],
    })),
  };
}

function imageExtension(source: ArrayBuffer): "png" | "jpg" | "bmp" | "gif" {
  const bytes = new Uint8Array(source);
  if (bytes.byteLength >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((byte, index) => bytes[index] === byte)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  if (bytes.byteLength >= 6 &&
    (Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF87a" ||
      Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF89a")) return "gif";
  throw protocolError();
}

function requireDocument(
  inputs: Readonly<{ document?: ArrayBuffer }>,
): ArrayBuffer {
  if (!(inputs.document instanceof ArrayBuffer)) throw protocolError();
  return inputs.document;
}

function requireImage(inputs: Readonly<{ image?: ArrayBuffer }>): ArrayBuffer {
  if (!(inputs.image instanceof ArrayBuffer) || inputs.image.byteLength === 0) {
    throw protocolError();
  }
  return inputs.image;
}

function boundedProgress(
  stage: DocumentEngineOperation,
  handler: DocumentComputeProgressHandler | undefined,
): ((completed: number, total: number) => void) | undefined {
  if (handler === undefined) return undefined;
  let last = -1;
  return (completed, total) => {
    if (!Number.isSafeInteger(total) || total <= 0 ||
      !Number.isSafeInteger(completed) || completed < 0 || completed > total) return;
    const normalized = Math.max(last, Math.min(1_000, Math.floor(completed / total * 1_000)));
    if (normalized === last) return;
    last = normalized;
    handler({ stage, completed: normalized, total: 1_000 });
  };
}

function requireKordocApi(value: KordocModule): void {
  for (const name of [
    "detectFormat",
    "detectOle2Format",
    "detectZipFormat",
    "parse",
    "renderHwpxToSvg",
    "markdownToHwpx",
    "patchHwpx",
    "fillHwpx",
    "fillWithUniqueGuard",
    "validateHwpx",
    "placeSealHwpx",
  ] as const) {
    if (typeof value[name] !== "function") throw new Error(`Kordoc is missing ${name}().`);
  }
}

export function encodeDocumentResultSpool(
  operation: DocumentSpoolEligibleOperation,
  payload: DocumentResultPayload<DocumentSpoolEligibleOperation>,
): Uint8Array {
  validateResultPayload(operation, payload);
  let encoded: Uint8Array;
  switch (operation) {
    case "parse":
      encoded = encodeParseSpool(payload as DocumentResultPayload<"parse">);
      break;
    case "render":
      encoded = encodeRenderSpool(payload as DocumentResultPayload<"render">);
      break;
    case "generateHwpx":
    case "patchHwpx":
    case "fillHwpx":
    case "insertImage":
      encoded = new Uint8Array(
        (payload as DocumentResultPayload<"generateHwpx">).bytes,
      );
      break;
  }
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_DOCUMENT_ENGINE_RESULT_BYTES) {
    throw protocolError();
  }
  return encoded;
}

export async function decodeDocumentResultSpool<
  Operation extends DocumentSpoolEligibleOperation,
>(
  spool: IntegrityVerifiedResultSpool<Operation>,
): Promise<DocumentResultPayload<Operation>> {
  if (!isIntegrityVerifiedResultSpool(spool)) throw protocolError();
  const { operation, encoding, sizeBytes } = spool.metadata;
  if (encoding !== resultSpoolEncoding(operation) ||
    !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 ||
    sizeBytes > MAX_DOCUMENT_ENGINE_RESULT_BYTES) throw protocolError();

  try {
    const handle = spool.takeHandle();
    if (handle.sizeBytes !== sizeBytes) throw protocolError();
    const bytes = await readExactFd(handle.fd, sizeBytes);
    let payload: DocumentResultPayload<DocumentSpoolEligibleOperation>;
    switch (operation) {
      case "parse":
        payload = decodeParseSpool(bytes);
        break;
      case "render": {
        payload = decodeRenderSpool(bytes);
        break;
      }
      case "generateHwpx":
      case "patchHwpx":
      case "fillHwpx":
      case "insertImage":
        payload = { bytes: copyArrayBuffer(bytes) };
        break;
    }
    validateResultPayload(operation, payload);
    return payload as DocumentResultPayload<Operation>;
  } catch (error: unknown) {
    if (error instanceof DocumentEngineRunError) throw error;
    throw protocolError();
  } finally {
    try {
      await spool.cleanup();
    } catch {
      throw protocolError();
    }
  }
}

function encodeParseSpool(payload: DocumentResultPayload<"parse">): Uint8Array {
  const markdown = Buffer.from(payload.markdown, "utf8");
  const images = payload.images.map((image) => ({
    filename: image.filename,
    mimeType: image.mimeType,
    sizeBytes: image.bytes.byteLength,
  }));
  const header = Buffer.from(JSON.stringify({
    version: PARSE_SPOOL_VERSION,
    markdownBytes: markdown.byteLength,
    fileType: payload.fileType,
    ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
    ...(payload.pageCount === undefined ? {} : { pageCount: payload.pageCount }),
    ...(payload.isImageBased === undefined ? {} : { isImageBased: payload.isImageBased }),
    warnings: payload.warnings,
    images,
  }), "utf8");
  if (header.byteLength === 0 || header.byteLength > MAX_SAFE_JSON_BYTES) {
    throw protocolError();
  }
  const total = PARSE_SPOOL_PREFIX_BYTES + header.byteLength + markdown.byteLength +
    images.reduce((sum, image) => sum + image.sizeBytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_DOCUMENT_ENGINE_RESULT_BYTES) {
    throw protocolError();
  }
  const encoded = Buffer.allocUnsafeSlow(total);
  encoded.writeUInt32BE(header.byteLength, 0);
  header.copy(encoded, PARSE_SPOOL_PREFIX_BYTES);
  let offset = PARSE_SPOOL_PREFIX_BYTES + header.byteLength;
  markdown.copy(encoded, offset);
  offset += markdown.byteLength;
  for (const image of payload.images) {
    Buffer.from(image.bytes).copy(encoded, offset);
    offset += image.bytes.byteLength;
  }
  return encoded;
}

function encodeRenderSpool(payload: DocumentResultPayload<"render">): Uint8Array {
  const svg = Buffer.from(payload.svg, "utf8");
  const header = Buffer.from(JSON.stringify({
    version: RENDER_SPOOL_VERSION,
    svgBytes: svg.byteLength,
    ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
  }), "utf8");
  if (header.byteLength === 0 || header.byteLength > MAX_SAFE_JSON_BYTES) {
    throw protocolError();
  }
  const total = RENDER_SPOOL_PREFIX_BYTES + header.byteLength + svg.byteLength;
  if (!Number.isSafeInteger(total) || total > MAX_DOCUMENT_ENGINE_RESULT_BYTES) {
    throw protocolError();
  }
  const encoded = Buffer.allocUnsafeSlow(total);
  encoded.writeUInt32BE(header.byteLength, 0);
  header.copy(encoded, RENDER_SPOOL_PREFIX_BYTES);
  svg.copy(encoded, RENDER_SPOOL_PREFIX_BYTES + header.byteLength);
  return encoded;
}

function decodeRenderSpool(bytes: Uint8Array): DocumentResultPayload<"render"> {
  if (bytes.byteLength <= RENDER_SPOOL_PREFIX_BYTES) throw protocolError();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerBytes = buffer.readUInt32BE(0);
  if (headerBytes === 0 || headerBytes > MAX_SAFE_JSON_BYTES ||
    headerBytes > bytes.byteLength - RENDER_SPOOL_PREFIX_BYTES) {
    throw protocolError();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(RENDER_SPOOL_PREFIX_BYTES, RENDER_SPOOL_PREFIX_BYTES + headerBytes),
    ));
  } catch {
    throw protocolError();
  }
  if (!isRecord(raw) || !hasExactKeys(raw, ["version", "svgBytes"], ["metadata"]) ||
    raw.version !== RENDER_SPOOL_VERSION ||
    !Number.isSafeInteger(raw.svgBytes) || Number(raw.svgBytes) <= 0) {
    throw protocolError();
  }
  const offset = RENDER_SPOOL_PREFIX_BYTES + headerBytes;
  const end = checkedOffset(offset, Number(raw.svgBytes), bytes.byteLength);
  if (end !== bytes.byteLength) throw protocolError();
  let svg: string;
  try {
    svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
  } catch {
    throw protocolError();
  }
  const payload = {
    svg,
    ...(Object.hasOwn(raw, "metadata") ? { metadata: raw.metadata } : {}),
  };
  validateResultPayload("render", payload);
  return payload as DocumentResultPayload<"render">;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function decodeParseSpool(bytes: Uint8Array): DocumentResultPayload<"parse"> {
  if (bytes.byteLength <= PARSE_SPOOL_PREFIX_BYTES) throw protocolError();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerBytes = buffer.readUInt32BE(0);
  if (headerBytes === 0 || headerBytes > MAX_SAFE_JSON_BYTES ||
    headerBytes > bytes.byteLength - PARSE_SPOOL_PREFIX_BYTES) throw protocolError();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(
        PARSE_SPOOL_PREFIX_BYTES,
        PARSE_SPOOL_PREFIX_BYTES + headerBytes,
      ),
    ));
  } catch {
    throw protocolError();
  }
  if (!isRecord(raw) || raw.version !== PARSE_SPOOL_VERSION ||
    !Number.isSafeInteger(raw.markdownBytes) || Number(raw.markdownBytes) < 0 ||
    !Array.isArray(raw.images) || !Array.isArray(raw.warnings)) throw protocolError();
  const imageHeaders = raw.images.map((value) => {
    if (!isRecord(value) || typeof value.filename !== "string" ||
      typeof value.mimeType !== "string" || !Number.isSafeInteger(value.sizeBytes) ||
      Number(value.sizeBytes) <= 0) throw protocolError();
    return {
      filename: value.filename,
      mimeType: value.mimeType,
      sizeBytes: Number(value.sizeBytes),
    };
  });
  let offset = PARSE_SPOOL_PREFIX_BYTES + headerBytes;
  const markdownEnd = checkedOffset(offset, Number(raw.markdownBytes), bytes.byteLength);
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset, markdownEnd),
    );
  } catch {
    throw protocolError();
  }
  offset = markdownEnd;
  const images = imageHeaders.map((image) => {
    const end = checkedOffset(offset, image.sizeBytes, bytes.byteLength);
    const result = {
      filename: image.filename,
      mimeType: image.mimeType,
      bytes: copyArrayBuffer(bytes.subarray(offset, end)),
    };
    offset = end;
    return result;
  });
  if (offset !== bytes.byteLength) throw protocolError();
  const payload = {
    markdown,
    fileType: raw.fileType,
    ...(Object.hasOwn(raw, "metadata") ? { metadata: raw.metadata } : {}),
    ...(Object.hasOwn(raw, "pageCount") ? { pageCount: raw.pageCount } : {}),
    ...(Object.hasOwn(raw, "isImageBased") ? { isImageBased: raw.isImageBased } : {}),
    warnings: raw.warnings,
    images,
  };
  validateResultPayload("parse", payload);
  return payload as DocumentResultPayload<"parse">;
}

function validateResultPayload(
  operation: DocumentEngineOperation,
  payload: unknown,
): void {
  try {
    measureDocumentResultByteLength(operation, payload);
    if (operation === "render") {
      assertSvg((payload as DocumentResultPayload<"render">).svg);
    }
  } catch {
    throw protocolError();
  }
}

function assertSvg(svg: unknown): asserts svg is string {
  try {
    assertSafeSvgString(svg);
  } catch {
    throw protocolError();
  }
}

async function readExactFd(fd: number, sizeBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(fd) || fd < 0) throw protocolError();
  const bytes = Buffer.allocUnsafeSlow(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const bytesRead = await new Promise<number>((resolvePromise, rejectPromise) => {
      readFd(fd, bytes, offset, sizeBytes - offset, offset, (error, count) => {
        if (error === null) resolvePromise(count);
        else rejectPromise(error);
      });
    });
    if (bytesRead === 0) throw protocolError();
    offset += bytesRead;
  }
  return bytes;
}

function checkedOffset(offset: number, length: number, maximum: number): number {
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum - offset) {
    throw protocolError();
  }
  return offset + length;
}

function copyArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function protocolError(): DocumentEngineRunError {
  return createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
