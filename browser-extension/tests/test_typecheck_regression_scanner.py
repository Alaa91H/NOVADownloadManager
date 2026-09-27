from pathlib import Path


def test_scanner_strict_index_access_regressions_are_guarded() -> None:
    scanner = Path("src/content/scanner.ts").read_text(encoding="utf-8")
    assert "const fallbackPath = value.split(/[?#]/, 1)[0] ?? value;" in scanner
    assert "const match = fallbackPath.match" in scanner
    assert "const first = focusable[0]!;" in scanner
    assert "const last = focusable[focusable.length - 1]!;" in scanner
