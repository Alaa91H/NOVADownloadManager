pub mod browser_cookies;
pub mod curl;
pub mod diagnostics;
pub mod direct;
pub mod engine;
pub mod engine_capabilities;
pub mod external_tools;
pub mod persist;
pub mod postprocess;
pub mod resource_intelligence;
pub mod routes;
pub mod state;
pub mod static_files;
pub mod telegram;
pub mod types;
pub mod utils;
pub mod native_media;
pub mod native_torrent;
pub mod torrent_peer;
pub mod torrent_policy;
pub mod torrent_seed;
pub mod torrent_seeding;
pub mod torrent_dht;
pub mod torrent_bandwidth;
pub mod torrent_magnet;
pub mod torrent_storage;
pub mod torrent_task;
pub mod torrent_telemetry;
pub mod torrent_tracker;
pub mod torrent_transfer;

/// Stable Chromium extension origin derived from NOVA's pinned public key.
/// Chrome and Edge enforce this origin as an extension-identity boundary.
pub(crate) const NOVA_CHROMIUM_EXTENSION_ORIGIN: &str =
    "chrome-extension://jplpcjabfbfnmdoofcjchikfcmfbdiej";
/// Header only the native messaging host adds to the local auto-pair request.
/// Browser callers cannot use it because daemon CORS does not allow this header.
pub(crate) const NATIVE_HOST_PAIRING_HEADER: &str = "x-nova-native-host";
pub(crate) const NATIVE_HOST_PAIRING_VALUE: &str = "1";

use axum::routing::get;
use axum::Router;
use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use tokio::sync::oneshot;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;

use crate::daemon::state::{AppState, SharedState};
use crate::daemon::static_files::{serve_asset, serve_index, serve_spa_fallback};
use crate::daemon::telegram::start_telegram_bot;
use crate::daemon::types::{
    transition_task_state, CreateDownloadBody, CurlJob, NativeMediaJob, TaskState,
    TelegramConfig,
};
use crate::lock_or_err;

use crate::daemon::engine::extractor::{ExtractorRegistry, SharedExtractorRegistry};
use crate::daemon::engine::priority_queue::{DownloadPriority, QueueEntry};

fn is_allowed_cors_origin(origin: &axum::http::HeaderValue) -> bool {
    let bytes = origin.as_bytes();
    // Reject null origin — it allows arbitrary local HTML files to access the
    // loopback daemon without a trustworthy browser origin.
    if bytes == b"null" {
        return false;
    }
    let allowed_loopback = bytes == b"http://127.0.0.1"
        || bytes == b"http://localhost"
        || bytes.starts_with(b"http://127.0.0.1:")
        || bytes.starts_with(b"http://localhost:")
        || bytes.starts_with(b"tauri://localhost")
        || bytes.starts_with(b"https://tauri.localhost")
        || bytes.starts_with(b"http://tauri.localhost");
    // Chromium derives a stable origin from NOVA's public key. Firefox uses a
    // profile-local UUID, so it remains allowed only for already-authenticated
    // requests; its pairing flow is constrained to Native Messaging.
    let allowed_extension = bytes == NOVA_CHROMIUM_EXTENSION_ORIGIN.as_bytes()
        || bytes.starts_with(b"moz-extension://");
    allowed_loopback || allowed_extension
}

/// External shutdown signal, set by the host process (Tauri) to trigger
/// graceful daemon shutdown via the `graceful_shutdown` future.
static SHUTDOWN_TX: std::sync::Mutex<Option<oneshot::Sender<()>>> = std::sync::Mutex::new(None);
/// Whether the daemon thread is alive. The integration host uses this to exit
/// after a graceful signal-driven shutdown rather than lingering indefinitely.
static DAEMON_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn is_running() -> bool {
    DAEMON_RUNNING.load(std::sync::atomic::Ordering::Acquire)
}

/// Request the running daemon to shut down gracefully. Safe from any thread.
pub fn signal_shutdown() {
    if let Ok(mut guard) = SHUTDOWN_TX.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
}

/// Generate a random 32-char hex token for API authentication.
fn generate_api_token() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}

/// The API token shared between the daemon (which validates it) and the Tauri
/// command layer (which hands it to the trusted desktop webview). Initialised
/// once per process, so it stays stable across daemon restarts.
pub fn shared_api_token() -> String {
    static API_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    API_TOKEN
        .get_or_init(|| {
            // A deterministic token is permitted only for the explicit
            // integration process. It lets browser-driven tests authenticate
            // with a real daemon without exposing or weakening production
            // tokens, which remain per-process random values.
            if crate::is_integration_mode() {
                if let Ok(token) = std::env::var("NOVA_INTEGRATION_API_TOKEN") {
                    if token.len() >= 24 {
                        return token;
                    }
                    log::warn!(
                        "Ignoring NOVA_INTEGRATION_API_TOKEN shorter than the required 24 characters"
                    );
                }
            }
            generate_api_token()
        })
        .clone()
}

/// Path used for request/response log lines, with the SSE `token` query
/// parameter redacted so the shared API token never lands in the log file.
fn loggable_path(uri: &axum::http::Uri) -> String {
    let path = uri.path();
    let Some(query) = uri.query() else {
        return path.to_owned();
    };
    if !query.contains("token=") {
        return format!("{path}?{query}");
    }
    let redacted: Vec<String> = query
        .split('&')
        .map(|pair| {
            if let Some((key, _value)) = pair.split_once('=') {
                if key == "token" {
                    "token=***".to_owned()
                } else {
                    pair.to_owned()
                }
            } else {
                pair.to_owned()
            }
        })
        .collect();
    format!("{path}?{}", redacted.join("&"))
}

