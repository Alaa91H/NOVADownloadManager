use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{
    sse::{Event, KeepAlive, Sse},
    Json,
};
use axum::routing::{delete, get, post};
use axum::Router;
use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use crate::daemon::curl::{
    create_curl_task as direct_create, delete_task, list_all_tasks, pause_task, redownload_task,
    resume_task, update_task_metadata,
};
use crate::daemon::direct::DirectUrl;
use crate::daemon::engine::mirror::{MirrorManager, MirrorSource};
use crate::daemon::engine::priority_queue::{DownloadPriority, QueueEntry};
use crate::daemon::engine::rules::RuleAction;
use crate::daemon::state::SharedState;
use crate::daemon::telegram::telegram_notify;
use crate::daemon::types::{CreateDownloadBody, Task};
use crate::daemon::ytdlp::create_ytdlp_task;
use crate::lock_or_err;

use super::common::{daemon_error, fallback_file_name};
use super::extension::{
    extension_candidate_to_download_body, legacy_v1_body_to_download_body, queue_capture_review,
};
use super::probes::probe_url_with_options;

pub async fn handle_health(State(state): State<SharedState>) -> Json<serde_json::Value> {
    // Offload the (potentially subprocess-spawning) capability probe to the
    // blocking pool so health polling never stalls the async runtime.
    let status = tokio::task::spawn_blocking(move || state.engine_capabilities())
        .await
        .unwrap_or_else(|_| std::sync::Arc::new(serde_json::json!({"status": "degraded"})));
    let service_status = status
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("degraded");
    Json(serde_json::json!({
        "status": service_status,
        "name": "NOVA Daemon",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "allEnginesReady": status.get("allReady").cloned().unwrap_or(serde_json::json!(false)),
        "routing": status.get("routing").cloned().unwrap_or(serde_json::json!({})),
        "engines": status.get("engines").cloned().unwrap_or(serde_json::json!({}))
    }))
}

pub async fn handle_list_downloads(State(state): State<SharedState>) -> Json<Vec<Task>> {
    Json(list_all_tasks(&state).await)
}

/// Produce a stable in-memory fingerprint for every task field that clients
/// need to observe during a running download. Progress alone is insufficient:
/// background resolution can update the real URL/name/size before the first
/// bytes arrive, and segment-level state is rendered by the live-progress UI.
fn task_event_fingerprint(task: &Task) -> u64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    task.status.hash(&mut hasher);
    task.name.hash(&mut hasher);
    task.url.hash(&mut hasher);
    task.file_type.hash(&mut hasher);
    task.date_added.hash(&mut hasher);
    task.category.hash(&mut hasher);
    task.queue_id.hash(&mut hasher);
    task.description.hash(&mut hasher);
    task.referer.hash(&mut hasher);
    task.engine.hash(&mut hasher);
    task.engine_id.hash(&mut hasher);
    task.downloaded_bytes.hash(&mut hasher);
    task.speed_bytes_per_sec.hash(&mut hasher);
    task.time_left_seconds.hash(&mut hasher);
    task.elapsed_seconds.hash(&mut hasher);
    task.size_bytes.hash(&mut hasher);
    task.connections.hash(&mut hasher);
    task.resumable.hash(&mut hasher);
    task.save_path.hash(&mut hasher);
    task.engine_status.hash(&mut hasher);
    task.error_message.hash(&mut hasher);
    for segment in &task.segments {
        segment.id.hash(&mut hasher);
        segment.progress.to_bits().hash(&mut hasher);
        segment.downloaded_bytes.hash(&mut hasher);
        segment.total_bytes.hash(&mut hasher);
        segment.active.hash(&mut hasher);
        segment.speed.hash(&mut hasher);
        segment.start_byte.hash(&mut hasher);
        segment.end_byte.hash(&mut hasher);
    }
    hasher.finish()
}

