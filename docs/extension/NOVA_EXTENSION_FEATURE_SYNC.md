# NOVA-Extension Feature Sync

This browser extension is kept feature-compatible with `Alaa91H/NOVA-Extension` at the product-contract level.
The upstream feature surface used for this sync includes aggressive capture mode, multi-protocol page-context video detection, deep DOM scanning, noise filtering, resolution-change monitoring, smart overlay, HLS/DASH parsing, torrent/magnet detection, zero-click pairing, privacy-first local transport, and Manifest V3 builds.

## Integrated feature map

| Upstream capability | Project implementation |
| --- | --- |
| Aggressive Capture Mode | `src/profiles/aggressive-capture-profile.ts`, permission enforcer, popup capture options, optional all-sites policy. |
| fetch/XHR/MSE/WebSocket/EventSource/blob/performance capture | `src/content/page-tap-main.ts`, `page-tap-bridge.ts`, `background/message-router.ts`. |
| Deep DOM scanning | `src/content/scan-page.ts`, `src/background/tab-scanner.ts`, platform adapters. |
| Noise filtering | `src/content/overlay-types.ts`, `src/pipeline/scorer.ts`, security filters. |
| Resolution change monitoring | `src/content/overlay-install.ts`, `src/content/overlay-ui.ts`. |
| Smart overlay | `src/content/overlay-ui.ts` plus `overlay-ui-video.css.ts` and `overlay-ui-picker.css.ts`. |
| HLS/DASH parsing and quality selection | `src/capture/hls-capture.ts`, `dash-capture.ts`, `/v1/stream/resolve`, `/v1/stream/add`. |
| Torrent/magnet detection | `src/capture/torrent-magnet-capture.ts`; handoff is capability-gated because the desktop libcurl engine intentionally does not claim torrent support. |
| Zero-click pairing | `src/bridge/pairing-manager.ts`, `/v1/pair/auto`, auth manager, health monitor. |
| Local-only privacy model | CSP, loopback URL policy, native messaging boundary, redaction, no remote-code release audit. |
| Chrome/Edge/Firefox MV3 | `wxt.config.ts`, build scripts, store/readiness checks. |
| Desktop design parity | `src/ui/styles/theme.css` mirrors desktop tokens and uses the project logo for popup/options/diagnostics. |

## Contract rule

The extension may detect more candidate types than the desktop engine can download, but it must never advertise or submit unsupported work as ready. Runtime capabilities from NOVA Desktop are the source of truth for handoff.

## 2026-07-06 integration update

The sync now includes production Native Messaging integration rather than a manifest-only placeholder:

- Host identity: `com.nova.downloadmanager`.
- Installed executable: `nova.exe` detects browser native-host launches and runs a stdio proxy.
- Supported native methods: `engine.status`, `task.list`, `task.pause`, `task.resume`, `task.cancel`.
- Native host manifest generation is handled by the desktop build script and patched by NSIS at install time.
- Loopback HTTP/SSE remains the primary full protocol path; Native Messaging is used for wake/status/task commands and as an availability signal.
- Chromium native host allow-listing is build-time controlled through `NOVA_CHROMIUM_EXTENSION_IDS`; Firefox uses the stable gecko extension ID.
