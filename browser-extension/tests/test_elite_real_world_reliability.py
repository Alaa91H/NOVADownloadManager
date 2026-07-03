from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_scan_results_are_budget_enforced_after_every_scan_path() -> None:
    budget = read('src/security/scan-result-budget.ts')
    tab_scanner = read('src/background/tab-scanner.ts')
    content_scanner = read('src/content/scanner.ts')

    assert 'export function enforceContentScanBudget' in budget
    assert 'ContentScanResponseSchema.parse(input)' in budget
    assert 'links: parsed.links.slice(0, MAX_SCAN_LINKS)' in budget
    assert 'media: parsed.media.slice(0, MAX_SCAN_MEDIA)' in budget
    assert 'openGraph: parsed.openGraph.slice(0, MAX_SCAN_OPEN_GRAPH)' in budget
    assert 'jsonLd: trimJsonLd(parsed.jsonLd)' in budget
    assert 'return enforceContentScanBudget(first);' in tab_scanner
    assert 'return enforceContentScanBudget(response);' in tab_scanner
    assert 'MAX_SCAN_MEDIA' in content_scanner
    assert 'MAX_SCAN_OPEN_GRAPH' in content_scanner
    assert 'MAX_SCAN_JSON_LD_TOTAL_CHARS' in content_scanner


def test_outbox_has_storage_retention_and_maintenance() -> None:
    limits = read('src/contracts/limits.ts')
    store = read('src/outbox/outbox-store.ts')
    worker = read('src/outbox/retry-worker.ts')
    router = read('src/background/message-router.ts')

    assert 'MAX_OUTBOX_JOBS = 1_000' in limits
    assert 'OUTBOX_SENT_RETENTION_DAYS = 7' in limits
    assert 'OUTBOX_DEAD_LETTER_RETENTION_DAYS = 30' in limits
    assert 'async maintenance(now = new Date())' in store
    assert "job.status === 'sent'" in store
    assert "job.status === 'dead-letter'" in store
    assert 'bulkDelete(ids)' in store
    assert 'await this.store.maintenance();' in worker
    assert 'outboxRetention' in router


def test_release_sbom_is_generated_and_packaged() -> None:
    package = json.loads(read('package.json'))
    sbom = read('tools/create-sbom.ts')
    workflow = read('.github/workflows/ci.yml')
    validator = read('tools/package-validator.ts')

    assert package['scripts']['release:sbom'] == 'tsx tools/create-sbom.ts'
    assert 'pnpm release:sbom' in package['scripts']['release:metadata']
    assert "schema: 'adm-extension.sbom.v1'" in sbom
    assert "for (const dir of ['dist/packages', 'dist/release-assets'])" in sbom
    assert 'dependencies: [...deps(packageJson, \'runtime\'), ...deps(packageJson, \'development\')]' in sbom
    assert 'files: release-assets/*' in workflow
    assert 'dist/packages/SBOM.json' in validator
    assert 'Expected exactly 3 browser archives under dist/release-assets' in validator
    assert 'Edge package archive is missing' in validator
