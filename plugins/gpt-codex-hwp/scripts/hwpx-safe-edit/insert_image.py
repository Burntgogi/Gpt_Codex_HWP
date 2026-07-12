#!/usr/bin/env python3
"""Insert a PNG as a new inline paragraph immediately after an HWPX anchor."""

from __future__ import annotations

import argparse
import io
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
from typing import Any
import xml.etree.ElementTree as ET
import zipfile

import hwpxlib as H


HU_PER_MM = 7200 / 25.4
DEFAULT_MAX_WIDTH_HU = round(150 * HU_PER_MM)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_IMAGE_BYTES = 25 * 1024 * 1024


class ImageInsertionError(ValueError):
    code = "IMAGE_INSERTION_ERROR"


class InvalidImageError(ImageInsertionError):
    code = "INVALID_IMAGE"


class AnchorNotFoundError(ImageInsertionError):
    code = "ANCHOR_NOT_FOUND"

    def __init__(self, message: str, *, matches: int) -> None:
        super().__init__(message)
        self.matches = matches


class ProtectedDocumentError(ImageInsertionError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def select_anchor_paragraph(
    sections: list[str],
    section_roots: dict[str, ET.Element],
    anchor_text: str,
    occurrence: int,
) -> tuple[str, ET.Element]:
    matches_seen = 0
    for section_name in sections:
        for paragraph in H.eligible_paragraphs(section_roots[section_name]):
            match_count = H.paragraph_own_text(paragraph).count(anchor_text)
            if occurrence < matches_seen + match_count:
                return section_name, paragraph
            matches_seen += match_count

    raise AnchorNotFoundError(
        f"Anchor {anchor_text!r} occurrence {occurrence} was not found; "
        f"eligible matches: {matches_seen}.",
        matches=matches_seen,
    )


def insert_image(
    source: str | os.PathLike[str],
    output: str | os.PathLike[str],
    *,
    image_path: str | os.PathLike[str],
    anchor_text: str,
    occurrence: int = 0,
    width_mm: float | None = None,
) -> dict[str, Any]:
    source_path = H.safe_existing_input_path(source)
    output_path = H.safe_new_output_path(output)
    image_file = H.safe_existing_input_path(image_path)
    if os.path.samefile(source_path, image_file):
        raise H.UnsafePathError("Source document and image path must be different files.")
    if not anchor_text:
        raise AnchorNotFoundError("anchor_text must not be empty", matches=0)
    if occurrence < 0:
        raise AnchorNotFoundError("occurrence must be zero or greater", matches=0)
    if width_mm is not None and (
        not math.isfinite(width_mm) or width_mm <= 0 or width_mm > 1000
    ):
        raise InvalidImageError("width_mm must be a finite value between 0 and 1000")

    if image_file.stat().st_size > MAX_IMAGE_BYTES:
        raise InvalidImageError(
            f"Image exceeds the {MAX_IMAGE_BYTES}-byte safety limit."
        )
    archive = H.inspect_archive(source_path)
    image_bytes = image_file.read_bytes()
    native_width_px, native_height_px = png_dimensions(image_bytes)
    native_width_hu = native_width_px * 75
    native_height_hu = native_height_px * 75

    with zipfile.ZipFile(source_path) as zipped:
        guard_protected_package(zipped)
        names = set(zipped.namelist())
        sections = H.section_names(zipped)
        if not sections:
            raise H.NotHwpxError("HWPX has no Contents/sectionN.xml entries.")
        if "Contents/content.hpf" not in names:
            raise H.NotHwpxError("HWPX has no Contents/content.hpf manifest.")
        section_roots = {
            name: H.parse_xml(zipped.read(name))
            for name in sections
        }
        manifest_root = H.parse_xml(zipped.read("Contents/content.hpf"))
        manifest_problems = H.manifest_issues(zipped)
        if manifest_problems:
            raise ImageInsertionError(
                "Source HWPX manifest is inconsistent: " + "; ".join(manifest_problems[:8])
            )

    section_name, anchor = select_anchor_paragraph(
        sections,
        section_roots,
        anchor_text,
        occurrence,
    )
    section_root = section_roots[section_name]
    section_number = int(re.search(r"section(\d+)\.xml$", section_name).group(1))
    all_ids: set[int] = set()
    for root in section_roots.values():
        all_ids.update(H.numeric_ids(root))
    next_id = max(all_ids, default=0) + 1
    paragraph_id, picture_id, instance_id = next_id, next_id + 1, next_id + 2

    item_id, image_entry = next_image_identity(
        archive,
        manifest_root,
        section_roots.values(),
    )
    available_width_hu = paragraph_available_width(anchor, section_root)
    requested_width_hu = (
        native_width_hu
        if width_mm is None
        else round(width_mm * HU_PER_MM)
    )
    cap = max(1, available_width_hu)
    display_width_hu = max(1, min(requested_width_hu, cap))
    display_height_hu = max(
        1,
        round(display_width_hu * native_height_hu / native_width_hu),
    )
    warnings: list[str] = []
    if display_width_hu < requested_width_hu:
        warnings.append(
            "Requested image width exceeded the containing text area and was reduced."
        )

    new_paragraph = build_image_paragraph(
        anchor,
        anchor_text=anchor_text,
        paragraph_id=paragraph_id,
        picture_id=picture_id,
        instance_id=instance_id,
        item_id=item_id,
        native_width_hu=native_width_hu,
        native_height_hu=native_height_hu,
        display_width_hu=display_width_hu,
        display_height_hu=display_height_hu,
    )
    parents = H.parent_map(section_root)
    parent = parents.get(anchor)
    if parent is None:
        raise ImageInsertionError("The anchor paragraph has no insertable parent.")
    siblings = list(parent)
    parent.insert(siblings.index(anchor) + 1, new_paragraph)
    removed_linesegarray = H.strip_linesegarray(section_root)

    manifest = manifest_root.find(f".//{H.OPF}manifest")
    if manifest is None:
        raise H.NotHwpxError("Contents/content.hpf has no opf:manifest element.")
    ET.SubElement(
        manifest,
        f"{H.OPF}item",
        {
            "id": item_id,
            "href": image_entry,
            "media-type": "image/png",
            "isEmbeded": "1",
        },
    )

    changed = {
        section_name: H.serialize_xml(section_root),
        "Contents/content.hpf": H.serialize_xml(manifest_root),
    }
    output_bytes = H.repack_preserve_bytes(
        source_path,
        changed,
        {image_entry: image_bytes},
    )
    validate_result_bytes(output_bytes, image_entry=image_entry, item_id=item_id)
    H.write_exclusive(output_path, output_bytes)

    return {
        "ok": True,
        "image_entry": image_entry,
        "item_id": item_id,
        "section_index": section_number,
        "removed_linesegarray": removed_linesegarray,
        "display_width_hu": display_width_hu,
        "display_height_hu": display_height_hu,
        "warnings": warnings,
    }


def png_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 33 or data[:8] != PNG_MAGIC:
        raise InvalidImageError("Image must be a valid PNG file.")
    length = struct.unpack_from(">I", data, 8)[0]
    if length != 13 or data[12:16] != b"IHDR":
        raise InvalidImageError("PNG is missing its canonical IHDR chunk.")
    payload = data[16:29]
    expected_crc = struct.unpack_from(">I", data, 29)[0]
    import zlib

    if zlib.crc32(b"IHDR" + payload) & 0xFFFFFFFF != expected_crc:
        raise InvalidImageError("PNG IHDR checksum is invalid.")
    width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", payload
    )
    valid_depths = {
        0: {1, 2, 4, 8, 16},
        2: {8, 16},
        3: {1, 2, 4, 8},
        4: {8, 16},
        6: {8, 16},
    }
    if (
        width <= 0
        or height <= 0
        or width > 1_000_000
        or height > 1_000_000
        or color_type not in valid_depths
        or bit_depth not in valid_depths[color_type]
        or compression != 0
        or filtering != 0
        or interlace not in (0, 1)
    ):
        raise InvalidImageError("PNG IHDR contains unsupported dimensions or settings.")
    return width, height


