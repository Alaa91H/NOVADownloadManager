use std::collections::BTreeMap;

use url::Url;

use crate::{
    ExtractRequest, MediaDescriptor, MediaError, MediaExtractor, MediaMetadata, MediaProtocol,
    MediaSourceKind, MediaStream, MediaTrackKind,
};

pub struct GenericManifestExtractor;

impl MediaExtractor for GenericManifestExtractor {
    fn id(&self) -> &'static str {
        "generic-manifest"
    }

    fn priority(&self) -> i32 {
        -900
    }

    fn supports(&self, request: &ExtractRequest) -> bool {
        request
            .parsed_url()
            .ok()
            .and_then(|url| extension(&url))
            .is_some_and(|extension| matches!(extension.as_str(), "m3u8" | "mpd"))
    }

    fn extract(&self, request: &ExtractRequest) -> Result<MediaDescriptor, MediaError> {
        let url = request.parsed_url()?;
        let extension = extension(&url).ok_or(MediaError::NoExtractor)?;
        let (source_kind, protocol) = match extension.as_str() {
            "m3u8" => (MediaSourceKind::Hls, MediaProtocol::Hls),
            "mpd" => (MediaSourceKind::Dash, MediaProtocol::Dash),
            _ => return Err(MediaError::NoExtractor),
        };

        Ok(MediaDescriptor {
            source_kind,
            metadata: metadata_from_url(&url),
            streams: vec![MediaStream {
                id: "manifest".to_owned(),
                kind: MediaTrackKind::AudioVideo,
                protocol,
                url: request.url.clone(),
                container: None,
                video_codec: None,
                audio_codec: None,
                width: None,
                height: None,
                fps: None,
                bitrate_bps: None,
                audio_bitrate_bps: None,
                content_length: None,
                language: None,
                headers: request.headers.clone(),
            }],
            subtitles: Vec::new(),
            request_headers: request.headers.clone(),
            is_live: false,
        })
    }
}

pub struct GenericDirectMediaExtractor;

impl MediaExtractor for GenericDirectMediaExtractor {
    fn id(&self) -> &'static str {
        "generic-direct-media"
    }

    fn priority(&self) -> i32 {
        -1000
    }

    fn supports(&self, request: &ExtractRequest) -> bool {
        request
            .parsed_url()
            .ok()
            .and_then(|url| extension(&url))
            .is_some_and(|extension| direct_kind(&extension).is_some())
    }

    fn extract(&self, request: &ExtractRequest) -> Result<MediaDescriptor, MediaError> {
        let url = request.parsed_url()?;
        let extension = extension(&url).ok_or(MediaError::NoExtractor)?;
        let kind = direct_kind(&extension).ok_or(MediaError::NoExtractor)?;
        let protocol = match url.scheme() {
            "http" => MediaProtocol::Http,
            "https" => MediaProtocol::Https,
            scheme => return Err(MediaError::UnsupportedScheme(scheme.to_owned())),
        };

        Ok(MediaDescriptor {
            source_kind: MediaSourceKind::Direct,
            metadata: metadata_from_url(&url),
            streams: vec![MediaStream {
                id: "direct".to_owned(),
                kind,
                protocol,
                url: request.url.clone(),
                container: Some(extension),
                video_codec: None,
                audio_codec: None,
                width: None,
                height: None,
                fps: None,
                bitrate_bps: None,
                audio_bitrate_bps: None,
                content_length: None,
                language: None,
                headers: request.headers.clone(),
            }],
            subtitles: Vec::new(),
            request_headers: request.headers.clone(),
            is_live: false,
        })
    }
}

fn extension(url: &Url) -> Option<String> {
    let segment = url.path_segments()?.next_back()?;
    let (_, extension) = segment.rsplit_once('.')?;
    Some(extension.to_ascii_lowercase())
}

fn direct_kind(extension: &str) -> Option<MediaTrackKind> {
    match extension {
        "mp4" | "webm" | "mkv" | "mov" | "m4v" | "avi" | "ts" => {
            Some(MediaTrackKind::AudioVideo)
        }
        "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "wav" => {
            Some(MediaTrackKind::Audio)
        }
        _ => None,
    }
}

fn metadata_from_url(url: &Url) -> MediaMetadata {
    let title = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|name| !name.is_empty())
        .unwrap_or("media")
        .to_owned();

    MediaMetadata {
        title,
        description: None,
        duration_millis: None,
        uploader: None,
        webpage_url: url.as_str().to_owned(),
        thumbnail_url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_extractor_recognizes_hls_and_dash_with_query_strings() {
        let extractor = GenericManifestExtractor;

        let hls = ExtractRequest::new("https://cdn.test/master.m3u8?token=abc");
        assert!(extractor.supports(&hls));
        let descriptor = extractor.extract(&hls).expect("HLS descriptor");
        assert_eq!(descriptor.source_kind, MediaSourceKind::Hls);
        assert_eq!(descriptor.streams[0].protocol, MediaProtocol::Hls);

        let dash = ExtractRequest::new("https://cdn.test/video.mpd?sig=123");
        assert!(extractor.supports(&dash));
        assert_eq!(
            extractor.extract(&dash).expect("DASH descriptor").source_kind,
            MediaSourceKind::Dash
        );
    }

    #[test]
    fn direct_media_extractor_classifies_audio_and_video() {
        let extractor = GenericDirectMediaExtractor;

        let video = extractor
            .extract(&ExtractRequest::new("https://cdn.test/movie.mp4"))
            .expect("video");
        assert_eq!(video.streams[0].kind, MediaTrackKind::AudioVideo);

        let audio = extractor
            .extract(&ExtractRequest::new("https://cdn.test/audio.flac"))
            .expect("audio");
        assert_eq!(audio.streams[0].kind, MediaTrackKind::Audio);
    }
}
