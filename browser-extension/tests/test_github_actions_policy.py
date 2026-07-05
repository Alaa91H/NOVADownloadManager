from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_release_uses_softprops_v3_with_explicit_asset_guards() -> None:
    workflow = read('.github/workflows/ci.yml')
    telegram = read('scripts/telegram-release-notify.py')

    assert 'release:' in workflow
    assert 'uses: softprops/action-gh-release@v3.0.0' in workflow
    assert 'fail_on_unmatched_files: true' in workflow
    assert 'overwrite_files: true' in workflow
    assert 'files: release-assets/*' in workflow
    assert 'telegram-release:' in workflow
    assert 'needs: [release, package-build]' in workflow
    assert "needs.release.result == 'success'" in workflow
    assert "github.event_name == 'push'" in workflow
    assert "github.ref_type == 'tag'" in workflow
    assert "startsWith(github.ref_name, 'v')" in workflow
    assert 'python3 scripts/telegram-release-notify.py' in workflow
    assert 'telegram-build-success:' not in workflow
    assert 'node tools/prepare-release-notes.mjs' in workflow
    assert 'body_path: ${{ steps.notes.outputs.body_path }}' in workflow
    assert 'Build Chrome Edge Firefox packages once and run release gates' in workflow
    assert 'Run Playwright smoke tests against the existing Chromium build' in workflow
    assert 'https://api.telegram.org/bot{token}/sendMessage' in telegram
    assert 'TELEGRAM_BOT_TOKEN' in telegram
    assert 'RELEASE_NOTIFICATION_FILE' in telegram
    assert 'Downloads:' in telegram
    assert 'Change log:' in telegram
    assert 'gh release create' not in workflow
    assert 'gh release upload' not in workflow


def test_action_policy_guard_enforces_pinned_official_versions() -> None:
    guard = read('tools/github-actions-policy-check.ts')
    assert 'actions/checkout@v6.0.3' in guard
    assert 'actions/upload-artifact@v7.0.1' in guard
    assert 'actions/download-artifact@v8.0.1' in guard
    assert 'softprops/action-gh-release@v3.0.0' in guard
    assert 'Swatinem/rust-cache@v2.9.1' in guard
    assert 'pnpm/action-setup@v6.0.8' in guard
