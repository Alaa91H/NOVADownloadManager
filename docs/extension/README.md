<p align="center">
  <img src="public/icons/logo.png" alt="NOVA logo" width="128" />
</p>

# NOVA Browser Extension

> Browser companion for **NOVA Browser Extension** â€” detects downloads, media streams, HLS/DASH manifests, torrents, and magnets across all sites, then hands them to the desktop NOVA Browser Extension application via Native Messaging.

## Features

- **Aggressive Capture Mode** â€” user-approved all-sites access for broader discovery beyond the default conservative profile; requests `<all_urls>` permission and enables expanded DOM scanning, network observation, and download interception
- **Multiâ€‘protocol video detection** â€” intercepts `fetch()`, `XHR`, `MediaSource` (MSE), `WebSocket`, `EventSource` (SSE), and `URL.createObjectURL` in the page context to capture streaming manifests and segments
- **Deep DOM scanning** â€” JSONâ€‘LD `VideoObject`, embedded iframe players (YouTube, Vimeo, Dailymotion, Twitch, Kick), `<video>` / `<audio>` / `<source>` / `<track>` elements, Open Graph / Twitter Card meta tags, and linkâ€‘rel manifests
- **Noise filtering** â€” regexâ€‘based blocklist excludes ads, trackers, analytics, CDNs, and tracking pixels from candidate detection
- **Resolution change monitoring** â€” observes `resize`, `ratechange`, `durationchange` events and 16 videoâ€‘related `data-*` attributes for adaptive bitrate switches
- **Smart overlay** â€” draggable floating download button with pulseâ€‘glow animation; autoâ€‘positions near the first `<video>` element; shows candidate picker with quality / resolution / format badges
- **HLS / DASH** â€” playlist parsing, variant resolution extraction, segment URL collection
- **Torrent & magnet** â€” `.torrent` files and `magnet:` URI detection
- **Pairing** â€” automatic zeroâ€‘click pairing via Native Messaging; fallback `Link with NOVA Browser Extension` in popup
- **Privacyâ€‘first** â€” no remote code, no telemetry, no cookie collection; all communication is local (Native Messaging or loopback `127.0.0.1`)
- **Manifest V3** â€” works on Chrome, Edge (116+), and Firefox (128+)

## Quick Start

```bash
corepack enable
pnpm install
python -m pip install pytest ruff
pnpm exec playwright install chromium
pnpm dev
```

## Requirements

| Tool      | Version         |
|-----------|-----------------|
| Node.js   | `>=24 <27`      |
| pnpm      | `>=11 <12` (pinned to `11.6.0`) |
| Python    | 3.11+           |
| Playwright| Chromium (for E2E tests) |

## Development

### Commands

| Command                         | Purpose |
|---------------------------------|---------|
| `pnpm dev`                      | Start dev server (Chrome MV3) |
| `pnpm typecheck`                | TypeScript strict check |
| `pnpm lint`                     | ESLint |
| `pnpm test`                     | Vitest unit + contract + integration |
| `pnpm test:e2e`                 | Playwright E2E smoke tests |
| `pnpm test:py`                  | Python policy / CI / compatibility tests |
| `pnpm ci`                       | Full CI pipeline (typecheck, lint, test, build, E2E, verify) |
| `pnpm fake-nova`                 | Start fake NOVA Browser Extension daemon for integration testing |

### Build

```bash
pnpm build:chrome         # Chrome MV3
pnpm build:edge           # Edge MV3
pnpm build:firefox        # Firefox MV3
pnpm build:store          # Storeâ€‘optimised build (minimal permissions)
pnpm build:zip            # Full build + zip packaging
```

Output artifacts are written to `dist/`.

### Verification

```bash
pnpm verify:release:reuse-build    # 13 release gates (deps, transport, storage, runtime, permissions, architecture, package, hygiene, production)
pnpm verify:highest                 # All gates including store readiness
pnpm verify:store                   # Storeâ€‘specific policy checks
```

## Project Structure

```
src/                  Extension source
  background/         Background service worker (message router, cache, transport)
  capture/            Capture pipeline (page scanner, candidate extraction)
  content/            Content scripts (DOM scanner, page-tap main/bridge)
  contracts/          Message schemas & type definitions
  pipeline/           Candidate classification, enrichment, evidence
  ui/                 Popup, options, overlay, diagnostics panels
  transport/          Native Messaging / WebSocket relay
  tests/              Vitest unit, contract, integration tests
tests/                Python policy, CI, and compatibility tests
tools/                Build, release, policy, and hardening tools
native-messaging/     Native host manifest template
fake-nova-daemon/      Local loopback NOVA Browser Extension daemon for integration testing
contracts/            JSON Schema desktop bridge contracts (generated)
store/                Chrome, Edge, and Firefox store listings
```

## Architecture

The extension follows a multiâ€‘layer architecture:

1. **Content layer** â€” two content scripts:
   - `page-tap-main.ts` (MAIN world, `document_start`) â€” patches `fetch`, `XHR`, `MediaSource`, `WebSocket`, `EventSource`, `URL.createObjectURL`, observes performance resources and DOM mutations
   - `scanner.ts` (isolated world) â€” DOMâ€‘based candidate scanning, JSONâ€‘LD parsing, iframe detection, overlay management
2. **Bridge layer** â€” `page-tap-bridge.ts` validates and forwards postMessage events from the MAIN world to the background via `chrome.runtime.sendMessage`
3. **Background layer** â€” `message-router.ts` receives candidates, enriches metadata, runs platformâ€‘specific confidence adjustment, merges into the candidate cache
4. **Pipeline layer** â€” `CapturePipeline` orchestrates page scans, `MetadataEnricher` resolves resolutions, variant playlists, and format details
5. **Transport layer** â€” `TransportManager` maintains the Native Messaging connection with the desktop daemon; `BridgeManager` handles pairing, capability exchange, and message relay

## Intercepted Protocols

| API                     | Initiator Type        | Detection Method |
|-------------------------|-----------------------|------------------|
| `fetch()`               | `fetch`               | Response URL + Contentâ€‘Type header |
| `XMLHttpRequest`        | `xhr`                 | Response URL + Contentâ€‘Type header |
| `MediaSource`           | `mediasource`         | `addSourceBuffer()` MIME type |
| `WebSocket`             | `websocket`           | Constructor URL parameter |
| `EventSource` (SSE)     | `eventsource`         | Constructor URL parameter |
| `URL.createObjectURL`   | `blob-url`            | Blob / MediaSource MIME type |
| `PerformanceObserver`   | `performance-resource`| Resource Timing API entries |
| DOM elements            | `media-src` / `source-src` | `<video>` / `<audio>` / `<source>` src attributes |
| Player configs          | `player-config`       | Global JS objects (e.g. `ytInitialPlayerResponse`) |

## Privacy & Security

- All NOVA Browser Extension communication is local â€” Native Messaging or loopback `127.0.0.1:3199`
- Bearer tokens stored in extensionâ€‘local storage only
- Tokens, cookies, Authorization headers, and sensitive query parameters are redacted from diagnostics
- No remote code execution, no eval, no telemetry, no browsing history collection
- Content Security Policy restricts scripts to `'self'`
- DRM detection is entirely removed â€” no key system capture, no encryptedâ€‘media event logging
- Permissionâ€‘minimal default profile; broader capture is optâ€‘in via settings
- Store build uses optional permissions (`<all_urls>` is optional, granted at user request)

## License

MIT — see [LICENSE](../../LICENSE)
