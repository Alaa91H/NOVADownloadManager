from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_permission_requests_are_allowlisted_before_browser_api() -> None:
    policy = read('src/security/permission-request-policy.ts')
    permission_policy = read('src/rules/permission-policy.ts')

    assert 'ALLOWED_OPTIONAL_PERMISSIONS' in policy
    assert "'downloads'" in policy
    assert "'webRequest'" in policy
    assert "'scripting'" in policy
    assert 'ALLOWED_SCHEMED_HOST_ORIGIN' in policy
    assert 'forbiddenPermissions' in policy
    assert 'forbiddenOrigins' in policy
    assert 'validatePermissionRequest(permissions, origins)' in permission_policy
    assert 'browser.permissions.request({ permissions: requested.permissions' in permission_policy


def test_task_commands_validate_task_ids_before_transport() -> None:
    limits = read('src/contracts/limits.ts')
    task_policy = read('src/security/task-command-policy.ts')
    bridge = read('src/bridge/bridge-manager.ts')
    messages = read('src/contracts/messages.schema.ts')

    assert 'MAX_TASK_ID_CHARS = 256' in limits
    assert 'assertTaskIdSafe' in task_policy
    assert 'control characters' in task_policy
    assert 'const safeTaskId = assertTaskIdSafe(taskId);' in bridge
    assert 'encodeURIComponent(safeTaskId)' in bridge
    assert 'z.string().trim().min(1).max(MAX_TASK_ID_CHARS)' in messages


def test_single_candidate_send_uses_payload_budget() -> None:
    bridge = read('src/bridge/bridge-manager.ts')
    send_candidate_section = bridge.split('async sendCandidateNow', 1)[1].split('async sendBatchNow', 1)[0]

    assert 'assertHandoffPayloadBudget([candidate]);' in send_candidate_section


def test_page_scanner_bounds_media_and_open_graph_collections() -> None:
    limits = read('src/contracts/limits.ts')
    scanner = read('src/background/tab-scanner.ts')
    router = read('src/background/message-router.ts')

    assert 'MAX_SCAN_MEDIA = 1_000' in limits
    assert 'MAX_SCAN_OPEN_GRAPH = 200' in limits
    assert 'const MEDIA_LIMIT = 1_000;' in scanner
    assert 'const OPEN_GRAPH_LIMIT = 200;' in scanner
    assert "querySelectorAll('video,audio,img')].slice(0, MEDIA_LIMIT)" in scanner
    assert 'Array.from(metas).slice(0, OPEN_GRAPH_LIMIT)' in scanner
    assert 'maxMedia: MAX_SCAN_MEDIA' in router
    assert 'maxOpenGraph: MAX_SCAN_OPEN_GRAPH' in router
