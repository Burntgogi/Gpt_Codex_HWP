// Kordoc's Markdown-to-HWPX converter treats an underscore inside a word as
// emphasis, so "Gpt_Codex_HWP" became "Gpt" + italic "Codex" + "HWP" with the
// underscores lost. CommonMark never opens or closes "_" emphasis inside a
// word, so escaping only those underscores keeps the intended text while
// "_word_" emphasis at word boundaries still works.
//
// This applies to generation only. hwp_patch_document inserts edited text
// literally, where an escape would leave a visible backslash.
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const INTRAWORD_UNDERSCORES = /(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu;
// Inline code spans, autolinks, link destinations, and bare URLs keep their
// underscores verbatim.
const PROTECTED_INLINE = /(`+)[\s\S]*?\1|<[a-z][a-z0-9+.-]*:[^>\s]*>|\]\([^)\s]*\)|\bhttps?:\/\/\S+/giu;
export function escapeIntrawordUnderscores(markdown) {
    const lines = markdown.split("\n");
    let fence;
    for (const [index, line] of lines.entries()) {
        const marker = FENCE.exec(line)?.[1];
        if (fence !== undefined) {
            if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
                fence = undefined;
            }
            continue;
        }
        if (marker !== undefined) {
            fence = marker;
            continue;
        }
        lines[index] = escapeLine(line);
    }
    return lines.join("\n");
}
function escapeLine(line) {
    if (!line.includes("_"))
        return line;
    let result = "";
    let last = 0;
    for (const match of line.matchAll(PROTECTED_INLINE)) {
        result += escapeText(line.slice(last, match.index));
        result += match[0];
        last = match.index + match[0].length;
    }
    return result + escapeText(line.slice(last));
}
function escapeText(text) {
    return text.replace(INTRAWORD_UNDERSCORES, (run) => "\\_".repeat(run.length));
}
