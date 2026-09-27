use std::collections::BTreeSet;

use crate::{
    flac::{native_flac_codec_private_from_dfla, parse_native_flac_codec_private},
    AudioParameters, MediaCodec, MediaContainer, MediaProbe, MediaProcessingError,
    MediaTimeBase, MediaTrack, MediaTrackKind, VideoParameters,
};

use super::boxes::{
    child, demux_error, full_box_body, parse_boxes, read_i32, read_u16, read_u32,
    read_u64, slice, FourCc, Mp4Box,
};

const MAX_SAMPLES_PER_TRACK: usize = 10_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Mp4Sample {
    pub offset: u64,
    pub size: u32,
    pub dts: i64,
    pub pts: i64,
    pub duration: u32,
    pub keyframe: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mp4TrackIndex {
    pub track: MediaTrack,
    pub duration_millis: Option<u64>,
    pub samples: Vec<Mp4Sample>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedMp4 {
    pub probe: MediaProbe,
    pub tracks: Vec<Mp4TrackIndex>,
    pub fragmented: bool,
}

#[derive(Default)]
struct SampleTable {
    sample_sizes: Vec<u32>,
    chunk_offsets: Vec<u64>,
    sample_to_chunk: Vec<SampleToChunk>,
    decode_times: Vec<(u32, u32)>,
    composition_offsets: Vec<(u32, i64)>,
    sync_samples: Option<BTreeSet<u32>>,
}

#[derive(Clone, Copy, Debug)]
struct SampleToChunk {
    first_chunk: u32,
    samples_per_chunk: u32,
}

struct TrackMetadata {
    track_id: u32,
    kind: MediaTrackKind,
    codec: MediaCodec,
    timescale: u32,
    duration: u64,
    language: Option<String>,
    video: Option<VideoParameters>,
    audio: Option<AudioParameters>,
    codec_private: Vec<u8>,
}

pub fn parse_movie(moov_payload: &[u8], fragmented: bool) -> Result<ParsedMp4, MediaProcessingError> {
    let moov_children = parse_boxes(moov_payload)?;
    let movie_duration = child(&moov_children, *b"mvhd")
        .map(|mvhd| parse_mvhd_duration(mvhd.payload))
        .transpose()?
        .flatten();

    let mut tracks = Vec::new();
    for trak in moov_children.iter().filter(|item| item.kind == FourCc::new(*b"trak")) {
        tracks.push(parse_track(trak.payload)?);
    }

    if tracks.is_empty() {
        return Err(demux_error("MP4 moov contains no tracks"));
    }
    let mut track_ids = BTreeSet::new();
    for track in &tracks {
        if track.track.id == 0 || !track_ids.insert(track.track.id) {
            return Err(demux_error("MP4 track ids must be unique and non-zero"));
        }
    }

    let duration_millis = movie_duration.or_else(|| {
        tracks
            .iter()
            .filter_map(|track| {
                track
                    .duration_millis
                    .or_else(|| track_duration_millis(&track.track, track.samples.last()))
            })
            .max()
    });

    Ok(ParsedMp4 {
        probe: MediaProbe {
            container: if fragmented {
                MediaContainer::FragmentedMp4
            } else {
                MediaContainer::Mp4
            },
            duration_millis,
            tracks: tracks.iter().map(|entry| entry.track.clone()).collect(),
        },
        tracks,
        fragmented,
    })
}

fn parse_track(trak_payload: &[u8]) -> Result<Mp4TrackIndex, MediaProcessingError> {
    let trak_children = parse_boxes(trak_payload)?;
    let tkhd = child(&trak_children, *b"tkhd")
        .ok_or_else(|| demux_error("MP4 track is missing tkhd"))?;
    let (track_id, tkhd_width, tkhd_height) = parse_tkhd(tkhd.payload)?;

    let mdia = child(&trak_children, *b"mdia")
        .ok_or_else(|| demux_error("MP4 track is missing mdia"))?;
    let mdia_children = parse_boxes(mdia.payload)?;

    let mdhd = child(&mdia_children, *b"mdhd")
        .ok_or_else(|| demux_error("MP4 track is missing mdhd"))?;
    let (timescale, duration, language) = parse_mdhd(mdhd.payload)?;

    let hdlr = child(&mdia_children, *b"hdlr")
        .ok_or_else(|| demux_error("MP4 track is missing hdlr"))?;
    let kind = parse_handler_kind(hdlr.payload)?;

    let minf = child(&mdia_children, *b"minf")
        .ok_or_else(|| demux_error("MP4 track is missing minf"))?;
    let minf_children = parse_boxes(minf.payload)?;
    let stbl = child(&minf_children, *b"stbl")
        .ok_or_else(|| demux_error("MP4 track is missing stbl"))?;
    let stbl_children = parse_boxes(stbl.payload)?;

    let stsd = child(&stbl_children, *b"stsd")
        .ok_or_else(|| demux_error("MP4 track is missing stsd"))?;
    let (codec, sample_video, sample_audio, codec_private) =
        parse_sample_description(stsd.payload, kind)?;

    let width = sample_video
        .as_ref()
        .map(|video| video.width)
        .or(tkhd_width)
        .unwrap_or(0);
    let height = sample_video
        .as_ref()
        .map(|video| video.height)
        .or(tkhd_height)
        .unwrap_or(0);
    let video = if kind == MediaTrackKind::Video {
        Some(VideoParameters {
            width,
            height,
            frame_rate: None,
            bitrate_bps: None,
        })
    } else {
        None
    };
    let audio = if kind == MediaTrackKind::Audio {
        sample_audio
    } else {
        None
    };

    let metadata = TrackMetadata {
        track_id,
        kind,
        codec,
        timescale,
        duration,
        language,
        video,
        audio,
        codec_private,
    };

    let table = parse_sample_table(&stbl_children)?;
    let track = media_track(&metadata)?;
    let samples = build_sample_index(&table, metadata.timescale)?;
    let duration_millis = if metadata.duration == u32::MAX as u64
        || metadata.duration == u64::MAX
    {
        None
    } else {
        Some(scale_to_millis(metadata.duration, metadata.timescale))
    };

    Ok(Mp4TrackIndex {
        track,
        duration_millis,
        samples,
    })
}

fn media_track(metadata: &TrackMetadata) -> Result<MediaTrack, MediaProcessingError> {
    let time_base = MediaTimeBase::new(1, metadata.timescale)
        .ok_or_else(|| demux_error("MP4 track has zero media timescale"))?;

    Ok(MediaTrack {
        id: metadata.track_id,
        kind: metadata.kind,
        codec: metadata.codec.clone(),
        time_base,
        language: metadata.language.clone(),
        video: metadata.video.clone(),
        audio: metadata.audio.clone(),
        codec_private: metadata.codec_private.clone(),
    })
}

fn parse_mvhd_duration(data: &[u8]) -> Result<Option<u64>, MediaProcessingError> {
    let (version, _, body) = full_box_body(data)?;
    let (timescale, duration) = match version {
        0 => (read_u32(slice(body, 8, 4)?)?, read_u32(slice(body, 12, 4)?)? as u64),
        1 => (read_u32(slice(body, 16, 4)?)?, read_u64(slice(body, 20, 8)?)?),
        other => return Err(demux_error(format!("unsupported mvhd version {other}"))),
    };
    if timescale == 0 || duration == u32::MAX as u64 || duration == u64::MAX {
        return Ok(None);
    }
    Ok(Some(scale_to_millis(duration, timescale)))
}

fn parse_tkhd(data: &[u8]) -> Result<(u32, Option<u32>, Option<u32>), MediaProcessingError> {
    let (version, _, body) = full_box_body(data)?;
    let (track_id_offset, width_offset) = match version {
        0 => (8_usize, 76_usize),
        1 => (16_usize, 84_usize),
        other => return Err(demux_error(format!("unsupported tkhd version {other}"))),
    };
    let track_id = read_u32(slice(body, track_id_offset, 4)?)?;
    let width_fixed = read_u32(slice(body, width_offset, 4)?)?;
    let height_fixed = read_u32(slice(body, width_offset + 4, 4)?)?;
    let width = (width_fixed >> 16 != 0).then_some(width_fixed >> 16);
    let height = (height_fixed >> 16 != 0).then_some(height_fixed >> 16);
    Ok((track_id, width, height))
}

fn parse_mdhd(data: &[u8]) -> Result<(u32, u64, Option<String>), MediaProcessingError> {
    let (version, _, body) = full_box_body(data)?;
    let (timescale, duration, language_offset) = match version {
        0 => (
            read_u32(slice(body, 8, 4)?)?,
            read_u32(slice(body, 12, 4)?)? as u64,
            16_usize,
        ),
        1 => (
            read_u32(slice(body, 16, 4)?)?,
            read_u64(slice(body, 20, 8)?)?,
            28_usize,
        ),
        other => return Err(demux_error(format!("unsupported mdhd version {other}"))),
    };
    if timescale == 0 {
        return Err(demux_error("MP4 mdhd has zero timescale"));
    }
    let packed_language = read_u16(slice(body, language_offset, 2)?)?;
    Ok((timescale, duration, decode_language(packed_language)))
}

fn decode_language(value: u16) -> Option<String> {
    let a = ((value >> 10) & 0x1f) as u8;
    let b = ((value >> 5) & 0x1f) as u8;
    let c = (value & 0x1f) as u8;
    if a == 0 || b == 0 || c == 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&[a + 0x60, b + 0x60, c + 0x60]).into_owned())
}

