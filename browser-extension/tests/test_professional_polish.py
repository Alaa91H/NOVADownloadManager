from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_github_actions_use_current_official_versions():
    workflow = read('.github/workflows/ci.yml')
    setup = read('.github/actions/setup-extension-ci/action.yml')
    package = json.loads(read('package.json'))

    assert 'actions/checkout@v6.0.3' in workflow
    assert 'actions/upload-artifact@v7.0.1' in workflow
    assert 'actions/download-artifact@v8.0.1' in workflow
    assert 'softprops/action-gh-release@v3.0.0' in workflow
    assert 'pnpm/action-setup@v6.0.8' in setup
    assert 'Swatinem/rust-cache@v2.9.1' in setup
    assert 'actions/setup-node@v5' in setup
    assert 'actions:policy' in package['scripts']
    assert 'pnpm actions:policy' in package['scripts']['verify:highest']

    for old in ('actions/checkout@v5', 'actions/upload-artifact@v4', 'actions/download-artifact@v4', 'pnpm/action-setup@v4'):
        assert old not in workflow + setup


def test_runtime_error_handling_is_centralized():
    shared = read('src/ui/runtime-request.ts')
    assert 'RuntimeErrorResponseSchema' in read('src/contracts/runtime-response.schema.ts')
    assert 'isRuntimeErrorResponse' in shared
    assert 'runtimeErrorMessage' in shared
    assert 'function runtimeRequest' not in read('src/ui/popup/PopupApp.tsx')
    assert 'ok?: unknown' not in read('src/ui/popup/PopupApp.tsx')
    assert read('src/ui/options/runtime-request.ts').strip() == "export { runtimeRequest } from '../runtime-request';"


def test_retryable_autoconnect_failures_are_scheduled_with_alarms():
    bridge = read('src/bridge/bridge-manager.ts')
    alarms = read('src/background/alarms.ts')
    lifecycle = read('src/background/lifecycle.ts')
    main = read('src/background/main.ts')
    assert 'const retryAfterMs = normalized.retryable ? this.retry.next() : undefined;' in bridge
    assert "await this.setState({ status: 'reconnecting' });" in bridge
    assert 'scheduleReconnect(state.retryAfterMs)' in alarms
    assert 'scheduleReconnect(state.retryAfterMs)' in lifecycle
    assert 'scheduleReconnect(state.retryAfterMs)' in main


def test_event_stream_failures_are_visible():
    sse = read('src/transport/sse-transport.ts')
    ws = read('src/transport/websocket-transport.ts')
    assert "handlers.onError(new Error('SSE stream closed.'))" in sse
    assert 'try {' in ws and 'handlers.onError(error)' in ws


def test_architecture_guard_is_part_of_highest_verification():
    pkg = json.loads(read('package.json'))
    assert pkg['scripts']['guard:architecture'] == 'tsx tools/architecture-guard.ts'
    assert 'pnpm guard:architecture' in pkg['scripts']['verify:highest']
    guard = read('tools/architecture-guard.ts')
    assert 'direct fetch is only allowed in src/transport' in guard
    assert 'UI/content/capture code must not depend on BridgeManager directly' in guard
