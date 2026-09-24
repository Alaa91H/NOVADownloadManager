use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use nova_download_core::{
    download_http_to_path_segmented_controlled_with_context, TransferControl, TransportError,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct YouTubeTransferProgress {
    pub video_downloaded: u64,
    pub video_total: Option<u64>,
    pub audio_downloaded: u64,
    pub audio_total: Option<u64>,
}

impl YouTubeTransferProgress {
    pub fn downloaded_bytes(self) -> u64 {
        self.video_downloaded.saturating_add(self.audio_downloaded)
    }

    pub fn total_bytes(self) -> Option<u64> {
        match (self.video_total, self.audio_total) {
            (Some(video), Some(audio)) => Some(video.saturating_add(audio)),
            _ => None,
        }
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum YouTubeTransferError {
    #[error("selected YouTube stream was not found: {0}")]
    MissingStream(String),
    #[error("selected YouTube stream requires the HLS/DASH pipeline: {0}")]
    ManifestStream(String),
    #[error("native YouTube transfer was paused")]
    Paused,
    #[error("native YouTube transfer was cancelled")]
    Cancelled,
    #[error("native YouTube transfer failed: {0}")]
    Transport(String),
    #[error("native YouTube transfer worker panicked")]
    WorkerPanic,
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
    download_youtube_plan_controlled(
        extraction,
        plan,
        destination,
        requested_connections,
        || TransferControl::Continue,
        |_| {},
    )
}

pub fn download_youtube_plan_controlled<
    F: Fn() -> TransferControl + Sync,
    P: Fn(YouTubeTransferProgress) + Sync,
>(
    extraction: &YouTubeExtraction,
    plan: &YouTubeDownloadPlan,
    destination: &Path,
    requested_connections: u32,
    control: F,
    progress: P,
) -> Result<YouTubeTransferOutput, YouTubeTransferError> {
    match control() {
        TransferControl::Pause => return Err(YouTubeTransferError::Paused),
        TransferControl::Cancel => return Err(YouTubeTransferError::Cancelled),
        TransferControl::Continue => {}
    }

    match plan {
        YouTubeDownloadPlan::SingleStream { stream_id } => {
            let stream = find_stream(&extraction.descriptor, stream_id)?;
            ensure_direct(stream)?;
            let context = extraction
                .descriptor
                .request_context_for_stream(stream)
                .map_err(|error| YouTubeTransferError::Transport(error.to_string()))?;
            let transfer = download_http_to_path_segmented_controlled_with_context(
                &stream.url,
                destination,
                requested_connections.max(1),
                &context,
                || control(),
                |downloaded, total| {
                    progress(YouTubeTransferProgress {
                        video_downloaded: downloaded,
                        video_total: total,
                        audio_downloaded: 0,
                        audio_total: Some(0),
                    });
                },
            )
            .map_err(map_transport_error)?;

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

            let video_downloaded = AtomicU64::new(0);
            let audio_downloaded = AtomicU64::new(0);
            let video_total = AtomicU64::new(video.content_length.unwrap_or(0));
            let audio_total = AtomicU64::new(audio.content_length.unwrap_or(0));
            let transfer_abort = std::sync::atomic::AtomicBool::new(false);

            let emit_progress = || {
                let video_total_value = video_total.load(Ordering::Acquire);
                let audio_total_value = audio_total.load(Ordering::Acquire);
                progress(YouTubeTransferProgress {
                    video_downloaded: video_downloaded.load(Ordering::Acquire),
                    video_total: (video_total_value > 0).then_some(video_total_value),
                    audio_downloaded: audio_downloaded.load(Ordering::Acquire),
                    audio_total: (audio_total_value > 0).then_some(audio_total_value),
                });
            };

            emit_progress();
            let (video_result, audio_result) = std::thread::scope(|scope| {
                let video_worker = scope.spawn(|| {
                    let result = download_http_to_path_segmented_controlled_with_context(
                        &video.url,
                        &video_path,
                        per_track_connections,
                        &video_context,
                        || {
                            let command = control();
                            if command != TransferControl::Continue {
                                return command;
                            }
                            if transfer_abort.load(Ordering::Acquire) {
                                TransferControl::Cancel
                            } else {
                                TransferControl::Continue
                            }
                        },
                        |downloaded, total| {
                            video_downloaded.store(downloaded, Ordering::Release);
                            if let Some(total) = total {
                                video_total.store(total, Ordering::Release);
                            }
                            emit_progress();
                        },
                    );
                    if let Err(error) = &result {
                        if !matches!(error, TransportError::Paused | TransportError::Cancelled) {
                            transfer_abort.store(true, Ordering::Release);
                        }
                    }
                    result
                });
                let audio_worker = scope.spawn(|| {
                    let result = download_http_to_path_segmented_controlled_with_context(
                        &audio.url,
                        &audio_path,
                        per_track_connections,
                        &audio_context,
                        || {
                            let command = control();
                            if command != TransferControl::Continue {
                                return command;
                            }
                            if transfer_abort.load(Ordering::Acquire) {
                                TransferControl::Cancel
                            } else {
                                TransferControl::Continue
                            }
                        },
                        |downloaded, total| {
                            audio_downloaded.store(downloaded, Ordering::Release);
                            if let Some(total) = total {
                                audio_total.store(total, Ordering::Release);
                            }
                            emit_progress();
                        },
                    );
                    if let Err(error) = &result {
                        if !matches!(error, TransportError::Paused | TransportError::Cancelled) {
                            transfer_abort.store(true, Ordering::Release);
                        }
                    }
                    result
                });
                (video_worker.join(), audio_worker.join())
            });

            let video_transfer = video_result
                .map_err(|_| YouTubeTransferError::WorkerPanic)?
                .map_err(map_transport_error)?;
            let audio_transfer = audio_result
                .map_err(|_| YouTubeTransferError::WorkerPanic)?
                .map_err(map_transport_error)?;
            emit_progress();

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

fn map_transport_error(error: TransportError) -> YouTubeTransferError {
    match error {
        TransportError::Paused => YouTubeTransferError::Paused,
        TransportError::Cancelled => YouTubeTransferError::Cancelled,
        other => YouTubeTransferError::Transport(other.to_string()),
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn transfer_progress_aggregates_track_totals() {
        let progress = YouTubeTransferProgress {
            video_downloaded: 10,
            video_total: Some(100),
            audio_downloaded: 5,
            audio_total: Some(20),
        };
        assert_eq!(progress.downloaded_bytes(), 15);
        assert_eq!(progress.total_bytes(), Some(120));
    }

    #[test]
    fn controlled_separate_tracks_download_in_parallel_with_progress() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind track server");
        let address = listener.local_addr().expect("track server address");
        let server = std::thread::spawn(move || {
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().expect("accept track request");
                let mut request = [0_u8; 4096];
                let read = socket.read(&mut request).expect("read track request");
                let request = String::from_utf8_lossy(&request[..read]);
                let is_video = request.contains(" /video ");
                let body: &[u8] = if is_video { b"VIDEO-DATA" } else { b"AUDIO" };
                let head = request.starts_with("HEAD ");
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket
                    .write_all(response.as_bytes())
                    .expect("write track headers");
                if !head {
                    socket.write_all(body).expect("write track body");
                }
            }
        });

        let mut extraction = extraction();
        extraction.descriptor.streams[0].protocol = MediaProtocol::Http;
        extraction.descriptor.streams[0].url = format!("http://{address}/video");
        extraction.descriptor.streams[0].content_length = Some(10);
        extraction.descriptor.streams[1].protocol = MediaProtocol::Http;
        extraction.descriptor.streams[1].url = format!("http://{address}/audio");
        extraction.descriptor.streams[1].content_length = Some(5);

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-youtube-tracks-{unique}"));
        std::fs::create_dir_all(&dir).expect("create track temp dir");
        let destination = dir.join("staged");
        let observed = Mutex::new(Vec::<YouTubeTransferProgress>::new());

        let output = download_youtube_plan_controlled(
            &extraction,
            &YouTubeDownloadPlan::SeparateTracks {
                video_stream_id: "video".to_owned(),
                audio_stream_id: "audio".to_owned(),
            },
            &destination,
            2,
            || TransferControl::Continue,
            |progress| observed.lock().expect("progress lock").push(progress),
        )
        .expect("download separate tracks");

        server.join().expect("track server");
        let YouTubeTransferOutput::SeparateTracks {
            video_path,
            audio_path,
            video_bytes,
            audio_bytes,
            ..
        } = output
        else {
            panic!("expected separate-track output");
        };

        assert_eq!(video_bytes, 10);
        assert_eq!(audio_bytes, 5);
        assert_eq!(std::fs::read(video_path).expect("video track"), b"VIDEO-DATA");
        assert_eq!(std::fs::read(audio_path).expect("audio track"), b"AUDIO");
        let progress = observed.lock().expect("progress lock");
        let last = progress.last().copied().expect("final progress");
        assert_eq!(last.downloaded_bytes(), 15);
        assert_eq!(last.total_bytes(), Some(15));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn controlled_separate_tracks_can_cancel_before_network_io() {
        let error = download_youtube_plan_controlled(
            &extraction(),
            &YouTubeDownloadPlan::SeparateTracks {
                video_stream_id: "video".to_owned(),
                audio_stream_id: "audio".to_owned(),
            },
            Path::new("unused"),
            4,
            || TransferControl::Cancel,
            |_| {},
        )
        .expect_err("cancel before network");
        assert!(matches!(
            error,
            YouTubeTransferError::Cancelled | YouTubeTransferError::Transport(_)
        ));
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
