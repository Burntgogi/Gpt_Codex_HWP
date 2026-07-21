import { createWriteStream } from "node:fs";

const control = createWriteStream(null, { fd: 3, autoClose: true });
control.end("GPT_CODEX_HWP_SCAN_RUNNER WRONG 1\n");
setInterval(() => {}, 1_000);