def next_image_identity(
    archive: H.Archive,
    manifest_root: ET.Element,
    section_roots: Any = (),
) -> tuple[str, str]:
    used_numbers: set[int] = set()
    for entry in archive.entries:
        matched = re.fullmatch(
            r"BinData/(?:image|img)(\d+)\.[^/]+",
            entry.name,
            re.IGNORECASE,
        )
        if matched is not None:
            used_numbers.add(int(matched.group(1)))
    identifiers = {item.get("id", "") for item in manifest_root.iter(f"{H.OPF}item")}
    for item in manifest_root.iter(f"{H.OPF}item"):
        identifier = item.get("id", "")
        matched = re.fullmatch(r"image(\d+)", identifier, re.IGNORECASE)
        if matched is not None:
            used_numbers.add(int(matched.group(1)))
        href = item.get("href", "")
        matched_href = re.fullmatch(
            r"BinData/(?:image|img)(\d+)\.[^/]+",
            href,
            re.IGNORECASE,
        )
        if matched_href is not None:
            used_numbers.add(int(matched_href.group(1)))
    for root in section_roots:
        for image in root.iter(f"{H.HC}img"):
            reference = image.get("binaryItemIDRef", "")
            matched = re.fullmatch(r"image(\d+)", reference, re.IGNORECASE)
            if matched is not None:
                used_numbers.add(int(matched.group(1)))
    number = 1
    while number in used_numbers:
        number += 1
    return f"image{number}", f"BinData/image{number}.png"


