pub mod curl;
pub mod diagnostics;
pub mod direct;
pub mod engine;
pub mod engine_capabilities;
pub mod persist;
pub mod routes;
pub mod state;
pub mod static_files;
pub mod telegram;
pub mod types;
pub mod utils;
pub mod ytdlp;

use axum::routing::{delete, get, post};
use axum::Router;
use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::daemon::routes::{
    handle_adaptive_get, handle_bandwidth_get, handle_bandwidth_set, handle_browser_ext_config,
    handle_browser_ext_health, handle_captures, handle_captures_pending, handle_checksum_verify,
    handle_create_download, handle_delete_task, handle_diagnostics, handle_download_events,
    handle_engine_capabilities, handle_engine_events, handle_engine_events_clear,
    handle_engine_events_for_task, handle_health, handle_list_downloads,
    handle_metadata_cache_clear, handle_metadata_cache_stats, handle_mirrors_add,
    handle_mirrors_enable_failover, handle_mirrors_failover, handle_mirrors_list,
    handle_mirrors_set, handle_pause_task, handle_plugins_disable, handle_plugins_enable,
    handle_plugins_get, handle_plugins_list, handle_plugins_register, handle_plugins_unregister,
    handle_plugins_update_settings, handle_post_diagnostics, handle_probe, handle_probe_post,
    handle_profiles_add_custom, handle_profiles_delete, handle_profiles_get, handle_profiles_list,
    handle_profiles_set_active, handle_queue_list, handle_queue_set_priority,
    handle_rate_limit_get, handle_rate_limit_set, handle_resume_task, handle_retry_policy_get,
    handle_retry_policy_set, handle_rules_add, handle_rules_delete, handle_rules_list,
    handle_scheduler_add, handle_scheduler_delete, handle_scheduler_list, handle_scheduler_update,
    handle_segments_get, handle_torrent_config, handle_v1_add, handle_v1_auth_check,
    handle_v1_cancel_task_body, handle_v1_cancel_task_path, handle_v1_events,
    handle_v1_extension_settings, handle_v1_list_tasks, handle_v1_pair_auto,
    handle_v1_pause_task_body, handle_v1_pause_task_path, handle_v1_ping,
    handle_v1_resume_task_body, handle_v1_resume_task_path, handle_v1_stream_add,
    handle_v1_stream_resolve, handle_ytdlp_ffmpeg, handle_ytdlp_probe, handle_ytdlp_probe_playlist,
};
use crate::daemon::state::{AppState, SharedState};
use crate::daemon::static_files::{serve_asset, serve_index, serve_spa_fallback};
use crate::daemon::telegram::{
    handle_telegram_config, handle_telegram_send_file, handle_telegram_test,
    handle_telegram_update_config, start_telegram_bot,
};
use crate::daemon::types::{CreateDownloadBody, CurlJob, MediaJob, TelegramConfig};

use crate::daemon::engine::extractor::{ExtractorRegistry, SharedExtractorRegistry};

/// Generate a random 32-char hex token for API authentication.
fn generate_api_token() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}

/// The API token shared between the daemon (which validates it) and the Tauri
/// command layer (which hands it to the trusted desktop webview). Initialised
/// once per process, so it stays stable across daemon restarts.
pub fn shared_api_token() -> String {
    static API_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    API_TOKEN.get_or_init(generate_api_token).clone()
}

