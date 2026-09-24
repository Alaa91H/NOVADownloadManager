use std::collections::BTreeMap;

use nova_download_core::{
    fetch_http_bytes_with_context, post_http_bytes_with_context, HttpRequestContext,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::{form_urlencoded, Url};

use crate::{
    ExtractRequest, MediaDescriptor, MediaError, MediaExtractor, MediaMetadata, MediaProtocol,
    MediaSourceKind, MediaStream, MediaTrackKind, SubtitleTrack,
};

const WATCH_PAGE_MAX_BYTES: usize = 6 * 1024 * 1024;
const PLAYER_RESPONSE_MAX_BYTES: usize = 4 * 1024 * 1024;
const YOUTUBE_ORIGIN: &str = "https://www.youtube.com";
const YOUTUBE_BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum YouTubeChallengeKind {
    Signature,
    ThrottlingParameter,
    SignatureAndThrottling,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct YouTubePendingFormat {
    pub itag: Option<u64>,
    pub mime_type: Option<String>,
    pub cipher_url: Option<String>,
    pub encrypted_signature: Option<String>,
    pub signature_parameter: Option<String>,
    pub throttling_parameter: Option<String>,
    pub challenge: YouTubeChallengeKind,
    pub stream_template: MediaStream,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct YouTubeExtraction {
    pub video_id: String,
    pub descriptor: MediaDescriptor,
    pub pending_formats: Vec<YouTubePendingFormat>,
    pub player_js_url: Option<String>,
    pub visitor_data: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct YouTubeBootstrap {
    api_key: String,
    context: Value,
    client_name_header: Option<String>,
    client_version: Option<String>,
    player_js_url: Option<String>,
    visitor_data: Option<String>,
}

pub trait YouTubeChallengeSolver: Send + Sync {
    fn decipher_signature(
        &self,
        player_javascript: &str,
        encrypted_signature: &str,
    ) -> Result<String, String>;

    fn transform_throttling_parameter(
        &self,
        player_javascript: &str,
        value: &str,
    ) -> Result<String, String>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct YouTubeChallengeResolution {
    pub resolved_stream_ids: Vec<String>,
    pub unresolved_itags: Vec<u64>,
}

pub fn resolve_youtube_pending_formats(
    extraction: &mut YouTubeExtraction,
    context: &HttpRequestContext,
    solver: &dyn YouTubeChallengeSolver,
) -> Result<YouTubeChallengeResolution, MediaError> {
    if extraction.pending_formats.is_empty() {
        return Ok(YouTubeChallengeResolution {
            resolved_stream_ids: Vec::new(),
            unresolved_itags: Vec::new(),
        });
    }

    let player_js_url = extraction
        .player_js_url
        .as_deref()
        .ok_or_else(|| MediaError::ExtractorFailed {
            extractor: "youtube-native",
            message: "YouTube player JavaScript URL is unavailable for challenge resolution"
                .to_owned(),
        })?;

    let mut player_context = context.clone();
    if player_context.user_agent.is_none() {
        player_context.user_agent = Some(YOUTUBE_BROWSER_UA.to_owned());
    }
    if player_context.referer.is_none() {
        player_context.referer = Some(extraction.descriptor.metadata.webpage_url.clone());
    }

    let player_js = fetch_http_bytes_with_context(
        player_js_url,
        &player_context,
        PLAYER_RESPONSE_MAX_BYTES,
    )
    .map_err(|error| MediaError::Transport(error.to_string()))?;
    let player_js =
        String::from_utf8(player_js.body).map_err(|_| MediaError::ExtractorFailed {
            extractor: "youtube-native",
            message: "YouTube player JavaScript is not valid UTF-8".to_owned(),
        })?;

    let pending = std::mem::take(&mut extraction.pending_formats);
    let mut unresolved = Vec::new();
    let mut resolved_stream_ids = Vec::new();
    let mut unresolved_itags = Vec::new();

    for format in pending {
        match resolve_one_pending_format(&format, &player_js, solver) {
            Ok(stream) => {
                if !extraction
                    .descriptor
                    .streams
                    .iter()
                    .any(|existing| existing.id == stream.id)
                {
                    resolved_stream_ids.push(stream.id.clone());
                    extraction.descriptor.streams.push(stream);
                }
            }
            Err(_) => {
                if let Some(itag) = format.itag {
                    unresolved_itags.push(itag);
                }
                unresolved.push(format);
            }
        }
    }

    extraction.pending_formats = unresolved;
    Ok(YouTubeChallengeResolution {
        resolved_stream_ids,
        unresolved_itags,
    })
}

fn resolve_one_pending_format(
    format: &YouTubePendingFormat,
    player_javascript: &str,
    solver: &dyn YouTubeChallengeSolver,
) -> Result<MediaStream, String> {
    let source_url = format
        .cipher_url
        .as_deref()
        .ok_or_else(|| "challenged YouTube format has no base URL".to_owned())?;
    let mut url = Url::parse(source_url)
        .map_err(|error| format!("invalid challenged YouTube format URL: {error}"))?;

    if let Some(encrypted_signature) = format.encrypted_signature.as_deref() {
        let signature = solver.decipher_signature(player_javascript, encrypted_signature)?;
        let parameter = format
            .signature_parameter
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or("signature");
        set_query_parameter(&mut url, parameter, &signature);
    }

    if let Some(throttling) = format.throttling_parameter.as_deref() {
        let transformed =
            solver.transform_throttling_parameter(player_javascript, throttling)?;
        set_query_parameter(&mut url, "n", &transformed);
    }

    let mut stream = format.stream_template.clone();
    stream.url = url.to_string();
    Ok(stream)
}

fn set_query_parameter(url: &mut Url, key: &str, value: &str) {
    let pairs = url
        .query_pairs()
        .filter(|(existing, _)| existing != key)
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();

    url.set_query(None);
    let mut query = url.query_pairs_mut();
    for (existing, existing_value) in pairs {
        query.append_pair(&existing, &existing_value);
    }
    query.append_pair(key, value);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct YouTubeSelectionPolicy {
    pub max_height: Option<u32>,
    pub prefer_separate_tracks: bool,
}

impl Default for YouTubeSelectionPolicy {
    fn default() -> Self {
        Self {
            max_height: None,
            prefer_separate_tracks: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum YouTubeDownloadPlan {
    SingleStream {
        stream_id: String,
    },
    SeparateTracks {
        video_stream_id: String,
        audio_stream_id: String,
    },
}

/// Select the best direct ISO-BMFF/MP4-compatible YouTube plan for NOVA's
/// native MP4 muxer. WebM formats are intentionally ignored here rather than
/// forcing the caller to fall back to an external post-processor.
pub fn select_youtube_mp4_download_plan(
    extraction: &YouTubeExtraction,
    max_height: Option<u32>,
) -> Option<YouTubeDownloadPlan> {
    let pending_itags: std::collections::BTreeSet<u64> = extraction
        .pending_formats
        .iter()
        .filter_map(|format| format.itag)
        .collect();

    let usable = extraction
        .descriptor
        .streams
        .iter()
        .filter(|stream| {
            stream_itag(stream)
                .map(|itag| !pending_itags.contains(&itag))
                .unwrap_or(true)
        })
        .filter(|stream| {
            max_height.map_or(true, |limit| {
                stream.height.map_or(true, |height| height <= limit)
            })
        })
        .filter(|stream| matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https))
        .filter(|stream| {
            stream.container.as_deref().is_some_and(|container| {
                matches!(
                    container.trim().to_ascii_lowercase().as_str(),
                    "mp4" | "m4a" | "m4v" | "mov"
                )
            })
        })
        .collect::<Vec<_>>();

    let best_muxed = usable
        .iter()
        .copied()
        .filter(|stream| stream.kind == MediaTrackKind::AudioVideo)
        .max_by_key(|stream| stream_quality_score(stream));

    let best_video = usable
        .iter()
        .copied()
        .filter(|stream| stream.kind == MediaTrackKind::Video)
        .max_by_key(|stream| stream_quality_score(stream));

    let best_audio = usable
        .iter()
        .copied()
        .filter(|stream| stream.kind == MediaTrackKind::Audio)
        .max_by_key(|stream| {
            (
                stream.audio_bitrate_bps.or(stream.bitrate_bps).unwrap_or(0),
                stream.content_length.unwrap_or(0),
            )
        });

    if let (Some(video), Some(audio)) = (best_video, best_audio) {
        let separate_is_better = best_muxed.map_or(true, |muxed| {
            stream_quality_score(video) > stream_quality_score(muxed)
        });
        if separate_is_better {
            return Some(YouTubeDownloadPlan::SeparateTracks {
                video_stream_id: video.id.clone(),
                audio_stream_id: audio.id.clone(),
            });
        }
    }

    if let Some(stream) = best_muxed {
        return Some(YouTubeDownloadPlan::SingleStream {
            stream_id: stream.id.clone(),
        });
    }

    best_video.zip(best_audio).map(|(video, audio)| {
        YouTubeDownloadPlan::SeparateTracks {
            video_stream_id: video.id.clone(),
            audio_stream_id: audio.id.clone(),
        }
    })
}

pub fn select_youtube_download_plan(
    extraction: &YouTubeExtraction,
    policy: YouTubeSelectionPolicy,
) -> Option<YouTubeDownloadPlan> {
    let pending_itags: std::collections::BTreeSet<u64> = extraction
        .pending_formats
        .iter()
        .filter_map(|format| format.itag)
        .collect();

    let usable = extraction
        .descriptor
        .streams
        .iter()
        .filter(|stream| {
            stream_itag(stream)
                .map(|itag| !pending_itags.contains(&itag))
                .unwrap_or(true)
        })
        .filter(|stream| {
            policy
                .max_height
                .map_or(true, |limit| stream.height.map_or(true, |height| height <= limit))
        })
        .collect::<Vec<_>>();

    let best_muxed = usable
        .iter()
        .copied()
        .filter(|stream| stream.kind == MediaTrackKind::AudioVideo)
        .filter(|stream| matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https))
        .max_by_key(|stream| stream_quality_score(stream));

    let best_video = usable
        .iter()
        .copied()
        .filter(|stream| stream.kind == MediaTrackKind::Video)
        .filter(|stream| matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https))
        .max_by_key(|stream| stream_quality_score(stream));

    let best_audio = usable
        .iter()
        .copied()
        .filter(|stream| stream.kind == MediaTrackKind::Audio)
        .filter(|stream| matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https))
        .max_by_key(|stream| {
            (
                stream.audio_bitrate_bps.or(stream.bitrate_bps).unwrap_or(0),
                stream.content_length.unwrap_or(0),
            )
        });

    if policy.prefer_separate_tracks {
        if let (Some(video), Some(audio)) = (best_video, best_audio) {
            let separate_is_better = best_muxed.map_or(true, |muxed| {
                stream_quality_score(video) > stream_quality_score(muxed)
            });
            if separate_is_better {
                return Some(YouTubeDownloadPlan::SeparateTracks {
                    video_stream_id: video.id.clone(),
                    audio_stream_id: audio.id.clone(),
                });
            }
        }
    }

    if let Some(stream) = best_muxed {
        return Some(YouTubeDownloadPlan::SingleStream {
            stream_id: stream.id.clone(),
        });
    }

    if let (Some(video), Some(audio)) = (best_video, best_audio) {
        return Some(YouTubeDownloadPlan::SeparateTracks {
            video_stream_id: video.id.clone(),
            audio_stream_id: audio.id.clone(),
        });
    }

    usable
        .into_iter()
        .filter(|stream| matches!(stream.protocol, MediaProtocol::Hls | MediaProtocol::Dash))
        .max_by_key(|stream| {
            (
                u8::from(stream.protocol == MediaProtocol::Dash),
                stream_quality_score(stream),
            )
        })
        .map(|stream| YouTubeDownloadPlan::SingleStream {
            stream_id: stream.id.clone(),
        })
}

fn stream_itag(stream: &MediaStream) -> Option<u64> {
    stream
        .id
        .strip_prefix("youtube-itag-")
        .and_then(|value| value.parse().ok())
}

fn stream_quality_score(stream: &MediaStream) -> (u32, u32, u64) {
    (
        stream.height.unwrap_or(0),
        stream.fps.map(|fps| (fps * 1000.0) as u32).unwrap_or(0),
        stream.bitrate_bps.unwrap_or(0),
    )
}

pub struct YouTubeExtractor;

impl YouTubeExtractor {
    pub fn extract_native(
        &self,
        request: &ExtractRequest,
    ) -> Result<YouTubeExtraction, MediaError> {
        let video_id = youtube_video_id(&request.parsed_url()?)
            .ok_or_else(|| MediaError::ExtractorFailed {
                extractor: self.id(),
                message: "YouTube URL does not contain a supported video id".to_owned(),
            })?;

        let mut context = request.request_context()?;
        if context.user_agent.is_none() {
            context.user_agent = Some(YOUTUBE_BROWSER_UA.to_owned());
        }
        if context.referer.is_none() {
            context.referer = Some(format!("{YOUTUBE_ORIGIN}/watch?v={video_id}"));
        }

        let watch_url = format!("{YOUTUBE_ORIGIN}/watch?v={video_id}&hl=en");
        let watch = fetch_http_bytes_with_context(&watch_url, &context, WATCH_PAGE_MAX_BYTES)
            .map_err(|error| MediaError::Transport(error.to_string()))?;
        let html = String::from_utf8(watch.body).map_err(|_| MediaError::ExtractorFailed {
            extractor: self.id(),
            message: "YouTube watch page is not valid UTF-8".to_owned(),
        })?;

        let bootstrap = extract_bootstrap(&html);
        let player_response = extract_initial_player_response(&html)
            .filter(player_response_has_details)
            .or_else(|| {
                bootstrap
                    .as_ref()
                    .and_then(|bootstrap| fetch_innertube_player(&video_id, bootstrap, &context).ok())
            })
            .ok_or_else(|| MediaError::ExtractorFailed {
                extractor: self.id(),
                message: "YouTube player response was not available from watch page or Innertube"
                    .to_owned(),
            })?;

        ensure_playable(&player_response).map_err(|message| MediaError::ExtractorFailed {
            extractor: self.id(),
            message,
        })?;

        normalize_player_response(
            &video_id,
            &watch_url,
            &player_response,
            bootstrap.as_ref(),
            &request.headers,
        )
    }
}

impl MediaExtractor for YouTubeExtractor {
    fn id(&self) -> &'static str {
        "youtube-native"
    }

    fn priority(&self) -> i32 {
        1000
    }

    fn supports(&self, request: &ExtractRequest) -> bool {
        request
            .parsed_url()
            .ok()
            .is_some_and(|url| youtube_video_id(&url).is_some())
    }

    fn extract(&self, request: &ExtractRequest) -> Result<MediaDescriptor, MediaError> {
        self.extract_native(request).map(|extraction| extraction.descriptor)
    }
}

pub fn youtube_video_id(url: &Url) -> Option<String> {
    let host = url.host_str()?.trim_start_matches("www.").to_ascii_lowercase();
    let candidate = match host.as_str() {
        "youtu.be" => url.path_segments()?.next()?.to_owned(),
        "youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            let mut segments = url.path_segments()?;
            match segments.next().unwrap_or_default() {
                "watch" => url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "v").then(|| value.into_owned()))?,
                "shorts" | "live" | "embed" => segments.next()?.to_owned(),
                _ => return None,
            }
        }
        _ => return None,
    };

    let id = candidate.trim();
    (id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then(|| id.to_owned())
}

fn extract_bootstrap(html: &str) -> Option<YouTubeBootstrap> {
    let cfg = ["ytcfg.set(", "window.ytcfg.set(", "ytcfg.data_ ="]
        .iter()
        .flat_map(|marker| extract_json_objects_after_marker(html, marker))
        .find(|cfg| {
            cfg.get("INNERTUBE_API_KEY").and_then(Value::as_str).is_some()
                && cfg.get("INNERTUBE_CONTEXT").is_some()
        })?;

    let api_key = cfg.get("INNERTUBE_API_KEY")?.as_str()?.to_owned();
    let context = cfg.get("INNERTUBE_CONTEXT")?.clone();
    let client_name_header = cfg
        .get("INNERTUBE_CONTEXT_CLIENT_NAME")
        .and_then(value_to_header_string);
    let client_version = cfg
        .get("INNERTUBE_CONTEXT_CLIENT_VERSION")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            context
                .pointer("/client/clientVersion")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let player_js_url = cfg
        .get("PLAYER_JS_URL")
        .and_then(Value::as_str)
        .and_then(resolve_youtube_url)
        .or_else(|| {
            extract_json_string_property(html, "jsUrl")
                .and_then(|value| resolve_youtube_url(&value))
        });
    let visitor_data = context
        .pointer("/client/visitorData")
        .and_then(Value::as_str)
        .map(str::to_owned);

    Some(YouTubeBootstrap {
        api_key,
        context,
        client_name_header,
        client_version,
        player_js_url,
        visitor_data,
    })
}

fn fetch_innertube_player(
    video_id: &str,
    bootstrap: &YouTubeBootstrap,
    base_context: &HttpRequestContext,
) -> Result<Value, MediaError> {
    let endpoint = format!(
        "{YOUTUBE_ORIGIN}/youtubei/v1/player?key={}&prettyPrint=false",
        bootstrap.api_key
    );
    let body = json!({
        "context": bootstrap.context.clone(),
        "videoId": video_id,
        "playbackContext": {
            "contentPlaybackContext": {
                "html5Preference": "HTML5_PREF_WANTS"
            }
        }
    });
    let body = serde_json::to_vec(&body).map_err(|error| MediaError::ExtractorFailed {
        extractor: "youtube-native",
        message: format!("failed to encode Innertube request: {error}"),
    })?;

    let mut context = base_context.clone();
    context
        .headers
        .insert("Origin".to_owned(), YOUTUBE_ORIGIN.to_owned());
    if let Some(client_name) = &bootstrap.client_name_header {
        context
            .headers
            .insert("X-Youtube-Client-Name".to_owned(), client_name.clone());
    }
    if let Some(client_version) = &bootstrap.client_version {
        context
            .headers
            .insert("X-Youtube-Client-Version".to_owned(), client_version.clone());
    }

    let response = post_http_bytes_with_context(
        &endpoint,
        &context,
        "application/json",
        &body,
        PLAYER_RESPONSE_MAX_BYTES,
    )
    .map_err(|error| MediaError::Transport(error.to_string()))?;

    serde_json::from_slice(&response.body).map_err(|error| MediaError::ExtractorFailed {
        extractor: "youtube-native",
        message: format!("invalid Innertube player JSON: {error}"),
    })
}

fn extract_initial_player_response(html: &str) -> Option<Value> {
    extract_json_object_after_markers(
        html,
        &[
            "var ytInitialPlayerResponse =",
            "ytInitialPlayerResponse =",
            "window.ytInitialPlayerResponse =",
        ],
    )
}

fn player_response_has_details(value: &Value) -> bool {
    value.get("videoDetails").is_some() || value.get("streamingData").is_some()
}

fn ensure_playable(player: &Value) -> Result<(), String> {
    let status = player
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");

    if matches!(status, "OK" | "LIVE_STREAM_OFFLINE") {
        return Ok(());
    }

    let reason = player
        .pointer("/playabilityStatus/reason")
        .and_then(Value::as_str)
        .or_else(|| {
            player
                .pointer("/playabilityStatus/messages/0")
                .and_then(Value::as_str)
        })
        .unwrap_or("YouTube reported that this video is not playable");

    Err(format!("YouTube playability status {status}: {reason}"))
}

fn normalize_player_response(
    video_id: &str,
    webpage_url: &str,
    player: &Value,
    bootstrap: Option<&YouTubeBootstrap>,
    request_headers: &BTreeMap<String, String>,
) -> Result<YouTubeExtraction, MediaError> {
    let details = player.get("videoDetails").unwrap_or(&Value::Null);
    let title = details
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(video_id)
        .to_owned();
    let duration_millis = details
        .get("lengthSeconds")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|seconds| seconds.checked_mul(1000));
    let uploader = details
        .get("author")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let thumbnail_url = details
        .pointer("/thumbnail/thumbnails")
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .and_then(|item| item.get("url"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let is_live = details
        .get("isLiveContent")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || player
            .pointer("/videoDetails/isLive")
            .and_then(Value::as_bool)
            .unwrap_or(false);

    let mut streams = Vec::new();
    let mut pending_formats = Vec::new();
    if let Some(streaming) = player.get("streamingData") {
        for key in ["formats", "adaptiveFormats"] {
            if let Some(formats) = streaming.get(key).and_then(Value::as_array) {
                for format in formats {
                    normalize_format(format, request_headers, &mut streams, &mut pending_formats);
                }
            }
        }

        if let Some(url) = streaming.get("hlsManifestUrl").and_then(Value::as_str) {
            streams.push(manifest_stream(
                "youtube-hls",
                MediaProtocol::Hls,
                url,
                request_headers,
            ));
        }
        if let Some(url) = streaming.get("dashManifestUrl").and_then(Value::as_str) {
            streams.push(manifest_stream(
                "youtube-dash",
                MediaProtocol::Dash,
                url,
                request_headers,
            ));
        }
    }

    let subtitles = normalize_captions(player);
    if streams.is_empty() && pending_formats.is_empty() {
        return Err(MediaError::ExtractorFailed {
            extractor: "youtube-native",
            message: "YouTube player response contained no stream formats".to_owned(),
        });
    }

    Ok(YouTubeExtraction {
        video_id: video_id.to_owned(),
        descriptor: MediaDescriptor {
            source_kind: if is_live {
                MediaSourceKind::Live
            } else {
                MediaSourceKind::Site
            },
            metadata: MediaMetadata {
                title,
                description: details
                    .get("shortDescription")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                duration_millis,
                uploader,
                webpage_url: webpage_url.to_owned(),
                thumbnail_url,
            },
            streams,
            subtitles,
            request_headers: request_headers.clone(),
            is_live,
        },
        pending_formats,
        player_js_url: bootstrap.and_then(|value| value.player_js_url.clone()),
        visitor_data: bootstrap.and_then(|value| value.visitor_data.clone()),
    })
}

fn normalize_format(
    format: &Value,
    request_headers: &BTreeMap<String, String>,
    streams: &mut Vec<MediaStream>,
    pending_formats: &mut Vec<YouTubePendingFormat>,
) {
    let itag = format.get("itag").and_then(Value::as_u64);
    let mime_type = format
        .get("mimeType")
        .and_then(Value::as_str)
        .map(str::to_owned);

    if let Some(cipher) = format
        .get("signatureCipher")
        .or_else(|| format.get("cipher"))
        .and_then(Value::as_str)
    {
        pending_formats.push(parse_pending_format(
            format,
            request_headers,
            itag,
            mime_type,
            cipher,
        ));
        return;
    }

    let Some(url) = format.get("url").and_then(Value::as_str) else {
        return;
    };

    let throttling_parameter = Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .query_pairs()
                .find_map(|(key, value)| (key == "n").then(|| value.into_owned()))
        });

    if throttling_parameter.is_some() {
        pending_formats.push(YouTubePendingFormat {
            itag,
            mime_type: mime_type.clone(),
            cipher_url: Some(url.to_owned()),
            encrypted_signature: None,
            signature_parameter: None,
            throttling_parameter,
            challenge: YouTubeChallengeKind::ThrottlingParameter,
            stream_template: media_stream_from_format(format, url, request_headers),
        });
        return;
    }

    streams.push(media_stream_from_format(format, url, request_headers));
}

fn media_stream_from_format(
    format: &Value,
    url: &str,
    request_headers: &BTreeMap<String, String>,
) -> MediaStream {
    let mime = format.get("mimeType").and_then(Value::as_str).unwrap_or_default();
    let (container, codecs) = parse_mime_type(mime);
    let width = value_u32(format.get("width"));
    let height = value_u32(format.get("height"));
    let fps = format.get("fps").and_then(Value::as_f64).map(|value| value as f32);
    let audio_bitrate_bps = format
        .get("audioSampleRate")
        .and_then(Value::as_str)
        .and_then(|_| format.get("bitrate"))
        .and_then(Value::as_u64);
    let has_video = mime.starts_with("video/") || width.is_some() || height.is_some();
    let has_audio = mime.starts_with("audio/")
        || format.get("audioQuality").is_some()
        || codecs.iter().any(|codec| is_audio_codec(codec));
    let kind = match (has_video, has_audio) {
        (true, true) => MediaTrackKind::AudioVideo,
        (true, false) => MediaTrackKind::Video,
        (false, true) => MediaTrackKind::Audio,
        (false, false) => MediaTrackKind::AudioVideo,
    };

    let video_codec = codecs.iter().find(|codec| !is_audio_codec(codec)).cloned();
    let audio_codec = codecs.iter().find(|codec| is_audio_codec(codec)).cloned();

    MediaStream {
        id: format
            .get("itag")
            .and_then(Value::as_u64)
            .map(|itag| format!("youtube-itag-{itag}"))
            .unwrap_or_else(|| "youtube-format".to_owned()),
        kind,
        protocol: if url.starts_with("http://") {
            MediaProtocol::Http
        } else {
            MediaProtocol::Https
        },
        url: url.to_owned(),
        container,
        video_codec,
        audio_codec,
        width,
        height,
        fps,
        bitrate_bps: format.get("bitrate").and_then(Value::as_u64),
        audio_bitrate_bps,
        content_length: format
            .get("contentLength")
            .and_then(Value::as_str)
            .and_then(|value| value.parse().ok()),
        language: format
            .get("language")
            .and_then(Value::as_str)
            .map(str::to_owned),
        headers: request_headers.clone(),
    }
}

fn manifest_stream(
    id: &str,
    protocol: MediaProtocol,
    url: &str,
    request_headers: &BTreeMap<String, String>,
) -> MediaStream {
    MediaStream {
        id: id.to_owned(),
        kind: MediaTrackKind::AudioVideo,
        protocol,
        url: url.to_owned(),
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
        headers: request_headers.clone(),
    }
}

fn parse_pending_format(
    format: &Value,
    request_headers: &BTreeMap<String, String>,
    itag: Option<u64>,
    mime_type: Option<String>,
    cipher: &str,
) -> YouTubePendingFormat {
    let fields: BTreeMap<String, String> = form_urlencoded::parse(cipher.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let cipher_url = fields.get("url").cloned();
    let encrypted_signature = fields.get("s").cloned();
    let signature_parameter = fields.get("sp").cloned();
    let throttling_parameter = cipher_url.as_deref().and_then(|url| {
        Url::parse(url).ok().and_then(|parsed| {
            parsed
                .query_pairs()
                .find_map(|(key, value)| (key == "n").then(|| value.into_owned()))
        })
    });
    let challenge = match (
        encrypted_signature.is_some(),
        throttling_parameter.is_some(),
    ) {
        (true, true) => YouTubeChallengeKind::SignatureAndThrottling,
        (true, false) => YouTubeChallengeKind::Signature,
        (false, true) | (false, false) => YouTubeChallengeKind::ThrottlingParameter,
    };

    let stream_template = media_stream_from_format(
        format,
        cipher_url.as_deref().unwrap_or_default(),
        request_headers,
    );

    YouTubePendingFormat {
        itag,
        mime_type,
        cipher_url,
        encrypted_signature,
        signature_parameter,
        throttling_parameter,
        challenge,
        stream_template,
    }
}

fn normalize_captions(player: &Value) -> Vec<SubtitleTrack> {
    player
        .pointer("/captions/playerCaptionsTracklistRenderer/captionTracks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|track| {
            let url = track.get("baseUrl")?.as_str()?.to_owned();
            let language = track.get("languageCode")?.as_str()?.to_owned();
            let name = track
                .pointer("/name/simpleText")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    track
                        .pointer("/name/runs/0/text")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            Some(SubtitleTrack {
                language,
                name,
                url,
                format: Some("srv3".to_owned()),
                automatic: track
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind == "asr"),
            })
        })
        .collect()
}

