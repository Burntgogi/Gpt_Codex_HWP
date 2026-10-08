import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 } from "node:path";

export interface PythonCommand {
  readonly command: string;
  readonly argsPrefix: readonly string[];
}

/**
 * Absolute interpreter locations trusted for the image helper. PATH is never
 * searched, so a writable PATH entry cannot substitute the interpreter. The
 * doctor and the document child share this list so their verdicts agree.
 */
export function pythonCommandCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly PythonCommand[] {
  if (platform === "win32") {
    // A relative SystemRoot or LOCALAPPDATA would resolve against the working
    // directory, so such a value never names a trusted location.
    const systemRoot = env.SystemRoot ?? "C:\\Windows";
    const candidates: PythonCommand[] = win32.isAbsolute(systemRoot)
      ? [{ command: win32.join(systemRoot, "py.exe"), argsPrefix: ["-3"] }]
      : [];
    if (env.LOCALAPPDATA !== undefined && win32.isAbsolute(env.LOCALAPPDATA)) {
      candidates.push({
        command: win32.join(env.LOCALAPPDATA, "Programs", "Python", "Launcher", "py.exe"),
        argsPrefix: ["-3"],
      });
    }
    return Object.freeze(candidates);
  }
  if (platform === "darwin") {
    // Prefer real installations; /usr/bin/python3 is a stub that may open the
    // Command Line Tools installer when they are absent, so it is tried last.
    return Object.freeze([
      { command: "/opt/homebrew/bin/python3", argsPrefix: [] },
      { command: "/usr/local/bin/python3", argsPrefix: [] },
      { command: "/Library/Developer/CommandLineTools/usr/bin/python3", argsPrefix: [] },
      { command: "/usr/bin/python3", argsPrefix: [] },
    ]);
  }
  return Object.freeze([
    { command: "/usr/bin/python3", argsPrefix: [] },
    { command: "/usr/local/bin/python3", argsPrefix: [] },
  ]);
}

/** The image helper and doctor both require at least this version. */
export const MINIMUM_HELPER_PYTHON: readonly [number, number] = Object.freeze([3, 10]);

export interface ResolvePythonOptions {
  /** Skip interpreters older than [major, minor]; omit to accept any version. */
  readonly minimumVersion?: readonly [number, number];
  /** Test seam: returns the `--version` output, or undefined on failure. */
  readonly probeVersion?: (candidate: PythonCommand) => Promise<string | undefined>;
}

const versionCache = new Map<string, Promise<string | undefined>>();

function probeVersionOnce(candidate: PythonCommand): Promise<string | undefined> {
  const key = [candidate.command, ...candidate.argsPrefix].join("\u0000");
  let pending = versionCache.get(key);
  if (pending === undefined) {
    pending = new Promise((resolvePromise) => {
      execFile(candidate.command, [...candidate.argsPrefix, "--version"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 4 * 1024,
      }, (error, stdout, stderr) => {
        resolvePromise(error === null ? `${stdout}\n${stderr}` : undefined);
      });
    });
    versionCache.set(key, pending);
    // Cache only answers; a slow cold start or transient failure is retried.
    void pending.then((output) => {
      if (output === undefined) versionCache.delete(key);
    });
  }
  return pending;
}

export function pythonVersionAtLeast(
  output: string | undefined,
  minimum: readonly [number, number],
): boolean {
  const match = /Python\s+(\d+)\.(\d+)/u.exec(output ?? "");
  if (match === null) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

/**
 * Returns the first trusted interpreter that exists and, when a minimum is
 * given, reports at least that version. The doctor applies the same list and
 * the same minimum, so its verdict matches what the image helper will run.
 */
export async function resolvePythonCommand(
  candidates: readonly PythonCommand[] = pythonCommandCandidates(),
  options: ResolvePythonOptions = {},
): Promise<PythonCommand | undefined> {
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate.command)).isFile()) continue;
    } catch {
      continue; // Try the next trusted location.
    }
    if (options.minimumVersion === undefined) return candidate;
    const output = await (options.probeVersion ?? probeVersionOnce)(candidate);
    if (pythonVersionAtLeast(output, options.minimumVersion)) return candidate;
  }
  return undefined;
}
