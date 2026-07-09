# Engine Compatibility

NOVA now separates the direct-download core from helper command-line tools.

- Direct HTTP/HTTPS/FTP-style downloads run inside the daemon through the Rust `curl` crate and the linked `libcurl` multi interface.
- `curl.exe`/`curl` is still bundled and detected for diagnostics and for yt-dlp external-downloader compatibility, but direct tasks no longer depend on spawning a curl process.
- `yt-dlp` remains the media extraction engine.
- `ffmpeg` remains the post-processing engine for merge, remux, audio extraction, subtitles, thumbnails, metadata, and chapters.
- Torrent and magnet support remain disabled until a dedicated torrent engine is added. libcurl is not a torrent engine.

## Runtime capability endpoint

```http
GET /api/engines/capabilities
```

The endpoint returns live data for:

- `libcurlMulti`: in-process direct download engine.
- `curl`: compatibility alias that exposes the same libcurl-multi direct engine payload.
- `yt-dlp`: media extraction, playlists, format selection, subtitles, and external downloader delegation.
- `ffmpeg`: media post-processing, formats, codecs, protocols, and filters.

The response includes binary paths, runtime versions, verified commands, supported options, unsupported options, protocol lists, feature lists, and routing decisions.

## libcurl multi direct-download model

The direct engine uses `Easy2` handles inside a `Multi` handle instead of spawning a long-running `curl` process. For large resumable files it creates byte ranges, starts several libcurl transfers concurrently, writes `.partNNN` files, tracks per-segment progress, and then merges the verified parts into the final file.

A direct task supports:

- Multiple connections per single file through explicit byte ranges.
- Resume by reusing partial `.partNNN` files and requesting the remaining range.
- Pause/delete by cancellation token rather than killing an external process.
- Retry loop around the libcurl transfer while preserving partial data.
- Safe merge through a temporary `.nova-merge-tmp` file.
- Fallback to one libcurl transfer when segmentation is disabled or the file is too small.

The daemon rejects unsupported direct options before starting the transfer. The Add Download UI loads `/api/engines/capabilities` first, disables unsupported controls, and omits unsupported keys before the request reaches the daemon. Legacy aria2/curl-CLI-only fields remain blocked unless they are implemented in the libcurl path.

## Direct core contract

The professional direct-download core is split between libcurl transport primitives and NOVA-owned scheduling, file writing, resume, and validation layers:

| Layer | Technology | Decision |
| --- | --- | --- |
| URL analysis | libcurl URL API | Required |
| Download or segment transfer | libcurl easy handle | Required |
| Parallel runtime and event loop | libcurl `multi_socket` with socket and timer callbacks | Required |
| Resume | `CURLOPT_RESUME_FROM_LARGE` and byte ranges | Required |
| Shared caches | libcurl share object | Optional, only across multi handles or workers with locking |
| Connection cache size | `CURLMOPT_MAXCONNECTS` | Controls connection cache size and reuse, not active throttling |
| Total active connection limit | `CURLMOPT_MAX_TOTAL_CONNECTIONS` | Required |
| Per-host active connection limit | `CURLMOPT_MAX_HOST_CONNECTIONS` | Required |
| HTTP/2 and HTTP/3 multiplexing | `CURLMOPT_PIPELINING` with `CURLPIPE_MULTIPLEX` | Preferred when supported by the linked libcurl |
| File writes | NOVA `FileWriter` layer | Required |
| Segment planning and merge | NOVA `SegmentPlanner` and merge layer | Required |
| Integrity validation | size, ETag, Last-Modified, Content-Range, hash when available | Required |

`CURLMOPT_MAXCONNECTS` is intentionally treated as a connection cache limit. It does not cap the number of currently open connections. NOVA uses `CURLMOPT_MAX_TOTAL_CONNECTIONS` for the global active-connection ceiling and `CURLMOPT_MAX_HOST_CONNECTIONS` for the per-host ceiling, then keeps `CURLMOPT_MAXCONNECTS` as a memory and connection-reuse tuning knob.

The current libcurl runtime uses `Multi::socket_function`, `Multi::timer_function`, `Multi::action`, and timeout actions as the default path. `wait_perform` remains a diagnostic fallback only and is not the advertised professional runtime.

## Probe model

Direct URL probing now tries:

1. `HEAD` with redirects.
2. Fallback `GET` with `Range: bytes=0-0`.

