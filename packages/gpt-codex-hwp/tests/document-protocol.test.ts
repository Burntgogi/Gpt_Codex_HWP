import assert from "node:assert/strict";
import test from "node:test";

import * as protocolModule from "../src/workers/document-protocol.js";
import {
  DocumentProtocolError,
  normalizeDocumentEngineError,
} from "../src/workers/document-errors.js";

interface ProtocolApi {
  readonly DOCUMENT_ENGINE_OPERATIONS: readonly string[];
  readonly MAX_INLINE_MARKDOWN_CHARACTERS: number;
  readonly MAX_DOCUMENT_PARSE_MARKDOWN_BYTES: number;
  readonly MAX_DOCUMENT_RENDER_SVG_BYTES: number;
  readonly MAX_CHILD_INLINE_RESULT_BYTES: number;
  validateLogicalDocumentRequest(value: unknown): Readonly<Record<string, unknown>>;
  validateWireDocumentRequest(value: unknown): Readonly<Record<string, unknown>>;
  createWireDocumentRequest(
    logical: unknown,
    transports: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
  createDocumentEventValidator(
    requestId: string,
    operation: string,
  ): { accept(value: unknown): unknown };
  createChildDocumentEventValidator(
    requestId: string,
    operation: string,
  ): { accept(value: unknown): unknown };
  createInlineDocumentResultEvent(
    requestId: string,
    operation: string,
    payload: unknown,
  ): Readonly<Record<string, unknown>>;
  measureDocumentResultByteLength(operation: string, payload: unknown): number;
}

const protocol = protocolModule as unknown as ProtocolApi;
const requestId = "request_42";
const documentBuffer = new ArrayBuffer(3);
const imageBuffer = new ArrayBuffer(2);
const documentTransport = { transport: "buffer", buffer: documentBuffer };
const imageTransport = { transport: "buffer", buffer: imageBuffer };

const logicalRequests = {
  detect: request("detect", {}, {}),
  parse: request("parse", {}, { pages: "1-3, 5" }),
  render: request(
    "render",
    {},
    { reflow: true, highlights: ["approval", "결재"] },
  ),
  generateHwpx: request(
    "generateHwpx",
    { markdown: "# document" },
    {},
  ),
  patchHwpx: request(
    "patchHwpx",
    { markdown: "changed" },
    {},
  ),
  fillHwpx: request(
    "fillHwpx",
    { fields: { name: "value", tags: ["a", "b"] } },
    { formats: { name: "date" }, requireUnique: true },
  ),
  validateHwpx: request("validateHwpx", {}, { maxIssues: 100 }),
  insertImage: request(
    "insertImage",
    { anchorText: "anchor" },
    {
      mode: "seal-anchor",
      sizeMm: 18,
      anchorOccurrence: 0,
      widthPx: 320,
      heightPx: 240,
    },
  ),
} as const;

const wireRequests = {
  detect: request("detect", { document: documentTransport }, {}),
  parse: request(
    "parse",
    { document: documentTransport },
    { pages: "1-3, 5" },
  ),
  render: request(
    "render",
    { document: documentTransport },
    { reflow: true, highlights: ["approval", "결재"] },
  ),
  generateHwpx: logicalRequests.generateHwpx,
  patchHwpx: request(
    "patchHwpx",
    { document: documentTransport, markdown: "changed" },
    {},
  ),
  fillHwpx: request(
    "fillHwpx",
    { document: documentTransport, fields: { name: "value" } },
    { formats: { name: "date" }, requireUnique: true },
  ),
  validateHwpx: request(
    "validateHwpx",
    { document: documentTransport },
    { maxIssues: 100 },
  ),
  insertImage: request(
    "insertImage",
    { document: documentTransport, image: imageTransport, anchorText: "anchor" },
    {
      mode: "seal-anchor",
      sizeMm: 18,
      anchorOccurrence: 0,
      widthPx: 320,
      heightPx: 240,
    },
  ),
} as const;

test("document engine protocol separates path-free logical requests from wire transport", () => {
  assert.deepEqual(protocol.DOCUMENT_ENGINE_OPERATIONS, Object.keys(logicalRequests));
  for (const logical of Object.values(logicalRequests)) {
    assert.doesNotThrow(() => protocol.validateLogicalDocumentRequest(logical));
    assert.doesNotMatch(JSON.stringify(logical), /bytes|buffer|spool|path/iu);
  }
  assertProtocolError(() =>
    protocol.validateLogicalDocumentRequest({
      ...logicalRequests.detect,
      input: { documentBytes: new Uint8Array([1]) },
    }),
  );
});

test("document engine protocol builds exact wire inputs from logical requests and transports", () => {
  for (const wire of Object.values(wireRequests)) {
    assert.doesNotThrow(() => protocol.validateWireDocumentRequest(wire));
  }
  assert.deepEqual(
    protocol.createWireDocumentRequest(logicalRequests.patchHwpx, {
      document: documentTransport,
    }),
    wireRequests.patchHwpx,
  );
  assert.deepEqual(
    protocol.createWireDocumentRequest(logicalRequests.generateHwpx, {}),
    logicalRequests.generateHwpx,
  );
  assertProtocolError(() =>
    protocol.createWireDocumentRequest(logicalRequests.detect, {}),
  );
  assertProtocolError(() =>
    protocol.createWireDocumentRequest(logicalRequests.generateHwpx, {
      document: documentTransport,
    }),
  );
});

test("document engine protocol preserves bounded parse page selections", () => {
  for (const pages of ["1", "1-3", "1, 3, 5", " 2 - 4 , 7 "]) {
    assert.doesNotThrow(() =>
      protocol.validateLogicalDocumentRequest(request("parse", {}, { pages })),
    );
  }
  for (const options of [
    { pages: "" },
    { pages: "   " },
    { pages: "1;2" },
    { pages: "1, ../../secret" },
    { pages: "1".repeat(257) },
    { filePath: "C:\\private\\source.hwp" },
  ]) {
    assertProtocolError(() =>
      protocol.validateLogicalDocumentRequest(request("parse", {}, options)),
    );
  }
});

test("document engine protocol preserves render reflow and highlight limits", () => {
  assert.doesNotThrow(() =>
    protocol.validateLogicalDocumentRequest(
      request("render", {}, { reflow: false, highlights: ["one", "two"] }),
    ),
  );
  for (const options of [
    { page: 1 },
    { scale: 1 },
    { highlights: [""] },
    { highlights: ["x".repeat(257)] },
    { highlights: Array.from({ length: 257 }, () => "x") },
    { highlights: Array.from({ length: 65 }, () => "x".repeat(256)) },
  ]) {
    assertProtocolError(() =>
      protocol.validateLogicalDocumentRequest(request("render", {}, options)),
    );
  }
});

test("document engine protocol removes invented generation and patch options", () => {
  for (const logical of [
    request("generateHwpx", { markdown: "# ok" }, { compressionLevel: 6 }),
    request("patchHwpx", { markdown: "changed" }, { compressionLevel: 6 }),
    request("patchHwpx", { markdown: "changed" }, { verify: false }),
  ]) {
    assertProtocolError(() => protocol.validateLogicalDocumentRequest(logical));
  }
});

test("document engine protocol preserves fill formats and uniqueness guard options", () => {
  assert.doesNotThrow(() =>
    protocol.validateLogicalDocumentRequest(
      request(
        "fillHwpx",
        { fields: { birthday: "19900315", names: ["one", "two"] } },
        {
          formats: { birthday: "YYYY-MM-DD" },
          requireUnique: true,
        },
      ),
    ),
  );
  for (const options of [
    { formats: { missing: "YYYY-MM-DD" } },
    { formats: { birthday: "x".repeat(257) } },
    { requireUnique: "yes" },
  ]) {
    assertProtocolError(() =>
      protocol.validateLogicalDocumentRequest(
        request("fillHwpx", { fields: { birthday: "19900315" } }, options),
      ),
    );
  }
  assertProtocolError(() =>
    protocol.validateLogicalDocumentRequest(
      request(
        "fillHwpx",
        { fields: { ["k".repeat(10_001)]: "value" } },
        {},
      ),
    ),
  );
  assertProtocolError(() =>
    resultFor("fillHwpx", {
      bytes: new ArrayBuffer(1),
      metadata: { formValues: { birthday: "19900315" } },
    }),
  );
});

test("document engine protocol preserves actual image insertion options", () => {
  assert.doesNotThrow(() =>
    protocol.validateLogicalDocumentRequest(
      request(
        "insertImage",
        { anchorText: "(인)" },
        {
          mode: "after-paragraph",
          sizeMm: 200,
          anchorOccurrence: 1,
          widthPx: 100,
          heightPx: 100,
        },
      ),
    ),
  );
  for (const options of [
    { mode: "overlap" },
    { sizeMm: 0 },
    { sizeMm: 201 },
    { anchorOccurrence: -1 },
    { anchorOccurrence: 0.5 },
  ]) {
    assertProtocolError(() =>
      protocol.validateLogicalDocumentRequest(
        request("insertImage", { anchorText: "anchor" }, options),
      ),
    );
  }
});

test("document engine protocol accepts only exact ArrayBuffer worker transports", () => {
  for (const rejected of [
    new Uint8Array([1]),
    Buffer.from([1]),
    new Uint8Array(new ArrayBuffer(4), 1, 2),
    typeof SharedArrayBuffer === "undefined" ? {} : new SharedArrayBuffer(1),
  ]) {
    assertProtocolError(() =>
      protocol.validateWireDocumentRequest({
        ...wireRequests.detect,
        input: { document: { transport: "buffer", buffer: rejected } },
      }),
    );
  }
  assertProtocolError(() =>
    protocol.validateWireDocumentRequest({
      ...wireRequests.detect,
      input: {
        document: {
          transport: "buffer",
          buffer: documentBuffer,
          byteOffset: 1,
        },
      },
    }),
  );
});

test("document engine protocol validates path-free child spool descriptors and sizes", () => {
  const child = request(
    "insertImage",
    {
      document: { transport: "spool", descriptor: 3, sizeBytes: 512 },
      image: { transport: "spool", descriptor: 4, sizeBytes: 25 },
      anchorText: "anchor",
    },
    {},
  );
  assert.doesNotThrow(() => protocol.validateWireDocumentRequest(child));

  for (const badInput of [
    {
      document: {
        transport: "spool",
        descriptor: 3,
        sizeBytes: 512 * 1024 * 1024 + 1,
      },
      image: { transport: "spool", descriptor: 4, sizeBytes: 25 },
      anchorText: "anchor",
    },
    {
      document: { transport: "spool", descriptor: 4, sizeBytes: 512 },
      image: { transport: "spool", descriptor: 4, sizeBytes: 25 },
      anchorText: "anchor",
    },
    {
      document: { transport: "spool", descriptor: 3, sizeBytes: 512 },
      image: { transport: "spool", descriptor: 4, sizeBytes: 0 },
      anchorText: "anchor",
    },
    {
      document: { transport: "spool", descriptor: 3, sizeBytes: 512 },
      image: {
        transport: "spool",
        descriptor: 4,
        sizeBytes: 25 * 1024 * 1024 + 1,
      },
      anchorText: "anchor",
    },
    {
      document: {
        transport: "spool",
        descriptor: 3,
        sizeBytes: 512,
        path: "C:\\private\\source.hwp",
      },
      image: { transport: "spool", descriptor: 4, sizeBytes: 25 },
      anchorText: "anchor",
    },
  ]) {
    assertProtocolError(() =>
      protocol.validateWireDocumentRequest({ ...child, input: badInput }),
    );
  }
});

test("document child protocol accepts only small inline results", () => {
  assert.equal(protocol.MAX_CHILD_INLINE_RESULT_BYTES, 8 * 1024 * 1024);
  const validator = protocol.createChildDocumentEventValidator(requestId, "detect");
  validator.accept(readyEvent());
  assert.deepEqual(
    validator.accept(resultEvent({ format: "hwp" }, 3)),
    resultEvent({ format: "hwp" }, 3),
  );

  const oversized = protocol.createChildDocumentEventValidator(requestId, "detect");
  oversized.accept(readyEvent());
  assertProtocolError(() => oversized.accept({
    ...resultEvent({ format: "hwp" }, 3),
    outputByteLength: protocol.MAX_CHILD_INLINE_RESULT_BYTES + 1,
  }));
});

test("document child protocol validates exact fd 5 spool receipts by operation", () => {
  const validator = protocol.createChildDocumentEventValidator(requestId, "render");
  validator.accept(readyEvent());
  const event = {
    protocolVersion: 1,
    requestId,
    type: "spoolResult",
    receipt: {
      descriptor: 5,
      operation: "render",
      encoding: "utf8",
      sizeBytes: 9 * 1024 * 1024,
      sha256: "a".repeat(64),
    },
  };
  assert.deepEqual(validator.accept(event), event);

  for (const receipt of [
    { ...event.receipt, descriptor: 4 },
    { ...event.receipt, operation: "parse" },
    { ...event.receipt, encoding: "binary" },
    { ...event.receipt, sizeBytes: 0 },
    { ...event.receipt, sha256: "C:\\private\\output.hwpx" },
    { ...event.receipt, path: "C:\\private\\output.hwpx" },
  ]) {
    const rejected = protocol.createChildDocumentEventValidator(requestId, "render");
    rejected.accept(readyEvent());
    assertProtocolError(() => rejected.accept({ ...event, receipt }));
  }
});

test("document child protocol requires detect and validate results inline", () => {
  for (const operation of ["detect", "validateHwpx"] as const) {
    const validator = protocol.createChildDocumentEventValidator(requestId, operation);
    validator.accept(readyEvent());
    assertProtocolError(() => validator.accept({
      protocolVersion: 1,
      requestId,
      type: "spoolResult",
      receipt: {
        descriptor: 5,
        operation,
        encoding: "safe-json",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
      },
    }));
  }
});

test("document child protocol sender refuses oversized inline payloads before posting", () => {
  const payload = { svg: "x".repeat(8 * 1024 * 1024 + 1) };
  assertProtocolError(() =>
    protocol.createInlineDocumentResultEvent(requestId, "render", payload),
  );
});

test("document engine protocol rejects empty and oversized image buffers", () => {
  for (const buffer of [
    new ArrayBuffer(0),
    new ArrayBuffer(25 * 1024 * 1024 + 1),
  ]) {
    assertProtocolError(() =>
      protocol.validateWireDocumentRequest({
        ...wireRequests.insertImage,
        input: { ...wireRequests.insertImage.input, image: { transport: "buffer", buffer } },
      }),
    );
  }
});

test("document engine protocol preserves established request limits", () => {
  assert.doesNotThrow(() =>
    protocol.validateLogicalDocumentRequest(
      request("generateHwpx", { markdown: "m".repeat(64_001) }, {}),
    ),
  );
  for (const logical of [
    request("insertImage", { anchorText: "   " }, {}),
    request("insertImage", { anchorText: "a".repeat(10_001) }, {}),
    request("insertImage", { anchorText: "a" }, { widthPx: 10_001 }),
    request(
      "insertImage",
      { anchorText: "a" },
      { widthPx: 8_000, heightPx: 6_000 },
    ),
    request("patchHwpx", { markdown: "m".repeat(5_000_001) }, {}),
    request(
      "fillHwpx",
      {
        fields: {
          first: "a".repeat(2_500_001),
          second: "b".repeat(2_500_000),
        },
      },
      {},
    ),
  ]) {
    assertProtocolError(() => protocol.validateLogicalDocumentRequest(logical));
  }
});

test("document engine protocol enforces ready progress and terminal ordering", () => {
  const beforeReady = protocol.createDocumentEventValidator(requestId, "detect");
  assertProtocolError(() =>
    beforeReady.accept(progressEvent(0, 1)),
  );
  assertProtocolError(() =>
    beforeReady.accept(resultEvent({ format: "hwp" }, 3)),
  );

  const failureBeforeReady = protocol.createDocumentEventValidator(requestId, "detect");
  assert.doesNotThrow(() => failureBeforeReady.accept(failureEvent()));
  assertProtocolError(
    () => failureBeforeReady.accept(readyEvent()),
    "A terminal document engine event was already accepted.",
  );

  const failureAfterReady = protocol.createDocumentEventValidator(requestId, "detect");
  failureAfterReady.accept(readyEvent());
  assert.doesNotThrow(() => failureAfterReady.accept(failureEvent()));
});

test("document engine protocol rejects duplicate ready and nonmonotonic progress", () => {
  const validator = protocol.createDocumentEventValidator(requestId, "detect");
  validator.accept(readyEvent());
  assertProtocolError(() => validator.accept(readyEvent()));
  validator.accept(progressEvent(2, 10));
  assertProtocolError(() => validator.accept(progressEvent(1, 10)));
  assertProtocolError(() => validator.accept(progressEvent(3, 11)));
});

test("document engine protocol rejects every event after a terminal event", () => {
  const validator = protocol.createDocumentEventValidator(requestId, "detect");
  validator.accept(readyEvent());
  validator.accept(resultFor("detect", { format: "hwp" }));
  for (const event of [readyEvent(), progressEvent(1, 1), failureEvent()]) {
    assertProtocolError(
      () => validator.accept(event),
      "A terminal document engine event was already accepted.",
    );
  }
});

test("document engine protocol validates operation-linked result payloads", () => {
  const payloads = {
    detect: { format: "hwpx" },
    parse: parsePayload("# parsed", { metadata: { title: "document" } }),
    render: { svg: "<svg/>", metadata: Object.assign(Object.create(null), { page: 1 }) },
    generateHwpx: { bytes: new ArrayBuffer(1) },
    patchHwpx: { bytes: new ArrayBuffer(2), metadata: { changed: true } },
    fillHwpx: { bytes: new ArrayBuffer(3) },
    validateHwpx: {
      ok: false,
      issues: [{ message: "invalid entry", entry: "Contents/section0.xml" }],
      entryCount: 4,
    },
    insertImage: { bytes: new ArrayBuffer(4) },
  } as const;

  for (const [operation, payload] of Object.entries(payloads)) {
    assert.doesNotThrow(() => resultFor(operation, payload));
  }
});

test("document engine protocol preserves the exact parse result consumed by hwp_read", () => {
  const payload = parsePayload("# parsed", {
    fileType: "hwp",
    pageCount: 3,
    isImageBased: true,
    metadata: { title: "safe" },
    warnings: [
      { page: 2, code: "SKIPPED_IMAGE", message: "Image was skipped." },
    ],
    images: [
      {
        filename: "image_001.png",
        mimeType: "image/png",
        bytes: new ArrayBuffer(3),
      },
    ],
  });
  assert.doesNotThrow(() => resultFor("parse", payload));

  const base = protocol.measureDocumentResultByteLength(
    "parse",
    parsePayload("# parsed"),
  );
  const enriched = protocol.measureDocumentResultByteLength("parse", payload);
  assert.ok(enriched > base + 3);
});

test("document engine protocol accepts actual parse shapes without optional top-level fields", () => {
  const minimal = {
    markdown: "minimal",
    fileType: "hwpx",
    warnings: [],
    images: [],
  };
  assert.doesNotThrow(() => resultFor("parse", minimal));

  const base = protocol.measureDocumentResultByteLength("parse", minimal);
  const withPageCount = protocol.measureDocumentResultByteLength("parse", {
    ...minimal,
    pageCount: 12,
  });
  const withImageBased = protocol.measureDocumentResultByteLength("parse", {
    ...minimal,
    isImageBased: false,
  });
  assert.ok(withPageCount > base);
  assert.ok(withImageBased > base);
});

test("document engine protocol rejects scalar and array parse metadata", () => {
  for (const metadata of [null, true, 1, "title", ["keyword"]]) {
    assertProtocolError(() =>
      resultFor("parse", parsePayload("ok", { metadata })),
    );
  }
});

test("document engine protocol validates exact document metadata keys types and limits", () => {
  for (const metadata of [
    { unknown: "value" },
    { title: 1 },
    { author: ["author"] },
    { pageCount: 0 },
    { pageCount: Number.MAX_SAFE_INTEGER + 1 },
    { keywords: "keyword" },
    { keywords: ["safe", 1] },
    { keywords: Array(257).fill("keyword") },
    { title: "x".repeat(1_000_001) },
    { description: "bad\u0000description" },
  ]) {
    assertProtocolError(() =>
      resultFor("parse", parsePayload("ok", { metadata })),
    );
  }
});

test("document engine protocol rejects incomplete or expanded parse result shapes", () => {
  for (const payload of [
    { markdown: "missing consumed fields" },
    parsePayload("ok", { blocks: [] }),
    parsePayload("ok", { fileType: "pdf" }),
    parsePayload("ok", { pageCount: 0 }),
    parsePayload("ok", { isImageBased: "false" }),
    parsePayload("ok", {
      warnings: [{ page: 0, code: "WARNING", message: "invalid page" }],
    }),
    parsePayload("ok", {
      warnings: [{ code: "BAD\nCODE", message: "invalid code" }],
    }),
    parsePayload("ok", {
      warnings: [{ code: "WARNING", message: "bad\u0000message" }],
    }),
    parsePayload("ok", {
      images: [
        {
          filename: "../secret.png",
          mimeType: "image/png",
          bytes: new ArrayBuffer(1),
        },
      ],
    }),
    parsePayload("ok", {
      images: [
        {
          filename: "image.bin",
          mimeType: "application/octet-stream",
          bytes: new ArrayBuffer(1),
        },
      ],
    }),
    parsePayload("ok", {
      images: [
        {
          filename: "image.png",
          mimeType: "image/png",
          bytes: new Uint8Array([1]),
        },
      ],
    }),
  ]) {
    assertProtocolError(() => resultFor("parse", payload));
  }
});

test("document engine protocol bounds parse warnings and extracted images", () => {
  const warning = { code: "WARNING", message: "bounded" };
  assertProtocolError(() =>
    resultFor("parse", parsePayload("ok", { warnings: Array(1_001).fill(warning) })),
  );

  const image = {
    filename: "image.png",
    mimeType: "image/png",
    bytes: new ArrayBuffer(1),
  };
  assertProtocolError(() =>
    resultFor("parse", parsePayload("ok", { images: Array(257).fill(image) })),
  );
  assertProtocolError(() =>
    resultFor(
      "parse",
      parsePayload("ok", {
        images: [
          {
            ...image,
            bytes: new ArrayBuffer(25 * 1024 * 1024 + 1),
          },
        ],
      }),
    ),
  );
  const sharedLargeBuffer = new ArrayBuffer(25 * 1024 * 1024);
  assertProtocolError(() =>
    resultFor(
      "parse",
      parsePayload("ok", {
        images: Array.from({ length: 6 }, (_, index) => ({
          filename: `image_${index}.png`,
          mimeType: "image/png",
          bytes: sharedLargeBuffer,
        })),
      }),
    ),
  );
});

test("document engine protocol includes parse warnings and images in output length", () => {
  const payload = parsePayload("ok", {
    warnings: [{ code: "WARNING", message: "bounded" }],
    images: [
      {
        filename: "image.png",
        mimeType: "image/png",
        bytes: new ArrayBuffer(7),
      },
    ],
  });
  const exact = protocol.measureDocumentResultByteLength("parse", payload);
  const validator = protocol.createDocumentEventValidator(requestId, "parse");
  validator.accept(readyEvent());
  assertProtocolError(() => validator.accept(resultEvent(payload, exact - 1)));
});

test("document engine protocol rejects results for the wrong operation", () => {
  const validator = protocol.createDocumentEventValidator(requestId, "detect");
  validator.accept(readyEvent());
  assertProtocolError(() =>
    validator.accept(
      resultEvent(
        { bytes: new ArrayBuffer(1) },
        protocol.measureDocumentResultByteLength("generateHwpx", {
          bytes: new ArrayBuffer(1),
        }),
      ),
    ),
  );
});

test("document engine protocol rejects non-exact binary result buffers", () => {
  for (const bytes of [
    new Uint8Array([1]),
    Buffer.from([1]),
    typeof SharedArrayBuffer === "undefined" ? {} : new SharedArrayBuffer(1),
  ]) {
    assertProtocolError(() => resultFor("generateHwpx", { bytes }));
  }
});

test("document engine protocol keeps parse and render delivery ceilings distinct", () => {
  assert.equal(protocol.MAX_DOCUMENT_PARSE_MARKDOWN_BYTES, 256 * 1024 * 1024);
  assert.equal(protocol.MAX_DOCUMENT_RENDER_SVG_BYTES, 128 * 1024 * 1024);
  assert.equal(protocol.MAX_INLINE_MARKDOWN_CHARACTERS, 64_000);
  assert.doesNotThrow(() =>
    resultFor("parse", parsePayload("m".repeat(64_001))),
  );
});

test("document engine protocol validates exact validation results", () => {
  for (const payload of [
    { ok: true, issues: [], entryCount: 0, path: "C:\\private\\source.hwpx" },
    { ok: true, issues: [{ message: "x", path: "secret" }], entryCount: 1 },
    { ok: true, issues: [{ message: "x", entry: "C:\\private\\a.xml" }], entryCount: 1 },
    { ok: true, issues: [], entryCount: -1 },
  ]) {
    assertProtocolError(() => resultFor("validateHwpx", payload));
  }
});

test("document engine protocol accepts exact bounded document metadata", () => {
  const metadata = Object.assign(Object.create(null), {
    title: "Title",
    author: "Author",
    creator: "Hancom",
    createdAt: "2026-07-16T00:00:00Z",
    modifiedAt: "2026-07-16T01:00:00Z",
    pageCount: 2,
    version: "5.1.0.1",
    description: "Description",
    keywords: ["official", "document"],
  });
  assert.doesNotThrow(() =>
    resultFor("parse", parsePayload("ok", { metadata })),
  );
});

test("document engine protocol rejects unsafe metadata channels and descriptors", () => {
  const accessor = Object.defineProperty({}, "safe", {
    enumerable: true,
    get: () => "secret",
  });
  const nonenumerable = Object.defineProperty({}, "hidden", { value: "secret" });
  const symbol = { [Symbol("secret")]: "value" };
  const inherited = Object.create({ inherited: "secret" });
  inherited.safe = true;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let tooDeep: unknown = null;
  for (let depth = 0; depth < 18; depth += 1) tooDeep = { nested: tooDeep };
  const descriptorTrap = new Proxy({ safe: true }, {
    getOwnPropertyDescriptor(): never {
      throw new Error("DESCRIPTOR_SECRET");
    },
  });

  for (const metadata of [
    { path: "C:\\private\\source.hwp" },
    { file_path: "C:\\private\\source.hwp" },
    { command: "type secret" },
    { environment: { TOKEN: "secret" } },
    { stdout: "document fragment" },
    accessor,
    nonenumerable,
    symbol,
    inherited,
    cyclic,
    tooDeep,
    { value: "x".repeat(1_000_001) },
    descriptorTrap,
  ]) {
    assertProtocolError(() =>
      resultFor("parse", parsePayload("ok", { metadata })),
    );
  }
});

test("document engine protocol rejects inaccurate deterministic output lengths", () => {
  const validator = protocol.createDocumentEventValidator(requestId, "parse");
  validator.accept(readyEvent());
  const payload = parsePayload("한글", { metadata: { title: "hwpx" } });
  const exact = protocol.measureDocumentResultByteLength("parse", payload);
  assertProtocolError(() => validator.accept(resultEvent(payload, exact + 1)));
});

test("document engine protocol converts hostile request and event traps to protocol errors", () => {
  const throwingProxy = new Proxy({}, {
    ownKeys(): never {
      throw new Error("PROXY_SECRET");
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();

  for (const hostile of [throwingProxy, revoked.proxy]) {
    assertProtocolError(() => protocol.validateLogicalDocumentRequest(hostile));
    assertProtocolError(() => protocol.validateWireDocumentRequest(hostile));
    const validator = protocol.createDocumentEventValidator(requestId, "detect");
    assertProtocolError(() => validator.accept(hostile));
  }
});

test("document engine protocol gives OOM precedence over lifecycle races", () => {
  const oom = { message: "FATAL ERROR: Reached heap limit Allocation failed" };
  for (const context of [
    { terminationReason: "abort", ready: false },
    { terminationReason: "deadline", ready: true },
  ]) {
    assert.equal(normalizeDocumentEngineError(oom, context).code, "ENGINE_OOM");
  }
  assert.equal(
    normalizeDocumentEngineError(
      "FATAL ERROR: JavaScript heap out of memory",
      { terminationReason: "abort", ready: true },
    ).code,
    "ENGINE_OOM",
  );
  assert.equal(
    normalizeDocumentEngineError(new Error("deadline"), {
      terminationReason: "deadline",
      ready: false,
    }).code,
    "ENGINE_TIMEOUT",
  );
  assert.equal(
    normalizeDocumentEngineError(new Error("abort"), {
      terminationReason: "abort",
      ready: true,
    }).code,
    "REQUEST_CANCELLED",
  );
});

test("document engine protocol redacts hostile error and context objects", () => {
  const hostileContext = new Proxy({}, {
    get(): never {
      throw new Error("CONTEXT_SECRET");
    },
    ownKeys(): never {
      throw new Error("CONTEXT_KEYS_SECRET");
    },
    getOwnPropertyDescriptor(): never {
      throw new Error("CONTEXT_DESCRIPTOR_SECRET");
    },
  });
  const revokedError = Proxy.revocable({}, {});
  revokedError.revoke();
  assert.doesNotThrow(() => {
    const normalized = normalizeDocumentEngineError(
      revokedError.proxy,
      hostileContext,
    );
    assert.doesNotMatch(JSON.stringify(normalized), /SECRET/iu);
  });
});

function parsePayload(
  markdown: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    markdown,
    fileType: "hwpx",
    pageCount: 1,
    isImageBased: false,
    warnings: [],
    images: [],
    ...overrides,
  };
}

function request(
  operation: string,
  input: Readonly<Record<string, unknown>>,
  options: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { protocolVersion: 1, requestId, operation, input, options };
}

function readyEvent(): Readonly<Record<string, unknown>> {
  return { protocolVersion: 1, requestId, type: "ready" };
}

function progressEvent(completed: number, total: number): Readonly<Record<string, unknown>> {
  return { protocolVersion: 1, requestId, type: "progress", completed, total };
}

function failureEvent(): Readonly<Record<string, unknown>> {
  return {
    protocolVersion: 1,
    requestId,
    type: "failure",
    error: {
      code: "ENGINE_CRASH",
      message: "The document engine stopped unexpectedly.",
    },
  };
}

function resultEvent(
  payload: unknown,
  outputByteLength: number,
): Readonly<Record<string, unknown>> {
  return { protocolVersion: 1, requestId, type: "result", payload, outputByteLength };
}

function resultFor(operation: string, payload: unknown): unknown {
  const validator = protocol.createDocumentEventValidator(requestId, operation);
  validator.accept(readyEvent());
  return validator.accept(
    resultEvent(
      payload,
      protocol.measureDocumentResultByteLength(operation, payload),
    ),
  );
}

function assertProtocolError(action: () => unknown, message?: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DocumentProtocolError);
    assert.equal(error.code, "ENGINE_PROTOCOL_ERROR");
    if (message !== undefined) assert.equal(error.message, message);
    assert.doesNotMatch(error.message, /SECRET|private|source\.hwp/iu);
    return true;
  });
}
