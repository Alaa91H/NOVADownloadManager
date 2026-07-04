from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_ci_does_not_duplicate_standalone_production_signoff_after_package_build() -> None:
    workflow = read('.github/workflows/ci.yml')
    package_section = workflow.split('  package-build:', 1)[1].split('  browser-e2e:', 1)[0]

    assert 'pnpm signoff:production -- --strict' not in package_section
    assert 'Production signoff is covered by preflight/quality/package/E2E gates in CI.' in package_section
    assert 'production-signoff' not in package_section


def test_playwright_overlay_smoke_uses_valid_fixture_destructuring() -> None:
    overlay_spec = read('src/tests/e2e/overlay.spec.ts')

    assert 'async ({ browserName }, testInfo)' in overlay_spec
    assert 'async (_fixtures, testInfo)' not in overlay_spec
    assert "testInfo.annotations.push({ type: 'browser', description: browserName });" in overlay_spec
