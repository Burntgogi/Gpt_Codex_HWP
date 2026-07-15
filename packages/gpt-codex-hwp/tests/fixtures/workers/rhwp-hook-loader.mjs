let delayMs = 0;

export function initialize(data) {
  delayMs = data?.delayMs ?? 0;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@rhwp/core") {
    if (delayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    throw new Error("SENSITIVE_RHWP_LOADER_REASON");
  }
  return nextResolve(specifier, context);
}
