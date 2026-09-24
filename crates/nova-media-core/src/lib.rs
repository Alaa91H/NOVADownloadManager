//! Native media domain and extractor orchestration for NOVA.
//!
//! The long-term contract of this crate is deliberately independent of
//! external media executables. Extractors produce typed descriptors; NOVA's
//! native download core owns transfer scheduling and persistence.

mod assembly;
mod dash_live;
mod dash_transfer;
mod generic;
mod hls_live;
mod hls_transfer;
mod youtube;
mod youtube_player;
mod youtube_transfer;

pub use assembly::{assemble_ordered_parts, AssemblyError, AssemblyResult};
pub use dash_live::{refresh_and_stage_dash_live_once, DashLiveError, DashLiveStageRefresh};
pub use dash_transfer::{
    stage_dash_representation_plan, stage_dash_representation_plan_controlled,
    stage_dash_representation_plan_controlled_with_progress, DashStageError, DashStageFile,
    DashStageResult,
};
pub use generic::{GenericDirectMediaExtractor, GenericManifestExtractor};
pub use hls_live::{refresh_and_stage_hls_live_once, HlsLiveError, HlsLiveStageRefresh};
pub use hls_transfer::{
    stage_hls_media_plan, stage_hls_media_plan_controlled,
    stage_hls_media_plan_controlled_with_progress, HlsStageError, HlsStageFile, HlsStageResult,
};
pub use youtube::{
    resolve_youtube_pending_formats, select_youtube_download_plan, youtube_video_id,
    YouTubeChallengeKind, YouTubeChallengeResolution, YouTubeChallengeSolver,
    YouTubeDownloadPlan, YouTubeExtraction, YouTubeExtractor, YouTubePendingFormat,
    YouTubeSelectionPolicy,
};
pub use youtube_player::YouTubePlayerScriptSolver;
pub use youtube_transfer::{
    download_youtube_plan, download_youtube_plan_controlled, YouTubeTransferError,
    YouTubeTransferOutput, YouTubeTransferProgress,
};

use std::collections::BTreeMap;

use nova_download_core::{fetch_http_bytes_with_context, HttpRequestContext};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

pub use nova_stream_core::{
    detect_manifest_kind, parse_dash, parse_hls, DashManifest, HlsManifest, StreamManifestKind,
};

/// Default hard ceiling for in-memory HLS/DASH manifest acquisition.
pub const DEFAULT_MANIFEST_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Compile-time capability matrix for the first-party Rust media core.
///
/// This describes what the core itself implements. Platform adapters may expose
/// a narrower execution surface until task lifecycle integration reaches parity.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NativeMediaCoreCapabilities {
    pub generic_direct_extraction: bool,
    pub hls_parsing: bool,
    pub hls_staging: bool,
    pub hls_live_refresh: bool,
    pub hls_aes128_cbc: bool,
    pub dash_parsing: bool,
    pub dash_staging: bool,
    pub dash_live_refresh: bool,
    pub ordered_assembly: bool,
    pub youtube_extraction: bool,
    pub youtube_signature_transform: bool,
    pub youtube_throttling_transform: bool,
    pub separate_track_staging: bool,
}

