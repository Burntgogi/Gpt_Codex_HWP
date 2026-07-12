import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { detectFormat, detectOle2Format, detectZipFormat, } from "kordoc";
const RHWP_MODULE_SPECIFIER = "@rhwp/core";
const RHWP_WASM_FILENAME = "rhwp_bg.wasm";
const requireFromHere = createRequire(import.meta.url);
const defaultLoaderDependencies = {
    importModule: async (specifier) => import(specifier),
    resolveModule: (specifier) => requireFromHere.resolve(specifier),
    readBinary: async (path) => readFile(path),
};
export class RhwpBackendLoader {
    #dependencies;
    #initialization;
    constructor(dependencies = defaultLoaderDependencies) {
        this.#dependencies = dependencies;
    }
    load() {
        this.#initialization ??= this.#initialize();
        return this.#initialization;
    }
    async #initialize() {
        try {
            const imported = await this.#dependencies.importModule(RHWP_MODULE_SPECIFIER);
            const module = validateModuleShape(imported);
            installMeasureTextWidthIfAbsent();
            const entryPath = this.#dependencies.resolveModule(RHWP_MODULE_SPECIFIER);
            const wasmPath = join(dirname(entryPath), RHWP_WASM_FILENAME);
            const wasm = exactUint8Array(await this.#dependencies.readBinary(wasmPath));
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
                        }
                        catch (error) {
                            if (typeof document === "object" &&
                                document !== null &&
                                "free" in document &&
                                typeof document.free === "function") {
                                try {
                                    document.free();
                                }
                                catch (cleanupError) {
                                    throw new Error(`${errorMessage(error)} Cleanup also failed: ${errorMessage(cleanupError)}`);
                                }
                            }
                            throw error;
                        }
                    },
                },
            };
        }
        catch (error) {
            return {
                available: false,
                reason: `@rhwp/core is unavailable: ${errorMessage(error)}`,
            };
        }
    }
}
const defaultRhwpBackendLoader = new RhwpBackendLoader();
export async function loadRhwpBackend() {
    return defaultRhwpBackendLoader.load();
}
export async function checkRhwpBackend(provider = defaultRhwpBackendLoader) {
    const loaded = await provider.load();
    return loaded.available
        ? { available: true, version: loaded.backend.version }
        : loaded;
}
export async function detectPreciseDocumentFormat(input) {
    const initial = detectFormat(input);
    if (initial === "hwpx") {
        return detectZipFormat(input);
    }
    if (initial === "hwp") {
        return detectOle2Format(input);
    }
    return initial;
}
export function inspectRhwpPreflightProtection(result) {
    if (!result.success) {
        return result.code === "ENCRYPTED" || result.code === "DRM_PROTECTED"
            ? { code: result.code, error: result.error }
            : undefined;
    }
    if (isDistributionSentinel(result.markdown)) {
        return {
            code: "DRM_PROTECTED",
            error: "Kordoc returned only a protected/distribution-document sentinel; rhwp fallback is refused.",
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
function validateModuleShape(value) {
    if (typeof value !== "object" || value === null) {
        throw new Error("@rhwp/core module API is not an object.");
    }
    const module = value;
    if (typeof module.default !== "function") {
        throw new Error("@rhwp/core module API is missing default init().");
    }
    if (typeof module.HwpDocument !== "function") {
        throw new Error("@rhwp/core module API is missing HwpDocument.");
    }
    if (typeof module.version !== "function") {
        throw new Error("@rhwp/core module API is missing version().");
    }
    return module;
}
function isDistributionSentinel(markdown) {
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
function validateDocumentShape(value) {
    if (typeof value !== "object" || value === null) {
        throw new Error("@rhwp/core HwpDocument returned an invalid object.");
    }
    const document = value;
    for (const method of [
        "pageCount",
        "renderPageSvg",
        "getSourceFormat",
        "free",
    ]) {
        if (typeof document[method] !== "function") {
            throw new Error(`@rhwp/core HwpDocument is missing ${method}().`);
        }
    }
    return document;
}
function installMeasureTextWidthIfAbsent() {
    const globalObject = globalThis;
    if (!("measureTextWidth" in globalObject)) {
        Object.defineProperty(globalObject, "measureTextWidth", {
            configurable: true,
            writable: true,
            value: heuristicMeasureTextWidth,
        });
        return;
    }
    if (typeof globalObject.measureTextWidth !== "function") {
        throw new Error("Existing globalThis.measureTextWidth is not callable and was preserved.");
    }
}
function heuristicMeasureTextWidth(font, text) {
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
function isCombiningCodePoint(codePoint) {
    return ((codePoint >= 0x0300 && codePoint <= 0x036f) ||
        (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
        (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
        (codePoint >= 0xfe20 && codePoint <= 0xfe2f));
}
function isWideCodePoint(codePoint) {
    return ((codePoint >= 0x1100 && codePoint <= 0x115f) ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1faff));
}
function exactUint8Array(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
