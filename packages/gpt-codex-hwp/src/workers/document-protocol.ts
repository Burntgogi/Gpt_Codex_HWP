import {
  DOCUMENT_ENGINE_ERROR_MESSAGES,
  DocumentProtocolError,
  type DocumentEnginePublicError,
  isDocumentEngineErrorCode,
  isDocumentEngineRemediation,
  isDocumentEngineStage,
  isDocumentProtocolError,
} from "./document-errors.js";

export const DOCUMENT_PROTOCOL_VERSION = 1 as const;
export const MAX_DOCUMENT_ENGINE_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_DOCUMENT_ENGINE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_ENGINE_RESULT_BYTES = 512 * 1024 * 1024;
export const MAX_CHILD_INLINE_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_CHILD_REQUEST_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS = 5_000_000;
export const MAX_IMAGE_DIMENSION_PX = 10_000;
export const MAX_IMAGE_PIXELS = 40_000_000;

// These are delivery boundaries, not the later main-process inline/MCP boundary.
export const MAX_DOCUMENT_PARSE_MARKDOWN_BYTES = 256 * 1024 * 1024;
export const MAX_DOCUMENT_RENDER_SVG_BYTES = 128 * 1024 * 1024;
export const MAX_INLINE_MARKDOWN_CHARACTERS = 64_000;

export const MAX_SAFE_JSON_DEPTH = 16;
export const MAX_SAFE_JSON_NODES = 10_000;
export const MAX_SAFE_JSON_STRING_CHARACTERS = 1_000_000;
export const MAX_SAFE_JSON_BYTES = 8 * 1024 * 1024;

const MAX_FILL_VALUES = 10_000;
const MAX_FILL_FIELD_KEY_CHARACTERS = 10_000;
const MAX_FILL_FORMAT_CHARACTERS = 256;
const MAX_PARSE_PAGES_CHARACTERS = 256;
const MAX_HIGHLIGHT_TERMS = 256;
const MAX_HIGHLIGHT_CHARACTERS = 16_384;
const MAX_PARSE_WARNINGS = 1_000;
const MAX_PARSE_IMAGES = 256;
const MAX_PARSE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PARSE_IMAGE_AGGREGATE_BYTES = 128 * 1024 * 1024;
const MAX_VALIDATION_ISSUES = 10_000;
const MAX_VALIDATION_MESSAGE_CHARACTERS = 10_000;
const MAX_VALIDATION_ENTRY_CHARACTERS = 4_096;
const MAX_VALIDATION_ENTRY_COUNT = 1_000_000;
const PARSE_IMAGE_MIME_TYPES = new Set([
  "image/bmp",
  "image/emf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "image/wmf",
]);

export const DOCUMENT_ENGINE_OPERATIONS = [
  "detect",
  "parse",
  "render",
  "generateHwpx",
  "patchHwpx",
  "fillHwpx",
  "validateHwpx",
  "insertImage",
] as const;

export type DocumentEngineOperation =
  (typeof DOCUMENT_ENGINE_OPERATIONS)[number];

export interface BufferTransport {
  readonly transport: "buffer";
  readonly buffer: ArrayBuffer;
}

export interface DocumentSpoolTransport {
  readonly transport: "spool";
  readonly descriptor: 3;
  readonly sizeBytes: number;
}

export interface ImageSpoolTransport {
  readonly transport: "spool";
  readonly descriptor: 4;
  readonly sizeBytes: number;
}

export type DocumentInputTransport = BufferTransport | DocumentSpoolTransport;
export type ImageInputTransport = BufferTransport | ImageSpoolTransport;

interface RequestBase<Operation extends DocumentEngineOperation, Input, Options> {
  readonly protocolVersion: typeof DOCUMENT_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: Operation;
  readonly input: Input;
  readonly options: Options;
}

type EmptyRecord = Record<string, never>;
interface RenderOptions {
  readonly reflow?: boolean;
  readonly highlights?: readonly string[];
}
interface ParseOptions {
  readonly pages?: string;
}
interface FillOptions {
  readonly formats?: Readonly<Record<string, string>>;
  readonly requireUnique?: boolean;
}
interface ValidateOptions {
  readonly maxIssues?: number;
}
interface InsertImageOptions {
  readonly mode?: "after-paragraph" | "seal-anchor";
  readonly sizeMm?: number;
  readonly anchorOccurrence?: number;
  readonly widthPx?: number;
  readonly heightPx?: number;
}
type FillFields = Readonly<Record<string, string | readonly string[]>>;

export type LogicalDocumentRequest =
  | RequestBase<"detect", EmptyRecord, EmptyRecord>
  | RequestBase<"parse", EmptyRecord, ParseOptions>
  | RequestBase<"render", EmptyRecord, RenderOptions>
  | RequestBase<"generateHwpx", { readonly markdown: string }, EmptyRecord>
  | RequestBase<"patchHwpx", { readonly markdown: string }, EmptyRecord>
  | RequestBase<"fillHwpx", { readonly fields: FillFields }, FillOptions>
  | RequestBase<"validateHwpx", EmptyRecord, ValidateOptions>
  | RequestBase<"insertImage", { readonly anchorText: string }, InsertImageOptions>;

