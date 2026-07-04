from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_spawn_sync_build_script_is_explicitly_reviewed_for_pnpm_v11_ci():
    workspace = (ROOT / 'pnpm-workspace.yaml').read_text()
    assert 'allowBuilds:' in workspace
    assert '  spawn-sync: true' in workspace


def test_pnpm_action_does_not_use_standalone_exe_layout_in_ci():
    action = (ROOT / '.github/actions/setup-extension-ci/action.yml').read_text()
    pnpm_block = action.split('uses: pnpm/action-setup@v6.0.8', 1)[1].split('    - name: Setup Node.js', 1)[0]
    assert 'version: 11.6.0' in pnpm_block
    assert 'standalone:' not in pnpm_block
