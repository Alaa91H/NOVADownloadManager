from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_preflight_requires_current_production_guards() -> None:
    preflight = read('tools/preflight.mjs')

    assert "'tools/production-guard.ts'" in preflight
    assert "'tools/e2e-readiness-check.ts'" in preflight
    assert 'store permission policy term missing' in preflight
    assert 'packageManager must stay pnpm@11.6.0' in preflight


def test_floating_panel_position_is_bounded_and_persistent() -> None:
    panel = read('src/content/floating-panel.ts')
    assert "PANEL_POSITION_KEY = 'nova-floating-panel-position-v1'" in panel
    assert 'clampPanelCoordinate' in panel
    assert 'restoreSavedPosition' in panel
    assert 'persistSavedPosition' in panel
    assert 'positionAtVideo' in panel
