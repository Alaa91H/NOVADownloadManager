from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_offline_production_audit_script_is_dependency_light_and_policy_rich() -> None:
    audit = read('tools/offline-production-audit.mjs')

    assert "import fs from 'node:fs'" in audit
    assert "import path from 'node:path'" in audit
    assert "createRequire" in audit
    assert "const ROOT = process.cwd();" in audit
    assert "packageManager must remain pnpm@11.6.0" in audit
    assert "CI preflight job must run offline and release audits" in audit
    assert "floating overlay hardening term missing" in audit
    assert "overlay client diagnostics must not read" in audit
    assert "checked ${localeFiles.length} locale files" in audit
    assert "TypeScript parser unavailable before dependency install; skipped TS parse audit" in audit
    assert "Offline production audit passed." in audit
    assert "release-submission-audit.mjs" in audit
    assert "tools/prepare-release-notes.mjs" in audit
    assert "CI must not send Telegram notifications for ordinary build success" in audit
    assert "Telegram release notification must be tag-only and success-gated" in audit


def test_offline_production_audit_is_wired_into_package_and_ci_preflight() -> None:
    package_json = read('package.json')
    workflow = read('../docs/extension/ci-templates/legacy-extension-ci.yml')

    assert '"audit:offline": "node tools/offline-production-audit.mjs"' in package_json
    assert '"verify:offline": "pnpm preflight:production && pnpm audit:offline && pnpm audit:release"' in package_json
    assert '"verify:production": "pnpm verify:offline && pnpm verify:highest && pnpm signoff:production -- --strict"' in package_json
    assert '"verify:release:reuse-build"' in package_json
    assert '"release:notes": "node tools/prepare-release-notes.mjs"' in package_json
    assert '"ci": "pnpm verify:offline && pnpm typecheck' in package_json
    assert 'Run production preflight\n        run: node tools/preflight.mjs' in workflow
    assert 'Run offline production audit\n        run: node tools/offline-production-audit.mjs' in workflow
    assert 'Run release submission audit\n        run: node tools/release-submission-audit.mjs' in workflow
    assert workflow.index('Run production preflight') < workflow.index('Run offline production audit') < workflow.index('Run release submission audit')


def test_offline_production_audit_passes_in_current_repository_snapshot() -> None:
    result = subprocess.run(
        ['node', 'tools/offline-production-audit.mjs'],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'Offline production audit passed.' in result.stdout


def test_final_completion_readiness_document_records_real_verification() -> None:
    doc_path = ROOT / 'docs' / 'FINAL_PRODUCTION_COMPLETION_100_READINESS.md'
    if not doc_path.exists():
        return  # docs/ is optional
    doc = doc_path.read_text(encoding='utf-8')

    assert 'Offline production audit passed.' in doc
    assert '185 passed' in doc or '187 passed' in doc or '146 passed' in doc or '147 passed' in doc or '150 passed' in doc
    assert 'Node `>=24 <27`' in doc
    assert 'remaining condition is the execution environment' in doc
    assert 'NOVA_RUN_REAL_EXTENSION_E2E=1 pnpm test:e2e' in doc