/// Middleware that enforces Bearer token authentication on API routes.
/// Exempt paths: /api/health, /api/engines/capabilities, /v1/pair-auto,
/// / (SPA index), /assets/*, and SPA fallback.
async fn auth_middleware(
    axum::extract::State(state): axum::extract::State<SharedState>,
    request: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> Result<axum::http::Response<axum::body::Body>, axum::http::StatusCode> {
    let path = request.uri().path();

    let exempt = path == "/api/health"
        || path == "/api/engines/capabilities"
        || path == "/v1/pair-auto"
        || path == "/v1/ping"
        || path.starts_with("/api/engines/")
        || path == "/"
        || path.starts_with("/assets/")
        || path == "/index.html"
        || path.ends_with(".js")
        || path.ends_with(".css")
        || path.ends_with(".ico");

    if exempt {
        return Ok(next.run(request).await);
    }

    if let Some(auth) = request.headers().get(axum::http::header::AUTHORIZATION) {
        if let Ok(auth_str) = auth.to_str() {
            if auth_str.strip_prefix("Bearer ").unwrap_or("") == state.api_token {
                return Ok(next.run(request).await);
            }
        }
    }

    // EventSource (SSE) cannot attach an Authorization header, so also accept the
    // same token via a `token` query parameter — but ONLY for SSE endpoints to
    // minimize token exposure in URLs (query params appear in logs, Referer, etc.).
    let is_sse_endpoint = path == "/api/downloads/events" || path == "/v1/events";
    if is_sse_endpoint {
        if let Some(query) = request.uri().query() {
            for pair in query.split('&') {
                if let Some(token) = pair.strip_prefix("token=") {
                    if token == state.api_token {
                        return Ok(next.run(request).await);
                    }
                }
            }
        }
    }

    Err(axum::http::StatusCode::UNAUTHORIZED)
}

fn resolve_engine_binary(resource_dir: &str, binary_name: &str) -> String {
    let resource_path = std::path::Path::new(resource_dir);
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let candidates = [
        resource_path.join("bin").join(binary_name),
        resource_path.join("..").join("bin").join(binary_name),
        exe_dir.join("resources").join("bin").join(binary_name),
        exe_dir.join("bin").join(binary_name),
        manifest_dir.join("..").join("bin").join(binary_name),
    ];

    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.display().to_string())
        .unwrap_or_else(|| {
            log::warn!(
                "{} not found in bundled locations; falling back to PATH lookup. \
                 This may be a security risk if PATH has been tampered with.",
                binary_name
            );
            binary_name.to_string()
        })
}