fn parse_handler_kind(data: &[u8]) -> Result<MediaTrackKind, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let handler = slice(body, 4, 4)?;
    match handler {
        b"vide" => Ok(MediaTrackKind::Video),
        b"soun" => Ok(MediaTrackKind::Audio),
        b"text" | b"sbtl" | b"subt" | b"clcp" => Ok(MediaTrackKind::Subtitle),
        _ => Ok(MediaTrackKind::Data),
    }
}

fn parse_sample_description(
    data: &[u8],
    kind: MediaTrackKind,
) -> Result<(MediaCodec, Option<VideoParameters>, Option<AudioParameters>, Vec<u8>), MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let entry_count = read_u32(slice(body, 0, 4)?)?;
    if entry_count == 0 {
        return Err(demux_error("MP4 stsd has no sample descriptions"));
    }
    let entries = parse_boxes(
        body.get(4..)
            .ok_or_else(|| demux_error("truncated MP4 stsd entries"))?,
    )?;
    let entry = entries
        .first()
        .ok_or_else(|| demux_error("MP4 stsd first sample entry is missing"))?;
    let codec = codec_from_sample_entry(entry.kind);

    match kind {
        MediaTrackKind::Video => {
            let width = read_u16(slice(entry.payload, 24, 2)?)? as u32;
            let height = read_u16(slice(entry.payload, 26, 2)?)? as u32;
            let private = parse_codec_private(entry.payload.get(78..).unwrap_or_default(), &codec)?;
            Ok((
                codec,
                Some(VideoParameters {
                    width,
                    height,
                    frame_rate: None,
                    bitrate_bps: None,
                }),
                None,
                private,
            ))
        }
        MediaTrackKind::Audio => {
            let mut channels = read_u16(slice(entry.payload, 16, 2)?)?;
            let sample_rate_fixed = read_u32(slice(entry.payload, 24, 4)?)?;
            let mut sample_rate_hz = sample_rate_fixed >> 16;
            let private = parse_codec_private(entry.payload.get(28..).unwrap_or_default(), &codec)?;
            if matches!(&codec, MediaCodec::Flac) {
                let info = parse_native_flac_codec_private(&private)
                    .map_err(demux_error)?;
                sample_rate_hz = info.sample_rate_hz;
                channels = info.channels;
            }
            Ok((
                codec,
                None,
                Some(AudioParameters {
                    sample_rate_hz,
                    channels,
                    bitrate_bps: None,
                }),
                private,
            ))
        }
        MediaTrackKind::Subtitle | MediaTrackKind::Data => Ok((codec, None, None, Vec::new())),
    }
}

