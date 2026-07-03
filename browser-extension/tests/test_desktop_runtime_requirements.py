from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_desktop_runtime_contract_is_enforced_by_runtime_files() -> None:
    native_manifest = read("native-messaging/com.apex.downloadmanager.json")
    native_transport = read("src/transport/native-transport.ts")
    protocol = read("src/contracts/adm.protocol.v4.ts")
    schema = read("contracts/adm.protocol.v4.schema.json")

    assert "com.apex.downloadmanager" in native_manifest
    assert '"type": "stdio"' in native_manifest
    assert "allowed_origins" in native_manifest
    assert "allowed_extensions" in native_manifest
    assert "host = 'com.apex.downloadmanager'" in native_transport
    assert "ADM_PROTOCOL_VERSION = 4" in protocol
    assert '"protocolVersion"' in schema
    assert '"const": 4' in schema


def test_extension_ui_exposes_one_click_link_with_adm_fallback() -> None:
    popup_status = read("src/ui/popup/ConnectionStatus.tsx")
    popup_app = read("src/ui/popup/PopupApp.tsx")
    options = read("src/ui/options/ConnectionSettings.tsx")
    assert "Link with ADM" in popup_status
    assert "Link with ADM" in options
    assert "RESET_PAIRING" in popup_app
    assert "RESET_PAIRING" in options
    assert "repair()" in popup_app


def test_strict_ci_keeps_python_and_e2e_gates_without_docs_dependency() -> None:
    package_json = read("package.json")
    assert '"guard:e2e": "tsx tools/e2e-readiness-check.ts"' in package_json
    assert "pnpm test:py" in package_json
    assert "pnpm test:e2e" in package_json
    assert "pnpm guard:e2e" in package_json
    assert "pnpm docs:check" not in package_json
