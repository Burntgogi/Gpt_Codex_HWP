import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, parse as parsePath, resolve } from "node:path";

export interface ResolvedSourceAndOutputPaths {
  sourcePath: string;
  outputPath: string;
}

export function resolveLocalPath(localPath: string, label = "path"): string {
  if (typeof localPath !== "string" || localPath.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  if (process.platform === "win32") {
    assertSafeWindowsPath(localPath, label);
  }
  const resolved = resolve(localPath);
  if (process.platform === "win32") {
    assertSafeWindowsPath(resolved, label);
  }
  return resolved;
}

export class UnsafeWindowsPathError extends Error {
  readonly code: "UNSAFE_OUTPUT_PATH" | "UNSAFE_LOCAL_PATH";

  constructor(label: string, reason: string) {
    super(`${label} uses unsafe Windows path syntax: ${reason}`);
    this.name = "UnsafeWindowsPathError";
    this.code = /output/iu.test(label)
      ? "UNSAFE_OUTPUT_PATH"
      : "UNSAFE_LOCAL_PATH";
  }
}

function assertSafeWindowsPath(path: string, label: string): void {
  const withWindowsSeparators = path.replaceAll("/", "\\");
  if (/^\\\\[.?]\\/u.test(withWindowsSeparators)) {
    throw new UnsafeWindowsPathError(
      label,
      "device namespace paths are not accepted",
    );
  }

  const root = parsePath(path).root;
  const remainder = path.slice(root.length);
  if (remainder.includes(":")) {
    throw new UnsafeWindowsPathError(
      label,
      "alternate data streams are not accepted",
    );
  }

  const components = remainder.split(/[\\/]+/u).filter(Boolean);
  for (const component of components) {
    if (/[ .]$/u.test(component)) {
      throw new UnsafeWindowsPathError(
        label,
        "components must not end with a dot or space",
      );
    }
    if (/[<>"|?*\u0000-\u001f]/u.test(component)) {
      throw new UnsafeWindowsPathError(
        label,
        "components contain invalid or control characters",
      );
    }
    if (
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(?:\.|$)/iu.test(
        component,
      )
    ) {
      throw new UnsafeWindowsPathError(
        label,
        `reserved DOS device name ${component} is not accepted`,
      );
    }
  }
}

export function assertSafeZipEntryName(entryName: string): string {
  if (typeof entryName !== "string" || entryName.trim().length === 0) {
    throw new Error("ZIP entry name must not be empty.");
  }

  if (entryName.includes("\0")) {
    throw new Error("ZIP entry name must not contain null bytes.");
  }

  const normalizedName = entryName.replaceAll("\\", "/");
  if (normalizedName.startsWith("/") || /^[A-Za-z]:/.test(normalizedName)) {
    throw new Error("ZIP entry name must be package-relative.");
  }

  if (normalizedName.split("/").includes("..")) {
    throw new Error("ZIP entry name must not contain directory traversal.");
  }

  return normalizedName;
}

export function resolveSourceAndOutputPaths(
  sourcePath: string,
  outputPath: string,
): ResolvedSourceAndOutputPaths {
  const resolvedSourcePath = resolveLocalPath(sourcePath, "source_path");
  const resolvedOutputPath = resolveLocalPath(outputPath, "output_path");
  const comparableSourcePath = comparablePath(resolvedSourcePath);
  const comparableOutputPath = comparablePath(resolvedOutputPath);

  if (comparableSourcePath === comparableOutputPath) {
    throw new Error("source_path and output_path must be different.");
  }

  return {
    sourcePath: resolvedSourcePath,
    outputPath: resolvedOutputPath,
  };
}

export async function prepareOutputPath(
  sourcePath: string,
  outputPath: string,
): Promise<ResolvedSourceAndOutputPaths> {
  const resolvedPaths = resolveSourceAndOutputPaths(sourcePath, outputPath);
  const [sourceIdentity, outputIdentity] = await Promise.all([
    getExistingPathIdentity(resolvedPaths.sourcePath),
    getExistingPathIdentity(resolvedPaths.outputPath),
  ]);

  if (
    sourceIdentity !== undefined &&
    outputIdentity !== undefined &&
    (comparablePath(sourceIdentity.realPath) ===
      comparablePath(outputIdentity.realPath) ||
      (sourceIdentity.device === outputIdentity.device &&
        sourceIdentity.inode === outputIdentity.inode))
  ) {
    throw new Error("source_path and output_path must be different.");
  }

  await mkdir(dirname(resolvedPaths.outputPath), { recursive: true });
  return resolvedPaths;
}

interface ExistingPathIdentity {
  realPath: string;
  device: bigint;
  inode: bigint;
}

async function getExistingPathIdentity(
  path: string,
): Promise<ExistingPathIdentity | undefined> {
  try {
    const [resolvedRealPath, stats] = await Promise.all([
      realpath(path),
      stat(path, { bigint: true }),
    ]);
    return {
      realPath: resolvedRealPath,
      device: stats.dev,
      inode: stats.ino,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}
