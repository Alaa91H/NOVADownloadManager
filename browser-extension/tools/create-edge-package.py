#!/usr/bin/env python3
from __future__ import annotations

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.output'


def find_chrome_zip() -> Path:
    candidates = sorted(OUTPUT.glob('*-chrome-*.zip'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise SystemExit('Chrome ZIP not found under .output. Run package:chrome before package:edge.')
    return candidates[0]


def main() -> None:
    chrome_zip = find_chrome_zip()
    edge_zip = chrome_zip.with_name(chrome_zip.name.replace('-chrome-', '-edge-'))
    with zipfile.ZipFile(chrome_zip, 'r') as src, zipfile.ZipFile(edge_zip, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == 'manifest.json':
                manifest = json.loads(data.decode('utf-8'))
                manifest['name'] = 'NOVA Download Manager Extension for Edge'
                data = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            new_info = zipfile.ZipInfo(info.filename)
            new_info.date_time = (1980, 1, 1, 0, 0, 0)
            new_info.compress_type = zipfile.ZIP_DEFLATED
            new_info.external_attr = info.external_attr
            dst.writestr(new_info, data)
    print(f'Created Edge package: {edge_zip.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
