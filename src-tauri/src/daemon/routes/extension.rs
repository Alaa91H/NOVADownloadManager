use axum::extract::{connect_info::ConnectInfo, Path, State};
use axum::http::{header::ORIGIN, HeaderMap};
use axum::response::{
    sse::{Event, KeepAlive, Sse},
    Json,
};
use axum::routing::{delete, get, post};
use axum::Router;
use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::daemon::curl::{
    create_curl_task as direct_create, delete_task, get_task, list_all_tasks, pause_task,
    resume_task,
};
use crate::daemon::state::{
    PendingCaptureReview, SharedState, CAPTURE_REVIEW_TTL, MAX_PENDING_CAPTURE_REVIEWS,
};
use crate::daemon::types::{CreateDownloadBody, Task};
use crate::daemon::ytdlp::create_ytdlp_task;

use super::common::hidden_output_timed;
use super::engine::extension_capabilities_from_status;

use serde_json::json;

fn now_str_for_events() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Engine-capability computation probes external tools via subprocesses and
/// can take seconds on a cold cache. Never run it on the async worker —
/// offload to the blocking pool so one cold probe cannot stall every other
/// daemon request (this was a major cause of slow first extension connects).
async fn engine_capabilities_async(state: SharedState) -> std::sync::Arc<serde_json::Value> {
    tokio::task::spawn_blocking(move || state.engine_capabilities())
        .await
        .unwrap_or_else(|_| std::sync::Arc::new(serde_json::json!({"status": "degraded"})))
}

pub async fn handle_v1_ping(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let status = engine_capabilities_async(state).await;
    Json(serde_json::json!({
        "ok": true,
        "app": "NOVA",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": 4,
        "minimumSupportedProtocolVersion": 4,
        "browserIntegrationEnabled": true,
        "status": status.get("status").cloned().unwrap_or_else(|| serde_json::json!("degraded")),
        "capabilities": extension_capabilities_from_status(&status)
    }))
}

fn trusted_auto_pair_caller(headers: &HeaderMap) -> bool {
    let origin = headers.get(ORIGIN).and_then(|value| value.to_str().ok());
    // A browser is required to attach its immutable extension Origin. The
    // native host uses reqwest and has no Origin at all, so require that shape
    // in addition to its marker header; an unrelated extension cannot turn
    // itself into the native host merely by adding an X- header.
    let native_host = origin.is_none()
        && headers
            .get(crate::daemon::NATIVE_HOST_PAIRING_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some(crate::daemon::NATIVE_HOST_PAIRING_VALUE);
    let chromium_extension = origin == Some(crate::daemon::NOVA_CHROMIUM_EXTENSION_ORIGIN);

    native_host || chromium_extension
}

pub async fn handle_v1_pair_auto(
    State(state): State<SharedState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    if addr.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        && addr.ip() != std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
    {
        return Json(serde_json::json!({
            "ok": false,
            "error": "pair-auto is only available from loopback"
        }));
    }
    if !trusted_auto_pair_caller(&headers) {
        // `moz-extension://` origins are intentionally not accepted here: the
        // UUID is profile-specific and cannot provide an allowlist boundary.
        // Firefox receives its token through the registered native host, while
        // Chromium/Edge use NOVA's pinned extension origin.
        return Json(serde_json::json!({
            "ok": false,
            "error": "pair-auto requires the NOVA browser extension or native host"
        }));
    }
    Json(serde_json::json!({
        "ok": true,
        "pairToken": state.api_token,
        "autoApproved": true,
        "method": "origin-or-native-host-verified",
        "protocolVersion": 4,
        "minimumSupportedProtocolVersion": 4,
        "ttlSeconds": 60 * 60 * 24 * 30,
        "warning": "Token is scoped to the local NOVA browser integration. Do not expose it to untrusted code."
    }))
}

#[cfg(test)]
mod auto_pair_tests {
    use super::trusted_auto_pair_caller;
    use axum::http::{header::ORIGIN, HeaderMap, HeaderValue};

    #[test]
    fn accepts_the_pinned_chromium_extension_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            ORIGIN,
            HeaderValue::from_static(crate::daemon::NOVA_CHROMIUM_EXTENSION_ORIGIN),
        );
        assert!(trusted_auto_pair_caller(&headers));
    }

    #[test]
    fn accepts_the_native_host_marker() {
        let mut headers = HeaderMap::new();
        headers.insert(
            crate::daemon::NATIVE_HOST_PAIRING_HEADER,
            HeaderValue::from_static(crate::daemon::NATIVE_HOST_PAIRING_VALUE),
        );
        assert!(trusted_auto_pair_caller(&headers));
    }

    #[test]
    fn rejects_unrelated_extension_origins() {
        let mut headers = HeaderMap::new();
        headers.insert(
            ORIGIN,
            HeaderValue::from_static("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );
        assert!(!trusted_auto_pair_caller(&headers));
    }

    #[test]
    fn rejects_native_marker_when_a_browser_origin_is_present() {
        let mut headers = HeaderMap::new();
        headers.insert(
            ORIGIN,
            HeaderValue::from_static("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );
        headers.insert(
            crate::daemon::NATIVE_HOST_PAIRING_HEADER,
            HeaderValue::from_static(crate::daemon::NATIVE_HOST_PAIRING_VALUE),
        );
        assert!(!trusted_auto_pair_caller(&headers));
    }
}

pub async fn handle_v1_auth_check(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let status = engine_capabilities_async(state).await;
    Json(serde_json::json!({
        "ok": true,
        "protocolVersion": 4,
        "minimumSupportedProtocolVersion": 4,
        "scopes": ["task.add", "task.addBatch", "task.pause", "task.resume", "task.cancel", "events.sse", "settings.snapshot"],
        "capabilities": extension_capabilities_from_status(&status)
    }))
}

pub async fn handle_v1_extension_settings(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let status = engine_capabilities_async(state).await;
    Json(serde_json::json!({
        "ok": true,
        "capabilities": extension_capabilities_from_status(&status),
        "settings": {
            "captureEndpoint": "/captures",
            "directEngine": "libcurl-multi",
            "mediaEngine": "yt-dlp",
            "postProcessor": "ffmpeg",
            "torrentMagnet": false
        }
    }))
}

pub(super) fn read_browser_integration_state(data_dir: &str) -> (bool, bool) {
    let path = std::path::Path::new(data_dir).join("config.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return (false, false),
    };
    let cfg = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v,
        Err(_) => return (true, false),
    };
    let enabled = cfg
        .get("general")
        .and_then(|g| g.get("integrateWithBrowsers"))
        .and_then(|b| b.as_object())
        .map_or(true, |m| m.values().any(|v| v.as_bool() == Some(true)));
    let paired = cfg
        .get("extra")
        .and_then(|e| e.get("browserPairingToken"))
        .and_then(|t| t.as_str())
        .is_some_and(|s| !s.is_empty());
    (enabled, paired)
}

pub(super) const fn browser_ext_status(enabled: bool, paired: bool) -> &'static str {
    if enabled && paired {
        "connected"
    } else if enabled {
        "degraded"
    } else {
        "disconnected"
    }
}

pub(super) fn browser_ext_response(state: &SharedState) -> Json<serde_json::Value> {
    let capabilities = state.engine_capabilities();
    let extension_capabilities = extension_capabilities_from_status(&capabilities);
    let (enabled, paired) = read_browser_integration_state(&state.data_dir);
    let status = browser_ext_status(enabled, paired);
    Json(serde_json::json!({
        "status": status,
        "enabled": enabled,
        "paired": paired,
        "version": env!("CARGO_PKG_VERSION"),
        "captureEndpoint": "/captures",
        "directDownloads": capabilities.get("directReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "mediaDownloads": capabilities.get("mediaReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "postProcessing": capabilities.get("postProcessingReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "directEngine": "libcurl-multi",
        "mediaEngine": "yt-dlp",
        "postProcessor": "ffmpeg",
        "engineCapabilities": capabilities,
        "capabilities": extension_capabilities
    }))
}

pub async fn handle_browser_ext_config(
    State(state): State<SharedState>,
    Json(_body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    browser_ext_response(&state)
}

pub async fn handle_browser_ext_health(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    browser_ext_response(&state)
}

pub async fn handle_v1_list_tasks(State(state): State<SharedState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "tasks": list_all_tasks(&state).await}))
}

pub async fn handle_v1_get_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match get_task(&state, &id) {
        Some(task) => Json(serde_json::json!({"ok": true, "task": task})),
        None => Json(serde_json::json!({"ok": false, "error": "Task not found"})),
    }
}

