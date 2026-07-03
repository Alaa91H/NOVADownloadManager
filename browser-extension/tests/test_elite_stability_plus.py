from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_handoff_payload_budget_limits_are_enforced_at_all_boundaries() -> None:
    limits = read('src/contracts/limits.ts')
    payload_budget = read('src/security/payload-budget.ts')
    messages = read('src/contracts/messages.schema.ts')
    outbox = read('src/outbox/outbox-service.ts')
    bridge = read('src/bridge/bridge-manager.ts')

    assert 'MAX_HANDOFF_CANDIDATES = 100' in limits
    assert 'MAX_HANDOFF_PAYLOAD_BYTES = 1_500_000' in limits
    assert 'MAX_CANDIDATE_URL_CHARS = 8_192' in limits
    assert 'export function assertHandoffPayloadBudget' in payload_budget
    assert 'payload exceeds the safe extension budget' in payload_budget
    assert 'Too many candidates in one ADM handoff' in payload_budget
    assert 'z.array(CandidateSchema).min(1).max(MAX_HANDOFF_CANDIDATES)' in messages
    assert 'assertHandoffPayloadBudget(parsed);' in outbox
    assert 'assertHandoffPayloadBudget(candidates);' in bridge


def test_scan_user_activation_is_bound_to_extension_ui_sender_and_rate_limited() -> None:
    policy = read('src/security/page-scan-policy.ts')
    router = read('src/background/message-router.ts')

    assert 'isExtensionUiSender' in policy
    assert "['popup', 'options', 'diagnostics']" in policy
    assert 'User-activated page scanning is only accepted from extension UI surfaces.' in policy
    assert 'MAX_SCAN_REQUESTS_PER_TAB_PER_MINUTE' in policy
    assert 'assertScanRateLimit' in policy
    assert 'Page scan rate limit reached for this tab.' in policy
    assert 'onMessage.addListener((raw: unknown, sender: RuntimeMessageSenderLike)' in router
    assert 'dispatchMessage(parsed.data, sender)' in router
    assert 'assertUserActivatedScan(sender, userActivated);' in router
    assert 'assertScanRateLimit(activeTabId);' in router


def test_highest_verification_keeps_supply_chain_and_architecture_guards() -> None:
    package = json.loads(read('package.json'))
    verify = package['scripts']['verify:highest']
    for guard in [
        'pnpm deps:policy',
        'pnpm actions:policy',
        'pnpm guard:architecture',
        'pnpm validate:package',
        'pnpm guard:production',
        'pnpm verify:store',
    ]:
        assert guard in verify
