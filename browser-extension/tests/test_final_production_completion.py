from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_clear_local_data_really_clears_supported_runtime_state() -> None:
    schema = read('src/contracts/messages.schema.ts')
    router = read('src/background/message-router.ts')

    for scope in ['diagnostics', 'outbox-terminal', 'all-local']:
        assert scope in schema
        assert scope in router

    assert "browser.storage.local.remove(['nova.diagnostics'])" in router
    assert 'outbox.clearTerminal()' in router
    assert 'cache.clearAll()' in router
    assert 'outbox.clearAll()' in router


def test_production_preflight_is_wired_before_heavy_ci_jobs() -> None:
    package_json = read('package.json')
    workflow = read('../docs/extension/ci-templates/legacy-extension-ci.yml')
    preflight = read('tools/preflight.mjs')

    assert '"preflight:production": "node tools/preflight.mjs"' in package_json
    assert 'pnpm verify:offline && pnpm typecheck' in package_json
    assert '"verify:production": "pnpm verify:offline && pnpm verify:highest && pnpm signoff:production -- --strict"' in package_json
    assert 'preflight:' in workflow
    assert 'name: Repository preflight' in workflow
    assert 'run: node tools/preflight.mjs' in workflow
    assert 'run: node tools/offline-production-audit.mjs' in workflow
    assert 'run: node tools/release-submission-audit.mjs' in workflow
    assert 'needs: preflight' in workflow
    assert "nodeMajor < 24 || nodeMajor >= 27" in preflight
    assert "packageManager must stay pnpm@11.6.0" in preflight
    assert "store permission policy term missing" in preflight
    assert "'tools/production-guard.ts'" in preflight
    assert "'tools/e2e-readiness-check.ts'" in preflight
    assert "optional_host_permissions: store ? ['<all_urls>']" in preflight


def test_ci_release_notification_is_tag_only_and_has_valid_job_shape() -> None:
    workflow = read('../docs/extension/ci-templates/legacy-extension-ci.yml')
    assert workflow.count('RELEASE_ACTOR: ${{ github.actor }}') >= 2
    assert 'telegram-build-success:' not in workflow
    assert "github.event_name == 'push'" in workflow
    assert "github.ref_type == 'tag'" in workflow
    assert "startsWith(github.ref_name, 'v')" in workflow
    assert 'quality-gates:' in workflow
    assert 'Build Chrome Edge Firefox packages once and run release gates' in workflow
    assert 'Run Playwright smoke tests against the existing Chromium build' in workflow
    assert 'needs: [preflight, quality-gates, package-build, browser-e2e]' in workflow
