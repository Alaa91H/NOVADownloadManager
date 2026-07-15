#!/usr/bin/env python3
from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist' / 'packages' / 'NOVA-extension-source.zip'
EXCLUDED = {'.git', 'node_modules', '.output', 'dist', '.wxt', 'coverage', 'test-results', 'playwright-report', '.pytest_cache', '__pycache__'}
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def should_include(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in EXCLUDED for part in rel.parts):
        return False
    if path.suffix in {'.pyc', '.pyo'}:
        return False
    return path.is_file()


OUT.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(OUT, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted((p for p in ROOT.rglob('*', follow_symlinks=False) if should_include(p)), key=lambda item: item.relative_to(ROOT).as_posix()):
        rel = path.relative_to(ROOT).as_posix()
        info = zipfile.ZipInfo(rel)
        info.date_time = FIXED_ZIP_TIME
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())
print(f'Created {OUT.relative_to(ROOT)}')
