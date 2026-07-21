function environmentError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function environmentRecord(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw environmentError(code);
  }
  return value;
}

function validEnvironmentEntry(key, value) {
  return typeof key === "string" && key.length > 0 && !/[=\0]/u.test(key)
    && typeof value === "string" && !value.includes("\0");
}

export function releaseSubprocessEnvironment(
  inherited = process.env,
  overrides = {},
) {
  environmentRecord(inherited, "RELEASE_SUBPROCESS_ENV_INHERITED_INVALID");
  environmentRecord(overrides, "RELEASE_SUBPROCESS_ENV_OVERRIDE_INVALID");

  const environment = Object.create(null);
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (!validEnvironmentEntry(key, value)) {
      throw environmentError("RELEASE_SUBPROCESS_ENV_INHERITED_INVALID");
    }
    if (/^GIT_/iu.test(key) || /^NODE_TEST_CONTEXT$/iu.test(key)) continue;
    environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!validEnvironmentEntry(key, value) || /^GIT_/iu.test(key)) {
      throw environmentError("RELEASE_SUBPROCESS_ENV_OVERRIDE_INVALID");
    }
    if (/^NODE_TEST_CONTEXT$/iu.test(key)) continue;
    environment[key] = value;
  }
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  return environment;
}

export function noReplaceGitArguments(args) {
  if (!Array.isArray(args) || !args.every((arg) =>
    typeof arg === "string" && !arg.includes("\0"))) {
    throw environmentError("RELEASE_SUBPROCESS_GIT_ARGUMENTS_INVALID");
  }
  return ["--no-replace-objects", ...args.filter((arg) => arg !== "--no-replace-objects")];
}
