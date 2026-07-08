from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_overlay_client_runtime_diagnostics_are_recorded_without_page_urls() -> None:
    scanner = read('src/content/scanner.ts')
    diagnostics = read('src/ui/diagnostics/DiagnosticsPanel.tsx')

    assert "OVERLAY_DIAGNOSTICS_STORAGE_KEY = 'nova.downloadOverlayDiagnostics.v1'" in scanner
    assert 'writeOverlayClientDiagnostics(patch' in scanner
    assert "state: 'created'" in scanner
    assert "state: 'moved'" in scanner
    assert "state: 'picker-open'" in scanner
    assert "state: 'picker-closed'" in scanner
    assert "state: 'destroyed'" in scanner
    assert 'viewportWidth: window.innerWidth' in scanner
    assert 'viewportHeight: window.innerHeight' in scanner
    assert 'location.href' not in scanner.split('function writeOverlayClientDiagnostics', 1)[1].split('function overlayRectSnapshot', 1)[0]

    assert 'Client state' in diagnostics
    assert 'Client placement' in diagnostics
    assert 'Picker client' in diagnostics
    assert 'Client runtime' in diagnostics


def test_overlay_observer_has_a_mutation_budget_and_reactivates_on_settings_change() -> None:
    scanner = read('src/content/scanner.ts')

    assert 'let mutationScanCount = 0' in scanner
    assert 'mutationScanCount > 160' in scanner
    assert "state: 'observer-paused'" in scanner
    assert "hiddenReason: 'mutation-budget-exhausted'" in scanner
    assert 'Math.min(1200, 350 + Math.floor(mutationScanCount / 20) * 100)' in scanner
    assert 'observer?.disconnect();' in scanner
    assert 'closed = false;' in scanner
    assert 'mutationScanCount = 0;' in scanner
    assert 'let relayScanCount = 0' in scanner
    assert 'relayScanCount > 120' in scanner


def test_overlay_picker_accessibility_selection_and_resize_cleanup_are_hardened() -> None:
    scanner = read('src/content/scanner.ts')

    assert "root.setAttribute('aria-labelledby', pickerTitleId)" in scanner
    assert "list.setAttribute('role', 'list')" in scanner
    assert "item.setAttribute('role', 'listitem')" in scanner
    assert 'function updateSelectionStatus()' in scanner
    assert 'sendBtn.disabled = selected === 0' in scanner
    assert 'window.addEventListener(\'resize\', keepPickerInViewport' in scanner
    assert 'window.removeEventListener(\'resize\', keepPickerInViewport)' in scanner
    assert 'updateSelectionStatus();' in scanner


def test_real_overlay_e2e_smoke_is_present_and_guarded() -> None:
    spec = read('src/tests/e2e/overlay.spec.ts')
    readiness = read('tools/e2e-readiness-check.ts')

    for term in [
        'NOVA floating overlay real content smoke',
        'RUN_REAL_EXTENSION_E2E',
        'startOverlayFixtureServer',
        '#nova-video-download-overlay-host',
        '.nova-video-download-trigger',
        '.nova-video-download-actions',
        '.nova-video-download-label',
        '#nova-candidate-picker-host',
        '.nova-picker-send',
    ]:
        assert term in spec
    assert 'overlayE2eSpec' in readiness
    assert 'E2E overlay content smoke test' in readiness
