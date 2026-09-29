# Android Native Media Capability

## Runtime boundary

Android media must run through NOVA-owned Rust code and the Android app's
background-task and storage lifecycle. The media feature does not discover or
launch FFmpeg, yt-dlp, or another installed application.

The Android Rust FFI resolves native media metadata, re-resolves a selected
representation in the background worker, and keeps the extractor's
origin-scoped headers inside Rust. Android stores only the original page,
selected stream ID, and safe output extension in its Keystore-encrypted task
intent. Progressive HTTP(S), finite HLS playlists, and static one-period DASH
representations use NOVA's native transport and segment pipeline. HLS master
selection can include a separate downloadable audio rendition, with AES-128
identity decryption and native muxing when the linked container and codec
registry accepts the combination. The Compose media screen also imports local
files into app-private staging, invokes the shared Rust codec engine over
relative paths, and exports the result through the system document picker
after a byte-count and SHA-256 check.

The direct HTTP download path is separate. It runs through the Rust mobile
transfer core, stages in app-private storage, then publishes through the
selected MediaStore or SAF destination.

## Current Android capability matrix

| Capability | Current status |
|---|---|
| Direct HTTP(S) file transfer | Implemented in source with native Rust transfer, lifecycle persistence, and MediaStore/SAF publication; Android runtime acceptance remains pending. |
| Native media resolution | Compose selection UI uses the JNI resolver; native task execution re-resolves the chosen stream ID. ABI/device acceptance remains pending. |
| Progressive media streams | Implemented in source for direct HTTP(S) formats; background transfer reuses task pause/resume/cancel, app-private staging, and destination publication. Runtime acceptance remains pending. |
| Finite HLS transfer | Implemented in source for finite media playlists, highest-quality master variant selection, selected downloadable audio rendition, byte ranges, and AES-128 identity encryption. Staging parts are retained on pause and re-fetched on resume; runtime acceptance remains pending. |
| Static DASH transfer | Implemented in source for one-period manifests and supported direct BaseURL/fixed-duration template plans. Best audio and video representations are selected and muxed only where the native engine accepts them. Dynamic manifests, multi-period editing, and runtime acceptance remain pending. |
| Live HLS/DASH | Shared protocol refresh primitives exist; Android task scheduling, durable live cursor persistence, and final-output policy are not connected. |
| Local audio/video conversion | Compose UI, JNI capabilities, app-private path-constrained transcode, cooperative pause/cancel, and SAF export are implemented in source. Device performance, process-death handling, and ABI validation remain pending. |
| Subtitle download and embedding | No Android task flow. Desktop/shared-core support remains container- and codec-limited. |
| Playlists | Shared native playlist extraction exists for supported providers; Android selection and batch task creation are not implemented. |
| BitTorrent | Not connected to the Android mobile FFI or app lifecycle. |

Do not report a row as verified Android support until its ABI/device acceptance
has passed. Progressive and manifest downloads use the existing durable
transfer task. Manifest downloads currently restart segment staging after a
pause, although completed task parts remain in private staging until resume or
terminal cleanup. Local conversion currently runs in the foreground app
process and restarts from its source after a pause or process death.

## Integration requirements

1. Add durable HLS/DASH segment resume, Android live-manifest scheduling and
   persisted live cursors without storing authorization headers, cookies, or
   other request secrets.
2. Add native playlist selection and batch task creation to Android.
3. Move long local conversions into a foreground-capable Android lifecycle
   task; conversion pause currently restarts from the source after process death.
4. Reuse the app-private staging and verified publication path. The Rust API
   must accept only root-relative paths and must never receive arbitrary SAF
   paths as filesystem paths.
5. Preflight stream/container/codec combinations using the exact native
   registry and reject unsupported combinations before processing.
6. Connect native torrent task controls and metadata selection to the Android
   task lifecycle.
7. Keep native codec capability reporting separate from extraction and task
   capabilities; subtitles remain unexposed.
8. Validate ABI builds, fixtures, process death, cancellation, low storage,
   thermals, and real-device output before enabling conversion controls.

Unsupported formats, DRM-protected streams, missing authentication, and
unsupported manifest encryption must fail explicitly. None may fall back to an
external executable.
