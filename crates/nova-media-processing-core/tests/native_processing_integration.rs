use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use nova_media_processing_core::{
    MediaProcessingControl, MediaProcessingProgress, NativeMediaTranscodeJob,
    transcode_local_media,
};

struct ScratchFiles(Vec<PathBuf>);

impl ScratchFiles {
    fn path(&mut self, label: &str, extension: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "nova-native-media-{label}-{}-{nonce}.{extension}",
            std::process::id()
        ));
        self.0.push(path.clone());
        path
    }
}

impl Drop for ScratchFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn write_test_wave(path: &Path) -> io::Result<()> {
    const SAMPLE_RATE: u32 = 16_000;
    const SAMPLE_COUNT: u32 = 3_200;
    let data_bytes = SAMPLE_COUNT * 2;
    let mut file = File::create(path)?;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + data_bytes).to_le_bytes())?;
    file.write_all(b"WAVEfmt ")?;
    file.write_all(&16_u32.to_le_bytes())?;
    file.write_all(&1_u16.to_le_bytes())?;
    file.write_all(&1_u16.to_le_bytes())?;
    file.write_all(&SAMPLE_RATE.to_le_bytes())?;
    file.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?;
    file.write_all(&2_u16.to_le_bytes())?;
    file.write_all(&16_u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_bytes.to_le_bytes())?;
    for index in 0..SAMPLE_COUNT {
        let phase = (index % 128) as i32;
        let sample = ((phase - 64).abs().saturating_sub(16) * 400) as i16;
        file.write_all(&sample.to_le_bytes())?;
    }
    Ok(())
}

fn write_test_y4m(path: &Path) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(b"YUV4MPEG2 W64 H64 F25:1 Ip A1:1 C420mpeg2\n")?;
    for frame in 0..6_u8 {
        file.write_all(b"FRAME\n")?;
        file.write_all(&vec![32 + frame * 24; 64 * 64])?;
        file.write_all(&[128; 32 * 32])?;
        file.write_all(&[128; 32 * 32])?;
    }
    Ok(())
}

fn default_job(
    source: PathBuf,
    destination: PathBuf,
    input_container: &str,
) -> NativeMediaTranscodeJob {
    NativeMediaTranscodeJob {
        source,
        destination,
        input_container: input_container.to_owned(),
        source_video_codec: None,
        source_audio_codec: None,
        video_codec: None,
        audio_codec: None,
        video_bitrate_bps: None,
        audio_bitrate_bps: None,
        quality_crf: None,
        preset: None,
        width: None,
        height: None,
        frame_rate_milli: None,
        audio_sample_rate_hz: None,
        audio_channels: None,
        threads: None,
        include_video: false,
        include_audio: false,
    }
}

#[test]
fn native_audio_transcode_writes_decodable_flac_without_an_external_runtime() {
    let mut scratch = ScratchFiles(Vec::new());
    let source = scratch.path("audio-source", "wav");
    let destination = scratch.path("audio-output", "flac");
    write_test_wave(&source).expect("write PCM/WAV fixture");

    let mut job = default_job(source, destination.clone(), "wav");
    job.audio_codec = Some("flac".to_owned());
    job.include_audio = true;
    let control = || MediaProcessingControl::Continue;
    let progress = |_: &MediaProcessingProgress| {};
    let result = transcode_local_media(&job, &control, &progress)
        .expect("native WAV-to-FLAC transcode");

    let output = fs::read(&destination).expect("read native FLAC output");
    assert!(output.starts_with(b"fLaC"), "output must be a FLAC stream");
    let engine = rff::Engine::new();
    let probe = rff::probe::probe(&engine, &destination).expect("probe native FLAC output");
    assert_eq!(probe.format_name, "flac");
    assert_eq!(probe.streams.len(), 1);
    assert!(result.output_bytes > 0);
    assert!(result.packets_written > 0);
}

#[test]
fn native_video_transcode_writes_mp4_without_an_external_runtime() {
    let mut scratch = ScratchFiles(Vec::new());
    let source = scratch.path("video-source", "y4m");
    let destination = scratch.path("video-output", "mp4");
    write_test_y4m(&source).expect("write YUV4MPEG fixture");

    let mut job = default_job(source, destination.clone(), "y4m");
    job.video_codec = Some("h264".to_owned());
    job.quality_crf = Some(30);
    job.include_video = true;
    let control = || MediaProcessingControl::Continue;
    let progress = |_: &MediaProcessingProgress| {};
    let result = transcode_local_media(&job, &control, &progress)
        .expect("native Y4M-to-H.264/MP4 transcode");

    let output = fs::read(&destination).expect("read native MP4 output");
    assert!(output.len() > 8);
    assert_eq!(&output[4..8], b"ftyp", "output must be an ISO-BMFF file");
    let engine = rff::Engine::new();
    let probe = rff::probe::probe(&engine, &destination).expect("probe native MP4 output");
    assert_eq!(probe.format_name, "mp4");
    assert_eq!(probe.streams.len(), 1);
    assert!(result.output_bytes > 0);
    assert!(result.frames_decoded > 0);
    assert!(result.packets_written > 0);
}
