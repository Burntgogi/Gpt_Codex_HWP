import assert from "node:assert/strict";
import test from "node:test";

import { createMcpServer } from "../src/mcp-main.js";
import type { DocumentEngineFacade } from "../src/shared/document-engine.js";
import {
  getDefaultDocumentEngineFacade,
  inspectLazyDocumentEngineForTests,
  resetLazyDocumentEngineForTests,
  setDocumentEngineImporterForTests,
} from "../src/shared/lazy-document-engine.js";

test("MCP tool registration does not load or construct the document engine", () => {
  resetLazyDocumentEngineForTests();
  createMcpServer();
  assert.deepEqual(inspectLazyDocumentEngineForTests(), {
    moduleLoadCount: 0,
    facadeConstructionCount: 0,
  });
});

test("concurrent first document operations share one lazy facade", async (t) => {
  const expected = {} as DocumentEngineFacade;
  let importerCalls = 0;
  resetLazyDocumentEngineForTests();
  setDocumentEngineImporterForTests(async () => {
    importerCalls += 1;
    return { createDocumentEngineFacade: () => expected };
  });
  t.after(() => resetLazyDocumentEngineForTests());

  const [first, second] = await Promise.all([
    getDefaultDocumentEngineFacade(),
    getDefaultDocumentEngineFacade(),
  ]);

  assert.equal(first, expected);
  assert.equal(second, expected);
  assert.equal(importerCalls, 1);
  assert.deepEqual(inspectLazyDocumentEngineForTests(), {
    moduleLoadCount: 1,
    facadeConstructionCount: 1,
  });
});

test("a document-engine loader failure is bounded and cached", async (t) => {
  let attempts = 0;
  resetLazyDocumentEngineForTests();
  setDocumentEngineImporterForTests(async () => {
    attempts += 1;
    throw new Error("private import detail");
  });
  t.after(() => resetLazyDocumentEngineForTests());

  await assert.rejects(getDefaultDocumentEngineFacade(), {
    name: "DocumentEngineUnavailableError",
    message: "Document processing runtime is unavailable.",
  });
  await assert.rejects(getDefaultDocumentEngineFacade(), {
    name: "DocumentEngineUnavailableError",
    message: "Document processing runtime is unavailable.",
  });
  assert.equal(attempts, 1);
  assert.deepEqual(inspectLazyDocumentEngineForTests(), {
    moduleLoadCount: 1,
    facadeConstructionCount: 0,
  });
});
