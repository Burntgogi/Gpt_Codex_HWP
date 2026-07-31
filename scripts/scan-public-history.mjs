import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  classifyPublicContent,
  classifyPublicLabel,
  formatPublicFindings,
  isApprovedOwnerIdentity,
  isPrivateRepositoryPath,
  publicFinding,
  publicScanFailure,
  runBoundedProcess,
  startBoundedProcess,
} from "./public-content-policy.mjs";

const MAX_COMMAND_BYTES = 32 * 1024 * 1024;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_BYTES = 512 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_PATH_ASSOCIATIONS = 500_000;
const NEUTRAL_EMAIL = "codex@local";
const NEUTRAL_NAME = "Codex";

const FROZEN_RELEASE_TAGS = Object.freeze({
  "v0.1.0": {
    tagObject: "ef0912777438499192c570f6e4f8e638f723f713",
    commit: "8ab57d6b289727a6ea4b53f21193223e314c5f11",
  },
  "v0.1.1": {
    tagObject: "c40236454d48ab5010d5df39761220fb7bf0759b",
    commit: "356eb97d4627769a9593529b0c08adf481ca0eb8",
  },
  "v0.1.2": {
    tagObject: "95d563c8edeeb1db97129c364cc353938faf1eb2",
    commit: "4fe07da12d12fdba928f98fb9167a9ce70c98151",
  },
  "v0.1.3": {
    tagObject: "35f5792981d8306ab9554d107b6fbe33576df99c",
    commit: "4132b280cb206f7da426c1c479e950ac208d9639",
  },
  "v0.1.4": {
    tagObject: "e400d45c1f9f746d177f7ffcc2a5737ae699beee",
    commit: "27e44224241628e336181727c85b1598dfe74fd2",
  },
});

export const IMMUTABLE_NEUTRAL_OBJECT_IDS = Object.freeze([
  "8ab57d6b289727a6ea4b53f21193223e314c5f11",
  "4f1d0c12f10cce7c1f7e8aca38732f6e2c60c9ed",
  "b4ff80cbeda77d55a4c048eb4dc21e66f8fe556b",
  "356eb97d4627769a9593529b0c08adf481ca0eb8",
  "4fe07da12d12fdba928f98fb9167a9ce70c98151",
  "4132b280cb206f7da426c1c479e950ac208d9639",
  "ef0912777438499192c570f6e4f8e638f723f713",
  "c40236454d48ab5010d5df39761220fb7bf0759b",
  "95d563c8edeeb1db97129c364cc353938faf1eb2",
  "35f5792981d8306ab9554d107b6fbe33576df99c",
]);