pub const fn native_media_core_capabilities() -> NativeMediaCoreCapabilities {
    NativeMediaCoreCapabilities {
        generic_direct_extraction: true,
        hls_parsing: true,
        hls_staging: true,
        hls_live_refresh: true,
        hls_aes128_cbc: true,
        dash_parsing: true,
        dash_staging: true,
        dash_live_refresh: true,
        ordered_assembly: true,
        youtube_extraction: true,
        youtube_signature_transform: true,
        youtube_throttling_transform: true,
        separate_track_staging: true,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaSourceKind {
    Direct,
    Hls,
    Dash,
    Site,
    Live,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaTrackKind {
    Video,
    Audio,
    AudioVideo,
    Subtitle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaProtocol {
    Http,
    Https,
    Hls,
    Dash,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub title: String,
    pub description: Option<String>,
    pub duration_millis: Option<u64>,
    pub uploader: Option<String>,
    pub webpage_url: String,
    pub thumbnail_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MediaStream {
    pub id: String,
    pub kind: MediaTrackKind,
    pub protocol: MediaProtocol,
    pub url: String,
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f32>,
    pub bitrate_bps: Option<u64>,
    pub audio_bitrate_bps: Option<u64>,
    pub content_length: Option<u64>,
    pub language: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "manifest", rename_all = "kebab-case")]
pub enum NativeManifest {
    Hls(HlsManifest),
    Dash(DashManifest),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SubtitleTrack {
    pub language: String,
    pub name: Option<String>,
    pub url: String,
    pub format: Option<String>,
    pub automatic: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MediaDescriptor {
    pub source_kind: MediaSourceKind,
    pub metadata: MediaMetadata,
    pub streams: Vec<MediaStream>,
    #[serde(default)]
    pub subtitles: Vec<SubtitleTrack>,
    #[serde(default)]
    pub request_headers: BTreeMap<String, String>,
    pub is_live: bool,
}

impl MediaDescriptor {
    pub fn playable_streams(&self) -> impl Iterator<Item = &MediaStream> {
        self.streams.iter().filter(|stream| {
            matches!(
                stream.kind,
                MediaTrackKind::Video | MediaTrackKind::Audio | MediaTrackKind::AudioVideo
            )
        })
    }

    /// Build the native HTTP context for a concrete stream.
    ///
    /// Descriptor headers provide site-wide defaults while stream headers win
    /// for representation-specific requests. Browser identity headers are
    /// normalized into typed transport fields rather than raw header strings.
    pub fn request_context_for_stream(
        &self,
        stream: &MediaStream,
    ) -> Result<HttpRequestContext, MediaError> {
        let mut context = HttpRequestContext::default();
        merge_request_headers(&mut context, &self.request_headers);
        merge_request_headers(&mut context, &stream.headers);
        context
            .validate()
            .map_err(|error| MediaError::Transport(error.to_string()))?;
        Ok(context)
    }
}

fn merge_request_headers(
    context: &mut HttpRequestContext,
    headers: &BTreeMap<String, String>,
) {
    for (name, value) in headers {
        match name.to_ascii_lowercase().as_str() {
            "referer" => context.referer = Some(value.clone()),
            "cookie" => context.cookie_header = Some(value.clone()),
            "user-agent" => context.user_agent = Some(value.clone()),
            _ => {
                if let Some(existing) = context
                    .headers
                    .keys()
                    .find(|existing| existing.eq_ignore_ascii_case(name))
                    .cloned()
                {
                    context.headers.remove(&existing);
                }
                context.headers.insert(name.clone(), value.clone());
            }
        }
    }
}

/// Fetch and parse an HLS/DASH manifest entirely through NOVA's native core.
pub fn fetch_native_manifest(
    descriptor: &MediaDescriptor,
    stream: &MediaStream,
    max_bytes: usize,
) -> Result<NativeManifest, MediaError> {
    let context = descriptor.request_context_for_stream(stream)?;
    let response = fetch_http_bytes_with_context(&stream.url, &context, max_bytes)
        .map_err(|error| MediaError::Transport(error.to_string()))?;
    let body = String::from_utf8(response.body).map_err(|_| MediaError::ManifestEncoding)?;

    let kind = match stream.protocol {
        MediaProtocol::Hls => StreamManifestKind::Hls,
        MediaProtocol::Dash => StreamManifestKind::Dash,
        MediaProtocol::Http | MediaProtocol::Https => detect_manifest_kind(&response.effective_url, &body)
            .ok_or(MediaError::UnsupportedManifest)?,
    };

    match kind {
        StreamManifestKind::Hls => parse_hls(&response.effective_url, &body)
            .map(NativeManifest::Hls)
            .map_err(|error| MediaError::ManifestParse {
                kind: StreamManifestKind::Hls,
                message: error.to_string(),
            }),
        StreamManifestKind::Dash => parse_dash(&body)
            .map(NativeManifest::Dash)
            .map_err(|error| MediaError::ManifestParse {
                kind: StreamManifestKind::Dash,
                message: error.to_string(),
            }),
    }
}

pub fn fetch_native_manifest_default(
    descriptor: &MediaDescriptor,
    stream: &MediaStream,
) -> Result<NativeManifest, MediaError> {
    fetch_native_manifest(descriptor, stream, DEFAULT_MANIFEST_MAX_BYTES)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtractRequest {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

impl ExtractRequest {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            headers: BTreeMap::new(),
        }
    }

    pub fn parsed_url(&self) -> Result<Url, MediaError> {
        let parsed = Url::parse(&self.url).map_err(|_| MediaError::InvalidUrl(self.url.clone()))?;
        match parsed.scheme() {
            "http" | "https" => Ok(parsed),
            scheme => Err(MediaError::UnsupportedScheme(scheme.to_owned())),
        }
    }

    pub fn request_context(&self) -> Result<HttpRequestContext, MediaError> {
        let mut context = HttpRequestContext::default();
        merge_request_headers(&mut context, &self.headers);
        context
            .validate()
            .map_err(|error| MediaError::Transport(error.to_string()))?;
        Ok(context)
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum MediaError {
    #[error("invalid media URL: {0}")]
    InvalidUrl(String),
    #[error("unsupported media URL scheme: {0}")]
    UnsupportedScheme(String),
    #[error("no native extractor accepted this URL")]
    NoExtractor,
    #[error("extractor {extractor} failed: {message}")]
    ExtractorFailed {
        extractor: &'static str,
        message: String,
    },
    #[error("native media transport failed: {0}")]
    Transport(String),
    #[error("native manifest is not valid UTF-8")]
    ManifestEncoding,
    #[error("native manifest type could not be determined")]
    UnsupportedManifest,
    #[error("native {kind:?} manifest parse failed: {message}")]
    ManifestParse {
        kind: StreamManifestKind,
        message: String,
    },
}

/// Platform-neutral native media extractor contract.
///
/// Implementations must only resolve metadata and stream descriptors. Transfer
/// bytes are owned by nova-download-core / nova-stream-core so every source
/// benefits from the same scheduler, retries, persistence and rate controls.
pub trait MediaExtractor: Send + Sync {
    fn id(&self) -> &'static str;
    fn priority(&self) -> i32 {
        0
    }
    fn supports(&self, request: &ExtractRequest) -> bool;
    fn extract(&self, request: &ExtractRequest) -> Result<MediaDescriptor, MediaError>;
}

/// Ordered registry for native media extractors.
///
/// Higher priority implementations run first. Registration order is preserved
/// for equal priorities so resolution remains deterministic across platforms.
#[derive(Default)]
pub struct ExtractorRegistry {
    extractors: Vec<Box<dyn MediaExtractor>>,
}

impl ExtractorRegistry {
    pub fn with_native_defaults() -> Self {
        let mut registry = Self::default();
        registry.register(YouTubeExtractor);
        registry.register(GenericManifestExtractor);
        registry.register(GenericDirectMediaExtractor);
        registry
    }

    pub fn register<E>(&mut self, extractor: E)
    where
        E: MediaExtractor + 'static,
    {
        self.extractors.push(Box::new(extractor));
        self.extractors
            .sort_by_key(|extractor| std::cmp::Reverse(extractor.priority()));
    }

    pub fn resolve(&self, request: &ExtractRequest) -> Result<MediaDescriptor, MediaError> {
        request.parsed_url()?;

        for extractor in &self.extractors {
            if extractor.supports(request) {
                return extractor.extract(request).map_err(|error| match error {
                    MediaError::ExtractorFailed { .. } => error,
                    other => MediaError::ExtractorFailed {
                        extractor: extractor.id(),
                        message: other.to_string(),
                    },
                });
            }
        }

        Err(MediaError::NoExtractor)
    }

    pub fn ids(&self) -> Vec<&'static str> {
        self.extractors.iter().map(|extractor| extractor.id()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_capability_matrix_exposes_deliberate_boundaries() {
        let capabilities = native_media_core_capabilities();
        assert!(capabilities.hls_parsing);
        assert!(capabilities.hls_staging);
        assert!(capabilities.dash_parsing);
        assert!(capabilities.dash_staging);
        assert!(capabilities.separate_track_staging);
        assert!(capabilities.youtube_signature_transform);
        assert!(capabilities.youtube_throttling_transform);
    }

    struct TestExtractor {
        id: &'static str,
        host: &'static str,
        priority: i32,
    }

    impl MediaExtractor for TestExtractor {
        fn id(&self) -> &'static str {
            self.id
        }

        fn priority(&self) -> i32 {
            self.priority
        }

        fn supports(&self, request: &ExtractRequest) -> bool {
            request
                .parsed_url()
                .ok()
                .and_then(|url| url.host_str().map(ToOwned::to_owned))
                .is_some_and(|host| host == self.host)
        }

        fn extract(&self, request: &ExtractRequest) -> Result<MediaDescriptor, MediaError> {
            Ok(MediaDescriptor {
                source_kind: MediaSourceKind::Site,
                metadata: MediaMetadata {
                    title: self.id.to_owned(),
                    description: None,
                    duration_millis: None,
                    uploader: None,
                    webpage_url: request.url.clone(),
                    thumbnail_url: None,
                },
                streams: Vec::new(),
                subtitles: Vec::new(),
                request_headers: BTreeMap::new(),
                is_live: false,
            })
        }
    }

    fn media_descriptor_with_stream() -> (MediaDescriptor, MediaStream) {
        let mut descriptor_headers = BTreeMap::new();
        descriptor_headers.insert("User-Agent".to_owned(), "NOVA-Site/1".to_owned());
        descriptor_headers.insert("Referer".to_owned(), "https://site.test/watch".to_owned());
        descriptor_headers.insert("X-Site".to_owned(), "descriptor".to_owned());

        let mut stream_headers = BTreeMap::new();
        stream_headers.insert("user-agent".to_owned(), "NOVA-Stream/2".to_owned());
        stream_headers.insert("Cookie".to_owned(), "session=ok".to_owned());
        stream_headers.insert("x-site".to_owned(), "stream".to_owned());

        let stream = MediaStream {
            id: "video".to_owned(),
            kind: MediaTrackKind::Video,
            protocol: MediaProtocol::Hls,
            url: "https://cdn.test/master.m3u8".to_owned(),
            container: Some("mp4".to_owned()),
            video_codec: Some("avc1".to_owned()),
            audio_codec: None,
            width: Some(1920),
            height: Some(1080),
            fps: Some(60.0),
            bitrate_bps: Some(4_500_000),
            audio_bitrate_bps: None,
            content_length: None,
            language: None,
            headers: stream_headers,
        };

        let descriptor = MediaDescriptor {
            source_kind: MediaSourceKind::Site,
            metadata: MediaMetadata {
                title: "Native".to_owned(),
                description: None,
                duration_millis: None,
                uploader: None,
                webpage_url: "https://site.test/watch".to_owned(),
                thumbnail_url: None,
            },
            streams: vec![stream.clone()],
            subtitles: Vec::new(),
            request_headers: descriptor_headers,
            is_live: false,
        };

        (descriptor, stream)
    }

    #[test]
    fn stream_request_context_normalizes_browser_headers_and_stream_overrides() {
        let (descriptor, stream) = media_descriptor_with_stream();
        let context = descriptor
            .request_context_for_stream(&stream)
            .expect("native request context");

        assert_eq!(context.user_agent.as_deref(), Some("NOVA-Stream/2"));
        assert_eq!(
            context.referer.as_deref(),
            Some("https://site.test/watch")
        );
        assert_eq!(context.cookie_header.as_deref(), Some("session=ok"));
        assert_eq!(context.headers.len(), 1);
        assert_eq!(
            context.headers.values().next().map(String::as_str),
            Some("stream")
        );
    }

    #[test]
    fn request_rejects_non_http_schemes() {
        let error = ExtractRequest::new("file:///tmp/video.mp4")
            .parsed_url()
            .expect_err("file scheme must be rejected");

        assert_eq!(error, MediaError::UnsupportedScheme("file".to_owned()));
    }

    #[test]
    fn registry_resolves_native_extractor() {
        let mut registry = ExtractorRegistry::default();
        registry.register(TestExtractor {
            id: "example",
            host: "media.example",
            priority: 10,
        });

        let descriptor = registry
            .resolve(&ExtractRequest::new("https://media.example/watch/1"))
            .expect("native extractor");

        assert_eq!(descriptor.metadata.title, "example");
        assert_eq!(descriptor.source_kind, MediaSourceKind::Site);
    }

    #[test]
    fn native_default_registry_resolves_manifests_before_direct_media() {
        let registry = ExtractorRegistry::with_native_defaults();
        assert_eq!(
            registry.ids(),
            vec!["youtube-native", "generic-manifest", "generic-direct-media"]
        );
        assert_eq!(
            registry
                .resolve(&ExtractRequest::new("https://cdn.test/master.m3u8"))
                .expect("HLS")
                .source_kind,
            MediaSourceKind::Hls
        );
    }

    #[test]
    fn registry_orders_extractors_by_priority() {
        let mut registry = ExtractorRegistry::default();
        registry.register(TestExtractor {
            id: "generic",
            host: "media.example",
            priority: 0,
        });
        registry.register(TestExtractor {
            id: "specific",
            host: "media.example",
            priority: 100,
        });

        assert_eq!(registry.ids(), vec!["specific", "generic"]);
        assert_eq!(
            registry
                .resolve(&ExtractRequest::new("https://media.example/watch"))
                .expect("highest priority")
                .metadata
                .title,
            "specific"
        );
    }
}
