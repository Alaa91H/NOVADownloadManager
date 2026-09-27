from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_overlay_defaults_to_permanent_download_close_bar_without_logo() -> None:
    schema = read('src/contracts/settings.schema.ts')
    scanner = read('src/content/scanner.ts')

    assert 'compactPermanentActions: z.boolean().default(true)' in schema
    assert 'showProgramLogo: z.boolean().default(false)' in schema
    assert 'attachPickerToOverlay: z.boolean().default(true)' in schema
    assert 'popover.dataset.compact = compactActions' in scanner
    assert 'if (showLogo)' in scanner
    assert 'positionCandidatePicker(picker, host, true)' in scanner
    assert 'makeDraggable(host, header, settings.attachPickerToOverlay ? anchor : undefined, settings)' in scanner


def test_overlay_customization_strings_exist_in_all_locales() -> None:
    locale_dir = ROOT / 'src/i18n/locales'
    required = [
        'overlay.options.compactPermanentActions',
        'overlay.options.showProgramLogo',
        'overlay.options.attachPickerToOverlay',
        'overlay.options.resetSavedPosition',
        'videoOverlay.download',
        'videoOverlay.close',
        'videoOverlay.selectAll',
        'videoOverlay.clearSelection',
        'videoOverlay.sendSelected',
    ]
    for path in locale_dir.glob('*.ts'):
        text = path.read_text(encoding='utf-8')
        for key in required:
            assert f"'{key}'" in text, f"{key} missing from {path.name}"
