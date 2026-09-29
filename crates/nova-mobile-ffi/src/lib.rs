//! Typed FFI boundary for NOVA mobile clients.
//!
//! The bridge deliberately starts with a versioned compatibility handshake.
//! It must not expose the desktop daemon, Axum routes, Tauri commands, or
//! arbitrary filesystem paths. Task operations are added only after the shared
//! core owns their durable semantics.

uniffi::setup_scaffolding!();

/// Increment when a bridge change is not backward compatible.
pub const BRIDGE_API_VERSION: u32 = 4;

/// Typed capability and compatibility information returned before a mobile
/// client creates a core session.
#[derive(uniffi::Record)]
pub struct BridgeInfo {
    pub bridge_api_version: u32,
    pub core_version: String,
    pub task_schema: String,
    pub recovery_schema_version: u32,
}

/// Stable mobile projection of one inclusive shared-core byte range.
#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Record)]
pub struct TransferRange {
    pub start: u64,
    pub end: u64,
}

/// Stable mobile projection of the shared core's resume decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum ResumeAction {
    Append,
    Restart,
}

/// HTTP metadata collected by NOVA's native libcurl transport.
#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct HttpResourceProbe {
    pub response_status: u16,
    pub content_length: Option<u64>,
    pub effective_url: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct RecoveryIdentity {
    pub effective_url: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
}

