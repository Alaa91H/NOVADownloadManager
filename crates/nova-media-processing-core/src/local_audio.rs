use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

use crate::{
    MediaProcessingControl, MediaProcessingError, MediaProcessingPhase, MediaProcessingProgress,
    MediaProgressSink,
};

const WAV_MAX_DATA_BYTES: u64 = u32::MAX as u64 - 36;
const WAV_CHANNEL_LIMIT: usize = 2;
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeAudioTranscodeResult {
    pub output_bytes: u64,
    pub audio_frames: u64,
    pub sample_rate_hz: u32,
    pub channels: u16,
}

/// Decode one local audio stream and encode it as little-endian signed 16-bit
/// PCM in a RIFF/WAVE file. Decoding is performed in-process by the bundled
/// Symphonia codec implementations; no helper executable or network access is
/// used. The streaming writer bounds memory use to one decoded packet.
///
/// This first local encoder intentionally caps output at the RIFF/WAVE 4 GiB
/// limit and supports mono/stereo channel layouts. Other layouts fail closed
/// until NOVA writes WAVE_FORMAT_EXTENSIBLE channel maps.
pub fn transcode_audio_to_wav(
    source: &Path,
    destination: &Path,
    control: &(dyn Fn() -> MediaProcessingControl + Sync),
    progress: &dyn MediaProgressSink,
) -> Result<NativeAudioTranscodeResult, MediaProcessingError> {
    if !source.is_file() {
        return Err(MediaProcessingError::InvalidJob(format!(
            "audio source is not a regular file: {}",
            source.display()
        )));
    }
    let input = File::open(source).map_err(io_error)?;
    let source_bytes = input.metadata().map_err(io_error)?.len();
    if source_bytes == 0 {
        return Err(MediaProcessingError::InvalidJob(
            "audio source is empty".to_owned(),
        ));
    }

    let stream = MediaSourceStream::new(Box::new(input), Default::default());
    let probed = get_probe()
        .format(
            &Hint::new(),
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| MediaProcessingError::Probe(error.to_string()))?;
    let mut format = probed.format;
    let source_track = format
        .tracks()
        .iter()
        .find(|track| {
            track.codec_params.codec != CODEC_TYPE_NULL
                && track.codec_params.sample_rate.is_some()
                && track.codec_params.channels.is_some()
        })
        .ok_or_else(|| {
            MediaProcessingError::UnsupportedOperation(
                "the source has no locally decodable audio track".to_owned(),
            )
        })?;
    let track_id = source_track.id;
    let (sample_rate_hz, channels, total_frames) = audio_track_properties(source_track)?;
    let codec_parameters = source_track.codec_params.clone();
    let mut decoder = get_codecs()
        .make(&codec_parameters, &DecoderOptions::default())
        .map_err(|error| MediaProcessingError::UnsupportedCodec(error.to_string()))?;

    if destination.exists() && !destination.is_file() {
        return Err(MediaProcessingError::InvalidJob(format!(
            "audio destination is not a regular file: {}",
            destination.display()
        )));
    }
    if let Some(parent) = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let temporary = unique_sibling_path(destination, "audio-transcode");
    let mut temporary_guard = TemporaryFile::new(temporary.clone());
    let mut writer = WavPcm16Writer::create(&temporary, sample_rate_hz, channels)?;
    let mut audio_frames = 0_u64;
    let mut last_progress_units = 0_u64;
    progress.publish(&MediaProcessingProgress::new(
        MediaProcessingPhase::Decoding,
    ));

    loop {
        match control() {
            MediaProcessingControl::Continue => {}
            MediaProcessingControl::Pause => return Err(MediaProcessingError::Paused),
            MediaProcessingControl::Cancel => return Err(MediaProcessingError::Cancelled),
        }

        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(MediaProcessingError::UnsupportedOperation(
                    "the source changes audio stream parameters mid-file".to_owned(),
                ));
            }
            Err(error) => {
                return Err(MediaProcessingError::Demux(error.to_string()));
            }
        };
        if packet.track_id() != track_id {
            continue;
        }

        let decoded = decoder
            .decode(&packet)
            .map_err(|error| MediaProcessingError::Demux(error.to_string()))?;
        let spec = *decoded.spec();
        let decoded_channels = spec.channels.count();
        if spec.rate != sample_rate_hz || decoded_channels != usize::from(channels) {
            return Err(MediaProcessingError::UnsupportedOperation(
                "the decoded audio layout changes within the source".to_owned(),
            ));
        }
        let decoded_frames = decoded.frames() as u64;
        if decoded_frames == 0 {
            continue;
        }
        let mut interleaved = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        interleaved.copy_interleaved_ref(decoded);
        writer.write_interleaved(interleaved.samples())?;
        audio_frames = audio_frames
            .checked_add(decoded_frames)
            .ok_or_else(|| MediaProcessingError::Mux("audio frame count overflow".to_owned()))?;

        if audio_frames > last_progress_units {
            last_progress_units = audio_frames;
            let mut update = MediaProcessingProgress::new(MediaProcessingPhase::Encoding);
            update.completed_units = audio_frames;
            update.total_units = total_frames;
            update.fraction = total_frames
                .filter(|total| *total > 0)
                .map(|total| (audio_frames as f64 / total as f64).clamp(0.0, 1.0) as f32);
            progress.publish(&update);
        }
    }

    if audio_frames == 0 {
        return Err(MediaProcessingError::Demux(
            "the source did not produce any decoded audio frames".to_owned(),
        ));
    }
    if control() == MediaProcessingControl::Cancel {
        return Err(MediaProcessingError::Cancelled);
    }

    let output_bytes = writer.finish()?;
    drop(decoder);
    drop(format);
    commit_output(&temporary, destination)?;
    temporary_guard.disarm();

    let mut complete = MediaProcessingProgress::new(MediaProcessingPhase::Completed);
    complete.completed_units = audio_frames;
    complete.total_units = Some(audio_frames);
    complete.fraction = Some(1.0);
    progress.publish(&complete);

    Ok(NativeAudioTranscodeResult {
        output_bytes,
        audio_frames,
        sample_rate_hz,
        channels,
    })
}

