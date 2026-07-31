export class SharpRuntimeUnavailableError extends Error {
    constructor() {
        super("Image processing runtime is unavailable.");
        this.name = "SharpRuntimeUnavailableError";
    }
}
const defaultImporter = () => import("sharp");
let importer = defaultImporter;
let sharpPromise;
let loadCount = 0;
let configured = false;
export function getSharp() {
    sharpPromise ??= loadSharp();
    return sharpPromise;
}
async function loadSharp() {
    loadCount += 1;
    try {
        const { default: sharp } = await importer();
        sharp.cache(false);
        sharp.concurrency(1);
        configured = true;
        return sharp;
    }
    catch {
        throw new SharpRuntimeUnavailableError();
    }
}
export function inspectSharpRuntimeForTests() {
    return Object.freeze({ loadCount, configured });
}
export function setSharpImporterForTests(value) {
    importer = value;
    sharpPromise = undefined;
    loadCount = 0;
    configured = false;
}
export function resetSharpRuntimeForTests() {
    importer = defaultImporter;
    sharpPromise = undefined;
    loadCount = 0;
    configured = false;
}
