use std::collections::BTreeMap;

use nova_download_core::HttpRequestContext;
use nova_media_core::{
    resolve_youtube_pending_formats, select_youtube_download_plan, youtube_video_id,
    ExtractRequest, MediaDescriptor, MediaProtocol, MediaStream, YouTubeDownloadPlan,
    YouTubeExtractor, YouTubePlayerScriptSolver, YouTubeSelectionPolicy,
};
use serde_json::Value;

use crate::daemon::engine::extractor::{EngineStatus, Extractor, ValidateError};
use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, MediaDownloadOptions, Task};

pub struct NativeMediaExtractor;

impl Extractor for NativeMediaExtractor {
    fn id(&self) -> &'static str {
        "nova-media-engine"
    }

    fn can_handle(&self, url: &str, has_media_options: bool) -> bool {
        has_media_options
            && (url.starts_with("http://") || url.starts_with("https://"))
    }

    fn validate(&self, body: &CreateDownloadBody) -> Result<(), ValidateError> {
        let url = body.url.as_deref().unwrap_or("").trim();
        let parsed = url::Url::parse(url)
            .map_err(|_| ValidateError("Invalid media URL".to_owned()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(ValidateError("Native media requires HTTP(S)".to_owned()));
        }

        let options = body
            .media_options
            .as_ref()
            .ok_or_else(|| ValidateError("Missing media options".to_owned()))?;
        validate_native_options(options).map_err(ValidateError)
    }

    fn engine_status(&self, _state: &SharedState) -> EngineStatus {
        EngineStatus {
            id: "nova-media-engine".to_owned(),
            name: "NOVA Media Engine".to_owned(),
            available: true,
            version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            features: vec![
                "native-resolution".to_owned(),
                "native-format-selection".to_owned(),
                "direct-media-handoff".to_owned(),
                "request-context".to_owned(),
            ],
        }
    }
}

#[derive(Debug)]
struct ResolvedDirectMedia {
    url: String,
    title: String,
    container: Option<String>,
    content_length: Option<u64>,
    context: HttpRequestContext,
}

pub async fn create_native_media_task(
    state: &SharedState,
    body: &CreateDownloadBody,
) -> Result<Task, String> {
    let owned = body.clone();
    let resolution = tokio::task::spawn_blocking(move || resolve_native_direct(&owned))
        .await
        .map_err(|error| format!("Native media resolver worker failed: {error}"))?;

    let resolved = match resolution {
        Ok(resolved) => resolved,
        Err(reason) => {
            log::debug!("Native media path deferred to Media Bridge: {reason}");
            return crate::daemon::media_bridge::create_media_bridge_task(state, body).await;
        }
    };

    let mut direct = body.clone();
    direct.url = Some(resolved.url);
    direct.media_options = None;
    if direct.name.as_deref().is_none_or(|name| name.trim().is_empty()) {
        direct.name = Some(resolved.title);
    }
    if direct.file_type.as_deref().is_none_or(|kind| kind.trim().is_empty()) {
        direct.file_type = resolved.container;
    }
    if direct.size_bytes.unwrap_or(0) == 0 {
        direct.size_bytes = resolved.content_length;
    }

    let mut options = direct.direct_options.take().unwrap_or_default();
    if let Some(user_agent) = resolved.context.user_agent {
        options.insert("userAgent".to_owned(), Value::String(user_agent));
    }
    if let Some(referer) = resolved.context.referer {
        direct.referer = Some(referer.clone());
        options.insert("referer".to_owned(), Value::String(referer));
    }
    if let Some(cookies) = resolved.context.cookie_header {
        options.insert("cookies".to_owned(), Value::String(cookies));
    }
    if !resolved.context.headers.is_empty() {
        let headers = resolved
            .context
            .headers
            .into_iter()
            .map(|(name, value)| format!("{name}: {value}"))
            .collect::<Vec<_>>()
            .join("\n");
        options.insert("headers".to_owned(), Value::String(headers));
    }
    direct.direct_options = Some(options);

    log::info!(
        "NOVA Media Engine resolved media to native direct transport: {}",
        direct.url.as_deref().unwrap_or_default()
    );
    crate::daemon::curl::create_curl_task(state, &direct).await
}

