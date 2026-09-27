import json
from pathlib import Path


def test_default_locale_source_is_packaged_from_public() -> None:
    messages_path = Path('public/_locales/en/messages.json')
    assert messages_path.exists()

    messages = json.loads(messages_path.read_text(encoding='utf-8'))
    assert messages['extensionDescription']['message']
    assert messages['extensionName']['message']
    assert messages['extensionShortName']['message']
    assert messages['extensionActionTitle']['message']
    assert messages['commandSendCurrentPageDescription']['message']


def test_arabic_locale_source_is_available_for_browser_ui() -> None:
    messages_path = Path('public/_locales/ar/messages.json')
    assert messages_path.exists()

    messages = json.loads(messages_path.read_text(encoding='utf-8'))
    assert messages['extensionName']['message'].startswith('إضافة')
    assert messages['extensionDescription']['message']


GLOBAL_UI_LOCALES = ('en', 'ar', 'es', 'fr', 'de', 'pt', 'it', 'ru', 'tr', 'hi', 'id', 'zh', 'ja', 'ko', 'fa')

REQUIRED_MANIFEST_MESSAGE_KEYS = (
    'extensionName',
    'extensionNameEdge',
    'extensionShortName',
    'extensionActionTitle',
    'extensionDescription',
    'commandSendCurrentPageDescription',
)


def test_global_manifest_locales_are_complete_for_every_language() -> None:
    for code in GLOBAL_UI_LOCALES:
        messages_path = Path(f'public/_locales/{code}/messages.json')
        assert messages_path.exists(), f'missing manifest locale: {code}'

        messages = json.loads(messages_path.read_text(encoding='utf-8'))
        for key in REQUIRED_MANIFEST_MESSAGE_KEYS:
            assert messages.get(key, {}).get('message'), f'{code}/messages.json is missing {key}'


def test_global_ui_i18n_uses_browser_interface_language_by_default() -> None:
    i18n = Path('src/i18n/index.ts').read_text(encoding='utf-8')
    popup = Path('src/ui/popup/PopupApp.tsx').read_text(encoding='utf-8')
    content = Path('src/content/scanner.ts').read_text(encoding='utf-8')

    for code in GLOBAL_UI_LOCALES:
        assert Path(f'src/i18n/locales/{code}.ts').exists(), f'missing runtime locale bundle: {code}'

    assert 'browser.i18n?.getUILanguage?.()' in i18n
    assert 'normalizeUiLanguage' in i18n
    # The resolver is now a generic registry lookup rather than a single hard-coded language.
    assert 'SUPPORTED_LOCALES' in i18n
    assert 'isSupportedLocale(primary)' in i18n
    assert 'useI18n' in popup
    assert "translate('videoOverlay.download', locale)" in content


def test_global_ui_registry_registers_every_world_language() -> None:
    types = Path('src/i18n/types.ts').read_text(encoding='utf-8')
    index = Path('src/i18n/index.ts').read_text(encoding='utf-8')

    for code in GLOBAL_UI_LOCALES:
        assert f"'{code}'" in types, f'LocaleCode union is missing {code}'
        assert f"import {{ {code} }} from './locales/{code}';" in index, f'index does not import {code}'


def test_manifest_validation_guards_default_locale_messages() -> None:
    validator = Path('tools/validate-manifests.ts').read_text(encoding='utf-8')
    assert 'manifest.default_locale' in validator
    assert "'_locales'" in validator
    assert "'messages.json'" in validator
    assert 'extensionDescription' in validator
    assert 'requiredLocaleMessages' in validator
