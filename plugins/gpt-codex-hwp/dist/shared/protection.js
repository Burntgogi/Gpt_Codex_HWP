import CFB from "cfb";
import { parsePolicyXml, xmlLocalName } from "./xml-policy.js";
import { loadBoundedHwpxZip, } from "./zip-preflight.js";
const HWP_FILE_HEADER_MINIMUM_BYTES = 40;
const HWP_FILE_HEADER_FLAGS_OFFSET = 36;
const HWP_FLAG_ENCRYPTED = 1 << 1;
const HWP_FLAG_DISTRIBUTION = 1 << 2;
const HWP_FLAG_DRM = 1 << 4;
const HWP_FLAG_DIGITAL_SIGNATURE = 1 << 7;
const HWP_FLAG_PUBLIC_KEY_ENCRYPTION = 1 << 8;
const HWP_FLAG_MODIFIED_CERTIFICATE = 1 << 9;
const HWP_FLAG_PREPARE_DISTRIBUTION = 1 << 10;
const MAX_PROTECTION_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_ZIP_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 1_000;
export async function inspectExactDocumentProtection(bytes, format) {
    if (format === "hwp") {
        return inspectExactHwpProtection(bytes, format);
    }
    if (format === "hwpx") {
        return await inspectExactHwpxProtection(bytes);
    }
    return undefined;
}
export function inspectExactHwpProtection(bytes, format) {
    if (format !== "hwp") {
        return undefined;
    }
    let container;
    try {
        container = CFB.parse(Uint8Array.from(bytes));
    }
    catch (error) {
        return {
            code: "INVALID_HWP_FILE_HEADER",
            error: `Could not parse the exact HWP OLE container: ${errorMessage(error)}`,
        };
    }
    const entry = CFB.find(container, "/FileHeader");
    if (entry?.content === undefined) {
        return {
            code: "INVALID_HWP_FILE_HEADER",
            error: "The exact HWP OLE container has no FileHeader stream.",
        };
    }
    const header = Uint8Array.from(entry.content);
    if (header.byteLength < HWP_FILE_HEADER_MINIMUM_BYTES) {
        return {
            code: "INVALID_HWP_FILE_HEADER",
            error: `The exact HWP FileHeader is too short (${header.byteLength} bytes).`,
        };
    }
    const flags = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(HWP_FILE_HEADER_FLAGS_OFFSET, true);
    if ((flags & HWP_FLAG_PUBLIC_KEY_ENCRYPTION) !== 0) {
        return {
            code: "ENCRYPTED",
            error: "The exact HWP FileHeader marks this document as public-key encrypted.",
        };
    }
    if ((flags & HWP_FLAG_ENCRYPTED) !== 0) {
        return {
            code: "ENCRYPTED",
            error: "The exact HWP FileHeader marks this document as encrypted.",
        };
    }
    if ((flags &
        (HWP_FLAG_DIGITAL_SIGNATURE | HWP_FLAG_MODIFIED_CERTIFICATE)) !==
        0) {
        return {
            code: "SIGNED_DOCUMENT",
            error: "The exact HWP FileHeader marks this document as digitally signed or certificate-modified.",
        };
    }
    if ((flags &
        (HWP_FLAG_DISTRIBUTION |
            HWP_FLAG_DRM |
            HWP_FLAG_PREPARE_DISTRIBUTION)) !==
        0) {
        return {
            code: "DRM_PROTECTED",
            error: "The exact HWP FileHeader marks this document as distribution-protected, DRM-protected, or prepared for distribution.",
        };
    }
    return undefined;
}
export async function inspectExactHwpxProtection(bytes, loadZip) {
    let zip;
    try {
        zip = await loadBoundedHwpxZip(bytes, loadZip);
    }
    catch (error) {
        return {
            code: "INVALID_HWPX_PROTECTION_METADATA",
            error: `Could not inspect the exact HWPX protection metadata: ${errorMessage(error)}`,
        };
    }
    const names = Object.keys(zip.files);
    const resourceIssue = inspectZipResourceProfile(zip, names);
    if (resourceIssue !== undefined) {
        return resourceIssue;
    }
    for (const name of names) {
        const lower = name.toLocaleLowerCase("en-US");
        if (lower.startsWith("_xmlsignatures/") ||
            /(^|\/)(?:digital)?signatures?(?:[./]|$)/u.test(lower) ||
            /\.(?:p7s|p7m|sig)$/u.test(lower)) {
            return {
                code: "SIGNED_DOCUMENT",
                error: "The exact HWPX package contains an electronic-signature entry.",
            };
        }
    }
    const manifestNames = names.filter((name) => name.toLocaleLowerCase("en-US") === "meta-inf/manifest.xml");
    if (manifestNames.length > 1) {
        return {
            code: "INVALID_HWPX_PROTECTION_METADATA",
            error: "The exact HWPX package contains multiple case-equivalent protection manifests.",
        };
    }
    const manifestName = manifestNames[0];
    if (manifestName === undefined) {
        return undefined;
    }
    const manifest = zip.file(manifestName);
    if (manifest === null) {
        return {
            code: "INVALID_HWPX_PROTECTION_METADATA",
            error: "The exact HWPX protection manifest entry could not be opened.",
        };
    }
    const declaredSize = manifest._data?.uncompressedSize;
    if (declaredSize !== undefined &&
        declaredSize > MAX_PROTECTION_MANIFEST_BYTES) {
        return {
            code: "INVALID_HWPX_PROTECTION_METADATA",
            error: "The HWPX protection manifest is too large to inspect safely.",
        };
    }
    let manifestBytes;
    try {
        manifestBytes = await manifest.async("uint8array");
    }
    catch (error) {
        return {
            code: "INVALID_HWPX_PROTECTION_METADATA",
            error: `Could not decompress the HWPX protection manifest: ${errorMessage(error)}`,
        };
    }
    if (manifestBytes.byteLength > MAX_PROTECTION_MANIFEST_BYTES) {
        return {
            code: "INVALID_HWPX_PROTECTION_METADATA",
            error: "The HWPX protection manifest is too large to inspect safely.",
        };
    }
    let document;
    try {
        document = parsePolicyXml(manifestBytes, "HWPX protection manifest");
    }
    catch (error) {
        return {
            code: "INVALID_HWPX_PROTECTION_METADATA",
            error: `Could not parse the HWPX protection manifest safely: ${errorMessage(error)}`,
        };
    }
    const elements = document.getElementsByTagName("*");
    for (let index = 0; index < elements.length; index += 1) {
        const element = elements.item(index);
        const local = xmlLocalName(element?.localName ?? element?.nodeName ?? "");
        if (local === "encryption-data" ||
            local === "encrypted-data" ||
            local === "public-key-encryption") {
            return {
                code: "ENCRYPTED",
                error: "The exact HWPX protection manifest marks this document as encrypted.",
            };
        }
        if (local === "drm" ||
            local === "distribution" ||
            local === "distribution-protection") {
            return {
                code: "DRM_PROTECTED",
                error: "The exact HWPX protection manifest marks this document as DRM or distribution protected.",
            };
        }
        if (local === "digital-signature" || local === "signature") {
            return {
                code: "SIGNED_DOCUMENT",
                error: "The exact HWPX protection manifest marks this document as signed.",
            };
        }
    }
    return undefined;
}
function inspectZipResourceProfile(zip, names) {
    if (names.length > MAX_ZIP_ENTRIES) {
        return {
            code: "INVALID_HWPX_PROTECTION_METADATA",
            error: `HWPX entry count exceeds the ${MAX_ZIP_ENTRIES}-entry safety limit.`,
        };
    }
    let total = 0;
    for (const name of names) {
        const entry = zip.files[name];
        if (entry === undefined || entry.dir)
            continue;
        const data = entry._data;
        const compressed = data?.compressedSize;
        const uncompressed = data?.uncompressedSize;
        if (compressed === undefined ||
            uncompressed === undefined ||
            !Number.isSafeInteger(compressed) ||
            !Number.isSafeInteger(uncompressed) ||
            compressed < 0 ||
            uncompressed < 0) {
            return {
                code: "INVALID_HWPX_PROTECTION_METADATA",
                error: `HWPX entry has unavailable or invalid size metadata: ${name}`,
            };
        }
        if (uncompressed > MAX_ZIP_ENTRY_BYTES) {
            return {
                code: "INVALID_HWPX_PROTECTION_METADATA",
                error: `HWPX entry exceeds the per-entry safety limit: ${name}`,
            };
        }
        total += uncompressed;
        if (total > MAX_ZIP_TOTAL_BYTES) {
            return {
                code: "INVALID_HWPX_PROTECTION_METADATA",
                error: "HWPX total uncompressed size exceeds the safety limit.",
            };
        }
        if (uncompressed > 0 &&
            (compressed === 0 || uncompressed / compressed > MAX_ZIP_COMPRESSION_RATIO)) {
            return {
                code: "INVALID_HWPX_PROTECTION_METADATA",
                error: `HWPX entry compression ratio exceeds the safety limit: ${name}`,
            };
        }
    }
    return undefined;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