pub(super) fn task_id_from_json(body: &serde_json::Value) -> Result<String, String> {
    body.get("taskId")
        .or_else(|| body.get("id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(std::borrow::ToOwned::to_owned)
        .ok_or_else(|| "Missing taskId".to_owned())
}

pub async fn handle_v1_pause_task_body(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    match task_id_from_json(&body) {
        Ok(id) => match pause_task(&state, &id).await {
            Ok(task) => {
                Json(serde_json::json!({"ok": true, "taskId": task.id, "message": "Paused"}))
            }
            Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
        },
        Err(error) => Json(serde_json::json!({"ok": false, "message": error})),
    }
}

pub async fn handle_v1_resume_task_body(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    match task_id_from_json(&body) {
        Ok(id) => match resume_task(&state, &id).await {
            Ok(task) => {
                Json(serde_json::json!({"ok": true, "taskId": task.id, "message": "Resumed"}))
            }
            Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
        },
        Err(error) => Json(serde_json::json!({"ok": false, "message": error})),
    }
}

pub async fn handle_v1_cancel_task_body(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    match task_id_from_json(&body) {
        Ok(id) => match delete_task(&state, &id, false).await {
            Ok(()) => {
                Json(serde_json::json!({"ok": true, "taskId": id, "message": "Removed from list"}))
            }
            Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
        },
        Err(error) => Json(serde_json::json!({"ok": false, "message": error})),
    }
}

pub async fn handle_v1_pause_task_path(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match pause_task(&state, &id).await {
        Ok(task) => Json(serde_json::json!({"ok": true, "taskId": task.id, "message": "Paused"})),
        Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
    }
}

pub async fn handle_v1_resume_task_path(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match resume_task(&state, &id).await {
        Ok(task) => Json(serde_json::json!({"ok": true, "taskId": task.id, "message": "Resumed"})),
        Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
    }
}

pub async fn handle_v1_cancel_task_path(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match delete_task(&state, &id, false).await {
        Ok(()) => {
            Json(serde_json::json!({"ok": true, "taskId": id, "message": "Removed from list"}))
        }
        Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
    }
}

pub async fn handle_v1_events(
    State(state): State<SharedState>,
) -> Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        yield Ok::<Event, Infallible>(Event::default().data(serde_json::json!({"type":"connected", "at": now_str_for_events()}).to_string()));
        let mut last_payload = String::new();
        loop {
            let tasks = list_all_tasks(&state).await;
            let payload = serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_owned());
            if payload == last_payload {
                yield Ok::<Event, Infallible>(Event::default().data(serde_json::json!({"type":"heartbeat", "at": now_str_for_events()}).to_string()));
            } else {
                last_payload = payload;
                for task in &tasks {
                    let progress = if task.size_bytes > 0 { (task.downloaded_bytes as f64 / task.size_bytes as f64 * 100.0).clamp(0.0, 100.0) } else { 0.0 };
                    yield Ok::<Event, Infallible>(Event::default().data(serde_json::json!({
                        "type":"task.updated",
                        "taskId": task.id,
                        "status": task.status,
                        "progress": progress
                    }).to_string()));
                }
            }
            // One SSE message is emitted per task per tick, so scale the tick
            // up with the task count to bound aggregate bandwidth (e.g. 1000
            // tasks -> 5s tick instead of 500ms, cutting the rate 10x).
            let tick_ms = (500u64)
                .max(tasks.len() as u64 * 5)
                .min(5000);
            tokio::time::sleep(Duration::from_millis(tick_ms)).await;
        }
    };
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(10))
            .text("keep-alive"),
    )
}

pub(super) fn json_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(std::borrow::ToOwned::to_owned)
        .filter(|s| !s.trim().is_empty())
}

pub(super) fn map_candidate_file_type(media_type: &str, extension: Option<&str>) -> String {
    match media_type {
        "archive" => "compressed".to_owned(),
        "app" => "program".to_owned(),
        "document" | "video" | "audio" | "other" => media_type.to_owned(),
        "image" => "other".to_owned(),
        // For unknown media types, fall back to the unified extension map in
        // utils::file_type_from_extension so every code path classifies files
        // identically.
        _ => crate::daemon::utils::file_type_from_extension(
            extension.unwrap_or("").to_ascii_lowercase().as_str(),
        )
        .to_owned(),
    }
}

