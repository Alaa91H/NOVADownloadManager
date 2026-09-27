from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_capture_settings_schema_is_persistent_and_safe():
    settings = read('src/contracts/settings.schema.ts')
    assert 'SettingsSchema' in settings
    assert 'aggressiveMode: z.boolean().default(true)' in settings
    assert 'takeoverEnabled: z.boolean().default(true)' in settings
    assert "captureProfile: CaptureProfileSchema.default('aggressive')" in settings
    assert 'defaultSettings: Settings = SettingsSchema.parse({})' in settings


def test_popup_has_candidate_quality_and_analysis_workflows():
    popup = read('src/ui/popup/PopupApp.tsx')
    assert "type ViewMode = 'list' | 'quality'" in popup
    assert 'GET_CANDIDATES' in popup
    assert 'SCAN_PAGE' in popup
    assert 'AnalyzeResultPanel' in popup
    assert 'QualityTable' in popup
    assert 'selected' in popup



