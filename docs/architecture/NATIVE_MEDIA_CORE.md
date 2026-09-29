# NOVA Native Media Core

## Status

Implementation is integrated in the native Rust runtime and shared media crates.

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

This rule is enforced at runtime and in CI: once the first-party native media extractor accepts the request shape, validation or execution failures fail closed and cannot fall through to an external resolver.

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

The former `Media Bridge` runtime has been removed. Legacy persisted tasks that still identify that engine are recognized only as migration records and are never executed.

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
- native throttling-parameter transform discovery and execution for verified player transform families, including named/indexed helpers, object-member aliases, helper-array aliases, top-level comma pipelines, rotate/drop/swap variants and splice-based swaps;
- bounded player-transform plan cache with fail-closed invalidation; unknown helper aliases, compound returns and unverified transform semantics are rejected rather than partially executed;
- native direct media transfer execution;
- end-to-end HLS VOD and live recording with selected master variants, alternate audio renditions, per-track sequence cursors, pause/resume checkpoints, committed-part recovery and native audio/video muxing;
- end-to-end static and dynamic DASH execution with selected audio/video representations, same-period pairing, per-track timeline cursors, pause/resume checkpoints and native muxing when the input codecs and containers are supported;
- native manifest tasks integrated with the shared task lifecycle, cancellation generation, queue accounting and persisted snapshots;
- HLS and DASH quality caps are applied to the selected video variant/representation before segment requests begin;
- manifest video tasks choose a stable output container from the declared stream container or protocol default, and validate any required single-track remux against the actual parsed container/codecs before staging media segments;
- manifest audio-only tasks default to M4A before task naming/path creation, and validate required conversion against the selected manifest rendition before staging;
- native separate audio/video task execution with parallel track staging, per-track progress and durable completed-track checkpoints;
- native progressive MP4 multi-track muxing in `nova-media-core`, preserving source codec/sample metadata and interleaving video/audio by decode time without transcoding;
- 1080p/1440p/2160p quality selection can choose compatible MP4 video/audio tracks for the in-process native muxer;
- separate-track mux, local transcode, and supported text-subtitle embedding use the in-process `nova-media-processing-core`; each output combination is preflighted against the codecs and containers registered by that binary;
- pause/resume during separate-track transfer preserves native partial artifacts, while completed tracks are reused after restart without unnecessary re-download;
- native audio-only representation selection without transcoding, including source-container preference and bounded format sorting;
- media-task finalization uses a bundled in-process Rust codec engine for compatible audio/video re-encoding and container conversion; its encoder/container pairs are returned by `/api/engines/capabilities`;
- conversion controls include stream copy, locally registered software encoders, bitrate/quality, resolution, frame rate, presets, sample rate and mono/stereo output; output templates are sanitized before they become task names;
- explicit native stream/itag selection for one stream or a video+audio pair;
- native subtitle and automatic-subtitle sidecar download with language filtering;
- native thumbnail, description and redacted info-JSON sidecars; transport headers, cookies and signed stream URLs are excluded from info JSON;
- native YouTube chapter normalization with start/end timestamps included in metadata sidecars;
- native remux policy that permits same-container/direct output and compatible copy-mux containers while failing closed when additional post-processing is required;
- native YouTube playlist probing with continuation pagination, bounded page/entry limits and a first-party `/api/media/probe-playlist` endpoint;
- native playlist batch task creation with bounded frontend scheduling and one first-party media task per selected entry;
- Desktop media probing is native-only through `/api/media/probe`; automatic Media Bridge fallback has been removed;
- browser-extension media probe, stream resolve, media add and unified analysis routes are backed by NOVA Media Engine only;
- browser-extension capability negotiation derives HLS/DASH/subtitle/audio readiness from native core capabilities rather than FFmpeg availability;
- the native host routes media probes to NOVA Media Engine instead of the compatibility bridge;
- Android links `nova-media-core` through `nova-mobile-ffi`, exposes typed media descriptors and native progressive, finite-HLS and static single-period DASH task paths with local codec conversion;
- Android media descriptor projection excludes transport headers and keeps the engine identity `nova-media-engine`;
- native Netscape cookie-file loading with bounded file size and URL-scoped domain, path, secure and expiry filtering;
- native Firefox `cookies.sqlite` import with profile discovery, read-only SQLite access and URL-scoped domain/path/secure/expiry filtering;
- browser-cookie storage is read only when the request explicitly includes `cookiesFromBrowser`; validation alone never opens a browser profile;
- native auth/request-context precedence is deterministic: explicit media fields override body-level referer and raw header fallbacks;
- transport-owned headers such as Host, Range and Content-Length are rejected before extraction;
- descriptor-wide Cookie/Authorization context is same-origin scoped; cross-origin derived media and sidecar URLs receive only safe browser identity headers unless an extractor explicitly supplies stream-scoped authorization;
- the same origin-scoping policy is enforced for HLS variants/segments/AES keys, DASH units, YouTube player/control requests, thumbnails and subtitle sidecars;
- Chromium-family App-Bound cookie encryption is not bypassed; unsupported Chrome/Edge sources fail closed while Firefox remains the currently supported browser-cookie adapter;
- sensitive native request context, including browser-cookie profile selection, is kept in memory and omitted from restart snapshots, forcing reauthorization when needed;
- native-only public media API: `/api/media/resolve`, `/api/media/probe`, `/api/media/download`, and `/api/media/postprocess/status`;
- runtime readiness is split explicitly into `mediaExtractionReady`, `streamingReady`, and `postProcessingReady`; the retired `mediaReady` compatibility alias has been removed;
- legacy `/api/media/bridge/*` routes have been removed; active clients use the native media endpoints only;
- Media Bridge is no longer registered in the runtime extractor registry, discovered during daemon startup, exposed by `/api/engines/*`, or listed by `/api/external-tools`;
- native media capability checks such as `media.resolve` and `media.media_probe` report `nova-media-engine` directly with no external tool requirement.