The probe reports final URL, file name, content type, size, `Accept-Ranges`, `Content-Range`, ETag, Last-Modified, and whether segmentation is actually supported. If the server does not honor range requests, the daemon rejects segmented transfer and tells the caller to retry with one connection or re-probe the URL.

## Linked libcurl capability model

NOVA inspects the linked libcurl at runtime through `curl::Version::get()` and reports its version, protocols, and features. When a curl CLI binary is available, NOVA also reads `curl --version` and `curl --help all` for diagnostic parity, but the in-process libcurl engine remains the source of truth for direct downloads.

HTTP/2 and HTTP/3 are exposed only when the linked libcurl advertises those features. Compression support is exposed only when libcurl advertises libz, Brotli, or zstd support.

## yt-dlp compatibility model

NOVA verifies yt-dlp with:

```bash
yt-dlp --version
yt-dlp --help
```

The daemon parses available yt-dlp flags and constructs `supportedMediaOptionKeys` dynamically. Media downloads validate options before process spawn. FFmpeg-dependent options such as audio extraction, remuxing, embedded subtitles, embedded thumbnails, embedded metadata, and chapter handling are only accepted when FFmpeg is available or a valid custom `ffmpegLocation` is supplied.

The legacy `aria2` and `aria2c` external downloaders are blocked intentionally.

## FFmpeg compatibility model

NOVA verifies FFmpeg with:

```bash
ffmpeg -version
ffmpeg -formats
ffmpeg -codecs
ffmpeg -protocols
ffmpeg -filters
```

The daemon reports live formats, codecs, input protocols, output protocols, and filters. Post-processing capabilities are inferred from those real lists rather than from static assumptions.

## Operational rule

Every engine option follows this path:

```text
User/API option -> runtime capability validation -> libcurl/yt-dlp/ffmpeg execution -> diagnostics snapshot
```

This prevents the UI and API from claiming support for a feature that the actual runtime engine does not expose.

## Production libcurl pinning policy

The production build no longer treats the bundled `curl` CLI as the direct-download core. The approved production path is:

```text
GitHub Releases latest stable curl/curl tag
-> scripts/build-native-curl.mjs
-> static libcurl install prefix under vendor/native/curl/<platform-arch>
-> pkg-config points Cargo/curl-sys at that prefix
-> Rust daemon links against that exact libcurl
-> runtime diagnostics compare curl::Version::get() with the build manifest
```

Use:

```bash
pnpm run native-curl:build
# Linux/macOS shell:
. ./bin/native-curl.env
# Windows PowerShell:
. .\bin\native-curl.ps1
cargo check --manifest-path src-tauri/Cargo.toml
```

The script writes `bin/native-curl-manifest.json`, `bin/native-curl.env`, and `bin/native-curl.ps1`. CI exports those values before `cargo check` and `tauri build`, so release builds are pinned to the libcurl built from the latest stable upstream source at release time.

The runtime capability endpoint includes `buildIntegrity` with the expected libcurl version/tag/source SHA-256, feature profile, expected protocols, expected features, runtime protocols, runtime features, and match flags. In a pinned production build, direct downloads refuse to start if the linked libcurl version, protocols, or features do not match the build manifest.

`curl-sys` vendored/system fallback remains acceptable only for local development when `NOVA_BUILD_LIBCURL_VERSION` is `unmanaged`. Release CI uses `PKG_CONFIG_PATH` and `PKG_CONFIG_ALL_STATIC=1` to avoid accidentally linking against a random system libcurl.

## Probe and persistence hardening

Direct probing now has both GET and POST forms. The POST form accepts the same referer, user-agent, headers, and cookies used by direct downloads, so protected CDN/signed-cookie links are probed with matching request metadata.

Segmented downloads now reject oversized stale `.partNNN` files, merge only exact-size verified parts, fsync the temporary merged file before atomic rename, fsync the destination directory when supported, validate the final file size, and clean partial segment files on `deleteFiles=true` task deletion or `removeOnError` failures.


## Feature profile

`maximum-stable` is the production profile. It requires HTTP/HTTPS plus FTP/FTPS, SSL, IPv6, Largefile, HTTP/2, and compression support (`libz`, Brotli, zstd) before CI accepts the native curl build. SSH-based protocols can be enabled when libssh2 is available. HTTP/3 is deliberately opt-in through `maximum-experimental` or `NOVA_CURL_ENABLE_HTTP3=1`; NOVA reports it only when the linked libcurl exposes `HTTP3`.

The direct engine never claims “all curl options” blindly. It claims only the subset that the in-process libcurl multi implementation maps to real `curl` crate calls and that the linked libcurl build proves at runtime. Unsupported capabilities stay visible in `unsupportedDirectOptionKeys` for diagnostics.