fn codec_from_sample_entry(kind: FourCc) -> MediaCodec {
    match kind.as_bytes() {
        [b'a', b'v', b'c', b'1'] | [b'a', b'v', b'c', b'3'] => MediaCodec::H264,
        [b'h', b'v', b'c', b'1'] | [b'h', b'e', b'v', b'1'] => MediaCodec::Hevc,
        [b'a', b'v', b'0', b'1'] => MediaCodec::Av1,
        [b'v', b'p', b'0', b'9'] => MediaCodec::Vp9,
        [b'v', b'p', b'0', b'8'] => MediaCodec::Vp8,
        [b'm', b'p', b'4', b'a'] => MediaCodec::Aac,
        [b'O', b'p', b'u', b's'] => MediaCodec::Opus,
        [b'f', b'L', b'a', b'C'] => MediaCodec::Flac,
        [b'.', b'm', b'p', b'3'] | [b'm', b'p', b'3', b' '] => MediaCodec::Mp3,
        other => MediaCodec::Unknown(String::from_utf8_lossy(&other).into_owned()),
    }
}

fn parse_codec_private(data: &[u8], codec: &MediaCodec) -> Result<Vec<u8>, MediaProcessingError> {
    if data.is_empty() {
        return Ok(Vec::new());
    }
    let children = parse_boxes(data)?;
    if matches!(codec, MediaCodec::Flac) {
        let dfla = child(&children, *b"dfLa")
            .ok_or_else(|| demux_error("FLAC sample entry is missing dfLa"))?;
        return native_flac_codec_private_from_dfla(dfla.payload)
            .map_err(demux_error);
    }

    let wanted = match codec {
        MediaCodec::H264 => Some(*b"avcC"),
        MediaCodec::Hevc => Some(*b"hvcC"),
        MediaCodec::Av1 => Some(*b"av1C"),
        MediaCodec::Vp9 | MediaCodec::Vp8 => Some(*b"vpcC"),
        MediaCodec::Aac => Some(*b"esds"),
        MediaCodec::Opus => Some(*b"dOps"),
        _ => None,
    };
    Ok(wanted
        .and_then(|kind| child(&children, kind))
        .map(|item| item.payload.to_vec())
        .unwrap_or_default())
}

