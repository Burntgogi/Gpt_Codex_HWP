import { register } from "node:module";
import { workerData } from "node:worker_threads";

register(new URL("./rhwp-hook-loader.mjs", import.meta.url), import.meta.url, {
  data: { delayMs: workerData?.rhwpHookDelayMs ?? 0 },
});
