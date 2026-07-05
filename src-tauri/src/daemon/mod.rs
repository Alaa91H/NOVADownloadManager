pub mod aria2;
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
use axum::routing::{get, post, delete};
use axum::Router;
use reqwest::Client as HttpClient;
use tower_http::cors::CorsLayer;

use crate::daemon::routes::{
    handle_add_torrent, handle_browser_ext_config, handle_browser_ext_health,
    handle_captures, handle_captures_pending, handle_create_download, handle_delete_task,
    handle_diagnostics, handle_download_events, handle_health, handle_list_downloads, handle_pause_task,
    handle_post_diagnostics, handle_probe, handle_resume_task, handle_torrent_config,
    handle_v1_add, handle_v1_stream_resolve, handle_ytdlp_ffmpeg, handle_ytdlp_probe,
    handle_ytdlp_probe_playlist,
};
use crate::daemon::state::AppState;
use crate::daemon::static_files::{serve_asset, serve_index, serve_spa_fallback};
use crate::daemon::telegram::{handle_telegram_config, handle_telegram_test, handle_telegram_update_config, start_telegram_bot};
use crate::daemon::types::{MediaJob, TelegramConfig};

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

            let mut state = AppState {
                aria2_process: Mutex::new(None),
                media_jobs: Mutex::new(HashMap::new()),
                aria2_meta: Mutex::new(restored.aria2_meta.clone()),
                task_snapshot: Mutex::new(HashMap::new()),
                persist_dirty: std::sync::atomic::AtomicBool::new(false),
                telegram_config: Mutex::new(TelegramConfig {
                    enabled: false,
                    token: String::new(),
                    chat_id: 0,
                }),
                telegram_last_update_id: Mutex::new(restored.telegram_last_update_id),
                torrent_config: Mutex::new(crate::daemon::routes::load_initial_torrent_config(&data_dir)),
                http_client: HttpClient::new(),
                resource_dir: resource_dir.clone(),
                data_dir: data_dir.clone(),
                aria2_rpc_port: std::sync::atomic::AtomicU16::new(6800),
                aria2_starting: std::sync::atomic::AtomicBool::new(false),
                aria2_secret: uuid::Uuid::new_v4().to_string(),
                aria2_bin: "aria2c".to_string(),
                ytdlp_bin: "yt-dlp".to_string(),
            };

            let bin_dir = std::path::Path::new(&resource_dir).join("bin");
            let bundled_aria2 = bin_dir.join("aria2c.exe");
            let bundled_ytdlp = bin_dir.join("yt-dlp.exe");
            if bundled_aria2.exists() {
                state.aria2_bin = bundled_aria2.display().to_string();
            }
            if bundled_ytdlp.exists() {
                state.ytdlp_bin = bundled_ytdlp.display().to_string();
            }

            // Engines orphaned by previous runs hold RPC ports with secrets
            // this run no longer knows — clear them before starting our own.
            aria2::kill_stale_bundled_aria2(&state.aria2_bin);

            let state = Arc::new(state);

            crate::daemon::routes::record_daemon_start();
            restore_persisted_tasks(&state, restored);
            // Always start aria2 in the background, even on fresh installs
            let state_aria2 = state.clone();
            tokio::spawn(async move {
                if let Err(e) = aria2::ensure_aria2(&state_aria2).await {
                    log::warn!("Could not start aria2: {}", e);
                }
            });
            persist::start_persistence_loop(state.clone());

            start_telegram_bot(state.clone());

            let app = Router::new()
                .route("/api/health", get(handle_health))
                .route("/api/downloads", get(handle_list_downloads).post(handle_create_download))
                .route("/api/downloads/events", get(handle_download_events))
                .route("/api/downloads/{id}/pause", post(handle_pause_task))
                .route("/api/downloads/{id}/resume", post(handle_resume_task))
                .route("/api/downloads/{id}", delete(handle_delete_task))
                .route("/api/torrents", post(handle_add_torrent))
                .route("/api/torrents/config", post(handle_torrent_config))
                .route("/api/probe", get(handle_probe))
                .route("/api/ytdlp/probe", get(handle_ytdlp_probe))
                .route("/api/ytdlp/probe-playlist", get(handle_ytdlp_probe_playlist))
                .route("/api/ytdlp/ffmpeg", get(handle_ytdlp_ffmpeg))
                .route("/api/telegram/config", get(handle_telegram_config).post(handle_telegram_update_config))
                .route("/api/telegram/test", post(handle_telegram_test))
                .route("/api/diagnostics", get(handle_diagnostics).post(handle_post_diagnostics))
                .route("/api/browser-extension/config", post(handle_browser_ext_config))
                .route("/api/browser-extension/health", get(handle_browser_ext_health))
                .route("/captures", post(handle_captures))
                .route("/captures/pending", get(handle_captures_pending))
                .route("/v1/add", post(handle_v1_add))
                .route("/v1/stream/resolve", post(handle_v1_stream_resolve))
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

/// Rebuild in-memory task state from the persisted snapshot: media jobs are
/// re-registered (paused, resumable via their saved yt-dlp args) and aria2 is
/// relaunched from its session file so unfinished downloads continue.
fn restore_persisted_tasks(state: &crate::daemon::state::SharedState, restored: persist::PersistedState) {
    if restored.tasks.is_empty() {
        return;
    }
    log::info!("Restoring {} persisted download task(s)", restored.tasks.len());

    let mut user_paused_gids: Vec<String> = Vec::new();
    {
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

        for mut task in restored.tasks {
            let was_running = matches!(task.status.as_str(), "downloading" | "queued" | "waiting" | "starting");
            if task.engine == "yt-dlp" {
                if was_running {
                    task.status = "paused".to_string();
                    task.engine_status = Some("interrupted".to_string());
                }
                task.speed_bytes_per_sec = 0;
                let args = restored.media_args.get(&task.id).cloned().unwrap_or_default();
                if task.status != "completed" && !args.is_empty() {
                    media_jobs.insert(task.id.clone(), MediaJob {
                        task: task.clone(),
                        child: None,
                        args,
                    });
                }
            } else if task.status == "paused" {
                user_paused_gids.push(task.id.clone());
            }
            snapshot.insert(task.id.clone(), task);
        }
    }

    // Relaunch aria2 from its saved session so unfinished downloads resume,
    // then re-apply pauses the user had set before the restart.
    if persist::aria2_session_path(&state.data_dir).exists() {
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = aria2::ensure_aria2(&state).await {
                log::warn!("Could not relaunch aria2 from saved session: {}", e);
                return;
            }
            for gid in user_paused_gids {
                let _ = aria2::aria2_rpc(&state, "forcePause", vec![serde_json::json!(gid)]).await;
            }
        });
    }
}
