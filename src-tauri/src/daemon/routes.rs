use std::collections::HashMap;
use std::convert::Infallible;
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;
use std::time::Duration;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{
    sse::{Event, KeepAlive, Sse},
    Json,
};
use serde_json;

static YTDLP_VERSION: OnceLock<String> = OnceLock::new();

use crate::daemon::aria2::{aria2_rpc, create_aria2_task as aria2_create, ensure_aria2, list_all_tasks, pause_task, resume_task, delete_task};
use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, Task, TorrentBody, TorrentConfigBody};
use crate::daemon::utils::{hide_command_window, infer_file_type};
use crate::daemon::ytdlp::create_ytdlp_task;
use crate::daemon::telegram::telegram_notify;

fn command_available(command: &str) -> bool {
    if std::path::Path::new(command).exists() {
        return true;
    }

    let mut cmd = hidden_command(command);
    cmd.arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn hidden_command(command: &str) -> Command {
    let mut cmd = Command::new(command);
    hide_command_window(&mut cmd);
    cmd.stdin(Stdio::null());
    cmd
}

fn hidden_output(command: &str, args: &[&str]) -> std::io::Result<Output> {
    let mut cmd = hidden_command(command);
    cmd.args(args).output()
}

pub async fn handle_health(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let aria2_ready = tokio::time::timeout(
        Duration::from_millis(1000),
        aria2_rpc(&state, "getVersion", vec![]),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .is_some();
    let aria2_available = command_available(&state.aria2_bin);
    let ytdlp_available = command_available(&state.ytdlp_bin);
    let ytdlp_bin = state.ytdlp_bin.clone();
    let ytdlp_version = YTDLP_VERSION.get_or_init(|| {
        if !ytdlp_available {
            return "unknown".to_string();
        }
        hidden_output(&ytdlp_bin, &["--version"])
            .ok()
            .and_then(|o| if o.status.success() { String::from_utf8(o.stdout).ok() } else { None })
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }).clone();
    let service_status = if aria2_available && aria2_ready {
        "connected"
    } else {
        "degraded"
    };
    if !aria2_ready && aria2_available {
        // Self-heal: kick a background relaunch. The single-flight guard in
        // ensure_aria2 keeps repeated health polls from stacking restarts.
        let heal_state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = ensure_aria2(&heal_state).await {
                log::warn!("aria2 self-heal failed: {}", e);
            }
        });
    }
    Json(serde_json::json!({
        "status": service_status,
        "name": "NOVA Daemon",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "engines": {
            "aria2": {
                "available": aria2_available,
                "rpcReady": aria2_ready,
                "rpcPort": state.aria2_rpc_port.load(std::sync::atomic::Ordering::Relaxed),
                "version": env!("CARGO_PKG_VERSION"),
            },
            "ytdlp": {
                "available": ytdlp_available,
                "version": ytdlp_version,
            }
        }
    }))
}

pub async fn handle_list_downloads(State(state): State<SharedState>) -> Json<Vec<Task>> {
    Json(list_all_tasks(&state).await)
}

pub async fn handle_download_events(
    State(state): State<SharedState>,
) -> Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        let mut last_payload = String::new();
        let mut interval = tokio::time::interval(Duration::from_millis(750));

        loop {
            interval.tick().await;
            let tasks = list_all_tasks(&state).await;
            let payload = serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_string());
            if payload != last_payload {
                last_payload = payload.clone();
                yield Ok::<Event, Infallible>(Event::default().event("downloads").data(payload));
            }
        }
    };

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(10))
            .text("keep-alive"),
    )
}

pub async fn handle_create_download(
    State(state): State<SharedState>,
    Json(body): Json<CreateDownloadBody>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    let url = body.url.as_deref().unwrap_or("");
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing url"}))));
    }

    let result = if body.media_options.is_some() {
        create_ytdlp_task(&state, &body).await
    } else {
        aria2_create(&state, &body).await
    };

    match result {
        Ok(task) => {
            telegram_notify(&state, &format!("Download started: {}", task.name)).await;
            Ok(Json(task))
        }
        Err(e) => {
            log::error!("Create download failed: {}", e);
            Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Internal error"}))))
        }
    }
}

pub async fn handle_pause_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    pause_task(&state, &id).await
        .map(Json)
        .map_err(|e| {
            log::error!("Pause task failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Internal error"})))
        })
}

pub async fn handle_resume_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    resume_task(&state, &id).await
        .map(Json)
        .map_err(|e| {
            log::error!("Resume task failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Internal error"})))
        })
}