export type WireDocumentRequest =
  | RequestBase<
      "detect",
      { readonly document: DocumentInputTransport },
      EmptyRecord
    >
  | RequestBase<
      "parse",
      { readonly document: DocumentInputTransport },
      ParseOptions
    >
  | RequestBase<
      "render",
      { readonly document: DocumentInputTransport },
      RenderOptions
    >
  | RequestBase<"generateHwpx", { readonly markdown: string }, EmptyRecord>
  | RequestBase<
      "patchHwpx",
      { readonly document: DocumentInputTransport; readonly markdown: string },
      EmptyRecord
    >
  | RequestBase<
      "fillHwpx",
      { readonly document: DocumentInputTransport; readonly fields: FillFields },
      FillOptions
    >
  | RequestBase<
      "validateHwpx",
      { readonly document: DocumentInputTransport },
      ValidateOptions
    >
  | RequestBase<
      "insertImage",
      {
        readonly document: DocumentInputTransport;
        readonly image: ImageInputTransport;
        readonly anchorText: string;
      },
      InsertImageOptions
    >;

export interface WireDocumentTransports {
  readonly document?: DocumentInputTransport;
  readonly image?: ImageInputTransport;
}

interface EventBase<Type extends string> {
  readonly protocolVersion: typeof DOCUMENT_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly type: Type;
}

export type SafeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SafeJsonValue[]
  | { readonly [key: string]: SafeJsonValue };

export interface ValidationIssueResult {
  readonly message: string;
  readonly entry?: string;
}

export interface ParseWarningResult {
  readonly page?: number;
  readonly code: string;
  readonly message: string;
}

export interface ParseImageResult {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: ArrayBuffer;
}

export interface DocumentMetadataResult {
  readonly title?: string;
  readonly author?: string;
  readonly creator?: string;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly pageCount?: number;
  readonly version?: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
}

export interface DocumentResultPayloadMap {
  readonly detect: { readonly format: "hwp" | "hwpx" | "unknown" };
  readonly parse: {
    readonly markdown: string;
    readonly fileType: "hwp" | "hwpx";
    readonly metadata?: DocumentMetadataResult;
    readonly pageCount?: number;
    readonly isImageBased?: boolean;
    readonly warnings: readonly ParseWarningResult[];
    readonly images: readonly ParseImageResult[];
  };
  readonly render: {
    readonly svg: string;
    readonly metadata?: SafeJsonValue;
  };
  readonly generateHwpx: {
    readonly bytes: ArrayBuffer;
    readonly metadata?: SafeJsonValue;
  };
  readonly patchHwpx: {
    readonly bytes: ArrayBuffer;
    readonly metadata?: SafeJsonValue;
  };
  readonly fillHwpx: {
    readonly bytes: ArrayBuffer;
    readonly metadata?: SafeJsonValue;
  };
  readonly validateHwpx: {
    readonly ok: boolean;
    readonly issues: readonly ValidationIssueResult[];
    readonly entryCount: number;
  };
  readonly insertImage: {
    readonly bytes: ArrayBuffer;
    readonly metadata?: SafeJsonValue;
  };
}

export type DocumentResultPayload<Operation extends DocumentEngineOperation> =
  DocumentResultPayloadMap[Operation];

export type DocumentReadyEvent = EventBase<"ready">;
export interface DocumentProgressEvent extends EventBase<"progress"> {
  readonly completed: number;
  readonly total: number;
}
export interface DocumentResultEvent<
  Operation extends DocumentEngineOperation = DocumentEngineOperation,
> extends EventBase<"result"> {
  readonly payload: DocumentResultPayload<Operation>;
  readonly outputByteLength: number;
}
export interface DocumentFailureEvent extends EventBase<"failure"> {
  readonly error: DocumentEnginePublicError;
}
export type DocumentResultSpoolEncoding =
  | "document-result-v1"
  | "render-result-v1"
  | "binary";
export type DocumentSpoolEligibleOperation = Exclude<
  DocumentEngineOperation,
  "detect" | "validateHwpx"
>;
export interface DocumentResultSpoolReceipt<
  Operation extends DocumentEngineOperation = DocumentEngineOperation,
> {
  readonly descriptor: 5;
  readonly operation: Operation;
  readonly encoding: DocumentResultSpoolEncoding;
  readonly sizeBytes: number;
  readonly sha256: string;
}
export interface DocumentSpoolResultEvent<
  Operation extends DocumentEngineOperation = DocumentEngineOperation,
> extends EventBase<"spoolResult"> {
  readonly receipt: DocumentResultSpoolReceipt<Operation>;
}
export type DocumentEventEnvelope<
  Operation extends DocumentEngineOperation = DocumentEngineOperation,
> =
  | DocumentReadyEvent
  | DocumentProgressEvent
  | DocumentResultEvent<Operation>
  | DocumentFailureEvent;
export type ChildDocumentEventEnvelope<
  Operation extends DocumentEngineOperation = DocumentEngineOperation,
