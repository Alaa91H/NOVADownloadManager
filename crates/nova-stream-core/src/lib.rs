//! Native streaming primitives for NOVA Download Manager.
//!
//! This crate contains protocol-level media stream logic only. It deliberately
//! has no Tauri, subprocess, Python, yt-dlp, FFmpeg or UI dependencies.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

/// Streaming manifest family understood by the native NOVA media stack.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StreamManifestKind {
    Hls,
    Dash,
}

/// HLS playlist family.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HlsPlaylistKind {
    Master,
    Media,
}

/// One HLS variant exposed by a master playlist.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsVariant {
    pub uri: String,
    pub bandwidth: Option<u64>,
    pub average_bandwidth: Option<u64>,
    pub resolution: Option<(u32, u32)>,
    pub codecs: Vec<String>,
    pub frame_rate_milli: Option<u32>,
    pub audio_group: Option<String>,
    pub subtitle_group: Option<String>,
}

/// One media segment from an HLS media playlist.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HlsSegment {
    pub uri: String,
    pub duration_seconds: Option<f64>,
    pub sequence: u64,
    pub discontinuity: bool,
}

/// Parsed subset of an HLS manifest required by NOVA's native scheduler.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HlsManifest {
    pub kind: HlsPlaylistKind,
    pub variants: Vec<HlsVariant>,
    pub segments: Vec<HlsSegment>,
    pub media_sequence: u64,
    pub target_duration_seconds: Option<u64>,
    pub end_list: bool,
}

/// Minimal DASH manifest metadata used during protocol routing.
///
/// Representation parsing is intentionally introduced in the next migration
/// slice. Keeping detection typed now prevents callers from falling back to an
/// external process while the native parser grows.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashManifest {
    pub is_dynamic: bool,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum StreamError {
    #[error("manifest is empty")]
    EmptyManifest,
    #[error("invalid HLS manifest: missing #EXTM3U header")]
    MissingHlsHeader,
    #[error("manifest URL is invalid: {0}")]
    InvalidBaseUrl(String),
    #[error("HLS variant metadata is missing its URI")]
    MissingVariantUri,
    #[error("unsupported or unrecognized stream manifest")]
    UnsupportedManifest,
}

/// Detect an HLS or DASH manifest from content and, secondarily, the URL.
pub fn detect_manifest_kind(source_url: &str, body: &str) -> Option<StreamManifestKind> {
    let trimmed = body.trim_start();

    if trimmed.starts_with("#EXTM3U") {
        return Some(StreamManifestKind::Hls);
    }

    let lower = trimmed
        .chars()
        .take(1024)
        .collect::<String>()
        .to_ascii_lowercase();
    if lower.contains("<mpd") {
        return Some(StreamManifestKind::Dash);
    }

    let url = source_url.to_ascii_lowercase();
    if url.split('?').next().is_some_and(|path| path.ends_with(".m3u8")) {
        return Some(StreamManifestKind::Hls);
    }
    if url.split('?').next().is_some_and(|path| path.ends_with(".mpd")) {
        return Some(StreamManifestKind::Dash);
    }

    None
}

/// Parse the protocol fields NOVA needs to begin native HLS routing.
///
/// This parser intentionally accepts unknown tags so upstream additions do not
/// break downloads. Security-sensitive URI validation stays at the transport
/// boundary where redirects, schemes and request metadata are enforced.
pub fn parse_hls(base_url: &str, body: &str) -> Result<HlsManifest, StreamError> {
    if body.trim().is_empty() {
        return Err(StreamError::EmptyManifest);
    }

    let mut lines = body.lines().map(str::trim).filter(|line| !line.is_empty());
    if lines.next() != Some("#EXTM3U") {
        return Err(StreamError::MissingHlsHeader);
    }

    let base = Url::parse(base_url).map_err(|_| StreamError::InvalidBaseUrl(base_url.to_owned()))?;
    let all_lines: Vec<&str> = body.lines().map(str::trim).collect();

    let mut variants = Vec::new();
    let mut segments = Vec::new();
    let mut media_sequence = 0_u64;
    let mut target_duration_seconds = None;
    let mut end_list = false;
    let mut pending_variant: Option<&str> = None;
    let mut pending_duration: Option<f64> = None;
    let mut pending_discontinuity = false;
    let mut sequence_offset = 0_u64;

    for line in all_lines.into_iter().skip(1) {
        if line.is_empty() {
            continue;
        }

        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_sequence = value.trim().parse().unwrap_or(0);
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            target_duration_seconds = value.trim().parse().ok();
            continue;
        }
        if line == "#EXT-X-ENDLIST" {
            end_list = true;
            continue;
        }
        if line == "#EXT-X-DISCONTINUITY" {
            pending_discontinuity = true;
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            pending_duration = value
                .split(',')
                .next()
                .and_then(|duration| duration.trim().parse::<f64>().ok());
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_variant = Some(value);
            continue;
        }

        if line.starts_with('#') {
            continue;
        }

        let resolved = base
            .join(line)
            .map(|url| url.to_string())
            .unwrap_or_else(|_| line.to_owned());

        if let Some(attributes) = pending_variant.take() {
            variants.push(parse_hls_variant(attributes, resolved));
            continue;
        }

        if pending_duration.is_some() || variants.is_empty() {
            segments.push(HlsSegment {
                uri: resolved,
                duration_seconds: pending_duration.take(),
                sequence: media_sequence + sequence_offset,
                discontinuity: std::mem::take(&mut pending_discontinuity),
            });
            sequence_offset += 1;
        }
    }

    let kind = if variants.is_empty() {
        HlsPlaylistKind::Media
    } else {
        HlsPlaylistKind::Master
    };

    Ok(HlsManifest {
        kind,
        variants,
        segments,
        media_sequence,
        target_duration_seconds,
        end_list,
    })
}

