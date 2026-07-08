pub mod curl;
pub mod direct;
pub mod engine_capabilities;
pub mod persist;
pub mod routes;
pub mod state;
pub mod static_files;
pub mod telegram;
pub mod types;
pub mod utils;
pub mod ytdlp;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64};
use axum::routing::{get, post, delete};
use axum::Router;
use reqwest::Client as HttpClient;
use tower_http::cors::CorsLayer;

use crate::daemon::routes::{
    handle_add_torrent, handle_browser_ext_config, handle_browser_ext_health,
    handle_captures, handle_captures_pending, handle_create_download, handle_delete_task,
    handle_diagnostics, handle_download_events, handle_health, handle_list_downloads, handle_pause_task,
    handle_post_diagnostics, handle_probe, handle_probe_post, handle_resume_task, handle_torrent_config,
    handle_v1_add, handle_v1_stream_resolve, handle_v1_stream_add, handle_v1_ping, handle_v1_pair_auto, handle_v1_auth_check,
    handle_v1_extension_settings, handle_v1_list_tasks, handle_v1_pause_task_body, handle_v1_resume_task_body,
    handle_v1_cancel_task_body, handle_v1_pause_task_path, handle_v1_resume_task_path, handle_v1_cancel_task_path,
    handle_v1_events, handle_engine_capabilities, handle_ytdlp_ffmpeg, handle_ytdlp_probe, handle_ytdlp_probe_playlist,
};
use crate::daemon::state::AppState;
use crate::daemon::static_files::{serve_asset, serve_index, serve_spa_fallback};
use crate::daemon::telegram::{
    handle_telegram_config, handle_telegram_send_file, handle_telegram_test, handle_telegram_update_config,
    start_telegram_bot,
};
use crate::daemon::types::{CreateDownloadBody, CurlJob, MediaJob, TelegramConfig};

fn resolve_engine_binary(resource_dir: &str, binary_name: &str, fallback_command: &str) -> String {
    let resource_path = std::path::Path::new(resource_dir);
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        resource_path.join("bin").join(binary_name),
        resource_path.join("..").join("bin").join(binary_name),
        manifest_dir.join("..").join("bin").join(binary_name),
    ];

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.display().to_string())
        .unwrap_or_else(|| fallback_command.to_string())
}

pub fn start_daemon(resource_dir: String, data_dir: String, port: u16) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("Failed to create tokio runtime: {}", e);
                return;
            }
        };
        rt.block_on(async {
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                log::warn!("Failed to create data directory: {}", e);
            }
            let restored = persist::load(&data_dir);
            let curl_binary = if cfg!(windows) { "curl.exe" } else { "curl" };
            let ytdlp_binary = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
            let ffmpeg_binary = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
            let curl_bin = resolve_engine_binary(&resource_dir, curl_binary, "curl");
            let ytdlp_bin = resolve_engine_binary(&resource_dir, ytdlp_binary, "yt-dlp");
            let ffmpeg_bin = resolve_engine_binary(&resource_dir, ffmpeg_binary, "ffmpeg");

            let state = AppState {
                media_jobs: Mutex::new(HashMap::new()),
                curl_jobs: Mutex::new(HashMap::new()),
                task_snapshot: Mutex::new(HashMap::new()),
                persist_dirty: std::sync::atomic::AtomicBool::new(false),
                telegram_config: Mutex::new(TelegramConfig::default()),
                telegram_last_update_id: Mutex::new(restored.telegram_last_update_id),
                torrent_config: Mutex::new(crate::daemon::routes::load_initial_torrent_config(&data_dir)),
                http_client: HttpClient::new(),
                resource_dir: resource_dir.clone(),
                data_dir: data_dir.clone(),
                curl_bin,
                ytdlp_bin,
                ffmpeg_bin,
            };

            let state = Arc::new(state);

            crate::daemon::routes::record_daemon_start();
            restore_persisted_tasks(&state, restored);
            persist::start_persistence_loop(state.clone());

            start_telegram_bot(state.clone());

            let app = Router::new()
                .route("/api/health", get(handle_health))
                .route("/api/engines/capabilities", get(handle_engine_capabilities))
                .route("/api/downloads", get(handle_list_downloads).post(handle_create_download))
                .route("/api/downloads/events", get(handle_download_events))
                .route("/api/downloads/{id}/pause", post(handle_pause_task))
                .route("/api/downloads/{id}/resume", post(handle_resume_task))
                .route("/api/downloads/{id}", delete(handle_delete_task))
                .route("/api/torrents", post(handle_add_torrent))
                .route("/api/torrents/config", post(handle_torrent_config))
                .route("/api/probe", get(handle_probe).post(handle_probe_post))
                .route("/api/ytdlp/probe", get(handle_ytdlp_probe))
                .route("/api/ytdlp/probe-playlist", get(handle_ytdlp_probe_playlist))
                .route("/api/ytdlp/ffmpeg", get(handle_ytdlp_ffmpeg))
                .route("/api/telegram/config", get(handle_telegram_config).post(handle_telegram_update_config))
                .route("/api/telegram/test", post(handle_telegram_test))
                .route("/api/telegram/send-file", post(handle_telegram_send_file))
                .route("/api/diagnostics", get(handle_diagnostics).post(handle_post_diagnostics))
                .route("/api/browser-extension/config", post(handle_browser_ext_config))
                .route("/api/browser-extension/health", get(handle_browser_ext_health))
                .route("/captures", post(handle_captures))
                .route("/captures/pending", get(handle_captures_pending))
                .route("/v1/ping", get(handle_v1_ping))
                .route("/v1/pair/auto", post(handle_v1_pair_auto))
                .route("/v1/auth/check", post(handle_v1_auth_check))
                .route("/v1/extension-settings", get(handle_v1_extension_settings))
                .route("/v1/events", get(handle_v1_events))
                .route("/api/v1/events/stream", get(handle_v1_events))
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
                .route("/", get(serve_index))
                .route("/assets/{*path}", get(serve_asset))
                .route("/{*path}", get(serve_spa_fallback))
                .with_state(state.clone())
                .layer(CorsLayer::permissive());

            let addr = format!("127.0.0.1:{}", port);
            log::info!("NOVA daemon starting on {}", addr);

            let listener = match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(e) => {
                    log::error!("Failed to bind daemon to {}: {}", addr, e);
                    return;
                }
            };
            if let Err(e) = axum::serve(listener, app).await {
                log::error!("Daemon server error: {}", e);
            }
        });
    });
}

