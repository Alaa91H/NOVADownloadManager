# Native codec and media backends

The desktop daemon links the vendored `remade-ffmpeg` Rust engine through
`nova-media-processing-core`; the Android FFI dependency graph includes the
same crate. Desktop media tasks call the Rust API directly and do not start an
FFmpeg or other media executable. Conversion writes to a sibling temporary
file and replaces the destination only after the engine reports packets and a
non-empty output. Pause and cancel are checked at the engine's cooperative
control points.

At runtime NOVA builds its codec/container capability list from the same
registries used to execute the job. The current linked set includes H.264 and
VP9 video encoders, plus MJPEG and raw-video encoders only where the runtime
container registry accepts them. Audio encoders include AAC, MP3, Opus,
Vorbis, FLAC, and PCM. Decoder reporting is separate and includes decoder-only
source formats when the registry provides them, including AV1 decoding for
AVIF. The AV1 decoder uses the portable Rust path because the x86 assembly
objects in its optimized path are not position-independent for NOVA's mobile
FFI shared library. Each advertised pair is checked against the engine's codec
and muxer registries. It supports stream copy or re-encoding, bitrate/quality
settings, scaling, frame rate, sample rate, and mono/stereo output. It does not
claim every codec, container, profile, or hardware encoder. Unknown source
codecs and incompatible copy/mux combinations fail closed when metadata is
available.

Separate video/audio downloads retain their native MP4 mux route. Other
containers use the linked codec engine and are preflighted against the source
track codecs before transfer. Local text subtitle embedding is enabled only
for container/codec pairs reported by the running engine; it currently targets
Matroska and WebM when registered. It preserves media packets and never burns
captions into video. Subtitle track language labels and advanced ASS styling
are not promised by the current mux adapter.

The Android JNI bridge now projects the codec registry and invokes the same
local transcode API over source and destination paths constrained to the app's
private files root. The Compose media screen imports through Android's document
picker and exports the completed file through SAF after verifying its byte
count and SHA-256. Progressive HTTP(S), finite HLS VOD, and static one-period
DASH streams are selected in the UI, then re-resolved and downloaded in Rust
with credentials scoped to the stream; the encrypted Android task intent
contains only the source page and format ID. HLS can stage a separate audio
rendition and use the linked muxer when the registered containers and codecs
support the pair. Live HLS, dynamic or multi-period DASH, playlist batches,
subtitle tasks, and torrent remain outside the Android task surface. The
cross-target build and real-device media runs are pending; source integration
does not establish that every Android ABI builds or that long transcodes meet
memory, heat, battery, and lifecycle limits.

The project still contains a compatibility manager for optional legacy tools.
The download, mux, subtitle, and conversion paths in this backend do not use
those tools. Engine status reports the Rust processing backend independently
of whether an external binary is installed.

The vendored crate is pinned to `remade-ffmpeg` 0.2.0 under Apache-2.0. Its
upstream project describes the API as pre-1.0 and not independently audited;
codec coverage and compatibility remain bounded by its release matrix. H.264
and AAC distribution may also have patent considerations. See the upstream
[project and compatibility matrix](https://github.com/Remade-With-Rust/remade_ffmpeg_rs),
[published crate](https://crates.io/crates/remade-ffmpeg/0.2.0), and
[crate API documentation](https://docs.rs/remade-ffmpeg/0.2.0/rff/).

Repository CI and codec-registry discovery do not replace fixture-based
playback, audio/video synchronization, output quality, load, or real-device
acceptance checks. Those remain required before describing the engine as
production-validated across all formats.
