use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::{
    MediaCodec, MediaContainer, MediaDemuxer, MediaMuxResult, MediaMuxer, MediaPacket,
    MediaProcessingControl, MediaProcessingError, MediaTimeBase, MediaTimestamp, MediaTrack,
    MediaTrackKind,
};

const TIMESTAMP_SCALE_NS: u64 = 10_000;
const MAX_TRACKS: usize = 64;
const MAX_PACKETS_PER_TRACK: u64 = 10_000_000;
const MAX_PACKET_BYTES: usize = 256 * 1024 * 1024;
const MAX_CODEC_PRIVATE_BYTES: usize = 1024 * 1024;
const MAX_CUES: usize = 1_000_000;

const ID_EBML: &[u8] = &[0x1A, 0x45, 0xDF, 0xA3];
const ID_EBML_VERSION: &[u8] = &[0x42, 0x86];
const ID_EBML_READ_VERSION: &[u8] = &[0x42, 0xF7];
const ID_EBML_MAX_ID_LENGTH: &[u8] = &[0x42, 0xF2];
const ID_EBML_MAX_SIZE_LENGTH: &[u8] = &[0x42, 0xF3];
const ID_DOC_TYPE: &[u8] = &[0x42, 0x82];
const ID_DOC_TYPE_VERSION: &[u8] = &[0x42, 0x87];
const ID_DOC_TYPE_READ_VERSION: &[u8] = &[0x42, 0x85];

const ID_SEGMENT: &[u8] = &[0x18, 0x53, 0x80, 0x67];
const ID_INFO: &[u8] = &[0x15, 0x49, 0xA9, 0x66];
const ID_TIMESTAMP_SCALE: &[u8] = &[0x2A, 0xD7, 0xB1];
const ID_DURATION: &[u8] = &[0x44, 0x89];
const ID_MUXING_APP: &[u8] = &[0x4D, 0x80];
const ID_WRITING_APP: &[u8] = &[0x57, 0x41];

const ID_TRACKS: &[u8] = &[0x16, 0x54, 0xAE, 0x6B];
const ID_TRACK_ENTRY: &[u8] = &[0xAE];
const ID_TRACK_NUMBER: &[u8] = &[0xD7];
const ID_TRACK_UID: &[u8] = &[0x73, 0xC5];
const ID_TRACK_TYPE: &[u8] = &[0x83];
const ID_CODEC_ID: &[u8] = &[0x86];
const ID_CODEC_PRIVATE: &[u8] = &[0x63, 0xA2];
const ID_LANGUAGE: &[u8] = &[0x22, 0xB5, 0x9C];
const ID_CODEC_DELAY: &[u8] = &[0x56, 0xAA];
const ID_SEEK_PREROLL: &[u8] = &[0x56, 0xBB];
const ID_VIDEO: &[u8] = &[0xE0];
const ID_PIXEL_WIDTH: &[u8] = &[0xB0];
const ID_PIXEL_HEIGHT: &[u8] = &[0xBA];
const ID_COLOUR: &[u8] = &[0x55, 0xB0];
const ID_MATRIX_COEFFICIENTS: &[u8] = &[0x55, 0xB1];
const ID_BITS_PER_CHANNEL: &[u8] = &[0x55, 0xB2];
const ID_COLOUR_RANGE: &[u8] = &[0x55, 0xB9];
const ID_TRANSFER_CHARACTERISTICS: &[u8] = &[0x55, 0xBA];
const ID_PRIMARIES: &[u8] = &[0x55, 0xBB];
const ID_AUDIO: &[u8] = &[0xE1];
const ID_SAMPLING_FREQUENCY: &[u8] = &[0xB5];
const ID_CHANNELS: &[u8] = &[0x9F];

const ID_CLUSTER: &[u8] = &[0x1F, 0x43, 0xB6, 0x75];
const ID_CLUSTER_TIMESTAMP: &[u8] = &[0xE7];
const ID_BLOCK_GROUP: &[u8] = &[0xA0];
const ID_BLOCK: &[u8] = &[0xA1];
const ID_BLOCK_DURATION: &[u8] = &[0x9B];
const ID_REFERENCE_BLOCK: &[u8] = &[0xFB];

const ID_CUES: &[u8] = &[0x1C, 0x53, 0xBB, 0x6B];
const ID_CUE_POINT: &[u8] = &[0xBB];
const ID_CUE_TIME: &[u8] = &[0xB3];
const ID_CUE_TRACK_POSITIONS: &[u8] = &[0xB7];
const ID_CUE_TRACK: &[u8] = &[0xF7];
const ID_CUE_CLUSTER_POSITION: &[u8] = &[0xF1];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EbmlOutputKind {
    WebM,
    Matroska,
}

impl EbmlOutputKind {
    fn container(self) -> MediaContainer {
        match self {
            Self::WebM => MediaContainer::WebM,
            Self::Matroska => MediaContainer::Matroska,
        }
    }

