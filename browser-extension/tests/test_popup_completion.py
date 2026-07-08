from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_popup_wires_connection_candidate_and_task_surfaces() -> None:
    popup = read('src/ui/popup/PopupApp.tsx')
    # Connection panel and recovery actions remain present.
    assert 'nova-connection-panel' in popup
    assert 'GET_BRIDGE_STATE' in popup
    assert 'RETRY_CONNECT' in popup
    assert 'RESET_PAIRING' in popup
    assert 'OPEN_NOVA' in popup
    # Candidate review and task control surfaces are now wired into the popup
    # (the README promises candidates are shown and handed off from the popup).
    assert 'OutboxStatus' in popup
    assert 'TaskList' in popup
    assert 'CandidateList' in popup
    assert "SCAN_PAGE" in popup
    assert "SEND_BATCH" in popup
    assert "GET_CANDIDATES" in popup
    # Theme toggle behavior is preserved.
    assert 'THEME_STORAGE_KEY' in popup
    assert "return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';" in popup
    assert 'nova-theme-toggle' in popup
    assert 'toggleTheme' in popup


def test_store_manifest_keeps_user_activation_scan_viable() -> None:
    config = read('wxt.config.ts')
    assert "'activeTab'" in config
    assert "'scripting'" in config
    assert "optional_permissions" in config


def test_diagnostics_reports_runtime_context() -> None:
    router = read('src/background/message-router.ts')
    panel = read('src/ui/diagnostics/DiagnosticsPanel.tsx')
    assert 'browser.runtime.getManifest()' in router
    assert 'getBrowserInfo' in router
    assert 'extension:' in router
    assert 'Build target' in panel
    assert 'Browser' in panel
