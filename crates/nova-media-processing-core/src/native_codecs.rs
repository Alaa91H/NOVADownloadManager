use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use rff::core::{CodecId, Dictionary, MediaType, SampleFormat};
use rff::transcode::{
    InputSpec, MapSelector, MapSpec, OutputSpec, StreamCodec, TranscodeControl, TranscodeReport,
    TranscodeSpec,
};
use rff::Engine;

use crate::{
    MediaProcessingControl, MediaProcessingError, MediaProcessingPhase, MediaProcessingProgress,
    MediaProgressSink,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);
static CODEC_CAPABILITIES: OnceLock<NativeMediaCodecCapabilities> = OnceLock::new();
const MAX_DIMENSION: u32 = 16_384;
const CANCEL_SENTINEL: &str = "NOVA_TRANSCODE_CANCELLED";

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaCodecTrackCapabilities {
    pub decoders: Vec<String>,
    pub encoders: Vec<String>,
    pub input_containers: Vec<String>,
    pub output_containers: Vec<String>,
    pub encoders_by_container: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMediaCodecCapabilities {
    pub audio: NativeMediaCodecTrackCapabilities,
    pub video: NativeMediaCodecTrackCapabilities,
    pub demuxers: Vec<String>,
    pub muxers: Vec<String>,
    pub subtitle_containers: Vec<String>,
}

/// Return codec and container names that this exact native binary can use.
/// The lists are resolved from the same registries used by transcode jobs.
pub fn native_media_codec_capabilities() -> NativeMediaCodecCapabilities {
    CODEC_CAPABILITIES
        .get_or_init(|| {
            let engine = Engine::new();
            let audio = track_capabilities(&engine, MediaType::Audio);
            let video = track_capabilities(&engine, MediaType::Video);
            let demuxers = engine
                .formats
                .iter()
                .filter(|format| format.can_demux())
                .map(|format| format.name.to_owned())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            let muxers = engine
                .formats
                .iter()
                .filter(|format| format.can_mux())
                .map(|format| format.name.to_owned())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            let subtitle_containers = engine
                .formats
                .iter()
                .filter(|format| {
                    format.can_mux()
                        && (format.mux_caps.accepts_media(MediaType::Video)
                            || format.mux_caps.accepts_media(MediaType::Audio))
                })
                .filter(|format| {
                    format
                        .mux_caps
                        .codecs_for(MediaType::Subtitle)
                        .any(|codec| format_accepts_subtitle_codec(&engine, format.name, codec))
                })
                .flat_map(|format| {
                    format
                        .extensions
                        .iter()
                        .map(|extension| (*extension).to_owned())
                })
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            NativeMediaCodecCapabilities {
                audio,
                video,
                demuxers,
                muxers,
                subtitle_containers,
            }
        })
        .clone()
}

fn track_capabilities(engine: &Engine, media_type: MediaType) -> NativeMediaCodecTrackCapabilities {
    let encoder_codecs = engine
        .codecs
        .iter()
        .filter(|codec| codec.media_type == media_type && codec.can_encode())
        .collect::<Vec<_>>();
    let mut encoders_by_container = BTreeMap::new();
    let mut output_formats = engine
        .formats
        .iter()
        .filter(|format| format.can_mux())
        .collect::<Vec<_>>();
    output_formats.sort_by_key(|format| format.name);
    for format in output_formats {
        let mut accepted = encoder_codecs
            .iter()
            .filter(|codec| {
                format_accepts_codec(
                    engine,
                    format.name,
                    codec.id,
                    media_type == MediaType::Audio,
                )
            })
            .map(|codec| codec.name.to_owned())
            .collect::<Vec<_>>();
        accepted.sort();
        accepted.dedup();
        if !accepted.is_empty() {
            for extension in format.extensions {
                encoders_by_container.insert((*extension).to_owned(), accepted.clone());
            }
        }
    }
    let encoders = engine
        .codecs
        .iter()
        .filter(|codec| codec.media_type == media_type && codec.can_encode())
        .map(|codec| codec.name.to_owned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let decoders = engine
        .codecs
        .iter()
        .filter(|codec| codec.media_type == media_type && codec.can_decode())
        .map(|codec| codec.name.to_owned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let input_containers = engine
        .formats
        .iter()
        .filter(|format| format.can_demux() && format.mux_caps.accepts_media(media_type))
        .flat_map(|format| {
            format
                .extensions
                .iter()
                .map(|extension| (*extension).to_owned())
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let output_containers = encoders_by_container.keys().cloned().collect();

    NativeMediaCodecTrackCapabilities {
        decoders,
        encoders,
        input_containers,
        output_containers,
        encoders_by_container,
    }
}

fn format_accepts_codec(engine: &Engine, format_name: &str, codec: CodecId, audio: bool) -> bool {
    let media_type = if audio {
        MediaType::Audio
    } else {
        MediaType::Video
    };
    let source = rff::targets::SourceStream::new(0, media_type, codec);
    let targets = rff::targets::for_streams(engine, &[source]);
    serde_json::from_str::<serde_json::Value>(&targets.to_json())
        .ok()
        .and_then(|value| value.get("targets").cloned())
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|targets| {
            targets.iter().any(|target| {
                if target.get("format").and_then(|value| value.as_str()) != Some(format_name) {
                    return false;
                }
                let stream_flag = if audio { "-c:a" } else { "-c:v" };
                target
                    .get("args")
                    .and_then(|value| value.as_array())
                    .is_some_and(|args| {
                        args.windows(2).any(|pair| {
                            pair[0].as_str() == Some(stream_flag)
                                && pair[1].as_str() == Some("copy")
                        })
                    })
            })
        })
}

fn format_accepts_subtitle_codec(engine: &Engine, format_name: &str, codec: CodecId) -> bool {
    let source = rff::targets::SourceStream::new(0, MediaType::Subtitle, codec);
    let targets = rff::targets::for_streams(engine, &[source]);
    serde_json::from_str::<serde_json::Value>(&targets.to_json())
        .ok()
        .and_then(|value| value.get("targets").cloned())
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|targets| {
            targets.iter().any(|target| {
                target.get("format").and_then(|value| value.as_str()) == Some(format_name)
                    && target
                        .get("args")
                        .and_then(|value| value.as_array())
                        .is_some_and(|args| {
                            args.windows(2).any(|pair| {
                                pair[0].as_str() == Some("-c:s") && pair[1].as_str() == Some("copy")
                            })
                        })
            })
        })
}

/// Local media conversion request. Input format is explicit because download
/// jobs commonly stage source bytes under the requested output extension.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeMediaTranscodeJob {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub input_container: String,
    pub source_video_codec: Option<String>,
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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeMediaTranscodeResult {
    pub output_bytes: u64,
    pub packets_written: u64,
    pub frames_decoded: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeMediaMuxJob {
    pub video_source: PathBuf,
    pub audio_source: PathBuf,
    pub destination: PathBuf,
    pub video_container: String,
    pub audio_container: String,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeMediaMuxResult {
    pub output_bytes: u64,
    pub packets_written: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeMediaSubtitleEmbedJob {
    pub media_source: PathBuf,
    pub subtitles: Vec<PathBuf>,
}

/// Transcode one local media file using the codecs and containers statically
/// linked into the native NOVA binary. No helper executable, network input,
/// or host FFmpeg installation is used by this operation.
pub fn transcode_local_media(
    job: &NativeMediaTranscodeJob,
    control: &(dyn Fn() -> MediaProcessingControl + Sync),
    progress: &dyn MediaProgressSink,
) -> Result<NativeMediaTranscodeResult, MediaProcessingError> {
    validate_job(job)?;
    wait_until_resumed(control)?;
    validate_local_media_transcode_job(job)?;
    if !job.source.is_file() {
        return Err(MediaProcessingError::InvalidJob(format!(
            "media source is not a regular file: {}",
            job.source.display()
        )));
    }
    let source_bytes = fs::metadata(&job.source).map_err(io_error)?.len();
    if source_bytes == 0 {
        return Err(MediaProcessingError::InvalidJob(
            "media source is empty".to_owned(),
        ));
    }
    if job.destination.exists() && !job.destination.is_file() {
        return Err(MediaProcessingError::InvalidJob(format!(
            "media destination is not a regular file: {}",
            job.destination.display()
        )));
    }
    if let Some(parent) = job
        .destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(io_error)?;
    }

    let temporary = unique_sibling_path(&job.destination, "codec-output");
    let mut temporary_guard = TemporaryFile::new(temporary.clone());
    let engine = Engine::new();
    let output_extension = job
        .destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let output_format = engine
        .formats
        .by_extension(output_extension)
        .filter(|format| format.can_mux())
        .ok_or_else(|| {
            MediaProcessingError::UnsupportedContainer(format!(
                "native local codec backend cannot write '.{output_extension}'"
            ))
        })?;
    let output_format_name = output_format.name.to_owned();

    let video_codec = build_stream_codec(
        &engine,
        job.video_codec.as_deref(),
        job.video_bitrate_bps,
        job.quality_crf,
        job.preset.as_deref(),
        None,
    )?;
    let audio_sample_format = job
        .audio_codec
        .as_deref()
        .filter(|codec| normalize_audio_codec(codec) == Some("pcm"))
        .map(|_| SampleFormat::S16);
    let audio_codec = build_stream_codec(
        &engine,
        job.audio_codec.as_deref(),
        job.audio_bitrate_bps,
        None,
        None,
        audio_sample_format,
    )?;
    let video_filters = video_filter(job.width, job.height)?;
    let frame_rate = job.frame_rate_milli.map(|rate| (rate, 1_000));
    let mut maps = Vec::with_capacity(2);
    if job.include_video {
        maps.push(MapSpec {
            input: 0,
            selector: MapSelector::Kind(MediaType::Video),
        });
    }
    if job.include_audio {
        maps.push(MapSpec {
            input: 0,
            selector: MapSelector::Kind(MediaType::Audio),
        });
    }
    let spec = TranscodeSpec {
        inputs: vec![InputSpec {
            path: job.source.clone(),
            format: Some(input_format_name(&job.input_container).ok_or_else(|| {
                MediaProcessingError::UnsupportedContainer(format!(
                    "native local codec backend does not recognize source container '{}'",
                    job.input_container
                ))
            })?),
        }],
        outputs: vec![OutputSpec {
            path: temporary.clone(),
            format: Some(output_format_name),
            video_codec,
            audio_codec,
            video_filters,
            maps,
            overwrite: true,
            frame_rate,
            audio_rate: job.audio_sample_rate_hz,
            audio_channels: job.audio_channels.map(u16::from),
            ..OutputSpec::default()
        }],
    };

    let mut last_report = TranscodeReport::default();
    progress.publish(&MediaProcessingProgress::new(
        MediaProcessingPhase::Decoding,
    ));
    let report_result = rff::transcode::run_controlled(
        &engine,
        &spec,
        || map_control(control()),
        |report| {
            if report.frames_decoded != last_report.frames_decoded
                || report.packets_written != last_report.packets_written
            {
                let mut update = MediaProcessingProgress::new(MediaProcessingPhase::Encoding);
                update.completed_units = report.frames_decoded;
                update.message = Some(format!(
                    "{} decoded frames, {} output packets",
                    report.frames_decoded, report.packets_written
                ));
                progress.publish(&update);
                last_report = report.clone();
            }
        },
    );
    let report = report_result.map_err(|error| {
        let message = error.to_string();
        if message.contains(CANCEL_SENTINEL) {
            MediaProcessingError::Cancelled
        } else {
            MediaProcessingError::Mux(message)
        }
    })?;
    wait_until_resumed(control)?;

    let output_bytes = fs::metadata(&temporary).map_err(io_error)?.len();
    if output_bytes == 0 || report.packets_written == 0 {
        return Err(MediaProcessingError::Mux(
            "local codec engine produced no output packets".to_owned(),
        ));
    }
    commit_output(&temporary, &job.destination)?;
    temporary_guard.disarm();

    let mut complete = MediaProcessingProgress::new(MediaProcessingPhase::Completed);
    complete.completed_units = report.frames_decoded;
    complete.fraction = Some(1.0);
    progress.publish(&complete);
    Ok(NativeMediaTranscodeResult {
        output_bytes,
        packets_written: report.packets_written,
        frames_decoded: report.frames_decoded,
    })
}

/// Combine local video-only and audio-only streams with the muxers compiled
/// into the native NOVA binary. The operation stream-copies both tracks and
/// never launches a helper process.
pub fn mux_local_media_tracks(
    job: &NativeMediaMuxJob,
    control: &(dyn Fn() -> MediaProcessingControl + Sync),
    progress: &dyn MediaProgressSink,
) -> Result<NativeMediaMuxResult, MediaProcessingError> {
    wait_until_resumed(control)?;
    validate_local_media_mux_job(job)?;
    ensure_nonempty_local_file(&job.video_source, "video source")?;
    ensure_nonempty_local_file(&job.audio_source, "audio source")?;
    if job.destination.exists() && !job.destination.is_file() {
        return Err(MediaProcessingError::InvalidJob(format!(
            "media destination is not a regular file: {}",
            job.destination.display()
        )));
    }
    if let Some(parent) = job
        .destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(io_error)?;
    }

    let temporary = unique_sibling_path(&job.destination, "mux-output");
    let mut temporary_guard = TemporaryFile::new(temporary.clone());
    let engine = Engine::new();
    let output_extension = job
        .destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let output_format = engine
        .formats
        .by_extension(output_extension)
        .filter(|format| format.can_mux())
        .ok_or_else(|| {
            MediaProcessingError::UnsupportedContainer(format!(
                "native local mux engine cannot write '.{output_extension}'"
            ))
        })?;
    let video_format = input_format_name(&job.video_container).ok_or_else(|| {
        MediaProcessingError::UnsupportedContainer(format!(
            "native local mux engine does not recognize video container '{}'",
            job.video_container
        ))
    })?;
    let audio_format = input_format_name(&job.audio_container).ok_or_else(|| {
        MediaProcessingError::UnsupportedContainer(format!(
            "native local mux engine does not recognize audio container '{}'",
            job.audio_container
        ))
    })?;
    let spec = TranscodeSpec {
        inputs: vec![
            InputSpec {
                path: job.video_source.clone(),
                format: Some(video_format),
            },
            InputSpec {
                path: job.audio_source.clone(),
                format: Some(audio_format),
            },
        ],
        outputs: vec![OutputSpec {
            path: temporary.clone(),
            format: Some(output_format.name.to_owned()),
            maps: vec![
                MapSpec {
                    input: 0,
                    selector: MapSelector::Kind(MediaType::Video),
                },
                MapSpec {
                    input: 1,
                    selector: MapSelector::Kind(MediaType::Audio),
                },
            ],
            overwrite: true,
            ..OutputSpec::default()
        }],
    };

    progress.publish(&MediaProcessingProgress::new(MediaProcessingPhase::Muxing));
    let mut last_report = TranscodeReport::default();
    let report = rff::transcode::run_controlled(
        &engine,
        &spec,
        || map_control(control()),
        |report| {
            if report.packets_written != last_report.packets_written {
                let mut update = MediaProcessingProgress::new(MediaProcessingPhase::Muxing);
                update.completed_units = report.packets_written;
                update.message = Some(format!("{} output packets", report.packets_written));
                progress.publish(&update);
                last_report = report.clone();
            }
        },
    )
    .map_err(|error| {
        let message = error.to_string();
        if message.contains(CANCEL_SENTINEL) {
            MediaProcessingError::Cancelled
        } else {
            MediaProcessingError::Mux(message)
        }
    })?;
    wait_until_resumed(control)?;
    let output_bytes = fs::metadata(&temporary).map_err(io_error)?.len();
    if output_bytes == 0 || report.packets_written == 0 {
        return Err(MediaProcessingError::Mux(
            "local codec engine produced no muxed output packets".to_owned(),
        ));
    }
    commit_output(&temporary, &job.destination)?;
    temporary_guard.disarm();
    let mut complete = MediaProcessingProgress::new(MediaProcessingPhase::Completed);
    complete.completed_units = report.packets_written;
    complete.fraction = Some(1.0);
    progress.publish(&complete);
    Ok(NativeMediaMuxResult {
        output_bytes,
        packets_written: report.packets_written,
    })
}

/// Validate source and destination containers before starting the downloads
/// that will later be combined by [`mux_local_media_tracks`].
pub fn validate_local_media_mux_job(job: &NativeMediaMuxJob) -> Result<(), MediaProcessingError> {
    for (name, path) in [
        ("video source", &job.video_source),
        ("audio source", &job.audio_source),
        ("destination", &job.destination),
    ] {
        let value = path.to_string_lossy().to_ascii_lowercase();
        if value.contains("://")
            || value.starts_with("data:")
            || value.starts_with("pipe:")
            || value.starts_with("udp:")
            || value.starts_with("tcp:")
            || value.starts_with("rtmp:")
        {
            return Err(MediaProcessingError::InvalidJob(format!(
                "{name} must be a local filesystem path"
            )));
        }
    }
    let engine = Engine::new();
    for (label, container) in [
        ("video", job.video_container.as_str()),
        ("audio", job.audio_container.as_str()),
    ] {
        let input_format = input_format_name(container).ok_or_else(|| {
            MediaProcessingError::UnsupportedContainer(format!(
                "native local mux engine does not recognize {label} container '{container}'"
            ))
        })?;
        if !engine
            .formats
            .by_name(&input_format)
            .is_some_and(|format| format.can_demux())
        {
            return Err(MediaProcessingError::UnsupportedContainer(format!(
                "native local mux engine cannot read {label} container '{container}'"
            )));
        }
    }
    let output_extension = job
        .destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let output_format = engine
        .formats
        .by_extension(output_extension)
        .filter(|format| format.can_mux())
        .ok_or_else(|| {
            MediaProcessingError::UnsupportedContainer(format!(
                "native local mux engine cannot write '.{output_extension}'"
            ))
        })?;
    for (track, codec, audio) in [
        ("video", job.video_codec.as_deref(), false),
        ("audio", job.audio_codec.as_deref(), true),
    ] {
        let Some(codec_name) = codec.filter(|name| !name.trim().is_empty()) else {
            continue;
        };
        let codec_id = source_codec_id(codec_name).ok_or_else(|| {
            MediaProcessingError::UnsupportedCodec(format!(
                "cannot verify whether '.{output_extension}' supports {track} codec '{codec_name}'"
            ))
        })?;
        if !format_accepts_codec(&engine, output_format.name, codec_id, audio) {
            return Err(MediaProcessingError::UnsupportedCodec(format!(
                "container '.{output_extension}' cannot copy the selected {track} codec '{codec_name}'"
            )));
        }
    }
    Ok(())
}

/// Add local text subtitles to a supported Matroska or WebM media file with
/// the linked codec engine. The media and subtitle inputs are stream-copied
/// into a sibling temporary file, then atomically committed after a successful
/// mux.
pub fn embed_local_media_subtitles(
    job: &NativeMediaSubtitleEmbedJob,
    control: &(dyn Fn() -> MediaProcessingControl + Sync),
    progress: &dyn MediaProgressSink,
) -> Result<NativeMediaMuxResult, MediaProcessingError> {
    wait_until_resumed(control)?;
    validate_local_media_subtitle_embed_job(job)?;
    ensure_nonempty_local_file(&job.media_source, "media source")?;
    for path in &job.subtitles {
        ensure_nonempty_local_file(path, "subtitle source")?;
    }

    let temporary = unique_sibling_path(&job.media_source, "subtitle-output");
    let mut temporary_guard = TemporaryFile::new(temporary.clone());
    let engine = Engine::new();
    let media_extension = job
        .media_source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let media_format = input_format_name(media_extension).ok_or_else(|| {
        MediaProcessingError::UnsupportedContainer(format!(
            "native subtitle engine cannot read media container '.{media_extension}'"
        ))
    })?;
    let mut inputs = vec![InputSpec {
        path: job.media_source.clone(),
        format: Some(media_format),
    }];
    let mut maps = vec![
        MapSpec {
            input: 0,
            selector: MapSelector::Kind(MediaType::Video),
        },
        MapSpec {
            input: 0,
            selector: MapSelector::Kind(MediaType::Audio),
        },
    ];
    for (index, path) in job.subtitles.iter().enumerate() {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let format = subtitle_input_format(extension).ok_or_else(|| {
            MediaProcessingError::UnsupportedOperation(format!(
                "local subtitle embedding accepts SRT and WebVTT files; '.{extension}' is not supported"
            ))
        })?;
        inputs.push(InputSpec {
            path: path.clone(),
            format: Some(format.to_owned()),
        });
        maps.push(MapSpec {
            input: index + 1,
            selector: MapSelector::Kind(MediaType::Subtitle),
        });
    }
    let (output_format, subtitle_codec) = subtitle_output_target(media_extension, &engine)?;
    let spec = TranscodeSpec {
        inputs,
        outputs: vec![OutputSpec {
            path: temporary.clone(),
            format: Some(output_format.to_owned()),
            subtitle_codec: Some(subtitle_codec),
            maps,
            overwrite: true,
            ..OutputSpec::default()
        }],
    };

    progress.publish(&MediaProcessingProgress::new(MediaProcessingPhase::Muxing));
    let mut last_report = TranscodeReport::default();
    let report = rff::transcode::run_controlled(
        &engine,
        &spec,
        || map_control(control()),
        |report| {
            if report.packets_written != last_report.packets_written {
                let mut update = MediaProcessingProgress::new(MediaProcessingPhase::Muxing);
                update.completed_units = report.packets_written;
                update.message = Some(format!("{} output packets", report.packets_written));
                progress.publish(&update);
                last_report = report.clone();
            }
        },
    )
    .map_err(|error| {
        let message = error.to_string();
        if message.contains(CANCEL_SENTINEL) {
            MediaProcessingError::Cancelled
        } else {
            MediaProcessingError::Mux(message)
        }
    })?;
    wait_until_resumed(control)?;
    let output_bytes = fs::metadata(&temporary).map_err(io_error)?.len();
    if output_bytes == 0 || report.packets_written == 0 {
        return Err(MediaProcessingError::Mux(
            "local subtitle muxer produced no output packets".to_owned(),
        ));
    }
    commit_output(&temporary, &job.media_source)?;
    temporary_guard.disarm();
    let mut complete = MediaProcessingProgress::new(MediaProcessingPhase::Completed);
    complete.completed_units = report.packets_written;
    complete.fraction = Some(1.0);
    progress.publish(&complete);
    Ok(NativeMediaMuxResult {
        output_bytes,
        packets_written: report.packets_written,
    })
}

pub fn validate_local_media_subtitle_embed_job(
    job: &NativeMediaSubtitleEmbedJob,
) -> Result<(), MediaProcessingError> {
    if job.subtitles.is_empty() {
        return Err(MediaProcessingError::InvalidJob(
            "subtitle embedding requires at least one local subtitle".to_owned(),
        ));
    }
    for (name, path) in std::iter::once(("media source", &job.media_source))
        .chain(job.subtitles.iter().map(|path| ("subtitle source", path)))
    {
        let value = path.to_string_lossy().to_ascii_lowercase();
        if value.contains("://")
            || value.starts_with("data:")
            || value.starts_with("pipe:")
            || value.starts_with("udp:")
            || value.starts_with("tcp:")
            || value.starts_with("rtmp:")
        {
            return Err(MediaProcessingError::InvalidJob(format!(
                "{name} must be a local filesystem path"
            )));
        }
    }
    let media_extension = job
        .media_source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let engine = Engine::new();
    let media_format = input_format_name(media_extension).ok_or_else(|| {
        MediaProcessingError::UnsupportedContainer(format!(
            "native subtitle engine cannot read media container '.{media_extension}'"
        ))
    })?;
    if !engine
        .formats
        .by_name(&media_format)
        .is_some_and(|format| format.can_demux())
    {
        return Err(MediaProcessingError::UnsupportedContainer(format!(
            "native subtitle engine cannot read media container '.{media_extension}'"
        )));
    }
    let (output_format, subtitle_codec) = subtitle_output_target(media_extension, &engine)?;
    if !format_accepts_subtitle_codec(&engine, &output_format, subtitle_codec) {
        return Err(MediaProcessingError::UnsupportedCodec(format!(
            "subtitle codec '{}' is unavailable for '.{media_extension}' in this local codec build",
            subtitle_codec.name()
        )));
    }
    for path in &job.subtitles {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let format_name = subtitle_input_format(extension).ok_or_else(|| {
            MediaProcessingError::UnsupportedOperation(format!(
                "local subtitle embedding accepts SRT and WebVTT files; '.{extension}' is not supported"
            ))
        })?;
        if !engine
            .formats
            .by_name(format_name)
            .is_some_and(|format| format.can_demux())
        {
            return Err(MediaProcessingError::UnsupportedContainer(format!(
                "native subtitle engine cannot read subtitle format '.{extension}'"
            )));
        }
    }
    Ok(())
}

fn subtitle_output_target(
    extension: &str,
    engine: &Engine,
) -> Result<(String, CodecId), MediaProcessingError> {
    let extension = extension.trim_start_matches('.').to_ascii_lowercase();
    let format = engine
        .formats
        .by_extension(&extension)
        .filter(|format| {
            format.can_mux()
                && (format.mux_caps.accepts_media(MediaType::Video)
                    || format.mux_caps.accepts_media(MediaType::Audio))
        })
        .ok_or_else(|| {
            MediaProcessingError::UnsupportedContainer(format!(
                "the bundled text-subtitle muxer does not support '.{extension}'"
            ))
        })?;
    let codec = format
        .mux_caps
        .codecs_for(MediaType::Subtitle)
        .find(|codec| format_accepts_subtitle_codec(engine, format.name, *codec))
        .ok_or_else(|| {
            MediaProcessingError::UnsupportedCodec(format!(
                "subtitle container '.{extension}' has no registered native text-subtitle codec"
            ))
        })?;
    Ok((format.name.to_owned(), codec))
}

fn ensure_nonempty_local_file(path: &Path, label: &str) -> Result<u64, MediaProcessingError> {
    let metadata = fs::metadata(path).map_err(|error| {
        MediaProcessingError::InvalidJob(format!(
            "{label} '{}' is unavailable: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(MediaProcessingError::InvalidJob(format!(
            "{label} '{}' is empty or is not a regular file",
            path.display()
        )));
    }
    Ok(metadata.len())
}

fn validate_job(job: &NativeMediaTranscodeJob) -> Result<(), MediaProcessingError> {
    if !job.include_video && !job.include_audio {
        return Err(MediaProcessingError::InvalidJob(
            "transcoding requires at least one selected video or audio stream".to_owned(),
        ));
    }
    for (name, path) in [("source", &job.source), ("destination", &job.destination)] {
        let value = path.to_string_lossy().to_ascii_lowercase();
        if value.contains("://")
            || value.starts_with("data:")
            || value.starts_with("pipe:")
            || value.starts_with("udp:")
            || value.starts_with("tcp:")
            || value.starts_with("rtmp:")
        {
            return Err(MediaProcessingError::InvalidJob(format!(
                "{name} must be a local filesystem path"
            )));
        }
    }
    if let (Some(_), Some(_)) = (job.video_bitrate_bps, job.quality_crf) {
        return Err(MediaProcessingError::InvalidJob(
            "choose either video bitrate or constant-quality mode".to_owned(),
        ));
    }
    for dimension in [job.width, job.height].into_iter().flatten() {
        if dimension == 0 || dimension > MAX_DIMENSION {
            return Err(MediaProcessingError::InvalidJob(format!(
                "video dimensions must be between 1 and {MAX_DIMENSION} pixels"
            )));
        }
    }
    if job
        .frame_rate_milli
        .is_some_and(|rate| rate == 0 || rate > 240_000)
    {
        return Err(MediaProcessingError::InvalidJob(
            "frame rate must be greater than zero and at most 240 fps".to_owned(),
        ));
    }
    if job
        .audio_sample_rate_hz
        .is_some_and(|rate| !(8_000..=192_000).contains(&rate))
    {
        return Err(MediaProcessingError::InvalidJob(
            "audio sample rate must be between 8 kHz and 192 kHz".to_owned(),
        ));
    }
    if job
        .audio_channels
        .is_some_and(|channels| !(1..=2).contains(&channels))
    {
        return Err(MediaProcessingError::UnsupportedOperation(
            "local audio channel conversion currently supports mono and stereo".to_owned(),
        ));
    }
    if let Some(preset) = job.preset.as_deref() {
        if !matches!(
            preset,
            "ultrafast"
                | "superfast"
                | "veryfast"
                | "faster"
                | "fast"
                | "medium"
                | "slow"
                | "slower"
                | "veryslow"
        ) {
            return Err(MediaProcessingError::InvalidJob(
                "unsupported local encoder preset".to_owned(),
            ));
        }
    }
    if let Some(threads) = job.threads {
        if threads > 1 {
            return Err(MediaProcessingError::UnsupportedOperation(
                "the bundled codec engine currently uses its internal thread policy; explicit multi-thread limits are not supported"
                    .to_owned(),
            ));
        }
    }
    Ok(())
}

/// Validate the requested codecs and input/output containers before a transfer
/// is started. The same engine registries are used again by the transcode.
pub fn validate_local_media_transcode_job(
    job: &NativeMediaTranscodeJob,
) -> Result<(), MediaProcessingError> {
    validate_job(job)?;
    let engine = Engine::new();
    let input_format = input_format_name(&job.input_container).ok_or_else(|| {
        MediaProcessingError::UnsupportedContainer(format!(
            "native local codec backend does not recognize source container '{}'",
            job.input_container
        ))
    })?;
    if !engine
        .formats
        .by_name(&input_format)
        .is_some_and(|format| format.can_demux())
    {
        return Err(MediaProcessingError::UnsupportedContainer(format!(
            "native local codec backend cannot read source container '{}'",
            job.input_container
        )));
    }
    let output_extension = job
        .destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let output_format = engine
        .formats
        .by_extension(output_extension)
        .filter(|format| format.can_mux())
        .ok_or_else(|| {
            MediaProcessingError::UnsupportedContainer(format!(
                "native local codec backend cannot write '.{output_extension}'"
            ))
        })?;
    let video_codec = build_stream_codec(
        &engine,
        job.video_codec.as_deref(),
        job.video_bitrate_bps,
        job.quality_crf,
        job.preset.as_deref(),
        None,
    )?;
    let sample_format = job
        .audio_codec
        .as_deref()
        .filter(|codec| normalize_audio_codec(codec) == Some("pcm"))
        .map(|_| SampleFormat::S16);
    let audio_codec = build_stream_codec(
        &engine,
        job.audio_codec.as_deref(),
        job.audio_bitrate_bps,
        None,
        None,
        sample_format,
    )?;
    for (track, source_name, requested_output_codec, audio) in [
        (
            "video",
            job.source_video_codec.as_deref(),
            job.video_codec.as_deref(),
            false,
        ),
        (
            "audio",
            job.source_audio_codec.as_deref(),
            job.audio_codec.as_deref(),
            true,
        ),
    ] {
        let Some(source_name) = source_name.filter(|name| !name.trim().is_empty()) else {
            continue;
        };
        let source_codec = source_codec_id(source_name).ok_or_else(|| {
            MediaProcessingError::UnsupportedCodec(format!(
                "the source {track} codec '{source_name}' is not recognized by the local codec backend"
            ))
        })?;
        let reencoding =
            requested_output_codec.is_some_and(|codec| !codec.eq_ignore_ascii_case("copy"));
        if reencoding {
            engine.codecs.find_decoder(source_codec).map_err(|error| {
                MediaProcessingError::UnsupportedCodec(format!(
                    "the local codec backend cannot decode source {track} codec '{source_name}': {error}"
                ))
            })?;
        } else if !format_accepts_codec(&engine, output_format.name, source_codec, audio) {
            return Err(MediaProcessingError::UnsupportedCodec(format!(
                "container '.{output_extension}' cannot copy source {track} codec '{source_name}'"
            )));
        }
    }
    for (codec, is_audio) in [(video_codec, false), (audio_codec, true)] {
        if let Some(codec) = codec {
            if !format_accepts_codec(&engine, output_format.name, codec.codec, is_audio) {
                return Err(MediaProcessingError::UnsupportedCodec(format!(
                    "container '.{output_extension}' cannot store the selected '{}' codec",
                    codec.codec.name()
                )));
            }
        }
    }
    video_filter(job.width, job.height)?;
    Ok(())
}

fn build_stream_codec(
    engine: &Engine,
    requested: Option<&str>,
    bitrate_bps: Option<u64>,
    quality_crf: Option<u8>,
    preset: Option<&str>,
    sample_format: Option<SampleFormat>,
) -> Result<Option<StreamCodec>, MediaProcessingError> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    if requested.eq_ignore_ascii_case("copy") {
        return Ok(None);
    }
    let canonical = normalize_codec_name(requested).ok_or_else(|| {
        MediaProcessingError::UnsupportedCodec(format!(
            "codec '{requested}' is not included in the local native codec set"
        ))
    })?;
    let codec = CodecId::from_name(canonical).ok_or_else(|| {
        MediaProcessingError::UnsupportedCodec(format!(
            "codec '{canonical}' is not recognized by the bundled codec engine"
        ))
    })?;
    engine.codecs.find_encoder(codec).map_err(|error| {
        MediaProcessingError::UnsupportedCodec(format!(
            "the bundled codec engine cannot encode '{}': {error}",
            codec.name()
        ))
    })?;

    let mut options = Dictionary::default();
    if let Some(bitrate_bps) = bitrate_bps {
        options.set("b", bitrate_bps.to_string());
    }
    if let Some(quality_crf) = quality_crf {
        options.set("crf", quality_crf.to_string());
    }
    if let Some(preset) = preset {
        options.set("preset", preset);
    }
    Ok(Some(StreamCodec {
        codec,
        options,
        sample_format,
    }))
}

fn normalize_codec_name(codec: &str) -> Option<&'static str> {
    match codec.trim().to_ascii_lowercase().as_str() {
        "h264" | "avc" | "libx264" => Some("h264"),
        "vp9" | "libvpx-vp9" => Some("vp9"),
        "mjpeg" | "mjpg" => Some("mjpeg"),
        "rawvideo" | "raw" => Some("rawvideo"),
        "aac" => Some("aac"),
        "mp3" | "libmp3lame" => Some("mp3"),
        "opus" | "libopus" => Some("opus"),
        "vorbis" | "libvorbis" => Some("vorbis"),
        "flac" => Some("flac"),
        "pcm_s16le" | "pcm" => Some("pcm"),
        _ => None,
    }
}

fn normalize_audio_codec(codec: &str) -> Option<&'static str> {
    match codec.trim().to_ascii_lowercase().as_str() {
        "pcm_s16le" | "pcm" => Some("pcm"),
        _ => normalize_codec_name(codec),
    }
}

fn source_codec_id(codec: &str) -> Option<CodecId> {
    let value = codec.trim().to_ascii_lowercase();
    let canonical = if value.starts_with("avc1") || value.starts_with("avc3") {
        "h264"
    } else if value.starts_with("hev1") || value.starts_with("hvc1") {
        "hevc"
    } else if value.starts_with("av01") {
        "av1"
    } else if value.starts_with("vp09") || value == "vp9" {
        "vp9"
    } else if value.starts_with("vp08") || value == "vp8" {
        "vp8"
    } else if value.starts_with("mp4a") {
        "aac"
    } else {
        value.as_str()
    };
    CodecId::from_name(canonical)
}

fn input_format_name(container: &str) -> Option<String> {
    let value = container
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    match value.as_str() {
        "mp4" | "m4a" | "m4v" | "mov" | "3gp" => Some("mp4".to_owned()),
        "mkv" | "mka" | "webm" => Some("matroska".to_owned()),
        "avi" => Some("avi".to_owned()),
        "flv" => Some("flv".to_owned()),
        "mpegts" | "mpeg-ts" | "ts" | "m2ts" => Some("mpegts".to_owned()),
        "wav" | "wave" => Some("wav".to_owned()),
        "ogg" | "oga" | "opus" => Some("ogg".to_owned()),
        "flac" => Some("flac".to_owned()),
        "mp3" => Some("mp3".to_owned()),
        "srt" => Some("srt".to_owned()),
        "vtt" | "webvtt" => Some("webvtt".to_owned()),
        "ivf" => Some("ivf".to_owned()),
        "y4m" => Some("yuv4mpegpipe".to_owned()),
        _ => None,
    }
}

fn subtitle_input_format(extension: &str) -> Option<&'static str> {
    match extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "srt" => Some("srt"),
        "vtt" | "webvtt" => Some("webvtt"),
        _ => None,
    }
}

