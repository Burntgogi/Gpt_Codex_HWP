import { basename, extname } from "node:path";
const HWPX_EXTENSION = ".hwpx";
export class HwpxOutputRequiredError extends Error {
    code = "HWPX_OUTPUT_REQUIRED";
    constructor() {
        super("Document output must use a nonempty .hwpx path.");
        this.name = "HwpxOutputRequiredError";
    }
}
export function assertHwpxOutputPath(path) {
    if (typeof path !== "string" || path.trim().length === 0) {
        throw new HwpxOutputRequiredError();
    }
    const filename = basename(path);
    if (/[\\/]$/u.test(path) ||
        filename.length <= HWPX_EXTENSION.length ||
        extname(filename).toLocaleLowerCase("en-US") !== HWPX_EXTENSION) {
        throw new HwpxOutputRequiredError();
    }
}
