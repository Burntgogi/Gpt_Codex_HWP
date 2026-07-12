import { extname } from "node:path";
import { resolveLocalPath } from "./paths.js";
export const MAX_INLINE_MARKDOWN_CHARACTERS = 64_000;
export const RECOMMENDED_CHUNK_CHARACTERS = 64_000;
export const MAX_MARKDOWN_OUTPUT_BYTES = 256 * 1024 * 1024;
export class MarkdownDeliveryError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "MarkdownDeliveryError";
    }
}
export function assertMarkdownOutputByteLength(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new MarkdownDeliveryError("MARKDOWN_OUTPUT_LIMIT", "Markdown output byte length is invalid.", {
            markdown_bytes: bytes,
            maximum_markdown_output_bytes: MAX_MARKDOWN_OUTPUT_BYTES,
        });
    }
    if (bytes > MAX_MARKDOWN_OUTPUT_BYTES) {
        throw new MarkdownDeliveryError("MARKDOWN_OUTPUT_LIMIT", `Extracted Markdown exceeds the ${MAX_MARKDOWN_OUTPUT_BYTES}-byte file-output limit.`, {
            markdown_bytes: bytes,
            maximum_markdown_output_bytes: MAX_MARKDOWN_OUTPUT_BYTES,
        });
    }
}
export function planMarkdownDelivery(markdown, outputPath) {
    const characters = markdown.length;
    const bytes = Buffer.byteLength(markdown, "utf8");
    if (outputPath === undefined) {
        if (characters > MAX_INLINE_MARKDOWN_CHARACTERS) {
            throw new MarkdownDeliveryError("RESPONSE_TOO_LARGE", "The extracted Markdown is too large for a context-safe inline response. Retry with markdown_output_path.", {
                markdown_characters: characters,
                markdown_bytes: bytes,
                maximum_inline_characters: MAX_INLINE_MARKDOWN_CHARACTERS,
                guidance: "Retry hwp_read with a new markdown_output_path.",
            });
        }
        return {
            inlineMarkdown: markdown,
            truncated: false,
            characters,
            bytes,
            recommendedChunkCharacters: RECOMMENDED_CHUNK_CHARACTERS,
        };
    }
    const resolvedOutputPath = resolveLocalPath(outputPath, "markdown_output_path");
    if (extname(resolvedOutputPath).toLocaleLowerCase("en-US") !== ".md") {
        throw new MarkdownDeliveryError("INVALID_MARKDOWN_OUTPUT_PATH", "markdown_output_path must use the .md extension.", { markdown_output_path: resolvedOutputPath });
    }
    assertMarkdownOutputByteLength(bytes);
    return {
        inlineMarkdown: markdown.slice(0, MAX_INLINE_MARKDOWN_CHARACTERS),
        truncated: characters > MAX_INLINE_MARKDOWN_CHARACTERS,
        outputPath: resolvedOutputPath,
        characters,
        bytes,
        recommendedChunkCharacters: RECOMMENDED_CHUNK_CHARACTERS,
    };
}
