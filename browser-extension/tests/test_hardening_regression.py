from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_runtime_request_surfaces_router_errors() -> None:
    popup = read('src/ui/popup/PopupApp.tsx')
    router = read('src/background/message-router.ts')
    assert 'normalizeRouterError' in router
    assert "ok: false" in router
    assert 'runtimeRequest' in popup
    assert "function runtimeRequest" not in popup
    assert "isRuntimeErrorResponse" in read('src/ui/runtime-request.ts')


def test_page_snapshot_is_structured_and_self_contained() -> None:
    scanner = read('src/background/tab-scanner.ts')
    assert 'links: collectLinks()' in scanner
    assert 'openGraph: collectOpenGraph()' in scanner
    assert 'jsonLd: collectJsonLd()' in scanner
    assert 'document.documentElement.outerHTML.slice(0, HTML_SNAPSHOT_LIMIT)' in scanner
    function_body = scanner.split('function capturePageSnapshot()', 1)[1]
    assert 'function collectLinks()' in function_body
    assert 'const HTML_SNAPSHOT_LIMIT' in function_body


def test_package_build_outputs_chrome_edge_and_firefox() -> None:
    build = read('build.py')
    package = json.loads(read('package.json'))
    copy_artifacts = read('tools/copy-artifacts.ts')

    assert package['scripts']['package:all'] == 'pnpm package:chrome && pnpm package:edge && pnpm package:firefox && pnpm prune:package-outputs'
    assert package['scripts']['prune:package-outputs'] == 'tsx tools/prune-package-outputs.ts'
    assert 'tools/create-source-archive.py' not in build
    assert 'release:metadata' in build
    assert "Expected exactly 3 browser package archives" in copy_artifacts
    assert "lower.includes('-edge-')" in copy_artifacts
    assert "lower.includes('source')" in copy_artifacts
    prune = read('tools/prune-package-outputs.ts')
    assert 'isForbiddenPackageOutput' in prune
    assert "lower.includes('edge')" not in prune


def test_toolchain_uses_supported_lts_generations() -> None:
    package = json.loads(read('package.json'))
    assert package['packageManager'].startswith('pnpm@11.')
    assert package['engines']['node'] == '>=24 <27'
    assert read('.nvmrc').strip() == '24'