fn parse_sample_table(children: &[Mp4Box<'_>]) -> Result<SampleTable, MediaProcessingError> {
    let mut table = SampleTable::default();

    if let Some(stsz) = child(children, *b"stsz") {
        table.sample_sizes = parse_stsz(stsz.payload)?;
    } else if let Some(stz2) = child(children, *b"stz2") {
        table.sample_sizes = parse_stz2(stz2.payload)?;
    }

    if let Some(stco) = child(children, *b"stco") {
        table.chunk_offsets = parse_stco(stco.payload)?;
    } else if let Some(co64) = child(children, *b"co64") {
        table.chunk_offsets = parse_co64(co64.payload)?;
    }

    if let Some(stsc) = child(children, *b"stsc") {
        table.sample_to_chunk = parse_stsc(stsc.payload)?;
    }
    if let Some(stts) = child(children, *b"stts") {
        table.decode_times = parse_time_runs(stts.payload)?;
    }
    if let Some(ctts) = child(children, *b"ctts") {
        table.composition_offsets = parse_ctts(ctts.payload)?;
    }
    if let Some(stss) = child(children, *b"stss") {
        table.sync_samples = Some(parse_stss(stss.payload)?);
    }

    Ok(table)
}

fn parse_stsz(data: &[u8]) -> Result<Vec<u32>, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let fixed_size = read_u32(slice(body, 0, 4)?)?;
    let count = checked_sample_count(read_u32(slice(body, 4, 4)?)?)?;
    if fixed_size != 0 {
        return Ok(vec![fixed_size; count]);
    }
    let bytes = slice(body, 8, count.checked_mul(4).ok_or_else(|| demux_error("stsz size overflow"))?)?;
    (0..count)
        .map(|index| read_u32(&bytes[index * 4..index * 4 + 4]))
        .collect()
}

