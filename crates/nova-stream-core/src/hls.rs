use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HlsPlaylistKind {
    Master,
    Media,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HlsRenditionKind {
    Audio,
    Video,
    Subtitles,
    ClosedCaptions,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsRendition {
    pub kind: HlsRenditionKind,
    pub group_id: String,
    pub name: String,
    pub uri: Option<String>,
    pub language: Option<String>,
    pub default: bool,
    pub autoselect: bool,
    pub forced: bool,
    pub channels: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsByteRange {
    pub length: u64,
    pub offset: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsInitMap {
    pub uri: String,
    pub byte_range: Option<HlsByteRange>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HlsEncryptionMethod {
    None,
    Aes128,
    SampleAes,
    Other(String),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsKey {
    pub method: HlsEncryptionMethod,
    pub uri: Option<String>,
    pub iv: Option<String>,
    pub key_format: Option<String>,
}

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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HlsSegment {
    pub uri: String,
    pub duration_seconds: Option<f64>,
    pub sequence: u64,
    pub discontinuity: bool,
    pub byte_range: Option<HlsByteRange>,
    pub init_map: Option<HlsInitMap>,
    pub key: Option<HlsKey>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HlsManifest {
    pub kind: HlsPlaylistKind,
    pub variants: Vec<HlsVariant>,
    pub renditions: Vec<HlsRendition>,
    pub segments: Vec<HlsSegment>,
    pub media_sequence: u64,
    pub target_duration_seconds: Option<u64>,
    pub end_list: bool,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum HlsError {
    #[error("manifest is empty")]
    EmptyManifest,
    #[error("invalid HLS manifest: missing #EXTM3U header")]
    MissingHeader,
    #[error("manifest URL is invalid: {0}")]
    InvalidBaseUrl(String),
    #[error("invalid HLS byte range: {0}")]
    InvalidByteRange(String),
}

pub fn parse_hls(base_url: &str, body: &str) -> Result<HlsManifest, HlsError> {
    if body.trim().is_empty() {
        return Err(HlsError::EmptyManifest);
    }

    let mut lines = body.lines().map(str::trim).filter(|line| !line.is_empty());
    if lines.next() != Some("#EXTM3U") {
        return Err(HlsError::MissingHeader);
    }

    let base = Url::parse(base_url).map_err(|_| HlsError::InvalidBaseUrl(base_url.to_owned()))?;
    let mut variants = Vec::new();
    let mut renditions = Vec::new();
    let mut segments = Vec::new();
    let mut media_sequence = 0_u64;
    let mut target_duration_seconds = None;
    let mut end_list = false;

    let mut pending_variant: Option<String> = None;
    let mut pending_duration: Option<f64> = None;
    let mut pending_discontinuity = false;
    let mut pending_byte_range: Option<HlsByteRange> = None;
    let mut active_init_map: Option<HlsInitMap> = None;
    let mut active_key: Option<HlsKey> = None;
    let mut sequence_offset = 0_u64;
    let mut next_implicit_offset: Option<u64> = None;

    for raw_line in body.lines().skip(1) {
        let line = raw_line.trim();
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
            next_implicit_offset = None;
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            pending_duration = value
                .split(',')
                .next()
                .and_then(|duration| duration.trim().parse::<f64>().ok());
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            let mut range = parse_byte_range(value.trim())?;
            if range.offset.is_none() {
                range.offset = next_implicit_offset;
            }
            pending_byte_range = Some(range);
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-MAP:") {
            active_init_map = parse_init_map(&base, value);
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-KEY:") {
            active_key = parse_key(&base, value);
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA:") {
            if let Some(rendition) = parse_rendition(&base, value) {
                renditions.push(rendition);
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_variant = Some(value.to_owned());
            continue;
        }

        if line.starts_with('#') {
            continue;
        }

        let resolved = resolve_uri(&base, line);

        if let Some(attributes) = pending_variant.take() {
            variants.push(parse_variant(&attributes, resolved));
            continue;
        }

        let byte_range = pending_byte_range.take();
        next_implicit_offset = byte_range
            .as_ref()
            .and_then(|range| range.offset.map(|offset| offset.saturating_add(range.length)));

        segments.push(HlsSegment {
            uri: resolved,
            duration_seconds: pending_duration.take(),
            sequence: media_sequence + sequence_offset,
            discontinuity: std::mem::take(&mut pending_discontinuity),
            byte_range,
            init_map: active_init_map.clone(),
            key: active_key.clone(),
        });
        sequence_offset += 1;
    }

    let kind = if variants.is_empty() && renditions.is_empty() {
        HlsPlaylistKind::Media
    } else {
        HlsPlaylistKind::Master
    };

    Ok(HlsManifest {
        kind,
        variants,
        renditions,
        segments,
        media_sequence,
        target_duration_seconds,
        end_list,
    })
}

fn parse_variant(attributes: &str, uri: String) -> HlsVariant {
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

    for (key, value) in split_attributes(attributes) {
        let value = unquote(value);
        match key {
            "BANDWIDTH" => variant.bandwidth = value.parse().ok(),
            "AVERAGE-BANDWIDTH" => variant.average_bandwidth = value.parse().ok(),
            "RESOLUTION" => {
                variant.resolution = value
                    .split_once('x')
                    .and_then(|(width, height)| match (width.parse(), height.parse()) {
                        (Ok(width), Ok(height)) => Some((width, height)),
                        _ => None,
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

fn parse_rendition(base: &Url, attributes: &str) -> Option<HlsRendition> {
    let attrs = split_attributes(attributes);
    let kind = match attr(&attrs, "TYPE")? {
        "AUDIO" => HlsRenditionKind::Audio,
        "VIDEO" => HlsRenditionKind::Video,
        "SUBTITLES" => HlsRenditionKind::Subtitles,
        "CLOSED-CAPTIONS" => HlsRenditionKind::ClosedCaptions,
        _ => return None,
    };

    Some(HlsRendition {
        kind,
        group_id: unquote(attr(&attrs, "GROUP-ID")?).to_owned(),
        name: unquote(attr(&attrs, "NAME")?).to_owned(),
        uri: attr(&attrs, "URI").map(|uri| resolve_uri(base, unquote(uri))),
        language: attr(&attrs, "LANGUAGE").map(|value| unquote(value).to_owned()),
        default: attr_yes(&attrs, "DEFAULT"),
        autoselect: attr_yes(&attrs, "AUTOSELECT"),
        forced: attr_yes(&attrs, "FORCED"),
        channels: attr(&attrs, "CHANNELS").map(|value| unquote(value).to_owned()),
    })
}

fn parse_init_map(base: &Url, attributes: &str) -> Option<HlsInitMap> {
    let attrs = split_attributes(attributes);
    let uri = attr(&attrs, "URI")?;
    let byte_range = attr(&attrs, "BYTERANGE").and_then(|value| parse_byte_range(unquote(value)).ok());

    Some(HlsInitMap {
        uri: resolve_uri(base, unquote(uri)),
        byte_range,
    })
}

fn parse_key(base: &Url, attributes: &str) -> Option<HlsKey> {
    let attrs = split_attributes(attributes);
    let method = match attr(&attrs, "METHOD").map(unquote)? {
        "NONE" => HlsEncryptionMethod::None,
        "AES-128" => HlsEncryptionMethod::Aes128,
        "SAMPLE-AES" => HlsEncryptionMethod::SampleAes,
        other => HlsEncryptionMethod::Other(other.to_owned()),
    };

    if method == HlsEncryptionMethod::None {
        return None;
    }

    Some(HlsKey {
        method,
        uri: attr(&attrs, "URI").map(|value| resolve_uri(base, unquote(value))),
        iv: attr(&attrs, "IV").map(|value| unquote(value).to_owned()),
        key_format: attr(&attrs, "KEYFORMAT").map(|value| unquote(value).to_owned()),
    })
}

fn parse_byte_range(value: &str) -> Result<HlsByteRange, HlsError> {
    let value = unquote(value);
    let (length, offset) = match value.split_once('@') {
        Some((length, offset)) => (
            length
                .parse::<u64>()
                .map_err(|_| HlsError::InvalidByteRange(value.to_owned()))?,
            Some(
                offset
                    .parse::<u64>()
                    .map_err(|_| HlsError::InvalidByteRange(value.to_owned()))?,
            ),
        ),
        None => (
            value
                .parse::<u64>()
                .map_err(|_| HlsError::InvalidByteRange(value.to_owned()))?,
            None,
        ),
    };

    Ok(HlsByteRange { length, offset })
}

fn resolve_uri(base: &Url, uri: &str) -> String {
    base.join(uri)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| uri.to_owned())
}

fn attr<'a>(attrs: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then_some(*value))
}

fn attr_yes(attrs: &[(&str, &str)], key: &str) -> bool {
    attr(attrs, key)
        .map(unquote)
        .is_some_and(|value| value.eq_ignore_ascii_case("YES"))
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value)
}

fn split_attributes(input: &str) -> Vec<(&str, &str)> {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HlsTransferUnitKind {
    Initialization,
    MediaSegment,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsTransferUnit {
    pub order: u64,
    pub kind: HlsTransferUnitKind,
    pub uri: String,
    pub byte_range: Option<HlsByteRange>,
    pub sequence: Option<u64>,
    pub discontinuity: bool,
    pub key: Option<HlsKey>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsMediaPlan {
    pub units: Vec<HlsTransferUnit>,
    pub end_list: bool,
    pub target_duration_seconds: Option<u64>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum HlsPlanError {
    #[error("HLS transfer planning requires a media playlist")]
    MasterPlaylist,
    #[error("HLS media playlist contains no segments")]
    EmptyMediaPlaylist,
}

/// Select the highest quality advertised variant using resolution first and
/// bandwidth second. This intentionally avoids codec policy so callers can
/// layer device/container preferences above the protocol parser.
pub fn select_best_hls_variant(manifest: &HlsManifest) -> Option<&HlsVariant> {
    manifest.variants.iter().max_by_key(|variant| {
        let (width, height) = variant.resolution.unwrap_or((0, 0));
        (
            u64::from(width) * u64::from(height),
            variant.average_bandwidth.or(variant.bandwidth).unwrap_or(0),
        )
    })
}

/// Convert one HLS media playlist into ordered native transfer units.
///
/// Initialization maps are emitted only when they change. Encryption metadata
/// stays attached to each media segment so the media executor can fetch keys
/// and decrypt without re-parsing the manifest.
pub fn build_hls_media_plan(manifest: &HlsManifest) -> Result<HlsMediaPlan, HlsPlanError> {
    if manifest.kind != HlsPlaylistKind::Media {
        return Err(HlsPlanError::MasterPlaylist);
    }
    if manifest.segments.is_empty() {
        return Err(HlsPlanError::EmptyMediaPlaylist);
    }

    let mut units = Vec::with_capacity(manifest.segments.len() + 1);
    let mut order = 0_u64;
    let mut active_map: Option<HlsInitMap> = None;

    for segment in &manifest.segments {
        if segment.init_map != active_map {
            if let Some(init_map) = &segment.init_map {
                units.push(HlsTransferUnit {
                    order,
                    kind: HlsTransferUnitKind::Initialization,
                    uri: init_map.uri.clone(),
                    byte_range: init_map.byte_range.clone(),
                    sequence: None,
                    discontinuity: false,
                    key: segment.key.clone(),
                });
                order += 1;
            }
            active_map = segment.init_map.clone();
        }

        units.push(HlsTransferUnit {
            order,
            kind: HlsTransferUnitKind::MediaSegment,
            uri: segment.uri.clone(),
            byte_range: segment.byte_range.clone(),
            sequence: Some(segment.sequence),
            discontinuity: segment.discontinuity,
            key: segment.key.clone(),
        });
        order += 1;
    }

    Ok(HlsMediaPlan {
        units,
        end_list: manifest.end_list,
        target_duration_seconds: manifest.target_duration_seconds,
    })
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsLiveCursor {
    pub next_sequence: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HlsLiveRefresh {
    pub plan: Option<HlsMediaPlan>,
    pub next_cursor: HlsLiveCursor,
    pub reload_after_millis: u64,
    pub ended: bool,
}

/// Build one incremental live-HLS refresh from a newly fetched media playlist.
///
/// Already-consumed sequence numbers are filtered out. The cursor advances only
/// to the first sequence not yet consumed, so callers can persist it safely
/// across process restarts.
pub fn build_hls_live_refresh(
    manifest: &HlsManifest,
    cursor: HlsLiveCursor,
) -> Result<HlsLiveRefresh, HlsPlanError> {
    if manifest.kind != HlsPlaylistKind::Media {
        return Err(HlsPlanError::MasterPlaylist);
    }

    let next_sequence = cursor.next_sequence.unwrap_or(manifest.media_sequence);
    let selected: Vec<HlsSegment> = manifest
        .segments
        .iter()
        .filter(|segment| segment.sequence >= next_sequence)
        .cloned()
        .collect();

    let plan = if selected.is_empty() {
        None
    } else {
        let selected_manifest = HlsManifest {
            kind: HlsPlaylistKind::Media,
            variants: Vec::new(),
            renditions: Vec::new(),
            segments: selected,
            media_sequence: next_sequence,
            target_duration_seconds: manifest.target_duration_seconds,
            end_list: manifest.end_list,
        };
        Some(build_hls_media_plan(&selected_manifest)?)
    };

    let next_cursor = manifest
        .segments
        .last()
        .map(|segment| HlsLiveCursor {
            next_sequence: Some(segment.sequence.saturating_add(1)),
        })
        .unwrap_or(cursor);

    let reload_after_millis = manifest
        .target_duration_seconds
        .unwrap_or(6)
        .saturating_mul(1000)
        .max(1000);

    Ok(HlsLiveRefresh {
        plan,
        next_cursor,
        reload_after_millis,
        ended: manifest.end_list,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_master_variants_and_audio_renditions() {
        let manifest = parse_hls(
            "https://cdn.test/path/master.m3u8",
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE=\"en\",URI=\"audio/en.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\",FRAME-RATE=60,AUDIO=\"aac\"\nvideo/1080.m3u8\n",
        )
        .expect("master");

        assert_eq!(manifest.kind, HlsPlaylistKind::Master);
        assert_eq!(manifest.variants.len(), 1);
        assert_eq!(manifest.renditions.len(), 1);
        assert_eq!(manifest.renditions[0].language.as_deref(), Some("en"));
        assert_eq!(
            manifest.renditions[0].uri.as_deref(),
            Some("https://cdn.test/path/audio/en.m3u8")
        );
        assert_eq!(manifest.variants[0].resolution, Some((1920, 1080)));
        assert_eq!(manifest.variants[0].frame_rate_milli, Some(60_000));
    }

    #[test]
    fn parses_media_segments_with_ranges_map_key_and_sequence() {
        let manifest = parse_hls(
            "https://cdn.test/vod/index.m3u8",
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x01\n#EXT-X-BYTERANGE:1000@720\n#EXTINF:5.5,\nmedia.mp4\n#EXT-X-BYTERANGE:900\n#EXT-X-DISCONTINUITY\n#EXTINF:6.0,\nmedia.mp4\n#EXT-X-ENDLIST\n",
        )
        .expect("media");

        assert_eq!(manifest.kind, HlsPlaylistKind::Media);
        assert_eq!(manifest.media_sequence, 42);
        assert_eq!(manifest.segments.len(), 2);
        assert_eq!(
            manifest.segments[0].byte_range,
            Some(HlsByteRange {
                length: 1000,
                offset: Some(720)
            })
        );
        assert_eq!(
            manifest.segments[1].byte_range,
            Some(HlsByteRange {
                length: 900,
                offset: Some(1720)
            })
        );
        assert_eq!(
            manifest.segments[0].init_map.as_ref().map(|map| map.uri.as_str()),
            Some("https://cdn.test/vod/init.mp4")
        );
        assert_eq!(
            manifest.segments[0].key.as_ref().map(|key| &key.method),
            Some(&HlsEncryptionMethod::Aes128)
        );
        assert!(manifest.segments[1].discontinuity);
        assert!(manifest.end_list);
    }

    #[test]
    fn rejects_invalid_byte_range() {
        assert_eq!(
            parse_byte_range("abc"),
            Err(HlsError::InvalidByteRange("abc".to_owned()))
        );
    }

    #[test]
    fn live_refresh_only_emits_unseen_sequences() {
        let first = parse_hls(
            "https://cdn.test/live/index.m3u8",
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n10.ts\n#EXTINF:4,\n11.ts\n",
        )
        .expect("first live manifest");
        let refresh = build_hls_live_refresh(&first, HlsLiveCursor::default())
            .expect("first refresh");

        assert_eq!(refresh.reload_after_millis, 4000);
        assert_eq!(refresh.next_cursor.next_sequence, Some(12));
        assert_eq!(
            refresh
                .plan
                .as_ref()
                .expect("initial plan")
                .units
                .iter()
                .filter_map(|unit| unit.sequence)
                .collect::<Vec<_>>(),
            vec![10, 11]
        );

        let second = parse_hls(
            "https://cdn.test/live/index.m3u8",
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:11\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n11.ts\n#EXTINF:4,\n12.ts\n#EXT-X-ENDLIST\n",
        )
        .expect("second live manifest");
        let refresh = build_hls_live_refresh(&second, refresh.next_cursor)
            .expect("second refresh");

        assert!(refresh.ended);
        assert_eq!(refresh.next_cursor.next_sequence, Some(13));
        assert_eq!(
            refresh
                .plan
                .as_ref()
                .expect("incremental plan")
                .units
                .iter()
                .filter_map(|unit| unit.sequence)
                .collect::<Vec<_>>(),
            vec![12]
        );
    }

    #[test]
    fn selects_highest_resolution_variant_before_bandwidth() {
        let manifest = parse_hls(
            "https://cdn.test/master.m3u8",
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080.m3u8\n",
        )
        .expect("master");

        assert_eq!(
            select_best_hls_variant(&manifest).map(|variant| variant.uri.as_str()),
            Some("https://cdn.test/1080.m3u8")
        );
    }

    #[test]
    fn media_plan_emits_init_map_once_and_preserves_encryption_metadata() {
        let manifest = parse_hls(
            "https://cdn.test/vod/index.m3u8",
            "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\na.m4s\n#EXTINF:4,\nb.m4s\n#EXT-X-ENDLIST\n",
        )
        .expect("media");
        let plan = build_hls_media_plan(&manifest).expect("plan");

        assert_eq!(plan.units.len(), 3);
        assert_eq!(plan.units[0].kind, HlsTransferUnitKind::Initialization);
        assert_eq!(plan.units[1].sequence, Some(0));
        assert_eq!(plan.units[2].sequence, Some(1));
        assert_eq!(
            plan.units[1].key.as_ref().map(|key| &key.method),
            Some(&HlsEncryptionMethod::Aes128)
        );
    }
}
