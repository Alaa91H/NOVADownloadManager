import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_package_json_uses_no_latest_ranges() -> None:
    package_json = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    for group in ('dependencies', 'devDependencies', 'optionalDependencies'):
        for name, version in package_json.get(group, {}).items():
            assert version not in {'latest', '*', 'x', 'X'}, f'{group}.{name} uses floating range {version}'
            assert 'latest' not in version, f'{group}.{name} uses latest dist-tag'


def test_dependency_policy_is_part_of_highest_verification() -> None:
    package_json = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    assert package_json['scripts']['deps:policy'] == 'tsx tools/dependency-policy-check.ts'
    assert package_json['scripts']['verify:highest'].startswith('pnpm deps:policy &&')


def test_eslint_js_range_tracks_published_channel() -> None:
    package_json = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    dev = package_json['devDependencies']
    assert dev['@eslint/js'] == '^10.0.1'
    assert dev['eslint'] == '^10.4.0'
    assert '^10.5.0' not in {dev['@eslint/js'], dev['eslint']}


def test_pnpm_v11_overrides_deprecated_uuid_transitive_dependency() -> None:
    workspace = (ROOT / '../pnpm-workspace.yaml').read_text(encoding='utf-8')
    assert 'overrides:' in workspace
    assert '"uuid@^8.3.0": "11.1.1"' in workspace
    assert 'allowedDeprecatedVersions:' not in workspace
