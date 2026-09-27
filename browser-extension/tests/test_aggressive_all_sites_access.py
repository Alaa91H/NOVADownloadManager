from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_aggressive_profile_requires_explicit_all_sites_grant() -> None:
    profile = read('src/profiles/aggressive-capture-profile.ts')
    messages = read('src/contracts/messages.schema.ts')
    assert 'AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions' in profile
    assert 'AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins' in profile
    assert 'hasAllSitesAccess' in profile
    assert "type: z.literal('REQUEST_PERMISSION')" in messages
    assert 'aggressiveMode: false' in profile


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


def test_diagnostics_make_all_sites_state_explicit() -> None:
    profile = read('src/profiles/aggressive-capture-profile.ts')
    diagnostics = read('src/background/message-router.ts')
    assert 'Aggressive Capture Mode' in profile
    assert 'requiresAllSitesAccess: true' in diagnostics
    assert 'allSitesAccessGranted' in diagnostics
