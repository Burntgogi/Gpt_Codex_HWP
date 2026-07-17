import { read as readFd } from "node:fs";

import {
  createDocumentEngineRunError,
  DocumentEngineRunError,
} from "../workers/document-errors.js";
import type {
  IntegrityVerifiedResultSpool,
  IsolatedDocumentResult,
} from "../workers/document-execution-policy.js";
import {
  MAX_DOCUMENT_ENGINE_RESULT_BYTES,
  MAX_SAFE_JSON_BYTES,
  measureDocumentResultByteLength,
  type SafeJsonValue,
} from "../workers/document-protocol.js";
import { isIntegrityVerifiedResultSpool } from "../workers/document-child-client.js";
import {
  OutputConflictError,
  PathAliasError,
  UnsafeOutputPathError,
  writeFileRangeExclusively,
  writeFilesExclusively,
  type ExclusiveOutputOptions,
} from "./output.js";
import { UnsafeWindowsPathError } from "./paths.js";
import { AllowedRootsPathError } from "./allowed-roots.js";
import {
  MAX_PREVIEW_SVG_BYTES,
  ResourceLimitError,
} from "./resource-limits.js";
import {
  assertSafeSvgString,
  IncrementalSvgPolicyValidator,
} from "./svg-policy.js";

const RENDER_SPOOL_PREFIX_BYTES = 4;
const RENDER_SPOOL_VERSION = 1;
const VALIDATION_CHUNK_BYTES = 64 * 1024;

export interface AuthorizedDocumentRenderResult {
  readonly payload: IsolatedDocumentResult<"render">;
  verifySourceUnchanged(): Promise<void>;
}

export interface DocumentRenderValidationOptions {
  readonly signal?: AbortSignal;
  /** Unit-test-only fault injection for exercising descriptor read failures. */
  readonly unitTestReadInto?: (
    fd: number,
    buffer: Buffer,
    length: number,
    position: number,
  ) => Promise<number>;
}

export interface DocumentRenderOutputOptions extends ExclusiveOutputOptions {
  readonly signal?: AbortSignal;
}

interface DocumentRenderWriterOptions extends DocumentRenderOutputOptions,
  DocumentRenderValidationOptions {}

export interface PreparedDocumentRenderOutput {
  readonly metadata?: SafeJsonValue;
  writeExclusively(
    outputPath: string,
    options?: DocumentRenderOutputOptions,
  ): Promise<void>;
  cleanup(): Promise<void>;
}

export async function prepareDocumentRenderOutput(
  rendered: AuthorizedDocumentRenderResult,
  options: DocumentRenderValidationOptions = {},
): Promise<PreparedDocumentRenderOutput> {
  const result = rendered.payload;
  if (isIntegrityVerifiedResultSpool(result)) {
    return prepareRenderSpool(rendered, result, options);
  }

  try {
    assertSafeSvgString(result.svg);
    const svgBytes = Buffer.byteLength(result.svg, "utf8");
    if (svgBytes > MAX_PREVIEW_SVG_BYTES) {
      throw previewTooLargeError(svgBytes);
    }
    requireNotAborted(options.signal);
  } catch (error: unknown) {
    if (isSafePublicError(error)) throw error;
    throw protocolError();
  }

  let cleaned = false;
  let committed = false;
  return {
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    async writeExclusively(
      outputPath: string,
      commitOptions: DocumentRenderOutputOptions = {},
    ): Promise<void> {
      if (cleaned || committed) throw protocolError();
      requireNotAborted(commitOptions.signal);
      await writeFilesExclusively(
        [{ path: outputPath, data: result.svg }],
        {
          sourcePaths: commitOptions.sourcePaths,
          expectedDirectoryIdentities:
            commitOptions.expectedDirectoryIdentities,
          beforeOpen: () => authorizeRenderOutputOpen(rendered, commitOptions),
        },
      );
      committed = true;
    },
    async cleanup(): Promise<void> {
      cleaned = true;
    },
  };
}

