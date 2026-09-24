use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::{
    MediaCodec, MediaDemuxer, MediaMuxResult, MediaMuxer, MediaPacket,
    MediaProcessingControl, MediaProcessingError, MediaTimeBase, MediaTrack,
    MediaTrackKind, MediaTimestamp,
};

const MOVIE_TIMESCALE: u32 = 1000;
const MAX_SAMPLES_PER_TRACK: usize = 10_000_000;
const MAX_TRACKS: usize = 64;

#[derive(Clone, Debug)]
struct WrittenSample {
    offset: u64,
    size: u32,
    dts: i64,
    pts: i64,
    duration: u32,
    keyframe: bool,
}

#[derive(Clone, Debug)]
struct OutputTrack {
    track: MediaTrack,
    samples: Vec<WrittenSample>,
}

pub struct Mp4Muxer {
    destination: PathBuf,
    temporary: PathBuf,
    file: Option<File>,
    mdat_offset: u64,
    tracks: BTreeMap<u32, OutputTrack>,
    next_track_id: u32,
    packets_written: u64,
    finalized: bool,
}

impl Mp4Muxer {
    pub fn create(destination: &Path) -> Result<Self, MediaProcessingError> {
        if let Some(parent) = destination.parent().filter(|path| !path.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(io_error)?;
        }

        let temporary = append_suffix(destination, ".nova-mp4.tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&temporary)
            .map_err(io_error)?;

        let ftyp = make_ftyp();
        file.write_all(&ftyp).map_err(io_error)?;
        let mdat_offset = file.stream_position().map_err(io_error)?;

        // Reserve an extended-size mdat header so files above 4 GiB remain valid
        // without relocating any already-written samples.
        file.write_all(&1_u32.to_be_bytes()).map_err(io_error)?;
        file.write_all(b"mdat").map_err(io_error)?;
        file.write_all(&0_u64.to_be_bytes()).map_err(io_error)?;

        Ok(Self {
            destination: destination.to_path_buf(),
            temporary,
            file: Some(file),
            mdat_offset,
            tracks: BTreeMap::new(),
            next_track_id: 1,
            packets_written: 0,
            finalized: false,
        })
    }

    fn file_mut(&mut self) -> Result<&mut File, MediaProcessingError> {
        self.file
            .as_mut()
            .ok_or_else(|| mux_error("MP4 muxer output is already closed"))
    }

    fn track_mut(&mut self, track_id: u32) -> Result<&mut OutputTrack, MediaProcessingError> {
        self.tracks
            .get_mut(&track_id)
            .ok_or_else(|| mux_error(format!("packet references unknown output track {track_id}")))
    }
}

impl MediaMuxer for Mp4Muxer {
    fn add_track(&mut self, track: &MediaTrack) -> Result<u32, MediaProcessingError> {
        if self.finalized {
            return Err(mux_error("cannot add a track after MP4 finalization"));
        }
        if self.packets_written != 0 {
            return Err(mux_error(
                "all MP4 tracks must be registered before writing packets",
            ));
        }
        if self.tracks.len() >= MAX_TRACKS {
            return Err(mux_error(format!(
                "MP4 output exceeds track safety limit {MAX_TRACKS}"
            )));
        }

        validate_track(track)?;

        let track_id = self.next_track_id;
        self.next_track_id = self
            .next_track_id
            .checked_add(1)
            .ok_or_else(|| mux_error("MP4 track id overflow"))?;

        let mut output_track = track.clone();
        output_track.id = track_id;
        self.tracks.insert(
            track_id,
            OutputTrack {
                track: output_track,
                samples: Vec::new(),
            },
        );
        Ok(track_id)
    }