export async function scanPublicHistory(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw historyFailure();
  }
  const root = resolve(options.root ?? process.cwd());
  const runGit = options.runGit ?? defaultRunGit;
  if (typeof runGit !== "function") throw historyFailure();
  const neutralObjectAllowlist = validateNeutralAllowlist(
    options.neutralObjectAllowlist ?? new Set(IMMUTABLE_NEUTRAL_OBJECT_IDS),
  );
  const frozenReleaseTags = validateFrozenReleaseTags(
    options.frozenReleaseTags === undefined ? FROZEN_RELEASE_TAGS : options.frozenReleaseTags,
  );

  await rejectGitGrafts(runGit, root);

  const shallow = await invokeGit(runGit, root, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.code !== 0 || shallow.stderr.length !== 0
    || shallow.stdout.toString("utf8") !== "false\n") throw historyFailure();

  const refsResult = await invokeGit(runGit, root, [
    "for-each-ref",
    "--format=%(objectname)%00%(objecttype)%00%(refname)%00",
  ]);
  if (refsResult.code !== 0 || refsResult.stderr.length !== 0) throw historyFailure();
  const refs = parseRefs(refsResult.stdout);
  if (refs.length === 0) throw historyFailure();
  validateFrozenTagRefs(frozenReleaseTags, refs);

  const objectsResult = await invokeGit(runGit, root, ["rev-list", "--objects", "--all", "-z"]);
  if (objectsResult.code !== 0 || objectsResult.stderr.length !== 0) throw historyFailure();
  const { objectIds } = parseObjectRecords(objectsResult.stdout);
  if (objectIds.length === 0 || objectIds.length > MAX_OBJECTS) throw historyFailure();

  const findings = [];
  for (const ref of refs) {
    if (ref.name.startsWith("refs/replace/")) {
      findings.push(historyFinding(
        "Git semantic override",
        `ref:${ref.objectId}`,
        ref.objectId,
        "ref",
      ));
    }
    const refFindings = classifyPublicContent(Buffer.from(ref.name, "utf8"), {
      label: `ref:${ref.objectId}`,
    });
    const refLabelFindings = classifyPublicLabel(ref.name);
    if (refFindings.length > 0 || refLabelFindings.length > 0) {
      findings.push(historyFinding("sensitive ref name", `ref:${ref.objectId}`, ref.objectId, "ref"));
    }
  }

  let totalBytes = 0;
  const blobs = new Map();
  const trees = new Map();
  const rootTrees = new Set();
  const objectTypes = new Map();
  const tagTargets = new Map();
  await readObjectsBatch(root, objectIds, async ({ objectId, type, bytes }) => {
    totalBytes += bytes.length;
    if (totalBytes > MAX_HISTORY_BYTES) throw historyFailure();
    objectTypes.set(objectId, type);
    if (type === "blob") {
      blobs.set(objectId, bytes);
    } else if (type === "commit" || type === "tag") {
      const metadata = scanGitMetadata({
        objectId,
        type,
        bytes,
        neutralObjectAllowlist,
      });
      findings.push(...metadata.findings);
      if (metadata.rootTree !== undefined) rootTrees.add(metadata.rootTree);
      if (metadata.tagTarget !== undefined) tagTargets.set(objectId, metadata.tagTarget);
    } else if (type === "tree") {
      const tree = scanTreeObject(objectId, bytes);
      findings.push(...tree.findings);
      trees.set(objectId, tree.entries);
    } else {
      throw historyFailure();
    }
  });

  validateFrozenTagTargets(frozenReleaseTags, tagTargets, objectTypes);
  addTaggedRootTrees(tagTargets, objectTypes, rootTrees);
  const associations = associateRepositoryPaths(rootTrees, trees, blobs);
  findings.push(...associations.findings);
  const { blobPaths } = associations;
  for (const [objectId, bytes] of blobs) {
    const paths = blobPaths.get(objectId) ?? new Set([`blob:${objectId}`]);
    for (const label of paths) {
      if (isPrivateRepositoryPath(label)) {
        findings.push(historyFinding(
          "private repository path",
          label,
          objectId,
          "blob",
        ));
      }
      const blobFindings = classifyPublicContent(bytes, { label });
      findings.push(...blobFindings.map((item) => Object.freeze({
        ...item,
        objectId,
        objectType: "blob",
      })));
    }
  }

  return Object.freeze({
    status: findings.length === 0 ? "passed" : "failed",
    objects: objectIds.length,
    refs: refs.length,
    bytes: totalBytes,
    findings: Object.freeze(findings),
  });
}

