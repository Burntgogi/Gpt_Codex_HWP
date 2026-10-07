import { stat } from "node:fs/promises";
import { join } from "node:path";

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
    const candidates: PythonCommand[] = [
      { command: join(env.SystemRoot ?? "C:\\Windows", "py.exe"), argsPrefix: ["-3"] },
    ];
    if (env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA.length > 0) {
      candidates.push({
        command: join(env.LOCALAPPDATA, "Programs", "Python", "Launcher", "py.exe"),
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

export async function resolvePythonCommand(
  candidates: readonly PythonCommand[] = pythonCommandCandidates(),
): Promise<PythonCommand | undefined> {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate.command)).isFile()) return candidate;
    } catch {
      // Try the next trusted location.
    }
  }
  return undefined;
}
