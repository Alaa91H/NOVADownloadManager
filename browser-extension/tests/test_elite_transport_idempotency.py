from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_http_transport_uses_bounded_request_and_response_reader():
    src = read('src/transport/http-transport.ts')
    assert 'encodeJsonPayloadWithBudget' in src
    assert 'readJsonResponseWithBudget' in src
    assert 'response.json()' not in src
    assert 'JSON.stringify(payload ?? {})' not in src


def test_native_transport_budgets_request_and_response_envelopes():
    src = read('src/transport/native-transport.ts')
    assert "assertNativeMessageBudget(request, 'request')" in src
    assert "assertNativeMessageBudget(raw, 'response')" in src


def test_outbox_retry_uses_leased_claims():
    store = read('src/outbox/outbox-store.ts')
    worker = read('src/outbox/retry-worker.ts')
    schema = read('src/outbox/handoff-job.ts')
    assert 'claimDue(owner' in store
    assert 'leaseOwner' in schema
    assert 'leaseExpiresAt' in schema
    assert 'claimDue(this.owner)' in worker
    assert 'leaseOwner: undefined' in worker


def test_idempotency_uses_versioned_canonical_fingerprint():
    src = read('src/outbox/idempotency.ts')
    assert 'IDEMPOTENCY_SCHEMA_VERSION' in src
    assert 'canonicalCandidate' in src
    assert 'normalizeUrl(candidate.url)' in src
    assert 'variants:' in src
    assert 'nova-extension-idempotency-v' in src


def test_transport_policy_guard_is_part_of_highest_verification():
    pkg = read('package.json')
    tool = read('tools/transport-budget-policy-check.ts')
    assert '"guard:transport"' in pkg
    assert 'pnpm guard:transport' in pkg
    assert 'Transport budget and idempotency policy passed.' in tool