fn parse_mime_type(mime: &str) -> (Option<String>, Vec<String>) {
    let mut parts = mime.split(';');
    let container = parts
        .next()
        .and_then(|kind| kind.split_once('/'))
        .map(|(_, subtype)| subtype.trim().to_owned());
    let codecs = parts
        .find_map(|part| part.trim().strip_prefix("codecs="))
        .map(|value| value.trim_matches('"'))
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    (container, codecs)
}

fn is_audio_codec(codec: &str) -> bool {
    let codec = codec.to_ascii_lowercase();
    codec.starts_with("mp4a")
        || codec.starts_with("opus")
        || codec.starts_with("vorbis")
        || codec.starts_with("ac-3")
        || codec.starts_with("ec-3")
}

fn value_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn resolve_youtube_url(value: &str) -> Option<String> {
    Url::parse(YOUTUBE_ORIGIN)
        .ok()?
        .join(value)
        .ok()
        .map(|url| url.to_string())
}

fn value_to_header_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|value| value.to_string()))
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

fn extract_json_objects_after_marker(text: &str, marker: &str) -> Vec<Value> {
    let mut values = Vec::new();
    let mut offset = 0;

    while offset < text.len() {
        let Some(found) = text[offset..].find(marker) else {
            break;
        };
        let start = offset + found + marker.len();
        let tail = &text[start..];
        let Some(brace) = tail.find('{') else {
            break;
        };
        let object = &tail[brace..];
        if let Some(json) = balanced_json_object(object) {
            if let Ok(value) = serde_json::from_str(json) {
                values.push(value);
            }
        }
        offset = start.saturating_add(brace).saturating_add(1);
    }

    values
}