export async function writeDocumentRenderResultExclusively(
  rendered: AuthorizedDocumentRenderResult,
  outputPath: string,
  options: DocumentRenderWriterOptions = {},
): Promise<SafeJsonValue | undefined> {
  const prepared = await prepareDocumentRenderOutput(rendered, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.unitTestReadInto === undefined
      ? {}
      : { unitTestReadInto: options.unitTestReadInto }),
  });
  try {
    await prepared.writeExclusively(outputPath, {
      sourcePaths: options.sourcePaths,
      beforeOpen: options.beforeOpen,
      expectedDirectoryIdentities: options.expectedDirectoryIdentities,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return prepared.metadata;
  } finally {
    await prepared.cleanup();
  }
}

async function prepareRenderSpool(
  rendered: AuthorizedDocumentRenderResult,
  spool: IntegrityVerifiedResultSpool<"render">,
  options: DocumentRenderValidationOptions,
): Promise<PreparedDocumentRenderOutput> {
  if (spool.metadata.operation !== "render" ||
    spool.metadata.encoding !== "render-result-v1" ||
    !Number.isSafeInteger(spool.metadata.sizeBytes) ||
    spool.metadata.sizeBytes <= RENDER_SPOOL_PREFIX_BYTES ||
    spool.metadata.sizeBytes > MAX_DOCUMENT_ENGINE_RESULT_BYTES) {
    await spool.cleanup().catch(() => undefined);
    throw protocolError();
  }

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await spool.cleanup();
    } catch {
      throw protocolError();
    }
  };

  try {
    const handle = spool.takeHandle();
    if (handle.sizeBytes !== spool.metadata.sizeBytes) throw protocolError();
    const validated = await validateRenderSpool(
      handle.fd,
      handle.sizeBytes,
      options.signal,
      options.unitTestReadInto ?? readInto,
    );
    let committed = false;
    return {
      ...(validated.metadata === undefined ? {} : { metadata: validated.metadata }),
      async writeExclusively(
        outputPath: string,
        commitOptions: DocumentRenderOutputOptions = {},
      ): Promise<void> {
        if (cleaned || committed) throw protocolError();
        requireNotAborted(commitOptions.signal);
        await writeFileRangeExclusively(outputPath, {
          fd: handle.fd,
          offset: validated.svgOffset,
          sizeBytes: validated.svgBytes,
        }, {
          sourcePaths: commitOptions.sourcePaths,
          expectedDirectoryIdentities:
            commitOptions.expectedDirectoryIdentities,
          beforeOpen: () => authorizeRenderOutputOpen(rendered, commitOptions),
        });
        committed = true;
      },
      cleanup,
    };
  } catch (error: unknown) {
    try {
      await cleanup();
    } catch {
      throw protocolError();
    }
    if (isSafePublicError(error)) throw error;
    throw protocolError();
  }
}

async function verifyRenderSourceUnchanged(
  rendered: AuthorizedDocumentRenderResult,
): Promise<void> {
  try {
    await rendered.verifySourceUnchanged();
  } catch (error: unknown) {
    if (isSafePublicError(error)) throw error;
    throw protocolError();
  }
}

async function authorizeRenderOutputOpen(
  rendered: AuthorizedDocumentRenderResult,
  options: DocumentRenderOutputOptions,
): Promise<void> {
  await options.beforeOpen?.();
  requireNotAborted(options.signal);
  await verifyRenderSourceUnchanged(rendered);
  requireNotAborted(options.signal);
}

