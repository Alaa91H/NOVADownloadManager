from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_structured_errors_drive_transport_router_and_outbox() -> None:
    error_core = read('src/core/error-classification.ts')
    http = read('src/transport/http-transport.ts')
    native = read('src/transport/native-transport.ts')
    router = read('src/background/message-router.ts')
    retry = read('src/outbox/retry-worker.ts')

    assert 'class NovaExtensionError' in error_core
    assert 'parseErrorBody' in http
    assert "status === 401" in error_core
    assert 'NativeResponseSchema.parse' in native
    assert 'toNovaExtensionError' in router
    assert 'isRetryableHandoffError' in retry
    assert "status: !retryable || attempts >= MAX_ATTEMPTS ? 'dead-letter' : 'failed'" in retry


def test_bridge_recovers_expired_tokens_and_checks_batch_capabilities() -> None:
    bridge = read('src/bridge/bridge-manager.ts')
    assert 'authenticatedHttp' in bridge
    assert 'isAuthError(error)' in bridge
    assert 'await this.auth.clear()' in bridge
    assert "return this.tm.requestHttp(route, payload, schema, refreshedToken, method)" in bridge
    assert 'for (const candidate of candidates) this.requireCandidateCapabilities(candidate)' in bridge
    assert "this.caps.registry.require('candidate.directUrl')" in bridge


def test_candidate_cache_is_bounded_and_index_cleanup_is_explicit() -> None:
    cache = read('src/storage/candidate-cache.ts')
    assert 'MAX_CANDIDATES_PER_TAB = 250' in cache
    assert 'slice(0, MAX_CANDIDATES_PER_TAB)' in cache
    assert 'writeIndex((await index()).filter((id) => id !== tabId))' in cache


def test_signed_urls_are_preserved_for_downloads_but_redacted_for_display() -> None:
    url_utils = read('src/utils/url.ts')
    candidate_list = read('src/ui/popup/CandidateList.tsx')
    assert 'SIGNED_QUERY_KEYS' in url_utils
    assert 'safeDisplayUrl' in url_utils
    assert 'u.hash = \'\'' in url_utils
    assert 'safeDisplayUrl(redactString(candidate.url))' in candidate_list