## Deliberate boundaries

Still isolated behind typed interfaces:

- newly observed throttling/challenge transform families that fall outside the verified native parser subset;
- DASH presentations containing multiple periods, which require period-aware timeline assembly;
- HLS/DASH track pairs whose source containers or codecs are not supported by the linked native muxer;
- subtitle/thumbnail/metadata embedding into the final container;
- chapter splitting and time-based partial-section extraction;
- Android media paths remain unverified on target devices and ABIs; live recording, playlist task orchestration and torrent media intake remain deferred, while public-storage publication is implemented in source and awaits target acceptance;
- advanced live crash recovery beyond the persisted cursor/committed-part checkpoint implemented by the task path;
- Chromium-family browser-cookie import (Chrome/Edge) pending native OS credential decryption; Firefox import is native;
- additional site adapters;
- legacy persisted `media-bridge` task snapshots remain decode-only migration records: unfinished tasks are marked `engine-retired` with guidance to re-add the original media URL; no bridge runtime is reconstructed.

Unknown transforms and unsupported protected-media modes fail closed. They are never silently delegated to an unrelated external executable.

### Post-processing boundary

Compatible MP4 video/audio pairs are muxed by NOVA's in-process Rust media cores. Other local mux and conversion work runs through `nova-media-processing-core` only when the selected codec/container pair is supported by that binary. Subtitle embedding currently accepts supported SRT/WebVTT sidecars and preserves media packets; it does not promise embedded-subtitle stream copying, styled ASS rendering, chapters, or thumbnail embedding. No media task falls back to an external executable. Android media transfers and local conversion are implemented in source for the documented subset, with cross-target ABI and device acceptance still pending.

## Post-removal native acceptance matrix

Media Bridge runtime/source/routes are deleted. The remaining acceptance coverage tracks native maturity and must not reintroduce an external resolver fallback:

- direct media;
- HLS VOD and live — task path implemented, final cross-platform acceptance still required;
- DASH VOD and dynamic manifests — task path implemented, final cross-platform acceptance still required;
- separate audio/video tracks — native staging/resume/task execution and copy-mux path implemented, final cross-platform acceptance still required;
- subtitles — native manual/automatic sidecars implemented; embed acceptance remains;
- playlists — native probe/pagination and bounded batch task creation implemented; final cross-platform acceptance remains;
- byte-range manifests;
- interrupted-transfer recovery;
- explicit user-authorized request context;
- desktop, browser-extension and Android integration tests — native-only routing implemented; final CI/cross-platform acceptance remains;
- challenge and format-selection regression corpus.

The end state is one product-owned media subsystem: **NOVA Media Engine**.