fn parse_stz2(data: &[u8]) -> Result<Vec<u32>, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let field_size = *body.get(3).ok_or_else(|| demux_error("truncated stz2 field size"))?;
    let count = checked_sample_count(read_u32(slice(body, 4, 4)?)?)?;
    let packed = body.get(8..).ok_or_else(|| demux_error("truncated stz2 sample table"))?;
    match field_size {
        4 => {
            if packed.len() < count.div_ceil(2) {
                return Err(demux_error("truncated stz2 4-bit sample table"));
            }
            Ok((0..count)
                .map(|index| {
                    let byte = packed[index / 2];
                    if index % 2 == 0 {
                        (byte >> 4) as u32
                    } else {
                        (byte & 0x0f) as u32
                    }
                })
                .collect())
        }
        8 => {
            let bytes = slice(packed, 0, count)?;
            Ok(bytes.iter().map(|value| *value as u32).collect())
        }
        16 => {
            let bytes = slice(
                packed,
                0,
                count.checked_mul(2).ok_or_else(|| demux_error("stz2 size overflow"))?,
            )?;
            (0..count)
                .map(|index| read_u16(&bytes[index * 2..index * 2 + 2]).map(u32::from))
                .collect()
        }
        other => Err(demux_error(format!("unsupported stz2 field size {other}"))),
    }
}

fn checked_sample_count(count: u32) -> Result<usize, MediaProcessingError> {
    let count = usize::try_from(count).map_err(|_| demux_error("sample count does not fit platform"))?;
    if count > MAX_SAMPLES_PER_TRACK {
        return Err(demux_error(format!(
            "MP4 sample count {count} exceeds safety limit {MAX_SAMPLES_PER_TRACK}"
        )));
    }
    Ok(count)
}

fn parse_stco(data: &[u8]) -> Result<Vec<u64>, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let count = usize::try_from(read_u32(slice(body, 0, 4)?)?)
        .map_err(|_| demux_error("stco count does not fit platform"))?;
    let bytes = slice(body, 4, count.checked_mul(4).ok_or_else(|| demux_error("stco size overflow"))?)?;
    (0..count)
        .map(|index| read_u32(&bytes[index * 4..index * 4 + 4]).map(u64::from))
        .collect()
}

fn parse_co64(data: &[u8]) -> Result<Vec<u64>, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let count = usize::try_from(read_u32(slice(body, 0, 4)?)?)
        .map_err(|_| demux_error("co64 count does not fit platform"))?;
    let bytes = slice(body, 4, count.checked_mul(8).ok_or_else(|| demux_error("co64 size overflow"))?)?;
    (0..count)
        .map(|index| read_u64(&bytes[index * 8..index * 8 + 8]))
        .collect()
}

fn parse_stsc(data: &[u8]) -> Result<Vec<SampleToChunk>, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let count = usize::try_from(read_u32(slice(body, 0, 4)?)?)
        .map_err(|_| demux_error("stsc count does not fit platform"))?;
    let bytes = slice(body, 4, count.checked_mul(12).ok_or_else(|| demux_error("stsc size overflow"))?)?;
    let mut result = Vec::with_capacity(count);
    for index in 0..count {
        let base = index * 12;
        let first_chunk = read_u32(&bytes[base..base + 4])?;
        let samples_per_chunk = read_u32(&bytes[base + 4..base + 8])?;
        if first_chunk == 0 || samples_per_chunk == 0 {
            return Err(demux_error("stsc contains zero chunk or samples-per-chunk"));
        }
        result.push(SampleToChunk {
            first_chunk,
            samples_per_chunk,
        });
    }
    if !result.windows(2).all(|pair| pair[0].first_chunk < pair[1].first_chunk) {
        return Err(demux_error("stsc first_chunk values are not strictly increasing"));
    }
    Ok(result)
}

fn parse_time_runs(data: &[u8]) -> Result<Vec<(u32, u32)>, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let count = usize::try_from(read_u32(slice(body, 0, 4)?)?)
        .map_err(|_| demux_error("time-entry count does not fit platform"))?;
    let bytes = slice(body, 4, count.checked_mul(8).ok_or_else(|| demux_error("time table overflow"))?)?;
    let mut result = Vec::with_capacity(count);
    for index in 0..count {
        let base = index * 8;
        let sample_count = read_u32(&bytes[base..base + 4])?;
        let delta = read_u32(&bytes[base + 4..base + 8])?;
        if sample_count == 0 {
            return Err(demux_error("time table contains zero sample_count"));
        }
        result.push((sample_count, delta));
    }
    Ok(result)
}

