use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::{
    AudioParameters, MediaCodec, MediaContainer, MediaDemuxer, MediaPacket, MediaPacketFlags,
    MediaProbe, MediaProcessingError, MediaTimeBase, MediaTimestamp, MediaTrack, MediaTrackKind,
    VideoParameters,
};

const ID_EBML: u64 = 0x1A45DFA3;
const ID_DOC_TYPE: u64 = 0x4282;
const ID_SEGMENT: u64 = 0x18538067;
const ID_INFO: u64 = 0x1549A966;
const ID_TIMECODE_SCALE: u64 = 0x2AD7B1;
const ID_DURATION: u64 = 0x4489;
const ID_TRACKS: u64 = 0x1654AE6B;
const ID_TRACK_ENTRY: u64 = 0xAE;
const ID_TRACK_NUMBER: u64 = 0xD7;
const ID_TRACK_TYPE: u64 = 0x83;
const ID_CODEC_ID: u64 = 0x86;
const ID_CODEC_PRIVATE: u64 = 0x63A2;
const ID_DEFAULT_DURATION: u64 = 0x23E383;
const ID_LANGUAGE: u64 = 0x22B59C;
const ID_VIDEO: u64 = 0xE0;
const ID_PIXEL_WIDTH: u64 = 0xB0;
const ID_PIXEL_HEIGHT: u64 = 0xBA;
const ID_COLOUR: u64 = 0x55B0;
const ID_MATRIX_COEFFICIENTS: u64 = 0x55B1;
const ID_BITS_PER_CHANNEL: u64 = 0x55B2;
const ID_COLOUR_RANGE: u64 = 0x55B9;
const ID_TRANSFER_CHARACTERISTICS: u64 = 0x55BA;
const ID_PRIMARIES: u64 = 0x55BB;
const ID_AUDIO: u64 = 0xE1;
const ID_SAMPLING_FREQUENCY: u64 = 0xB5;
const ID_CHANNELS: u64 = 0x9F;
const ID_CLUSTER: u64 = 0x1F43B675;
const ID_CLUSTER_TIMECODE: u64 = 0xE7;
const ID_SIMPLE_BLOCK: u64 = 0xA3;
const ID_BLOCK_GROUP: u64 = 0xA0;
const ID_BLOCK: u64 = 0xA1;
const ID_BLOCK_DURATION: u64 = 0x9B;
const ID_REFERENCE_BLOCK: u64 = 0xFB;
const ID_DISCARD_PADDING: u64 = 0x75A2;

const NANOSECOND_TIME_BASE: MediaTimeBase = MediaTimeBase {
    numerator: 1,
    denominator: 1_000_000_000,
};
const DEFAULT_TIMECODE_SCALE_NS: u64 = 1_000_000;
const MAX_TRACKS: usize = 64;
const MAX_PACKETS: usize = 10_000_000;
const MAX_ELEMENTS: usize = 12_000_000;
const MAX_PACKET_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CODEC_PRIVATE_BYTES: u64 = 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 4096;

#[derive(Clone, Copy, Debug)]
struct ElementHeader {
    id: u64,
    data_offset: u64,
    data_end: u64,
    unknown_size: bool,
}

