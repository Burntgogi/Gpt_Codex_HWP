import { DOMParser } from "@xmldom/xmldom";

export type PolicyXmlDocument = ReturnType<DOMParser["parseFromString"]>;

const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = Uint8Array.from([0xff, 0xfe]);
const UTF16_BE_BOM = Uint8Array.from([0xfe, 0xff]);

export function parsePolicyXml(bytes: Uint8Array, label: string): PolicyXmlDocument {
  const text = decodeXml(bytes, label);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text)) {
    throw new Error(`${label} contains a forbidden DTD or entity declaration.`);
  }

  const errors: string[] = [];
  let document: PolicyXmlDocument;
  try {
    document = new DOMParser({
      onError: (level, message) => {
        if (level === "error" || level === "fatalError") errors.push(message);
      },
    }).parseFromString(text, "application/xml");
  } catch (error: unknown) {
    throw new Error(`${label} is malformed XML: ${errorMessage(error)}`);
  }
  if (errors.length > 0 || document.documentElement === null) {
    throw new Error(`${label} is malformed XML.`);
  }
  return document;
}

export function xmlLocalName(name: string): string {
  return name.replace(/^.*:/u, "").toLocaleLowerCase("en-US");
}

function decodeXml(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength === 0) {
    throw new Error(`${label} is empty.`);
  }
  if (isUtf32(bytes)) {
    throw new Error(`${label} uses unsupported UTF-32 encoding.`);
  }

  let encoding: "utf-8" | "utf-16le" | "utf-16be";
  let offset = 0;
  if (startsWith(bytes, UTF8_BOM)) {
    encoding = "utf-8";
    offset = UTF8_BOM.byteLength;
  } else if (startsWith(bytes, UTF16_LE_BOM)) {
    encoding = "utf-16le";
    offset = UTF16_LE_BOM.byteLength;
  } else if (startsWith(bytes, UTF16_BE_BOM)) {
    encoding = "utf-16be";
    offset = UTF16_BE_BOM.byteLength;
  } else if (looksLikeUtf16Le(bytes)) {
    encoding = "utf-16le";
  } else if (looksLikeUtf16Be(bytes)) {
    encoding = "utf-16be";
  } else {
    encoding = "utf-8";
  }

  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch (error: unknown) {
    throw new Error(`${label} has invalid ${encoding} text: ${errorMessage(error)}`);
  }
  if (text.includes("\0") || !text.trimStart().startsWith("<")) {
    throw new Error(`${label} uses an unsupported or invalid XML encoding.`);
  }
  return text;
}

function isUtf32(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return (
    (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) ||
    (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x3c) ||
    (bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00)
  );
}

function looksLikeUtf16Le(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x3c && bytes[1] === 0x00;
}

function looksLikeUtf16Be(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3c;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