function scanGitMetadata({ objectId, type, bytes, neutralObjectAllowlist }) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw historyFailure(); }
  const boundary = text.indexOf("\n\n");
  if (boundary < 0) throw historyFailure();
  const headers = text.slice(0, boundary).split("\n");
  const message = text.slice(boundary + 2);
  const identityHeaders = type === "commit" ? new Set(["author", "committer"]) : new Set(["tagger"]);
  const observed = new Set();
  const findings = [];
  let rootTree;
  let tagObject;
  let tagType;
  for (const header of headers) {
    const separator = header.indexOf(" ");
    if (separator === 0) {
      const continuation = header.slice(1);
      const continuationFindings = classifyPublicContent(Buffer.from(continuation, "utf8"), {
        label: `${type}:${objectId}`,
      });
      const continuationLabelFindings = continuation.length === 0
        ? []
        : classifyPublicLabel(continuation);
      if (continuationFindings.length > 0 || continuationLabelFindings.length > 0) {
        findings.push(historyFinding("sensitive Git metadata", `${type}:${objectId}`, objectId, type));
      }
      continue;
    }
    if (separator < 1) throw historyFailure();
    const name = header.slice(0, separator);
    const value = header.slice(separator + 1);
    if (identityHeaders.has(name)) {
      if (observed.has(name)) throw historyFailure();
      observed.add(name);
      const identity = parseIdentity(value);
      if (identity === undefined || !identityAllowed(identity, objectId, neutralObjectAllowlist)) {
        findings.push(historyFinding("personal identity", `${type}:${objectId}`, objectId, type));
      }
    }
    if (type === "commit" && name === "tree") {
      if (rootTree !== undefined || !/^[a-f0-9]{40}$/u.test(value)) throw historyFailure();
      rootTree = value;
    }
    if (type === "tag" && name === "object") {
      if (tagObject !== undefined || !/^[a-f0-9]{40}$/u.test(value)) throw historyFailure();
      tagObject = value;
    }
    if (type === "tag" && name === "type") {
      if (tagType !== undefined || !["blob", "commit", "tag", "tree"].includes(value)) {
        throw historyFailure();
      }
      tagType = value;
    }
    const headerFindings = classifyPublicContent(Buffer.from(value, "utf8"), {
      label: `${type}:${objectId}`,
    });
    const headerLabelFindings = classifyPublicLabel(value);
    if (headerFindings.length > 0 || headerLabelFindings.length > 0) {
      findings.push(historyFinding("sensitive Git metadata", `${type}:${objectId}`, objectId, type));
    }
  }
  if (
    observed.size !== identityHeaders.size
    || (type === "commit" && rootTree === undefined)
    || (type === "tag" && (tagObject === undefined || tagType === undefined))
  ) {
    throw historyFailure();
  }
  const messageFindings = classifyPublicContent(Buffer.from(message, "utf8"), {
    label: `${type}:${objectId}`,
  });
  if (messageFindings.length > 0) {
    findings.push(historyFinding("sensitive Git metadata", `${type}:${objectId}`, objectId, type));
  }
  const tagTarget = type === "tag"
    ? Object.freeze({ objectId: tagObject, type: tagType })
    : undefined;
  return Object.freeze({ findings: Object.freeze(findings), rootTree, tagTarget });
}

function scanTreeObject(objectId, bytes) {
  const findings = [];
  const entriesFound = [];
  let cursor = 0;
  let entries = 0;
  while (cursor < bytes.length) {
    const space = bytes.indexOf(0x20, cursor);
    const nul = bytes.indexOf(0, space + 1);
    if (space <= cursor || nul < 0 || nul + 21 > bytes.length) throw historyFailure();
    const mode = bytes.subarray(cursor, space).toString("ascii");
    const nameBytes = bytes.subarray(space + 1, nul);
    if (!/^[0-7]{5,6}$/u.test(mode) || nameBytes.length === 0) throw historyFailure();
    let name;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); }
    catch { throw historyFailure(); }
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw historyFailure();
    const childId = bytes.subarray(nul + 1, nul + 21).toString("hex");
    const kind = /^(?:0?40000)$/u.test(mode) ? "tree"
      : mode === "160000" ? "gitlink"
        : ["100644", "100755"].includes(mode) ? "blob" : "non-regular";
    entriesFound.push(Object.freeze({ name, objectId: childId, kind }));
    const nameFindings = classifyPublicLabel(name);
    const contentFindings = classifyPublicContent(Buffer.from(name, "utf8"), {
      label: `tree:${objectId}`,
    });
    if (nameFindings.length > 0 || contentFindings.length > 0) {
      findings.push(historyFinding("sensitive Git metadata", `tree:${objectId}`, objectId, "tree"));
    }
    cursor = nul + 21;
    entries += 1;
    if (entries > MAX_OBJECTS) throw historyFailure();
  }
  if (cursor !== bytes.length) throw historyFailure();
  return Object.freeze({ findings: Object.freeze(findings), entries: Object.freeze(entriesFound) });
}

