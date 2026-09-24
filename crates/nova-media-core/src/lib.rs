//! Native media domain and extractor orchestration for NOVA.
//!
//! The long-term contract of this crate is deliberately independent of
//! external media executables. Extractors produce typed descriptors; NOVA's
//! native download core owns transfer scheduling and persistence.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

pub use nova_stream_core::{detect_manifest_kind, StreamManifestKind};

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
