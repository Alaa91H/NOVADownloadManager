use axum::extract::{Path, State};
use axum::response::{
    sse::{Event, KeepAlive, Sse},
    Json,
};
use axum::routing::{get, post};
use axum::Router;
use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use crate::daemon::curl::{
    create_curl_task as direct_create, delete_task, list_all_tasks, pause_task, resume_task,
};
use crate::daemon::state::SharedState;
use crate::daemon::types::CreateDownloadBody;
use crate::daemon::ytdlp::create_ytdlp_task;

use super::common::*;
use super::engine::extension_capabilities_from_status;

fn now_str_for_events() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub async fn handle_v1_ping(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let status = state.engine_capabilities();
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

pub async fn handle_v1_pair_auto(Json(_body): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let token = format!(
        "nova-local-pair-{}",
        uuid::Uuid::new_v4().to_string().replace('-', "")
    );
    Json(serde_json::json!({
        "ok": true,
        "pairToken": token,
        "autoApproved": true,
        "method": "auto-localhost-runtime-verified",
        "protocolVersion": 4,
        "minimumSupportedProtocolVersion": 4,
        "ttlSeconds": 60 * 60 * 24 * 30
    }))
}

pub async fn handle_v1_auth_check(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let status = state.engine_capabilities();
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
    let status = state.engine_capabilities();
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
        Err(_) => return (true, false),
    };
    let cfg = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v,
        Err(_) => return (true, false),
    };
    let enabled = cfg
        .get("general")
        .and_then(|g| g.get("integrateWithBrowsers"))
        .and_then(|b| b.as_object())
        .map(|m| m.values().any(|v| v.as_bool() == Some(true)))
        .unwrap_or(true);
    let paired = cfg
        .get("extra")
        .and_then(|e| e.get("browserPairingToken"))
        .and_then(|t| t.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    (enabled, paired)
}

pub(super) fn browser_ext_status(enabled: bool, paired: bool) -> &'static str {
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

