import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { runDocumentChildStartGate, runDocumentChildStartGateWindowsSync, } from "./document-process-registration.js";
if (process.platform === "win32") {
    runDocumentChildStartGateWindowsSync();
}
else {
    const childEntry = process.argv[2];
    if (childEntry === undefined || !isAbsolute(childEntry))
        process.exit(79);
    process.argv.splice(1, 1);
    await runDocumentChildStartGate();
    try {
        await import(pathToFileURL(childEntry).href);
    }
    catch {
        process.exit(79);
    }
}
