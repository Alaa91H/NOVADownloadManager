from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_runtime_message_budget_runs_before_schema_validation() -> None:
    router = read('src/background/message-router.ts')
    budget = read('src/security/runtime-message-budget.ts')
    limits = read('src/contracts/limits.ts')

    assert 'MAX_RUNTIME_MESSAGE_BYTES' in limits
    assert 'assertRuntimeMessageBudget(raw)' in router
    assert router.index('assertRuntimeMessageBudget(raw)') < router.index('RuntimeMessageSchema.safeParse(raw)')
    assert 'Runtime message exceeded the safe extension boundary budget' in budget


def test_large_imports_are_budgeted_before_expensive_schema_parsing() -> None:
    schema = read('src/contracts/messages.schema.ts')
    router = read('src/background/message-router.ts')
    settings_store = read('src/storage/settings-store.ts')

    assert "type: z.literal('IMPORT_SETTINGS'), settings: z.unknown()" in schema
    assert "type: z.literal('IMPORT_SITE_RULES'), rules: z.unknown()" in schema
    assert "assertStorageBudget('settings-import', settings)" in router
    assert "assertStorageBudget('site-rules-import', msg.rules)" in router
    assert "assertStorageBudget('settings-import', parsed)" in settings_store


def test_trusted_ui_sender_matching_is_exact_not_substring_based() -> None:
    policy = read('src/security/page-scan-policy.ts')

    assert 'TRUSTED_EXTENSION_UI_PATHS' in policy
    assert "'/popup.html'" in policy
    assert "'/options.html'" in policy
    assert "'/diagnostics.html'" in policy
    assert '.some((surface) => pathname.includes(surface))' not in policy


def test_all_user_triggered_scan_paths_share_rate_limit() -> None:
    router = read('src/background/message-router.ts')
    context = read('src/background/context-menus.ts')
    commands = read('src/background/commands.ts')

    assert 'assertScanRateLimit(activeTabId)' in router
    assert 'assertScanRateLimit(activeTabId)' in context
    assert 'assertScanRateLimit(tabId)' in commands


def test_csp_pins_adm_loopback_port_and_guard_rejects_wildcards() -> None:
    manifest = read('src/manifest.json')
    wxt = read('wxt.config.ts')
    guard = read('tools/manifest-source-policy-check.ts')

    assert 'http://127.0.0.1:3199' in manifest
    assert 'ws://127.0.0.1:3199' in manifest
    assert '127.0.0.1:*' not in manifest
    assert '127.0.0.1:*' not in wxt
    assert 'must not use wildcard ports' in guard


def test_mv3_lifecycle_captures_boot_errors() -> None:
    main = read('src/background/main.ts')
    lifecycle = read('src/background/lifecycle.ts')

    assert "boot().catch" in main
    assert "lifecycle auto-connect failed" in lifecycle
    assert "background boot failed" in main


def test_runtime_guard_is_part_of_highest_verification() -> None:
    package_json = read('package.json')
    guard = read('tools/runtime-boundary-policy-check.ts')

    assert 'guard:runtime' in package_json
    assert 'runtime-boundary-policy-check.ts' in package_json
    assert 'pnpm guard:runtime' in package_json
    assert 'Runtime boundary policy passed' in guard