fn audio_track_properties(track: &Track) -> Result<(u32, u16, Option<u64>), MediaProcessingError> {
    let sample_rate_hz = track.codec_params.sample_rate.ok_or_else(|| {
        MediaProcessingError::UnsupportedCodec(
            "the source audio track does not declare a sample rate".to_owned(),
        )
    })?;
    if sample_rate_hz == 0 {
        return Err(MediaProcessingError::UnsupportedCodec(
            "the source audio track declares a zero sample rate".to_owned(),
        ));
    }
    let channel_count = track
        .codec_params
        .channels
        .as_ref()
        .map(|channels| channels.count())
        .unwrap_or_default();
    if !(1..=WAV_CHANNEL_LIMIT).contains(&channel_count) {
        return Err(MediaProcessingError::UnsupportedOperation(format!(
            "local WAV encoding supports one or two channels; source has {channel_count}"
        )));
    }
    let channels = u16::try_from(channel_count).map_err(|_| {
        MediaProcessingError::UnsupportedCodec("invalid source channel count".to_owned())
    })?;
    Ok((sample_rate_hz, channels, track.codec_params.n_frames))
}

struct WavPcm16Writer {
    file: Option<File>,
    data_size_offset: u64,
    data_bytes: u64,
    channels: u16,
}

impl WavPcm16Writer {
    fn create(
        path: &Path,
        sample_rate_hz: u32,
        channels: u16,
    ) -> Result<Self, MediaProcessingError> {
        let block_align = channels
            .checked_mul(2)
            .ok_or_else(|| MediaProcessingError::Mux("WAVE block alignment overflow".to_owned()))?;
        let byte_rate = sample_rate_hz
            .checked_mul(u32::from(block_align))
            .ok_or_else(|| MediaProcessingError::Mux("WAVE byte rate overflow".to_owned()))?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .read(true)
            .open(path)
            .map_err(io_error)?;
        file.write_all(b"RIFF")
            .and_then(|_| file.write_all(&0_u32.to_le_bytes()))
            .and_then(|_| file.write_all(b"WAVEfmt "))
            .and_then(|_| file.write_all(&16_u32.to_le_bytes()))
            .and_then(|_| file.write_all(&1_u16.to_le_bytes()))
            .and_then(|_| file.write_all(&channels.to_le_bytes()))
            .and_then(|_| file.write_all(&sample_rate_hz.to_le_bytes()))
            .and_then(|_| file.write_all(&byte_rate.to_le_bytes()))
            .and_then(|_| file.write_all(&block_align.to_le_bytes()))
            .and_then(|_| file.write_all(&16_u16.to_le_bytes()))
            .and_then(|_| file.write_all(b"data"))
            .map_err(io_error)?;
        let data_size_offset = file.stream_position().map_err(io_error)?;
        file.write_all(&0_u32.to_le_bytes()).map_err(io_error)?;
        Ok(Self {
            file: Some(file),
            data_size_offset,
            data_bytes: 0,
            channels,
        })
    }

