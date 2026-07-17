# Engine Capability Gating

The desktop UI, browser popup, and browser overlay must not expose or send an option unless the active runtime engine reports support for it.

## Desktop UI

`src/capabilities/EngineCapabilityContext.tsx` is the single UI source of truth for engine state. It polls `/api/engines/capabilities` and exposes:

- `supportsDirectOption(key)`
- `supportsMediaOption(key)`
- `supportsDirectProtocol(urlOrProtocol)`
- `supportsStreamCandidate(mediaType, source, url)`
- `sanitizeDirectOptions(options)`
- `sanitizeMediaOptions(options)`

All desktop dialogs that create or mutate tasks must pass options through this context before calling the daemon.

## Browser Extension

The extension keeps protocol and stream gating in its bridge/capability layer. Direct links are sent only when `directProtocols` confirms protocol support from linked libcurl. HLS/DASH manifests are routed to `yt-dlp + FFmpeg`, not to the direct libcurl downloader.

## Rule

A rejected or unknown capability is not a delayed runtime error; it must be disabled in UI and removed from outbound payloads.