export function addTaggedRootTrees(tagTargets, objectTypes, rootTrees) {
  if (!(tagTargets instanceof Map) || !(objectTypes instanceof Map) || !(rootTrees instanceof Set)) {
    throw historyFailure();
  }
  const resolved = new Map();
  let traversalSteps = 0;
  for (const tagObjectId of tagTargets.keys()) {
    if (resolved.has(tagObjectId)) {
      const terminal = resolved.get(tagObjectId);
      if (terminal.type === "tree") rootTrees.add(terminal.objectId);
      continue;
    }
    const chain = [];
    const chainSet = new Set();
    let currentTag = tagObjectId;
    let terminal;
    while (true) {
      if (resolved.has(currentTag)) {
        terminal = resolved.get(currentTag);
        break;
      }
      if (chainSet.has(currentTag)) throw historyFailure();
      chainSet.add(currentTag);
      chain.push(currentTag);
      const target = tagTargets.get(currentTag);
      if (target === undefined || objectTypes.get(target.objectId) !== target.type) {
        throw historyFailure();
      }
      traversalSteps += 1;
      if (traversalSteps > tagTargets.size || traversalSteps > MAX_OBJECTS) {
        throw historyFailure();
      }
      if (target.type !== "tag") {
        terminal = target;
        break;
      }
      currentTag = target.objectId;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      resolved.set(chain[index], terminal);
    }
    if (terminal.type === "tree") rootTrees.add(terminal.objectId);
  }
  return Object.freeze({ traversalSteps, resolvedTags: resolved.size });
}

