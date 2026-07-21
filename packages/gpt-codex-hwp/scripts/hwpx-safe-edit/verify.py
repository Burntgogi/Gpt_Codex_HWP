#!/usr/bin/env python3
"""Read-only structural verification for edited HWPX documents.

The verification workflow and raw-preservation checks are adapted from
kangdacool/hwpx-editing-skill at commit
0d17930f4dc546dfa02123867b1f1060eb259572 (MIT License).  See the bundled
THIRD_PARTY_NOTICES.md for the full notice.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import zipfile

import hwpxlib as H


try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, ValueError, OSError):
    pass


def report(ok: bool, label: str, detail: str = "") -> bool:
    line = f"[{'PASS' if ok else 'FAIL'}] {label}"
    if detail:
        line += f" — {detail}"
    print(line)
    return ok


def verify(
    edited: Path,
    original: Path | None = None,
    *,
    allow_changed: tuple[str, ...] = (),
    allow_added: tuple[str, ...] = (),
) -> bool:
    hard_ok = True
    try:
        H.inspect_archive(edited)
        if original is not None:
            H.inspect_archive(original)
    except (OSError, H.NotHwpxError, H.UnsafeZipError) as error:
        report(False, "0. safe HWPX ZIP profile", str(error))
        return False
    hard_ok &= report(True, "0. safe HWPX ZIP profile")

    if original is not None:
        try:
            identical = H.self_verify_identical(original)
        except (OSError, H.NotHwpxError, H.UnsafeZipError) as error:
            identical = False
            detail = str(error)
        else:
            detail = "" if identical else "no-op repacker changed bytes"
        hard_ok &= report(
            identical,
            "1. no-op repack byte-identical to original",
            detail,
        )
        try:
            preservation_issues = H.raw_preservation_issues(
                original,
                edited,
                allow_changed=allow_changed,
                allow_added=allow_added,
            )
        except (OSError, H.NotHwpxError, H.UnsafeZipError) as error:
            preservation_issues = [str(error)]
        hard_ok &= report(
            not preservation_issues,
            "1b. every non-allowlisted local ZIP record preserves raw bytes",
            "; ".join(preservation_issues[:8]),
        )

    try:
        with zipfile.ZipFile(edited) as zipped:
            wellformed = H.check_wellformed(zipped)
            malformed = [f"{name}: {state}" for name, state in wellformed.items() if state != "OK"]
            hard_ok &= report(
                not malformed,
                "2. all HWPX XML is well-formed and entity-safe",
                "; ".join(malformed[:5]) if malformed else f"{len(wellformed)} entries OK",
            )

            original_zip: zipfile.ZipFile | None = None
            if original is not None:
                original_zip = zipfile.ZipFile(original)
            try:
                edited_roots = [
                    H.parse_xml(zipped.read(section))
                    for section in H.section_names(zipped)
                ]
                original_roots = []
                if original_zip is not None:
                    original_roots = [
                        H.parse_xml(original_zip.read(section))
                        for section in H.section_names(original_zip)
                    ]
                duplicate_issues = H.new_document_duplicate_ids(
                    edited_roots,
                    original_roots,
                )
                hard_ok &= report(
                    not duplicate_issues,
                    "3. no document-global edit-introduced duplicate ids",
                    str(duplicate_issues) if duplicate_issues else "",
                )
            finally:
                if original_zip is not None:
                    original_zip.close()

            manifest_issues = H.manifest_issues(zipped)
            hard_ok &= report(
                not manifest_issues,
                "4. manifest and image references are consistent",
                "; ".join(manifest_issues[:8]),
            )

            print("\n--- informational structure inventory ---")
            for section in H.section_names(zipped):
                counts = H.structural_counts(H.parse_xml(zipped.read(section)))
                print(
                    f"  {section}: p={counts['p']} tbl={counts['tbl']} "
                    f"pic={counts['pic']} eq={counts['equation']} "
                    f"lineseg={counts['linesegarray']}"
                )
    except (OSError, zipfile.BadZipFile, RuntimeError, ValueError) as error:
        hard_ok &= report(False, "2-4. parse and semantic verification", str(error))

    try:
        integrity = H.zip_integrity(edited)
    except (OSError, zipfile.BadZipFile, H.NotHwpxError, H.UnsafeZipError) as error:
        hard_ok &= report(False, "5. ZIP/mimetype integrity", str(error))
    else:
        hard_ok &= report(integrity["testzip_ok"], "5a. ZIP CRC test passes")
        hard_ok &= report(integrity["mimetype_first"], "5b. mimetype is the first entry")
        hard_ok &= report(integrity["mimetype_stored"], "5c. mimetype is STORED")
        hard_ok &= report(integrity["mimetype_value"], "5d. mimetype value is application/hwp+zip")
    return hard_ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run read-only HWPX structural checks.")
    parser.add_argument("edited", type=Path, help="edited .hwpx to verify")
    parser.add_argument("--orig", type=Path, help="original .hwpx for identity/id comparisons")
    parser.add_argument(
        "--allow-changed",
        action="append",
        default=[],
        metavar="ENTRY",
        help="ZIP entry allowed to change; repeat for each expected changed entry",
    )
    parser.add_argument(
        "--allow-added",
        action="append",
        default=[],
        metavar="ENTRY",
        help="ZIP entry allowed to be added; repeat for each expected new entry",
    )
    args = parser.parse_args(argv)
    ok = verify(
        args.edited,
        args.orig,
        allow_changed=tuple(args.allow_changed),
        allow_added=tuple(args.allow_added),
    )
    print()
    if ok:
        print(
            "RESULT: all hard checks PASSED — structural validation only; "
            "Hancom GUI compatibility was not tested."
        )
        return 0
    print("RESULT: one or more hard checks FAILED — fix before shipping.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