    fn write_packet(&mut self, packet: &MediaPacket) -> Result<(), MediaProcessingError> {
        if self.finalized {
            return Err(mux_error("cannot write a packet after MP4 finalization"));
        }
        if packet.data.is_empty() {
            return Err(mux_error("MP4 packet payload must not be empty"));
        }
        if packet.flags.corrupted {
            return Err(mux_error("corrupted packets are rejected by the MP4 muxer"));
        }
        if packet.flags.discontinuity {
            return Err(MediaProcessingError::UnsupportedOperation(
                "MP4 discontinuities require edit-list/timeline handling".to_owned(),
            ));
        }

        let packet_size = u32::try_from(packet.data.len())
            .map_err(|_| mux_error("MP4 packet exceeds 32-bit sample size"))?;

        let (track_time_base, previous_sample_count, expected_dts) = {
            let track = self
                .tracks
                .get(&packet.track_id)
                .ok_or_else(|| {
                    mux_error(format!(
                        "packet references unknown output track {}",
                        packet.track_id
                    ))
                })?;
            let expected_dts = track
                .samples
                .last()
                .map(|sample| {
                    sample
                        .dts
                        .checked_add(i64::from(sample.duration))
                        .ok_or_else(|| mux_error("MP4 DTS overflow"))
                })
                .transpose()?;
            (track.track.time_base, track.samples.len(), expected_dts)
        };

        if previous_sample_count >= MAX_SAMPLES_PER_TRACK {
            return Err(mux_error(format!(
                "MP4 track {} exceeds sample safety limit {MAX_SAMPLES_PER_TRACK}",
                packet.track_id
            )));
        }

        let dts = required_timestamp(packet.dts, "DTS", track_time_base)?;
        let pts = optional_timestamp(packet.pts, dts, "PTS", track_time_base)?;
        let composition_offset = pts
            .checked_sub(dts)
            .ok_or_else(|| mux_error("MP4 composition timestamp overflow"))?;
        if composition_offset < i64::from(i32::MIN)
            || composition_offset > i64::from(u32::MAX)
        {
            return Err(MediaProcessingError::UnsupportedOperation(
                "MP4 composition offset exceeds ctts v0/v1 range".to_owned(),
            ));
        }
        let duration = required_duration(packet.duration, track_time_base)?;

        if previous_sample_count == 0 && dts != 0 {
            return Err(MediaProcessingError::UnsupportedOperation(
                "MP4 muxing currently requires each track DTS timeline to begin at zero"
                    .to_owned(),
            ));
        }
        if let Some(expected) = expected_dts {
            if dts != expected {
                return Err(MediaProcessingError::UnsupportedOperation(format!(
                    "MP4 muxing currently requires contiguous DTS; expected {expected}, got {dts}"
                )));
            }
        }

        let offset = self.file_mut()?.stream_position().map_err(io_error)?;
        self.file_mut()?.write_all(&packet.data).map_err(io_error)?;

        self.track_mut(packet.track_id)?.samples.push(WrittenSample {
            offset,
            size: packet_size,
            dts,
            pts,
            duration,
            keyframe: packet.flags.keyframe,
        });

        self.packets_written = self
            .packets_written
            .checked_add(1)
            .ok_or_else(|| mux_error("MP4 packet counter overflow"))?;
        Ok(())
    }

    fn finalize(&mut self) -> Result<MediaMuxResult, MediaProcessingError> {
        if self.finalized {
            return Err(mux_error("MP4 muxer was already finalized"));
        }
        if self.tracks.is_empty() {
            return Err(mux_error("MP4 output requires at least one track"));
        }
        if self.tracks.values().any(|track| track.samples.is_empty()) {
            return Err(mux_error("every registered MP4 track must contain samples"));
        }

        let mdat_end = self.file_mut()?.stream_position().map_err(io_error)?;
        let mdat_size = mdat_end
            .checked_sub(self.mdat_offset)
            .ok_or_else(|| mux_error("invalid MP4 mdat position"))?;

        let extended_size_offset = self
            .mdat_offset
            .checked_add(8)
            .ok_or_else(|| mux_error("MP4 mdat header offset overflow"))?;
        self.file_mut()?
            .seek(SeekFrom::Start(extended_size_offset))
            .map_err(io_error)?;
        self.file_mut()?
            .write_all(&mdat_size.to_be_bytes())
            .map_err(io_error)?;
        self.file_mut()?
            .seek(SeekFrom::Start(mdat_end))
            .map_err(io_error)?;

        let moov = make_moov(&self.tracks, self.next_track_id)?;
        self.file_mut()?.write_all(&moov).map_err(io_error)?;
        self.file_mut()?.flush().map_err(io_error)?;
        self.file_mut()?.sync_all().map_err(io_error)?;

        let final_bytes = self
            .file_mut()?
            .metadata()
            .map_err(io_error)?
            .len();

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
                .map_err(|_| mux_error("MP4 track count overflow"))?,
        })
    }
}

