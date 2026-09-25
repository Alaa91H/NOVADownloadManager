use std::fs::{self, File};
use std::path::{Path, PathBuf};

use mp4_track::{
    Mp4Reader, Mp4Writer, SampleInfo, SampleInput, Track, TrackConfig, TrackId, TrackKind,
    WriterConfig,
};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeMuxResult {
    pub destination: PathBuf,
    pub bytes: u64,
    pub video_samples: u32,
    pub audio_samples: u32,
}

#[derive(Debug, Error)]
pub enum NativeMuxError {
    #[error("native MP4 muxing was cancelled")]
    Cancelled,
    #[error("native MP4 muxing I/O failed: {0}")]
    Io(String),
    #[error("native MP4 container parse/write failed: {0}")]
    Container(String),
    #[error("native MP4 muxing requires exactly one {0} track")]
    TrackSelection(&'static str),
    #[error("native MP4 muxing does not support changing sample descriptions")]
    MultipleSampleDescriptions,
    #[error("native MP4 composition offset is outside the supported i32 range")]
    CompositionOffsetOverflow,
    #[error("native MP4 sample duration must be greater than zero")]
    ZeroDuration,
}

pub fn mux_mp4_tracks(
    video_path: &Path,
    audio_path: &Path,
    destination: &Path,
) -> Result<NativeMuxResult, NativeMuxError> {
    mux_mp4_tracks_controlled(video_path, audio_path, destination, || false)
}

pub fn mux_mp4_tracks_controlled<F>(
    video_path: &Path,
    audio_path: &Path,
    destination: &Path,
    should_cancel: F,
) -> Result<NativeMuxResult, NativeMuxError>
where
    F: Fn() -> bool,
{
    if should_cancel() {
        return Err(NativeMuxError::Cancelled);
    }

    let video_file = File::open(video_path).map_err(|error| {
        NativeMuxError::Io(format!(
            "could not open video track '{}': {error}",
            video_path.display()
        ))
    })?;
    let audio_file = File::open(audio_path).map_err(|error| {
        NativeMuxError::Io(format!(
            "could not open audio track '{}': {error}",
            audio_path.display()
        ))
    })?;

    let mut video_reader =
        Mp4Reader::open(video_file).map_err(|error| NativeMuxError::Container(error.to_string()))?;
    let mut audio_reader =
        Mp4Reader::open(audio_file).map_err(|error| NativeMuxError::Container(error.to_string()))?;

    let video_track = select_single_track(&video_reader, TrackKind::Video, "video")?;
    let audio_track = select_single_track(&audio_reader, TrackKind::Audio, "audio")?;

    validate_sample_descriptions(&video_reader, video_track.id)?;
    validate_sample_descriptions(&audio_reader, audio_track.id)?;

    if let Some(parent) = destination.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| NativeMuxError::Io(error.to_string()))?;
    }

    let temp = append_suffix(destination, ".nova-native-mux.tmp");
    let _ = fs::remove_file(&temp);

    let result = mux_into_file(
        &mut video_reader,
        &video_track,
        &mut audio_reader,
        &audio_track,
        &temp,
        &should_cancel,
    );

    let (video_samples, audio_samples) = match result {
        Ok(samples) => samples,
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    };

    if should_cancel() {
        let _ = fs::remove_file(&temp);
        return Err(NativeMuxError::Cancelled);
    }

    let bytes = fs::metadata(&temp)
        .map_err(|error| NativeMuxError::Io(error.to_string()))?
        .len();
    if bytes == 0 {
        let _ = fs::remove_file(&temp);
        return Err(NativeMuxError::Container(
            "native MP4 muxer produced an empty output".to_owned(),
        ));
    }

    if destination.exists() {
        fs::remove_file(destination).map_err(|error| NativeMuxError::Io(error.to_string()))?;
    }
    fs::rename(&temp, destination).map_err(|error| NativeMuxError::Io(error.to_string()))?;

    Ok(NativeMuxResult {
        destination: destination.to_path_buf(),
        bytes,
        video_samples,
        audio_samples,
    })
}