fn video_filter(
    width: Option<u32>,
    height: Option<u32>,
) -> Result<Option<String>, MediaProcessingError> {
    if width.is_none() && height.is_none() {
        return Ok(None);
    }
    if width.is_some() || height.is_some() {
        let width = width
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-2".to_owned());
        let height = height
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-2".to_owned());
        return Ok(Some(format!("scale={width}:{height}")));
    }
    Err(MediaProcessingError::InvalidJob(
        "video scaling request is incomplete".to_owned(),
    ))
}

fn map_control(control: MediaProcessingControl) -> TranscodeControl {
    match control {
        MediaProcessingControl::Continue => TranscodeControl::Continue,
        MediaProcessingControl::Pause => TranscodeControl::Pause,
        MediaProcessingControl::Cancel => TranscodeControl::Cancel,
    }
}

fn wait_until_resumed(
    control: &(dyn Fn() -> MediaProcessingControl + Sync),
) -> Result<(), MediaProcessingError> {
    loop {
        match control() {
            MediaProcessingControl::Continue => return Ok(()),
            MediaProcessingControl::Pause => std::thread::sleep(Duration::from_millis(100)),
            MediaProcessingControl::Cancel => return Err(MediaProcessingError::Cancelled),
        }
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
        .unwrap_or("nova-media");
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let unique = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        "{stem}.nova-{tag}-{}-{unique}.tmp{extension}",
        std::process::id()
    ))
}