> = DocumentEventEnvelope<Operation> | DocumentSpoolResultEvent<Operation>;

export interface DocumentEventValidator<
  Operation extends DocumentEngineOperation = DocumentEngineOperation,
> {
  accept(value: unknown): DocumentEventEnvelope<Operation>;
}
export interface ChildDocumentEventValidator<
  Operation extends DocumentEngineOperation = DocumentEngineOperation,
> {
  accept(value: unknown): ChildDocumentEventEnvelope<Operation>;
}

interface ParsedRequest {
  readonly raw: unknown;
  readonly requestId: string;
  readonly operation: DocumentEngineOperation;
  readonly input: RecordSnapshot;
  readonly options: RecordSnapshot;
}

type RecordSnapshot = Record<string, unknown>;

export function validateLogicalDocumentRequest(
  value: unknown,
): LogicalDocumentRequest {
  return protocolBoundary(() => {
    parseRequest(value, "logical");
    return value as LogicalDocumentRequest;
  });
}

export function validateWireDocumentRequest(value: unknown): WireDocumentRequest {
  return protocolBoundary(() => {
    parseRequest(value, "wire");
    return value as WireDocumentRequest;
  });
}

export function createWireDocumentRequest(
  logicalValue: unknown,
  transportValue: unknown,
): WireDocumentRequest {
  return protocolBoundary(() => {
    const logical = parseRequest(logicalValue, "logical");
    const transportKeys = requiredTransportKeys(logical.operation);
    const transports = exactRecord(transportValue, transportKeys);
    const input = createWireInput(logical, transports);
    const wire = {
      protocolVersion: DOCUMENT_PROTOCOL_VERSION,
      requestId: logical.requestId,
      operation: logical.operation,
      input,
      options: { ...logical.options },
    };
    parseRequest(wire, "wire");
    return wire as WireDocumentRequest;
  });
}

export function createDocumentEventValidator<
  Operation extends DocumentEngineOperation,
>(
  expectedRequestId: string,
  expectedOperation: Operation,
): DocumentEventValidator<Operation> {
  const validator = createEventValidator(
    expectedRequestId,
    expectedOperation,
    false,
  );
  return {
    accept(value: unknown): DocumentEventEnvelope<Operation> {
      return validator.accept(value) as DocumentEventEnvelope<Operation>;
    },
  };
}

export function createChildDocumentEventValidator<
  Operation extends DocumentEngineOperation,
>(
  expectedRequestId: string,
  expectedOperation: Operation,
): ChildDocumentEventValidator<Operation> {
  return createEventValidator(expectedRequestId, expectedOperation, true);
}

function createEventValidator<Operation extends DocumentEngineOperation>(
  expectedRequestId: string,
  expectedOperation: Operation,
  childMode: boolean,
): ChildDocumentEventValidator<Operation> {
  return protocolBoundary(() => {
    requireRequestId(expectedRequestId);
    requireOperation(expectedOperation);
    let readyAccepted = false;
    let terminalAccepted = false;
    let progressTotal: number | undefined;
    let progressCompleted = -1;

    return {
      accept(value: unknown): ChildDocumentEventEnvelope<Operation> {
        return protocolBoundary(() => {
          if (terminalAccepted) {
            throw new DocumentProtocolError(
              "A terminal document engine event was already accepted.",
            );
          }
          const event = parseEvent(
            value,
            expectedRequestId,
            expectedOperation,
            childMode,
          );
          switch (event.type) {
            case "failure":
              terminalAccepted = true;
              return event;
            case "ready":
              if (readyAccepted) protocolFailure();
              readyAccepted = true;
              return event;
            case "progress":
              if (!readyAccepted) protocolFailure();
              if (
                (progressTotal !== undefined && event.total !== progressTotal) ||
                event.completed < progressCompleted
              ) {
                protocolFailure();
              }
              progressTotal = event.total;
              progressCompleted = event.completed;
              return event;
            case "result":
              if (!readyAccepted) protocolFailure();
              terminalAccepted = true;
              return event;
            case "spoolResult":
              if (!readyAccepted || !childMode) protocolFailure();
              terminalAccepted = true;
              return event;
          }
        });
      },
    };
  });
}

export function createInlineDocumentResultEvent<
  Operation extends DocumentEngineOperation,
>(
  requestId: string,
  operation: Operation,
  payload: unknown,
): DocumentResultEvent<Operation> {
  return protocolBoundary(() => {
    requireRequestId(requestId);
    requireOperation(operation);
    const outputByteLength = measureResultInternal(operation, payload);
    if (outputByteLength > MAX_CHILD_INLINE_RESULT_BYTES) protocolFailure();
    const event = {
      protocolVersion: DOCUMENT_PROTOCOL_VERSION,
      requestId,
      type: "result" as const,
      payload,
      outputByteLength,
    };
    parseEvent(event, requestId, operation, true);
    return event as DocumentResultEvent<Operation>;
  });
}

