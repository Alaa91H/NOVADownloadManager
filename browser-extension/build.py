#!/usr/bin/env python3
"""NOVA Browser Extension compatible build entrypoint.

This project keeps WXT as the canonical extension compiler, but exposes the
same top-level build contract used by Alaa91H/NOVA-Browser-Extension:

  python build.py --clean
  python build.py --clean --zip
  node scripts/run-python.js build.py --clean --zip --version "$GITHUB_REF_NAME"

Outputs are staged under dist/chromium, dist/firefox, dist/packages, and
dist/release-assets. Release assets contain browser packages only: Chrome, Edge, and Firefox
archives plus release metadata used by GitHub Releases and notifications.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(cmd: list[str], env: dict[str, str] | None = None) -> None:
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=ROOT, env=env or os.environ.copy(), check=True)


def pnpm_cmd() -> str:
    return "pnpm.cmd" if os.name == "nt" else "pnpm"


def validate_version(raw: str) -> str:
    version = raw.strip().removeprefix("v").split("+", 1)[0]
    if re.match(r"^\d+\.\d+\.\d+(?:\.\d+)?$", version):
        return version

    prerelease = re.match(r"^(\d+)\.(\d+)\.(\d+)-([0-9A-Za-z][0-9A-Za-z.-]*)$", version)
    if prerelease:
        major, minor, patch, prerelease_label = prerelease.groups()
        numeric_parts = [part for part in prerelease_label.split(".") if part.isdecimal()]
        prerelease_number = numeric_parts[-1] if numeric_parts else "0"
        return f"{major}.{minor}.{patch}.{prerelease_number}"

    raise SystemExit(
        f"Invalid extension version: {raw}. Use a tag like v1.2.3, v1.2.3.4, or v1.2.3-beta.4"
    )


def version_from_github_ref() -> str:
    ref_name = os.environ.get("GITHUB_REF_NAME", "")
    ref_type = os.environ.get("GITHUB_REF_TYPE", "")
    ref = os.environ.get("GITHUB_REF", "")
    if ref_type == "tag" and ref_name.startswith("v"):
        return validate_version(ref_name)
    if ref.startswith("refs/tags/v"):
        return validate_version(ref.rsplit("/", 1)[-1])
    return ""


def clean_outputs() -> None:
    for path in [ROOT / ".output", ROOT / "dist"]:
        if path.exists():
            shutil.rmtree(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clean", action="store_true", help="Remove generated artifacts before building.")
    parser.add_argument("--zip", action="store_true", help="Create deterministic browser packages.")
    parser.add_argument("--store", action="store_true", help="Also build the Chromium store-compliance profile.")
    parser.add_argument("--target", choices=["chromium", "chrome", "firefox", "edge", "all"], default="all", help="Build a single unpacked target or all default targets.")
    parser.add_argument("--version", default="", help="Override manifest/package version, with or without v prefix.")
    args = parser.parse_args()

    env = os.environ.copy()
    resolved_version = validate_version(args.version) if args.version else version_from_github_ref()
    if resolved_version:
        env["WXT_VERSION"] = resolved_version
        print(f"Using extension version from tag/override: {resolved_version}", flush=True)
    else:
        print("No release tag supplied; using development manifest version from package.json.", flush=True)

    if args.clean:
        clean_outputs()

    pnpm = pnpm_cmd()
    if args.zip:
        run([pnpm, "package:all"], env)
    else:
        if args.target in {"all", "chromium", "chrome"}:
            run([pnpm, "build:chrome"], env)
        if args.target in {"all", "firefox"}:
            run([pnpm, "build:firefox"], env)
        if args.target == "edge":
            run([pnpm, "build:edge"], env)

    if args.store:
        run([pnpm, "build:store"], env)

    if args.zip:
        run([pnpm, "release:artifacts"], env)
        run([pnpm, "release:metadata"], env)
    else:
        # Preserve NOVA Browser Extension dist layout even for unpacked-only builds.
        run([pnpm, "tsx", "tools/copy-artifacts.ts", "--allow-no-packages"], env)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)
