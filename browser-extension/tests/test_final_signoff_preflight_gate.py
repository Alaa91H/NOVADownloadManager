from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_final_signoff_runs_production_preflight_and_scores_blocked_gates() -> None:
    signoff = read('tools/final-production-signoff.mjs')

    assert "runRaw('production preflight'" in signoff
    assert "runPreflight();" in signoff
    assert "Use Node >=24 <27" in signoff
    assert "current Node is" in signoff
    assert "pnpm is unavailable" in signoff
    assert "node_modules is absent" in signoff
    assert "Executed-check score" in signoff
    assert "Total-gate score" in signoff
    assert "Strict mode converts them to failures" in signoff


def test_offline_and_release_audits_guard_final_signoff_shape() -> None:
    offline = read('tools/offline-production-audit.mjs')
    release = read('tools/release-submission-audit.mjs')

    for audit in [offline, release]:
        assert "tools/final-production-signoff.mjs" in audit
        assert "runPreflight()" in audit
        assert "Executed-check score" in audit
        assert "Total-gate score" in audit
