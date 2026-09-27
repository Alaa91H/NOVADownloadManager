# Download-Manager Benchmark Notes — 2026-08-26

## Sources reviewed

| Reference | Document | Verified capability | Implication for NOVA |
|---|---|---|---|
| aria2 | [Official manual](https://aria2.github.io/manual/en/html/aria2c.html) | Supports multi-protocol and multi-source downloads, multi-connection transfers, checkpoint/session-oriented input, server-performance profiling, and Metalink chunk checksum validation. | NOVA already has segmented HTTP transfers. Prioritize a user-visible integrity-verification workflow and clearer server capability/progress diagnostics instead of duplicating an unrelated engine. |
| JDownloader | [Official LinkGrabber documentation](https://jdownloader.org/knowledge/wiki/glossary/linkgrabber) | Separates link collection from downloading; users can filter, sort, package links, and set download directory/password/metadata before queueing. | Treat link intake as a reviewable pre-download stage: expose grouping, validation, and bulk controls where NOVA has latent data-model support. |

## Initial implementation hypothesis

A focused, release-safe improvement should be selected from existing NOVA capabilities rather than attempting a speculative full subsystem rewrite. Candidate areas to inspect next are: integrity checksum verification, preflight URL/link inspection, advanced queue actions, and clearer retry diagnostics. These directly reinforce known download-manager reliability patterns and can be covered with deterministic tests.

## Scope restraint

This note is a research log, not a product claim. Any capability will be reported as implemented only after source inspection, test coverage, local validation, and CI success.

## Additional sources reviewed

| Reference | Document | Verified capability | Implication for NOVA |
|---|---|---|---|
| Free Download Manager | [Official features](https://www.freedownloadmanager.org/features.htm) | Documents a scheduler that starts/pauses downloads and application/network actions at scheduled times, multiple traffic-usage modes, add-on support, and smart file placement. | NOVA already has scheduler and browser-extension foundations. The differentiator should be making scheduler/traffic intent observable and safe rather than adding opaque automation. |
| Persepolis | [Official GitHub repository](https://github.com/persepolisdm/persepolis) | Documents multi-segment downloading, download scheduling, download queues, browser integration, and video capture. | These are table-stakes capabilities in the open-source segment. NOVA should concentrate on reliable preflight feedback, quality-of-life batch actions, and transparent error recovery rather than expanding protocol scope blindly. |

## Refined shortlist

1. **Integrity verification UX/API** — strongest reliability improvement but may require a larger data-model and native-engine change.
2. **Preflight link inspection** — high customer value when adding one or many links; can expose HTTP status, filename, content length, range support, content type, and redirect destination before queueing.
3. **Queue/scheduler observability** — make scheduled or waiting downloads explain why they are waiting and what event will release them.
4. **Traffic profiles** — attractive but risks duplicated configuration semantics unless the current global/per-download rate-control model is first audited.

The next source inspection should decide which feature already has supporting primitives and can be implemented completely with tests in this release.

## Decision for this release

The selected implementation target is **preflight transparency in the Add Download dialog**. The daemon already performs staged URL analysis (HEAD, range/encoding fallback, redirect resolution), exposes HTTP status, content type, range support, validators, and a server-advertised SHA-256 digest, and validates that digest in the native transfer path. The React dialog currently uses only filename, size, and resumability.

This makes the improvement bounded and evidence-based: preserve the existing engine and security controls, extend the typed probe contract only for already-emitted fields, and present an accessible compact source-inspection summary. The UI must avoid new fallback-English translations; protocol values such as `HTTP 206`, `SHA-256`, MIME types, and hostnames are technical data rather than user-facing prose. Existing localized labels remain responsible for the surrounding workflow.

### Acceptance criteria

- The client type retains the daemon's already-emitted digest, redirect, mirror, and probe fields.
- The dialog renders a concise, data-only inspection summary after a successful probe without exposing credentials or query secrets.
- Redirect destinations are rendered as sanitized origins, not full token-bearing URLs.
- Existing submission behavior remains unchanged; server digest verification remains in the native engine.
- Unit tests cover technical-summary derivation, redirect sanitization, and absence of a summary before probe completion.
