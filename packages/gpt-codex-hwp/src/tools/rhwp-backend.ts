import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  detectFormat,
  detectOle2Format,
  detectZipFormat,
  type FileType,
  type ParseResult,
} from "kordoc";
import {
  type DocumentProtection,
} from "../shared/protection.js";

const RHWP_MODULE_SPECIFIER = "@rhwp/core";
const RHWP_WASM_FILENAME = "rhwp_bg.wasm";

export interface RhwpDocument {
  pageCount(): number;
  renderPageSvg(page: number): string;
  getSourceFormat(): string;
  free(): void;
}

export interface RhwpBackend {
  version: string;
  createDocument(bytes: Uint8Array): RhwpDocument;
}

export type RhwpBackendLoadResult =
  | { available: true; backend: RhwpBackend }
  | { available: false; reason: string };

export type RhwpBackendStatus =
  | { available: true; version: string }
  | { available: false; reason: string };

export interface RhwpBackendProvider {
  load(): Promise<RhwpBackendLoadResult>;
}

export interface RhwpLoaderDependencies {
  importModule(specifier: string): Promise<unknown>;
  resolveModule(specifier: string): string;
  readBinary(path: string): Promise<Uint8Array>;
}

interface RhwpModuleShape {
  default(input: { module_or_path: Uint8Array }): Promise<unknown>;
  HwpDocument: new (bytes: Uint8Array) => RhwpDocument;
  version(): string;
}

const requireFromHere = createRequire(import.meta.url);
const defaultLoaderDependencies: RhwpLoaderDependencies = {
  importModule: async (specifier) => import(specifier),
  resolveModule: (specifier) => requireFromHere.resolve(specifier),
  readBinary: async (path) => readFile(path),
};

export class RhwpBackendLoader implements RhwpBackendProvider {
  readonly #dependencies: RhwpLoaderDependencies;
  #initialization: Promise<RhwpBackendLoadResult> | undefined;

  constructor(dependencies: RhwpLoaderDependencies = defaultLoaderDependencies) {
    this.#dependencies = dependencies;
  }

  load(): Promise<RhwpBackendLoadResult> {
    this.#initialization ??= this.#initialize();
    return this.#initialization;
  }

  async #initialize(): Promise<RhwpBackendLoadResult> {
    try {
      const imported = await this.#dependencies.importModule(
        RHWP_MODULE_SPECIFIER,
      );
      const module = validateModuleShape(imported);
      installMeasureTextWidthIfAbsent();
      const entryPath = this.#dependencies.resolveModule(
        RHWP_MODULE_SPECIFIER,
      );
      const wasmPath = join(dirname(entryPath), RHWP_WASM_FILENAME);
      const wasm = exactUint8Array(
        await this.#dependencies.readBinary(wasmPath),
      );
      await module.default({ module_or_path: wasm });
      const version = module.version();
      if (typeof version !== "string" || version.trim().length === 0) {
        throw new Error("@rhwp/core version() returned an invalid value.");
      }

      return {
        available: true,
        backend: {
          version,
          createDocument(bytes) {
            const document = new module.HwpDocument(exactUint8Array(bytes));
            try {
              return validateDocumentShape(document);
            } catch (error: unknown) {
              if (
                typeof document === "object" &&
                document !== null &&
                "free" in document &&
                typeof document.free === "function"
              ) {
                try {
                  document.free();
                } catch (cleanupError: unknown) {
                  throw new Error(
                    `${errorMessage(error)} Cleanup also failed: ${errorMessage(cleanupError)}`,
                  );
                }
              }
              throw error;
            }
          },
        },
      };
    } catch (error: unknown) {
      return {
        available: false,
        reason: `@rhwp/core is unavailable: ${errorMessage(error)}`,
      };
    }
  }
}

const defaultRhwpBackendLoader = new RhwpBackendLoader();

export async function loadRhwpBackend(): Promise<RhwpBackendLoadResult> {
  return defaultRhwpBackendLoader.load();
}

export async function checkRhwpBackend(
  provider: RhwpBackendProvider = defaultRhwpBackendLoader,
): Promise<RhwpBackendStatus> {
  const loaded = await provider.load();
  return loaded.available
    ? { available: true, version: loaded.backend.version }
    : loaded;
}

