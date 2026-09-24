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
- packet reads constrained to validated `mdat` payload ranges;
- hard limits for box counts, `moov`/`moof` sizes, packet sizes, and sample
  counts to bound malformed-input resource consumption.

## Capability boundary

`mp4_demux` and `fragmented_mp4_demux` are enabled.

`mp4_mux` and `native_remux` are enabled. The native muxer writes `ftyp`, an
extended-size `mdat`, and a generated `moov` with `stsd`, `stts`, optional
`ctts`, `stsc`, `stsz`, `co64`, and `stss` tables. It supports packet-preserving
video/audio MP4 output for H.264, HEVC, AV1, VP8/VP9, AAC, Opus, and MP3 when
the required codec configuration is available.

The media core also exposes a YouTube finalization path that downloads separate
MP4/M4A tracks and muxes them inside NOVA without FFmpeg. WebM separate-track
finalization remains intentionally rejected until the native WebM/Matroska
demuxer is implemented.

Audio transcoding, video transcoding, subtitles/data muxing, edit-list timeline
handling, and hardware acceleration remain disabled until their implementations
are present and covered by native tests.
