import type {
  DocumentEngineFacade,
  createDocumentEngineFacade as CreateDocumentEngineFacade,
} from "./document-engine.js";

type DocumentEngineModule = Readonly<{
  createDocumentEngineFacade: typeof CreateDocumentEngineFacade;
}>;
type DocumentEngineImporter = () => Promise<DocumentEngineModule>;

export class DocumentEngineUnavailableError extends Error {
  constructor() {
    super("Document processing runtime is unavailable.");
    this.name = "DocumentEngineUnavailableError";
  }
}

const defaultImporter: DocumentEngineImporter = () => import("./document-engine.js");

let importer: DocumentEngineImporter = defaultImporter;
let facadePromise: Promise<DocumentEngineFacade> | undefined;
let moduleLoadCount = 0;
let facadeConstructionCount = 0;

export function getDefaultDocumentEngineFacade(): Promise<DocumentEngineFacade> {
  facadePromise ??= loadDefaultFacade();
  return facadePromise;
}

async function loadDefaultFacade(): Promise<DocumentEngineFacade> {
  moduleLoadCount += 1;
  try {
    const { createDocumentEngineFacade } = await importer();
    const facade = createDocumentEngineFacade();
    facadeConstructionCount += 1;
    return facade;
  } catch {
    throw new DocumentEngineUnavailableError();
  }
}

export function inspectLazyDocumentEngineForTests(): Readonly<{
  moduleLoadCount: number;
  facadeConstructionCount: number;
}> {
  return Object.freeze({ moduleLoadCount, facadeConstructionCount });
}

export function setDocumentEngineImporterForTests(value: DocumentEngineImporter): void {
  importer = value;
  facadePromise = undefined;
  moduleLoadCount = 0;
  facadeConstructionCount = 0;
}

export function resetLazyDocumentEngineForTests(): void {
  importer = defaultImporter;
  facadePromise = undefined;
  moduleLoadCount = 0;
  facadeConstructionCount = 0;
}
