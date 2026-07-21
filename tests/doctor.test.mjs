import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runRootDoctor } from "../scripts/doctor.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("doctor contract delegates the root command to the committed runtime doctor", async () => {
  const calls = [];
  const exitCode = await runRootDoctor(["--json"], {
    loadDoctor: async (url) => {
      calls.push(url.href);
      return {
        doctorMain: async (args) => {
          calls.push([...args]);
          return 0;
        },
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    new URL("../plugins/gpt-codex-hwp/dist/doctor.js", import.meta.url).href,
    ["--json"],
  ]);
});

test("doctor contract is exposed by source and projected runtime packages", async () => {
  const rootPackage = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const sourcePackage = JSON.parse(
    await readFile(join(ROOT, "packages", "gpt-codex-hwp", "package.json"), "utf8"),
  );
  const runtimePackage = JSON.parse(
    await readFile(join(ROOT, "plugins", "gpt-codex-hwp", "package.json"), "utf8"),
  );

  assert.equal(rootPackage.scripts?.doctor, "node scripts/doctor.mjs");
  assert.equal(sourcePackage.scripts?.doctor, "node dist/doctor.js");
  assert.equal(runtimePackage.scripts?.doctor, "node dist/doctor.js");
});