impl ElementHeader {
    fn size(self) -> u64 {
        self.data_end.saturating_sub(self.data_offset)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WebmVideoColour {
    matrix_coefficients: u8,
    bits_per_channel: u8,
    range: u8,
    transfer_characteristics: u8,
    primaries: u8,
}

impl Default for WebmVideoColour {
    fn default() -> Self {
        Self {
            matrix_coefficients: 2,
            bits_per_channel: 0,
            range: 0,
            transfer_characteristics: 2,
            primaries: 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct VpColourConfiguration {
    colour_primaries: u8,
    transfer_characteristics: u8,
    matrix_coefficients: u8,
    full_range: bool,
}

impl Default for VpColourConfiguration {
    fn default() -> Self {
        Self {
            colour_primaries: 1,
            transfer_characteristics: 1,
            matrix_coefficients: 1,
            full_range: false,
        }
    }
}

#[derive(Clone, Debug)]
struct TrackMeta {
    track: MediaTrack,
    default_duration_ns: Option<u64>,
    colour: Option<WebmVideoColour>,
}

#[derive(Clone, Debug)]
struct RawPacketLocator {
    track_id: u32,
    offset: u64,
    size: u64,
    block_id: u64,
    block_timecode_units: i64,
    block_duration_units: Option<u64>,
    discard_padding_ns: Option<i64>,
    lace_index: u16,
    lace_count: u16,
    keyframe: bool,
}

#[derive(Clone, Debug)]
struct PacketLocator {
    track_id: u32,
    offset: u64,
    size: u64,
    pts_ns: i64,
    duration_ns: Option<i64>,
    discard_padding_ns: Option<i64>,
    keyframe: bool,
}

#[derive(Clone, Copy, Debug)]
struct BlockFrame {
    offset: u64,
    size: u64,
}

#[derive(Clone, Debug)]
struct ParsedBlock {
    track_id: u32,
    relative_timecode: i16,
    keyframe: bool,
    frames: Vec<BlockFrame>,
}

#[derive(Clone, Copy, Debug)]
struct SegmentInfo {
    timecode_scale_ns: u64,
    duration_ticks: Option<f64>,
}

impl Default for SegmentInfo {
    fn default() -> Self {
        Self {
            timecode_scale_ns: DEFAULT_TIMECODE_SCALE_NS,
            duration_ticks: None,
        }
    }
}

#[derive(Debug)]
pub struct WebmDemuxer {
    file: File,
    probe: MediaProbe,
    packets: Vec<PacketLocator>,
    packet_time_bases: BTreeMap<u32, MediaTimeBase>,
    video_colours: BTreeMap<u32, WebmVideoColour>,
    apply_discard_padding: bool,
    cursor: usize,
}

impl WebmDemuxer {
    pub fn open(path: &Path) -> Result<Self, MediaProcessingError> {
        Self::open_container(path, "webm", MediaContainer::WebM)
    }

    fn open_container(
        path: &Path,
        expected_doc_type: &str,
        container: MediaContainer,
    ) -> Result<Self, MediaProcessingError> {
        let mut file = File::open(path).map_err(io_error)?;
        let file_len = file.metadata().map_err(io_error)?.len();
        if file_len < 8 {
            return Err(demux_error("file is too small to be EBML media"));
        }

        let (probe, packets, video_colours) =
            scan_ebml(&mut file, file_len, expected_doc_type, container)?;
        let packet_time_bases = probe
            .tracks
            .iter()
            .map(|track| (track.id, track.time_base))
            .collect();
        Ok(Self {
            file,
            probe,
            packets,
            packet_time_bases,
            video_colours,
            apply_discard_padding: false,
            cursor: 0,
        })
    }

    pub fn packet_count(&self) -> usize {
        self.packets.len()
    }

    /// Open WebM for packet-preserving remux into NOVA's MP4 muxer.
    ///
    /// WebM codec initialization data is converted to the ISO-BMFF form
    /// expected by `Mp4Muxer`. Unsupported codec/profile combinations remain
    /// explicitly gated instead of producing a structurally valid but
    /// undecodable MP4.
    pub fn open_for_mp4_remux(path: &Path) -> Result<Self, MediaProcessingError> {
        let mut demuxer = Self::open(path)?;
        let video_colours = demuxer.video_colours.clone();
        demuxer.probe.tracks = demuxer
            .probe
            .tracks
            .iter()
            .map(|track| {
                prepare_webm_track_for_mp4_with_colour(
                    track,
                    video_colours.get(&track.id).copied(),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        demuxer.packet_time_bases = demuxer
            .probe
            .tracks
            .iter()
            .map(|track| (track.id, track.time_base))
            .collect();

        let codecs = demuxer
            .probe
            .tracks
            .iter()
            .map(|track| (track.id, &track.codec))
            .collect::<BTreeMap<_, _>>();
        let mut last_packet_by_track = BTreeMap::<u32, usize>::new();
        for (index, packet) in demuxer.packets.iter().enumerate() {
            last_packet_by_track.insert(packet.track_id, index);
        }
        for (index, packet) in demuxer.packets.iter().enumerate() {
            let Some(padding) = packet.discard_padding_ns.filter(|value| *value != 0) else {
                continue;
            };
            if !matches!(codecs.get(&packet.track_id), Some(MediaCodec::Opus)) {
                return Err(MediaProcessingError::UnsupportedOperation(
                    "WebM DiscardPadding remux is currently implemented only for Opus"
                        .to_owned(),
                ));
            }
            if padding < 0 {
                return Err(MediaProcessingError::UnsupportedOperation(
                    "negative WebM DiscardPadding requires start-trim timeline handling"
                        .to_owned(),
                ));
            }
            if last_packet_by_track.get(&packet.track_id) != Some(&index) {
                return Err(MediaProcessingError::UnsupportedOperation(
                    "WebM DiscardPadding before the final Opus packet cannot preserve contiguous DTS"
                        .to_owned(),
                ));
            }
            let duration = packet.duration_ns.ok_or_else(|| {
                demux_error("final Opus packet with DiscardPadding is missing duration")
            })?;
            if padding >= duration {
                return Err(demux_error(
                    "WebM DiscardPadding consumes the entire final Opus packet",
                ));
            }
        }
        demuxer.apply_discard_padding = true;
        Ok(demuxer)
    }
}

/// Native Matroska reader backed by the same bounded EBML packet indexer used
/// for WebM. The public type keeps the container boundary explicit while the
/// parser shares the common Matroska/WebM Segment, Track, Cluster and Block
/// machinery.
#[derive(Debug)]
pub struct MatroskaDemuxer {
    inner: WebmDemuxer,
}

impl MatroskaDemuxer {
    pub fn open(path: &Path) -> Result<Self, MediaProcessingError> {
        Ok(Self {
            inner: WebmDemuxer::open_container(
                path,
                "matroska",
                MediaContainer::Matroska,
            )?,
        })
    }

    pub fn packet_count(&self) -> usize {
        self.inner.packet_count()
    }
}

impl MediaDemuxer for MatroskaDemuxer {
    fn probe(&self) -> &MediaProbe {
        self.inner.probe()
    }

    fn next_packet(&mut self) -> Result<Option<MediaPacket>, MediaProcessingError> {
        self.inner.next_packet()
    }
}

impl MediaDemuxer for WebmDemuxer {
    fn probe(&self) -> &MediaProbe {
        &self.probe
    }

    fn next_packet(&mut self) -> Result<Option<MediaPacket>, MediaProcessingError> {
        let Some(locator) = self.packets.get(self.cursor).cloned() else {
            return Ok(None);
        };
        self.cursor += 1;

        if locator.size > MAX_PACKET_BYTES {
            return Err(demux_error(format!(
                "WebM frame size {} exceeds safety limit {MAX_PACKET_BYTES}",
                locator.size
            )));
        }
        let size = usize::try_from(locator.size)
            .map_err(|_| demux_error("WebM frame size does not fit platform"))?;
        let mut data = vec![0_u8; size];
        self.file
            .seek(SeekFrom::Start(locator.offset))
            .and_then(|_| self.file.read_exact(&mut data))
            .map_err(io_error)?;

        let time_base = self
            .packet_time_bases
            .get(&locator.track_id)
            .copied()
            .unwrap_or(NANOSECOND_TIME_BASE);
        let timestamp = MediaTimestamp {
            value: rescale_nanoseconds(locator.pts_ns, time_base)?,
            time_base,
        };
        let duration_ns = match (
            locator.duration_ns,
            self.apply_discard_padding.then_some(locator.discard_padding_ns).flatten(),
        ) {
            (Some(duration), Some(padding)) if padding > 0 => Some(
                duration
                    .checked_sub(padding)
                    .filter(|value| *value > 0)
                    .ok_or_else(|| demux_error("WebM DiscardPadding exceeds packet duration"))?,
            ),
            (duration, _) => duration,
        };
        let duration = duration_ns
            .map(|value| {
                Ok(MediaTimestamp {
                    value: rescale_nanoseconds(value, time_base)?,
                    time_base,
                })
            })
            .transpose()?;
        Ok(Some(MediaPacket {
            track_id: locator.track_id,
            pts: Some(timestamp),
            dts: Some(timestamp),
            duration,
            flags: MediaPacketFlags {
                keyframe: locator.keyframe,
                discontinuity: false,
                corrupted: false,
            },
            data,
        }))
    }
}

pub fn probe_webm_file(path: &Path) -> Result<MediaProbe, MediaProcessingError> {
    WebmDemuxer::open(path).map(|demuxer| demuxer.probe)
}

pub fn probe_matroska_file(path: &Path) -> Result<MediaProbe, MediaProcessingError> {
    MatroskaDemuxer::open(path).map(|demuxer| demuxer.inner.probe)
}

fn scan_ebml(
    file: &mut File,
    file_len: u64,
    expected_doc_type: &str,
    container: MediaContainer,
) -> Result<
    (
        MediaProbe,
        Vec<PacketLocator>,
        BTreeMap<u32, WebmVideoColour>,
    ),
    MediaProcessingError,
> {
    let mut element_count = 0_usize;
    let ebml = read_element_header(file, 0, file_len)?;
    bump_element_count(&mut element_count)?;
    if ebml.id != ID_EBML {
        return Err(demux_error("file does not begin with an EBML header"));
    }

    let doc_type = parse_doc_type(file, ebml, &mut element_count)?
        .ok_or_else(|| demux_error("EBML header is missing DocType"))?;
    if !doc_type.eq_ignore_ascii_case(expected_doc_type) {
        return Err(MediaProcessingError::UnsupportedContainer(format!(
            "EBML DocType '{doc_type}' does not match expected '{expected_doc_type}'"
        )));
    }

    let segment = find_segment(file, ebml.data_end, file_len, &mut element_count)?;
    let mut info = SegmentInfo::default();
    let mut tracks = BTreeMap::<u32, TrackMeta>::new();
    let mut raw_packets = Vec::<RawPacketLocator>::new();
    let mut block_id = 0_u64;

    let mut cursor = segment.data_offset;
    while cursor < segment.data_end {
        let child = read_element_header(file, cursor, segment.data_end)?;
        bump_element_count(&mut element_count)?;
        match child.id {
            ID_INFO => parse_info(file, child, &mut info, &mut element_count)?,
            ID_TRACKS => parse_tracks(file, child, &mut tracks, &mut element_count)?,
            ID_CLUSTER => {
                cursor = parse_cluster(
                    file,
                    child,
                    &mut raw_packets,
                    &mut block_id,
                    &mut element_count,
                )?;
                continue;
            }
            _ => {}
        }
        cursor = child.data_end;
    }

    if tracks.is_empty() {
        return Err(demux_error("WebM segment contains no tracks"));
    }
    if raw_packets.is_empty() {
        return Err(demux_error("WebM segment contains no media blocks"));
    }

    for packet in &raw_packets {
        if !tracks.contains_key(&packet.track_id) {
            return Err(demux_error(format!(
                "WebM block references unknown track {}",
                packet.track_id
            )));
        }
    }

    let packets = finalize_packet_timing(&raw_packets, &tracks, info.timecode_scale_ns)?;
    let duration_millis = info.duration_ticks.and_then(|ticks| {
        let millis = ticks * info.timecode_scale_ns as f64 / 1_000_000.0;
        (millis.is_finite() && millis >= 0.0 && millis <= u64::MAX as f64)
            .then(|| millis.round() as u64)
    });

    let video_colours = tracks
        .iter()
        .filter_map(|(track_id, meta)| meta.colour.map(|colour| (*track_id, colour)))
        .collect();
    let probe = MediaProbe {
        container,
        duration_millis,
        tracks: tracks.into_values().map(|meta| meta.track).collect(),
    };
    Ok((probe, packets, video_colours))
}

fn parse_doc_type(
    file: &mut File,
    ebml: ElementHeader,
    element_count: &mut usize,
) -> Result<Option<String>, MediaProcessingError> {
    let mut cursor = ebml.data_offset;
    while cursor < ebml.data_end {
        let child = read_element_header(file, cursor, ebml.data_end)?;
        bump_element_count(element_count)?;
        if child.id == ID_DOC_TYPE {
            return read_text(file, child, "EBML DocType").map(Some);
        }
        cursor = child.data_end;
    }
    Ok(None)
}

fn find_segment(
    file: &mut File,
    mut cursor: u64,
    file_len: u64,
    element_count: &mut usize,
) -> Result<ElementHeader, MediaProcessingError> {
    while cursor < file_len {
        let header = read_element_header(file, cursor, file_len)?;
        bump_element_count(element_count)?;
        if header.id == ID_SEGMENT {
            return Ok(header);
        }
        if header.unknown_size {
            return Err(demux_error(
                "unknown-size top-level EBML element appears before Segment",
            ));
        }
        cursor = header.data_end;
    }
    Err(demux_error("WebM file is missing Segment"))
}

fn parse_info(
    file: &mut File,
    info_header: ElementHeader,
    info: &mut SegmentInfo,
    element_count: &mut usize,
) -> Result<(), MediaProcessingError> {
    let mut cursor = info_header.data_offset;
    while cursor < info_header.data_end {
        let child = read_element_header(file, cursor, info_header.data_end)?;
        bump_element_count(element_count)?;
        match child.id {
            ID_TIMECODE_SCALE => {
                let scale = read_uint(file, child)?;
                if scale == 0 {
                    return Err(demux_error("WebM TimecodeScale must be positive"));
                }
                info.timecode_scale_ns = scale;
            }
            ID_DURATION => {
                let duration = read_float(file, child)?;
                if duration.is_finite() && duration >= 0.0 {
                    info.duration_ticks = Some(duration);
                }
            }
            _ => {}
        }
        cursor = child.data_end;
    }
    Ok(())
}

fn parse_tracks(
    file: &mut File,
    tracks_header: ElementHeader,
    tracks: &mut BTreeMap<u32, TrackMeta>,
    element_count: &mut usize,
) -> Result<(), MediaProcessingError> {
    let mut cursor = tracks_header.data_offset;
    while cursor < tracks_header.data_end {
        let child = read_element_header(file, cursor, tracks_header.data_end)?;
        bump_element_count(element_count)?;
        if child.id == ID_TRACK_ENTRY {
            let track = parse_track_entry(file, child, element_count)?;
            if tracks.len() >= MAX_TRACKS && !tracks.contains_key(&track.track.id) {
                return Err(demux_error(format!(
                    "WebM exceeds track safety limit {MAX_TRACKS}"
                )));
            }
            if tracks.insert(track.track.id, track).is_some() {
                return Err(demux_error("WebM contains duplicate TrackNumber"));
            }
        }
        cursor = child.data_end;
    }
    Ok(())
}

fn parse_track_entry(
    file: &mut File,
    entry: ElementHeader,
    element_count: &mut usize,
) -> Result<TrackMeta, MediaProcessingError> {
    let mut number = None;
    let mut kind = None;
    let mut codec_id = None;
    let mut codec_private = Vec::new();
    let mut default_duration_ns = None;
    let mut language = None;
    let mut width = None;
    let mut height = None;
    let mut colour = None;
    let mut sample_rate = None;
    let mut channels = None;

    let mut cursor = entry.data_offset;
    while cursor < entry.data_end {
        let child = read_element_header(file, cursor, entry.data_end)?;
        bump_element_count(element_count)?;
        match child.id {
            ID_TRACK_NUMBER => {
                number = Some(
                    u32::try_from(read_uint(file, child)?)
                        .map_err(|_| demux_error("WebM TrackNumber exceeds u32"))?,
                );
            }
            ID_TRACK_TYPE => kind = Some(track_kind(read_uint(file, child)?)),
            ID_CODEC_ID => codec_id = Some(read_text(file, child, "CodecID")?),
            ID_CODEC_PRIVATE => {
                if child.size() > MAX_CODEC_PRIVATE_BYTES {
                    return Err(demux_error(format!(
                        "WebM CodecPrivate exceeds safety limit {MAX_CODEC_PRIVATE_BYTES}"
                    )));
                }
                codec_private = read_bytes(file, child)?;
            }
            ID_DEFAULT_DURATION => {
                let value = read_uint(file, child)?;
                if value > 0 {
                    default_duration_ns = Some(value);
                }
            }
            ID_LANGUAGE => {
                let value = read_text(file, child, "Language")?;
                if !value.is_empty() {
                    language = Some(value);
                }
            }
            ID_VIDEO => {
                let (parsed_width, parsed_height, parsed_colour) =
                    parse_video(file, child, element_count)?;
                width = parsed_width;
                height = parsed_height;
                colour = parsed_colour;
            }
            ID_AUDIO => {
                let (parsed_rate, parsed_channels) =
                    parse_audio(file, child, element_count)?;
                sample_rate = parsed_rate;
                channels = parsed_channels;
            }
            _ => {}
        }
        cursor = child.data_end;
    }

    let id = number.ok_or_else(|| demux_error("WebM TrackEntry is missing TrackNumber"))?;
    if id == 0 {
        return Err(demux_error("WebM TrackNumber must be positive"));
    }
    let kind = kind.ok_or_else(|| demux_error("WebM TrackEntry is missing TrackType"))?;
    let codec_id = codec_id.ok_or_else(|| demux_error("WebM TrackEntry is missing CodecID"))?;
    let codec = codec_from_ebml_id(&codec_id);

    let video = if kind == MediaTrackKind::Video {
        let width = width.ok_or_else(|| demux_error("WebM video track is missing PixelWidth"))?;
        let height =
            height.ok_or_else(|| demux_error("WebM video track is missing PixelHeight"))?;
        Some(VideoParameters {
            width,
            height,
            frame_rate: default_duration_ns
                .filter(|duration| *duration > 0)
                .map(|duration| 1_000_000_000.0 / duration as f64),
            bitrate_bps: None,
        })
    } else {
        None
    };

    let audio = if kind == MediaTrackKind::Audio {
        let sample_rate_hz = sample_rate
            .filter(|value| value.is_finite() && *value > 0.0 && *value <= u32::MAX as f64)
            .map(|value| value.round() as u32)
            .ok_or_else(|| demux_error("WebM audio track has invalid SamplingFrequency"))?;
        let channels = channels
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| demux_error("WebM audio track has invalid Channels"))?;
        Some(AudioParameters {
            sample_rate_hz,
            channels,
            bitrate_bps: None,
        })
    } else {
        None
    };

    Ok(TrackMeta {
        track: MediaTrack {
            id,
            kind,
            codec,
            time_base: NANOSECOND_TIME_BASE,
            language,
            video,
            audio,
            codec_private,
        },
        default_duration_ns,
        colour,
    })
}

fn parse_video(
    file: &mut File,
    video: ElementHeader,
    element_count: &mut usize,
) -> Result<
    (
        Option<u32>,
        Option<u32>,
        Option<WebmVideoColour>,
    ),
    MediaProcessingError,
> {
    let mut width = None;
    let mut height = None;
    let mut colour = None;
    let mut cursor = video.data_offset;
    while cursor < video.data_end {
        let child = read_element_header(file, cursor, video.data_end)?;
        bump_element_count(element_count)?;
        match child.id {
            ID_PIXEL_WIDTH => {
                width = Some(
                    u32::try_from(read_uint(file, child)?)
                        .map_err(|_| demux_error("WebM PixelWidth exceeds u32"))?,
                )
            }
            ID_PIXEL_HEIGHT => {
                height = Some(
                    u32::try_from(read_uint(file, child)?)
                        .map_err(|_| demux_error("WebM PixelHeight exceeds u32"))?,
                )
            }
            ID_COLOUR => {
                if colour.is_some() {
                    return Err(demux_error("WebM Video contains duplicate Colour elements"));
                }
                colour = Some(parse_video_colour(file, child, element_count)?);
            }
            _ => {}
        }
        cursor = child.data_end;
    }
    Ok((width, height, colour))
}

fn parse_video_colour(
    file: &mut File,
    colour_header: ElementHeader,
    element_count: &mut usize,
) -> Result<WebmVideoColour, MediaProcessingError> {
    let mut colour = WebmVideoColour::default();
    let mut cursor = colour_header.data_offset;
    while cursor < colour_header.data_end {
        let child = read_element_header(file, cursor, colour_header.data_end)?;
        bump_element_count(element_count)?;
        match child.id {
            ID_MATRIX_COEFFICIENTS => {
                colour.matrix_coefficients =
                    read_colour_u8(file, child, "MatrixCoefficients")?;
            }
            ID_BITS_PER_CHANNEL => {
                colour.bits_per_channel =
                    read_colour_u8(file, child, "BitsPerChannel")?;
            }
            ID_COLOUR_RANGE => {
                colour.range = read_colour_u8(file, child, "Range")?;
                if colour.range > 3 {
                    return Err(demux_error("WebM Colour Range exceeds defined values"));
                }
            }
            ID_TRANSFER_CHARACTERISTICS => {
                colour.transfer_characteristics =
                    read_colour_u8(file, child, "TransferCharacteristics")?;
            }
            ID_PRIMARIES => {
                colour.primaries = read_colour_u8(file, child, "Primaries")?;
            }
            _ => {}
        }
        cursor = child.data_end;
    }
    Ok(colour)
}

fn read_colour_u8(
    file: &mut File,
    header: ElementHeader,
    name: &str,
) -> Result<u8, MediaProcessingError> {
    u8::try_from(read_uint(file, header)?)
        .map_err(|_| demux_error(format!("WebM Colour {name} exceeds u8")))
}

fn parse_audio(
    file: &mut File,
    audio: ElementHeader,
    element_count: &mut usize,
) -> Result<(Option<f64>, Option<u64>), MediaProcessingError> {
    let mut sample_rate = None;
    let mut channels = None;
    let mut cursor = audio.data_offset;
    while cursor < audio.data_end {
        let child = read_element_header(file, cursor, audio.data_end)?;
        bump_element_count(element_count)?;
        match child.id {
            ID_SAMPLING_FREQUENCY => sample_rate = Some(read_float(file, child)?),
            ID_CHANNELS => channels = Some(read_uint(file, child)?),
            _ => {}
        }
        cursor = child.data_end;
    }
    Ok((sample_rate, channels))
}

fn parse_cluster(
    file: &mut File,
    cluster: ElementHeader,
    packets: &mut Vec<RawPacketLocator>,
    block_id: &mut u64,
    element_count: &mut usize,
) -> Result<u64, MediaProcessingError> {
    let mut cluster_timecode = 0_u64;
    let mut cursor = cluster.data_offset;

    while cursor < cluster.data_end {
        let child = read_element_header(file, cursor, cluster.data_end)?;
        if cluster.unknown_size && child.id == ID_CLUSTER {
            return Ok(cursor);
        }
        bump_element_count(element_count)?;

        match child.id {
            ID_CLUSTER_TIMECODE => cluster_timecode = read_uint(file, child)?,
            ID_SIMPLE_BLOCK => {
                let parsed = parse_block(file, child, true)?;
                push_block_packets(
                    parsed,
                    cluster_timecode,
                    None,
                    None,
                    packets,
                    block_id,
                )?;
            }
            ID_BLOCK_GROUP => {
                parse_block_group(
                    file,
                    child,
                    cluster_timecode,
                    packets,
                    block_id,
                    element_count,
                )?;
            }
            _ => {}
        }
        cursor = child.data_end;
    }

    Ok(cluster.data_end)
}

fn parse_block_group(
    file: &mut File,
    group: ElementHeader,
    cluster_timecode: u64,
    packets: &mut Vec<RawPacketLocator>,
    block_id: &mut u64,
    element_count: &mut usize,
) -> Result<(), MediaProcessingError> {
    let mut block = None;
    let mut duration = None;
    let mut discard_padding_ns = None;
    let mut has_reference = false;
    let mut cursor = group.data_offset;

    while cursor < group.data_end {
        let child = read_element_header(file, cursor, group.data_end)?;
        bump_element_count(element_count)?;
        match child.id {
            ID_BLOCK => block = Some(child),
            ID_BLOCK_DURATION => duration = Some(read_uint(file, child)?),
            ID_DISCARD_PADDING => discard_padding_ns = Some(read_signed_int(file, child)?),
            ID_REFERENCE_BLOCK => has_reference = true,
            _ => {}
        }
        cursor = child.data_end;
    }

    if let Some(block_header) = block {
        let mut parsed = parse_block(file, block_header, false)?;
        parsed.keyframe = !has_reference;
        push_block_packets(
            parsed,
            cluster_timecode,
            duration,
            discard_padding_ns,
            packets,
            block_id,
        )?;
    }
    Ok(())
}

fn push_block_packets(
    block: ParsedBlock,
    cluster_timecode: u64,
    block_duration_units: Option<u64>,
    discard_padding_ns: Option<i64>,
    packets: &mut Vec<RawPacketLocator>,
    block_id: &mut u64,
) -> Result<(), MediaProcessingError> {
    if block.frames.is_empty() {
        return Err(demux_error("WebM block contains no frames"));
    }
    if packets.len().saturating_add(block.frames.len()) > MAX_PACKETS {
        return Err(demux_error(format!(
            "WebM exceeds packet safety limit {MAX_PACKETS}"
        )));
    }

    let cluster_timecode = i64::try_from(cluster_timecode)
        .map_err(|_| demux_error("WebM Cluster Timecode exceeds i64"))?;
    let block_timecode_units = cluster_timecode
        .checked_add(i64::from(block.relative_timecode))
        .ok_or_else(|| demux_error("WebM block timecode overflow"))?;
    let lace_count = u16::try_from(block.frames.len())
        .map_err(|_| demux_error("WebM lace frame count exceeds u16"))?;
    let current_block_id = *block_id;
    *block_id = block_id
        .checked_add(1)
        .ok_or_else(|| demux_error("WebM block counter overflow"))?;

    for (index, frame) in block.frames.into_iter().enumerate() {
        if frame.size == 0 || frame.size > MAX_PACKET_BYTES {
            return Err(demux_error(format!(
                "WebM frame size {} is outside the supported range",
                frame.size
            )));
        }
        packets.push(RawPacketLocator {
            track_id: block.track_id,
            offset: frame.offset,
            size: frame.size,
            block_id: current_block_id,
            block_timecode_units,
            block_duration_units,
            discard_padding_ns: match discard_padding_ns {
                Some(value) if value > 0 && index + 1 == usize::from(lace_count) => Some(value),
                Some(value) if value < 0 && index == 0 => Some(value),
                _ => None,
            },
            lace_index: u16::try_from(index)
                .map_err(|_| demux_error("WebM lace index exceeds u16"))?,
            lace_count,
            keyframe: block.keyframe,
        });
    }
    Ok(())
}

fn parse_block(
    file: &mut File,
    block: ElementHeader,
    simple_block: bool,
) -> Result<ParsedBlock, MediaProcessingError> {
    let mut cursor = block.data_offset;
    let (track_number, _) = read_value_vint_cursor(file, &mut cursor, block.data_end)?;
    let track_id = u32::try_from(track_number)
        .map_err(|_| demux_error("WebM block TrackNumber exceeds u32"))?;
    if track_id == 0 {
        return Err(demux_error("WebM block TrackNumber must be positive"));
    }

    let mut timecode = [0_u8; 2];
    read_exact_cursor(file, &mut cursor, block.data_end, &mut timecode)?;
    let relative_timecode = i16::from_be_bytes(timecode);
    let flags = read_u8_cursor(file, &mut cursor, block.data_end)?;
    let keyframe = simple_block && (flags & 0x80) != 0;
    let lacing = flags & 0x06;
    let frames = parse_laced_frames(file, &mut cursor, block.data_end, lacing)?;

    Ok(ParsedBlock {
        track_id,
        relative_timecode,
        keyframe,
        frames,
    })
}

fn parse_laced_frames(
    file: &mut File,
    cursor: &mut u64,
    end: u64,
    lacing: u8,
) -> Result<Vec<BlockFrame>, MediaProcessingError> {
    if *cursor >= end {
        return Err(demux_error("WebM block has no frame payload"));
    }

    if lacing == 0 {
        return Ok(vec![BlockFrame {
            offset: *cursor,
            size: end - *cursor,
        }]);
    }

    let lace_count_minus_one = read_u8_cursor(file, cursor, end)?;
    let frame_count = usize::from(lace_count_minus_one) + 1;
    let mut sizes = Vec::<u64>::with_capacity(frame_count);

    match lacing {
        0x02 => {
            for _ in 0..frame_count - 1 {
                let mut size = 0_u64;
                loop {
                    let value = read_u8_cursor(file, cursor, end)?;
                    size = size
                        .checked_add(u64::from(value))
                        .ok_or_else(|| demux_error("WebM Xiph lace size overflow"))?;
                    if value != 255 {
                        break;
                    }
                }
                sizes.push(size);
            }
        }
        0x04 => {
            let remaining = end.saturating_sub(*cursor);
            let frame_count_u64 = u64::try_from(frame_count)
                .map_err(|_| demux_error("WebM fixed lace count overflow"))?;
            if remaining % frame_count_u64 != 0 {
                return Err(demux_error(
                    "WebM fixed-size lacing payload is not evenly divisible",
                ));
            }
            let size = remaining / frame_count_u64;
            sizes.resize(frame_count, size);
        }
        0x06 => {
            let (first, _) = read_value_vint_cursor(file, cursor, end)?;
            sizes.push(first);
            for _ in 1..frame_count - 1 {
                let (encoded, length) = read_value_vint_cursor(file, cursor, end)?;
                let bits = 7_usize
                    .checked_mul(length)
                    .ok_or_else(|| demux_error("WebM EBML lace bit count overflow"))?;
                let bias = (1_i64 << (bits - 1)) - 1;
                let delta = i64::try_from(encoded)
                    .map_err(|_| demux_error("WebM EBML lace delta exceeds i64"))?
                    - bias;
                let previous = i64::try_from(*sizes.last().expect("first lace size"))
                    .map_err(|_| demux_error("WebM EBML lace size exceeds i64"))?;
                let next = previous
                    .checked_add(delta)
                    .filter(|value| *value >= 0)
                    .ok_or_else(|| demux_error("WebM EBML lace produced a negative size"))?;
                sizes.push(
                    u64::try_from(next)
                        .map_err(|_| demux_error("WebM EBML lace size conversion failed"))?,
                );
            }
        }
        _ => return Err(demux_error("unsupported WebM lacing mode")),
    }

    if lacing != 0x04 {
        let remaining = end.saturating_sub(*cursor);
        let declared = sizes.iter().try_fold(0_u64, |total, size| {
            total
                .checked_add(*size)
                .ok_or_else(|| demux_error("WebM lace size total overflow"))
        })?;
        if declared >= remaining {
            return Err(demux_error(
                "WebM lace sizes leave no payload for the final frame",
            ));
        }
        sizes.push(remaining - declared);
    }

    let mut frames = Vec::with_capacity(frame_count);
    for size in sizes {
        if size == 0 || size > MAX_PACKET_BYTES {
            return Err(demux_error(format!(
                "WebM laced frame size {size} is outside the supported range"
            )));
        }
        let frame_end = cursor
            .checked_add(size)
            .ok_or_else(|| demux_error("WebM laced frame offset overflow"))?;
        if frame_end > end {
            return Err(demux_error("WebM laced frame extends past block payload"));
        }
        frames.push(BlockFrame {
            offset: *cursor,
            size,
        });
        *cursor = frame_end;
    }

    if *cursor != end {
        return Err(demux_error("WebM lacing did not consume the block payload"));
    }
    Ok(frames)
}

fn finalize_packet_timing(
    raw_packets: &[RawPacketLocator],
    tracks: &BTreeMap<u32, TrackMeta>,
    timecode_scale_ns: u64,
) -> Result<Vec<PacketLocator>, MediaProcessingError> {
    let mut blocks_by_track = BTreeMap::<u32, Vec<(u64, i64)>>::new();
    for packet in raw_packets {
        let blocks = blocks_by_track.entry(packet.track_id).or_default();
        if blocks
            .last()
            .map(|(block_id, _)| *block_id != packet.block_id)
            .unwrap_or(true)
        {
            blocks.push((packet.block_id, packet.block_timecode_units));
        }
    }

    let mut next_block_time = BTreeMap::<(u32, u64), i64>::new();
    let mut previous_block_time = BTreeMap::<(u32, u64), i64>::new();
    for (track_id, blocks) in &blocks_by_track {
        for pair in blocks.windows(2) {
            next_block_time.insert((*track_id, pair[0].0), pair[1].1);
            previous_block_time.insert((*track_id, pair[1].0), pair[0].1);
        }
    }

    raw_packets
        .iter()
        .map(|packet| {
            let track = tracks
                .get(&packet.track_id)
                .ok_or_else(|| demux_error("WebM packet references missing track metadata"))?;
            let lace_count = u64::from(packet.lace_count);
            let total_duration_ns = if let Some(duration_units) = packet.block_duration_units {
                Some(scale_unsigned_units(duration_units, timecode_scale_ns)?)
            } else if let Some(default_duration) = track.default_duration_ns {
                Some(
                    default_duration
                        .checked_mul(lace_count)
                        .ok_or_else(|| demux_error("WebM default duration overflow"))?,
                )
            } else {
                let inferred_units = next_block_time
                    .get(&(packet.track_id, packet.block_id))
                    .copied()
                    .filter(|next| *next > packet.block_timecode_units)
                    .map(|next| next - packet.block_timecode_units)
                    .or_else(|| {
                        previous_block_time
                            .get(&(packet.track_id, packet.block_id))
                            .copied()
                            .filter(|previous| *previous < packet.block_timecode_units)
                            .map(|previous| packet.block_timecode_units - previous)
                    });
                inferred_units
                    .map(|duration| {
                        scale_unsigned_units(
                            u64::try_from(duration)
                                .map_err(|_| demux_error("WebM block duration conversion failed"))?,
                            timecode_scale_ns,
                        )
                    })
                    .transpose()?
            };

            let frame_duration_ns = total_duration_ns
                .map(|duration| duration / lace_count)
                .filter(|duration| *duration > 0);
            let block_pts_ns =
                scale_signed_units(packet.block_timecode_units, timecode_scale_ns)?;
            let lace_offset_ns = frame_duration_ns
                .unwrap_or(0)
                .checked_mul(u64::from(packet.lace_index))
                .ok_or_else(|| demux_error("WebM lace timestamp overflow"))?;
            let pts_ns = block_pts_ns
                .checked_add(
                    i64::try_from(lace_offset_ns)
                        .map_err(|_| demux_error("WebM lace timestamp exceeds i64"))?,
                )
                .ok_or_else(|| demux_error("WebM packet timestamp overflow"))?;
            let duration_ns = frame_duration_ns
                .map(|duration| {
                    i64::try_from(duration)
                        .map_err(|_| demux_error("WebM packet duration exceeds i64"))
                })
                .transpose()?;

            Ok(PacketLocator {
                track_id: packet.track_id,
                offset: packet.offset,
                size: packet.size,
                pts_ns,
                duration_ns,
                discard_padding_ns: packet.discard_padding_ns,
                keyframe: packet.keyframe,
            })
        })
        .collect()
}

/// Convert WebM codec initialization metadata into the canonical payload
/// expected by NOVA's ISO-BMFF/MP4 muxer.
///
/// The conversion is lossless for Opus identification headers. VP8 uses its
/// defined profile-0 defaults. VP9 consumes the WebM CodecPrivate feature list.
/// When this function is used without a WebM demuxer, VP colour fields use the
/// ISO binding defaults; `open_for_mp4_remux` additionally preserves WebM
/// `Colour` metadata.
pub fn prepare_webm_track_for_mp4(
    track: &MediaTrack,
) -> Result<MediaTrack, MediaProcessingError> {
    prepare_webm_track_for_mp4_with_colour(track, None)
}

fn prepare_webm_track_for_mp4_with_colour(
    track: &MediaTrack,
    colour: Option<WebmVideoColour>,
) -> Result<MediaTrack, MediaProcessingError> {
    let mut converted = track.clone();
    converted.codec_private = match &track.codec {
        MediaCodec::Vp8 => make_vpcc(
            0,
            0,
            8,
            1,
            vp_colour_configuration(colour, 8, 1)?,
        )?,
        MediaCodec::Vp9 => vp9_webm_private_to_vpcc(&track.codec_private, colour)?,
        MediaCodec::Av1 => validate_webm_av1c(&track.codec_private)?.to_vec(),
        MediaCodec::Opus => {
            if let Some(audio) = converted.audio.as_mut() {
                audio.sample_rate_hz = 48_000;
            }
            converted.time_base = MediaTimeBase {
                numerator: 1,
                denominator: 48_000,
            };
            opus_head_to_dops(&track.codec_private, converted.audio.as_ref())?
        }
        MediaCodec::Mp3 => Vec::new(),
        _ => {
            return Err(MediaProcessingError::UnsupportedCodec(format!(
                "{:?} WebM-to-MP4 remux",
                track.codec
            )))
        }
    };
    Ok(converted)
}

fn validate_webm_av1c(data: &[u8]) -> Result<&[u8], MediaProcessingError> {
    if data.len() < 4 {
        return Err(demux_error(
            "WebM AV1 CodecPrivate is shorter than AV1CodecConfigurationRecord",
        ));
    }
    if data[0] != 0x81 {
        return Err(demux_error(
            "WebM AV1 CodecPrivate must use marker=1 and version=1",
        ));
    }
    let seq_profile = data[1] >> 5;
    if seq_profile > 2 {
        return Err(demux_error("WebM AV1 CodecPrivate has invalid sequence profile"));
    }
    if data[3] & 0xe0 != 0 {
        return Err(demux_error(
            "WebM AV1 CodecPrivate has non-zero reserved configuration bits",
        ));
    }
    let initial_delay_present = data[3] & 0x10 != 0;
    if !initial_delay_present && data[3] & 0x0f != 0 {
        return Err(demux_error(
            "WebM AV1 CodecPrivate has non-zero reserved presentation-delay bits",
        ));
    }
    Ok(data)
}

fn vp9_webm_private_to_vpcc(
    data: &[u8],
    colour: Option<WebmVideoColour>,
) -> Result<Vec<u8>, MediaProcessingError> {
    if data.is_empty() {
        return Err(MediaProcessingError::UnsupportedOperation(
            "VP9 WebM remux requires CodecPrivate profile metadata".to_owned(),
        ));
    }

    let mut profile = None;
    let mut level = None;
    let mut bit_depth = None;
    let mut chroma_subsampling = None;
    let mut cursor = 0_usize;

    while cursor < data.len() {
        if data.len() - cursor < 2 {
            return Err(demux_error("truncated VP9 WebM CodecPrivate feature header"));
        }
        let raw_id = data[cursor];
        let length = usize::from(data[cursor + 1]);
        cursor += 2;
        if raw_id & 0x80 != 0 {
            return Err(demux_error(
                "extended VP9 WebM CodecPrivate feature ids are not supported",
            ));
        }
        let end = cursor
            .checked_add(length)
            .filter(|end| *end <= data.len())
            .ok_or_else(|| demux_error("truncated VP9 WebM CodecPrivate feature"))?;
        let id = raw_id & 0x7f;
        if matches!(id, 1..=4) && length != 1 {
            return Err(demux_error(
                "VP9 WebM profile/level/bit-depth/chroma features must be one byte",
            ));
        }
        if length == 1 {
            let value = data[cursor];
            match id {
                1 => set_unique_feature(&mut profile, value, "profile")?,
                2 => set_unique_feature(&mut level, value, "level")?,
                3 => set_unique_feature(&mut bit_depth, value, "bit depth")?,
                4 => set_unique_feature(&mut chroma_subsampling, value, "chroma subsampling")?,
                _ => {}
            }
        }
        cursor = end;
    }

    let profile = profile.ok_or_else(|| {
        MediaProcessingError::UnsupportedOperation(
            "VP9 WebM remux requires CodecPrivate profile".to_owned(),
        )
    })?;
    let bit_depth = bit_depth.ok_or_else(|| {
        MediaProcessingError::UnsupportedOperation(
            "VP9 WebM remux requires CodecPrivate bit depth".to_owned(),
        )
    })?;
    let chroma = chroma_subsampling.ok_or_else(|| {
        MediaProcessingError::UnsupportedOperation(
            "VP9 WebM remux requires CodecPrivate chroma subsampling".to_owned(),
        )
    })?;
    let profile_matches = match profile {
        0 => bit_depth == 8 && matches!(chroma, 0 | 1),
        1 => bit_depth == 8 && matches!(chroma, 2 | 3),
        2 => matches!(bit_depth, 10 | 12) && matches!(chroma, 0 | 1),
        3 => matches!(bit_depth, 10 | 12) && matches!(chroma, 2 | 3),
        _ => false,
    };
    if !profile_matches {
        return Err(MediaProcessingError::UnsupportedOperation(format!(
            "VP9 profile {profile} is incompatible with bit depth {bit_depth} and chroma {chroma}"
        )));
    }

    let colour = vp_colour_configuration(colour, bit_depth, chroma)?;
    make_vpcc(profile, level.unwrap_or(0), bit_depth, chroma, colour)
}

fn set_unique_feature(
    slot: &mut Option<u8>,
    value: u8,
    name: &str,
) -> Result<(), MediaProcessingError> {
    if slot.replace(value).is_some() {
        return Err(demux_error(format!(
            "duplicate VP9 WebM CodecPrivate {name} feature"
        )));
    }
    Ok(())
}

fn vp_colour_configuration(
    colour: Option<WebmVideoColour>,
    bit_depth: u8,
    chroma_subsampling: u8,
) -> Result<VpColourConfiguration, MediaProcessingError> {
    let Some(colour) = colour else {
        return Ok(VpColourConfiguration::default());
    };

    if colour.bits_per_channel != 0 && colour.bits_per_channel != bit_depth {
        return Err(MediaProcessingError::UnsupportedOperation(format!(
            "WebM Colour BitsPerChannel {} conflicts with VP bit depth {bit_depth}",
            colour.bits_per_channel
        )));
    }
    if colour.matrix_coefficients == 0 && chroma_subsampling != 3 {
        return Err(MediaProcessingError::UnsupportedOperation(
            "RGB/identity matrix VP content requires 4:4:4 chroma in vpcC".to_owned(),
        ));
    }

    let full_range = match colour.range {
        0 | 1 => false,
        2 => true,
        3 => {
            return Err(MediaProcessingError::UnsupportedOperation(
                "WebM Colour Range=3 cannot be represented by the binary vpcC full-range flag"
                    .to_owned(),
            ))
        }
        _ => return Err(demux_error("invalid WebM Colour Range")),
    };

    Ok(VpColourConfiguration {
        colour_primaries: colour.primaries,
        transfer_characteristics: colour.transfer_characteristics,
        matrix_coefficients: colour.matrix_coefficients,
        full_range,
    })
}

fn make_vpcc(
    profile: u8,
    level: u8,
    bit_depth: u8,
    chroma_subsampling: u8,
    colour: VpColourConfiguration,
) -> Result<Vec<u8>, MediaProcessingError> {
    if profile > 3
        || !matches!(bit_depth, 8 | 10 | 12)
        || chroma_subsampling > 3
        || !matches!(level, 0 | 10 | 11 | 20 | 21 | 30 | 31 | 40 | 41 | 50 | 51 | 52 | 60 | 61 | 62)
    {
        return Err(demux_error("invalid VP codec configuration for MP4"));
    }

    // vpcC is a FullBox(version=1, flags=0), followed by the
    // VPCodecConfigurationRecord. WebM Colour fields are preserved when
    // present; otherwise the VP ISO binding defaults are used.
    Ok(vec![
        1,
        0,
        0,
        0,
        profile,
        level,
        (bit_depth << 4) | (chroma_subsampling << 1) | u8::from(colour.full_range),
        colour.colour_primaries,
        colour.transfer_characteristics,
        colour.matrix_coefficients,
        0,
        0,
    ])
}

fn opus_head_to_dops(
    data: &[u8],
    audio: Option<&AudioParameters>,
) -> Result<Vec<u8>, MediaProcessingError> {
    if data.len() < 19 || &data[..8] != b"OpusHead" {
        return Err(demux_error(
            "WebM Opus CodecPrivate must contain an OpusHead identification header",
        ));
    }
    if data[8] > 15 {
        return Err(MediaProcessingError::UnsupportedOperation(format!(
            "unsupported OpusHead major version {}",
            data[8]
        )));
    }

    let channels = data[9];
    if channels == 0 {
        return Err(demux_error("OpusHead output channel count must be positive"));
    }
    if let Some(audio) = audio {
        if audio.channels != u16::from(channels) {
            return Err(demux_error(
                "WebM Channels does not match OpusHead output channel count",
            ));
        }
    }

    let pre_skip = u16::from_le_bytes([data[10], data[11]]);
    let input_sample_rate = u32::from_le_bytes([data[12], data[13], data[14], data[15]]);
    let output_gain = i16::from_le_bytes([data[16], data[17]]);
    let mapping_family = data[18];

    let mut dops = Vec::with_capacity(data.len().saturating_sub(8));
    dops.push(0); // OpusSpecificBox version
    dops.push(channels);
    dops.extend_from_slice(&pre_skip.to_be_bytes());
    dops.extend_from_slice(&input_sample_rate.to_be_bytes());
    dops.extend_from_slice(&output_gain.to_be_bytes());
    dops.push(mapping_family);

    if mapping_family == 0 {
        if !matches!(channels, 1 | 2) {
            return Err(demux_error(
                "Opus channel mapping family 0 only supports mono or stereo",
            ));
        }
    } else {
        let mapping_len = usize::from(channels);
        let required = 21_usize
            .checked_add(mapping_len)
            .ok_or_else(|| demux_error("Opus channel mapping length overflow"))?;
        if data.len() < required {
            return Err(demux_error("truncated OpusHead channel mapping table"));
        }
        let stream_count = data[19];
        let coupled_count = data[20];
        if stream_count == 0
            || coupled_count > stream_count
            || u16::from(stream_count) + u16::from(coupled_count) != u16::from(channels)
        {
            return Err(demux_error("invalid OpusHead stream/coupled channel counts"));
        }
        dops.push(stream_count);
        dops.push(coupled_count);
        dops.extend_from_slice(&data[21..required]);
    }

    Ok(dops)
}

fn codec_from_ebml_id(value: &str) -> MediaCodec {
    match value {
        "V_VP8" => MediaCodec::Vp8,
        "V_VP9" => MediaCodec::Vp9,
        "V_AV1" => MediaCodec::Av1,
        "V_MPEG4/ISO/AVC" => MediaCodec::H264,
        "V_MPEGH/ISO/HEVC" => MediaCodec::Hevc,
        "A_OPUS" => MediaCodec::Opus,
        "A_MPEG/L3" => MediaCodec::Mp3,
        "A_FLAC" => MediaCodec::Flac,
        other if other == "A_AAC" || other.starts_with("A_AAC/") => MediaCodec::Aac,
        other => MediaCodec::Unknown(other.to_owned()),
    }
}

fn track_kind(value: u64) -> MediaTrackKind {
    match value {
        1 => MediaTrackKind::Video,
        2 => MediaTrackKind::Audio,
        17 => MediaTrackKind::Subtitle,
        _ => MediaTrackKind::Data,
    }
}

fn read_element_header(
    file: &mut File,
    offset: u64,
    parent_end: u64,
) -> Result<ElementHeader, MediaProcessingError> {
    if offset >= parent_end {
        return Err(demux_error("EBML element offset is outside its parent"));
    }

    file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
    let mut first = [0_u8; 1];
    file.read_exact(&mut first).map_err(io_error)?;
    if first[0] == 0 {
        return Err(demux_error("invalid zero-prefixed EBML element id"));
    }
    let id_len = usize::try_from(first[0].leading_zeros() + 1)
        .map_err(|_| demux_error("EBML id length conversion failed"))?;
    if id_len > 4 {
        return Err(demux_error("EBML element id exceeds four bytes"));
    }

    let mut id = u64::from(first[0]);
    for _ in 1..id_len {
        file.read_exact(&mut first).map_err(io_error)?;
        id = (id << 8) | u64::from(first[0]);
    }

    file.read_exact(&mut first).map_err(io_error)?;
    if first[0] == 0 {
        return Err(demux_error("invalid zero-prefixed EBML size"));
    }
    let size_len = usize::try_from(first[0].leading_zeros() + 1)
        .map_err(|_| demux_error("EBML size length conversion failed"))?;
    if size_len > 8 {
        return Err(demux_error("EBML size exceeds eight bytes"));
    }
    let marker = 0x80_u8 >> (size_len - 1);
    let mut size = u64::from(first[0] & (marker - 1));
    for _ in 1..size_len {
        file.read_exact(&mut first).map_err(io_error)?;
        size = (size << 8) | u64::from(first[0]);
    }
    let unknown_max = (1_u64 << (7 * size_len)) - 1;
    let unknown_size = size == unknown_max;

    let header_len = u64::try_from(id_len + size_len)
        .map_err(|_| demux_error("EBML header length conversion failed"))?;
    let data_offset = offset
        .checked_add(header_len)
        .ok_or_else(|| demux_error("EBML data offset overflow"))?;
    if data_offset > parent_end {
        return Err(demux_error("EBML element header extends past its parent"));
    }
    let data_end = if unknown_size {
        parent_end
    } else {
        data_offset
            .checked_add(size)
            .filter(|end| *end <= parent_end)
            .ok_or_else(|| demux_error("EBML element extends past its parent"))?
    };

    Ok(ElementHeader {
        id,
        data_offset,
        data_end,
        unknown_size,
    })
}

fn read_value_vint_cursor(
    file: &mut File,
    cursor: &mut u64,
    end: u64,
) -> Result<(u64, usize), MediaProcessingError> {
    let first = read_u8_cursor(file, cursor, end)?;
    if first == 0 {
        return Err(demux_error("invalid zero-prefixed EBML variable integer"));
    }
    let length = usize::try_from(first.leading_zeros() + 1)
        .map_err(|_| demux_error("EBML variable integer length conversion failed"))?;
    if length > 8 {
        return Err(demux_error("EBML variable integer exceeds eight bytes"));
    }
    let marker = 0x80_u8 >> (length - 1);
    let mut value = u64::from(first & (marker - 1));
    for _ in 1..length {
        value = (value << 8) | u64::from(read_u8_cursor(file, cursor, end)?);
    }
    let unknown_max = (1_u64 << (7 * length)) - 1;
    if value == unknown_max {
        return Err(demux_error(
            "unknown-length EBML variable integer is invalid in a block",
        ));
    }
    Ok((value, length))
}

fn read_uint(file: &mut File, header: ElementHeader) -> Result<u64, MediaProcessingError> {
    let size = header.size();
    if size == 0 || size > 8 {
        return Err(demux_error("EBML unsigned integer must contain 1..=8 bytes"));
    }
    file.seek(SeekFrom::Start(header.data_offset))
        .map_err(io_error)?;
    let mut value = 0_u64;
    for _ in 0..size {
        let mut byte = [0_u8; 1];
        file.read_exact(&mut byte).map_err(io_error)?;
        value = (value << 8) | u64::from(byte[0]);
    }
    Ok(value)
}

fn read_signed_int(file: &mut File, header: ElementHeader) -> Result<i64, MediaProcessingError> {
    let size = header.size();
    if size == 0 || size > 8 {
        return Err(demux_error("EBML signed integer must contain 1..=8 bytes"));
    }
    file.seek(SeekFrom::Start(header.data_offset))
        .map_err(io_error)?;
    let mut bytes = [0_u8; 8];
    let start = 8_usize
        .checked_sub(usize::try_from(size).map_err(|_| demux_error("signed integer size overflow"))?)
        .ok_or_else(|| demux_error("signed integer size underflow"))?;
    file.read_exact(&mut bytes[start..]).map_err(io_error)?;
    if bytes[start] & 0x80 != 0 {
        bytes[..start].fill(0xff);
    }
    Ok(i64::from_be_bytes(bytes))
}

fn read_float(file: &mut File, header: ElementHeader) -> Result<f64, MediaProcessingError> {
    file.seek(SeekFrom::Start(header.data_offset))
        .map_err(io_error)?;
    match header.size() {
        4 => {
            let mut bytes = [0_u8; 4];
            file.read_exact(&mut bytes).map_err(io_error)?;
            Ok(f64::from(f32::from_be_bytes(bytes)))
        }
        8 => {
            let mut bytes = [0_u8; 8];
            file.read_exact(&mut bytes).map_err(io_error)?;
            Ok(f64::from_be_bytes(bytes))
        }
        _ => Err(demux_error("EBML float must contain 4 or 8 bytes")),
    }
}

fn read_text(
    file: &mut File,
    header: ElementHeader,
    name: &str,
) -> Result<String, MediaProcessingError> {
    if header.size() > MAX_TEXT_BYTES {
        return Err(demux_error(format!(
            "WebM {name} exceeds text safety limit {MAX_TEXT_BYTES}"
        )));
    }
    let bytes = read_bytes(file, header)?;
    String::from_utf8(bytes).map_err(|_| demux_error(format!("WebM {name} is not valid UTF-8")))
}

fn read_bytes(
    file: &mut File,
    header: ElementHeader,
) -> Result<Vec<u8>, MediaProcessingError> {
    let size = usize::try_from(header.size())
        .map_err(|_| demux_error("EBML element size does not fit platform"))?;
    let mut bytes = vec![0_u8; size];
    file.seek(SeekFrom::Start(header.data_offset))
        .and_then(|_| file.read_exact(&mut bytes))
        .map_err(io_error)?;
    Ok(bytes)
}

fn read_u8_cursor(
    file: &mut File,
    cursor: &mut u64,
    end: u64,
) -> Result<u8, MediaProcessingError> {
    let mut byte = [0_u8; 1];
    read_exact_cursor(file, cursor, end, &mut byte)?;
    Ok(byte[0])
}

fn read_exact_cursor(
    file: &mut File,
    cursor: &mut u64,
    end: u64,
    bytes: &mut [u8],
) -> Result<(), MediaProcessingError> {
    let len = u64::try_from(bytes.len())
        .map_err(|_| demux_error("buffer length conversion failed"))?;
    let next = cursor
        .checked_add(len)
        .filter(|next| *next <= end)
        .ok_or_else(|| demux_error("EBML read extends past element payload"))?;
    file.seek(SeekFrom::Start(*cursor))
        .and_then(|_| file.read_exact(bytes))
        .map_err(io_error)?;
    *cursor = next;
    Ok(())
}

fn rescale_nanoseconds(
    value: i64,
    target: MediaTimeBase,
) -> Result<i64, MediaProcessingError> {
    if target.numerator != 1 || target.denominator == 0 {
        return Err(demux_error("WebM packet target time base must be 1/timescale"));
    }
    if target == NANOSECOND_TIME_BASE {
        return Ok(value);
    }

    let scaled = i128::from(value)
        .checked_mul(i128::from(target.denominator))
        .ok_or_else(|| demux_error("WebM timestamp rescale overflow"))?;
    let divisor = 1_000_000_000_i128;
    let rounded = if scaled >= 0 {
        scaled
            .checked_add(divisor / 2)
            .ok_or_else(|| demux_error("WebM timestamp rounding overflow"))?
            / divisor
    } else {
        scaled
            .checked_sub(divisor / 2)
            .ok_or_else(|| demux_error("WebM timestamp rounding overflow"))?
            / divisor
    };
    i64::try_from(rounded).map_err(|_| demux_error("WebM rescaled timestamp exceeds i64"))
}

fn scale_signed_units(value: i64, scale_ns: u64) -> Result<i64, MediaProcessingError> {
    let scale = i64::try_from(scale_ns)
        .map_err(|_| demux_error("WebM TimecodeScale exceeds i64"))?;
    value
        .checked_mul(scale)
        .ok_or_else(|| demux_error("WebM timestamp overflow"))
}

fn scale_unsigned_units(value: u64, scale_ns: u64) -> Result<u64, MediaProcessingError> {
    value
        .checked_mul(scale_ns)
        .ok_or_else(|| demux_error("WebM duration overflow"))
}

fn bump_element_count(count: &mut usize) -> Result<(), MediaProcessingError> {
    *count = count
        .checked_add(1)
        .ok_or_else(|| demux_error("WebM element counter overflow"))?;
    if *count > MAX_ELEMENTS {
        return Err(demux_error(format!(
            "WebM exceeds element safety limit {MAX_ELEMENTS}"
        )));
    }
    Ok(())
}

fn demux_error(message: impl Into<String>) -> MediaProcessingError {
    MediaProcessingError::Demux(message.into())
}

fn io_error(error: std::io::Error) -> MediaProcessingError {
    MediaProcessingError::Io(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn encode_size(value: usize) -> Vec<u8> {
        let value = u64::try_from(value).expect("fixture size");
        for length in 1..=8_usize {
            let max = (1_u64 << (7 * length)) - 1;
            if value < max {
                let mut bytes = vec![0_u8; length];
                let mut remaining = value;
                for byte in bytes.iter_mut().rev() {
                    *byte = (remaining & 0xff) as u8;
                    remaining >>= 8;
                }
                bytes[0] |= 0x80_u8 >> (length - 1);
                return bytes;
            }
        }
        panic!("fixture is too large");
    }

    fn element(id: &[u8], payload: Vec<u8>) -> Vec<u8> {
        let mut result = id.to_vec();
        result.extend_from_slice(&encode_size(payload.len()));
        result.extend_from_slice(&payload);
        result
    }

    fn uint_element(id: &[u8], value: u64, bytes: usize) -> Vec<u8> {
        let encoded = value.to_be_bytes();
        element(id, encoded[encoded.len() - bytes..].to_vec())
    }

    fn webm_fixture(block_payload: Vec<u8>, default_duration_ns: u64) -> Vec<u8> {
        let ebml = element(&[0x1A, 0x45, 0xDF, 0xA3], element(&[0x42, 0x82], b"webm".to_vec()));
        let info = element(
            &[0x15, 0x49, 0xA9, 0x66],
            uint_element(&[0x2A, 0xD7, 0xB1], 1_000_000, 3),
        );

        let video = element(
            &[0xE0],
            [
                uint_element(&[0xB0], 640, 2),
                uint_element(&[0xBA], 360, 2),
            ]
            .concat(),
        );
        let track_entry = element(
            &[0xAE],
            [
                uint_element(&[0xD7], 1, 1),
                uint_element(&[0x83], 1, 1),
                element(&[0x86], b"V_VP9".to_vec()),
                element(&[0x63, 0xA2], vec![1, 2, 3, 4]),
                uint_element(&[0x23, 0xE3, 0x83], default_duration_ns, 4),
                video,
            ]
            .concat(),
        );
        let tracks = element(&[0x16, 0x54, 0xAE, 0x6B], track_entry);
        let cluster = element(
            &[0x1F, 0x43, 0xB6, 0x75],
            [
                uint_element(&[0xE7], 0, 1),
                element(&[0xA3], block_payload),
            ]
            .concat(),
        );
        let segment = element(
            &[0x18, 0x53, 0x80, 0x67],
            [info, tracks, cluster].concat(),
        );
        [ebml, segment].concat()
    }

    fn temp_path() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("nova-native-webm-{unique}.webm"))
    }

    #[test]
    fn demuxes_vp9_simple_block_without_loading_whole_file() {
        let mut block = vec![0x81, 0x00, 0x00, 0x80];
        block.extend_from_slice(b"FRAME");
        let bytes = webm_fixture(block, 33_333_333);
        let path = temp_path();
        fs::write(&path, bytes).expect("fixture");

        let mut demuxer = WebmDemuxer::open(&path).expect("webm demuxer");
        assert_eq!(demuxer.probe().container, MediaContainer::WebM);
        assert_eq!(demuxer.probe().tracks.len(), 1);
        assert_eq!(demuxer.probe().tracks[0].codec, MediaCodec::Vp9);
        assert_eq!(demuxer.probe().tracks[0].video.as_ref().expect("video").width, 640);
        assert_eq!(demuxer.packet_count(), 1);

        let packet = demuxer.next_packet().expect("packet").expect("frame");
        assert_eq!(packet.track_id, 1);
        assert_eq!(packet.data, b"FRAME");
        assert_eq!(packet.pts.expect("pts").value, 0);
        assert_eq!(packet.duration.expect("duration").value, 33_333_333);
        assert!(packet.flags.keyframe);
        assert!(demuxer.next_packet().expect("end").is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn fixed_lacing_splits_frames_and_advances_timestamps() {
        let mut block = vec![0x81, 0x00, 0x00, 0x84, 0x01];
        block.extend_from_slice(b"AABB");
        let bytes = webm_fixture(block, 10_000_000);
        let path = temp_path();
        fs::write(&path, bytes).expect("fixture");

        let mut demuxer = WebmDemuxer::open(&path).expect("webm demuxer");
        assert_eq!(demuxer.packet_count(), 2);

        let first = demuxer.next_packet().expect("first").expect("frame");
        let second = demuxer.next_packet().expect("second").expect("frame");
        assert_eq!(first.data, b"AA");
        assert_eq!(second.data, b"BB");
        assert_eq!(first.pts.expect("first pts").value, 0);
        assert_eq!(second.pts.expect("second pts").value, 10_000_000);
        assert_eq!(first.duration.expect("first duration").value, 10_000_000);
        assert_eq!(second.duration.expect("second duration").value, 10_000_000);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn converts_webm_vp9_codec_features_to_vpcc() {
        let track = MediaTrack {
            id: 1,
            kind: MediaTrackKind::Video,
            codec: MediaCodec::Vp9,
            time_base: NANOSECOND_TIME_BASE,
            language: None,
            video: Some(VideoParameters {
                width: 1920,
                height: 1080,
                frame_rate: Some(30.0),
                bitrate_bps: None,
            }),
            audio: None,
            codec_private: vec![
                1, 1, 0, // profile 0
                2, 1, 41, // level 4.1
                3, 1, 8, // 8-bit
                4, 1, 1, // 4:2:0 colocated
            ],
        };
        let converted = prepare_webm_track_for_mp4(&track).expect("VP9 bridge");
        assert_eq!(
            converted.codec_private,
            vec![1, 0, 0, 0, 0, 41, 0x82, 1, 1, 1, 0, 0]
        );
    }

    #[test]
    fn bridges_vp9_profile_1_444_with_iso_colour_defaults() {
        let track = MediaTrack {
            id: 1,
            kind: MediaTrackKind::Video,
            codec: MediaCodec::Vp9,
            time_base: NANOSECOND_TIME_BASE,
            language: None,
            video: Some(VideoParameters {
                width: 1920,
                height: 1080,
                frame_rate: Some(30.0),
                bitrate_bps: None,
            }),
            audio: None,
            codec_private: vec![
                1, 1, 1, // profile 1
                2, 1, 31, // level 3.1
                3, 1, 8, // 8-bit
                4, 1, 3, // 4:4:4
            ],
        };
        let converted = prepare_webm_track_for_mp4(&track).expect("VP9 profile 1 bridge");
        assert_eq!(
            converted.codec_private,
            vec![1, 0, 0, 0, 1, 31, 0x86, 1, 1, 1, 0, 0]
        );
    }

    #[test]
    fn preserves_webm_hdr_colour_for_vp9_profile_2_vpcc() {
        let ebml = element(
            &[0x1A, 0x45, 0xDF, 0xA3],
            element(&[0x42, 0x82], b"webm".to_vec()),
        );
        let info = element(
            &[0x15, 0x49, 0xA9, 0x66],
            uint_element(&[0x2A, 0xD7, 0xB1], 1_000_000, 3),
        );
        let colour = element(
            &[0x55, 0xB0],
            [
                uint_element(&[0x55, 0xB1], 9, 1),  // BT.2020 NCL matrix
                uint_element(&[0x55, 0xB2], 10, 1), // 10-bit
                uint_element(&[0x55, 0xB9], 2, 1),  // full range
                uint_element(&[0x55, 0xBA], 16, 1), // PQ
                uint_element(&[0x55, 0xBB], 9, 1),  // BT.2020 primaries
            ]
            .concat(),
        );
        let video = element(
            &[0xE0],
            [
                uint_element(&[0xB0], 1920, 2),
                uint_element(&[0xBA], 1080, 2),
                colour,
            ]
            .concat(),
        );
        let track = element(
            &[0xAE],
            [
                uint_element(&[0xD7], 1, 1),
                uint_element(&[0x83], 1, 1),
                element(&[0x86], b"V_VP9".to_vec()),
                element(
                    &[0x63, 0xA2],
                    vec![
                        1, 1, 2, // profile 2
                        2, 1, 41, // level 4.1
                        3, 1, 10, // 10-bit
                        4, 1, 1, // 4:2:0 colocated
                    ],
                ),
                uint_element(&[0x23, 0xE3, 0x83], 33_333_333, 4),
                video,
            ]
            .concat(),
        );
        let tracks = element(&[0x16, 0x54, 0xAE, 0x6B], track);
        let mut block = vec![0x81, 0x00, 0x00, 0x80];
        block.extend_from_slice(b"HDR");
        let cluster = element(
            &[0x1F, 0x43, 0xB6, 0x75],
            [
                uint_element(&[0xE7], 0, 1),
                element(&[0xA3], block),
            ]
            .concat(),
        );
        let segment = element(
            &[0x18, 0x53, 0x80, 0x67],
            [info, tracks, cluster].concat(),
        );
        let path = temp_path();
        fs::write(&path, [ebml, segment].concat()).expect("fixture");

        let demuxer = WebmDemuxer::open_for_mp4_remux(&path).expect("profile 2 remux");
        assert_eq!(
            demuxer.probe().tracks[0].codec_private,
            vec![1, 0, 0, 0, 2, 41, 0xA3, 9, 16, 9, 0, 0]
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_vp9_colour_bit_depth_conflict() {
        let data = vec![
            1, 1, 2, // profile 2
            2, 1, 41,
            3, 1, 10,
            4, 1, 1,
        ];
        let colour = WebmVideoColour {
            bits_per_channel: 12,
            ..WebmVideoColour::default()
        };
        let error = vp9_webm_private_to_vpcc(&data, Some(colour))
            .expect_err("conflicting colour metadata");
        assert!(matches!(
            error,
            MediaProcessingError::UnsupportedOperation(_)
        ));
    }

    #[test]
    fn preserves_valid_webm_av1_configuration_for_av1c() {
        let av1c = vec![0x81, 0x08, 0x0c, 0x00];
        let track = MediaTrack {
            id: 3,
            kind: MediaTrackKind::Video,
            codec: MediaCodec::Av1,
            time_base: NANOSECOND_TIME_BASE,
            language: None,
            video: Some(VideoParameters {
                width: 1920,
                height: 1080,
                frame_rate: Some(30.0),
                bitrate_bps: None,
            }),
            audio: None,
            codec_private: av1c.clone(),
        };
        let converted = prepare_webm_track_for_mp4(&track).expect("AV1 bridge");
        assert_eq!(converted.codec_private, av1c);
    }

    #[test]
    fn converts_opus_head_to_big_endian_dops() {
        let mut opus_head = b"OpusHead".to_vec();
        opus_head.push(1);
        opus_head.push(2);
        opus_head.extend_from_slice(&312_u16.to_le_bytes());
        opus_head.extend_from_slice(&48_000_u32.to_le_bytes());
        opus_head.extend_from_slice(&(-256_i16).to_le_bytes());
        opus_head.push(0);

        let track = MediaTrack {
            id: 2,
            kind: MediaTrackKind::Audio,
            codec: MediaCodec::Opus,
            time_base: NANOSECOND_TIME_BASE,
            language: None,
            video: None,
            audio: Some(AudioParameters {
                sample_rate_hz: 48_000,
                channels: 2,
                bitrate_bps: None,
            }),
            codec_private: opus_head,
        };
        let converted = prepare_webm_track_for_mp4(&track).expect("Opus bridge");
        assert_eq!(
            converted.codec_private,
            vec![0, 2, 0x01, 0x38, 0x00, 0x00, 0xbb, 0x80, 0xff, 0x00, 0]
        );
        assert_eq!(
            converted.audio.expect("audio").sample_rate_hz,
            48_000
        );
        assert_eq!(converted.time_base.denominator, 48_000);
    }

    #[test]
    fn final_opus_discard_padding_shortens_mp4_remux_sample_duration() {
        let ebml = element(
            &[0x1A, 0x45, 0xDF, 0xA3],
            element(&[0x42, 0x82], b"webm".to_vec()),
        );
        let info = element(
            &[0x15, 0x49, 0xA9, 0x66],
            uint_element(&[0x2A, 0xD7, 0xB1], 1_000_000, 3),
        );
        let audio = element(
            &[0xE1],
            [
                element(&[0xB5], 48_000_f64.to_be_bytes().to_vec()),
                uint_element(&[0x9F], 2, 1),
            ]
            .concat(),
        );
        let mut opus_head = b"OpusHead".to_vec();
        opus_head.push(1);
        opus_head.push(2);
        opus_head.extend_from_slice(&312_u16.to_le_bytes());
        opus_head.extend_from_slice(&48_000_u32.to_le_bytes());
        opus_head.extend_from_slice(&0_i16.to_le_bytes());
        opus_head.push(0);
        let track = element(
            &[0xAE],
            [
                uint_element(&[0xD7], 1, 1),
                uint_element(&[0x83], 2, 1),
                element(&[0x86], b"A_OPUS".to_vec()),
                element(&[0x63, 0xA2], opus_head),
                uint_element(&[0x23, 0xE3, 0x83], 20_000_000, 4),
                audio,
            ]
            .concat(),
        );
        let tracks = element(&[0x16, 0x54, 0xAE, 0x6B], track);
        let mut block_payload = vec![0x81, 0x00, 0x00, 0x00];
        block_payload.extend_from_slice(b"OPUS");
        let block_group = element(
            &[0xA0],
            [
                element(&[0xA1], block_payload),
                uint_element(&[0x9B], 20, 1),
                element(&[0x75, 0xA2], 5_000_000_i64.to_be_bytes().to_vec()),
            ]
            .concat(),
        );
        let cluster = element(
            &[0x1F, 0x43, 0xB6, 0x75],
            [uint_element(&[0xE7], 0, 1), block_group].concat(),
        );
        let segment = element(
            &[0x18, 0x53, 0x80, 0x67],
            [info, tracks, cluster].concat(),
        );
        let path = temp_path();
        fs::write(&path, [ebml, segment].concat()).expect("fixture");

        let mut demuxer = WebmDemuxer::open_for_mp4_remux(&path).expect("remux demuxer");
        let packet = demuxer.next_packet().expect("packet").expect("frame");
        assert_eq!(packet.duration.expect("duration").value, 720); // 15 ms at 48 kHz

        let _ = fs::remove_file(path);
    }

    #[test]
    fn demuxes_matroska_h264_simple_block() {
        let ebml = element(
            &[0x1A, 0x45, 0xDF, 0xA3],
            element(&[0x42, 0x82], b"matroska".to_vec()),
        );
        let info = element(
            &[0x15, 0x49, 0xA9, 0x66],
            uint_element(&[0x2A, 0xD7, 0xB1], 1_000_000, 3),
        );
        let video = element(
            &[0xE0],
            [
                uint_element(&[0xB0], 1280, 2),
                uint_element(&[0xBA], 720, 2),
            ]
            .concat(),
        );
        let avcc = vec![1, 100, 0, 31, 0xff, 0xe1, 0, 0];
        let track = element(
            &[0xAE],
            [
                uint_element(&[0xD7], 1, 1),
                uint_element(&[0x83], 1, 1),
                element(&[0x86], b"V_MPEG4/ISO/AVC".to_vec()),
                element(&[0x63, 0xA2], avcc.clone()),
                uint_element(&[0x23, 0xE3, 0x83], 40_000_000, 4),
                video,
            ]
            .concat(),
        );
        let tracks = element(&[0x16, 0x54, 0xAE, 0x6B], track);
        let mut block = vec![0x81, 0x00, 0x00, 0x80];
        block.extend_from_slice(b"NALU");
        let cluster = element(
            &[0x1F, 0x43, 0xB6, 0x75],
            [
                uint_element(&[0xE7], 0, 1),
                element(&[0xA3], block),
            ]
            .concat(),
        );
        let segment = element(
            &[0x18, 0x53, 0x80, 0x67],
            [info, tracks, cluster].concat(),
        );
        let path = temp_path();
        fs::write(&path, [ebml, segment].concat()).expect("fixture");

        let mut demuxer = MatroskaDemuxer::open(&path).expect("Matroska demuxer");
        assert_eq!(demuxer.probe().container, MediaContainer::Matroska);
        assert_eq!(demuxer.probe().tracks.len(), 1);
        assert_eq!(demuxer.probe().tracks[0].codec, MediaCodec::H264);
        assert_eq!(demuxer.probe().tracks[0].codec_private, avcc);
        assert_eq!(demuxer.packet_count(), 1);

        let packet = demuxer.next_packet().expect("packet").expect("frame");
        assert_eq!(packet.data, b"NALU");
        assert_eq!(packet.duration.expect("duration").value, 40_000_000);
        assert!(packet.flags.keyframe);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn webm_demuxer_rejects_matroska_doctype() {
        let ebml = element(
            &[0x1A, 0x45, 0xDF, 0xA3],
            element(&[0x42, 0x82], b"matroska".to_vec()),
        );
        let segment = element(&[0x18, 0x53, 0x80, 0x67], Vec::new());
        let path = temp_path();
        fs::write(&path, [ebml, segment].concat()).expect("fixture");

        let error = WebmDemuxer::open(&path).expect_err("WebM must reject Matroska");
        assert!(matches!(
            error,
            MediaProcessingError::UnsupportedContainer(_)
        ));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn matroska_demuxer_rejects_webm_doctype() {
        let ebml = element(
            &[0x1A, 0x45, 0xDF, 0xA3],
            element(&[0x42, 0x82], b"webm".to_vec()),
        );
        let segment = element(&[0x18, 0x53, 0x80, 0x67], Vec::new());
        let path = temp_path();
        fs::write(&path, [ebml, segment].concat()).expect("fixture");

        let error = MatroskaDemuxer::open(&path).expect_err("Matroska must reject WebM");
        assert!(matches!(
            error,
            MediaProcessingError::UnsupportedContainer(_)
        ));

        let _ = fs::remove_file(path);
    }
}