def guard_protected_package(zipped: zipfile.ZipFile) -> None:
    names = zipped.namelist()
    for name in names:
        normalized = name.casefold()
        if (
            normalized.startswith("_xmlsignatures/")
            or re.search(r"(^|/)(?:digital)?signatures?(?:[./]|$)", normalized)
            or normalized.endswith((".p7s", ".p7m", ".sig"))
        ):
            raise ProtectedDocumentError(
                "SIGNED_DOCUMENT",
                "Electronically signed HWPX packages are not edited.",
            )
    manifest_names = [
        name for name in names if name.casefold() == "meta-inf/manifest.xml"
    ]
    if len(manifest_names) > 1:
        raise ProtectedDocumentError(
            "INVALID_HWPX_PROTECTION_METADATA",
            "HWPX package contains multiple case-equivalent protection manifests.",
        )
    manifest_name = manifest_names[0] if manifest_names else None
    if manifest_name is not None:
        info = zipped.getinfo(manifest_name)
        if info.file_size > 8 * 1024 * 1024:
            raise ProtectedDocumentError(
                "ENCRYPTED",
                "Protection manifest is too large to inspect safely.",
            )
        manifest = zipped.read(manifest_name)
        try:
            manifest_root = H.parse_xml(manifest)
        except (ET.ParseError, ValueError) as error:
            raise ProtectedDocumentError(
                "INVALID_HWPX_PROTECTION_METADATA",
                f"Protection manifest is malformed or unsafe: {error}",
            ) from error
        protected_names = {
            "encryption-data",
            "encrypted-data",
            "public-key-encryption",
            "drm",
            "distribution",
            "distribution-protection",
            "digital-signature",
            "signature",
        }
        if any(
            H.local_name(element.tag).casefold() in protected_names
            for element in manifest_root.iter()
        ):
            raise ProtectedDocumentError(
                "ENCRYPTED",
                "Encrypted, DRM, or distribution HWPX packages are not edited.",
            )


def paragraph_available_width(paragraph: ET.Element, root: ET.Element) -> int:
    parents = H.parent_map(root)
    ancestor = parents.get(paragraph)
    while ancestor is not None:
        if H.local_name(ancestor.tag) == "tc":
            cell_size = ancestor.find(f".//{H.HP}cellSz")
            if cell_size is not None and (cell_size.get("width") or "").isdigit():
                width = int(cell_size.get("width"))
                margin = ancestor.find(f".//{H.HP}cellMargin")
                if margin is not None:
                    width -= _numeric_attr(margin, "left") + _numeric_attr(margin, "right")
                if width > 0:
                    return width
            break
        ancestor = parents.get(ancestor)

    page = root.find(f".//{H.HP}pagePr")
    if page is not None and (page.get("width") or "").isdigit():
        width = int(page.get("width"))
        margin = page.find(f"{H.HP}margin")
        if margin is not None:
            width -= _numeric_attr(margin, "left") + _numeric_attr(margin, "right")
        if width > 0:
            return width
    return DEFAULT_MAX_WIDTH_HU


