import JSZip from "jszip";
export const MAX_ZIP_ENTRIES = 10_000;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MINIMUM_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const ZIP16_SENTINEL = 0xffff;
const ZIP32_SENTINEL = 0xffffffff;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_FILE_HEADER_BYTES = 46;
export function assertClassicZipEntryBudget(bytes, maximumEntries = MAX_ZIP_ENTRIES) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
        throw new Error("ZIP entry budget must be a nonnegative safe integer.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findExactEocd(view);
    const disk = view.getUint16(eocd + 4, true);
    const centralDisk = view.getUint16(eocd + 6, true);
    const diskEntries = view.getUint16(eocd + 8, true);
    const totalEntries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
        throw new Error("Multi-disk ZIP archives are not supported.");
    }
    if (totalEntries === ZIP16_SENTINEL ||
        centralSize === ZIP32_SENTINEL ||
        centralOffset === ZIP32_SENTINEL) {
        throw new Error("ZIP64 archives are not supported.");
    }
    if (totalEntries > maximumEntries) {
        throw new Error(`ZIP entry count exceeds ${maximumEntries}.`);
    }
    if (centralOffset + centralSize > eocd) {
        throw new Error("ZIP central directory lies outside the archive.");
    }
    const observedEntries = countCentralDirectoryEntries(view, centralOffset, centralSize, maximumEntries);
    if (observedEntries !== diskEntries || observedEntries !== totalEntries) {
        throw new Error(`ZIP entry count does not match the central directory (${totalEntries} declared, ${observedEntries} observed).`);
    }
    return observedEntries;
}
export async function loadBoundedHwpxZip(bytes, loader = defaultZipLoader) {
    assertClassicZipEntryBudget(bytes);
    return await loader(Uint8Array.from(bytes));
}
function findExactEocd(view) {
    if (view.byteLength < EOCD_MINIMUM_BYTES) {
        throw new Error("ZIP end-of-central-directory record is missing.");
    }
    const minimumOffset = Math.max(0, view.byteLength - EOCD_MINIMUM_BYTES - MAX_ZIP_COMMENT_BYTES);
    for (let offset = view.byteLength - EOCD_MINIMUM_BYTES; offset >= minimumOffset; offset -= 1) {
        if (view.getUint32(offset, true) !== EOCD_SIGNATURE)
            continue;
        const commentLength = view.getUint16(offset + 20, true);
        if (offset + EOCD_MINIMUM_BYTES + commentLength === view.byteLength) {
            return offset;
        }
    }
    throw new Error("ZIP end-of-central-directory record is missing or malformed.");
}
function countCentralDirectoryEntries(view, centralOffset, centralSize, maximumEntries) {
    const end = centralOffset + centralSize;
    let cursor = centralOffset;
    let count = 0;
    while (cursor < end) {
        if (end - cursor < CENTRAL_FILE_HEADER_BYTES) {
            throw new Error("ZIP central directory has a truncated file header.");
        }
        if (view.getUint32(cursor, true) !== CENTRAL_FILE_HEADER_SIGNATURE) {
            throw new Error("ZIP central directory has an invalid file header signature.");
        }
        const filenameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const next = cursor +
            CENTRAL_FILE_HEADER_BYTES +
            filenameLength +
            extraLength +
            commentLength;
        if (next > end) {
            throw new Error("ZIP central directory file header exceeds its declared bounds.");
        }
        count += 1;
        if (count > maximumEntries) {
            throw new Error(`ZIP entry count exceeds ${maximumEntries}.`);
        }
        cursor = next;
    }
    return count;
}
async function defaultZipLoader(bytes) {
    return await JSZip.loadAsync(bytes);
}
