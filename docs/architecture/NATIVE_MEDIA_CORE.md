# NOVA Native Media Core

## Status

Implementation branch: `feature/native-media-core`

Current implementation now includes native media request context, bounded GET/POST control traffic, HLS/DASH transfer planning, parallel staging executors, generic native extractors, HLS AES-128 decryption, incremental HLS/DASH live refresh cursors, DASH SegmentTimeline planning, atomic ordered assembly, and the first first-party YouTube extraction/transfer path.

The media subsystem is being moved into the NOVA Rust core. The target runtime has no required yt-dlp executable, Python runtime, Node.js runtime, or Deno runtime.

## Ownership model

NOVA owns:

- media source classification;
- native extractor registration and selection;
- HLS and DASH manifest parsing;
- stream/representation selection;
- transfer scheduling through the shared native download core;
- retries, pause/resume, persistence, recovery, and integrity checks;
- media metadata normalization;
- post-processing orchestration.

The media layer produces typed stream descriptors. It does not own a second HTTP downloader.

## Crates

### `nova-media-core`

Platform-neutral media domain and extractor orchestration.

Primary contracts:

- `MediaDescriptor`
- `MediaStream`
- `MediaMetadata`
- `SubtitleTrack`
- `MediaExtractor`
- `ExtractorRegistry`

### `nova-stream-core`

Native streaming protocol parser layer.

Current scope:

- HLS master and media playlists;
- HLS variants and alternate renditions;
- HLS media sequence and target duration;
- HLS byte ranges and implicit offsets;
- HLS initialization maps;
- HLS encryption metadata;
- DASH MPD detection;
- DASH Period / AdaptationSet / Representation models;
- DASH SegmentTemplate metadata;
- static and dynamic MPD classification.

## Runtime rule

No media extractor may spawn yt-dlp or Python.

The intended path is:

```text
URL
 -> native extractor
 -> MediaDescriptor
 -> native stream planner
 -> nova-download-core/libcurl
 -> verification
 -> optional native/post-process stage
```

## Migration stages

1. Establish typed media and stream cores.
2. Complete HLS and DASH parser coverage needed by real downloads. **Implemented for HLS VOD/live basics, AES-128, DASH fixed templates and SegmentTimeline snapshots.**
3. Add request metadata support to `nova-download-core` for media headers, referer, cookies, and user-agent. **Implemented.**
4. Connect HLS/DASH segment planning to the native transfer core. **Implemented for HLS VOD/live ticks and static/dynamic timeline DASH snapshots.**
5. Add generic native media extraction. **Implemented for manifest URLs and common direct audio/video files.**
6. Add first-party site extractors, beginning with YouTube. **Implemented for watch/short/live URL parsing, watch-page bootstrap, Innertube fallback, metadata/formats/captions, native selection and direct transfer execution.**
7. Add an embedded challenge execution layer only where a site extractor requires it. **Pure-Rust YouTube signature transforms are implemented; the evolving `n` transform remains fail-closed behind a typed solver contract.**
8. Migrate existing desktop API/media jobs onto the native engine. **Started with `/api/media/native/resolve` GET/POST while legacy endpoints remain available during parity validation.**
9. Remove runtime yt-dlp discovery, installation, updater, subprocess and compatibility code.
10. Remove the legacy yt-dlp binary from release resources after feature-parity acceptance tests pass.

## Removal gate for legacy yt-dlp path

The old runtime path must not be removed until the native path passes:

- direct media;
- HLS VOD;
- HLS live;
- DASH VOD;
- separate audio/video tracks;
- subtitles;
- byte-range manifests;
- interrupted-transfer recovery;
- protected requests using explicit user-authorized headers/cookies;
- Windows/Linux/macOS build and integration tests.

This staged removal keeps the product functional while ensuring the final architecture has zero runtime dependency on yt-dlp.


## Current native streaming boundaries

Implemented in-process:

- HLS AES-128/CBC with PKCS#7 unpadding;
- default IV derivation from media sequence and explicit IV parsing;
- live HLS cursors that emit only unseen media sequences;
- DASH SegmentTimeline parsing including bounded `r=-1` expansion;
- incremental dynamic DASH cursors using Time/Number identity;
- atomic ordered assembly for a single representation.

Still intentionally separate:

- SAMPLE-AES and DRM key formats;
- multi-track audio/video muxing;
- codec transcoding;
- YouTube `n` throttling transform patterns not yet covered by the pure-Rust solver;
- multi-track container muxing after separate video/audio downloads;
- browser-cookie import and cookie-file loading in the native resolver;
- wider first-party site extractor coverage beyond YouTube.


## Native YouTube path

The first-party YouTube implementation is owned by `nova-media-core` and does not invoke yt-dlp.

Current flow:

```text
YouTube URL
 -> video-id validation
 -> native watch-page fetch
 -> ytcfg / ytInitialPlayerResponse
 -> native Innertube POST fallback
 -> MediaDescriptor + subtitles
 -> ready formats + challenged formats
 -> pure-Rust signature solver where supported
 -> format selection
 -> nova-download-core segmented transfer
 -> single stream output or separate video/audio staging
```

Important invariants:

- formats carrying unresolved `signatureCipher` or `n` parameters never enter the ready stream list;
- unknown player-script transforms fail closed rather than guessing;
- direct YouTube media bytes use the same libcurl scheduler as normal NOVA downloads;
- the native resolver exposes pending challenge state to callers;
- `/api/media/native/resolve` accepts existing media request context through GET/POST migration endpoints;
- cookie files and browser-cookie import are not silently delegated to an external executable.

The built-in `YouTubePlayerScriptSolver` currently recognizes the classic reverse/drop/swap signature-transform family directly from player JavaScript. The `n` transform remains behind the same solver interface so the implementation can evolve without changing extraction, selection, or transfer contracts.