fn extract_json_string_property(text: &str, property: &str) -> Option<String> {
    let marker = format!("\"{property}\":");
    let mut offset = 0;

    while let Some(found) = text[offset..].find(&marker) {
        let start = offset + found + marker.len();
        let tail = text[start..].trim_start();
        if !tail.starts_with('"') {
            offset = start;
            continue;
        }

        let bytes = tail.as_bytes();
        let mut escaped = false;
        for index in 1..bytes.len() {
            let byte = bytes[index];
            if escaped {
                escaped = false;
                continue;
            }
            if byte == b'\\' {
                escaped = true;
                continue;
            }
            if byte == b'"' {
                let encoded = &tail[..=index];
                if let Ok(value) = serde_json::from_str::<String>(encoded) {
                    return Some(value);
                }
                break;
            }
        }
        offset = start;
    }

    None
}

fn extract_json_object_after_markers(text: &str, markers: &[&str]) -> Option<Value> {
    for marker in markers {
        let mut offset = 0;
        while let Some(found) = text[offset..].find(marker) {
            let start = offset + found + marker.len();
            let tail = &text[start..];
            let Some(brace) = tail.find('{') else {
                break;
            };
            let object = &tail[brace..];
            if let Some(json) = balanced_json_object(object) {
                if let Ok(value) = serde_json::from_str(json) {
                    return Some(value);
                }
            }
            offset = start.saturating_add(brace).saturating_add(1);
            if offset >= text.len() {
                break;
            }
        }
    }
    None
}

