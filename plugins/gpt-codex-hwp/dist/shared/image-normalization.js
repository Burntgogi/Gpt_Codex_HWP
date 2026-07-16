import { DOMParser } from "@xmldom/xmldom";
import sharp from "sharp";
export const MAX_NORMALIZED_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_SVG_BYTES = 1_000_000;
const MAX_IMAGE_DIMENSION = 10_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const PNG_MAGIC = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export class ImageNormalizationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ImageNormalizationError";
    }
}
export async function normalizeImageBytes(input) {
    const bytes = input instanceof ArrayBuffer
        ? new Uint8Array(input.slice(0))
        : Uint8Array.from(input);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_NORMALIZED_IMAGE_BYTES) {
        throw new ImageNormalizationError("INVALID_IMAGE", `Image input must be between 1 and ${MAX_NORMALIZED_IMAGE_BYTES} bytes.`);
    }
    const prefix = bytes.subarray(0, Math.min(bytes.byteLength, MAX_SVG_BYTES + 1));
    if ((prefix[0] === 0xff && prefix[1] === 0xfe) ||
        (prefix[0] === 0xfe && prefix[1] === 0xff) ||
        (prefix[0] === 0x00 && prefix[1] === 0x3c) ||
        (prefix[0] === 0x3c && prefix[1] === 0x00)) {
        throw new ImageNormalizationError("UNSAFE_SVG", "UTF-16 XML/SVG image input is not supported safely.");
    }
    let source = bytes;
    const decoded = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/u, "");
    if (decoded.trimStart().startsWith("<")) {
        source = Buffer.from(sanitizeImageSvg(decoded));
    }
    try {
        const image = sharp(source, {
            failOn: "error",
            limitInputPixels: MAX_IMAGE_PIXELS,
        });
        const metadata = await image.metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (width < 1 || height < 1 ||
            width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION ||
            width * height > MAX_IMAGE_PIXELS || (metadata.pages ?? 1) !== 1) {
            throw new Error("unsafe image dimensions or animation");
        }
        const rendered = await image
            .rotate()
            .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
            .toBuffer({ resolveWithObject: true });
        if (rendered.data.byteLength > MAX_NORMALIZED_IMAGE_BYTES) {
            throw new Error("normalized PNG exceeds the size limit");
        }
        assertPng(rendered.data);
        return {
            bytes: Uint8Array.from(rendered.data),
            width: rendered.info.width,
            height: rendered.info.height,
        };
    }
    catch (error) {
        if (error instanceof ImageNormalizationError)
            throw error;
        throw new ImageNormalizationError("INVALID_IMAGE", `Image could not be decoded safely: ${errorMessage(error)}`);
    }
}
function sanitizeImageSvg(svg) {
    if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) {
        throw new ImageNormalizationError("UNSAFE_SVG", "SVG input exceeds the 1 MB safety limit.");
    }
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/iu.test(svg)) {
        throw new ImageNormalizationError("UNSAFE_SVG", "Inline SVG contains unsafe XML declarations.");
    }
    const trimmed = svg.trim();
    const rootMatch = trimmed.match(/^(?:<\?xml\b[^>]*>\s*)?<svg\b([^>]*)>/iu);
    if (rootMatch === null || !/<\/svg\s*>\s*$/iu.test(trimmed)) {
        throw new ImageNormalizationError("UNSAFE_SVG", "Inline SVG must have one closed svg root.");
    }
    const namespace = (rootMatch[1] ?? "")
        .match(/\sxmlns\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (namespace !== undefined && namespace !== "http://www.w3.org/2000/svg") {
        throw new ImageNormalizationError("UNSAFE_SVG", "Inline SVG uses an unexpected namespace.");
    }
    const normalized = namespace === undefined
        ? trimmed.replace(/<svg\b/iu, '<svg xmlns="http://www.w3.org/2000/svg"')
        : trimmed;
    inspectSvg(normalized);
    return normalized;
}
const GLOBAL_ATTRIBUTES = new Set([
    "id", "class", "transform", "fill", "stroke", "stroke-width", "opacity",
    "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
    "stroke-dasharray", "stroke-dashoffset", "vector-effect",
]);
const ELEMENT_ATTRIBUTES = {
    svg: new Set(["xmlns", "width", "height", "viewBox", "preserveAspectRatio"]),
    g: new Set(),
    rect: new Set(["x", "y", "width", "height", "rx", "ry"]),
    circle: new Set(["cx", "cy", "r"]),
    ellipse: new Set(["cx", "cy", "rx", "ry"]),
    line: new Set(["x1", "y1", "x2", "y2"]),
    text: new Set(["x", "y", "dx", "dy", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline"]),
    tspan: new Set(["x", "y", "dx", "dy", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline"]),
    path: new Set(["d", "pathLength"]),
    polyline: new Set(["points", "pathLength"]),
    polygon: new Set(["points", "pathLength"]),
    title: new Set(),
    desc: new Set(),
};
function inspectSvg(svg) {
    if (/<\/?\s*[A-Za-z_][\w.-]*:/u.test(svg) ||
        /\s(?:xmlns:[A-Za-z_][\w.-]*|[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)\s*=/u.test(svg)) {
        throw new ImageNormalizationError("UNSAFE_SVG", "Prefixed SVG names are not allowed.");
    }
    let document;
    try {
        document = new DOMParser({
            onError: (_level, message) => {
                throw new Error(message);
            },
        }).parseFromString(svg, "image/svg+xml");
    }
    catch (error) {
        throw new ImageNormalizationError("UNSAFE_SVG", `Inline SVG is not well-formed XML: ${errorMessage(error)}`);
    }
    const root = document.documentElement;
    if (root === null || root.localName !== "svg" ||
        root.namespaceURI !== "http://www.w3.org/2000/svg") {
        throw new ImageNormalizationError("UNSAFE_SVG", "Inline SVG root is invalid.");
    }
    inspectElement(root);
}
function inspectElement(element) {
    const name = element.localName;
    if (name === null || element.namespaceURI !== "http://www.w3.org/2000/svg" ||
        element.prefix !== null || !Object.hasOwn(ELEMENT_ATTRIBUTES, name)) {
        throw new ImageNormalizationError("UNSAFE_SVG", `Inline SVG element is not allowed: ${element.nodeName}`);
    }
    const attributes = ELEMENT_ATTRIBUTES[name];
    for (let index = 0; index < element.attributes.length; index += 1) {
        const attribute = element.attributes.item(index);
        if (attribute === null)
            continue;
        const defaultNamespace = attribute.name === "xmlns";
        if ((!defaultNamespace && attribute.prefix !== null) ||
            (!GLOBAL_ATTRIBUTES.has(attribute.name) && !attributes.has(attribute.name))) {
            throw new ImageNormalizationError("UNSAFE_SVG", `Inline SVG attribute is not allowed: ${attribute.name}`);
        }
        if (defaultNamespace) {
            if (attribute.value !== "http://www.w3.org/2000/svg") {
                throw new ImageNormalizationError("UNSAFE_SVG", "Inline SVG uses an unexpected namespace.");
            }
        }
        else if (/url\s*\(|javascript\s*:|data\s*:|https?\s*:|file\s*:|\\\\|\/\//iu.test(attribute.value)) {
            throw new ImageNormalizationError("UNSAFE_SVG", `Inline SVG attribute contains an active value: ${attribute.name}`);
        }
    }
    for (let child = element.firstChild; child !== null; child = child.nextSibling) {
        if (child.nodeType === 1)
            inspectElement(child);
        else if (child.nodeType !== 3) {
            throw new ImageNormalizationError("UNSAFE_SVG", "Inline SVG contains a disallowed node.");
        }
    }
}
function assertPng(bytes) {
    if (bytes.byteLength < PNG_MAGIC.byteLength ||
        !PNG_MAGIC.every((byte, index) => bytes[index] === byte)) {
        throw new ImageNormalizationError("INVALID_IMAGE", "Image normalization did not return PNG bytes.");
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