export function measureDocumentResultByteLength(
  operation: DocumentEngineOperation,
  payload: unknown,
): number {
  return protocolBoundary(() => {
    requireOperation(operation);
    const total = measureResultInternal(operation, payload);
    if (total > MAX_DOCUMENT_ENGINE_RESULT_BYTES) protocolFailure();
    return total;
  });
}

function parseRequest(value: unknown, mode: "logical" | "wire"): ParsedRequest {
  const root = exactRecord(value, [
    "protocolVersion",
    "requestId",
    "operation",
    "input",
    "options",
  ]);
  if (root.protocolVersion !== DOCUMENT_PROTOCOL_VERSION) protocolFailure();
  requireRequestId(root.requestId);
  requireOperation(root.operation);
  const input = readRecord(root.input);
  const options = readRecord(root.options);
  validateRequestPayload(root.operation, input, options, mode);
  return {
    raw: value,
    requestId: root.requestId,
    operation: root.operation,
    input,
    options,
  };
}

function validateRequestPayload(
  operation: DocumentEngineOperation,
  input: RecordSnapshot,
  options: RecordSnapshot,
  mode: "logical" | "wire",
): void {
  const needsDocument = operation !== "generateHwpx";
  const documentKey = mode === "wire" && needsDocument ? ["document"] : [];
  switch (operation) {
    case "detect":
      requireKeys(input, documentKey);
      requireKeys(options, []);
      break;
    case "parse":
      requireKeys(input, documentKey);
      validateParseOptions(options);
      break;
    case "render":
      requireKeys(input, documentKey);
      validateRenderOptions(options);
      break;
    case "generateHwpx":
      requireKeys(input, ["markdown"]);
      requireBoundedString(input.markdown, MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS);
      requireKeys(options, []);
      break;
    case "patchHwpx":
      requireKeys(input, [...documentKey, "markdown"]);
      requireBoundedString(input.markdown, MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS);
      requireKeys(options, []);
      break;
    case "fillHwpx":
      requireKeys(input, [...documentKey, "fields"]);
      validateFillOptions(options, validateFillFields(input.fields));
      break;
    case "validateHwpx":
      requireKeys(input, documentKey);
      validateValidateOptions(options);
      break;
    case "insertImage":
      requireKeys(
        input,
        mode === "wire" ? ["document", "image", "anchorText"] : ["anchorText"],
      );
      requireTrimmedString(input.anchorText, 10_000);
      validateInsertImageOptions(options);
      break;
  }
  if (mode === "wire" && needsDocument) {
    validateTransport(input.document, "document");
  }
  if (mode === "wire" && operation === "insertImage") {
    validateTransport(input.image, "image");
  }
}

function requiredTransportKeys(operation: DocumentEngineOperation): readonly string[] {
  if (operation === "generateHwpx") return [];
  return operation === "insertImage" ? ["document", "image"] : ["document"];
}

function createWireInput(
  logical: ParsedRequest,
  transports: RecordSnapshot,
): RecordSnapshot {
  switch (logical.operation) {
    case "detect":
    case "parse":
    case "render":
    case "validateHwpx":
      return { document: transports.document };
    case "generateHwpx":
      return { markdown: logical.input.markdown };
    case "patchHwpx":
      return { document: transports.document, markdown: logical.input.markdown };
    case "fillHwpx":
      return { document: transports.document, fields: logical.input.fields };
    case "insertImage":
      return {
        document: transports.document,
        image: transports.image,
        anchorText: logical.input.anchorText,
      };
  }
}

function validateTransport(value: unknown, kind: "document" | "image"): void {
  const transport = readRecord(value);
  if (transport.transport === "buffer") {
    requireKeys(transport, ["transport", "buffer"]);
    const byteLength = exactArrayBufferByteLength(transport.buffer);
    const minimum = kind === "image" ? 1 : 0;
    const maximum = kind === "image"
      ? MAX_DOCUMENT_ENGINE_IMAGE_BYTES
      : MAX_DOCUMENT_ENGINE_INPUT_BYTES;
    requireIntegerInRange(byteLength, minimum, maximum);
    return;
  }
  if (transport.transport === "spool") {
    requireKeys(transport, ["transport", "descriptor", "sizeBytes"]);
    const expectedDescriptor = kind === "image" ? 4 : 3;
    if (transport.descriptor !== expectedDescriptor) protocolFailure();
    requireIntegerInRange(
      transport.sizeBytes,
      kind === "image" ? 1 : 0,
      kind === "image"
        ? MAX_DOCUMENT_ENGINE_IMAGE_BYTES
        : MAX_DOCUMENT_ENGINE_INPUT_BYTES,
    );
    return;
  }
  protocolFailure();
}