fn parse_hls_variant(attributes: &str, uri: String) -> HlsVariant {
    let mut variant = HlsVariant {
        uri,
        bandwidth: None,
        average_bandwidth: None,
        resolution: None,
        codecs: Vec::new(),
        frame_rate_milli: None,
        audio_group: None,
        subtitle_group: None,
    };

    for (key, value) in split_hls_attributes(attributes) {
        let value = value.trim_matches('"');
        match key {
            "BANDWIDTH" => variant.bandwidth = value.parse().ok(),
            "AVERAGE-BANDWIDTH" => variant.average_bandwidth = value.parse().ok(),
            "RESOLUTION" => {
                variant.resolution = value.split_once('x').and_then(|(w, h)| {
                    Some((w.parse().ok()?, h.parse().ok()?))
                });
            }
            "CODECS" => {
                variant.codecs = value
                    .split(',')
                    .map(str::trim)
                    .filter(|codec| !codec.is_empty())
                    .map(ToOwned::to_owned)
                    .collect();
            }
            "FRAME-RATE" => {
                variant.frame_rate_milli = value
                    .parse::<f64>()
                    .ok()
                    .map(|fps| (fps * 1000.0).round() as u32);
            }
            "AUDIO" => variant.audio_group = Some(value.to_owned()),
            "SUBTITLES" => variant.subtitle_group = Some(value.to_owned()),
            _ => {}
        }
    }

    variant
}

fn split_hls_attributes(input: &str) -> Vec<(&str, &str)> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;

    for (index, ch) in input.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                push_attribute(&input[start..index], &mut parts);
                start = index + 1;
            }
            _ => {}
        }
    }
    push_attribute(&input[start..], &mut parts);
    parts
}

fn push_attribute<'a>(raw: &'a str, output: &mut Vec<(&'a str, &'a str)>) {
    if let Some((key, value)) = raw.split_once('=') {
        output.push((key.trim(), value.trim()));
    }
}

/// Parse enough of a DASH MPD to route it to the native DASH pipeline.
pub fn parse_dash(body: &str) -> Result<DashManifest, StreamError> {
    if body.trim().is_empty() {
        return Err(StreamError::EmptyManifest);
    }

    let prefix = body
        .trim_start()
        .chars()
        .take(4096)
        .collect::<String>()
        .to_ascii_lowercase();
    if !prefix.contains("<mpd") {
        return Err(StreamError::UnsupportedManifest);
    }

    let is_dynamic = prefix.contains("type=\"dynamic\"") || prefix.contains("type='dynamic'");
    Ok(DashManifest { is_dynamic })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_manifests_from_content_before_extension() {
        assert_eq!(
            detect_manifest_kind("https://cdn.test/file.bin", "#EXTM3U\n#EXT-X-VERSION:7"),
            Some(StreamManifestKind::Hls)
        );
        assert_eq!(
            detect_manifest_kind("https://cdn.test/file.bin", "<?xml version=\"1.0\"?><MPD></MPD>"),
            Some(StreamManifestKind::Dash)
        );
    }

    #[test]
    fn parses_hls_master_variant_and_resolves_relative_uri() {
        let manifest = parse_hls(
            "https://cdn.test/path/master.m3u8",
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\",FRAME-RATE=60\nvideo/1080.m3u8\n",
        )
        .expect("master playlist");

        assert_eq!(manifest.kind, HlsPlaylistKind::Master);
        assert_eq!(manifest.variants.len(), 1);
        assert_eq!(manifest.variants[0].bandwidth, Some(2_500_000));
        assert_eq!(manifest.variants[0].resolution, Some((1920, 1080)));
        assert_eq!(manifest.variants[0].frame_rate_milli, Some(60_000));
        assert_eq!(
            manifest.variants[0].uri,
            "https://cdn.test/path/video/1080.m3u8"
        );
    }

    #[test]
    fn parses_hls_media_segments_with_sequence_and_discontinuity() {
        let manifest = parse_hls(
            "https://cdn.test/live/index.m3u8",
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.5,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6.0,\nb.ts\n#EXT-X-ENDLIST\n",
        )
        .expect("media playlist");

        assert_eq!(manifest.kind, HlsPlaylistKind::Media);
        assert_eq!(manifest.media_sequence, 42);
        assert_eq!(manifest.target_duration_seconds, Some(6));
        assert!(manifest.end_list);
        assert_eq!(manifest.segments.len(), 2);
        assert_eq!(manifest.segments[0].sequence, 42);
        assert_eq!(manifest.segments[1].sequence, 43);
        assert!(manifest.segments[1].discontinuity);
    }

    #[test]
    fn recognizes_dynamic_dash_manifest() {
        assert_eq!(
            parse_dash("<MPD type=\"dynamic\"></MPD>").expect("dash"),
            DashManifest { is_dynamic: true }
        );
    }
}