pub(super) fn task_id_from_json(body: &serde_json::Value) -> Result<String, String> {
    body.get("taskId")
        .or_else(|| body.get("id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .ok_or_else(|| "Missing taskId".to_string())
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
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        loop {
            interval.tick().await;
            let tasks = list_all_tasks(&state).await;
            let payload = serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_string());
            if payload != last_payload {
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
            } else {
                yield Ok::<Event, Infallible>(Event::default().data(serde_json::json!({"type":"heartbeat", "at": now_str_for_events()}).to_string()));
            }
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
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

pub(super) fn map_candidate_file_type(media_type: &str, extension: Option<&str>) -> String {
    match media_type {
        "archive" => "compressed".to_string(),
        "app" => "program".to_string(),
        "document" | "video" | "audio" | "other" => media_type.to_string(),
        "image" => "other".to_string(),
        _ => match extension.unwrap_or("").to_ascii_lowercase().as_str() {
            "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" => "compressed".to_string(),
            "exe" | "msi" | "apk" | "dmg" | "pkg" | "appimage" | "deb" | "rpm" => {
                "program".to_string()
            }
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "epub" => {
                "document".to_string()
            }
            "mp4" | "mkv" | "webm" | "avi" | "mov" | "m4v" | "flv" => "video".to_string(),
            "mp3" | "wav" | "flac" | "m4a" | "ogg" | "opus" | "aac" => "audio".to_string(),
            _ => "other".to_string(),
        },
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
                .to_string(),
        );
    }
    let url = candidate
        .get("finalUrl")
        .or_else(|| candidate.get("url"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Missing candidate URL".to_string())?;
    let is_stream_manifest =
        media_type == "manifest" || source == "hls-manifest" || source == "dash-manifest";
    if is_stream_manifest {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("Only http(s) HLS/DASH manifests can be handed off to yt-dlp.".to_string());
        }
    } else if !(url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("ftp://")
        || url.starts_with("ftps://"))
    {
        return Err(
            "Only http(s)/ftp(s) candidates can be handed off to libcurl multi.".to_string(),
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
        .map(|s| s.to_string());
    if let Some(referrer) = referer.as_deref().filter(|v| !v.trim().is_empty()) {
        direct_options
            .entry("referer".to_string())
            .or_insert_with(|| serde_json::json!(referrer));
    }
    let media_options = if is_stream_manifest {
        let media = crate::daemon::types::MediaDownloadOptions {
            mode: Some("video".to_string()),
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
        url: Some(url.to_string()),
        name: json_str(candidate, "filename").or_else(|| json_str(body, "name")),
        file_type: Some(if is_stream_manifest {
            "video".to_string()
        } else {
            map_candidate_file_type(
                media_type,
                candidate.get("extension").and_then(|v| v.as_str()),
            )
        }),
        size_bytes: candidate
            .get("sizeBytes")
            .and_then(|v| v.as_u64())
            .or_else(|| body.get("sizeBytes").and_then(|v| v.as_u64())),
        category: Some(if is_stream_manifest {
            "video".to_string()
        } else {
            map_candidate_file_type(
                media_type,
                candidate.get("extension").and_then(|v| v.as_str()),
            )
        }),
        queue_id: json_str(body, "queueId"),
        connections: body
            .get("connections")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        resumable: candidate
            .pointer("/headers/acceptRanges")
            .and_then(|v| v.as_str())
            .map(|v| v.eq_ignore_ascii_case("bytes"))
            .or_else(|| body.get("resumable").and_then(|v| v.as_bool())),
        save_path: json_str(body, "savePath"),
        description: json_str(body, "description").or_else(|| {
            Some(if is_stream_manifest {
                "Browser extension HLS/DASH stream via yt-dlp + FFmpeg".to_string()
            } else {
                "Browser extension capture via runtime-verified libcurl multi".to_string()
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
        return Err("Missing url".to_string());
    }
    Ok(CreateDownloadBody {
        url: Some(url.to_string()),
        name: json_str(body, "name"),
        file_type: json_str(body, "fileType"),
        size_bytes: body.get("sizeBytes").and_then(|v| v.as_u64()),
        category: json_str(body, "category"),
        queue_id: json_str(body, "queueId"),
        connections: body
            .get("connections")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        resumable: body.get("resumable").and_then(|v| v.as_bool()),
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

pub async fn handle_v1_add(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let download_body = match legacy_v1_body_to_download_body(&body, true) {
        Ok(v) => v,
        Err(message) => {
            return Json(
                serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": message}),
            );
        }
    };
    if let Some(ref url) = download_body.url {
        if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
            log::warn!("Blocked SSRF in v1/add for {}: {}", url, e);
            return Json(
                serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": e}),
            );
        }
    }
    let result = {
        let extractor = state.extractor_registry.validate(&download_body);
        match extractor {
            Ok(ext) => match ext.id() {
                "yt-dlp" => create_ytdlp_task(&state, &download_body).await,
                _ => direct_create(&state, &download_body).await,
            },
            Err(_) => {
                if download_body.media_options.is_some() {
                    create_ytdlp_task(&state, &download_body).await
                } else {
                    direct_create(&state, &download_body).await
                }
            }
        }
    };
    match result {
        Ok(task) => Json(serde_json::json!({
            "ok": true,
            "accepted": true,
            "taskId": task.id,
            "taskIds": [task.id],
            "message": "Added"
        })),
        Err(e) => {
            log::error!("v1/add failed: {}", e);
            Json(serde_json::json!({
                "ok": false,
                "accepted": false,
                "taskId": "",
                "taskIds": [],
                "message": e
            }))
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
        log::warn!("Blocked stream resolve of unsafe URL {}: {}", url, e);
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": e, "qualities": []}),
        );
    }

    let ytdlp_bin = state.ytdlp_bin.clone();
    let url2 = url.to_string();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            hidden_output(
                &ytdlp_bin,
                &[
                    "--dump-json",
                    "--no-playlist",
                    "--no-warnings",
                    "--skip-download",
                    "--",
                    &url2,
                ],
            )
        }),
    )
    .await;

    let Ok(joined) = output else {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": "Stream resolve timed out", "qualities": []}),
        );
    };
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
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let width = format
                .get("width")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let bandwidth = format
                .get("tbr")
                .and_then(|v| v.as_f64())
                .map(|v| (v * 1000.0).max(0.0) as u64)
                .or_else(|| {
                    format
                        .get("abr")
                        .and_then(|v| v.as_f64())
                        .map(|v| (v * 1000.0).max(0.0) as u64)
                });
            let label = format
                .get("format_note")
                .or_else(|| format.get("resolution"))
                .or_else(|| format.get("format_id"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .or_else(|| height.map(|h| format!("{}p", h)));
            let mut q = serde_json::Map::new();
            q.insert("url".to_string(), serde_json::json!(format_url));
            if let Some(width) = width {
                q.insert("width".to_string(), serde_json::json!(width));
            }
            if let Some(height) = height {
                q.insert("height".to_string(), serde_json::json!(height));
            }
            if let Some(bandwidth) = bandwidth {
                q.insert("bandwidth".to_string(), serde_json::json!(bandwidth));
            }
            if let Some(codecs) = format
                .get("vcodec")
                .or_else(|| format.get("acodec"))
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty() && *v != "none")
            {
                q.insert("codecs".to_string(), serde_json::json!(codecs));
            }
            if let Some(label) = label.filter(|v| !v.is_empty()) {
                q.insert("label".to_string(), serde_json::json!(label));
            }
            if let Some(format_id) = format
                .get("format_id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                q.insert("formatId".to_string(), serde_json::json!(format_id));
            }
            if let Some(container) = format
                .get("ext")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                q.insert("container".to_string(), serde_json::json!(container));
            }
            if let Some(fps) = format
                .get("fps")
                .and_then(|v| v.as_f64())
                .filter(|v| *v > 0.0)
            {
                q.insert("fps".to_string(), serde_json::json!(fps));
            }
            q.insert(
                "hasVideo".to_string(),
                serde_json::json!(format
                    .get("vcodec")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v != "none")),
            );
            q.insert(
                "hasAudio".to_string(),
                serde_json::json!(format
                    .get("acodec")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v != "none")),
            );
            qualities.push(serde_json::Value::Object(q));
        }
    }
    qualities.sort_by(|a, b| {
        let ah = a.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
        let bh = b.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
        bh.cmp(&ah)
    });
    qualities.dedup_by(|a, b| a.get("url") == b.get("url"));

    let mut payload = serde_json::Map::new();
    payload.insert("ok".to_string(), serde_json::json!(true));
    payload.insert("resolved".to_string(), serde_json::json!(true));
    payload.insert("manifestType".to_string(), serde_json::json!(manifest_type));
    payload.insert("qualities".to_string(), serde_json::Value::Array(qualities));
    if let Some(duration) = info
        .get("duration")
        .and_then(|v| v.as_f64())
        .filter(|v| *v >= 0.0)
    {
        payload.insert("durationSec".to_string(), serde_json::json!(duration));
    }
    if let Some(is_live) = info.get("is_live").and_then(|v| v.as_bool()) {
        payload.insert("isLive".to_string(), serde_json::json!(is_live));
    }
    payload.insert("drmProtected".to_string(), serde_json::json!(false));
    payload.insert("subtitleTracks".to_string(), serde_json::json!([]));
    payload.insert("audioTracks".to_string(), serde_json::json!([]));
    if let Some(size) = info
        .get("filesize")
        .or_else(|| info.get("filesize_approx"))
        .and_then(|v| v.as_u64())
    {
        payload.insert("estimatedSizeBytes".to_string(), serde_json::json!(size));
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
        .and_then(|v| v.as_bool())
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
    let url = if !manifest_url.is_empty() {
        manifest_url
    } else {
        selected_url
    };
    if url.is_empty() || url.starts_with('-') {
        return Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": "Invalid stream URL"}),
        );
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked SSRF in stream/add for {}: {}", url, e);
        return Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": e}),
        );
    }
    let mut media_options = crate::daemon::types::MediaDownloadOptions {
        mode: Some("video".to_string()),
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
            .map(|v| v.to_string()),
        ..Default::default()
    };
    if let Some(format_id) = selected
        .and_then(|q| q.get("formatId"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
    {
        media_options.format_selector = Some(format_id.to_string());
    } else if let Some(height) = selected
        .and_then(|q| q.get("height"))
        .and_then(|v| v.as_u64())
    {
        media_options.quality = Some(format!("{}p", height));
        media_options.format_selector = Some(format!(
            "bestvideo[height<={0}]+bestaudio/best[height<={0}]/best",
            height
        ));
    }
    let body = CreateDownloadBody {
        url: Some(url.to_string()),
        name: manifest
            .get("title")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .or_else(|| Some("stream".to_string())),
        file_type: Some("video".to_string()),
        size_bytes: selected
            .and_then(|q| q.get("estimatedSizeBytes"))
            .and_then(|v| v.as_u64()),
        category: Some("video".to_string()),
        queue_id: None,
        connections: Some(1),
        resumable: Some(true),
        save_path: None,
        description: Some("Browser extension HLS/DASH stream via yt-dlp + FFmpeg".to_string()),
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

pub(crate) fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
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
        .route("/v1/task/pause", post(handle_v1_pause_task_body))
        .route("/v1/task/resume", post(handle_v1_resume_task_body))
        .route("/v1/task/cancel", post(handle_v1_cancel_task_body))
        .route("/v1/tasks/{id}/pause", post(handle_v1_pause_task_path))
        .route("/v1/tasks/{id}/resume", post(handle_v1_resume_task_path))
        .route("/v1/tasks/{id}/cancel", post(handle_v1_cancel_task_path))
        .route("/v1/add", post(handle_v1_add))
        .route("/v1/stream/resolve", post(handle_v1_stream_resolve))
        .route("/v1/stream/add", post(handle_v1_stream_add))
}
