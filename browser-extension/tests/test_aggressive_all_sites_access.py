from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_aggressive_toggle_requests_all_sites_before_enable() -> None:
    capture = read('src/ui/options/CaptureSettings.tsx')
    assert "type: 'REQUEST_PERMISSION'" in capture
    assert 'AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions' in capture
    assert 'AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins' in capture
    assert 'summary.hasAllSitesAccess' in capture
    assert 'the mode remains off' in capture


def test_background_rejects_forced_aggressive_without_permissions() -> None:
    router = read('src/background/message-router.ts')
    assert 'assertAggressiveAllSitesAccess' in router
    assert 'next.capture.aggressiveMode' in router
    assert 'parsed.capture.aggressiveMode' in router
    assert 'PERMISSION_MISSING' in router
    assert '<all_urls>' in router


def test_aggressive_profile_documents_all_sites_capture() -> None:
    profile = read('src/profiles/aggressive-capture-profile.ts')
    assert 'AGGRESSIVE_CAPTURE_MODE_VERSION = 2' in profile
    assert "AGGRESSIVE_ALL_SITES_ORIGINS = ['<all_urls>']" in profile
    assert 'Chrome-style read/change site access on all websites' in profile


def test_options_and_diagnostics_make_all_sites_state_explicit() -> None:
    capture = read('src/ui/options/CaptureSettings.tsx')
    permissions = read('src/ui/options/PermissionsSettings.tsx')
    diagnostics = read('src/background/message-router.ts')
    assert 'Aggressive Capture Mode enabled with all-sites access' in capture
    assert 'Request aggressive all-sites permission bundle' in permissions
    assert 'requiresAllSitesAccess: true' in diagnostics
    assert 'allSitesAccessGranted' in diagnostics
