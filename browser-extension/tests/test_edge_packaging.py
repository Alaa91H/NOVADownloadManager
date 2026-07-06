from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_edge_package_is_first_class_release_output() -> None:
    package = json.loads(read('package.json'))
    assert package['scripts']['package:edge'] == 'node scripts/run-python.js tools/create-edge-package.py'
    assert package['scripts']['package:all'] == 'pnpm package:chrome && pnpm package:edge && pnpm package:firefox && pnpm prune:package-outputs'
    script = read('tools/create-edge-package.py')
    copy_artifacts = read('tools/copy-artifacts.ts')
    validate = read('tools/validate-manifests.ts')
    assert "manifest['name'] = 'APEX Download Manager Extension for Edge'" in script
    assert "replace('-chrome-', '-edge-')" in script
    assert "if (lower.includes('-edge-')) return 'edge'" in copy_artifacts
    assert "Expected exactly 3 browser package archives" in copy_artifacts
    assert "await validateTarget('edge', 'dist/edge/manifest.json')" in validate
