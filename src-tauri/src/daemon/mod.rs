pub mod curl;
pub mod curl_capabilities;
pub mod diagnostics;
pub mod direct;
pub mod engine;
pub mod engine_capabilities;
pub mod external_tools;
pub mod persist;
pub mod resource_intelligence;
pub mod routes;
pub mod state;
pub mod static_files;
pub mod telegram;
pub mod types;
pub mod utils;
pub mod ytdlp;

use axum::routing::get;
use axum::Router;
use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;

use crate::daemon::state::{AppState, SharedState};
use crate::daemon::static_files::{serve_asset, serve_index, serve_spa_fallback};
use crate::daemon::telegram::start_telegram_bot;
use crate::daemon::types::{CreateDownloadBody, CurlJob, MediaJob, TelegramConfig};
use crate::lock_or_err;

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
    let is_sse_endpoint =
        path == "/api/downloads/events" || path == "/v1/events" || path == "/v1/analyze/progress";
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
                http_client: HttpClient::builder()
                    .pool_idle_timeout(std::time::Duration::from_secs(90))
                    .pool_max_idle_per_host(4)
                    .connect_timeout(std::time::Duration::from_secs(15))
                    .build()
                    .unwrap_or_else(|_| HttpClient::new()),
                resource_dir,
                data_dir: data_dir.clone(),
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
                download_stats: Mutex::new({
                    let mut s = restored.stats.clone();
                    s.session_started_at = Some(chrono::Utc::now().to_rfc3339());
                    s
                }),
                rie: crate::daemon::resource_intelligence::ResourceIntelligenceEngine::new(),
                external_tools: {
                    let http_client = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(30))
                        .build()
                        .unwrap_or_else(|_| reqwest::Client::new());
                    Arc::new(Mutex::new(
                        crate::daemon::external_tools::ExternalToolManager::new(
                            &data_dir,
                            http_client,
                        ),
                    ))
                },
            };

            let state = Arc::new(state);

            log::debug!("Daemon started with API auth enabled");

            // Discover external tools on startup.
            {
                let et = state.external_tools.lock().unwrap();
                et.discover_and_initialize();
            }

            if log::log_enabled!(log::Level::Debug) {
                state.event_bus.subscribe(|event| {
                    log::debug!("engine event #{}: {:?}", event.id, event.event);
                });
            }

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

            // Restore persisted scheduler rules.
            for rule in &restored.scheduler_rules {
                state.scheduler.add_rule(rule.clone());
            }

            crate::daemon::routes::record_daemon_start();
            restore_persisted_tasks(&state, restored);
            persist::start_persistence_loop(state.clone());

            start_telegram_bot(state.clone());

            let app = crate::daemon::routes::register_routes(Router::new())
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
                .layer(CompressionLayer::new())
                .layer(RequestBodyLimitLayer::new(32 * 1024 * 1024));

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
                log::info!("Shutdown signal received; pausing active downloads...");
                {
                    let mut curl = lock_or_err!(shutdown_state.curl_jobs);
                    for job in curl.values_mut() {
                        job.cancel_token
                            .store(true, std::sync::atomic::Ordering::Release);
                        job.task.status = "paused".to_string();
                        job.task.engine_status = Some("shutdown".to_string());
                    }
                }
                {
                    let mut media = lock_or_err!(shutdown_state.media_jobs);
                    for job in media.values_mut() {
                        if let Some(pid) = job.child {
                            crate::daemon::utils::kill_process(pid);
                        }
                        job.task.status = "paused".to_string();
                        job.task.engine_status = Some("shutdown".to_string());
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
                log::info!("Flushing state...");
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
            || (task.engine != "yt-dlp" && task.url.starts_with("http://"))
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
        } else {
            task.status = "error".to_string();
            task.engine_status = Some("unsupported-engine".to_string());
            task.error_message = Some(
                "This download used a removed engine. Re-add it with the libcurl engine."
                    .to_string(),
            );
            task.speed_bytes_per_sec = 0;
        }

        snapshot.insert(task.id.clone(), task);
    }
}