def build_image_paragraph(
    anchor: ET.Element,
    *,
    anchor_text: str,
    paragraph_id: int,
    picture_id: int,
    instance_id: int,
    item_id: str,
    native_width_hu: int,
    native_height_hu: int,
    display_width_hu: int,
    display_height_hu: int,
) -> ET.Element:
    paragraph = ET.Element(
        f"{H.HP}p",
        {
            "id": str(paragraph_id),
            "paraPrIDRef": anchor.get("paraPrIDRef", "0"),
            "styleIDRef": anchor.get("styleIDRef", "0"),
            "pageBreak": "0",
            "columnBreak": "0",
            "merged": "0",
        },
    )
    run = ET.SubElement(
        paragraph,
        f"{H.HP}run",
        {"charPrIDRef": anchor_char_property(anchor, anchor_text)},
    )
    picture = ET.SubElement(
        run,
        f"{H.HP}pic",
        {
            "id": str(picture_id),
            "zOrder": "0",
            "numberingType": "PICTURE",
            "textWrap": "TOP_AND_BOTTOM",
            "textFlow": "BOTH_SIDES",
            "lock": "0",
            "dropcapstyle": "None",
            "href": "",
            "groupLevel": "0",
            "instid": str(instance_id),
            "reverse": "0",
            "xmlns:hc": H.HC_NS,
        },
    )
    ET.SubElement(picture, f"{H.HP}offset", {"x": "0", "y": "0"})
    ET.SubElement(
        picture,
        f"{H.HP}orgSz",
        {"width": str(native_width_hu), "height": str(native_height_hu)},
    )
    ET.SubElement(
        picture,
        f"{H.HP}curSz",
        {"width": str(display_width_hu), "height": str(display_height_hu)},
    )
    ET.SubElement(picture, f"{H.HP}flip", {"horizontal": "0", "vertical": "0"})
    ET.SubElement(
        picture,
        f"{H.HP}rotationInfo",
        {
            "angle": "0",
            "centerX": str(round(display_width_hu / 2)),
            "centerY": str(round(display_height_hu / 2)),
            "rotateimage": "1",
        },
    )
    rendering = ET.SubElement(picture, f"{H.HP}renderingInfo")
    ET.SubElement(rendering, f"{H.HC}transMatrix", matrix_attributes(1, 1))
    ET.SubElement(
        rendering,
        f"{H.HC}scaMatrix",
        matrix_attributes(
            display_width_hu / native_width_hu,
            display_height_hu / native_height_hu,
        ),
    )
    ET.SubElement(rendering, f"{H.HC}rotMatrix", matrix_attributes(1, 1))
    rectangle = ET.SubElement(picture, f"{H.HP}imgRect")
    for name, x, y in (
        ("pt0", 0, 0),
        ("pt1", native_width_hu, 0),
        ("pt2", native_width_hu, native_height_hu),
        ("pt3", 0, native_height_hu),
    ):
        ET.SubElement(rectangle, f"{H.HC}{name}", {"x": str(x), "y": str(y)})
    ET.SubElement(
        picture,
        f"{H.HP}imgClip",
        {
            "left": "0",
            "right": str(native_width_hu),
            "top": "0",
            "bottom": str(native_height_hu),
        },
    )
    ET.SubElement(
        picture,
        f"{H.HP}inMargin",
        {"left": "0", "right": "0", "top": "0", "bottom": "0"},
    )
    ET.SubElement(
        picture,
        f"{H.HP}imgDim",
        {"dimwidth": str(native_width_hu), "dimheight": str(native_height_hu)},
    )
    ET.SubElement(
        picture,
        f"{H.HC}img",
        {
            "binaryItemIDRef": item_id,
            "bright": "0",
            "contrast": "0",
            "effect": "REAL_PIC",
            "alpha": "0",
        },
    )
    ET.SubElement(picture, f"{H.HP}effects")
    ET.SubElement(
        picture,
        f"{H.HP}sz",
        {
            "width": str(display_width_hu),
            "widthRelTo": "ABSOLUTE",
            "height": str(display_height_hu),
            "heightRelTo": "ABSOLUTE",
            "protect": "0",
        },
    )
    ET.SubElement(
        picture,
        f"{H.HP}pos",
        {
            "treatAsChar": "1",
            "affectLSpacing": "0",
            "flowWithText": "1",
            "allowOverlap": "0",
            "holdAnchorAndSO": "0",
            "vertRelTo": "PARA",
            "horzRelTo": "PARA",
            "vertAlign": "TOP",
            "horzAlign": "LEFT",
            "vertOffset": "0",
            "horzOffset": "0",
        },
    )
    ET.SubElement(
        picture,
        f"{H.HP}outMargin",
        {"left": "0", "right": "0", "top": "0", "bottom": "0"},
    )
    ET.SubElement(picture, f"{H.HP}shapeComment").text = "hwp-korean-docs inline image"
    ET.SubElement(run, f"{H.HP}t")
    return paragraph


