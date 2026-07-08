from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_clear_local_data_really_clears_diagnostics_and_overlay_state() -> None:
    schema = read('src/contracts/messages.schema.ts')
    router = read('src/background/message-router.ts')
    data_settings = read('src/ui/options/DataSettings.tsx')

    for scope in ['diagnostics', 'overlay-diagnostics', 'overlay-positions']:
        assert scope in schema
        assert scope in router
        assert scope in data_settings

    assert "OVERLAY_DIAGNOSTICS_STORAGE_KEY" in router
    assert "browser.storage.local.remove([OVERLAY_DIAGNOSTICS_STORAGE_KEY, 'adm.diagnostics'])" in router
    assert "key.startsWith('adm.downloadOverlayPosition.v2.')" in router
    assert "Clear overlay diagnostics" in data_settings
    assert "Clear overlay positions" in data_settings


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
    assert "floating overlay runtime hardening" in preflight
    assert "floating overlay settings schema" in preflight
    assert "floating overlay background filtering" in preflight


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
