# NOVA Native Media Core

## Status

Implementation branch: `feature/native-media-core`

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
2. Complete HLS and DASH parser coverage needed by real downloads.
3. Add request metadata support to `nova-download-core` for media headers, referer, cookies, and user-agent.
4. Connect HLS/DASH segment planning to the native transfer core.
5. Add generic native media extraction.
6. Add first-party site extractors, beginning with YouTube.
7. Add an embedded JavaScript execution layer only where a site extractor requires it.
8. Migrate existing desktop API/media jobs onto the native engine.
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
