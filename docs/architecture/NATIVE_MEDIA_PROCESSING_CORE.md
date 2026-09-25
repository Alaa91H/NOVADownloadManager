# NOVA Native Media Processing Core

The `nova-media-processing-core` crate is the in-process media container and
codec-processing layer for NOVA Download Manager. It must not spawn FFmpeg,
FFprobe, yt-dlp, or any other post-processing executable.

## Current execution surface

The core currently provides:

- typed media jobs, packets, tracks, timestamps, codecs, and containers;
- deterministic pipeline planning for probe, mux, remux, transcode, audio
  extraction, and stream assembly;
- native container sniffing;
- a seek-based ISO-BMFF reader that does not load media payloads into memory;
- classic MP4 track/sample parsing through `moov/trak/mdia/minf/stbl`;
- `stsd`, `stts`, `ctts`, `stsc`, `stsz`/`stz2`,
  `stco`/`co64`, and `stss` parsing;
- H.264, HEVC, AV1, VP8/VP9, AAC, Opus, and MP3 sample-entry recognition;
- extraction of common codec private configuration such as `avcC`, `hvcC`,
  `av1C`, `vpcC`, `esds`, and `dOps`;
- fragmented MP4/CMAF sample-run parsing through `mvex/trex`,
  `moof/traf/tfhd/tfdt/trun`;
- native WebM and Matroska demuxing through a shared bounded EBML reader for
  `Info`, `Tracks`, `Cluster`, `SimpleBlock`, and `BlockGroup`
  structures;
- WebM VP8, VP9, AV1, Opus, MP3, and FLAC track recognition plus Matroska
  H.264, HEVC, AAC, VP8/VP9, AV1, Opus, MP3, and FLAC recognition, including
  codec-private data, dimensions, audio parameters, language, default
  duration metadata, and VP-relevant `Colour` fields;
- WebM Xiph, fixed-size, and EBML block lacing with bounded frame indexing;
- WebM `DiscardPadding` parsing, with positive final Opus tail padding mapped
  to the shortened duration of the last MP4 Opus sample;
- packet reads constrained to validated container payload ranges;
- hard limits for box/element counts, metadata sizes, packet sizes, track
  counts, and sample counts to bound malformed-input resource consumption.

## Capability boundary

`mp4_demux`, `fragmented_mp4_demux`, `webm_demux`, and
`matroska_demux` are enabled. EBML container sniffing validates the DocType
instead of treating an arbitrary non-WebM EBML document as Matroska.

`mp4_mux` and `native_remux` are enabled. The native muxer writes `ftyp`,
an extended-size `mdat`, and a generated `moov` with `stsd`, `stts`,
optional `ctts`, `stsc`, `stsz`, `co64`, and `stss` tables. It
supports packet-preserving video/audio MP4 output for H.264, HEVC, AV1,
VP8/VP9, AAC, Opus, and MP3 when the required MP4 codec configuration is
available.

The media core also exposes a YouTube finalization path that downloads separate
tracks and muxes them inside NOVA without FFmpeg. MP4/M4A inputs continue to
work directly. WebM VP8, VP9 profiles 0-3, AV1, Opus, and MP3 tracks can now
enter the same MP4 remux path through content-based demux selection. WebM
OpusHead is converted to big-endian `dOps`; VP8/VP9 metadata is converted to
the version-1 `vpcC` representation expected by the MP4 muxer, including
MatrixCoefficients, Primaries, TransferCharacteristics, Range, and
BitsPerChannel validation from WebM `Colour`; and WebM AV1
`AV1CodecConfigurationRecord` is validated and reused directly as `av1C`. Opus remuxing emits an `edts/elst` edit for decoder pre-skip, uses a 48 kHz
movie timescale for sample-accurate trimming, and writes `roll` sample groups
(`sgpd/sbgp`) with a conservative 80 ms random-access pre-roll. The MP4
`ftyp` also advertises `iso2` compatibility for roll-group support.
WebM/Matroska muxing, audio transcoding, video transcoding,
subtitles/data muxing, general edit-list timeline handling beyond Opus pre-skip,
and hardware acceleration
remain disabled until their implementations are present and covered by native
tests.
