from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_runtime_message_policy_blocks_sensitive_messages_from_content_scripts() -> None:
    policy = read('src/security/runtime-message-policy.ts')
    router = read('src/background/message-router.ts')

    assert 'export function assertRuntimeMessageAllowed' in policy
    assert "const PASSIVE_MESSAGES = new Set<RuntimeMessage['type']>(['GET_BRIDGE_STATE']);" in policy
    for message in [
        'SEND_BATCH',
        'CLEAR_LOCAL_DATA',
        'REQUEST_PERMISSION',
        'GET_DIAGNOSTICS',
        'GET_SETTINGS',
        'LIST_TASKS',
        'PAUSE_TASK',
        'OPEN_ADM',
    ]:
        assert f"'{message}'" in policy
    assert 'requires a trusted extension UI sender' in policy
    assert 'assertRuntimeMessageAllowed(msg, sender);' in router


def test_scan_snapshot_json_ld_is_bounded() -> None:
    limits = read('src/contracts/limits.ts')
    scanner = read('src/background/tab-scanner.ts')

    assert 'MAX_SCAN_JSON_LD_ITEMS = 50' in limits
    assert 'MAX_SCAN_JSON_LD_SCRIPT_CHARS = 120_000' in limits
    assert 'MAX_SCAN_JSON_LD_TOTAL_CHARS = 250_000' in limits
    assert 'const JSON_LD_SCRIPT_LIMIT = 120_000;' in scanner
    assert 'const JSON_LD_TOTAL_LIMIT = 250_000;' in scanner
    assert 'if (rawText.length > JSON_LD_SCRIPT_LIMIT) continue;' in scanner
    assert 'if (totalChars + rawText.length > JSON_LD_TOTAL_LIMIT) break;' in scanner


def test_site_rules_are_bounded_in_schema_storage_and_migration() -> None:
    limits = read('src/contracts/limits.ts')
    rules = read('src/rules/site-rules.ts')
    messages = read('src/contracts/messages.schema.ts')
    store = read('src/storage/site-rules-store.ts')
    migration = read('src/storage/migration-store.ts')

    assert 'MAX_SITE_RULES = 500' in limits
    assert 'MAX_SITE_RULE_PATTERNS = 100' in limits
    assert 'MAX_SITE_RULE_PATTERN_CHARS = 512' in limits
    assert 'host: z.string().min(1).max(MAX_SITE_RULE_HOST_CHARS)' in rules
    assert 'z.array(z.string().max(MAX_SITE_RULE_PATTERN_CHARS)).max(MAX_SITE_RULE_PATTERNS)' in rules
    assert 'z.array(SiteRuleSchema).max(MAX_SITE_RULES)' in messages
    assert 'const SiteRulesArraySchema = SiteRuleSchema.array().max(MAX_SITE_RULES);' in store
    assert 'SITE_RULES_KEY = \'adm.siteRules\'' in migration
    assert 'SiteRulesArraySchema.safeParse' in migration
    assert 'slice(0, MAX_SITE_RULES)' in migration
    assert 'CURRENT_STORAGE_SCHEMA_VERSION = 3' in migration


def test_manifest_source_policy_is_part_of_highest_verification() -> None:
    package = json.loads(read('package.json'))
    guard = read('tools/manifest-source-policy-check.ts')
    verify = package['scripts']['verify:highest']

    assert 'pnpm manifest:policy' in verify
    assert package['scripts']['manifest:policy'] == 'tsx tools/manifest-source-policy-check.ts'
    assert 'Store builds must expose integration permissions as optional.' in guard
    assert 'Store builds must keep broad host access optional' in guard
    assert 'src/manifest.json CSP must not contain unsafe-inline or unsafe-eval.' in guard


def test_diagnostics_surface_active_security_policy() -> None:
    router = read('src/background/message-router.ts')
    panel = read('src/ui/diagnostics/DiagnosticsPanel.tsx')

    assert 'securityPolicy: {' in router
    assert 'maxJsonLdTotalChars' in router
    assert 'uiOnlyDiagnosticsSettingsTasks' in router
    assert 'securityPolicy?: Record<string, unknown>;' in panel
    assert '<h2>Security policy</h2>' in panel
