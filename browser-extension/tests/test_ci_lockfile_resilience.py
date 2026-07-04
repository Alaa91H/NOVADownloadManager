from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_setup_node_cache_disabled_until_lockfile_exists():
    action = (ROOT / '.github/actions/setup-extension-ci/action.yml').read_text()
    assert 'uses: actions/setup-node@v5' in action
    assert 'package-manager-cache: false' in action
    assert 'pnpm install --no-frozen-lockfile' in action


def test_ci_does_not_require_pnpm_lock_for_setup_action():
    action = (ROOT / '.github/actions/setup-extension-ci/action.yml').read_text()
    setup_node_block = action.split('uses: actions/setup-node@v5', 1)[1].split('Cache Rust dependencies when present', 1)[0]
    assert 'cache: pnpm' not in setup_node_block
    assert 'cache-dependency-path' not in setup_node_block


def test_pnpm_setup_pins_requested_version_without_v10_layout_noise():
    action = (ROOT / '.github/actions/setup-extension-ci/action.yml').read_text()
    pnpm_block = action.split('uses: pnpm/action-setup@v6.0.8', 1)[1].split('    - name: Setup Node.js', 1)[0]
    assert 'version: 11.6.0' in pnpm_block
    assert 'standalone: true' not in pnpm_block


def test_workflow_suppresses_non_project_runner_noise_before_checkout():
    workflow = (ROOT / '.github/workflows/ci.yml').read_text()
    assert 'NODE_OPTIONS: --no-deprecation' in workflow
    assert "NPM_CONFIG_AUDIT: 'false'" in workflow
    assert "NPM_CONFIG_FUND: 'false'" in workflow
    assert workflow.count('git config --global init.defaultBranch main') >= workflow.count('actions/checkout@v6.0.3')


def test_pnpm_v11_workspace_settings_are_explicit():
    workspace = (ROOT / 'pnpm-workspace.yaml').read_text()
    assert 'engineStrict: true' in workspace
    assert 'strictPeerDependencies: false' in workspace
    assert 'autoInstallPeers: true' in workspace
    assert 'minimumReleaseAge: 1440' in workspace
    assert 'verifyDepsBeforeRun: warn' in workspace
    assert 'overrides:' in workspace
    assert '"uuid@^8.3.0": "11.1.1"' in workspace
    assert 'allowBuilds:' in workspace
    assert '  esbuild: true' in workspace
    assert '  playwright: true' in workspace
    assert '  spawn-sync: true' in workspace
    assert '  unrs-resolver: true' in workspace