impl From<RecoveryIdentity> for nova_core_model::ResourceIdentity {
    fn from(value: RecoveryIdentity) -> Self {
        Self {
            effective_url: value.effective_url,
            etag: value.etag,
            last_modified: value.last_modified,
            content_length: value.content_length,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Record)]
pub struct NativeTransferProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum MobileMediaTrackKind {
    Video,
    Audio,
    AudioVideo,
    Subtitle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum MobileMediaProtocol {
    Http,
    Https,
    Hls,
    Dash,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct MobileMediaStream {
    pub id: String,
    pub kind: MobileMediaTrackKind,
    pub protocol: MobileMediaProtocol,
    pub url: String,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub bitrate_bps: Option<u64>,
    pub audio_bitrate_bps: Option<u64>,
    pub content_length: Option<u64>,
    pub language: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileSubtitleTrack {
    pub language: String,
    pub name: Option<String>,
    pub url: String,
    pub format: Option<String>,
    pub automatic: bool,
}

#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct MobileMediaDescriptor {
    pub source_kind: String,
    pub title: String,
    pub description: Option<String>,
    pub duration_millis: Option<u64>,
    pub uploader: Option<String>,
    pub webpage_url: String,
    pub thumbnail_url: Option<String>,
    pub is_live: bool,
    pub streams: Vec<MobileMediaStream>,
    pub subtitles: Vec<MobileSubtitleTrack>,
}

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileMediaResolveRequest {
    pub url: String,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub cookie_header: Option<String>,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MediaResolveError {
    #[error("invalid native media request: {message}")]
    InvalidRequest { message: String },
    #[error("native media resolution failed: {message}")]
    ResolveFailed { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileMediaDownloadRequest {
    pub task_id: String,
    pub webpage_url: String,
    pub stream_id: String,
    pub output_container: String,
    pub app_private_root: String,
    pub relative_destination: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileMediaDownloadResult {
    pub final_bytes: u64,
    pub total_bytes: Option<u64>,
    pub resumed_from: u64,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MediaDownloadError {
    #[error("invalid native media download request: {message}")]
    InvalidRequest { message: String },
    #[error("native media stream resolution failed: {message}")]
    ResolveFailed { message: String },
    #[error("native media transfer failed: {message}")]
    DownloadFailed { message: String },
    #[error("native media transfer paused")]
    Paused,
    #[error("native media transfer cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileMediaCodecContainer {
    pub extension: String,
    pub encoders: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileMediaCodecTrackCapabilities {
    pub decoders: Vec<String>,
    pub encoders: Vec<String>,
    pub input_containers: Vec<String>,
    pub output_containers: Vec<String>,
    pub encoders_by_container: Vec<MobileMediaCodecContainer>,
}

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileMediaCodecCapabilities {
    pub capability_registry_version: u32,
    pub audio: MobileMediaCodecTrackCapabilities,
    pub video: MobileMediaCodecTrackCapabilities,
    pub demuxers: Vec<String>,
    pub muxers: Vec<String>,
    pub subtitle_containers: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct MobileMediaTranscodeOptions {
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

#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileMediaTranscodeRequest {
    pub task_id: String,
    pub app_private_root: String,
    pub source_relative_path: String,
    pub destination_relative_path: String,
    pub options: MobileMediaTranscodeOptions,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct MobileMediaProcessingProgress {
    pub phase: u8,
    pub completed_units: u64,
    pub total_units: u64,
    pub fraction: f32,
    pub has_fraction: bool,
    pub active: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Record)]
pub struct MobileMediaTranscodeResult {
    pub output_bytes: u64,
    pub packets_written: u64,
    pub frames_decoded: u64,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MediaProcessingBridgeError {
    #[error("invalid native media request: {message}")]
    InvalidRequest { message: String },
    #[error("native media processing failed: {message}")]
    ProcessingFailed { message: String },
    #[error("native media processing is paused")]
    Paused,
    #[error("native media processing was cancelled")]
    Cancelled,
}

/// Result of a validated bounded ranged GET performed entirely by libcurl.
#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct HttpRangeProbe {
    pub response_status: u16,
    pub range_start: u64,
    pub range_end: u64,
    pub bytes_received: u64,
    pub effective_url: String,
}

/// A stable error for a client that was compiled against an incompatible bridge.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BridgeError {
    #[error("Android client bridge version {client_version} is incompatible with core version {core_version}")]
    IncompatibleVersion {
        client_version: u32,
        core_version: u32,
    },
}

/// Stable transport error projected across the mobile FFI boundary.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum TransportError {
    #[error("native HTTP transport failed: {message}")]
    RequestFailed { message: String },
    #[error("native HTTP transport returned an unsupported status value: {status}")]
    InvalidStatus { status: u32 },
    #[error("invalid inclusive byte range {start}-{end}")]
    InvalidRange { start: u64, end: u64 },
    #[error("native HTTP range response rejected: {message}")]
    RangeResponseRejected { message: String },
    #[error("native transfer paused")]
    Paused,
    #[error("native transfer cancelled")]
    Cancelled,
}

impl From<nova_download_core::TransportError> for TransportError {
    fn from(error: nova_download_core::TransportError) -> Self {
        match error {
            nova_download_core::TransportError::RequestFailed { message } => {
                Self::RequestFailed { message }
            }
            nova_download_core::TransportError::InvalidStatus { status } => {
                Self::InvalidStatus { status }
            }
            nova_download_core::TransportError::InvalidRange { start, end } => {
                Self::InvalidRange { start, end }
            }
            nova_download_core::TransportError::RangeResponseRejected { message } => {
                Self::RangeResponseRejected { message }
            }
            nova_download_core::TransportError::InvalidRequestContext { message } => {
                Self::RequestFailed { message }
            }
            nova_download_core::TransportError::ResponseTooLarge { limit_bytes } => {
                Self::RequestFailed {
                    message: format!(
                        "native HTTP response exceeded the in-memory limit of {limit_bytes} bytes"
                    ),
                }
            }
            nova_download_core::TransportError::Paused => Self::Paused,
            nova_download_core::TransportError::Cancelled => Self::Cancelled,
        }
    }
}

/// Validates that a mobile client and the Rust core agree on the public bridge
/// contract before any task command is accepted.
#[uniffi::export]
pub fn initialize(client_bridge_api_version: u32) -> Result<BridgeInfo, BridgeError> {
    if client_bridge_api_version != BRIDGE_API_VERSION {
        return Err(BridgeError::IncompatibleVersion {
            client_version: client_bridge_api_version,
            core_version: BRIDGE_API_VERSION,
        });
    }

    Ok(BridgeInfo {
        bridge_api_version: BRIDGE_API_VERSION,
        core_version: env!("CARGO_PKG_VERSION").to_owned(),
        task_schema: "nova.task.v1".to_owned(),
        recovery_schema_version: nova_core_model::RECOVERY_SCHEMA_VERSION,
    })
}

/// Performs a bounded HTTP metadata probe with NOVA's bundled libcurl.
///
/// This is intentionally the first network operation exposed by the mobile
/// bridge: Android can discover the final URL, status, and remote size without
/// inventing a second HTTP stack. Identity encoding keeps metadata aligned with
/// the byte representation that subsequent Range requests address.
#[uniffi::export]
pub fn probe_http_resource(url: String) -> Result<HttpResourceProbe, TransportError> {
    nova_download_core::probe_http_resource(&url)
        .map(|probe| HttpResourceProbe {
            response_status: probe.response_status,
            content_length: probe.content_length,
            effective_url: probe.effective_url,
            etag: probe.etag,
            last_modified: probe.last_modified,
        })
        .map_err(TransportError::from)
}

/// Performs and validates an inclusive HTTP byte-range GET with native libcurl.
///
/// Payload bytes stay inside Rust and are streamed through the same guarded sink
/// that durable Android segment storage will use. The public probe intentionally
/// discards the bytes while exercising the exact production validation path.
#[uniffi::export]
pub fn probe_http_range(
    url: String,
    start: u64,
    end: u64,
) -> Result<HttpRangeProbe, TransportError> {
    nova_download_core::probe_http_range(&url, start, end)
        .map(|probe| HttpRangeProbe {
            response_status: probe.response_status,
            range_start: probe.range_start,
            range_end: probe.range_end,
            bytes_received: probe.bytes_received,
            effective_url: probe.effective_url,
        })
        .map_err(TransportError::from)
}

/// Plans balanced inclusive byte ranges using the same platform-neutral policy
/// consumed by NOVA's native transfer engine.
///
/// Mobile lifecycle code may request fewer connections for battery/network
/// policy, but it must not invent a separate segmentation algorithm.
#[uniffi::export]
pub fn plan_transfer_ranges(total_bytes: u64, requested_connections: u32) -> Vec<TransferRange> {
    nova_download_core::plan_transfer_ranges(total_bytes, requested_connections)
        .into_iter()
        .map(|range| TransferRange {
            start: range.start,
            end: range.end,
        })
        .collect()
}

/// Applies the same resume-corruption policy used by the shared NOVA core.
///
/// Transports (libcurl on the native path, or another host integration) must not
/// append response bytes until this returns `Append`. This keeps Android and
/// desktop aligned on range semantics while the mobile transport migration is
/// completed incrementally.
#[uniffi::export]
pub fn plan_http_resume(
    existing_bytes: u64,
    response_status: u16,
    content_range_start: Option<u64>,
) -> ResumeAction {
    match nova_download_core::plan_http_resume(existing_bytes, response_status, content_range_start)
    {
        nova_download_core::ResumeAction::Append => ResumeAction::Append,
        nova_download_core::ResumeAction::Restart => ResumeAction::Restart,
    }
}

/// Applies NOVA's validator-aware shared recovery policy.
#[uniffi::export]
pub fn plan_http_recovery(
    existing_bytes: u64,
    response_status: u16,
    content_range_start: Option<u64>,
    previous: RecoveryIdentity,
    current: RecoveryIdentity,
) -> ResumeAction {
    let previous: nova_core_model::ResourceIdentity = previous.into();
    let current: nova_core_model::ResourceIdentity = current.into();
    match nova_core_model::plan_http_recovery(
        existing_bytes,
        response_status,
        content_range_start,
        &previous,
        &current,
    ) {
        nova_core_model::ResumeAction::Append => ResumeAction::Append,
        nova_core_model::ResumeAction::Restart => ResumeAction::Restart,
    }
}

fn mobile_media_descriptor(descriptor: nova_media_core::MediaDescriptor) -> MobileMediaDescriptor {
    let source_kind = match descriptor.source_kind {
        nova_media_core::MediaSourceKind::Direct => "direct",
        nova_media_core::MediaSourceKind::Hls => "hls",
        nova_media_core::MediaSourceKind::Dash => "dash",
        nova_media_core::MediaSourceKind::Site => "site",
        nova_media_core::MediaSourceKind::Live => "live",
    }
    .to_owned();

    let streams = descriptor
        .streams
        .into_iter()
        .map(|stream| MobileMediaStream {
            id: stream.id,
            kind: match stream.kind {
                nova_media_core::MediaTrackKind::Video => MobileMediaTrackKind::Video,
                nova_media_core::MediaTrackKind::Audio => MobileMediaTrackKind::Audio,
                nova_media_core::MediaTrackKind::AudioVideo => MobileMediaTrackKind::AudioVideo,
                nova_media_core::MediaTrackKind::Subtitle => MobileMediaTrackKind::Subtitle,
            },
            protocol: match stream.protocol {
                nova_media_core::MediaProtocol::Http => MobileMediaProtocol::Http,
                nova_media_core::MediaProtocol::Https => MobileMediaProtocol::Https,
                nova_media_core::MediaProtocol::Hls => MobileMediaProtocol::Hls,
                nova_media_core::MediaProtocol::Dash => MobileMediaProtocol::Dash,
            },
            url: stream.url,
            container: stream.container,
            video_codec: stream.video_codec,
            audio_codec: stream.audio_codec,
            width: stream.width,
            height: stream.height,
            fps: stream.fps.map(f64::from),
            bitrate_bps: stream.bitrate_bps,
            audio_bitrate_bps: stream.audio_bitrate_bps,
            content_length: stream.content_length,
            language: stream.language,
        })
        .collect();

    let subtitles = descriptor
        .subtitles
        .into_iter()
        .map(|subtitle| MobileSubtitleTrack {
            language: subtitle.language,
            name: subtitle.name,
            url: subtitle.url,
            format: subtitle.format,
            automatic: subtitle.automatic,
        })
        .collect();

    MobileMediaDescriptor {
        source_kind,
        title: descriptor.metadata.title,
        description: descriptor.metadata.description,
        duration_millis: descriptor.metadata.duration_millis,
        uploader: descriptor.metadata.uploader,
        webpage_url: descriptor.metadata.webpage_url,
        thumbnail_url: descriptor.metadata.thumbnail_url,
        is_live: descriptor.is_live,
        streams,
        subtitles,
    }
}

fn resolve_native_media_descriptor(
    request: MobileMediaResolveRequest,
) -> Result<
    (
        nova_media_core::ExtractRequest,
        nova_media_core::MediaDescriptor,
    ),
    MediaResolveError,
> {
    let mut extract = nova_media_core::ExtractRequest::new(request.url);
    if let Some(user_agent) = request
        .user_agent
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        extract.headers.insert("User-Agent".to_owned(), user_agent);
    }
    if let Some(referer) = request
        .referer
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        extract.headers.insert("Referer".to_owned(), referer);
    }
    if let Some(cookie) = request
        .cookie_header
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        extract.headers.insert("Cookie".to_owned(), cookie);
    }

    let parsed = extract
        .parsed_url()
        .map_err(|error| MediaResolveError::InvalidRequest {
            message: error.to_string(),
        })?;
    extract
        .request_context()
        .map_err(|error| MediaResolveError::InvalidRequest {
            message: error.to_string(),
        })?;

    let descriptor = if nova_media_core::youtube_video_id(&parsed).is_some() {
        let extractor = nova_media_core::YouTubeExtractor;
        let mut extraction = extractor.extract_native(&extract).map_err(|error| {
            MediaResolveError::ResolveFailed {
                message: error.to_string(),
            }
        })?;
        if !extraction.pending_formats.is_empty() {
            let context =
                extract
                    .request_context()
                    .map_err(|error| MediaResolveError::InvalidRequest {
                        message: error.to_string(),
                    })?;
            let solver = nova_media_core::YouTubePlayerScriptSolver;
            nova_media_core::resolve_youtube_pending_formats(&mut extraction, &context, &solver)
                .map_err(|error| MediaResolveError::ResolveFailed {
                    message: error.to_string(),
                })?;
        }
        extraction.descriptor
    } else {
        nova_media_core::ExtractorRegistry::with_native_defaults()
            .resolve(&extract)
            .map_err(|error| MediaResolveError::ResolveFailed {
                message: error.to_string(),
            })?
    };

    Ok((extract, descriptor))
}

fn resolve_mobile_media_descriptor(
    request: MobileMediaResolveRequest,
) -> Result<MobileMediaDescriptor, MediaResolveError> {
    resolve_native_media_descriptor(request)
        .map(|(_, descriptor)| mobile_media_descriptor(descriptor))
}

#[uniffi::export]
pub fn resolve_media(
    request: MobileMediaResolveRequest,
) -> Result<MobileMediaDescriptor, MediaResolveError> {
    resolve_mobile_media_descriptor(request)
}

/// Re-resolves one chosen representation in Rust and downloads it with the
/// extractor-owned, origin-scoped request context. CDN URLs and auth headers
/// therefore never need to enter Kotlin task storage. Static HLS and DASH
/// plans are staged and assembled by the same native task session.
#[uniffi::export]
pub fn download_mobile_media_stream(
    request: MobileMediaDownloadRequest,
) -> Result<MobileMediaDownloadResult, MediaDownloadError> {
    if request.task_id.trim().is_empty() || request.stream_id.trim().is_empty() {
        return Err(MediaDownloadError::InvalidRequest {
            message: "task id and stream id are required".to_owned(),
        });
    }
    if request.output_container.is_empty()
        || request.output_container.len() > 8
        || !request
            .output_container
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(MediaDownloadError::InvalidRequest {
            message: "a short alphanumeric output container is required".to_owned(),
        });
    }
    let (_extract, descriptor) = resolve_native_media_descriptor(MobileMediaResolveRequest {
        url: request.webpage_url.clone(),
        user_agent: None,
        referer: None,
        cookie_header: None,
    })
    .map_err(|error| match error {
        MediaResolveError::InvalidRequest { message } => {
            MediaDownloadError::InvalidRequest { message }
        }
        MediaResolveError::ResolveFailed { message } => {
            MediaDownloadError::ResolveFailed { message }
        }
    })?;
    let stream = descriptor
        .streams
        .iter()
        .find(|stream| stream.id == request.stream_id)
        .ok_or_else(|| MediaDownloadError::ResolveFailed {
            message: "selected media stream is no longer available; analyze the page again"
                .to_owned(),
        })?;
    let context = descriptor
        .request_context_for_stream(stream)
        .map_err(|error| MediaDownloadError::InvalidRequest {
            message: error.to_string(),
        })?;
    match stream.protocol {
        nova_media_core::MediaProtocol::Http | nova_media_core::MediaProtocol::Https => {
            let outcome = nova_mobile_core::download_to_app_private_path_with_context(
                &request.task_id,
                &stream.url,
                std::path::Path::new(&request.app_private_root),
                std::path::Path::new(&request.relative_destination),
                &context,
                nova_mobile_core::DEFAULT_MOBILE_CONNECTIONS,
            )
            .map_err(map_mobile_transfer_error)?;
            Ok(MobileMediaDownloadResult {
                final_bytes: outcome.final_bytes,
                total_bytes: outcome.total_bytes,
                resumed_from: outcome.resumed_from,
            })
        }
        nova_media_core::MediaProtocol::Hls | nova_media_core::MediaProtocol::Dash => {
            download_native_manifest_stream(&request, &descriptor, stream, &context)
        }
    }
}

pub fn discard_mobile_media_staging(
    app_private_root: &str,
    task_id: &str,
) -> Result<(), MediaDownloadError> {
    nova_mobile_core::discard_app_private_media_staging_dir(
        std::path::Path::new(app_private_root),
        task_id,
    )
    .map_err(map_mobile_transfer_error)
}

fn map_mobile_transfer_error(error: nova_mobile_core::MobileTransferError) -> MediaDownloadError {
    let message = error.to_string();
    match error {
        nova_mobile_core::MobileTransferError::InvalidRelativeDestination
        | nova_mobile_core::MobileTransferError::DestinationEscapedRoot => {
            MediaDownloadError::InvalidRequest { message }
        }
        nova_mobile_core::MobileTransferError::Paused => MediaDownloadError::Paused,
        nova_mobile_core::MobileTransferError::Cancelled => MediaDownloadError::Cancelled,
        nova_mobile_core::MobileTransferError::TransferFailed { .. } => {
            MediaDownloadError::DownloadFailed { message }
        }
    }
}

fn check_mobile_media_control(
    session: &nova_mobile_core::MobileTransferSession,
) -> Result<(), MediaDownloadError> {
    match session.control() {
        nova_download_core::TransferControl::Continue => Ok(()),
        nova_download_core::TransferControl::Pause => Err(MediaDownloadError::Paused),
        nova_download_core::TransferControl::Cancel => Err(MediaDownloadError::Cancelled),
    }
}

fn fetch_mobile_manifest_text(
    url: &str,
    context: &nova_download_core::HttpRequestContext,
    session: &nova_mobile_core::MobileTransferSession,
) -> Result<(String, String), MediaDownloadError> {
    check_mobile_media_control(session)?;
    let response = nova_download_core::fetch_http_bytes_with_context(
        url,
        context,
        nova_media_core::DEFAULT_MANIFEST_MAX_BYTES,
    )
    .map_err(|error| MediaDownloadError::DownloadFailed {
        message: format!("native manifest request failed: {error}"),
    })?;
    check_mobile_media_control(session)?;
    let body =
        String::from_utf8(response.body).map_err(|_| MediaDownloadError::DownloadFailed {
            message: "native media manifest is not UTF-8".to_owned(),
        })?;
    Ok((response.effective_url, body))
}

fn assemble_mobile_media_parts<I>(
    parts: I,
    destination: &std::path::Path,
) -> Result<u64, MediaDownloadError>
where
    I: IntoIterator<Item = (u64, std::path::PathBuf)>,
{
    let parts = parts.into_iter().collect::<Vec<_>>();
    let assembled =
        nova_media_core::assemble_ordered_parts(&parts, destination).map_err(|error| {
            MediaDownloadError::DownloadFailed {
                message: error.to_string(),
            }
        })?;
    Ok(assembled.bytes)
}

fn publish_mobile_media_output(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<u64, MediaDownloadError> {
    let bytes = std::fs::metadata(source)
        .map_err(|error| MediaDownloadError::DownloadFailed {
            message: error.to_string(),
        })?
        .len();
    if bytes == 0 {
        return Err(MediaDownloadError::DownloadFailed {
            message: "native media pipeline produced an empty file".to_owned(),
        });
    }
    if destination.exists() {
        std::fs::remove_file(destination).map_err(|error| MediaDownloadError::DownloadFailed {
            message: error.to_string(),
        })?;
    }
    std::fs::rename(source, destination).map_err(|error| MediaDownloadError::DownloadFailed {
        message: error.to_string(),
    })?;
    Ok(bytes)
}

fn media_container_from_urls<'a>(
    urls: impl IntoIterator<Item = &'a str>,
    fragmented_mp4: bool,
    fallback: &str,
) -> String {
    if fragmented_mp4 {
        return "mp4".to_owned();
    }
    urls.into_iter()
        .filter_map(|url| {
            let path = url.split(['?', '#']).next().unwrap_or(url);
            path.rsplit('/')
                .next()
                .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext))
        })
        .find_map(|extension| match extension.to_ascii_lowercase().as_str() {
            "m4s" | "mp4" | "m4a" => Some("mp4".to_owned()),
            "ts" | "m2ts" | "mts" => Some("ts".to_owned()),
            "aac" => Some("aac".to_owned()),
            "mp3" => Some("mp3".to_owned()),
            "webm" => Some("webm".to_owned()),
            "mkv" => Some("mkv".to_owned()),
            _ => None,
        })
        .unwrap_or_else(|| fallback.to_owned())
}

fn media_mux_output_extension(container: &str) -> Option<&'static str> {
    match container
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" | "mov" | "m4a" => Some("mp4"),
        "mkv" | "matroska" => Some("mkv"),
        "webm" => Some("webm"),
        "ts" | "mpegts" | "mpeg-ts" | "m2ts" => Some("ts"),
        _ => None,
    }
}