    fn write_interleaved(&mut self, samples: &[f32]) -> Result<(), MediaProcessingError> {
        let samples_per_frame = usize::from(self.channels);
        if samples.is_empty() || samples.len() % samples_per_frame != 0 {
            return Err(MediaProcessingError::Mux(
                "decoded PCM samples do not contain complete audio frames".to_owned(),
            ));
        }
        let chunk_bytes = u64::try_from(samples.len())
            .ok()
            .and_then(|count| count.checked_mul(2))
            .ok_or_else(|| MediaProcessingError::Mux("WAVE sample chunk overflow".to_owned()))?;
        let next_data_bytes = self
            .data_bytes
            .checked_add(chunk_bytes)
            .filter(|size| *size <= WAV_MAX_DATA_BYTES)
            .ok_or_else(|| {
                MediaProcessingError::UnsupportedOperation(
                    "RIFF/WAVE PCM output is limited to 4 GiB; RF64 is not enabled".to_owned(),
                )
            })?;

        let capacity = usize::try_from(chunk_bytes)
            .map_err(|_| MediaProcessingError::Mux("PCM chunk exceeds addressable memory".to_owned()))?;
        let mut bytes = Vec::with_capacity(capacity);
        for sample in samples {
            let sample = if sample.is_finite() { *sample } else { 0.0 }.clamp(-1.0, 1.0);
            let pcm = if sample <= -1.0 {
                i16::MIN
            } else {
                (sample * f32::from(i16::MAX)).round() as i16
            };
            bytes.extend_from_slice(&pcm.to_le_bytes());
        }
        self.file
            .as_mut()
            .ok_or_else(|| MediaProcessingError::Mux("WAVE writer is closed".to_owned()))?
            .write_all(&bytes)
            .map_err(io_error)?;
        self.data_bytes = next_data_bytes;
        Ok(())
    }

    fn finish(mut self) -> Result<u64, MediaProcessingError> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| MediaProcessingError::Mux("WAVE writer is closed".to_owned()))?;
        let riff_size = u32::try_from(36_u64 + self.data_bytes)
            .map_err(|_| MediaProcessingError::Mux("RIFF size exceeds its format limit".to_owned()))?;
        let data_size = u32::try_from(self.data_bytes)
            .map_err(|_| MediaProcessingError::Mux("WAVE data size exceeds its format limit".to_owned()))?;
        file.seek(SeekFrom::Start(4))
            .and_then(|_| file.write_all(&riff_size.to_le_bytes()))
            .and_then(|_| file.seek(SeekFrom::Start(self.data_size_offset)))
            .and_then(|_| file.write_all(&data_size.to_le_bytes()))
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(io_error)?;
        let output_bytes = file.metadata().map_err(io_error)?.len();
        self.file.take();
        Ok(output_bytes)
    }
}

struct TemporaryFile {
    path: PathBuf,
    armed: bool,
}