    fn doc_type(self) -> &'static str {
        match self {
            Self::WebM => "webm",
            Self::Matroska => "matroska",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct EbmlColour {
    matrix_coefficients: u8,
    bits_per_channel: u8,
    range: u8,
    transfer_characteristics: u8,
    primaries: u8,
}

#[derive(Clone, Debug)]
struct OutputTrack {
    track: MediaTrack,
    codec_id: &'static str,
    codec_private: Vec<u8>,
    colour: Option<EbmlColour>,
    codec_delay_ns: Option<u64>,
    seek_preroll_ns: Option<u64>,
    packets_written: u64,
    previous_pts_ticks: Option<i64>,
    previous_dts_ticks: Option<i64>,
}

#[derive(Clone, Copy, Debug)]
struct CueRecord {
    time_ticks: u64,
    track_id: u32,
    cluster_position: u64,
}

#[derive(Debug)]
struct EbmlMuxer {
    kind: EbmlOutputKind,
    destination: PathBuf,
    temporary: PathBuf,
    file: Option<File>,
    tracks: BTreeMap<u32, OutputTrack>,
    next_track_id: u32,
    segment_data_offset: Option<u64>,
    duration_data_offset: Option<u64>,
    header_written: bool,
    packets_written: u64,
    max_end_ns: u64,
    last_cluster_ticks: Option<u64>,
    cues: Vec<CueRecord>,
    finalized: bool,
}

impl EbmlMuxer {
    fn create(destination: &Path, kind: EbmlOutputKind) -> Result<Self, MediaProcessingError> {
        if let Some(parent) = destination.parent().filter(|path| !path.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(io_error)?;
        }

        let suffix = match kind {
            EbmlOutputKind::WebM => ".nova-webm.tmp",
            EbmlOutputKind::Matroska => ".nova-matroska.tmp",
        };
        let temporary = append_suffix(destination, suffix);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&temporary)
            .map_err(io_error)?;

        Ok(Self {
            kind,
            destination: destination.to_path_buf(),
            temporary,
            file: Some(file),
            tracks: BTreeMap::new(),
            next_track_id: 1,
            segment_data_offset: None,
            duration_data_offset: None,
            header_written: false,
            packets_written: 0,
            max_end_ns: 0,
            last_cluster_ticks: None,
            cues: Vec::new(),
            finalized: false,
        })
    }

    fn file_mut(&mut self) -> Result<&mut File, MediaProcessingError> {
        self.file
            .as_mut()
            .ok_or_else(|| mux_error("EBML muxer output is already closed"))
    }

    fn ensure_header(&mut self) -> Result<(), MediaProcessingError> {
        if self.header_written {
            return Ok(());
        }
        if self.tracks.is_empty() {
            return Err(mux_error("EBML output requires at least one registered track"));
        }

        let ebml_header = make_ebml_header(self.kind)?;
        let (info, duration_relative_offset) = make_info()?;
        let tracks = make_tracks(&self.tracks)?;

        self.file_mut()?.write_all(&ebml_header).map_err(io_error)?;
        self.file_mut()?.write_all(ID_SEGMENT).map_err(io_error)?;
        self.file_mut()?
            .write_all(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
            .map_err(io_error)?;

        let segment_data_offset = self.file_mut()?.stream_position().map_err(io_error)?;
        let info_offset = segment_data_offset;
        self.file_mut()?.write_all(&info).map_err(io_error)?;
        self.file_mut()?.write_all(&tracks).map_err(io_error)?;

        self.segment_data_offset = Some(segment_data_offset);
        self.duration_data_offset = Some(
            info_offset
                .checked_add(
                    u64::try_from(duration_relative_offset)
                        .map_err(|_| mux_error("EBML duration offset exceeds u64"))?,
                )
                .ok_or_else(|| mux_error("EBML duration offset overflow"))?,
        );
        self.header_written = true;
        Ok(())
    }

    fn write_cluster_for_packet(
        &mut self,
        packet: &MediaPacket,
        pts_ticks: i64,
        dts_ticks: i64,
        duration_ticks: u64,
        is_keyframe: bool,
        previous_pts_ticks: Option<i64>,
    ) -> Result<u64, MediaProcessingError> {
        let cluster_ticks = u64::try_from(dts_ticks)
            .map_err(|_| mux_error("EBML cluster timestamp must not be negative"))?;
        if self
            .last_cluster_ticks
            .is_some_and(|previous| cluster_ticks < previous)
        {
            return Err(MediaProcessingError::UnsupportedOperation(
                "EBML packets must be globally interleaved in nondecreasing DTS order".to_owned(),
            ));
        }

        let relative_ticks = pts_ticks
            .checked_sub(dts_ticks)
            .ok_or_else(|| mux_error("EBML PTS/DTS offset overflow"))?;
        let relative_timecode = i16::try_from(relative_ticks).map_err(|_| {
            MediaProcessingError::UnsupportedOperation(format!(
                "EBML PTS-DTS offset {relative_ticks} exceeds signed 16-bit Block range"
            ))
        })?;

        let track_vint = encode_vint_value(u64::from(packet.track_id))?;
        let block_payload_len = track_vint
            .len()
            .checked_add(3)
            .and_then(|value| value.checked_add(packet.data.len()))
            .ok_or_else(|| mux_error("EBML block payload length overflow"))?;
        let block_size = encode_ebml_size(block_payload_len)?;
        let block_total_len = ID_BLOCK
            .len()
            .checked_add(block_size.len())
            .and_then(|value| value.checked_add(block_payload_len))
            .ok_or_else(|| mux_error("EBML block length overflow"))?;

        let duration_element = uint_element(ID_BLOCK_DURATION, duration_ticks)?;
        let reference_element = if is_keyframe {
            Vec::new()
        } else {
            let previous = previous_pts_ticks.ok_or_else(|| {
                MediaProcessingError::UnsupportedOperation(
                    "non-keyframe EBML packet has no earlier coded packet to reference".to_owned(),
                )
            })?;
            let delta = previous
                .checked_sub(pts_ticks)
                .ok_or_else(|| mux_error("EBML ReferenceBlock timestamp overflow"))?;
            signed_element(ID_REFERENCE_BLOCK, delta)?
        };

        let group_payload_len = block_total_len
            .checked_add(duration_element.len())
            .and_then(|value| value.checked_add(reference_element.len()))
            .ok_or_else(|| mux_error("EBML BlockGroup length overflow"))?;
        let group_size = encode_ebml_size(group_payload_len)?;
        let group_header_len = ID_BLOCK_GROUP
            .len()
            .checked_add(group_size.len())
            .ok_or_else(|| mux_error("EBML BlockGroup header overflow"))?;

        let timestamp_element = uint_element(ID_CLUSTER_TIMESTAMP, cluster_ticks)?;
        let cluster_payload_len = timestamp_element
            .len()
            .checked_add(group_header_len)
            .and_then(|value| value.checked_add(group_payload_len))
            .ok_or_else(|| mux_error("EBML Cluster length overflow"))?;
        let cluster_size = encode_ebml_size(cluster_payload_len)?;

        let cluster_offset = self.file_mut()?.stream_position().map_err(io_error)?;
        let segment_data_offset = self
            .segment_data_offset
            .ok_or_else(|| mux_error("EBML Segment offset is missing"))?;
        let cluster_position = cluster_offset
            .checked_sub(segment_data_offset)
            .ok_or_else(|| mux_error("EBML Cluster precedes Segment data"))?;

        self.file_mut()?.write_all(ID_CLUSTER).map_err(io_error)?;
        self.file_mut()?.write_all(&cluster_size).map_err(io_error)?;
        self.file_mut()?
            .write_all(&timestamp_element)
            .map_err(io_error)?;
        self.file_mut()?.write_all(ID_BLOCK_GROUP).map_err(io_error)?;
        self.file_mut()?.write_all(&group_size).map_err(io_error)?;
        self.file_mut()?.write_all(ID_BLOCK).map_err(io_error)?;
        self.file_mut()?.write_all(&block_size).map_err(io_error)?;
        self.file_mut()?.write_all(&track_vint).map_err(io_error)?;
        self.file_mut()?
            .write_all(&relative_timecode.to_be_bytes())
            .map_err(io_error)?;
        self.file_mut()?.write_all(&[0]).map_err(io_error)?;
        self.file_mut()?.write_all(&packet.data).map_err(io_error)?;
        self.file_mut()?
            .write_all(&duration_element)
            .map_err(io_error)?;
        if !reference_element.is_empty() {
            self.file_mut()?
                .write_all(&reference_element)
                .map_err(io_error)?;
        }

        self.last_cluster_ticks = Some(cluster_ticks);
        Ok(cluster_position)
    }
}

impl MediaMuxer for EbmlMuxer {
    fn add_track(&mut self, track: &MediaTrack) -> Result<u32, MediaProcessingError> {
        if self.finalized {
            return Err(mux_error("cannot add a track after EBML finalization"));
        }
        if self.header_written || self.packets_written != 0 {
            return Err(mux_error(
                "all EBML tracks must be registered before writing packets",
            ));
        }
        if self.tracks.len() >= MAX_TRACKS {
            return Err(mux_error(format!(
                "EBML output exceeds track safety limit {MAX_TRACKS}"
            )));
        }

        let track_id = self.next_track_id;
        self.next_track_id = self
            .next_track_id
            .checked_add(1)
            .ok_or_else(|| mux_error("EBML track id overflow"))?;
        let prepared = prepare_output_track(track, track_id, self.kind)?;
        self.tracks.insert(track_id, prepared);
        Ok(track_id)
    }

    fn write_packet(&mut self, packet: &MediaPacket) -> Result<(), MediaProcessingError> {
        if self.finalized {
            return Err(mux_error("cannot write a packet after EBML finalization"));
        }
        if packet.data.is_empty() {
            return Err(mux_error("EBML packet payload must not be empty"));
        }
        if packet.data.len() > MAX_PACKET_BYTES {
            return Err(mux_error(format!(
                "EBML packet exceeds safety limit {MAX_PACKET_BYTES}"
            )));
        }
        if packet.flags.corrupted {
            return Err(mux_error("corrupted packets are rejected by the EBML muxer"));
        }
        if packet.flags.discontinuity {
            return Err(MediaProcessingError::UnsupportedOperation(
                "EBML discontinuities require timeline segmentation support".to_owned(),
            ));
        }

        if !self.tracks.contains_key(&packet.track_id) {
            return Err(mux_error(format!(
                "packet references unknown EBML output track {}",
                packet.track_id
            )));
        }
        self.ensure_header()?;

        let (
            track_kind,
            track_time_base,
            track_packet_count,
            previous_pts_ticks,
            previous_dts_ticks,
        ) = {
            let track = self
                .tracks
                .get(&packet.track_id)
                .ok_or_else(|| mux_error("EBML output track disappeared"))?;
            (
                track.track.kind,
                track.track.time_base,
                track.packets_written,
                track.previous_pts_ticks,
                track.previous_dts_ticks,
            )
        };

        if track_packet_count >= MAX_PACKETS_PER_TRACK {
            return Err(mux_error(format!(
                "EBML track {} exceeds packet safety limit {MAX_PACKETS_PER_TRACK}",
                packet.track_id
            )));
        }

        let pts = required_timestamp(packet.pts, "PTS", track_time_base)?;
        let dts = required_timestamp(packet.dts.or(packet.pts), "DTS", track_time_base)?;
        let duration = required_duration(packet.duration, track_time_base)?;
        let pts_ns = timestamp_to_nanoseconds(pts)?;
        let dts_ns = timestamp_to_nanoseconds(dts)?;
        let duration_ns = duration_to_nanoseconds(duration)?;

        if pts_ns < 0 || dts_ns < 0 {
            return Err(MediaProcessingError::UnsupportedOperation(
                "negative EBML packet timestamps are not emitted by the native muxer yet"
                    .to_owned(),
            ));
        }

        let pts_ticks = nanoseconds_to_ticks(pts_ns)?;
        let dts_ticks = nanoseconds_to_ticks(dts_ns)?;
        let duration_ticks = u64::try_from(nanoseconds_to_ticks(duration_ns)?)
            .map_err(|_| mux_error("EBML packet duration became negative"))?
            .max(1);

        if let Some(previous) = previous_dts_ticks {
            if dts_ticks < previous {
                return Err(MediaProcessingError::UnsupportedOperation(format!(
                    "EBML track {} DTS regressed from {previous} to {dts_ticks} ticks",
                    packet.track_id
                )));
            }
        }

        let is_keyframe = track_kind == MediaTrackKind::Audio || packet.flags.keyframe;
        let cluster_position = self.write_cluster_for_packet(
            packet,
            pts_ticks,
            dts_ticks,
            duration_ticks,
            is_keyframe,
            previous_pts_ticks,
        )?;

        let end_ns = u64::try_from(pts_ns)
            .ok()
            .and_then(|value| value.checked_add(u64::try_from(duration_ns).ok()?))
            .ok_or_else(|| mux_error("EBML presentation duration overflow"))?;
        self.max_end_ns = self.max_end_ns.max(end_ns);

        let has_video = self
            .tracks
            .values()
            .any(|track| track.track.kind == MediaTrackKind::Video);
        if self.cues.len() < MAX_CUES
            && ((track_kind == MediaTrackKind::Video && is_keyframe)
                || (!has_video && track_packet_count == 0))
        {
            self.cues.push(CueRecord {
                time_ticks: u64::try_from(pts_ticks)
                    .map_err(|_| mux_error("EBML CueTime must not be negative"))?,
                track_id: packet.track_id,
                cluster_position,
            });
        }

        let track = self
            .tracks
            .get_mut(&packet.track_id)
            .ok_or_else(|| mux_error("EBML output track disappeared"))?;
        track.packets_written = track
            .packets_written
            .checked_add(1)
            .ok_or_else(|| mux_error("EBML packet counter overflow"))?;
        track.previous_pts_ticks = Some(pts_ticks);
        track.previous_dts_ticks = Some(dts_ticks);
        self.packets_written = self
            .packets_written
            .checked_add(1)
            .ok_or_else(|| mux_error("EBML packet counter overflow"))?;
        Ok(())
    }

    fn finalize(&mut self) -> Result<MediaMuxResult, MediaProcessingError> {
        if self.finalized {
            return Err(mux_error("EBML muxer was already finalized"));
        }
        if self.tracks.is_empty() {
            return Err(mux_error("EBML output requires at least one track"));
        }
        if self.packets_written == 0
            || self
                .tracks
                .values()
                .any(|track| track.packets_written == 0)
        {
            return Err(mux_error(
                "every registered EBML track must contain at least one packet",
            ));
        }

        self.ensure_header()?;
        if !self.cues.is_empty() {
            let cues = make_cues(&self.cues)?;
            self.file_mut()?.write_all(&cues).map_err(io_error)?;
        }

        let end_position = self.file_mut()?.stream_position().map_err(io_error)?;
        let duration_offset = self
            .duration_data_offset
            .ok_or_else(|| mux_error("EBML duration patch offset is missing"))?;
        let duration_ticks = self.max_end_ns as f64 / TIMESTAMP_SCALE_NS as f64;
        self.file_mut()?
            .seek(SeekFrom::Start(duration_offset))
            .map_err(io_error)?;
        self.file_mut()?
            .write_all(&duration_ticks.to_be_bytes())
            .map_err(io_error)?;
        self.file_mut()?
            .seek(SeekFrom::Start(end_position))
            .map_err(io_error)?;
        self.file_mut()?.flush().map_err(io_error)?;
        self.file_mut()?.sync_all().map_err(io_error)?;

        let final_bytes = self.file_mut()?.metadata().map_err(io_error)?.len();
        drop(self.file.take());

        if self.destination.exists() {
            fs::remove_file(&self.destination).map_err(io_error)?;
        }
        fs::rename(&self.temporary, &self.destination).map_err(io_error)?;
        self.finalized = true;

        Ok(MediaMuxResult {
            packets_written: self.packets_written,
            bytes_written: final_bytes,
            tracks_written: u32::try_from(self.tracks.len())
                .map_err(|_| mux_error("EBML track count exceeds u32"))?,
        })
    }
}

impl Drop for EbmlMuxer {
    fn drop(&mut self) {
        if !self.finalized {
            drop(self.file.take());
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

#[derive(Debug)]
pub struct WebmMuxer {
    inner: EbmlMuxer,
}

impl WebmMuxer {
    pub fn create(destination: &Path) -> Result<Self, MediaProcessingError> {
        Ok(Self {
            inner: EbmlMuxer::create(destination, EbmlOutputKind::WebM)?,
        })
    }
}

impl MediaMuxer for WebmMuxer {
    fn add_track(&mut self, track: &MediaTrack) -> Result<u32, MediaProcessingError> {
        self.inner.add_track(track)
    }

    fn write_packet(&mut self, packet: &MediaPacket) -> Result<(), MediaProcessingError> {
        self.inner.write_packet(packet)
    }

    fn finalize(&mut self) -> Result<MediaMuxResult, MediaProcessingError> {
        self.inner.finalize()
    }
}

#[derive(Debug)]
pub struct MatroskaMuxer {
    inner: EbmlMuxer,
}

impl MatroskaMuxer {
    pub fn create(destination: &Path) -> Result<Self, MediaProcessingError> {
        Ok(Self {
            inner: EbmlMuxer::create(destination, EbmlOutputKind::Matroska)?,
        })
    }
}

impl MediaMuxer for MatroskaMuxer {
    fn add_track(&mut self, track: &MediaTrack) -> Result<u32, MediaProcessingError> {
        self.inner.add_track(track)
    }

    fn write_packet(&mut self, packet: &MediaPacket) -> Result<(), MediaProcessingError> {
        self.inner.write_packet(packet)
    }

    fn finalize(&mut self) -> Result<MediaMuxResult, MediaProcessingError> {
        self.inner.finalize()
    }
}

pub fn mux_demuxers_to_webm(
    destination: &Path,
    demuxers: &mut [&mut dyn MediaDemuxer],
) -> Result<MediaMuxResult, MediaProcessingError> {
    mux_demuxers_to_ebml_controlled(
        destination,
        demuxers,
        EbmlOutputKind::WebM,
        || MediaProcessingControl::Continue,
        |_| {},
    )
}

pub fn mux_demuxers_to_matroska(
    destination: &Path,
    demuxers: &mut [&mut dyn MediaDemuxer],
) -> Result<MediaMuxResult, MediaProcessingError> {
    mux_demuxers_to_ebml_controlled(
        destination,
        demuxers,
        EbmlOutputKind::Matroska,
        || MediaProcessingControl::Continue,
        |_| {},
    )
}

pub fn mux_demuxers_to_webm_controlled<C, P>(
    destination: &Path,
    demuxers: &mut [&mut dyn MediaDemuxer],
    control: C,
    progress: P,
) -> Result<MediaMuxResult, MediaProcessingError>
where
    C: Fn() -> MediaProcessingControl,
    P: Fn(u64),
{
    mux_demuxers_to_ebml_controlled(
        destination,
        demuxers,
        EbmlOutputKind::WebM,
        control,
        progress,
    )
}

pub fn mux_demuxers_to_matroska_controlled<C, P>(
    destination: &Path,
    demuxers: &mut [&mut dyn MediaDemuxer],
    control: C,
    progress: P,
) -> Result<MediaMuxResult, MediaProcessingError>
where
    C: Fn() -> MediaProcessingControl,
    P: Fn(u64),
{
    mux_demuxers_to_ebml_controlled(
        destination,
        demuxers,
        EbmlOutputKind::Matroska,
        control,
        progress,
    )
}

fn mux_demuxers_to_ebml_controlled<C, P>(
    destination: &Path,
    demuxers: &mut [&mut dyn MediaDemuxer],
    kind: EbmlOutputKind,
    control: C,
    progress: P,
) -> Result<MediaMuxResult, MediaProcessingError>
where
    C: Fn() -> MediaProcessingControl,
    P: Fn(u64),
{
    if demuxers.is_empty() {
        return Err(mux_error("EBML mux requires at least one input demuxer"));
    }

    let mut muxer = EbmlMuxer::create(destination, kind)?;
    let mut mappings = Vec::with_capacity(demuxers.len());
    let mut kinds = Vec::with_capacity(demuxers.len());

    for demuxer in demuxers.iter() {
        let mut map = BTreeMap::new();
        let mut kind_map = BTreeMap::new();
        for track in &demuxer.probe().tracks {
            let output_id = muxer.add_track(track)?;
            map.insert(track.id, output_id);
            kind_map.insert(track.id, track.kind);
        }
        mappings.push(map);
        kinds.push(kind_map);
    }

    let mut pending = Vec::with_capacity(demuxers.len());
    for demuxer in demuxers.iter_mut() {
        pending.push(demuxer.next_packet()?);
    }

    let mut processed_bytes = 0_u64;
    loop {
        match control() {
            MediaProcessingControl::Continue => {}
            MediaProcessingControl::Pause => return Err(MediaProcessingError::Paused),
            MediaProcessingControl::Cancel => return Err(MediaProcessingError::Cancelled),
        }

        let mut selected: Option<(usize, i64, u8)> = None;
        for (index, packet) in pending.iter().enumerate() {
            let Some(packet) = packet.as_ref() else {
                continue;
            };
            let timestamp = packet.dts.or(packet.pts).ok_or_else(|| {
                mux_error("EBML interleaver requires DTS or PTS on every packet")
            })?;
            let timestamp_ns = timestamp_to_nanoseconds(timestamp)?;
            let kind_priority = match kinds[index].get(&packet.track_id) {
                Some(MediaTrackKind::Audio) => 0,
                Some(MediaTrackKind::Video) => 1,
                _ => 2,
            };
            if selected
                .map(|(_, current_ns, current_priority)| {
                    (timestamp_ns, kind_priority) < (current_ns, current_priority)
                })
                .unwrap_or(true)
            {
                selected = Some((index, timestamp_ns, kind_priority));
            }
        }

        let Some((index, _, _)) = selected else {
            break;
        };
        let mut packet = pending[index]
            .take()
            .ok_or_else(|| mux_error("EBML interleaver selected an empty input"))?;
        packet.track_id = mappings[index]
            .get(&packet.track_id)
            .copied()
            .ok_or_else(|| mux_error("EBML input packet references an unregistered track"))?;

        processed_bytes = processed_bytes
            .checked_add(
                u64::try_from(packet.data.len())
                    .map_err(|_| mux_error("EBML processed-byte count exceeds u64"))?,
            )
            .ok_or_else(|| mux_error("EBML processed-byte counter overflow"))?;
        muxer.write_packet(&packet)?;
        progress(processed_bytes);
        pending[index] = demuxers[index].next_packet()?;
    }

    match control() {
        MediaProcessingControl::Continue => muxer.finalize(),
        MediaProcessingControl::Pause => Err(MediaProcessingError::Paused),
        MediaProcessingControl::Cancel => Err(MediaProcessingError::Cancelled),
    }
}

fn prepare_output_track(
    source: &MediaTrack,
    output_id: u32,
    kind: EbmlOutputKind,
) -> Result<OutputTrack, MediaProcessingError> {
    if source.time_base.numerator == 0 || source.time_base.denominator == 0 {
        return Err(mux_error("EBML track has an invalid time base"));
    }

    let mut track = source.clone();
    track.id = output_id;
    let mut colour = None;
    let mut codec_delay_ns = None;
    let mut seek_preroll_ns = None;

    let (codec_id, codec_private) = match (&track.kind, &track.codec) {
        (MediaTrackKind::Video, MediaCodec::Vp8) => {
            validate_video_parameters(&track)?;
            if !source.codec_private.is_empty() {
                colour = parse_vpcc_colour(&source.codec_private)?;
            }
            ("V_VP8", Vec::new())
        }
        (MediaTrackKind::Video, MediaCodec::Vp9) => {
            validate_video_parameters(&track)?;
            let (private, parsed_colour) = normalize_vp9_private(&source.codec_private)?;
            colour = parsed_colour;
            ("V_VP9", private)
        }
        (MediaTrackKind::Video, MediaCodec::Av1) => {
            validate_video_parameters(&track)?;
            validate_av1_private(&source.codec_private)?;
            ("V_AV1", source.codec_private.clone())
        }
        (MediaTrackKind::Audio, MediaCodec::Opus) => {
            validate_audio_parameters(&track)?;
            let (private, pre_skip, input_rate) =
                normalize_opus_private(&source.codec_private, &track)?;
            if let Some(audio) = track.audio.as_mut() {
                audio.sample_rate_hz = input_rate;
            }
            codec_delay_ns = Some(
                u64::from(pre_skip)
                    .checked_mul(1_000_000_000)
                    .and_then(|value| value.checked_add(24_000))
                    .map(|value| value / 48_000)
                    .ok_or_else(|| mux_error("Opus CodecDelay calculation overflow"))?,
            );
            seek_preroll_ns = Some(80_000_000);
            ("A_OPUS", private)
        }
        (MediaTrackKind::Video, MediaCodec::H264) if kind == EbmlOutputKind::Matroska => {
            validate_video_parameters(&track)?;
            validate_avc_private(&source.codec_private)?;
            ("V_MPEG4/ISO/AVC", source.codec_private.clone())
        }
        (MediaTrackKind::Video, MediaCodec::Hevc) if kind == EbmlOutputKind::Matroska => {
            validate_video_parameters(&track)?;
            validate_hevc_private(&source.codec_private)?;
            ("V_MPEGH/ISO/HEVC", source.codec_private.clone())
        }
        (MediaTrackKind::Audio, MediaCodec::Aac) if kind == EbmlOutputKind::Matroska => {
            validate_audio_parameters(&track)?;
            let asc = normalize_aac_private(&source.codec_private)?;
            ("A_AAC", asc)
        }
        (MediaTrackKind::Audio, MediaCodec::Mp3) if kind == EbmlOutputKind::Matroska => {
            validate_audio_parameters(&track)?;
            ("A_MPEG/L3", Vec::new())
        }
        (MediaTrackKind::Audio, MediaCodec::Flac) if kind == EbmlOutputKind::Matroska => {
            validate_audio_parameters(&track)?;
            if source.codec_private.is_empty() {
                return Err(mux_error("Matroska FLAC track is missing codec initialization data"));
            }
            ("A_FLAC", source.codec_private.clone())
        }
        (MediaTrackKind::Subtitle | MediaTrackKind::Data, _) => {
            return Err(MediaProcessingError::UnsupportedOperation(
                "native WebM/Matroska subtitle and data muxing is not implemented yet".to_owned(),
            ))
        }
        _ => {
            return Err(MediaProcessingError::UnsupportedCodec(format!(
                "{:?} is not supported by the native {} muxer",
                track.codec,
                kind.container().as_str()
            )))
        }
    };

    if codec_private.len() > MAX_CODEC_PRIVATE_BYTES {
        return Err(mux_error(format!(
            "EBML codec private data exceeds safety limit {MAX_CODEC_PRIVATE_BYTES}"
        )));
    }

    Ok(OutputTrack {
        track,
        codec_id,
        codec_private,
        colour,
        codec_delay_ns,
        seek_preroll_ns,
        packets_written: 0,
        previous_pts_ticks: None,
        previous_dts_ticks: None,
    })
}

fn validate_video_parameters(track: &MediaTrack) -> Result<(), MediaProcessingError> {
    let video = track
        .video
        .as_ref()
        .ok_or_else(|| mux_error("EBML video track is missing video parameters"))?;
    if video.width == 0 || video.height == 0 {
        return Err(mux_error("EBML video dimensions must be positive"));
    }
    Ok(())
}

fn validate_audio_parameters(track: &MediaTrack) -> Result<(), MediaProcessingError> {
    let audio = track
        .audio
        .as_ref()
        .ok_or_else(|| mux_error("EBML audio track is missing audio parameters"))?;
    if audio.sample_rate_hz == 0 || audio.channels == 0 {
        return Err(mux_error(
            "EBML audio sampling frequency and channels must be positive",
        ));
    }
    Ok(())
}

fn make_ebml_header(kind: EbmlOutputKind) -> Result<Vec<u8>, MediaProcessingError> {
    let payload = [
        uint_element(ID_EBML_VERSION, 1)?,
        uint_element(ID_EBML_READ_VERSION, 1)?,
        uint_element(ID_EBML_MAX_ID_LENGTH, 4)?,
        uint_element(ID_EBML_MAX_SIZE_LENGTH, 8)?,
        text_element(ID_DOC_TYPE, kind.doc_type())?,
        uint_element(ID_DOC_TYPE_VERSION, 4)?,
        uint_element(ID_DOC_TYPE_READ_VERSION, 2)?,
    ]
    .concat();
    element(ID_EBML, payload)
}

fn make_info() -> Result<(Vec<u8>, usize), MediaProcessingError> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&uint_element(ID_TIMESTAMP_SCALE, TIMESTAMP_SCALE_NS)?);

    let duration_size = encode_ebml_size(8)?;
    let duration_start = payload.len();
    payload.extend_from_slice(ID_DURATION);
    payload.extend_from_slice(&duration_size);
    let duration_data_in_payload = payload.len();
    payload.extend_from_slice(&0_f64.to_be_bytes());

    payload.extend_from_slice(&text_element(ID_MUXING_APP, "NOVA Download Manager")?);
    payload.extend_from_slice(&text_element(ID_WRITING_APP, "NOVA Download Manager")?);

    let size = encode_ebml_size(payload.len())?;
    let prefix_len = ID_INFO
        .len()
        .checked_add(size.len())
        .ok_or_else(|| mux_error("EBML Info header length overflow"))?;
    let mut result = Vec::with_capacity(prefix_len + payload.len());
    result.extend_from_slice(ID_INFO);
    result.extend_from_slice(&size);
    result.extend_from_slice(&payload);

    let expected_duration_data = duration_start
        .checked_add(ID_DURATION.len())
        .and_then(|value| value.checked_add(duration_size.len()))
        .ok_or_else(|| mux_error("EBML Duration offset overflow"))?;
    debug_assert_eq!(expected_duration_data, duration_data_in_payload);

    Ok((
        result,
        prefix_len
            .checked_add(duration_data_in_payload)
            .ok_or_else(|| mux_error("EBML Duration absolute offset overflow"))?,
    ))
}

fn make_tracks(tracks: &BTreeMap<u32, OutputTrack>) -> Result<Vec<u8>, MediaProcessingError> {
    let entries = tracks
        .values()
        .map(make_track_entry)
        .collect::<Result<Vec<_>, _>>()?
        .concat();
    element(ID_TRACKS, entries)
}

fn make_track_entry(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&uint_element(ID_TRACK_NUMBER, u64::from(track.track.id))?);
    payload.extend_from_slice(&uint_element(ID_TRACK_UID, u64::from(track.track.id))?);
    payload.extend_from_slice(&uint_element(
        ID_TRACK_TYPE,
        match track.track.kind {
            MediaTrackKind::Video => 1,
            MediaTrackKind::Audio => 2,
            MediaTrackKind::Subtitle => 17,
            MediaTrackKind::Data => 33,
        },
    )?);
    payload.extend_from_slice(&text_element(ID_CODEC_ID, track.codec_id)?);

    if !track.codec_private.is_empty() {
        payload.extend_from_slice(&binary_element(
            ID_CODEC_PRIVATE,
            track.codec_private.clone(),
        )?);
    }
    if let Some(language) = track
        .track
        .language
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if !language.is_ascii() || language.len() > 64 {
            return Err(mux_error("EBML track language must be short ASCII text"));
        }
        payload.extend_from_slice(&text_element(ID_LANGUAGE, language)?);
    }
    if let Some(delay) = track.codec_delay_ns {
        payload.extend_from_slice(&uint_element(ID_CODEC_DELAY, delay)?);
    }
    if let Some(preroll) = track.seek_preroll_ns {
        payload.extend_from_slice(&uint_element(ID_SEEK_PREROLL, preroll)?);
    }

    match track.track.kind {
        MediaTrackKind::Video => {
            let video = track
                .track
                .video
                .as_ref()
                .ok_or_else(|| mux_error("EBML video track parameters disappeared"))?;
            let mut video_payload = Vec::new();
            video_payload.extend_from_slice(&uint_element(
                ID_PIXEL_WIDTH,
                u64::from(video.width),
            )?);
            video_payload.extend_from_slice(&uint_element(
                ID_PIXEL_HEIGHT,
                u64::from(video.height),
            )?);
            if let Some(colour) = track.colour {
                let colour_payload = [
                    uint_element(
                        ID_MATRIX_COEFFICIENTS,
                        u64::from(colour.matrix_coefficients),
                    )?,
                    uint_element(ID_BITS_PER_CHANNEL, u64::from(colour.bits_per_channel))?,
                    uint_element(ID_COLOUR_RANGE, u64::from(colour.range))?,
                    uint_element(
                        ID_TRANSFER_CHARACTERISTICS,
                        u64::from(colour.transfer_characteristics),
                    )?,
                    uint_element(ID_PRIMARIES, u64::from(colour.primaries))?,
                ]
                .concat();
                video_payload.extend_from_slice(&element(ID_COLOUR, colour_payload)?);
            }
            payload.extend_from_slice(&element(ID_VIDEO, video_payload)?);
        }
        MediaTrackKind::Audio => {
            let audio = track
                .track
                .audio
                .as_ref()
                .ok_or_else(|| mux_error("EBML audio track parameters disappeared"))?;
            let audio_payload = [
                float_element(ID_SAMPLING_FREQUENCY, f64::from(audio.sample_rate_hz))?,
                uint_element(ID_CHANNELS, u64::from(audio.channels))?,
            ]
            .concat();
            payload.extend_from_slice(&element(ID_AUDIO, audio_payload)?);
        }
        MediaTrackKind::Subtitle | MediaTrackKind::Data => {}
    }

    element(ID_TRACK_ENTRY, payload)
}

fn make_cues(cues: &[CueRecord]) -> Result<Vec<u8>, MediaProcessingError> {
    let mut payload = Vec::new();
    for cue in cues {
        let track_positions = element(
            ID_CUE_TRACK_POSITIONS,
            [
                uint_element(ID_CUE_TRACK, u64::from(cue.track_id))?,
                uint_element(ID_CUE_CLUSTER_POSITION, cue.cluster_position)?,
            ]
            .concat(),
        )?;
        let point = element(
            ID_CUE_POINT,
            [
                uint_element(ID_CUE_TIME, cue.time_ticks)?,
                track_positions,
            ]
            .concat(),
        )?;
        payload.extend_from_slice(&point);
    }
    element(ID_CUES, payload)
}

fn normalize_vp9_private(
    data: &[u8],
) -> Result<(Vec<u8>, Option<EbmlColour>), MediaProcessingError> {
    if data.is_empty() {
        return Ok((Vec::new(), None));
    }
    if looks_like_vpcc(data) {
        let record = parse_vpcc(data)?;
        let private = vec![
            1,
            1,
            record.profile,
            2,
            1,
            record.level,
            3,
            1,
            record.bit_depth,
            4,
            1,
            record.chroma_subsampling,
        ];
        return Ok((private, Some(record.colour)));
    }

    validate_vp9_feature_private(data)?;
    Ok((data.to_vec(), None))
}

#[derive(Clone, Copy, Debug)]
struct ParsedVpcc {
    profile: u8,
    level: u8,
    bit_depth: u8,
    chroma_subsampling: u8,
    colour: EbmlColour,
}

fn looks_like_vpcc(data: &[u8]) -> bool {
    data.len() >= 12 && data[0] == 1 && data.get(1..4) == Some(&[0, 0, 0][..])
}

fn parse_vpcc(data: &[u8]) -> Result<ParsedVpcc, MediaProcessingError> {
    if !looks_like_vpcc(data) {
        return Err(mux_error("VP codec private data is not a vpcC version-1 payload"));
    }
    let initialization_size = usize::from(u16::from_be_bytes([data[10], data[11]]));
    let expected = 12_usize
        .checked_add(initialization_size)
        .ok_or_else(|| mux_error("vpcC initialization data length overflow"))?;
    if data.len() != expected {
        return Err(mux_error("vpcC initialization data length does not match payload"));
    }
    if initialization_size != 0 {
        return Err(MediaProcessingError::UnsupportedOperation(
            "WebM VP remux does not preserve vpcC codecInitializationData yet".to_owned(),
        ));
    }

    let bit_depth = data[6] >> 4;
    let chroma_subsampling = (data[6] >> 1) & 0x07;
    if !matches!(bit_depth, 8 | 10 | 12) || chroma_subsampling > 3 {
        return Err(mux_error("vpcC contains invalid bit depth or chroma subsampling"));
    }
    Ok(ParsedVpcc {
        profile: data[4],
        level: data[5],
        bit_depth,
        chroma_subsampling,
        colour: EbmlColour {
            matrix_coefficients: data[9],
            bits_per_channel: bit_depth,
            range: if data[6] & 1 != 0 { 2 } else { 1 },
            transfer_characteristics: data[8],
            primaries: data[7],
        },
    })
}

fn parse_vpcc_colour(data: &[u8]) -> Result<Option<EbmlColour>, MediaProcessingError> {
    if data.is_empty() {
        return Ok(None);
    }
    parse_vpcc(data).map(|record| Some(record.colour))
}

fn validate_vp9_feature_private(data: &[u8]) -> Result<(), MediaProcessingError> {
    let mut cursor = 0_usize;
    while cursor < data.len() {
        if data.len() - cursor < 2 {
            return Err(mux_error("truncated VP9 CodecPrivate feature header"));
        }
        let id = data[cursor];
        let len = usize::from(data[cursor + 1]);
        cursor += 2;
        if id & 0x80 != 0 {
            return Err(mux_error("VP9 CodecPrivate extended feature ids are unsupported"));
        }
        let end = cursor
            .checked_add(len)
            .filter(|end| *end <= data.len())
            .ok_or_else(|| mux_error("truncated VP9 CodecPrivate feature"))?;
        if matches!(id, 1..=4) && len != 1 {
            return Err(mux_error(
                "VP9 profile, level, bit-depth and chroma features must be one byte",
            ));
        }
        cursor = end;
    }
    Ok(())
}

fn validate_av1_private(data: &[u8]) -> Result<(), MediaProcessingError> {
    if data.len() < 4 || data[0] != 0x81 {
        return Err(mux_error(
            "AV1 EBML output requires an AV1CodecConfigurationRecord",
        ));
    }
    Ok(())
}

fn normalize_opus_private(
    data: &[u8],
    track: &MediaTrack,
) -> Result<(Vec<u8>, u16, u32), MediaProcessingError> {
    let audio = track
        .audio
        .as_ref()
        .ok_or_else(|| mux_error("Opus track is missing audio parameters"))?;

    if data.len() >= 19 && data.starts_with(b"OpusHead") {
        let mut head = data.to_vec();
        if head[8] > 15 {
            return Err(mux_error(format!(
                "unsupported OpusHead major version {}",
                head[8]
            )));
        }
        let channels = head[9];
        if channels == 0 || u16::from(channels) != audio.channels {
            return Err(mux_error(
                "OpusHead channel count does not match EBML audio parameters",
            ));
        }
        let pre_skip = u16::from_le_bytes([head[10], head[11]]);
        let mut input_rate = u32::from_le_bytes([head[12], head[13], head[14], head[15]]);
        if input_rate == 0 {
            input_rate = audio.sample_rate_hz;
            head[12..16].copy_from_slice(&input_rate.to_le_bytes());
        }
        if input_rate != audio.sample_rate_hz {
            return Err(mux_error(
                "OpusHead input sample rate does not match EBML SamplingFrequency",
            ));
        }
        validate_opus_mapping(&head, channels)?;
        return Ok((head, pre_skip, input_rate));
    }

    if data.len() < 11 || data[0] != 0 {
        return Err(mux_error(
            "Opus EBML output requires OpusHead or dOps version 0 codec data",
        ));
    }
    let channels = data[1];
    if channels == 0 || u16::from(channels) != audio.channels {
        return Err(mux_error(
            "dOps channel count does not match EBML audio parameters",
        ));
    }
    let pre_skip = u16::from_be_bytes([data[2], data[3]]);
    let mut input_rate = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    if input_rate == 0 {
        input_rate = audio.sample_rate_hz;
    }
    if input_rate != audio.sample_rate_hz {
        return Err(mux_error(
            "dOps input sample rate does not match EBML SamplingFrequency",
        ));
    }
    let gain = i16::from_be_bytes([data[8], data[9]]);
    let family = data[10];
    if family == 0 && data.len() != 11 {
        return Err(mux_error(
            "Opus dOps mapping family 0 must not contain a channel mapping table",
        ));
    }

    let mut head = b"OpusHead".to_vec();
    head.push(1);
    head.push(channels);
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&input_rate.to_le_bytes());
    head.extend_from_slice(&gain.to_le_bytes());
    head.push(family);
    if family != 0 {
        let required = 13_usize
            .checked_add(usize::from(channels))
            .ok_or_else(|| mux_error("Opus dOps mapping length overflow"))?;
        if data.len() < required {
            return Err(mux_error("truncated dOps channel mapping table"));
        }
        head.extend_from_slice(&data[11..required]);
    }
    validate_opus_mapping(&head, channels)?;
    Ok((head, pre_skip, input_rate))
}

