import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, stat, writeFile, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { detectFormat, detectZipFormat, parse, placeSealHwpx, renderHwpxToSvg, scanSectionXml, validateHwpx, } from "kordoc";
import sharp from "sharp";
import { z } from "zod";
import { OutputConflictError, PathAliasError, UnsafeOutputPathError, writeFilesExclusively, } from "../shared/output.js";
import { MAX_IMAGE_BYTES as MAX_IMAGE_FILE_BYTES, readFileBounded, } from "../shared/files.js";
import { resolveLocalPath } from "../shared/paths.js";
import { inspectExactDocumentProtection } from "../shared/protection.js";
import { toolError, toolSuccess } from "../shared/result.js";
import { loadBoundedHwpxZip, } from "../shared/zip-preflight.js";
export const HWP_CREATE_SVG_ASSET_TOOL_NAME = "hwp_create_svg_asset";
export const HWP_INSERT_IMAGE_TOOL_NAME = "hwp_insert_image";
const MAX_SVG_BYTES = 1_000_000;
const MAX_SVG_DIMENSION = 4_096;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 10_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_ANCHOR_CHARACTERS = 10_000;
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const defaultSvgDependencies = {
    validateSvg: async (svg) => {
        await sharp(Buffer.from(svg), { limitInputPixels: MAX_IMAGE_PIXELS })
            .png({ compressionLevel: 9, adaptiveFiltering: false })
            .toBuffer();
    },
    renderSvgToPng: async (svg) => sharp(Buffer.from(svg), { limitInputPixels: MAX_IMAGE_PIXELS })
        .png({ compressionLevel: 9, adaptiveFiltering: false })
        .toBuffer(),
};
const defaultImageDependencies = {
    parseDocument: parse,
    placeSeal: placeSealHwpx,
    validateDocument: validateHwpx,
    renderDocument: renderHwpxToSvg,
    loadZip: async (bytes) => await JSZip.loadAsync(bytes),
};
export async function handleHwpCreateSvgAsset(input, dependencyOverrides = {}) {
    let svgPath;
    let pngPath;
    try {
        svgPath = resolveLocalPath(input.output_svg_path, "output_svg_path");
        pngPath = input.output_png_path === undefined
            ? undefined
            : resolveLocalPath(input.output_png_path, "output_png_path");
        if (pngPath !== undefined && comparablePath(svgPath) === comparablePath(pngPath)) {
            throw new PathAliasError("SVG and PNG output paths must be different.");
        }
        const dependencies = { ...defaultSvgDependencies, ...dependencyOverrides };
        const svg = buildSafeSvg(input.prompt_or_spec);
        await dependencies.validateSvg(svg);
        if (pngPath !== undefined) {
            await preflightOutputPath(pngPath, []);
            await preflightOutputPath(svgPath, []);
            try {
                const png = await dependencies.renderSvgToPng(svg);
                assertPngBytes(png);
                await writeFilesExclusively([
                    { path: svgPath, data: svg },
                    { path: pngPath, data: png },
                ]);
                return toolSuccess("Created standalone SVG and PNG assets.", {
                    svg_path: svgPath,
                    png_path: pngPath,
                    warnings: [],
                });
            }
            catch (error) {
                if (isOutputSafetyError(error)) {
                    throw error;
                }
                await preflightOutputPath(pngPath, []);
                await writeFilesExclusively([{ path: svgPath, data: svg }]);
                return toolSuccess("Created the SVG asset; PNG rendering was skipped.", {
                    svg_path: svgPath,
                    warnings: [`PNG rendering failed: ${errorMessage(error)}`],
                });
            }
        }
        await writeFilesExclusively([{ path: svgPath, data: svg }]);
        return toolSuccess("Created standalone SVG asset.", {
            svg_path: svgPath,
            warnings: [],
        });
    }
    catch (error) {
        const message = errorMessage(error);
        return toolError(`Could not create the SVG asset: ${message}`, {
            code: errorCode(error, "SVG_ASSET_ERROR"),
            error: message,
            svg_path: svgPath ?? safeResolvedPath(input.output_svg_path),
            png_path: pngPath ?? safeResolvedPath(input.output_png_path),
        });
    }
}
export async function handleHwpInsertImage(input, dependencyOverrides = {}) {
    let filePath;
    let imagePath;
    let outputPath;
    let workDirectory;
    let workDirectoryIdentity;
    try {
        const dependencies = { ...defaultImageDependencies, ...dependencyOverrides };
        filePath = resolveLocalPath(input.file_path, "file_path");
        imagePath = resolveLocalPath(input.image_path, "image_path");
        outputPath = resolveLocalPath(input.output_path, "output_path");
        if (input.anchor_text.trim().length === 0) {
            throw new AssetError("ANCHOR_REQUIRED", "anchor_text must not be empty.");
        }
        if (input.anchor_text.length > MAX_ANCHOR_CHARACTERS) {
            throw new AssetError("INPUT_TOO_LARGE", `anchor_text exceeds the ${MAX_ANCHOR_CHARACTERS}-character safety limit.`);
        }
        if (input.anchor_occurrence !== undefined && (!Number.isInteger(input.anchor_occurrence) || input.anchor_occurrence < 0)) {
            throw new AssetError("INVALID_ANCHOR_OCCURRENCE", "anchor_occurrence must be a nonnegative integer.");
        }
        if (input.size_mm !== undefined && (!Number.isFinite(input.size_mm) || input.size_mm < 1 || input.size_mm > 200)) {
            throw new AssetError("INVALID_IMAGE_SIZE", "size_mm must be between 1 and 200.");
        }
        const [sourceBytes, originalImageBytes] = await Promise.all([
            readFileBounded(filePath, "source document"),
            readFileBounded(imagePath, "source image", MAX_IMAGE_FILE_BYTES),
        ]);
        const sourceHash = sha256(sourceBytes);
        await preflightOutputPath(outputPath, [filePath, imagePath]);
        const sourceBuffer = exactArrayBuffer(sourceBytes);
        await assertEditableHwpx(sourceBuffer);
        const zip = await loadBoundedHwpxZip(sourceBytes, dependencies.loadZip);
        const protection = await inspectExactDocumentProtection(sourceBytes, "hwpx");
        if (protection !== undefined) {
            throw new AssetError(protection.code, protection.error);
        }
        workDirectory = await mkdtemp(join(tmpdir(), "hwp-image-insert-"));
        workDirectoryIdentity = await fileSystemIdentity(workDirectory);
        const sourceSnapshotPath = join(workDirectory, "source-snapshot.hwpx");
        await writeFile(sourceSnapshotPath, sourceBytes, { flag: "wx" });
        const sourceValidation = await dependencies.validateDocument(sourceBuffer);
        if (!sourceValidation.ok) {
            throw new AssetError("SOURCE_HWPX_INVALID", "Source HWPX failed structural validation and was not edited.", validationDetails(sourceValidation));
        }
        const preflight = await dependencies.parseDocument(sourceBuffer);
        if (!preflight.success) {
            throw new AssetError(preflight.code ?? "PARSE_ERROR", preflight.error);
        }
        const anchor = await selectAnchor(zip, input.anchor_text, input.anchor_occurrence);
        const normalized = await normalizeImage(originalImageBytes);
        const mode = input.mode ?? "after-paragraph";
        const normalizedImagePath = join(workDirectory, "normalized.png");
        const candidatePath = join(workDirectory, "candidate.hwpx");
        await writeFile(normalizedImagePath, normalized.bytes, { flag: "wx" });
        let candidate;
        let imageEntry;
        let changedSectionEntry;
        let placement;
        const warnings = [];
        if (mode === "seal-anchor") {
            const placed = await dependencies.placeSeal(sourceBuffer, [{
                    anchor: input.anchor_text,
                    occurrence: anchor.occurrence,
                    image: normalized.bytes,
                    ext: "png",
                    sizeMm: input.size_mm,
                }]);
            const firstPlacement = placed.placed[0];
            if (firstPlacement === undefined) {
                throw new AssetError("IMAGE_INSERTION_FAILED", "Kordoc returned no seal placement.");
            }
            candidate = new Uint8Array(placed.buffer);
            imageEntry = firstPlacement.entry;
            placement = { ...firstPlacement };
            warnings.push(...(firstPlacement.warnings ?? []));
            await writeFile(candidatePath, candidate, { flag: "wx" });
        }
        else if (mode === "after-paragraph") {
            const script = helperScriptPath("insert_image.py");
            const args = [
                sourceSnapshotPath,
                candidatePath,
                "--image",
                normalizedImagePath,
                "--anchor-text",
                input.anchor_text,
                "--occurrence",
                String(anchor.occurrence),
            ];
            if (input.size_mm !== undefined) {
                args.push("--width-mm", String(input.size_mm));
            }
            const inserted = await runPython(script, args);
            const metadata = parseHelperJson(inserted.stdout);
            if (metadata.ok !== true || typeof metadata.image_entry !== "string") {
                throw new AssetError("IMAGE_INSERTION_FAILED", "Image helper returned incomplete metadata.");
            }
            imageEntry = metadata.image_entry;
            if (!Number.isSafeInteger(metadata.section_index) || Number(metadata.section_index) < 0) {
                throw new AssetError("IMAGE_INSERTION_FAILED", "Image helper returned an invalid section index.");
            }
            changedSectionEntry = `Contents/section${String(metadata.section_index)}.xml`;
            if (Array.isArray(metadata.warnings)) {
                warnings.push(...metadata.warnings.filter((value) => typeof value === "string"));
            }
            candidate = await readFile(candidatePath);
        }
        else {
            throw new AssetError("INVALID_IMAGE_MODE", `Unsupported image insertion mode: ${String(mode)}`);
        }
        if (mode === "after-paragraph") {
            await runVerifier(candidatePath, sourceSnapshotPath, {
                changed: ["Contents/content.hpf", changedSectionEntry],
                added: [imageEntry],
            });
        }
        else {
            await runVerifier(candidatePath);
        }
        const validation = await dependencies.validateDocument(candidate);
        if (!validation.ok) {
            throw new AssetError("HWPX_VALIDATION_FAILED", "Inserted HWPX failed structural validation.", validation);
        }
        const reparsed = await dependencies.parseDocument(exactArrayBuffer(candidate));
        if (!reparsed.success) {
            throw new AssetError(reparsed.code ?? "PARSE_ERROR", reparsed.error);
        }
        const beforeImages = countImages(preflight.blocks);
        const afterImages = countImages(reparsed.blocks);
        if (afterImages !== beforeImages + 1) {
            throw new AssetError("IMAGE_COUNT_MISMATCH", `Expected one inserted image, but image count changed from ${beforeImages} to ${afterImages}.`);
        }
        const preview = await dependencies.renderDocument(candidate, { reflow: true });
        if (preview.svg.trim().length === 0) {
            throw new AssetError("PREVIEW_VALIDATION_FAILED", "Inserted HWPX rendered an empty SVG preview.");
        }
        warnings.push(...preview.warnings);
        if (sha256(await readFileBounded(filePath, "source document")) !== sourceHash) {
            throw new AssetError("SOURCE_CHANGED", "The source document changed during image insertion.");
        }
        await writeFilesExclusively([{ path: outputPath, data: candidate }], { sourcePaths: [filePath, imagePath] });
        return toolSuccess("Inserted a PNG image into a structurally validated HWPX document.", {
            output_path: outputPath,
            mode,
            image_entry: imageEntry,
            ...(placement === undefined ? {} : { placement }),
            warnings,
            validation: validationDetails(validation),
        });
    }
    catch (error) {
        const message = errorMessage(error);
        const extra = error instanceof AssetError && error.details !== undefined
            ? { details: error.details }
            : {};
        return toolError(`Could not insert the image: ${message}`, {
            code: errorCode(error, "IMAGE_INSERTION_ERROR"),
            error: message,
            file_path: filePath ?? safeResolvedPath(input.file_path),
            image_path: imagePath ?? safeResolvedPath(input.image_path),
            output_path: outputPath ?? safeResolvedPath(input.output_path),
            ...extra,
        });
    }
    finally {
        if (workDirectory !== undefined && workDirectoryIdentity !== undefined) {
            await removeOwnedTemporaryDirectory(workDirectory, workDirectoryIdentity).catch(() => undefined);
        }
    }
}
export function registerHwpCreateSvgAsset(server) {
    server.registerTool(HWP_CREATE_SVG_ASSET_TOOL_NAME, {
        title: "Create a safe SVG visual asset",
        description: "Create a standalone SVG from sanitized inline SVG or a documented JSON shape specification, with an optional PNG rendering.",
        inputSchema: {
            prompt_or_spec: z
                .string()
                .min(1)
                .max(MAX_SVG_BYTES)
                .describe("Sanitized inline <svg>, or JSON {width,height,viewBox?,background?,elements:[rect|circle|ellipse|line|text|path|polyline]}; shape coordinates use camelCase such as strokeWidth, fontSize, textAnchor."),
            output_svg_path: z.string().min(1),
            output_png_path: z.string().min(1).optional(),
        },
        annotations: { readOnlyHint: false },
    }, (args) => handleHwpCreateSvgAsset(args));
}
export function registerHwpInsertImage(server) {
    server.registerTool(HWP_INSERT_IMAGE_TOOL_NAME, {
        title: "Insert an image into HWPX",
        description: "Normalize a local image to PNG and insert it into a new, structurally validated HWPX after an anchor paragraph or as a seal overlay.",
        inputSchema: {
            file_path: z.string().min(1),
            image_path: z.string().min(1),
            output_path: z.string().min(1),
            anchor_text: z.string().min(1).max(MAX_ANCHOR_CHARACTERS),
            mode: z.enum(["after-paragraph", "seal-anchor"]).optional(),
            size_mm: z.number().finite().min(1).max(200).optional(),
            anchor_occurrence: z.number().int().nonnegative().optional(),
        },
        annotations: { readOnlyHint: false },
    }, (args) => handleHwpInsertImage(args));
}
async function normalizeImage(input) {
    if (input.byteLength === 0 || input.byteLength > MAX_IMAGE_BYTES) {
        throw new AssetError("INVALID_IMAGE", `Image input must be between 1 and ${MAX_IMAGE_BYTES} bytes.`);
    }
    let source = input;
    const prefix = input.subarray(0, Math.min(input.byteLength, MAX_SVG_BYTES + 1));
    if ((prefix[0] === 0xff && prefix[1] === 0xfe) ||
        (prefix[0] === 0xfe && prefix[1] === 0xff) ||
        (prefix[0] === 0x00 && prefix[1] === 0x3c) ||
        (prefix[0] === 0x3c && prefix[1] === 0x00)) {
        throw new AssetError("UNSAFE_SVG", "UTF-16 XML/SVG image input is not supported safely.");
    }
    const decoded = Buffer.from(input).toString("utf8").replace(/^\uFEFF/u, "");
    if (decoded.trimStart().startsWith("<")) {
        source = Buffer.from(sanitizeInlineSvg(decoded));
    }
    try {
        const image = sharp(source, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS });
        const metadata = await image.metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (width < 1 ||
            height < 1 ||
            width > MAX_IMAGE_DIMENSION ||
            height > MAX_IMAGE_DIMENSION ||
            width * height > MAX_IMAGE_PIXELS ||
            (metadata.pages ?? 1) !== 1) {
            throw new Error("unsafe image dimensions or animation");
        }
        const rendered = await image
            .rotate()
            .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
            .toBuffer({ resolveWithObject: true });
        if (rendered.data.byteLength > MAX_IMAGE_BYTES) {
            throw new Error("normalized PNG exceeds the size limit");
        }
        assertPngBytes(rendered.data);
        return {
            bytes: rendered.data,
            width: rendered.info.width,
            height: rendered.info.height,
        };
    }
    catch (error) {
        if (error instanceof AssetError)
            throw error;
        throw new AssetError("INVALID_IMAGE", `Image could not be decoded safely: ${errorMessage(error)}`);
    }
}
async function assertEditableHwpx(buffer) {
    try {
        if (detectFormat(buffer) !== "hwpx" || (await detectZipFormat(buffer)) !== "hwpx") {
            throw new Error("not an HWPX package");
        }
    }
    catch (error) {
        throw new AssetError("UNSUPPORTED_IMAGE_DOCUMENT_FORMAT", `Image insertion supports only a valid HWPX package: ${errorMessage(error)}`);
    }
}
async function selectAnchor(zip, anchorText, requestedOccurrence) {
    const sectionNames = Object.keys(zip.files)
        .filter((name) => /(?:^|\/)section\d+\.xml$/iu.test(name))
        .sort((a, b) => sectionNumber(a) - sectionNumber(b));
    let matchCount = 0;
    for (const [index, name] of sectionNames.entries()) {
        const xml = await zip.file(name).async("text");
        const scan = scanSectionXml(xml, index);
        const paragraphs = eligibleParagraphs(scan.bodyParagraphs, scan.tables);
        for (const paragraph of paragraphs) {
            let from = 0;
            while (from <= paragraph.text.length) {
                const found = paragraph.text.indexOf(anchorText, from);
                if (found < 0)
                    break;
                if (requestedOccurrence === matchCount) {
                    return { occurrence: matchCount };
                }
                matchCount += 1;
                if (requestedOccurrence === undefined && matchCount > 1) {
                    throw new AssetError("AMBIGUOUS_ANCHOR", "Anchor text occurs more than once; set anchor_occurrence to a 0-based occurrence.", { anchor_count_at_least: 2 });
                }
                from = found + Math.max(1, anchorText.length);
            }
        }
    }
    if (matchCount === 0) {
        throw new AssetError("ANCHOR_NOT_FOUND", `Anchor text was not found: ${anchorText}`);
    }
    const occurrence = requestedOccurrence ?? 0;
    if (occurrence >= matchCount) {
        throw new AssetError("ANCHOR_NOT_FOUND", `anchor_occurrence ${occurrence} is outside 0..${matchCount - 1}.`, { anchor_count: matchCount });
    }
    return { occurrence };
}
function eligibleParagraphs(body, tables) {
    const paragraphs = [...body];
    const walk = (nestedTables) => {
        for (const table of nestedTables) {
            for (const row of table.rows) {
                for (const cell of row) {
                    paragraphs.push(...cell.paragraphs);
                    walk(cell.tables);
                }
            }
        }
    };
    walk(tables);
    const byStart = new Map();
    for (const paragraph of paragraphs) {
        if (paragraph.kind !== "excluded")
            byStart.set(paragraph.start, paragraph);
    }
    return [...byStart.values()].sort((a, b) => a.start - b.start);
}
function buildSafeSvg(input) {
    if (Buffer.byteLength(input, "utf8") > MAX_SVG_BYTES) {
        throw new AssetError("UNSAFE_SVG", "SVG input exceeds the 1 MB safety limit.");
    }
    const trimmed = input.trim();
    if (/<!DOCTYPE|<!ENTITY/iu.test(trimmed)) {
        throw new AssetError("UNSAFE_SVG", "SVG contains a document type or entity declaration.");
    }
    if (/^(?:<\?xml\b[^>]*>\s*)?<svg\b/iu.test(trimmed)) {
        return sanitizeInlineSvg(trimmed);
    }
    let value;
    try {
        value = JSON.parse(trimmed);
    }
    catch {
        throw new AssetError("INVALID_SVG_SPEC", "prompt_or_spec must be inline SVG or a JSON SVG specification.");
    }
    return renderStructuredSvg(value);
}
function sanitizeInlineSvg(svg) {
    if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) {
        throw new AssetError("UNSAFE_SVG", "SVG input exceeds the 1 MB safety limit.");
    }
    if (/<!DOCTYPE|<!ENTITY/iu.test(svg) ||
        /<!--|<!\[CDATA\[|<\?(?!xml\s)/iu.test(svg) ||
        /<(?:script|style|foreignObject|iframe|object|embed|animate|animateMotion|animateTransform|set|discard)\b/iu.test(svg) ||
        /\son[a-z][a-z0-9_-]*\s*=/iu.test(svg) ||
        /\sstyle\s*=/iu.test(svg) ||
        /\s(?:href|src|xlink:href)\s*=/iu.test(svg) ||
        /url\s*\(|javascript\s*:|data\s*:/iu.test(svg)) {
        throw new AssetError("UNSAFE_SVG", "SVG contains active or external content.");
    }
    assertSafeInlineSvgVocabulary(svg);
    const root = svg.match(/<svg\b([^>]*)>/iu);
    if (root === null) {
        throw new AssetError("UNSAFE_SVG", "Inline SVG must have an svg root element.");
    }
    const width = numericSvgDimension(root[1] ?? "", "width");
    const height = numericSvgDimension(root[1] ?? "", "height");
    assertSafeDimensions(width, height);
    if (!/<\/svg>\s*$/iu.test(svg)) {
        throw new AssetError("UNSAFE_SVG", "Inline SVG root must be closed.");
    }
    const namespace = (root[1] ?? "").match(/\sxmlns\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (namespace !== undefined && namespace !== "http://www.w3.org/2000/svg") {
        throw new AssetError("UNSAFE_SVG", "Inline SVG uses an unexpected default namespace.");
    }
    if (namespace !== undefined)
        return svg;
    return svg.replace(/<svg\b/iu, '<svg xmlns="http://www.w3.org/2000/svg"');
}
function assertSafeInlineSvgVocabulary(svg) {
    if (/<\/?\s*[A-Za-z_][\w.-]*:/u.test(svg) ||
        /\s(?:xmlns:[A-Za-z_][\w.-]*|[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)\s*=/u.test(svg)) {
        throw new AssetError("UNSAFE_SVG", "Prefixed SVG elements, attributes, and namespace aliases are not allowed.");
    }
    const allowedElements = new Set([
        "svg",
        "g",
        "rect",
        "circle",
        "ellipse",
        "line",
        "text",
        "tspan",
        "path",
        "polyline",
        "polygon",
        "title",
        "desc",
    ]);
    for (const match of svg.matchAll(/<\/?\s*([A-Za-z_][\w.-]*)\b/gu)) {
        if (!allowedElements.has(match[1])) {
            throw new AssetError("UNSAFE_SVG", `Inline SVG element is not allowed: ${match[1]}`);
        }
    }
    inspectDecodedSvg(svg, allowedElements);
}
function inspectDecodedSvg(svg, allowedElements) {
    let document;
    try {
        document = new DOMParser({
            onError: (_level, message) => {
                throw new Error(message);
            },
        }).parseFromString(svg, "image/svg+xml");
    }
    catch (error) {
        throw new AssetError("UNSAFE_SVG", `Inline SVG is not well-formed XML: ${errorMessage(error)}`);
    }
    const root = document.documentElement;
    if (root === null || root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") {
        throw new AssetError("UNSAFE_SVG", "Inline SVG root must use the standard SVG namespace.");
    }
    inspectSvgElement(root, allowedElements);
}
const SVG_GLOBAL_ATTRIBUTES = new Set([
    "id", "class", "transform", "fill", "stroke", "stroke-width", "opacity",
    "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
    "stroke-dasharray", "stroke-dashoffset", "vector-effect",
]);
const SVG_ELEMENT_ATTRIBUTES = {
    svg: new Set(["xmlns", "width", "height", "viewBox", "preserveAspectRatio"]),
    g: new Set(),
    rect: new Set(["x", "y", "width", "height", "rx", "ry"]),
    circle: new Set(["cx", "cy", "r"]),
    ellipse: new Set(["cx", "cy", "rx", "ry"]),
    line: new Set(["x1", "y1", "x2", "y2"]),
    text: new Set(["x", "y", "dx", "dy", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline"]),
    tspan: new Set(["x", "y", "dx", "dy", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline"]),
    path: new Set(["d", "pathLength"]),
    polyline: new Set(["points", "pathLength"]),
    polygon: new Set(["points", "pathLength"]),
    title: new Set(),
    desc: new Set(),
};
function inspectSvgElement(element, allowedElements) {
    const name = element.localName;
    if (name === null || element.namespaceURI !== "http://www.w3.org/2000/svg" || element.prefix !== null || !allowedElements.has(name)) {
        throw new AssetError("UNSAFE_SVG", `Inline SVG element is not allowed: ${element.nodeName}`);
    }
    const elementAttributes = SVG_ELEMENT_ATTRIBUTES[name] ?? new Set();
    for (let index = 0; index < element.attributes.length; index += 1) {
        const attribute = element.attributes.item(index);
        if (attribute === null)
            continue;
        const isDefaultNamespace = attribute.name === "xmlns";
        if ((!isDefaultNamespace && attribute.prefix !== null) ||
            (!SVG_GLOBAL_ATTRIBUTES.has(attribute.name) && !elementAttributes.has(attribute.name))) {
            throw new AssetError("UNSAFE_SVG", `Inline SVG attribute is not allowed: ${attribute.name}`);
        }
        const value = attribute.value;
        if (isDefaultNamespace) {
            if (value !== "http://www.w3.org/2000/svg") {
                throw new AssetError("UNSAFE_SVG", "Inline SVG uses an unexpected namespace.");
            }
        }
        else if (/url\s*\(|javascript\s*:|data\s*:|https?\s*:|file\s*:|\\\\|\/\//iu.test(value)) {
            throw new AssetError("UNSAFE_SVG", `Inline SVG attribute contains an external or active value: ${attribute.name}`);
        }
    }
    for (let child = element.firstChild; child !== null; child = child.nextSibling) {
        if (child.nodeType === 1) {
            inspectSvgElement(child, allowedElements);
        }
        else if (child.nodeType !== 3) {
            throw new AssetError("UNSAFE_SVG", "Inline SVG contains a non-text, non-element node.");
        }
    }
}
function renderStructuredSvg(value) {
    if (!isRecord(value)) {
        throw new AssetError("INVALID_SVG_SPEC", "Structured SVG spec must be a JSON object.");
    }
    const width = safeNumber(value.width, "width", 1, MAX_SVG_DIMENSION);
    const height = safeNumber(value.height, "height", 1, MAX_SVG_DIMENSION);
    assertSafeDimensions(width, height);
    const viewBox = value.viewBox === undefined
        ? `0 0 ${formatNumber(width)} ${formatNumber(height)}`
        : safeViewBox(value.viewBox);
    const elements = Array.isArray(value.elements) ? value.elements : [];
    if (elements.length > 1_000) {
        throw new AssetError("INVALID_SVG_SPEC", "Structured SVG spec has too many elements.");
    }
    const body = [];
    if (value.background !== undefined) {
        body.push(`<rect x="0" y="0" width="100%" height="100%" fill="${escapeXml(safePaint(value.background, "background"))}"/>`);
    }
    body.push(...elements.map(renderSvgElement));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(width)}" height="${formatNumber(height)}" viewBox="${escapeXml(viewBox)}">${body.join("")}</svg>`;
}
function renderSvgElement(value) {
    if (!isRecord(value) || typeof value.type !== "string") {
        throw new AssetError("INVALID_SVG_SPEC", "Each SVG element must have a supported type.");
    }
    const type = value.type;
    const paint = commonPaintAttributes(value);
    switch (type) {
        case "rect":
            return `<rect x="${n(value.x, "x")}" y="${n(value.y, "y")}" width="${positive(value.width, "width")}" height="${positive(value.height, "height")}"${optionalNumberAttr("rx", value.rx)}${paint}/>`;
        case "circle":
            return `<circle cx="${n(value.cx, "cx")}" cy="${n(value.cy, "cy")}" r="${positive(value.r, "r")}"${paint}/>`;
        case "ellipse":
            return `<ellipse cx="${n(value.cx, "cx")}" cy="${n(value.cy, "cy")}" rx="${positive(value.rx, "rx")}" ry="${positive(value.ry, "ry")}"${paint}/>`;
        case "line":
            return `<line x1="${n(value.x1, "x1")}" y1="${n(value.y1, "y1")}" x2="${n(value.x2, "x2")}" y2="${n(value.y2, "y2")}"${paint}/>`;
        case "text": {
            if (typeof value.text !== "string" || value.text.length > 10_000) {
                throw new AssetError("INVALID_SVG_SPEC", "text elements require a bounded text string.");
            }
            const fontSize = value.fontSize === undefined ? "16" : positive(value.fontSize, "fontSize");
            const anchor = value.textAnchor === undefined ? "start" : enumString(value.textAnchor, ["start", "middle", "end"], "textAnchor");
            return `<text x="${n(value.x, "x")}" y="${n(value.y, "y")}" font-size="${fontSize}" text-anchor="${anchor}"${paint}>${escapeXml(value.text)}</text>`;
        }
        case "path": {
            if (typeof value.d !== "string" || value.d.length > 100_000 || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/u.test(value.d)) {
                throw new AssetError("INVALID_SVG_SPEC", "path.d contains unsupported content.");
            }
            return `<path d="${escapeXml(value.d)}"${paint}/>`;
        }
        case "polyline": {
            if (typeof value.points !== "string" || value.points.length > 100_000 || !/^[0-9eE+.,\s-]+$/u.test(value.points)) {
                throw new AssetError("INVALID_SVG_SPEC", "polyline.points contains unsupported content.");
            }
            return `<polyline points="${escapeXml(value.points)}"${paint}/>`;
        }
        default:
            throw new AssetError("INVALID_SVG_SPEC", `Unsupported SVG element type: ${type}`);
    }
}
function commonPaintAttributes(value) {
    const attributes = [];
    for (const [key, attr] of [["fill", "fill"], ["stroke", "stroke"]]) {
        if (value[key] !== undefined)
            attributes.push(`${attr}="${escapeXml(safePaint(value[key], key))}"`);
    }
    if (value.strokeWidth !== undefined)
        attributes.push(`stroke-width="${positive(value.strokeWidth, "strokeWidth")}"`);
    if (value.opacity !== undefined)
        attributes.push(`opacity="${formatNumber(safeNumber(value.opacity, "opacity", 0, 1))}"`);
    return attributes.length === 0 ? "" : ` ${attributes.join(" ")}`;
}
function safePaint(value, label) {
    if (typeof value !== "string" || value.length > 128 || !/^(?:none|transparent|currentColor|#[0-9a-f]{3,8}|rgba?\([0-9.,%\s]+\)|[a-z]+)$/iu.test(value)) {
        throw new AssetError("INVALID_SVG_SPEC", `${label} is not a safe SVG paint value.`);
    }
    return value;
}
function safeViewBox(value) {
    if (typeof value !== "string" || !/^-?[0-9.eE+]+(?:\s+-?[0-9.eE+]+){3}$/u.test(value.trim())) {
        throw new AssetError("INVALID_SVG_SPEC", "viewBox must contain four finite numbers.");
    }
    const numbers = value.trim().split(/\s+/u).map(Number);
    if (numbers.some((number) => !Number.isFinite(number)) || numbers[2] <= 0 || numbers[3] <= 0) {
        throw new AssetError("INVALID_SVG_SPEC", "viewBox dimensions must be positive and finite.");
    }
    return numbers.map(formatNumber).join(" ");
}
function numericSvgDimension(attributes, name) {
    const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([0-9]+(?:\\.[0-9]+)?)(?:px)?["']`, "iu"));
    if (match === null)
        throw new AssetError("UNSAFE_SVG", `Inline SVG requires a numeric ${name}.`);
    return Number(match[1]);
}
function assertSafeDimensions(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > MAX_SVG_DIMENSION || height > MAX_SVG_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
        throw new AssetError("UNSAFE_SVG", "SVG dimensions exceed safe limits.");
    }
}
async function preflightOutputPath(outputPath, sourcePaths) {
    const comparableOutput = comparablePath(outputPath);
    if (sourcePaths.some((source) => comparablePath(source) === comparableOutput)) {
        throw new PathAliasError("A source path and output path must be different.");
    }
    let outputLink;
    try {
        outputLink = await lstat(outputPath);
    }
    catch (error) {
        if (errorCode(error, "") === "ENOENT")
            return;
        throw error;
    }
    for (const sourcePath of sourcePaths) {
        const [source, output] = await Promise.all([
            stat(sourcePath, { bigint: true }),
            stat(outputPath, { bigint: true }).catch(() => undefined),
        ]);
        if (output !== undefined && source.dev === output.dev && source.ino === output.ino) {
            throw new PathAliasError(`Output path aliases a source file: ${sourcePath}`);
        }
    }
    void outputLink;
    throw new OutputConflictError(outputPath);
}
async function runVerifier(editedPath, originalPath, allowlist = {
    changed: [],
    added: [],
}) {
    const script = helperScriptPath("verify.py");
    const args = [editedPath];
    if (originalPath !== undefined) {
        args.push("--orig", originalPath);
    }
    for (const entry of allowlist.changed) {
        args.push("--allow-changed", entry);
    }
    for (const entry of allowlist.added) {
        args.push("--allow-added", entry);
    }
    await runPython(script, args);
}
function helperScriptPath(name) {
    return fileURLToPath(new URL(`../../scripts/hwpx-safe-edit/${name}`, import.meta.url));
}
export function pythonCommandCandidates(platform = process.platform) {
    return platform === "win32"
        ? [
            { command: "python", argsPrefix: ["-X", "utf8"] },
            { command: "py", argsPrefix: ["-3", "-X", "utf8"] },
        ]
        : [
            { command: "python3", argsPrefix: ["-X", "utf8"] },
            { command: "python", argsPrefix: ["-X", "utf8"] },
        ];
}
export async function runPython(script, args, platform = process.platform, execute = execFilePromise) {
    for (const candidate of pythonCommandCandidates(platform)) {
        try {
            return await execute(candidate.command, [...candidate.argsPrefix, script, ...args], script);
        }
        catch (error) {
            if (errorCode(error, "") !== "ENOENT") {
                throw helperFailure(error);
            }
        }
    }
    throw new AssetError("PYTHON_NOT_FOUND", "Python 3.10 or newer was not found on PATH.");
}
function execFilePromise(command, args, script) {
    return new Promise((resolvePromise, rejectPromise) => {
        execFile(command, args, {
            cwd: dirname(script),
            windowsHide: true,
            shell: false,
            timeout: 20_000,
            maxBuffer: 1_000_000,
            encoding: "utf8",
            env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        }, (error, stdout, stderr) => {
            if (error !== null) {
                Object.assign(error, { stdout, stderr });
                rejectPromise(error);
            }
            else {
                resolvePromise({ stdout, stderr });
            }
        });
    });
}
function helperFailure(error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const failure = new AssetError("HWPX_SAFE_EDIT_FAILED", stderr.length > 0 ? stderr : errorMessage(error));
    return failure;
}
function parseHelperJson(stdout) {
    const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(lines[index]);
            if (isRecord(parsed))
                return parsed;
        }
        catch {
            // Keep scanning in case the helper emitted diagnostics before JSON.
        }
    }
    throw new AssetError("HWPX_SAFE_EDIT_FAILED", "Image helper did not return JSON metadata.");
}
function validationDetails(validation) {
    return {
        ok: validation.ok,
        issues: validation.issues.map((issue) => ({ ...issue })),
        entry_count: validation.entryCount,
    };
}
function assertPngBytes(bytes) {
    if (bytes.byteLength < PNG_MAGIC.byteLength || !PNG_MAGIC.every((byte, index) => bytes[index] === byte)) {
        throw new AssetError("PNG_RENDER_FAILED", "Renderer did not return PNG bytes.");
    }
}
class AssetError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "AssetError";
    }
}
function safeNumber(value, label, minimum, maximum) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new AssetError("INVALID_SVG_SPEC", `${label} must be between ${minimum} and ${maximum}.`);
    }
    return value;
}
function n(value, label) {
    return formatNumber(safeNumber(value, label, -100_000, 100_000));
}
function positive(value, label) {
    return formatNumber(safeNumber(value, label, 0.000_001, 100_000));
}
function optionalNumberAttr(name, value) {
    return value === undefined ? "" : ` ${name}="${positive(value, name)}"`;
}
function enumString(value, allowed, label) {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new AssetError("INVALID_SVG_SPEC", `${label} has an unsupported value.`);
    }
    return value;
}
function formatNumber(value) {
    return Number(value.toFixed(6)).toString();
}
function escapeXml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
function countImages(blocks) {
    let count = 0;
    for (const block of blocks) {
        if (block.type === "image")
            count += 1;
        if (block.children !== undefined)
            count += countImages(block.children);
        if (block.table !== undefined) {
            for (const row of block.table.cells) {
                for (const cell of row) {
                    if (cell.blocks !== undefined)
                        count += countImages(cell.blocks);
                }
            }
        }
    }
    return count;
}
function sectionNumber(path) {
    return Number(path.match(/section(\d+)\.xml$/iu)?.[1] ?? 0);
}
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function comparablePath(path) {
    return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}
function safeResolvedPath(value) {
    try {
        return typeof value === "string" ? resolveLocalPath(value) : undefined;
    }
    catch {
        return undefined;
    }
}
function isOutputSafetyError(error) {
    return error instanceof OutputConflictError ||
        error instanceof PathAliasError ||
        error instanceof UnsafeOutputPathError;
}
async function fileSystemIdentity(path) {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new UnsafeOutputPathError(`Temporary workspace is not an owned directory: ${path}`);
    }
    return { device: stats.dev, inode: stats.ino };
}
async function removeOwnedTemporaryDirectory(path, identity) {
    let current;
    try {
        current = await lstat(path, { bigint: true });
    }
    catch (error) {
        if (errorCode(error, "") === "ENOENT")
            return;
        throw error;
    }
    if (!current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.device ||
        current.ino !== identity.inode) {
        return;
    }
    await rm(path, { recursive: true, force: true });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function errorCode(error, fallback) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error.code.length > 0) {
        return error.code;
    }
    return fallback;
}
