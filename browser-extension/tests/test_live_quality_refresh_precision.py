from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_page_tap_accepts_youtube_videoplayback_without_file_extension():
    main = read('src/content/page-tap-main.ts')
    assert 'SMART_STREAM_URL_RE' in main
    assert '/videoplayback\\b' in main
    assert 'mime=(?:video|audio)' in main
    assert 'isSmartStreamUrl(u.href, mimeHint)' in main
    assert 'responseUrl = response.url || requestUrl' in main
    assert "'fetch'" in main
    assert 'this.responseURL || resolved' in main
    assert "'xhr'" in main


def test_page_tap_extracts_immediate_quality_metadata_from_signed_stream_urls():
    main = read('src/content/page-tap-main.ts')
    for token in ['itag', 'clen', 'dur', 'quality_label', 'YOUTUBE_ITAG_QUALITY']:
        assert token in main
    for field in ['sizeBytes', 'width', 'height', 'bitrate', 'durationSec', 'qualityLabel']:
        assert field in main
    assert 'extensionFromMime(mime)' in main
    assert 'mediaHintFromMime(mime)' in main


def test_bridge_and_runtime_schema_allow_live_quality_metadata_safely():
    bridge = read('src/content/page-tap-bridge.ts')
    schema = read('src/contracts/messages.schema.ts')
    for text in [bridge, schema]:
        assert "'performance-resource'" in text
        assert 'sizeBytes: z.number().int().nonnegative().optional()' in text
        assert 'width: z.number().int().positive().optional()' in text
        assert 'height: z.number().int().positive().optional()' in text
        assert 'qualityLabel: z.string().max(64).optional()' in text
        assert 'itag: z.string().max(16).optional()' in text


def test_background_preserves_page_tap_quality_fields_in_candidates():
    router = read('src/background/message-router.ts')
    for assignment in ['sizeBytes: ev.sizeBytes', 'width: ev.width', 'height: ev.height', 'bitrate: ev.bitrate', 'durationSec: ev.durationSec']:
        assert assignment in router
    assert "assistiveSource: 'page-tap-live-quality'" in router
    assert 'buildPageTapFilename(ev)' in router
    assert 'mediaTypeFromPageTapHint(ev.mediaHint)' in router


def test_picker_uses_stable_overlay_ids_and_canonical_stream_keys_to_avoid_duplicates():
    scanner = read('src/content/scanner.ts')
    assert "c.id?.startsWith('overlay-video-')" in scanner
    assert 'canonicalPickerUrlKey(c.url)' in scanner
    assert "parsed.searchParams.get('itag')" in scanner
    assert "parsed.searchParams.delete(volatile)" in scanner