fn validate_opus_mapping(data: &[u8], channels: u8) -> Result<(), MediaProcessingError> {
    let family = *data
        .get(18)
        .ok_or_else(|| mux_error("truncated OpusHead mapping family"))?;
    if family == 0 {
        if !matches!(channels, 1 | 2) || data.len() != 19 {
            return Err(mux_error(
                "Opus mapping family 0 requires mono/stereo and no mapping table",
            ));
        }
        return Ok(());
    }

    let required = 21_usize
        .checked_add(usize::from(channels))
        .ok_or_else(|| mux_error("OpusHead mapping table length overflow"))?;
    if data.len() < required {
        return Err(mux_error("truncated OpusHead channel mapping table"));
    }
    let stream_count = data[19];
    let coupled_count = data[20];
    if stream_count == 0
        || coupled_count > stream_count
        || u16::from(stream_count) + u16::from(coupled_count) != u16::from(channels)
    {
        return Err(mux_error("invalid OpusHead stream and coupled channel counts"));
    }
    Ok(())
}

fn validate_avc_private(data: &[u8]) -> Result<(), MediaProcessingError> {
    if data.len() < 7 || data[0] != 1 {
        return Err(mux_error(
            "Matroska AVC output requires an AVCDecoderConfigurationRecord",
        ));
    }
    Ok(())
}