impl TemporaryFile {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn unique_sibling_path(destination: &Path, tag: &str) -> PathBuf {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("nova-audio");
    let suffix = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    parent.join(format!("{stem}.nova-{tag}-{}-{suffix}.tmp", std::process::id()))
}

fn commit_output(temporary: &Path, destination: &Path) -> Result<(), MediaProcessingError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty());
    if let Some(parent) = parent {
        fs::create_dir_all(parent).map_err(io_error)?;
    }

    if !destination.exists() {
        return fs::rename(temporary, destination).map_err(io_error);
    }

    let backup = unique_sibling_path(destination, "audio-backup");
    fs::rename(destination, &backup).map_err(|error| {
        MediaProcessingError::Io(format!("could not preserve the original media file: {error}"))
    })?;
    if let Err(error) = fs::rename(temporary, destination) {
        if let Err(restore_error) = fs::rename(&backup, destination) {
            return Err(MediaProcessingError::Io(format!(
                "could not commit decoded audio ({error}) or restore the original ({restore_error}); original remains at {}",
                backup.display()
            )));
        }
        return Err(MediaProcessingError::Io(format!(
            "could not commit decoded audio: {error}"
        )));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn io_error(error: std::io::Error) -> MediaProcessingError {
    MediaProcessingError::Io(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use super::*;

    fn temp_path(extension: &str) -> PathBuf {
        let unique = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nova-local-audio-{}-{unique}.{extension}",
            std::process::id()
        ))
    }

    fn write_mono_pcm_wav(path: &Path, samples: &[i16]) {
        let sample_bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        let mut file = File::create(path).expect("source WAV");
        file.write_all(b"RIFF").expect("RIFF");
        file.write_all(&(36_u32 + sample_bytes.len() as u32).to_le_bytes())
            .expect("RIFF size");
        file.write_all(b"WAVEfmt ").expect("WAVE fmt");
        file.write_all(&16_u32.to_le_bytes()).expect("fmt size");
        file.write_all(&1_u16.to_le_bytes()).expect("PCM");
        file.write_all(&1_u16.to_le_bytes()).expect("mono");
        file.write_all(&48_000_u32.to_le_bytes()).expect("sample rate");
        file.write_all(&96_000_u32.to_le_bytes()).expect("byte rate");
        file.write_all(&2_u16.to_le_bytes()).expect("block align");
        file.write_all(&16_u16.to_le_bytes()).expect("bits");
        file.write_all(b"data").expect("data chunk");
        file.write_all(&(sample_bytes.len() as u32).to_le_bytes())
            .expect("data size");
        file.write_all(&sample_bytes).expect("PCM samples");
    }

    #[test]
    fn local_pcm_decoder_writes_a_valid_wav_and_reports_completed_frames() {
        let source = temp_path("wav");
        let destination = temp_path("out.wav");
        write_mono_pcm_wav(&source, &[-32768, -16384, 0, 16384, 32767]);
        let updates = std::sync::Mutex::new(Vec::new());

        let result = transcode_audio_to_wav(
            &source,
            &destination,
            &|| MediaProcessingControl::Continue,
            &|update: &MediaProcessingProgress| updates.lock().expect("progress").push(update.clone()),
        )
        .expect("local audio conversion");

        let bytes = fs::read(&destination).expect("output WAV");
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1);
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().expect("sample rate")), 48_000);
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 16);
        assert_eq!(result.sample_rate_hz, 48_000);
        assert_eq!(result.channels, 1);
        assert_eq!(result.audio_frames, 5);
        assert_eq!(result.output_bytes, bytes.len() as u64);
        assert_eq!(updates.lock().expect("progress").last().map(|item| item.phase), Some(MediaProcessingPhase::Completed));

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(destination);
    }

    #[test]
    fn cancellation_preserves_an_existing_destination() {
        let source = temp_path("wav");
        let destination = temp_path("out.wav");
        write_mono_pcm_wav(&source, &[0, 1, -1]);
        fs::write(&destination, b"keep existing output").expect("existing output");

        let result = transcode_audio_to_wav(
            &source,
            &destination,
            &|| MediaProcessingControl::Cancel,
            &|_: &MediaProcessingProgress| {},
        );

        assert_eq!(result, Err(MediaProcessingError::Cancelled));
        assert_eq!(fs::read(&destination).expect("unchanged output"), b"keep existing output");

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(destination);
    }
}