fn balanced_json_object(input: &str) -> Option<&str> {
    let bytes = input.as_bytes();
    if bytes.first() != Some(&b'{') {
        return None;
    }

    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }

        match byte {
            b'"' => in_string = true,
            b'{' => depth = depth.saturating_add(1),
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return input.get(..=index);
                }
            }
            _ => {}
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_youtube_video_urls() {
        for (url, expected) in [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtu.be/dQw4w9WgXcQ?t=1", "dQw4w9WgXcQ"),
            ("https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ] {
            assert_eq!(
                youtube_video_id(&Url::parse(url).expect("URL")).as_deref(),
                Some(expected)
            );
        }
    }

    #[test]
    fn rejects_playlist_and_invalid_ids() {
        assert_eq!(
            youtube_video_id(
                &Url::parse("https://www.youtube.com/playlist?list=PL123").expect("URL")
            ),
            None
        );
        assert_eq!(
            youtube_video_id(
                &Url::parse("https://www.youtube.com/watch?v=short").expect("URL")
            ),
            None
        );
    }

    #[test]
    fn bootstrap_skips_partial_ytcfg_calls_and_falls_back_to_js_url() {
        let html = r#"
<script>
ytcfg.set({"EXPERIMENT_FLAGS":{"x":true}});
ytcfg.set({"INNERTUBE_API_KEY":"key2","INNERTUBE_CONTEXT_CLIENT_NAME":1,
"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"2.0"}}});
window.bootstrap={"jsUrl":"\\/s\\/player\\/fallback\\/base.js"};
</script>
"#;

        let bootstrap = extract_bootstrap(html).expect("bootstrap");
        assert_eq!(bootstrap.api_key, "key2");
        assert_eq!(
            bootstrap.player_js_url.as_deref(),
            Some("https://www.youtube.com/s/player/fallback/base.js")
        );
    }

    #[test]
    fn extracts_nested_player_and_bootstrap_json() {
        let html = r#"
<script>
ytcfg.set({"INNERTUBE_API_KEY":"key","INNERTUBE_CONTEXT_CLIENT_NAME":1,
"INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260924.00.00",
"PLAYER_JS_URL":"/s/player/abc/base.js",
"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"2.20260924.00.00","visitorData":"visitor"}}});
var ytInitialPlayerResponse = {"videoDetails":{"title":"NOVA","videoId":"dQw4w9WgXcQ"},"streamingData":{}};
</script>
"#;
        let bootstrap = extract_bootstrap(html).expect("bootstrap");
        assert_eq!(bootstrap.api_key, "key");
        assert_eq!(bootstrap.client_name_header.as_deref(), Some("1"));
        assert_eq!(bootstrap.visitor_data.as_deref(), Some("visitor"));
        assert_eq!(
            bootstrap.player_js_url.as_deref(),
            Some("https://www.youtube.com/s/player/abc/base.js")
        );

        let player = extract_initial_player_response(html).expect("player");
        assert_eq!(
            player.pointer("/videoDetails/title").and_then(Value::as_str),
            Some("NOVA")
        );
    }

    #[test]
    fn normalizes_direct_manifest_cipher_and_subtitle_formats() {
        let player = json!({
            "playabilityStatus": {"status": "OK"},
            "videoDetails": {
                "title": "NOVA Test",
                "author": "NOVA",
                "lengthSeconds": "12",
                "shortDescription": "native",
                "thumbnail": {"thumbnails": [{"url": "https://img.test/1.jpg"}]}
            },
            "streamingData": {
                "formats": [{
                    "itag": 18,
                    "url": "https://video.test/file.mp4",
                    "mimeType": "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"",
                    "width": 640,
                    "height": 360,
                    "fps": 30,
                    "bitrate": 500000,
                    "contentLength": "1234"
                }],
                "adaptiveFormats": [{
                    "itag": 137,
                    "signatureCipher": "url=https%3A%2F%2Fvideo.test%2Fv.mp4&sp=sig&s=encrypted",
                    "mimeType": "video/mp4; codecs=\"avc1.640028\"",
                    "width": 1920,
                    "height": 1080
                }],
                "hlsManifestUrl": "https://video.test/live.m3u8",
                "dashManifestUrl": "https://video.test/manifest.mpd"
            },
            "captions": {
                "playerCaptionsTracklistRenderer": {
                    "captionTracks": [{
                        "baseUrl": "https://subs.test/en",
                        "languageCode": "en",
                        "name": {"simpleText": "English"},
                        "kind": "asr"
                    }]
                }
            }
        });

        let extraction = normalize_player_response(
            "dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            &player,
            None,
            &BTreeMap::new(),
        )
        .expect("normalized");

        assert_eq!(extraction.descriptor.metadata.title, "NOVA Test");
        assert_eq!(extraction.descriptor.streams.len(), 3);
        assert_eq!(extraction.pending_formats.len(), 1);
        assert_eq!(
            extraction.pending_formats[0].challenge,
            YouTubeChallengeKind::Signature
        );
        assert_eq!(extraction.descriptor.subtitles.len(), 1);
        assert!(extraction.descriptor.subtitles[0].automatic);
    }

    #[test]
    fn native_player_solver_rebuilds_throttling_parameter() {
        let pending = YouTubePendingFormat {
            itag: Some(18),
            mime_type: Some("video/mp4".to_owned()),
            cipher_url: Some("https://video.test/v.mp4?n=abcdef&x=1".to_owned()),
            encrypted_signature: None,
            signature_parameter: None,
            throttling_parameter: Some("abcdef".to_owned()),
            challenge: YouTubeChallengeKind::ThrottlingParameter,
            stream_template: MediaStream {
                id: "youtube-itag-18".to_owned(),
                kind: MediaTrackKind::AudioVideo,
                protocol: MediaProtocol::Https,
                url: "https://video.test/v.mp4?n=abcdef&x=1".to_owned(),
                container: Some("mp4".to_owned()),
                video_codec: Some("avc1".to_owned()),
                audio_codec: Some("mp4a".to_owned()),
                width: Some(640),
                height: Some(360),
                fps: Some(30.0),
                bitrate_bps: Some(700_000),
                audio_bitrate_bps: Some(128_000),
                content_length: None,
                language: None,
                headers: BTreeMap::new(),
            },
        };
        let player = r#"
NT=function(a){a=a.split("");a.reverse();a=a.slice(1);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let stream = resolve_one_pending_format(
            &pending,
            player,
            &crate::youtube_player::YouTubePlayerScriptSolver,
        )
        .expect("native throttling challenge");
        let url = Url::parse(&stream.url).expect("resolved URL");
        assert_eq!(
            url.query_pairs()
                .find_map(|(key, value)| (key == "n").then(|| value.into_owned()))
                .as_deref(),
            Some("edcba")
        );
    }

    struct FakeChallengeSolver;

    impl YouTubeChallengeSolver for FakeChallengeSolver {
        fn decipher_signature(
            &self,
            _player_javascript: &str,
            encrypted_signature: &str,
        ) -> Result<String, String> {
            Ok(encrypted_signature.chars().rev().collect())
        }

        fn transform_throttling_parameter(
            &self,
            _player_javascript: &str,
            value: &str,
        ) -> Result<String, String> {
            Ok(value.to_ascii_uppercase())
        }
    }

    #[test]
    fn challenge_resolution_rebuilds_signature_and_n_parameters() {
        let pending = YouTubePendingFormat {
            itag: Some(137),
            mime_type: Some("video/mp4".to_owned()),
            cipher_url: Some("https://video.test/v.mp4?n=abc&x=1".to_owned()),
            encrypted_signature: Some("secret".to_owned()),
            signature_parameter: Some("sig".to_owned()),
            throttling_parameter: Some("abc".to_owned()),
            challenge: YouTubeChallengeKind::SignatureAndThrottling,
            stream_template: MediaStream {
                id: "youtube-itag-137".to_owned(),
                kind: MediaTrackKind::Video,
                protocol: MediaProtocol::Https,
                url: "https://video.test/v.mp4?n=abc&x=1".to_owned(),
                container: Some("mp4".to_owned()),
                video_codec: Some("avc1".to_owned()),
                audio_codec: None,
                width: Some(1920),
                height: Some(1080),
                fps: Some(60.0),
                bitrate_bps: Some(4_000_000),
                audio_bitrate_bps: None,
                content_length: None,
                language: None,
                headers: BTreeMap::new(),
            },
        };

        let stream = resolve_one_pending_format(
            &pending,
            "function player(){}",
            &FakeChallengeSolver,
        )
        .expect("resolved challenge");
        let url = Url::parse(&stream.url).expect("resolved URL");
        let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();

        assert_eq!(query.get("sig").map(String::as_str), Some("terces"));
        assert_eq!(query.get("n").map(String::as_str), Some("ABC"));
        assert_eq!(query.get("x").map(String::as_str), Some("1"));
    }

    #[test]
    fn format_planner_prefers_higher_quality_separate_tracks() {
        let mut extraction = YouTubeExtraction {
            video_id: "dQw4w9WgXcQ".to_owned(),
            descriptor: MediaDescriptor {
                source_kind: MediaSourceKind::Site,
                metadata: MediaMetadata {
                    title: "test".to_owned(),
                    description: None,
                    duration_millis: None,
                    uploader: None,
                    webpage_url: "https://youtube.test/watch".to_owned(),
                    thumbnail_url: None,
                },
                streams: vec![
                    MediaStream {
                        id: "youtube-itag-18".to_owned(),
                        kind: MediaTrackKind::AudioVideo,
                        protocol: MediaProtocol::Https,
                        url: "https://video.test/360.mp4".to_owned(),
                        container: Some("mp4".to_owned()),
                        video_codec: Some("avc1".to_owned()),
                        audio_codec: Some("mp4a".to_owned()),
                        width: Some(640),
                        height: Some(360),
                        fps: Some(30.0),
                        bitrate_bps: Some(600_000),
                        audio_bitrate_bps: Some(96_000),
                        content_length: None,
                        language: None,
                        headers: BTreeMap::new(),
                    },
                    MediaStream {
                        id: "youtube-itag-137".to_owned(),
                        kind: MediaTrackKind::Video,
                        protocol: MediaProtocol::Https,
                        url: "https://video.test/1080.mp4".to_owned(),
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
                        headers: BTreeMap::new(),
                    },
                    MediaStream {
                        id: "youtube-itag-140".to_owned(),
                        kind: MediaTrackKind::Audio,
                        protocol: MediaProtocol::Https,
                        url: "https://video.test/audio.m4a".to_owned(),
                        container: Some("mp4".to_owned()),
                        video_codec: None,
                        audio_codec: Some("mp4a".to_owned()),
                        width: None,
                        height: None,
                        fps: None,
                        bitrate_bps: Some(128_000),
                        audio_bitrate_bps: Some(128_000),
                        content_length: None,
                        language: Some("en".to_owned()),
                        headers: BTreeMap::new(),
                    },
                ],
                subtitles: Vec::new(),
                request_headers: BTreeMap::new(),
                is_live: false,
            },
            pending_formats: Vec::new(),
            player_js_url: None,
            visitor_data: None,
        };

        assert_eq!(
            select_youtube_download_plan(
                &extraction,
                YouTubeSelectionPolicy::default(),
            ),
            Some(YouTubeDownloadPlan::SeparateTracks {
                video_stream_id: "youtube-itag-137".to_owned(),
                audio_stream_id: "youtube-itag-140".to_owned(),
            })
        );

        extraction.pending_formats.push(YouTubePendingFormat {
            itag: Some(137),
            mime_type: None,
            cipher_url: None,
            encrypted_signature: Some("cipher".to_owned()),
            signature_parameter: Some("sig".to_owned()),
            throttling_parameter: None,
            challenge: YouTubeChallengeKind::Signature,
            stream_template: MediaStream {
                id: "youtube-itag-137".to_owned(),
                kind: MediaTrackKind::Video,
                protocol: MediaProtocol::Https,
                url: "https://video.test/1080.mp4".to_owned(),
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
                headers: BTreeMap::new(),
            },
        });

        assert_eq!(
            select_youtube_download_plan(
                &extraction,
                YouTubeSelectionPolicy::default(),
            ),
            Some(YouTubeDownloadPlan::SingleStream {
                stream_id: "youtube-itag-18".to_owned(),
            })
        );
    }

    #[test]
    fn balanced_json_handles_nested_braces_inside_strings() {
        let input = r#"{"a":{"b":"value } still string"},"c":1} trailing"#;
        assert_eq!(
            balanced_json_object(input),
            Some(r#"{"a":{"b":"value } still string"},"c":1}"#)
        );
    }
}