fn validate_native_options(options: &MediaDownloadOptions) -> Result<(), String> {
    let mode = options.mode.as_deref().unwrap_or("video").trim().to_ascii_lowercase();
    if !matches!(mode.as_str(), "video" | "best" | "auto") {
        return Err(format!(
            "Native media mode '{mode}' is not migrated yet"
        ));
    }

    if let Some(template) = options.output_template.as_deref().map(str::trim) {
        if !template.is_empty() && template != "%(title)s.%(ext)s" {
            return Err("Custom media output templates are not migrated yet".to_owned());
        }
    }

    if let Some(cookies) = options.cookies.as_deref().map(str::trim) {
        if !cookies.is_empty() && (!cookies.contains('=') || cookies.ends_with(".txt")) {
            return Err("Cookie-file loading is not migrated to the native engine yet".to_owned());
        }
    }

    let serialized = serde_json::to_value(options)
        .map_err(|error| format!("Could not inspect media options: {error}"))?;
    let object = serialized
        .as_object()
        .ok_or_else(|| "Invalid media options".to_owned())?;
    const ALLOWED: &[&str] = &[
        "mode",
        "quality",
        "audioFormat",
        "ffmpegEnabled",
        "ffmpegLocation",
        "bitrate",
        "outputTemplate",
        "cookies",
        "userAgent",
        "referer",
        "headers",
    ];

    for (key, value) in object {
        if option_is_configured(value) && !ALLOWED.contains(&key.as_str()) {
            return Err(format!(
                "Media option '{key}' is not migrated to the native engine yet"
            ));
        }
    }

    Ok(())
}

fn option_is_configured(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.trim().is_empty(),
        Value::Number(value) => value.as_u64().map_or(true, |number| number != 0),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
    }
}

fn resolve_native_direct(body: &CreateDownloadBody) -> Result<ResolvedDirectMedia, String> {
    let request = build_extract_request(body)?;
    let parsed = request.parsed_url().map_err(|error| error.to_string())?;
    let max_height = body
        .media_options
        .as_ref()
        .and_then(|options| options.quality.as_deref())
        .and_then(parse_quality_height);

    if youtube_video_id(&parsed).is_some() {
        let extractor = YouTubeExtractor;
        let mut extraction = extractor
            .extract_native(&request)
            .map_err(|error| error.to_string())?;

        if !extraction.pending_formats.is_empty() {
            if let Ok(context) = request.request_context() {
                let solver = YouTubePlayerScriptSolver;
                let _ = resolve_youtube_pending_formats(&mut extraction, &context, &solver);
            }
        }

        let prefer_separate_tracks = body
            .media_options
            .as_ref()
            .and_then(|options| options.ffmpeg_enabled)
            .unwrap_or(false);
        let plan = select_youtube_download_plan(
            &extraction,
            YouTubeSelectionPolicy {
                max_height,
                prefer_separate_tracks,
            },
        )
        .ok_or_else(|| "No native-ready media stream was found".to_owned())?;

        return match plan {
            YouTubeDownloadPlan::SingleStream { stream_id } => {
                let stream = extraction
                    .descriptor
                    .streams
                    .iter()
                    .find(|stream| stream.id == stream_id)
                    .ok_or_else(|| "Selected native media stream disappeared".to_owned())?;
                resolved_direct_from_descriptor(&extraction.descriptor, stream)
            }
            YouTubeDownloadPlan::SeparateTracks { .. } => {
                Err("Separate-track mux is not migrated to task execution yet".to_owned())
            }
        };
    }

    let registry = nova_media_core::ExtractorRegistry::with_native_defaults();
    let descriptor = registry
        .resolve(&request)
        .map_err(|error| error.to_string())?;
    let stream = descriptor
        .playable_streams()
        .filter(|stream| matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https))
        .max_by_key(|stream| {
            (
                stream.height.unwrap_or(0),
                stream.bitrate_bps.unwrap_or(0),
                stream.content_length.unwrap_or(0),
            )
        })
        .ok_or_else(|| "Native media result requires the stream pipeline".to_owned())?;

    resolved_direct_from_descriptor(&descriptor, stream)
}

