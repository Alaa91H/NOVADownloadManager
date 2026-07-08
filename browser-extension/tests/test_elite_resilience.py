from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_bridge_uses_single_flight_for_connection_and_outbox() -> None:
    bridge = read('src/bridge/bridge-manager.ts')
    single = read('src/core/single-flight.ts')
    assert 'export class SingleFlight' in single
    assert 'private readonly connectFlight = new SingleFlight<BridgeState>();' in bridge
    assert 'private readonly outboxFlight = new SingleFlight<void>();' in bridge
    assert 'return this.connectFlight.run(() => this.autoConnectInternal());' in bridge
    assert 'await this.outboxFlight.run(async () => {' in bridge


def test_storage_migrations_run_before_bridge_boot_and_lifecycle_autoconnect() -> None:
    migration = read('src/storage/migration-store.ts')
    main = read('src/background/main.ts')
    lifecycle = read('src/background/lifecycle.ts')
    diagnostics = read('src/background/message-router.ts')
    assert 'CURRENT_STORAGE_SCHEMA_VERSION = 4' in migration
    assert 'SettingsSchema.safeParse' in migration
    assert 'BridgeStateSchema.safeParse' in migration
    assert "CANDIDATE_INDEX_KEY = 'nova.candidateCache.index'" in migration
    assert 'await new MigrationStore().migrate();' in main
    assert "await enforceAggressivePermissions('background.boot');" in main
    assert 'await bridgeManager.init();' in main
    assert 'await new MigrationStore().migrate();' in lifecycle
    assert "await enforceAggressivePermissions('lifecycle.auto-connect');" in lifecycle
    assert 'const settings = await new SettingsStore().get();' in lifecycle
    assert 'storageMigration' in diagnostics


def test_page_scan_requires_explicit_user_activation() -> None:
    router = read('src/background/message-router.ts')
    context_menus = read('src/background/context-menus.ts')
    assert 'Page scanning requires an explicit user action.' in router
    assert "code: 'PERMISSION_MISSING'" in router
    assert 'userActivated: true' in context_menus


def test_outbox_dead_letter_count_supports_store_shape() -> None:
    store = read('src/outbox/outbox-store.ts')
    popup_status = read('src/ui/popup/OutboxStatus.tsx')
    assert 'deadLetter' in store
    assert "'dead-letter' | 'deadLetter'" in popup_status
    assert "counts?.deadLetter ?? counts?.['dead-letter']" in popup_status


def test_candidate_cache_clear_all_removes_stale_cache_keys() -> None:
    cache = read('src/storage/candidate-cache.ts')
    assert 'browser.storage.local.get(null)' in cache
    assert "key.startsWith('nova.candidateCache.')" in cache
    assert '...discoveredKeys' in cache


def test_diagnostics_surface_storage_schema_status() -> None:
    panel = read('src/ui/diagnostics/DiagnosticsPanel.tsx')
    router = read('src/background/message-router.ts')
    assert 'storageMigration?: { schemaVersion?: number; migratedAt?: string }' in panel
    assert '<h2>Storage</h2>' in panel
    assert 'migrationStore.status()' in router