/// Rebuild in-memory task state from the persisted snapshot. Direct HTTP(S)
/// jobs are restored as curl jobs; running jobs are marked paused because the
/// child process cannot survive an application restart.
fn restore_persisted_tasks(state: &crate::daemon::state::SharedState, restored: persist::PersistedState) {
    if restored.tasks.is_empty() {
        return;
    }
    log::info!("Restoring {} persisted download task(s)", restored.tasks.len());

    let mut snapshot = match state.task_snapshot.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("Snapshot lock poisoned during restore: {}", e);
            return;
        }
    };
    let mut media_jobs = match state.media_jobs.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("Media jobs lock poisoned during restore: {}", e);
            return;
        }
    };
    let mut curl_jobs = match state.curl_jobs.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("curl jobs lock poisoned during restore: {}", e);
            return;
        }
    };

    for mut task in restored.tasks {
        let was_running = matches!(task.status.as_str(), "downloading" | "queued" | "waiting" | "starting");
        if was_running {
            task.status = "paused".to_string();
            task.engine_status = Some("interrupted".to_string());
            task.speed_bytes_per_sec = 0;
        }

        if task.engine == "yt-dlp" {
            let args = restored.media_args.get(&task.id).cloned().unwrap_or_default();
            if task.status != "completed" && !args.is_empty() {
                media_jobs.insert(task.id.clone(), MediaJob {
                    task: task.clone(),
                    child: None,
                    args,
                });
            }
        } else if task.engine == "curl"
            || task.engine == "libcurl-multi"
            || (task.engine == "aria2"
                && task.torrent_metadata.is_none()
                && (task.url.starts_with("http://") || task.url.starts_with("https://")))
        {
            task.engine = "libcurl-multi".to_string();
            task.engine_id = task.id.clone();
            task.description = if task.description.trim().is_empty() || task.description == "Direct download" {
                "Direct download via libcurl multi".to_string()
            } else {
                task.description.clone()
            };
            let args = restored.curl_args.get(&task.id).cloned().unwrap_or_else(|| {
                let body = CreateDownloadBody {
                    url: Some(task.url.clone()),
                    name: Some(task.name.clone()),
                    file_type: Some(task.file_type.clone()),
                    size_bytes: Some(task.size_bytes),
                    category: Some(task.category.clone()),
                    queue_id: Some(task.queue_id.clone()),
                    connections: Some(task.connections),
                    resumable: Some(task.resumable),
                    save_path: if task.save_path.is_empty() { None } else { Some(task.save_path.clone()) },
                    description: Some(task.description.clone()),
                    referer: task.referer.clone(),
                    start_immediately: Some(false),
                    direct_options: None,
                    media_options: None,
                };
                crate::daemon::curl::build_curl_args(&body, std::path::Path::new(&task.save_path)).unwrap_or_default()
            });
            if task.status != "completed" && !args.is_empty() {
                curl_jobs.insert(task.id.clone(), CurlJob {
                    task: task.clone(),
                    child: None,
                    args,
                    direct_options: HashMap::new(),
                    cancel_token: Arc::new(AtomicBool::new(false)),
                    run_generation: Arc::new(AtomicU64::new(0)),
                });
            }
        } else if task.engine == "aria2" {
            task.status = "error".to_string();
            task.engine_status = Some("legacy-engine-removed".to_string());
            task.error_message = Some("The legacy aria2 engine has been removed. Re-add this torrent/magnet with a dedicated torrent engine when available.".to_string());
            task.speed_bytes_per_sec = 0;
        }

        snapshot.insert(task.id.clone(), task);
    }
}
