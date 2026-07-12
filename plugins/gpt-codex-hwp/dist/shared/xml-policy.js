import { DOMParser } from "@xmldom/xmldom";
const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = Uint8Array.from([0xff, 0xfe]);
const UTF16_BE_BOM = Uint8Array.from([0xfe, 0xff]);
export function parsePolicyXml(bytes, label) {
    const text = decodeXml(bytes, label);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text)) {
        throw new Error(`${label} contains a forbidden DTD or entity declaration.`);
    }
    const errors = [];
    let document;
    try {
        document = new DOMParser({
            onError: (level, message) => {
                if (level === "error" || level === "fatalError")
                    errors.push(message);
            },
        }).parseFromString(text, "application/xml");
    }
    catch (error) {
        throw new Error(`${label} is malformed XML: ${errorMessage(error)}`);
    }
    if (errors.length > 0 || document.documentElement === null) {
        throw new Error(`${label} is malformed XML.`);
    }
    return document;
}
export function xmlLocalName(name) {
    return name.replace(/^.*:/u, "").toLocaleLowerCase("en-US");
}
function decodeXml(bytes, label) {
    if (bytes.byteLength === 0) {
        throw new Error(`${label} is empty.`);
    }
    if (isUtf32(bytes)) {
        throw new Error(`${label} uses unsupported UTF-32 encoding.`);
    }
    let encoding;
    let offset = 0;
    if (startsWith(bytes, UTF8_BOM)) {
        encoding = "utf-8";
        offset = UTF8_BOM.byteLength;
    }
    else if (startsWith(bytes, UTF16_LE_BOM)) {
        encoding = "utf-16le";
        offset = UTF16_LE_BOM.byteLength;
    }
    else if (startsWith(bytes, UTF16_BE_BOM)) {
        encoding = "utf-16be";
        offset = UTF16_BE_BOM.byteLength;
    }
    else if (looksLikeUtf16Le(bytes)) {
        encoding = "utf-16le";
    }
    else if (looksLikeUtf16Be(bytes)) {
        encoding = "utf-16be";
    }
    else {
        encoding = "utf-8";
    }
    let text;
    try {
        text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
    }
    catch (error) {
        throw new Error(`${label} has invalid ${encoding} text: ${errorMessage(error)}`);
    }
    if (text.includes("\0") || !text.trimStart().startsWith("<")) {
        throw new Error(`${label} uses an unsupported or invalid XML encoding.`);
    }
    return text;
}
function isUtf32(bytes) {
    if (bytes.byteLength < 4)
        return false;
    return ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) ||
        (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) ||
        (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x3c) ||
        (bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00));
}
function looksLikeUtf16Le(bytes) {
    return bytes.byteLength >= 4 && bytes[0] === 0x3c && bytes[1] === 0x00;
}
function looksLikeUtf16Be(bytes) {
    return bytes.byteLength >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3c;
}
function startsWith(bytes, prefix) {
    return prefix.every((value, index) => bytes[index] === value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
