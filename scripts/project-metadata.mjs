import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const APPROVED_LEGACY_SELECTOR = "hwp-korean-docs@hwp-local";
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const BUILD_ID_PATTERN = /^[0-9]{14}$/u;

export async function loadProjectMetadata(root) {
  return (await loadProjectConfiguration(root)).metadata;
}

export function pluginVersion(metadata) {
  return `${metadata.version}+codex.${metadata.codexBuildId}`;
}

export function renderGeneratedTypeScript(metadata) {
  return (
    "export const PROJECT_METADATA = Object.freeze({\n" +
    `  productId: ${JSON.stringify(metadata.productId)},\n` +
    `  displayName: ${JSON.stringify(metadata.displayName)},\n` +
    `  version: ${JSON.stringify(metadata.version)},\n` +
    "} as const);\n"
  );
}

export async function syncProjectMetadata({ root, check }) {
  if (typeof check !== "boolean") {
    throw projectMetadataError("check", "must be a boolean");
  }

  const projectRoot = resolve(root);
  const { metadata, license } = await loadProjectConfiguration(projectRoot);
  const sourceRoot = join(projectRoot, "packages", "gpt-codex-hwp");
  const packagePath = join(sourceRoot, "package.json");
  const lockPath = join(sourceRoot, "package-lock.json");
  const skillPath = join(sourceRoot, "skills", "gpt-codex-hwp", "SKILL.md");
  const agentPath = join(sourceRoot, "skills", "gpt-codex-hwp", "agents", "openai.yaml");
  const generatedPath = join(sourceRoot, "src", "generated", "project-metadata.ts");

  const sourcePackage = await readJson(packagePath);
  sourcePackage.name = metadata.productId;
  sourcePackage.version = metadata.version;
  sourcePackage.license = license;

  const sourceLock = await readJson(lockPath);
  if (!sourceLock.packages || typeof sourceLock.packages[""] !== "object") {
    throw projectMetadataError("packages/gpt-codex-hwp/package-lock.json", "has no root package record");
  }
  sourceLock.name = metadata.productId;
  sourceLock.version = metadata.version;
  sourceLock.packages[""].name = metadata.productId;
  sourceLock.packages[""].version = metadata.version;
  sourceLock.packages[""].license = license;

  const targets = [
    {
      path: generatedPath,
      content: renderGeneratedTypeScript(metadata),
    },
    {
      path: packagePath,
      content: renderJson(sourcePackage),
    },
    {
      path: lockPath,
      content: renderJson(sourceLock),
    },
    {
      path: skillPath,
      content: renderSkillMetadata(await readFile(skillPath, "utf8"), metadata),
    },
    {
      path: agentPath,
      content: renderAgentMetadata(await readFile(agentPath, "utf8"), metadata),
    },
  ].sort((left, right) => relativePath(projectRoot, left.path).localeCompare(relativePath(projectRoot, right.path)));

  const compared = [];
  for (const target of targets) {
    compared.push({ ...target, actual: await readOptional(target.path) });
  }

  if (check) {
    const drift = compared.find(({ actual, content }) => actual !== content);
    if (drift) throw metadataDrift(projectRoot, drift.path);
    return;
  }

  for (const target of compared) {
    if (target.actual === target.content) continue;
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, target.content, "utf8");
  }
}

async function loadProjectConfiguration(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw projectMetadataError("root", "must be a non-empty path");
  }

  const rootPackage = await readJson(join(resolve(root), "package.json"));
  const config = rootPackage.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw projectMetadataError("config", "must be an object");
  }

  const version = requiredString(rootPackage.version, "version");
  if (!SEMVER_PATTERN.test(version)) {
    throw projectMetadataError("version", "must be a valid semantic version");
  }
  if (version.includes("+")) {
    throw projectMetadataError(
      "version",
      "must not contain build metadata because the +codex.<build-id> suffix is generated separately",
    );
  }

  const metadata = {
    productId: requiredString(config.productId, "productId"),
    displayName: requiredString(config.displayName, "displayName"),
    developerName: requiredString(config.developerName, "developerName"),
    marketplaceName: requiredString(config.marketplaceName, "marketplaceName"),
    legacyUninstallSelector: requiredString(config.legacyUninstallSelector, "legacyUninstallSelector"),
    codexBuildId: requiredString(config.codexBuildId, "codexBuildId"),
    version,
  };

  if (metadata.legacyUninstallSelector !== APPROVED_LEGACY_SELECTOR) {
    throw projectMetadataError(
      "legacyUninstallSelector",
      `must remain ${JSON.stringify(APPROVED_LEGACY_SELECTOR)}`,
    );
  }
  if (!BUILD_ID_PATTERN.test(metadata.codexBuildId)) {
    throw projectMetadataError("codexBuildId", "must contain exactly 14 decimal digits");
  }

  return Object.freeze({
    metadata: Object.freeze(metadata),
    license: requiredString(rootPackage.license, "license"),
  });
}