pub async fn handle_delete_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    delete_task(&state, &id).await
        .map(|_| Json(serde_json::json!({"ok": true})))
        .map_err(|e| {
            log::error!("Delete task failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Internal error"})))
        })
}

pub async fn handle_add_torrent(
    State(state): State<SharedState>,
    Json(body): Json<TorrentBody>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    match aria2_create(&state, &CreateDownloadBody {
        url: body.magnet.clone().or(Some("".to_string())),
        name: body.name.clone(),
        file_type: None,
        size_bytes: None,
        category: None,
        queue_id: None,
        connections: None,
        resumable: None,
        save_path: body.save_path.clone(),
        description: None,
        referer: None,
        start_immediately: Some(true),
        direct_options: None,
        media_options: None,
    }).await {
        Ok(task) => {
            telegram_notify(&state, &format!("Torrent added: {}", task.name)).await;
            Ok(Json(task))
        }
        Err(e) => {
            log::error!("Add torrent failed: {}", e);
            Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Internal error"}))))
        }
    }
}

fn save_torrent_config(state: &SharedState) {
    if let Ok(tc) = state.torrent_config.lock() {
        let path = std::path::Path::new(&state.data_dir).join("torrent-config.json");
        let tmp = path.with_extension("json.tmp");
        if let Ok(payload) = serde_json::to_string(&*tc) {
            let _ = std::fs::write(&tmp, &payload);
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

pub fn load_initial_torrent_config(data_dir: &str) -> TorrentConfigBody {
    let path = std::path::Path::new(data_dir).join("torrent-config.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        TorrentConfigBody {
            dht: Some(true),
            pex: Some(true),
            encryption: Some(true),
            listen_port: Some(6881),
            max_peers: Some(100),
            seeding: Some(true),
            ratio_limit: Some(2.0),
            upload_speed: Some(0),
        }
    }
}

pub async fn handle_torrent_config(
    State(state): State<SharedState>,
    Json(body): Json<TorrentConfigBody>,
) -> Json<serde_json::Value> {
    {
        if let Ok(mut tc) = state.torrent_config.lock() {
            if let Some(v) = body.dht { tc.dht = Some(v); }
            if let Some(v) = body.pex { tc.pex = Some(v); }
            if let Some(v) = body.encryption { tc.encryption = Some(v); }
            if let Some(v) = body.listen_port { tc.listen_port = Some(v); }
            if let Some(v) = body.max_peers { tc.max_peers = Some(v); }
            if let Some(v) = body.seeding { tc.seeding = Some(v); }
            if let Some(v) = body.ratio_limit { tc.ratio_limit = Some(v); }
            if let Some(v) = body.upload_speed { tc.upload_speed = Some(v); }
        }
    }
    save_torrent_config(&state);
    Json(serde_json::json!({"ok": true, "saved": true}))
}

pub async fn handle_probe(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map(|s| s.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing url"}))));
    }

    if let Ok(resp) = state.http_client.head(url).timeout(Duration::from_secs(5)).send().await {
        let content_type = resp.headers().get("content-type")
            .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let content_length = resp.headers().get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        let file_name = url.rsplit('/').next().unwrap_or("download").to_string();
        let cd = resp.headers().get("content-disposition")
            .and_then(|v| v.to_str().ok());
        let cd_name = cd.and_then(|s| {
            s.split("filename=").nth(1)
                .map(|s| s.trim_matches('"').trim().to_string())
        });
        let final_name = cd_name.unwrap_or(file_name);

        return Ok(Json(serde_json::json!({
            "url": url,
            "fileName": final_name,
            "fileType": infer_file_type(&final_name),
            "sizeBytes": content_length.unwrap_or(0),
            "resumable": true,
            "contentType": content_type,
        })));
    }

    Ok(Json(serde_json::json!({
        "url": url,
        "fileName": url.rsplit('/').next().unwrap_or("download"),
        "fileType": "other",
        "sizeBytes": 0,
        "resumable": false,
        "contentType": "",
    })))
}

pub async fn handle_ytdlp_probe(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map(|s| s.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing url"}))));
    }
    if url.starts_with('-') {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid url"}))));
    }

    let ytdlp_bin = state.ytdlp_bin.clone();
    let url2 = url.to_string();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            hidden_output(&ytdlp_bin, &["--dump-json", "--no-playlist", "--no-warnings", &url2])
        }),
    )
    .await
    .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, Json(serde_json::json!({"error": "Probe timed out"}))))?
    .map_err(|e| {
        log::error!("yt-dlp spawn failed: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Probe failed"})))
    })?
    .map_err(|e| {
        log::error!("yt-dlp probe failed: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Probe failed"})))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("yt-dlp probe stderr: {}", stderr);
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Probe failed"}))));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let info: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| {
            log::error!("yt-dlp probe parse failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Probe failed"})))
        })?;

    let duration = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let hours = (duration / 3600.0).floor();
    let minutes = ((duration % 3600.0) / 60.0).floor();
    let seconds = (duration % 60.0).floor();
    let duration_str = if hours > 0.0 {
        format!("{:02}:{:02}:{:02}", hours as u64, minutes as u64, seconds as u64)
    } else {
        format!("{:02}:{:02}", minutes as u64, seconds as u64)
    };

    Ok(Json(serde_json::json!({
        "id": info.get("id"),
        "title": info.get("title"),
        "duration": duration,
        "durationString": duration_str,
        "thumbnail": info.get("thumbnail"),
        "webpageUrl": info.get("webpage_url"),
        "formats": info.get("formats"),
    })))
}