fn resolved_direct_from_descriptor(
    descriptor: &MediaDescriptor,
    stream: &MediaStream,
) -> Result<ResolvedDirectMedia, String> {
    if !matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https) {
        return Err("Selected stream requires manifest execution".to_owned());
    }

    let context = descriptor
        .request_context_for_stream(stream)
        .map_err(|error| error.to_string())?;
    Ok(ResolvedDirectMedia {
        url: stream.url.clone(),
        title: descriptor.metadata.title.clone(),
        container: stream.container.clone(),
        content_length: stream.content_length,
        context,
    })
}

fn build_extract_request(body: &CreateDownloadBody) -> Result<ExtractRequest, String> {
    let url = body.url.as_deref().unwrap_or_default().trim();
    if url.is_empty() {
        return Err("Missing media URL".to_owned());
    }

    let mut request = ExtractRequest::new(url);
    if let Some(referer) = body.referer.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        request.headers.insert("Referer".to_owned(), referer.to_owned());
    }

    if let Some(options) = body.media_options.as_ref() {
        if let Some(user_agent) = options
            .user_agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request
                .headers
                .insert("User-Agent".to_owned(), user_agent.to_owned());
        }
        if let Some(referer) = options
            .referer
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request.headers.insert("Referer".to_owned(), referer.to_owned());
        }
        if let Some(cookies) = options
            .cookies
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request.headers.insert("Cookie".to_owned(), cookies.to_owned());
        }
        if let Some(headers) = options
            .headers
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            parse_header_lines(&mut request.headers, headers)?;
        }
    }

    request
        .request_context()
        .map_err(|error| error.to_string())?;
    Ok(request)
}

fn parse_header_lines(
    target: &mut BTreeMap<String, String>,
    headers: &str,
) -> Result<(), String> {
    for line in headers.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| format!("Invalid media header line: {line}"))?;
        if name.trim().is_empty() || value.trim().is_empty() {
            return Err(format!("Invalid media header line: {line}"));
        }
        target.insert(name.trim().to_owned(), value.trim().to_owned());
    }
    Ok(())
}

fn parse_quality_height(value: &str) -> Option<u32> {
    let normalized = value.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "" | "best" | "auto") {
        return None;
    }
    match normalized.as_str() {
        "4k" => Some(2160),
        "2k" => Some(1440),
        _ => normalized
            .trim_end_matches('p')
            .parse::<u32>()
            .ok()
            .filter(|height| *height >= 144),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(url: &str) -> CreateDownloadBody {
        CreateDownloadBody {
            url: Some(url.to_owned()),
            name: None,
            file_type: None,
            size_bytes: None,
            category: None,
            queue_id: None,
            connections: Some(4),
            resumable: Some(true),
            save_path: None,
            description: None,
            referer: None,
            start_immediately: Some(false),
            direct_options: None,
            media_options: Some(MediaDownloadOptions {
                mode: Some("video".to_owned()),
                quality: Some("1080p".to_owned()),
                audio_format: Some("m4a".to_owned()),
                bitrate: Some("320k".to_owned()),
                output_template: Some("%(title)s.%(ext)s".to_owned()),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn standard_video_options_use_native_path() {
        let body = body("https://cdn.test/video.mp4");
        NativeMediaExtractor
            .validate(&body)
            .expect("standard native options");
    }

    #[test]
    fn advanced_media_option_defers_to_bridge() {
        let mut body = body("https://cdn.test/video.mp4");
        body.media_options.as_mut().expect("media").subtitles = Some(true);
        assert!(NativeMediaExtractor.validate(&body).is_err());
    }

    #[test]
    fn generic_direct_media_resolves_without_network_probe() {
        let resolved = resolve_native_direct(&body("https://cdn.test/movie.mp4"))
            .expect("native direct resolution");
        assert_eq!(resolved.url, "https://cdn.test/movie.mp4");
        assert_eq!(resolved.container.as_deref(), Some("mp4"));
    }

    #[test]
    fn parses_common_quality_limits() {
        assert_eq!(parse_quality_height("1080p"), Some(1080));
        assert_eq!(parse_quality_height("4k"), Some(2160));
        assert_eq!(parse_quality_height("best"), None);
    }
}
