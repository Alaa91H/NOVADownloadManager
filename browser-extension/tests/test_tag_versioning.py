import json
import importlib.util
from pathlib import Path


def test_release_version_is_not_hardcoded():
    package = json.loads(Path('package.json').read_text())
    manifest = json.loads(Path('src/manifest.json').read_text())

    assert package['version'] == '0.0.0'
    assert manifest['version'] == '0.0.0'


def test_build_uses_git_tag_version_source():
    build_py = Path('build.py').read_text()
    workflow = Path('../docs/extension/ci-templates/legacy-extension-ci.yml').read_text()
    wxt_config = Path('wxt.config.ts').read_text()

    assert 'GITHUB_REF_NAME' in build_py
    assert 'WXT_VERSION' in build_py
    assert 'WXT_VERSION' in wxt_config
    assert 'v1.2.3-beta.4' in wxt_config
    assert 'GITHUB_REF_NAME' in workflow
    assert 'vX.Y.Z' in workflow
    assert 'vX.Y.Z-beta.N' in workflow


def test_prerelease_tags_are_normalized_for_browser_manifests():
    spec = importlib.util.spec_from_file_location('adm_build', Path('build.py'))
    assert spec is not None
    build = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(build)

    assert build.validate_version('v1.0.0-beta.15') == '1.0.0.15'
    assert build.validate_version('v1.0.0-rc.2+build.7') == '1.0.0.2'
    assert build.validate_version('v1.2.3') == '1.2.3'
    assert build.validate_version('v1.2.3+45') == '1.2.3.45'
    assert build.validate_version('v1.2.3.4') == '1.2.3.4'