pub async fn handle_download_events(
    State(state): State<SharedState>,
) -> Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        let mut last_snapshots: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        let mut full_sync_counter: u32 = 0;

        loop {
            interval.tick().await;
            let tasks = list_all_tasks(&state).await;

            // Every 240 ticks (~60 seconds), send a full sync so the frontend can
            // reconcile any missed events or ghost entries.
            full_sync_counter += 1;
            if full_sync_counter >= 240 {
                full_sync_counter = 0;
                let payload = serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_owned());
                last_snapshots.clear();
                for t in &tasks {
                    last_snapshots.insert(t.id.clone(), 0);
                }
                yield Ok::<Event, Infallible>(Event::default().event("downloads").data(payload));
                continue;
            }

            let mut changed_tasks: Vec<serde_json::Value> = Vec::new();
            let mut removed_ids: Vec<String> = Vec::new();

                // Build a compact fingerprint for all client-visible mutable
                // task fields so background analysis and segment updates are sent
                // on the next 250 ms tick rather than delayed until full sync.
                let mut current_ids: std::collections::HashSet<&String> = std::collections::HashSet::new();
                for task in &tasks {
                    current_ids.insert(&task.id);
                    let fingerprint = task_event_fingerprint(task);

                let changed = match last_snapshots.get(&task.id) {
                    Some(prev) => *prev != fingerprint,
                    None => true,
                };

                if changed {
                    last_snapshots.insert(task.id.clone(), fingerprint);
                    if let Ok(v) = serde_json::to_value(task) {
                        changed_tasks.push(v);
                    }
                }
            }

            // Detect removed tasks.
            for key in last_snapshots.keys() {
                if !current_ids.contains(key) {
                    removed_ids.push(key.clone());
                }
            }
            for id in &removed_ids {
                last_snapshots.remove(id);
            }

            if !changed_tasks.is_empty() || !removed_ids.is_empty() {
                let delta = serde_json::json!({
                    "changed": changed_tasks,
                    "removed": removed_ids,
                });
                let data = serde_json::to_string(&delta).unwrap_or_else(|_| "{}".to_owned());
                yield Ok::<Event, Infallible>(Event::default().event("downloads-delta").data(data));
            }
        }
    };

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(10))
            .text("keep-alive"),
    )
}

fn priority_from_name(name: &str) -> DownloadPriority {
    match name.to_ascii_lowercase().as_str() {
        "critical" | "0" => DownloadPriority::Critical,
        "high" | "1" => DownloadPriority::High,
        "low" | "3" => DownloadPriority::Low,
        "background" | "4" => DownloadPriority::Background,
        _ => DownloadPriority::Normal,
    }
}

/// Applies matching download rules to the request body before task creation.
/// Returns the queue priority chosen by rules (if any), the mirror URLs to
/// register, and the per-task rate limit â€” or an error for `Reject` rules.
type ApplyRulesResult = Result<(Option<DownloadPriority>, Vec<String>, Option<u64>), String>;

fn apply_download_rules(
    state: &SharedState,
    body: &mut CreateDownloadBody,
    url: &str,
) -> ApplyRulesResult {
    let hostname = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    let matched = state.rule_engine.evaluate(url, &hostname, body.size_bytes);
    let mut priority = None;
    let mut mirrors = Vec::new();
    let mut rate_limit_kbps = None;
    for (rule_id, action) in matched {
        let action_label = format!("{action:?}");
        match action {
            RuleAction::Reject { reason } => {
                return Err(format!("Download rejected by rule {rule_id}: {reason}"));
            }
            RuleAction::SetCategory { category } => body.category = Some(category),
            RuleAction::SetPriority { priority: p } => priority = Some(priority_from_name(&p)),
            RuleAction::SetConnections { connections } => body.connections = Some(connections),
            RuleAction::SetSavePath { path } => body.save_path = Some(path),
            RuleAction::SetProfile { profile } => {
                if let Some(profile) = state.profile_manager.get_profile(&profile) {
                    if body.connections.is_none() {
                        body.connections = Some(profile.default_connections);
                    }
                    if rate_limit_kbps.is_none() {
                        rate_limit_kbps = profile.rate_limit_kbps;
                    }
                }
            }
            RuleAction::SetRateLimit { kbps } => rate_limit_kbps = Some(kbps),
            RuleAction::AddHeader { name, value } => {
                let options = body.direct_options.get_or_insert_with(HashMap::new);
                let header_line = format!("{name}: {value}");
                let headers = options
                    .entry("headers".to_owned())
                    .or_insert_with(|| serde_json::Value::String(String::new()));
                // Headers are stored as newline-separated strings for direct_str()
                // compatibility. An existing array from the request body is also
                // handled by joining all entries.
                match headers {
                    serde_json::Value::String(s) => {
                        if !s.is_empty() {
                            s.push('\n');
                        }
                        s.push_str(&header_line);
                    }
                    serde_json::Value::Array(arr) => {
                        // Legacy array format: flatten to newline-separated string.
                        let lines: Vec<String> = arr
                            .iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect();
                        let mut combined = lines.join("\n");
                        if !combined.is_empty() {
                            combined.push('\n');
                        }
                        combined.push_str(&header_line);
                        *headers = serde_json::Value::String(combined);
                    }
                    other => {
                        *other = serde_json::Value::String(header_line);
                    }
                }
            }
            RuleAction::AddMirror { url_pattern } => mirrors.push(url_pattern),
            RuleAction::RequireChecksum { algorithm } => {
                let options = body.direct_options.get_or_insert_with(HashMap::new);
                options.insert(
                    "checksumAlgorithm".to_owned(),
                    serde_json::Value::String(algorithm),
                );
            }
        }
        state
            .event_bus
            .publish(crate::daemon::engine::event_bus::EngineEvent::RuleApplied {
                task_id: String::new(),
                rule_id,
                action: action_label,
            });
    }
    Ok((priority, mirrors, rate_limit_kbps))
}