export async function detectPreciseDocumentFormat(
  input: ArrayBuffer,
): Promise<FileType> {
  const initial = detectFormat(input);
  if (initial === "hwpx") {
    return detectZipFormat(input);
  }
  if (initial === "hwp") {
    return detectOle2Format(input);
  }
  return initial;
}

export type RhwpPreflightProtection = DocumentProtection;

export function inspectRhwpPreflightProtection(
  result: ParseResult,
): RhwpPreflightProtection | undefined {
  if (!result.success) {
    return result.code === "ENCRYPTED" || result.code === "DRM_PROTECTED"
      ? { code: result.code, error: result.error }
      : undefined;
  }
  if (isDistributionSentinel(result.markdown)) {
    return {
      code: "DRM_PROTECTED",
      error:
        "Kordoc returned only a protected/distribution-document sentinel; rhwp fallback is refused.",
    };
  }
  for (const warning of result.warnings ?? []) {
    if (/암호화|\bDRM\b|배포용\s*문서|distribution\s+document|protected\s+document/iu.test(warning.message)) {
      return {
        code: /암호화/iu.test(warning.message)
          ? "ENCRYPTED"
          : "DRM_PROTECTED",
        error: `Kordoc reported a protected document: ${warning.message}`,
      };
    }
  }
  return undefined;
}

function validateModuleShape(value: unknown): RhwpModuleShape {
  if (typeof value !== "object" || value === null) {
    throw new Error("@rhwp/core module API is not an object.");
  }
  const module = value as Partial<RhwpModuleShape>;
  if (typeof module.default !== "function") {
    throw new Error("@rhwp/core module API is missing default init().");
  }
  if (typeof module.HwpDocument !== "function") {
    throw new Error("@rhwp/core module API is missing HwpDocument.");
  }
  if (typeof module.version !== "function") {
    throw new Error("@rhwp/core module API is missing version().");
  }
  return module as RhwpModuleShape;
}

function isDistributionSentinel(markdown: string): boolean {
  const patterns = [
    /상위\s*버전의\s*배포용\s*문서/iu,
    /최신\s*버전의\s*한글.*뷰어/iu,
    /문서를\s*읽으려면/iu,
  ];
  if (!patterns.some((pattern) => pattern.test(markdown))) {
    return false;
  }
  const remainder = markdown
    .split(/\r?\n/u)
    .filter((line) => !patterns.some((pattern) => pattern.test(line)))
    .join("")
    .replace(/\s+/gu, "");
  return remainder.length < 120;
}

function validateDocumentShape(value: unknown): RhwpDocument {
  if (typeof value !== "object" || value === null) {
    throw new Error("@rhwp/core HwpDocument returned an invalid object.");
  }
  const document = value as Partial<RhwpDocument>;
  for (const method of [
    "pageCount",
    "renderPageSvg",
    "getSourceFormat",
    "free",
  ] as const) {
    if (typeof document[method] !== "function") {
      throw new Error(`@rhwp/core HwpDocument is missing ${method}().`);
    }
  }
  return document as RhwpDocument;
}

function installMeasureTextWidthIfAbsent(): void {
  const globalObject = globalThis as typeof globalThis & {
    measureTextWidth?: unknown;
  };
  if (!("measureTextWidth" in globalObject)) {
    Object.defineProperty(globalObject, "measureTextWidth", {
      configurable: true,
      writable: true,
      value: heuristicMeasureTextWidth,
    });
    return;
  }
  if (typeof globalObject.measureTextWidth !== "function") {
    throw new Error(
      "Existing globalThis.measureTextWidth is not callable and was preserved.",
    );
  }
}

function heuristicMeasureTextWidth(font: string, text: string): number {
  const match = /([0-9]+(?:\.[0-9]+)?)(px|pt)\b/iu.exec(font);
  const numericSize = Number(match?.[1] ?? 16);
  const unit = match?.[2]?.toLocaleLowerCase("en-US");
  const pixels = numericSize * (unit === "pt" ? 96 / 72 : 1);
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isCombiningCodePoint(codePoint)) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? pixels : pixels * 0.55;
  }
  return width;
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

function exactUint8Array(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
