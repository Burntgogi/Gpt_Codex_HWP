export function toOwnedExactBytes(input, copyObserver) {
    if (copyObserver !== undefined && typeof copyObserver !== "function") {
        throw new TypeError("copyObserver must be a function when provided.");
    }
    const view = asByteView(input);
    const backing = view.buffer;
    const isExactOwnedArrayBuffer = backing instanceof ArrayBuffer &&
        view.byteOffset === 0 &&
        view.byteLength === backing.byteLength;
    if (isExactOwnedArrayBuffer) {
        const bytes = new Uint8Array(backing);
        copyObserver?.(0);
        return { bytes, transferable: backing, copiedBytes: 0 };
    }
    const bytes = new Uint8Array(view.byteLength);
    bytes.set(view);
    copyObserver?.(view.byteLength);
    return {
        bytes,
        transferable: bytes.buffer,
        copiedBytes: view.byteLength,
    };
}
function asByteView(input) {
    if (input instanceof ArrayBuffer) {
        return new Uint8Array(input);
    }
    if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError("input must be an ArrayBuffer or ArrayBuffer view.");
}
