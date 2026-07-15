import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import type {
  DocumentSnapshot,
  DocumentSnapshotMetadata,
} from "./document-snapshot.js";
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
  type DocumentEngineOperation,
  type DocumentResultPayload,
  type LogicalDocumentRequest,
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
  ): Promise<DocumentFacadeResult<"render">>;
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
    ): Promise<DocumentFacadeResult<"render">> {
      return run("render", snapshot, {}, {
        ...(options.reflow === undefined ? {} : { reflow: options.reflow }),
        ...(options.highlights === undefined
          ? {}
          : { highlights: [...options.highlights] }),
      }, context);
    },
  });

  async function run<Operation extends "detect" | "parse" | "render">(
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
    return { payload, snapshotMetadata: snapshot.metadata };
  }
}

export const defaultDocumentEngineFacade = createDocumentEngineFacade();

async function decodeResult<Operation extends "detect" | "parse" | "render">(
  operation: Operation,
  result: IsolatedDocumentResult<Operation>,
): Promise<DocumentResultPayload<Operation>> {
  if (!isIntegrityVerifiedResultSpool(result)) {
    return result as DocumentResultPayload<Operation>;
  }
  if (operation === "detect") {
    await result.cleanup();
    throw new Error("Detect results cannot use a spool transport.");
  }
  return decodeDocumentResultSpool(result) as Promise<DocumentResultPayload<Operation>>;
}

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
