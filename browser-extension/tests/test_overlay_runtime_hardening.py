from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_overlay_scan_records_filter_reasons_and_runtime_diagnostics() -> None:
    router = read('src/background/message-router.ts')
    assert "OVERLAY_DIAGNOSTICS_STORAGE_KEY = 'adm.downloadOverlayDiagnostics.v1'" in router
    assert 'analyzeOverlayCandidates(candidates, settings, smartVideoMode)' in router
    for reason in [
        'low-confidence',
        'too-small',
        'too-large',
        'blocked-extension',
        'missing-allowlisted-extension',
        'media-type-rejected',
    ]:
        assert reason in router
    assert 'writeOverlayDiagnostics({ lastScan' in router
    assert 'overlayRuntimeDiagnostics()' in router
    assert 'runtime: overlayRuntime' in router


def test_overlay_picker_is_capped_and_safety_filtered_before_user_selection() -> None:
    router = read('src/background/message-router.ts')
    settings = read('src/contracts/settings.schema.ts')
    options = read('src/ui/options/OverlaySettings.tsx')
    assert 'handoffableCandidates = accepted.filter' in router
    assert 'handoffPolicyDecision(candidate).allowed' in router
    assert 'settings.overlay.maxPickerItems' in router
    assert 'clipped' in router
    assert 'maxPickerItems: z.number().int().min(10).max(500).default(100)' in settings
    assert 'Maximum picker items' in options


def test_overlay_accessibility_has_keyboard_nudge_idle_dimming_and_selection_defaults() -> None:
    scanner = read('src/content/scanner.ts')
    settings = read('src/contracts/settings.schema.ts')
    options = read('src/ui/options/OverlaySettings.tsx')
    assert "'aria-keyshortcuts'" in scanner
    assert "'Enter Space Escape ArrowUp ArrowDown ArrowLeft ArrowRight'" in scanner
    assert 'nudgeOverlay(event.key, event.shiftKey)' in scanner
    assert 'void saveOverlayPosition(host, settings)' in scanner
    assert 'settings.autoHideWhenIdle' in scanner
    assert 'isCandidateSelectedByDefault(candidate, settings)' in scanner
    assert "defaultPickerSelection: OverlayPickerSelectionSchema.default('high-confidence')" in settings
    assert 'Keyboard move step' in options
    assert 'Idle dimming' in options
    assert 'Default picker selection' in options


def test_overlay_i18n_keys_are_present_in_all_locale_bundles() -> None:
    locale_dir = ROOT / 'src/i18n/locales'
    bundles = sorted(locale_dir.glob('*.ts'))
    assert bundles
    reference_keys = set(re.findall(r"'([^']+)':", read('src/i18n/locales/en.ts')))
    for bundle in bundles:
        current = set(re.findall(r"'([^']+)':", bundle.read_text(encoding='utf-8')))
        assert not (reference_keys - current), f'{bundle.name} missing {sorted(reference_keys - current)}'
        assert not (current - reference_keys), f'{bundle.name} has extra {sorted(current - reference_keys)}'
    assert 'videoOverlay.selectAll' in reference_keys
    assert 'videoOverlay.clearSelection' in reference_keys
