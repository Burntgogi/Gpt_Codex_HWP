import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RUNTIME_DOCTOR = new URL("../plugins/gpt-codex-hwp/dist/doctor.js", import.meta.url);

export async function runRootDoctor(args = process.argv.slice(2), dependencies = {}) {
  const loadDoctor = dependencies.loadDoctor ?? ((url) => import(url.href));
  const doctor = await loadDoctor(RUNTIME_DOCTOR);
  if (typeof doctor.doctorMain !== "function") {
    throw new Error("DOCTOR_RUNTIME_INVALID: regenerate the verified runtime projection.");
  }
  return await doctor.doctorMain(args);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runRootDoctor().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write("DOCTOR_RUNTIME_INVALID: regenerate the verified runtime projection.\n");
    process.exitCode = 1;
  });
}