function parseEvent<Operation extends DocumentEngineOperation>(
  value: unknown,
  expectedRequestId: string,
  expectedOperation: Operation,
  childMode = false,
): ChildDocumentEventEnvelope<Operation> {
  const event = readRecord(value);
  if (event.protocolVersion !== DOCUMENT_PROTOCOL_VERSION) protocolFailure();
  if (event.requestId !== expectedRequestId) protocolFailure();
  switch (event.type) {
    case "ready":
      requireKeys(event, ["protocolVersion", "requestId", "type"]);
      return value as DocumentReadyEvent;
    case "progress":
      requireKeys(event, [
        "protocolVersion",
        "requestId",
        "type",
        "completed",
        "total",
      ]);
      requireIntegerInRange(event.total, 1, Number.MAX_SAFE_INTEGER);
      requireIntegerInRange(event.completed, 0, event.total as number);
      return value as DocumentProgressEvent;
    case "result": {
      requireKeys(event, [
        "protocolVersion",
        "requestId",
        "type",
        "payload",
        "outputByteLength",
      ]);
      requireIntegerInRange(
        event.outputByteLength,
        0,
        childMode
          ? MAX_CHILD_INLINE_RESULT_BYTES
          : MAX_DOCUMENT_ENGINE_RESULT_BYTES,
      );
      const measured = measureResultInternal(expectedOperation, event.payload);
      if (measured !== event.outputByteLength) protocolFailure();
      return value as DocumentResultEvent<Operation>;
    }
    case "spoolResult": {
      if (!childMode) protocolFailure();
      requireKeys(event, [
        "protocolVersion",
        "requestId",
        "type",
        "receipt",
      ]);
      validateSpoolResultReceipt(event.receipt, expectedOperation);
      return value as DocumentSpoolResultEvent<Operation>;
    }
    case "failure":
      requireKeys(event, ["protocolVersion", "requestId", "type", "error"]);
      validateFailure(event.error);
      return value as DocumentFailureEvent;
    default:
      return protocolFailure();
  }
}

function validateSpoolResultReceipt<Operation extends DocumentEngineOperation>(
  value: unknown,
  expectedOperation: Operation,
): void {
  if (expectedOperation === "detect" || expectedOperation === "validateHwpx") {
    protocolFailure();
  }
  const receipt = exactRecord(value, [
    "descriptor",
    "operation",
    "encoding",
    "sizeBytes",
    "sha256",
  ]);
  if (receipt.descriptor !== 5 || receipt.operation !== expectedOperation) {
    protocolFailure();
  }
  if (receipt.encoding !== resultSpoolEncoding(expectedOperation)) {
    protocolFailure();
  }
  requireIntegerInRange(receipt.sizeBytes, 1, MAX_DOCUMENT_ENGINE_RESULT_BYTES);
  if (
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256)
  ) {
    protocolFailure();
  }
}

export function resultSpoolEncoding(
  operation: DocumentSpoolEligibleOperation,
): DocumentResultSpoolEncoding {
  switch (operation) {
    case "parse":
      return "document-result-v1";
    case "render":
      return "render-result-v1";
    case "generateHwpx":
    case "patchHwpx":
    case "fillHwpx":
    case "insertImage":
      return "binary";
  }
}

function measureResultInternal(
  operation: DocumentEngineOperation,
  value: unknown,
): number {
  const payload = readRecord(value);
  switch (operation) {
    case "detect":
      requireKeys(payload, ["format"]);
      if (
        payload.format !== "hwp" &&
        payload.format !== "hwpx" &&
        payload.format !== "unknown"
      ) {
        protocolFailure();
      }
      return utf8Bytes(payload.format);
    case "parse": {
      return measureParseResult(payload);
    }
    case "render": {
      requireKeys(payload, ["svg"], ["metadata"]);
      if (typeof payload.svg !== "string") protocolFailure();
      const primary = utf8Bytes(payload.svg);
      if (primary > MAX_DOCUMENT_RENDER_SVG_BYTES) protocolFailure();
      return checkedResultTotal(primary, metadataBytes(payload));
    }
    case "generateHwpx":
    case "patchHwpx":
    case "fillHwpx":
    case "insertImage": {
      requireKeys(payload, ["bytes"], ["metadata"]);
      const primary = exactArrayBufferByteLength(payload.bytes);
      if (primary > MAX_DOCUMENT_ENGINE_RESULT_BYTES) protocolFailure();
      return checkedResultTotal(primary, metadataBytes(payload));
    }
    case "validateHwpx":
      validateValidationResult(payload);
      return safeJsonBytes(value);
  }
}