fn validate_hevc_private(data: &[u8]) -> Result<(), MediaProcessingError> {
    if data.len() < 23 || data[0] != 1 {
        return Err(mux_error(
            "Matroska HEVC output requires an HEVCDecoderConfigurationRecord",
        ));
    }
    Ok(())
}

fn normalize_aac_private(data: &[u8]) -> Result<Vec<u8>, MediaProcessingError> {
    if data.len() >= 5 && data.get(0..4) == Some(&[0, 0, 0, 0][..]) && data[4] == 0x03 {
        let asc = extract_aac_asc_from_esds(data)?;
        validate_aac_asc(&asc)?;
        return Ok(asc);
    }
    validate_aac_asc(data)?;
    Ok(data.to_vec())
}

fn extract_aac_asc_from_esds(data: &[u8]) -> Result<Vec<u8>, MediaProcessingError> {
    let mut cursor = 4_usize;
    let (tag, start, end) = descriptor_header(data, cursor)?;
    if tag != 0x03 {
        return Err(mux_error("AAC esds does not begin with ES_Descriptor"));
    }
    cursor = start;
    if end.saturating_sub(cursor) < 3 {
        return Err(mux_error("truncated AAC ES_Descriptor"));
    }
    cursor += 2;
    let flags = data[cursor];
    cursor += 1;
    if flags & 0x80 != 0 {
        cursor = cursor
            .checked_add(2)
            .filter(|value| *value <= end)
            .ok_or_else(|| mux_error("truncated AAC stream-dependence field"))?;
    }
    if flags & 0x40 != 0 {
        let url_len = usize::from(
            *data
                .get(cursor)
                .ok_or_else(|| mux_error("truncated AAC URL length"))?,
        );
        cursor = cursor
            .checked_add(1 + url_len)
            .filter(|value| *value <= end)
            .ok_or_else(|| mux_error("truncated AAC URL field"))?;
    }
    if flags & 0x20 != 0 {
        cursor = cursor
            .checked_add(2)
            .filter(|value| *value <= end)
            .ok_or_else(|| mux_error("truncated AAC OCR field"))?;
    }

    let (decoder_tag, decoder_start, decoder_end) = descriptor_header(data, cursor)?;
    if decoder_tag != 0x04 || decoder_end > end {
        return Err(mux_error("AAC esds is missing DecoderConfigDescriptor"));
    }
    if decoder_end.saturating_sub(decoder_start) < 13 {
        return Err(mux_error("truncated AAC DecoderConfigDescriptor"));
    }

    cursor = decoder_start + 13;
    while cursor < decoder_end {
        let (nested_tag, nested_start, nested_end) = descriptor_header(data, cursor)?;
        if nested_end > decoder_end {
            return Err(mux_error("AAC nested descriptor exceeds DecoderConfigDescriptor"));
        }
        if nested_tag == 0x05 {
            let asc = data
                .get(nested_start..nested_end)
                .ok_or_else(|| mux_error("truncated AAC DecoderSpecificInfo"))?;
            if asc.is_empty() {
                return Err(mux_error("AAC DecoderSpecificInfo is empty"));
            }
            return Ok(asc.to_vec());
        }
        cursor = nested_end;
    }
    Err(mux_error(
        "AAC esds does not contain DecoderSpecificInfo AudioSpecificConfig",
    ))
}

