from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_native_confirm_alert_are_not_used_in_ui():
    for path in (ROOT / 'src/ui').rglob('*.tsx'):
        text = path.read_text(encoding='utf-8')
        assert 'confirm(' not in text, f'native confirm found in {path}'
        assert 'alert(' not in text, f'native alert found in {path}'


def test_shared_confirm_dialog_is_used_for_destructive_actions():
    dialog = read('src/ui/components/ConfirmDialog.tsx')
    data = read('src/ui/options/DataSettings.tsx')
    site_rules = read('src/ui/options/SiteRulesSettings.tsx')
    tasks = read('src/ui/popup/TaskList.tsx')
    assert 'role="dialog"' in dialog
    assert 'aria-modal="true"' in dialog
    assert 'Reset all local extension data?' in data
    assert 'Delete site rule?' in site_rules
    assert 'Cancel ADM task?' in tasks


def test_candidate_and_task_details_are_expandable():
    candidate_list = read('src/ui/popup/CandidateList.tsx')
    task_list = read('src/ui/popup/TaskList.tsx')
    assert 'Details and evidence' in candidate_list
    assert 'Task details' in task_list
    assert 'DetailGrid' in candidate_list
    assert 'DetailGrid' in task_list


def test_popup_has_connection_panel_instead_of_selection_dashboard():
    popup = read('src/ui/popup/PopupApp.tsx')
    assert 'adm-connection-panel' in popup
    assert 'adm-connection-state' in popup
    assert 'adm-connection-actions' in popup
    assert 'Select visible handoffable' not in popup
    assert 'pending jobs' not in popup


def test_refined_css_contains_dialog_progress_and_detail_styles():
    css = read('src/ui/styles/theme.css')
    for marker in [
        '.adm-modal-backdrop',
        '.adm-dialog',
        '.adm-detail-grid',
        '.adm-progress',
        '.adm-import-preview',
        '.adm-inline-warning',
    ]:
        assert marker in css
