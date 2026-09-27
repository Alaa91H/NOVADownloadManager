# Android Media Capability Policy

## Decision

Desktop NOVA media workflows rely on externally discovered or managed executables, including yt-dlp and FFmpeg. That model is **not Android-ready**. Android does not provide a general desktop-style `PATH`, process installation model, or unrestricted subprocess contract that can be reused from the Tauri daemon.

Accordingly, this Android milestone provides **no media-download or post-processing capability**. The UI, bridge, scheduler, background jobs, and release notes must not imply parity for yt-dlp, FFmpeg, playlist extraction, muxing, format conversion, subtitle processing, or arbitrary executable invocation.

## Why the desktop behavior cannot be copied

| Desktop assumption | Android incompatibility | Required replacement decision |
|---|---|---|
| Resolve yt-dlp/FFmpeg from resource paths or `PATH` | App sandboxing and application packaging differ fundamentally from desktop process discovery. | Define an Android-distributable backend or remove the capability. |
| Spawn unrestricted child processes | Android lifecycle, foreground execution, ABI packaging, and policy constraints differ. | Build a bounded platform adapter with explicit cancellation and resources. |
| Download/scrape third-party media through a desktop tool | Service terms, authentication, DRM, jurisdiction, and store policy may apply. | Perform legal/policy assessment per provider before implementation. |
| Post-process files at arbitrary filesystem paths | User-visible storage is capability-based through SAF/MediaStore. | Integrate only through vetted descriptors and MediaStore/SAF adapters. |
| Treat a media task like a direct HTTP file task | Media planning, metadata, stream selection, muxing, and process cost are different. | Introduce a separate task capability and execution policy. |

## Future design gates

A media capability may be proposed only after all gates below are satisfied.

1. Define supported user-owned/content-authorized use cases and review applicable provider, DRM, and distribution constraints.
2. Choose a lawful, maintainable backend that can be packaged for every supported ABI without desktop executable discovery.
3. Make media support a typed core capability. Direct-download task controls must remain usable when media is unavailable.
4. Define CPU, battery, storage, cancellation, and notification policy separately from direct transfer.
5. Route final output through the Android storage capability model; do not hand a raw user path to Rust.
6. Test device thermals, process loss, insufficient storage, malformed input, cancellation during muxing, and upgrade/rollback behavior.
7. Conduct a policy and security review before any public release.

## Capability reporting

Until those gates are complete, the typed bridge should return an explicit `MediaUnsupportedOnThisPlatform` capability/error rather than silently falling back to a desktop implementation or a Kotlin substitute. Diagnostics may state that media is unavailable, but they must not expose external-tool paths, unredacted remote URLs, cookies, or headers.

## Current status

| Capability | Android status |
|---|---|
| Direct HTTP(S) download | Architecture and narrow FFI proof only; no transfer yet. |
| yt-dlp extraction | Not supported. |
| FFmpeg mux/transcode | Not supported. |
| Playlist/format selection | Not supported. |
| Subtitle handling | Not supported. |
| Android media notification execution | Not implemented. |

This scope control prevents an early Android release from making misleading parity claims and keeps the first real transfer milestone focused on durable, user-authorized direct downloads.
