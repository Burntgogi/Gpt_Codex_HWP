import { lstat, stat, } from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import sharp from "sharp";
import { z } from "zod";
import { defaultDocumentEngineFacade, } from "../shared/document-engine.js";
import { openDocumentSnapshot, } from "../shared/document-snapshot.js";
import { OutputConflictError, PathAliasError, writeFilesExclusively, } from "../shared/output.js";
import { HwpxOutputRequiredError, assertHwpxOutputPath, } from "../shared/document-contract.js";
import { MAX_IMAGE_BYTES as MAX_IMAGE_FILE_BYTES, } from "../shared/files.js";
import { resolveLocalPath } from "../shared/paths.js";
import { authorizeExistingPath, authorizeFuturePath, } from "../shared/allowed-roots.js";
import { commitBudgetedToolSuccess, toolError, } from "../shared/result.js";
import { requireToolNotCancelled, runWithToolExecutionContext, toDocumentEngineExecutionContext, } from "../shared/tool-context.js";
export const HWP_CREATE_SVG_ASSET_TOOL_NAME = "hwp_create_svg_asset";
export const HWP_INSERT_IMAGE_TOOL_NAME = "hwp_insert_image";
const MAX_SVG_BYTES = 1_000_000;
const MAX_SVG_DIMENSION = 4_096;
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
export async function handleHwpCreateSvgAsset(input, dependencyOverrides = {}, context) {
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
            let png;
            let pngRenderError;
            try {
                png = await dependencies.renderSvgToPng(svg);
                assertPngBytes(png);
            }
            catch (error) {
                pngRenderError = error;
            }
            if (png !== undefined) {
                return await commitBudgetedToolSuccess("Created standalone SVG and PNG assets.", {
                    svg_path: svgPath,
                    png_path: pngPath,
                    warnings: [],
                }, async () => {
                    await writeFilesExclusively([
                        { path: svgPath, data: svg },
                        { path: pngPath, data: png },
                    ], { beforeOpen: async () => requireToolNotCancelled(context) });
                });
            }
            await preflightOutputPath(pngPath, []);
            return await commitBudgetedToolSuccess("Created the SVG asset; PNG rendering was skipped.", {
                svg_path: svgPath,
                warnings: [`PNG rendering failed: ${errorMessage(pngRenderError)}`],
            }, async () => {
                await writeFilesExclusively([{ path: svgPath, data: svg }], { beforeOpen: async () => requireToolNotCancelled(context) });
            });
        }
        return await commitBudgetedToolSuccess("Created standalone SVG asset.", {
            svg_path: svgPath,
            warnings: [],
        }, async () => {
            await writeFilesExclusively([{ path: svgPath, data: svg }], { beforeOpen: async () => requireToolNotCancelled(context) });
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
export async function handleHwpInsertImage(input, facade = defaultDocumentEngineFacade, context) {
    let filePath;
    let imagePath;
    let outputPath;
    try {
        filePath = resolveLocalPath(input.file_path, "file_path");
        imagePath = resolveLocalPath(input.image_path, "image_path");
        outputPath = resolveLocalPath(input.output_path, "output_path");
        assertHwpxOutputPath(outputPath);
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
        const mode = input.mode ?? "after-paragraph";
        if (mode !== "after-paragraph" && mode !== "seal-anchor") {
            throw new AssetError("INVALID_IMAGE_MODE", `Unsupported image insertion mode: ${String(mode)}`);
        }
        await preflightOutputPath(outputPath, [filePath, imagePath]);
        const [documentSnapshot, imageSnapshot] = await openImageInsertionSnapshots(filePath, imagePath);
        if (documentSnapshot.metadata.shallowFormat.candidate !== "hwpx") {
            await Promise.allSettled([
                documentSnapshot.verifySourceUnchanged(),
                imageSnapshot.verifySourceUnchanged(),
            ]);
            await Promise.allSettled([
                documentSnapshot.cleanup(),
                imageSnapshot.cleanup(),
            ]);
            throw new AssetError("UNSUPPORTED_IMAGE_DOCUMENT_FORMAT", "Image insertion supports only a valid HWPX package.");
        }
        let inserted;
        try {
            inserted = await facade.insertImage(documentSnapshot, imageSnapshot, input.anchor_text, {
                mode,
                ...(input.size_mm === undefined ? {} : { sizeMm: input.size_mm }),
                ...(input.anchor_occurrence === undefined
                    ? {}
                    : { anchorOccurrence: input.anchor_occurrence }),
            }, toDocumentEngineExecutionContext(context));
        }
        catch (error) {
            await Promise.allSettled([
                documentSnapshot.cleanup(),
                imageSnapshot.cleanup(),
            ]);
            throw error;
        }
        try {
            const metadata = readImageInsertionMetadata(inserted.resultMetadata, mode);
            if (!inserted.validation.ok) {
                throw new AssetError("HWPX_VALIDATION_FAILED", "Inserted HWPX failed structural validation.", validationDetails(inserted.validation));
            }
            return await commitBudgetedToolSuccess("Inserted a PNG image into a structurally validated HWPX document.", {
                output_path: outputPath,
                mode,
                image_entry: metadata.imageEntry,
                ...(metadata.placement === undefined
                    ? {}
                    : { placement: metadata.placement }),
                warnings: metadata.warnings,
                validation: validationDetails(inserted.validation),
            }, async () => {
                await inserted.writeOutputExclusively(outputPath, {
                    sourcePaths: [filePath, imagePath],
                });
            });
        }
        finally {
            await inserted.cleanup();
        }
    }
    catch (error) {
        const message = errorMessage(error);
        if (error instanceof HwpxOutputRequiredError) {
            return toolError("HWPX output is required.", {
                code: error.code,
                error: message,
            });
        }
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
}
export async function openImageInsertionSnapshots(documentPath, imagePath, opener = openDocumentSnapshot) {
    const documentSnapshot = await opener(documentPath, { workerInputMaxBytes: 0 });
    try {
        const imageSnapshot = await opener(imagePath, {
            workerInputMaxBytes: 0,
            maximumBytes: MAX_IMAGE_FILE_BYTES,
        });
        return [documentSnapshot, imageSnapshot];
    }
    catch (error) {
        await documentSnapshot.cleanup();
        throw error;
    }
}
export function registerHwpCreateSvgAsset(server, dependencyOverrides = {}) {
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
    }, (args, extra) => runWithToolExecutionContext(extra, (context) => handleHwpCreateSvgAsset(args, dependencyOverrides, context)));
}
export function registerHwpInsertImage(server, facade = defaultDocumentEngineFacade) {
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
    }, (args, extra) => runWithToolExecutionContext(extra, (context) => handleHwpInsertImage(args, facade, context)));
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
    const authorizedOutput = await authorizeFuturePath(outputPath);
    const authorizedSources = await Promise.all(sourcePaths.map((source) => authorizeExistingPath(source)));
    const comparableOutput = comparablePath(authorizedOutput);
    if (authorizedSources.some((source) => comparablePath(source) === comparableOutput)) {
        throw new PathAliasError("A source path and output path must be different.");
    }
    let outputLink;
    try {
        outputLink = await lstat(authorizedOutput);
    }
    catch (error) {
        if (errorCode(error, "") === "ENOENT")
            return;
        throw error;
    }
    for (const sourcePath of authorizedSources) {
        const [source, output] = await Promise.all([
            stat(sourcePath, { bigint: true }),
            stat(authorizedOutput, { bigint: true }).catch(() => undefined),
        ]);
        if (output !== undefined && source.dev === output.dev && source.ino === output.ino) {
            throw new PathAliasError(`Output path aliases a source file: ${sourcePath}`);
        }
    }
    void outputLink;
    throw new OutputConflictError(authorizedOutput);
}
function validationDetails(validation) {
    return {
        ok: validation.ok,
        issues: validation.issues.map((issue) => ({ ...issue })),
        entry_count: validation.entryCount,
    };
}
function readImageInsertionMetadata(value, expectedMode) {
    if (!isRecord(value) || value.operation !== "insertImage" ||
        value.mode !== expectedMode) {
        throw new AssetError("ENGINE_PROTOCOL_ERROR", "The isolated image engine returned invalid result metadata.");
    }
    if (expectedMode === "seal-anchor") {
        if (!Array.isArray(value.placed) || value.placed.length === 0 ||
            !isRecord(value.placed[0])) {
            throw new AssetError("ENGINE_PROTOCOL_ERROR", "The isolated image engine returned invalid placement metadata.");
        }
        const placement = value.placed[0];
        if (typeof placement.entry !== "string" ||
            !Array.isArray(placement.warnings) ||
            !placement.warnings.every((warning) => typeof warning === "string")) {
            throw new AssetError("ENGINE_PROTOCOL_ERROR", "The isolated image engine returned invalid placement metadata.");
        }
        return {
            imageEntry: placement.entry,
            warnings: [...placement.warnings],
            placement: { ...placement },
        };
    }
    if (!isRecord(value.placement) ||
        typeof value.placement.imageEntry !== "string" ||
        !Array.isArray(value.placement.warnings) ||
        !value.placement.warnings.every((warning) => typeof warning === "string")) {
        throw new AssetError("ENGINE_PROTOCOL_ERROR", "The isolated image engine returned invalid placement metadata.");
    }
    return {
        imageEntry: value.placement.imageEntry,
        warnings: [...value.placement.warnings],
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
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function errorCode(error, fallback) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error.code.length > 0) {
        return error.code;
    }
    return fallback;
}
