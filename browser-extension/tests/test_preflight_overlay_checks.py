from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_preflight_checks_overlay_terms_in_their_own_files() -> None:
    preflight = read('tools/preflight.mjs')

    assert "assertFileIncludes('src/content/scanner.ts', term, 'floating overlay runtime hardening')" in preflight
    assert "assertFileIncludes('src/contracts/settings.schema.ts', term, 'floating overlay settings schema')" in preflight
    assert "assertFileIncludes('src/background/message-router.ts', term, 'floating overlay background filtering')" in preflight

    scanner_block = preflight.split('const overlayRuntimeTerms = [', 1)[1].split('];', 1)[0]
    assert 'maxPickerItems' not in scanner_block
    assert 'defaultPickerSelection' not in scanner_block

    settings_block = preflight.split('const overlaySettingsTerms = [', 1)[1].split('];', 1)[0]
    assert 'maxPickerItems' in settings_block
    assert 'defaultPickerSelection' in settings_block


def test_overlay_picker_cap_is_validated_where_it_is_used() -> None:
    assert 'maxPickerItems' in read('src/contracts/settings.schema.ts')
    assert 'settings.overlay.maxPickerItems' in read('src/background/message-router.ts')
    assert 'maxPickerItems' in read('src/ui/options/OverlaySettings.tsx')