/// Registers a freshly created task with the engine subsystems: priority
/// queue entry, rule-provided mirrors, and per-task rate limits.
fn register_task_with_engine(
    state: &SharedState,
    task: &Task,
    priority: Option<DownloadPriority>,
    mirrors: Vec<String>,
    rate_limit_kbps: Option<u64>,
) {
    state.priority_queue.enqueue(QueueEntry {
        task_id: task.id.clone(),
        priority: priority.unwrap_or(DownloadPriority::Normal),
        added_at: std::time::Instant::now(),
        size_bytes: task.size_bytes,
        bandwidth_kbps: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
    });
    if !mirrors.is_empty() {
        if let Ok(mut managers) = state.mirror_managers.lock() {
            let manager = managers
                .entry(task.id.clone())
                .or_insert_with(|| MirrorManager::new(&task.url));
            for mirror_url in mirrors {
                manager.add_mirror(MirrorSource {
                    url: mirror_url.clone(),
                    priority: 1,
                    region: None,
                    bandwidth_estimate: None,
                    last_checked: None,
                    healthy: true,
                });
                state.event_bus.publish(
                    crate::daemon::engine::event_bus::EngineEvent::MirrorFound {
                        task_id: task.id.clone(),
                        mirror_url,
                    },
                );
            }
        }
    }
    if let Some(kbps) = rate_limit_kbps {
        state
            .bandwidth_manager
            .set_task_limit(task.id.clone(), kbps);
    }
}

pub async fn handle_create_download(
    State(state): State<SharedState>,
    Json(mut body): Json<CreateDownloadBody>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    let url = body.url.clone().unwrap_or_default();
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }

    let (rule_priority, rule_mirrors, rule_rate_limit) =
        apply_download_rules(&state, &mut body, &url).map_err(|e| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": e})),
            )
        })?;

    // ── Accept Immediately → Resolve Concurrently ──────────────────────────
    // Try the synchronous fast-path first (we already have a filename).
    // If that fails, still create the task immediately so the user sees it
    // right away, then spawn a background probe to enrich metadata and kick
    // off the actual download once the probe resolves.
    let (needs_background_resolve, needs_background_size_update) = if body.media_options.is_none() {
        let original_url = body.url.clone().unwrap_or_default();
        let fast_path_hit = apply_fast_resolve(&mut body);
        if fast_path_hit {
            // Fast path: start immediately, but launch a non-blocking probe to
            // discover the total size (so the UI can show progress percentage)
            // and enrich metadata (etag, resumable, mirrors) without delaying
            // the download start.
            (false, body.size_bytes.unwrap_or(0) == 0)
        } else {
            (
                body.start_immediately.unwrap_or(true) && supported_direct_url(&original_url),
                false,
            )
        }
    } else {
        (false, false)
    };

    if needs_background_resolve {
        // Prevent the curl engine from starting the download right away —
        // the background probe will call start_curl_process once it has the
        // final URL and metadata.
        body.start_immediately = Some(false);
    }
    let background_state = state.clone();
    let background_url = if needs_background_resolve {
        body.url.clone().unwrap_or_default()
    } else {
        String::new()
    };

    let result = {
        let extractor = state.extractor_registry.validate(&body).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?;
        match extractor.id() {
            "yt-dlp" => create_ytdlp_task(&state, &body).await,
            _ => direct_create(&state, &body).await,
        }
    };

    match result {
        Ok(task) => {
            let task_id = task.id.clone();
            log::debug!(
                "Created download task {task_id} (engine={}, name={})",
                task.engine,
                task.name
            );
            // Merge probe-discovered Link mirrors (RFC 6249) with rule-engine mirrors.
            let mut all_mirrors = rule_mirrors;
            if let Some(opts) = body.direct_options.as_ref() {
                if let Some(arr) = opts.get("linkMirrors").and_then(|v| v.as_array()) {
                    for v in arr {
                        if let Some(url) = v.as_str() {
                            let url = url.to_owned();
                            if !all_mirrors.contains(&url) {
                                all_mirrors.push(url);
                            }
                        }
                    }
                }
            }
            register_task_with_engine(&state, &task, rule_priority, all_mirrors, rule_rate_limit);

            // ── Spawn background resolution for slow-path tasks ────────────
            if needs_background_resolve && !task_id.is_empty() {
                let state_clone = background_state.clone();
                let task_id_clone = task_id.clone();
                let original_url_clone = background_url;
                tokio::spawn(async move {
                    background_resolve_and_start(state_clone, task_id_clone, original_url_clone)
                        .await;
                });
            }

            // Fast-path size discovery: the download already started, but we
            // don't know the total size yet. Launch a non-blocking HEAD probe
            // to update size_bytes so the UI can show a progress percentage.
            if needs_background_size_update && !task_id.is_empty() {
                let state_clone = background_state.clone();
                let task_id_clone = task_id.clone();
                let probe_url = body.url.clone().unwrap_or_default();
                tokio::spawn(async move {
                    background_size_probe(state_clone, task_id_clone, probe_url).await;
                });
            }

            telegram_notify(&state, &format!("Download started: {}", task.name)).await;
            Ok(Json(task))
        }
        Err(e) => {
            log::error!("Create download failed: {e}");
            Err(daemon_error(e))
        }
    }
}