/// Outermost middleware: logs every HTTP request/response with method, path
/// (token-redacted), status, and duration, so any daemon interaction can be
/// traced precisely.
async fn request_log_middleware(
    request: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::http::Response<axum::body::Body> {
    let method = request.method().clone();
    let path = loggable_path(request.uri());
    let started = std::time::Instant::now();
    log::trace!("HTTP -> {method} {path}");
    let response = next.run(request).await;
    let status = response.status();
    let elapsed = started.elapsed();
    let noisy = path == "/api/health" || path.starts_with("/v1/ping");
    let level = if status.is_server_error() {
        log::Level::Error
    } else if status.is_client_error() || elapsed.as_millis() >= 1000 {
        log::Level::Warn
    } else if noisy {
        log::Level::Trace
    } else {
        log::Level::Debug
    };
    log::log!(
        level,
        "HTTP <- {} {} ({:?})",
        status.as_u16(),
        path,
        elapsed
    );
    response
}

/// Middleware that enforces Bearer token authentication on API routes.
/// Exempt paths: /api/health, /api/engines/capabilities, /v1/pair/auto,
/// / (SPA index), /assets/*, and SPA fallback.
async fn auth_middleware(
    axum::extract::State(state): axum::extract::State<SharedState>,
    request: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> Result<axum::http::Response<axum::body::Body>, axum::http::StatusCode> {
    let path = request.uri().path();

    // NOTE: do NOT use `path.starts_with("/api/engines/")` here — that would
    // exempt every engine route (including POST /api/engines/download which
    // downloads & executes binaries) from authentication. Only capabilities
    // is public. Likewise, avoid `ends_with(".js")`-style exemptions: any
    // path like `/api/downloads/secret.js` would bypass auth.
    let exempt = path == "/api/health"
        || path == "/api/engines/capabilities"
        || path == "/v1/pair/auto"
        || path == "/v1/ping"
        || path == "/"
        || path.starts_with("/assets/")
        || path == "/index.html";

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
                        log::warn!(
                            "SSE token accepted via URL query parameter on {path}; \
                             the token can leak into browser history, Referer headers, \
                             and proxy/access logs. Prefer a fetch-based stream that sends \
                             the token in an Authorization header."
                        );
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
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_default();
    let candidates = [
        resource_path.join("bin").join(binary_name),
        resource_path.join("..").join("bin").join(binary_name),
        exe_dir.join("resources").join("bin").join(binary_name),
        exe_dir.join("bin").join(binary_name),
        manifest_dir.join("..").join("bin").join(binary_name),
    ];

    if let Some(candidate) = candidates.into_iter().find(|c| c.exists()) {
        return candidate.display().to_string();
    }

    log::error!(
        "{binary_name} not found in bundled locations; falling back to PATH lookup. \
     This may be a security risk if PATH has been tampered with."
    );

    if let Some(path) = find_on_path(binary_name) {
        if cfg!(target_os = "windows") && !verify_authenticode_signature(&path) {
            log::error!(
                "{} found on PATH but Authenticode signature is not valid; refusing to use it",
                binary_name
            );
            return binary_name.to_owned();
        }
        return path.display().to_string();
    }

    binary_name.to_owned()
}

fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let is_windows = cfg!(target_os = "windows");
    for dir in std::env::split_paths(&path_var) {
        if dir == std::path::Path::new(".") || dir == std::path::Path::new("") {
            continue;
        }
        let candidate = if is_windows {
            let with_exe = dir.join(format!("{}.exe", name));
            if with_exe.exists() {
                with_exe
            } else {
                dir.join(name)
            }
        } else {
            dir.join(name)
        };
        if candidate.exists() && candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn verify_authenticode_signature(path: &std::path::Path) -> bool {
    let verify = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "if (Get-AuthenticodeSignature '{}').Status -eq 'Valid' {{ exit 0 }} else {{ exit 1 }}",
                path.display()
            ),
        ])
        .output();
    match verify {
        Ok(output) => output.status.success(),
        Err(e) => {
            log::error!(
                "Failed to verify Authenticode signature for {}: {e}",
                path.display()
            );
            false
        }
    }
}

async fn wait_for_daemon_shutdown(shutdown_rx: oneshot::Receiver<()>) {
    #[cfg(unix)]
    {
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = async {
                if let Some(signal) = sigterm.as_mut() {
                    signal.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {},
            _ = shutdown_rx => {},
        }
    }

    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = shutdown_rx => {},
        }
    }
}