fn mux_mobile_media_tracks(
    task_id: &str,
    video_path: &std::path::Path,
    audio_path: &std::path::Path,
    video_container: &str,
    audio_container: &str,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    output_container: &str,
    staging_dir: &std::path::Path,
    destination: &std::path::Path,
    session: &nova_mobile_core::MobileTransferSession,
) -> Result<u64, MediaDownloadError> {
    check_mobile_media_control(session)?;
    let output_extension = media_mux_output_extension(output_container).ok_or_else(|| {
        MediaDownloadError::DownloadFailed {
            message: format!(
                "separate audio/video streams require a native muxer for .{output_container}"
            ),
        }
    })?;
    let muxed = staging_dir.join(format!("muxed-{task_id}.{output_extension}"));
    let job = nova_media_processing_core::NativeMediaMuxJob {
        video_source: video_path.to_owned(),
        audio_source: audio_path.to_owned(),
        destination: muxed.clone(),
        video_container: video_container.to_owned(),
        audio_container: audio_container.to_owned(),
        video_codec,
        audio_codec,
    };
    let control = || match session.control() {
        nova_download_core::TransferControl::Continue => {
            nova_media_processing_core::MediaProcessingControl::Continue
        }
        nova_download_core::TransferControl::Pause => {
            nova_media_processing_core::MediaProcessingControl::Pause
        }
        nova_download_core::TransferControl::Cancel => {
            nova_media_processing_core::MediaProcessingControl::Cancel
        }
    };
    let progress = |_update: &nova_media_processing_core::MediaProcessingProgress| {};
    nova_media_processing_core::mux_local_media_tracks(&job, &control, &progress).map_err(
        |error| match error {
            nova_media_processing_core::MediaProcessingError::Paused => MediaDownloadError::Paused,
            nova_media_processing_core::MediaProcessingError::Cancelled => {
                MediaDownloadError::Cancelled
            }
            other => MediaDownloadError::DownloadFailed {
                message: other.to_string(),
            },
        },
    )?;
    publish_mobile_media_output(&muxed, destination)
}

fn download_native_manifest_stream(
    request: &MobileMediaDownloadRequest,
    descriptor: &nova_media_core::MediaDescriptor,
    stream: &nova_media_core::MediaStream,
    context: &nova_download_core::HttpRequestContext,
) -> Result<MobileMediaDownloadResult, MediaDownloadError> {
    let root = std::path::Path::new(&request.app_private_root);
    let destination = nova_mobile_core::prepare_app_private_output_path(
        root,
        std::path::Path::new(&request.relative_destination),
    )
    .map_err(map_mobile_transfer_error)?;
    let staging_dir =
        nova_mobile_core::prepare_app_private_media_staging_dir(root, &request.task_id)
            .map_err(map_mobile_transfer_error)?;
    let session = nova_mobile_core::begin_mobile_transfer_session(&request.task_id)
        .map_err(map_mobile_transfer_error)?;

    let result = match stream.protocol {
        nova_media_core::MediaProtocol::Hls => download_native_hls_stream(
            request,
            stream,
            context,
            &staging_dir,
            &destination,
            &session,
        ),
        nova_media_core::MediaProtocol::Dash => download_native_dash_stream(
            request,
            descriptor,
            stream,
            context,
            &staging_dir,
            &destination,
            &session,
        ),
        nova_media_core::MediaProtocol::Http | nova_media_core::MediaProtocol::Https => {
            Err(MediaDownloadError::InvalidRequest {
                message: "a manifest task requires an HLS or DASH stream".to_owned(),
            })
        }
    };
    session.finish();

    if matches!(result, Ok(_)) || matches!(result, Err(MediaDownloadError::Cancelled)) {
        let _ = nova_mobile_core::discard_app_private_media_staging_dir(root, &request.task_id);
    }
    result.map(|final_bytes| MobileMediaDownloadResult {
        final_bytes,
        total_bytes: Some(final_bytes),
        resumed_from: 0,
    })
}

