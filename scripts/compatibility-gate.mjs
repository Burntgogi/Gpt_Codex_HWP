import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_ARGUMENTS = 6;
const MAX_ARGUMENT_BYTES = 64;
const DESKTOP_REQUIREMENTS = Object.freeze(["large", "receipt"]);
const LINUX_REQUIREMENTS = Object.freeze(["node", "python", "large"]);

export function parseCompatibilityGateArguments(args) {
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS
    || (args.length !== 4 && args.length !== 6)) {
    throw gateError("COMPATIBILITY_GATE_USAGE");
  }
  const names = [];
  const outcomes = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const requirement = args[index + 1];
    if (flag !== "--require" || typeof requirement !== "string"
      || Buffer.byteLength(requirement, "utf8") > MAX_ARGUMENT_BYTES) {
      throw gateError("COMPATIBILITY_GATE_USAGE");
    }
    const match = /^(node|python|large|receipt)=([a-z][a-z0-9_-]{0,31})$/u.exec(requirement);
    if (match === null) throw gateError("COMPATIBILITY_GATE_USAGE");
    names.push(match[1]);
    outcomes.push(match[2]);
  }
  const expected = names.length === DESKTOP_REQUIREMENTS.length
    ? DESKTOP_REQUIREMENTS
    : LINUX_REQUIREMENTS;
  if (names.some((name, index) => name !== expected[index])) {
    throw gateError("COMPATIBILITY_GATE_USAGE");
  }
  return Object.freeze({
    passed: outcomes.every((outcome) => outcome === "success"),
    requirementCount: names.length,
  });
}

export function runCompatibilityGateCli(options = {}) {
  const args = Object.prototype.hasOwnProperty.call(options, "args")
    ? options.args
    : process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  let decision;
  try {
    decision = parseCompatibilityGateArguments(args);
  } catch (error) {
    if (error?.code === "COMPATIBILITY_GATE_USAGE") {
      stderr.write("COMPATIBILITY_GATE_USAGE\n");
      setExitCode(2);
      return undefined;
    }
    stderr.write("COMPATIBILITY_GATE_FAILED\n");
    setExitCode(1);
    return undefined;
  }
  if (!decision.passed) {
    stderr.write("COMPATIBILITY_GATE_FAILED\n");
    setExitCode(1);
    return decision;
  }
  stdout.write(`COMPATIBILITY_GATE_PASSED requirements=${decision.requirementCount}\n`);
  setExitCode(0);
  return decision;
}

function gateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCompatibilityGateCli();
}