pub fn start_daemon(resource_dir: String, data_dir: String, port: u16) {
    // Initialise SSL for the curl engine (bundled CA cert)
    crate::daemon::curl::init_download_ssl();
    DAEMON_RUNNING.store(true, std::sync::atomic::Ordering::Release);
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let rt = match tokio::runtime::Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("Failed to create tokio runtime: {e}");
                    return;
                }
            };
            rt.block_on(async {
                if let Err(e) = std::fs::create_dir_all(&data_dir) {
                    log::warn!("Failed to create data directory: {e}");
                }
                let restored = persist::load(&data_dir);
                let ffmpeg_binary = if cfg!(windows) {
                    "ffmpeg.exe"
                } else {
                    "ffmpeg"
                };
                let ffmpeg_bin = resolve_engine_binary(&resource_dir, ffmpeg_binary);

                // Build extractor registry
                let mut extractor_registry = ExtractorRegistry::new();
                extractor_registry
                    .register(std::sync::Arc::new(crate::daemon::curl::CurlExtractor));
                extractor_registry.register(std::sync::Arc::new(
                    crate::daemon::native_media::NativeMediaExtractor,
                ));
                let extractor_registry = SharedExtractorRegistry::new(extractor_registry);
                let torrent_dht = crate::daemon::torrent_dht::DhtService::load_or_new(&data_dir);

                let state = AppState {
                    native_media_jobs: Mutex::new(HashMap::new()),
                    torrent_jobs: Mutex::new(HashMap::new()),
                    torrent_analyses: Mutex::new(HashMap::new()),
                    curl_jobs: Mutex::new(HashMap::new()),
                    task_snapshot: Mutex::new(HashMap::new()),
                    capture_reviews: Mutex::new(std::collections::VecDeque::new()),
                    persist_dirty: std::sync::atomic::AtomicBool::new(false),
                    telegram_config: Mutex::new(TelegramConfig::default()),
                    telegram_last_update_id: Mutex::new(restored.telegram_last_update_id),
                    http_client: HttpClient::builder()
                        .pool_idle_timeout(std::time::Duration::from_secs(90))
                        .pool_max_idle_per_host(4)
                        .connect_timeout(std::time::Duration::from_secs(15))
                        // Deep-but-valid redirect chains (CDNs, mirror farms)
                        // must survive probe + download. reqwest's default (10)
                        // fails chains the curl engine would happily follow
                        // (curl's own default limit is 50).
                        .redirect(reqwest::redirect::Policy::limited(50))
                        .build()
                        .unwrap_or_else(|_| {
                            // M4: the fallback client must also have timeouts
                            // (a bare HttpClient::new() could hang forever).
                            HttpClient::builder()
                                .connect_timeout(std::time::Duration::from_secs(15))
                                .timeout(std::time::Duration::from_secs(60))
                                .build()
                                .unwrap_or_else(|_| HttpClient::new())
                        }),
                    resource_dir,
                    data_dir: data_dir.clone(),
                    ffmpeg_bin: std::sync::RwLock::new(ffmpeg_bin.clone()),
                    bundled_ffmpeg_bin: ffmpeg_bin,
                    engine_capabilities_cache: std::sync::RwLock::new(None),
                    engine_capabilities_probe: Mutex::new(()),
                    task_generation: std::sync::atomic::AtomicU64::new(0),
                    task_list_cache: std::sync::RwLock::new(None),
                    event_bus: crate::daemon::engine::event_bus::EventBus::new_with_capacity(
                        10_000,
                    ),
                    priority_queue:
                        crate::daemon::engine::priority_queue::PriorityBandwidthQueue::new(0),
                    bandwidth_manager: crate::daemon::engine::bandwidth::BandwidthManager::default(
                    ),
                    torrent_dht,
                    profile_manager: crate::daemon::engine::profiles::ProfileManager::new(),
                    rule_engine: crate::daemon::engine::rules::DownloadRuleEngine::new(),
                    scheduler: crate::daemon::engine::scheduler::SmartScheduler::new(),
                    metadata_cache: crate::daemon::engine::metadata_cache::MetadataCache::with_ttl(
                        std::time::Duration::from_secs(3600),
                    ),
                    default_retry_policy: std::sync::RwLock::new(
                        crate::daemon::engine::config::global_config().retry_policy(),
                    ),
                    plugin_api: crate::daemon::engine::plugin_api::PluginApi::new(),
                    engine_trackers: RwLock::new(HashMap::new()),
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
                    policy_engine: {
                        let pe = crate::daemon::engine::policy_engine::PolicyEngine::new();
                        Arc::new(Mutex::new(pe))
                    },
                    self_healer: {
                        let pe_ref = Arc::new(Mutex::new(
                            crate::daemon::engine::policy_engine::PolicyEngine::new(),
                        ));
                        Arc::new(Mutex::new(
                            crate::daemon::engine::self_healing::SelfHealer::new(pe_ref),
                        ))
                    },
                    die_orchestrator: Arc::new(Mutex::new(
                        crate::daemon::engine::die_orchestrator::DieOrchestrator::new(),
                    )),
                    resource_manager: Arc::new(Mutex::new(
                        crate::daemon::engine::resource_manager::ResourceManager::new(),
                    )),
                    shutdown_requested: std::sync::atomic::AtomicBool::new(false),
                    watchdog_handles: Mutex::new(Vec::new()),
                };

                let state = Arc::new(state);

                log::debug!("Daemon started with API auth enabled");

                // Discover the public post-processing backend before probing
                // engine capabilities. Media extraction itself is in-process
                // and must not depend on compatibility executables.
                let discovered_tools = {
                    let et = state.external_tools.clone();
                    tokio::task::spawn_blocking(move || {
                        let et = lock_or_err!(et);
                        vec![et.discover(
                            crate::daemon::external_tools::types::ToolId::Ffmpeg,
                        )]
                    })
                    .await
                    .unwrap_or_else(|error| {
                        log::error!("External tool discovery panicked: {error}");
                        Vec::new()
                    })
                };
                for installation in discovered_tools {
                    if installation.health_ok {
                        if let Some(path) = installation.path {
                            if let Err(error) = state.activate_external_tool(
                                installation.tool_id,
                                path.display().to_string(),
                            ) {
                                log::warn!(
                                    "Verified {} but could not activate it: {error}",
                                    installation.tool_id
                                );
                            }
                        }
                    }
                }

                // Warm the engine-capability cache after post-processing tool
                // activation. Media extraction readiness comes from the compiled core.
                {
                    let warm_state = state.clone();
                    std::thread::spawn(move || {
                        let _ = warm_state.engine_capabilities();
                        log::debug!("Engine capability cache warmed");
                    });
                }

                if log::log_enabled!(log::Level::Debug) {
                    state.event_bus.subscribe(|event| {
                        log::debug!("engine event #{}: {:?}", event.id, event.event);
                    });
                }

                // Periodic smart-scheduler evaluation: applies time-window and
                // bandwidth-triggered rules (pause/start/limit/notify) for real.
                //
                // Runs on a dedicated OS thread with its own current-thread tokio
                // runtime instead of `spawn_blocking` + `block_on`, so a tick can
                // never occupy (and exhaust) a blocking-thread-pool worker.
                let scheduler_state = state.clone();
                std::thread::spawn(move || {
                    let rt = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt,
                        Err(e) => {
                            log::error!("Failed to create scheduler runtime: {e}");
                            return;
                        }
                    };
                    rt.block_on(async move {
                        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
                        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                        loop {
                            ticker.tick().await;
                            let state = scheduler_state.clone();
                            // Spawn the tick as a task so a panic is captured by
                            // the JoinHandle instead of killing the scheduler
                            // thread (tokio logs task panics and keeps going).
                            let handle = tokio::task::spawn(async move {
                                crate::daemon::routes::run_scheduler_tick(&state).await;
                            });
                            if let Err(join_err) = handle.await {
                                let msg = match join_err.try_into_panic() {
                                    Ok(panic) => {
                                        if let Some(s) = panic.downcast_ref::<&str>() {
                                            (*s).to_owned()
                                        } else if let Some(s) = panic.downcast_ref::<String>() {
                                            s.clone()
                                        } else {
                                            "unknown".to_owned()
                                        }
                                    }
                                    Err(_) => "task cancelled".to_owned(),
                                };
                                log::error!("Scheduler tick panicked: {msg}");
                            }
                        }
                    });
                });

                // Restore persisted scheduler rules.
                for rule in &restored.scheduler_rules {
                    state.scheduler.add_rule(rule.clone());
                }

                crate::daemon::routes::record_daemon_start();
                restore_persisted_tasks(&state, restored);
                persist::start_persistence_loop(state.clone());

                start_telegram_bot(state.clone(), rt.handle().clone());

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
                             _parts: &axum::http::request::Parts| is_allowed_cors_origin(origin),
                        ))
                        .allow_methods([
                            axum::http::Method::GET,
                            axum::http::Method::POST,
                            axum::http::Method::PATCH,
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
                .layer(RequestBodyLimitLayer::new(32 * 1024 * 1024))
                .layer(axum::middleware::from_fn(request_log_middleware));

                let addr = format!("127.0.0.1:{port}");
                log::info!("NOVA daemon starting on {addr}");

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
                let listener = if let Some(l) = listener {
                    l
                } else {
                    log::error!("Failed to bind daemon to {addr} after 5 retries");
                    return;
                };

                // Write the bound port + PID to a file so the native messaging host
                // and browser extension can discover it, and so we can kill only the
                // correct process on restart (not other services on the port range).
                let port_file = std::path::Path::new(&data_dir).join("nova-daemon.port");
                if let Err(e) =
                    std::fs::write(&port_file, format!("{}\n{}", port, std::process::id()))
                {
                    log::warn!("Failed to write daemon port file: {e}");
                }
                let (shutdown_tx, shutdown_rx) = oneshot::channel();
                *SHUTDOWN_TX.lock().unwrap() = Some(shutdown_tx);
                let shutdown_state = state.clone();
                let shutdown_signal = async move {
                    wait_for_daemon_shutdown(shutdown_rx).await;
                    log::info!("Shutdown signal received; pausing active downloads...");
                    crate::daemon::torrent_task::shutdown_torrent_tasks(&shutdown_state).await;
                    // Snapshot first-party libcurl jobs before persisting shutdown state.
                    let curl_shutdown_snapshots = {
                        let mut curl = lock_or_err!(shutdown_state.curl_jobs);
                        let mut snapshots = Vec::with_capacity(curl.len());
                        for job in curl.values_mut() {
                            job.cancel_token
                                .store(true, std::sync::atomic::Ordering::Release);
                            let current = TaskState::from_status(&job.task.status);
                            if current != Some(TaskState::Completed) {
                                if let Err(error) = transition_task_state(
                                    &mut job.task,
                                    TaskState::Paused,
                                    "shutdown",
                                ) {
                                    // Verifying/finalizing deliberately cannot
                                    // be paused mid-commit. Leave that active
                                    // state intact; restart recovery will mark
                                    // it interrupted if the worker does not
                                    // finish during the shutdown grace period.
                                    log::info!(
                                        "Task {} kept in state '{}' during shutdown: {error}",
                                        job.task.id,
                                        job.task.status
                                    );
                                }
                            }
                            job.task.speed_bytes_per_sec = 0;
                            snapshots.push(job.task.clone());
                        }
                        snapshots
                    };
                    {
                        let mut snapshot = lock_or_err!(shutdown_state.task_snapshot);
                        for task in curl_shutdown_snapshots {
                            snapshot.insert(task.id.clone(), task);
                        }
                    }
                    shutdown_state.mark_dirty();
                    // Signal watchdog threads to exit.
                    shutdown_state
                        .shutdown_requested
                        .store(true, std::sync::atomic::Ordering::Release);
                    // Join watchdog handles (they will exit on next check loop after
                    // shutdown_requested is set).
                    // Take the Vec out of the Mutex first so the lock is not held
                    // during the potentially-blocking join() calls.
                    let handles =
                        std::mem::take(&mut *lock_or_err!(shutdown_state.watchdog_handles));
                    for h in handles {
                        // Do not let a stuck watchdog block shutdown forever —
                        // give each thread a bounded grace period.
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(2);
                        while !h.is_finished() && std::time::Instant::now() < deadline {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                        if h.is_finished() {
                            let _ = h.join();
                        } else {
                            log::warn!(
                                "Watchdog thread did not exit within grace period; detaching"
                            );
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    log::info!("Flushing state...");
                    crate::daemon::persist::save_now(&shutdown_state);
                    log::info!("State saved; shutting down daemon.");
                };
                if let Err(e) = axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
                )
                .with_graceful_shutdown(shutdown_signal)
                .await
                {
                    log::error!("Daemon server error: {e}");
                }
                // Remove the port file on clean shutdown.
                let _ =
                    std::fs::remove_file(std::path::Path::new(&data_dir).join("nova-daemon.port"));
            });
        }));
        if let Err(panic) = result {
            let msg = if let Some(s) = panic.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown".to_owned()
            };
            log::error!("Daemon thread panicked: {msg}");
        }
        DAEMON_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    });
}

