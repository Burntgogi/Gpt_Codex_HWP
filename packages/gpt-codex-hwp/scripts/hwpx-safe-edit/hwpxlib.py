"""Safe, raw-preserving primitives for editing HWPX archives.

Portions of the design and the raw-preserving ZIP repacker are adapted from
kangdacool/hwpx-editing-skill at commit
0d17930f4dc546dfa02123867b1f1060eb259572 (MIT License).  This adaptation uses
only the Python standard library and deliberately fails closed for ZIP features
that cannot be copied losslessly by this small implementation.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import io
import os
from pathlib import Path
import re
import stat as stat_module
import struct
import tempfile
from typing import Iterable, Mapping
import xml.etree.ElementTree as ET
import zipfile
import zlib


HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HC_NS = "http://www.hancom.co.kr/hwpml/2011/core"
HS_NS = "http://www.hancom.co.kr/hwpml/2011/section"
HH_NS = "http://www.hancom.co.kr/hwpml/2011/head"
OPF_NS = "http://www.idpf.org/2007/opf/"
HP = f"{{{HP_NS}}}"
HC = f"{{{HC_NS}}}"
OPF = f"{{{OPF_NS}}}"
XML_DECL = b'<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n'

for _prefix, _uri in (
    ("hp", HP_NS),
    ("hc", HC_NS),
    ("hs", HS_NS),
    ("hh", HH_NS),
    ("opf", OPF_NS),
    ("hpf", "http://www.hancom.co.kr/schema/2011/hpf"),
):
    ET.register_namespace(_prefix, _uri)


class NotHwpxError(ValueError):
    """The input is not a ZIP-based HWPX document."""


class UnsafeZipError(ValueError):
    """The archive uses a ZIP feature this editor must reject."""


class UnsafePathError(ValueError):
    """A filesystem path is ambiguous, linked, device-backed, or unsafe."""


MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_ZIP_ENTRIES = 10_000
MAX_ENTRY_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 1_000
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def safe_existing_input_path(path: str | os.PathLike[str]) -> Path:
    absolute = _normalized_local_path(path)
    _assert_unlinked_components(absolute, include_final=True)
    try:
        status = os.lstat(absolute)
    except OSError as error:
        raise UnsafePathError(f"Input path is unavailable: {absolute}") from error
    if not stat_module.S_ISREG(status.st_mode):
        raise UnsafePathError(f"Input path must be a regular file: {absolute}")
    return absolute


def safe_new_output_path(path: str | os.PathLike[str]) -> Path:
    absolute = _normalized_local_path(path)
    parent = absolute.parent
    _assert_unlinked_components(parent, include_final=True)
    try:
        parent_status = os.lstat(parent)
    except OSError as error:
        raise UnsafePathError(f"Output parent is unavailable: {parent}") from error
    if not stat_module.S_ISDIR(parent_status.st_mode):
        raise UnsafePathError(f"Output parent must be a directory: {parent}")
    try:
        final_status = os.lstat(absolute)
    except FileNotFoundError:
        return absolute
    if _is_link_or_reparse(final_status):
        raise UnsafePathError(f"Output path is a symlink or junction: {absolute}")
    raise FileExistsError(f"Output already exists: {absolute}")


def _normalized_local_path(path: str | os.PathLike[str]) -> Path:
    raw = os.fspath(path)
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise UnsafePathError("Path must be a non-empty local filesystem string.")
    if os.name == "nt":
        normalized = raw.replace("/", "\\")
        lowered = normalized.lower()
        if lowered.startswith(("\\\\?\\", "\\\\.\\", "\\??\\")) or "globalroot" in lowered:
            raise UnsafePathError("Windows device and extended-length paths are not allowed.")
        drive_prefix = re.match(r"^[A-Za-z]:", normalized)
        remainder = normalized[2:] if drive_prefix is not None else normalized
        if ":" in remainder:
            raise UnsafePathError("Windows alternate data streams are not allowed.")
        if any(ord(character) < 32 for character in normalized):
            raise UnsafePathError("Windows control characters are not allowed in paths.")
        for segment in re.split(r"[\\/]+", remainder):
            if segment in ("", ".", ".."):
                continue
            if segment.rstrip(" .") != segment:
                raise UnsafePathError("Windows path segments may not end in a dot or space.")
            stem = segment.split(".", 1)[0].upper()
            if stem in _WINDOWS_RESERVED:
                raise UnsafePathError(f"Windows reserved device name is not allowed: {segment}")
    return Path(os.path.abspath(raw))


def _assert_unlinked_components(path: Path, *, include_final: bool) -> None:
    components: list[Path] = []
    current = Path(path.anchor) if path.anchor else Path()
    parts = path.parts[1:] if path.anchor else path.parts
    for part in parts:
        current = current / part
        components.append(current)
    if not include_final and components:
        components.pop()
    for component in components:
        try:
            status = os.lstat(component)
        except FileNotFoundError:
            raise UnsafePathError(f"Path component does not exist: {component}") from None
        if _is_link_or_reparse(status):
            raise UnsafePathError(f"Path component is a symlink or junction: {component}")


def _is_link_or_reparse(status: os.stat_result) -> bool:
    attributes = getattr(status, "st_file_attributes", 0)
    return stat_module.S_ISLNK(status.st_mode) or bool(
        attributes & _FILE_ATTRIBUTE_REPARSE_POINT
    )


@dataclass(frozen=True)
class ZipEntry:
    name: str
    name_bytes: bytes
    version_made_by: int
    version_needed: int
    flags: int
    method: int
    mod_time: int
    mod_date: int
    crc: int
    compressed_size: int
    uncompressed_size: int
    disk_start: int
    internal_attr: int
    external_attr: int
    local_offset: int
    local_extra: bytes
    central_extra: bytes
    comment: bytes
    data_start: int
    data_end: int
    span_end: int


@dataclass(frozen=True)
class Archive:
    raw: bytes
    entries: tuple[ZipEntry, ...]
    local_order: tuple[str, ...]
    comment: bytes

    @property
    def by_name(self) -> dict[str, ZipEntry]:
        return {entry.name: entry for entry in self.entries}


def ensure_hwpx(path: str | os.PathLike[str]) -> None:
    safe_path = safe_existing_input_path(path)
    with open(safe_path, "rb") as stream:
        magic = stream.read(4)
    if magic == b"\xd0\xcf\x11\xe0":
        raise NotHwpxError("Legacy binary HWP is not supported by the HWPX safe editor.")
    if magic != b"PK\x03\x04":
        raise NotHwpxError("The input is not a ZIP-based HWPX document.")


def inspect_archive(path: str | os.PathLike[str]) -> Archive:
    safe_path = safe_existing_input_path(path)
    ensure_hwpx(safe_path)
    size = safe_path.stat().st_size
    if size > MAX_ARCHIVE_BYTES:
        raise UnsafeZipError(
            f"HWPX archive exceeds the {MAX_ARCHIVE_BYTES}-byte safety limit."
        )
    raw = safe_path.read_bytes()
    if len(raw) < 22:
        raise UnsafeZipError("Truncated ZIP archive.")

    eocd = _find_eocd(raw)
    (
        _signature,
        disk_number,
        central_disk,
        entries_on_disk,
        entry_count,
        central_size,
        central_offset,
        comment_length,
    ) = struct.unpack_from("<IHHHHIIH", raw, eocd)
    if disk_number != 0 or central_disk != 0 or entries_on_disk != entry_count:
        raise UnsafeZipError("Multi-disk ZIP archives are not supported.")
    if (
        entry_count == 0xFFFF
        or central_size == 0xFFFFFFFF
        or central_offset == 0xFFFFFFFF
    ):
        raise UnsafeZipError("ZIP64 archives are not supported.")
    if entry_count > MAX_ZIP_ENTRIES:
        raise UnsafeZipError(
            f"ZIP entry count {entry_count} exceeds the {MAX_ZIP_ENTRIES}-entry limit."
        )
    if eocd + 22 + comment_length != len(raw):
        raise UnsafeZipError("Trailing or truncated ZIP data is not supported.")
    central_end = central_offset + central_size
    if central_end > eocd:
        raise UnsafeZipError("Central directory lies outside the archive.")
    gap = raw[central_end:eocd]
    if gap.startswith(b"PK\x05\x05"):
        raise UnsafeZipError("Digitally signed ZIP archives are not supported.")
    if gap:
        raise UnsafeZipError("Unexpected data between the central directory and EOCD.")
    if central_offset == 0 and entry_count:
        raise UnsafeZipError("Archive has no local-file area.")

    provisional: list[ZipEntry] = []
    total_uncompressed = 0
    cursor = central_offset
    names: set[str] = set()
    for _ in range(entry_count):
        if cursor + 46 > central_end or raw[cursor:cursor + 4] != b"PK\x01\x02":
            raise UnsafeZipError("Malformed central directory record.")
        fields = struct.unpack_from("<IHHHHHHIIIHHHHHII", raw, cursor)
        (
            _sig,
            version_made_by,
            version_needed,
            flags,
            method,
            mod_time,
            mod_date,
            crc,
            compressed_size,
            uncompressed_size,
            name_length,
            extra_length,
            entry_comment_length,
            disk_start,
            internal_attr,
            external_attr,
            local_offset,
        ) = fields
        record_end = cursor + 46 + name_length + extra_length + entry_comment_length
        if record_end > central_end:
            raise UnsafeZipError("Truncated central directory record.")
        name_bytes = raw[cursor + 46:cursor + 46 + name_length]
        central_extra = raw[
            cursor + 46 + name_length:cursor + 46 + name_length + extra_length
        ]
        comment = raw[
            cursor + 46 + name_length + extra_length:record_end
        ]
        _guard_entry_features(flags, method, disk_start, central_extra)
        if uncompressed_size > MAX_ENTRY_UNCOMPRESSED_BYTES:
            raise UnsafeZipError(
                f"ZIP entry exceeds the per-entry size limit: {uncompressed_size} bytes."
            )
        total_uncompressed += uncompressed_size
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise UnsafeZipError("ZIP total uncompressed size exceeds the safety limit.")
        if uncompressed_size > 0:
            if compressed_size == 0:
                raise UnsafeZipError("Non-empty ZIP entry has zero compressed bytes.")
            if uncompressed_size / compressed_size > MAX_COMPRESSION_RATIO:
                raise UnsafeZipError("ZIP entry compression ratio exceeds the safety limit.")
        name = _decode_name(name_bytes, flags)
        _guard_entry_name(name)
        if name in names:
            raise UnsafeZipError(f"Duplicate ZIP entry name: {name!r}.")
        names.add(name)
        provisional.append(
            ZipEntry(
                name=name,
                name_bytes=name_bytes,
                version_made_by=version_made_by,
                version_needed=version_needed,
                flags=flags,
                method=method,
                mod_time=mod_time,
                mod_date=mod_date,
                crc=crc,
                compressed_size=compressed_size,
                uncompressed_size=uncompressed_size,
                disk_start=disk_start,
                internal_attr=internal_attr,
                external_attr=external_attr,
                local_offset=local_offset,
                local_extra=b"",
                central_extra=central_extra,
                comment=comment,
                data_start=0,
                data_end=0,
                span_end=0,
            )
        )
        cursor = record_end
    if cursor != central_end:
        raise UnsafeZipError("Central directory size does not match its records.")

    offsets = sorted((entry.local_offset, entry.name) for entry in provisional)
    if offsets and offsets[0][0] != 0:
        raise UnsafeZipError("Prefixed/self-extracting ZIP archives are not supported.")
    if len({offset for offset, _ in offsets}) != len(offsets):
        raise UnsafeZipError("Multiple ZIP entries share a local-file offset.")
    next_offsets = {
        name: (offsets[index + 1][0] if index + 1 < len(offsets) else central_offset)
        for index, (_offset, name) in enumerate(offsets)
    }

    finalized: list[ZipEntry] = []
    for entry in provisional:
        offset = entry.local_offset
        if offset + 30 > central_offset or raw[offset:offset + 4] != b"PK\x03\x04":
            raise UnsafeZipError(f"Malformed local header for {entry.name!r}.")
        (
            _local_sig,
            local_version,
            local_flags,
            local_method,
            local_time,
            local_date,
            local_crc,
            local_compressed_size,
            local_uncompressed_size,
            local_name_length,
            local_extra_length,
        ) = struct.unpack_from("<IHHHHHIIIHH", raw, offset)
        header_end = offset + 30 + local_name_length + local_extra_length
        data_end = header_end + local_compressed_size
        span_end = next_offsets[entry.name]
        if data_end > span_end or span_end > central_offset:
            raise UnsafeZipError(f"Overlapping or truncated local entry {entry.name!r}.")
        local_name = raw[offset + 30:offset + 30 + local_name_length]
        local_extra = raw[
            offset + 30 + local_name_length:header_end
        ]
        _guard_extra(local_extra)
        if (
            local_name != entry.name_bytes
            or local_version != entry.version_needed
            or local_flags != entry.flags
            or local_method != entry.method
            or local_time != entry.mod_time
            or local_date != entry.mod_date
            or local_crc != entry.crc
            or local_compressed_size != entry.compressed_size
            or local_uncompressed_size != entry.uncompressed_size
        ):
            raise UnsafeZipError(f"Local/central ZIP metadata mismatch for {entry.name!r}.")
        finalized.append(
            replace(
                entry,
                local_extra=local_extra,
                data_start=header_end,
                data_end=data_end,
                span_end=span_end,
            )
        )

    return Archive(
        raw=raw,
        entries=tuple(finalized),
        local_order=tuple(name for _offset, name in offsets),
        comment=raw[eocd + 22:],
    )


def repack_preserve_bytes(
    src: str | os.PathLike[str],
    changed: Mapping[str, bytes],
    added: Mapping[str, bytes] | None = None,
) -> bytes:
    archive = inspect_archive(src)
    additions = dict(added or {})
    original = archive.by_name
    missing = set(changed) - set(original)
    if missing:
        raise KeyError(f"Changed ZIP entries do not exist: {sorted(missing)!r}")
    collisions = set(additions) & set(original)
    if collisions:
        raise ValueError(f"Added ZIP entries already exist: {sorted(collisions)!r}")
    if set(changed) & set(additions):
        raise ValueError("An entry cannot be both changed and added.")
    for name in additions:
        _guard_entry_name(name)
    output = io.BytesIO()
    emitted: dict[str, ZipEntry] = {}
    for name in archive.local_order:
        entry = original[name]
        new_offset = output.tell()
        if new_offset > 0xFFFFFFFF:
            raise UnsafeZipError("Output would require ZIP64 offsets.")
        if name not in changed:
            output.write(archive.raw[entry.local_offset:entry.span_end])
            emitted[name] = replace(entry, local_offset=new_offset)
            continue
        data = bytes(changed[name])
        compressed = _compress(data, entry.method)
        _guard_classic_sizes(len(compressed), len(data))
        crc = zipfile.crc32(data) & 0xFFFFFFFF
        output.write(
            struct.pack(
                "<IHHHHHIIIHH",
                0x04034B50,
                entry.version_needed,
                entry.flags,
                entry.method,
                entry.mod_time,
                entry.mod_date,
                crc,
                len(compressed),
                len(data),
                len(entry.name_bytes),
                len(entry.local_extra),
            )
        )
        output.write(entry.name_bytes)
        output.write(entry.local_extra)
        output.write(compressed)
        output.write(archive.raw[entry.data_end:entry.span_end])
        emitted[name] = replace(
            entry,
            crc=crc,
            compressed_size=len(compressed),
            uncompressed_size=len(data),
            local_offset=new_offset,
            data_start=0,
            data_end=0,
            span_end=0,
        )

    addition_order: list[str] = []
    for name, raw_data in additions.items():
        data = bytes(raw_data)
        name_bytes = name.encode("utf-8")
        flags = 0x0800 if any(byte >= 0x80 for byte in name_bytes) else 0
        compressed = _compress(data, zipfile.ZIP_DEFLATED)
        _guard_classic_sizes(len(compressed), len(data))
        offset = output.tell()
        if offset > 0xFFFFFFFF:
            raise UnsafeZipError("Output would require ZIP64 offsets.")
        crc = zipfile.crc32(data) & 0xFFFFFFFF
        output.write(
            struct.pack(
                "<IHHHHHIIIHH",
                0x04034B50,
                20,
                flags,
                zipfile.ZIP_DEFLATED,
                0,
                0,
                crc,
                len(compressed),
                len(data),
                len(name_bytes),
                0,
            )
        )
        output.write(name_bytes)
        output.write(compressed)
        emitted[name] = ZipEntry(
            name=name,
            name_bytes=name_bytes,
            version_made_by=20,
            version_needed=20,
            flags=flags,
            method=zipfile.ZIP_DEFLATED,
            mod_time=0,
            mod_date=0,
            crc=crc,
            compressed_size=len(compressed),
            uncompressed_size=len(data),
            disk_start=0,
            internal_attr=0,
            external_attr=0,
            local_offset=offset,
            local_extra=b"",
            central_extra=b"",
            comment=b"",
            data_start=0,
            data_end=0,
            span_end=0,
        )
        addition_order.append(name)

    central_offset = output.tell()
    central_order = [entry.name for entry in archive.entries] + addition_order
    if len(central_order) > 0xFFFF:
        raise UnsafeZipError("Output would require ZIP64 entry counts.")
    for name in central_order:
        entry = emitted[name]
        output.write(
            struct.pack(
                "<IHHHHHHIIIHHHHHII",
                0x02014B50,
                entry.version_made_by,
                entry.version_needed,
                entry.flags,
                entry.method,
                entry.mod_time,
                entry.mod_date,
                entry.crc,
                entry.compressed_size,
                entry.uncompressed_size,
                len(entry.name_bytes),
                len(entry.central_extra),
                len(entry.comment),
                0,
                entry.internal_attr,
                entry.external_attr,
                entry.local_offset,
            )
        )
        output.write(entry.name_bytes)
        output.write(entry.central_extra)
        output.write(entry.comment)
    central_size = output.tell() - central_offset
    _guard_classic_sizes(central_size, central_offset)
    output.write(
        struct.pack(
            "<IHHHHIIH",
            0x06054B50,
            0,
            0,
            len(central_order),
            len(central_order),
            central_size,
            central_offset,
            len(archive.comment),
        )
    )
    output.write(archive.comment)
    return output.getvalue()


def repack_preserve(
    src: str | os.PathLike[str],
    changed: Mapping[str, bytes],
    out: str | os.PathLike[str],
    added: Mapping[str, bytes] | None = None,
) -> None:
    data = repack_preserve_bytes(src, changed, added)
    write_exclusive(out, data)


def write_exclusive(path: str | os.PathLike[str], data: bytes) -> None:
    safe_path = safe_new_output_path(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    descriptor = os.open(safe_path, flags, 0o600)
    try:
        os.fstat(descriptor)
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("Could not finish writing the output archive.")
            view = view[written:]
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        # Never unlink a failed output by pathname. A concurrent replacement
        # can race even an inode comparison followed by unlink; an orphan is
        # safer than deleting another actor's file.
        raise
    else:
        os.close(descriptor)


def self_verify_identical(src: str | os.PathLike[str]) -> bool:
    """Rebuild a no-op archive in a private temp directory and compare bytes."""
    safe_source = safe_existing_input_path(src)
    original = safe_source.read_bytes()
    rebuilt = repack_preserve_bytes(safe_source, {})
    temporary_name: str | None = None
    with tempfile.TemporaryDirectory(prefix="hwpx-noop-check-") as directory:
        handle = tempfile.NamedTemporaryFile(
            mode="w+b",
            prefix="repacked-",
            suffix=".hwpx",
            dir=directory,
            delete=False,
        )
        temporary_name = handle.name
        try:
            handle.write(rebuilt)
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()
            return Path(temporary_name).read_bytes() == original
        finally:
            if not handle.closed:
                handle.close()
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass


def section_names(source: zipfile.ZipFile | Iterable[str]) -> list[str]:
    names = source.namelist() if isinstance(source, zipfile.ZipFile) else list(source)
    matched = [name for name in names if re.fullmatch(r"Contents/section\d+\.xml", name)]
    return sorted(matched, key=lambda name: int(re.search(r"section(\d+)", name).group(1)))


class _RejectingTreeBuilder(ET.TreeBuilder):
    def doctype(
        self,
        name: str,
        pubid: str | None,
        system: str | None,
    ) -> None:
        raise ValueError("DTD/entity declarations are not allowed in HWPX XML.")


def parse_xml(data: bytes) -> ET.Element:
    if len(data) > 128 * 1024 * 1024:
        raise ValueError("XML entry is too large to parse safely.")
    parser = ET.XMLParser(target=_RejectingTreeBuilder())
    return ET.fromstring(data, parser=parser)


def serialize_xml(root: ET.Element) -> bytes:
    return XML_DECL + ET.tostring(root, encoding="utf-8", short_empty_elements=True) + b"\n"


def parent_map(root: ET.Element) -> dict[ET.Element, ET.Element]:
    return {child: parent for parent in root.iter() for child in parent}


_TEXT_BARRIERS = {
    "tbl",
    "ctrl",
    "footNote",
    "endNote",
    "fn",
    "en",
    "caption",
    "pic",
    "shape",
    "drawingObject",
    "drawText",
    "shapeComment",
    "memogroup",
    "memo",
    "hiddenComment",
    "equation",
    "parameters",
    "subList",
    "fieldBegin",
    "header",
    "footer",
    "masterPage",
}

_PARAGRAPH_EXCLUDED_ANCESTORS = {
    "ctrl",
    "caption",
    "pic",
    "shape",
    "drawingObject",
    "memogroup",
    "memo",
    "hiddenComment",
    "footNote",
    "endNote",
    "fn",
    "en",
    "fieldBegin",
    "header",
    "footer",
    "masterPage",
}


def paragraph_own_text(paragraph: ET.Element) -> str:
    parts: list[str] = []

    def walk(element: ET.Element, *, is_root: bool = False) -> None:
        name = local_name(element.tag)
        if not is_root and name == "p":
            return
        if name in _TEXT_BARRIERS:
            return
        if name == "t":
            parts.extend(element.itertext())
            return
        for child in element:
            walk(child)

    walk(paragraph, is_root=True)
    return "".join(parts)


def eligible_paragraphs(root: ET.Element) -> list[ET.Element]:
    parents = parent_map(root)
    result: list[ET.Element] = []
    for paragraph in root.iter(f"{HP}p"):
        ancestor = parents.get(paragraph)
        excluded = False
        while ancestor is not None:
            if local_name(ancestor.tag) in _PARAGRAPH_EXCLUDED_ANCESTORS:
                excluded = True
                break
            ancestor = parents.get(ancestor)
        if not excluded:
            result.append(paragraph)
    return result


def strip_linesegarray(root: ET.Element) -> int:
    parents = parent_map(root)
    targets = list(root.iter(f"{HP}linesegarray"))
    for target in targets:
        parent = parents.get(target)
        if parent is not None:
            parent.remove(target)
    return len(targets)


_ID_ATTRS = ("id", "instId", "instid")


def numeric_ids(root: ET.Element) -> set[int]:
    return {
        int(value)
        for element in root.iter()
        for attribute in _ID_ATTRS
        if (value := element.get(attribute)) is not None and value.isdigit()
    }


def id_counts(root: ET.Element) -> dict[tuple[str, int], int]:
    counts: dict[tuple[str, int], int] = {}
    for element in root.iter():
        for attribute in _ID_ATTRS:
            value = element.get(attribute)
            if value is None or not value.isdigit() or int(value) in (0, 2147483648):
                continue
            key = (attribute.lower(), int(value))
            counts[key] = counts.get(key, 0) + 1
    return counts


def new_duplicate_ids(
    edited: ET.Element,
    original: ET.Element | None = None,
) -> dict[str, int]:
    edited_counts = id_counts(edited)
    original_counts = id_counts(original) if original is not None else {}
    return {
        f"{attribute}={value}": count
        for (attribute, value), count in edited_counts.items()
        if count > 1 and count > original_counts.get((attribute, value), 0)
    }


def document_id_counts(roots: Iterable[ET.Element]) -> dict[tuple[str, int], int]:
    counts: dict[tuple[str, int], int] = {}
    for root in roots:
        for key, count in id_counts(root).items():
            counts[key] = counts.get(key, 0) + count
    return counts


def new_document_duplicate_ids(
    edited_roots: Iterable[ET.Element],
    original_roots: Iterable[ET.Element] = (),
) -> dict[str, int]:
    edited_counts = document_id_counts(edited_roots)
    original_counts = document_id_counts(original_roots)
    return {
        f"{attribute}={value}": count
        for (attribute, value), count in edited_counts.items()
        if count > 1 and count > original_counts.get((attribute, value), 0)
    }


def raw_preservation_issues(
    original: str | os.PathLike[str],
    edited: str | os.PathLike[str],
    *,
    allow_changed: Iterable[str] = (),
    allow_added: Iterable[str] = (),
) -> list[str]:
    original_archive = inspect_archive(original)
    edited_archive = inspect_archive(edited)
    original_names = set(original_archive.by_name)
    edited_names = set(edited_archive.by_name)
    changed = set(allow_changed)
    added = set(allow_added)
    issues: list[str] = []

    removed = original_names - edited_names
    unexpected_added = (edited_names - original_names) - added
    missing_added = added - (edited_names - original_names)
    unknown_changed = changed - (original_names & edited_names)
    if removed:
        issues.append(f"entries were removed: {sorted(removed)!r}")
    if unexpected_added:
        issues.append(f"unexpected entries were added: {sorted(unexpected_added)!r}")
    if missing_added:
        issues.append(f"allowed added entries are missing: {sorted(missing_added)!r}")
    if unknown_changed:
        issues.append(f"allowed changed entries are not common entries: {sorted(unknown_changed)!r}")

    for name in sorted((original_names & edited_names) - changed):
        original_entry = original_archive.by_name[name]
        edited_entry = edited_archive.by_name[name]
        original_span = original_archive.raw[
            original_entry.local_offset:original_entry.span_end
        ]
        edited_span = edited_archive.raw[
            edited_entry.local_offset:edited_entry.span_end
        ]
        if edited_span != original_span:
            issues.append(f"unchanged local ZIP record differs: {name}")
    return issues


def check_wellformed(zipped: zipfile.ZipFile) -> dict[str, str]:
    targets = [
        name
        for name in zipped.namelist()
        if name.lower().endswith((".xml", ".hpf")) and not name.endswith("/")
    ]
    result: dict[str, str] = {}
    for name in targets:
        try:
            parse_xml(zipped.read(name))
            result[name] = "OK"
        except Exception as error:  # noqa: BLE001 - verifier reports every parser failure
            result[name] = f"MALFORMED: {error}"
    return result


def zip_integrity(path: str | os.PathLike[str]) -> dict[str, bool]:
    archive = inspect_archive(path)
    first = archive.entries[0] if archive.entries else None
    with zipfile.ZipFile(path) as zipped:
        broken = zipped.testzip()
        try:
            mimetype = zipped.read("mimetype")
        except KeyError:
            mimetype = b""
    return {
        "testzip_ok": broken is None,
        "mimetype_first": first is not None and first.name == "mimetype",
        "mimetype_stored": first is not None and first.name == "mimetype" and first.method == zipfile.ZIP_STORED,
        "mimetype_value": mimetype == b"application/hwp+zip",
    }


def manifest_issues(zipped: zipfile.ZipFile) -> list[str]:
    names = set(zipped.namelist())
    if "Contents/content.hpf" not in names:
        return ["manifest Contents/content.hpf is missing"]
    try:
        manifest = parse_xml(zipped.read("Contents/content.hpf"))
    except Exception as error:  # noqa: BLE001
        return [f"manifest is malformed: {error}"]

    items: dict[str, ET.Element] = {}
    issues: list[str] = []
    hrefs: set[str] = set()
    href_owners: dict[str, list[str]] = {}
    for item in manifest.iter(f"{OPF}item"):
        item_id = item.get("id")
        href = item.get("href")
        if not item_id or not href:
            issues.append("manifest item is missing id or href")
            continue
        if item_id in items:
            issues.append(f"manifest has duplicate item id {item_id!r}")
        items[item_id] = item
        owners = href_owners.setdefault(href, [])
        owners.append(item_id)
        if len(owners) > 1:
            issues.append(f"manifest has duplicate href {href!r} for ids {owners!r}")
        hrefs.add(href)
        if href not in names:
            issues.append(f"manifest item {item_id!r} points to missing entry {href!r}")

    references: set[str] = set()
    for section in section_names(zipped):
        root = parse_xml(zipped.read(section))
        for image in root.iter(f"{HC}img"):
            reference = image.get("binaryItemIDRef")
            if reference:
                references.add(reference)
    for reference in sorted(references):
        item = items.get(reference)
        if item is None:
            issues.append(f"image reference {reference!r} is absent from manifest")
            continue
        if item.get("href") not in names:
            issues.append(f"image reference {reference!r} has no ZIP payload")
        if not (item.get("media-type") or "").startswith("image/"):
            issues.append(f"image reference {reference!r} has a non-image media type")
    for name in sorted(names):
        if re.fullmatch(r"BinData/(?:image|img)\d+\.(?:png|jpe?g|bmp|gif)", name, re.IGNORECASE):
            if name not in hrefs:
                issues.append(f"image ZIP entry {name!r} is absent from manifest")
    return issues


def structural_counts(root: ET.Element) -> dict[str, int]:
    return {
        "p": sum(1 for _ in root.iter(f"{HP}p")),
        "tbl": sum(1 for _ in root.iter(f"{HP}tbl")),
        "pic": sum(1 for _ in root.iter(f"{HP}pic")),
        "equation": sum(1 for _ in root.iter(f"{HP}equation")),
        "linesegarray": sum(1 for _ in root.iter(f"{HP}linesegarray")),
    }


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _find_eocd(raw: bytes) -> int:
    start = max(0, len(raw) - 22 - 0xFFFF)
    cursor = raw.rfind(b"PK\x05\x06", start)
    if cursor < 0 or cursor + 22 > len(raw):
        raise UnsafeZipError("ZIP end-of-central-directory record is missing.")
    return cursor


def _guard_entry_features(flags: int, method: int, disk_start: int, extra: bytes) -> None:
    if flags & 0x0001 or flags & 0x0040 or flags & 0x2000:
        raise UnsafeZipError("Encrypted ZIP entries are not supported.")
    if flags & 0x0008:
        raise UnsafeZipError("ZIP data descriptors are not supported.")
    if method not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise UnsafeZipError(f"Unsupported ZIP compression method: {method}.")
    if disk_start != 0:
        raise UnsafeZipError("Multi-disk ZIP entries are not supported.")
    _guard_extra(extra)


def _guard_extra(extra: bytes) -> None:
    cursor = 0
    while cursor < len(extra):
        if cursor + 4 > len(extra):
            raise UnsafeZipError("Malformed ZIP extra field.")
        field_id, length = struct.unpack_from("<HH", extra, cursor)
        cursor += 4
        if cursor + length > len(extra):
            raise UnsafeZipError("Truncated ZIP extra field.")
        if field_id == 0x0001:
            raise UnsafeZipError("ZIP64 extra fields are not supported.")
        cursor += length


def _guard_entry_name(name: str) -> None:
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        raise UnsafeZipError(f"Unsafe ZIP entry name: {name!r}.")
    if re.match(r"^[A-Za-z]:", name) or any(part == ".." for part in name.split("/")):
        raise UnsafeZipError(f"Unsafe ZIP entry name: {name!r}.")


def _decode_name(name: bytes, flags: int) -> str:
    encoding = "utf-8" if flags & 0x0800 else "cp437"
    try:
        return name.decode(encoding)
    except UnicodeDecodeError as error:
        raise UnsafeZipError("ZIP entry name cannot be decoded safely.") from error


def _compress(data: bytes, method: int) -> bytes:
    if method == zipfile.ZIP_STORED:
        return data
    compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
    return compressor.compress(data) + compressor.flush()


def _guard_classic_sizes(first: int, second: int) -> None:
    if first > 0xFFFFFFFF or second > 0xFFFFFFFF:
        raise UnsafeZipError("Output would require ZIP64 sizes.")