pub(super) fn extension_candidate_to_download_body(
    body: &serde_json::Value,
    start_immediately: bool,
) -> Result<CreateDownloadBody, String> {
    let candidate = body.get("candidate").unwrap_or(body);
    let media_type = candidate
        .get("mediaType")
        .and_then(|v| v.as_str())
        .unwrap_or("other");
    let source = candidate
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if matches!(media_type, "torrent" | "magnet") {
        return Err(
            "Torrent and magnet candidates are not supported by the libcurl direct engine."
                .to_owned(),
        );
    }
    let url = candidate
        .get("finalUrl")
        .or_else(|| candidate.get("url"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Missing candidate URL".to_owned())?;
    let is_stream_manifest =
        media_type == "manifest" || source == "hls-manifest" || source == "dash-manifest";
    if is_stream_manifest {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("Only http(s) HLS/DASH manifests can be handed off to yt-dlp.".to_owned());
        }
    } else if !(url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("ftp://")
        || url.starts_with("ftps://"))
    {
        return Err(
            "Only http(s)/ftp(s) candidates can be handed off to libcurl multi.".to_owned(),
        );
    }
    let mut direct_options = body
        .get("directOptions")
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .unwrap_or_default();
    let referer = candidate
        .get("referrer")
        .or_else(|| candidate.get("pageUrl"))
        .and_then(|v| v.as_str())
        .map(std::borrow::ToOwned::to_owned);
    if let Some(referrer) = referer.as_deref().filter(|v| !v.trim().is_empty()) {
        direct_options
            .entry("referer".to_owned())
            .or_insert_with(|| serde_json::json!(referrer));
    }
    let media_options = if is_stream_manifest {
        let media = crate::daemon::types::MediaDownloadOptions {
            mode: Some("video".to_owned()),
            playlist: Some(false),
            ffmpeg_enabled: Some(true),
            embed_metadata: Some(true),
            concurrent_fragments: Some(8),
            retries: Some(5),
            fragment_retries: Some(10),
            referer: referer.clone(),
            ..Default::default()
        };
        Some(media)
    } else {
        None
    };
    Ok(CreateDownloadBody {
        url: Some(url.to_owned()),
        name: json_str(candidate, "filename").or_else(|| json_str(body, "name")),
        file_type: Some(if is_stream_manifest {
            "video".to_owned()
        } else {
            map_candidate_file_type(
                media_type,
                candidate.get("extension").and_then(|v| v.as_str()),
            )
        }),
        size_bytes: candidate
            .get("sizeBytes")
            .and_then(serde_json::Value::as_u64)
            .or_else(|| body.get("sizeBytes").and_then(serde_json::Value::as_u64)),
        category: Some(if is_stream_manifest {
            "video".to_owned()
        } else {
            map_candidate_file_type(
                media_type,
                candidate.get("extension").and_then(|v| v.as_str()),
            )
        }),
        queue_id: json_str(body, "queueId"),
        connections: body
            .get("connections")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v as u32),
        resumable: candidate
            .pointer("/headers/acceptRanges")
            .and_then(|v| v.as_str())
            .map(|v| v.eq_ignore_ascii_case("bytes"))
            .or_else(|| body.get("resumable").and_then(serde_json::Value::as_bool)),
        save_path: json_str(body, "savePath"),
        description: json_str(body, "description").or_else(|| {
            Some(if is_stream_manifest {
                "Browser extension HLS/DASH stream via yt-dlp + FFmpeg".to_owned()
            } else {
                "Browser extension capture via runtime-verified libcurl multi".to_owned()
            })
        }),
        referer,
        start_immediately: Some(start_immediately),
        direct_options: if direct_options.is_empty() || media_options.is_some() {
            None
        } else {
            Some(direct_options)
        },
        media_options,
    })
}

pub(super) fn legacy_v1_body_to_download_body(
    body: &serde_json::Value,
    start_immediately: bool,
) -> Result<CreateDownloadBody, String> {
    if body.get("candidate").is_some() {
        return extension_candidate_to_download_body(body, start_immediately);
    }
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if url.is_empty() {
        return Err("Missing url".to_owned());
    }
    Ok(CreateDownloadBody {
        url: Some(url.to_owned()),
        name: json_str(body, "name"),
        file_type: json_str(body, "fileType"),
        size_bytes: body.get("sizeBytes").and_then(serde_json::Value::as_u64),
        category: json_str(body, "category"),
        queue_id: json_str(body, "queueId"),
        connections: body
            .get("connections")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v as u32),
        resumable: body.get("resumable").and_then(serde_json::Value::as_bool),
        save_path: json_str(body, "savePath"),
        description: json_str(body, "description"),
        referer: json_str(body, "referer"),
        start_immediately: Some(start_immediately),
        direct_options: body
            .get("directOptions")
            .and_then(|v| v.as_object())
            .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        media_options: None,
    })
}

fn capture_review_summary(review: &PendingCaptureReview) -> serde_json::Value {
    serde_json::json!({
        "reviewId": review.id,
        "url": review.download.url,
        "name": review.download.name,
        "fileType": review.download.file_type,
        "sizeBytes": review.download.size_bytes,
        "referer": review.download.referer,
        "createdAt": review.created_at.elapsed().as_secs(),
    })
}

fn prune_capture_reviews(reviews: &mut std::collections::VecDeque<PendingCaptureReview>) {
    reviews.retain(|review| review.created_at.elapsed() < CAPTURE_REVIEW_TTL);
}

/// Store a validated browser candidate until the desktop user explicitly chooses
/// a destination and clicks Queue or Start. This is intentionally separate from
/// the task store: a captured link is not a download task and must not appear in
/// the queue or start any network transfer before consent.
pub(super) fn queue_capture_review(
    state: &SharedState,
    download: CreateDownloadBody,
    idempotency_key: Option<String>,
) -> Result<(String, bool), String> {
    let url = download
        .url
        .as_deref()
        .ok_or_else(|| "Missing candidate URL".to_owned())?;
    crate::daemon::utils::is_safe_target_url(url)
        .map_err(|error| format!("Unsafe browser capture URL: {error}"))?;

    let mut reviews = state
        .capture_reviews
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    prune_capture_reviews(&mut reviews);
    if let Some(key) = idempotency_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
    {
        if let Some(existing) = reviews
            .iter()
            .find(|review| review.idempotency_key.as_deref() == Some(key))
        {
            return Ok((existing.id.clone(), true));
        }
    }
    while reviews.len() >= MAX_PENDING_CAPTURE_REVIEWS {
        reviews.pop_front();
    }
    let review_id = uuid::Uuid::new_v4().to_string();
    reviews.push_back(PendingCaptureReview {
        id: review_id.clone(),
        idempotency_key,
        created_at: std::time::Instant::now(),
        download,
    });
    Ok((review_id, false))
}

