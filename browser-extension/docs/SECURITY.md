# Security

No remote code, no eval, no inline scripts, strict CSP. Tokens never logged. SafeHeaders excludes cookies and authorization. Diagnostics run through redaction.

## Hardening

This build adds a runtime message trust-boundary guard, JSON-LD scan budgets, bounded site-rule imports/storage, a manifest source policy check, and diagnostics for active security budgets. See `docs/HARDENING.md`.

## Local-only runtime boundary

The extension communicates only with the local NOVA bridge through loopback/native messaging. Tokens and diagnostics stay local-only and are redacted from logs and exported reports.
