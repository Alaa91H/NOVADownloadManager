from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_shared_ui_theme_is_imported_by_popup_entrypoint():
    assert "import '../../ui/styles/theme.css';" in read('src/entrypoints/popup/main.tsx')


def test_popup_entrypoint_has_accessible_document_shell():
    html = read('src/entrypoints/popup/index.html')
    assert '<!doctype html>' in html.lower()
    assert 'meta name="viewport"' in html
    assert '<title>' in html


def test_popup_uses_polished_candidates_and_status_indicators():
    popup = read('src/ui/popup/PopupApp.tsx')
    candidate_list = read('src/ui/popup/CandidateList.tsx')
    css = read('src/ui/styles/theme.css')
    assert 'statusTone(bridge?.status)' in popup
    assert 'nova-popup' in popup
    assert 'color-scheme: dark;' in css
    assert 'className="nova-candidate"' in candidate_list
    assert '.nova-pill' in css


def test_popup_exposes_aggressive_capture_workflows():
    popup = read('src/ui/popup/PopupApp.tsx')
    profile = read('src/profiles/aggressive-capture-profile.ts')
    assert 'SCAN_PAGE' in popup
    assert 'SEND_BATCH' in popup
    assert 'Aggressive Capture Mode' in profile
    assert '<all_urls>' in profile


def test_diagnostics_are_structured_and_bounded_in_background():
    router = read('src/background/message-router.ts')
    assert 'securityPolicy:' in router
    assert 'storageMigration' in router
    assert 'assertStorageBudget(\'diagnostics-export\', diagnosticPayload)' in router
