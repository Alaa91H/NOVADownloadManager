from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_release_submission_audit_is_dependency_light_and_store_policy_rich() -> None:
    audit = read('tools/release-submission-audit.mjs')

    assert "import fs from 'node:fs'" in audit
    assert "import path from 'node:path'" in audit
    assert "audit:release" in audit
    assert "signoff:production" in audit
    assert "remote-code and release-policy violations" in audit
    assert "Dockerfile.ci" in audit
    assert ".devcontainer/devcontainer.json" in audit
    assert "Release submission audit passed." in audit


def test_release_submission_audit_is_wired_into_package_ci_and_reproducible_env() -> None:
    package_json = read('package.json')
    workflow = read('.github/workflows/ci.yml')
    dockerfile = read('Dockerfile.ci')
    bootstrap = read('scripts/bootstrap-node24-pnpm.sh')
    devcontainer = read('.devcontainer/devcontainer.json')

    assert '"audit:release": "node tools/release-submission-audit.mjs"' in package_json
    assert '"signoff:production": "node tools/final-production-signoff.mjs"' in package_json
    assert 'Run release submission audit\n        run: node tools/release-submission-audit.mjs' in workflow
    assert 'FROM node:24' in dockerfile
    assert 'corepack prepare pnpm@11.6.0 --activate' in dockerfile
    assert 'corepack prepare "pnpm@${REQUIRED_PNPM_VERSION}" --activate' in bootstrap
    assert 'javascript-node:1-24-bookworm' in devcontainer


def test_release_submission_audit_passes_in_current_repository_snapshot() -> None:
    result = subprocess.run(
        ['node', 'tools/release-submission-audit.mjs'],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'Release submission audit passed.' in result.stdout


def test_final_signoff_script_records_blocked_dependency_gates_without_hiding_them() -> None:
    signoff = read('tools/final-production-signoff.mjs')

    assert 'production preflight' in signoff
    assert 'runPreflight()' in signoff
    assert 'offline production audit' in signoff
    assert 'release submission audit' in signoff
    assert 'python regression tests' in signoff
    assert 'dependency-heavy production gates' in signoff
    assert "status: strict ? 'failed' : 'blocked'" in signoff
    assert 'Executed-check score' in signoff
    assert 'Total-gate score' in signoff
    assert "pnpm typecheck && pnpm lint && pnpm test && pnpm build:store && pnpm test:e2e" in signoff
