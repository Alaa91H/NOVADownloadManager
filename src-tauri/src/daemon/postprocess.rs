use std::path::{Path, PathBuf};

use nova_media_core::processing::{MediaProcessingControl, MediaProcessingProgress};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct MediaSubtitleInput {
    pub path: PathBuf,
    pub language: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct MediaSubtitleEmbedRequest {
    pub source_path: PathBuf,
    pub subtitles: Vec<MediaSubtitleInput>,
    pub cleanup_sidecars: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct MediaTranscodeRequest {
    pub media_path: PathBuf,
    #[serde(default)]
    pub input_container: Option<String>,
    #[serde(default)]
    pub source_video_codec: Option<String>,
    #[serde(default)]
    pub source_audio_codec: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub video_bitrate_bps: Option<u64>,
    pub audio_bitrate_bps: Option<u64>,
    pub quality_crf: Option<u8>,
    pub preset: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate_milli: Option<u32>,
    pub audio_sample_rate_hz: Option<u32>,
    pub audio_channels: Option<u8>,
    pub threads: Option<u8>,
    pub include_video: bool,
    pub include_audio: bool,
    pub duration_millis: Option<u64>,
}

pub const MEDIA_SUBTITLE_EMBED_OPTION: &str = "__novaMediaSubtitleEmbed";
pub const MEDIA_TRANSCODE_OPTION: &str = "__novaMediaTranscode";

/// Run a supported conversion using codecs compiled into NOVA's Rust media
/// core. Unsupported local codec/container combinations fail explicitly and
/// are never silently redirected to the host FFmpeg executable.
pub fn transcode_with_native_codecs(
    request: &MediaTranscodeRequest,
    control: &(dyn Fn() -> MediaProcessingControl + Sync),
    on_progress: &(dyn Fn(Option<f64>) + Sync),
) -> Result<u64, PostProcessError> {
    validate_native_transcode_request(request)?;
    ensure_local_path(&request.media_path, "media source")?;
    ensure_regular_nonempty_file(&request.media_path, "media source")?;

    let job = native_transcode_job(request)?;
    let progress_sink = |update: &MediaProcessingProgress| {
        on_progress(update.fraction.map(f64::from));
    };
    let result = nova_media_core::processing::transcode_local_media(&job, control, &progress_sink)
        .map_err(map_native_media_error)?;
    Ok(result.output_bytes)
}

pub fn validate_native_transcode_request(
    request: &MediaTranscodeRequest,
) -> Result<(), PostProcessError> {
    validate_transcode_request(request)?;
    let job = native_transcode_job(request)?;
    nova_media_core::processing::validate_local_media_transcode_job(&job)
        .map_err(map_native_media_error)
}

/// Embed supported local text subtitle files with NOVA's linked codec engine.
/// Unsupported subtitle/container combinations fail before replacing the
/// downloaded media and are never routed to an external executable.
pub fn embed_subtitles_with_native_codecs(
    request: &MediaSubtitleEmbedRequest,
    control: &(dyn Fn() -> MediaProcessingControl + Sync),
    on_progress: &(dyn Fn(Option<f64>) + Sync),
) -> Result<u64, PostProcessError> {
    ensure_local_path(&request.source_path, "media source")?;
    ensure_regular_nonempty_file(&request.source_path, "media source")?;
    for subtitle in &request.subtitles {
        ensure_local_path(&subtitle.path, "subtitle")?;
        ensure_regular_nonempty_file(&subtitle.path, "subtitle")?;
    }
    let job = nova_media_core::processing::NativeMediaSubtitleEmbedJob {
        media_source: request.source_path.clone(),
        subtitles: request
            .subtitles
            .iter()
            .map(|subtitle| subtitle.path.clone())
            .collect(),
    };
    nova_media_core::processing::validate_local_media_subtitle_embed_job(&job)
        .map_err(map_native_media_error)?;
    let progress_sink = |update: &MediaProcessingProgress| {
        on_progress(update.fraction.map(f64::from));
    };
    let result =
        nova_media_core::processing::embed_local_media_subtitles(&job, control, &progress_sink)
            .map_err(map_native_media_error)?;
    if request.cleanup_sidecars {
        for subtitle in &request.subtitles {
            let _ = std::fs::remove_file(&subtitle.path);
        }
    }
    Ok(result.output_bytes)
}

fn native_transcode_job(
    request: &MediaTranscodeRequest,
) -> Result<nova_media_core::processing::NativeMediaTranscodeJob, PostProcessError> {
    let input_container = request
        .input_container
        .as_deref()
        .or_else(|| {
            request
                .media_path
                .extension()
                .and_then(|value| value.to_str())
        })
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            PostProcessError::InvalidInput(
                "source container is required for local conversion".to_owned(),
            )
        })?
        .to_owned();
    Ok(nova_media_core::processing::NativeMediaTranscodeJob {
        source: request.media_path.clone(),
        destination: request.media_path.clone(),
        input_container,
        source_video_codec: request.source_video_codec.clone(),
        source_audio_codec: request.source_audio_codec.clone(),
        video_codec: request.video_codec.clone(),
        audio_codec: request.audio_codec.clone(),
        video_bitrate_bps: request.video_bitrate_bps,
        audio_bitrate_bps: request.audio_bitrate_bps,
        quality_crf: request.quality_crf,
        preset: request.preset.clone(),
        width: request.width,
        height: request.height,
        frame_rate_milli: request.frame_rate_milli,
        audio_sample_rate_hz: request.audio_sample_rate_hz,
        audio_channels: request.audio_channels,
        threads: request.threads,
        include_video: request.include_video,
        include_audio: request.include_audio,
    })
}

