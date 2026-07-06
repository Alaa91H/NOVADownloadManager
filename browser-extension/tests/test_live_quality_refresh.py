from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_picker_refresh_is_event_driven_not_timer_only():
    scanner = read('src/content/scanner.ts')
    assert 'requestLiveRefresh' in scanner
    assert '`media-${event.type}`' in scanner
    assert 'performance-resource' in scanner
    assert 'candidate-cache-storage' in scanner
    assert 'picker-dom-mutation' in scanner
    assert 'minLiveRefreshDelayMs = 120' in scanner
    assert 'liveBurstUntil' in scanner


def test_background_notifies_content_when_network_cache_gets_new_candidates():
    cache = read('src/storage/candidate-cache.ts')
    network = read('src/background/network-observer.ts')
    assert 'ADM_CANDIDATE_CACHE_UPDATED' in cache
    assert 'browser.tabs' in cache and 'sendMessage(tabId' in cache
    assert "reason: 'network-headers'" in network
    assert "reason: 'network-redirect'" in network


def test_overlay_scan_merges_existing_network_cache_instead_of_overwriting_it():
    router = read('src/background/message-router.ts')
    assert 'scannedCandidates' in router
    assert 'cachedCandidates = await cache.merge(tabId, scannedCandidates' in router
    assert "notify: false, reason: 'overlay-scan-dom'" in router
    assert 'mergeLiveOverlayCandidateSet(cachedCandidates, scannedCandidates)' in router
    assert 'await cache.set(tabId, mergeLiveOverlayCandidateSet(candidates, pickerCandidates))' in router


def test_refresh_interval_allows_near_live_updates_with_resource_safety():
    schema = read('src/contracts/settings.schema.ts')
    options = read('src/ui/options/OverlaySettings.tsx')
    assert 'smartVideoRefreshMs: z.number().int().min(250).max(15000).default(1000)' in schema
    assert 'min={250}' in options
    assert 'Live media/network/DOM changes refresh immediately' in options