fn mux_into_file<F>(
    video_reader: &mut Mp4Reader<File>,
    video_track: &Track,
    audio_reader: &mut Mp4Reader<File>,
    audio_track: &Track,
    output: &Path,
    should_cancel: &F,
) -> Result<(u32, u32), NativeMuxError>
where
    F: Fn() -> bool,
{
    let output_file = File::create(output).map_err(|error| NativeMuxError::Io(error.to_string()))?;
    let mut writer = Mp4Writer::new(output_file, WriterConfig::default())
        .map_err(|error| NativeMuxError::Container(error.to_string()))?;

    let video_output_id = writer
        .add_track(track_config(video_track))
        .map_err(|error| NativeMuxError::Container(error.to_string()))?;
    let audio_output_id = writer
        .add_track(track_config(audio_track))
        .map_err(|error| NativeMuxError::Container(error.to_string()))?;

    let mut video_index = 0_u32;
    let mut audio_index = 0_u32;
    let mut video_buffer = Vec::new();
    let mut audio_buffer = Vec::new();

    while video_index < video_track.sample_count || audio_index < audio_track.sample_count {
        if should_cancel() {
            return Err(NativeMuxError::Cancelled);
        }

        let video_info = if video_index < video_track.sample_count {
            Some(
                video_reader
                    .sample_info(video_track.id, video_index)
                    .map_err(|error| NativeMuxError::Container(error.to_string()))?,
            )
        } else {
            None
        };
        let audio_info = if audio_index < audio_track.sample_count {
            Some(
                audio_reader
                    .sample_info(audio_track.id, audio_index)
                    .map_err(|error| NativeMuxError::Container(error.to_string()))?,
            )
        } else {
            None
        };

        let write_video = match (video_info, audio_info) {
            (Some(video), Some(audio)) => {
                sample_time_le(video, video_track.timescale, audio, audio_track.timescale)
            }
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };

        if write_video {
            let info = video_reader
                .read_sample_into(video_track.id, video_index, &mut video_buffer)
                .map_err(|error| NativeMuxError::Container(error.to_string()))?;
            write_sample(&mut writer, video_output_id, &video_buffer, info)?;
            video_index = video_index.saturating_add(1);
        } else {
            let info = audio_reader
                .read_sample_into(audio_track.id, audio_index, &mut audio_buffer)
                .map_err(|error| NativeMuxError::Container(error.to_string()))?;
            write_sample(&mut writer, audio_output_id, &audio_buffer, info)?;
            audio_index = audio_index.saturating_add(1);
        }
    }

    let output_file = writer
        .finish()
        .map_err(|error| NativeMuxError::Container(error.to_string()))?;
    output_file
        .sync_all()
        .map_err(|error| NativeMuxError::Io(error.to_string()))?;

    Ok((video_index, audio_index))
}

fn track_config(track: &Track) -> TrackConfig {
    TrackConfig {
        kind: track.kind,
        timescale: track.timescale,
        language: track.language.clone(),
        handler_name: track.handler_name.clone(),
        codec: track.codec.clone(),
        width: track.width,
        height: track.height,
        edit_list: track.edit_list.clone(),
    }
}

fn select_single_track(
    reader: &Mp4Reader<File>,
    kind: TrackKind,
    label: &'static str,
) -> Result<Track, NativeMuxError> {
    let mut matching = reader.tracks().iter().filter(|track| track.kind == kind);
    let track = matching
        .next()
        .cloned()
        .ok_or(NativeMuxError::TrackSelection(label))?;
    if matching.next().is_some() {
        return Err(NativeMuxError::TrackSelection(label));
    }
    Ok(track)
}

fn validate_sample_descriptions(
    reader: &Mp4Reader<File>,
    track_id: TrackId,
) -> Result<(), NativeMuxError> {
    for sample in reader
        .samples(track_id)
        .map_err(|error| NativeMuxError::Container(error.to_string()))?
    {
        if sample.description_index != 1 {
            return Err(NativeMuxError::MultipleSampleDescriptions);
        }
        if sample.duration == 0 {
            return Err(NativeMuxError::ZeroDuration);
        }
        if i32::try_from(sample.cts_offset).is_err() {
            return Err(NativeMuxError::CompositionOffsetOverflow);
        }
    }
    Ok(())
}

fn write_sample<W: std::io::Write + std::io::Seek>(
    writer: &mut Mp4Writer<W>,
    track_id: TrackId,
    buffer: &[u8],
    info: SampleInfo,
) -> Result<(), NativeMuxError> {
    let cts_offset =
        i32::try_from(info.cts_offset).map_err(|_| NativeMuxError::CompositionOffsetOverflow)?;
    if info.duration == 0 {
        return Err(NativeMuxError::ZeroDuration);
    }
    writer
        .write_sample(
            track_id,
            &SampleInput {
                data: buffer,
                duration: info.duration,
                cts_offset,
                is_sync: info.is_sync,
            },
        )
        .map_err(|error| NativeMuxError::Container(error.to_string()))
}

fn sample_time_le(
    left: SampleInfo,
    left_timescale: u32,
    right: SampleInfo,
    right_timescale: u32,
) -> bool {
    (left.dts as u128) * (right_timescale as u128)
        <= (right.dts as u128) * (left_timescale as u128)
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(dts: u64) -> SampleInfo {
        SampleInfo {
            index: 0,
            offset: 0,
            size: 1,
            dts,
            cts_offset: 0,
            pts: i64::try_from(dts).unwrap_or(i64::MAX),
            duration: 1,
            is_sync: true,
            chunk: 0,
            description_index: 1,
        }
    }

    #[test]
    fn interleave_order_uses_track_timescales_without_float_rounding() {
        assert!(sample_time_le(sample(45_000), 90_000, sample(24_000), 48_000));
        assert!(sample_time_le(sample(90_000), 90_000, sample(48_000), 48_000));
        assert!(!sample_time_le(sample(90_001), 90_000, sample(48_000), 48_000));
    }

    #[test]
    fn temp_path_stays_next_to_destination() {
        assert_eq!(
            append_suffix(Path::new("movie.mp4"), ".nova-native-mux.tmp"),
            PathBuf::from("movie.mp4.nova-native-mux.tmp")
        );
    }

    #[test]
    fn cancellation_happens_before_input_open() {
        let error = mux_mp4_tracks_controlled(
            Path::new("missing-video.mp4"),
            Path::new("missing-audio.m4a"),
            Path::new("out.mp4"),
            || true,
        )
        .expect_err("cancel before I/O");
        assert!(matches!(error, NativeMuxError::Cancelled));
    }
}
