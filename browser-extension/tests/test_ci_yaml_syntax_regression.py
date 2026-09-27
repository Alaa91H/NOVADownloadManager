from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_github_release_body_uses_block_scalar_to_avoid_yaml_colon_parse_errors() -> None:
    workflow = (ROOT / '../docs/extension/ci-templates/legacy-extension-ci.yml').read_text(encoding='utf-8')
    assert 'body_path: ${{ steps.notes.outputs.body_path }}' in workflow
    assert 'node tools/prepare-release-notes.mjs' in workflow
    assert 'body: Automated package release' not in workflow


def test_workflow_no_known_plain_scalar_release_body_regression() -> None:
    lines = (ROOT / '../docs/extension/ci-templates/legacy-extension-ci.yml').read_text(encoding='utf-8').splitlines()
    for line in lines:
        stripped = line.strip()
        assert not stripped.startswith('body: Automated package release'), line