impl Drop for Mp4Muxer {
    fn drop(&mut self) {
        if !self.finalized {
            drop(self.file.take());
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

/// Packet-preserving native merge/remux into MP4.
///
/// Each input demuxer gets an independent source->destination track-id map, so
/// separate media files may safely reuse source track ids (for example both
/// video.mp4 and audio.m4a using track id 1).
pub fn mux_demuxers_to_mp4(
    destination: &Path,
    demuxers: &mut [&mut dyn MediaDemuxer],
) -> Result<MediaMuxResult, MediaProcessingError> {
    mux_demuxers_to_mp4_controlled(
        destination,
        demuxers,
        || MediaProcessingControl::Continue,
        |_| {},
    )
}

pub fn mux_demuxers_to_mp4_controlled<C, P>(
    destination: &Path,
    demuxers: &mut [&mut dyn MediaDemuxer],
    control: C,
    progress: P,
) -> Result<MediaMuxResult, MediaProcessingError>
where
    C: Fn() -> MediaProcessingControl,
    P: Fn(u64),
{
    if demuxers.is_empty() {
        return Err(mux_error("MP4 merge requires at least one input demuxer"));
    }

    let mut muxer = Mp4Muxer::create(destination)?;
    let mut mappings = Vec::with_capacity(demuxers.len());

    for demuxer in demuxers.iter() {
        let mut map = BTreeMap::new();
        for track in &demuxer.probe().tracks {
            let output_id = muxer.add_track(track)?;
            map.insert(track.id, output_id);
        }
        mappings.push(map);
    }

    let mut processed_bytes = 0_u64;
    for (index, demuxer) in demuxers.iter_mut().enumerate() {
        loop {
            match control() {
                MediaProcessingControl::Continue => {}
                MediaProcessingControl::Pause => return Err(MediaProcessingError::Paused),
                MediaProcessingControl::Cancel => return Err(MediaProcessingError::Cancelled),
            }
            let Some(mut packet) = demuxer.next_packet()? else {
                break;
            };
            let output_id = mappings[index].get(&packet.track_id).copied().ok_or_else(|| {
                mux_error(format!(
                    "input demuxer emitted unregistered track {}",
                    packet.track_id
                ))
            })?;
            packet.track_id = output_id;
            processed_bytes = processed_bytes
                .checked_add(packet.data.len() as u64)
                .ok_or_else(|| mux_error("MP4 processing byte counter overflow"))?;
            muxer.write_packet(&packet)?;
            progress(processed_bytes);
        }
    }

    match control() {
        MediaProcessingControl::Continue => muxer.finalize(),
        MediaProcessingControl::Pause => Err(MediaProcessingError::Paused),
        MediaProcessingControl::Cancel => Err(MediaProcessingError::Cancelled),
    }
}

fn validate_track(track: &MediaTrack) -> Result<(), MediaProcessingError> {
    if track.time_base.numerator != 1 || track.time_base.denominator == 0 {
        return Err(MediaProcessingError::UnsupportedOperation(
            "MP4 muxer currently requires a 1/timescale media time base".to_owned(),
        ));
    }

    match track.kind {
        MediaTrackKind::Video => validate_video_track(track),
        MediaTrackKind::Audio => validate_audio_track(track),
        MediaTrackKind::Subtitle | MediaTrackKind::Data => Err(
            MediaProcessingError::UnsupportedOperation(
                "MP4 subtitle/data muxing is not implemented yet".to_owned(),
            ),
        ),
    }
}

fn validate_video_track(track: &MediaTrack) -> Result<(), MediaProcessingError> {
    let video = track
        .video
        .as_ref()
        .ok_or_else(|| mux_error("video track is missing video parameters"))?;
    if video.width == 0 || video.height == 0 || video.width > u16::MAX as u32 || video.height > u16::MAX as u32 {
        return Err(mux_error("video dimensions are invalid for MP4 sample entry"));
    }

    match &track.codec {
        MediaCodec::H264
        | MediaCodec::Hevc
        | MediaCodec::Av1
        | MediaCodec::Vp9
        | MediaCodec::Vp8 => {
            if track.codec_private.is_empty() {
                return Err(mux_error(format!(
                    "{} video track is missing codec configuration",
                    codec_name(&track.codec)
                )));
            }
            Ok(())
        }
        _ => Err(MediaProcessingError::UnsupportedCodec(codec_name(&track.codec))),
    }
}

fn validate_audio_track(track: &MediaTrack) -> Result<(), MediaProcessingError> {
    let audio = track
        .audio
        .as_ref()
        .ok_or_else(|| mux_error("audio track is missing audio parameters"))?;
    if audio.channels == 0 || audio.sample_rate_hz == 0 || audio.sample_rate_hz > u16::MAX as u32 {
        return Err(mux_error("audio parameters are invalid for MP4 sample entry"));
    }

    match &track.codec {
        MediaCodec::Aac | MediaCodec::Opus => {
            if track.codec_private.is_empty() {
                return Err(mux_error(format!(
                    "{} audio track is missing codec configuration",
                    codec_name(&track.codec)
                )));
            }
            Ok(())
        }
        MediaCodec::Mp3 => Ok(()),
        _ => Err(MediaProcessingError::UnsupportedCodec(codec_name(&track.codec))),
    }
}

fn required_timestamp(
    timestamp: Option<MediaTimestamp>,
    name: &str,
    expected: MediaTimeBase,
) -> Result<i64, MediaProcessingError> {
    let timestamp = timestamp.ok_or_else(|| mux_error(format!("MP4 packet is missing {name}")))?;
    if timestamp.time_base != expected {
        return Err(mux_error(format!(
            "MP4 packet {name} time base does not match its track"
        )));
    }
    if timestamp.value < 0 {
        return Err(MediaProcessingError::UnsupportedOperation(format!(
            "negative MP4 packet {name} requires edit-list timeline handling"
        )));
    }
    Ok(timestamp.value)
}

fn optional_timestamp(
    timestamp: Option<MediaTimestamp>,
    fallback: i64,
    name: &str,
    expected: MediaTimeBase,
) -> Result<i64, MediaProcessingError> {
    match timestamp {
        Some(value) => {
            if value.time_base != expected {
                return Err(mux_error(format!(
                    "MP4 packet {name} time base does not match its track"
                )));
            }
            Ok(value.value)
        }
        None => Ok(fallback),
    }
}

fn required_duration(
    duration: Option<MediaTimestamp>,
    expected: MediaTimeBase,
) -> Result<u32, MediaProcessingError> {
    let duration = duration.ok_or_else(|| mux_error("MP4 packet is missing duration"))?;
    if duration.time_base != expected {
        return Err(mux_error(
            "MP4 packet duration time base does not match its track",
        ));
    }
    if duration.value <= 0 {
        return Err(mux_error("MP4 packet duration must be positive"));
    }
    u32::try_from(duration.value).map_err(|_| mux_error("MP4 packet duration exceeds u32"))
}

fn make_ftyp() -> Vec<u8> {
    let mut payload = Vec::with_capacity(20);
    payload.extend_from_slice(b"isom");
    payload.extend_from_slice(&0x0000_0200_u32.to_be_bytes());
    payload.extend_from_slice(b"isom");
    payload.extend_from_slice(b"iso6");
    payload.extend_from_slice(b"mp41");
    make_box(*b"ftyp", payload)
}

fn make_moov(
    tracks: &BTreeMap<u32, OutputTrack>,
    next_track_id: u32,
) -> Result<Vec<u8>, MediaProcessingError> {
    let movie_duration = tracks
        .values()
        .map(track_duration_movie_timescale)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .max()
        .unwrap_or(0);

    let mut payload = make_mvhd(movie_duration, next_track_id)?;
    for track in tracks.values() {
        payload.extend_from_slice(&make_trak(track)?);
    }
    Ok(make_box(*b"moov", payload))
}

fn make_mvhd(duration: u64, next_track_id: u32) -> Result<Vec<u8>, MediaProcessingError> {
    let mut body = Vec::with_capacity(108);
    body.extend_from_slice(&0_u64.to_be_bytes()); // creation_time
    body.extend_from_slice(&0_u64.to_be_bytes()); // modification_time
    body.extend_from_slice(&MOVIE_TIMESCALE.to_be_bytes());
    body.extend_from_slice(&duration.to_be_bytes());
    body.extend_from_slice(&0x0001_0000_u32.to_be_bytes()); // rate 1.0
    body.extend_from_slice(&0x0100_u16.to_be_bytes()); // volume 1.0
    body.extend_from_slice(&[0_u8; 10]);
    body.extend_from_slice(&unity_matrix());
    body.extend_from_slice(&[0_u8; 24]);
    body.extend_from_slice(&next_track_id.to_be_bytes());
    Ok(make_full_box(*b"mvhd", 1, 0, body))
}

fn make_trak(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let duration_movie = track_duration_movie_timescale(track)?;
    let payload = [make_tkhd(track, duration_movie)?, make_mdia(track)?].concat();
    Ok(make_box(*b"trak", payload))
}

fn make_tkhd(
    track: &OutputTrack,
    movie_duration: u64,
) -> Result<Vec<u8>, MediaProcessingError> {
    let mut body = Vec::with_capacity(92);
    body.extend_from_slice(&0_u64.to_be_bytes());
    body.extend_from_slice(&0_u64.to_be_bytes());
    body.extend_from_slice(&track.track.id.to_be_bytes());
    body.extend_from_slice(&0_u32.to_be_bytes());
    body.extend_from_slice(&movie_duration.to_be_bytes());
    body.extend_from_slice(&[0_u8; 8]);
    body.extend_from_slice(&0_i16.to_be_bytes()); // layer
    body.extend_from_slice(&0_i16.to_be_bytes()); // alternate group
    let volume = if track.track.kind == MediaTrackKind::Audio {
        0x0100_u16
    } else {
        0_u16
    };
    body.extend_from_slice(&volume.to_be_bytes());
    body.extend_from_slice(&0_u16.to_be_bytes());
    body.extend_from_slice(&unity_matrix());

    let (width, height) = track
        .track
        .video
        .as_ref()
        .map(|video| (video.width, video.height))
        .unwrap_or((0, 0));
    body.extend_from_slice(
        &width
            .checked_shl(16)
            .ok_or_else(|| mux_error("MP4 width fixed-point overflow"))?
            .to_be_bytes(),
    );
    body.extend_from_slice(
        &height
            .checked_shl(16)
            .ok_or_else(|| mux_error("MP4 height fixed-point overflow"))?
            .to_be_bytes(),
    );
    Ok(make_full_box(*b"tkhd", 1, 0x000007, body))
}

fn make_mdia(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    Ok(make_box(
        *b"mdia",
        [
            make_mdhd(track)?,
            make_hdlr(track.track.kind),
            make_minf(track)?,
        ]
        .concat(),
    ))
}

fn make_mdhd(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let duration = track_duration_media_timescale(track)?;
    let mut body = Vec::with_capacity(32);
    body.extend_from_slice(&0_u64.to_be_bytes());
    body.extend_from_slice(&0_u64.to_be_bytes());
    body.extend_from_slice(&track.track.time_base.denominator.to_be_bytes());
    body.extend_from_slice(&duration.to_be_bytes());
    body.extend_from_slice(&pack_language(track.track.language.as_deref()).to_be_bytes());
    body.extend_from_slice(&0_u16.to_be_bytes());
    Ok(make_full_box(*b"mdhd", 1, 0, body))
}

fn make_hdlr(kind: MediaTrackKind) -> Vec<u8> {
    let (handler, name): ([u8; 4], &[u8]) = match kind {
        MediaTrackKind::Video => (*b"vide", b"NOVA Video Handler\0"),
        MediaTrackKind::Audio => (*b"soun", b"NOVA Audio Handler\0"),
        MediaTrackKind::Subtitle => (*b"subt", b"NOVA Subtitle Handler\0"),
        MediaTrackKind::Data => (*b"meta", b"NOVA Data Handler\0"),
    };
    let mut body = Vec::new();
    body.extend_from_slice(&0_u32.to_be_bytes());
    body.extend_from_slice(&handler);
    body.extend_from_slice(&[0_u8; 12]);
    body.extend_from_slice(name);
    make_full_box(*b"hdlr", 0, 0, body)
}

fn make_minf(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let header = match track.track.kind {
        MediaTrackKind::Video => {
            let mut body = Vec::new();
            body.extend_from_slice(&0_u16.to_be_bytes());
            body.extend_from_slice(&[0_u8; 6]);
            make_full_box(*b"vmhd", 0, 1, body)
        }
        MediaTrackKind::Audio => make_full_box(*b"smhd", 0, 0, vec![0_u8; 4]),
        _ => {
            return Err(MediaProcessingError::UnsupportedOperation(
                "MP4 minf generation is only implemented for video/audio".to_owned(),
            ))
        }
    };

    Ok(make_box(
        *b"minf",
        [header, make_dinf(), make_stbl(track)?].concat(),
    ))
}

fn make_dinf() -> Vec<u8> {
    let url = make_full_box(*b"url ", 0, 1, Vec::new());
    let mut dref_body = 1_u32.to_be_bytes().to_vec();
    dref_body.extend_from_slice(&url);
    let dref = make_full_box(*b"dref", 0, 0, dref_body);
    make_box(*b"dinf", dref)
}

fn make_stbl(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let mut boxes = vec![
        make_stsd(&track.track)?,
        make_stts(track)?,
    ];

    if track.samples.iter().any(|sample| sample.pts != sample.dts) {
        boxes.push(make_ctts(track)?);
    }

    boxes.push(make_stsc());
    boxes.push(make_stsz(track)?);
    boxes.push(make_co64(track)?);

    if track.track.kind == MediaTrackKind::Video
        && track.samples.iter().any(|sample| !sample.keyframe)
    {
        boxes.push(make_stss(track)?);
    }

    Ok(make_box(*b"stbl", boxes.concat()))
}

fn make_stsd(track: &MediaTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let entry = match track.kind {
        MediaTrackKind::Video => make_video_sample_entry(track)?,
        MediaTrackKind::Audio => make_audio_sample_entry(track)?,
        _ => {
            return Err(MediaProcessingError::UnsupportedOperation(
                "MP4 stsd generation is only implemented for video/audio".to_owned(),
            ))
        }
    };
    let mut body = 1_u32.to_be_bytes().to_vec();
    body.extend_from_slice(&entry);
    Ok(make_full_box(*b"stsd", 0, 0, body))
}

fn make_video_sample_entry(track: &MediaTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let video = track
        .video
        .as_ref()
        .ok_or_else(|| mux_error("video sample entry is missing video parameters"))?;
    let width = u16::try_from(video.width).map_err(|_| mux_error("video width exceeds u16"))?;
    let height = u16::try_from(video.height).map_err(|_| mux_error("video height exceeds u16"))?;

    let (entry_kind, config_kind) = match &track.codec {
        MediaCodec::H264 => (*b"avc1", *b"avcC"),
        MediaCodec::Hevc => (*b"hvc1", *b"hvcC"),
        MediaCodec::Av1 => (*b"av01", *b"av1C"),
        MediaCodec::Vp9 => (*b"vp09", *b"vpcC"),
        MediaCodec::Vp8 => (*b"vp08", *b"vpcC"),
        _ => return Err(MediaProcessingError::UnsupportedCodec(codec_name(&track.codec))),
    };

    let mut payload = vec![0_u8; 6];
    payload.extend_from_slice(&1_u16.to_be_bytes()); // data_reference_index
    payload.extend_from_slice(&[0_u8; 16]);
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&height.to_be_bytes());
    payload.extend_from_slice(&0x0048_0000_u32.to_be_bytes());
    payload.extend_from_slice(&0x0048_0000_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&1_u16.to_be_bytes());
    payload.extend_from_slice(&[0_u8; 32]);
    payload.extend_from_slice(&0x0018_u16.to_be_bytes());
    payload.extend_from_slice(&0xffff_u16.to_be_bytes());
    payload.extend_from_slice(&make_box(config_kind, track.codec_private.clone()));

    Ok(make_box(entry_kind, payload))
}

fn make_audio_sample_entry(track: &MediaTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let audio = track
        .audio
        .as_ref()
        .ok_or_else(|| mux_error("audio sample entry is missing audio parameters"))?;
    let sample_rate = u16::try_from(audio.sample_rate_hz)
        .map_err(|_| mux_error("audio sample rate exceeds classic MP4 sample entry"))?;

    let (entry_kind, config) = match &track.codec {
        MediaCodec::Aac => (
            *b"mp4a",
            Some(make_box(*b"esds", track.codec_private.clone())),
        ),
        MediaCodec::Opus => (
            *b"Opus",
            Some(make_box(*b"dOps", track.codec_private.clone())),
        ),
        MediaCodec::Mp3 => (*b".mp3", None),
        _ => return Err(MediaProcessingError::UnsupportedCodec(codec_name(&track.codec))),
    };

    let mut payload = vec![0_u8; 6];
    payload.extend_from_slice(&1_u16.to_be_bytes());
    payload.extend_from_slice(&[0_u8; 8]);
    payload.extend_from_slice(&audio.channels.to_be_bytes());
    payload.extend_from_slice(&16_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&(u32::from(sample_rate) << 16).to_be_bytes());
    if let Some(config) = config {
        payload.extend_from_slice(&config);
    }

    Ok(make_box(entry_kind, payload))
}

fn make_stts(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let runs = compress_u32_runs(track.samples.iter().map(|sample| sample.duration));
    let mut body = u32::try_from(runs.len())
        .map_err(|_| mux_error("stts run count overflow"))?
        .to_be_bytes()
        .to_vec();
    for (count, duration) in runs {
        body.extend_from_slice(&count.to_be_bytes());
        body.extend_from_slice(&duration.to_be_bytes());
    }
    Ok(make_full_box(*b"stts", 0, 0, body))
}

fn make_ctts(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let offsets = track.samples.iter().map(|sample| sample.pts - sample.dts);
    let runs = compress_i64_runs(offsets);
    let version = if runs.iter().any(|(_, offset)| *offset < 0) {
        1
    } else {
        0
    };

    let mut body = u32::try_from(runs.len())
        .map_err(|_| mux_error("ctts run count overflow"))?
        .to_be_bytes()
        .to_vec();
    for (count, offset) in runs {
        body.extend_from_slice(&count.to_be_bytes());
        if version == 0 {
            body.extend_from_slice(
                &u32::try_from(offset)
                    .map_err(|_| mux_error("positive composition offset exceeds u32"))?
                    .to_be_bytes(),
            );
        } else {
            body.extend_from_slice(
                &i32::try_from(offset)
                    .map_err(|_| mux_error("signed composition offset exceeds i32"))?
                    .to_be_bytes(),
            );
        }
    }
    Ok(make_full_box(*b"ctts", version, 0, body))
}

fn make_stsc() -> Vec<u8> {
    let mut body = 1_u32.to_be_bytes().to_vec();
    body.extend_from_slice(&1_u32.to_be_bytes()); // first_chunk
    body.extend_from_slice(&1_u32.to_be_bytes()); // samples_per_chunk
    body.extend_from_slice(&1_u32.to_be_bytes()); // sample_description_index
    make_full_box(*b"stsc", 0, 0, body)
}

fn make_stsz(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let mut body = 0_u32.to_be_bytes().to_vec();
    body.extend_from_slice(
        &u32::try_from(track.samples.len())
            .map_err(|_| mux_error("stsz sample count overflow"))?
            .to_be_bytes(),
    );
    for sample in &track.samples {
        body.extend_from_slice(&sample.size.to_be_bytes());
    }
    Ok(make_full_box(*b"stsz", 0, 0, body))
}

fn make_co64(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let mut body = u32::try_from(track.samples.len())
        .map_err(|_| mux_error("co64 chunk count overflow"))?
        .to_be_bytes()
        .to_vec();
    for sample in &track.samples {
        body.extend_from_slice(&sample.offset.to_be_bytes());
    }
    Ok(make_full_box(*b"co64", 0, 0, body))
}

fn make_stss(track: &OutputTrack) -> Result<Vec<u8>, MediaProcessingError> {
    let sync = track
        .samples
        .iter()
        .enumerate()
        .filter_map(|(index, sample)| sample.keyframe.then_some(index + 1))
        .collect::<Vec<_>>();
    let mut body = u32::try_from(sync.len())
        .map_err(|_| mux_error("stss sample count overflow"))?
        .to_be_bytes()
        .to_vec();
    for index in sync {
        body.extend_from_slice(
            &u32::try_from(index)
                .map_err(|_| mux_error("stss sample number overflow"))?
                .to_be_bytes(),
        );
    }
    Ok(make_full_box(*b"stss", 0, 0, body))
}

fn track_duration_media_timescale(track: &OutputTrack) -> Result<u64, MediaProcessingError> {
    track.samples.iter().try_fold(0_u64, |total, sample| {
        total
            .checked_add(u64::from(sample.duration))
            .ok_or_else(|| mux_error("MP4 track duration overflow"))
    })
}

fn track_duration_movie_timescale(track: &OutputTrack) -> Result<u64, MediaProcessingError> {
    let media_duration = track_duration_media_timescale(track)?;
    let timescale = u64::from(track.track.time_base.denominator);
    media_duration
        .checked_mul(u64::from(MOVIE_TIMESCALE))
        .map(|value| value / timescale)
        .ok_or_else(|| mux_error("MP4 movie duration overflow"))
}

fn compress_u32_runs<I>(values: I) -> Vec<(u32, u32)>
where
    I: IntoIterator<Item = u32>,
{
    let mut result = Vec::new();
    for value in values {
        match result.last_mut() {
            Some((count, existing)) if *existing == value && *count < u32::MAX => {
                *count += 1;
            }
            _ => result.push((1, value)),
        }
    }
    result
}

fn compress_i64_runs<I>(values: I) -> Vec<(u32, i64)>
where
    I: IntoIterator<Item = i64>,
{
    let mut result = Vec::new();
    for value in values {
        match result.last_mut() {
            Some((count, existing)) if *existing == value && *count < u32::MAX => {
                *count += 1;
            }
            _ => result.push((1, value)),
        }
    }
    result
}

fn make_full_box(kind: [u8; 4], version: u8, flags: u32, body: Vec<u8>) -> Vec<u8> {
    let mut payload = vec![
        version,
        ((flags >> 16) & 0xff) as u8,
        ((flags >> 8) & 0xff) as u8,
        (flags & 0xff) as u8,
    ];
    payload.extend_from_slice(&body);
    make_box(kind, payload)
}

fn make_box(kind: [u8; 4], payload: Vec<u8>) -> Vec<u8> {
    let regular_size = payload.len().checked_add(8);
    if let Some(size) = regular_size.and_then(|size| u32::try_from(size).ok()) {
        let mut result = Vec::with_capacity(size as usize);
        result.extend_from_slice(&size.to_be_bytes());
        result.extend_from_slice(&kind);
        result.extend_from_slice(&payload);
        result
    } else {
        let size = u64::try_from(payload.len())
            .unwrap_or(u64::MAX)
            .saturating_add(16);
        let mut result = Vec::with_capacity(payload.len().saturating_add(16));
        result.extend_from_slice(&1_u32.to_be_bytes());
        result.extend_from_slice(&kind);
        result.extend_from_slice(&size.to_be_bytes());
        result.extend_from_slice(&payload);
        result
    }
}

fn unity_matrix() -> [u8; 36] {
    let values = [
        0x0001_0000_i32,
        0,
        0,
        0,
        0x0001_0000,
        0,
        0,
        0,
        0x4000_0000,
    ];
    let mut result = [0_u8; 36];
    for (index, value) in values.into_iter().enumerate() {
        result[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    result
}

fn pack_language(language: Option<&str>) -> u16 {
    let language = language
        .filter(|value| value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
        .unwrap_or("und")
        .to_ascii_lowercase();
    let bytes = language.as_bytes();
    ((u16::from(bytes[0] - 0x60) & 0x1f) << 10)
        | ((u16::from(bytes[1] - 0x60) & 0x1f) << 5)
        | (u16::from(bytes[2] - 0x60) & 0x1f)
}

fn codec_name(codec: &MediaCodec) -> String {
    match codec {
        MediaCodec::H264 => "h264".to_owned(),
        MediaCodec::Hevc => "hevc".to_owned(),
        MediaCodec::Av1 => "av1".to_owned(),
        MediaCodec::Vp9 => "vp9".to_owned(),
        MediaCodec::Vp8 => "vp8".to_owned(),
        MediaCodec::Aac => "aac".to_owned(),
        MediaCodec::Opus => "opus".to_owned(),
        MediaCodec::Mp3 => "mp3".to_owned(),
        MediaCodec::Flac => "flac".to_owned(),
        MediaCodec::Pcm => "pcm".to_owned(),
        MediaCodec::Unknown(value) => value.clone(),
    }
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
        AudioParameters, MediaContainer, MediaDemuxer, MediaPacketFlags, MediaProbe,
        VideoParameters,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("nova-mux-{name}-{unique}.mp4"))
    }

    fn video_track(id: u32) -> MediaTrack {
        MediaTrack {
            id,
            kind: MediaTrackKind::Video,
            codec: MediaCodec::H264,
            time_base: MediaTimeBase::new(1, 1000).expect("time base"),
            language: None,
            video: Some(VideoParameters {
                width: 640,
                height: 360,
                frame_rate: Some(1.0),
                bitrate_bps: None,
            }),
            audio: None,
            codec_private: vec![1, 66, 0, 30],
        }
    }

    fn audio_track(id: u32) -> MediaTrack {
        MediaTrack {
            id,
            kind: MediaTrackKind::Audio,
            codec: MediaCodec::Aac,
            time_base: MediaTimeBase::new(1, 48_000).expect("time base"),
            language: Some("eng".to_owned()),
            video: None,
            audio: Some(AudioParameters {
                sample_rate_hz: 48_000,
                channels: 2,
                bitrate_bps: None,
            }),
            codec_private: vec![0, 0, 0, 0],
        }
    }

    fn packet(track_id: u32, time_base: MediaTimeBase, dts: i64, duration: i64, data: &[u8]) -> MediaPacket {
        MediaPacket {
            track_id,
            pts: Some(MediaTimestamp { value: dts, time_base }),
            dts: Some(MediaTimestamp { value: dts, time_base }),
            duration: Some(MediaTimestamp { value: duration, time_base }),
            flags: MediaPacketFlags {
                keyframe: true,
                discontinuity: false,
                corrupted: false,
            },
            data: data.to_vec(),
        }
    }

    #[test]
    fn writes_mp4_that_native_demuxer_reads_back() {
        let path = temp_path("roundtrip");
        let mut muxer = Mp4Muxer::create(&path).expect("muxer");
        let output_track = muxer.add_track(&video_track(99)).expect("track");
        assert_eq!(output_track, 1);

        let time_base = MediaTimeBase::new(1, 1000).expect("time base");
        muxer
            .write_packet(&packet(output_track, time_base, 0, 1000, b"AAAA"))
            .expect("packet 1");
        muxer
            .write_packet(&packet(output_track, time_base, 1000, 1000, b"BBBBB"))
            .expect("packet 2");
        let result = muxer.finalize().expect("finalize");
        assert_eq!(result.packets_written, 2);
        assert_eq!(result.tracks_written, 1);

        let mut demuxer = super::super::Mp4Demuxer::open(&path).expect("read back");
        assert_eq!(demuxer.probe().container, MediaContainer::Mp4);
        assert_eq!(demuxer.probe().tracks.len(), 1);
        assert_eq!(
            demuxer.next_packet().expect("first").expect("packet").data,
            b"AAAA"
        );
        assert_eq!(
            demuxer.next_packet().expect("second").expect("packet").data,
            b"BBBBB"
        );
        assert!(demuxer.next_packet().expect("end").is_none());

        let _ = fs::remove_file(path);
    }

    struct MemoryDemuxer {
        probe: MediaProbe,
        packets: std::collections::VecDeque<MediaPacket>,
    }

    impl MediaDemuxer for MemoryDemuxer {
        fn probe(&self) -> &MediaProbe {
            &self.probe
        }

        fn next_packet(&mut self) -> Result<Option<MediaPacket>, MediaProcessingError> {
            Ok(self.packets.pop_front())
        }
    }

    #[test]
    fn merges_inputs_with_colliding_source_track_ids() {
        let path = temp_path("merge");
        let video = video_track(1);
        let audio = audio_track(1);
        let mut video_demuxer = MemoryDemuxer {
            probe: MediaProbe {
                container: MediaContainer::Mp4,
                duration_millis: Some(1000),
                tracks: vec![video.clone()],
            },
            packets: [packet(1, video.time_base, 0, 1000, b"VID")]
                .into_iter()
                .collect(),
        };
        let mut audio_demuxer = MemoryDemuxer {
            probe: MediaProbe {
                container: MediaContainer::Mp4,
                duration_millis: Some(1000),
                tracks: vec![audio.clone()],
            },
            packets: [packet(1, audio.time_base, 0, 48_000, b"AUD")]
                .into_iter()
                .collect(),
        };

        let mut inputs: [&mut dyn MediaDemuxer; 2] =
            [&mut video_demuxer, &mut audio_demuxer];
        let result = mux_demuxers_to_mp4(&path, &mut inputs).expect("merge");
        assert_eq!(result.tracks_written, 2);

        let mut demuxer = super::super::Mp4Demuxer::open(&path).expect("merged file");
        assert_eq!(demuxer.probe().tracks.len(), 2);
        let mut payloads = Vec::new();
        while let Some(packet) = demuxer.next_packet().expect("packet") {
            payloads.push(packet.data);
        }
        assert_eq!(payloads, vec![b"VID".to_vec(), b"AUD".to_vec()]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn controlled_mux_pauses_before_consuming_the_next_packet() {
        let path = temp_path("controlled-pause");
        let video = video_track(1);
        let mut input = MemoryDemuxer {
            probe: MediaProbe {
                container: MediaContainer::Mp4,
                duration_millis: Some(1000),
                tracks: vec![video.clone()],
            },
            packets: [packet(1, video.time_base, 0, 1000, b"VIDEO")]
                .into_iter()
                .collect(),
        };
        let mut inputs: [&mut dyn MediaDemuxer; 1] = [&mut input];
        let error = mux_demuxers_to_mp4_controlled(
            &path,
            &mut inputs,
            || MediaProcessingControl::Pause,
            |_| panic!("paused mux must not publish progress"),
        )
        .expect_err("pause must interrupt mux");

        assert_eq!(error, MediaProcessingError::Paused);
        assert_eq!(input.packets.len(), 1, "packet must remain unread");
        assert!(!path.exists());
        assert!(!append_suffix(&path, ".nova-mp4.tmp").exists());
    }

    #[test]
    fn rejects_non_contiguous_dts_instead_of_silently_corrupting_timeline() {
        let path = temp_path("gap");
        let mut muxer = Mp4Muxer::create(&path).expect("muxer");
        let output_track = muxer.add_track(&video_track(1)).expect("track");
        let time_base = MediaTimeBase::new(1, 1000).expect("time base");
        muxer
            .write_packet(&packet(output_track, time_base, 0, 100, b"A"))
            .expect("first");
        let error = muxer
            .write_packet(&packet(output_track, time_base, 200, 100, b"B"))
            .expect_err("gap must fail");
        assert!(matches!(error, MediaProcessingError::UnsupportedOperation(_)));

        drop(muxer);
        assert!(!path.exists());
        assert!(!append_suffix(&path, ".nova-mp4.tmp").exists());
    }
}
