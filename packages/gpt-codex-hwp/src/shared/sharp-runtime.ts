type SharpRuntime = typeof import("sharp")["default"];
type SharpImporter = () => Promise<{ default: SharpRuntime }>;

export class SharpRuntimeUnavailableError extends Error {
  constructor() {
    super("Image processing runtime is unavailable.");
    this.name = "SharpRuntimeUnavailableError";
  }
}

const defaultImporter: SharpImporter = () => import("sharp");

let importer: SharpImporter = defaultImporter;
let sharpPromise: Promise<SharpRuntime> | undefined;
let loadCount = 0;
let configured = false;

export function getSharp(): Promise<SharpRuntime> {
  sharpPromise ??= loadSharp();
  return sharpPromise;
}

async function loadSharp(): Promise<SharpRuntime> {
  loadCount += 1;
  try {
    const { default: sharp } = await importer();
    sharp.cache(false);
    sharp.concurrency(1);
    configured = true;
    return sharp;
  } catch {
    throw new SharpRuntimeUnavailableError();
  }
}

export function inspectSharpRuntimeForTests(): Readonly<{
  loadCount: number;
  configured: boolean;
}> {
  return Object.freeze({ loadCount, configured });
}

export function setSharpImporterForTests(value: SharpImporter): void {
  importer = value;
  sharpPromise = undefined;
  loadCount = 0;
  configured = false;
}

export function resetSharpRuntimeForTests(): void {
  importer = defaultImporter;
  sharpPromise = undefined;
  loadCount = 0;
  configured = false;
}
