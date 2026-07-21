const MAX_SVG_TAG_CHARACTERS = 64 * 1024;
const MAX_SVG_NESTING_DEPTH = 1024;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const SAFE_DATA_IMAGE_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/gif;base64,",
  "data:image/webp;base64,",
] as const;

interface DataImageState {
  characters: number;
  padding: number;
  lastSextet: number;
}

export class IncrementalSvgPolicyValidator {
  #tag = "";
  #quote: "\"" | "'" | undefined;
  #referenceCandidate: string | undefined;
  #dataImage: DataImageState | undefined;
  #elements: string[] = [];
  #rootSeen = false;
  #rootClosed = false;

  push(text: string): void {
    for (const character of text) {
      if (this.#tag.length === 0) {
        if (character === "<") {
          this.#tag = "<";
        } else if (this.#elements.length === 0 && /\S/u.test(character)) {
          throw new Error("SVG content outside the root element is not allowed.");
        }
        continue;
      }
      this.#pushTagCharacter(character);
    }
  }

  finish(): void {
    if (this.#tag.length !== 0 || this.#quote !== undefined ||
      !this.#rootSeen || !this.#rootClosed || this.#elements.length !== 0) {
      throw new Error("SVG structure is invalid.");
    }
  }

  #pushTagCharacter(character: string): void {
    if (this.#quote !== undefined) {
      if (character === this.#quote) {
        if (this.#dataImage !== undefined) {
          assertCompleteBase64(this.#dataImage);
          this.#appendTag("AAAA");
        } else if (this.#referenceCandidate !== undefined) {
          this.#appendTag(this.#referenceCandidate);
        }
        this.#dataImage = undefined;
        this.#referenceCandidate = undefined;
        this.#quote = undefined;
        this.#appendTag(character);
        return;
      }
      if (this.#dataImage !== undefined) {
        pushBase64Character(this.#dataImage, character);
        return;
      }
      if (this.#referenceCandidate !== undefined) {
        this.#referenceCandidate += character;
        const lower = this.#referenceCandidate.toLocaleLowerCase("en-US");
        if (SAFE_DATA_IMAGE_PREFIXES.some((prefix) => prefix === lower)) {
          this.#appendTag(this.#referenceCandidate);
          this.#referenceCandidate = undefined;
          this.#dataImage = { characters: 0, padding: 0, lastSextet: 0 };
        } else if (!SAFE_DATA_IMAGE_PREFIXES.some((prefix) => prefix.startsWith(lower))) {
          this.#appendTag(this.#referenceCandidate);
          this.#referenceCandidate = undefined;
        }
        return;
      }
      this.#appendTag(character);
      return;
    }

    if (character === "<") throw new Error("SVG tag structure is invalid.");
    if (character === "\"" || character === "'") {
      const isReference = /(?:^|\s)(?:href|xlink:href|src)\s*=\s*$/iu.test(this.#tag);
      this.#appendTag(character);
      this.#quote = character;
      if (isReference) this.#referenceCandidate = "";
      return;
    }
    this.#appendTag(character);
    if (character === ">") {
      const tag = this.#tag;
      this.#tag = "";
      inspectSvgTag(tag);
      this.#inspectStructure(tag);
    }
  }

  #inspectStructure(tag: string): void {
    const body = tag.slice(1, -1).trim();
    if (body.startsWith("!") || body.startsWith("?")) {
      throw new Error("SVG declarations are not allowed.");
    }
    const closing = /^\/\s*([a-z_][\w:.-]*)\s*$/iu.exec(body);
    if (closing !== null) {
      const expected = this.#elements.pop();
      const actual = closing[1]!.toLocaleLowerCase("en-US");
      if (expected === undefined || expected !== actual) {
        throw new Error("SVG element nesting is invalid.");
      }
      if (this.#elements.length === 0) this.#rootClosed = true;
      return;
    }

    const opening = /^([a-z_][\w:.-]*)\b/iu.exec(body);
    if (opening === null) throw new Error("SVG tag structure is invalid.");
    const name = opening[1]!.toLocaleLowerCase("en-US");
    const selfClosing = /\/\s*$/u.test(body);
    if (this.#elements.length === 0) {
      if (this.#rootSeen || this.#rootClosed || name !== "svg") {
        throw new Error("SVG must contain exactly one top-level root.");
      }
      this.#rootSeen = true;
    }
    if (selfClosing) {
      if (this.#elements.length === 0) this.#rootClosed = true;
      return;
    }
    if (this.#elements.length >= MAX_SVG_NESTING_DEPTH) {
      throw new Error("SVG nesting exceeds the safety limit.");
    }
    this.#elements.push(name);
  }

  #appendTag(fragment: string): void {
    if (fragment.length > MAX_SVG_TAG_CHARACTERS - this.#tag.length) {
      throw new Error("SVG tag exceeds the safety limit.");
    }
    this.#tag += fragment;
  }
}

export function assertSafeSvgString(svg: unknown): asserts svg is string {
  if (typeof svg !== "string") throw new Error("SVG output is not text.");
  const validator = new IncrementalSvgPolicyValidator();
  validator.push(svg);
  validator.finish();
}

function pushBase64Character(state: DataImageState, character: string): void {
  if (character === "=") {
    state.padding += 1;
    if (state.padding > 2) throw new Error("SVG data image has invalid base64 padding.");
    return;
  }
  if (!/[A-Za-z0-9+/]/u.test(character) || state.padding !== 0) {
    throw new Error("SVG data image has an invalid base64 payload.");
  }
  state.characters += 1;
  state.lastSextet = base64Sextet(character);
}

function assertCompleteBase64(state: DataImageState): void {
  if (state.characters === 0 ||
    (state.padding === 0 && state.characters % 4 !== 0) ||
    (state.padding === 1 &&
      (state.characters % 4 !== 3 || (state.lastSextet & 0b11) !== 0)) ||
    (state.padding === 2 &&
      (state.characters % 4 !== 2 || (state.lastSextet & 0b1111) !== 0))) {
    throw new Error("SVG data image has an invalid base64 payload.");
  }
}

function base64Sextet(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  return character === "+" ? 62 : 63;
}

function inspectSvgTag(tag: string): void {
  const decoded = decodeXmlEntities(tag);
  const lower = decoded.toLocaleLowerCase("en-US");
  const attributes = [...readSvgAttributes(tag), ...readSvgAttributes(decoded)];
  if (attributes.some(({ name }) => name === "xml:base" || name === "srcdoc") ||
    hasUnsafeNamespaceDeclaration(readSvgAttributes(decoded)) ||
    lower.includes("\\") ||
    /^<\s*\/?\s*[a-z_][\w.-]*:[a-z_][\w.-]*\b/u.test(lower) ||
    /^<\s*\/?\s*(?:script|foreignobject|style|animate|set|animatetransform|animatemotion|mpath|discard|iframe|object|embed|audio|video|canvas|link|meta|base)\b/u.test(lower) ||
    /\bstyle\s*=/u.test(lower) ||
    /\bon[a-z][\w:.-]*\s*=/u.test(lower) ||
    /j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/u.test(lower) ||
    /@import\b/u.test(lower)) {
    throw new Error("SVG active content is not allowed.");
  }

  if (/\b(?:href|xlink:href|src)\s*=\s*(?!["'])/u.test(lower)) {
    throw new Error("SVG reference attributes must be quoted.");
  }
  for (const match of lower.matchAll(
    /\b(?:href|xlink:href|src)\s*=\s*(["'])(.*?)\1/gu,
  )) {
    const value = match[2]!.trim();
    if (value.length > 0 && !value.startsWith("#") &&
      !/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/]+=*$/u.test(value)) {
      throw new Error("SVG external references are not allowed.");
    }
  }
  for (const match of lower.matchAll(/\burl\s*\(\s*(["']?)(.*?)\1\s*\)/gu)) {
    if (!match[2]!.trim().startsWith("#")) {
      throw new Error("SVG external URL references are not allowed.");
    }
  }
}

interface SvgAttribute {
  readonly name: string;
  readonly value: string;
}

function readSvgAttributes(tag: string): SvgAttribute[] {
  const attributes: SvgAttribute[] = [];
  let offset = 1;
  while (offset < tag.length && /\s/u.test(tag[offset]!)) offset += 1;
  if (tag[offset] === "/") offset += 1;
  while (offset < tag.length && !/[\s>]/u.test(tag[offset]!)) offset += 1;

  while (offset < tag.length) {
    while (offset < tag.length && /\s/u.test(tag[offset]!)) offset += 1;
    if (tag[offset] === "/" || tag[offset] === ">" || offset >= tag.length) break;
    const nameStart = offset;
    while (offset < tag.length && !/[\s=/>]/u.test(tag[offset]!)) offset += 1;
    const name = tag.slice(nameStart, offset).toLocaleLowerCase("en-US");
    while (offset < tag.length && /\s/u.test(tag[offset]!)) offset += 1;
    if (tag[offset] !== "=") continue;
    offset += 1;
    while (offset < tag.length && /\s/u.test(tag[offset]!)) offset += 1;
    const quote = tag[offset];
    let value: string;
    if (quote === "\"" || quote === "'") {
      offset += 1;
      const valueStart = offset;
      while (offset < tag.length && tag[offset] !== quote) offset += 1;
      value = tag.slice(valueStart, offset);
      if (offset < tag.length) offset += 1;
    } else {
      const valueStart = offset;
      while (offset < tag.length && !/[\s>]/u.test(tag[offset]!)) offset += 1;
      value = tag.slice(valueStart, offset);
    }
    attributes.push({ name, value });
  }
  return attributes;
}

function hasUnsafeNamespaceDeclaration(attributes: readonly SvgAttribute[]): boolean {
  return attributes.some(({ name, value }) =>
    (name === "xmlns" && value !== SVG_NAMESPACE) ||
    (name.startsWith("xmlns:") &&
      (name !== "xmlns:xlink" || value !== XLINK_NAMESPACE)),
  );
}

function decodeXmlEntities(value: string): string {
  const decoded = value.replace(
    /&(?:#x([0-9a-f]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/giu,
    (entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (named !== undefined) {
        return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" } as const)[
          named.toLocaleLowerCase("en-US") as "amp" | "lt" | "gt" | "quot" | "apos"
        ];
      }
      const codePoint = Number.parseInt(hex ?? decimal!, hex === undefined ? 10 : 16);
      if (codePoint === 0 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new Error("SVG contains an invalid XML entity.");
      }
      return String.fromCodePoint(codePoint);
    },
  );
  if (/&(?:#|[a-z])/iu.test(decoded)) {
    throw new Error("SVG contains an unsupported XML entity.");
  }
  return decoded;
}
