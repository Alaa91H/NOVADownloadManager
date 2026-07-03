use std::collections::HashMap;
use std::time::Duration;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use serde_json;

use crate::daemon::aria2::{aria2_rpc, create_aria2_task as aria2_create, list_all_tasks, pause_task, resume_task, delete_task};
use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, Task, TorrentBody, TorrentConfigBody};
use crate::daemon::utils::infer_file_type;
use crate::daemon::ytdlp::create_ytdlp_task;
use crate::daemon::telegram::telegram_notify;

pub async fn handle_health(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let aria2_ready = aria2_rpc(&state, "getVersion", vec![]).await.is_ok();
    let ytdlp_available = std::path::Path::new(&state.ytdlp_bin).exists();
    Json(serde_json::json!({
        "status": "connected",
        "name": "NOVA Daemon",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "engines": {
            "aria2": {
                "available": true,
                "rpcReady": aria2_ready,
                "rpcPort": state.aria2_rpc_port,
                "version": env!("CARGO_PKG_VERSION"),
            },
            "ytdlp": {
                "available": ytdlp_available,
                "version": "unknown",
            }
        }
    }))
}

pub async fn handle_list_downloads(State(state): State<SharedState>) -> Json<Vec<Task>> {
    Json(list_all_tasks(&state).await)
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
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e})))),
    }
}

pub async fn handle_pause_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    pause_task(&state, &id).await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))
}

pub async fn handle_resume_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    resume_task(&state, &id).await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))
}

pub async fn handle_delete_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    delete_task(&state, &id).await
        .map(|_| Json(serde_json::json!({"ok": true})))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))
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
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e})))),
    }
}

pub async fn handle_torrent_config(
    State(state): State<SharedState>,
    Json(body): Json<TorrentConfigBody>,
) -> Json<serde_json::Value> {
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
    Json(serde_json::json!({"ok": true}))
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

    let output = std::process::Command::new(&state.ytdlp_bin)
        .args(["--dump-json", "--no-playlist", "--no-warnings", url])
        .output()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("yt-dlp failed: {}", e)}))))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": stderr.to_string()}))));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let info: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Parse failed: {}", e)}))))?;

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

    let output = std::process::Command::new(&state.ytdlp_bin)
        .args(["--flat-playlist", "--dump-json", "--no-warnings", url])
        .output()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("yt-dlp failed: {}", e)}))))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": stderr.to_string()}))));
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
    let available = std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    Json(serde_json::json!({"available": available}))
}

pub async fn handle_browser_ext_config(
    State(_state): State<SharedState>,
    Json(_body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    log::info!("Browser extension config updated");
    Json(serde_json::json!({"ok": true, "enabled": true}))
}

pub async fn handle_browser_ext_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "enabled": true,
        "paired": false,
        "bridged": false,
    }))
}

pub async fn handle_diagnostics(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let jobs_count = state.media_jobs.lock().map(|j| j.len()).unwrap_or(0);
    let meta_count = state.aria2_meta.lock().map(|m| m.len()).unwrap_or(0);
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "uptime": 0,
        "jobs": jobs_count,
        "aria2Meta": meta_count,
        "aria2Port": state.aria2_rpc_port,
    }))
}

pub async fn handle_post_diagnostics(
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    log::info!("Diagnostics posted: {:?}", body);
    Json(serde_json::json!({"ok": true}))
}

pub async fn handle_captures(
    State(_state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let _ = body;
    Json(serde_json::json!({"ok": true, "accepted": true, "taskId": "", "taskIds": [], "message": "Captured"}))
}

pub async fn handle_captures_pending() -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "captures": []}))
}

pub async fn handle_v1_add(
    State(_state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let _ = body;
    Json(serde_json::json!({"ok": true, "accepted": true, "taskId": "", "taskIds": [], "message": "Added"}))
}

pub async fn handle_v1_stream_resolve(
    State(_state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let _ = body;
    Json(serde_json::json!({"ok": true, "resolved": true}))
}
