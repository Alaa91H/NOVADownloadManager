# Browser Extension Live Acceptance Record — 2026-08-20

## Scope

This record documents a live acceptance pass for the NOVA Browser Extension against a real local NOVA daemon. The pass used a production-built Manifest V3 Chromium extension with its registered stable extension ID and a clean Chromium profile. It did not use the fake daemon for the live handoff assertions.

## Fixed defects

| Area | Verified defect | Correction |
|---|---|---|
| User capture policy | A `CAPTURE_DOWNLOAD` runtime message could be handed off when `downloads`, `takeoverEnabled`, and `aggressiveMode` were all disabled, because the trusted background boundary only checked global `enabled`. | The background now applies the complete capture and takeover policy before queuing a manual/content-script candidate. |
| Document-start timing | The content script began with takeover enabled while its asynchronous settings read was still pending, allowing an early click to be intercepted before user settings arrived. | The content script now begins in browser-preserving mode and enables takeover only after settings authorize it. |
| Settings initialization | A first-run storage migration could race incoming extension messages. | Runtime mutations and capture work wait for background migration/bootstrap completion while MV3 event listeners remain synchronously registered. |
| Rejected capture continuity | A content-script request rejected by policy could leave the original browser interaction cancelled. | The content script receives an explicit `ok: false` response and replays the native anchor interaction through a short one-shot bypass. |

## Live acceptance scenarios

| Scenario | Procedure | Acceptance result |
|---|---|---|
| Trusted loopback handoff | Started the real daemon in integration mode, then verified `ping`, trusted auto-pairing, bearer validation, and candidate handoff. | Passed. |
| Real Chromium download interception | Loaded the production Chromium extension in a clean profile, connected it through the extension popup runtime, started a browser download, and verified outbox delivery plus a matching task in the real daemon. | Passed. |
| Content-script download link capture | Opened a local fixture page in Chromium with an HTML `download` link, clicked it, and verified the matching URL reached the real daemon through the extension outbox. | Passed. |
| Disabled capture policy | Disabled `downloads`, `takeoverEnabled`, and `aggressiveMode` in the real extension runtime, clicked the fixture link, and verified no new outbox item or daemon task was created. | Passed. |
| Offline recovery | Captured a link while the daemon was stopped, verified an outbox pending item, restarted the daemon, retried connection, and verified the item changed to sent with a matching daemon task. | Passed. |

## Reproducible commands

The live scripts require a production-built Chromium extension, a local daemon in integration mode where noted, and a Chromium instance launched with a dedicated DevTools port. They are intentionally kept outside ordinary unit CI because they control local processes and a real browser profile.

```bash
# Build the extension.
pnpm --filter nova-browser-extension wxt:build:chrome

# With Chromium launched using --remote-debugging-port=9223 and the built
# extension loaded, run the real-browser acceptance scripts.
NOVA_CHROME_CDP=http://127.0.0.1:9223 node scripts/verify_live_extension_chromium.mjs
NOVA_CHROME_CDP=http://127.0.0.1:9223 node scripts/verify_live_extension_content_capture.mjs
NOVA_CHROME_CDP=http://127.0.0.1:9223 node scripts/verify_live_extension_capture_disabled.mjs
NOVA_CHROME_CDP=http://127.0.0.1:9223 node scripts/verify_live_extension_offline_recovery.mjs
```

## Regression and quality evidence

The completed local gates for this pass were:

| Gate | Result |
|---|---|
| Extension TypeScript tests | 752 passed |
| Extension Python policy tests | 125 passed |
| Desktop React tests | 461 passed |
| Extension typecheck and ESLint | Passed |
| Root TypeScript, ESLint, and Prettier checks | Passed |
| Chromium and Firefox production builds | Passed |

## Boundaries

The acceptance pass proves the local Chromium-to-daemon path, direct browser download takeover, document download-link capture, disabled-policy handling, and recovery after a local daemon outage. It does not claim universal capture support for every third-party website, DRM-protected media, or browser implementation; those require separate site-specific and cross-browser compatibility runs.
