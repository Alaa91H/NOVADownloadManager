from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_aggressive_permission_enforcer_disables_mode_on_revocation():
    source = read('src/profiles/aggressive-permission-enforcer.ts')
    assert 'browser.permissions.onRemoved.addListener' in source
    assert 'disableAggressiveCapture(settings)' in source
    assert "permissions.onRemoved" in source
    assert 'AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions' in source
    assert 'AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins' in source


def test_aggressive_permission_enforcement_runs_before_boot_and_lifecycle_settings():
    assert "enforceAggressivePermissions('background.boot')" in read('src/background/main.ts')
    assert 'registerAggressivePermissionRevocationWatcher()' in read('src/background/main.ts')
    assert "enforceAggressivePermissions('lifecycle.auto-connect')" in read('src/background/lifecycle.ts')
    assert "enforceAggressivePermissions('runtime.GET_SETTINGS')" in read('src/background/message-router.ts')


def test_diagnostics_exposes_aggressive_permission_integrity():
    router = read('src/background/message-router.ts')
    assert 'getAggressivePermissionIntegrity' in router
    assert 'permissionIntegrity: aggressiveIntegrity' in router
    assert 'missingOrigins.length === 0' in router


def test_aggressive_guard_is_part_of_highest_verification():
    package = read('package.json')
    assert 'guard:aggressive-permissions' in package
    assert 'tools/aggressive-permission-policy-check.ts' in package
    assert 'pnpm guard:aggressive-permissions' in package