async function validateRenderSpool(
  fd: number,
  sizeBytes: number,
  signal: AbortSignal | undefined,
  read: typeof readInto,
): Promise<{
  readonly svgOffset: number;
  readonly svgBytes: number;
  readonly metadata?: SafeJsonValue;
}> {
  requireNotAborted(signal);
  const prefix = await readExactRange(fd, 0, RENDER_SPOOL_PREFIX_BYTES, read);
  const headerBytes = Buffer.from(prefix).readUInt32BE(0);
  if (headerBytes <= 0 || headerBytes > MAX_SAFE_JSON_BYTES ||
    headerBytes > sizeBytes - RENDER_SPOOL_PREFIX_BYTES) throw protocolError();
  requireNotAborted(signal);
  const headerBuffer = await readExactRange(
    fd,
    RENDER_SPOOL_PREFIX_BYTES,
    headerBytes,
    read,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBuffer));
  } catch {
    throw protocolError();
  }
  if (!isRecord(raw) || !hasExactKeys(raw, ["version", "svgBytes"], ["metadata"]) ||
    raw.version !== RENDER_SPOOL_VERSION || !Number.isSafeInteger(raw.svgBytes) ||
    Number(raw.svgBytes) <= 0) {
    throw protocolError();
  }
  const svgOffset = RENDER_SPOOL_PREFIX_BYTES + headerBytes;
  const svgBytes = Number(raw.svgBytes);
  if (svgBytes > MAX_PREVIEW_SVG_BYTES) throw previewTooLargeError(svgBytes);
  if (svgOffset + svgBytes !== sizeBytes) throw protocolError();
  const metadata = Object.hasOwn(raw, "metadata") ? raw.metadata : undefined;
  measureDocumentResultByteLength("render", {
    svg: "<svg></svg>",
    ...(metadata === undefined ? {} : { metadata }),
  });

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const validator = new IncrementalSvgPolicyValidator();
  const buffer = Buffer.allocUnsafeSlow(VALIDATION_CHUNK_BYTES);
  let consumed = 0;
  try {
    while (consumed < svgBytes) {
      requireNotAborted(signal);
      const requested = Math.min(buffer.byteLength, svgBytes - consumed);
      const count = await read(fd, buffer, requested, svgOffset + consumed);
      if (count === 0) throw protocolError();
      validator.push(decoder.decode(buffer.subarray(0, count), { stream: true }));
      consumed += count;
    }
    validator.push(decoder.decode());
    validator.finish();
  } catch (error: unknown) {
    if (error instanceof DocumentEngineRunError) throw error;
    throw protocolError();
  }
  return {
    svgOffset,
    svgBytes,
    ...(metadata === undefined ? {} : { metadata: metadata as SafeJsonValue }),
  };
}

async function readExactRange(
  fd: number,
  position: number,
  sizeBytes: number,
  read: typeof readInto,
): Promise<Uint8Array> {
  const result = Buffer.allocUnsafeSlow(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const count = await read(fd, result.subarray(offset), sizeBytes - offset, position + offset);
    if (count === 0) throw protocolError();
    offset += count;
  }
  return result;
}

function readInto(
  fd: number,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    readFd(fd, buffer, 0, length, position, (error, bytesRead) => {
      if (error === null) resolvePromise(bytesRead);
      else rejectPromise(error);
    });
  });
}

function requireNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createDocumentEngineRunError("REQUEST_CANCELLED");
  }
}

function protocolError(): DocumentEngineRunError {
  return createDocumentEngineRunError("ENGINE_PROTOCOL_ERROR");
}

function previewTooLargeError(actualAtLeast: number): ResourceLimitError {
  return new ResourceLimitError(
    "PREVIEW_TOO_LARGE",
    `SVG preview exceeds the ${MAX_PREVIEW_SVG_BYTES}-byte safety limit.`,
    MAX_PREVIEW_SVG_BYTES,
    actualAtLeast,
  );
}

function isSafePublicError(value: unknown): boolean {
  return value instanceof DocumentEngineRunError ||
    value instanceof ResourceLimitError ||
    value instanceof OutputConflictError ||
    value instanceof PathAliasError ||
    value instanceof UnsafeOutputPathError ||
    value instanceof AllowedRootsPathError ||
    value instanceof UnsafeWindowsPathError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}