pub async fn handle_pause_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    pause_task(&state, &id).await.map(Json).map_err(|e| {
        log::error!("Pause task failed: {e}");
        daemon_error(e)
    })
}

pub async fn handle_resume_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    resume_task(&state, &id).await.map(Json).map_err(|e| {
        log::error!("Resume task failed: {e}");
        daemon_error(e)
    })
}

pub async fn handle_delete_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let delete_files = params
        .get("deleteFiles")
        .or_else(|| params.get("deleteDisk"))
        .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"));
    delete_task(&state, &id, delete_files)
        .await
        .map(|()| Json(serde_json::json!({"ok": true, "deleteFiles": delete_files})))
        .map_err(|e| {
            log::error!("Delete task failed: {e}");
            daemon_error(e)
        })
}

#[derive(serde::Deserialize, Default)]
pub struct UpdateDownloadBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

pub async fn handle_update_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateDownloadBody>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    update_task_metadata(&state, &id, body.name, body.url)
        .await
        .map(Json)
        .map_err(|e| {
            log::error!("Update task failed: {e}");
            daemon_error(e)
        })
}

pub async fn handle_redownload_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    redownload_task(&state, &id).await.map(Json).map_err(|e| {
        log::error!("Redownload task failed: {e}");
        daemon_error(e)
    })
}

fn supported_direct_url(url: &str) -> bool {
    DirectUrl::parse(url).is_ok()
}

/// Synchronous fast-path: if we already have a specific filename and the URL
/// is a direct download link, enrich the body without any network probe.
/// Returns `true` if the fast path was taken (caller can skip background resolve).
fn apply_fast_resolve(body: &mut CreateDownloadBody) -> bool {
    let Some(original_url) = body
        .url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
    else {
        return false;
    };
    if !supported_direct_url(&original_url) {
        return false;
    }

    // Fast path: if we already have a specific filename, skip network probing.
    // This prevents the daemon from blocking for 1-2 seconds, which is crucial
    // for intercepted browser downloads to return instantly so the extension can
    // cancel the native download before the browser's "Save As" dialog appears.
    if let Some(name) = body.name.as_deref().map(str::trim) {
        if !name.is_empty() && name != "download" && name != "index.html" {
            body.url = Some(original_url);
            return true;
        }
    }

    // Even without a specific filename, for user-initiated downloads we accept
    // the URL as-is and let the download engine resolve it via HTTP redirects
    // and Content-Disposition. The background probe will enrich metadata
    // (size, etag, mirrors) asynchronously.
    //
    // Strong fast-path: if the URL path ends with a recognizable file extension
    // (e.g. vlc-3.0.23-win64.exe, file.zip), the filename is already derivable
    // from the URL itself — skip the background RIE probe entirely and start the
    // download immediately. This is the common case for direct download links
    // (get.videolan.org, github releases, cdns) and eliminates the multi-second
    // probe delay users experienced between "size detected" and "download starts".
    if let Some(file_name) = file_name_from_url(&original_url) {
        if has_recognizable_extension(&file_name) {
            body.name = Some(file_name);
            body.url = Some(original_url);
            return true;
        }
    }

    // Scripted download endpoints hide the real file name in a query parameter
    // (`/download.php?file=setup.exe`, `/get?id=7&filename=report.pdf`) while
    // the path ends in `.php`/`.asp`. If a well-known filename parameter names
    // a recognizable file, the URL is a direct download — take the fast path
    // with the query-derived name instead of probing an HTML endpoint.
    if let Some(file_name) = crate::daemon::utils::file_name_from_query(&original_url) {
        body.name = Some(file_name);
        if body.referer.as_deref().unwrap_or("").trim().is_empty() {
            body.referer = Some(original_url.clone());
        }
        body.url = Some(original_url);
        return true;
    }

    // No recognizable name or extension — let background_resolve_and_start
    // analyze this URL with proper anti-bot headers (Sec-Fetch-*, realistic
    // User-Agent) and resolve the final name, size, and metadata via RIE.
    // Returning false here enables the background probe for ambiguous URLs
    // (API redirects, CDN tokens, shortlinks, etc.) where curl alone may
    // receive a block page or incorrect Content-Disposition.
    false
}

/// Extract the final path segment as a filename, stripping query strings.
fn file_name_from_url(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or(url);
    let path = path.split('#').next().unwrap_or(path);
    let last = path.rsplit('/').next()?;
    let decoded = percent_decode(last);
    if decoded.is_empty() || decoded == "/" {
        None
    } else {
        Some(decoded)
    }
}

