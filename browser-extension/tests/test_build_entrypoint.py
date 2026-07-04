from pathlib import Path


def test_build_entrypoint_exists():
    assert Path('build.py').exists()
    assert Path('scripts/run-python.js').exists()