function associateRepositoryPaths(rootTrees, trees, blobs) {
  if (rootTrees.size === 0) throw historyFailure();
  const blobPaths = new Map();
  const findings = [];
  const findingKeys = new Set();
  const visited = new Set();
  const pending = [...rootTrees].map((treeId) => Object.freeze({ treeId, prefix: "" }));
  let associations = 0;
  while (pending.length > 0) {
    const { treeId, prefix } = pending.pop();
    const visitKey = `${treeId}\0${prefix}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const entries = trees.get(treeId);
    if (entries === undefined) throw historyFailure();
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (path.length > 4096) throw historyFailure();
      associations += 1;
      if (associations > MAX_PATH_ASSOCIATIONS) throw historyFailure();
      if (isPrivateRepositoryPath(path, entry.kind)) {
        const key = `${treeId}\0${path}`;
        if (!findingKeys.has(key)) {
          findingKeys.add(key);
          findings.push(historyFinding(
            "private repository path",
            path,
            treeId,
            "tree",
          ));
        }
      }
      if (entry.kind === "tree") {
        pending.push(Object.freeze({ treeId: entry.objectId, prefix: path }));
      } else if (entry.kind === "blob") {
        if (!blobs.has(entry.objectId)) throw historyFailure();
        let paths = blobPaths.get(entry.objectId);
        if (paths === undefined) {
          paths = new Set();
          blobPaths.set(entry.objectId, paths);
        }
        paths.add(path);
      }
    }
  }
  return Object.freeze({ blobPaths, findings: Object.freeze(findings) });
}

function parseIdentity(value) {
  const match = /^([^<>\r\n]+) <([^<>\r\n]+)>\s+[0-9]+\s+[+-][0-9]{4}$/u.exec(value);
  if (match === null) return undefined;
  return Object.freeze({ name: match[1], email: match[2] });
}

function identityAllowed(identity, objectId, neutralObjectAllowlist) {
  return isApprovedOwnerIdentity(identity.name, identity.email)
    || (identity.name === NEUTRAL_NAME && identity.email === NEUTRAL_EMAIL
      && neutralObjectAllowlist.has(objectId));
}

function parseRefs(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw historyFailure(); }
  const fields = text.split("\0");
  const refs = [];
  let index = 0;
  while (index < fields.length) {
    let objectId = fields[index++];
    if (objectId === "") break;
    objectId = objectId.replace(/^\n/u, "");
    const type = fields[index++];
    const name = fields[index++];
    if (!/^[a-f0-9]{40}$/u.test(objectId) || !["commit", "tag"].includes(type)
      || typeof name !== "string" || !name.startsWith("refs/") || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw historyFailure();
    }
    refs.push(Object.freeze({ objectId, type, name }));
    const separator = fields[index++];
    if (separator !== undefined && separator !== "\n" && separator !== "") {
      index -= 1;
    }
  }
  if (refs.length === 0 || new Set(refs.map((ref) => ref.name)).size !== refs.length) {
    throw historyFailure();
  }
  return refs;
}

function validateFrozenReleaseTags(value) {
  const entries = value instanceof Map
    ? [...value.entries()]
    : value === FROZEN_RELEASE_TAGS ? Object.entries(value) : undefined;
  if (entries === undefined) throw historyFailure();
  const validated = new Map();
  for (const [name, identity] of entries) {
    if (typeof name !== "string" || !/^v[A-Za-z0-9._-]{1,64}$/u.test(name)
      || identity === null || typeof identity !== "object" || Array.isArray(identity)
      || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(["commit", "tagObject"])
      || !/^[a-f0-9]{40}$/u.test(identity.tagObject)
      || !/^[a-f0-9]{40}$/u.test(identity.commit)
      || validated.has(name)) {
      throw historyFailure();
    }
    validated.set(name, Object.freeze({
      tagObject: identity.tagObject,
      commit: identity.commit,
    }));
  }
  return validated;
}

function validateFrozenTagRefs(frozenReleaseTags, refs) {
  const byName = new Map(refs.map((ref) => [ref.name, ref]));
  for (const [tag, expected] of frozenReleaseTags) {
    const ref = byName.get(`refs/tags/${tag}`);
    if (ref?.type !== "tag" || ref.objectId !== expected.tagObject) throw historyFailure();
  }
}

function validateFrozenTagTargets(frozenReleaseTags, tagTargets, objectTypes) {
  for (const { tagObject, commit } of frozenReleaseTags.values()) {
    const terminal = resolveTagTerminal(tagObject, tagTargets, objectTypes);
    if (terminal.type !== "commit" || terminal.objectId !== commit) throw historyFailure();
  }
}

function resolveTagTerminal(tagObject, tagTargets, objectTypes) {
  const visited = new Set();
  let current = tagObject;
  while (true) {
    if (visited.has(current) || visited.size >= MAX_OBJECTS || objectTypes.get(current) !== "tag") {
      throw historyFailure();
    }
    visited.add(current);
    const target = tagTargets.get(current);
    if (target === undefined || objectTypes.get(target.objectId) !== target.type) {
      throw historyFailure();
    }
    if (target.type !== "tag") return target;
    current = target.objectId;
  }
}

function parseObjectRecords(bytes) {
  if (bytes.length === 0 || bytes.at(-1) !== 0) throw historyFailure();
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)); }
  catch { throw historyFailure(); }
  const values = text.split("\0");
  const objectIds = [];
  const objectLabels = new Map();
  let previousObjectId;
  for (const value of values) {
    if (/^[a-f0-9]{40}$/u.test(value)) {
      objectIds.push(value);
      previousObjectId = value;
      continue;
    }
    if (value.startsWith("path=") && previousObjectId !== undefined) {
      const path = value.slice(5);
      if (path.length === 0 || path.length > 4096 || path.includes("\0")) throw historyFailure();
      objectLabels.set(previousObjectId, path);
      previousObjectId = undefined;
      continue;
    }
    throw historyFailure();
  }
  return Object.freeze({ objectIds: [...new Set(objectIds)], objectLabels });
}

async function readObjectsBatch(root, objectIds, visit) {
  const input = Buffer.from(`${objectIds.join("\n")}\n`, "ascii");
  let lifecycle;
  try {
    lifecycle = await startBoundedProcess("git", [
      "--no-replace-objects", "-C", root, "cat-file", "--batch",
    ], {
      env: gitEnvironment(),
      input,
      timeoutMs: 15 * 60 * 1_000,
    });
  } catch { throw historyFailure(); }
  await new Promise((resolvePromise, reject) => {
    const { child } = lifecycle;
    let buffer = Buffer.alloc(0);
    let expected = 0;
    let current;
    let processing = Promise.resolve();
    let stderrBytes = 0;
    let aggregateBytes = 0;
    let failed;
    let timer;
    const fail = async () => {
      if (failed !== undefined) return;
      failed = historyFailure();
      clearTimeout(timer);
      try { await lifecycle.terminate(); } catch { /* failure remains authoritative */ }
      reject(failed);
    };
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 0) void fail();
    });
    child.stdout.on("data", (chunk) => {
      if (failed !== undefined) return;
      aggregateBytes += chunk.length;
      if (aggregateBytes > MAX_HISTORY_BYTES + (MAX_OBJECTS * 128)) {
        void fail();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_OBJECT_BYTES + 512) {
        void fail();
        return;
      }
      const records = [];
      while (true) {
        if (current === undefined) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) {
            if (buffer.length > 256) void fail();
            break;
          }
          const header = buffer.subarray(0, newline).toString("ascii");
          buffer = buffer.subarray(newline + 1);
          const match = /^([a-f0-9]{40}) (blob|commit|tag|tree) ([0-9]+)$/u.exec(header);
          if (match === null || match[1] !== objectIds[expected]) { void fail(); break; }
          const size = Number(match[3]);
          if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES) { void fail(); break; }
          current = { objectId: match[1], type: match[2], size };
        }
        if (buffer.length < current.size + 1) break;
        if (buffer[current.size] !== 0x0a) { void fail(); break; }
        const record = Object.freeze({
          objectId: current.objectId,
          type: current.type,
          bytes: Buffer.from(buffer.subarray(0, current.size)),
        });
        buffer = buffer.subarray(current.size + 1);
        current = undefined;
        expected += 1;
        records.push(record);
      }
      if (records.length > 0) {
        child.stdout.pause();
        processing = processing.then(async () => {
          for (const record of records) await visit(record);
        }).then(() => {
          if (failed === undefined) child.stdout.resume();
        }).catch(() => { void fail(); });
      }
    });
    lifecycle.exit.then(({ code, signal, error }) => {
      if (error) { void fail(); return; }
      processing.finally(() => {
        if (failed !== undefined || code !== 0 || signal !== null || stderrBytes !== 0
          || expected !== objectIds.length || current !== undefined || buffer.length !== 0) {
          void fail();
        } else {
          clearTimeout(timer);
          lifecycle.terminate().then((gone) => {
            if (gone) resolvePromise();
            else reject(historyFailure());
          }, () => reject(historyFailure()));
        }
      });
    });
    timer = setTimeout(() => { void fail(); }, Math.max(1, lifecycle.deadline - Date.now()));
  });
}

function validateNeutralAllowlist(value) {
  if (!(value instanceof Set)) throw historyFailure();
  for (const objectId of value) if (!/^[a-f0-9]{40}$/u.test(objectId)) throw historyFailure();
  return value;
}

async function rejectGitGrafts(runGit, root) {
  const result = await invokeGit(runGit, root, [
    "rev-parse", "--path-format=absolute", "--git-path", "info/grafts",
  ]);
  if (result.code !== 0 || result.stderr.length !== 0) throw historyFailure();
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
  catch { throw historyFailure(); }
  const match = /^([^\u0000\r\n]{1,4096})\r?\n$/u.exec(text);
  if (match === null) throw historyFailure();
  try { await lstat(resolve(root, match[1])); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw historyFailure();
  }
  throw historyFailure();
}

async function defaultRunGit(root, args) {
  return await runBoundedProcess("git", ["--no-replace-objects", "-C", root, ...args], {
    env: gitEnvironment(),
    maxOutputBytes: MAX_COMMAND_BYTES,
  });
}

function gitEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)),
  );
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}

async function invokeGit(runGit, root, args) {
  let result;
  try { result = await runGit(root, args); }
  catch { throw historyFailure(); }
  if (result === null || typeof result !== "object") throw historyFailure();
  return Object.freeze({
    code: result.code,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
  });
}

function historyFinding(category, label, objectId, objectType) {
  return Object.freeze({
    ...publicFinding(category, label),
    objectId,
    objectType,
    remediation: category === "personal identity"
      ? "Rewrite only unpublished objects with the approved noreply identity."
      : category === "private repository path"
        ? "Remove the private path from every unpublished tree and object, then rescan."
        : "Remove the sensitive Git metadata from every unpublished object and ref.",
  });
}

function historyFailure() {
  return publicScanFailure([
    publicFinding("non-regular file", "<git-history>"),
  ], "Git history scan failed");
}

async function runCli() {
  try {
    const result = await scanPublicHistory({ root: process.cwd() });
    if (result.findings.length > 0) {
      process.stderr.write(`${formatPublicFindings(result.findings)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`PUBLIC_HISTORY_SCAN_OK refs=${result.refs} objects=${result.objects} bytes=${result.bytes}\n`);
  } catch (error) {
    const findings = Array.isArray(error?.findings) ? error.findings : [
      publicFinding("non-regular file", "<git-history>"),
    ];
    process.stderr.write(`${formatPublicFindings(findings)}\n`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  if (process.argv.length !== 2) {
    process.stderr.write("PUBLIC_HISTORY_SCAN_USAGE\n");
    process.exitCode = 1;
  } else await runCli();
}
