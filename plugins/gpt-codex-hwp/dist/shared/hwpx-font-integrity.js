import { DOMParser, XMLSerializer, } from "@xmldom/xmldom";
import { loadBoundedHwpxZip, } from "./zip-preflight.js";
export class HwpxFontReferenceError extends Error {
    issues;
    code = "HWPX_FONT_REFERENCE_ERROR";
    constructor(message, issues) {
        super(message);
        this.issues = issues;
        this.name = "HwpxFontReferenceError";
    }
}
const HEADER_PATH = "Contents/header.xml";
const HEADER_NAMESPACE = "http://www.hancom.co.kr/hwpml/2011/head";
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const SCRIPT_LANG = [
    ["hangul", "HANGUL"],
    ["latin", "LATIN"],
    ["hanja", "HANJA"],
    ["japanese", "JAPANESE"],
    ["other", "OTHER"],
    ["symbol", "SYMBOL"],
    ["user", "USER"],
];
export async function inspectHwpxFontReferences(input, loadZip) {
    const { document } = await loadArchiveAndHeader(input, loadZip);
    return inspectDocument(document);
}
export async function normalizeGeneratedFontReferences(input, loadZip) {
    try {
        const { bytes, zip, document } = await loadArchiveAndHeader(input, loadZip);
        const inspection = inspectDocument(document);
        const nonRepairable = inspection.issues.filter((issue) => !isRepairableFontReferenceIssue(issue));
        if (nonRepairable.length > 0) {
            throw new HwpxFontReferenceError("Generated HWPX has a font table that cannot be normalized safely.", nonRepairable);
        }
        const invalidReferences = inspection.issues.filter((issue) => isRepairableFontReferenceIssue(issue) &&
            issue.char_pr_id !== undefined &&
            issue.script !== undefined &&
            issue.font_id !== undefined);
        if (invalidReferences.length === 0) {
            return {
                bytes,
                changed: false,
                changed_reference_count: 0,
                changes: [],
            };
        }
        const charProperties = headerCharacterProperties(document);
        const changes = [];
        for (const issue of invalidReferences) {
            const charPr = charProperties.find((candidate) => candidate.getAttribute("id") === issue.char_pr_id);
            const fontRef = charPr === undefined
                ? undefined
                : directHeaderChildren(charPr, "fontRef")[0];
            if (fontRef === undefined ||
                fontRef.getAttribute(issue.script) !== issue.font_id) {
                throw new HwpxFontReferenceError("Generated HWPX changed while font references were being normalized.", [issue]);
            }
            fontRef.setAttribute(issue.script, "0");
            changes.push({
                char_pr_id: issue.char_pr_id,
                script: issue.script,
                from: issue.font_id,
                to: "0",
            });
        }
        zip.file(HEADER_PATH, new XMLSerializer().serializeToString(document));
        const mimetype = zip.file("mimetype");
        if (mimetype !== null) {
            zip.file("mimetype", await mimetype.async("string"), {
                compression: "STORE",
            });
        }
        const normalized = await zip.generateAsync({
            type: "uint8array",
            compression: "DEFLATE",
        });
        const remaining = await inspectHwpxFontReferences(normalized, loadZip);
        if (remaining.issues.length > 0) {
            throw new HwpxFontReferenceError("Generated HWPX still has invalid font references after normalization.", remaining.issues);
        }
        return {
            bytes: normalized,
            changed: true,
            changed_reference_count: changes.length,
            changes,
        };
    }
    catch (error) {
        if (error instanceof HwpxFontReferenceError) {
            throw error;
        }
        throw new HwpxFontReferenceError(errorMessage(error), []);
    }
}
async function loadArchiveAndHeader(input, loadZip) {
    const bytes = input instanceof ArrayBuffer
        ? new Uint8Array(input.slice(0))
        : Uint8Array.from(input);
    const zip = await loadBoundedHwpxZip(bytes, loadZip);
    const entry = zip.file(HEADER_PATH);
    if (entry === null) {
        throw new Error(`${HEADER_PATH} is missing from the HWPX package.`);
    }
    const errors = [];
    const document = new DOMParser({
        onError: (level, message) => {
            if (level !== "warning") {
                errors.push(message);
            }
        },
    }).parseFromString(await entry.async("string"), "application/xml");
    if (errors.length > 0) {
        throw new Error(`Could not parse ${HEADER_PATH}: ${errors.join("; ")}`);
    }
    return { bytes, zip, document };
}
function inspectDocument(document) {
    const issues = [];
    const root = document.documentElement;
    if (root === null ||
        root.localName !== "head" ||
        root.namespaceURI !== HEADER_NAMESPACE) {
        issues.push({
            code: "HWPX_HEADER_NAMESPACE_INVALID",
            path: HEADER_PATH,
            message: `The header root must be head in ${HEADER_NAMESPACE}.`,
        });
        return { issues };
    }
    const refList = directHeaderChildren(root, "refList")[0];
    const fontfaceContainers = refList === undefined
        ? []
        : directHeaderChildren(refList, "fontfaces");
    if (fontfaceContainers.length === 0) {
        issues.push({
            code: "FONTFACE_CONTAINER_MISSING",
            path: HEADER_PATH,
            message: "The head/refList/fontfaces container is missing.",
        });
        return { issues };
    }
    if (fontfaceContainers.length !== 1) {
        issues.push({
            code: "FONTFACE_COUNT_MISMATCH",
            path: HEADER_PATH,
            message: `The header contains ${fontfaceContainers.length} direct fontfaces containers; expected 1.`,
        });
    }
    const fontfacesContainer = fontfaceContainers[0];
    const fontfaces = directHeaderChildren(fontfacesContainer, "fontface");
    const declaredGroupCount = fontfacesContainer.getAttribute("itemCnt");
    if (declaredGroupCount !== String(fontfaces.length)) {
        issues.push({
            code: "FONTFACE_COUNT_MISMATCH",
            path: HEADER_PATH,
            message: `The fontfaces container declares ${declaredGroupCount ?? "no"} groups but contains ${fontfaces.length}.`,
        });
    }
    const idsByLanguage = new Map();
    for (const [, language] of SCRIPT_LANG) {
        const matchingFontfaces = fontfaces.filter((candidate) => candidate.getAttribute("lang") === language);
        if (matchingFontfaces.length === 0) {
            issues.push({
                code: "FONTFACE_MISSING",
                path: HEADER_PATH,
                message: `The ${language} fontface group is missing.`,
            });
            continue;
        }
        if (matchingFontfaces.length > 1) {
            issues.push({
                code: "FONTFACE_DUPLICATE",
                path: HEADER_PATH,
                message: `The ${language} fontface group appears ${matchingFontfaces.length} times.`,
            });
        }
        const fontface = matchingFontfaces[0];
        const fonts = directHeaderChildren(fontface, "font");
        const declaredCount = fontface.getAttribute("fontCnt");
        if (declaredCount !== String(fonts.length)) {
            issues.push({
                code: "FONT_COUNT_MISMATCH",
                path: HEADER_PATH,
                message: `The ${language} fontface declares ${declaredCount ?? "no"} fonts but contains ${fonts.length}.`,
            });
        }
        const ids = new Set();
        for (const font of fonts) {
            const id = font.getAttribute("id") ?? "";
            if (!NON_NEGATIVE_INTEGER.test(id)) {
                issues.push({
                    code: "FONT_ID_INVALID",
                    path: HEADER_PATH,
                    message: `The ${language} fontface contains invalid font ID ${id || "(empty)"}.`,
                    font_id: id,
                });
            }
            else if (ids.has(id)) {
                issues.push({
                    code: "FONT_ID_DUPLICATE",
                    path: HEADER_PATH,
                    message: `The ${language} fontface contains duplicate font ID ${id}.`,
                    font_id: id,
                });
            }
            else {
                ids.add(id);
            }
            const face = font.getAttribute("face");
            if (face === null || face.trim().length === 0) {
                issues.push({
                    code: "FONT_FACE_NAME_MISSING",
                    path: HEADER_PATH,
                    message: `The ${language} font ${id || "(empty)"} has no face name.`,
                    font_id: id,
                });
            }
        }
        if (!ids.has("0")) {
            issues.push({
                code: "FONT_ID_ZERO_MISSING",
                path: HEADER_PATH,
                message: `The ${language} fontface does not contain fallback font ID 0.`,
            });
        }
        idsByLanguage.set(language, ids);
    }
    const seenCharPrIds = new Set();
    for (const charPr of headerCharacterProperties(document)) {
        const charPrId = charPr.getAttribute("id") ?? "";
        if (!NON_NEGATIVE_INTEGER.test(charPrId)) {
            issues.push({
                code: "CHAR_PR_ID_INVALID",
                path: HEADER_PATH,
                message: `The charPr ID ${charPrId || "(empty)"} is not a non-negative integer.`,
                char_pr_id: charPrId,
            });
        }
        else if (seenCharPrIds.has(charPrId)) {
            issues.push({
                code: "CHAR_PR_ID_DUPLICATE",
                path: HEADER_PATH,
                message: `The charPr ID ${charPrId} is duplicated.`,
                char_pr_id: charPrId,
            });
        }
        else {
            seenCharPrIds.add(charPrId);
        }
        const fontRefs = directHeaderChildren(charPr, "fontRef");
        if (fontRefs.length === 0) {
            issues.push({
                code: "FONT_REF_MISSING",
                path: HEADER_PATH,
                message: `charPr ${charPrId || "(empty)"} has no direct fontRef.`,
                char_pr_id: charPrId,
            });
            continue;
        }
        if (fontRefs.length > 1) {
            issues.push({
                code: "FONT_REF_DUPLICATE",
                path: HEADER_PATH,
                message: `charPr ${charPrId || "(empty)"} has ${fontRefs.length} direct fontRef elements.`,
                char_pr_id: charPrId,
            });
        }
        const fontRef = fontRefs[0];
        for (const [script, language] of SCRIPT_LANG) {
            const fontId = fontRef.getAttribute(script);
            if (fontId === null) {
                issues.push({
                    code: "FONT_REF_ATTRIBUTE_MISSING",
                    path: HEADER_PATH,
                    message: `charPr ${charPrId || "(empty)"} has no ${script} fontRef attribute.`,
                    char_pr_id: charPrId,
                    script,
                });
                continue;
            }
            const validIds = idsByLanguage.get(language);
            if (!NON_NEGATIVE_INTEGER.test(fontId) || (validIds !== undefined && !validIds.has(fontId))) {
                issues.push({
                    code: "FONT_REF_INVALID",
                    path: HEADER_PATH,
                    message: `charPr ${charPrId} references missing ${language} font ID ${fontId}.`,
                    char_pr_id: charPrId,
                    script,
                    font_id: fontId,
                });
            }
        }
    }
    return { issues };
}
function headerCharacterProperties(document) {
    const root = document.documentElement;
    if (root === null ||
        root.localName !== "head" ||
        root.namespaceURI !== HEADER_NAMESPACE) {
        return [];
    }
    const refList = directHeaderChildren(root, "refList")[0];
    if (refList === undefined)
        return [];
    const container = directHeaderChildren(refList, "charProperties")[0];
    return container === undefined ? [] : directHeaderChildren(container, "charPr");
}
function directHeaderChildren(parent, localName) {
    const result = [];
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
        if (child.nodeType === 1 &&
            child.localName === localName &&
            child.namespaceURI === HEADER_NAMESPACE) {
            result.push(child);
        }
    }
    return result;
}
function isRepairableFontReferenceIssue(issue) {
    return (issue.code === "FONT_REF_INVALID" &&
        issue.char_pr_id !== undefined &&
        NON_NEGATIVE_INTEGER.test(issue.char_pr_id) &&
        issue.script !== undefined &&
        issue.font_id !== undefined &&
        NON_NEGATIVE_INTEGER.test(issue.font_id));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
