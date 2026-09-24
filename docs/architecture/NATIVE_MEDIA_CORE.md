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

This rule is enforced at runtime and in CI: once the first-party native media extractor accepts the request shape, validation or execution failures fail closed and cannot fall through to the compatibility bridge.

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
- native throttling-parameter transform discovery and execution for verified player transform families;
- bounded player-transform plan cache with fail-closed invalidation;
- native direct media transfer execution;
- end-to-end HLS VOD task execution with master-variant selection, segment progress, verification and atomic assembly;
- end-to-end live HLS recording with sequence cursors, pause/resume checkpoints and committed-part recovery;
- end-to-end static DASH single-representation task execution with native staging and atomic assembly;
- dynamic DASH recording with incremental timeline cursors, pause/resume checkpoints and committed-part recovery;
- native manifest tasks integrated with the shared task lifecycle, cancellation generation, queue accounting and persisted snapshots;
- native separate audio/video task execution with parallel track staging, per-track progress and durable completed-track checkpoints;
- 1080p/1440p/2160p quality selection can choose separate native video/audio tracks when post-processing is explicitly enabled;
- lossless copy-mux is isolated behind the `NOVA Post-Processing` host interface; the temporary FFmpeg adapter receives local files only and never participates in URL resolution, extraction or authentication;
- pause/resume during separate-track transfer preserves native partial artifacts, while completed tracks are reused after restart without unnecessary re-download;
- native audio-only representation selection without transcoding, including source-container preference and bounded format sorting;
- explicit native stream/itag selection for one stream or a video+audio pair;
- native subtitle and automatic-subtitle sidecar download with language filtering;
- native thumbnail, description and redacted info-JSON sidecars; transport headers, cookies and signed stream URLs are excluded from info JSON;
- native YouTube chapter normalization with start/end timestamps included in metadata sidecars;
- native remux policy that permits same-container/direct output and compatible copy-mux containers while failing closed when additional post-processing is required;
- native YouTube playlist probing with continuation pagination, bounded page/entry limits and a first-party `/api/media/probe-playlist` endpoint;
- native playlist batch task creation with bounded frontend scheduling and one first-party media task per selected entry;
- native Netscape cookie-file loading with bounded file size and URL-scoped domain, path, secure and expiry filtering;
- native Firefox `cookies.sqlite` import with profile discovery, read-only SQLite access and URL-scoped domain/path/secure/expiry filtering;
- browser-cookie storage is read only when the request explicitly includes `cookiesFromBrowser`; validation alone never opens a browser profile;
- native auth/request-context precedence is deterministic: explicit media fields override body-level referer and raw header fallbacks;
- transport-owned headers such as Host, Range and Content-Length are rejected before extraction;
- descriptor-wide Cookie/Authorization context is same-origin scoped; cross-origin derived media and sidecar URLs receive only safe browser identity headers unless an extractor explicitly supplies stream-scoped authorization;
- sensitive native request context, including browser-cookie profile selection, is kept in memory and omitted from restart snapshots, forcing reauthorization when needed;
- `/api/media/native/resolve` GET and POST migration API.

## Deliberate boundaries

Still isolated behind typed interfaces:

- newly observed throttling/challenge transform families that fall outside the verified native parser subset;
- a fully in-process Rust container muxer that can replace the temporary host post-processing adapter;
- HLS/DASH manifests that require composing separate audio/video representations into one output;
- subtitle/thumbnail/metadata embedding into the final container;
- chapter splitting and time-based partial-section extraction;
- audio transcoding targets such as MP3/FLAC/WAV when no matching source representation exists;
- advanced live crash recovery beyond the persisted cursor/committed-part checkpoint implemented by the task path;
- Chromium-family browser-cookie import (Chrome/Edge) pending native OS credential decryption; Firefox import is native;
- additional site adapters;
- final migration of all legacy media jobs onto the native execution path.

Unknown transforms and unsupported protected-media modes fail closed. They are never silently delegated to an unrelated external executable.

### Post-processing boundary

The temporary FFmpeg adapter is **not** a media resolver. NOVA resolves and downloads every selected track first. The adapter receives only local staged file paths and a destination path, uses explicit stream mapping with copy-only muxing, accepts no user-supplied command fragments, and can be cancelled by the task lifecycle. If post-processing is disabled or unavailable, a request that explicitly requires separate tracks fails closed rather than silently delegating extraction or lowering the selected quality.

## Removal gate for Media Bridge

The temporary bridge can be deleted after native acceptance tests pass for:

- direct media;
- HLS VOD and live — task path implemented, final cross-platform acceptance still required;
- DASH VOD and dynamic manifests — task path implemented, final cross-platform acceptance still required;
- separate audio/video tracks — native staging/resume/task execution and copy-mux path implemented, final cross-platform acceptance still required;
- subtitles — native manual/automatic sidecars implemented; embed acceptance remains;
- playlists — native probe/pagination and bounded batch task creation implemented; final cross-platform acceptance remains;
- byte-range manifests;
- interrupted-transfer recovery;
- explicit user-authorized request context;
- desktop and Android integration tests;
- challenge and format-selection regression corpus.

The end state is one product-owned media subsystem: **NOVA Media Engine**.