/// Minimal percent-decoding for path segments (handles %20, %2F, etc.).
/// Delegates to the shared decoder in `daemon::utils`.
fn percent_decode(input: &str) -> String {
    crate::daemon::utils::percent_decode(input)
}

/// True when the filename ends with a known downloadable extension, indicating
/// a direct file link rather than an HTML interstitial that needs probing.
///
/// Delegates to the single source of truth in `daemon::utils` so the fast
/// path and the interstitial link extractor can never drift apart again.
fn has_recognizable_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    crate::daemon::utils::is_recognizable_download_extension(ext)
}

struct ProbeMetadata {
    final_url: Option<String>,
    file_name: Option<String>,
    size_bytes: u64,
    resumable: bool,
    etag: Option<String>,
    last_modified: Option<String>,
    digest_sha256: Option<String>,
    content_type: Option<String>,
    link_mirrors: Vec<String>,
    strategy: Option<String>,
    connections: Option<u32>,
}

/// Background resolve: runs the RIE (Resource Intelligence Engine) to analyze
/// the URL and select a download strategy, then enriches the task with
/// discovered metadata and starts the download. Falls back to the legacy
/// probe if RIE fails.
async fn background_resolve_and_start(state: SharedState, task_id: String, original_url: String) {
    // ── Try the RIE first ──────────────────────────────────────────────
    // M-2: bound the RIE resolve so a hung probe (DNS, TLS, anti-bot wait)
    // cannot strand a queued task forever. On timeout, start the download
    // without the RIE enrichment and let the engine's own preflight handle
    // the URL.
    let report = match tokio::time::timeout(
        std::time::Duration::from_secs(60),
        state.rie.resolve(&state, &original_url, None),
    )
    .await
    {
        Ok(report) => report,
        Err(_) => {
            log::warn!(
                "Task {task_id}: RIE resolve timed out after 60s; starting download without enrichment"
            );
            start_curl_task_by_id(&state, &task_id);
            return;
        }
    };

    // Map the ResolutionReport into a flat ProbeMetadata struct.
    let identity = report.resource_identity.as_ref();
    let metadata = {
        let final_url = report
            .redirect_chain
            .final_url
            .as_ref()
            .filter(|u| !u.is_empty() && supported_direct_url(u))
            .cloned()
            .or_else(|| {
                identity
                    .and_then(|i| {
                        if i.final_url.is_empty() {
                            None
                        } else {
                            Some(i.final_url.clone())
                        }
                    })
                    .filter(|u| supported_direct_url(u))
            })
            .or_else(|| Some(original_url.clone()));

        ProbeMetadata {
            final_url,
            file_name: identity
                .map(|i| i.file_name.clone())
                .filter(|n| !n.is_empty()),
            size_bytes: identity.and_then(|i| i.content_length).unwrap_or(0),
            resumable: matches!(
                report.server_capabilities.range_support,
                crate::daemon::resource_intelligence::types::CapabilityState::Confirmed
            ),
            etag: identity.and_then(|i| i.etag.clone()),
            last_modified: identity.and_then(|i| i.last_modified.clone()),
            digest_sha256: identity.and_then(|i| i.digest_sha256.clone()),
            content_type: identity
                .and_then(|i| i.content_type.clone())
                .filter(|n| !n.is_empty()),
            link_mirrors: report.server_capabilities.link_mirrors.clone(),
            strategy: Some(format!("{:?}", report.recommended_strategy)),
            connections: report.server_capabilities.detected_connections,
        }
    };

    // Hoisted to function scope: both the curl_jobs block below and the
    // task_snapshot sync block must refuse HTML-page metadata (size, name,
    // resumable). Some CDNs (get.videolan.org) answer browser-like probes
    // with a 200 HTML interstitial instead of a redirect; applying that
    // page's size/name to the task would leak a bogus ~12 KB "file" into
    // the UI and break the engine's own re-resolution.
    let rie_saw_html = metadata
        .content_type
        .as_deref()
        .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/html"));

    // ── Apply enriched metadata to curl job first, then task snapshot ──
    // Lock order: curl_jobs → task_snapshot (documented order).
    let mut updates_applied = false;
    let mut deferred_url_update: Option<String> = None;
    let mut deferred_name_update: Option<String> = None;

    {
        if let Ok(mut jobs) = state.curl_jobs.lock() {
            if let Some(job) = jobs.get_mut(&task_id) {
                if let Some(ref final_url) = metadata.final_url {
                    if supported_direct_url(final_url) && final_url != &job.task.url {
                        job.task.url = final_url.clone();
                        deferred_url_update = Some(final_url.clone());
                    }
                }

                let opts = &mut job.direct_options;
                if let Some(ref etag) = metadata.etag {
                    opts.entry("etag".to_owned())
                        .or_insert_with(|| serde_json::Value::String(etag.clone()));
                }
                if let Some(ref last_modified) = metadata.last_modified {
                    opts.entry("lastModified".to_owned())
                        .or_insert_with(|| serde_json::Value::String(last_modified.clone()));
                }
                if let Some(ref digest) = metadata.digest_sha256 {
                    opts.insert(
                        "digestSha256".to_owned(),
                        serde_json::Value::String(digest.clone()),
                    );
                }
                if let Some(ref ct) = metadata.content_type {
                    opts.entry("contentType".to_owned())
                        .or_insert_with(|| serde_json::Value::String(ct.clone()));
                }
                if !metadata.link_mirrors.is_empty() {
                    let mirrors: Vec<serde_json::Value> = metadata
                        .link_mirrors
                        .iter()
                        .map(|m| serde_json::Value::String(m.clone()))
                        .collect();
                    opts.insert("linkMirrors".to_owned(), serde_json::Value::Array(mirrors));
                }
                if job.task.size_bytes == 0 && metadata.size_bytes > 0 && !rie_saw_html {
                    job.task.size_bytes = metadata.size_bytes;
                }
                // Never apply a file name scraped from an HTML interstitial
                // page (e.g. get.videolan.org's "thanks" page, which answers
                // browser probes with a 200 HTML document); the engine
                // preflight re-resolves and picks the real file name.
                if let Some(ref probe_name) = metadata.file_name {
                    let should_update = !rie_saw_html
                        && (job.task.name == "download"
                            || job.task.name.is_empty()
                            || job
                                .task
                                .name
                                .eq_ignore_ascii_case(&fallback_file_name(&job.task.url)));
                    if should_update {
                        // The name comes from a server-controlled
                        // Content-Disposition header; sanitize it to a bare
                        // file name so a crafted `filename="../../evil"`
                        // cannot become a path traversal on disk.
                        let safe_name =
                            crate::daemon::utils::sanitize_derived_file_name(probe_name);
                        job.task.name = safe_name.clone();
                        deferred_name_update = Some(safe_name);
                    }
                }
                job.task.resumable = metadata.resumable && !rie_saw_html;
                if let Some(ref strategy) = metadata.strategy {
                    opts.insert(
                        "rieStrategy".to_owned(),
                        serde_json::Value::String(strategy.clone()),
                    );
                }
                if let Some(connections) = metadata.connections {
                    opts.insert(
                        "rieConnections".to_owned(),
                        serde_json::Value::Number(connections.into()),
                    );
                }
                // Only mark the task as preflight-resolved when the RIE
                // actually found a real file. Some CDNs (get.videolan.org)
                // answer browser-like probes with an HTML interstitial page;
                // trusting it would make the engine skip its own preflight
                // and download the HTML page instead of the file.
                opts.insert(
                    "preflightResolved".to_owned(),
                    serde_json::Value::Bool(!rie_saw_html),
                );
                opts.insert(
                    "preflightSupportsRange".to_owned(),
                    serde_json::Value::Bool(metadata.resumable && !rie_saw_html),
                );
                if rie_saw_html {
                    // Do not apply the HTML page's bogus size/name; the
                    // engine preflight re-resolves through redirects,
                    // meta-refresh and direct download links.
                    log::info!(
                        "Task {task_id}: RIE resolved to an HTML interstitial — deferring to engine preflight"
                    );
                }
                updates_applied = true;
            }
        }
    }

    // Sync all changes to task_snapshot (single lock acquisition).
    if let Ok(mut tasks) = state.task_snapshot.lock() {
        if let Some(task) = tasks.get_mut(&task_id) {
            // Never apply an HTML interstitial's bogus size/resumability to
            // the UI snapshot either — the engine preflight re-resolves and
            // reports the real file size once the transfer starts.
            if task.size_bytes == 0 && metadata.size_bytes > 0 && !rie_saw_html {
                task.size_bytes = metadata.size_bytes;
            }
            task.resumable = metadata.resumable && !rie_saw_html;
            if let Some(ref final_url) = deferred_url_update {
                task.url = final_url.clone();
            }
            if let Some(ref name) = deferred_name_update {
                task.name = name.clone();
            }
        }
    }

    if updates_applied {
        state.mark_dirty();
    }

    start_curl_task_by_id(&state, &task_id);
}

