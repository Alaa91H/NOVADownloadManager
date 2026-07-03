pub mod aria2;
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
use uuid::Uuid;

use crate::daemon::routes::{
    handle_add_torrent, handle_browser_ext_config, handle_browser_ext_health,
    handle_captures, handle_captures_pending, handle_create_download, handle_delete_task,
    handle_diagnostics, handle_health, handle_list_downloads, handle_pause_task,
    handle_post_diagnostics, handle_probe, handle_resume_task, handle_torrent_config,
    handle_v1_add, handle_v1_stream_resolve, handle_ytdlp_ffmpeg, handle_ytdlp_probe,
    handle_ytdlp_probe_playlist,
};
use crate::daemon::state::AppState;
use crate::daemon::static_files::{serve_asset, serve_index, serve_spa_fallback};
use crate::daemon::telegram::{handle_telegram_config, handle_telegram_test, handle_telegram_update_config, start_telegram_bot};
use crate::daemon::types::{TelegramConfig, TorrentConfigBody};

pub fn start_daemon(resource_dir: String, port: u16) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("Failed to create tokio runtime: {}", e);
                return;
            }
        };
        rt.block_on(async {
            let mut state = AppState {
                aria2_process: Mutex::new(None),
                media_jobs: Mutex::new(HashMap::new()),
                aria2_meta: Mutex::new(HashMap::new()),
                telegram_config: Mutex::new(TelegramConfig {
                    enabled: false,
                    token: String::new(),
                    chat_id: 0,
                }),
                torrent_config: Mutex::new(TorrentConfigBody {
                    dht: Some(true),
                    pex: Some(true),
                    encryption: Some(true),
                    listen_port: Some(6881),
                    max_peers: Some(100),
                    seeding: Some(true),
                    ratio_limit: Some(2.0),
                    upload_speed: Some(0),
                }),
                http_client: HttpClient::new(),
                resource_dir: resource_dir.clone(),
                aria2_rpc_port: 6800,
                aria2_secret: Uuid::new_v4().to_string(),
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

            let state = Arc::new(state);
            start_telegram_bot(state.clone());

            let app = Router::new()
                .route("/api/health", get(handle_health))
                .route("/api/downloads", get(handle_list_downloads).post(handle_create_download))
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
