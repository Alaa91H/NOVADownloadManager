from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_aggressive_mode_is_opt_in_and_has_safe_defaults() -> None:
    settings = read('src/contracts/settings.schema.ts')
    profile = read('src/profiles/aggressive-capture-profile.ts')

    assert 'aggressiveMode: z.boolean().default(false)' in settings
    assert 'AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE' in profile
    assert 'AGGRESSIVE_REQUIRED_PERMISSIONS' in profile
    assert "'downloads', 'webRequest', 'scripting', 'tabs'" in profile
    assert "AGGRESSIVE_ALL_SITES_ORIGINS = ['<all_urls>']" in profile
    assert 'no cookies' in profile.lower()
    assert 'no Authorization headers' in profile


def test_aggressive_mode_options_enable_defaults_and_permission_bundle() -> None:
    capture = read('src/ui/options/CaptureSettings.tsx')
    permissions = read('src/ui/options/PermissionsSettings.tsx')

    assert 'Aggressive Capture Mode' in capture
    assert 'applyAggressiveCaptureDefaults(settings)' in capture
    assert "minFileSizeMB: 0" in read('src/profiles/aggressive-capture-profile.ts')
    assert 'Request aggressive all-sites permissions' in capture
    assert 'Request aggressive all-sites permission bundle' in permissions
    assert "type: 'REQUEST_PERMISSION'" in capture


def test_aggressive_scans_use_larger_bounded_budgets() -> None:
    limits = read('src/contracts/limits.ts')
    tab_scanner = read('src/background/tab-scanner.ts')
    content = read('src/content/scanner.ts')
    budget = read('src/security/scan-result-budget.ts')

    assert 'AGGRESSIVE_MAX_SCAN_LINKS = 8_000' in limits
    assert 'AGGRESSIVE_MAX_SCAN_MEDIA = 3_000' in limits
    assert 'AGGRESSIVE_MAX_SCAN_JSON_LD_TOTAL_CHARS = 800_000' in limits
    assert "aggressive ? 8_000 : 2_000" in tab_scanner
    assert 'scanPage(Boolean' in content
    assert "profile === 'aggressive'" in budget


def test_aggressive_mode_keeps_secret_boundaries() -> None:
    safe_headers = read('src/security/safe-headers.ts')
    profile = read('src/profiles/aggressive-capture-profile.ts')
    handoff_policy = read('src/security/handoff-policy.ts')

    assert 'Authorization headers' in safe_headers
    assert 'cookie' in safe_headers.lower()
    assert 'authorization' in safe_headers.lower()
    assert 'No hidden telemetry' in profile
    assert "blob:" in handoff_policy
    assert 'browser-local or ephemeral' in handoff_policy


def test_aggressive_mode_activates_observers_without_restart() -> None:
    router = read('src/background/message-router.ts')
    network = read('src/background/network-observer.ts')
    downloads = read('src/background/download-interceptor.ts')

    assert 'registerNetworkObserver' in router
    assert 'registerDownloadInterceptor' in router
    assert 'next.capture.aggressiveMode || next.capture.network' in router
    assert 'next.capture.aggressiveMode || next.capture.downloads' in router
    assert 'let networkObserverRegistered = false' in network
    assert 'let downloadInterceptorRegistered = false' in downloads


def test_manifest_describes_aggressive_mode_as_capture_only() -> None:
    profile = read('src/profiles/aggressive-capture-profile.ts')

    assert 'Aggressive Capture Mode' in profile
    assert 'capture' in profile.lower()
    assert 'No DRM bypass' in profile