/// Non-blocking probe that discovers the total file size for a download that
/// already started via the fast path (where size was unknown). This lets the UI
/// show a progress percentage without delaying the download start.
async fn background_size_probe(state: SharedState, task_id: String, url: String) {
    if url.is_empty() {
        return;
    }
    // Build a minimal probe body for size discovery only.
    let probe_body = CreateDownloadBody {
        url: Some(url.clone()),
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
        start_immediately: Some(false),
        direct_options: None,
        media_options: None,
    };
    let probe_result = probe_url_with_options(&state, &url, Some(&probe_body)).await;
    let size = match probe_result {
        Ok(json) => json
            .get("sizeBytes")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        Err(e) => {
            log::debug!("background_size_probe for {task_id}: {e:?}");
            return;
        }
    };
    if size == 0 {
        return;
    }
    // Update the task size_bytes so the UI can compute progress percentage.
    let mut updated = false;
    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.get_mut(&task_id) {
            if job.task.size_bytes == 0 {
                job.task.size_bytes = size;
                updated = true;
            }
        }
    }
    if updated {
        // Also update the snapshot and the priority queue entry.
        if let Ok(mut tasks) = state.task_snapshot.lock() {
            if let Some(task) = tasks.get_mut(&task_id) {
                if task.size_bytes == 0 {
                    task.size_bytes = size;
                }
            }
        }
        state.priority_queue.update_size(&task_id, size);
        state.mark_dirty();
        log::info!("background_size_probe: updated task {task_id} size to {size} bytes");
    }
}