fn descriptor_header(
    data: &[u8],
    offset: usize,
) -> Result<(u8, usize, usize), MediaProcessingError> {
    let tag = *data
        .get(offset)
        .ok_or_else(|| mux_error("truncated MPEG-4 descriptor tag"))?;
    let mut cursor = offset + 1;
    let mut length = 0_usize;
    let mut saw_end = false;
    for _ in 0..4 {
        let byte = *data
            .get(cursor)
            .ok_or_else(|| mux_error("truncated MPEG-4 descriptor length"))?;
        cursor += 1;
        length = length
            .checked_mul(128)
            .and_then(|value| value.checked_add(usize::from(byte & 0x7f)))
            .ok_or_else(|| mux_error("MPEG-4 descriptor length overflow"))?;
        if byte & 0x80 == 0 {
            saw_end = true;
            break;
        }
    }
    if !saw_end {
        return Err(mux_error("MPEG-4 descriptor length exceeds four bytes"));
    }
    let end = cursor
        .checked_add(length)
        .filter(|end| *end <= data.len())
        .ok_or_else(|| mux_error("MPEG-4 descriptor payload is truncated"))?;
    Ok((tag, cursor, end))
}

fn validate_aac_asc(data: &[u8]) -> Result<(), MediaProcessingError> {
    let mut bit_offset = 0_usize;
    let object_type = read_aac_object_type(data, &mut bit_offset)?;
    read_aac_sampling_frequency(data, &mut bit_offset)?;
    let _channel_configuration = read_bits(data, &mut bit_offset, 4)?;

    if matches!(object_type, 5 | 29) {
        read_aac_sampling_frequency(data, &mut bit_offset)?;
        let _extension_object_type = read_aac_object_type(data, &mut bit_offset)?;
    }
    Ok(())
}

