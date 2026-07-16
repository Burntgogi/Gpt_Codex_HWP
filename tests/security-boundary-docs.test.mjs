import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("security boundary documentation publishes a private disclosure route and supported versions", async () => {
  const security = await readFile(join(ROOT, "SECURITY.md"), "utf8");

  assert.match(security, /^## Supported Versions$/mu);
  assert.match(security, /GitHub private vulnerability reporting/iu);
  assert.match(security, /Security[^\n]+Report a vulnerability/iu);
  assert.match(security, /do not[^\n]+public issue/iu);
  assert.match(security, /do not[^\n]+(?:private )?HWP(?:\/HWPX)?[^\n]+(?:secret|personal data)/iu);
});

test("security boundary documentation treats document content as untrusted data", async () => {
  const boundary = await readFile(join(ROOT, "docs", "SECURITY-BOUNDARIES.md"), "utf8");

  assert.match(boundary, /untrusted document/iu);
  assert.match(boundary, /prompt injection/iu);
  for (const subject of ["embedded document instructions", "links", "macros", "OLE data", "extracted text"]) {
    assert.match(boundary, new RegExp(subject, "iu"));
  }
  assert.match(boundary, /never (?:treated as authority|executed|followed automatically)/iu);
});

test("security boundary documentation states format, platform, and isolation limits", async () => {
  const boundary = await readFile(join(ROOT, "docs", "SECURITY-BOUNDARIES.md"), "utf8");

  assert.match(boundary, /HWP is read-only/iu);
  assert.match(boundary, /writes? (?:new or modified documents )?only as HWPX/iu);
  assert.match(boundary, /Windows[^\n]+primary/iu);
  assert.match(boundary, /macOS[^\n]+(?:app|Codex Desktop)[^\n]+unverified/iu);
  assert.match(boundary, /worker[^\n]+child[^\n]+reliability boundary/iu);
  assert.match(boundary, /not a security sandbox/iu);
});

test("security boundary documentation is linked from both public READMEs", async () => {
  const [korean, english] = await Promise.all([
    readFile(join(ROOT, "README.md"), "utf8"),
    readFile(join(ROOT, "README.en.md"), "utf8"),
  ]);

  for (const readme of [korean, english]) {
    assert.match(readme, /\[SECURITY\.md\]\(SECURITY\.md\)/u);
    assert.match(readme, /\[.+\]\(docs\/SECURITY-BOUNDARIES\.md\)/u);
  }
});
