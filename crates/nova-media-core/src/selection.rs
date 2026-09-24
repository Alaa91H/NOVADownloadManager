use serde::{Deserialize, Serialize};

use crate::{MediaDescriptor, MediaStream, MediaTrackKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaSelectionMode {
    Video,
    Audio,
}

impl Default for MediaSelectionMode {
    fn default() -> Self {
        Self::Video
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaSortKey {
    Quality,
    Bitrate,
    Size,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaSelectionPolicy {
    pub mode: MediaSelectionMode,
    pub max_height: Option<u32>,
    pub preferred_container: Option<String>,
    pub preferred_language: Option<String>,
    pub sort: Vec<MediaSortKey>,
}

impl Default for MediaSelectionPolicy {
    fn default() -> Self {
        Self {
            mode: MediaSelectionMode::Video,
            max_height: None,
            preferred_container: None,
            preferred_language: None,
            sort: vec![
                MediaSortKey::Quality,
                MediaSortKey::Bitrate,
                MediaSortKey::Size,
            ],
        }
    }
}

pub fn select_media_stream<'a>(
    descriptor: &'a MediaDescriptor,
    policy: &MediaSelectionPolicy,
) -> Option<&'a MediaStream> {
    descriptor
        .streams
        .iter()
        .filter(|stream| matches_mode(stream, policy.mode))
        .filter(|stream| {
            policy
                .max_height
                .map_or(true, |limit| stream.height.map_or(true, |height| height <= limit))
        })
        .max_by(|left, right| compare_streams(left, right, policy))
}

fn matches_mode(stream: &MediaStream, mode: MediaSelectionMode) -> bool {
    match mode {
        MediaSelectionMode::Video => matches!(
            stream.kind,
            MediaTrackKind::Video | MediaTrackKind::AudioVideo
        ),
        MediaSelectionMode::Audio => stream.kind == MediaTrackKind::Audio,
    }
}

fn compare_streams(
    left: &MediaStream,
    right: &MediaStream,
    policy: &MediaSelectionPolicy,
) -> std::cmp::Ordering {
    let left_preferences = preference_score(left, policy);
    let right_preferences = preference_score(right, policy);
    left_preferences
        .cmp(&right_preferences)
        .then_with(|| {
            for key in &policy.sort {
                let ordering = sort_value(left, *key).cmp(&sort_value(right, *key));
                if ordering != std::cmp::Ordering::Equal {
                    return ordering;
                }
            }
            std::cmp::Ordering::Equal
        })
}

fn preference_score(stream: &MediaStream, policy: &MediaSelectionPolicy) -> (u8, u8, u8) {
    let container = stream.container.as_deref().unwrap_or_default();
    let language = stream.language.as_deref().unwrap_or_default();
    let container_match = policy
        .preferred_container
        .as_deref()
        .map_or(false, |wanted| container.eq_ignore_ascii_case(wanted));
    let language_match = policy
        .preferred_language
        .as_deref()
        .map_or(false, |wanted| language.eq_ignore_ascii_case(wanted));
    let muxed_video = policy.mode == MediaSelectionMode::Video
        && stream.kind == MediaTrackKind::AudioVideo;
    (
        u8::from(container_match),
        u8::from(language_match),
        u8::from(muxed_video),
    )
}

fn sort_value(stream: &MediaStream, key: MediaSortKey) -> u64 {
    match key {
        MediaSortKey::Quality => u64::from(stream.height.unwrap_or(0))
            .saturating_mul(1_000_000)
            .saturating_add(
                stream
                    .fps
                    .map(|fps| (fps.max(0.0) * 1_000.0) as u64)
                    .unwrap_or(0),
            ),
        MediaSortKey::Bitrate => stream
            .audio_bitrate_bps
            .or(stream.bitrate_bps)
            .unwrap_or(0),
        MediaSortKey::Size => stream.content_length.unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        MediaMetadata, MediaProtocol, MediaSourceKind,
    };
    use std::collections::BTreeMap;

    fn stream(
        id: &str,
        kind: MediaTrackKind,
        container: &str,
        height: Option<u32>,
        bitrate: u64,
        language: Option<&str>,
    ) -> MediaStream {
        MediaStream {
            id: id.to_owned(),
            kind,
            protocol: MediaProtocol::Https,
            url: format!("https://media.test/{id}"),
            container: Some(container.to_owned()),
            video_codec: None,
            audio_codec: None,
            width: height.map(|value| value.saturating_mul(16) / 9),
            height,
            fps: Some(30.0),
            bitrate_bps: Some(bitrate),
            audio_bitrate_bps: (kind == MediaTrackKind::Audio).then_some(bitrate),
            content_length: Some(bitrate / 10),
            language: language.map(str::to_owned),
            headers: BTreeMap::new(),
        }
    }

    fn descriptor() -> MediaDescriptor {
        MediaDescriptor {
            source_kind: MediaSourceKind::Site,
            metadata: MediaMetadata {
                title: "test".to_owned(),
                description: None,
                duration_millis: None,
                uploader: None,
                webpage_url: "https://media.test/watch".to_owned(),
                thumbnail_url: None,
            },
            streams: vec![
                stream(
                    "muxed-720",
                    MediaTrackKind::AudioVideo,
                    "mp4",
                    Some(720),
                    2_000_000,
                    None,
                ),
                stream(
                    "video-1080",
                    MediaTrackKind::Video,
                    "webm",
                    Some(1080),
                    4_000_000,
                    None,
                ),
                stream(
                    "audio-en",
                    MediaTrackKind::Audio,
                    "webm",
                    None,
                    128_000,
                    Some("en"),
                ),
                stream(
                    "audio-ar",
                    MediaTrackKind::Audio,
                    "mp4",
                    None,
                    160_000,
                    Some("ar"),
                ),
            ],
            subtitles: Vec::new(),
            request_headers: BTreeMap::new(),
            is_live: false,
        }
    }

    #[test]
    fn audio_mode_never_selects_muxed_video() {
        let selected = select_media_stream(
            &descriptor(),
            &MediaSelectionPolicy {
                mode: MediaSelectionMode::Audio,
                ..MediaSelectionPolicy::default()
            },
        )
        .expect("audio stream");
        assert_eq!(selected.id, "audio-ar");
    }

    #[test]
    fn container_and_language_preferences_are_deterministic() {
        let selected = select_media_stream(
            &descriptor(),
            &MediaSelectionPolicy {
                mode: MediaSelectionMode::Audio,
                preferred_container: Some("webm".to_owned()),
                preferred_language: Some("en".to_owned()),
                ..MediaSelectionPolicy::default()
            },
        )
        .expect("preferred audio");
        assert_eq!(selected.id, "audio-en");
    }

    #[test]
    fn video_height_ceiling_prefers_muxed_stream_with_audio() {
        let selected = select_media_stream(
            &descriptor(),
            &MediaSelectionPolicy {
                max_height: Some(720),
                ..MediaSelectionPolicy::default()
            },
        )
        .expect("video stream");
        assert_eq!(selected.id, "muxed-720");
    }
}