function measureParseResult(payload: RecordSnapshot): number {
  requireKeys(
    payload,
    [
      "markdown",
      "fileType",
      "warnings",
      "images",
    ],
    ["metadata", "pageCount", "isImageBased"],
  );
  if (typeof payload.markdown !== "string") protocolFailure();
  const markdownBytes = utf8Bytes(payload.markdown);
  if (markdownBytes > MAX_DOCUMENT_PARSE_MARKDOWN_BYTES) protocolFailure();
  if (payload.fileType !== "hwp" && payload.fileType !== "hwpx") {
    protocolFailure();
  }
  if (Object.hasOwn(payload, "pageCount")) {
    requireIntegerInRange(payload.pageCount, 1, Number.MAX_SAFE_INTEGER);
  }
  if (
    Object.hasOwn(payload, "isImageBased") &&
    typeof payload.isImageBased !== "boolean"
  ) {
    protocolFailure();
  }

  const warnings = readArray(payload.warnings);
  if (warnings.length > MAX_PARSE_WARNINGS) protocolFailure();
  for (const warningValue of warnings) {
    const warning = exactRecord(warningValue, ["code", "message"], ["page"]);
    if (Object.hasOwn(warning, "page")) {
      requireIntegerInRange(warning.page, 1, Number.MAX_SAFE_INTEGER);
    }
    requireSafeCode(warning.code, 128);
    requireSafeText(warning.message, 10_000);
  }

  const images = readArray(payload.images);
  if (images.length > MAX_PARSE_IMAGES) protocolFailure();
  let imageBytes = 0;
  let aggregateImageContentBytes = 0;
  for (const imageValue of images) {
    const image = exactRecord(imageValue, ["filename", "mimeType", "bytes"]);
    requireSafeImageFilename(image.filename);
    if (
      typeof image.mimeType !== "string" ||
      !PARSE_IMAGE_MIME_TYPES.has(image.mimeType)
    ) {
      protocolFailure();
    }
    const bytes = exactArrayBufferByteLength(image.bytes);
    requireIntegerInRange(bytes, 1, MAX_PARSE_IMAGE_BYTES);
    aggregateImageContentBytes += bytes;
    if (aggregateImageContentBytes > MAX_PARSE_IMAGE_AGGREGATE_BYTES) {
      protocolFailure();
    }
    imageBytes = checkedResultTotal(
      imageBytes,
      checkedResultTotal(
        bytes,
        utf8Bytes(image.filename as string) + utf8Bytes(image.mimeType),
      ),
    );
  }

  let total = checkedResultTotal(markdownBytes, utf8Bytes(payload.fileType));
  if (Object.hasOwn(payload, "pageCount")) {
    total = checkedResultTotal(total, utf8Bytes(String(payload.pageCount)));
  }
  if (Object.hasOwn(payload, "isImageBased")) {
    total = checkedResultTotal(total, payload.isImageBased ? 4 : 5);
  }
  total = checkedResultTotal(total, safeJsonBytes(payload.warnings));
  total = checkedResultTotal(total, imageBytes);
  return checkedResultTotal(total, parseMetadataBytes(payload));
}

function parseMetadataBytes(payload: RecordSnapshot): number {
  if (!Object.hasOwn(payload, "metadata")) return 0;
  const metadata = exactRecord(
    payload.metadata,
    [],
    [
      "title",
      "author",
      "creator",
      "createdAt",
      "modifiedAt",
      "pageCount",
      "version",
      "description",
      "keywords",
    ],
  );
  for (const key of [
    "title",
    "author",
    "creator",
    "createdAt",
    "modifiedAt",
    "version",
    "description",
  ]) {
    if (Object.hasOwn(metadata, key)) {
      requireMetadataString(metadata[key]);
    }
  }
  if (Object.hasOwn(metadata, "pageCount")) {
    requireIntegerInRange(metadata.pageCount, 1, Number.MAX_SAFE_INTEGER);
  }
  if (Object.hasOwn(metadata, "keywords")) {
    const keywords = readArray(metadata.keywords);
    if (keywords.length > 256) protocolFailure();
    for (const keyword of keywords) requireMetadataString(keyword);
  }
  return safeJsonBytes(payload.metadata);
}

function metadataBytes(payload: RecordSnapshot): number {
  return Object.hasOwn(payload, "metadata")
    ? safeJsonBytes(payload.metadata)
    : 0;
}

function checkedResultTotal(primary: number, metadata: number): number {
  if (primary > MAX_DOCUMENT_ENGINE_RESULT_BYTES - metadata) protocolFailure();
  return primary + metadata;
}

function validateValidationResult(payload: RecordSnapshot): void {
  requireKeys(payload, ["ok", "issues", "entryCount"]);
  if (typeof payload.ok !== "boolean") protocolFailure();
  requireIntegerInRange(payload.entryCount, 0, MAX_VALIDATION_ENTRY_COUNT);
  const issues = readArray(payload.issues);
  if (issues.length > MAX_VALIDATION_ISSUES) protocolFailure();
  if ((payload.entryCount as number) < issues.length) protocolFailure();
  for (const issueValue of issues) {
    const issue = exactRecord(issueValue, ["message"], ["entry"]);
    requireTrimmedString(issue.message, MAX_VALIDATION_MESSAGE_CHARACTERS);
    if (Object.hasOwn(issue, "entry")) {
      requireTrimmedString(issue.entry, MAX_VALIDATION_ENTRY_CHARACTERS);
      if (isAbsoluteOrTraversingPath(issue.entry as string)) protocolFailure();
    }
  }
}

function validateFailure(value: unknown): void {
  const error = exactRecord(value, ["code", "message"], ["details"]);
  if (!isDocumentEngineErrorCode(error.code)) protocolFailure();
  if (error.message !== DOCUMENT_ENGINE_ERROR_MESSAGES[error.code]) {
    protocolFailure();
  }
  if (Object.hasOwn(error, "details")) {
    const details = exactRecord(
      error.details,
      [],
      ["stage", "elapsedMs", "remediation"],
    );
    if (Object.hasOwn(details, "stage") && !isDocumentEngineStage(details.stage)) {
      protocolFailure();
    }
    if (Object.hasOwn(details, "elapsedMs")) {
      requireIntegerInRange(details.elapsedMs, 0, Number.MAX_SAFE_INTEGER);
    }
    if (
      Object.hasOwn(details, "remediation") &&
      !isDocumentEngineRemediation(details.remediation)
    ) {
      protocolFailure();
    }
  }
}

