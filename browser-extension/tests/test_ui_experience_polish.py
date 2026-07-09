from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_shared_ui_theme_is_imported_by_all_react_entrypoints():
    for entrypoint in [
        'src/entrypoints/popup/main.tsx',
        'src/entrypoints/options/main.tsx',
        'src/entrypoints/diagnostics/main.tsx',
    ]:
        assert "import '../../ui/styles/theme.css';" in read(entrypoint)


def test_entrypoint_html_has_accessible_document_shells():
    for entrypoint in [
        'src/entrypoints/popup/index.html',
        'src/entrypoints/options/index.html',
        'src/entrypoints/diagnostics/index.html',
    ]:
        html = read(entrypoint)
        assert '<!doctype html>' in html.lower()
        assert 'meta name="viewport"' in html
        assert '<title>' in html


def test_popup_uses_polished_cards_and_status_pills():
    popup = read('src/ui/popup/PopupApp.tsx')
    candidate_list = read('src/ui/popup/CandidateList.tsx')
    connection = read('src/ui/popup/ConnectionStatus.tsx')
    css = read('src/ui/styles/theme.css')
    assert 'nova-popup nova-connection-popup' in popup
    assert 'nova-connection-header' in popup
    assert 'nova-connection-panel' in popup
    assert 'nova-header-tools' in popup
    assert 'nova-theme-toggle' in popup
    assert 'color-scheme: dark;' in css
    assert ':root[data-theme="light"]' in css
    assert 'className="nova-candidate"' in candidate_list
    assert 'nova-pill' in connection


def test_options_have_control_center_navigation_and_clear_aggressive_copy():
    options = read('src/ui/options/Options.tsx')
    capture = read('src/ui/options/CaptureSettings.tsx')
    assert 'nova-settings-shell' in options
    assert 'nova-sidebar-nav' in options
    assert 'Aggressive Capture Mode' in capture
    assert '<all_urls>' in capture or '&lt;all_urls&gt;' in capture


def test_diagnostics_are_structured_not_raw_only():
    panel = read('src/ui/diagnostics/DiagnosticsPanel.tsx')
    assert 'nova-diagnostics-grid' in panel
    assert 'Connectivity' in panel
    assert 'Security policy' in panel
    assert 'Raw diagnostics' in panel