fn download_native_hls_stream(
    request: &MobileMediaDownloadRequest,
    stream: &nova_media_core::MediaStream,
    initial_context: &nova_download_core::HttpRequestContext,
    staging_dir: &std::path::Path,
    destination: &std::path::Path,
    session: &nova_mobile_core::MobileTransferSession,
) -> Result<u64, MediaDownloadError> {
    use nova_stream_core::{
        build_hls_media_plan, parse_hls, select_best_hls_variant, HlsPlaylistKind, HlsRenditionKind,
    };

    let (mut manifest_url, manifest_body) =
        fetch_mobile_manifest_text(&stream.url, initial_context, session)?;
    let mut context = initial_context.clone();
    let mut manifest = parse_hls(&manifest_url, &manifest_body).map_err(|error| {
        MediaDownloadError::DownloadFailed {
            message: format!("native HLS manifest parse failed: {error}"),
        }
    })?;
    let mut audio_playlist: Option<(String, nova_download_core::HttpRequestContext)> = None;
    let mut selected_codecs: Option<Vec<String>> = None;

    for _ in 0..4 {
        if manifest.kind == HlsPlaylistKind::Media {
            break;
        }
        let variant = select_best_hls_variant(&manifest).cloned().ok_or_else(|| {
            MediaDownloadError::DownloadFailed {
                message: "HLS master playlist contains no selectable variant".to_owned(),
            }
        })?;
        selected_codecs = Some(variant.codecs.clone());
        if let Some(group_id) = variant.audio_group.as_deref() {
            let rendition = manifest
                .renditions
                .iter()
                .filter(|rendition| {
                    rendition.kind == HlsRenditionKind::Audio
                        && rendition.group_id == group_id
                        && rendition.uri.is_some()
                })
                .max_by_key(|rendition| (rendition.default, rendition.autoselect))
                .ok_or_else(|| MediaDownloadError::DownloadFailed {
                    message: format!("HLS audio group '{group_id}' has no downloadable rendition"),
                })?;
            let audio_url =
                rendition
                    .uri
                    .clone()
                    .ok_or_else(|| MediaDownloadError::DownloadFailed {
                        message: "HLS audio rendition is missing its playlist URL".to_owned(),
                    })?;
            let audio_context =
                nova_media_core::scope_http_request_context(&context, &manifest_url, &audio_url);
            audio_playlist = Some((audio_url, audio_context));
        }
        let next_context =
            nova_media_core::scope_http_request_context(&context, &manifest_url, &variant.uri);
        let (next_url, next_body) =
            fetch_mobile_manifest_text(&variant.uri, &next_context, session)?;
        manifest_url = next_url;
        context = next_context;
        manifest = parse_hls(&manifest_url, &next_body).map_err(|error| {
            MediaDownloadError::DownloadFailed {
                message: format!("native HLS variant playlist parse failed: {error}"),
            }
        })?;
    }
    if manifest.kind != HlsPlaylistKind::Media {
        return Err(MediaDownloadError::DownloadFailed {
            message: "HLS master playlist nesting exceeds the supported limit".to_owned(),
        });
    }
    if !manifest.end_list {
        return Err(MediaDownloadError::DownloadFailed {
            message: "live HLS requires the native live-session scheduler; finite playlists can be downloaded here".to_owned(),
        });
    }

    let video_plan =
        build_hls_media_plan(&manifest).map_err(|error| MediaDownloadError::DownloadFailed {
            message: error.to_string(),
        })?;
    let video_container = media_container_from_urls(
        video_plan.units.iter().map(|unit| unit.uri.as_str()),
        video_plan
            .units
            .iter()
            .any(|unit| unit.kind == nova_stream_core::HlsTransferUnitKind::Initialization),
        "ts",
    );
    let video_stage = staging_dir.join("hls-video");
    let base_context = context.clone();
    let manifest_origin = manifest_url.clone();
    let video = nova_media_core::stage_hls_media_plan_controlled_with_transfer_control_scoped(
        &video_plan,
        &base_context,
        Some(&manifest_origin),
        &video_stage,
        nova_mobile_core::DEFAULT_MOBILE_CONNECTIONS,
        || session.control(),
        |bytes| session.update_progress(bytes, None),
    )
    .map_err(map_hls_stage_error)?;
    let video_path = staging_dir.join(format!("hls-video.{video_container}"));
    let video_bytes = assemble_mobile_media_parts(
        video
            .files
            .iter()
            .map(|file| (file.order, file.path.clone())),
        &video_path,
    )?;

    let Some((audio_url, audio_context)) = audio_playlist else {
        check_mobile_media_control(session)?;
        return publish_mobile_media_output(&video_path, destination).map(|_| video_bytes);
    };
    let (audio_manifest_url, audio_body) =
        fetch_mobile_manifest_text(&audio_url, &audio_context, session)?;
    let audio_manifest = parse_hls(&audio_manifest_url, &audio_body).map_err(|error| {
        MediaDownloadError::DownloadFailed {
            message: format!("native HLS audio playlist parse failed: {error}"),
        }
    })?;
    if audio_manifest.kind != HlsPlaylistKind::Media || !audio_manifest.end_list {
        return Err(MediaDownloadError::DownloadFailed {
            message: "HLS separate audio must be a finite media playlist".to_owned(),
        });
    }
    let audio_plan = build_hls_media_plan(&audio_manifest).map_err(|error| {
        MediaDownloadError::DownloadFailed {
            message: error.to_string(),
        }
    })?;
    let audio_container = media_container_from_urls(
        audio_plan.units.iter().map(|unit| unit.uri.as_str()),
        audio_plan
            .units
            .iter()
            .any(|unit| unit.kind == nova_stream_core::HlsTransferUnitKind::Initialization),
        "mp4",
    );
    let audio_stage = staging_dir.join("hls-audio");
    let audio_base = video_bytes;
    let audio_manifest_origin = audio_manifest_url.clone();
    let audio = nova_media_core::stage_hls_media_plan_controlled_with_transfer_control_scoped(
        &audio_plan,
        &audio_context,
        Some(&audio_manifest_origin),
        &audio_stage,
        nova_mobile_core::DEFAULT_MOBILE_CONNECTIONS,
        || session.control(),
        |bytes| session.update_progress(audio_base.saturating_add(bytes), None),
    )
    .map_err(map_hls_stage_error)?;
    let audio_path = staging_dir.join(format!("hls-audio.{audio_container}"));
    let audio_bytes = assemble_mobile_media_parts(
        audio
            .files
            .iter()
            .map(|file| (file.order, file.path.clone())),
        &audio_path,
    )?;
    let codec_list = selected_codecs.unwrap_or_default();
    let video_codec = codec_list.iter().find(|codec| {
        let codec = codec.to_ascii_lowercase();
        codec.starts_with("avc")
            || codec.starts_with("hvc")
            || codec.starts_with("hev")
            || codec.starts_with("vp")
            || codec.starts_with("av01")
    });
    let audio_codec = codec_list.iter().find(|codec| {
        let codec = codec.to_ascii_lowercase();
        codec.starts_with("mp4a") || codec.starts_with("ac-3") || codec.starts_with("ec-3")
    });
    let output_container = request
        .output_container
        .as_str()
        .trim()
        .trim_start_matches('.');
    let final_bytes = mux_mobile_media_tracks(
        &request.task_id,
        &video_path,
        &audio_path,
        &video_container,
        &audio_container,
        video_codec.cloned(),
        audio_codec.cloned(),
        output_container,
        staging_dir,
        destination,
        session,
    )?;
    let _staged_track_bytes = video_bytes.saturating_add(audio_bytes);
    Ok(final_bytes)
}

fn map_hls_stage_error(error: nova_media_core::HlsStageError) -> MediaDownloadError {
    match error {
        nova_media_core::HlsStageError::Paused => MediaDownloadError::Paused,
        nova_media_core::HlsStageError::Cancelled => MediaDownloadError::Cancelled,
        other => MediaDownloadError::DownloadFailed {
            message: other.to_string(),
        },
    }
}

fn map_dash_stage_error(error: nova_media_core::DashStageError) -> MediaDownloadError {
    match error {
        nova_media_core::DashStageError::Paused => MediaDownloadError::Paused,
        nova_media_core::DashStageError::Cancelled => MediaDownloadError::Cancelled,
        other => MediaDownloadError::DownloadFailed {
            message: other.to_string(),
        },
    }
}