fn parse_ctts(data: &[u8]) -> Result<Vec<(u32, i64)>, MediaProcessingError> {
    let (version, _, body) = full_box_body(data)?;
    if version > 1 {
        return Err(demux_error(format!("unsupported ctts version {version}")));
    }
    let count = usize::try_from(read_u32(slice(body, 0, 4)?)?)
        .map_err(|_| demux_error("ctts count does not fit platform"))?;
    let bytes = slice(body, 4, count.checked_mul(8).ok_or_else(|| demux_error("ctts size overflow"))?)?;
    let mut result = Vec::with_capacity(count);
    for index in 0..count {
        let base = index * 8;
        let sample_count = read_u32(&bytes[base..base + 4])?;
        let offset = if version == 0 {
            read_u32(&bytes[base + 4..base + 8])? as i64
        } else {
            read_i32(&bytes[base + 4..base + 8])? as i64
        };
        if sample_count == 0 {
            return Err(demux_error("ctts contains zero sample_count"));
        }
        result.push((sample_count, offset));
    }
    Ok(result)
}

fn parse_stss(data: &[u8]) -> Result<BTreeSet<u32>, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    let count = usize::try_from(read_u32(slice(body, 0, 4)?)?)
        .map_err(|_| demux_error("stss count does not fit platform"))?;
    let bytes = slice(body, 4, count.checked_mul(4).ok_or_else(|| demux_error("stss size overflow"))?)?;
    let mut result = BTreeSet::new();
    for index in 0..count {
        let sample = read_u32(&bytes[index * 4..index * 4 + 4])?;
        if sample == 0 {
            return Err(demux_error("stss sample numbers are one-based"));
        }
        result.insert(sample);
    }
    Ok(result)
}

fn build_sample_index(table: &SampleTable, _timescale: u32) -> Result<Vec<Mp4Sample>, MediaProcessingError> {
    let sample_count = table.sample_sizes.len();
    if sample_count == 0 {
        return Ok(Vec::new());
    }
    if table.chunk_offsets.is_empty() || table.sample_to_chunk.is_empty() || table.decode_times.is_empty() {
        return Err(demux_error("classic MP4 sample table is incomplete"));
    }

    let offsets = build_sample_offsets(table, sample_count)?;
    let (decode_times, durations) = expand_decode_times(&table.decode_times, sample_count)?;
    let composition = expand_composition_offsets(&table.composition_offsets, sample_count)?;

    let mut samples = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        let sample_number = u32::try_from(index + 1)
            .map_err(|_| demux_error("sample number overflow"))?;
        let dts = decode_times[index];
        let pts = dts
            .checked_add(composition[index])
            .ok_or_else(|| demux_error("MP4 presentation timestamp overflow"))?;
        samples.push(Mp4Sample {
            offset: offsets[index],
            size: table.sample_sizes[index],
            dts,
            pts,
            duration: durations[index],
            keyframe: table
                .sync_samples
                .as_ref()
                .map(|set| set.contains(&sample_number))
                .unwrap_or(true),
        });
    }
    Ok(samples)
}

fn build_sample_offsets(table: &SampleTable, sample_count: usize) -> Result<Vec<u64>, MediaProcessingError> {
    let mut result = Vec::with_capacity(sample_count);
    let mut sample_index = 0_usize;

    for (chunk_zero_based, chunk_offset) in table.chunk_offsets.iter().copied().enumerate() {
        let chunk_number = u32::try_from(chunk_zero_based + 1)
            .map_err(|_| demux_error("chunk number overflow"))?;
        let entry = stsc_entry_for_chunk(&table.sample_to_chunk, chunk_number)
            .ok_or_else(|| demux_error("stsc has no mapping for chunk"))?;
        let mut offset = chunk_offset;

        for _ in 0..entry.samples_per_chunk {
            if sample_index >= sample_count {
                break;
            }
            result.push(offset);
            offset = offset
                .checked_add(table.sample_sizes[sample_index] as u64)
                .ok_or_else(|| demux_error("MP4 sample offset overflow"))?;
            sample_index += 1;
        }
    }

    if result.len() != sample_count {
        return Err(demux_error(format!(
            "sample/chunk tables map {} of {sample_count} samples",
            result.len()
        )));
    }
    Ok(result)
}

