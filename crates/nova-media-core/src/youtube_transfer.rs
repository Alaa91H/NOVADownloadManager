use std::fs;
use std::path::{Path, PathBuf};

use nova_download_core::download_http_to_path_segmented_with_context;
use nova_media_processing_core::{
    mux_demuxers_to_mp4, open_mp4_remux_demuxer, MediaDemuxer, MediaMuxResult,
};
use thiserror::Error;

use crate::{
    MediaDescriptor, MediaProtocol, MediaStream, YouTubeDownloadPlan, YouTubeExtraction,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum YouTubeTransferOutput {
    Single {
        path: PathBuf,
        bytes: u64,
        stream_id: String,
    },
    SeparateTracks {
        video_path: PathBuf,
        audio_path: PathBuf,
        video_bytes: u64,
        audio_bytes: u64,
        video_stream_id: String,
        audio_stream_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum YouTubeFinalizedOutput {
    Single {
        path: PathBuf,
        bytes: u64,
        stream_id: String,
    },
    Muxed {
        path: PathBuf,
        bytes: u64,
        video_stream_id: String,
        audio_stream_id: String,
    },
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum YouTubeTransferError {
    #[error("selected YouTube stream was not found: {0}")]
    MissingStream(String),
    #[error("selected YouTube stream requires the HLS/DASH pipeline: {0}")]
    ManifestStream(String),
    #[error("native YouTube transfer failed: {0}")]
    Transport(String),
    #[error("native YouTube transfer worker panicked")]
    WorkerPanic,
    #[error("native YouTube media processing failed: {0}")]
    Processing(String),
    #[error("selected YouTube separate track is not supported by the native MP4 remux bridge: {0}")]
    UnsupportedMuxContainer(String),
    #[error("native YouTube mux requires a separate-track transfer")]
    NotSeparateTracks,
}

/// Execute a selected YouTube plan through NOVA's existing native transfer
/// engine. No external media-resolver subprocess participates in this path.
///
/// Separate audio/video tracks are intentionally staged independently; the
/// mux layer consumes the returned paths afterwards.
pub fn download_youtube_plan(
    extraction: &YouTubeExtraction,
    plan: &YouTubeDownloadPlan,
    destination: &Path,
    requested_connections: u32,
) -> Result<YouTubeTransferOutput, YouTubeTransferError> {
    match plan {
        YouTubeDownloadPlan::SingleStream { stream_id } => {
            let stream = find_stream(&extraction.descriptor, stream_id)?;
            ensure_direct(stream)?;
            let context = extraction
                .descriptor
                .request_context_for_stream(stream)
                .map_err(|error| YouTubeTransferError::Transport(error.to_string()))?;
            let transfer = download_http_to_path_segmented_with_context(
                &stream.url,
                destination,
                requested_connections.max(1),
                &context,
            )
            .map_err(|error| YouTubeTransferError::Transport(error.to_string()))?;

            Ok(YouTubeTransferOutput::Single {
                path: destination.to_path_buf(),
                bytes: transfer.final_bytes,
                stream_id: stream_id.clone(),
            })
        }
        YouTubeDownloadPlan::SeparateTracks {
            video_stream_id,
            audio_stream_id,
        } => {
            let video = find_stream(&extraction.descriptor, video_stream_id)?;
            let audio = find_stream(&extraction.descriptor, audio_stream_id)?;
            ensure_direct(video)?;
            ensure_direct(audio)?;

            let video_context = extraction
                .descriptor
                .request_context_for_stream(video)
                .map_err(|error| YouTubeTransferError::Transport(error.to_string()))?;
            let audio_context = extraction
                .descriptor
                .request_context_for_stream(audio)
                .map_err(|error| YouTubeTransferError::Transport(error.to_string()))?;
            let video_path = append_suffix(destination, ".nova-video.part");
            let audio_path = append_suffix(destination, ".nova-audio.part");
            let per_track_connections = (requested_connections.max(2) + 1) / 2;

            let (video_result, audio_result) = std::thread::scope(|scope| {
                let video_worker = scope.spawn(|| {
                    download_http_to_path_segmented_with_context(
                        &video.url,
                        &video_path,
                        per_track_connections,
                        &video_context,
                    )
                });
                let audio_worker = scope.spawn(|| {
                    download_http_to_path_segmented_with_context(
                        &audio.url,
                        &audio_path,
                        per_track_connections,
                        &audio_context,
                    )
                });
                (video_worker.join(), audio_worker.join())
            });

            let video_transfer = video_result
                .map_err(|_| YouTubeTransferError::WorkerPanic)?
                .map_err(|error| YouTubeTransferError::Transport(error.to_string()))?;
            let audio_transfer = audio_result
                .map_err(|_| YouTubeTransferError::WorkerPanic)?
                .map_err(|error| YouTubeTransferError::Transport(error.to_string()))?;

            Ok(YouTubeTransferOutput::SeparateTracks {
                video_path,
                audio_path,
                video_bytes: video_transfer.final_bytes,
                audio_bytes: audio_transfer.final_bytes,
                video_stream_id: video_stream_id.clone(),
                audio_stream_id: audio_stream_id.clone(),
            })
        }
    }
}

/// Download a selected YouTube plan and finish all MP4-compatible
/// post-processing inside NOVA's native media core.
///
/// Single-stream plans are returned directly. Separate MP4/M4A or supported
/// WebM tracks are downloaded through nova-download-core and muxed in-process
/// without FFmpeg.
pub fn download_and_finalize_youtube_plan(
    extraction: &YouTubeExtraction,
    plan: &YouTubeDownloadPlan,
    destination: &Path,
    requested_connections: u32,
) -> Result<YouTubeFinalizedOutput, YouTubeTransferError> {
    if let YouTubeDownloadPlan::SeparateTracks {
        video_stream_id,
        audio_stream_id,
    } = plan
    {
        let video = find_stream(&extraction.descriptor, video_stream_id)?;
        let audio = find_stream(&extraction.descriptor, audio_stream_id)?;
        ensure_mp4_muxable_stream(video)?;
        ensure_mp4_muxable_stream(audio)?;
    }

    let staged = download_youtube_plan(
        extraction,
        plan,
        destination,
        requested_connections,
    )?;

    match &staged {
        YouTubeTransferOutput::Single {
            path,
            bytes,
            stream_id,
        } => Ok(YouTubeFinalizedOutput::Single {
            path: path.clone(),
            bytes: *bytes,
            stream_id: stream_id.clone(),
        }),
        YouTubeTransferOutput::SeparateTracks {
            video_stream_id,
            audio_stream_id,
            ..
        } => {
            let muxed = mux_youtube_separate_tracks_to_mp4(&staged, destination)?;
            Ok(YouTubeFinalizedOutput::Muxed {
                path: destination.to_path_buf(),
                bytes: muxed.bytes_written,
                video_stream_id: video_stream_id.clone(),
                audio_stream_id: audio_stream_id.clone(),
            })
        }
    }
}

/// Mux already-downloaded YouTube MP4/M4A or supported WebM staging files
/// into one MP4.
///
/// Staging files are deleted only after the destination has been finalized
/// successfully. On any demux/mux failure they are retained for diagnostics
/// and retry.
pub fn mux_youtube_separate_tracks_to_mp4(
    transfer: &YouTubeTransferOutput,
    destination: &Path,
) -> Result<MediaMuxResult, YouTubeTransferError> {
    let YouTubeTransferOutput::SeparateTracks {
        video_path,
        audio_path,
        ..
    } = transfer
    else {
        return Err(YouTubeTransferError::NotSeparateTracks);
    };

    let mut video = open_mp4_remux_demuxer(video_path)
        .map_err(|error| YouTubeTransferError::Processing(error.to_string()))?;
    let mut audio = open_mp4_remux_demuxer(audio_path)
        .map_err(|error| YouTubeTransferError::Processing(error.to_string()))?;
    let mut inputs: [&mut dyn MediaDemuxer; 2] = [video.as_mut(), audio.as_mut()];
    let result = mux_demuxers_to_mp4(destination, &mut inputs)
        .map_err(|error| YouTubeTransferError::Processing(error.to_string()))?;

    let _ = fs::remove_file(video_path);
    let _ = fs::remove_file(audio_path);
    Ok(result)
}

fn ensure_mp4_muxable_stream(stream: &MediaStream) -> Result<(), YouTubeTransferError> {
    if youtube_stream_is_native_mp4_remuxable(stream) {
        return Ok(());
    }

    let container = stream
        .container
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let codec = stream
        .video_codec
        .as_deref()
        .or(stream.audio_codec.as_deref())
        .unwrap_or("unknown");
    Err(YouTubeTransferError::UnsupportedMuxContainer(format!(
        "{container}/{codec}"
    )))
}

/// Whether a direct YouTube track can enter NOVA's packet-preserving MP4
/// remux bridge without an external post-processor.
pub fn youtube_stream_is_native_mp4_remuxable(stream: &MediaStream) -> bool {
    if !matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https) {
        return false;
    }

    let container = stream
        .container
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if matches!(container.as_str(), "mp4" | "m4a" | "m4v" | "mov") {
        return true;
    }
    if container != "webm" {
        return false;
    }

    match stream.kind {
        crate::MediaTrackKind::Video => stream
            .video_codec
            .as_deref()
            .map(|codec| codec.trim().to_ascii_lowercase())
            .is_some_and(|codec| codec.starts_with("vp9") || codec.starts_with("vp8")),
        crate::MediaTrackKind::Audio => stream
            .audio_codec
            .as_deref()
            .map(|codec| codec.trim().to_ascii_lowercase())
            .is_some_and(|codec| codec.starts_with("opus") || codec.starts_with("mp3")),
        _ => false,
    }
}

fn find_stream<'a>(
    descriptor: &'a MediaDescriptor,
    stream_id: &str,
) -> Result<&'a MediaStream, YouTubeTransferError> {
    descriptor
        .streams
        .iter()
        .find(|stream| stream.id == stream_id)
        .ok_or_else(|| YouTubeTransferError::MissingStream(stream_id.to_owned()))
}

fn ensure_direct(stream: &MediaStream) -> Result<(), YouTubeTransferError> {
    if matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https) {
        Ok(())
    } else {
        Err(YouTubeTransferError::ManifestStream(stream.id.clone()))
    }
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        MediaMetadata, MediaSourceKind, MediaTrackKind, YouTubePendingFormat,
    };
    use std::collections::BTreeMap;

    fn stream(id: &str, kind: MediaTrackKind, url: &str) -> MediaStream {
        MediaStream {
            id: id.to_owned(),
            kind,
            protocol: MediaProtocol::Https,
            url: url.to_owned(),
            container: Some("mp4".to_owned()),
            video_codec: (kind == MediaTrackKind::Video).then(|| "avc1".to_owned()),
            audio_codec: (kind == MediaTrackKind::Audio).then(|| "mp4a".to_owned()),
            width: None,
            height: None,
            fps: None,
            bitrate_bps: None,
            audio_bitrate_bps: None,
            content_length: None,
            language: None,
            headers: BTreeMap::new(),
        }
    }

    fn extraction() -> YouTubeExtraction {
        YouTubeExtraction {
            video_id: "dQw4w9WgXcQ".to_owned(),
            descriptor: MediaDescriptor {
                source_kind: MediaSourceKind::Site,
                metadata: MediaMetadata {
                    title: "test".to_owned(),
                    description: None,
                    duration_millis: None,
                    uploader: None,
                    webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_owned(),
                    thumbnail_url: None,
                },
                streams: vec![
                    stream("video", MediaTrackKind::Video, "https://video.test/v"),
                    stream("audio", MediaTrackKind::Audio, "https://video.test/a"),
                ],
                subtitles: Vec::new(),
                request_headers: BTreeMap::new(),
                is_live: false,
            },
            pending_formats: Vec::<YouTubePendingFormat>::new(),
            player_js_url: None,
            visitor_data: None,
        }
    }

    fn processing_video_track() -> nova_media_processing_core::MediaTrack {
        use nova_media_processing_core as processing;
        processing::MediaTrack {
            id: 1,
            kind: processing::MediaTrackKind::Video,
            codec: processing::MediaCodec::H264,
            time_base: processing::MediaTimeBase::new(1, 1000).expect("time base"),
            language: None,
            video: Some(processing::VideoParameters {
                width: 640,
                height: 360,
                frame_rate: Some(1.0),
                bitrate_bps: None,
            }),
            audio: None,
            codec_private: vec![1, 66, 0, 30],
        }
    }

    fn processing_audio_track() -> nova_media_processing_core::MediaTrack {
        use nova_media_processing_core as processing;
        processing::MediaTrack {
            id: 1,
            kind: processing::MediaTrackKind::Audio,
            codec: processing::MediaCodec::Aac,
            time_base: processing::MediaTimeBase::new(1, 48_000).expect("time base"),
            language: Some("eng".to_owned()),
            video: None,
            audio: Some(processing::AudioParameters {
                sample_rate_hz: 48_000,
                channels: 2,
                bitrate_bps: None,
            }),
            codec_private: vec![0, 0, 0, 0],
        }
    }

    fn write_processing_track(
        path: &Path,
        track: nova_media_processing_core::MediaTrack,
        duration: i64,
        bytes: &[u8],
    ) {
        use nova_media_processing_core::{
            MediaMuxer, MediaPacket, MediaPacketFlags, MediaTimestamp, Mp4Muxer,
        };
        let mut muxer = Mp4Muxer::create(path).expect("create staging MP4");
        let output_id = muxer.add_track(&track).expect("add staging track");
        let packet = MediaPacket {
            track_id: output_id,
            pts: Some(MediaTimestamp {
                value: 0,
                time_base: track.time_base,
            }),
            dts: Some(MediaTimestamp {
                value: 0,
                time_base: track.time_base,
            }),
            duration: Some(MediaTimestamp {
                value: duration,
                time_base: track.time_base,
            }),
            flags: MediaPacketFlags {
                keyframe: true,
                discontinuity: false,
                corrupted: false,
            },
            data: bytes.to_vec(),
        };
        muxer.write_packet(&packet).expect("write staging packet");
        muxer.finalize().expect("finalize staging MP4");
    }

    #[test]
    fn native_youtube_mux_merges_separate_mp4_tracks_and_cleans_staging() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-youtube-mux-{unique}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let video_path = dir.join("video.part");
        let audio_path = dir.join("audio.part");
        let destination = dir.join("final.mp4");

        write_processing_track(
            &video_path,
            processing_video_track(),
            1000,
            b"VIDEO",
        );
        write_processing_track(
            &audio_path,
            processing_audio_track(),
            48_000,
            b"AUDIO",
        );

        let transfer = YouTubeTransferOutput::SeparateTracks {
            video_path: video_path.clone(),
            audio_path: audio_path.clone(),
            video_bytes: 5,
            audio_bytes: 5,
            video_stream_id: "137".to_owned(),
            audio_stream_id: "140".to_owned(),
        };

        let result = mux_youtube_separate_tracks_to_mp4(&transfer, &destination)
            .expect("native YouTube mux");
        assert_eq!(result.tracks_written, 2);
        assert!(!video_path.exists());
        assert!(!audio_path.exists());

        let probe = nova_media_processing_core::probe_mp4_file(&destination)
            .expect("probe merged output");
        assert_eq!(probe.tracks.len(), 2);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn webm_vp9_and_opus_are_admitted_to_native_mp4_remux() {
        let mut video = stream("vp9", MediaTrackKind::Video, "https://video.test/vp9");
        video.container = Some("webm".to_owned());
        video.video_codec = Some("vp9".to_owned());
        assert!(youtube_stream_is_native_mp4_remuxable(&video));

        let mut audio = stream("opus", MediaTrackKind::Audio, "https://video.test/opus");
        audio.container = Some("webm".to_owned());
        audio.audio_codec = Some("opus".to_owned());
        assert!(youtube_stream_is_native_mp4_remuxable(&audio));

        video.video_codec = Some("av01.0.08M.08".to_owned());
        assert!(!youtube_stream_is_native_mp4_remuxable(&video));
    }

    #[test]
    fn missing_selected_stream_is_rejected_before_network_io() {
        let error = download_youtube_plan(
            &extraction(),
            &YouTubeDownloadPlan::SingleStream {
                stream_id: "missing".to_owned(),
            },
            Path::new("unused"),
            4,
        )
        .expect_err("missing stream");
        assert_eq!(
            error,
            YouTubeTransferError::MissingStream("missing".to_owned())
        );
    }

    #[test]
    fn manifest_stream_is_routed_to_stream_pipeline() {
        let mut extraction = extraction();
        extraction.descriptor.streams[0].protocol = MediaProtocol::Dash;
        let error = download_youtube_plan(
            &extraction,
            &YouTubeDownloadPlan::SingleStream {
                stream_id: "video".to_owned(),
            },
            Path::new("unused"),
            4,
        )
        .expect_err("manifest stream");
        assert_eq!(
            error,
            YouTubeTransferError::ManifestStream("video".to_owned())
        );
    }
}
