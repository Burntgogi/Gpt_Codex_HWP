import { fstatSync, writeFileSync } from "node:fs";

for (const descriptor of [8, 9]) {
  try {
    fstatSync(descriptor);
    process.exit(91);
  } catch (error) {
    if (error?.code !== "EBADF") process.exit(92);
  }
}

const markerPath = process.argv[2];
if (markerPath === undefined) process.exit(93);
writeFileSync(markerPath, JSON.stringify(process.argv.slice(1)), { flag: "wx" });
setInterval(() => undefined, 1_000);
