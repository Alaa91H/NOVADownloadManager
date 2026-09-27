from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_storage_budget_limits_are_declared() -> None:
    limits = read('src/contracts/limits.ts')
    assert 'MAX_CANDIDATE_CACHE_BYTES_PER_TAB' in limits
    assert 'MAX_CANDIDATE_METADATA_BYTES' in limits
    assert 'MAX_SETTINGS_IMPORT_BYTES' in limits
    assert 'MAX_SITE_RULES_IMPORT_BYTES' in limits
    assert 'MAX_DIAGNOSTICS_EXPORT_BYTES' in limits


def test_candidate_cache_is_byte_budgeted_not_only_count_limited() -> None:
    cache = read('src/storage/candidate-cache.ts')
    budget = read('src/security/storage-budget.ts')
    assert 'fitCandidatesWithinStorageBudget' in cache
    assert 'storageSafeCandidate' in budget
    assert 'compactMetadata' in budget
    assert 'MAX_CANDIDATE_METADATA_BYTES' in budget


def test_import_paths_enforce_storage_budgets() -> None:
    router = read('src/background/message-router.ts')
    site_rules = read('src/storage/site-rules-store.ts')
    assert "assertStorageBudget('settings-import'" in router
    assert "assertStorageBudget('site-rules-import'" in router
    assert "assertStorageBudget('site-rules-import'" in site_rules


def test_outbox_capacity_failure_is_explicit() -> None:
    outbox = read('src/outbox/outbox-store.ts')
    assert 'ensureCapacityForNewJob' in outbox
    assert "code: 'OUTBOX_FAILED'" in outbox
    assert 'Outbox is full' in outbox


def test_storage_guard_is_part_of_highest_verification() -> None:
    package_json = read('package.json')
    assert 'guard:storage' in package_json
    assert 'tools/storage-budget-policy-check.ts' in package_json
    assert 'pnpm guard:storage' in package_json


def test_outbox_insertion_is_idempotency_aware() -> None:
    outbox = read('src/outbox/outbox-store.ts')
    service = read('src/outbox/outbox-service.ts')
    assert 'addIfAbsent' in outbox
    assert "where('idempotencyKey')" in outbox
    assert "transaction('rw'" in outbox
    assert 'return this.store.addIfAbsent(job)' in service
