# Download Resume, YouTube Reliability, and Browser UX Research — September 2026

## Official and project findings

### yt-dlp

The official yt-dlp project documents three binary release channels: stable, nightly, and master. It explicitly notes that stable can become stale when third-party sites change and recommends trying nightly when users experience extractor breakage. It also documents format selection, optional FFmpeg dependencies, standalone binaries for Windows/macOS/Linux/ARM64, and signed checksum files. NOVA should therefore expose tool readiness and update age as bounded capability states, keep the selected format contract stable, and avoid showing an empty successful catalog when the local extractor is unavailable or stale.

Source: https://github.com/yt-dlp/yt-dlp

### Browser downloads lifecycle

Chrome documents persistent download IDs, `canResume`, `paused`, `state`, byte counters, total size, interruption errors, and `downloads.resume()`. MDN documents that `downloads.onChanged` reports property deltas but does not fire for every `bytesReceived` change. NOVA should correlate events by persistent download ID, refresh the authoritative item before showing completion actions, and distinguish paused, interrupted-but-resumable, interrupted-terminal, and complete states.

Sources: https://developer.chrome.com/docs/extensions/reference/api/downloads and https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/onChanged

### Xtreme Download Manager

XDM presents a mature comparison point: browser takeover, broken-download resume, scheduling, streaming protocols, conversion, proxy/authentication support, and post-download automation. For NOVA, the bounded next step is not to copy every feature, but to make the browser-to-desktop handoff and task lifecycle explicit, durable, and localized before adding more advanced scheduling or conversion controls.

Source: https://github.com/subhra74/xdm

## Proposed bounded implementation scope

| Area | Implementation target | Verification |
|---|---|---|
| Browser download correlation | Centralize event handling by persistent download ID and refresh the item for terminal transitions. | Unit tests for duplicate deltas, stale filenames, paused/resumable, interrupted/resumable, and complete states. |
| Resume UX | Expose one truthful action based on `paused` and `canResume`; do not show Finish/Complete actions until state is confirmed. | State-machine tests and UI contract tests. |
| YouTube reliability | Add bounded tool readiness messaging and prevent stale or empty format catalogs from appearing actionable. | Existing YouTube adapter tests plus analysis outcome tests. |
| Extension lifecycle | Guard message/timer/observer work after context invalidation and avoid uncaught errors. | Context invalidation tests and source audit. |
| Responsive UI | Keep the panel usable on narrow viewports with one primary action per state and accessible live feedback. | Typecheck, lint, visual contract checks, and narrow-layout CSS audit. |
| Localization | Add all new states to the full extension locale registry. | Key-set parity test across 25 locales. |

## Safety boundary

NOVA must not bypass DRM, authentication, cookies, access controls, CAPTCHAs, signed tokens, regional restrictions, or protected-media controls. The implementation should improve allowed downloads, truthful state presentation, and safe handoff only.

## References

- [1] [yt-dlp official repository](https://github.com/yt-dlp/yt-dlp)
- [2] [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [3] [MDN downloads.onChanged](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/onChanged)
- [4] [Xtreme Download Manager](https://github.com/subhra74/xdm)