async fn create_download_from_body(
    state: &SharedState,
    download_body: &CreateDownloadBody,
) -> Result<Task, String> {
    let url = download_body
        .url
        .as_deref()
        .ok_or_else(|| "Missing candidate URL".to_owned())?;
    crate::daemon::utils::is_safe_target_url(url)?;
    match state.extractor_registry.validate(download_body) {
        Ok(extractor) if extractor.id() == "yt-dlp" => {
            create_ytdlp_task(state, download_body).await
        }
        Ok(_) => direct_create(state, download_body).await,
        Err(_) if download_body.media_options.is_some() => {
            create_ytdlp_task(state, download_body).await
        }
        Err(_) => direct_create(state, download_body).await,
    }
}

fn capture_review_response(review_id: String, duplicate: bool) -> Json<serde_json::Value> {
    // `taskId`/`taskIds` remain populated for protocol-v4 clients that predate
    // reviewId. They identify the accepted handoff request, never a task.
    Json(serde_json::json!({
        "ok": true,
        "accepted": true,
        "reviewId": review_id,
        "taskId": review_id,
        "taskIds": [review_id],
        "duplicate": duplicate,
        "message": "Waiting for approval in NOVA"
    }))
}

pub async fn handle_v1_add(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let download = match legacy_v1_body_to_download_body(&body, true) {
        Ok(value) => value,
        Err(message) => {
            return Json(
                serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": message}),
            );
        }
    };
    match queue_capture_review(
        &state,
        download,
        body.get("idempotencyKey")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
    ) {
        Ok((review_id, duplicate)) => capture_review_response(review_id, duplicate),
        Err(message) => Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": message}),
        ),
    }
}

pub async fn handle_capture_reviews(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let mut reviews = state
        .capture_reviews
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    prune_capture_reviews(&mut reviews);
    let captures: Vec<_> = reviews.iter().map(capture_review_summary).collect();
    Json(serde_json::json!({"ok": true, "reviews": captures}))
}

pub async fn handle_create_capture_review(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let download = match legacy_v1_body_to_download_body(&body, true) {
        Ok(value) => value,
        Err(message) => {
            return Json(serde_json::json!({"ok": false, "accepted": false, "message": message}))
        }
    };
    match queue_capture_review(
        &state,
        download,
        body.get("idempotencyKey")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
    ) {
        Ok((review_id, duplicate)) => capture_review_response(review_id, duplicate),
        Err(message) => {
            Json(serde_json::json!({"ok": false, "accepted": false, "message": message}))
        }
    }
}

pub async fn handle_discard_capture_review(
    State(state): State<SharedState>,
    Path(review_id): Path<String>,
) -> Json<serde_json::Value> {
    let mut reviews = state
        .capture_reviews
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    prune_capture_reviews(&mut reviews);
    let original_len = reviews.len();
    reviews.retain(|review| review.id != review_id);
    Json(serde_json::json!({"ok": true, "discarded": reviews.len() != original_len}))
}

pub async fn handle_consume_capture_review(
    State(state): State<SharedState>,
    Path(review_id): Path<String>,
    Json(mut requested): Json<CreateDownloadBody>,
) -> Json<serde_json::Value> {
    let pending = {
        let mut reviews = state
            .capture_reviews
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        prune_capture_reviews(&mut reviews);
        let Some(position) = reviews.iter().position(|review| review.id == review_id) else {
            return Json(
                serde_json::json!({"ok": false, "accepted": false, "message": "Capture review was not found or has expired."}),
            );
        };
        reviews
            .remove(position)
            .expect("capture review position must remain valid")
    };

    // The original URL stays authoritative. Users can adjust destination and
    // task settings in the dialog, but a post-review request can never replace
    // the URL that was validated during browser capture.
    requested.url = pending.download.url.clone();
    if requested.name.is_none() {
        requested.name = pending.download.name.clone();
    }
    if requested.file_type.is_none() {
        requested.file_type = pending.download.file_type.clone();
    }
    if requested.size_bytes.is_none() {
        requested.size_bytes = pending.download.size_bytes;
    }
    if requested.category.is_none() {
        requested.category = pending.download.category.clone();
    }
    if requested.referer.is_none() {
        requested.referer = pending.download.referer.clone();
    }
    if requested.description.is_none() {
        requested.description = pending.download.description.clone();
    }

    match create_download_from_body(&state, &requested).await {
        Ok(task) => Json(serde_json::json!({
            "ok": true,
            "accepted": true,
            "task": task,
            "taskId": task.id,
            "taskIds": [task.id],
            "message": "Download approved and added"
        })),
        Err(message) => {
            // A transient engine error must not silently discard the user's
            // capture. Reinsert it for retry, while still keeping the queue bounded.
            let mut reviews = state
                .capture_reviews
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            prune_capture_reviews(&mut reviews);
            while reviews.len() >= MAX_PENDING_CAPTURE_REVIEWS {
                reviews.pop_front();
            }
            reviews.push_front(pending);
            Json(serde_json::json!({"ok": false, "accepted": false, "message": message}))
        }
    }
}

