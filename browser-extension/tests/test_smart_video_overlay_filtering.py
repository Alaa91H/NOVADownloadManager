from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_smart_video_overlay_settings_are_enabled_by_default_and_configurable():
    schema = read('src/contracts/settings.schema.ts')
    options = read('src/ui/options/OverlaySettings.tsx')
    assert 'smartVideoOnlyOnVideoPages: z.boolean().default(true)' in schema
    assert 'smartVideoMaxItems: z.number().int().min(1).max(200).default(60)' in schema
    assert 'smartVideoContinuousRefresh: z.boolean().default(true)' in schema
    assert 'smartVideoRefreshMs: z.number().int().min(250).max(15000).default(1000)' in schema
    assert 'Smart video-page mode' in options
    assert 'Video-page item limit' in options
    assert 'Continuous quality discovery' in options
    assert 'Refresh interval ms' in options
    assert 'smartVideoOnlyOnVideoPages: true' in options
    assert 'smartVideoOnlyOnVideoPages: false' in options  # power-user escape hatch


def test_content_overlay_hint_ignores_non_video_noise_on_video_pages():
    scanner = read('src/content/scanner.ts')
    assert 'isSmartVideoOverlayContext' in scanner
    assert 'SMART_VIDEO_OVERLAY_MEDIA_TYPES' in scanner
    assert "new Set<OverlayMediaType>(['video', 'manifest'])" in scanner
    assert 'smartVideoOnlyOnVideoPages && isSmartVideoOverlayContext()' in scanner
    assert "overlayHintMatchesSettings(url, settings, tag, type, smartVideoMode)" in scanner


def test_background_overlay_filters_youtube_noise_and_only_renders_video_candidates():
    router = read('src/background/message-router.ts')
    assert 'SMART_VIDEO_NOISE_URL_RE' in router
    assert 'ytimg\\.com' in router
    assert 'googleads' in router
    assert "'smart-video-page-filter'" in router
    assert 'isSmartVideoCandidate(candidate)' in router
    assert 'prepareSmartVideoCandidates' in router
    assert 'settings.overlay.smartVideoMaxItems' in router
    assert 'Video page detected. Non-video assets such as thumbnails' in router


def test_smart_video_picker_uses_clean_page_title_instead_of_long_stream_url():
    router = read('src/background/message-router.ts')
    assert 'withSmartVideoDisplayName' in router
    assert 'sanitizeVideoTitle' in router
    assert "replace(/\\s+-\\s+YouTube$/i, '')" in router
    assert 'overlaySmartVideoDisplayName' in router


def test_smart_video_candidates_expand_variants_and_sort_by_resolution():
    router = read('src/background/message-router.ts')
    assert 'expandSmartVideoVariants(candidates)' in router
    assert 'overlayVariant: true' in router
    assert 'estimateSizeFromBitrate(variant.bandwidth, durationSec)' in router
    assert '.sort(smartVideoCompare)' in router
    assert 'resolutionPixels(b) - resolutionPixels(a)' in router
    assert 'YOUTUBE_ITAG_VIDEO_PROFILES' in router
    assert 'withSmartVideoStableId' in router
    assert 'stableHash(smartVideoDedupeKey(candidate))' in router


def test_overlay_picker_displays_only_name_extension_size_and_resolution():
    scanner = read('src/content/scanner.ts')
    assert 'candidateExtensionText(candidate)' in scanner
    assert 'candidateSizeText(candidate, locale)' in scanner
    assert 'candidateResolutionText(candidate)' in scanner
    assert 'adm-picker-item-ext' in scanner
    assert 'adm-picker-item-resolution' in scanner
    assert 'candidateSecondary' not in scanner


def test_overlay_picker_refreshes_candidates_while_open():
    scanner = read('src/content/scanner.ts')
    assert 'smartVideoContinuousRefresh' in scanner
    assert 'smartVideoRefreshMs' in scanner
    assert 'refreshPickerCandidates' in scanner
    assert 'OVERLAY_REFRESH_CANDIDATES' in scanner
    assert 'OVERLAY_REFRESH_MESSAGE_TYPE' in scanner
    assert 'mergeOverlayCandidates(pickerCandidates, fresh)' in scanner
    assert 'requestLiveRefresh' in scanner
    assert 'VIDEO_OVERLAY_LIVE_REFRESH_EVENT' in scanner
    assert 'PerformanceObserver' in scanner
    assert 'browser.storage.onChanged.addListener(requestFromStorageChange)' in scanner


def test_overlay_refresh_is_cache_only_and_content_script_bound():
    messages = read('src/contracts/messages.schema.ts')
    policy = read('src/security/runtime-message-policy.ts')
    router = read('src/background/message-router.ts')
    scanner = read('src/content/scanner.ts')
    assert "z.object({ type: z.literal('OVERLAY_REFRESH_CANDIDATES') })" in messages
    assert "'OVERLAY_REFRESH_CANDIDATES'" in policy
    assert "case 'OVERLAY_REFRESH_CANDIDATES'" in router
    assert 'overlayRefreshCandidates' in router
    assert "scanProfile: 'cache-only'" in router
    assert "type: OVERLAY_REFRESH_MESSAGE_TYPE" in scanner