fn map_native_media_error(
    error: nova_media_core::processing::MediaProcessingError,
) -> PostProcessError {
    let message = error.to_string();
    match error {
        nova_media_core::processing::MediaProcessingError::Cancelled
        | nova_media_core::processing::MediaProcessingError::Paused => PostProcessError::Cancelled,
        nova_media_core::processing::MediaProcessingError::InvalidJob(_)
        | nova_media_core::processing::MediaProcessingError::UnsupportedCodec(_)
        | nova_media_core::processing::MediaProcessingError::UnsupportedContainer(_)
        | nova_media_core::processing::MediaProcessingError::UnsupportedOperation(_) => {
            PostProcessError::InvalidInput(message)
        }
        _ => PostProcessError::Failed(message),
    }
}

#[derive(Debug)]
pub enum PostProcessError {
    InvalidInput(String),
    Failed(String),
    Cancelled,
}

impl std::fmt::Display for PostProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(message) => write!(f, "invalid post-processing input: {message}"),
            Self::Failed(message) => write!(f, "post-processing failed: {message}"),
            Self::Cancelled => write!(f, "post-processing was cancelled"),
        }
    }
}

impl std::error::Error for PostProcessError {}

fn validate_transcode_request(request: &MediaTranscodeRequest) -> Result<(), PostProcessError> {
    if !request.include_video && !request.include_audio {
        return Err(PostProcessError::InvalidInput(
            "transcoding requires at least one selected audio or video stream".to_owned(),
        ));
    }
    ensure_local_path(&request.media_path, "media source")?;
    if request.media_path.extension().is_none() {
        return Err(PostProcessError::InvalidInput(
            "media source must include a known container extension".to_owned(),
        ));
    }
    Ok(())
}
fn ensure_local_path(path: &Path, label: &str) -> Result<(), PostProcessError> {
    let value = path.to_string_lossy();
    let lower = value.trim().to_ascii_lowercase();
    let protocol_like = lower.contains("://")
        || lower.starts_with("data:")
        || lower.starts_with("pipe:")
        || lower.starts_with("tcp:")
        || lower.starts_with("udp:")
        || lower.starts_with("rtmp:");
    if protocol_like {
        return Err(PostProcessError::InvalidInput(format!(
            "{label} must be a local filesystem path"
        )));
    }
    Ok(())
}

fn ensure_regular_nonempty_file(path: &Path, label: &str) -> Result<u64, PostProcessError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        PostProcessError::InvalidInput(format!(
            "{label} '{}' is unavailable: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(PostProcessError::InvalidInput(format!(
            "{label} '{}' is empty or is not a regular file",
            path.display()
        )));
    }
    Ok(metadata.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str, include_video: bool, include_audio: bool) -> MediaTranscodeRequest {
        MediaTranscodeRequest {
            media_path: PathBuf::from(path),
            input_container: Some("mp4".to_owned()),
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
            include_video,
            include_audio,
            duration_millis: None,
        }
    }

    #[test]
    fn validation_rejects_jobs_without_audio_or_video() {
        let error = validate_transcode_request(&request("input.mp4", false, false))
            .expect_err("at least one stream kind must be selected");
        assert!(matches!(error, PostProcessError::InvalidInput(_)));
    }

    #[test]
    fn validation_rejects_network_urls_as_media_paths() {
        let error =
            validate_transcode_request(&request("https://example.test/media.mp4", true, true))
                .expect_err("the native codec backend only accepts local paths");
        assert!(matches!(error, PostProcessError::InvalidInput(_)));
    }
}