## Browser extension compatibility closure

The daemon now exposes the protocol endpoints expected by the browser companion: `/v1/ping`, `/v1/pair/auto`, `/v1/auth/check`, `/v1/extension-settings`, `/v1/events`, `/v1/tasks`, `/v1/add`, and `/captures`. The extension consumes `capabilities.items` and the runtime engine matrix before enabling handoff actions. Torrent/magnet capabilities are not advertised because libcurl is not a torrent engine.

### Browser stream handoff

The browser companion stream contract is now wired end-to-end. When `yt-dlp` and FFmpeg are available, the daemon advertises HLS/DASH capabilities and serves `/v1/stream/resolve` plus `/v1/stream/add`. Resolving uses `yt-dlp --dump-json --skip-download` and returns a Zod-compatible quality list without null fields. Adding a stream creates a yt-dlp task rather than downloading the manifest file as a plain text asset. Batch and single candidate handoff also route `hls-manifest`, `dash-manifest`, and `mediaType=manifest` candidates through yt-dlp.

### UI capability gating

The desktop add-download dialog and browser popup both gate controls from runtime capabilities. Direct download controls are disabled until `/api/engines/capabilities` confirms the linked libcurl option key. The browser popup disables candidate checkboxes when the daemon does not advertise the corresponding capability. Torrent/magnet settings are visible only as disabled legacy controls until a dedicated torrent engine is introduced.

## Final product hardening pass

The project now standardizes on pnpm for the root application, CI, and release scripts. Root `package-lock.json` and generated diagnostic files are intentionally excluded from source, and `.npmrc`/`pnpm-workspace.yaml` enforce the same package-manager policy locally and in CI. The `clean` script removes generated build outputs only from known project-relative paths and refuses unsafe absolute targets.

The browser companion now carries the complete selected stream quality object, including `formatId` when present, across the runtime message and bridge contract. This prevents HLS/DASH quality choices from being reduced to a URL-only hint and lets the daemon pass the correct selector to yt-dlp.

Direct candidate handoff is now checked twice: the UI/extension gate candidates from `capabilities.items`, and the bridge additionally checks the URL protocol against `directProtocols` exported from the linked libcurl runtime. HLS/DASH manifest candidates return after their stream capability check and are not also forced through the direct libcurl path.

Single-connection libcurl resume handling now allows safe continuation of existing partial files when the remote size is known, returns completed files as completed, rejects oversized stale files when overwrite is disabled, and avoids destructive deletion unless overwrite or explicit cleanup is allowed.

`pnpm run audit:final` performs a dependency-free source audit for the release tree: package-manager consistency, absence of generated artifacts, expected daemon/extension endpoints, runtime libcurl validation hooks, and browser bridge capability gates. It intentionally warns, rather than fabricates, if `Cargo.lock` has not yet been regenerated in a Rust environment after adding `curl/curl-sys`.


## NOVA-Extension feature sync

The bundled browser extension now tracks the upstream `Alaa91H/NOVA-Extension` feature surface through `browser-extension/tools/nova-extension-feature-parity-check.ts`. The desktop daemon remains the runtime source of truth: HLS/DASH are routed to `yt-dlp + FFmpeg`, direct files are routed to in-process `libcurl multi`, and torrent/magnet detection is shown only as unsupported unless a future torrent engine advertises that capability.

## Final product integration hardening

The Windows NSIS installer, desktop daemon, and browser extension are treated as one product surface. The installer uses branded NSIS images, lifecycle hooks, safe process shutdown, legacy cleanup, Native Messaging registration, a cached maintenance installer, Apps & Features repair metadata, and Start Menu repair/uninstall shortcuts.

The browser extension uses the same visual system as the desktop app and follows the current NOVA-Extension feature surface: aggressive capture, page-context fetch/XHR/MSE/WebSocket/EventSource/blob interception, deep DOM scanning, noise filtering, overlay quality selection, HLS/DASH handoff through yt-dlp/FFmpeg, local-only pairing, and runtime capability gating.

Native Messaging is supported through `com.nova.downloadmanager`. The installed `nova.exe` can run as a stdio native host when launched by Chrome, Edge, or Firefox, and proxies supported methods to the verified loopback daemon. Chromium native messaging requires final extension IDs to be supplied at build time through `NOVA_CHROMIUM_EXTENSION_IDS`; Firefox uses the stable `browser_specific_settings.gecko.id`.
