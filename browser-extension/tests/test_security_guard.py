from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_production_guard_scans_runtime_not_tooling_literals() -> None:
    guard = (ROOT / 'tools/production-guard.ts').read_text(encoding='utf-8')
    assert "name.startsWith('tools/')" in guard
    assert "extension runtime source" in guard
