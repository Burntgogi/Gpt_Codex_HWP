export class DocumentEngineUnavailableError extends Error {
    constructor() {
        super("Document processing runtime is unavailable.");
        this.name = "DocumentEngineUnavailableError";
    }
}
const defaultImporter = () => import("./document-engine.js");
let importer = defaultImporter;
let facadePromise;
let moduleLoadCount = 0;
let facadeConstructionCount = 0;
export function getDefaultDocumentEngineFacade() {
    facadePromise ??= loadDefaultFacade();
    return facadePromise;
}
async function loadDefaultFacade() {
    moduleLoadCount += 1;
    try {
        const { createDocumentEngineFacade } = await importer();
        const facade = createDocumentEngineFacade();
        facadeConstructionCount += 1;
        return facade;
    }
    catch {
        throw new DocumentEngineUnavailableError();
    }
}
export function inspectLazyDocumentEngineForTests() {
    return Object.freeze({ moduleLoadCount, facadeConstructionCount });
}
export function setDocumentEngineImporterForTests(value) {
    importer = value;
    facadePromise = undefined;
    moduleLoadCount = 0;
    facadeConstructionCount = 0;
}
export function resetLazyDocumentEngineForTests() {
    importer = defaultImporter;
    facadePromise = undefined;
    moduleLoadCount = 0;
    facadeConstructionCount = 0;
}