pub async fn handle_ytdlp_probe_playlist(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map(|s| s.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing url"}))));
    }
    if url.starts_with('-') {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid url"}))));
    }

    let ytdlp_bin = state.ytdlp_bin.clone();
    let url2 = url.to_string();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            hidden_output(&ytdlp_bin, &["--flat-playlist", "--dump-json", "--no-warnings", &url2])
        }),
    )
    .await
    .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, Json(serde_json::json!({"error": "Probe timed out"}))))?
    .map_err(|e| {
        log::error!("yt-dlp spawn failed: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Probe failed"})))
    })?
    .map_err(|e| {
        log::error!("yt-dlp probe failed: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Probe failed"})))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("yt-dlp probe playlist stderr: {}", stderr);
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Probe failed"}))));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut playlist_title = "Playlist".to_string();

    for line in stdout.lines() {
        if line.trim().is_empty() { continue; }
        if let Ok(info) = serde_json::from_str::<serde_json::Value>(line) {
            if playlist_title == "Playlist" {
                playlist_title = info.get("playlist_title").or(info.get("title")).and_then(|v| v.as_str()).unwrap_or("Playlist").to_string();
            }
            let dur = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let hours = (dur / 3600.0).floor();
            let minutes = ((dur % 3600.0) / 60.0).floor();
            let seconds = (dur % 60.0).floor();
            let dur_str = if hours > 0.0 {
                format!("{:02}:{:02}:{:02}", hours as u64, minutes as u64, seconds as u64)
            } else {
                format!("{:02}:{:02}", minutes as u64, seconds as u64)
            };
            entries.push(serde_json::json!({
                "id": info.get("id"),
                "title": info.get("title"),
                "url": info.get("url").or(info.get("webpage_url")),
                "duration": dur,
                "durationString": dur_str,
                "thumbnail": info.get("thumbnail"),
                "index": info.get("playlist_index"),
            }));
        }
    }

    Ok(Json(serde_json::json!({
        "title": playlist_title,
        "webpageUrl": url,
        "entries": entries,
    })))
}

pub async fn handle_ytdlp_ffmpeg() -> Json<serde_json::Value> {
    let available = hidden_output("ffmpeg", &["-version"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    Json(serde_json::json!({"available": available}))
}

pub async fn handle_browser_ext_config(
    State(_state): State<SharedState>,
    Json(_body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "connected",
        "enabled": true,
        "paired": true,
        "version": env!("CARGO_PKG_VERSION"),
        "captureEndpoint": "/captures",
        "directDownloads": true,
        "mediaDownloads": true,
    }))
}

pub async fn handle_browser_ext_health(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let aria2_ready = aria2_rpc(&state, "getVersion", vec![]).await.is_ok();
    Json(serde_json::json!({
        "status": if aria2_ready { "connected" } else { "degraded" },
        "enabled": true,
        "paired": true,
        "version": env!("CARGO_PKG_VERSION"),
        "captureEndpoint": "/captures",
        "directDownloads": true,
        "mediaDownloads": true,
    }))
}

use std::time::Instant;
static DAEMON_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

pub fn record_daemon_start() {
    DAEMON_START.get_or_init(Instant::now);
}