fn download_native_dash_stream(
    request: &MobileMediaDownloadRequest,
    descriptor: &nova_media_core::MediaDescriptor,
    stream: &nova_media_core::MediaStream,
    initial_context: &nova_download_core::HttpRequestContext,
    staging_dir: &std::path::Path,
    destination: &std::path::Path,
    session: &nova_mobile_core::MobileTransferSession,
) -> Result<u64, MediaDownloadError> {
    use nova_stream_core::{
        build_dash_representation_plan, parse_dash, select_best_dash_representation, DashTrackKind,
    };

    let (manifest_url, body) = fetch_mobile_manifest_text(&stream.url, initial_context, session)?;
    let manifest = parse_dash(&body).map_err(|error| MediaDownloadError::DownloadFailed {
        message: format!("native DASH manifest parse failed: {error}"),
    })?;
    if manifest.is_dynamic {
        return Err(MediaDownloadError::DownloadFailed {
            message: "dynamic DASH requires the native live-session scheduler; static manifests are supported here".to_owned(),
        });
    }
    if manifest.periods.len() != 1 {
        return Err(MediaDownloadError::DownloadFailed {
            message: "this Android task runner currently accepts one static DASH period per task"
                .to_owned(),
        });
    }
    let period = manifest
        .periods
        .first()
        .ok_or_else(|| MediaDownloadError::DownloadFailed {
            message: "DASH manifest contains no periods".to_owned(),
        })?;
    let mut video_selection = None;
    let mut audio_selection = None;
    for (adaptation_index, adaptation) in period.adaptations.iter().enumerate() {
        let Some(representation) = select_best_dash_representation(adaptation) else {
            continue;
        };
        let Some(representation_index) = adaptation
            .representations
            .iter()
            .position(|candidate| std::ptr::eq(candidate, representation))
        else {
            continue;
        };
        let plan = build_dash_representation_plan(
            &manifest,
            &manifest_url,
            0,
            adaptation_index,
            representation_index,
        )
        .map_err(|error| MediaDownloadError::DownloadFailed {
            message: format!("DASH representation planning failed: {error}"),
        })?;
        let container = media_container_from_urls(
            plan.units.iter().map(|unit| unit.url.as_str()),
            plan.units.iter().any(|unit| unit.initialization),
            "mp4",
        );
        let selected = (
            plan,
            representation
                .codecs
                .clone()
                .or_else(|| adaptation.codecs.clone()),
            container,
        );
        match selected.0.track_kind {
            DashTrackKind::Video => {
                if video_selection.as_ref().is_none_or(
                    |existing: &(
                        nova_stream_core::DashRepresentationPlan,
                        Option<String>,
                        String,
                    )| {
                        selected.0.bandwidth.unwrap_or(0) > existing.0.bandwidth.unwrap_or(0)
                    },
                )
                {
                    video_selection = Some(selected);
                }
            }
            DashTrackKind::Audio => {
                if audio_selection.as_ref().is_none_or(
                    |existing: &(
                        nova_stream_core::DashRepresentationPlan,
                        Option<String>,
                        String,
                    )| {
                        selected.0.bandwidth.unwrap_or(0) > existing.0.bandwidth.unwrap_or(0)
                    },
                )
                {
                    audio_selection = Some(selected);
                }
            }
            DashTrackKind::Other => {}
        }
    }
    if video_selection.is_none() && audio_selection.is_none() {
        return Err(MediaDownloadError::DownloadFailed {
            message: "DASH manifest has no supported audio or video representation".to_owned(),
        });
    }

    let manifest_context = descriptor
        .request_context_for_stream(stream)
        .map_err(|error| MediaDownloadError::InvalidRequest {
            message: error.to_string(),
        })?;
    let mut assembled_video = None;
    let mut assembled_audio = None;
    if let Some((plan, codec, container)) = video_selection {
        let stage_dir = staging_dir.join("dash-video");
        let context_origin = manifest_url.clone();
        let staged = nova_media_core::stage_dash_representation_plan_controlled_with_transfer_control_scoped(
            &plan,
            &manifest_context,
            Some(&context_origin),
            &stage_dir,
            nova_mobile_core::DEFAULT_MOBILE_CONNECTIONS,
            || session.control(),
            |bytes| session.update_progress(bytes, None),
        )
        .map_err(map_dash_stage_error)?;
        let output = staging_dir.join(format!("dash-video.{container}"));
        assemble_mobile_media_parts(
            staged
                .files
                .iter()
                .map(|file| (file.order, file.path.clone())),
            &output,
        )?;
        assembled_video = Some((output, container, codec));
    }
    let video_bytes = assembled_video
        .as_ref()
        .and_then(|(path, _, _)| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if let Some((plan, codec, container)) = audio_selection {
        let stage_dir = staging_dir.join("dash-audio");
        let context_origin = manifest_url.clone();
        let staged = nova_media_core::stage_dash_representation_plan_controlled_with_transfer_control_scoped(
            &plan,
            &manifest_context,
            Some(&context_origin),
            &stage_dir,
            nova_mobile_core::DEFAULT_MOBILE_CONNECTIONS,
            || session.control(),
            |bytes| session.update_progress(video_bytes.saturating_add(bytes), None),
        )
        .map_err(map_dash_stage_error)?;
        let output = staging_dir.join(format!("dash-audio.{container}"));
        assemble_mobile_media_parts(
            staged
                .files
                .iter()
                .map(|file| (file.order, file.path.clone())),
            &output,
        )?;
        assembled_audio = Some((output, container, codec));
    }

    match (assembled_video, assembled_audio) {
        (
            Some((video_path, video_container, video_codec)),
            Some((audio_path, audio_container, audio_codec)),
        ) => mux_mobile_media_tracks(
            &request.task_id,
            &video_path,
            &audio_path,
            &video_container,
            &audio_container,
            video_codec,
            audio_codec,
            &request.output_container,
            staging_dir,
            destination,
            session,
        ),
        (Some((path, _, _)), None) | (None, Some((path, _, _))) => {
            check_mobile_media_control(session)?;
            publish_mobile_media_output(&path, destination)
        }
        (None, None) => Err(MediaDownloadError::DownloadFailed {
            message: "DASH plan did not produce a media track".to_owned(),
        }),
    }
}

fn mobile_codec_track_capabilities(
    capabilities: nova_media_processing_core::NativeMediaCodecTrackCapabilities,
) -> MobileMediaCodecTrackCapabilities {
    MobileMediaCodecTrackCapabilities {
        decoders: capabilities.decoders,
        encoders: capabilities.encoders,
        input_containers: capabilities.input_containers,
        output_containers: capabilities.output_containers,
        encoders_by_container: capabilities
            .encoders_by_container
            .into_iter()
            .map(|(extension, encoders)| MobileMediaCodecContainer {
                extension,
                encoders,
            })
            .collect(),
    }
}

/// Reports the codecs and containers registered by this exact native binary.
///
/// Android uses this response to keep its conversion controls aligned with the
/// codecs that can be decoded and encoded on the current ABI.
#[uniffi::export]
pub fn native_media_codec_capabilities() -> MobileMediaCodecCapabilities {
    let capabilities = nova_media_processing_core::native_media_codec_capabilities();
    MobileMediaCodecCapabilities {
        capability_registry_version: nova_core_model::CAPABILITY_REGISTRY_CONTRACT_VERSION,
        audio: mobile_codec_track_capabilities(capabilities.audio),
        video: mobile_codec_track_capabilities(capabilities.video),
        demuxers: capabilities.demuxers,
        muxers: capabilities.muxers,
        subtitle_containers: capabilities.subtitle_containers,
    }
}

#[uniffi::export]
pub fn transcode_mobile_media(
    request: MobileMediaTranscodeRequest,
) -> Result<MobileMediaTranscodeResult, MediaProcessingBridgeError> {
    run_mobile_media_transcode(request)
}

fn run_mobile_media_transcode(
    request: MobileMediaTranscodeRequest,
) -> Result<MobileMediaTranscodeResult, MediaProcessingBridgeError> {
    let options = nova_mobile_core::MobileMediaTranscodeOptions {
        input_container: request.options.input_container,
        source_video_codec: request.options.source_video_codec,
        source_audio_codec: request.options.source_audio_codec,
        video_codec: request.options.video_codec,
        audio_codec: request.options.audio_codec,
        video_bitrate_bps: request.options.video_bitrate_bps,
        audio_bitrate_bps: request.options.audio_bitrate_bps,
        quality_crf: request.options.quality_crf,
        preset: request.options.preset,
        width: request.options.width,
        height: request.options.height,
        frame_rate_milli: request.options.frame_rate_milli,
        audio_sample_rate_hz: request.options.audio_sample_rate_hz,
        audio_channels: request.options.audio_channels,
        threads: request.options.threads,
        include_video: request.options.include_video,
        include_audio: request.options.include_audio,
    };
    nova_mobile_core::transcode_media_in_app_private(
        &request.task_id,
        std::path::Path::new(&request.app_private_root),
        std::path::Path::new(&request.source_relative_path),
        std::path::Path::new(&request.destination_relative_path),
        &options,
    )
    .map(|result| MobileMediaTranscodeResult {
        output_bytes: result.output_bytes,
        packets_written: result.packets_written,
        frames_decoded: result.frames_decoded,
    })
    .map_err(|error| {
        let message = error.to_string();
        match error {
            nova_mobile_core::MobileMediaProcessingError::InvalidRelativePath
            | nova_mobile_core::MobileMediaProcessingError::PathEscapedRoot => {
                MediaProcessingBridgeError::InvalidRequest { message }
            }
            nova_mobile_core::MobileMediaProcessingError::Paused => {
                MediaProcessingBridgeError::Paused
            }
            nova_mobile_core::MobileMediaProcessingError::Cancelled => {
                MediaProcessingBridgeError::Cancelled
            }
            nova_mobile_core::MobileMediaProcessingError::ProcessingFailed { .. } => {
                MediaProcessingBridgeError::ProcessingFailed { message }
            }
        }
    })
}

#[uniffi::export]
pub fn mobile_media_processing_progress(task_id: String) -> Option<MobileMediaProcessingProgress> {
    nova_mobile_core::media_processing_progress(&task_id).map(|progress| {
        MobileMediaProcessingProgress {
            phase: progress.phase,
            completed_units: progress.completed_units,
            total_units: progress.total_units,
            fraction: progress.fraction,
            has_fraction: progress.has_fraction,
            active: progress.active,
        }
    })
}

#[uniffi::export]
pub fn pause_mobile_media_processing(task_id: String) -> bool {
    nova_mobile_core::pause_media_processing(&task_id)
}

#[uniffi::export]
pub fn resume_mobile_media_processing(task_id: String) -> bool {
    nova_mobile_core::resume_media_processing(&task_id)
}

#[uniffi::export]
pub fn cancel_mobile_media_processing(task_id: String) -> bool {
    nova_mobile_core::cancel_media_processing(&task_id)
}

#[uniffi::export]
pub fn forget_mobile_media_processing_progress(task_id: String) {
    nova_mobile_core::forget_media_processing_progress(&task_id);
}

#[cfg(any(target_os = "android", test))]
fn mobile_media_descriptor_json(descriptor: &MobileMediaDescriptor) -> String {
    let streams = descriptor
        .streams
        .iter()
        .map(|stream| {
            serde_json::json!({
                "id": stream.id,
                "kind": match stream.kind {
                    MobileMediaTrackKind::Video => "video",
                    MobileMediaTrackKind::Audio => "audio",
                    MobileMediaTrackKind::AudioVideo => "audio-video",
                    MobileMediaTrackKind::Subtitle => "subtitle",
                },
                "protocol": match stream.protocol {
                    MobileMediaProtocol::Http => "http",
                    MobileMediaProtocol::Https => "https",
                    MobileMediaProtocol::Hls => "hls",
                    MobileMediaProtocol::Dash => "dash",
                },
                "url": stream.url,
                "container": stream.container,
                "videoCodec": stream.video_codec,
                "audioCodec": stream.audio_codec,
                "width": stream.width,
                "height": stream.height,
                "fps": stream.fps,
                "bitrateBps": stream.bitrate_bps,
                "audioBitrateBps": stream.audio_bitrate_bps,
                "contentLength": stream.content_length,
                "language": stream.language,
            })
        })
        .collect::<Vec<_>>();
    let subtitles = descriptor
        .subtitles
        .iter()
        .map(|subtitle| {
            serde_json::json!({
                "language": subtitle.language,
                "name": subtitle.name,
                "url": subtitle.url,
                "format": subtitle.format,
                "automatic": subtitle.automatic,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "sourceKind": descriptor.source_kind,
        "title": descriptor.title,
        "description": descriptor.description,
        "durationMillis": descriptor.duration_millis,
        "uploader": descriptor.uploader,
        "webpageUrl": descriptor.webpage_url,
        "thumbnailUrl": descriptor.thumbnail_url,
        "isLive": descriptor.is_live,
        "streams": streams,
        "subtitles": subtitles,
        "engine": "nova-media-engine",
    })
    .to_string()
}

#[cfg(any(target_os = "android", test))]
fn mobile_media_codec_capabilities_json() -> String {
    let capabilities = nova_media_processing_core::native_media_codec_capabilities();
    serde_json::json!({
        "capabilityRegistryVersion": nova_core_model::CAPABILITY_REGISTRY_CONTRACT_VERSION,
        "audio": capabilities.audio,
        "video": capabilities.video,
        "demuxers": capabilities.demuxers,
        "muxers": capabilities.muxers,
        "subtitleContainers": capabilities.subtitle_containers,
        "engine": "nova-native-codecs",
    })
    .to_string()
}

#[cfg(any(target_os = "android", test))]
fn mobile_media_processing_progress_json(task_id: &str) -> String {
    let progress = nova_mobile_core::media_processing_progress(task_id).map(|progress| {
        serde_json::json!({
            "phase": progress.phase,
            "completedUnits": progress.completed_units,
            "totalUnits": progress.total_units,
            "fraction": progress.has_fraction.then_some(progress.fraction),
            "active": progress.active,
        })
    });
    progress.unwrap_or(serde_json::Value::Null).to_string()
}

#[uniffi::export]
pub fn transfer_progress(task_id: String) -> Option<NativeTransferProgress> {
    nova_mobile_core::transfer_progress(&task_id).map(|progress| NativeTransferProgress {
        downloaded_bytes: progress.downloaded_bytes,
        total_bytes: progress.total_bytes,
    })
}

#[uniffi::export]
pub fn forget_transfer_progress(task_id: String) {
    nova_mobile_core::forget_transfer_progress(&task_id);
}

/// Narrow primitive used by Android before the generated high-level task API is
/// activated. Keeping this handshake primitive means the APK can prove that the
/// packaged Rust library is present and ABI-compatible without introducing a
/// second Kotlin implementation of the NOVA task contract.
#[cfg(any(target_os = "android", test))]
fn android_initialize_status(client_bridge_api_version: i32) -> i32 {
    let Ok(client_version) = u32::try_from(client_bridge_api_version) else {
        return -1;
    };

    initialize(client_version)
        .map(|info| i32::try_from(info.bridge_api_version).unwrap_or(-1))
        .unwrap_or(-1)
}

/// JNI-safe projection of the shared range planner.
///
/// Returns the planned number of segments or -1 for invalid JNI inputs.
#[cfg(any(target_os = "android", test))]
fn android_plan_segment_count(total_bytes: i64, requested_connections: i32) -> i32 {
    let Ok(total_bytes) = u64::try_from(total_bytes) else {
        return -1;
    };
    let Ok(requested_connections) = u32::try_from(requested_connections) else {
        return -1;
    };

    i32::try_from(plan_transfer_ranges(total_bytes, requested_connections).len()).unwrap_or(-1)
}

/// Returns one inclusive range bound from the shared planner.
///
/// `bound` is 0 for start and 1 for end. Returns -1 for invalid inputs or an
/// out-of-bounds segment index.
#[cfg(any(target_os = "android", test))]
fn android_plan_segment_bound(
    total_bytes: i64,
    requested_connections: i32,
    segment_index: i32,
    bound: i32,
) -> i64 {
    let Ok(total_bytes) = u64::try_from(total_bytes) else {
        return -1;
    };
    let Ok(requested_connections) = u32::try_from(requested_connections) else {
        return -1;
    };
    let Ok(segment_index) = usize::try_from(segment_index) else {
        return -1;
    };

    let Some(range) = plan_transfer_ranges(total_bytes, requested_connections)
        .get(segment_index)
        .copied()
    else {
        return -1;
    };
    let value = match bound {
        0 => range.start,
        1 => range.end,
        _ => return -1,
    };

    i64::try_from(value).unwrap_or(-1)
}

/// JNI-safe projection of the shared resume policy.
///
/// `content_range_start` uses `-1` to represent an absent `Content-Range` start.
/// Returns 0 for append, 1 for restart, and -1 for invalid JNI inputs.
#[cfg(any(target_os = "android", test))]
fn android_plan_http_resume_status(
    existing_bytes: i64,
    response_status: i32,
    content_range_start: i64,
) -> i32 {
    let Ok(existing_bytes) = u64::try_from(existing_bytes) else {
        return -1;
    };
    let Ok(response_status) = u16::try_from(response_status) else {
        return -1;
    };
    let content_range_start = if content_range_start == -1 {
        None
    } else {
        let Ok(start) = u64::try_from(content_range_start) else {
            return -1;
        };
        Some(start)
    };

    match plan_http_resume(existing_bytes, response_status, content_range_start) {
        ResumeAction::Append => 0,
        ResumeAction::Restart => 1,
    }
}

/// JNI entry point used by `NovaNativeCore` on Android.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeInitialize(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    client_bridge_api_version: i32,
) -> i32 {
    android_initialize_status(client_bridge_api_version)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePlanSegmentCount(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    total_bytes: i64,
    requested_connections: i32,
) -> i32 {
    android_plan_segment_count(total_bytes, requested_connections)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePlanSegmentStart(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    total_bytes: i64,
    requested_connections: i32,
    segment_index: i32,
) -> i64 {
    android_plan_segment_bound(total_bytes, requested_connections, segment_index, 0)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePlanSegmentEnd(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    total_bytes: i64,
    requested_connections: i32,
    segment_index: i32,
) -> i64 {
    android_plan_segment_bound(total_bytes, requested_connections, segment_index, 1)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePlanHttpResume(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    existing_bytes: i64,
    response_status: i32,
    content_range_start: i64,
) -> i32 {
    android_plan_http_resume_status(existing_bytes, response_status, content_range_start)
}

#[cfg(target_os = "android")]
const ANDROID_TRANSFER_PAUSED: i64 = -2;
#[cfg(target_os = "android")]
const ANDROID_TRANSFER_CANCELLED: i64 = -3;

#[cfg(target_os = "android")]
fn jni_string(
    env: &mut jni::JNIEnv<'_>,
    value: &jni::objects::JString<'_>,
    field: &str,
) -> Result<String, String> {
    env.get_string(value)
        .map(String::from)
        .map_err(|error| format!("failed to decode {field}: {error}"))
}

#[cfg(target_os = "android")]
fn throw_android_transfer_error(env: &mut jni::JNIEnv<'_>, message: impl Into<String>) {
    let _ = env.throw_new("java/lang/IllegalStateException", message.into());
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeResolveMediaJson(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    url: jni::objects::JString<'_>,
    user_agent: jni::objects::JString<'_>,
    referer: jni::objects::JString<'_>,
    cookie_header: jni::objects::JString<'_>,
) -> jni::sys::jstring {
    let url = match jni_string(&mut env, &url, "media URL") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };
    let user_agent = match jni_string(&mut env, &user_agent, "media user-agent") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };
    let referer = match jni_string(&mut env, &referer, "media referer") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };
    let cookie_header = match jni_string(&mut env, &cookie_header, "media cookie header") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };

    let optional = |value: String| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    };
    let descriptor = match resolve_mobile_media_descriptor(MobileMediaResolveRequest {
        url,
        user_agent: optional(user_agent),
        referer: optional(referer),
        cookie_header: optional(cookie_header),
    }) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            throw_android_transfer_error(&mut env, error.to_string());
            return std::ptr::null_mut();
        }
    };

    match env.new_string(mobile_media_descriptor_json(&descriptor)) {
        Ok(value) => value.into_raw(),
        Err(error) => {
            throw_android_transfer_error(
                &mut env,
                format!("failed to encode native media descriptor for Android: {error}"),
            );
            std::ptr::null_mut()
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeMediaCodecCapabilitiesJson(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
) -> jni::sys::jstring {
    match env.new_string(mobile_media_codec_capabilities_json()) {
        Ok(value) => value.into_raw(),
        Err(error) => {
            throw_android_transfer_error(
                &mut env,
                format!("failed to encode native media codec capabilities: {error}"),
            );
            std::ptr::null_mut()
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeTranscodeMediaJson(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
    app_private_root: jni::objects::JString<'_>,
    source_relative_path: jni::objects::JString<'_>,
    destination_relative_path: jni::objects::JString<'_>,
    options_json: jni::objects::JString<'_>,
) -> jni::sys::jstring {
    let decode = |env: &mut jni::JNIEnv<'_>, value: &jni::objects::JString<'_>, field: &str| {
        jni_string(env, value, field)
    };
    let task_id = match decode(&mut env, &task_id, "media task id") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };
    let app_private_root = match decode(&mut env, &app_private_root, "app-private root") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };
    let source_relative_path = match decode(&mut env, &source_relative_path, "media source path") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };
    let destination_relative_path =
        match decode(&mut env, &destination_relative_path, "media output path") {
            Ok(value) => value,
            Err(message) => {
                throw_android_transfer_error(&mut env, message);
                return std::ptr::null_mut();
            }
        };
    let options_json = match decode(&mut env, &options_json, "media conversion options") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };
    let options = match serde_json::from_str::<MobileMediaTranscodeOptions>(&options_json) {
        Ok(value) => value,
        Err(error) => {
            throw_android_transfer_error(
                &mut env,
                format!("invalid native media conversion options: {error}"),
            );
            return std::ptr::null_mut();
        }
    };
    let result = run_mobile_media_transcode(MobileMediaTranscodeRequest {
        task_id,
        app_private_root,
        source_relative_path,
        destination_relative_path,
        options,
    });
    let payload = match result {
        Ok(result) => serde_json::json!({
            "status": "completed",
            "outputBytes": result.output_bytes,
            "packetsWritten": result.packets_written,
            "framesDecoded": result.frames_decoded,
        }),
        Err(MediaProcessingBridgeError::Paused) => serde_json::json!({ "status": "paused" }),
        Err(MediaProcessingBridgeError::Cancelled) => serde_json::json!({ "status": "cancelled" }),
        Err(error) => {
            throw_android_transfer_error(&mut env, error.to_string());
            return std::ptr::null_mut();
        }
    };
    match env.new_string(payload.to_string()) {
        Ok(value) => value.into_raw(),
        Err(error) => {
            throw_android_transfer_error(
                &mut env,
                format!("failed to encode native media conversion result: {error}"),
            );
            std::ptr::null_mut()
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeMediaProcessingProgressJson(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jstring {
    let task_id = match jni_string(&mut env, &task_id, "media task id") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return std::ptr::null_mut();
        }
    };
    match env.new_string(mobile_media_processing_progress_json(&task_id)) {
        Ok(value) => value.into_raw(),
        Err(error) => {
            throw_android_transfer_error(
                &mut env,
                format!("failed to encode native media processing progress: {error}"),
            );
            std::ptr::null_mut()
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePauseMediaProcessing(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jboolean {
    match jni_string(&mut env, &task_id, "media task id") {
        Ok(task_id) => u8::from(nova_mobile_core::pause_media_processing(&task_id)),
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            0
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeResumeMediaProcessing(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jboolean {
    match jni_string(&mut env, &task_id, "media task id") {
        Ok(task_id) => u8::from(nova_mobile_core::resume_media_processing(&task_id)),
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            0
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeCancelMediaProcessing(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jboolean {
    match jni_string(&mut env, &task_id, "media task id") {
        Ok(task_id) => u8::from(nova_mobile_core::cancel_media_processing(&task_id)),
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            0
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeForgetMediaProcessingProgress(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) {
    if let Ok(task_id) = jni_string(&mut env, &task_id, "media task id") {
        nova_mobile_core::forget_media_processing_progress(&task_id);
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeDownloadToAppPrivate(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
    url: jni::objects::JString<'_>,
    app_private_root: jni::objects::JString<'_>,
    relative_destination: jni::objects::JString<'_>,
) -> jni::sys::jlong {
    let task_id = match jni_string(&mut env, &task_id, "native task id") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };
    let url = match jni_string(&mut env, &url, "download URL") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };
    let app_private_root = match jni_string(&mut env, &app_private_root, "app-private root") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };
    let relative_destination =
        match jni_string(&mut env, &relative_destination, "relative destination") {
            Ok(value) => value,
            Err(message) => {
                throw_android_transfer_error(&mut env, message);
                return -1;
            }
        };

    match nova_mobile_core::download_to_app_private_path(
        &task_id,
        &url,
        std::path::Path::new(&app_private_root),
        std::path::Path::new(&relative_destination),
    ) {
        Ok(outcome) => i64::try_from(outcome.final_bytes).unwrap_or(-1),
        Err(nova_mobile_core::MobileTransferError::Paused) => ANDROID_TRANSFER_PAUSED,
        Err(nova_mobile_core::MobileTransferError::Cancelled) => ANDROID_TRANSFER_CANCELLED,
        Err(error) => {
            throw_android_transfer_error(&mut env, error.to_string());
            -1
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeDownloadMediaStreamToAppPrivate(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
    webpage_url: jni::objects::JString<'_>,
    stream_id: jni::objects::JString<'_>,
    output_container: jni::objects::JString<'_>,
    app_private_root: jni::objects::JString<'_>,
    relative_destination: jni::objects::JString<'_>,
) -> jni::sys::jlong {
    let task_id = match jni_string(&mut env, &task_id, "media task id") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };
    let webpage_url = match jni_string(&mut env, &webpage_url, "media webpage URL") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };
    let stream_id = match jni_string(&mut env, &stream_id, "media stream id") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };
    let output_container = match jni_string(&mut env, &output_container, "media output container") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };
    let app_private_root = match jni_string(&mut env, &app_private_root, "app-private root") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };
    let relative_destination = match jni_string(
        &mut env,
        &relative_destination,
        "media relative destination",
    ) {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return -1;
        }
    };

    match download_mobile_media_stream(MobileMediaDownloadRequest {
        task_id,
        webpage_url,
        stream_id,
        output_container,
        app_private_root,
        relative_destination,
    }) {
        Ok(outcome) => i64::try_from(outcome.final_bytes).unwrap_or(-1),
        Err(MediaDownloadError::Paused) => ANDROID_TRANSFER_PAUSED,
        Err(MediaDownloadError::Cancelled) => ANDROID_TRANSFER_CANCELLED,
        Err(error) => {
            throw_android_transfer_error(&mut env, error.to_string());
            -1
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeDiscardAppPrivateMediaStaging(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    app_private_root: jni::objects::JString<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jboolean {
    let app_private_root = match jni_string(&mut env, &app_private_root, "app-private root") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return 0;
        }
    };
    let task_id = match jni_string(&mut env, &task_id, "media task id") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return 0;
        }
    };
    match discard_mobile_media_staging(&app_private_root, &task_id) {
        Ok(()) => 1,
        Err(error) => {
            throw_android_transfer_error(&mut env, error.to_string());
            0
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePauseTransfer(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jboolean {
    match jni_string(&mut env, &task_id, "native task id") {
        Ok(task_id) => u8::from(nova_mobile_core::pause_transfer(&task_id)),
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            0
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeCancelTransfer(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jboolean {
    match jni_string(&mut env, &task_id, "native task id") {
        Ok(task_id) => u8::from(nova_mobile_core::cancel_transfer(&task_id)),
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            0
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeTransferDownloadedBytes(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jlong {
    match jni_string(&mut env, &task_id, "native task id") {
        Ok(task_id) => nova_mobile_core::transfer_progress(&task_id)
            .and_then(|progress| i64::try_from(progress.downloaded_bytes).ok())
            .unwrap_or(-1),
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            -1
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeTransferTotalBytes(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) -> jni::sys::jlong {
    match jni_string(&mut env, &task_id, "native task id") {
        Ok(task_id) => nova_mobile_core::transfer_progress(&task_id)
            .and_then(|progress| i64::try_from(progress.total_bytes).ok())
            .unwrap_or(-1),
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            -1
        }
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeForgetTransferProgress(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    task_id: jni::objects::JString<'_>,
) {
    if let Ok(task_id) = jni_string(&mut env, &task_id, "native task id") {
        nova_mobile_core::forget_transfer_progress(&task_id);
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeDiscardAppPrivateTransfer(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    app_private_root: jni::objects::JString<'_>,
    relative_destination: jni::objects::JString<'_>,
) -> jni::sys::jboolean {
    let app_private_root = match jni_string(&mut env, &app_private_root, "app-private root") {
        Ok(value) => value,
        Err(message) => {
            throw_android_transfer_error(&mut env, message);
            return 0;
        }
    };
    let relative_destination =
        match jni_string(&mut env, &relative_destination, "relative destination") {
            Ok(value) => value,
            Err(message) => {
                throw_android_transfer_error(&mut env, message);
                return 0;
            }
        };

    match nova_mobile_core::discard_app_private_transfer(
        std::path::Path::new(&app_private_root),
        std::path::Path::new(&relative_destination),
    ) {
        Ok(()) => 1,
        Err(error) => {
            throw_android_transfer_error(&mut env, error.to_string());
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn initialize_accepts_current_bridge_version() {
        let info = initialize(BRIDGE_API_VERSION).expect("current bridge version must initialize");
        assert_eq!(info.bridge_api_version, BRIDGE_API_VERSION);
        assert_eq!(info.task_schema, "nova.task.v1");
        assert_eq!(
            info.recovery_schema_version,
            nova_core_model::RECOVERY_SCHEMA_VERSION
        );
    }

    #[test]
    fn initialize_rejects_incompatible_bridge_version() {
        let result = initialize(BRIDGE_API_VERSION + 1);
        assert!(matches!(
            result,
            Err(BridgeError::IncompatibleVersion {
                client_version,
                core_version,
            }) if client_version == BRIDGE_API_VERSION + 1 && core_version == BRIDGE_API_VERSION
        ));
    }

    #[test]
    fn mobile_codec_registry_json_has_runtime_track_and_container_matrices() {
        let value: serde_json::Value =
            serde_json::from_str(&mobile_media_codec_capabilities_json())
                .expect("codec capability JSON");
        assert_eq!(
            value["capabilityRegistryVersion"],
            nova_core_model::CAPABILITY_REGISTRY_CONTRACT_VERSION
        );
        assert!(value["audio"]["decoders"].is_array());
        assert!(value["audio"]["encoders"].is_array());
        assert!(value["audio"]["encodersByContainer"].is_object());
        assert!(value["video"]["decoders"].is_array());
        assert!(value["video"]["encodersByContainer"].is_object());
        assert!(value["demuxers"].is_array());
        assert!(value["muxers"].is_array());
        assert!(value["subtitleContainers"].is_array());
        assert_eq!(value["engine"], "nova-native-codecs");
    }

    #[test]
    fn mobile_processing_progress_reports_absent_task_as_json_null() {
        assert_eq!(mobile_media_processing_progress_json("missing"), "null");
    }

    #[test]
    fn mobile_media_download_rejects_missing_stream_identity_before_resolution() {
        let error = download_mobile_media_stream(MobileMediaDownloadRequest {
            task_id: "task-1".to_owned(),
            webpage_url: "https://example.test/watch".to_owned(),
            stream_id: " ".to_owned(),
            output_container: "mp4".to_owned(),
            app_private_root: "/tmp/nova".to_owned(),
            relative_destination: "downloads/video.mp4".to_owned(),
        })
        .expect_err("stream id is mandatory");
        assert!(matches!(error, MediaDownloadError::InvalidRequest { .. }));
    }

    #[test]
    fn mobile_media_projection_uses_shared_descriptor_without_transport_secrets() {
        let mut request_headers = std::collections::BTreeMap::new();
        request_headers.insert("Cookie".to_owned(), "session=secret".to_owned());
        let mut stream_headers = std::collections::BTreeMap::new();
        stream_headers.insert("Authorization".to_owned(), "Bearer secret".to_owned());

        let descriptor = nova_media_core::MediaDescriptor {
            source_kind: nova_media_core::MediaSourceKind::Site,
            metadata: nova_media_core::MediaMetadata {
                title: "Mobile media".to_owned(),
                description: Some("description".to_owned()),
                duration_millis: Some(42_000),
                uploader: Some("NOVA".to_owned()),
                webpage_url: "https://site.test/watch".to_owned(),
                thumbnail_url: Some("https://img.test/thumb.jpg".to_owned()),
            },
            streams: vec![nova_media_core::MediaStream {
                id: "video".to_owned(),
                kind: nova_media_core::MediaTrackKind::AudioVideo,
                protocol: nova_media_core::MediaProtocol::Https,
                url: "https://cdn.test/video.mp4".to_owned(),
                container: Some("mp4".to_owned()),
                video_codec: Some("avc1".to_owned()),
                audio_codec: Some("mp4a".to_owned()),
                width: Some(1920),
                height: Some(1080),
                fps: Some(30.0),
                bitrate_bps: Some(4_000_000),
                audio_bitrate_bps: Some(128_000),
                content_length: Some(123),
                language: None,
                headers: stream_headers,
            }],
            subtitles: Vec::new(),
            request_headers,
            is_live: false,
        };

        let mobile = mobile_media_descriptor(descriptor);
        assert_eq!(mobile.title, "Mobile media");
        assert_eq!(mobile.streams.len(), 1);
        assert_eq!(mobile.streams[0].kind, MobileMediaTrackKind::AudioVideo);

        let json = mobile_media_descriptor_json(&mobile);
        assert!(json.contains("\"engine\":\"nova-media-engine\""));
        assert!(!json.contains("session=secret"));
        assert!(!json.contains("Bearer secret"));
    }

    #[test]
    fn native_probe_uses_libcurl_head_and_reports_metadata() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe server");
        let address = listener.local_addr().expect("probe server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept probe connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read probe request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("HEAD /payload.bin HTTP/"));
            assert!(request.contains("Accept-Encoding: identity"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 12345\r\nETag: \"nova-v1\"\r\nLast-Modified: Wed, 21 Oct 2015 07:28:00 GMT\r\nConnection: close\r\n\r\n",
                )
                .expect("write probe response");
        });

        let url = format!("http://{address}/payload.bin");
        let probe = probe_http_resource(url.clone()).expect("native probe must succeed");
        server.join().expect("probe server thread");

        assert_eq!(probe.response_status, 200);
        assert_eq!(probe.content_length, Some(12_345));
        assert_eq!(probe.effective_url, url);
        assert_eq!(probe.etag.as_deref(), Some("\"nova-v1\""));
        assert_eq!(
            probe.last_modified.as_deref(),
            Some("Wed, 21 Oct 2015 07:28:00 GMT")
        );
    }

    #[test]
    fn native_range_probe_validates_partial_content() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read range request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /payload.bin HTTP/"));
            assert!(request.contains("Range: bytes=2-5"));
            assert!(request.contains("Accept-Encoding: identity"));
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-5/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\ncdef",
                )
                .expect("write range response");
        });

        let url = format!("http://{address}/payload.bin");
        let probe = probe_http_range(url.clone(), 2, 5).expect("valid range must succeed");
        server.join().expect("range server thread");

        assert_eq!(probe.response_status, 206);
        assert_eq!(probe.range_start, 2);
        assert_eq!(probe.range_end, 5);
        assert_eq!(probe.bytes_received, 4);
        assert_eq!(probe.effective_url, url);
    }

    #[test]
    fn native_range_stream_writes_only_validated_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read range request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("Range: bytes=2-5"));
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-5/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\ncdef",
                )
                .expect("write range response");
        });

        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let probe = nova_download_core::stream_http_range(&url, 2, 5, &mut payload)
            .expect("validated native range stream must succeed");
        server.join().expect("range server thread");

        assert_eq!(probe.bytes_received, 4);
        assert_eq!(payload, b"cdef");
    }

    #[test]
    fn native_range_probe_rejects_server_ignoring_range() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read range request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("Range: bytes=2-5"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh",
                )
                .expect("write ignored-range response");
        });

        let url = format!("http://{address}/payload.bin");
        let result = probe_http_range(url, 2, 5);
        server.join().expect("range server thread");

        assert!(matches!(
            result,
            Err(TransportError::RangeResponseRejected { .. })
        ));
    }

    #[test]
    fn native_range_stream_does_not_write_ignored_range_body() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("read range request");
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh",
                )
                .expect("write ignored-range response");
        });

        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let result = nova_download_core::stream_http_range(&url, 2, 5, &mut payload);
        server.join().expect("range server thread");

        assert!(matches!(
            result,
            Err(nova_download_core::TransportError::RangeResponseRejected { .. })
        ));
        assert!(
            payload.is_empty(),
            "rejected body must never reach the sink"
        );
    }

    #[test]
    fn native_range_stream_does_not_write_mismatched_content_range() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("read range request");
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 1-4/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbcde",
                )
                .expect("write mismatched range response");
        });

        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let result = nova_download_core::stream_http_range(&url, 2, 5, &mut payload);
        server.join().expect("range server thread");

        assert!(matches!(
            result,
            Err(nova_download_core::TransportError::RangeResponseRejected { .. })
        ));
        assert!(
            payload.is_empty(),
            "mismatched range must never reach the sink"
        );
    }

    #[test]
    fn native_range_probe_rejects_invalid_bounds() {
        assert!(matches!(
            probe_http_range("https://example.invalid".to_owned(), 9, 4),
            Err(TransportError::InvalidRange { start: 9, end: 4 })
        ));
    }

    #[test]
    fn android_primitive_handshake_is_fail_closed() {
        assert_eq!(
            android_initialize_status(BRIDGE_API_VERSION as i32),
            BRIDGE_API_VERSION as i32
        );
        assert_eq!(android_initialize_status(-1), -1);
        assert_eq!(
            android_initialize_status((BRIDGE_API_VERSION + 1) as i32),
            -1
        );
    }

    #[test]
    fn ffi_range_plan_matches_shared_core() {
        assert_eq!(
            plan_transfer_ranges(10, 3),
            vec![
                TransferRange { start: 0, end: 3 },
                TransferRange { start: 4, end: 6 },
                TransferRange { start: 7, end: 9 },
            ]
        );
    }

    #[test]
    fn android_range_primitives_project_shared_plan() {
        assert_eq!(android_plan_segment_count(10, 3), 3);
        assert_eq!(android_plan_segment_bound(10, 3, 0, 0), 0);
        assert_eq!(android_plan_segment_bound(10, 3, 0, 1), 3);
        assert_eq!(android_plan_segment_bound(10, 3, 2, 0), 7);
        assert_eq!(android_plan_segment_bound(10, 3, 2, 1), 9);
    }

    #[test]
    fn android_range_primitives_reject_invalid_inputs() {
        assert_eq!(android_plan_segment_count(-1, 4), -1);
        assert_eq!(android_plan_segment_count(10, -1), -1);
        assert_eq!(android_plan_segment_bound(10, 3, -1, 0), -1);
        assert_eq!(android_plan_segment_bound(10, 3, 3, 0), -1);
        assert_eq!(android_plan_segment_bound(10, 3, 0, 2), -1);
    }

    #[test]
    fn ffi_resume_policy_matches_shared_core() {
        assert_eq!(
            plan_http_resume(4096, 206, Some(4096)),
            ResumeAction::Append
        );
        assert_eq!(plan_http_resume(4096, 200, None), ResumeAction::Restart);
        assert_eq!(
            plan_http_resume(4096, 206, Some(2048)),
            ResumeAction::Restart
        );
    }

    #[test]
    fn android_resume_primitive_projects_shared_policy() {
        assert_eq!(android_plan_http_resume_status(4096, 206, 4096), 0);
        assert_eq!(android_plan_http_resume_status(4096, 200, -1), 1);
        assert_eq!(android_plan_http_resume_status(4096, 206, 2048), 1);
    }

    #[test]
    fn android_resume_primitive_rejects_invalid_jni_inputs() {
        assert_eq!(android_plan_http_resume_status(-1, 206, 0), -1);
        assert_eq!(android_plan_http_resume_status(0, -1, -1), -1);
        assert_eq!(android_plan_http_resume_status(0, 70_000, -1), -1);
        assert_eq!(android_plan_http_resume_status(4096, 206, -2), -1);
    }
}
