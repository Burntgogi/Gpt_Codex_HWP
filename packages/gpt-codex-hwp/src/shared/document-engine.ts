import { createHash, randomUUID } from "node:crypto";
import { read as readFd } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import type {
  DocumentSnapshot,
  DocumentSnapshotMetadata,
  SpoolDocumentSnapshot,
} from "./document-snapshot.js";
import {
  prepareDocumentRenderOutput,
  writeDocumentRenderResultExclusively,
  type AuthorizedDocumentRenderResult,
} from "./document-render-output.js";
import {
  writeFileRangeAndFilesExclusively,
  writeFilesExclusively,
  type ExclusiveOutputFile,
} from "./output.js";
import {
  decodeDocumentResultSpool,
} from "../workers/document-compute-backend.js";
import {
  createDocumentChildClient,
  isIntegrityVerifiedResultSpool,
} from "../workers/document-child-client.js";
import {
  createIsolatedDocumentEngine,
  type DocumentEngineRunOptions,
  type IsolatedDocumentEngine,
  type IsolatedDocumentResult,
} from "../workers/document-execution-policy.js";
import {
  DOCUMENT_PROTOCOL_VERSION,
  validateDocumentResultSpoolMetadata,
  type DocumentEngineOperation,
  type DocumentResultPayload,
  type LogicalDocumentRequest,
  type SafeJsonValue,
} from "../workers/document-protocol.js";
import { createDocumentWorkerClient } from "../workers/document-worker-client.js";

export interface DocumentEngineExecutionContext {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly onProgress?: (completed: number, total: number) => void;
}

export interface DocumentFacadeResult<Operation extends DocumentEngineOperation> {
  readonly payload: DocumentResultPayload<Operation>;
  readonly snapshotMetadata: Readonly<DocumentSnapshotMetadata>;
  readonly verifySourceUnchanged: () => Promise<void>;
}

export interface DocumentFacadeRenderResult extends AuthorizedDocumentRenderResult {
  readonly snapshotMetadata: Readonly<DocumentSnapshotMetadata>;
}

export interface DocumentFacadeHwpxResult<
  Operation extends "generateHwpx" | "patchHwpx" | "fillHwpx" | "insertImage",
> {
  readonly payload: IsolatedDocumentResult<Operation>;
  readonly validation: DocumentResultPayload<"validateHwpx">;
  readonly snapshotMetadata?: Readonly<DocumentSnapshotMetadata>;
  readonly resultMetadata: SafeJsonValue;
  readonly preview?: DocumentResultPayload<"render">;
  verifySourceUnchanged(): Promise<void>;
  writeOutputExclusively(
    outputPath: string,
    options?: Readonly<{
      sourcePaths?: readonly string[];
      companionFiles?: readonly ExclusiveOutputFile[];
    }>,
  ): Promise<readonly string[]>;
  cleanup(): Promise<void>;
}