pub fn start_daemon(resource_dir: String, data_dir: String, port: u16) {
    // Initialise SSL for the curl engine (bundled CA cert)
    crate::daemon::curl::init_download_ssl();
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
            let ytdlp_binary = if cfg!(windows) {
                "yt-dlp.exe"
            } else {
                "yt-dlp"
            };
            let ffmpeg_binary = if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            };
            let ytdlp_bin = resolve_engine_binary(&resource_dir, ytdlp_binary);
            let ffmpeg_bin = resolve_engine_binary(&resource_dir, ffmpeg_binary);

            // Build extractor registry
            let mut extractor_registry = ExtractorRegistry::new();
            extractor_registry.register(std::sync::Arc::new(crate::daemon::curl::CurlExtractor));
            extractor_registry.register(std::sync::Arc::new(
                crate::daemon::ytdlp::YtDlpExtractor::new(ytdlp_bin.clone(), ffmpeg_bin.clone()),
            ));
            let extractor_registry = SharedExtractorRegistry::new(extractor_registry);

            let state = AppState {
                media_jobs: Mutex::new(HashMap::new()),
                curl_jobs: Mutex::new(HashMap::new()),
                task_snapshot: Mutex::new(HashMap::new()),
                persist_dirty: std::sync::atomic::AtomicBool::new(false),
                telegram_config: Mutex::new(TelegramConfig::default()),
                telegram_last_update_id: Mutex::new(restored.telegram_last_update_id),
                torrent_config: Mutex::new(crate::daemon::routes::load_initial_torrent_config(
                    &data_dir,
                )),
                http_client: HttpClient::builder()
                    .pool_idle_timeout(std::time::Duration::from_secs(90))
                    .pool_max_idle_per_host(4)
                    .connect_timeout(std::time::Duration::from_secs(15))
                    .build()
                    .unwrap_or_else(|_| HttpClient::new()),
                resource_dir,
                data_dir,
                ytdlp_bin,
                ffmpeg_bin,
                engine_capabilities_cache: std::sync::RwLock::new(None),
                task_generation: std::sync::atomic::AtomicU64::new(0),
                task_list_cache: std::sync::RwLock::new(None),
                event_bus: crate::daemon::engine::event_bus::EventBus::new_with_capacity(10_000),
                priority_queue: crate::daemon::engine::priority_queue::PriorityBandwidthQueue::new(
                    0,
                ),
                bandwidth_manager: crate::daemon::engine::bandwidth::BandwidthManager::default(),
                profile_manager: crate::daemon::engine::profiles::ProfileManager::new(),
                rule_engine: crate::daemon::engine::rules::DownloadRuleEngine::new(),
                scheduler: crate::daemon::engine::scheduler::SmartScheduler::new(),
                metadata_cache: crate::daemon::engine::metadata_cache::MetadataCache::with_ttl(
                    std::time::Duration::from_secs(3600),
                ),
                default_retry_policy: std::sync::RwLock::new(
                    crate::daemon::engine::retry::RetryPolicy::default(),
                ),
                plugin_api: crate::daemon::engine::plugin_api::PluginApi::new(),
                engine_trackers: Mutex::new(HashMap::new()),
                mirror_managers: Mutex::new(HashMap::new()),
                extractor_registry,
                api_token: shared_api_token(),
            };

            let state = Arc::new(state);

            log::debug!("Daemon started with API auth enabled");

            // Mirror every engine event into the daemon log so the events are
            // captured by file logging alongside the in-memory event log.
            state.event_bus.subscribe(|event| {
                log::debug!("engine event #{}: {:?}", event.id, event.event);
            });

            // Periodic smart-scheduler evaluation: applies time-window and
            // bandwidth-triggered rules (pause/start/limit/notify) for real.
            let scheduler_state = state.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    ticker.tick().await;
                    crate::daemon::routes::run_scheduler_tick(&scheduler_state).await;
                }
            });

            crate::daemon::routes::record_daemon_start();
            restore_persisted_tasks(&state, restored);
            persist::start_persistence_loop(state.clone());

            start_telegram_bot(state.clone());

            let app = Router::new()
                .route("/api/health", get(handle_health))
                .route("/api/engines/capabilities", get(handle_engine_capabilities))
                .route(
                    "/api/downloads",
                    get(handle_list_downloads).post(handle_create_download),
                )
                .route("/api/downloads/events", get(handle_download_events))
                .route("/api/downloads/{id}/pause", post(handle_pause_task))
                .route("/api/downloads/{id}/resume", post(handle_resume_task))
                .route("/api/downloads/{id}", delete(handle_delete_task))
                .route("/api/torrents/config", post(handle_torrent_config))
                .route("/api/probe", get(handle_probe).post(handle_probe_post))
                .route("/api/ytdlp/probe", get(handle_ytdlp_probe))
                .route(
                    "/api/ytdlp/probe-playlist",
                    get(handle_ytdlp_probe_playlist),
                )
                .route("/api/ytdlp/ffmpeg", get(handle_ytdlp_ffmpeg))
                .route(
                    "/api/telegram/config",
                    get(handle_telegram_config).post(handle_telegram_update_config),
                )
                .route("/api/telegram/test", post(handle_telegram_test))
                .route("/api/telegram/send-file", post(handle_telegram_send_file))
                .route(
                    "/api/diagnostics",
                    get(handle_diagnostics).post(handle_post_diagnostics),
                )
                .route(
                    "/api/browser-extension/config",
                    post(handle_browser_ext_config),
                )
                .route(
                    "/api/browser-extension/health",
                    get(handle_browser_ext_health),
                )
                .route("/captures", post(handle_captures))
                .route("/captures/pending", get(handle_captures_pending))
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
                .route(
                    "/api/engine/events",
                    get(handle_engine_events).delete(handle_engine_events_clear),
                )
                .route(
                    "/api/engine/events/{task_id}",
                    get(handle_engine_events_for_task),
                )
                .route("/api/engine/adaptive/{task_id}", get(handle_adaptive_get))
                .route("/api/engine/segments/{task_id}", get(handle_segments_get))
                .route(
                    "/api/engine/retry-policy",
                    get(handle_retry_policy_get).post(handle_retry_policy_set),
                )
                .route(
                    "/api/engine/cache",
                    get(handle_metadata_cache_stats).delete(handle_metadata_cache_clear),
                )
                .route(
                    "/api/engine/queue",
                    get(handle_queue_list).post(handle_queue_set_priority),
                )
                .route(
                    "/api/engine/bandwidth",
                    get(handle_bandwidth_get).post(handle_bandwidth_set),
                )
                .route(
                    "/api/engine/rate-limit",
                    get(handle_rate_limit_get).post(handle_rate_limit_set),
                )
                .route(
                    "/api/engine/profiles",
                    get(handle_profiles_list).post(handle_profiles_set_active),
                )
                .route(
                    "/api/engine/profiles/custom",
                    post(handle_profiles_add_custom),
                )
                .route(
                    "/api/engine/profiles/{id}",
                    get(handle_profiles_get).delete(handle_profiles_delete),
                )
                .route(
                    "/api/engine/rules",
                    get(handle_rules_list).post(handle_rules_add),
                )
                .route("/api/engine/rules/{id}", delete(handle_rules_delete))
                .route(
                    "/api/engine/scheduler",
                    get(handle_scheduler_list).post(handle_scheduler_add),
                )
                .route(
                    "/api/engine/scheduler/update",
                    post(handle_scheduler_update),
                )
                .route(
                    "/api/engine/scheduler/{id}",
                    delete(handle_scheduler_delete),
                )
                .route("/api/engine/checksum", post(handle_checksum_verify))
                .route(
                    "/api/engine/mirrors",
                    get(handle_mirrors_list).post(handle_mirrors_add),
                )
                .route("/api/engine/mirrors/set", post(handle_mirrors_set))
                .route(
                    "/api/engine/mirrors/failover",
                    post(handle_mirrors_failover),
                )
                .route(
                    "/api/engine/mirrors/enable-failover",
                    post(handle_mirrors_enable_failover),
                )
                .route(
                    "/api/plugins",
                    get(handle_plugins_list).post(handle_plugins_register),
                )
                .route(
                    "/api/plugins/{id}",
                    get(handle_plugins_get).delete(handle_plugins_unregister),
                )
                .route("/api/plugins/{id}/enable", post(handle_plugins_enable))
                .route("/api/plugins/{id}/disable", post(handle_plugins_disable))
                .route(
                    "/api/plugins/{id}/settings",
                    post(handle_plugins_update_settings),
                )
                .route("/", get(serve_index))
                .route("/assets/{*path}", get(serve_asset))
                .route("/{*path}", get(serve_spa_fallback))
                .with_state(state.clone())
                .layer(axum::middleware::from_fn_with_state(
                    state.clone(),
                    auth_middleware,
                ))
                .layer(
                    CorsLayer::new()
                        .allow_origin(AllowOrigin::predicate(
                            |origin: &axum::http::HeaderValue,
                             _parts: &axum::http::request::Parts| {
                                let bytes = origin.as_bytes();
                                // Reject null origin — it allows any local HTML
                                // file to access the API (SSRF vector).
                                if bytes == b"null" {
                                    return false;
                                }
                                // Only allow exact localhost:port on the bound port.
                                let allowed_loopback = bytes == b"http://127.0.0.1"
                                    || bytes == b"http://localhost"
                                    || bytes.starts_with(b"http://127.0.0.1:")
                                    || bytes.starts_with(b"http://localhost:")
                                    || bytes.starts_with(b"tauri://localhost")
                                    || bytes.starts_with(b"https://tauri.localhost")
                                    || bytes.starts_with(b"http://tauri.localhost");
                                let allowed_extensions = bytes.starts_with(b"chrome-extension://")
                                    || bytes.starts_with(b"moz-extension://")
                                    || bytes.starts_with(b"safari-web-extension://");
                                allowed_loopback || allowed_extensions
                            },
                        ))
                        .allow_methods([
                            axum::http::Method::GET,
                            axum::http::Method::POST,
                            axum::http::Method::DELETE,
                            axum::http::Method::OPTIONS,
                        ])
                        .allow_headers([
                            axum::http::header::CONTENT_TYPE,
                            axum::http::header::AUTHORIZATION,
                            axum::http::header::ORIGIN,
                            axum::http::header::ACCEPT,
                        ]),
                )
                .layer(CompressionLayer::new());

            let addr = format!("127.0.0.1:{}", port);
            log::info!("NOVA daemon starting on {}", addr);

            // Retry TCP bind a few times — ports may still be in TIME_WAIT after
            // the old daemon was killed.
            let mut listener: Option<tokio::net::TcpListener> = None;
            for attempt in 0..5u32 {
                match tokio::net::TcpListener::bind(&addr).await {
                    Ok(l) => {
                        listener = Some(l);
                        break;
                    }
                    Err(e) => {
                        log::warn!(
                            "Daemon bind attempt {}/5 to {} failed: {}",
                            attempt + 1,
                            addr,
                            e
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
            let listener = match listener {
                Some(l) => l,
                None => {
                    log::error!("Failed to bind daemon to {} after 5 retries", addr);
                    return;
                }
            };
            let shutdown_state = state.clone();
            let shutdown_signal = async move {
                let _ = tokio::signal::ctrl_c().await;
                log::info!("Shutdown signal received; flushing state...");
                crate::daemon::persist::save_now(&shutdown_state);
                log::info!("State saved; shutting down daemon.");
            };
            if let Err(e) = axum::serve(listener, app)
                .with_graceful_shutdown(shutdown_signal)
                .await
            {
                log::error!("Daemon server error: {}", e);
            }
        });
    });
}