pub async fn handle_v1_stream_resolve(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let manifest_type = body
        .get("manifestType")
        .and_then(|v| v.as_str())
        .unwrap_or("hls");
    if url.is_empty() {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": "Missing url", "qualities": []}),
        );
    }
    if url.starts_with('-') {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": "Invalid url", "qualities": []}),
        );
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": "Only http(s) stream manifests are supported", "qualities": []}),
        );
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked stream resolve of unsafe URL {url}: {e}");
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": e, "qualities": []}),
        );
    }

    let ytdlp_bin = state.ytdlp_binary();
    let url2 = url.to_owned();
    let joined = tokio::task::spawn_blocking(move || {
        hidden_output_timed(
            &ytdlp_bin,
            &[
                "--dump-json",
                "--no-playlist",
                "--no-warnings",
                "--skip-download",
                "--",
                &url2,
            ],
            Duration::from_secs(30),
        )
    })
    .await;

    let spawned = match joined {
        Ok(value) => value,
        Err(error) => {
            return Json(
                serde_json::json!({"ok": false, "resolved": false, "message": format!("Stream resolve worker failed: {}", error), "qualities": []}),
            );
        }
    };
    let process_output = match spawned {
        Ok(value) => value,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::TimedOut {
                return Json(
                    serde_json::json!({"ok": false, "resolved": false, "message": "Stream resolve timed out", "qualities": []}),
                );
            }
            return Json(
                serde_json::json!({"ok": false, "resolved": false, "message": format!("yt-dlp failed to start: {}", error), "qualities": []}),
            );
        }
    };
    if !process_output.status.success() {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": String::from_utf8_lossy(&process_output.stderr).lines().next().unwrap_or("yt-dlp could not resolve this stream"), "qualities": []}),
        );
    }
    let stdout = String::from_utf8_lossy(&process_output.stdout);
    let info: serde_json::Value = match serde_json::from_str(&stdout) {
        Ok(value) => value,
        Err(_) => {
            return Json(
                serde_json::json!({"ok": false, "resolved": false, "message": "Could not parse yt-dlp stream metadata", "qualities": []}),
            )
        }
    };
    let mut qualities = Vec::new();
    if let Some(formats) = info.get("formats").and_then(|v| v.as_array()) {
        for format in formats {
            let Some(format_url) = format.get("url").and_then(|v| v.as_str()) else {
                continue;
            };
            let height = format
                .get("height")
                .and_then(serde_json::Value::as_u64)
                .map(|v| v as u32);
            let width = format
                .get("width")
                .and_then(serde_json::Value::as_u64)
                .map(|v| v as u32);
            let bandwidth = format
                .get("tbr")
                .and_then(serde_json::Value::as_f64)
                .map(|v| (v * 1000.0).max(0.0) as u64)
                .or_else(|| {
                    format
                        .get("abr")
                        .and_then(serde_json::Value::as_f64)
                        .map(|v| (v * 1000.0).max(0.0) as u64)
                });
            let label = format
                .get("format_note")
                .or_else(|| format.get("resolution"))
                .or_else(|| format.get("format_id"))
                .and_then(|v| v.as_str())
                .map(std::borrow::ToOwned::to_owned)
                .or_else(|| height.map(|h| format!("{h}p")));
            let mut q = serde_json::Map::new();
            q.insert("url".to_owned(), serde_json::json!(format_url));
            if let Some(width) = width {
                q.insert("width".to_owned(), serde_json::json!(width));
            }
            if let Some(height) = height {
                q.insert("height".to_owned(), serde_json::json!(height));
            }
            if let Some(bandwidth) = bandwidth {
                q.insert("bandwidth".to_owned(), serde_json::json!(bandwidth));
            }
            if let Some(codecs) = format
                .get("vcodec")
                .or_else(|| format.get("acodec"))
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty() && *v != "none")
            {
                q.insert("codecs".to_owned(), serde_json::json!(codecs));
            }
            if let Some(label) = label.filter(|v| !v.is_empty()) {
                q.insert("label".to_owned(), serde_json::json!(label));
            }
            if let Some(format_id) = format
                .get("format_id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                q.insert("formatId".to_owned(), serde_json::json!(format_id));
            }
            if let Some(container) = format
                .get("ext")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                q.insert("container".to_owned(), serde_json::json!(container));
            }
            if let Some(fps) = format
                .get("fps")
                .and_then(serde_json::Value::as_f64)
                .filter(|v| *v > 0.0)
            {
                q.insert("fps".to_owned(), serde_json::json!(fps));
            }
            q.insert(
                "hasVideo".to_owned(),
                serde_json::json!(format
                    .get("vcodec")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v != "none")),
            );
            q.insert(
                "hasAudio".to_owned(),
                serde_json::json!(format
                    .get("acodec")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v != "none")),
            );
            qualities.push(serde_json::Value::Object(q));
        }
    }
    qualities.sort_by(|a, b| {
        let ah = a
            .get("height")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let bh = b
            .get("height")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        bh.cmp(&ah)
    });
    qualities.dedup_by(|a, b| a.get("url") == b.get("url"));

    let mut payload = serde_json::Map::new();
    payload.insert("ok".to_owned(), serde_json::json!(true));
    payload.insert("resolved".to_owned(), serde_json::json!(true));
    payload.insert("manifestType".to_owned(), serde_json::json!(manifest_type));
    payload.insert("qualities".to_owned(), serde_json::Value::Array(qualities));
    if let Some(duration) = info
        .get("duration")
        .and_then(serde_json::Value::as_f64)
        .filter(|v| *v >= 0.0)
    {
        payload.insert("durationSec".to_owned(), serde_json::json!(duration));
    }
    if let Some(is_live) = info.get("is_live").and_then(serde_json::Value::as_bool) {
        payload.insert("isLive".to_owned(), serde_json::json!(is_live));
    }
    payload.insert("drmProtected".to_owned(), serde_json::json!(false));
    payload.insert("subtitleTracks".to_owned(), serde_json::json!([]));
    payload.insert("audioTracks".to_owned(), serde_json::json!([]));
    if let Some(size) = info
        .get("filesize")
        .or_else(|| info.get("filesize_approx"))
        .and_then(serde_json::Value::as_u64)
    {
        payload.insert("estimatedSizeBytes".to_owned(), serde_json::json!(size));
    }
    Json(serde_json::Value::Object(payload))
}