fn stsc_entry_for_chunk(entries: &[SampleToChunk], chunk: u32) -> Option<SampleToChunk> {
    entries
        .iter()
        .rev()
        .find(|entry| entry.first_chunk <= chunk)
        .copied()
}

fn expand_decode_times(
    runs: &[(u32, u32)],
    sample_count: usize,
) -> Result<(Vec<i64>, Vec<u32>), MediaProcessingError> {
    let mut times = Vec::with_capacity(sample_count);
    let mut durations = Vec::with_capacity(sample_count);
    let mut dts = 0_i64;

    for (count, delta) in runs {
        for _ in 0..*count {
            if times.len() >= sample_count {
                return Err(demux_error("stts describes more samples than stsz"));
            }
            times.push(dts);
            durations.push(*delta);
            dts = dts
                .checked_add(i64::from(*delta))
                .ok_or_else(|| demux_error("MP4 decode timestamp overflow"))?;
        }
    }
    if times.len() != sample_count {
        return Err(demux_error("stts describes fewer samples than stsz"));
    }
    Ok((times, durations))
}

fn expand_composition_offsets(
    runs: &[(u32, i64)],
    sample_count: usize,
) -> Result<Vec<i64>, MediaProcessingError> {
    if runs.is_empty() {
        return Ok(vec![0; sample_count]);
    }
    let mut result = Vec::with_capacity(sample_count);
    for (count, offset) in runs {
        for _ in 0..*count {
            if result.len() >= sample_count {
                return Err(demux_error("ctts describes more samples than stsz"));
            }
            result.push(*offset);
        }
    }
    if result.len() != sample_count {
        return Err(demux_error("ctts describes fewer samples than stsz"));
    }
    Ok(result)
}

fn track_duration_millis(track: &MediaTrack, last: Option<&Mp4Sample>) -> Option<u64> {
    let sample = last?;
    let total = sample.dts.checked_add(i64::from(sample.duration))?;
    if total < 0 {
        return None;
    }
    Some(scale_to_millis(total as u64, track.time_base.denominator))
}

