//! Native streaming primitives for NOVA Download Manager.
//!
//! Protocol parsing lives in-process and deliberately has no Tauri,
//! subprocess, Python, yt-dlp, FFmpeg or UI dependency.

mod dash;
mod hls;

pub use dash::{
    build_dash_representation_plan, parse_dash, select_best_dash_representation,
    DashAdaptationSet, DashError, DashManifest, DashPeriod, DashPlanError,
    DashRepresentation, DashRepresentationPlan, DashSegmentTemplate, DashTimelineEntry,
    DashTrackKind, DashTransferUnit,
};
pub use hls::{
    build_hls_media_plan, parse_hls, select_best_hls_variant, HlsByteRange,
    HlsEncryptionMethod, HlsError, HlsInitMap, HlsKey, HlsManifest, HlsMediaPlan,
    HlsPlanError, HlsPlaylistKind, HlsRendition, HlsRenditionKind, HlsSegment,
    HlsTransferUnit, HlsTransferUnitKind, HlsVariant,
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StreamManifestKind {
    Hls,
    Dash,
}

/// Detect a native stream manifest from content before consulting the URL.
pub fn detect_manifest_kind(source_url: &str, body: &str) -> Option<StreamManifestKind> {
    let trimmed = body.trim_start();
    if trimmed.starts_with("#EXTM3U") {
        return Some(StreamManifestKind::Hls);
    }

    let prefix = trimmed
        .chars()
        .take(2048)
        .collect::<String>()
        .to_ascii_lowercase();
    if prefix.contains("<mpd") {
        return Some(StreamManifestKind::Dash);
    }

    let path = source_url.split('?').next().unwrap_or(source_url).to_ascii_lowercase();
    if path.ends_with(".m3u8") {
        return Some(StreamManifestKind::Hls);
    }
    if path.ends_with(".mpd") {
        return Some(StreamManifestKind::Dash);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_detection_wins_without_known_extension() {
        assert_eq!(
            detect_manifest_kind("https://cdn.test/media", "#EXTM3U\n#EXT-X-VERSION:7"),
            Some(StreamManifestKind::Hls)
        );
        assert_eq!(
            detect_manifest_kind("https://cdn.test/media", "<MPD></MPD>"),
            Some(StreamManifestKind::Dash)
        );
    }

    #[test]
    fn extension_detection_ignores_query_string() {
        assert_eq!(
            detect_manifest_kind("https://cdn.test/master.m3u8?token=abc", ""),
            Some(StreamManifestKind::Hls)
        );
    }
}