pub async fn handle_v1_stream_add(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let manifest = body.get("manifest").unwrap_or(&body);
    if manifest
        .get("drmProtected")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": "DRM-protected streams cannot be downloaded."}),
        );
    }
    let selected = body.get("selectedQuality");
    let manifest_url = manifest
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let selected_url = selected
        .and_then(|q| q.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let url = if manifest_url.is_empty() {
        selected_url
    } else {
        manifest_url
    };
    if url.is_empty() || url.starts_with('-') {
        return Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": "Invalid stream URL"}),
        );
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked SSRF in stream/add for {url}: {e}");
        return Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": e}),
        );
    }
    let mut media_options = crate::daemon::types::MediaDownloadOptions {
        mode: Some("video".to_owned()),
        playlist: Some(false),
        ffmpeg_enabled: Some(true),
        embed_metadata: Some(true),
        concurrent_fragments: Some(8),
        retries: Some(5),
        fragment_retries: Some(10),
        referer: manifest
            .get("referrer")
            .or_else(|| manifest.get("pageUrl"))
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned),
        ..Default::default()
    };
    if let Some(format_id) = selected
        .and_then(|q| q.get("formatId"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
    {
        media_options.format_selector = Some(format_id.to_owned());
    } else if let Some(height) = selected
        .and_then(|q| q.get("height"))
        .and_then(serde_json::Value::as_u64)
    {
        media_options.quality = Some(format!("{height}p"));
        media_options.format_selector = Some(format!(
            "bestvideo[height<={height}]+bestaudio/best[height<={height}]/best"
        ));
    }
    let body = CreateDownloadBody {
        url: Some(url.to_owned()),
        name: manifest
            .get("title")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned)
            .or_else(|| Some("stream".to_owned())),
        file_type: Some("video".to_owned()),
        size_bytes: selected
            .and_then(|q| q.get("estimatedSizeBytes"))
            .and_then(serde_json::Value::as_u64),
        category: Some("video".to_owned()),
        queue_id: None,
        connections: Some(1),
        resumable: Some(true),
        save_path: None,
        description: Some("Browser extension HLS/DASH stream via yt-dlp + FFmpeg".to_owned()),
        referer: media_options.referer.clone(),
        start_immediately: Some(true),
        direct_options: None,
        media_options: Some(media_options),
    };
    match create_ytdlp_task(&state, &body).await {
        Ok(task) => Json(
            serde_json::json!({"ok": true, "accepted": true, "taskId": task.id, "taskIds": [task.id], "message": "Stream added"}),
        ),
        Err(error) => Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": error}),
        ),
    }
}

// ── Unified media analysis: /v1/analyze ────────────────────────────────
//
// The extension sends a URL plus optional context. The daemon runs:
//   1. HTTP HEAD probe (size, type, range support)
//   2. yt-dlp probe (full format catalog, title, duration)
//   3. RIE analysis (strategy, retry, connections)
// and returns a unified analysis result with all the data the extension
// needs to present a rich format catalog to the user.

pub async fn handle_v1_analyze(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    if url.is_empty() {
        return Json(serde_json::json!({"ok": false, "stage": "init", "message": "Missing url"}));
    }
    if url.starts_with('-') {
        return Json(serde_json::json!({"ok": false, "stage": "init", "message": "Invalid url"}));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Json(
            serde_json::json!({"ok": false, "stage": "init", "message": "Only http(s) URLs are supported for analysis"}),
        );
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(&url) {
        log::warn!("Blocked SSRF in v1/analyze for {url}: {e}");
        return Json(serde_json::json!({"ok": false, "stage": "init", "message": e}));
    }

    let context = body.get("context").cloned().unwrap_or_else(|| json!({}));

    // Stage 1: use the same staged HTTP probe as direct downloads. A bare
    // HEAD request cannot resolve many production links (range-only servers,
    // meta-refresh interstitials, SourceForge/GitHub-style pages) and loses
    // the browser referer needed by hotlink-protected hosts.
    let http_meta = http_probe_for_analyze(&state, &url, &context).await;

    // Stage 2: yt-dlp probe (for video/audio URLs)
    let ytdlp_result = ytdlp_probe_for_analyze(&state, &url).await;

    // Build format catalog
    let mut formats: Vec<serde_json::Value> = Vec::new();
    let mut title: Option<String> = None;
    let mut duration_sec: Option<f64> = None;
    let mut thumbnail: Option<String> = None;
    let mut is_live = false;
    let mut drm_protected = false;

    if let Some(ref info) = ytdlp_result {
        title = info
            .get("title")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned);
        duration_sec = info.get("duration").and_then(serde_json::Value::as_f64);
        thumbnail = info
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(std::borrow::ToOwned::to_owned);
        is_live = info
            .get("is_live")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        drm_protected = info
            .get("drm_protected")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if let Some(yt_formats) = info.get("formats").and_then(|v| v.as_array()) {
            for fmt in yt_formats {
                let fmt_url = match fmt.get("url").and_then(|v| v.as_str()) {
                    Some(u) => u,
                    None => continue,
                };
                let height = fmt
                    .get("height")
                    .and_then(serde_json::Value::as_u64)
                    .map(|v| v as u32);
                let width = fmt
                    .get("width")
                    .and_then(serde_json::Value::as_u64)
                    .map(|v| v as u32);
                let bandwidth = fmt
                    .get("tbr")
                    .and_then(serde_json::Value::as_f64)
                    .map(|v| (v * 1000.0).max(0.0) as u64)
                    .or_else(|| {
                        fmt.get("abr")
                            .and_then(serde_json::Value::as_f64)
                            .map(|v| (v * 1000.0).max(0.0) as u64)
                    });
                let label = fmt
                    .get("format_note")
                    .or_else(|| fmt.get("resolution"))
                    .or_else(|| fmt.get("format_id"))
                    .and_then(|v| v.as_str())
                    .map(std::borrow::ToOwned::to_owned)
                    .or_else(|| height.map(|h| format!("{h}p")));
                let has_video = fmt
                    .get("vcodec")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v != "none");
                let has_audio = fmt
                    .get("acodec")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v != "none");
                let estimated_size = fmt
                    .get("filesize")
                    .or_else(|| fmt.get("filesize_approx"))
                    .and_then(serde_json::Value::as_u64);

                formats.push(json!({
                    "url": fmt_url,
                    "formatId": fmt.get("format_id").and_then(|v| v.as_str()).unwrap_or(""),
                    "label": label.unwrap_or_default(),
                    "width": width,
                    "height": height,
                    "bandwidth": bandwidth,
                    "codecs": fmt.get("vcodec").or_else(|| fmt.get("acodec")).and_then(|v| v.as_str()).filter(|v| !v.is_empty() && *v != "none").unwrap_or(""),
                    "container": fmt.get("ext").and_then(|v| v.as_str()).unwrap_or(""),
                    "fps": fmt.get("fps").and_then(serde_json::Value::as_f64).filter(|v| *v > 0.0),
                    "hasVideo": has_video,
                    "hasAudio": has_audio,
                    "estimatedSizeBytes": estimated_size,
                    "tbr": fmt.get("tbr").and_then(serde_json::Value::as_f64),
                    "vbr": fmt.get("vbr").and_then(serde_json::Value::as_f64),
                    "abr": fmt.get("abr").and_then(serde_json::Value::as_f64),
                }));
            }
        }
    }

    // If no yt-dlp formats but HTTP probe found something, add a single entry
    if formats.is_empty() {
        if let Some(ref meta) = http_meta {
            let content_type = meta
                .get("contentType")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let size = meta.get("sizeBytes").and_then(serde_json::Value::as_u64);
            formats.push(json!({
                "url": &url,
                "formatId": "direct",
                "label": "Direct download",
                "container": content_type_to_ext(content_type),
                "hasVideo": content_type.starts_with("video/"),
                "hasAudio": content_type.starts_with("audio/"),
                "estimatedSizeBytes": size,
                "bandwidth": None::<u64>,
            }));
        }
    }

    // Sort formats: video by height desc, audio by bandwidth desc
    formats.sort_by(|a, b| {
        let a_h = a
            .get("height")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let b_h = b
            .get("height")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let a_bw = a
            .get("bandwidth")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let b_bw = b
            .get("bandwidth")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if a_h != b_h {
            return b_h.cmp(&a_h);
        }
        b_bw.cmp(&a_bw)
    });
    formats.dedup_by(|a, b| a.get("url") == b.get("url"));

    // Detect media type from HTTP probe + format analysis
    let detected_type = if !formats.is_empty() {
        let has_video = formats.iter().any(|f| {
            f.get("hasVideo")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        });
        let has_audio = formats.iter().any(|f| {
            f.get("hasAudio")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        });
        if has_video {
            "video"
        } else if has_audio {
            "audio"
        } else {
            "other"
        }
    } else if let Some(ref meta) = http_meta {
        let ct = meta
            .get("contentType")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if ct.starts_with("video/") {
            "video"
        } else if ct.starts_with("audio/") {
            "audio"
        } else if ct.starts_with("image/") {
            "image"
        } else {
            "other"
        }
    } else {
        "other"
    };

    let mut result = serde_json::Map::new();
    result.insert("ok".to_owned(), json!(true));
    result.insert("stage".to_owned(), json!("complete"));
    result.insert("url".to_owned(), json!(url));
    result.insert("title".to_owned(), json!(title));
    result.insert("durationSec".to_owned(), json!(duration_sec));
    result.insert("thumbnail".to_owned(), json!(thumbnail));
    result.insert("isLive".to_owned(), json!(is_live));
    result.insert("drmProtected".to_owned(), json!(drm_protected));
    result.insert("detectedType".to_owned(), json!(detected_type));
    result.insert("formats".to_owned(), json!(formats));

    // Include HTTP probe metadata if available
    if let Some(ref meta) = http_meta {
        result.insert("httpProbe".to_owned(), meta.clone());
    }

    Json(serde_json::Value::Object(result))
}

