from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_popup_wires_bridge_candidate_and_download_workflows() -> None:
    popup = read('src/ui/popup/PopupApp.tsx')
    assert 'GET_BRIDGE_STATE' in popup
    assert 'OPEN_NOVA' in popup
    assert 'CandidateList' in popup
    assert 'SCAN_PAGE' in popup
    assert 'SEND_BATCH' in popup
    assert 'GET_CANDIDATES' in popup
    assert 'SEND_CANDIDATE' in popup
    assert 'DOWNLOAD_DIRECT' in popup
    assert 'ANALYZE_MEDIA' in popup
    assert 'QualityTable' in popup


def test_store_manifest_keeps_user_activation_scan_viable() -> None:
    config = read('wxt.config.ts')
    assert "'activeTab'" in config
    assert "'scripting'" in config
    assert "optional_permissions" in config


def test_diagnostics_reports_runtime_context() -> None:
    router = read('src/background/message-router.ts')
    assert 'browser.runtime.getManifest()' in router
    assert 'getBrowserInfo' in router
    assert 'extension:' in router
    assert 'storageMigration' in router
    assert 'aggressiveIntegrity' in router
    assert 'permissionPolicy.diagnostics' in router
