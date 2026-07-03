from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_quality_gates_collect_all_failures_before_final_pipeline_failure() -> None:
    workflow = read('.github/workflows/ci.yml')
    quality_section = workflow.split('  quality-gates:', 1)[1].split('  package-build:', 1)[0]
    assert quality_section.count('continue-on-error: true') >= 4
    assert 'Typecheck' in quality_section
    assert 'ESLint' in quality_section
    assert 'Vitest' in quality_section
    assert 'Python regression tests' in quality_section
    assert 'Summarize quality gates without failing early' in quality_section
    assert 'quality-gates.json' in quality_section
    assert 'failed=${failed ? \'true\' : \'false\'}' in quality_section


def test_package_build_continues_after_quality_gate_failures_and_reports_at_end() -> None:
    workflow = read('.github/workflows/ci.yml')
    package_section = workflow.split('  package-build:', 1)[1].split('  browser-e2e:', 1)[0]
    assert 'needs: [preflight, quality-gates]' in package_section
    assert "if: ${{ always() && needs.preflight.result == 'success' }}" in package_section
    assert package_section.count('continue-on-error: true') >= 3
    assert 'Build Chrome Edge Firefox packages once and run release gates' in package_section
    assert 'pnpm build:store' in package_section
    assert 'pnpm verify:release:reuse-build' in package_section
    assert 'pnpm signoff:production -- --strict' not in package_section
    assert 'Production signoff is covered by preflight/quality/package/E2E gates in CI.' in package_section
    assert 'package-build.json' in package_section
    assert 'has_unpacked=' in package_section
    assert 'has_release_assets=' in package_section


def test_final_pipeline_result_is_the_only_authoritative_failure_gate() -> None:
    workflow = read('.github/workflows/ci.yml')
    pipeline_section = workflow.split('  pipeline-result:', 1)[1].split('  release:', 1)[0]
    assert 'if: always()' in pipeline_section
    assert 'needs: [preflight, quality-gates, package-build, browser-e2e]' in pipeline_section
    assert 'The pipeline is configured to collect all diagnosable failures first' in pipeline_section
    assert "row.outputs.failed === 'true'" in pipeline_section
    assert 'Pipeline failed after collecting all available gates' in pipeline_section
    release_section = workflow.split('  release:', 1)[1].split('  telegram-release:', 1)[0]
    assert "needs.pipeline-result.result == 'success'" in release_section