// ── Streaming analysis progress: /v1/analyze/progress ──────────────────
//
// Same as /v1/analyze but returns SSE events for each stage so the
// extension can show a live progress indicator.

/// Guard that cancels a `CancellationToken` on drop. Placed inside the SSE
/// stream so that when the client disconnects (and the stream is dropped),
/// any in-flight probe work is cancelled promptly rather than running until
/// its own timeout elapses.
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub async fn handle_v1_analyze_progress(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>> {
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    let _context = body.get("context").cloned().unwrap_or_else(|| json!({}));
    let cancel = CancellationToken::new();

    let stream = async_stream::stream! {
        // When the stream is dropped (client disconnect), the guard drops and
        // cancels the token, which causes any in-flight `tokio::select!` that
        // races against `cancel.cancelled()` to abort immediately.
        let _guard = CancelOnDrop(cancel.clone());

        macro_rules! yield_event {
            ($data:expr) => {
                if let Ok(event) = Event::default().json_data($data) {
                    yield Ok::<Event, Infallible>(event);
                } else {
                    log::error!("SSE: failed to serialize event data");
                }
            };
        }

        if url.is_empty() || url.starts_with('-') || !(url.starts_with("http://") || url.starts_with("https://")) {
            yield_event!(json!({"stage": "error", "message": "Invalid url"}));
            return;
        }
        if let Err(e) = crate::daemon::utils::is_safe_target_url(&url) {
            yield_event!(json!({"stage": "error", "message": e}));
            return;
        }

        yield_event!(json!({"stage": "http.probing", "url": &url}));

        let http_meta = tokio::select! {
            result = http_probe_for_analyze(&state, &url, &_context) => result,
            () = cancel.cancelled() => None,
        };
        if let Some(ref meta) = http_meta {
            yield_event!(json!({"stage": "http.done", "meta": meta}));
        }

        if cancel.is_cancelled() {
            return;
        }

        yield_event!(json!({"stage": "ytdlp.probing", "url": &url}));

        let ytdlp_result = tokio::select! {
            result = ytdlp_probe_for_analyze(&state, &url) => result,
            () = cancel.cancelled() => None,
        };
        if let Some(ref info) = ytdlp_result {
            let format_count = info.get("formats").and_then(|v| v.as_array()).map_or(0, std::vec::Vec::len);
            yield_event!(json!({"stage": "ytdlp.done", "formatCount": format_count, "title": info.get("title")}));
        } else {
            yield_event!(json!({"stage": "ytdlp.done", "formatCount": 0}));
        }

        if cancel.is_cancelled() {
            return;
        }

        yield_event!(json!({"stage": "complete", "url": &url, "hint": "Fetch full result via /v1/analyze"}));
    };

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

fn analyze_probe_body(url: &str, context: &serde_json::Value) -> CreateDownloadBody {
    let referer = context
        .get("referrer")
        .or_else(|| context.get("pageUrl"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    CreateDownloadBody {
        url: Some(url.to_owned()),
        name: None,
        file_type: None,
        size_bytes: None,
        category: None,
        queue_id: None,
        connections: None,
        resumable: None,
        save_path: None,
        description: None,
        referer,
        start_immediately: Some(false),
        direct_options: None,
        media_options: None,
    }
}

async fn http_probe_for_analyze(
    state: &SharedState,
    url: &str,
    context: &serde_json::Value,
) -> Option<serde_json::Value> {
    let probe_body = analyze_probe_body(url, context);
    match super::probes::probe_url_with_options(state, url, Some(&probe_body)).await {
        Ok(Json(payload)) => Some(payload),
        Err((status, Json(error))) => {
            log::debug!(
                "extension analyze HTTP probe failed for {url}: status={status} error={error}"
            );
            None
        }
    }
}

async fn ytdlp_probe_for_analyze(state: &SharedState, url: &str) -> Option<serde_json::Value> {
    let ytdlp_bin = state.ytdlp_binary();
    let url2 = url.to_owned();
    let output = tokio::task::spawn_blocking(move || {
        hidden_output_timed(
            &ytdlp_bin,
            &[
                "--dump-json",
                "--no-playlist",
                "--no-warnings",
                "--skip-download",
                "--",
                &url2,
            ],
            Duration::from_secs(30),
        )
    })
    .await;

    // spawn_blocking -> io::Result<Output>; timeouts surface as Err(TimedOut).
    let io_result = output.ok()?;
    let process_output = io_result.ok()?;
    if !process_output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&process_output.stdout);
    if stdout.len() > 1_048_576 {
        log::warn!(
            "yt-dlp output exceeded 1 MB size limit ({} bytes)",
            stdout.len()
        );
        return None;
    }
    serde_json::from_str(&stdout).ok()
}

fn content_type_to_ext(content_type: &str) -> &str {
    let ct = content_type.split(';').next().unwrap_or("").trim();
    match ct {
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "video/x-flv" => "flv",
        "video/quicktime" => "mov",
        "video/x-msvideo" => "avi",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/mp4" => "m4a",
        "audio/wav" => "wav",
        "audio/webm" => "webm",
        "application/zip" => "zip",
        "application/pdf" => "pdf",
        _ => {
            if ct.starts_with("video/") {
                "mp4"
            } else if ct.starts_with("audio/") {
                "mp3"
            } else {
                "bin"
            }
        }
    }
}

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route(
            "/api/browser-extension/config",
            post(handle_browser_ext_config),
        )
        .route(
            "/api/browser-extension/health",
            get(handle_browser_ext_health),
        )
        .route("/v1/ping", get(handle_v1_ping))
        .route("/v1/pair/auto", post(handle_v1_pair_auto))
        .route("/v1/auth/check", post(handle_v1_auth_check))
        .route("/v1/extension-settings", get(handle_v1_extension_settings))
        .route("/v1/events", get(handle_v1_events))
        .route("/v1/tasks", get(handle_v1_list_tasks))
        .route("/v1/tasks/{id}", get(handle_v1_get_task))
        .route("/v1/task/pause", post(handle_v1_pause_task_body))
        .route("/v1/task/resume", post(handle_v1_resume_task_body))
        .route("/v1/task/cancel", post(handle_v1_cancel_task_body))
        .route("/v1/tasks/{id}/pause", post(handle_v1_pause_task_path))
        .route("/v1/tasks/{id}/resume", post(handle_v1_resume_task_path))
        .route("/v1/tasks/{id}/cancel", post(handle_v1_cancel_task_path))
        .route("/v1/add", post(handle_v1_add))
        .route(
            "/v1/capture-reviews",
            get(handle_capture_reviews).post(handle_create_capture_review),
        )
        .route(
            "/v1/capture-reviews/{id}",
            delete(handle_discard_capture_review),
        )
        .route(
            "/v1/capture-reviews/{id}/consume",
            post(handle_consume_capture_review),
        )
        .route("/v1/stream/resolve", post(handle_v1_stream_resolve))
        .route("/v1/stream/add", post(handle_v1_stream_add))
        .route("/v1/analyze", post(handle_v1_analyze))
        .route("/v1/analyze/progress", post(handle_v1_analyze_progress))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Path, State};
    use axum::Json;
    use std::sync::Arc;

    fn pending_capture_body(url: &str) -> CreateDownloadBody {
        CreateDownloadBody {
            url: Some(url.to_owned()),
            name: Some("captured-file.zip".to_owned()),
            file_type: Some("compressed".to_owned()),
            size_bytes: Some(42),
            category: Some("compressed".to_owned()),
            queue_id: Some("main".to_owned()),
            connections: Some(4),
            resumable: Some(true),
            save_path: Some("/tmp/NOVA/captured-file.zip".to_owned()),
            description: Some("browser capture".to_owned()),
            referer: Some("https://page.example.test/download".to_owned()),
            start_immediately: Some(false),
            direct_options: None,
            media_options: None,
        }
    }

    fn review_test_state() -> SharedState {
        let path =
            std::env::temp_dir().join(format!("nova-capture-review-{}", uuid::Uuid::new_v4()));
        Arc::new(crate::daemon::persist::tests::test_state(
            &path.display().to_string(),
        ))
    }

    #[tokio::test]
    async fn capture_is_not_a_task_until_the_desktop_approves_it() {
        let state = review_test_state();
        let original_url = "https://example.com/captured-file.zip";
        let (review_id, duplicate) = queue_capture_review(
            &state,
            pending_capture_body(original_url),
            Some("capture-review-test-key".to_owned()),
        )
        .expect("queue capture review");
        assert!(!duplicate);
        assert!(state
            .task_snapshot
            .lock()
            .expect("task snapshot")
            .is_empty());

        let Json(listed) = handle_capture_reviews(State(state.clone())).await;
        assert_eq!(listed["reviews"].as_array().map(Vec::len), Some(1));
        assert_eq!(listed["reviews"][0]["reviewId"], review_id);
        assert_eq!(listed["reviews"][0]["url"], original_url);

        // An attempted URL replacement must be ignored: the capture-time URL is
        // authoritative, while the dialog may still adjust its file name/path.
        let mut approved = pending_capture_body("https://example.org/replaced.zip");
        approved.name = Some("approved-name.zip".to_owned());
        let Json(result) =
            handle_consume_capture_review(State(state.clone()), Path(review_id), Json(approved))
                .await;
        assert_eq!(result["ok"], true);
        assert_eq!(result["accepted"], true);
        let tasks = state.task_snapshot.lock().expect("task snapshot");
        assert_eq!(tasks.len(), 1);
        assert_eq!(
            tasks.values().next().expect("created task").url,
            original_url
        );
        drop(tasks);
        assert!(state
            .capture_reviews
            .lock()
            .expect("review queue")
            .is_empty());
    }

    #[test]
    fn analyze_probe_body_preserves_explicit_referrer_then_page_url() {
        let url = "https://cdn.example.test/file.zip";
        let with_referrer = analyze_probe_body(
            url,
            &serde_json::json!({
                "pageUrl": "https://page.example.test/download",
                "referrer": "https://referrer.example.test/source"
            }),
        );
        assert_eq!(
            with_referrer.referer.as_deref(),
            Some("https://referrer.example.test/source")
        );

        let with_page_url = analyze_probe_body(
            url,
            &serde_json::json!({"pageUrl": "https://page.example.test/download"}),
        );
        assert_eq!(
            with_page_url.referer.as_deref(),
            Some("https://page.example.test/download")
        );
    }
}