/// Start a previously-created curl task by its ID. Called by the background
/// resolver once metadata is ready, or as a fallback if the probe fails.
fn start_curl_task_by_id(state: &SharedState, task_id: &str) {
    // Transition the task status to "downloading" in the snapshot.
    if let Ok(mut tasks) = state.task_snapshot.lock() {
        if let Some(task) = tasks.get_mut(task_id) {
            if task.status == "queued" {
                task.status = "downloading".to_owned();
                task.engine_status = Some("starting".to_owned());
            }
        }
    }
    state.mark_dirty();
    // Spawn the actual curl process on a blocking thread.
    crate::daemon::curl::start_curl_process(state, task_id);
}

pub async fn handle_captures(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut download_bodies = Vec::new();
    if let Some(candidates) = body.get("candidates").and_then(|v| v.as_array()) {
        for candidate in candidates {
            let wrapper = serde_json::json!({
                "candidate": candidate,
                "source": body.get("source").cloned().unwrap_or_else(|| serde_json::json!("nova-extension")),
                "idempotencyKey": body.get("idempotencyKey").cloned().unwrap_or(serde_json::Value::Null)
            });
            match extension_candidate_to_download_body(&wrapper, true) {
                Ok(download_body) => download_bodies.push(download_body),
                Err(error) => log::warn!("Rejected browser-extension candidate: {error}"),
            }
        }
    }
    if let Some(single_candidate) = body.get("candidate") {
        let wrapper = serde_json::json!({"candidate": single_candidate});
        match extension_candidate_to_download_body(&wrapper, true) {
            Ok(download_body) => download_bodies.push(download_body),
            Err(error) => log::warn!("Rejected browser-extension candidate: {error}"),
        }
    }
    if let Some(urls) = body.get("urls").and_then(|v| v.as_array()) {
        for url_val in urls {
            let url_str = url_val.as_str().unwrap_or("");
            if url_str.is_empty() {
                continue;
            }
            if let Ok(download_body) =
                legacy_v1_body_to_download_body(&serde_json::json!({"url": url_str}), true)
            {
                download_bodies.push(download_body);
            }
        }
    }

    let mut review_ids = Vec::new();
    let mut errors = Vec::new();
    let idempotency_base = body
        .get("idempotencyKey")
        .and_then(serde_json::Value::as_str)
        .filter(|key| !key.trim().is_empty());
    for (index, download_body) in download_bodies.into_iter().enumerate() {
        let idempotency_key = idempotency_base.map(|key| format!("{key}:{index}"));
        match queue_capture_review(&state, download_body, idempotency_key) {
            Ok((review_id, _duplicate)) => review_ids.push(review_id),
            Err(error) => errors.push(error),
        }
    }
    let first_id = review_ids.first().cloned().unwrap_or_default();
    Json(serde_json::json!({
        "ok": errors.is_empty(),
        "accepted": !review_ids.is_empty(),
        // Kept for protocol-v4 clients. These are review IDs, not task IDs.
        "taskId": first_id,
        "taskIds": review_ids,
        "reviewIds": review_ids,
        "message": if errors.is_empty() { "Waiting for approval in NOVA".to_owned() } else { errors.join("; ") }
    }))
}

pub async fn handle_captures_pending(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let tasks = list_all_tasks(&state).await;
    let pending: Vec<serde_json::Value> = tasks
        .iter()
        .filter(|t| t.status == "queued" || t.status == "waiting")
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "url": t.url,
                "name": t.name,
                "status": t.status,
            })
        })
        .collect();
    Json(serde_json::json!({"ok": true, "captures": pending}))
}

