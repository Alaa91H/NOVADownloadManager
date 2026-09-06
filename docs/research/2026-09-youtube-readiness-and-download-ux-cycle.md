# YouTube Readiness and Download UX Research — September 2026

## Findings

### Browser download state

The Chrome downloads API documents a persistent download ID, `canResume`, `paused`, `state`, `bytesReceived`, `totalBytes`, `exists`, and interruption errors. The API also supports searching an item by ID and resuming it. The practical implication for NOVA is that a single `onChanged` delta is not enough to decide whether a download is terminal; the background service should refresh the item and use persistent IDs for reconciliation.

Source: https://developer.chrome.com/docs/extensions/reference/api/downloads

### Extension storage

Chrome documents that extension service workers cannot use Web Storage reliably and recommends the extension Storage API for service-worker state. `storage.local` persists across browser restarts and supports larger local state than sync storage, while session storage is ephemeral. NOVA should keep only bounded, redacted download metadata in local storage, use session state only for ephemeral in-flight UI, and never persist cookies, authorization headers, or transient media URLs.

Source: https://developer.chrome.com/docs/extensions/reference/api/storage

### yt-dlp YouTube maintenance

The latest official yt-dlp release notes show ongoing YouTube player-client maintenance, new client fallbacks, live adaptive-fragment fixes, and player-version updates. This confirms that extractor freshness is a first-class operational concern. NOVA should make tool readiness, version age, and missing helper dependencies visible and actionable, while keeping the extension contract independent of raw extractor internals.

Source: https://github.com/yt-dlp/yt-dlp/releases

### QDM comparison

Quantum Download Manager demonstrates a modern product pattern around persistent segment state, auto-retry, probing for resumability, quality presets, browser handoff, queues, and explicit tool management. NOVA's bounded next step is to improve capability transparency and state reconciliation before introducing broader engine features. The relevant design principle is that every visible action should correspond to a confirmed engine capability, rather than a generic button that can become stale.

Source: https://github.com/PBhadoo/QDM

## Bounded implementation target

| Area | Target | Verification |
|---|---|---|
| Tool readiness | Surface a truthful extractor/FFmpeg readiness state in media analysis outcomes. | Unit tests for missing, stale, and ready tools. |
| Download reconciliation | Refresh tracked items after lifecycle deltas and preserve persistent IDs. | State classifier and observer tests. |
| Storage hygiene | Keep persisted state bounded and redacted. | Existing storage-budget and redaction tests. |
| Media UX | One primary action per confirmed state; stale catalogs remain non-actionable. | Floating-panel request guard tests and typecheck/build. |
| Localization | Add all new readiness/status strings to the full locale set. | Locale parity test across 25 locales. |

## Safety boundary

This cycle does not bypass DRM, authentication, cookies, access controls, CAPTCHA, signed tokens, regional restrictions, or protected-media controls. It improves allowed downloads, tool readiness communication, state reconciliation, and localized UI only.

## References

- [1] [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [2] [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [3] [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases)
- [4] [Quantum Download Manager](https://github.com/PBhadoo/QDM)
