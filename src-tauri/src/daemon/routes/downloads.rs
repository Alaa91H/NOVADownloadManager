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
    create_curl_task as direct_create, delete_task, list_all_tasks, pause_task, resume_task,
};
use crate::daemon::engine::mirror::{MirrorManager, MirrorSource};
use crate::daemon::engine::priority_queue::{DownloadPriority, QueueEntry};
use crate::daemon::engine::rules::RuleAction;
use crate::daemon::state::SharedState;
use crate::daemon::telegram::telegram_notify;
use crate::daemon::types::{CreateDownloadBody, Task};
use crate::daemon::ytdlp::create_ytdlp_task;
use crate::lock_or_err;

use super::common::*;
use super::extension::{extension_candidate_to_download_body, legacy_v1_body_to_download_body};

pub async fn handle_health(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let status = state.engine_capabilities();
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
                let payload = serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_string());
                last_snapshots.clear();
                for t in &tasks {
                    last_snapshots.insert(t.id.clone(), 0);
                }
                yield Ok::<Event, Infallible>(Event::default().event("downloads").data(payload));
                continue;
            }

            let mut changed_tasks: Vec<serde_json::Value> = Vec::new();
            let mut removed_ids: Vec<String> = Vec::new();

            // Build fingerprint hash for each task using the fields that change
            // during download. A u64 hash avoids String allocation and comparison.
            let mut current_ids: std::collections::HashSet<&String> = std::collections::HashSet::new();
            for task in &tasks {
                current_ids.insert(&task.id);
                let fingerprint = {
                    let mut hasher: std::collections::hash_map::DefaultHasher =
                        std::collections::hash_map::DefaultHasher::new();
                    use std::hash::{Hash, Hasher};
                    task.status.hash(&mut hasher);
                    task.downloaded_bytes.hash(&mut hasher);
                    task.speed_bytes_per_sec.hash(&mut hasher);
                    task.time_left_seconds.hash(&mut hasher);
                    task.size_bytes.hash(&mut hasher);
                    task.connections.hash(&mut hasher);
                    task.error_message.hash(&mut hasher);
                    hasher.finish()
                };

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
                let data = serde_json::to_string(&delta).unwrap_or_else(|_| "{}".to_string());
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
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let matched = state.rule_engine.evaluate(url, &hostname, body.size_bytes);
    let mut priority = None;
    let mut mirrors = Vec::new();
    let mut rate_limit_kbps = None;
    for (rule_id, action) in matched {
        let action_label = format!("{:?}", action);
        match action {
            RuleAction::Reject { reason } => {
                return Err(format!("Download rejected by rule {}: {}", rule_id, reason));
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
                let headers = options
                    .entry("headers".to_string())
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let Some(list) = headers.as_array_mut() {
                    list.push(serde_json::Value::String(format!("{}: {}", name, value)));
                }
            }
            RuleAction::AddMirror { url_pattern } => mirrors.push(url_pattern),
            RuleAction::RequireChecksum { algorithm } => {
                let options = body.direct_options.get_or_insert_with(HashMap::new);
                options.insert(
                    "checksumAlgorithm".to_string(),
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
    let needs_background_resolve = if body.media_options.is_none() {
        let original_url = body.url.clone().unwrap_or_default();
        let fast_path_hit = apply_fast_resolve(&mut body);
        !fast_path_hit
            && body.start_immediately.unwrap_or(true)
            && supported_direct_url(&original_url)
    } else {
        false
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
            // Merge probe-discovered Link mirrors (RFC 6249) with rule-engine mirrors.
            let mut all_mirrors = rule_mirrors;
            if let Some(opts) = body.direct_options.as_ref() {
                if let Some(arr) = opts.get("linkMirrors").and_then(|v| v.as_array()) {
                    for v in arr {
                        if let Some(url) = v.as_str() {
                            let url = url.to_string();
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
                let state_clone = background_state;
                let task_id_clone = task_id.clone();
                let original_url_clone = background_url;
                tokio::spawn(async move {
                    background_resolve_and_start(state_clone, task_id_clone, original_url_clone)
                        .await;
                });
            }

            telegram_notify(&state, &format!("Download started: {}", task.name)).await;
            Ok(Json(task))
        }
        Err(e) => {
            log::error!("Create download failed: {}", e);
            Err(daemon_error(e))
        }
    }
}

pub async fn handle_pause_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    pause_task(&state, &id).await.map(Json).map_err(|e| {
        log::error!("Pause task failed: {}", e);
        daemon_error(e)
    })
}

pub async fn handle_resume_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<serde_json::Value>)> {
    resume_task(&state, &id).await.map(Json).map_err(|e| {
        log::error!("Resume task failed: {}", e);
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
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false);
    delete_task(&state, &id, delete_files)
        .await
        .map(|_| Json(serde_json::json!({"ok": true, "deleteFiles": delete_files})))
        .map_err(|e| {
            log::error!("Delete task failed: {}", e);
            daemon_error(e)
        })
}

fn supported_direct_url(url: &str) -> bool {
    url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("ftp://")
        || url.starts_with("ftps://")
        || url.starts_with("sftp://")
        || url.starts_with("scp://")
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
        .map(str::to_string)
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
            if body.referer.as_deref().unwrap_or("").trim().is_empty() {
                body.referer = Some(original_url.clone());
            }
            body.url = Some(original_url);
            return true;
        }
    }

    // Even without a specific filename, for user-initiated downloads we accept
    // the URL as-is and let the download engine resolve it via HTTP redirects
    // and Content-Disposition. The background probe will enrich metadata
    // (size, etag, mirrors) asynchronously.
    if body.referer.as_deref().unwrap_or("").trim().is_empty() {
        body.referer = Some(original_url.clone());
    }
    body.url = Some(original_url);
    true
}

struct ProbeMetadata {
    final_url: Option<String>,
    file_name: Option<String>,
    size_bytes: u64,
    resumable: bool,
    etag: Option<String>,
    last_modified: Option<String>,
    digest_sha256: Option<String>,
    link_mirrors: Vec<String>,
    mirror_priorities: Vec<serde_json::Value>,
    strategy: Option<String>,
    connections: Option<u32>,
}

/// Background resolve: runs the RIE (Resource Intelligence Engine) to analyze
/// the URL and select a download strategy, then enriches the task with
/// discovered metadata and starts the download. Falls back to the legacy
/// probe if RIE fails.
async fn background_resolve_and_start(state: SharedState, task_id: String, original_url: String) {
    // ── Try the RIE first ──────────────────────────────────────────────
    let report = state.rie.resolve(&state, &original_url, None).await;

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
            link_mirrors: Vec::new(),
            mirror_priorities: Vec::new(),
            strategy: Some(format!("{:?}", report.recommended_strategy)),
            connections: report.server_capabilities.detected_connections,
        }
    };

    // ── Apply enriched metadata to task snapshot + curl job ─────────────
    let mut updates_applied = false;
    if let Ok(mut tasks) = state.task_snapshot.lock() {
        if let Some(task) = tasks.get_mut(&task_id) {
            if task.size_bytes == 0 && metadata.size_bytes > 0 {
                task.size_bytes = metadata.size_bytes;
                updates_applied = true;
            }
            task.resumable = metadata.resumable;
            if let Some(ref probe_name) = metadata.file_name {
                let should_update = task.name == "download"
                    || task.name.is_empty()
                    || task
                        .name
                        .eq_ignore_ascii_case(&fallback_file_name(&task.url));
                if should_update {
                    task.name = probe_name.clone();
                    updates_applied = true;
                }
            }
        }
    }

    if let Ok(mut jobs) = state.curl_jobs.lock() {
        if let Some(job) = jobs.get_mut(&task_id) {
            if let Some(ref final_url) = metadata.final_url {
                if final_url != &job.task.url && supported_direct_url(final_url) {
                    job.task.url = final_url.clone();
                    if let Ok(mut tasks) = state.task_snapshot.lock() {
                        if let Some(task) = tasks.get_mut(&task_id) {
                            task.url = final_url.clone();
                        }
                    }
                }
            }

            let opts = &mut job.direct_options;
            if let Some(ref etag) = metadata.etag {
                opts.entry("etag".to_string())
                    .or_insert_with(|| serde_json::Value::String(etag.clone()));
            }
            if let Some(ref last_modified) = metadata.last_modified {
                opts.entry("lastModified".to_string())
                    .or_insert_with(|| serde_json::Value::String(last_modified.clone()));
            }
            if let Some(ref digest) = metadata.digest_sha256 {
                opts.insert(
                    "digestSha256".to_string(),
                    serde_json::Value::String(digest.clone()),
                );
            }
            if !metadata.link_mirrors.is_empty() {
                let mirrors: Vec<serde_json::Value> = metadata
                    .link_mirrors
                    .iter()
                    .map(|m| serde_json::Value::String(m.clone()))
                    .collect();
                opts.insert("linkMirrors".to_string(), serde_json::Value::Array(mirrors));
                if !metadata.mirror_priorities.is_empty() {
                    opts.insert(
                        "mirrorPriorities".to_string(),
                        serde_json::Value::Array(metadata.mirror_priorities),
                    );
                }
            }
            if job.task.size_bytes == 0 && metadata.size_bytes > 0 {
                job.task.size_bytes = metadata.size_bytes;
            }
            if let Some(ref strategy) = metadata.strategy {
                opts.insert(
                    "rieStrategy".to_string(),
                    serde_json::Value::String(strategy.clone()),
                );
            }
            if let Some(connections) = metadata.connections {
                opts.insert(
                    "rieConnections".to_string(),
                    serde_json::Value::Number(connections.into()),
                );
            }
        }
    }

    if updates_applied {
        state.mark_dirty();
    }

    start_curl_task_by_id(&state, &task_id).await;
}

/// Start a previously-created curl task by its ID. Called by the background
/// resolver once metadata is ready, or as a fallback if the probe fails.
async fn start_curl_task_by_id(state: &SharedState, task_id: &str) {
    // Transition the task status to "downloading" in the snapshot.
    if let Ok(mut tasks) = state.task_snapshot.lock() {
        if let Some(task) = tasks.get_mut(task_id) {
            if task.status == "queued" {
                task.status = "downloading".to_string();
                task.engine_status = Some("starting".to_string());
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
                Err(error) => log::warn!("Rejected browser-extension candidate: {}", error),
            }
        }
    }
    if let Some(single_candidate) = body.get("candidate") {
        let wrapper = serde_json::json!({"candidate": single_candidate});
        match extension_candidate_to_download_body(&wrapper, true) {
            Ok(download_body) => download_bodies.push(download_body),
            Err(error) => log::warn!("Rejected browser-extension candidate: {}", error),
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

    let mut task_ids = Vec::new();
    let mut errors = Vec::new();
    for download_body in download_bodies {
        if let Some(ref url) = download_body.url {
            if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
                log::warn!("Blocked SSRF in captures for {}: {}", url, e);
                errors.push(format!("SSRF blocked: {}", e));
                continue;
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
            Ok(task) => task_ids.push(task.id),
            Err(error) => errors.push(error),
        }
    }
    let first_id = task_ids.first().cloned().unwrap_or_default();
    Json(serde_json::json!({
        "ok": errors.is_empty(),
        "accepted": !task_ids.is_empty(),
        "taskId": first_id,
        "taskIds": task_ids,
        "message": if errors.is_empty() { "Captured".to_string() } else { errors.join("; ") }
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

pub(crate) fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/health", get(handle_health))
        .route(
            "/api/downloads",
            get(handle_list_downloads).post(handle_create_download),
        )
        .route("/api/downloads/events", get(handle_download_events))
        .route("/api/downloads/{id}/pause", post(handle_pause_task))
        .route("/api/downloads/{id}/resume", post(handle_resume_task))
        .route("/api/downloads/{id}", delete(handle_delete_task))
        .route("/api/stats", get(handle_stats))
        .route("/captures", post(handle_captures))
        .route("/captures/pending", get(handle_captures_pending))
}
