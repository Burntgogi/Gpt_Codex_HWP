const IMAGE_HELPER_PASSTHROUGH_CODES = new Set([
    "ANCHOR_NOT_FOUND",
    "AMBIGUOUS_ANCHOR",
    "INVALID_IMAGE",
    "ENCRYPTED",
    "DRM_PROTECTED",
    "SIGNED_DOCUMENT",
]);
/**
 * Maps the helper's single-line JSON failure ({"ok":false,"code":...}) to a
 * public engine code. Only the code is used; helper messages never leave the
 * child. Malformed output stays a protocol error.
 */
export function imageHelperFailureCode(stderr) {
    let value;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stderr).trim());
    }
    catch {
        return "ENGINE_PROTOCOL_ERROR";
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "ENGINE_PROTOCOL_ERROR";
    }
    const { ok, code } = value;
    if (ok !== false || typeof code !== "string")
        return "ENGINE_PROTOCOL_ERROR";
    if (IMAGE_HELPER_PASSTHROUGH_CODES.has(code))
        return code;
    if (code === "NOT_HWPX" || code === "UNSAFE_ZIP")
        return "SOURCE_HWPX_INVALID";
    return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? "IMAGE_INSERTION_FAILED" : "ENGINE_PROTOCOL_ERROR";
}
