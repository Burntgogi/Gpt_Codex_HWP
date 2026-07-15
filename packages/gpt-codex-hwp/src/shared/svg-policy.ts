const MAX_SVG_TAG_CHARACTERS = 64 * 1024;
const EDGE_CHARACTERS = 1024;

export class IncrementalSvgPolicyValidator {
  #leading = "";
  #trailing = "";
  #tag = "";
  #quote: "\"" | "'" | undefined;
  #tagCount = 0;
  #rootSelfClosing = false;
  #closedRoot = false;

  push(text: string): void {
    if (text.length === 0) return;
    if (this.#leading.length < EDGE_CHARACTERS) {
      this.#leading = (this.#leading + text).slice(0, EDGE_CHARACTERS);
    }
    this.#trailing = (this.#trailing + text).slice(-EDGE_CHARACTERS);
    let offset = 0;
    while (offset < text.length) {
      if (this.#tag.length === 0) {
        const start = text.indexOf("<", offset);
        if (start === -1) return;
        this.#tag = "<";
        offset = start + 1;
      }
      while (offset < text.length && this.#tag.length > 0) {
        const character = text[offset++]!;
        this.#appendTag(character);
        if (this.#quote !== undefined) {
          if (character === this.#quote) this.#quote = undefined;
          continue;
        }
        if (character === "\"" || character === "'") {
          this.#quote = character;
          continue;
        }
        if (character === ">") {
          inspectSvgTag(this.#tag);
          if (this.#tagCount === 0 && /^<\s*svg\b[^<>]*\/\s*>$/iu.test(this.#tag)) {
            this.#rootSelfClosing = true;
          }
          if (/^<\s*\/\s*svg\s*>$/iu.test(this.#tag)) this.#closedRoot = true;
          this.#tagCount += 1;
          this.#tag = "";
        }
      }
    }
  }

  finish(): void {
    const endsWithClosingRoot = /<\/svg\s*>\s*$/iu.test(this.#trailing);
    const endsWithSelfClosingRoot = /\/\s*>\s*$/u.test(this.#trailing);
    if (this.#tag.length !== 0 || !/^\s*<svg\b/iu.test(this.#leading) ||
      (!(this.#closedRoot && endsWithClosingRoot) &&
        !(this.#rootSelfClosing && this.#tagCount === 1 && endsWithSelfClosingRoot))) {
      throw new Error("SVG structure is invalid.");
    }
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

function inspectSvgTag(tag: string): void {
  const lower = tag.toLocaleLowerCase("en-US");
  if (/^<\s*\/?\s*(?:[a-z_][\w.-]*:)?(?:script|foreignobject|style)\b/u.test(lower) ||
    /\bon[a-z][\w:.-]*\s*=/u.test(lower) ||
    /j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/u.test(lower) ||
    /@import\b/u.test(lower)) {
    throw new Error("SVG active content is not allowed.");
  }

  for (const match of lower.matchAll(
    /\b(?:href|xlink:href|src)\s*=\s*(["'])(.*?)\1/gu,
  )) {
    const value = match[2]!.trim();
    if (value.length > 0 && !value.startsWith("#") &&
      !/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/u.test(value)) {
      throw new Error("SVG external references are not allowed.");
    }
  }
  for (const match of lower.matchAll(/\burl\s*\(\s*(["']?)(.*?)\1\s*\)/gu)) {
    if (!match[2]!.trim().startsWith("#")) {
      throw new Error("SVG external URL references are not allowed.");
    }
  }
}
