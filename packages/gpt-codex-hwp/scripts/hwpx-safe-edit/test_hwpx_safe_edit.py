from __future__ import annotations

import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile
import zlib


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import hwpxlib as H  # noqa: E402
import insert_image as I  # noqa: E402


HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HC = "http://www.hancom.co.kr/hwpml/2011/core"
HS = "http://www.hancom.co.kr/hwpml/2011/section"
OPF = "http://www.idpf.org/2007/opf/"


class SafeEditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="hwpx-safe-edit-")
        self.root = Path(self.temp.name).resolve(strict=True)
        self.source = self.root / "source.hwpx"
        self.image = self.root / "image.png"
        self.source.write_bytes(make_hwpx())
        self.image.write_bytes(make_png(8, 4))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_noop_identity_is_in_memory_and_does_not_write_beside_source(self) -> None:
        self.assertEqual(self.root, self.root.resolve(strict=True))
        before = sorted(self.root.iterdir())
        temp_paths: list[Path] = []
        real_named_tempfile = tempfile.NamedTemporaryFile

        def tracked_tempfile(*args, **kwargs):
            handle = real_named_tempfile(*args, **kwargs)
            temp_paths.append(Path(handle.name))
            return handle

        with mock.patch.object(H.tempfile, "NamedTemporaryFile", side_effect=tracked_tempfile):
            self.assertTrue(H.self_verify_identical(self.source))
        self.assertEqual(before, sorted(self.root.iterdir()))
        self.assertFalse((self.root / "source.hwpx.noop.tmp").exists())
        self.assertEqual(len(temp_paths), 1)
        self.assertNotEqual(temp_paths[0].parent, self.source.parent)
        self.assertFalse(temp_paths[0].exists())

        archive = H.inspect_archive(self.source)
        with mock.patch.object(H, "inspect_archive", return_value=archive):
            rebuilt = H.repack_preserve_bytes(self.source, {})
        self.assertIsNot(rebuilt, archive.raw)

    def test_insert_uses_numeric_sections_occurrence_same_parent_and_exact_picture_shape(self) -> None:
        output = self.root / "output.hwpx"
        result = I.insert_image(
            self.source,
            output,
            image_path=self.image,
            anchor_text="대상",
            occurrence=1,
            width_mm=25.4,
        )

        self.assertEqual(result["section_index"], 0)
        self.assertEqual(result["image_entry"], "BinData/image1.png")
        self.assertEqual(result["display_width_hu"], 7200)
        self.assertEqual(result["display_height_hu"], 3600)
        with zipfile.ZipFile(output) as edited, zipfile.ZipFile(self.source) as original:
            section = H.parse_xml(edited.read("Contents/section0.xml"))
            self.assertEqual(
                edited.read("Contents/section2.xml"),
                original.read("Contents/section2.xml"),
            )
            self.assertEqual(
                edited.read("Contents/section10.xml"),
                original.read("Contents/section10.xml"),
            )
            self.assertEqual(section.findall(f".//{{{HP}}}linesegarray"), [])
            table_anchor = next(
                p
                for p in section.iter(f"{{{HP}}}p")
                if "표 안 대상" in H.paragraph_own_text(p)
            )
            parents = H.parent_map(section)
            parent = parents[table_anchor]
            siblings = list(parent)
            new_para = siblings[siblings.index(table_anchor) + 1]
            self.assertEqual(new_para.tag, f"{{{HP}}}p")
            picture = new_para.find(f".//{{{HP}}}pic")
            self.assertIsNotNone(picture)
            assert picture is not None
            self.assertEqual(
                [local_name(child.tag) for child in picture],
                [
                    "offset", "orgSz", "curSz", "flip", "rotationInfo",
                    "renderingInfo", "imgRect", "imgClip", "inMargin",
                    "imgDim", "img", "effects", "sz", "pos", "outMargin",
                    "shapeComment",
                ],
            )
            self.assertEqual(picture.find(f"{{{HP}}}orgSz").attrib, {"width": "600", "height": "300"})
            self.assertEqual(picture.find(f"{{{HP}}}curSz").attrib, {"width": "7200", "height": "3600"})
            scale = picture.find(f"{{{HP}}}renderingInfo/{{{HC}}}scaMatrix")
            self.assertEqual(scale.get("e1"), "12")
            self.assertEqual(scale.get("e5"), "12")
            pos = picture.find(f"{{{HP}}}pos")
            self.assertEqual(pos.get("treatAsChar"), "1")
            self.assertEqual(pos.get("flowWithText"), "1")
            image_ref = picture.find(f"{{{HC}}}img")
            self.assertEqual(image_ref.get("binaryItemIDRef"), result["item_id"])
            self.assertEqual(edited.read(result["image_entry"]), self.image.read_bytes())
            manifest = H.parse_xml(edited.read("Contents/content.hpf"))
            item = next(
                item
                for item in manifest.iter(f"{{{OPF}}}item")
                if item.get("id") == result["item_id"]
            )
            self.assertEqual(item.get("href"), result["image_entry"])
            self.assertEqual(item.get("media-type"), "image/png")
            self.assertEqual(item.get("isEmbeded"), "1")

    def test_anchor_search_skips_note_content_and_sorts_sections_numerically(self) -> None:
        output = self.root / "numeric.hwpx"
        result = I.insert_image(
            self.source,
            output,
            image_path=self.image,
            anchor_text="대상",
            occurrence=2,
        )
        self.assertEqual(result["section_index"], 2)
        with zipfile.ZipFile(output) as edited:
            self.assertIn(b"binaryItemIDRef", edited.read("Contents/section2.xml"))
            self.assertNotIn(b"binaryItemIDRef", edited.read("Contents/section10.xml"))

    def test_occurrence_counts_each_nonoverlapping_match_within_one_paragraph(self) -> None:
        source = self.root / "repeated.hwpx"
        output = self.root / "repeated-output.hwpx"
        source.write_bytes(make_single_section_hwpx("중복, 다시 중복"))

        result = I.insert_image(
            source,
            output,
            image_path=self.image,
            anchor_text="중복",
            occurrence=1,
        )

        self.assertTrue(result["ok"])
        with zipfile.ZipFile(output) as edited:
            section = H.parse_xml(edited.read("Contents/section0.xml"))
            self.assertEqual(sum(1 for _ in section.iter(f"{{{HP}}}pic")), 1)

    def test_anchor_selection_returns_before_later_match_heavy_sections(self) -> None:
        first = object()

        def eligible(root):
            if root == "later-root":
                raise AssertionError("later sections must not be scanned after selection")
            return [first]

        with (
            mock.patch.object(H, "eligible_paragraphs", side_effect=eligible),
            mock.patch.object(H, "paragraph_own_text", return_value="앵커"),
        ):
            section_name, paragraph = I.select_anchor_paragraph(
                ["Contents/section0.xml", "Contents/section1.xml"],
                {
                    "Contents/section0.xml": "first-root",
                    "Contents/section1.xml": "later-root",
                },
                "앵커",
                0,
            )

        self.assertEqual(section_name, "Contents/section0.xml")
        self.assertIs(paragraph, first)

    def test_output_is_exclusive_and_existing_bytes_are_preserved(self) -> None:
        output = self.root / "existing.hwpx"
        output.write_bytes(b"keep")
        with self.assertRaises(FileExistsError):
            I.insert_image(
                self.source,
                output,
                image_path=self.image,
                anchor_text="대상",
                occurrence=0,
            )
        self.assertEqual(output.read_bytes(), b"keep")

    def test_write_exclusive_leaves_an_orphan_instead_of_unlinking_after_failure(self) -> None:
        output = self.root / "replacement-safe.hwpx"

        def fail_write(_descriptor: int, _data: memoryview) -> int:
            raise OSError("simulated short write failure")

        with mock.patch.object(H.os, "write", side_effect=fail_write):
            with self.assertRaises(OSError):
                H.write_exclusive(output, b"candidate")

        self.assertTrue(output.exists())
        self.assertEqual(output.read_bytes(), b"")

    @unittest.skipUnless(os.name == "nt", "Windows path syntax only")
    def test_direct_helper_rejects_alternate_data_stream_output(self) -> None:
        output = str(self.root / "output.hwpx") + ":hidden"
        with self.assertRaises(H.UnsafePathError):
            I.insert_image(
                self.source,
                output,
                image_path=self.image,
                anchor_text="대상",
            )

    def test_image_identity_skips_existing_image_number_in_any_extension(self) -> None:
        collision = self.root / "collision.hwpx"
        H.repack_preserve(
            self.source,
            {},
            collision,
            added={"BinData/image1.jpg": b"\xff\xd8\xff\xd9"},
        )
        archive = H.inspect_archive(collision)
        with zipfile.ZipFile(collision) as zipped:
            manifest = H.parse_xml(zipped.read("Contents/content.hpf"))

        self.assertEqual(I.next_image_identity(archive, manifest), ("image2", "BinData/image2.png"))

    def test_image_identity_also_skips_unmanifested_section_reference(self) -> None:
        archive = H.inspect_archive(self.source)
        with zipfile.ZipFile(self.source) as zipped:
            manifest = H.parse_xml(zipped.read("Contents/content.hpf"))
        section = H.parse_xml(
            f'''<hs:sec xmlns:hs="{HS}" xmlns:hp="{HP}" xmlns:hc="{HC}"><hp:p><hp:run><hp:pic><hc:img binaryItemIDRef="ImAgE1"/></hp:pic></hp:run></hp:p></hs:sec>'''.encode()
        )

        self.assertEqual(
            I.next_image_identity(archive, manifest, [section]),
            ("image2", "BinData/image2.png"),
        )

    def test_image_identity_reserves_manifest_hrefs_and_verifier_rejects_duplicate_href(self) -> None:
        archive = H.inspect_archive(self.source)
        duplicate_manifest = H.parse_xml(
            f'''<opf:package xmlns:opf="{OPF}"><opf:manifest>
            <opf:item id="foo" href="BinData/image1.png" media-type="image/png"/>
            <opf:item id="bar" href="BinData/image1.png" media-type="image/png"/>
            </opf:manifest></opf:package>'''.encode()
        )
        self.assertEqual(
            I.next_image_identity(archive, duplicate_manifest),
            ("image2", "BinData/image2.png"),
        )

        duplicate = self.root / "duplicate-href.hwpx"
        H.repack_preserve(
            self.source,
            {"Contents/content.hpf": H.serialize_xml(duplicate_manifest)},
            duplicate,
        )
        with zipfile.ZipFile(duplicate) as zipped:
            issues = H.manifest_issues(zipped)
        self.assertTrue(any("duplicate href" in issue for issue in issues), issues)

    def test_direct_helper_rejects_signed_and_encrypted_package_markers(self) -> None:
        baseline = self.source.stat()
        ctime_shift = mock.Mock(
            st_dev=baseline.st_dev,
            st_ino=baseline.st_ino,
            st_size=baseline.st_size,
            st_mtime_ns=baseline.st_mtime_ns,
            st_ctime_ns=baseline.st_ctime_ns + 1,
        )
        mtime_shift = mock.Mock(
            st_dev=baseline.st_dev,
            st_ino=baseline.st_ino,
            st_size=baseline.st_size,
            st_mtime_ns=baseline.st_mtime_ns + 1,
            st_ctime_ns=baseline.st_ctime_ns,
        )
        self.assertTrue(I.same_file_snapshot(baseline, ctime_shift, platform="nt"))
        self.assertFalse(I.same_file_snapshot(baseline, ctime_shift, platform="posix"))
        self.assertFalse(I.same_file_snapshot(baseline, mtime_shift, platform="nt"))

        for name, entries, expected_code in (
            (
                "signed",
                {"_xmlsignatures/sig1.xml": b"<Signature/>"},
                "SIGNED_DOCUMENT",
            ),
            (
                "encrypted",
                {"META-INF/manifest.xml": b"<manifest><encryption-data/></manifest>"},
                "ENCRYPTED",
            ),
        ):
            source = self.root / f"{name}.hwpx"
            output = self.root / f"{name}-output.hwpx"
            H.repack_preserve(self.source, {}, source, added=entries)
            with self.subTest(name=name):
                with self.assertRaises(I.ProtectedDocumentError) as caught:
                    I.insert_image(
                        source,
                        output,
                        image_path=self.image,
                        anchor_text="대상",
                    )
                self.assertEqual(caught.exception.code, expected_code)
                self.assertFalse(output.exists())

    def test_direct_helper_rejects_case_equivalent_duplicate_manifests(self) -> None:
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("meta-inf/MANIFEST.XML", b"<manifest/>")
            zipped.writestr(
                "META-INF/manifest.xml",
                b"<manifest><encryption-data/></manifest>",
            )
        archive.seek(0)

        with zipfile.ZipFile(archive) as zipped:
            with self.assertRaises(I.ProtectedDocumentError) as caught:
                I.guard_protected_package(zipped)

        self.assertEqual(
            caught.exception.code,
            "INVALID_HWPX_PROTECTION_METADATA",
        )

    def test_archive_guard_rejects_descriptor_zip64_encryption_and_signature(self) -> None:
        raw = self.source.read_bytes()
        for name, poisoned in {
            "descriptor": patch_first_flags(raw, 0x0008),
            "encrypted": patch_first_flags(raw, 0x0001),
            "zip64": patch_eocd_entry_count(raw, 0xFFFF),
            "signed": inject_central_signature(raw),
            "oversized-entry": patch_first_uncompressed_size(
                raw,
                H.MAX_ENTRY_UNCOMPRESSED_BYTES + 1,
            ),
        }.items():
            path = self.root / f"{name}.hwpx"
            path.write_bytes(poisoned)
            with self.subTest(name=name), self.assertRaises(H.UnsafeZipError):
                H.inspect_archive(path)

    def test_verifier_reports_manifest_and_new_duplicate_id_failures(self) -> None:
        good = self.root / "good.hwpx"
        I.insert_image(
            self.source,
            good,
            image_path=self.image,
            anchor_text="대상",
            occurrence=0,
        )
        command = [
            sys.executable,
            "-X",
            "utf8",
            str(SCRIPT_DIR / "verify.py"),
            str(good),
            "--orig",
            str(self.source),
            "--allow-changed",
            "Contents/content.hpf",
            "--allow-changed",
            "Contents/section0.xml",
            "--allow-added",
            "BinData/image1.png",
        ]
        passed = subprocess.run(command, text=True, encoding="utf-8", capture_output=True, check=False)
        self.assertEqual(passed.returncode, 0, passed.stdout + passed.stderr)
        self.assertIn("RESULT: all hard checks PASSED", passed.stdout)
        self.assertIn("structural validation only", passed.stdout)
        self.assertNotIn("safe to open", passed.stdout)

        bad = self.root / "bad-manifest.hwpx"
        with zipfile.ZipFile(good) as z:
            changed = {
                "Contents/content.hpf": z.read("Contents/content.hpf").replace(
                    b"BinData/image1.png", b"BinData/missing1.png"
                )
            }
        H.repack_preserve(good, changed, bad)
        failed = subprocess.run(
            [sys.executable, "-X", "utf8", str(SCRIPT_DIR / "verify.py"), str(bad)],
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("manifest", failed.stdout.lower())

    def test_verifier_checks_unchanged_raw_entries_and_document_global_ids(self) -> None:
        good = self.root / "good-global.hwpx"
        I.insert_image(
            self.source,
            good,
            image_path=self.image,
            anchor_text="대상",
            occurrence=0,
        )

        recompressed = self.root / "recompressed.hwpx"
        with zipfile.ZipFile(good) as source_zip, zipfile.ZipFile(recompressed, "w") as output_zip:
            for info in source_zip.infolist():
                clone = zipfile.ZipInfo(info.filename, info.date_time)
                clone.compress_type = info.compress_type
                clone.comment = info.comment
                clone.extra = info.extra
                clone.internal_attr = info.internal_attr
                clone.external_attr = info.external_attr
                clone.create_system = info.create_system
                if info.filename == "Contents/section2.xml":
                    clone.date_time = (2024, 1, 2, 3, 4, 6)
                output_zip.writestr(clone, source_zip.read(info.filename))
        raw_failure = subprocess.run(
            [
                sys.executable,
                "-X",
                "utf8",
                str(SCRIPT_DIR / "verify.py"),
                str(recompressed),
                "--orig",
                str(self.source),
            ],
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(raw_failure.returncode, 0, raw_failure.stdout)
        self.assertIn("raw", raw_failure.stdout.lower())

        global_duplicate = self.root / "global-duplicate.hwpx"
        with zipfile.ZipFile(good) as zipped:
            section2 = H.parse_xml(zipped.read("Contents/section2.xml"))
        paragraph = next(section2.iter(f"{{{HP}}}p"))
        paragraph.set("id", "1")
        H.repack_preserve(
            good,
            {"Contents/section2.xml": H.serialize_xml(section2)},
            global_duplicate,
        )
        duplicate_failure = subprocess.run(
            [
                sys.executable,
                "-X",
                "utf8",
                str(SCRIPT_DIR / "verify.py"),
                str(global_duplicate),
                "--orig",
                str(self.source),
            ],
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(duplicate_failure.returncode, 0, duplicate_failure.stdout)
        self.assertIn("duplicate", duplicate_failure.stdout.lower())

    def test_descriptor_control_is_one_strict_bounded_frame_with_exact_scalar_keys(self) -> None:
        payload = {
            "sourceSize": len(self.source.read_bytes()),
            "imageSize": len(self.image.read_bytes()),
            "anchorText": "대상",
            "occurrence": 1,
            "widthMm": 25.4,
        }
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        frame = struct.pack(">I", len(encoded)) + encoded
        self.assertEqual(I.read_descriptor_control(io.BytesIO(frame)), payload)

        class ChunkedStream(io.BytesIO):
            def read(self, size: int = -1) -> bytes:
                return super().read(1 if size > 1 else size)

        self.assertEqual(I.read_descriptor_control(ChunkedStream(frame)), payload)

        duplicate = b'{"sourceSize":1,"sourceSize":2,"imageSize":1,"anchorText":"a","occurrence":0}'
        invalid_frames = [
            struct.pack(">I", I.MAX_DESCRIPTOR_CONTROL_BYTES + 1),
            struct.pack(">I", 2) + b"\xff}",
            struct.pack(">I", len(duplicate)) + duplicate,
            frame + b"trailing",
            struct.pack(">I", 1) + b"{",
        ]
        for invalid in invalid_frames:
            with self.subTest(invalid=invalid[:20]):
                with self.assertRaises(ValueError):
                    I.read_descriptor_control(io.BytesIO(invalid))

    def test_invalid_descriptor_control_is_rejected_before_any_data_descriptor_io(self) -> None:
        malformed = struct.pack(">I", 1) + b"{"
        with (
            mock.patch.object(I, "read_exact_descriptor") as read_data,
            mock.patch.object(I, "write_descriptor") as write_data,
        ):
            with self.assertRaises(ValueError):
                I.run_descriptor_mode(io.BytesIO(malformed))
        read_data.assert_not_called()
        write_data.assert_not_called()

    def test_path_cli_rejects_oversized_inputs_before_any_full_read_or_byte_transform(self) -> None:
        oversized_source = self.root / "oversized-source.hwpx"
        with oversized_source.open("wb") as stream:
            stream.truncate(H.MAX_ARCHIVE_BYTES + 1)
        oversized_image = self.root / "oversized-image.png"
        with oversized_image.open("wb") as stream:
            stream.truncate(I.MAX_IMAGE_BYTES + 1)

        cases = [
            (oversized_source, self.image, H.UnsafeZipError),
            (self.source, oversized_image, I.InvalidImageError),
        ]
        for index, (source, image, expected) in enumerate(cases):
            with self.subTest(source=source.name, image=image.name):
                output = self.root / f"oversized-{index}.hwpx"
                with (
                    mock.patch.object(Path, "read_bytes", side_effect=AssertionError("full read")),
                    mock.patch.object(I, "insert_image_bytes") as transform,
                ):
                    with self.assertRaises(expected):
                        I.insert_image(
                            source,
                            output,
                            image_path=image,
                            anchor_text="대상",
                        )
                transform.assert_not_called()
                self.assertFalse(output.exists())

    def test_oversized_synthetic_output_is_rejected_before_descriptor_or_path_write(self) -> None:
        class OversizedResult:
            def __len__(self) -> int:
                return H.MAX_ARCHIVE_BYTES + 1

        oversized = OversizedResult()
        with mock.patch.object(I.os, "write") as descriptor_write:
            with self.assertRaises(H.UnsafeZipError):
                I.write_descriptor(5, oversized)  # type: ignore[arg-type]
        descriptor_write.assert_not_called()

        output = self.root / "oversized-output.hwpx"
        with (
            mock.patch.object(I, "insert_image_bytes", return_value=(oversized, {})),
            mock.patch.object(H, "write_exclusive") as path_write,
        ):
            with self.assertRaises(H.UnsafeZipError):
                I.insert_image(
                    self.source,
                    output,
                    image_path=self.image,
                    anchor_text="대상",
                )
        path_write.assert_not_called()


def make_hwpx() -> bytes:
    manifest = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:opf="{OPF}"><opf:manifest>
<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
<opf:item id="section2" href="Contents/section2.xml" media-type="application/xml"/>
<opf:item id="section10" href="Contents/section10.xml" media-type="application/xml"/>
</opf:manifest><opf:spine/></opf:package>'''.encode()
    section0 = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="{HS}" xmlns:hp="{HP}">
  <hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>본문 대상</hp:t></hp:run><hp:linesegarray/></hp:p>
  <hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl id="20" instid="21"><hp:tr><hp:tc><hp:subList>
    <hp:p id="3" paraPrIDRef="7" styleIDRef="0"><hp:run charPrIDRef="4"><hp:t>표 안 대상</hp:t></hp:run></hp:p>
  </hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>
  <hp:p id="4"><hp:run><hp:ctrl><hp:endNote instId="22"><hp:subList><hp:p id="5"><hp:run><hp:t>제외 대상</hp:t></hp:run></hp:p></hp:subList></hp:endNote></hp:ctrl></hp:run></hp:p>
</hs:sec>'''.encode()
    section2 = section_xml(30, "숫자 섹션 대상")
    section10 = section_xml(40, "열 번째 섹션 대상")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("Contents/content.hpf", manifest, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("Contents/section0.xml", section0, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("Contents/section2.xml", section2, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("Contents/section10.xml", section10, compress_type=zipfile.ZIP_DEFLATED)
    return out.getvalue()


def section_xml(identifier: int, text: str) -> bytes:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="{HS}" xmlns:hp="{HP}"><hp:p id="{identifier}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>{text}</hp:t></hp:run></hp:p></hs:sec>'''.encode()


def make_single_section_hwpx(text: str) -> bytes:
    manifest = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:opf="{OPF}"><opf:manifest><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine/></opf:package>'''.encode()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("Contents/content.hpf", manifest, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("Contents/section0.xml", section_xml(1, text), compress_type=zipfile.ZIP_DEFLATED)
    return out.getvalue()


def make_png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + (b"\x20\x60\xa0\xff" * width) for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def patch_first_flags(raw: bytes, mask: int) -> bytes:
    data = bytearray(raw)
    local = data.index(b"PK\x03\x04")
    central = data.index(b"PK\x01\x02")
    struct.pack_into("<H", data, local + 6, struct.unpack_from("<H", data, local + 6)[0] | mask)
    struct.pack_into("<H", data, central + 8, struct.unpack_from("<H", data, central + 8)[0] | mask)
    return bytes(data)


def patch_eocd_entry_count(raw: bytes, count: int) -> bytes:
    data = bytearray(raw)
    eocd = data.rfind(b"PK\x05\x06")
    struct.pack_into("<H", data, eocd + 8, count)
    struct.pack_into("<H", data, eocd + 10, count)
    return bytes(data)


def inject_central_signature(raw: bytes) -> bytes:
    eocd = raw.rfind(b"PK\x05\x06")
    return raw[:eocd] + b"PK\x05\x05\x00\x00" + raw[eocd:]


def patch_first_uncompressed_size(raw: bytes, size: int) -> bytes:
    data = bytearray(raw)
    local = data.index(b"PK\x03\x04")
    central = data.index(b"PK\x01\x02")
    struct.pack_into("<I", data, local + 22, size)
    struct.pack_into("<I", data, central + 24, size)
    return bytes(data)


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


if __name__ == "__main__":
    unittest.main()