export interface DocumentEngineFacade {
  detect(
    snapshot: DocumentSnapshot,
    context?: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeResult<"detect">>;
  parse(
    snapshot: DocumentSnapshot,
    options?: Readonly<{ pages?: string }>,
    context?: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeResult<"parse">>;
  render(
    snapshot: DocumentSnapshot,
    options?: Readonly<{ reflow?: boolean; highlights?: readonly string[] }>,
    context?: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeRenderResult>;
  generate(
    markdown: string,
    options?: Readonly<{
      preset?: "official" | "report" | "plan" | "notice" | "minutes";
      renderPreview?: boolean;
    }>,
    context?: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeHwpxResult<"generateHwpx">>;
  validate(
    snapshot: DocumentSnapshot,
    options?: Readonly<{ maxIssues?: number }>,
    context?: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeResult<"validateHwpx">>;
  patch(
    snapshot: DocumentSnapshot,
    markdown: string,
    context?: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeHwpxResult<"patchHwpx">>;
  fill(
    snapshot: DocumentSnapshot,
    fields: Readonly<Record<string, string | readonly string[]>>,
    options?: Readonly<{
      formats?: Readonly<Record<string, string>>;
      requireUnique?: boolean;
    }>,
    context?: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeHwpxResult<"fillHwpx">>;
  insertImage(
    snapshot: DocumentSnapshot,
    imageSnapshot: DocumentSnapshot,
    anchorText: string,
    options?: Readonly<{
      mode?: "after-paragraph" | "seal-anchor";
      sizeMm?: number;
      anchorOccurrence?: number;
    }>,
    context?: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeHwpxResult<"insertImage">>;
}

export interface DocumentEngineFacadeDependencies {
  readonly isolatedEngine?: IsolatedDocumentEngine;
  readonly requestIdFactory?: () => string;
}

export function createDocumentEngineFacade(
  dependencies: DocumentEngineFacadeDependencies = {},
): DocumentEngineFacade {
  const isolatedEngine = dependencies.isolatedEngine ?? createDefaultIsolatedEngine();
  const requestIdFactory = dependencies.requestIdFactory ?? randomUUID;

  return Object.freeze({
    async detect(
      snapshot: DocumentSnapshot,
      context: DocumentEngineExecutionContext = {},
    ): Promise<DocumentFacadeResult<"detect">> {
      if (snapshot.metadata.shallowFormat.candidate === "unknown") {
        try {
          await snapshot.verifySourceUnchanged();
          return {
            payload: { format: "unknown" },
            snapshotMetadata: snapshot.metadata,
            verifySourceUnchanged: () => snapshot.verifySourceUnchanged(),
          };
        } finally {
          await snapshot.cleanup();
        }
      }
      return run("detect", snapshot, {}, {}, context);
    },
    parse(
      snapshot: DocumentSnapshot,
      options: Readonly<{ pages?: string }> = {},
      context: DocumentEngineExecutionContext = {},
    ): Promise<DocumentFacadeResult<"parse">> {
      return run("parse", snapshot, {}, copyDefined(options), context);
    },
    render(
      snapshot: DocumentSnapshot,
      options: Readonly<{
        reflow?: boolean;
        highlights?: readonly string[];
      }> = {},
      context: DocumentEngineExecutionContext = {},
    ): Promise<DocumentFacadeRenderResult> {
      return runRender(snapshot, {
        ...(options.reflow === undefined ? {} : { reflow: options.reflow }),
        ...(options.highlights === undefined
          ? {}
          : { highlights: [...options.highlights] }),
      }, context);
    },
    generate(
      markdown: string,
      options: Readonly<{
        preset?: "official" | "report" | "plan" | "notice" | "minutes";
        renderPreview?: boolean;
      }> = {},
      context: DocumentEngineExecutionContext = {},
    ): Promise<DocumentFacadeHwpxResult<"generateHwpx">> {
      return runGenerate(markdown, options, context);
    },
    validate(
      snapshot: DocumentSnapshot,
      options: Readonly<{ maxIssues?: number }> = {},
      context: DocumentEngineExecutionContext = {},
    ): Promise<DocumentFacadeResult<"validateHwpx">> {
      return run(
        "validateHwpx",
        snapshot,
        {},
        options.maxIssues === undefined ? {} : { maxIssues: options.maxIssues },
        context,
      );
    },
    patch(
      snapshot: DocumentSnapshot,
      markdown: string,
      context: DocumentEngineExecutionContext = {},
    ): Promise<DocumentFacadeHwpxResult<"patchHwpx">> {
      return runMutation("patchHwpx", snapshot, { markdown }, {}, context);
    },
    fill(
      snapshot: DocumentSnapshot,
      fields: Readonly<Record<string, string | readonly string[]>>,
      options: Readonly<{
        formats?: Readonly<Record<string, string>>;
        requireUnique?: boolean;
      }> = {},
      context: DocumentEngineExecutionContext = {},
    ): Promise<DocumentFacadeHwpxResult<"fillHwpx">> {
      return runMutation(
        "fillHwpx",
        snapshot,
        { fields: copyFillFields(fields) },
        {
          ...(options.formats === undefined
            ? {}
            : { formats: { ...options.formats } }),
          ...(options.requireUnique === undefined
            ? {}
            : { requireUnique: options.requireUnique }),
        },
        context,
      );
    },
    insertImage(
      snapshot: DocumentSnapshot,
      imageSnapshot: DocumentSnapshot,
      anchorText: string,
      options: Readonly<{
        mode?: "after-paragraph" | "seal-anchor";
        sizeMm?: number;
        anchorOccurrence?: number;
      }> = {},
      context: DocumentEngineExecutionContext = {},
    ): Promise<DocumentFacadeHwpxResult<"insertImage">> {
      return runImageMutation(
        snapshot,
        imageSnapshot,
        anchorText,
        options,
        context,
      );
    },
  });

  async function run<Operation extends "detect" | "parse" | "validateHwpx">(
    operation: Operation,
    snapshot: DocumentSnapshot,
    input: Record<string, never>,
    options: Record<string, unknown>,
    context: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeResult<Operation>> {
    const request = {
      protocolVersion: DOCUMENT_PROTOCOL_VERSION,
      requestId: requestIdFactory(),
      operation,
      input,
      options,
    } as Extract<LogicalDocumentRequest, { operation: Operation }>;
    const execute = isolatedEngine.run as unknown as (
      request: Extract<LogicalDocumentRequest, { operation: Operation }>,
      snapshot: DocumentSnapshot,
      options: DocumentEngineRunOptions,
    ) => Promise<IsolatedDocumentResult<Operation>>;
    const result = await execute(
      request,
      snapshot,
      toRunOptions(context),
    );
    const payload = await decodeResult(operation, result);
    await snapshot.verifySourceUnchanged();
    return {
      payload,
      snapshotMetadata: snapshot.metadata,
      verifySourceUnchanged: () => snapshot.verifySourceUnchanged(),
    };
  }

  async function runGenerate(
    markdown: string,
    options: Readonly<{
      preset?: "official" | "report" | "plan" | "notice" | "minutes";
      renderPreview?: boolean;
    }>,
    context: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeHwpxResult<"generateHwpx">> {
    const request: Extract<LogicalDocumentRequest, { operation: "generateHwpx" }> = {
      protocolVersion: DOCUMENT_PROTOCOL_VERSION,
      requestId: requestIdFactory(),
      operation: "generateHwpx",
      input: { markdown },
      options: options.preset === undefined ? {} : { preset: options.preset },
    };
    const result = await isolatedEngine.run(request, undefined, toRunOptions(context));
    return authorizeHwpxResult(
      "generateHwpx",
      result,
      [],
      context,
      options.renderPreview === true,
    );
  }

  async function runMutation<Operation extends "patchHwpx" | "fillHwpx">(
    operation: Operation,
    snapshot: DocumentSnapshot,
    input: Extract<LogicalDocumentRequest, { operation: Operation }>["input"],
    options: Extract<LogicalDocumentRequest, { operation: Operation }>["options"],
    context: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeHwpxResult<Operation>> {
    const request = {
      protocolVersion: DOCUMENT_PROTOCOL_VERSION,
      requestId: requestIdFactory(),
      operation,
      input,
      options,
    } as Extract<LogicalDocumentRequest, { operation: Operation }>;
    const execute = isolatedEngine.run as unknown as (
      request: Extract<LogicalDocumentRequest, { operation: Operation }>,
      snapshot: DocumentSnapshot,
      options: DocumentEngineRunOptions,
    ) => Promise<IsolatedDocumentResult<Operation>>;
    const result = await execute(request, snapshot, toRunOptions(context));
    return authorizeHwpxResult(operation, result, [snapshot], context);
  }

  async function runImageMutation(
    snapshot: DocumentSnapshot,
    imageSnapshot: DocumentSnapshot,
    anchorText: string,
    options: Readonly<{
      mode?: "after-paragraph" | "seal-anchor";
      sizeMm?: number;
      anchorOccurrence?: number;
    }>,
    context: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeHwpxResult<"insertImage">> {
    if (snapshot.transport !== "spool" || imageSnapshot.transport !== "spool") {
      await Promise.allSettled([snapshot.cleanup(), imageSnapshot.cleanup()]);
      throw engineProtocolError();
    }
    const request: Extract<LogicalDocumentRequest, { operation: "insertImage" }> = {
      protocolVersion: DOCUMENT_PROTOCOL_VERSION,
      requestId: requestIdFactory(),
      operation: "insertImage",
      input: { anchorText },
      options: {
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.sizeMm === undefined ? {} : { sizeMm: options.sizeMm }),
        ...(options.anchorOccurrence === undefined
          ? {}
          : { anchorOccurrence: options.anchorOccurrence }),
      },
    };
    const imageHandle = imageSnapshot.takeSpoolHandle();
    let result: IsolatedDocumentResult<"insertImage"> | undefined;
    try {
      result = await isolatedEngine.run(request, snapshot, {
        ...toRunOptions(context),
        imageInput: {
          transport: "spool",
          fd: imageHandle.fd,
          sizeBytes: imageHandle.sizeBytes,
        },
      });
      await imageSnapshot.verifySourceUnchanged();
    } catch (error: unknown) {
      if (result !== undefined && isIntegrityVerifiedResultSpool(result)) {
        await result.cleanup();
      }
      await imageSnapshot.cleanup();
      throw error;
    }
    await imageSnapshot.cleanup();
    return authorizeHwpxResult(
      "insertImage",
      result,
      [snapshot, imageSnapshot],
      context,
    );
  }

  async function authorizeHwpxResult<
    Operation extends "generateHwpx" | "patchHwpx" | "fillHwpx" | "insertImage",
  >(
    operation: Operation,
    result: IsolatedDocumentResult<Operation>,
    sourceSnapshots: readonly DocumentSnapshot[],
    context: DocumentEngineExecutionContext,
    renderPreview = false,
  ): Promise<DocumentFacadeHwpxResult<Operation>> {
    const spoolResult = isIntegrityVerifiedResultSpool(result) ? result : undefined;
    const authorizedInlineBytes = spoolResult === undefined
      ? Uint8Array.from(new Uint8Array(
          (result as DocumentResultPayload<Operation>).bytes,
        ))
      : undefined;
    let range: Readonly<{ fd: number; sizeBytes: number }> | undefined;
    let resultMetadata: SafeJsonValue;
    let validation: DocumentFacadeResult<"validateHwpx">;
    let preview: DocumentResultPayload<"render"> | undefined;
    try {
      resultMetadata = validateDocumentResultSpoolMetadata(
        operation,
        spoolResult?.metadata.resultMetadata ??
          (result as DocumentResultPayload<Operation>).metadata,
      );
      const candidateSnapshot = (): DocumentSnapshot => {
        if (spoolResult === undefined) {
          if (authorizedInlineBytes === undefined) throw engineProtocolError();
          return createCandidateWorkerSnapshot(
            authorizedInlineBytes.buffer,
          );
        }
        range ??= spoolResult.takeHandle();
        return createCandidateSpoolSnapshot(
          range,
          spoolResult.metadata.sha256,
        );
      };
      validation = await run(
        "validateHwpx",
        candidateSnapshot(),
        {},
        {},
        context,
      );
      if (renderPreview && validation.payload.ok) {
        const rendered = await runRender(
          candidateSnapshot(),
          { reflow: true },
          context,
        );
        preview = await decodeRenderResult(rendered.payload);
      }
      for (const sourceSnapshot of sourceSnapshots) {
        await sourceSnapshot.verifySourceUnchanged();
      }
    } catch (error: unknown) {
      if (spoolResult !== undefined) await spoolResult.cleanup();
      throw error;
    }

    let committed = false;
    let cleaned = false;
    const verifySourceUnchanged = async (): Promise<void> => {
      for (const sourceSnapshot of sourceSnapshots) {
        await sourceSnapshot.verifySourceUnchanged();
      }
    };
    return Object.freeze({
      payload: result,
      validation: validation.payload,
      ...(sourceSnapshots[0] === undefined
        ? {}
        : { snapshotMetadata: sourceSnapshots[0].metadata }),
      resultMetadata,
      ...(preview === undefined ? {} : { preview }),
      verifySourceUnchanged,
      async writeOutputExclusively(
        outputPath: string,
        options: Readonly<{
          sourcePaths?: readonly string[];
          companionFiles?: readonly ExclusiveOutputFile[];
        }> = {},
      ): Promise<readonly string[]> {
        if (committed || cleaned) throw engineProtocolError();
        if (!validation.payload.ok) throw engineProtocolError();
        requireNotAborted(context.signal);
        const companions = options.companionFiles ?? [];
        const beforeOpen = async (): Promise<void> => {
          requireNotAborted(context.signal);
          if (range !== undefined && spoolResult !== undefined &&
            await hashFdRange(range.fd, range.sizeBytes) !==
              spoolResult.metadata.sha256) {
            throw engineProtocolError();
          }
          await verifySourceUnchanged();
          requireNotAborted(context.signal);
        };
        let written: readonly string[];
        if (range === undefined) {
          if (authorizedInlineBytes === undefined) throw engineProtocolError();
          written = await writeFilesExclusively(
            [
              { path: outputPath, data: authorizedInlineBytes },
              ...companions,
            ],
            { sourcePaths: options.sourcePaths, beforeOpen },
          );
        } else {
          written = await writeFileRangeAndFilesExclusively(
            outputPath,
            { fd: range.fd, offset: 0, sizeBytes: range.sizeBytes },
            companions,
            { sourcePaths: options.sourcePaths, beforeOpen },
          );
        }
        committed = true;
        return written;
      },
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        if (spoolResult !== undefined) await spoolResult.cleanup();
      },
    });
  }

  async function runRender(
    snapshot: DocumentSnapshot,
    options: Record<string, unknown>,
    context: DocumentEngineExecutionContext,
  ): Promise<DocumentFacadeRenderResult> {
    const request: Extract<LogicalDocumentRequest, { operation: "render" }> = {
      protocolVersion: DOCUMENT_PROTOCOL_VERSION,
      requestId: requestIdFactory(),
      operation: "render",
      input: {},
      options,
    } as Extract<LogicalDocumentRequest, { operation: "render" }>;
    const result = await isolatedEngine.run(
      request,
      snapshot,
      toRunOptions(context),
    );
    try {
      await snapshot.verifySourceUnchanged();
    } catch (error: unknown) {
      if (isIntegrityVerifiedResultSpool(result)) await result.cleanup();
      throw error;
    }
    return {
      payload: result,
      snapshotMetadata: snapshot.metadata,
      verifySourceUnchanged: () => snapshot.verifySourceUnchanged(),
    };
  }
}

export const defaultDocumentEngineFacade = createDocumentEngineFacade();

async function decodeResult<Operation extends "detect" | "parse" | "validateHwpx">(
  operation: Operation,
  result: IsolatedDocumentResult<Operation>,
): Promise<DocumentResultPayload<Operation>> {
  if (!isIntegrityVerifiedResultSpool(result)) {
    return result as DocumentResultPayload<Operation>;
  }
  if (operation === "detect" || operation === "validateHwpx") {
    await result.cleanup();
    throw new Error("Detect results cannot use a spool transport.");
  }
  return decodeDocumentResultSpool(result) as Promise<DocumentResultPayload<Operation>>;
}

async function decodeRenderResult(
  result: IsolatedDocumentResult<"render">,
): Promise<DocumentResultPayload<"render">> {
  return isIntegrityVerifiedResultSpool(result)
    ? decodeDocumentResultSpool(result)
    : result;
}

function createCandidateWorkerSnapshot(bytes: ArrayBuffer): DocumentSnapshot {
  const transferable = bytes.slice(0);
  let taken = false;
  let disposed = false;
  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  return Object.freeze({
    transport: "worker" as const,
    metadata: Object.freeze({
      sizeBytes: bytes.byteLength,
      sha256,
      shallowFormat: Object.freeze({
        candidate: "hwpx" as const,
        container: "zip" as const,
        exact: false as const,
      }),
      protection: Object.freeze({
        status: "requires-engine-validation" as const,
        candidateFormat: "hwpx" as const,
        exact: false as const,
      }),
    }),
    takeTransferable(): ArrayBuffer {
      if (taken || disposed) throw new Error("Candidate snapshot was already consumed.");
      taken = true;
      return transferable;
    },
    async verifySourceUnchanged(): Promise<void> {},
    async cleanup(): Promise<void> {
      disposed = true;
    },
  });
}

function createCandidateSpoolSnapshot(
  range: Readonly<{ fd: number; sizeBytes: number }>,
  sha256: string,
): SpoolDocumentSnapshot {
  let taken = false;
  return Object.freeze({
    transport: "spool" as const,
    metadata: Object.freeze({
      sizeBytes: range.sizeBytes,
      sha256,
      shallowFormat: Object.freeze({
        candidate: "hwpx" as const,
        container: "zip" as const,
        exact: false as const,
      }),
      protection: Object.freeze({
        status: "requires-engine-validation" as const,
        candidateFormat: "hwpx" as const,
        exact: false as const,
      }),
    }),
    takeSpoolHandle(): Readonly<{ fd: number; sizeBytes: number }> {
      if (taken) throw engineProtocolError();
      taken = true;
      return range;
    },
    async verifySourceUnchanged(): Promise<void> {
      if (await hashFdRange(range.fd, range.sizeBytes) !== sha256) {
        throw engineProtocolError();
      }
    },
    async cleanup(): Promise<void> {},
  });
}

async function hashFdRange(fd: number, sizeBytes: number): Promise<string> {
  if (!Number.isSafeInteger(fd) || fd < 0 ||
    !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw engineProtocolError();
  }
  const buffer = Buffer.allocUnsafeSlow(Math.min(1024 * 1024, sizeBytes));
  const hash = createHash("sha256");
  let position = 0;
  while (position < sizeBytes) {
    const requested = Math.min(buffer.byteLength, sizeBytes - position);
    const bytesRead = await new Promise<number>((resolve, reject) => {
      readFd(fd, buffer, 0, requested, position, (error, count) => {
        if (error === null) resolve(count);
        else reject(error);
      });
    });
    if (bytesRead === 0) throw engineProtocolError();
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function engineProtocolError(): Error {
  const error = new Error("The isolated engine returned an invalid HWPX result.");
  Object.assign(error, { code: "ENGINE_PROTOCOL_ERROR" });
  return error;
}

function requireNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error("The request was cancelled.");
  Object.assign(error, { code: "REQUEST_CANCELLED" });
  throw error;
}

export {
  prepareDocumentRenderOutput,
  writeDocumentRenderResultExclusively,
};

function toRunOptions(
  context: DocumentEngineExecutionContext,
): DocumentEngineRunOptions {
  return {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.deadlineMs === undefined ? {} : { deadlineMs: context.deadlineMs }),
    ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
  };
}

function copyDefined(
  options: Readonly<{ pages?: string }>,
): { pages?: string } {
  return options.pages === undefined ? {} : { pages: options.pages };
}

function copyFillFields(
  fields: Readonly<Record<string, string | readonly string[]>>,
): Record<string, string | readonly string[]> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    typeof value === "string" ? value : [...value],
  ]));
}

function createDefaultIsolatedEngine(): IsolatedDocumentEngine {
  const workerEntry = runtimeEntry("document-worker.js");
  const childEntry = runtimeEntry("document-child.js");
  return createIsolatedDocumentEngine({
    workerClient: createDocumentWorkerClient({
      workerFactory: (options) => new Worker(workerEntry, options),
    }),
    childClient: createDocumentChildClient({
      childEntry: fileURLToPath(childEntry),
    }),
  });
}

function runtimeEntry(filename: string): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL(`../../dist/workers/${filename}`, import.meta.url)
    : new URL(`../workers/${filename}`, import.meta.url);
}