/// Validate a persisted direct-download completion against the durable file.
///
/// A persisted `completed` flag is only a historical claim. The destination
/// may have been deleted, truncated, replaced by a directory, or otherwise
/// changed while NOVA was not running. Never restore such a task as completed
/// unless the file still exists and its byte count matches the committed task.
fn validate_restored_direct_completion(task: &crate::daemon::types::Task) -> Result<(), String> {
    let expected = if task.downloaded_bytes > 0 {
        task.downloaded_bytes
    } else {
        task.size_bytes
    };
    if expected == 0 {
        return Err("Completed download has no committed byte count.".to_owned());
    }

    let path = std::path::Path::new(&task.save_path);
    let metadata = std::fs::metadata(path).map_err(|error| {
        format!(
            "Completed file is no longer available at {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "Completed destination is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() != expected {
        return Err(format!(
            "Completed file changed on disk: expected {expected} bytes, found {} bytes at {}",
            metadata.len(),
            path.display()
        ));
    }

    Ok(())
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

    let resume_requires_reauth = restored.resume_requires_reauth.clone();
    let recovery_checkpoints = restored.recovery_checkpoints.clone();
    let torrent_sources = restored.torrent_sources.clone();
    let torrent_seeding = restored.torrent_seeding.clone();
    for mut task in restored.tasks {
        if let Some(checkpoint) = recovery_checkpoints.get(&task.id) {
            if !checkpoint.apply_to_task(&mut task) {
                log::warn!(
                    "Ignoring incompatible recovery checkpoint for task {}",
                    task.id
                );
            }
        }

        let is_direct_download = task.engine == "curl"
            || task.engine == "libcurl-multi"
            || (task.engine != "media-bridge"
                && task.engine != "nova-media-engine"
                && (task.url.starts_with("http://") || task.url.starts_with("https://")));

        // P0 crash/restart consistency: a persisted completed state must still
        // agree with the filesystem before it is exposed as completed again.
        if task.status == "completed"
            && (is_direct_download || task.engine == "nova-media-engine")
        {
            if let Err(error) = validate_restored_direct_completion(&task) {
                log::warn!("Task {}: invalid persisted completion: {error}", task.id);
                task.status = "error".to_owned();
                task.engine_status = Some("completion-invalid".to_owned());
                task.error_message = Some(error);
                task.speed_bytes_per_sec = 0;
                task.time_left_seconds = 0;
            }
        }

        let restored_state = TaskState::from_status(&task.status);
        let was_running =
            restored_state.is_some_and(|state| state.is_active() || state == TaskState::Queued);
        if was_running {
            // A process restart interrupts every active phase, including the
            // new Verifying/Finalizing states. Preserve the public paused
            // compatibility state while recording the interruption reason.
            task.status = TaskState::Paused.as_status().to_owned();
            task.engine_status = Some("interrupted".to_owned());
            task.speed_bytes_per_sec = 0;
        }

        let requires_reauth = resume_requires_reauth.contains(&task.id);
        if requires_reauth
            && task.engine != nova_torrent_core::ENGINE_ID
            && task.status != "completed"
        {
            task.status = "error".to_owned();
            task.engine_status = Some("reauth-required".to_owned());
            task.error_message = Some(
                "This interrupted download used credentials or session data that were not saved to disk. Re-add it and authorize again to continue."
                    .to_owned(),
            );
            task.speed_bytes_per_sec = 0;
        } else if task.engine == nova_torrent_core::ENGINE_ID {
            let source = torrent_sources
                .get(&task.id)
                .cloned()
                .or_else(|| (!task.url.trim().is_empty()).then(|| task.url.clone()));

            if requires_reauth && task.status != "completed" {
                task.status = TaskState::Failed.as_status().to_owned();
                task.engine_status = Some("reauth-required".to_owned());
                task.error_message = Some(
                    "This torrent used tracker authorization that was not saved to disk. Re-authorize the magnet link to continue."
                        .to_owned(),
                );
                task.speed_bytes_per_sec = 0;
                task.time_left_seconds = 0;
            }

            match crate::daemon::torrent_task::restore_torrent_job(
                task.clone(),
                source,
                requires_reauth,
                state.bandwidth_manager.clone(),
                torrent_seeding.get(&task.id).cloned(),
            ) {
                Ok(job) => {
                    let allocation = job.allocated_kbps.clone();
                    if task.status != "completed" && task.status != "error" {
                        state.priority_queue.enqueue(QueueEntry {
                            task_id: task.id.clone(),
                            priority: DownloadPriority::Normal,
                            added_at: Instant::now(),
                            size_bytes: task.size_bytes,
                            bandwidth_kbps: allocation,
                        });
                    }
                    if let Ok(mut jobs) = state.torrent_jobs.lock() {
                        jobs.insert(task.id.clone(), job);
                    }
                }
                Err(error) => {
                    task.status = TaskState::Failed.as_status().to_owned();
                    task.engine_status = Some("torrent-resume-invalid".to_owned());
                    task.error_message = Some(format!(
                        "The persisted torrent job could not be restored: {error}"
                    ));
                    task.speed_bytes_per_sec = 0;
                    task.time_left_seconds = 0;
                }
            }
        } else if task.engine == "media-bridge" {
            if task.status != "completed" {
                task.status = "error".to_owned();
                task.engine_status = Some("engine-retired".to_owned());
                task.error_message = Some(
                    "This task used the retired Media Bridge engine. Re-add the original media URL to migrate it to NOVA Media Engine."
                        .to_owned(),
                );
                task.speed_bytes_per_sec = 0;
                task.time_left_seconds = 0;
            }
        } else if task.engine == "nova-media-engine" {
            let request = restored.native_media_requests.get(&task.id).cloned();
            if task.status != "completed" {
                if let Some(request) = request {
                    if let Ok(mut jobs) = state.native_media_jobs.lock() {
                        jobs.insert(
                            task.id.clone(),
                            NativeMediaJob {
                                task: task.clone(),
                                request,
                                protocol: restored
                                    .native_media_protocols
                                    .get(&task.id)
                                    .cloned()
                                    .unwrap_or_else(|| {
                                        if task.segments.len() == 2 {
                                            "separate-tracks".to_owned()
                                        } else {
                                            "manifest".to_owned()
                                        }
                                    }),
                                cancel_token: Arc::new(AtomicBool::new(false)),
                                run_generation: Arc::new(AtomicU64::new(0)),
                                start_time: Instant::now(),
                            },
                        );
                    }
                } else {
                    task.status = "error".to_owned();
                    task.engine_status = Some("native-request-missing".to_owned());
                    task.error_message = Some(
                        "The native media request could not be restored. Re-add the media URL to continue."
                            .to_owned(),
                    );
                }
            }
        } else if task.engine == "curl"
            || task.engine == "libcurl-multi"
            || (task.engine != "media-bridge"
                && task.engine != "nova-media-engine"
                && (task.url.starts_with("http://") || task.url.starts_with("https://")))
        {
            task.engine = "libcurl-multi".to_owned();
            task.engine_id = task.id.clone();
            task.description =
                if task.description.trim().is_empty() || task.description == "Direct download" {
                    "Direct download via libcurl multi".to_owned()
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
            if task.status != "completed" {
                if let Ok(mut jobs) = state.curl_jobs.lock() {
                    jobs.insert(
                        task.id.clone(),
                        CurlJob {
                            task: task.clone(),
                            direct_options: {
                                let mut options = restored
                                    .curl_direct_options
                                    .get(&task.id)
                                    .cloned()
                                    .unwrap_or_default();
                                if let Some(checkpoint) = recovery_checkpoints.get(&task.id) {
                                    if let Some(etag) = checkpoint.resource.etag.as_ref() {
                                        options.entry("etag".to_owned()).or_insert_with(|| {
                                            serde_json::Value::String(etag.clone())
                                        });
                                    }
                                    if let Some(last_modified) =
                                        checkpoint.resource.last_modified.as_ref()
                                    {
                                        options.entry("lastModified".to_owned()).or_insert_with(
                                            || serde_json::Value::String(last_modified.clone()),
                                        );
                                    }
                                    if let Some(effective_url) =
                                        checkpoint.resource.effective_url.as_ref()
                                    {
                                        options.entry("effectiveUrl".to_owned()).or_insert_with(
                                            || serde_json::Value::String(effective_url.clone()),
                                        );
                                    }
                                }
                                options
                            },
                            cancel_token: Arc::new(AtomicBool::new(false)),
                            run_generation: Arc::new(AtomicU64::new(0)),
                            start_time: Instant::now(),
                            segment_prev_bytes: Vec::new(),
                            args,
                        },
                    );
                }
            } else {
                // Ensure `args` is used even for completed tasks to satisfy the compiler
                let _ = args;
            }
        } else {
            task.status = "error".to_owned();
            task.engine_status = Some("unsupported-engine".to_owned());
            task.error_message = Some(
                "This download used a removed engine. Re-add it with the libcurl engine."
                    .to_owned(),
            );
            task.speed_bytes_per_sec = 0;
        }

        if task.status != "completed" && task.status != "error" {
            state.priority_queue.enqueue(QueueEntry {
                task_id: task.id.clone(),
                priority: DownloadPriority::Normal,
                added_at: Instant::now(),
                size_bytes: task.size_bytes,
                bandwidth_kbps: Arc::new(AtomicU64::new(0)),
            });
        }

        if let Ok(mut snapshot) = state.task_snapshot.lock() {
            snapshot.insert(task.id.clone(), task);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::types::Task;

    #[test]
    fn cors_allows_local_ui_and_pinned_chromium_extension_only() {
        use axum::http::HeaderValue;

        assert!(is_allowed_cors_origin(&HeaderValue::from_static(
            "http://127.0.0.1:3199"
        )));
        assert!(is_allowed_cors_origin(&HeaderValue::from_static(
            NOVA_CHROMIUM_EXTENSION_ORIGIN,
        )));
        assert!(!is_allowed_cors_origin(&HeaderValue::from_static(
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )));
        assert!(!is_allowed_cors_origin(&HeaderValue::from_static("null")));
    }

    fn restoration_test_task(id: &str, status: &str) -> Task {
        Task {
            id: id.to_owned(),
            name: format!("restoration-{id}"),
            url: format!("https://example.com/{id}"),
            file_type: "other".to_owned(),
            status: status.to_owned(),
            size_bytes: 100,
            downloaded_bytes: 25,
            speed_bytes_per_sec: 42,
            time_left_seconds: 2,
            elapsed_seconds: 1,
            date_added: "2026-08-21".to_owned(),
            category: "other".to_owned(),
            queue_id: "main".to_owned(),
            connections: 1,
            resumable: true,
            save_path: std::env::temp_dir()
                .join(format!("{id}.bin"))
                .display()
                .to_string(),
            description: "Direct download".to_owned(),
            segments: Vec::new(),
            referer: None,
            engine: "libcurl-multi".to_owned(),
            engine_id: id.to_owned(),
            engine_status: Some(status.to_owned()),
            error_message: None,
        }
    }

    #[test]
    fn restoration_converts_transitioning_tasks_to_paused_after_crash() {
        let data_dir = std::env::temp_dir().join(format!(
            "nova-restore-transition-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).expect("create test data directory");
        let data_dir_string = data_dir.display().to_string();
        let state = Arc::new(persist::tests::test_state(&data_dir_string));
        let mut checkpoint_task = restoration_test_task("pausing", "pausing");
        checkpoint_task.downloaded_bytes = 321;
        checkpoint_task.speed_bytes_per_sec = 777;
        let checkpoint = nova_core_model::RecoveryCheckpoint::from_task(
            &checkpoint_task,
            nova_core_model::ResourceIdentity {
                etag: Some("\"restore-v1\"".to_owned()),
                content_length: Some(checkpoint_task.size_bytes),
                ..Default::default()
            },
        );
        let restored = persist::PersistedState {
            tasks: vec![
                restoration_test_task("pausing", "pausing"),
                restoration_test_task("stopping", "stopping"),
            ],
            recovery_checkpoints: HashMap::from([("pausing".to_owned(), checkpoint)]),
            ..Default::default()
        };

        restore_persisted_tasks(&state, restored);

        let snapshot = state.task_snapshot.lock().expect("lock restored snapshot");
        for id in ["pausing", "stopping"] {
            let task = snapshot.get(id).expect("restored transition task");
            assert_eq!(task.status, "paused");
            assert_eq!(task.engine_status.as_deref(), Some("interrupted"));
            assert_eq!(task.speed_bytes_per_sec, 0);
        }
        assert_eq!(
            snapshot
                .get("pausing")
                .expect("checkpoint-restored task")
                .downloaded_bytes,
            321
        );
        drop(snapshot);
        assert_eq!(state.curl_jobs.lock().expect("lock curl jobs").len(), 2);
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn restoration_rebuilds_native_media_job_from_persisted_request() {
        let data_dir = std::env::temp_dir().join(format!(
            "nova-restore-native-media-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).expect("create test data directory");
        let data_dir_string = data_dir.display().to_string();
        let state = Arc::new(persist::tests::test_state(&data_dir_string));

        let mut task = restoration_test_task("native-media", "downloading");
        task.engine = "nova-media-engine".to_owned();
        task.description = "Native media download".to_owned();

        let request = CreateDownloadBody {
            url: Some(task.url.clone()),
            name: Some(task.name.clone()),
            file_type: Some(task.file_type.clone()),
            size_bytes: Some(task.size_bytes),
            category: Some(task.category.clone()),
            queue_id: Some(task.queue_id.clone()),
            connections: Some(task.connections),
            resumable: Some(task.resumable),
            save_path: Some(task.save_path.clone()),
            description: Some(task.description.clone()),
            referer: None,
            start_immediately: Some(false),
            direct_options: None,
            media_options: None,
        };

        restore_persisted_tasks(
            &state,
            persist::PersistedState {
                tasks: vec![task],
                native_media_requests: HashMap::from([("native-media".to_owned(), request)]),
                native_media_protocols: HashMap::from([(
                    "native-media".to_owned(),
                    "manifest".to_owned(),
                )]),
                ..Default::default()
            },
        );

        let jobs = state
            .native_media_jobs
            .lock()
            .expect("lock restored native media jobs");
        let job = jobs.get("native-media").expect("restored native media job");
        assert_eq!(job.protocol, "manifest");
        assert_eq!(job.task.status, "paused");
        assert_eq!(job.task.engine_status.as_deref(), Some("interrupted"));
        assert_eq!(
            job.request.url.as_deref(),
            Some("https://example.com/native-media")
        );
        drop(jobs);

        let snapshot = state.task_snapshot.lock().expect("lock restored snapshot");
        let restored = snapshot.get("native-media").expect("restored native media task");
        assert_eq!(restored.status, "paused");
        assert_eq!(restored.engine, "nova-media-engine");
        drop(snapshot);

        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn restoration_keeps_completed_direct_task_only_when_file_matches() {
        let data_dir = std::env::temp_dir().join(format!(
            "nova-restore-complete-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).expect("create test data directory");
        let data_dir_string = data_dir.display().to_string();
        let state = Arc::new(persist::tests::test_state(&data_dir_string));

        let output = data_dir.join("complete.bin");
        std::fs::write(&output, vec![7u8; 100]).expect("write completed file");
        let mut task = restoration_test_task("complete", "completed");
        task.save_path = output.display().to_string();
        task.size_bytes = 100;
        task.downloaded_bytes = 100;

        restore_persisted_tasks(
            &state,
            persist::PersistedState {
                tasks: vec![task],
                ..Default::default()
            },
        );

        let snapshot = state.task_snapshot.lock().expect("lock restored snapshot");
        let restored = snapshot.get("complete").expect("restored completed task");
        assert_eq!(restored.status, "completed");
        assert_eq!(restored.engine_status.as_deref(), Some("completed"));
        drop(snapshot);
        assert!(state.curl_jobs.lock().expect("lock curl jobs").is_empty());
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn restoration_invalidates_completed_direct_task_when_file_is_missing() {
        let data_dir = std::env::temp_dir().join(format!(
            "nova-restore-missing-complete-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).expect("create test data directory");
        let data_dir_string = data_dir.display().to_string();
        let state = Arc::new(persist::tests::test_state(&data_dir_string));

        let mut task = restoration_test_task("missing-complete", "completed");
        task.save_path = data_dir.join("missing.bin").display().to_string();
        task.size_bytes = 100;
        task.downloaded_bytes = 100;

        restore_persisted_tasks(
            &state,
            persist::PersistedState {
                tasks: vec![task],
                ..Default::default()
            },
        );

        let snapshot = state.task_snapshot.lock().expect("lock restored snapshot");
        let restored = snapshot
            .get("missing-complete")
            .expect("restored invalid completion");
        assert_eq!(restored.status, "error");
        assert_eq!(
            restored.engine_status.as_deref(),
            Some("completion-invalid")
        );
        assert!(restored
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("no longer available")));
        drop(snapshot);
        assert!(state
            .curl_jobs
            .lock()
            .expect("lock curl jobs")
            .contains_key("missing-complete"));
        assert!(state.priority_queue.entries().is_empty());
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn restoration_invalidates_completed_direct_task_when_size_changed() {
        let data_dir = std::env::temp_dir().join(format!(
            "nova-restore-size-drift-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).expect("create test data directory");
        let data_dir_string = data_dir.display().to_string();
        let state = Arc::new(persist::tests::test_state(&data_dir_string));

        let output = data_dir.join("changed.bin");
        std::fs::write(&output, vec![3u8; 40]).expect("write changed file");
        let mut task = restoration_test_task("size-drift", "completed");
        task.save_path = output.display().to_string();
        task.size_bytes = 100;
        task.downloaded_bytes = 100;

        restore_persisted_tasks(
            &state,
            persist::PersistedState {
                tasks: vec![task],
                ..Default::default()
            },
        );

        let snapshot = state.task_snapshot.lock().expect("lock restored snapshot");
        let restored = snapshot.get("size-drift").expect("restored invalid task");
        assert_eq!(restored.status, "error");
        assert_eq!(
            restored.engine_status.as_deref(),
            Some("completion-invalid")
        );
        assert!(restored
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("expected 100 bytes")));
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn restoration_marks_sanitized_authenticated_task_for_reauthorization() {
        let data_dir =
            std::env::temp_dir().join(format!("nova-restore-reauth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).expect("create test data directory");
        let data_dir_string = data_dir.display().to_string();
        let state = Arc::new(persist::tests::test_state(&data_dir_string));
        let restored = persist::PersistedState {
            tasks: vec![restoration_test_task("credentialed", "downloading")],
            curl_args: HashMap::from([(
                "credentialed".to_owned(),
                vec![
                    "--location".to_owned(),
                    "https://example.com/credentialed".to_owned(),
                ],
            )]),
            resume_requires_reauth: vec!["credentialed".to_owned()],
            ..Default::default()
        };

        restore_persisted_tasks(&state, restored);

        let snapshot = state.task_snapshot.lock().expect("lock restored snapshot");
        let task = snapshot.get("credentialed").expect("restored task");
        assert_eq!(task.status, "error");
        assert_eq!(task.engine_status.as_deref(), Some("reauth-required"));
        assert!(task
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("authorize again")));
        drop(snapshot);
        assert!(state.curl_jobs.lock().expect("lock curl jobs").is_empty());
        assert!(state.priority_queue.entries().is_empty());
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn restoration_rehydrates_native_media_job_after_restart() {
        let data_dir = std::env::temp_dir().join(format!(
            "nova-restore-native-media-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).expect("create test data directory");
        let data_dir_string = data_dir.display().to_string();
        let state = Arc::new(persist::tests::test_state(&data_dir_string));

        let mut task = restoration_test_task("native-media", "downloading");
        task.engine = "nova-media-engine".to_owned();
        task.engine_id = task.id.clone();
        task.description = "Native media download".to_owned();
        let request = CreateDownloadBody {
            url: Some("https://example.com/watch?v=native".to_owned()),
            name: Some("native-media.bin".to_owned()),
            file_type: Some("video".to_owned()),
            size_bytes: None,
            category: Some("video".to_owned()),
            queue_id: Some("main".to_owned()),
            connections: Some(1),
            resumable: Some(true),
            save_path: Some(task.save_path.clone()),
            description: Some("Native media download".to_owned()),
            referer: None,
            start_immediately: Some(false),
            direct_options: None,
            media_options: None,
        };
        let restored = persist::PersistedState {
            tasks: vec![task],
            native_media_requests: HashMap::from([("native-media".to_owned(), request)]),
            native_media_protocols: HashMap::from([(
                "native-media".to_owned(),
                "direct".to_owned(),
            )]),
            ..Default::default()
        };

        restore_persisted_tasks(&state, restored);

        let snapshot = state.task_snapshot.lock().expect("lock restored snapshot");
        let restored_task = snapshot.get("native-media").expect("restored native media task");
        assert_eq!(restored_task.status, "paused");
        assert_eq!(restored_task.engine_status.as_deref(), Some("interrupted"));
        drop(snapshot);

        let jobs = state.native_media_jobs.lock().expect("lock native media jobs");
        let job = jobs.get("native-media").expect("rehydrated native media job");
        assert_eq!(job.protocol, "direct");
        assert_eq!(
            job.request.url.as_deref(),
            Some("https://example.com/watch?v=native")
        );
        drop(jobs);
        assert!(state.curl_jobs.lock().expect("lock curl jobs").is_empty());
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn restoration_marks_legacy_media_bridge_task_as_retired() {
        let data_dir = std::env::temp_dir().join(format!(
            "nova-restore-retired-media-bridge-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&data_dir).expect("create test data directory");
        let data_dir_string = data_dir.display().to_string();
        let state = Arc::new(persist::tests::test_state(&data_dir_string));

        let mut task = restoration_test_task("legacy-media", "downloading");
        task.engine = "media-bridge".to_owned();
        task.engine_id = task.id.clone();
        let restored = persist::PersistedState {
            tasks: vec![task],
            ..Default::default()
        };

        restore_persisted_tasks(&state, restored);

        let snapshot = state.task_snapshot.lock().expect("lock restored snapshot");
        let restored_task = snapshot.get("legacy-media").expect("restored legacy media task");
        assert_eq!(restored_task.status, "error");
        assert_eq!(restored_task.engine_status.as_deref(), Some("engine-retired"));
        assert!(restored_task
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("NOVA Media Engine")));
        drop(snapshot);
        assert!(state
            .native_media_jobs
            .lock()
            .expect("lock native media jobs")
            .is_empty());
        assert!(state.curl_jobs.lock().expect("lock curl jobs").is_empty());
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn signal_shutdown_delivers_once_and_clears_sender() {
        // Regression for C1/C2: the shutdown signal must be delivered exactly
        // once (no leaked tokio runtime on restart) and the Sender must be
        // drained so a second call is a safe no-op.
        let (tx, mut rx) = oneshot::channel::<()>();
        *SHUTDOWN_TX.lock().unwrap() = Some(tx);

        signal_shutdown();
        assert!(rx.try_recv().is_ok(), "first signal must be delivered");

        // Second call must not panic and must not hold a sender.
        signal_shutdown();
        let guard = SHUTDOWN_TX.lock().unwrap();
        assert!(
            guard.is_none(),
            "sender must be drained after shutdown signal"
        );
    }

    #[test]
    fn signal_shutdown_without_running_daemon_is_safe() {
        // Calling shutdown when nothing registered is a no-op, never panics.
        *SHUTDOWN_TX.lock().unwrap() = None;
        signal_shutdown();
        signal_shutdown();
        let guard = SHUTDOWN_TX.lock().unwrap();
        assert!(guard.is_none());
    }
}