function renderSkillMetadata(source, metadata) {
  const normalized = normalizeEol(source);
  const frontmatterEnd = normalized.indexOf("\n---\n", 4);
  if (!normalized.startsWith("---\n") || frontmatterEnd < 0) {
    throw projectMetadataError("skills/gpt-codex-hwp/SKILL.md", "has invalid frontmatter");
  }

  const frontmatter = normalized.slice(4, frontmatterEnd).split("\n");
  replaceExactlyOne(
    frontmatter,
    /^name:\s*.*$/u,
    `name: ${metadata.productId}`,
    "skills/gpt-codex-hwp/SKILL.md frontmatter name",
  );

  const body = normalized.slice(frontmatterEnd + 5).split("\n");
  replaceExactlyOne(body, /^#\s+.*$/u, `# ${metadata.displayName}`, "skills/gpt-codex-hwp/SKILL.md heading");
  return `---\n${frontmatter.join("\n")}\n---\n${body.join("\n")}`;
}

function renderAgentMetadata(source, metadata) {
  const lines = normalizeEol(source).split("\n");
  replaceExactlyOne(
    lines,
    /^  display_name:\s*.*$/u,
    `  display_name: ${JSON.stringify(metadata.displayName)}`,
    "skills/gpt-codex-hwp/agents/openai.yaml display_name",
  );

  const promptIndexes = matchingIndexes(lines, /^  default_prompt:\s*".*"\s*$/u);
  if (promptIndexes.length !== 1) {
    throw projectMetadataError(
      "skills/gpt-codex-hwp/agents/openai.yaml default_prompt",
      `expected exactly one field, found ${promptIndexes.length}`,
    );
  }
  const index = promptIndexes[0];
  const skillTokens = lines[index].match(/\$[a-z0-9][a-z0-9-]*/gu) ?? [];
  if (skillTokens.length !== 1) {
    throw projectMetadataError(
      "skills/gpt-codex-hwp/agents/openai.yaml default_prompt",
      `expected exactly one skill token, found ${skillTokens.length}`,
    );
  }
  lines[index] = lines[index].replace(skillTokens[0], `$${metadata.productId}`);
  return lines.join("\n");
}

function replaceExactlyOne(lines, pattern, replacement, field) {
  const indexes = matchingIndexes(lines, pattern);
  if (indexes.length !== 1) {
    throw projectMetadataError(field, `expected exactly one value, found ${indexes.length}`);
  }
  lines[indexes[0]] = replacement;
}

function matchingIndexes(lines, pattern) {
  const indexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) indexes.push(index);
  }
  return indexes;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw projectMetadataError(field, "must be a non-empty string");
  }
  if (value !== value.trim()) {
    throw projectMetadataError(field, "must not contain leading or trailing whitespace");
  }
  return value;
}

async function readJson(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw projectMetadataError(relativePath(process.cwd(), path), `could not be read: ${reason}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw projectMetadataError(relativePath(process.cwd(), path), `is not valid JSON: ${reason}`);
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeEol(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function metadataDrift(root, path) {
  const error = new Error(`METADATA_DRIFT: ${relativePath(root, path)}`);
  error.code = "METADATA_DRIFT";
  return error;
}

function projectMetadataError(field, detail) {
  const error = new Error(`PROJECT_METADATA_INVALID: ${field} ${detail}`);
  error.code = "PROJECT_METADATA_INVALID";
  return error;
}

function relativePath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}