fn scale_to_millis(value: u64, timescale: u32) -> u64 {
    if timescale == 0 {
        return 0;
    }
    value.saturating_mul(1000) / u64::from(timescale)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_bytes(kind: &[u8; 4], payload: Vec<u8>) -> Vec<u8> {
        let size = u32::try_from(payload.len() + 8).expect("box size");
        let mut bytes = Vec::with_capacity(size as usize);
        bytes.extend_from_slice(&size.to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn full_box(version: u8, payload: Vec<u8>) -> Vec<u8> {
        let mut bytes = vec![version, 0, 0, 0];
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn minimal_video_moov() -> Vec<u8> {
        let mut mvhd_body = vec![0_u8; 100];
        mvhd_body[8..12].copy_from_slice(&1000_u32.to_be_bytes());
        mvhd_body[12..16].copy_from_slice(&2000_u32.to_be_bytes());
        let mvhd = box_bytes(b"mvhd", full_box(0, mvhd_body));

        let mut tkhd_body = vec![0_u8; 84];
        tkhd_body[8..12].copy_from_slice(&1_u32.to_be_bytes());
        tkhd_body[76..80].copy_from_slice(&(1920_u32 << 16).to_be_bytes());
        tkhd_body[80..84].copy_from_slice(&(1080_u32 << 16).to_be_bytes());
        let tkhd = box_bytes(b"tkhd", full_box(0, tkhd_body));

        let mut mdhd_body = vec![0_u8; 20];
        mdhd_body[8..12].copy_from_slice(&1000_u32.to_be_bytes());
        mdhd_body[12..16].copy_from_slice(&2000_u32.to_be_bytes());
        let language = ((5_u16) << 10) | ((14_u16) << 5) | 7_u16;
        mdhd_body[16..18].copy_from_slice(&language.to_be_bytes());
        let mdhd = box_bytes(b"mdhd", full_box(0, mdhd_body));

        let mut hdlr_body = vec![0_u8; 20];
        hdlr_body[4..8].copy_from_slice(b"vide");
        let hdlr = box_bytes(b"hdlr", full_box(0, hdlr_body));

        let avcc = box_bytes(b"avcC", vec![1, 100, 0, 40]);
        let mut sample_entry = vec![0_u8; 78];
        sample_entry[24..26].copy_from_slice(&1920_u16.to_be_bytes());
        sample_entry[26..28].copy_from_slice(&1080_u16.to_be_bytes());
        sample_entry.extend_from_slice(&avcc);
        let avc1 = box_bytes(b"avc1", sample_entry);
        let mut stsd_payload = 1_u32.to_be_bytes().to_vec();
        stsd_payload.extend_from_slice(&avc1);
        let stsd = box_bytes(b"stsd", full_box(0, stsd_payload));

        let mut stts_payload = 1_u32.to_be_bytes().to_vec();
        stts_payload.extend_from_slice(&2_u32.to_be_bytes());
        stts_payload.extend_from_slice(&1000_u32.to_be_bytes());
        let stts = box_bytes(b"stts", full_box(0, stts_payload));

        let mut stsc_payload = 1_u32.to_be_bytes().to_vec();
        stsc_payload.extend_from_slice(&1_u32.to_be_bytes());
        stsc_payload.extend_from_slice(&2_u32.to_be_bytes());
        stsc_payload.extend_from_slice(&1_u32.to_be_bytes());
        let stsc = box_bytes(b"stsc", full_box(0, stsc_payload));

        let mut stsz_payload = 0_u32.to_be_bytes().to_vec();
        stsz_payload.extend_from_slice(&2_u32.to_be_bytes());
        stsz_payload.extend_from_slice(&4_u32.to_be_bytes());
        stsz_payload.extend_from_slice(&5_u32.to_be_bytes());
        let stsz = box_bytes(b"stsz", full_box(0, stsz_payload));

        let mut stco_payload = 1_u32.to_be_bytes().to_vec();
        stco_payload.extend_from_slice(&4096_u32.to_be_bytes());
        let stco = box_bytes(b"stco", full_box(0, stco_payload));

        let mut stss_payload = 1_u32.to_be_bytes().to_vec();
        stss_payload.extend_from_slice(&1_u32.to_be_bytes());
        let stss = box_bytes(b"stss", full_box(0, stss_payload));

        let stbl = box_bytes(
            b"stbl",
            [stsd, stts, stsc, stsz, stco, stss].concat(),
        );
        let minf = box_bytes(b"minf", stbl);
        let mdia = box_bytes(b"mdia", [mdhd, hdlr, minf].concat());
        let trak = box_bytes(b"trak", [tkhd, mdia].concat());
        [mvhd, trak].concat()
    }

    #[test]
    fn parses_classic_video_track_and_sample_index() {
        let parsed = parse_movie(&minimal_video_moov(), false).expect("movie");
        assert_eq!(parsed.probe.container, MediaContainer::Mp4);
        assert_eq!(parsed.probe.duration_millis, Some(2000));
        assert_eq!(parsed.tracks.len(), 1);
        let track = &parsed.tracks[0];
        assert_eq!(track.track.id, 1);
        assert_eq!(track.track.codec, MediaCodec::H264);
        assert_eq!(track.track.language.as_deref(), Some("eng"));
        assert_eq!(track.track.video.as_ref().map(|v| v.width), Some(1920));
        assert_eq!(track.samples.len(), 2);
        assert_eq!(track.samples[0].offset, 4096);
        assert_eq!(track.samples[1].offset, 4100);
        assert!(track.samples[0].keyframe);
        assert!(!track.samples[1].keyframe);
        assert_eq!(track.samples[1].dts, 1000);
    }

    #[test]
    fn fragmented_probe_keeps_moov_metadata_but_marks_container() {
        let parsed = parse_movie(&minimal_video_moov(), true).expect("movie");
        assert_eq!(parsed.probe.container, MediaContainer::FragmentedMp4);
        assert!(parsed.fragmented);
    }
}
