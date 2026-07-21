import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,80}-$/u;

export async function createCanonicalTemporaryDirectory({
  parent = tmpdir(),
  prefix,
} = {}) {
  if (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix)) {
    throw canonicalTempError("CANONICAL_TEMP_PREFIX_INVALID");
  }

  let canonicalParent;
  let parentIdentity;
  try {
    canonicalParent = await realpath(parent);
    const before = await lstat(canonicalParent);
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error();
    const verifiedCanonicalParent = await realpath(canonicalParent);
    const after = await lstat(canonicalParent);
    if (
      !samePath(verifiedCanonicalParent, canonicalParent)
      || after.isSymbolicLink()
      || !after.isDirectory()
      || !sameIdentity(before, after)
    ) throw new Error();
    parentIdentity = identityOf(after);
  } catch {
    throw canonicalTempError("CANONICAL_TEMP_PARENT_INVALID");
  }

  let created;
  try {
    created = await mkdtemp(join(canonicalParent, prefix));
  } catch {
    throw canonicalTempError("CANONICAL_TEMP_CHILD_INVALID");
  }

  try {
    const childBefore = await lstat(created);
    const canonicalChild = await realpath(created);
    const canonicalChildParent = await realpath(dirname(canonicalChild));
    const childAfter = await lstat(canonicalChild);
    const parentAfter = await lstat(canonicalParent);
    if (
      childBefore.isSymbolicLink()
      || !childBefore.isDirectory()
      || childAfter.isSymbolicLink()
      || !childAfter.isDirectory()
      || !sameIdentity(childBefore, childAfter)
      || !samePath(created, canonicalChild)
      || !samePath(canonicalChildParent, canonicalParent)
      || parentAfter.isSymbolicLink()
      || !parentAfter.isDirectory()
      || !sameIdentity(parentAfter, parentIdentity)
      || !samePath(await realpath(canonicalParent), canonicalParent)
    ) throw new Error();
    return canonicalChild;
  } catch {
    throw canonicalTempError("CANONICAL_TEMP_CHILD_INVALID");
  }
}

function identityOf(info) {
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function canonicalTempError(code) {
  return Object.assign(new Error(code), { code });
}