pub async fn handle_stats(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let stats = state
        .download_stats
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    let active = {
        let snap = lock_or_err!(state.task_snapshot);
        snap.values().filter(|t| t.status == "downloading").count()
    };
    Json(serde_json::json!({
        "totalCompleted": stats.total_completed,
        "totalFailed": stats.total_failed,
        "totalDownloadedBytes": stats.total_downloaded_bytes,
        "activeDownloads": active,
        "sessionStartedAt": stats.session_started_at,
    }))
}

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/health", get(handle_health))
        .route(
            "/api/downloads",
            get(handle_list_downloads).post(handle_create_download),
        )
        .route("/api/downloads/events", get(handle_download_events))
        .route("/api/downloads/{id}/pause", post(handle_pause_task))
        .route("/api/downloads/{id}/resume", post(handle_resume_task))
        .route(
            "/api/downloads/{id}/redownload",
            post(handle_redownload_task),
        )
        .route(
            "/api/downloads/{id}",
            delete(handle_delete_task).patch(handle_update_task),
        )
        .route("/api/stats", get(handle_stats))
        .route("/captures", post(handle_captures))
        .route("/captures/pending", get(handle_captures_pending))
}

#[cfg(test)]
mod tests {
    use super::{has_recognizable_extension, supported_direct_url, task_event_fingerprint};
    use crate::daemon::types::{Segment, Task};

    fn sample_task() -> Task {
        Task {
            id: "task-1".to_owned(),
            name: "pending.bin".to_owned(),
            url: "https://example.test/pending".to_owned(),
            file_type: "other".to_owned(),
            status: "downloading".to_owned(),
            size_bytes: 0,
            downloaded_bytes: 0,
            speed_bytes_per_sec: 0,
            time_left_seconds: 0,
            elapsed_seconds: 0,
            date_added: "2026-01-01T00:00:00Z".to_owned(),
            category: "other".to_owned(),
            queue_id: "main".to_owned(),
            connections: 2,
            resumable: false,
            save_path: "/tmp/pending.bin".to_owned(),
            description: "test".to_owned(),
            segments: vec![Segment {
                id: 0,
                progress: 0.0,
                downloaded_bytes: 0,
                total_bytes: 0,
                active: true,
                speed: 0,
                start_byte: 0,
                end_byte: 0,
            }],
            referer: None,
            engine: "libcurl-multi".to_owned(),
            engine_id: "task-1".to_owned(),
            engine_status: Some("starting".to_owned()),
            error_message: None,
        }
    }

    #[test]
    fn supported_direct_urls_follow_libcurl_scheme_normalization() {
        for url in [
            "HTTPS://example.test/archive.zip",
            "hTtP://example.test/archive.zip",
            "FtPs://example.test/archive.zip",
        ] {
            assert!(supported_direct_url(url), "expected supported URL: {url}");
        }
        assert!(!supported_direct_url("file:///tmp/archive.zip"));
        assert!(!supported_direct_url("magnet:?xt=urn:btih:example"));
    }

    #[test]
    fn event_fingerprint_changes_for_background_metadata_and_segment_updates() {
        let original = sample_task();
        let baseline = task_event_fingerprint(&original);

        let mut enriched = original.clone();
        enriched.name = "real-file.zip".to_owned();
        enriched.url = "https://cdn.example.test/real-file.zip".to_owned();
        enriched.save_path = "/tmp/real-file.zip".to_owned();
        enriched.category = "program".to_owned();
        enriched.queue_id = "fast".to_owned();
        enriched.description = "resolved download metadata".to_owned();
        enriched.referer = Some("https://example.test/page".to_owned());
        enriched.engine = "yt-dlp".to_owned();
        enriched.engine_id = "resolved-engine-id".to_owned();
        enriched.size_bytes = 100;
        enriched.resumable = true;
        enriched.engine_status = Some("running-libcurl-multi".to_owned());
        enriched.segments[0].downloaded_bytes = 50;
        enriched.segments[0].total_bytes = 100;
        enriched.segments[0].progress = 0.5;

        assert_ne!(
            baseline,
            task_event_fingerprint(&enriched),
            "SSE must emit metadata and segment changes immediately"
        );
    }

    #[test]
    fn recognizable_extensions_take_the_fast_path() {
        for name in [
            "photo.jpg",
            "image.jpeg",
            "pic.png",
            "anim.gif",
            "web.webp",
            "vector.svg",
            "notes.txt",
            "data.csv",
            "config.json",
            "feed.xml",
            "readme.md",
            "font.ttf",
            "font.otf",
            "font.woff2",
            "lib.dll",
            "lib.so",
            "lib.dylib",
            "archive.zip",
            "archive.tar.gz",
            "movie.mp4",
            "song.mp3",
            "doc.pdf",
        ] {
            assert!(
                has_recognizable_extension(name),
                "expected {name} to be recognized as a direct file link"
            );
        }
    }

    #[test]
    fn non_file_urls_do_not_take_the_fast_path() {
        for name in [
            "index.html",
            "page.php",
            "download.php?id=1",
            "",
            "/",
            "redirect",
        ] {
            assert!(
                !has_recognizable_extension(name),
                "expected {name:?} to NOT be recognized as a direct file link"
            );
        }
    }
}