def anchor_char_property(anchor: ET.Element, anchor_text: str) -> str:
    fallback = "0"
    for run in anchor.iter(f"{H.HP}run"):
        if run is not anchor and any(
            descendant is not run and descendant.tag == f"{H.HP}p"
            for descendant in run.iter()
        ):
            continue
        char_property = run.get("charPrIDRef", fallback)
        fallback = char_property
        if anchor_text in H.paragraph_own_text(run):
            return char_property
    return fallback


def matrix_attributes(scale_x: float, scale_y: float) -> dict[str, str]:
    return {
        "e1": format_number(scale_x),
        "e2": "0",
        "e3": "0",
        "e4": "0",
        "e5": format_number(scale_y),
        "e6": "0",
    }


def format_number(value: float | int) -> str:
    numeric = float(value)
    if numeric.is_integer():
        return str(int(value))
    return format(numeric, ".9g")


def validate_result_bytes(data: bytes, *, image_entry: str, item_id: str) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as zipped:
        if zipped.testzip() is not None:
            raise ImageInsertionError("Generated archive failed ZIP CRC validation.")
        if image_entry not in zipped.namelist():
            raise ImageInsertionError("Generated archive is missing the image payload.")
        manifest = H.parse_xml(zipped.read("Contents/content.hpf"))
        item = next(
            (
                element
                for element in manifest.iter(f"{H.OPF}item")
                if element.get("id") == item_id
            ),
            None,
        )
        if item is None or item.get("href") != image_entry:
            raise ImageInsertionError("Generated archive has an inconsistent image manifest.")
        references = {
            image.get("binaryItemIDRef")
            for section in H.section_names(zipped)
            for image in H.parse_xml(zipped.read(section)).iter(f"{H.HC}img")
        }
        if item_id not in references:
            raise ImageInsertionError("Generated section does not reference the image manifest item.")


def _numeric_attr(element: ET.Element, name: str) -> int:
    value = element.get(name, "0")
    return int(value) if value.isdigit() else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Insert a PNG in a new paragraph after an HWPX text anchor."
    )
    parser.add_argument("source", help="source .hwpx path")
    parser.add_argument("output", help="new .hwpx path (must not exist)")
    parser.add_argument("--image", required=True, help="PNG file to embed")
    parser.add_argument("--anchor-text", required=True, help="body/table paragraph substring")
    parser.add_argument("--occurrence", type=int, default=0, help="zero-based eligible paragraph match")
    parser.add_argument("--width-mm", type=float, help="requested display width in millimetres")
    args = parser.parse_args(argv)
    try:
        result = insert_image(
            args.source,
            args.output,
            image_path=args.image,
            anchor_text=args.anchor_text,
            occurrence=args.occurrence,
            width_mm=args.width_mm,
        )
    except Exception as error:  # noqa: BLE001 - CLI converts all failures to JSON
        payload: dict[str, Any] = {
            "ok": False,
            "code": error_code(error),
            "error": str(error),
        }
        if isinstance(error, AnchorNotFoundError):
            payload["matches"] = error.matches
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


def error_code(error: Exception) -> str:
    if isinstance(error, FileExistsError):
        return "OUTPUT_CONFLICT"
    if isinstance(error, H.NotHwpxError):
        return "NOT_HWPX"
    if isinstance(error, H.UnsafeZipError):
        return "UNSAFE_ZIP"
    if isinstance(error, ImageInsertionError):
        return error.code
    if isinstance(error, FileNotFoundError):
        return "FILE_NOT_FOUND"
    return "IMAGE_INSERTION_ERROR"


if __name__ == "__main__":
    raise SystemExit(main())