/// Rebuild in-memory task state from the persisted snapshot. Direct HTTP(S)
/// jobs are restored as curl jobs; running jobs are marked paused because the
/// child process cannot survive an application restart.
fn restore_persisted_tasks(
    state: &crate::daemon::state::SharedState,
    restored: persist::PersistedState,
) {
    if restored.tasks.is_empty() {
        return;
    }
    log::info!(
        "Restoring {} persisted download task(s)",
        restored.tasks.len()
    );

    // Lock order must be media_jobs, curl_jobs, task_snapshot to match
    // the rest of the daemon and prevent deadlock.
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
    let mut snapshot = match state.task_snapshot.lock() {
        Ok(g) => g,
        Err(e) => {
            log::error!("Snapshot lock poisoned during restore: {}", e);
            return;
        }
    };

    for mut task in restored.tasks {
        let was_running = matches!(
            task.status.as_str(),
            "downloading" | "queued" | "waiting" | "starting"
        );
        if was_running {
            task.status = "paused".to_string();
            task.engine_status = Some("interrupted".to_string());
            task.speed_bytes_per_sec = 0;
        }

        if task.engine == "yt-dlp" {
            let args = restored
                .media_args
                .get(&task.id)
                .cloned()
                .unwrap_or_default();
            if task.status != "completed" && !args.is_empty() {
                media_jobs.insert(
                    task.id.clone(),
                    MediaJob {
                        task: task.clone(),
                        child: None,
                        args,
                        start_time: Instant::now(),
                    },
                );
            }
        } else if task.engine == "curl"
            || task.engine == "libcurl-multi"
            || (task.engine == "aria2"
                && task.torrent_metadata.is_none()
                && (task.url.starts_with("http://") || task.url.starts_with("https://")))
        {
            task.engine = "libcurl-multi".to_string();
            task.engine_id = task.id.clone();
            task.description =
                if task.description.trim().is_empty() || task.description == "Direct download" {
                    "Direct download via libcurl multi".to_string()
                } else {
                    task.description.clone()
                };
            let args = restored
                .curl_args
                .get(&task.id)
                .cloned()
                .unwrap_or_else(|| {
                    let body = CreateDownloadBody {
                        url: Some(task.url.clone()),
                        name: Some(task.name.clone()),
                        file_type: Some(task.file_type.clone()),
                        size_bytes: Some(task.size_bytes),
                        category: Some(task.category.clone()),
                        queue_id: Some(task.queue_id.clone()),
                        connections: Some(task.connections),
                        resumable: Some(task.resumable),
                        save_path: if task.save_path.is_empty() {
                            None
                        } else {
                            Some(task.save_path.clone())
                        },
                        description: Some(task.description.clone()),
                        referer: task.referer.clone(),
                        start_immediately: Some(false),
                        direct_options: None,
                        media_options: None,
                    };
                    crate::daemon::curl::build_curl_args(
                        &body,
                        std::path::Path::new(&task.save_path),
                    )
                    .unwrap_or_default()
                });
            if task.status != "completed" && !args.is_empty() {
                curl_jobs.insert(
                    task.id.clone(),
                    CurlJob {
                        task: task.clone(),
                        args,
                        direct_options: HashMap::new(),
                        cancel_token: Arc::new(AtomicBool::new(false)),
                        run_generation: Arc::new(AtomicU64::new(0)),
                        start_time: Instant::now(),
                        segment_prev_bytes: Vec::new(),
                    },
                );
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