fn read_aac_object_type(
    data: &[u8],
    bit_offset: &mut usize,
) -> Result<u32, MediaProcessingError> {
    let object_type = read_bits(data, bit_offset, 5)?;
    let object_type = if object_type == 31 {
        32 + read_bits(data, bit_offset, 6)?
    } else {
        object_type
    };
    if object_type == 0 {
        return Err(mux_error(
            "AAC AudioSpecificConfig has reserved object type 0",
        ));
    }
    Ok(object_type)
}

fn read_aac_sampling_frequency(
    data: &[u8],
    bit_offset: &mut usize,
) -> Result<(), MediaProcessingError> {
    let frequency_index = read_bits(data, bit_offset, 4)?;
    if frequency_index == 15 {
        if read_bits(data, bit_offset, 24)? == 0 {
            return Err(mux_error(
                "AAC AudioSpecificConfig has zero explicit sampling frequency",
            ));
        }
    } else if frequency_index > 12 {
        return Err(mux_error(
            "AAC AudioSpecificConfig uses a reserved sampling-frequency index",
        ));
    }
    Ok(())
}

fn read_bits(
    data: &[u8],
    bit_offset: &mut usize,
    count: usize,
) -> Result<u32, MediaProcessingError> {
    if count == 0 || count > 32 {
        return Err(mux_error("invalid AAC bit-reader width"));
    }
    let end = bit_offset
        .checked_add(count)
        .ok_or_else(|| mux_error("AAC bit offset overflow"))?;
    if end > data.len().saturating_mul(8) {
        return Err(mux_error("truncated AAC AudioSpecificConfig"));
    }

    let mut value = 0_u32;
    for bit in *bit_offset..end {
        let byte = data[bit / 8];
        let shift = 7 - (bit % 8);
        value = (value << 1) | u32::from((byte >> shift) & 1);
    }
    *bit_offset = end;
    Ok(value)
}

