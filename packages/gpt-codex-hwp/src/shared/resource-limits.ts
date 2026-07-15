export const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_SVG_BYTES = 128 * 1024 * 1024;
export const MAX_HIGHLIGHT_TERMS = 256;
export const MAX_HIGHLIGHT_CHARACTERS = 16_384;
export const MAX_FILL_VALUES = 10_000;

export class ResourceLimitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly maximum: number,
    readonly actualAtLeast: number,
  ) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Value cannot be serialized as JSON.");
  }
  return utf8Bytes(serialized);
}

export function assertSerializedBudget(
  value: unknown,
  maximumBytes = MAX_MCP_RESPONSE_BYTES,
): void {
  const actual = serializedBytes(value);
  if (actual > maximumBytes) {
    throw new ResourceLimitError(
      "RESPONSE_TOO_LARGE",
      `Serialized MCP result exceeds the ${maximumBytes}-byte safety limit.`,
      maximumBytes,
      actual,
    );
  }
}

export function assertUtf8Budget(
  value: string,
  maximumBytes: number,
  label: string,
  code = "INPUT_TOO_LARGE",
): void {
  const actual = utf8Bytes(value);
  if (actual > maximumBytes) {
    throw new ResourceLimitError(
      code,
      `${label} exceeds the ${maximumBytes}-byte safety limit.`,
      maximumBytes,
      actual,
    );
  }
}

export function sumStringCharacters(
  values: Iterable<string>,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  let total = 0;
  for (const value of values) {
    if (value.length > maximum - total) return maximum + 1;
    total += value.length;
  }
  return total;
}

export function assertHighlightBudget(values: readonly string[]): void {
  if (values.length > MAX_HIGHLIGHT_TERMS) {
    throw new ResourceLimitError(
      "INPUT_TOO_LARGE",
      `Preview highlight term count exceeds ${MAX_HIGHLIGHT_TERMS}.`,
      MAX_HIGHLIGHT_TERMS,
      values.length,
    );
  }
  for (const value of values) {
    if (value.length === 0 || value.length > 256) {
      throw new ResourceLimitError(
        "INPUT_TOO_LARGE",
        "Each preview highlight must contain 1 to 256 characters.",
        256,
        value.length,
      );
    }
  }
  const characters = sumStringCharacters(values, MAX_HIGHLIGHT_CHARACTERS);
  if (characters > MAX_HIGHLIGHT_CHARACTERS) {
    throw new ResourceLimitError(
      "INPUT_TOO_LARGE",
      `Preview highlight characters exceed ${MAX_HIGHLIGHT_CHARACTERS}.`,
      MAX_HIGHLIGHT_CHARACTERS,
      characters,
    );
  }
}

export function assertFillValueBudget(
  fields: Readonly<Record<string, string | readonly string[]>>,
): void {
  let total = 0;
  for (const value of Object.values(fields)) {
    const count = Array.isArray(value) ? value.length : 1;
    if (count > MAX_FILL_VALUES - total) {
      throw new ResourceLimitError(
        "INPUT_TOO_LARGE",
        `Form value count exceeds ${MAX_FILL_VALUES}.`,
        MAX_FILL_VALUES,
        total + count,
      );
    }
    total += count;
  }
}
