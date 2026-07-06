from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_e2e_readiness_accepts_artifact_reuse_instead_of_rebuild() -> None:
    check = read('tools/e2e-readiness-check.ts')
    workflow = read('../docs/extension/ci-templates/legacy-extension-ci.yml')

    assert "Download unpacked browser builds" in check
    assert "actions/download-artifact@v8.0.1" in check
    assert "adm-extension-unpacked" in check
    assert "EXTENSION_UNPACKED_DIR: dist/chromium" in check
    assert "CI browser E2E job must reuse package-build artifacts instead of rebuilding Chromium." in check
    assert "node scripts/run-python.js build.py --clean --target chromium" not in check

    browser_e2e_section = workflow.split('  browser-e2e:', 1)[1].split('  pipeline-result:', 1)[0]
    assert "Download unpacked browser builds" in browser_e2e_section
    assert "actions/download-artifact@v8.0.1" in browser_e2e_section
    assert "EXTENSION_UNPACKED_DIR: dist/chromium" in browser_e2e_section
    assert "node scripts/run-python.js build.py --clean --target chromium" not in browser_e2e_section


def test_package_reuse_gate_keeps_e2e_guard_without_duplicate_browser_build() -> None:
    package_json = read('package.json')
    workflow = read('../docs/extension/ci-templates/legacy-extension-ci.yml')

    assert "pnpm guard:e2e" in package_json
    assert "pnpm verify:release:reuse-build" in workflow
    assert "Run Playwright smoke tests against the existing Chromium build" in workflow