function validateParseOptions(options: RecordSnapshot): void {
  requireKeys(options, [], ["pages"]);
  if (!Object.hasOwn(options, "pages")) return;
  if (
    typeof options.pages !== "string" ||
    options.pages.length > MAX_PARSE_PAGES_CHARACTERS ||
    !/^\s*\d+\s*(?:-\s*\d+\s*)?(?:,\s*\d+\s*(?:-\s*\d+\s*)?)*$/u.test(
      options.pages,
    )
  ) {
    protocolFailure();
  }
  for (const token of options.pages.match(/\d+/gu) ?? []) {
    requireIntegerInRange(Number(token), 1, Number.MAX_SAFE_INTEGER);
  }
}

function validateRenderOptions(options: RecordSnapshot): void {
  requireKeys(options, [], ["reflow", "highlights"]);
  if (Object.hasOwn(options, "reflow") && typeof options.reflow !== "boolean") {
    protocolFailure();
  }
  if (Object.hasOwn(options, "highlights")) {
    const highlights = readArray(options.highlights);
    if (highlights.length > MAX_HIGHLIGHT_TERMS) protocolFailure();
    let total = 0;
    for (const highlight of highlights) {
      if (
        typeof highlight !== "string" ||
        highlight.length === 0 ||
        highlight.length > 256
      ) {
        protocolFailure();
      }
      total += highlight.length;
      if (total > MAX_HIGHLIGHT_CHARACTERS) protocolFailure();
    }
  }
}

function validateFillOptions(
  options: RecordSnapshot,
  fields: RecordSnapshot,
): void {
  requireKeys(options, [], ["formats", "requireUnique"]);
  if (
    Object.hasOwn(options, "requireUnique") &&
    typeof options.requireUnique !== "boolean"
  ) {
    protocolFailure();
  }
  if (Object.hasOwn(options, "formats")) {
    const formats = readRecord(options.formats);
    const keys = Object.keys(formats);
    if (keys.length > MAX_FILL_VALUES) protocolFailure();
    for (const key of keys) {
      if (
        key.length > MAX_FILL_FIELD_KEY_CHARACTERS ||
        !Object.hasOwn(fields, key)
      ) {
        protocolFailure();
      }
      requireBoundedString(formats[key], MAX_FILL_FORMAT_CHARACTERS);
    }
  }
}

function validateValidateOptions(options: RecordSnapshot): void {
  requireKeys(options, [], ["maxIssues"]);
  if (Object.hasOwn(options, "maxIssues")) {
    requireIntegerInRange(options.maxIssues, 1, 10_000);
  }
}

function validateInsertImageOptions(options: RecordSnapshot): void {
  requireKeys(
    options,
    [],
    [
      "mode",
      "sizeMm",
      "anchorOccurrence",
      "widthPx",
      "heightPx",
    ],
  );
  if (
    Object.hasOwn(options, "mode") &&
    options.mode !== "after-paragraph" &&
    options.mode !== "seal-anchor"
  ) {
    protocolFailure();
  }
  if (Object.hasOwn(options, "sizeMm")) {
    requireNumberInRange(options.sizeMm, 1, 200);
  }
  if (Object.hasOwn(options, "anchorOccurrence")) {
    requireIntegerInRange(options.anchorOccurrence, 0, Number.MAX_SAFE_INTEGER);
  }
  if (Object.hasOwn(options, "widthPx")) {
    requireIntegerInRange(options.widthPx, 1, MAX_IMAGE_DIMENSION_PX);
  }
  if (Object.hasOwn(options, "heightPx")) {
    requireIntegerInRange(options.heightPx, 1, MAX_IMAGE_DIMENSION_PX);
  }
  if (
    typeof options.widthPx === "number" &&
    typeof options.heightPx === "number" &&
    options.widthPx * options.heightPx > MAX_IMAGE_PIXELS
  ) {
    protocolFailure();
  }
}

function validateFillFields(value: unknown): RecordSnapshot {
  const fields = readRecord(value);
  let valueCount = 0;
  let characterCount = 0;
  for (const key of Object.keys(fields)) {
    if (key.length > MAX_FILL_FIELD_KEY_CHARACTERS) protocolFailure();
    const fieldValue = fields[key];
    const values = Array.isArray(fieldValue) ? readStringArray(fieldValue) : [fieldValue];
    if (values.length === 0) protocolFailure();
    valueCount += values.length;
    if (valueCount > MAX_FILL_VALUES) protocolFailure();
    for (const item of values) {
      if (typeof item !== "string") protocolFailure();
      characterCount += item.length;
      if (characterCount > MAX_DOCUMENT_ENGINE_TEXT_CHARACTERS) {
        protocolFailure();
      }
    }
  }
  return fields;
}