fn commit_output(temporary: &Path, destination: &Path) -> Result<(), MediaProcessingError> {
    if !destination.exists() {
        return fs::rename(temporary, destination).map_err(io_error);
    }
    let backup = unique_sibling_path(destination, "transcode-backup");
    fs::rename(destination, &backup).map_err(|error| {
        MediaProcessingError::Io(format!(
            "could not preserve original media before replacing it: {error}"
        ))
    })?;
    if let Err(error) = fs::rename(temporary, destination) {
        if let Err(restore_error) = fs::rename(&backup, destination) {
            return Err(MediaProcessingError::Io(format!(
                "could not commit converted media ({error}) or restore the original ({restore_error}); original remains at {}",
                backup.display()
            )));
        }
        return Err(MediaProcessingError::Io(format!(
            "could not commit converted media: {error}"
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
    use super::*;

    #[test]
    fn codec_aliases_are_limited_to_bundled_encoders() {
        assert_eq!(normalize_codec_name("libx264"), Some("h264"));
        assert_eq!(normalize_codec_name("libvpx-vp9"), Some("vp9"));
        assert_eq!(normalize_codec_name("mjpeg"), Some("mjpeg"));
        assert_eq!(normalize_codec_name("rawvideo"), Some("rawvideo"));
        assert_eq!(normalize_codec_name("libmp3lame"), Some("mp3"));
        assert_eq!(normalize_codec_name("libx265"), None);
        assert_eq!(normalize_codec_name("libsvtav1"), None);
    }

    #[test]
    fn input_container_aliases_preserve_the_true_source_format() {
        assert_eq!(input_format_name("m4a").as_deref(), Some("mp4"));
        assert_eq!(input_format_name("webm").as_deref(), Some("matroska"));
        assert_eq!(input_format_name("wav").as_deref(), Some("wav"));
        assert_eq!(input_format_name("unknown"), None);
    }

    #[test]
    fn subtitle_targets_are_derived_from_registered_muxers_and_encoders() {
        let engine = Engine::new();
        let capabilities = native_media_codec_capabilities();
        assert!(!capabilities.subtitle_containers.is_empty());
        for extension in &capabilities.subtitle_containers {
            let (format, codec) = subtitle_output_target(extension, &engine).unwrap();
            let format = engine
                .formats
                .by_name(&format)
                .expect("registered output format");
            assert!(format.mux_caps.accepts(codec));
            assert!(format_accepts_subtitle_codec(&engine, format.name, codec));
        }
        assert_eq!(input_format_name("flv").as_deref(), Some("flv"));
        assert_eq!(input_format_name("opus").as_deref(), Some("ogg"));
        assert_eq!(subtitle_input_format(".srt"), Some("srt"));
        assert_eq!(subtitle_input_format(".vtt"), Some("webvtt"));
        assert_eq!(subtitle_input_format(".ass"), None);
    }

    #[test]
    fn common_stream_codec_tags_are_normalized_before_mux_preflight() {
        assert_eq!(source_codec_id("avc1.640028"), CodecId::from_name("h264"));
        assert_eq!(source_codec_id("vp09.00.10.08"), CodecId::from_name("vp9"));
        assert_eq!(source_codec_id("mp4a.40.2"), CodecId::from_name("aac"));
        assert_eq!(source_codec_id("unknown-codec"), None);
    }

    #[test]
    fn codec_capabilities_include_decoder_only_video_codecs_and_registered_output_pairs() {
        let capabilities = native_media_codec_capabilities();
        assert!(capabilities.audio.encoders.contains(&"aac".to_owned()));
        assert!(capabilities.video.encoders.contains(&"h264".to_owned()));
        assert!(capabilities.video.decoders.contains(&"av2".to_owned()));
        assert!(!capabilities.video.encoders.contains(&"av2".to_owned()));
        assert!(capabilities
            .video
            .input_containers
            .contains(&"ivf".to_owned()));
        assert!(capabilities
            .video
            .output_containers
            .iter()
            .all(|container| {
                capabilities
                    .video
                    .encoders_by_container
                    .contains_key(container)
            }));
    }

    #[test]
    fn codec_registry_reports_every_compiled_codec_and_container_direction() {
        use std::collections::BTreeSet;

        let engine = Engine::new();
        let capabilities = native_media_codec_capabilities();
        let codec_names = |media_type, encoder: bool| {
            engine
                .codecs
                .iter()
                .filter(|codec| {
                    codec.media_type == media_type
                        && if encoder {
                            codec.can_encode()
                        } else {
                            codec.can_decode()
                        }
                })
                .map(|codec| codec.name.to_owned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        };
        let format_names = |muxer: bool| {
            engine
                .formats
                .iter()
                .filter(|format| {
                    if muxer {
                        format.can_mux()
                    } else {
                        format.can_demux()
                    }
                })
                .map(|format| format.name.to_owned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        };

        assert_eq!(
            capabilities.audio.decoders,
            codec_names(MediaType::Audio, false)
        );
        assert_eq!(
            capabilities.audio.encoders,
            codec_names(MediaType::Audio, true)
        );
        assert_eq!(
            capabilities.video.decoders,
            codec_names(MediaType::Video, false)
        );
        assert_eq!(
            capabilities.video.encoders,
            codec_names(MediaType::Video, true)
        );
        assert_eq!(capabilities.demuxers, format_names(false));
        assert_eq!(capabilities.muxers, format_names(true));
    }

    #[test]
    fn conversion_cancellation_preserves_an_existing_output() {
        let unique = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let output = std::env::temp_dir().join(format!(
            "nova-native-codec-cancel-{}-{unique}.mp3",
            std::process::id()
        ));
        fs::write(&output, b"keep-existing-output").expect("create existing output");
        let job = NativeMediaTranscodeJob {
            source: PathBuf::from("missing.wav"),
            destination: output.clone(),
            input_container: "wav".to_owned(),
            source_video_codec: None,
            source_audio_codec: Some("pcm".to_owned()),
            video_codec: None,
            audio_codec: Some("mp3".to_owned()),
            video_bitrate_bps: None,
            audio_bitrate_bps: Some(128_000),
            quality_crf: None,
            preset: None,
            width: None,
            height: None,
            frame_rate_milli: None,
            audio_sample_rate_hz: None,
            audio_channels: None,
            threads: None,
            include_video: false,
            include_audio: true,
        };
        let error = transcode_local_media(
            &job,
            &|| MediaProcessingControl::Cancel,
            &|_: &MediaProcessingProgress| {},
        )
        .expect_err("cancel before touching output");
        assert_eq!(error, MediaProcessingError::Cancelled);
        assert_eq!(
            fs::read(&output).expect("existing output remains"),
            b"keep-existing-output"
        );
        let _ = fs::remove_file(output);
    }
}
