from pathlib import Path


def test_audit_notification_terms_do_not_escape_quotes_inside_single_quoted_js_strings():
    for rel in [
        'tools/offline-production-audit.mjs',
        'tools/release-submission-audit.mjs',
    ]:
        source = Path(rel).read_text(encoding='utf-8')
        assert 'DEFAULT_PARSE_MODE = "HTML"' in source
        assert 'DEFAULT_PARSE_MODE = \\"HTML\\"' not in source
