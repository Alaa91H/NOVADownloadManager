#!/usr/bin/env python3
"""Validate generated browser packages before release upload.

This deliberately avoids npm dependencies so it can run inside GitHub Actions,
local Python-only checks, and the NOVA-extension compatible build wrapper.
"""
from __future__ import annotations

import io
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST_PACKAGES = ROOT / "dist" / "packages"
FORBIDDEN_NAME_PATTERNS = [
    re.compile(r"(^|/)node_modules/"),
    re.compile(r"(^|/)tests?/"),
    re.compile(r"(^|/)\.github/"),
    re.compile(r"(^|/)__pycache__/"),
    re.compile(r"(^|/)\.pytest_cache/"),
    re.compile(r"(^|/)\.env(?:\.|$)"),
    re.compile(r"(^|/)(id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.key)$", re.IGNORECASE),
    re.compile(r"(^|/)pnpm-lock\.yaml$"),
    re.compile(r"(^|/)package(?:-lock)?\.json$"),
]
TEXT_EXTENSIONS = {".js", ".json", ".html", ".css", ".txt"}
SECRET_PATTERNS = [
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----"),
    re.compile(rb"(?i)github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(rb"(?i)xox[baprs]-[A-Za-z0-9-]{20,}"),
]


def fail(message: str) -> None:
    print(f"package hygiene failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def validate_manifest(archive: Path, names: set[str]) -> None:
    if "manifest.json" not in names:
        fail(f"{archive.name} is missing manifest.json")


def validate_entry_name(archive: Path, name: str) -> None:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or ".." in normalized.split("/"):
        fail(f"{archive.name} contains unsafe archive entry {name!r}")
    for pattern in FORBIDDEN_NAME_PATTERNS:
        if pattern.search(normalized):
            fail(f"{archive.name} contains forbidden entry {name!r}")


def validate_entry_payload(archive: Path, name: str, data: bytes) -> None:
    suffix = Path(name).suffix.lower()
    if suffix not in TEXT_EXTENSIONS:
        return
    for pattern in SECRET_PATTERNS:
        if pattern.search(data):
            fail(f"{archive.name}:{name} appears to contain a private key or secret token")


def open_zip_payload(archive: Path):
    """Return a zip source for the archive, unwrapping the CRX3 header for .crx files."""
    if archive.suffix.lower() == ".crx":
        data = archive.read_bytes()
        if data[:4] == b"Cr24":
            header_length = int.from_bytes(data[8:12], "little")
            return io.BytesIO(data[12 + header_length:])
        return io.BytesIO(data)
    return archive


def validate_archive(archive: Path) -> None:
    with zipfile.ZipFile(open_zip_payload(archive), "r") as zf:
        names = set(zf.namelist())
        validate_manifest(archive, names)
        for info in zf.infolist():
            validate_entry_name(archive, info.filename)
            if info.file_size > 8_000_000:
                fail(f"{archive.name}:{info.filename} is unexpectedly large ({info.file_size} bytes)")
            validate_entry_payload(archive, info.filename, zf.read(info))
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        if manifest.get("manifest_version") != 3:
            fail(f"{archive.name} is not an MV3 package")
        csp = manifest.get("content_security_policy", {})
        if isinstance(csp, dict):
            csp_text = csp.get("extension_pages", "")
        else:
            csp_text = str(csp)
        if re.search(r"unsafe-inline|unsafe-eval", csp_text, re.IGNORECASE):
            fail(f"{archive.name} contains an unsafe CSP")


def main() -> None:
    if not DIST_PACKAGES.exists():
        fail("dist/packages is missing; run the package build first")
    archives = sorted([p for p in DIST_PACKAGES.iterdir() if p.suffix.lower() in {".zip", ".xpi", ".crx"} and "source" not in p.name.lower() and "sources" not in p.name.lower()])
    if not archives:
        fail("no browser package archives found under dist/packages")
    for archive in archives:
        validate_archive(archive)
    print(f"Package hygiene passed for {len(archives)} archive(s).")


if __name__ == "__main__":
    main()