function safeJsonBytes(value: unknown): number {
  const state = { nodes: 0, stringCharacters: 0, stack: new WeakSet<object>() };
  const serialized = canonicalSafeJson(value, 0, state);
  const bytes = utf8Bytes(serialized);
  if (bytes > MAX_SAFE_JSON_BYTES) protocolFailure();
  return bytes;
}

function canonicalSafeJson(
  value: unknown,
  depth: number,
  state: { nodes: number; stringCharacters: number; stack: WeakSet<object> },
): string {
  state.nodes += 1;
  if (state.nodes > MAX_SAFE_JSON_NODES || depth > MAX_SAFE_JSON_DEPTH) {
    protocolFailure();
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) protocolFailure();
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    countSafeJsonString(value, state);
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === null) protocolFailure();
  if (state.stack.has(value)) protocolFailure();
  state.stack.add(value);
  try {
    if (Reflect.getPrototypeOf(value) === Array.prototype) {
      const values = readArray(value);
      return `[${values
        .map((item) => canonicalSafeJson(item, depth + 1, state))
        .join(",")}]`;
    }
    const record = readRecord(value);
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      if (isForbiddenChannelKey(key)) protocolFailure();
      countSafeJsonString(key, state);
      parts.push(
        `${JSON.stringify(key)}:${canonicalSafeJson(record[key], depth + 1, state)}`,
      );
    }
    return `{${parts.join(",")}}`;
  } finally {
    state.stack.delete(value);
  }
}

function countSafeJsonString(
  value: string,
  state: { stringCharacters: number },
): void {
  state.stringCharacters += value.length;
  if (state.stringCharacters > MAX_SAFE_JSON_STRING_CHARACTERS) {
    protocolFailure();
  }
}

function readRecord(value: unknown): RecordSnapshot {
  if (typeof value !== "object" || value === null) protocolFailure();
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) protocolFailure();
  const snapshot: RecordSnapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") protocolFailure();
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      protocolFailure();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): RecordSnapshot {
  const record = readRecord(value);
  requireKeys(record, required, optional);
  return record;
}

function requireKeys(
  record: RecordSnapshot,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    protocolFailure();
  }
}

function readArray(value: unknown): readonly unknown[] {
  if (typeof value !== "object" || value === null) protocolFailure();
  if (Reflect.getPrototypeOf(value) !== Array.prototype) protocolFailure();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) protocolFailure();
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    protocolFailure();
  }
  const length = lengthDescriptor.value as number;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      protocolFailure();
    }
    result.push(descriptor.value);
  }
  if (keys.length !== length + 1) protocolFailure();
  return result;
}

function readStringArray(value: unknown): readonly unknown[] {
  return readArray(value);
}

function exactArrayBufferByteLength(value: unknown): number {
  if (typeof value !== "object" || value === null) protocolFailure();
  if (Reflect.getPrototypeOf(value) !== ArrayBuffer.prototype) protocolFailure();
  if (Reflect.ownKeys(value).length !== 0) protocolFailure();
  const getter = Reflect.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    "byteLength",
  )?.get;
  if (getter === undefined) protocolFailure();
  return getter.call(value) as number;
}

function requireOperation(value: unknown): asserts value is DocumentEngineOperation {
  if (
    typeof value !== "string" ||
    !(DOCUMENT_ENGINE_OPERATIONS as readonly string[]).includes(value)
  ) {
    protocolFailure();
  }
}

function requireRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    protocolFailure();
  }
}

function requireBoundedString(value: unknown, maximum: number): void {
  if (typeof value !== "string" || value.length > maximum) protocolFailure();
}

function requireTrimmedString(value: unknown, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    value.trim().length === 0
  ) {
    protocolFailure();
  }
}

function requireSafeCode(value: unknown, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    protocolFailure();
  }
}

function requireSafeText(value: unknown, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim().length === 0 ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    protocolFailure();
  }
}

function requireSafeImageFilename(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    /[<>:"/\\|?*\u0000-\u001F\u007F]/u.test(value) ||
    isAbsoluteOrTraversingPath(value)
  ) {
    protocolFailure();
  }
}

function requireMetadataString(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > MAX_SAFE_JSON_STRING_CHARACTERS ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) {
    protocolFailure();
  }
}

function requireIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    protocolFailure();
  }
}

function requireNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    protocolFailure();
  }
}

function isForbiddenChannelKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
  return new Set([
    "path",
    "filepath",
    "sourcepath",
    "outputpath",
    "imagepath",
    "command",
    "cwd",
    "env",
    "environment",
    "stdout",
    "stderr",
    "fields",
    "fieldvalues",
    "formvalues",
  ]).has(normalized);
}

function isAbsoluteOrTraversingPath(value: string): boolean {
  return (
    /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u.test(value) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)
  );
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function protocolBoundary<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (isDocumentProtocolError(error)) throw error;
    throw new DocumentProtocolError();
  }
}

function protocolFailure(): never {
  throw new DocumentProtocolError();
}
