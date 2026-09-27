from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_ci_does_not_duplicate_standalone_production_signoff_after_package_build() -> None:
    workflow = read('../docs/extension/ci-templates/legacy-extension-ci.yml')
    package_section = workflow.split('  package-build:', 1)[1].split('  browser-e2e:', 1)[0]

    assert 'pnpm signoff:production -- --strict' not in package_section
    assert 'Production signoff is covered by preflight/quality/package/E2E gates in CI.' in package_section
    assert 'production-signoff' not in package_section


def test_floating_panel_persists_safe_user_positioning() -> None:
    panel = read('src/content/floating-panel.ts')

    assert "PANEL_POSITION_KEY = 'nova-floating-panel-position-v1'" in panel
    assert 'restoreSavedPosition' in panel
    assert 'persistSavedPosition' in panel
    assert 'setupDrag' in panel
    assert 'dblclick' in panel
    assert 'resetPositionToVideo' in panel
