from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_build_entrypoint_exists():
    assert (ROOT / 'build.py').exists()
    assert (ROOT / 'scripts/run-python.js').exists()