fn required_timestamp(
    timestamp: Option<MediaTimestamp>,
    name: &str,
    expected: MediaTimeBase,
) -> Result<MediaTimestamp, MediaProcessingError> {
    let timestamp = timestamp.ok_or_else(|| mux_error(format!("EBML packet is missing {name}")))?;
    if timestamp.time_base != expected {
        return Err(mux_error(format!(
            "EBML packet {name} time base does not match its track"
        )));
    }
    Ok(timestamp)
}

fn required_duration(
    duration: Option<MediaTimestamp>,
    expected: MediaTimeBase,
) -> Result<MediaTimestamp, MediaProcessingError> {
    let duration = duration.ok_or_else(|| mux_error("EBML packet is missing duration"))?;
    if duration.time_base != expected {
        return Err(mux_error(
            "EBML packet duration time base does not match its track",
        ));
    }
    if duration.value <= 0 {
        return Err(mux_error("EBML packet duration must be positive"));
    }
    Ok(duration)
}

fn timestamp_to_nanoseconds(timestamp: MediaTimestamp) -> Result<i64, MediaProcessingError> {
    if timestamp.time_base.numerator == 0 || timestamp.time_base.denominator == 0 {
        return Err(mux_error("timestamp has invalid time base"));
    }
    let numerator = i128::from(timestamp.value)
        .checked_mul(i128::from(timestamp.time_base.numerator))
        .and_then(|value| value.checked_mul(1_000_000_000))
        .ok_or_else(|| mux_error("timestamp nanosecond conversion overflow"))?;
    let denominator = i128::from(timestamp.time_base.denominator);
    let rounded = if numerator >= 0 {
        numerator
            .checked_add(denominator / 2)
            .ok_or_else(|| mux_error("timestamp rounding overflow"))?
            / denominator
    } else {
        numerator
            .checked_sub(denominator / 2)
            .ok_or_else(|| mux_error("timestamp rounding overflow"))?
            / denominator
    };
    i64::try_from(rounded).map_err(|_| mux_error("timestamp exceeds i64 nanoseconds"))
}

fn duration_to_nanoseconds(duration: MediaTimestamp) -> Result<i64, MediaProcessingError> {
    let value = timestamp_to_nanoseconds(duration)?;
    if value <= 0 {
        return Err(mux_error("EBML packet duration rounds to zero nanoseconds"));
    }
    Ok(value)
}

fn nanoseconds_to_ticks(value: i64) -> Result<i64, MediaProcessingError> {
    let scale = i128::from(TIMESTAMP_SCALE_NS);
    let value = i128::from(value);
    let rounded = if value >= 0 {
        value
            .checked_add(scale / 2)
            .ok_or_else(|| mux_error("EBML tick rounding overflow"))?
            / scale
    } else {
        value
            .checked_sub(scale / 2)
            .ok_or_else(|| mux_error("EBML tick rounding overflow"))?
            / scale
    };
    i64::try_from(rounded).map_err(|_| mux_error("EBML timestamp exceeds i64 ticks"))
}

fn element(id: &[u8], payload: Vec<u8>) -> Result<Vec<u8>, MediaProcessingError> {
    let size = encode_ebml_size(payload.len())?;
    let mut result = Vec::with_capacity(
        id.len()
            .checked_add(size.len())
            .and_then(|value| value.checked_add(payload.len()))
            .ok_or_else(|| mux_error("EBML element length overflow"))?,
    );
    result.extend_from_slice(id);
    result.extend_from_slice(&size);
    result.extend_from_slice(&payload);
    Ok(result)
}

fn uint_element(id: &[u8], value: u64) -> Result<Vec<u8>, MediaProcessingError> {
    element(id, encode_uint(value))
}

fn signed_element(id: &[u8], value: i64) -> Result<Vec<u8>, MediaProcessingError> {
    element(id, value.to_be_bytes().to_vec())
}

fn float_element(id: &[u8], value: f64) -> Result<Vec<u8>, MediaProcessingError> {
    element(id, value.to_be_bytes().to_vec())
}

fn text_element(id: &[u8], value: &str) -> Result<Vec<u8>, MediaProcessingError> {
    element(id, value.as_bytes().to_vec())
}

fn binary_element(id: &[u8], value: Vec<u8>) -> Result<Vec<u8>, MediaProcessingError> {
    element(id, value)
}

