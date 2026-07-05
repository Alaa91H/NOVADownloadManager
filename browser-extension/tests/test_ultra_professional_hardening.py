from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def test_direct_handoff_policy_blocks_ephemeral_urls() -> None:
    policy = read('src/security/handoff-policy.ts')
    bridge = read('src/bridge/bridge-manager.ts')
    candidate_list = read('src/ui/popup/CandidateList.tsx')
    assert 'BLOCKED_SCHEMES' in policy
    assert "'blob:'" in policy and "'data:'" in policy and "'javascript:'" in policy
    assert 'assertCandidateHandoffAllowed(candidate)' in bridge
    assert 'handoffPolicyDecision(candidate)' in candidate_list


def test_safe_headers_are_normalized_and_bounded() -> None:
    safe_headers = read('src/security/safe-headers.ts')
    normalizer = read('src/security/header-normalization.ts')
    assert 'normalizeSafeHeaderValue' in safe_headers
    assert 'HEADER_VALUE_LIMIT = 4096' in normalizer
    assert 'replace(/[\\r\\n\\0]+/g' in normalizer


def test_artifact_actions_use_current_official_pins() -> None:
    workflow = read('.github/workflows/ci.yml')
    assert 'actions/upload-artifact@v7.0.1' in workflow
    assert 'actions/download-artifact@v8.0.1' in workflow
    assert 'actions/upload-artifact@v4' not in workflow
    assert 'actions/download-artifact@v4' not in workflow


def test_popup_marks_non_handoffable_candidates() -> None:
    candidate_list = read('src/ui/popup/CandidateList.tsx')
    assert 'Not directly handoffable' in candidate_list
    assert 'disabled={!handoff.allowed}' in candidate_list


def test_e2e_has_stable_artifact_smoke_and_opt_in_real_extension_smoke() -> None:
    e2e = read('src/tests/e2e/popup.spec.ts')
    workflow = read('.github/workflows/ci.yml')
    assert 'startStaticServer' in e2e
    assert 'installExtensionApiMock' in e2e
    assert "RESET_PAIRING" in e2e
    assert 'chromium.launchPersistentContext' in e2e
    assert '--load-extension=' in e2e
    assert 'chrome-extension://' in e2e
    assert 'ADM_RUN_REAL_EXTENSION_E2E' in e2e
    assert 'run: pnpm test:e2e' in workflow
    assert 'xvfb-run' not in workflow


def test_fake_daemon_integration_is_not_placeholder() -> None:
    integration = read('src/tests/integration/fake-daemon.test.ts')
    assert 'placeholder' not in integration.lower()
    assert 'startFakeAdm' in integration
    assert '/v1/pair/auto' in integration
    assert '/v1/add' in integration


def test_source_archive_is_deterministic_and_clean() -> None:
    source_archive = read('tools/create-source-archive.py')
    assert 'FIXED_ZIP_TIME' in source_archive
    assert 'sorted(' in source_archive
    assert "'.pytest_cache'" in source_archive
    assert "'__pycache__'" in source_archive
    assert "'.pyc'" in source_archive
