# NOVA Native Media Core

## Status

Implementation branch: `feature/native-media-core`.

The media subsystem is owned by the NOVA Rust core. The target runtime uses NOVA-owned extraction, manifest parsing, transfer planning, live refresh, decryption, selection and staging contracts.

## Ownership model

NOVA owns:

- media source classification;
- native extractor registration and selection;
- HLS and DASH manifest parsing;
- stream and representation selection;
- transport request context;
- transfer scheduling through the shared native download core;
- retries, pause/resume, persistence, recovery and integrity checks;
- metadata and subtitle normalization;
- challenge detection and resolution contracts;
- ordered media assembly and post-processing orchestration.

The media layer produces typed stream descriptors and transfer plans. It does not own a second download stack.

## Crates

### `nova-media-core`

Platform-neutral media domain and extractor orchestration.

Primary contracts include:

- `MediaDescriptor`
- `MediaStream`
- `MediaMetadata`
- `SubtitleTrack`
- `MediaExtractor`
- `ExtractorRegistry`
- native media request context
- HLS/DASH staging executors
- live refresh executors
- media selection planners
- challenge solver contracts

### `nova-stream-core`

Native streaming protocol layer.

Current scope includes:

- HLS master and media playlists;
- HLS variants and alternate renditions;
- media sequence and target duration;
- byte ranges and initialization maps;
- AES-128 encryption metadata and transfer planning;
- live HLS cursors;
- DASH MPD / Period / AdaptationSet / Representation models;
- SegmentTemplate and SegmentTimeline;
- static and dynamic manifest planning;
- dynamic DASH refresh cursors.

## Runtime rule

NOVA extractors may not delegate media ownership to a user-installed external resolver.

The preferred path is:

```text
URL
 -> NOVA Media Engine
 -> MediaDescriptor
 -> native stream planner
 -> nova-download-core / libcurl
 -> native verification
 -> native assembly / post-processing
```

A temporary `Media Bridge` exists only as a migration boundary for capabilities that have not yet reached native parity. It is not the identity of the media engine and is not exposed as a product-facing dependency.

## Native request path

```text
request URL + authorized headers/cookies
 -> ExtractRequest
 -> extractor registry
 -> metadata/formats/subtitles
 -> challenge state
 -> selection plan
 -> native transfer / stream plan
 -> staged media
 -> assembly or mux stage
```

## Implemented

- typed media and stream cores;
- native HTTP request context;
- bounded GET and POST control traffic;
- generic direct-media extraction;
- HLS VOD and live basics;
- DASH static/dynamic planning;
- parallel staging;
- HLS AES-128/CBC with PKCS#7;
- incremental HLS and DASH cursors;
- DASH SegmentTimeline planning;
- atomic ordered assembly;
- first-party site extraction path for major video-page URLs;
- native metadata, formats and subtitles normalization;
- native format selection;
- challenge separation between ready and unresolved formats;
- pure-Rust signature transform family support;
- native direct media transfer execution;
- `/api/media/native/resolve` GET and POST migration API.

## Deliberate boundaries

Still isolated behind typed interfaces:

- evolving throttling/challenge transforms not yet covered by the native parser;
- multi-track container muxing;
- browser-cookie import and cookie-file loading;
- codec transcoding;
- additional site adapters;
- final migration of all legacy media jobs onto the native execution path.

Unknown transforms and unsupported protected-media modes fail closed. They are never silently delegated to an unrelated external executable.

## Removal gate for Media Bridge

The temporary bridge can be deleted after native acceptance tests pass for:

- direct media;
- HLS VOD and live;
- DASH VOD and dynamic manifests;
- separate audio/video tracks;
- subtitles;
- byte-range manifests;
- interrupted-transfer recovery;
- explicit user-authorized request context;
- desktop and Android integration tests;
- challenge and format-selection regression corpus.

The end state is one product-owned media subsystem: **NOVA Media Engine**.