fn encode_uint(value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let first_nonzero = bytes.iter().position(|byte| *byte != 0).unwrap_or(7);
    bytes[first_nonzero..].to_vec()
}

fn encode_vint_value(value: u64) -> Result<Vec<u8>, MediaProcessingError> {
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
            return Ok(bytes);
        }
    }
    Err(mux_error("EBML VINT value exceeds eight bytes"))
}

fn encode_ebml_size(value: usize) -> Result<Vec<u8>, MediaProcessingError> {
    let value = u64::try_from(value).map_err(|_| mux_error("EBML size exceeds u64"))?;
    encode_vint_value(value)
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn mux_error(message: impl Into<String>) -> MediaProcessingError {
    MediaProcessingError::Mux(message.into())
}

fn io_error(error: std::io::Error) -> MediaProcessingError {
    MediaProcessingError::Io(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AudioParameters, MatroskaDemuxer, MediaPacketFlags, VideoParameters, WebmDemuxer,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(extension: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("nova-ebml-mux-{unique}.{extension}"))
    }

    fn timestamp(value: i64, time_base: MediaTimeBase) -> MediaTimestamp {
        MediaTimestamp { value, time_base }
    }

    #[test]
    fn webm_mux_round_trips_vp9_and_opus() {
        let path = temp_path("webm");
        let mut muxer = WebmMuxer::create(&path).expect("create WebM");

        let video_time_base = MediaTimeBase::new(1, 1000).expect("video time base");
        let video = MediaTrack {
            id: 7,
            kind: MediaTrackKind::Video,
            codec: MediaCodec::Vp9,
            time_base: video_time_base,
            language: None,
            video: Some(VideoParameters {
                width: 640,
                height: 360,
                frame_rate: Some(30.0),
                bitrate_bps: None,
            }),
            audio: None,
            codec_private: vec![1, 0, 0, 0, 0, 41, 0x82, 1, 1, 1, 0, 0],
        };
        let audio_time_base = MediaTimeBase::new(1, 48_000).expect("audio time base");
        let audio = MediaTrack {
            id: 9,
            kind: MediaTrackKind::Audio,
            codec: MediaCodec::Opus,
            time_base: audio_time_base,
            language: Some("eng".to_owned()),
            video: None,
            audio: Some(AudioParameters {
                sample_rate_hz: 48_000,
                channels: 2,
                bitrate_bps: None,
            }),
            codec_private: vec![
                0, 2, 0x01, 0x38, 0x00, 0x00, 0xbb, 0x80, 0x00, 0x00, 0,
            ],
        };

        let video_id = muxer.add_track(&video).expect("video track");
        let audio_id = muxer.add_track(&audio).expect("audio track");

        let packets = [
            MediaPacket {
                track_id: audio_id,
                pts: Some(timestamp(0, audio_time_base)),
                dts: Some(timestamp(0, audio_time_base)),
                duration: Some(timestamp(960, audio_time_base)),
                flags: MediaPacketFlags {
                    keyframe: true,
                    ..Default::default()
                },
                data: b"A0".to_vec(),
            },
            MediaPacket {
                track_id: video_id,
                pts: Some(timestamp(0, video_time_base)),
                dts: Some(timestamp(0, video_time_base)),
                duration: Some(timestamp(33, video_time_base)),
                flags: MediaPacketFlags {
                    keyframe: true,
                    ..Default::default()
                },
                data: b"V0".to_vec(),
            },
            MediaPacket {
                track_id: audio_id,
                pts: Some(timestamp(960, audio_time_base)),
                dts: Some(timestamp(960, audio_time_base)),
                duration: Some(timestamp(960, audio_time_base)),
                flags: MediaPacketFlags {
                    keyframe: true,
                    ..Default::default()
                },
                data: b"A1".to_vec(),
            },
            MediaPacket {
                track_id: video_id,
                pts: Some(timestamp(33, video_time_base)),
                dts: Some(timestamp(33, video_time_base)),
                duration: Some(timestamp(33, video_time_base)),
                flags: MediaPacketFlags::default(),
                data: b"V1".to_vec(),
            },
        ];
        for packet in packets {
            muxer.write_packet(&packet).expect("write WebM packet");
        }
        let result = muxer.finalize().expect("finalize WebM");
        assert_eq!(result.tracks_written, 2);
        assert_eq!(result.packets_written, 4);

        let mut demuxer = WebmDemuxer::open(&path).expect("read WebM");
        assert_eq!(demuxer.probe().container, MediaContainer::WebM);
        assert_eq!(demuxer.probe().tracks.len(), 2);
        assert!(demuxer
            .probe()
            .tracks
            .iter()
            .any(|track| track.codec == MediaCodec::Vp9));
        let opus = demuxer
            .probe()
            .tracks
            .iter()
            .find(|track| track.codec == MediaCodec::Opus)
            .expect("Opus track");
        assert!(opus.codec_private.starts_with(b"OpusHead"));

        let mut packet_count = 0;
        while demuxer.next_packet().expect("WebM packet").is_some() {
            packet_count += 1;
        }
        assert_eq!(packet_count, 4);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn matroska_mux_preserves_h264_reordered_timestamps() {
        let path = temp_path("mkv");
        let mut muxer = MatroskaMuxer::create(&path).expect("create Matroska");
        let time_base = MediaTimeBase::new(1, 1000).expect("time base");
        let track = MediaTrack {
            id: 1,
            kind: MediaTrackKind::Video,
            codec: MediaCodec::H264,
            time_base,
            language: None,
            video: Some(VideoParameters {
                width: 640,
                height: 360,
                frame_rate: Some(25.0),
                bitrate_bps: None,
            }),
            audio: None,
            codec_private: vec![
                1, 66, 0, 30, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68,
            ],
        };
        let id = muxer.add_track(&track).expect("H264 track");
        for (pts, dts, keyframe, data) in [
            (0, 0, true, &b"I"[..]),
            (80, 40, false, &b"P"[..]),
            (40, 80, false, &b"B"[..]),
        ] {
            muxer
                .write_packet(&MediaPacket {
                    track_id: id,
                    pts: Some(timestamp(pts, time_base)),
                    dts: Some(timestamp(dts, time_base)),
                    duration: Some(timestamp(40, time_base)),
                    flags: MediaPacketFlags {
                        keyframe,
                        ..Default::default()
                    },
                    data: data.to_vec(),
                })
                .expect("write Matroska packet");
        }
        muxer.finalize().expect("finalize Matroska");

        let mut demuxer =
            MatroskaDemuxer::open_for_mp4_remux(&path).expect("Matroska remux reader");
        let mut pts = Vec::new();
        let mut dts = Vec::new();
        while let Some(packet) = demuxer.next_packet().expect("Matroska packet") {
            pts.push(packet.pts.expect("pts").value);
            dts.push(packet.dts.expect("dts").value);
        }
        assert_eq!(pts, vec![0, 80_000_000, 40_000_000]);
        assert_eq!(dts, vec![0, 40_000_000, 80_000_000]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_truncated_explicit_aac_sampling_frequency() {
        let error = validate_aac_asc(&[0x17, 0x80])
            .expect_err("explicit AAC sampling frequency must contain 24 bits");
        assert!(matches!(error, MediaProcessingError::Mux(_)));
    }

    #[test]
    fn matroska_mux_extracts_aac_asc_from_esds() {
        let asc = vec![0x11, 0x90];
        let decoder_specific = test_descriptor(0x05, asc.clone());
        let mut decoder_config = vec![0x40, 0x15, 0, 0, 0];
        decoder_config.extend_from_slice(&0_u32.to_be_bytes());
        decoder_config.extend_from_slice(&0_u32.to_be_bytes());
        decoder_config.extend_from_slice(&decoder_specific);
        let decoder_config = test_descriptor(0x04, decoder_config);
        let sl = test_descriptor(0x06, vec![2]);
        let mut es = vec![0, 1, 0];
        es.extend_from_slice(&decoder_config);
        es.extend_from_slice(&sl);
        let mut esds = vec![0, 0, 0, 0];
        esds.extend_from_slice(&test_descriptor(0x03, es));

        assert_eq!(normalize_aac_private(&esds).expect("AAC ASC"), asc);
    }

    fn test_descriptor(tag: u8, payload: Vec<u8>) -> Vec<u8> {
        assert!(payload.len() < 128);
        let mut result = vec![tag, payload.len() as u8];
        result.extend_from_slice(&payload);
        result
    }
}