pub async fn handle_diagnostics(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let jobs_count = state.media_jobs.lock().map(|j| j.len()).unwrap_or(0);
    let meta_count = state.aria2_meta.lock().map(|m| m.len()).unwrap_or(0);
    let uptime_secs = DAEMON_START.get().map(|t| t.elapsed().as_secs()).unwrap_or(0);
    let aria2_ready = aria2_rpc(&state, "getVersion", vec![]).await.is_ok();
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "uptime": uptime_secs,
        "jobs": jobs_count,
        "aria2Meta": meta_count,
        "aria2Port": state.aria2_rpc_port.load(std::sync::atomic::Ordering::Relaxed),
        "aria2Ready": aria2_ready,
        "cpuUsage": null,
        "memoryUsageMb": null,
        "diskFreeGb": null,
        "activeThreads": jobs_count,
    }))
}

pub async fn handle_post_diagnostics(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    log::info!("Diagnostics received: {}", serde_json::to_string(&body).unwrap_or_default());
    Json(serde_json::json!({"ok": true}))
}

pub async fn handle_captures(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let urls = body.get("urls").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut task_ids = Vec::new();
    for url_val in &urls {
        let url_str = url_val.as_str().unwrap_or("");
        if url_str.is_empty() { continue; }
        let download_body = CreateDownloadBody {
            url: Some(url_str.to_string()),
            name: None,
            file_type: None,
            size_bytes: None,
            category: None,
            queue_id: None,
            connections: None,
            resumable: None,
            save_path: None,
            description: None,
            referer: None,
            start_immediately: Some(true),
            direct_options: None,
            media_options: None,
        };
        if let Ok(task) = aria2_create(&state, &download_body).await {
            task_ids.push(task.id);
        }
    }
    let first_id = task_ids.first().cloned().unwrap_or_default();
    Json(serde_json::json!({
        "ok": true,
        "accepted": !task_ids.is_empty(),
        "taskId": first_id,
        "taskIds": task_ids,
        "message": format!("Captured {} download(s)", task_ids.len())
    }))
}

pub async fn handle_captures_pending(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let tasks = list_all_tasks(&state).await;
    let pending: Vec<serde_json::Value> = tasks.iter()
        .filter(|t| t.status == "queued" || t.status == "waiting")
        .map(|t| serde_json::json!({
            "id": t.id,
            "url": t.url,
            "name": t.name,
            "status": t.status,
        }))
        .collect();
    Json(serde_json::json!({"ok": true, "captures": pending}))
}

pub async fn handle_v1_add(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() {
        return Json(serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": "Missing url"}));
    }
    let download_body = CreateDownloadBody {
        url: Some(url.to_string()),
        name: body.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
        file_type: body.get("fileType").and_then(|v| v.as_str()).map(|s| s.to_string()),
        size_bytes: body.get("sizeBytes").and_then(|v| v.as_u64()),
        category: body.get("category").and_then(|v| v.as_str()).map(|s| s.to_string()),
        queue_id: body.get("queueId").and_then(|v| v.as_str()).map(|s| s.to_string()),
        connections: body.get("connections").and_then(|v| v.as_u64()).map(|v| v as u32),
        resumable: body.get("resumable").and_then(|v| v.as_bool()),
        save_path: body.get("savePath").and_then(|v| v.as_str()).map(|s| s.to_string()),
        description: body.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
        referer: body.get("referer").and_then(|v| v.as_str()).map(|s| s.to_string()),
        start_immediately: Some(true),
        direct_options: None,
        media_options: None,
    };
    match aria2_create(&state, &download_body).await {
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
                "message": "Failed"
            }))
        }
    }
}

pub async fn handle_v1_stream_resolve(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() {
        return Json(serde_json::json!({"ok": false, "resolved": false, "error": "Missing url"}));
    }
    if url.starts_with('-') {
        return Json(serde_json::json!({"ok": false, "resolved": false, "error": "Invalid url"}));
    }
    let resolved = if std::path::Path::new(&state.ytdlp_bin).exists() {
        let ytdlp_bin = state.ytdlp_bin.clone();
        let url2 = url.to_string();
        tokio::time::timeout(
            Duration::from_secs(30),
            tokio::task::spawn_blocking(move || {
                hidden_output(&ytdlp_bin, &["--dump-json", "--no-playlist", "--no-warnings", "--skip-download", &url2])
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            }),
        )
        .await
        .unwrap_or(Ok(false))
        .unwrap_or(false)
    } else {
        false
    };
    Json(serde_json::json!({
        "ok": true,
        "resolved": resolved,
        "url": url
    }))
}
