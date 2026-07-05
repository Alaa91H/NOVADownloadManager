from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_popup_settings_schema_is_persistent_and_safe():
    settings = read('src/contracts/settings.schema.ts')
    assert 'PopupSettingsSchema' in settings
    assert "defaultTab: PopupDefaultTabSchema.default('connection')" in settings
    assert "density: PopupDensitySchema.default('comfortable')" in settings
    assert 'autoRefreshCandidates: z.boolean().default(true)' in settings
    assert 'candidateRefreshMs: z.number().int().min(1000).max(30000).default(2500)' in settings
    assert 'popup: PopupSettingsSchema.default(() => PopupSettingsSchema.parse({}))' in settings


def test_popup_has_customization_and_capture_tabs():
    popup = read('src/ui/popup/PopupApp.tsx')
    assert "type TabKey = 'connection' | 'candidates' | 'tasks' | 'popup-options' | 'capture-options'" in popup
    assert 'Popup customization' in popup
    assert 'Capture customization' in popup
    assert 'candidateRefreshMs' in popup
    assert 'maxVisibleCandidates' in popup
    assert 'Confirm before Send all' in popup



