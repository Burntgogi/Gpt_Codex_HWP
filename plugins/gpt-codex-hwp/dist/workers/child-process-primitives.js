import { win32 } from "node:path";
export const MAX_DRAIN_ACCOUNTED_BYTES = 64 * 1024;
const childProcessCloseReceipts = new WeakMap();
export function observeChildProcessClose(child) {
    const existing = childProcessCloseReceipts.get(child);
    if (existing !== undefined)
        return existing;
    const receipt = new Promise((resolve) => {
        let childError = null;
        const onError = (error) => { childError ??= error; };
        child.on("error", onError);
        child.once("close", (code, signal) => {
            child.removeListener("error", onError);
            resolve(Object.freeze({ code, signal, error: childError }));
        });
    });
    childProcessCloseReceipts.set(child, receipt);
    return receipt;
}
export function waitWithTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        void promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, () => {
            clearTimeout(timer);
            resolve(undefined);
        });
    });
}
export function resolveWindowsSystemExecutable(name, platform = process.platform, systemRoot) {
    if (platform !== "win32")
        return name;
    if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
        throw new Error("absolute SystemRoot is required");
    }
    if (name.toLowerCase() === "powershell.exe") {
        return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", name);
    }
    return win32.join(systemRoot, "System32", name);
}
