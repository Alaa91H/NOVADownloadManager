from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_native_confirm_alert_are_not_used_in_ui():
    for path in (ROOT / 'src/ui').rglob('*.tsx'):
        text = path.read_text(encoding='utf-8')
        assert 'confirm(' not in text, f'native confirm found in {path}'
        assert 'alert(' not in text, f'native alert found in {path}'


def test_shared_confirm_dialog_is_accessible_for_destructive_actions():
    dialog = read('src/ui/components/ConfirmDialog.tsx')
    assert 'role="dialog"' in dialog
    assert 'aria-modal="true"' in dialog
    assert 'onConfirm' in dialog
    assert 'onCancel' in dialog


def test_candidate_details_are_expandable():
    candidate_list = read('src/ui/popup/CandidateList.tsx')
    assert 'Details and evidence' in candidate_list
    assert 'DetailGrid' in candidate_list
    assert '<details' in candidate_list


def test_popup_has_compact_bridge_status_and_explicit_expansion():
    popup = read('src/ui/popup/PopupApp.tsx')
    assert 'statusTone(bridge?.status)' in popup
    assert 'const [expanded, setExpanded]' in popup
    assert 'GET_BRIDGE_STATE' in popup
    assert 'OPEN_NOVA' in popup


def test_refined_css_contains_dialog_progress_and_detail_styles():
    css = read('src/ui/styles/theme.css')
    for marker in [
        '.nova-modal-backdrop',
        '.nova-dialog',
        '.nova-detail-grid',
        '.nova-candidate-details',
        '.nova-analyze-loading',
        '.nova-inline-warning',
    ]:
        assert marker in css
