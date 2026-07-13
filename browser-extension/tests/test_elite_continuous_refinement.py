
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_limits_do_not_redeclare_exported_constants():
    text = read("src/contracts/limits.ts")
    names = re.findall(r"^export const (\w+)", text, flags=re.MULTILINE)
    duplicates = sorted({name for name in names if names.count(name) > 1})
    assert duplicates == []


def test_loopback_url_policy_is_enforced_by_transports():
    policy = read("src/transport/loopback-url-policy.ts")
    assert "assertNovaLoopbackOrigin" in policy
    assert "127.0.0.1" in policy
    assert "localhost" in policy
    assert "3199" in policy
    assert "assertSafeLoopbackRoute" in policy
    assert "parent-directory traversal" in policy
    assert "must not include credentials" in policy

    http = read("src/transport/http-transport.ts")
    assert "DEFAULT_NOVA_LOOPBACK_HTTP_URL" in http
    assert "buildNovaLoopbackHttpUrl" in http
    assert "`${this.baseUrl}${route}`" not in http

    sse = read("src/transport/sse-transport.ts")
    ws = read("src/transport/websocket-transport.ts")
    assert "assertNovaLoopbackHttpUrl" in sse
    assert "assertNovaLoopbackWsUrl" in ws


def test_event_transports_have_payload_budgets():
    limits = read("src/contracts/limits.ts")
    assert "MAX_EVENT_MESSAGE_BYTES" in limits
    assert "MAX_SSE_BUFFER_BYTES" in limits
    assert "MAX_EVENT_PARSE_ERRORS_PER_CONNECTION" in limits
    assert "MAX_EVENT_MESSAGE_BYTES" in read("src/transport/sse-transport.ts")
    assert "MAX_SSE_BUFFER_BYTES" in read("src/transport/sse-transport.ts")
    assert "MAX_EVENT_MESSAGE_BYTES" in read("src/transport/websocket-transport.ts")


def test_pair_token_storage_is_ttl_aware_and_redacted_from_diagnostics():
    token_store = read("src/storage/token-store.ts")
    assert "expiresAt" in token_store
    assert "ttlSeconds" in token_store
    assert "legacy-string" in token_store
    assert "token: z.string().min(24)" in token_store
    assert "await this.clear()" in token_store

    bridge = read("src/bridge/bridge-manager.ts")
    assert "setToken(token, pair.ttlSeconds)" in bridge
    assert "tokenStatus" in bridge

    diagnostics = read("src/ui/diagnostics/DiagnosticsPanel.tsx")
    assert "Token:" in diagnostics
    assert "storageFormat" in diagnostics
    assert "pairToken" not in diagnostics


def test_package_hygiene_is_part_of_release_and_highest_verification():
    package_json = read("package.json")
    assert '"package:hygiene"' in package_json
    assert "pnpm package:hygiene" in package_json
    release_checks = read("tools/release-checks.ts")
    assert "package:hygiene" in release_checks
    hygiene = read("tools/package_hygiene_check.py")
    assert "node_modules" in hygiene
    assert "PRIVATE KEY" in hygiene
    assert "unsafe-inline|unsafe-eval" in hygiene
    assert "source" in hygiene and "sources" in hygiene
